// Tắt máy theo lệnh từ app: tắt ngay, sau một số giây, hay hẹn giờ; và huỷ lịch đang chờ.
//
// Windows: shutdown.exe có sẵn, người dùng thường có quyền tắt máy của chính mình, nên không cần cài
// gì thêm. /f đóng mọi ứng dụng đang mở (Windows vốn tự thêm /f khi hẹn quá 0 giây; tắt ngay cũng
// thêm, để không ứng dụng nào giữ máy lại chờ một cú bấm không ai ở đó bấm). Windows tự hiện thông
// báo đếm ngược trên máy. Đã có lịch tắt (lỗi 1190) thì huỷ lịch cũ rồi đặt lịch mới; huỷ khi không
// có lịch nào (lỗi 1116) thì coi như đã huỷ.

import { spawnSync } from 'node:child_process';

export const MAX_DELAY_SEC = 7 * 24 * 3600; // hẹn tối đa một tuần
const ALREADY_SCHEDULED = 1190;
const NOTHING_TO_CANCEL = 1116;
const COMMENT = 'Orbit Remote: máy sẽ tắt theo lệnh từ app.';

const run = (cmd, args) => spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 15000 });

export function checkDelay(delaySec) {
  const n = Number(delaySec);
  if (!Number.isInteger(n) || n < 0 || n > MAX_DELAY_SEC) throw new Error(`Thời gian chờ phải là số giây nguyên từ 0 tới ${MAX_DELAY_SEC}.`);
  return n;
}

export function shutdownArgs(delaySec) {
  return ['/s', '/f', '/t', String(checkDelay(delaySec)), '/c', COMMENT];
}

// Trả về lúc máy sẽ tắt (ms).
export function scheduleShutdown(delaySec, exec = run, platform = process.platform) {
  if (platform !== 'win32') throw new Error('Tắt máy từ app hiện chỉ làm cho Windows.');
  const args = shutdownArgs(delaySec);
  let r = exec('shutdown', args);
  if (r.status === ALREADY_SCHEDULED) {
    exec('shutdown', ['/a']);
    r = exec('shutdown', args);
  }
  if (r.status !== 0) throw new Error(`Không đặt được lịch tắt máy (mã ${r.status}): ${String(r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 200)}`);
  return Date.now() + Number(delaySec) * 1000;
}

export function cancelShutdown(exec = run, platform = process.platform) {
  if (platform !== 'win32') throw new Error('Tắt máy từ app hiện chỉ làm cho Windows.');
  const r = exec('shutdown', ['/a']);
  if (r.status !== 0 && r.status !== NOTHING_TO_CANCEL) throw new Error(`Không huỷ được lịch tắt máy (mã ${r.status}).`);
}
