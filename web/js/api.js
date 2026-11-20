/* 后端 API 客户端：同源或跨域均可，失败时由上层降级为本地模式 */
const CFG = window.APP_CONFIG || {};
const API_BASE = String(CFG.apiBase || '').replace(/\/+$/, '');
const TIMEOUT = Number(CFG.requestTimeout) || 9000;

/* 题库猫账号（huaxue）登录后拿到的 token，仅存在本机浏览器 */
const TOKEN_KEY = 'dx.hxToken';
let token = '';
try {
  token = localStorage.getItem(TOKEN_KEY) || '';
} catch {
  token = '';
}

export const Auth = {
  get token() {
    return token;
  },
  setToken(next) {
    token = String(next || '');
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* 隐私模式等场景忽略 */
    }
  },
  clear() {
    this.setToken('');
  },
  get loggedIn() {
    return !!token;
  },
};

async function request(path, { method = 'GET', body, timeout = TIMEOUT } = {}) {
  if (CFG.useServer === false) throw new Error('server-disabled');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(API_BASE + path, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      credentials: 'omit',
      mode: 'cors',
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* 非 JSON 响应 */
    }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.set(k, v);
  });
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const Api = {
  base: API_BASE,
  enabled: CFG.useServer !== false,

  health() {
    return request('/api/health', { timeout: 4000 });
  },

  /* ---- 题库猫账号（借用 huaxue 的登录鉴权） ---- */
  authLogin(username, password) {
    return request('/api/auth/login', { method: 'POST', body: { username, password } });
  },
  authMe() {
    return request('/api/auth/me', { timeout: 5000 });
  },

  profile(uid) {
    return request(`/api/profile${qs({ uid })}`);
  },

  saveAttempt(uid, nickname, attempt) {
    return request('/api/attempts', { method: 'POST', body: { uid, nickname, attempt } });
  },

  rename(uid, nickname) {
    return request('/api/profile', { method: 'POST', body: { uid, nickname } });
  },

  leaderboard() {
    return request('/api/leaderboard');
  },
};
