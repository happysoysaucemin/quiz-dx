# API 文档

Base URL：`http://<host>:8787/api`（部署时按实际域名替换）

- 所有请求/响应均为 JSON。
- 跨域：服务端默认 `Access-Control-Allow-Origin: *`，可用 `CORS_ORIGIN` 收紧。
- 身份：没有登录态，所有接口用 `uid` 区分用户。uid 由前端生成（`crypto.randomUUID()`）并存在 `localStorage`。
- 幂等：同一 `attempt.id` 重复提交只会记一次。

## 数据结构

### attempt（答卷）

```jsonc
{
  "id": "a1b2c3",                 // 前端生成，幂等键
  "mode": "paper",                // paper | loop
  "subject": "13007",             // 科目代码，混排为 "mix"
  "title": "编译原理 · 随机组卷 A7F",
  "total": 20,
  "durationSec": 754,
  "limitSec": 1200,
  "answers": [
    { "qid": "13007-single-1", "type": "single", "chosen": "B", "correct": true },
    { "qid": "13007-fill-1", "type": "fill", "chosen": ["语法分析器"], "correct": false, "selfJudged": false },
    { "qid": "13007-judge-2", "type": "judge", "chosen": null, "correct": false, "skipped": true }
  ],
  "counts": { "fill": 5, "single": 10, "judge": 5 },
  "config": { "code": "13007", "counts": { "fill": 5, "single": 10, "judge": 5 }, "limitMin": 20 },
  "createdAt": "2026-11-20T12:00:00.000Z"
}
```

服务端会忽略客户端传来的 `score`、`correct`、`singleRating`，按 `answers` 重新计算。

### stats（统计）

```jsonc
{
  "rating": 1042.6,          // B20 刷题力
  "attempts": 6,
  "accuracy": 91.2,
  "bestScore": 98.5,
  "wrongCount": 3,
  "seen": { "13006": 30, "13007": 45, "13008": 12, "13014": 8 },
  "bySubject": {
    "13007": { "attempts": 2, "total": 40, "correct": 38, "best": 98.5 }
  }
}
```

---

## GET /api/health

```bash
curl http://localhost:8787/api/health
```

```json
{
  "ok": true,
  "service": "quiz-dx-server",
  "version": 1,
  "uptimeSec": 999,
  "users": 1,
  "time": "2026-11-20T12:27:03.171Z"
}
```

## GET /api/profile?uid=…

返回用户、统计、最近 60 条答卷、错题本。用户不存在时返回空档案，不写盘。

```bash
curl "http://localhost:8787/api/profile?uid=abc123"
```

```json
{
  "ok": true,
  "user": { "uid": "abc123", "nickname": "学员", "createdAt": "2026-11-20T12:00:00.000Z" },
  "stats": { "rating": 1042.6, "attempts": 6, "…": "…" },
  "attempts": [ /* 最新在前 */ ],
  "wrongbook": {
    "13007-fill-1": { "qid": "13007-fill-1", "code": "13007", "at": "…", "count": 1, "chosen": ["…"] }
  }
}
```

## POST /api/profile

改昵称（会创建用户，如果不存在）。

```bash
curl -X POST http://localhost:8787/api/profile \
  -H 'content-type: application/json' \
  -d '{"uid":"abc123","nickname":"夜航鲸"}'
```

```json
{ "ok": true, "user": { "uid": "abc123", "nickname": "夜航鲸" } }
```

## POST /api/attempts

交卷。返回服务端重算后的成绩、统计、Rating 变化与最新错题本。

```bash
curl -X POST http://localhost:8787/api/attempts \
  -H 'content-type: application/json' \
  -d '{
    "uid": "abc123",
    "nickname": "夜航鲸",
    "attempt": {
      "id": "a1b2c3",
      "mode": "paper",
      "subject": "13007",
      "title": "编译原理 · 随机组卷 A7F",
      "total": 2,
      "durationSec": 60,
      "answers": [
        { "qid": "13007-single-1", "type": "single", "chosen": "B", "correct": true },
        { "qid": "13007-judge-1", "type": "judge", "chosen": false, "correct": false }
      ]
    }
  }'
```

```json
{
  "ok": true,
  "user": { "uid": "abc123", "nickname": "夜航鲸" },
  "attempt": { "id": "a1b2c3", "score": 50, "correct": 1, "wrong": 1, "singleRating": 0, "rank": "D", "…": "…" },
  "stats": { "rating": 0, "attempts": 1, "accuracy": 50, "…": "…" },
  "ratingDelta": 0,
  "wrongbook": { "13007-judge-1": { "…": "…" } }
}
```

重复提交同一 `id` 时返回 `"duplicate": true` 与已存的答卷，`ratingDelta: 0`。

## DELETE /api/wrongbook?uid=…

清空该用户的错题本（不影响历史答卷）。

```bash
curl -X DELETE "http://localhost:8787/api/wrongbook?uid=abc123"
```

```json
{ "ok": true }
```

## GET /api/leaderboard

B20 排行前 20（只统计有答卷的用户）。

```bash
curl http://localhost:8787/api/leaderboard
```

```json
{
  "ok": true,
  "rows": [
    { "uid": "abc123", "nickname": "夜航鲸", "rating": 1042.6, "attempts": 6, "bestScore": 98.5 }
  ]
}
```

## 错误格式

```json
{ "ok": false, "error": "缺少 uid" }
```

状态码：`400` 参数错误、`404` 接口不存在、`500` 服务端异常。
