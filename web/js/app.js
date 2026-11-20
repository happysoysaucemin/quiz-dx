import { Api } from './api.js';
import {
  TYPE_LABEL,
  RANK_TABLE,
  RATING_SLOTS,
  rankOf,
  difficultyOf,
  singleRating,
  totalRating,
  formatScore,
  rankColor,
} from './rating.js';

/* ======================================================================
 *  基础工具
 * ==================================================================== */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const richText = (s) =>
  esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/_{3,}/g, '<span class="blank"></span>');
const pad2 = (n) => String(n).padStart(2, '0');
const fmtClock = (sec) => {
  sec = Math.max(0, Math.round(sec));
  return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
};
const fmtDateTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const newId = () =>
  window.crypto?.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round1 = (n) => Math.round(n * 10) / 10;
const shortTag = () => Math.random().toString(16).slice(2, 5).toUpperCase();

const LS = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 隐私模式下忽略 */
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/* ======================================================================
 *  全局状态
 * ==================================================================== */
const state = {
  bank: null,
  index: null,
  qmap: new Map(),
  uid: LS.get('dx.uid', '') || (() => {
    const id = newId();
    LS.set('dx.uid', id);
    return id;
  })(),
  nickname: LS.get('dx.nick', '学员'),
  online: false,
  attempts: LS.get('dx.attempts', []),
  wrong: LS.get('dx.wrong', {}),
  profile: null,
  session: null,
  lastResult: null,
  setup: null,
  timerId: null,
  saving: false,
};

/* ======================================================================
 *  题库加载
 * ==================================================================== */
