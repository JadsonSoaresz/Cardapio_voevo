'use strict';

// Onde o cardápio, a senha e as fotos ficam guardados.
// - Upstash Redis quando as variáveis do Redis existem (Vercel e outras hospedagens sem disco).
// - Pasta data/ no disco nos demais casos (computador local, VPS).
// - Na Vercel sem Redis: só leitura, com o cardápio inicial, para o site não cair.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const SEED_MENU = require('../seed/menu.json');

const MAX_BACKUPS = 30;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function unavailable(message) {
  return Object.assign(new Error(message), { status: 503 });
}

// ---------- Disco (pasta data/) ----------

function createFileStorage(dataDir) {
  const menuFile = path.join(dataDir, 'menu.json');
  const authFile = path.join(dataDir, 'auth.json');
  const backupDir = path.join(dataDir, 'backups');
  const uploadDir = path.join(dataDir, 'uploads');

  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  if (!fs.existsSync(menuFile)) fs.writeFileSync(menuFile, JSON.stringify(SEED_MENU, null, 2));

  let menu = JSON.parse(fs.readFileSync(menuFile, 'utf8'));
  let writeQueue = Promise.resolve();
  const failures = new Map();

  async function writeJsonAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.rename(tmp, file);
  }

  async function readOrNull(read) {
    try {
      return await read();
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  return {
    kind: 'file',

    async getMenu() {
      return menu;
    },

    saveMenu(next) {
      // Serializa as gravações para que dois salvamentos simultâneos não se atropelem.
      const job = writeQueue.then(async () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.copyFile(menuFile, path.join(backupDir, `menu-${stamp}.json`));
        const backups = (await fsp.readdir(backupDir)).filter((f) => f.startsWith('menu-')).sort();
        await Promise.all(backups.slice(0, -MAX_BACKUPS).map((f) => fsp.unlink(path.join(backupDir, f))));
        await writeJsonAtomic(menuFile, next);
        menu = next;
      });
      writeQueue = job.catch(() => {});
      return job;
    },

    getAuth: () => readOrNull(async () => JSON.parse(await fsp.readFile(authFile, 'utf8'))),

    setAuth: (auth) => writeJsonAtomic(authFile, auth),

    async createAuth(auth) {
      try {
        await fsp.writeFile(authFile, JSON.stringify(auth, null, 2), { flag: 'wx' });
        return true;
      } catch (err) {
        if (err.code === 'EEXIST') return false;
        throw err;
      }
    },

    saveUpload: (name, type, data) => fsp.writeFile(path.join(uploadDir, name), data),

    getUpload: (name) => readOrNull(async () => ({
      type: MIME_BY_EXT[path.extname(name)],
      data: await fsp.readFile(path.join(uploadDir, name)),
    })),

    async failures(ip) {
      const entry = failures.get(ip);
      return entry && entry.resetAt > Date.now() ? entry.count : 0;
    },

    async registerFailure(ip) {
      const now = Date.now();
      const entry = failures.get(ip);
      if (!entry || entry.resetAt <= now) failures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_SECONDS * 1000 });
      else entry.count += 1;
    },

    async clearFailures(ip) {
      failures.delete(ip);
    },
  };
}

// ---------- Upstash Redis (API REST, sem dependências) ----------

function createRedisStorage({ url, token }) {
  const KEY = {
    menu: 'voevo:menu',
    auth: 'voevo:auth',
    backups: 'voevo:backups',
    upload: (name) => `voevo:upload:${name}`,
    failures: (ip) => `voevo:login-failures:${ip}`,
  };

  async function request(endpoint, body) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.error) {
      throw new Error(`Falha no Redis: ${(data && data.error) || `HTTP ${response.status}`}`);
    }
    return data;
  }

  const command = async (...args) => (await request(url, args)).result;

  async function pipeline(commands) {
    const results = await request(`${url}/pipeline`, commands);
    const failed = results.find((r) => r.error);
    if (failed) throw new Error(`Falha no Redis: ${failed.error}`);
    return results.map((r) => r.result);
  }

  return {
    kind: 'redis',

    async getMenu() {
      const raw = await command('GET', KEY.menu);
      // Antes do primeiro salvamento pelo painel, o cardápio é o inicial.
      return raw ? JSON.parse(raw) : SEED_MENU;
    },

    async saveMenu(menu) {
      const previous = await command('GET', KEY.menu);
      const backup = previous ? [['LPUSH', KEY.backups, previous], ['LTRIM', KEY.backups, 0, MAX_BACKUPS - 1]] : [];
      await pipeline([...backup, ['SET', KEY.menu, JSON.stringify(menu)]]);
    },

    async getAuth() {
      const raw = await command('GET', KEY.auth);
      return raw ? JSON.parse(raw) : null;
    },

    async setAuth(auth) {
      await command('SET', KEY.auth, JSON.stringify(auth));
    },

    async createAuth(auth) {
      return (await command('SET', KEY.auth, JSON.stringify(auth), 'NX')) === 'OK';
    },

    async saveUpload(name, type, data) {
      await command('SET', KEY.upload(name), JSON.stringify({ type, data: data.toString('base64') }));
    },

    async getUpload(name) {
      const raw = await command('GET', KEY.upload(name));
      if (!raw) return null;
      const { type, data } = JSON.parse(raw);
      return { type, data: Buffer.from(data, 'base64') };
    },

    async failures(ip) {
      return Number(await command('GET', KEY.failures(ip))) || 0;
    },

    async registerFailure(ip) {
      const count = await command('INCR', KEY.failures(ip));
      if (count === 1) await command('EXPIRE', KEY.failures(ip), LOGIN_WINDOW_SECONDS);
    },

    async clearFailures(ip) {
      await command('DEL', KEY.failures(ip));
    },
  };
}

// ---------- Somente leitura (Vercel sem banco configurado) ----------

function createReadOnlyStorage(message) {
  const fail = async () => { throw unavailable(message); };
  return {
    kind: 'readonly',
    getMenu: async () => SEED_MENU,
    saveMenu: fail,
    getAuth: fail,
    setAuth: fail,
    createAuth: fail,
    saveUpload: fail,
    getUpload: async () => null,
    failures: async () => 0,
    registerFailure: async () => {},
    clearFailures: async () => {},
  };
}

function redisConfig() {
  // A integração Upstash da Vercel cria KV_REST_API_*; o painel da Upstash usa UPSTASH_REDIS_REST_*.
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

let storage;

function getStorage() {
  if (storage) return storage;
  const redis = redisConfig();
  if (redis) {
    storage = createRedisStorage(redis);
  } else if (process.env.VERCEL) {
    storage = createReadOnlyStorage(
      'Banco de dados não configurado. Na Vercel, conecte o Upstash Redis ao projeto (aba Storage) e faça um novo deploy.',
    );
  } else {
    storage = createFileStorage(path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')));
  }
  return storage;
}

module.exports = { getStorage };
