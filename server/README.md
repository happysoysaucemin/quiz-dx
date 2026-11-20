# 刷题 DX 服务端

零依赖 Node.js（18+）HTTP 服务，负责：

- 托管静态前端 `../web` 与题库 `../bank`（可选，纯 API 部署时可忽略）
- 成绩、错题本、B20 刷题力的权威计算与持久化
- 跨域 CORS（前端分离部署时使用）

## 启动

```bash
node server.mjs
# 或
npm start
# Windows 双击 start.bat
```

默认监听 `0.0.0.0:8787`，数据写入 `server/data/db.json`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `server/data` | 数据目录，需可写 |
| `CORS_ORIGIN` | `*` | 允许的前端来源；多个用逗号分隔，如 `https://a.com,https://b.com` |
| `LOG` | 开启 | `LOG=0` 关闭访问日志 |

示例：

```bash
PORT=9000 DATA_DIR=/var/lib/quiz-dx CORS_ORIGIN=https://quiz.example.com node server.mjs
```

## 数据文件

`db.json`：

```jsonc
{
  "version": 1,
  "users": {
    "<uid>": {
      "uid": "…",
      "nickname": "学员",
      "createdAt": "…",
      "updatedAt": "…",
      "attempts": [ /* 最近 1000 条，最新在前 */ ],
      "wrong": { "<qid>": { "qid": "…", "code": "13007", "at": "…", "count": 2, "chosen": "A" } }
    }
  }
}
```

写入使用临时文件 + `rename` 原子替换，进程退出（SIGINT/SIGTERM）前会再落盘一次。
备份直接复制 `db.json` 即可。

## 接口

见 [../docs/API.md](../docs/API.md)。

## 说明

- 没有账号密码：`uid` 是前端 `localStorage` 里的随机 ID，知道 uid 即可读写该用户数据。个人使用足够；公网暴露时请加反向代理鉴权。
- 服务端会重新计算得分、题量、Rating，不信任客户端传来的 `score` / `singleRating`；只保留客户端上报的作答明细与标题。
- 答卷按 `attempt.id` 幂等：重复提交同一条不会重复计入。
