'use strict';

// Lógica HTTP compartilhada: o server.js usa no computador/VPS e api/index.js usa na Vercel.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { getStorage } = require('./storage');

// MODO DE TESTE: com false, qualquer pessoa com o link do /admin edita o cardápio, sem senha.
// Volte para true antes de divulgar o site.
const PASSWORD_REQUIRED = false;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ON_VERCEL = Boolean(process.env.VERCEL);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 512 * 1024;
// A Vercel recusa corpos acima de 4,5 MB; as fotos já chegam reduzidas pelo painel.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_LOGIN_FAILURES = 10;
const COOKIE_NAME = 'voevo_admin';
// Na Vercel o site é sempre HTTPS e fica atrás do proxy dela.
const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true' || ON_VERCEL;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || ON_VERCEL;

// Tipos de imagem aceitos no envio, com a assinatura dos primeiros bytes de cada um.
const UPLOAD_TYPES = {
  'image/jpeg': { ext: '.jpg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: '.png', matches: (b) => b.subarray(0, 4).toString('hex') === '89504e47' },
  'image/webp': { ext: '.webp', matches: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
};
const UPLOAD_NAME = /^[a-f0-9]{24}\.(jpg|png|webp)$/;

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

// Os mesmos cabeçalhos estão no vercel.json para os arquivos estáticos servidos pela Vercel.
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

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------- Autenticação ----------

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function createAuth(password) {
  return { ...hashPassword(password), secret: crypto.randomBytes(32).toString('hex') };
}

// Lida a cada requisição: na Vercel cada instância é independente, e uma troca de senha
// feita em uma precisa valer em todas.
async function loadAuth(storage) {
  const existing = await storage.getAuth();
  if (existing) return existing;

  let password = process.env.ADMIN_PASSWORD;
  const generated = !password;
  if (generated) {
    if (storage.kind !== 'file') {
      throw httpError(503, 'Senha do painel não configurada. Defina a variável ADMIN_PASSWORD e faça um novo deploy.');
    }
    password = crypto.randomBytes(6).toString('base64url');
  }
  const created = createAuth(password);
  // Se outra instância criou a senha ao mesmo tempo, vale a dela.
  if (!(await storage.createAuth(created))) return storage.getAuth();
  if (generated) {
    console.log('\n==============================================');
    console.log('  Senha inicial do painel admin: ' + password);
    console.log('  Troque em /admin > Senha, ou com:');
    console.log('  npm run set-password -- NOVA_SENHA');
    console.log('==============================================\n');
  }
  return created;
}

function checkPassword(auth, password) {
  const { hash } = hashPassword(String(password), auth.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(auth.hash, 'hex'));
}

function sign(auth, value) {
  return crypto.createHmac('sha256', auth.secret).update(value).digest('base64url');
}

function createSession(auth) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(auth, payload)}`;
}

function isValidSession(auth, token) {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = sign(auth, payload);
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

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
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
  const storage = getStorage();
  const sessionToken = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const requireAuth = async () => {
    if (!PASSWORD_REQUIRED) return null;
    const auth = await loadAuth(storage);
    if (!isValidSession(auth, sessionToken)) throw httpError(401, 'Sessão expirada. Entre novamente.');
    return auth;
  };

  switch (`${req.method} ${pathname}`) {
    case 'GET /api/menu': {
      const menu = await storage.getMenu();
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify(menu));
    }

    case 'GET /api/session': {
      if (!PASSWORD_REQUIRED) return sendJson(res, 200, { authenticated: true, passwordRequired: false });
      // Sem cookie não há o que validar; evita consultar o banco à toa.
      const authenticated = Boolean(sessionToken) && isValidSession(await loadAuth(storage), sessionToken);
      return sendJson(res, 200, { authenticated, passwordRequired: true });
    }

    case 'POST /api/login': {
      const ip = clientIp(req);
      if ((await storage.failures(ip)) >= MAX_LOGIN_FAILURES) {
        throw httpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
      }
      const { password } = await readJson(req);
      const auth = await loadAuth(storage);
      if (typeof password !== 'string' || !checkPassword(auth, password)) {
        await storage.registerFailure(ip);
        throw httpError(401, 'Senha incorreta.');
      }
      await storage.clearFailures(ip);
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': sessionCookie(createSession(auth), SESSION_TTL_MS / 1000),
      });
    }

    case 'POST /api/logout':
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });

    case 'PUT /api/menu': {
      await requireAuth();
      const menu = sanitizeMenu(await readJson(req));
      await storage.saveMenu(menu);
      return sendJson(res, 200, menu);
    }

    case 'POST /api/upload': {
      await requireAuth();
      const type = (req.headers['content-type'] || '').split(';')[0].trim();
      const upload = UPLOAD_TYPES[type];
      if (!upload) throw httpError(415, 'Envie uma imagem JPG, PNG ou WebP.');
      const image = await readBody(req, MAX_UPLOAD_BYTES);
      if (!upload.matches(image)) throw httpError(400, 'O arquivo não é uma imagem válida.');
      const name = crypto.randomBytes(12).toString('hex') + upload.ext;
      await storage.saveUpload(name, type, image);
      return sendJson(res, 201, { url: `/uploads/${name}` });
    }

    case 'POST /api/password': {
      if (!PASSWORD_REQUIRED) throw httpError(400, 'A senha do painel está desativada (modo de teste).');
      const auth = await requireAuth();
      const { current, next } = await readJson(req);
      if (typeof current !== 'string' || !checkPassword(auth, current)) throw httpError(400, 'Senha atual incorreta.');
      if (typeof next !== 'string' || next.length < 6) throw httpError(400, 'A nova senha precisa ter pelo menos 6 caracteres.');
      const updated = createAuth(next);
      await storage.setAuth(updated);
      // Trocar a senha troca o segredo e derruba as outras sessões; esta recebe um cookie novo.
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': sessionCookie(createSession(updated), SESSION_TTL_MS / 1000),
      });
    }

    default:
      throw httpError(404, 'Rota não encontrada.');
  }
}

async function serveUpload(req, res, pathname) {
  const name = pathname.slice('/uploads/'.length);
  if (!UPLOAD_NAME.test(name)) throw httpError(404, 'Não encontrado.');
  const upload = await getStorage().getUpload(name);
  if (!upload) throw httpError(404, 'Não encontrado.');
  res.writeHead(200, {
    'Content-Type': upload.type,
    'Content-Length': upload.data.length,
    // Nomes de upload são aleatórios e nunca reaproveitados: podem ficar em cache para sempre,
    // inclusive na CDN da Vercel (s-maxage), que assim quase não chama a função.
    'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
  });
  res.end(req.method === 'HEAD' ? undefined : upload.data);
}

async function serveStatic(req, res, pathname) {
  if (pathname === '/admin') {
    res.writeHead(301, { Location: '/admin/' });
    return res.end();
  }
  let relative = decodeURIComponent(pathname);
  if (relative.endsWith('/')) relative += 'index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(relative));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw httpError(404, 'Não encontrado.');

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
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Método não permitido.');
    if (pathname.startsWith('/uploads/')) return await serveUpload(req, res, pathname);
    return await serveStatic(req, res, pathname);
  } catch (err) {
    const status = err.status || (err instanceof URIError ? 400 : 500);
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Erro interno.' : err.message });
    else res.end();
  }
}

const ensureAuth = async () => (PASSWORD_REQUIRED ? loadAuth(getStorage()) : null);

module.exports = { handle, createAuth, ensureAuth, getStorage };
