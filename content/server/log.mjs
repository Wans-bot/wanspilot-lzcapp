/**
 * 运行日志：内存环形缓冲 + 落盘追加。
 * 日志同时用于「设置」页的排障入口和实机验收取证，所以既留内存也留文件。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_MEMORY_LINES = 2000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const lines = [];
let logFile = '';
let fileHandle = null;

export function initLog(dataDir) {
  try {
    const dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'wanspilot.log');
    // 超过上限就先截断，避免长期运行把磁盘写满。
    try {
      const st = fs.statSync(logFile);
      if (st.size > MAX_FILE_BYTES) fs.renameSync(logFile, logFile + '.1');
    } catch {
      // 文件不存在是正常情况
    }
  } catch (err) {
    logFile = '';
    process.stderr.write(`[log] 无法初始化日志目录: ${err.message}\n`);
  }
}

function write(level, args) {
  const time = new Date().toISOString();
  const text = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.message}${a.stack ? `\n${a.stack}` : ''}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  const line = `${time} [${level}] ${text}`;

  lines.push(line);
  if (lines.length > MAX_MEMORY_LINES) lines.splice(0, lines.length - MAX_MEMORY_LINES);

  if (level === 'ERROR') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');

  if (logFile) {
    try {
      if (!fileHandle) fileHandle = fs.openSync(logFile, 'a');
      fs.writeSync(fileHandle, line + '\n');
    } catch {
      // 写日志失败不应影响业务
    }
  }
}

export const log = {
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
  debug: (...a) => write('DEBUG', a),
};

/** 返回最近 n 行日志，供 GET /api/logs 使用。 */
export function tail(count = 200) {
  const n = Math.min(Math.max(1, Number(count) || 200), MAX_MEMORY_LINES);
  return lines.slice(-n).join('\n');
}
