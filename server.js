'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED_FILE = path.join(__dirname, 'seed', 'menu.json');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MENU_FILE = path.join(DATA_DIR, 'menu.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_BACKUPS = 30;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Tipos de imagem aceitos no envio, com a assinatura dos primeiros bytes de cada um.
const UPLOAD_TYPES = {
  'image/jpeg': { ext: '.jpg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: '.png', matches: (b) => b.subarray(0, 4).toString('hex') === '89504e47' },
  'image/webp': { ext: '.webp', matches: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
};
const COOKIE_NAME = 'voevo_admin';
// Ative COOKIE_SECURE=true quando o site estiver em HTTPS.
const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true';
// Ative TRUST_PROXY=true atrás de um proxy reverso (Nginx, Render, Railway...).
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

// ---------- Armazenamento ----------

function ensureDataFiles() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(MENU_FILE)) fs.copyFileSync(SEED_FILE, MENU_FILE);
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

async function backupMenu() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.copyFile(MENU_FILE, path.join(BACKUP_DIR, `menu-${stamp}.json`));
  const backups = (await fsp.readdir(BACKUP_DIR)).filter((f) => f.startsWith('menu-')).sort();
  await Promise.all(backups.slice(0, -MAX_BACKUPS).map((f) => fsp.unlink(path.join(BACKUP_DIR, f))));
}

let menuJson = '';
let writeQueue = Promise.resolve();

function loadMenu() {
  menuJson = JSON.stringify(JSON.parse(fs.readFileSync(MENU_FILE, 'utf8')));
}

function saveMenu(menu) {
  // Serializa as gravações para que dois salvamentos simultâneos não se atropelem.
  const job = writeQueue.then(async () => {
    await backupMenu();
    await writeJsonAtomic(MENU_FILE, menu);
    menuJson = JSON.stringify(menu);
  });
  writeQueue = job.catch(() => {});
  return job;
}

// ---------- Autenticação ----------

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function createAuth(password) {
  return { ...hashPassword(password), secret: crypto.randomBytes(32).toString('hex') };
}

function loadAuth() {
  if (fs.existsSync(AUTH_FILE)) return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const created = createAuth(password);
  fs.writeFileSync(AUTH_FILE, JSON.stringify(created, null, 2));
  if (!process.env.ADMIN_PASSWORD) {
    console.log('\n==============================================');
    console.log('  Senha inicial do painel admin: ' + password);
    console.log('  Troque em /admin > Senha, ou com:');
    console.log('  npm run set-password -- NOVA_SENHA');
    console.log('==============================================\n');
  }
  return created;
}

let auth;

function checkPassword(password) {
  const { hash } = hashPassword(String(password), auth.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(auth.hash, 'hex'));
}

function sign(value) {
  return crypto.createHmac('sha256', auth.secret).update(value).digest('base64url');
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function isValidSession(token) {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  if (signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return cookies;
}

function sessionCookie(token, maxAgeSeconds) {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    SECURE_COOKIE && 'Secure',
  ].filter(Boolean).join('; ');
}

const loginFailures = new Map();
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    return req.headers['x-forwarded-for'].split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isLockedOut(ip) {
  const entry = loginFailures.get(ip);
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= MAX_FAILURES);
}

function registerFailure(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) loginFailures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  else entry.count += 1;
}

// ---------- Validação do cardápio ----------

const ID_PATTERN = /^[a-z0-9-]{1,48}$/;
// Só imagens servidas pelo próprio site: fotos enviadas (/uploads) ou ilustrações (/img).
const IMAGE_PATTERN = /^\/(uploads|img)\/[\w/-]{1,120}\.(jpg|png|webp|svg)$/;

const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);

function parsePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
}

function sanitizeMenu(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.categories)) {
    throw httpError(400, 'Formato de cardápio inválido.');
  }
  const usedIds = new Set();
  const uniqueId = (value) => {
    let id = typeof value === 'string' && ID_PATTERN.test(value) ? value : '';
    while (!id || usedIds.has(id)) id = crypto.randomBytes(4).toString('hex');
    usedIds.add(id);
    return id;
  };
  const info = input.info && typeof input.info === 'object' ? input.info : {};

  return {
    info: {
      name: str(info.name, 80) || 'Vô e Vó',
      subtitle: str(info.subtitle, 80),
      tagline: str(info.tagline, 160),
      footer: str(info.footer, 200),
      hours: str(info.hours, 200),
      address: str(info.address, 200),
      whatsapp: str(info.whatsapp, 20).replace(/\D/g, ''),
      instagram: str(info.instagram, 60).replace(/^@/, '').replace(/[^\w.]/g, ''),
    },
    categories: list(input.categories, 50).map((category) => ({
      id: uniqueId(category.id),
      name: str(category.name, 80) || 'Sem nome',
      description: str(category.description, 300),
      note: str(category.note, 300),
      sections: list(category.sections, 30).map((section) => ({
        id: uniqueId(section.id),
        name: str(section.name, 80),
        note: str(section.note, 300),
        weekday: Number.isInteger(section.weekday) && section.weekday >= 0 && section.weekday <= 6
          ? section.weekday
          : null,
        items: list(section.items, 200).map((item) => ({
          id: uniqueId(item.id),
          name: str(item.name, 120) || 'Sem nome',
          description: str(item.description, 300),
          price: parsePrice(item.price),
          badge: str(item.badge, 30),
          image: typeof item.image === 'string' && IMAGE_PATTERN.test(item.image) ? item.image : '',
          available: item.available !== false,
        })),
      })),
    })),
    updatedAt: new Date().toISOString(),
  };
}

