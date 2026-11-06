// Đổi chiều nguồn hình theo chiều đang xem trên điện thoại (bật hay tắt trong danh sách nguồn hình
// của app), để hình phủ kín khung xem thay vì một dải nhỏ giữa hai mảng đen:
//   - Màn hình: đổi hướng màn hình của Windows (ngang ↔ dọc, như Cài đặt > Hiển thị > Hướng màn hình),
//     chỉ cho phiên đăng nhập đang chạy (không ghi registry), nên khởi động lại máy là về như cũ.
//   - Cửa sổ (ứng dụng, thư mục): đổi cỡ cho cùng tỉ lệ với khung xem, lớn nhất vừa vùng làm việc của
//     màn chứa nó (trừ thanh tác vụ).
// Trạng thái gốc được nhớ: điện thoại xoay lại về chiều gốc thì trả đúng như cũ; thôi xem (dừng, đổi
// nguồn, rời màn, mất kết nối) thì trả lại sau một lúc chờ, để rớt mạng chốc lát không làm màn hình
// xoay qua xoay lại. Trạng thái gốc ghi cả xuống orient.json: đầu máy tắt giữa chừng thì lần chạy sau
// trả lại ngay khi dựng.

import { uptime } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { STATE_DIR, readJson, writeJsonAtomic } from './paths.mjs';

export const ORIENT_FILE = join(STATE_DIR, 'orient.json');
const RESTORE_DELAY_MS = 8000;
const DISPLAY_SETTLE_MS = 900; // chờ Windows đổi xong hướng màn hình rồi mới đo lại
const ASPECT_MIN = 0.3; // tỉ lệ rộng/cao khung xem nhận được: chặn số lạ từ điện thoại
const ASPECT_MAX = 3.5;

export const isPortrait = (r) => r.height > r.width;

// Hướng màn hình kế tiếp khi cần đổi giữa ngang và dọc: 0 ↔ 1 và 2 ↔ 3 (luôn xoay đúng 90°, và từ một
// màn đang dọc thì về hướng gốc chứ không lật ngược).
export const turnedOrientation = (orient) => [1, 0, 3, 2][orient] ?? 1;

// Khung lớn nhất cùng tỉ lệ khung xem vừa vùng làm việc, đặt giữa quanh tâm cũ của cửa sổ.
export function fitRect(work, aspect, cx, cy) {
  let width = Math.min(work.width, Math.round(work.height * aspect));
  let height = Math.round(width / aspect);
  if (height > work.height) {
    height = work.height;
    width = Math.round(height * aspect);
  }
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return {
    x: clamp(Math.round(cx - width / 2), work.x, work.x + work.width - width),
    y: clamp(Math.round(cy - height / 2), work.y, work.y + work.height - height),
    width,
    height,
  };
}

// Chiều điện thoại gửi lên: { want: 'portrait' | 'landscape', aspect } hay null (tắt tính năng).
export function cleanOrient(o) {
  if (!o || (o.want !== 'portrait' && o.want !== 'landscape')) return null;
  const aspect = Number(o.aspect);
  const fallback = o.want === 'portrait' ? 9 / 16 : 16 / 9;
  const a = Number.isFinite(aspect) ? Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, aspect)) : fallback;
  // Tỉ lệ phải khớp chiều: dọc thì cao hơn rộng, ngang thì ngược lại.
  return { want: o.want, aspect: (o.want === 'portrait') === (a < 1) ? a : 1 / a };
}

export class Orienter {
  // onDisplayChange(origin): một màn vừa đổi hướng (toạ độ cả bàn làm việc đổi theo); origin là người xem
  // đã gây ra việc đó (nó tự đo lại nguồn của nó), để những người xem khác đo lại.
  constructor(input, { file = ORIENT_FILE, restoreDelayMs = RESTORE_DELAY_MS, settleMs = DISPLAY_SETTLE_MS, log = () => {}, onDisplayChange = () => {} } = {}) {
    this.input = input;
    this.file = file;
    this.delay = restoreDelayMs;
    this.settleMs = settleMs;
    this.log = log;
    this.onDisplayChange = onDisplayChange;
    // khoá ('screen:<tên>' | 'window:<mã>') -> trạng thái gốc
    this.saved = new Map();
    this.timers = new Map();
  }

  // Đổi hướng một màn mà con trỏ vẫn ở đúng chỗ. Windows xếp lại toạ độ cả bàn làm việc khi một màn đổi
  // hướng (màn bên cạnh bị đẩy đi), còn con trỏ đứng yên ở toạ độ cũ nên rơi sang màn khác: đang xem màn
  // B thì con trỏ nhảy về màn A lúc A được trả về hướng cũ. Nên ghi con trỏ đang ở màn nào, chỗ nào trên
  // màn đó (theo phần cỡ màn), đổi xong đợi Windows xếp lại rồi đặt về đúng chỗ ấy.
  async turnDisplay(name, orient, origin) {
    const spot = await this.cursorSpot();
    const code = await this.input.setDisplayOrientation(name, orient);
    if (code !== 0) return code;
    if (this.settleMs) await new Promise((r) => setTimeout(r, this.settleMs));
    await this.putCursor(spot);
    this.onDisplayChange(origin);
    return code;
  }

