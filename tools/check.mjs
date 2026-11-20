#!/usr/bin/env node
/**
 * 题库 / 评分自检（零依赖）
 *   node tools/check.mjs
 *
 * 校验内容：
 *  1. 题库索引与四科 JSON 的题量、字段、答案是否自洽；
 *  2. 前端 web/js/rating.js 与后端 server/lib/rating.mjs 计算是否完全一致；
 *  3. 单卷 Rating 在得分率上是否单调。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as web from '../web/js/rating.js';
import * as srv from '../server/lib/rating.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bankDir = path.join(root, 'bank');

let errors = 0;
const fail = (msg) => {
  errors += 1;
  console.error('  ✗', msg);
};
const ok = (msg) => console.log('  ✓', msg);

const readJSON = async (p) => JSON.parse(await readFile(p, 'utf8'));

/* ---------------- 1. 题库 ---------------- */
const index = await readJSON(path.join(bankDir, 'index.json'));
let total = 0;
const ids = new Set();

for (const meta of index.subjects) {
  const subject = await readJSON(path.join(bankDir, meta.file));
  const counts = { fill: 0, single: 0, judge: 0 };
  for (const q of subject.questions) {
    total += 1;
    counts[q.type] += 1;
    if (ids.has(q.id)) fail(`重复题号 ${q.id}`);
    ids.add(q.id);
    if (!q.id || !q.stem) fail(`${meta.code} 存在空题干`);
    if (q.type === 'single') {
      if (!Array.isArray(q.options) || q.options.length !== 4) fail(`${q.id} 选项不是 4 个`);
      if (!q.options.some((o) => o.key === q.answer)) fail(`${q.id} 答案 ${q.answer} 不在选项中`);
    } else if (q.type === 'judge') {
      if (typeof q.answer !== 'boolean') fail(`${q.id} 判断答案不是布尔值`);
    } else if (q.type === 'fill') {
      if (!q.answer) fail(`${q.id} 缺少填空答案`);
      if (!Array.isArray(q.accept) || !q.accept.length) fail(`${q.id} 缺少可接受答案`);
      if (q.blanks > 1 && q.accept.length !== q.blanks) fail(`${q.id} 空数 ${q.blanks} 与答案组数 ${q.accept.length} 不一致`);
    }
  }
  for (const t of ['fill', 'single', 'judge']) {
    if ((meta.counts[t] || 0) !== counts[t]) fail(`${meta.code} ${t} 数量索引不一致`);
  }
  if (meta.total !== subject.questions.length) fail(`${meta.code} total 不一致`);
  ok(`${meta.code} ${meta.name}：${subject.questions.length} 题（填空 ${counts.fill} / 选择 ${counts.single} / 判断 ${counts.judge}）`);
}
if (index.total !== total) fail(`索引合计 ${index.total} ≠ 实际 ${total}`);
ok(`题库合计 ${total} 题`);

/* ---------------- 2. 评分口径一致性 ---------------- */
const samples = [];
for (let score = 0; score <= 100; score += 3.7) {
  for (const counts of [
    { fill: 1, single: 2, judge: 1 },
    { fill: 5, single: 10, judge: 10 },
    { fill: 0, single: 60, judge: 0 },
  ]) {
    for (const mode of ['paper', 'loop']) samples.push([score, counts, mode]);
  }
}
let mismatch = 0;
for (const [score, counts, mode] of samples) {
  const a = web.singleRating(score, counts, mode);
  const b = srv.singleRating(score, counts, mode);
  if (a !== b) {
    mismatch += 1;
    fail(`评分不一致 score=${score} mode=${mode}: web=${a} server=${b}`);
  }
  if (web.difficultyOf(counts) !== srv.difficultyOf(counts)) fail(`定数不一致 ${JSON.stringify(counts)}`);
  if (web.rankOf(score).key !== srv.rankOf(score).key) fail(`评级不一致 ${score}`);
}
if (!mismatch) ok(`前后端评分公式一致（${samples.length} 组样本）`);

/* ---------------- 3. 单调性 ---------------- */
let prev = -1;
for (let score = 0; score <= 100; score += 0.5) {
  const v = web.singleRating(score, { fill: 5, single: 10, judge: 5 }, 'paper');
  if (v < prev) fail(`单卷 Rating 在 ${score}% 处不单调：${prev} → ${v}`);
  prev = v;
}
ok('单卷 Rating 随得分率单调不减');

/* ---------------- 汇总 ---------------- */
if (errors) {
  console.error(`\n检查失败：${errors} 个问题`);
  process.exit(1);
}
console.log('\n全部检查通过 ✔');
