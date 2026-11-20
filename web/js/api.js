/* 后端 API 客户端：同源或跨域均可，失败时由上层降级为本地模式 */
const CFG = window.APP_CONFIG || {};
const API_BASE = String(CFG.apiBase || '').replace(/\/+$/, '');
const TIMEOUT = Number(CFG.requestTimeout) || 9000;

async function request(path, { method = 'GET', body, timeout = TIMEOUT } = {}) {
  if (CFG.useServer === false) throw new Error('server-disabled');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      credentials: 'omit',
      mode: 'cors',
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* 非 JSON 响应 */ }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const Api = {
  base: API_BASE,
  enabled: CFG.useServer !== false,

  health() {
    return request('/api/health', { timeout: 4000 });
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
