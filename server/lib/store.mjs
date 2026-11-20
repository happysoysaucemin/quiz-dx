import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 极简 JSON 存储：单进程、写队列 + 原子替换。
 * 数据文件默认 server/data/db.json，可用 DATA_DIR 覆盖。
 */
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.data = { version: 1, users: {} };
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') this.data = data;
    } catch {
      this.data = { version: 1, users: {} };
    }
    if (!this.data.users || typeof this.data.users !== 'object') this.data.users = {};
    return this;
  }

  user(uid) {
    const id = String(uid);
    if (!this.data.users[id]) {
      const now = new Date().toISOString();
      this.data.users[id] = {
        uid: id,
        nickname: '学员',
        createdAt: now,
        updatedAt: now,
        attempts: [],
        wrong: {},
      };
    }
    return this.data.users[id];
  }

  find(uid) {
    return this.data.users[String(uid)] || null;
  }

  users() {
    return Object.values(this.data.users);
  }

  /** 串行落盘，避免并发写坏文件 */
  commit() {
    this.queue = this.queue
      .then(async () => {
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(this.data));
        await fs.rename(tmp, this.file);
      })
      .catch((err) => {
        console.error('[store] 写入失败', err);
      });
    return this.queue;
  }
}
