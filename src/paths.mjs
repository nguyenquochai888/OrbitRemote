// Chỗ duy nhất biết các file của Orbit Remote nằm ở đâu.
//
// Hai loại chỗ, cố ý tách:
//   - Thư mục trạng thái riêng từng máy (~/.orbit/state/remote): mã ghép đôi, danh sách
//     phiên, cấu hình MCP tạm. Không bao giờ vào git, vì nó chứa bí mật của máy đó.
//   - Thư mục custom/ trong tool: nút bấm, theme, phần mở rộng do người dùng viết. Nằm
//     trong repo, đồng bộ qua mọi máy bằng git (bản fork riêng của bạn).

import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = join(TOOL_DIR, 'web');
export const MCP_SERVER = join(TOOL_DIR, 'src', 'mcp-server.mjs');

// Cho phép đổi gốc trạng thái và thư mục custom/ để phép kiểm chạy trong thư mục tạm, không đụng
// máy thật cũng không đụng trạm thật khai trong kho.
export const CUSTOM_DIR = process.env.ORBIT_REMOTE_CUSTOM || join(TOOL_DIR, 'custom');
export const STATE_DIR = process.env.ORBIT_REMOTE_STATE || join(homedir(), '.orbit', 'state', 'remote');

export const MACHINE_NAME = process.env.ORBIT_REMOTE_MACHINE || hostname();

// Kết quả lần setup gần nhất của máy này (setup.mjs ghi, đầu máy gửi lên trạm để hiện trên app).
export const SETUP_RESULT_FILE = join(STATE_DIR, 'setup-last.json');
// Lịch tắt máy đang chờ (đặt từ app), để đầu máy khởi động lại giữa chừng vẫn báo đúng cho app.
export const POWER_FILE = join(STATE_DIR, 'power.json');

export const PIPE_PATH = process.platform === 'win32'
  ? `\\\\.\\pipe\\orbit-remote-${process.env.ORBIT_REMOTE_PIPE_TAG || 'main'}`
  : join(STATE_DIR, `node-${process.env.ORBIT_REMOTE_PIPE_TAG || 'main'}.sock`);

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Ghi qua file tạm rồi đổi tên: mất điện giữa chừng thì còn bản cũ nguyên vẹn,
// không bao giờ còn một file JSON cụt nửa chừng.
export function writeJsonAtomic(file, value) {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}
