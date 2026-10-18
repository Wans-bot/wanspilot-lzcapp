/**
 * 磁盘配额守卫。
 *
 * 两份约束：设置里的「配额上限」（0 表示不限）与真实剩余空间。
 * 加入下载前先算一次，装不下就拒绝并给出可执行的说明，避免下到一半撑爆网盘。
 */
import fs from 'node:fs';
import { resolveDownloadDir, getSettings } from './settings.mjs';

function freeBytes(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch (err) {
    return 0;
  }
}

/**
 * @param {number} sizeBytes 本次要下载的体积；未知时传 0，只做空间检查
 * @param {number} activeBytes 已在下载中的体积合计
 * @returns {{ok: boolean, freeBytes: number, quotaBytes: number, message: string}}
 */
export function capacityCheck(sizeBytes = 0, activeBytes = 0) {
  const settings = getSettings();
  const dir = resolveDownloadDir();
  const free = freeBytes(dir);
  const quotaBytes = Number(settings.quotaGB) > 0 ? Number(settings.quotaGB) * 1024 ** 3 : 0;
  const usable = quotaBytes > 0 ? Math.min(free, quotaBytes) : free;
  const need = Math.max(0, Number(sizeBytes) || 0);
  const used = Math.max(0, Number(activeBytes) || 0);
  const remain = usable - used;

  if (need && need > remain) {
    return {
      ok: false,
      freeBytes: free,
      quotaBytes,
      message: `空间不够：这个任务约 ${(need / 1024 ** 3).toFixed(1)} GB，`
        + `可用 ${(remain / 1024 ** 3).toFixed(1)} GB`
        + (quotaBytes ? `（配额上限 ${settings.quotaGB} GB）` : '')
        + '。可以在设置里调大配额或清理已下载的内容。',
    };
  }
  return {
    ok: true,
    freeBytes: free,
    quotaBytes,
    message: `可用 ${(remain / 1024 ** 3).toFixed(1)} GB`,
  };
}

/** 供健康度看板显示。 */
export function capacityStatus() {
  const settings = getSettings();
  const dir = resolveDownloadDir();
  return {
    freeBytes: freeBytes(dir),
    quotaGB: Number(settings.quotaGB) || 0,
    downloadDir: dir,
  };
}