function bankBaseCandidates() {
  const cfgBase = String(window.APP_CONFIG?.bankBase ?? '').trim();
  if (cfgBase) {
    const b = cfgBase.endsWith('/') ? cfgBase : `${cfgBase}/`;
    return [b];
  }
  return ['./bank/', '../bank/', '/bank/'];
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} · ${url}`);
  return res.json();
}

async function loadBank() {
  let lastError = null;
  for (const base of bankBaseCandidates()) {
    try {
      const index = await fetchJSON(`${base}index.json`);
      const subjects = {};
      await Promise.all(
        index.subjects.map(async (meta) => {
          subjects[meta.code] = await fetchJSON(`${base}${meta.file}`);
        }),
      );
      state.index = index;
      state.bank = { subjects };
      state.qmap = new Map();
      for (const subject of Object.values(subjects)) {
        for (const q of subject.questions) state.qmap.set(q.id, q);
      }
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('题库加载失败');
}

/* ======================================================================
 *  服务端连接
 * ==================================================================== */
function setConn(kind, text) {
  const chip = $('#conn-chip');
  if (!chip) return;
  chip.classList.toggle('online', kind === 'online');
  chip.classList.toggle('offline', kind !== 'online');
  const label = $('#conn-text');
  if (label) label.textContent = text;
}

async function connectServer() {
  if (!Api.enabled) {
    state.online = false;
    setConn('offline', '离线刷题');
    return;
  }
  setConn('checking', '连接中…');
  const locals = state.attempts.slice();
  try {
    await Api.health();
    const first = await Api.profile(state.uid);
    const serverIds = new Set((first.attempts || []).map((a) => a.id));
    const missing = locals.filter((a) => !serverIds.has(a.id));
    for (const attempt of missing.reverse()) {
      try {
        await Api.saveAttempt(state.uid, state.nickname, attempt);
      } catch {
        /* 单条失败不阻塞 */
      }
    }
    const data = missing.length ? await Api.profile(state.uid) : first;
    applyServerProfile(data);
    state.online = true;
    setConn('online', '已连接');
  } catch {
    state.online = false;
    setConn('offline', Api.enabled ? '本地模式' : '离线刷题');
  }
}

function applyServerProfile(data) {
  if (!data) return;
  if (data.user?.nickname) {
    state.nickname = data.user.nickname;
    LS.set('dx.nick', state.nickname);
  }
  if (Array.isArray(data.attempts)) {
    state.attempts = data.attempts;
    LS.set('dx.attempts', state.attempts);
  }
  if (data.wrongbook && typeof data.wrongbook === 'object') {
    state.wrong = data.wrongbook;
    LS.set('dx.wrong', state.wrong);
  }
  if (data.stats) state.profile = data.stats;
}

/* ======================================================================
 *  本地统计
 * ==================================================================== */
function computeStats(attempts = [], wrong = {}) {
  let total = 0;
  let correct = 0;
  let best = 0;
  const seen = {};
  const bySubject = {};
  for (const a of attempts) {
    total += a.total || 0;
    correct += a.correct || 0;
    best = Math.max(best, Number(a.score) || 0);
    const bs = (bySubject[a.subject] ||= { attempts: 0, total: 0, correct: 0, best: 0 });
    bs.attempts += 1;
    bs.total += a.total || 0;
    bs.correct += a.correct || 0;
    bs.best = Math.max(bs.best, Number(a.score) || 0);
    seen[a.subject] ||= {};
    for (const ans of a.answers || []) seen[a.subject][ans.qid] = true;
  }
  const seenCount = {};
  for (const [code, map] of Object.entries(seen)) seenCount[code] = Object.keys(map).length;
  return {
    rating: totalRating(attempts),
    attempts: attempts.length,
    accuracy: total ? round1((correct / total) * 100) : 0,
    bestScore: round1(best),
    wrongCount: Object.keys(wrong || {}).length,
    seen: seenCount,
    bySubject,
  };
}

function refreshLocalProfile() {
  state.profile = computeStats(state.attempts, state.wrong);
}

/* ======================================================================
 *  错题本 / 本地持久化
 * ==================================================================== */
function updateWrongLocal(attempt) {
  const now = new Date().toISOString();
  for (const ans of attempt.answers || []) {
    if (ans.skipped) continue;
    if (ans.correct) {
      delete state.wrong[ans.qid];
    } else {
      const prev = state.wrong[ans.qid];
      state.wrong[ans.qid] = {
        qid: ans.qid,
        code: attempt.subject,
        at: now,
        count: (prev?.count || 0) + 1,
        chosen: ans.chosen,
      };
    }
  }
  LS.set('dx.wrong', state.wrong);
}

function persistLocal() {
  LS.set('dx.attempts', state.attempts.slice(0, 300));
  LS.set('dx.wrong', state.wrong);
  LS.set('dx.nick', state.nickname);
}

/* ======================================================================
 *  会话
 * ==================================================================== */
function countBy(questions) {
  const counts = { fill: 0, single: 0, judge: 0 };
  for (const q of questions) counts[q.type] = (counts[q.type] || 0) + 1;
  return counts;
}

function subjectName(code) {
  if (code === 'mix') return '四科混排';
  return state.bank?.subjects?.[code]?.name || code;
}

function startLoop(code, order) {
  const codes = code === 'mix' ? state.index.subjects.map((s) => s.code) : [code];
  let questions = codes.flatMap((c) => state.bank.subjects[c].questions);
  if (order === 'rand') questions = shuffle(questions);
  if (!questions.length) {
    toast('这个科目还没有题目');
    return;
  }
  state.session = {
    id: newId(),
    mode: 'loop',
    code,
    title: `${subjectName(code)} · 全量循环`,
    ids: questions.map((q) => q.id),
    index: 0,
    cycle: 0,
    answers: {},
    drafts: {},
    startedAt: Date.now(),
    limitSec: 0,
    counts: countBy(questions),
    answeredCount: 0,
    correctCount: 0,
    streak: 0,
    maxStreak: 0,
  };
  LS.set('dx.session', state.session);
  state.lastResult = null;
  location.hash = '#/play';
}

function startPaper(code, counts, limitMin) {
  const codes = code === 'mix' ? state.index.subjects.map((s) => s.code) : [code];
  const pool = { fill: [], single: [], judge: [] };
  for (const c of codes) {
    for (const q of state.bank.subjects[c].questions) pool[q.type].push(q);
  }
  const picked = [];
  for (const type of ['fill', 'single', 'judge']) {
    const n = clamp(Number(counts[type]) || 0, 0, pool[type].length);
    picked.push(...shuffle(pool[type]).slice(0, n));
  }
  if (!picked.length) {
    toast('至少要选一道题');
    return;
  }
  state.session = {
    id: newId(),
    mode: 'paper',
    code,
    title: `${subjectName(code)} · 随机组卷 ${shortTag()}`,
    ids: picked.map((q) => q.id),
    index: 0,
    cycle: 0,
    answers: {},
    drafts: {},
    startedAt: Date.now(),
    limitSec: Math.max(0, Number(limitMin) || 0) * 60,
    counts: countBy(picked),
    paperConfig: { code, counts: { ...counts }, limitMin: Math.max(0, Number(limitMin) || 0) },
    answeredCount: 0,
    correctCount: 0,
    streak: 0,
    maxStreak: 0,
  };
  LS.set('dx.session', state.session);
  state.lastResult = null;
  location.hash = '#/play';
}

function currentQuestion() {
  const s = state.session;
  return s ? state.qmap.get(s.ids[s.index]) : null;
}

function currentAnswer(q) {
  return state.session?.answers?.[q.id] || null;
}

function saveSession() {
  if (state.session) LS.set('dx.session', state.session);
}

/* ======================================================================
 *  判分
 * ==================================================================== */
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：,.;:!?！？（）()【】\[\]{}<>《》"'“”‘’·—\-_/\\|]/g, '');

function fillBlankCorrect(expected, value) {
  const v = norm(value);
  if (!v) return false;
  const alts = [];
  for (const alt of expected || []) {
    alts.push(alt);
    const cut = String(alt).search(/[（(]/);
    if (cut > 0) alts.push(String(alt).slice(0, cut));
  }
  for (const alt of alts) {
    const a = norm(alt);
    if (!a) continue;
    if (a === v) return true;
    if (a.length >= 2 && (v.includes(a) || a.includes(v))) return true;
  }
  return false;
}

function checkFill(q, values) {
  const blanks = Math.max(1, q.blanks || 1);
  const valuesArr = Array.from({ length: blanks }, (_, i) => values?.[i] ?? '');
  let groups = q.accept || [];
  if (groups.length !== blanks) {
    const flat = groups.flat();
    groups = Array.from({ length: blanks }, () => flat);
  }
  const perBlank = valuesArr.map((v, i) => fillBlankCorrect(groups[i], v));
  return { correct: perBlank.every(Boolean), perBlank, blanks };
}

function grade(q, chosen) {
  if (q.type === 'fill') return checkFill(q, chosen).correct;
  if (q.type === 'judge') return Boolean(chosen) === Boolean(q.answer);
  return chosen === q.answer;
}

function answerTextOf(q) {
  if (q.type === 'single') {
    const opt = (q.options || []).find((o) => o.key === q.answer);
    return `${q.answer}. ${opt ? opt.text : ''}`;
  }
  if (q.type === 'judge') return q.answer ? '对（正确）' : '错（错误）';
  return q.answerText || q.answer || '';
}

function chosenTextOf(q, chosen) {
  if (chosen === undefined || chosen === null || chosen === '') return '（未作答）';
  if (q.type === 'single') {
    const opt = (q.options || []).find((o) => o.key === chosen);
    return `${chosen}. ${opt ? opt.text : ''}`;
  }
  if (q.type === 'judge') return chosen ? '对' : '错';
  if (Array.isArray(chosen)) return chosen.map((v) => v || '（空）').join(' / ');
  return String(chosen);
}

/* ======================================================================
 *  路由
 * ==================================================================== */
function showView(name) {
  for (const id of ['home', 'setup', 'play', 'result', 'wrong', 'stats']) {
    const el = document.getElementById(`view-${id}`);
    if (el) el.classList.toggle('hidden', id !== name);
  }
}

function setNavActive(name) {
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
}

function route() {
  if (!state.bank) return;
  stopTimer();
  const raw = location.hash.replace(/^#/, '') || '/home';
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query || '');

  if (path === '/home') {
    showView('home');
    setNavActive('home');
    renderHome();
  } else if (path === '/setup') {
    showView('setup');
    setNavActive('home');
    renderSetup(params);
  } else if (path === '/play') {
    if (!state.session) {
      location.hash = '#/home';
      return;
    }
    showView('play');
    setNavActive('home');
    renderPlay();
  } else if (path === '/result') {
    if (!state.lastResult) state.lastResult = LS.get('dx.lastResult', null);
    if (!state.lastResult?.attempt) {
      location.hash = '#/stats';
      return;
    }
    showView('result');
    setNavActive('stats');
    renderResult();
  } else if (path === '/wrong') {
    showView('wrong');
    setNavActive('wrong');
    renderWrong();
  } else if (path === '/stats') {
    showView('stats');
    setNavActive('stats');
    renderStats();
  } else {
    location.hash = '#/home';
    return;
  }
  updateChrome();
  window.scrollTo(0, 0);
}

function updateChrome() {
  const wrongCount = Object.keys(state.wrong || {}).length;
  const badge = $('#nav-wrong-count');
  if (badge) {
    badge.textContent = wrongCount > 99 ? '99+' : String(wrongCount);
    badge.classList.toggle('hidden', wrongCount === 0);
  }
  const nick = $('#nick-text');
  if (nick) nick.textContent = state.nickname;
  if (state.online) setConn('online', '已连接');
  else setConn('offline', Api.enabled ? '本地模式' : '离线刷题');
}

/* ======================================================================
 *  首页
 * ==================================================================== */
const RANK_CLASS = (score) => {
  const key = rankOf(score).key;
  return key.replace('+', 'plus');
};

function renderHome() {
  const view = $('#view-home');
  const profile = state.profile || computeStats(state.attempts, state.wrong);
  const seenTotal = Object.values(profile.seen || {}).reduce((a, b) => a + b, 0);
  const totalQ = state.index?.total || 0;
  const delta = state.lastResult?.delta;

  const subjectCards = (state.index?.subjects || [])
    .map((meta) => {
      const seen = profile.seen?.[meta.code] || 0;
      const pct = meta.total ? Math.round((seen / meta.total) * 100) : 0;
      const hue = SUBJECT_HUES[meta.code] || ['#ffd36e', '#ff8a5c'];
      return `
      <article class="subject-card" style="--c1:${hue[0]};--c2:${hue[1]}">
        <div class="subject-top">
          <span class="subject-code">${meta.code}</span>
          <span class="subject-count">${meta.total} 题</span>
        </div>
        <h3>${esc(meta.name)}</h3>
        <div class="subject-sub">${esc(meta.short)} · 客观题</div>
        <div class="type-chips">
          <span class="type-chip">填空 ${meta.counts.fill || 0}</span>
          <span class="type-chip">选择 ${meta.counts.single || 0}</span>
          <span class="type-chip">判断 ${meta.counts.judge || 0}</span>
        </div>
        <div class="progress-line"><i style="width:${pct}%"></i></div>
        <div class="progress-meta"><span>已练 ${seen}/${meta.total}</span><span>${pct}%</span></div>
        <div class="subject-actions">
          <button class="btn ghost sm" data-act="loop" data-code="${meta.code}">全量循环</button>
          <button class="btn sm" data-act="paper" data-code="${meta.code}">随机组卷</button>
        </div>
      </article>`;
    })
    .join('');

  const recent = (state.attempts || []).slice(0, 5);
  const recentHtml = recent.length
    ? recent
        .map((a) => {
          const rc = rankColor(a.score);
          return `
        <div class="recent-row" data-attempt="${esc(a.id)}">
          <div class="recent-rank" style="--rc1:${rc.c1};--rc2:${rc.c2}">${esc(a.rank || rankOf(a.score).key)}</div>
          <div class="recent-main">
            <b>${esc(a.title || subjectName(a.subject))}</b>
            <span>${a.mode === 'loop' ? '循环练习' : '随机组卷'} · ${a.total} 题 · ${fmtDateTime(a.createdAt)}</span>
          </div>
          <div class="recent-score">${formatScore(a.score)}<small>%</small></div>
          <div class="recent-score" style="font-size:14px;color:#8b7ba3">+${Number(a.singleRating || 0).toFixed(1)}</div>
        </div>`;
        })
        .join('')
    : '<div class="empty">还没有练习记录，先从上面的科目开始吧。</div>';

  view.innerHTML = `
  <div class="hero">
    <div class="hero-copy">
      <span class="eyebrow">2026 校考 · 四科客观题</span>
      <h1>刷题 <em>DX</em></h1>
      <p>全量无限循环，把每一道客观题刷到滚瓜烂熟；随机组卷，用一张卷子验收成果。
      题库来自《四科模拟试卷 · 纠错解析与挖空版》，答案已按勘误表修正。</p>
      <div class="hero-stats">
        <div class="stat-pill"><b>${totalQ}</b><span>道客观题</span></div>
        <div class="stat-pill"><b>${state.index?.subjects?.length || 4}</b><span>个科目</span></div>
        <div class="stat-pill"><b>${seenTotal}</b><span>已练题次</span></div>
        <div class="stat-pill"><b>${profile.accuracy.toFixed(1)}%</b><span>总正确率</span></div>
      </div>
    </div>
    <div class="hero-side">
      <div class="rating-card">
        <small>刷题力 · BEST ${RATING_SLOTS}</small>
        <div class="rating-value">
          <b>${Number(profile.rating || 0).toFixed(1)}</b>
          ${delta ? `<span class="delta">${delta >= 0 ? '+' : ''}${delta.toFixed(1)}</span>` : ''}
        </div>
        <div class="rating-meta"><span>已记录 ${profile.attempts} 卷</span><span>最高 ${profile.bestScore.toFixed(1)}%</span></div>
      </div>
      <div class="mode-tiles">
        <button class="mode-tile" data-act="mode" data-mode="loop">
          <b>♾️ 全量无限循环</b><span>按顺序刷完全部题目，自动进入下一轮</span>
        </button>
        <button class="mode-tile" data-act="mode" data-mode="paper">
          <b>🎲 随机组卷刷卷</b><span>按题型抽题成卷，限时作答后结算</span>
        </button>
      </div>
    </div>
  </div>

  <div class="section-head">
    <h2>选择科目</h2>
    <span class="hint">分科进入 · 题库可独立托管</span>
    <span class="spacer"></span>
    <button class="btn ghost sm" data-act="mix">四科混排组卷</button>
  </div>
  <div class="subject-grid">${subjectCards}</div>

  <div class="section-head">
    <h2>最近练习</h2>
    <span class="hint">点击查看结算</span>
    <span class="spacer"></span>
    <a href="#/stats" class="btn ghost sm">全部战绩</a>
  </div>
  <div class="recent-list">${recentHtml}</div>
  `;

  view.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'mode') {
        state.setup = { mode: btn.dataset.mode, code: '13006' };
        location.hash = '#/setup';
      } else if (act === 'loop' || act === 'paper') {
        location.hash = `#/setup?mode=${act}&code=${btn.dataset.code}`;
      } else if (act === 'mix') {
        location.hash = '#/setup?mode=paper&code=mix';
      }
    });
  });

  view.querySelectorAll('[data-attempt]').forEach((row) => {
    row.addEventListener('click', () => {
      const attempt = state.attempts.find((a) => a.id === row.dataset.attempt);
      if (!attempt) return;
      state.lastResult = { attempt, stats: state.profile, delta: 0, history: true };
      location.hash = '#/result';
    });
  });
}