  async cursorSpot() {
    try {
      const p = await this.input.cursor();
      const s = (await this.input.screens()).find((m) => p.x >= m.x && p.x < m.x + m.width && p.y >= m.y && p.y < m.y + m.height);
      return s ? { name: s.name, fx: (p.x - s.x) / s.width, fy: (p.y - s.y) / s.height } : null;
    } catch {
      return null; // không đọc được con trỏ: đổi hướng như thường
    }
  }

  async putCursor(spot) {
    if (!spot) return;
    try {
      // Danh sách màn hỏi lại ở đây cũng làm chương trình điều khiển cập nhật cỡ bàn làm việc mới.
      const s = (await this.input.screens()).find((m) => m.name === spot.name);
      if (s) this.input.moveTo(s.x + spot.fx * s.width, s.y + spot.fy * s.height);
    } catch {
      // chương trình điều khiển vừa dừng: con trỏ để Windows tự đặt
    }
  }

  // Màn hình s (một mục của danh sách màn hình) cho đúng chiều; true nếu đã đổi (cần quay lại).
  async screen(s, want, origin = null) {
    const key = `screen:${s.name}`;
    this.keep(key);
    if ((want === 'portrait') === isPortrait(s)) return false;
    const cur = await this.input.displayMode(s.name);
    if (!cur) throw new Error('Không đọc được hướng của màn hình này.');
    const saved = this.saved.get(key);
    // Đã đổi từ trước mà giờ muốn đúng chiều gốc: trả về hướng gốc.
    const back = saved && (want === 'portrait') === isPortrait(saved);
    const target = back ? saved.orient : turnedOrientation(cur.orient);
    if (!saved) this.remember(key, { kind: 'screen', name: s.name, orient: cur.orient, width: cur.width, height: cur.height });
    const code = await this.turnDisplay(s.name, target, origin);
    if (code !== 0) {
      if (!saved) this.forget(key);
      throw new Error(`Màn hình này không đổi được sang ${want === 'portrait' ? 'dọc' : 'ngang'} (Windows trả mã ${code}).`);
    }
    if (back) this.forget(key);
    return true;
  }

  // Cửa sổ w (khung nhìn thấy, như input.window) trên màn home (có vùng làm việc) cho cùng tỉ lệ khung
  // xem; true nếu đã đổi.
  async window(w, home, { want, aspect }) {
    const key = `window:${w.hwnd}`;
    this.keep(key);
    if ((want === 'portrait') === isPortrait(w)) return false;
    const saved = this.saved.get(key);
    if (saved && saved.shape === want) {
      this.input.setPlacement(w.hwnd, saved.placement);
      this.forget(key);
      return true;
    }
    if (!saved) {
      const placement = await this.input.placement(w.hwnd);
      if (!placement) return false;
      this.remember(key, { kind: 'window', hwnd: String(w.hwnd), exe: String(w.exe || ''), placement, shape: isPortrait(w) ? 'portrait' : 'landscape' });
    }
    const work = home.work || home;
    this.input.setWindowBounds(w.hwnd, fitRect(work, aspect, w.x + w.width / 2, w.y + w.height / 2));
    return true;
  }

  // Thôi xem nguồn này: trả lại sau một lúc chờ (now = true: trả ngay, như khi tắt tính năng).
  release(key, now = false) {
    if (!this.saved.has(key)) return;
    clearTimeout(this.timers.get(key));
    if (now) {
      this.restore(key).catch(() => {});
      return;
    }
    const timer = setTimeout(() => this.restore(key).catch(() => {}), this.delay);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  // Có người xem lại đúng nguồn này trong lúc chờ: thôi trả.
  keep(key) {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  async restore(key, origin = null) {
    this.keep(key);
    const s = this.saved.get(key);
    if (!s) return;
    this.forget(key);
    if (s.kind === 'screen') {
      const cur = await this.input.displayMode(s.name);
      if (cur && cur.orient !== s.orient) await this.turnDisplay(s.name, s.orient, origin);
    } else {
      // Mã cửa sổ chỉ đúng khi cửa sổ đó còn mở: kiểm lại ứng dụng trước khi trả.
      const w = await this.input.window(s.hwnd).catch(() => null);
      if (w && (!s.exe || w.exe === s.exe)) this.input.setPlacement(s.hwnd, s.placement);
    }
  }

  // Đầu máy vừa dựng: trả lại những gì lần chạy trước đổi mà chưa kịp trả. Ghi từ trước lần khởi
  // động máy gần nhất thì bỏ (Windows đã tự về hướng cũ, mã cửa sổ đã khác).
  async restoreLeftovers() {
    const data = readJson(this.file, null);
    if (!data?.list?.length) return 0;
    rmSync(this.file, { force: true });
    if (!(data.at > Date.now() - uptime() * 1000)) return 0;
    let n = 0;
    for (const s of data.list) {
      const key = s.kind === 'screen' ? `screen:${s.name}` : `window:${s.hwnd}`;
      this.saved.set(key, s);
      await this.restore(key).catch(() => {});
      n += 1;
    }
    return n;
  }

  remember(key, state) {
    this.saved.set(key, state);
    this.persist();
  }

  forget(key) {
    if (this.saved.delete(key)) this.persist();
  }

  persist() {
    try {
      if (this.saved.size) writeJsonAtomic(this.file, { at: Date.now(), list: [...this.saved.values()] });
      else rmSync(this.file, { force: true });
    } catch (err) {
      this.log(`Không ghi được orient.json: ${err.message}`);
    }
  }
}
