/**
 * 借用 tikumao.top（huaxue 项目）的登录鉴权 —— 只调用它的公开 HTTP 接口，
 * 不修改对方代码、配置或数据库。
 *
 *   POST /api/login  { username, password }  → { token, user }
 *   GET  /api/me     Authorization: Bearer … → { user }
 *
 * 我们只保存/token 校验结果的内存缓存（60s），不存密码、不存 JWT 密钥。
 */
const HUAXUE_API = String(process.env.HUAXUE_API || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const VERIFY_TTL = 60_000;
const verifyCache = new Map(); // token -> { user, exp }

async function call(path, { method = 'GET', body, headers = {}, timeout = 6000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(HUAXUE_API + path, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    return { status: res.status, ok: res.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

/** 用题库猫账号登录；返回 { ok, token, user } 或 { ok:false, status, error } */
export async function ssoLogin(username, password, ip) {
  const headers = {};
  /* 透传真实客户端 IP，让对方的「每 IP 15 分钟 20 次」限流按用户而不是按我们的代理计。
     对方优先读 X-Real-IP，且只认离自己最近的一跳，所以两个头都只放一个值。 */
  if (ip && /^[0-9a-fA-F:.]+$/.test(ip)) {
    headers['x-real-ip'] = ip;
    headers['x-forwarded-for'] = ip;
  }
  const { status, ok, data } = await call('/api/login', {
    method: 'POST',
    body: { username, password },
    headers,
  });
  if (!ok || !data.token) {
    return { ok: false, status: status === 429 ? 429 : 401, error: data.error || '用户名或密码错误' };
  }
  return { ok: true, token: data.token, user: data.user || {} };
}

/** 校验 token 是否仍然有效；有效返回 user，否则 null */
export async function ssoVerify(token) {
  if (!token) return null;
  const hit = verifyCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.user;
  try {
    const { ok, data } = await call('/api/me', { headers: { authorization: `Bearer ${token}` } });
    if (!ok || !data.user) {
      verifyCache.delete(token);
      return null;
    }
    if (verifyCache.size > 500) verifyCache.clear();
    verifyCache.set(token, { user: data.user, exp: Date.now() + VERIFY_TTL });
    return data.user;
  } catch {
    return null;
  }
}