const SUBJECT_HUES = {
  '13006': ['#ffd36e', '#ff8a5c'],
  '13007': ['#8fd3ff', '#5a8dff'],
  '13008': ['#c4a7ff', '#7b5cff'],
  '13014': ['#7cf0c8', '#12b886'],
};

/* ======================================================================
 *  配置页
 * ==================================================================== */
function availableCounts(code) {
  const codes = code === 'mix' ? state.index.subjects.map((s) => s.code) : [code];
  const counts = { fill: 0, single: 0, judge: 0 };
  for (const c of codes) {
    const meta = state.index.subjects.find((m) => m.code === c);
    if (!meta) continue;
    counts.fill += meta.counts.fill || 0;
    counts.single += meta.counts.single || 0;
    counts.judge += meta.counts.judge || 0;
  }
  return counts;
}

function defaultCounts(code) {
  const avail = availableCounts(code);
  return { fill: Math.min(5, avail.fill), single: Math.min(10, avail.single), judge: Math.min(10, avail.judge) };
}

function renderSetup(params) {
  const view = $('#view-setup');
  const prev = state.setup || {};
  const mode = params.get('mode') || prev.mode || 'paper';
  let code = params.get('code') || prev.code || '13006';
  if (code !== 'mix' && !state.bank.subjects[code]) code = '13006';

  const setup = {
    mode,
    code,
    order: prev.order || 'seq',
    limitMin: prev.limitMin ?? 20,
    counts: prev.code === code && prev.counts ? prev.counts : defaultCounts(code),
  };
  state.setup = setup;

  const subjects = state.index.subjects;
  const avail = availableCounts(code);
  const totalSelected = setup.counts.fill + setup.counts.single + setup.counts.judge;
  const diff = difficultyOf(setup.counts);

  const subjectOpts = [
    ...subjects.map((m) => ({ code: m.code, name: m.name, short: m.short, count: m.total, hue: SUBJECT_HUES[m.code] })),
    { code: 'mix', name: '四科混排', short: '随机抽四科', count: state.index.total, hue: ['#ffb15c', '#8b5cff'] },
  ]
    .map(
      (s) => `
      <button class="subject-opt ${s.code === code ? 'active' : ''}" data-code="${s.code}">
        <span class="dot-c" style="--c:${s.hue[0]}"></span>
        <span>${esc(s.name)}<small>${s.count} 题 · ${esc(s.short)}</small></span>
      </button>`,
    )
    .join('');

  const countRow = [['fill', '填空题'], ['single', '单选题'], ['judge', '判断题']]
    .map(
      ([type, label]) => `
      <div class="count-box">
        <label>${label}<b data-avail="${type}">${avail[type]}</b></label>
        <div class="stepper">
          <button data-step="${type}" data-d="-1" aria-label="减少">−</button>
          <input type="number" min="0" max="${avail[type]}" value="${setup.counts[type]}" data-count="${type}" inputmode="numeric" />
          <button data-step="${type}" data-d="1" aria-label="增加">+</button>
        </div>
      </div>`,
    )
    .join('');

  view.innerHTML = `
  <div class="setup-wrap">
    <div class="setup-title">
      <a class="back-link" href="#/home" aria-label="返回">←</a>
      <div>
        <h1>配置本轮练习</h1>
        <div class="hint" style="color:#8b7ba3;font-weight:700;font-size:13px">选好模式和科目，随时可以改</div>
      </div>
    </div>
    <div class="setup-card">
      <div class="mode-switch">
        <button data-mode="loop" class="${mode === 'loop' ? 'active' : ''}">♾️ 全量无限循环<small>一题一判，刷完自动下一轮</small></button>
        <button data-mode="paper" class="${mode === 'paper' ? 'active' : ''}">🎲 随机组卷刷卷<small>抽题成卷，交卷后结算</small></button>
      </div>

      <div class="field">
        <div class="field-label">科目</div>
        <div class="subject-picker">${subjectOpts}</div>
      </div>

      ${
        mode === 'loop'
          ? `<div class="field">
              <div class="field-label">出题顺序</div>
              <div class="seg">
                <button data-order="seq" class="${setup.order !== 'rand' ? 'active' : ''}">按题库原序</button>
                <button data-order="rand" class="${setup.order === 'rand' ? 'active' : ''}">随机打乱</button>
              </div>
            </div>`
          : `<div class="field">
              <div class="field-label">题型配比</div>
              <div class="count-grid">${countRow}</div>
            </div>
            <div class="field">
              <div class="field-label">限时</div>
              <div class="seg">
                ${[0, 10, 20, 30, 45]
                  .map((n) => `<button data-limit="${n}" class="${setup.limitMin === n ? 'active' : ''}">${n ? `${n} 分钟` : '不限时'}</button>`)
                  .join('')}
              </div>
            </div>`
      }

      <div class="summary-bar">
        <span>本轮 <b>${mode === 'loop' ? state.index.subjects.reduce((n, m) => n + (code === 'mix' || m.code === code ? m.total : 0), 0) : totalSelected}</b> 题</span>
        <span>试卷定数 <b>${diff}</b></span>
        ${mode === 'paper' ? `<span>限时 <b>${setup.limitMin ? setup.limitMin + ' 分钟' : '不限'}</b></span>` : '<span>可随时结束并结算</span>'}
      </div>

      <div class="setup-actions">
        <a class="btn ghost" href="#/home">取消</a>
        <button class="btn violet lg" id="start-btn" ${mode === 'paper' && totalSelected === 0 ? 'disabled' : ''}>开始${mode === 'loop' ? '循环' : '答题'} →</button>
      </div>
    </div>
  </div>`;

  const rerender = () => renderSetup(params);

  view.querySelectorAll('[data-mode]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.setup = { ...setup, mode: btn.dataset.mode, counts: setup.counts };
      rerender();
    }),
  );

  view.querySelectorAll('.subject-opt').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.setup = { ...setup, code: btn.dataset.code, counts: defaultCounts(btn.dataset.code) };
      rerender();
    }),
  );

  view.querySelectorAll('[data-order]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.setup = { ...setup, order: btn.dataset.order };
      rerender();
    }),
  );

  view.querySelectorAll('[data-limit]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.setup = { ...setup, limitMin: Number(btn.dataset.limit) };
      rerender();
    }),
  );

  view.querySelectorAll('[data-step]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const type = btn.dataset.step;
      const next = clamp((setup.counts[type] || 0) + Number(btn.dataset.d), 0, avail[type]);
      state.setup = { ...setup, counts: { ...setup.counts, [type]: next } };
      rerender();
    }),
  );

  view.querySelectorAll('[data-count]').forEach((input) =>
    input.addEventListener('change', () => {
      const type = input.dataset.count;
      const next = clamp(Math.round(Number(input.value) || 0), 0, avail[type]);
      state.setup = { ...setup, counts: { ...setup.counts, [type]: next } };
      rerender();
    }),
  );

  $('#start-btn')?.addEventListener('click', () => {
    if (mode === 'loop') startLoop(code, setup.order);
    else startPaper(code, setup.counts, setup.limitMin);
  });
}

