import { difficultyOf, rankOf, singleRating, totalRating } from './rating.mjs';

const clampInt = (n, lo, hi, fallback = 0) => {
  const v = Number.isFinite(Number(n)) ? Math.round(Number(n)) : fallback;
  return Math.max(lo, Math.min(hi, v));
};
const round = (n, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

const ANSWER_TYPES = new Set(['fill', 'single', 'judge']);

/** 把客户端提交的答卷清洗成可长期保存的结构（不信任客户端算分） */
export function normalizeAttempt(raw, uid) {
  if (!raw || typeof raw !== 'object') throw new Error('attempt 不合法');
  const mode = raw.mode === 'loop' ? 'loop' : 'paper';
  const id = String(raw.id || '').slice(0, 80) || `srv-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const subject = String(raw.subject || '').slice(0, 24) || 'mix';

  const answers = (Array.isArray(raw.answers) ? raw.answers : [])
    .slice(0, 500)
    .map((a) => ({
      qid: String(a?.qid || '').slice(0, 80),
      type: ANSWER_TYPES.has(a?.type) ? a.type : 'single',
      chosen: a?.chosen ?? null,
      correct: Boolean(a?.correct),
      ...(a?.skipped ? { skipped: true } : {}),
      ...(a?.selfJudged ? { selfJudged: true } : {}),
    }))
    .filter((a) => a.qid);

  const skipped = answers.filter((a) => a.skipped).length;
  const wrong = answers.filter((a) => !a.correct && !a.skipped).length;
  const correct = answers.filter((a) => a.correct && !a.skipped).length;

  let total = mode === 'loop' ? answers.length : clampInt(raw.total, 0, 500, answers.length);
  total = Math.max(answers.length, total);
  if (!total) throw new Error('空答卷');

  const counts = { fill: 0, single: 0, judge: 0 };
  for (const a of answers) counts[a.type] += 1;
  if (typeof raw.counts === 'object' && raw.counts) {
    for (const t of ['fill', 'single', 'judge']) {
      const v = Number(raw.counts[t]);
      if (Number.isFinite(v) && v >= 0) counts[t] = Math.min(500, Math.round(v));
    }
  }

  const score = Math.round((correct / total) * 1000000) / 10000;
  const difficulty = difficultyOf(counts);
  const createdAt = (() => {
    const d = new Date(raw.createdAt || Date.now());
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 86400000) return new Date().toISOString();
    return d.toISOString();
  })();

  return {
    id,
    uid: String(uid),
    mode,
    subject,
    title: String(raw.title || '').slice(0, 80),
    total,
    correct,
    wrong,
    skipped,
    score,
    answers,
    counts,
    difficulty,
    durationSec: clampInt(raw.durationSec, 0, 86400 * 6, 0),
    limitSec: clampInt(raw.limitSec, 0, 86400 * 6, 0),
    singleRating: singleRating(score, counts, mode),
    rank: rankOf(score).key,
    createdAt,
    ...(raw.config && typeof raw.config === 'object' ? { config: sanitizeConfig(raw.config) } : {}),
  };
}

function sanitizeConfig(config) {
  const code = String(config.code || 'mix').slice(0, 24);
  const counts = { fill: 0, single: 0, judge: 0 };
  for (const t of ['fill', 'single', 'judge']) {
    counts[t] = clampInt(config.counts?.[t], 0, 200, 0);
  }
  return { code, counts, limitMin: clampInt(config.limitMin, 0, 600, 0) };
}

export function computeStats(user) {
  const attempts = Array.isArray(user.attempts) ? user.attempts : [];
  let totalQuestions = 0;
  let correct = 0;
  let best = 0;
  const seen = {};
  const bySubject = {};

  for (const a of attempts) {
    totalQuestions += a.total || 0;
    correct += a.correct || 0;
    best = Math.max(best, Number(a.score) || 0);
    const bs = (bySubject[a.subject] ||= { attempts: 0, total: 0, correct: 0, best: 0 });
    bs.attempts += 1;
    bs.total += a.total || 0;
    bs.correct += a.correct || 0;
    bs.best = Math.max(bs.best, Number(a.score) || 0);
    seen[a.subject] ||= new Set();
    for (const ans of a.answers || []) {
      if (!ans.skipped) seen[a.subject].add(ans.qid);
    }
  }

  const seenCount = {};
  for (const [code, set] of Object.entries(seen)) seenCount[code] = set.size;

  return {
    rating: totalRating(attempts),
    attempts: attempts.length,
    accuracy: totalQuestions ? round((correct / totalQuestions) * 100) : 0,
    bestScore: round(best),
    wrongCount: Object.values(user.wrong || {}).filter((w) => !w?.mastered).length,
    masteredCount: Object.values(user.wrong || {}).filter((w) => w?.mastered).length,
    seen: seenCount,
    bySubject,
  };
}

/** 根据一次答卷更新错题本：答错收录、答对标记已掌握（保留记录，不删除） */
export function updateWrongbook(user, attempt) {
  const at = attempt.createdAt;
  user.wrong ||= {};
  for (const ans of attempt.answers) {
    if (ans.skipped) continue;
    const prev = user.wrong[ans.qid];
    if (ans.correct) {
      if (prev) user.wrong[ans.qid] = { ...prev, mastered: true, masteredAt: at, lastAt: at };
    } else {
      user.wrong[ans.qid] = {
        qid: ans.qid,
        code: attempt.subject,
        at: prev?.at || at,
        lastAt: at,
        count: (prev?.count || 0) + 1,
        chosen: ans.chosen,
        mastered: false,
      };
    }
  }
}
