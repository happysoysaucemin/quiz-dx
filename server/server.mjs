#!/usr/bin/env node
/**
 * 刷题 DX 服务端（零依赖）
 *
 *   node server.mjs                  # 默认 0.0.0.0:8787
 *   PORT=9000 node server.mjs        # 换端口
 *
 * 默认同时托管 ../web（静态页面）和 ../bank（题库 JSON）。
 * 也可以只把它当 API 用：前端部署在别处，通过 CORS 访问 /api/*。
 */
import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { computeStats, normalizeAttempt, updateWrongbook } from './lib/stats.mjs';
import { ssoLogin, ssoVerify } from './lib/sso.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const BANK_DIR = path.join(ROOT, 'bank');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const START_AT = Date.now();

const store = await new Store(DATA_DIR).init();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function setCors(res, req) {
  const origin = req.headers.origin;
  if (CORS_ORIGIN === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    const allow = CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
    if (origin && allow.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    else if (allow.length) res.setHeader('Access-Control-Allow-Origin', allow[0]);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1_500_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function cleanNickname(value, fallback = '学员') {
  const name = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 20);
  return name || fallback;
}

function publicUser(user) {
  return { uid: user.uid, nickname: user.nickname, createdAt: user.createdAt };
}

/** 取 Authorization: Bearer <token> */
function bearerToken(req) {
  const raw = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? m[1].trim() : '';
}

/** 真实客户端 IP（nginx 会带 X-Forwarded-For） */
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || String(req.socket.remoteAddress || '');
}

/**
 * 身份解析：带了有效的题库猫 token 就用 huaxue 账号（uid = hx:<id>），
 * 否则退回本机匿名 uid（保持原来的免登录体验）。
 */
async function resolveIdentity(req, fallbackUid) {
  const token = bearerToken(req);
  if (token) {
    const user = await ssoVerify(token);
    if (user) {
      return {
        uid: `hx:${user.id}`,
        nickname: String(user.nickname || user.username || '学员'),
        sso: true,
        user,
      };
    }
  }
  return { uid: String(fallbackUid || '').trim(), nickname: '', sso: false, user: null };
}

/* ------------------------------- API ------------------------------- */
async function handleApi(req, res, pathname, query) {
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/health' && method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      service: 'quiz-dx-server',
      version: 1,
      uptimeSec: Math.round((Date.now() - START_AT) / 1000),
      users: store.users().length,
      time: new Date().toISOString(),
    });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) {
      return sendJSON(res, 400, { ok: false, error: '请输入账号和密码' });
    }
    const r = await ssoLogin(username, password, clientIp(req));
    if (!r.ok) return sendJSON(res, r.status || 401, { ok: false, error: r.error || '登录失败' });
    const u = r.user || {};
    return sendJSON(res, 200, {
      ok: true,
      token: r.token,
      user: {
        uid: `hx:${u.id}`,
        id: u.id,
        username: u.username || username,
        nickname: u.nickname || u.username || username,
      },
    });
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const token = bearerToken(req);
    if (!token) return sendJSON(res, 401, { ok: false, error: '未登录' });
    const user = await ssoVerify(token);
    if (!user) return sendJSON(res, 401, { ok: false, error: '登录已过期，请重新登录' });
    return sendJSON(res, 200, {
      ok: true,
      user: {
        uid: `hx:${user.id}`,
        id: user.id,
        username: user.username,
        nickname: user.nickname || user.username,
      },
    });
  }

  if (pathname === '/api/profile' && method === 'GET') {
    const id = await resolveIdentity(req, query.get('uid'));
    const uid = id.uid;
    if (!uid) return sendJSON(res, 400, { ok: false, error: '缺少 uid' });
    const user = store.find(uid);
    if (!user) {
      return sendJSON(res, 200, {
        ok: true,
        user: { uid, nickname: id.nickname || '学员', createdAt: null },
        viewer: id.sso ? { sso: true, hxId: id.user.id } : { sso: false },
        stats: computeStats({ attempts: [], wrong: {} }),
        attempts: [],
        wrongbook: {},
      });
    }
    const attempts = (user.attempts || []).slice(0, 60);
    return sendJSON(res, 200, {
      ok: true,
      user: publicUser(user),
      viewer: id.sso ? { sso: true, hxId: id.user.id } : { sso: false },
      stats: computeStats(user),
      attempts,
      wrongbook: user.wrong || {},
    });
  }

  if (pathname === '/api/profile' && method === 'POST') {
    const body = await readBody(req);
    const id = await resolveIdentity(req, body.uid);
    const uid = id.uid;
    if (!uid) return sendJSON(res, 400, { ok: false, error: '缺少 uid' });
    const user = store.user(uid);
    user.nickname = cleanNickname(body.nickname, id.nickname || user.nickname);
    user.updatedAt = new Date().toISOString();
    await store.commit();
    return sendJSON(res, 200, { ok: true, user: publicUser(user) });
  }

  if (pathname === '/api/attempts' && method === 'POST') {
    const body = await readBody(req);
    const id = await resolveIdentity(req, body.uid);
    const uid = id.uid;
    if (!uid) return sendJSON(res, 400, { ok: false, error: '缺少 uid' });
    const user = store.user(uid);
    if (body.nickname || id.nickname) user.nickname = cleanNickname(body.nickname, id.nickname || user.nickname);

    const attempt = normalizeAttempt(body.attempt, uid);
    const exists = (user.attempts || []).find((a) => a.id === attempt.id);
    if (exists) {
      return sendJSON(res, 200, {
        ok: true,
        duplicate: true,
        user: publicUser(user),
        attempt: exists,
        stats: computeStats(user),
        ratingDelta: 0,
        wrongbook: user.wrong || {},
      });
    }

    const before = computeStats(user).rating;
    user.attempts ||= [];
    user.attempts.unshift(attempt);
    if (user.attempts.length > 1000) user.attempts.length = 1000;
    updateWrongbook(user, attempt);
    user.updatedAt = new Date().toISOString();
    await store.commit();

    const stats = computeStats(user);
    return sendJSON(res, 200, {
      ok: true,
      user: publicUser(user),
      attempt,
      stats,
      ratingDelta: Math.round((stats.rating - before) * 10) / 10,
      wrongbook: user.wrong || {},
    });
  }

  if (pathname === '/api/wrongbook' && method === 'DELETE') {
    const id = await resolveIdentity(req, query.get('uid'));
    const uid = id.uid;
    if (!uid) return sendJSON(res, 400, { ok: false, error: '缺少 uid' });
    const user = store.find(uid);
    if (user) {
      user.wrong = {};
      user.updatedAt = new Date().toISOString();
      await store.commit();
    }
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/leaderboard' && method === 'GET') {
    const rows = store
      .users()
      .filter((u) => (u.attempts || []).length > 0)
      .map((u) => {
        const stats = computeStats(u);
        return {
          uid: u.uid,
          nickname: u.nickname,
          rating: stats.rating,
          attempts: stats.attempts,
          bestScore: stats.bestScore,
        };
      })
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 20);
    return sendJSON(res, 200, { ok: true, rows });
  }

  return sendJSON(res, 404, { ok: false, error: '接口不存在' });
}