/* ======================================================================
 *  答题页
 * ==================================================================== */
function renderPlay() {
  const view = $('#view-play');
  const s = state.session;
  if (!s) return;

  view.innerHTML = `
  <div class="play-shell">
    <div class="play-head">
      <button class="back-link" id="play-exit" aria-label="退出">←</button>
      <div class="who">
        <span class="code">${s.code === 'mix' ? 'MIX' : s.code}</span>
        <span>${esc(subjectName(s.code))}</span>
      </div>
      <span class="mini-tile" style="padding:5px 10px;border-radius:999px;font-size:11px">${s.mode === 'loop' ? '全量循环' : '随机组卷'}</span>
      <span class="spacer"></span>
      <span class="chip" id="play-progress-chip">第 1 / ${s.ids.length}</span>
      <div class="timer" id="play-timer">00:00</div>
    </div>
    <div class="progress-track"><i id="play-progress" style="width:0%"></i></div>
    <div id="play-stage"></div>
    <div id="play-extra"></div>
  </div>`;

  $('#play-exit').addEventListener('click', exitPlay);
  renderPlayStage();
  startTimer();
}

function updatePlayHead() {
  const s = state.session;
  const pct = s.ids.length ? ((s.index + 1) / s.ids.length) * 100 : 0;
  const bar = $('#play-progress');
  if (bar) bar.style.width = `${pct}%`;
  const chip = $('#play-progress-chip');
  if (chip) chip.textContent = s.mode === 'loop' ? `第 ${s.cycle + 1} 轮 · ${s.index + 1}/${s.ids.length}` : `第 ${s.index + 1} / ${s.ids.length}`;
}

function renderPlayStage() {
  const s = state.session;
  const q = currentQuestion();
  const stage = $('#play-stage');
  const extra = $('#play-extra');
  if (!q || !stage) return;

  const ans = currentAnswer(q);
  const feedback = s.mode === 'loop' && ans ? ans : null;
  const isPaper = s.mode === 'paper';
  const multiBlanks = q.type === 'fill' && (q.blanks || 1) > 1;

  let body = '';
  if (q.type === 'single') {
    body = `<div class="options">${(q.options || [])
      .map((o) => {
        let cls = 'option';
        if (ans && ans.chosen === o.key) cls += ' chosen';
        if (feedback) {
          if (o.key === q.answer) cls += ' correct';
          else if (ans.chosen === o.key) cls += ' wrong';
          else cls += ' dim';
        }
        return `<button class="${cls}" data-opt="${o.key}" ${feedback ? 'disabled' : ''}>
          <span class="key">${o.key}</span><span>${esc(o.text)}</span>
        </button>`;
      })
      .join('')}</div>`;
  } else if (q.type === 'judge') {
    const t = ans?.chosen === true;
    const f = ans?.chosen === false;
    let tCls = 'judge-btn t';
    let fCls = 'judge-btn f';
    if (feedback) {
      if (q.answer) tCls += ' correct-t';
      else fCls += ' correct-f';
      if (t) tCls += ' chosen';
      if (f) fCls += ' chosen';
    } else {
      if (t) tCls += ' chosen';
      if (f) fCls += ' chosen';
    }
    body = `<div class="judge-row">
      <button class="${tCls}" data-judge="1" ${feedback ? 'disabled' : ''}>✓<small>正确</small></button>
      <button class="${fCls}" data-judge="0" ${feedback ? 'disabled' : ''}>✗<small>错误</small></button>
    </div>`;
  } else {
    const draft = state.session.drafts?.[q.id];
    const values = Array.isArray(ans?.chosen) ? ans.chosen : (Array.isArray(draft) ? draft : []);
    const perBlank = feedback?.perBlank || [];
    body = `<div class="fill-row">${Array.from({ length: Math.max(1, q.blanks || 1) })
      .map((_, i) => {
        let cls = 'fill-input';
        if (feedback) cls += perBlank[i] ? ' correct' : ' wrong';
        return `<div class="fill-item">
          <span class="tag">${multiBlanks ? `第${i + 1}空` : '答案'}</span>
          <input class="${cls}" data-fill="${i}" value="${esc(values[i] || '')}" placeholder="输入答案…"
            ${feedback ? 'disabled' : ''} autocomplete="off" />
        </div>`;
      })
      .join('')}</div>`;
  }

  const streakChip =
    s.mode === 'loop' && s.streak >= 2 ? `<span class="streak-chip">🔥 连对 ${s.streak}</span>` : '';

  stage.innerHTML = `
  <div class="q-card">
    <div class="q-meta">
      <span class="q-type ${q.type}">${TYPE_LABEL[q.type] || q.type}</span>
      <span class="q-no">原卷题号 ${q.no} · ${q.id}</span>
      ${streakChip}
    </div>
    <div class="q-stem">${richText(q.stem)}</div>
    ${body}
    ${
      s.mode === 'loop' && !feedback
        ? `<div class="q-hint">${
            q.type === 'single'
              ? '点击选项立即判分，答完即可看解析'
              : q.type === 'judge'
                ? '点击「正确 / 错误」立即判分'
                : '填完后点「确认答案」或按回车'
          }</div>`
        : ''
    }
    <div class="q-actions" id="q-actions"></div>
  </div>`;

  renderActions(q, ans, feedback);
  if (s.mode === 'loop' && feedback) renderFeedback(q, ans);
  else if (extra) extra.innerHTML = '';

  updatePlayHead();

  stage.querySelectorAll('[data-opt]').forEach((btn) =>
    btn.addEventListener('click', () => pickSingle(q, btn.dataset.opt)),
  );
  stage.querySelectorAll('[data-judge]').forEach((btn) =>
    btn.addEventListener('click', () => pickJudge(q, btn.dataset.judge === '1')),
  );
  stage.querySelectorAll('[data-fill]').forEach((input) =>
    input.addEventListener('input', () => {
      const values = collectFillValues();
      if (state.session.mode === 'paper') {
        state.session.answers[q.id] = { ...(state.session.answers[q.id] || {}), chosen: values, correct: grade(q, values) };
      } else {
        state.session.drafts ||= {};
        state.session.drafts[q.id] = values;
      }
      saveSession();
    }),
  );
  stage.querySelectorAll('[data-fill]').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (s.mode === 'loop') submitFill(q);
        else nextQuestion();
      }
    });
  });

  const firstInput = stage.querySelector('[data-fill]');
  if (firstInput && !feedback && window.matchMedia('(pointer:fine)').matches) {
    firstInput.focus();
  }
}

