/**
 * 评分与评级：全站唯一口径（前端与 server/lib/rating.mjs 保持一致）。
 *
 * 单卷 Rating = (试卷定数 / 50) × F(达成率)
 *   F(A) = A × 系数(A) / (97 × 20)      —— 97% 归一化为 1.000
 *   系数表照搬 maimai DX 的达成率系数阶梯
 * 总刷题力 = 历史最佳 20 卷单卷 Rating 之和（B20）
 */

export const RANK_TABLE = [
  { key: 'SSS+', min: 100, coef: 22.4, c1: '#ffe07a', c2: '#ff9ec7' },
  { key: 'SSS',  min: 99,  coef: 21.6, c1: '#ffd166', c2: '#ff9b3d' },
  { key: 'SS',   min: 97,  coef: 21.1, c1: '#ffb75e', c2: '#ff7a3d' },
  { key: 'S',    min: 93,  coef: 20.0, c1: '#d3f56a', c2: '#37d8a2' },
  { key: 'A',    min: 85,  coef: 16.8, c1: '#6ee7b7', c2: '#22c1a4' },
  { key: 'B',    min: 75,  coef: 13.6, c1: '#7cc8ff', c2: '#3f97f6' },
  { key: 'C',    min: 60,  coef: 8.0,  c1: '#9fb5ff', c2: '#6d86f0' },
  { key: 'D',    min: 0,   coef: 0,    c1: '#a9c2ff', c2: '#7f9cf5' },
];

export const TYPE_LABEL = { fill: '填空', single: '选择', judge: '判断' };
export const TYPE_WEIGHT = { fill: 1.2, single: 1, judge: 0.8 };
export const RATING_SLOTS = 20;

export function rankOf(score) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  return RANK_TABLE.find((r) => s >= r.min - 1e-9) || RANK_TABLE[RANK_TABLE.length - 1];
}

export function difficultyOf(counts = {}) {
  const weighted =
    (counts.fill || 0) * TYPE_WEIGHT.fill +
    (counts.single || 0) * TYPE_WEIGHT.single +
    (counts.judge || 0) * TYPE_WEIGHT.judge;
  return Math.round(1200 + 45 * weighted);
}

export function achievementFactor(score) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const rank = rankOf(s);
  return (s * rank.coef) / (97 * 20);
}

export function singleRating(score, counts = {}, mode = 'paper') {
  const diff = difficultyOf(counts);
  const penalty = mode === 'loop' ? 0.85 : 1;
  const value = (diff / 50) * achievementFactor(score) * penalty;
  return Math.round(value * 10) / 10;
}

/** B20：取历史最佳 20 卷的 Rating 之和 */
export function totalRating(attempts = [], slots = RATING_SLOTS) {
  const values = attempts
    .map((a) => Number(a.singleRating) || 0)
    .filter((v) => v > 0)
    .sort((a, b) => b - a)
    .slice(0, slots);
  return Math.round(values.reduce((sum, v) => sum + v, 0) * 10) / 10;
}

export function formatScore(score) {
  return (Math.round((Number(score) || 0) * 10000) / 10000).toFixed(4);
}

export function rankColor(score) {
  const r = rankOf(score);
  return { c1: r.c1, c2: r.c2, key: r.key };
}