/* ----------------------------- 静态文件 ----------------------------- */
async function serveFile(req, res, root, relative) {
  let rel = relative;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  const target = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let filePath = target;
  try {
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fs.stat(filePath);
    }
    if (!stat.isFile()) throw new Error('not file');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': ['.html', '.js', '.mjs', '.css', '.json'].includes(ext) ? 'no-cache' : 'public, max-age=300',
      'last-modified': stat.mtime.toUTCString(),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ------------------------------- 服务 ------------------------------- */
const server = http.createServer(async (req, res) => {
  setCors(res, req);
  const started = Date.now();
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, url.searchParams);
      return;
    }

    if (pathname.startsWith('/bank/')) {
      await serveFile(req, res, BANK_DIR, pathname.slice('/bank/'.length));
      return;
    }

    await serveFile(req, res, WEB_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
  } catch (err) {
    console.error(`[server] ${req.method} ${req.url} 失败:`, err);
    if (!res.headersSent) {
      sendJSON(res, 500, { ok: false, error: err.message || '服务器内部错误' });
    } else {
      res.end();
    }
  } finally {
    if (process.env.LOG !== '0') {
      console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`
  ╭──────────────────────────────────────────────╮
  │  刷题 DX 服务已启动                          │
  │  http://localhost:${PORT}${' '.repeat(Math.max(0, 22 - String(PORT).length))}│
  │  API 前缀   /api                             │
  │  静态页面   ../web                           │
  │  题库       ../bank                          │
  │  数据       ${DATA_DIR.length > 34 ? DATA_DIR.slice(0, 34) + '…' : DATA_DIR}${' '.repeat(Math.max(0, 34 - Math.min(34, DATA_DIR.length)))}│
  ╰──────────────────────────────────────────────╯
  `);
});

async function shutdown(signal) {
  console.log(`\n[server] 收到 ${signal}，保存数据后退出…`);
  await store.commit();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