// ---------- HTTP ----------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Arquivo ou dados grandes demais.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    throw httpError(415, 'Envie os dados como JSON.');
  }
  const body = await readBody(req, MAX_BODY_BYTES);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw httpError(400, 'JSON inválido.');
  }
}

async function handleApi(req, res, pathname) {
  const authenticated = isValidSession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  const requireAuth = () => {
    if (!authenticated) throw httpError(401, 'Sessão expirada. Entre novamente.');
  };

  switch (`${req.method} ${pathname}`) {
    case 'GET /api/menu':
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
      return res.end(menuJson);

    case 'GET /api/session':
      return sendJson(res, 200, { authenticated });

    case 'POST /api/login': {
      const ip = clientIp(req);
      if (isLockedOut(ip)) throw httpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
      const { password } = await readJson(req);
      if (typeof password !== 'string' || !checkPassword(password)) {
        registerFailure(ip);
        throw httpError(401, 'Senha incorreta.');
      }
      loginFailures.delete(ip);
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': sessionCookie(createSession(), SESSION_TTL_MS / 1000),
      });
    }

    case 'POST /api/logout':
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });

    case 'PUT /api/menu': {
      requireAuth();
      const menu = sanitizeMenu(await readJson(req));
      await saveMenu(menu);
      return sendJson(res, 200, menu);
    }

    case 'POST /api/upload': {
      requireAuth();
      const type = UPLOAD_TYPES[(req.headers['content-type'] || '').split(';')[0].trim()];
      if (!type) throw httpError(415, 'Envie uma imagem JPG, PNG ou WebP.');
      const image = await readBody(req, MAX_UPLOAD_BYTES);
      if (!type.matches(image)) throw httpError(400, 'O arquivo não é uma imagem válida.');
      const name = crypto.randomBytes(12).toString('hex') + type.ext;
      await fsp.writeFile(path.join(UPLOAD_DIR, name), image);
      return sendJson(res, 201, { url: `/uploads/${name}` });
    }

    case 'POST /api/password': {
      requireAuth();
      const { current, next } = await readJson(req);
      if (typeof current !== 'string' || !checkPassword(current)) throw httpError(400, 'Senha atual incorreta.');
      if (typeof next !== 'string' || next.length < 6) throw httpError(400, 'A nova senha precisa ter pelo menos 6 caracteres.');
      auth = createAuth(next);
      await writeJsonAtomic(AUTH_FILE, auth);
      // Trocar a senha troca o segredo e derruba as outras sessões; esta recebe um cookie novo.
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': sessionCookie(createSession(), SESSION_TTL_MS / 1000),
      });
    }

    default:
      throw httpError(404, 'Rota não encontrada.');
  }
}

async function serveStatic(req, res, pathname) {
  if (pathname === '/admin') {
    res.writeHead(301, { Location: '/admin/' });
    return res.end();
  }
  // Fotos enviadas ficam em data/uploads, fora de public/, para sobreviverem a atualizações do código.
  const isUpload = pathname.startsWith('/uploads/');
  const baseDir = isUpload ? UPLOAD_DIR : PUBLIC_DIR;
  let relative = decodeURIComponent(isUpload ? pathname.slice('/uploads'.length) : pathname);
  if (relative.endsWith('/')) relative += 'index.html';
  const file = path.join(baseDir, path.normalize(relative));
  if (!file.startsWith(baseDir + path.sep)) throw httpError(404, 'Não encontrado.');

  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw httpError(404, 'Não encontrado.');
  }
  if (!stat.isFile()) throw httpError(404, 'Não encontrado.');

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // Nomes de upload são aleatórios e nunca reaproveitados, então podem ficar em cache para sempre.
    'Cache-Control': isUpload ? 'public, max-age=31536000, immutable'
      : ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function createServer() {
  return http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Método não permitido.');
      return await serveStatic(req, res, pathname);
    } catch (err) {
      const status = err.status || (err instanceof URIError ? 400 : 500);
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Erro interno.' : err.message });
      else res.end();
    }
  });
}

// ---------- Inicialização ----------

ensureDataFiles();

const passwordFlag = process.argv.indexOf('--set-password');
if (passwordFlag !== -1) {
  const password = process.argv[passwordFlag + 1];
  if (!password || password.length < 6) {
    console.error('Uso: npm run set-password -- NOVA_SENHA (mínimo 6 caracteres)');
    process.exit(1);
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(createAuth(password), null, 2));
  console.log('Senha do painel admin atualizada.');
  process.exit(0);
}

auth = loadAuth();
loadMenu();

createServer().listen(PORT, () => {
  console.log(`Cardápio:      http://localhost:${PORT}`);
  console.log(`Painel admin:  http://localhost:${PORT}/admin`);
});