function renderActions(q, ans, feedback) {
  const s = state.session;
  const actions = $('#q-actions');
  if (!actions) return;
  if (s.mode === 'loop') {
    if (!ans) {
      actions.innerHTML = `
        <button class="btn ghost sm" id="act-skip">跳过这题</button>
        <span class="spacer"></span>
        ${q.type === 'fill' ? '<button class="btn" id="act-check">确认答案</button>' : ''}
        <button class="btn dark sm" id="act-finish">结束并结算</button>`;
      $('#act-skip')?.addEventListener('click', () => nextQuestion(true));
      $('#act-check')?.addEventListener('click', () => submitFill(q));
      $('#act-finish')?.addEventListener('click', finishLoop);
    } else {
      actions.innerHTML = `
        <button class="btn dark sm" id="act-finish">结束并结算</button>
        <span class="spacer"></span>
        <button class="btn lg" id="act-next">下一题 →</button>`;
      $('#act-next')?.addEventListener('click', () => nextQuestion());
      $('#act-finish')?.addEventListener('click', finishLoop);
    }
  } else {
    const last = s.index >= s.ids.length - 1;
    actions.innerHTML = `
      <button class="btn ghost sm" id="act-sheet">答题卡</button>
      <span class="spacer"></span>
      <button class="btn ghost sm" id="act-prev" ${s.index === 0 ? 'disabled' : ''}>← 上一题</button>
      <button class="btn sm" id="act-next">${last ? '检视答卷' : '下一题 →'}</button>
      <button class="btn violet sm" id="act-submit">交卷</button>`;
    $('#act-prev')?.addEventListener('click', prevQuestion);
    $('#act-next')?.addEventListener('click', () => (last ? openAnswerSheet() : nextQuestion()));
    $('#act-submit')?.addEventListener('click', () => submitPaper());
    $('#act-sheet')?.addEventListener('click', openAnswerSheet);
  }
}

function collectFillValues() {
  const inputs = $$('#play-stage [data-fill]');
  return inputs.map((i) => i.value);
}

function pickSingle(q, key) {
  const s = state.session;
  if (s.mode === 'loop') {
    if (currentAnswer(q)) return;
    const correct = grade(q, key);
    recordLoopAnswer(q, key, correct);
    renderPlayStage();
    setTimeout(() => $('#act-next')?.focus(), 30);
  } else {
    s.answers[q.id] = { chosen: key, correct: grade(q, key) };
    saveSession();
    renderPlayStage();
    setTimeout(() => $('#act-next')?.focus(), 30);
  }
}

function pickJudge(q, value) {
  const s = state.session;
  if (s.mode === 'loop') {
    if (currentAnswer(q)) return;
    const correct = grade(q, value);
    recordLoopAnswer(q, value, correct);
    renderPlayStage();
    setTimeout(() => $('#act-next')?.focus(), 30);
  } else {
    s.answers[q.id] = { chosen: value, correct: grade(q, value) };
    saveSession();
    renderPlayStage();
    setTimeout(() => $('#act-next')?.focus(), 30);
  }
}

function submitFill(q) {
  if (state.session.mode !== 'loop') return;
  if (currentAnswer(q)) return;
  const values = collectFillValues();
  if (values.every((v) => !v.trim())) {
    toast('先写下你的答案');
    return;
  }
  const result = checkFill(q, values);
  recordLoopAnswer(q, values, result.correct, result.perBlank);
  renderPlayStage();
}

function recordLoopAnswer(q, chosen, correct, perBlank) {
  const s = state.session;
  s.answers[q.id] = { chosen, correct, perBlank };
  s.answeredCount += 1;
  if (correct) {
    s.correctCount += 1;
    s.streak += 1;
    s.maxStreak = Math.max(s.maxStreak, s.streak);
  } else {
    s.streak = 0;
  }
  updateWrong(q, chosen, correct);
  saveSession();
  updateChrome();
}

function renderFeedback(q, ans) {
  const extra = $('#play-extra');
  if (!extra) return;
  const good = ans.correct;
  extra.innerHTML = `
  <div class="feedback ${good ? 'good' : 'bad'}">
    <div class="fb-head">
      <span class="fb-mark">${good ? '✓' : '✗'}</span>
      ${good ? '答对了！' : '答错了'}
    </div>
    <div class="fb-answer">正确答案：<b>${esc(answerTextOf(q))}</b>${
      !good && q.type !== 'single' ? `<br>你的答案：${esc(chosenTextOf(q, ans.chosen))}` : ''
    }</div>
    ${q.explain ? `<div class="fb-explain">${richText(q.explain)}</div>` : ''}
    ${q.note ? `<div class="fb-note">📌 勘误：${richText(q.note)}</div>` : ''}
    ${
      !good && q.type === 'fill'
        ? `<div class="self-judge">写的答案和参考答案不一致？<button class="btn ghost sm" id="self-judge">判我对</button></div>`
        : ''
    }
  </div>`;
  $('#self-judge')?.addEventListener('click', () => {
    if (ans.correct) return;
    ans.correct = true;
    ans.selfJudged = true;
    state.session.correctCount += 1;
    state.session.streak += 1;
    state.session.maxStreak = Math.max(state.session.maxStreak, state.session.streak);
    delete state.wrong[q.id];
    LS.set('dx.wrong', state.wrong);
    saveSession();
    renderPlayStage();
    toast('已按自评判为正确');
  });
}

function updateWrong(q, chosen, correct) {
  if (correct) delete state.wrong[q.id];
  else {
    const prev = state.wrong[q.id];
    state.wrong[q.id] = {
      qid: q.id,
      code: q.id.split('-')[0],
      at: new Date().toISOString(),
      count: (prev?.count || 0) + 1,
      chosen,
    };
  }
  LS.set('dx.wrong', state.wrong);
}

function nextQuestion(skip = false) {
  const s = state.session;
  if (!s) return;
  if (skip && s.mode === 'loop') {
    /* 跳过不计分 */
  }
  s.index += 1;
  if (s.index >= s.ids.length) {
    if (s.mode === 'paper') {
      s.index = s.ids.length - 1;
      openAnswerSheet();
      return;
    }
    s.index = 0;
    s.cycle += 1;
    s.answers = {};
    s.drafts = {};
    toast(`第 ${s.cycle + 1} 轮开始，继续加油`);
  }
  saveSession();
  renderPlayStage();
}

function prevQuestion() {
  const s = state.session;
  if (!s || s.index === 0) return;
  s.index -= 1;
  saveSession();
  renderPlayStage();
}

function openAnswerSheet() {
  const s = state.session;
  const extra = $('#play-extra');
  if (!extra) return;
  if (extra.dataset.sheet === '1') {
    extra.dataset.sheet = '0';
    extra.innerHTML = '';
    return;
  }
  extra.dataset.sheet = '1';
  const cells = s.ids
    .map((id, i) => {
      const answered = Boolean(s.answers[id]);
      const cls = `sheet-cell${answered ? ' done' : ''}${i === s.index ? ' now' : ''}`;
      return `<button class="${cls}" data-jump="${i}">${i + 1}</button>`;
    })
    .join('');
  extra.innerHTML = `<div class="answer-sheet">
    <div class="field-label" style="margin-bottom:10px">答题卡 · 已答 ${Object.keys(s.answers).length}/${s.ids.length}</div>
    <div class="sheet-grid">${cells}</div>
  </div>`;
  extra.querySelectorAll('[data-jump]').forEach((btn) =>
    btn.addEventListener('click', () => {
      s.index = Number(btn.dataset.jump);
      extra.dataset.sheet = '0';
      extra.innerHTML = '';
      saveSession();
      renderPlayStage();
    }),
  );
}

/* ---------------- 计时器 ---------------- */
function startTimer() {
  stopTimer();
  const s = state.session;
  if (!s) return;
  if (s.mode === 'paper' && s.limitSec > 0) {
    tickTimer();
    state.timerId = setInterval(tickTimer, 500);
  } else {
    tickTimer();
    state.timerId = setInterval(tickTimer, 1000);
  }
}

function stopTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
}

function tickTimer() {
  const s = state.session;
  const el = $('#play-timer');
  if (!s || !el) return;
  if (s.mode === 'paper' && s.limitSec > 0) {
    const remain = s.startedAt + s.limitSec * 1000 - Date.now();
    el.textContent = `⏱ ${fmtClock(remain / 1000)}`;
    el.classList.toggle('danger', remain <= 60_000);
    if (remain <= 0) {
      stopTimer();
      toast('时间到，自动交卷');
      submitSession();
    }
  } else {
    const elapsed = (Date.now() - s.startedAt) / 1000;
    el.textContent = `⏱ ${fmtClock(elapsed)}`;
  }
}

