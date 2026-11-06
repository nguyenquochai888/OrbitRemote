// Chạy một lệnh của main.mjs ở tiến trình tách riêng, không cửa sổ, ghi nhật ký vào thư mục trạng
// thái. Dùng để dựng trạm và đầu máy chạy nền, và cho các lệnh bấm từ app (khởi động lại trạm, setup
// một máy): tiến trình tách riêng sống tiếp khi trạm hay đầu máy đã gọi nó tắt đi.

import { spawn } from 'node:child_process';
import { openSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from './claude-session.mjs';
import { STATE_DIR, TOOL_DIR, ensureDir } from './paths.mjs';

export const MAIN_SCRIPT = join(TOOL_DIR, 'src', 'main.mjs');
const LOG_MAX_BYTES = 2 * 1024 * 1024;

// Nhật ký chạy nền không được phình mãi: quá ngưỡng thì cất thành .1 (đè bản cũ) và mở file mới.
export function rotateLog(file) {
  try {
    if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // chưa có file
  }
}

// Trả về đường dẫn tệp nhật ký.
export function spawnMain(args, logName) {
  ensureDir(STATE_DIR);
  const logFile = join(STATE_DIR, logName);
  rotateLog(logFile);
  const out = openSync(logFile, 'a');
  // Phiên Claude do trạm mở phải là phiên bình thường: bỏ công tắc tắt đồng bộ đầu phiên nếu lệnh
  // này được gọi từ một tiến trình đã bật nó.
  const env = childEnv();
  delete env.ORBIT_SESSION_SYNC_OFF;
  spawn(process.execPath, [MAIN_SCRIPT, ...args], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env }).unref();
  return logFile;
}
