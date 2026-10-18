/**
 * 极简持久化：把对象存成 JSON 文件，写入用「临时文件 + rename」保证原子性。
 * 数据量很小（设置、订阅、任务记录），不需要引入数据库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.mjs';

export class JsonStore {
  /**
   * @param {string} filePath 目标文件
   * @param {any} defaults 首次创建时的默认值
   * @param {object} [options]
   * @param {number} [options.debounceMs] 写入合并窗口
   */
  constructor(filePath, defaults, options = {}) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.debounceMs = options.debounceMs ?? 200;
    this.data = this.#load();
    this.timer = null;
    this.pending = false;
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
      log.warn(`[store] ${this.filePath} 内容不是对象，改用默认值`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn(`[store] 读取 ${this.filePath} 失败，改用默认值: ${err.message}`);
      }
    }
    // 深拷贝默认值，避免调用方改到共享常量
    return JSON.parse(JSON.stringify(this.defaults));
  }

  /** 立即同步落盘。 */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = false;
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      log.error(`[store] 写入 ${this.filePath} 失败: ${err.message}`);
    }
  }

  /** 标记需要落盘，短时间内多次调用只写一次。 */
  save() {
    this.pending = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending) this.flush();
    }, this.debounceMs);
    if (this.timer.unref) this.timer.unref();
  }
}