/* ---------------- 退出 / 交卷 ---------------- */
async function exitPlay() {
  const s = state.session;
  if (!s) {
    location.hash = '#/home';
    return;
  }
  const ok = await confirmModal({
    title: '退出本轮练习？',
    desc: s.mode === 'paper' ? '已作答内容会保留，下次可从答题卡继续。' : '本轮进度会保留，下次继续。',
    okText: '退出',
    danger: true,
  });
  if (!ok) return;
  saveSession();
  location.hash = '#/home';
}

async function finishLoop() {
  const s = state.session;
  if (!s) return;
  if (!s.answeredCount) {
    toast('还没作答，先做一题吧');
    return;
  }
  const ok = await confirmModal({
    title: '结束本轮并结算？',
    desc: `已作答 ${s.answeredCount} 题，正确 ${s.correctCount} 题。结算后会写入战绩与错题本。`,
    okText: '结算',
  });
  if (!ok) return;
  submitSession();
}

async function submitPaper() {
  const s = state.session;
  if (!s) return;
  const answered = Object.keys(s.answers).length;
  const left = s.ids.length - answered;
  const ok = await confirmModal({
    title: left > 0 ? `还有 ${left} 题未作答，确定交卷？` : '交卷并结算？',
    desc: left > 0 ? '未作答的题会按错误计入本卷（不计入错题本）。' : '交卷后将立即出分，并写入战绩。',
    okText: '交卷',
    danger: left > 0,
  });
  if (!ok) return;
  submitSession();
}

/* ---------------- 结算 ---------------- */
async function submitSession() {
  if (state.saving) return;
  const s = state.session;
  if (!s) return;
  state.saving = true;
  stopTimer();
  try {
    const isLoop = s.mode === 'loop';
    const qs = s.ids.map((id) => state.qmap.get(id)).filter(Boolean);
    const answers = [];
    let correct = 0;
    let wrong = 0;
    let skipped = 0;

    for (const q of qs) {
      const a = s.answers[q.id];
      if (!a) {
        if (isLoop) continue;
        skipped += 1;
        answers.push({ qid: q.id, type: q.type, chosen: null, correct: false, skipped: true });
        continue;
      }
      if (a.correct) correct += 1;
      else wrong += 1;
      answers.push({
        qid: q.id,
        type: q.type,
        chosen: a.chosen,
        correct: Boolean(a.correct),
        ...(a.selfJudged ? { selfJudged: true } : {}),
      });
    }

    const total = isLoop ? answers.length : qs.length;
    if (!total) {
      toast('还没有可结算的作答');
      state.saving = false;
      return;
    }
    const score = round1((correct / total) * 100);
    const attemptedQs = answers.map((a) => state.qmap.get(a.qid)).filter(Boolean);
    const counts = countBy(attemptedQs);
    const durationSec = Math.round((Date.now() - s.startedAt) / 1000);
    const attempt = {
      id: s.id,
      uid: state.uid,
      mode: s.mode,
      subject: s.code,
      title: s.title,
      total,
      correct,
      wrong,
      skipped,
      score: Math.round((correct / total) * 1000000) / 10000,
      answers,
      counts,
      difficulty: difficultyOf(counts),
      durationSec,
      limitSec: s.limitSec,
      singleRating: singleRating(score, counts, s.mode),
      rank: rankOf(score).key,
      createdAt: new Date().toISOString(),
      ...(isLoop ? { cycle: s.cycle + 1 } : {}),
      ...(s.paperConfig ? { config: s.paperConfig } : {}),
    };

    const result = await saveAttempt(attempt);
    state.lastResult = result;
    LS.set('dx.lastResult', { attempt, stats: result.stats, delta: result.delta });
    state.session = null;
    LS.del('dx.session');
    state.saving = false;
    location.hash = '#/result';
  } catch (err) {
    console.error(err);
    state.saving = false;
    toast('结算失败，请重试');
  }
}

async function saveAttempt(attempt) {
  const prevRating = Number(state.profile?.rating || totalRating(state.attempts));
  state.attempts.unshift(attempt);
  if (state.attempts.length > 300) state.attempts.length = 300;
  updateWrongLocal(attempt);

  let stats = computeStats(state.attempts, state.wrong);
  let delta = round1(stats.rating - prevRating);
  if (state.online) {
    try {
      const res = await Api.saveAttempt(state.uid, state.nickname, attempt);
      if (res.stats) stats = res.stats;
      if (res.wrongbook) state.wrong = res.wrongbook;
      if (typeof res.ratingDelta === 'number') delta = round1(res.ratingDelta);
      if (res.user?.nickname) state.nickname = res.user.nickname;
    } catch (err) {
      console.warn('服务端保存失败，已降级为本地模式', err);
      state.online = false;
      setConn('offline', '本地模式');
    }
  }
  state.profile = stats;
  persistLocal();
  updateChrome();
  return { attempt, stats, delta };
}

/* ======================================================================
 *  结算页
 * ==================================================================== */
function rankWordHtml(key) {
  const plus = key.endsWith('+');
  const letters = plus ? key.slice(0, -1) : key;
  const size = letters.length >= 3 ? 'font-size:clamp(64px,11vw,128px)' : '';
  return `<div class="rank-word" data-text="${esc(letters)}" style="${size}">
    <span class="rank-fill">${esc(letters)}${plus ? '<span class="plus">+</span>' : ''}</span>
  </div>`;
}

const MASCOT_SVG = `
<svg viewBox="0 0 240 240" role="img" aria-label="刷题 DX 吉祥物">
  <defs>
    <linearGradient id="mg-body" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#6ea8ff"/><stop offset="1" stop-color="#2f6bff"/>
    </linearGradient>
    <linearGradient id="mg-belly" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4fbff"/><stop offset="1" stop-color="#cfe6ff"/>
    </linearGradient>
    <linearGradient id="mg-ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.5" stop-color="#ffe28a"/><stop offset="1" stop-color="#ff9ec7"/>
    </linearGradient>
  </defs>
  <circle cx="120" cy="118" r="104" fill="none" stroke="url(#mg-ring)" stroke-width="10" stroke-dasharray="20 11" opacity="0.95" transform="rotate(-14 120 118)"/>
  <circle cx="120" cy="118" r="88" fill="#ffffff" opacity="0.55"/>
  <path d="M64 132c0-34 24-56 58-56 33 0 56 21 56 52 0 11-3 20-8 28l24-14c2 11 1 22-3 32-9 22-34 35-67 35-32 0-55-14-62-38-4-12-3-26 2-39z" fill="url(#mg-body)" stroke="#ffffff" stroke-width="7" stroke-linejoin="round"/>
  <path d="M92 156c8-13 23-20 41-20 17 0 30 6 38 18 5 8 4 17-4 22-10 6-26 9-41 9-16 0-30-3-38-10-6-5-4-11 4-19z" fill="url(#mg-belly)" opacity="0.95"/>
  <path d="M108 94c0-9 8-16 17-16s16 7 16 15c0 9-7 16-16 16s-17-6-17-15z" fill="#1b2b55"/>
  <circle cx="130" cy="89" r="5.5" fill="#ffffff"/>
  <path d="M92 132c7-6 16-8 24-5" stroke="#1b2b55" stroke-width="5" stroke-linecap="round" fill="none" opacity="0.35"/>
  <circle cx="88" cy="146" r="9" fill="#ff9ec7" opacity="0.65"/>
  <path d="M120 62c0-12 9-20 20-20 3 0 6 1 8 2" stroke="#ffffff" stroke-width="7" stroke-linecap="round" fill="none" opacity="0.9"/>
  <circle cx="163" cy="47" r="9" fill="#ffffff" opacity="0.85"/>
  <circle cx="183" cy="66" r="6" fill="#ffffff" opacity="0.7"/>
  <circle cx="188" cy="40" r="4" fill="#ffe28a"/>
  <g transform="translate(63 196) rotate(-6)">
    <rect x="0" y="0" width="72" height="30" rx="15" fill="#33244a"/>
    <text x="36" y="21" text-anchor="middle" font-family="sans-serif" font-size="17" font-weight="900" fill="#ffd166">DX</text>
  </g>
</svg>`;

function renderResult() {
  const view = $('#view-result');
  const { attempt, stats, delta } = state.lastResult || {};
  if (!attempt) return;
  const score = Number(attempt.score) || 0;
  const key = attempt.rank || rankOf(score).key;
  const colors = rankColor(score);
  const qs = (attempt.answers || []).map((a) => ({ a, q: state.qmap.get(a.qid) })).filter((x) => x.q);
  const selfJudged = qs.filter((x) => x.a.selfJudged).length;
  const perfect = attempt.correct === attempt.total && attempt.total > 0;
  const noWrong = attempt.wrong === 0;
  const badges = [];
  if (perfect) badges.push('<span class="badge-pill warm">🏆 ALL PERFECT</span>');
  else if (noWrong) badges.push('<span class="badge-pill green">✅ FULL COMBO</span>');
  if (attempt.limitSec > 0 && attempt.durationSec <= attempt.limitSec) badges.push('<span class="badge-pill">⏱ 限时内完成</span>');
  if (attempt.mode === 'loop') badges.push('<span class="badge-pill">♾️ 循环练习</span>');
  if (selfJudged) badges.push(`<span class="badge-pill">✍️ 含 ${selfJudged} 题自评</span>`);

  const review = qs
    .filter((x) => !x.a.correct || x.a.skipped)
    .map(({ a, q }) => `
      <div class="review-item">
        <div class="review-head">
          <span class="mark${a.correct ? ' ok' : ''}">${a.correct ? '✓' : '✗'}</span>
          <span>${richText(q.stem)}</span>
        </div>
        <div class="review-body">
          你的答案：<span class="mine">${esc(a.skipped ? '（未作答）' : chosenTextOf(q, a.chosen))}</span><br>
          正确答案：<span class="ans">${esc(answerTextOf(q))}</span>
          ${q.explain ? `<div class="exp">${richText(q.explain)}</div>` : ''}
          ${q.note ? `<div class="exp" style="color:#9a6a00">📌 勘误：${richText(q.note)}</div>` : ''}
        </div>
      </div>`)
    .join('');

  view.innerHTML = `
  <div class="result-wrap">
    <div class="result-stage" data-rank="${esc(key)}">
      <div class="result-banner"><span>${perfect ? 'PERFECT!' : 'CLEAR!'}</span></div>
      <div class="result-body">
        <div class="result-main">
          <div class="song-card">
            <div class="song-diff"><b>${attempt.subject === 'mix' ? 'MIX' : esc(attempt.subject)}</b><small>${attempt.total} 题</small></div>
            <div class="song-info">
              <div class="song-cat">SUBJECT <span class="tag">${attempt.mode === 'loop' ? 'LOOP' : 'PAPER'}</span></div>
              <div class="song-title">${esc(attempt.title || subjectName(attempt.subject))}</div>
            </div>
            <div class="song-lv">LV <b>${attempt.difficulty || 1200}</b></div>
          </div>

          <div class="achv">
            <div class="achv-label"><i>✦</i> ACHIEVEMENT <span style="letter-spacing:0">››</span></div>
            <div class="achv-score">${formatScore(score)}<small>%</small></div>
          </div>

          ${rankWordHtml(key)}
          <div class="badges">${badges.join('')}</div>
        </div>

        <div class="result-side">
          <div class="mascot-wrap">${MASCOT_SVG}</div>
          <div class="stat-panel">
            <div class="counters">
              <div class="counter ac"><b>AC 正确</b><span>${attempt.correct}</span></div>
              <div class="counter wa"><b>WA 错误</b><span>${attempt.wrong}</span></div>
              <div class="counter sk"><b>SK 未答</b><span>${attempt.skipped || 0}</span></div>
              ${selfJudged ? `<div class="counter sf"><b>SF 自评</b><span>${selfJudged}</span></div>` : ''}
            </div>
            <div class="mini-tile">
              <small>DX RATING</small>
              <b>${Number(stats?.rating || 0).toFixed(1)}${delta ? `<span class="delta ${delta < 0 ? 'neg' : ''}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)}</span>` : ''}</b>
            </div>
            <div class="mini-tile time">
              <small>PLAY TIME</small>
              <b>${fmtClock(attempt.durationSec)}</b>
            </div>
          </div>
          <div class="result-actions">
            <button class="btn ghost sm" id="res-home">返回首页</button>
            <button class="btn sm" id="res-again">再来一份</button>
          </div>
        </div>
      </div>
    </div>

    <div class="result-detail">
      <h3>本卷回顾 <span class="pill">${qs.length - (attempt.wrong + (attempt.skipped || 0))} / ${qs.length} 正确</span></h3>
      ${review || '<div class="empty">全部答对，太强了！去挑战更高难度吧。</div>'}
    </div>
  </div>`;

  $('#res-home')?.addEventListener('click', () => (location.hash = '#/home'));
  $('#res-again')?.addEventListener('click', () => {
    const cfg = attempt.config;
    if (attempt.mode === 'paper' && cfg) startPaper(cfg.code, cfg.counts, cfg.limitMin);
    else {
      state.setup = { mode: attempt.mode, code: attempt.subject };
      location.hash = '#/setup';
    }
  });
}

/* ======================================================================
 *  错题本
 * ==================================================================== */
function wrongEntries() {
  return Object.values(state.wrong || {})
    .filter((w) => state.qmap.has(w.qid))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function renderWrong() {
  const view = $('#view-wrong');
  const entries = wrongEntries();
  const list = entries
    .map((w) => {
      const q = state.qmap.get(w.qid);
      if (!q) return '';
      return `<details class="wrong-item">
        <summary>
          <span class="w-stem">${richText(q.stem)}</span>
          <span class="w-meta">${esc(q.id)}<br>错 ${w.count} 次</span>
        </summary>
        <div class="w-body">
          你的答案：<span style="color:#d61f45;font-weight:900">${esc(chosenTextOf(q, w.chosen))}</span><br>
          正确答案：<span style="color:#0b8f68;font-weight:900">${esc(answerTextOf(q))}</span>
          ${q.explain ? `<div style="margin-top:6px;color:#6b5b85">${richText(q.explain)}</div>` : ''}
          ${q.note ? `<div style="margin-top:6px;color:#9a6a00">📌 ${richText(q.note)}</div>` : ''}
        </div>
      </details>`;
    })
    .join('');

  view.innerHTML = `
  <div class="section-head" style="margin-top:4px">
    <h2>错题本</h2>
    <span class="hint">共 ${entries.length} 题 · 答对后自动移除</span>
    <span class="spacer"></span>
    <button class="btn violet sm" id="wrong-retry" ${entries.length ? '' : 'disabled'}>重练错题</button>
    <button class="btn ghost sm" id="wrong-clear" ${entries.length ? '' : 'disabled'}>清空</button>
  </div>
  ${list || '<div class="empty">错题本是空的。去刷题吧，做错的题会自动收进来。</div>'}`;

  $('#wrong-retry')?.addEventListener('click', () => {
    const codes = [...new Set(entries.map((e) => e.code).filter(Boolean))];
    const code = codes.length === 1 ? codes[0] : 'mix';
    const picked = entries.slice(0, 30).map((e) => state.qmap.get(e.qid)).filter(Boolean);
    startWrongPaper(picked, code);
  });

  $('#wrong-clear')?.addEventListener('click', async () => {
    const ok = await confirmModal({ title: '清空错题本？', desc: '只清空错题记录，不影响历史战绩。', okText: '清空', danger: true });
    if (!ok) return;
    state.wrong = {};
    LS.set('dx.wrong', {});
    if (state.online) {
      try {
        await fetch(`${Api.base}/api/wrongbook?uid=${encodeURIComponent(state.uid)}`, { method: 'DELETE' });
      } catch {
        /* 忽略 */
      }
    }
    updateChrome();
    renderWrong();
  });
}

function startWrongPaper(questions, code) {
  if (!questions.length) return;
  const counts = countBy(questions);
  state.session = {
    id: newId(),
    mode: 'paper',
    code,
    title: `${subjectName(code)} · 错题重练`,
    ids: questions.map((q) => q.id),
    index: 0,
    cycle: 0,
    answers: {},
    drafts: {},
    startedAt: Date.now(),
    limitSec: 0,
    counts,
    paperConfig: { code, counts, limitMin: 0 },
    answeredCount: 0,
    correctCount: 0,
    streak: 0,
    maxStreak: 0,
  };
  LS.set('dx.session', state.session);
  location.hash = '#/play';
}

/* ======================================================================
 *  战绩
 * ==================================================================== */
function renderStats() {
  const view = $('#view-stats');
  const p = state.profile || computeStats(state.attempts, state.wrong);
  const subjects = state.index.subjects
    .map((m) => {
      const bs = p.bySubject?.[m.code] || { attempts: 0, total: 0, correct: 0, best: 0 };
      const acc = bs.total ? round1((bs.correct / bs.total) * 100) : 0;
      const seen = p.seen?.[m.code] || 0;
      return `<div class="subject-card" style="--c1:${SUBJECT_HUES[m.code]?.[0] || '#ffd36e'};--c2:${SUBJECT_HUES[m.code]?.[1] || '#ff8a5c'}">
        <div class="subject-top"><span class="subject-code">${m.code}</span><span class="subject-count">${bs.attempts} 卷</span></div>
        <h3>${esc(m.name)}</h3>
        <div class="subject-sub">已练 ${seen}/${m.total} 题</div>
        <div class="progress-line" style="margin-top:14px"><i style="width:${Math.round((seen / m.total) * 100)}%"></i></div>
        <div class="progress-meta"><span>平均正确率 ${acc}%</span><span>最高 ${round1(bs.best)}%</span></div>
      </div>`;
    })
    .join('');

  const rows = state.attempts
    .slice(0, 40)
    .map((a) => {
      const rc = rankColor(a.score);
      return `<tr data-attempt="${esc(a.id)}">
        <td>${fmtDateTime(a.createdAt)}</td>
        <td>${esc(a.title || subjectName(a.subject))}</td>
        <td>${a.mode === 'loop' ? '循环' : '组卷'}</td>
        <td>${a.correct}/${a.total}</td>
        <td><b style="color:${rc.c1}">${formatScore(a.score)}%</b></td>
        <td>${esc(a.rank || rankOf(a.score).key)}</td>
        <td>+${Number(a.singleRating || 0).toFixed(1)}</td>
        <td>${fmtClock(a.durationSec)}</td>
      </tr>`;
    })
    .join('');

  view.innerHTML = `
  <div class="hero" style="grid-template-columns:1fr 340px">
    <div class="hero-copy">
      <span class="eyebrow">MY RECORD</span>
      <h1 style="font-size:clamp(34px,5vw,56px)">战绩 <em>总览</em></h1>
      <p>刷题力取历史最佳 ${RATING_SLOTS} 卷的单卷 Rating 之和。单卷 Rating 由得分率和试卷定数决定，与 maimai DX 同构。</p>
      <div class="hero-stats">
        <div class="stat-pill"><b>${p.attempts}</b><span>总卷数</span></div>
        <div class="stat-pill"><b>${p.accuracy.toFixed(1)}%</b><span>总正确率</span></div>
        <div class="stat-pill"><b>${p.bestScore.toFixed(1)}%</b><span>最高分</span></div>
        <div class="stat-pill"><b>${p.wrongCount}</b><span>错题</span></div>
      </div>
    </div>
    <div class="hero-side">
      <div class="rating-card">
        <small>DX RATING · BEST ${RATING_SLOTS}</small>
        <div class="rating-value"><b>${Number(p.rating).toFixed(1)}</b></div>
        <div class="rating-meta"><span>本地 + 服务端同步</span><span>${state.online ? '已连接' : '本地模式'}</span></div>
      </div>
      <div class="mode-tiles">
        <a class="mode-tile" href="#/setup?mode=paper"><b>🎲 组一套卷</b><span>随机抽题，限时结算</span></a>
        <a class="mode-tile" href="#/setup?mode=loop"><b>♾️ 开始循环</b><span>一题一判，无限刷</span></a>
      </div>
    </div>
  </div>

  <div class="section-head"><h2>分科进度</h2></div>
  <div class="subject-grid">${subjects}</div>

  <div class="section-head"><h2>练习记录</h2><span class="hint">最近 40 卷 · 点击查看结算</span></div>
  ${
    rows
      ? `<div class="panel" style="padding:8px 16px;overflow:auto"><table class="attempt-table">
          <thead><tr><th>时间</th><th>试卷</th><th>模式</th><th>对/总</th><th>得分</th><th>评级</th><th>单卷</th><th>用时</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
      : '<div class="empty">还没有练习记录。</div>'
  }`;

  view.querySelectorAll('[data-attempt]').forEach((row) => {
    row.addEventListener('click', () => {
      const attempt = state.attempts.find((a) => a.id === row.dataset.attempt);
      if (!attempt) return;
      state.lastResult = { attempt, stats: p, delta: 0, history: true };
      location.hash = '#/result';
    });
  });
}

/* ======================================================================
 *  弹窗 / Toast
 * ==================================================================== */
function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
  const mask = root.querySelector('.modal-mask');
  const close = () => {
    root.innerHTML = '';
  };
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  return { root, close };
}

function confirmModal({ title, desc = '', okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const { close, root } = openModal(`
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
      <div class="modal-actions">
        <button class="btn ghost" data-x="0">取消</button>
        <button class="btn ${danger ? 'dark' : 'violet'}" data-x="1">${esc(okText)}</button>
      </div>`);
    root.querySelectorAll('[data-x]').forEach((btn) =>
      btn.addEventListener('click', () => {
        close();
        resolve(btn.dataset.x === '1');
      }),
    );
  });
}

function promptModal({ title, desc = '', value = '', placeholder = '' }) {
  return new Promise((resolve) => {
    const { close, root } = openModal(`
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
      <input id="modal-input" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="18" />
      <div class="modal-actions">
        <button class="btn ghost" data-x="0">取消</button>
        <button class="btn violet" data-x="1">保存</button>
      </div>`);
    const input = root.querySelector('#modal-input');
    input?.focus();
    input?.select();
    root.querySelectorAll('[data-x]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const v = btn.dataset.x === '1' ? (input?.value || '').trim() : null;
        close();
        resolve(v);
      }),
    );
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') root.querySelector('[data-x="1"]')?.click();
    });
  });
}

let toastTimer = null;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ======================================================================
 *  键盘
 * ==================================================================== */
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (!location.hash.startsWith('#/play')) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' && e.key !== 'Enter') return;
    const s = state.session;
    if (!s) return;

    if (e.key >= '1' && e.key <= '4') {
      const q = currentQuestion();
      if (q?.type === 'single') {
        const opt = (q.options || [])[Number(e.key) - 1];
        if (opt && !currentAnswer(q)) pickSingle(q, opt.key);
      }
    } else if (e.key === 'Enter') {
      const q = currentQuestion();
      if (!q) return;
      if (q.type === 'fill' && s.mode === 'loop' && !currentAnswer(q)) submitFill(q);
      else if (currentAnswer(q) || s.mode === 'paper') nextQuestion();
    }
  });
}

/* ======================================================================
 *  顶栏交互
 * ==================================================================== */
function bindChrome() {
  $('#nick-btn')?.addEventListener('click', async () => {
    const name = await promptModal({
      title: '改个昵称',
      desc: '昵称只用于显示，成绩按本机身份（uid）归属。',
      value: state.nickname,
      placeholder: '例如：夜航鲸',
    });
    if (name === null) return;
    state.nickname = name || '学员';
    LS.set('dx.nick', state.nickname);
    updateChrome();
    if (state.online) {
      try {
        await Api.rename(state.uid, state.nickname);
      } catch {
        /* 忽略 */
      }
    }
    toast('昵称已更新');
  });

  $('#conn-chip')?.addEventListener('click', async () => {
    toast(state.online ? '服务端已连接' : '当前为本地模式，成绩保存在浏览器');
    if (!state.online) {
      await connectServer();
      refreshLocalProfile();
      updateChrome();
      route();
    }
  });
}

/* ======================================================================
 *  启动
 * ==================================================================== */
async function init() {
  bindChrome();
  bindKeyboard();
  try {
    await loadBank();
  } catch (err) {
    $('#main').innerHTML = `<div class="panel" style="padding:44px;text-align:center">
      <h2 style="margin:0 0 10px">题库加载失败</h2>
      <p style="color:#8b7ba3">${esc(err.message)}</p>
      <p style="color:#8b7ba3;font-size:13px">请检查 <code>web/js/config.js</code> 里的 <code>bankBase</code>，或确认 bank 目录已随页面一起部署。</p>
    </div>`;
    return;
  }

  const stored = LS.get('dx.session', null);
  if (stored && Array.isArray(stored.ids) && stored.ids.every((id) => state.qmap.has(id))) {
    state.session = stored;
  } else {
    if (stored) LS.del('dx.session');
    state.session = null;
  }

  refreshLocalProfile();
  updateChrome();
  await connectServer();
  if (!state.online) refreshLocalProfile();
  updateChrome();

  window.addEventListener('hashchange', route);
  route();
}

init();
