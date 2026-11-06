// Chuột, bàn phím và danh sách màn hình của máy này, qua chương trình nhỏ win-input.cs.
//
// Lần dùng đầu, chương trình được dịch bằng csc.exe có sẵn trong mọi bản Windows (.NET Framework
// 4) vào thư mục trạng thái, đặt tên theo dấu của mã nguồn nên sửa mã là tự dịch lại. Sau đó chỉ
// một tiến trình chạy suốt; mỗi thao tác là một dòng ghi vào stdin của nó.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { STATE_DIR, TOOL_DIR, ensureDir } from './paths.mjs';

const SOURCE = join(TOOL_DIR, 'src', 'win-input.cs');
const CSC = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

function helperPath() {
  const tag = createHash('sha256').update(readFileSync(SOURCE)).digest('hex').slice(0, 12);
  return join(ensureDir(join(STATE_DIR, 'bin')), `orbit-input-${tag}.exe`);
}

function build() {
  const out = helperPath();
  if (existsSync(out)) return out;
  if (!existsSync(CSC)) throw new Error('Máy này thiếu csc.exe của .NET Framework 4, không dựng được phần điều khiển chuột và phím.');
  const r = spawnSync(CSC, ['-nologo', '-optimize+', '-platform:x64', '-target:exe', `-out:${out}`, SOURCE], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(out)) throw new Error(`Dịch win-input.cs không được: ${(r.stdout || r.stderr || '').trim().slice(0, 400)}`);
  return out;
}

// Tên màn hình đi trong một dòng lệnh tách bằng dấu cách: chỉ nhận đúng dạng \\.\DISPLAYn.
function displayName(name) {
  const s = String(name || '');
  if (!/^\\\\\.\\DISPLAY\d{1,3}$/.test(s)) throw new Error(`Tên màn hình lạ: ${s}`);
  return s;
}

export class InputHelper {
  constructor() {
    this.proc = null;
    this.waiters = []; // lệnh có trả lời (s, p) chờ theo đúng thứ tự gửi
    // Tăng mỗi lần dựng tiến trình mới: thứ gì gắn với tiến trình cũ phải làm lại.
    this.generation = 0;
  }

  static supported() {
    return process.platform === 'win32';
  }

  ensure() {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const proc = spawn(build(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    proc.stdin.on('error', () => {});
    createInterface({ input: proc.stdout }).on('line', (line) => this.waiters.shift()?.resolve(line));
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      for (const w of this.waiters.splice(0)) w.reject(new Error('Chương trình điều khiển chuột đã dừng.'));
    });
    this.proc = proc;
    this.generation += 1;
    return proc;
  }

  send(line) {
    this.ensure().stdin.write(`${line}\n`);
  }

  ask(line) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      try {
        this.send(line);
      } catch (err) {
        this.waiters.pop();
        reject(err);
      }
    });
  }

  async screens() {
    return JSON.parse(await this.ask('s'));
  }

  // 'locked' (màn khoá, màn đăng nhập), 'secure' (hộp thoại UAC...) hay 'unlocked' (xem lệnh "L").
  async desktopState() {
    return String(await this.ask('L')).trim();
  }

  async cursor() {
    const [x, y] = (await this.ask('p')).split(' ').map(Number);
    return { x, y };
  }

  // Cửa sổ đang mở (xem lệnh "l" trong win-input.cs) và một cửa sổ theo mã (null nếu đã đóng).
  async windows() {
    return JSON.parse(await this.ask('l'));
  }

  async window(hwnd) {
    return JSON.parse(await this.ask(`g ${BigInt(hwnd)}`));
  }

  focus(hwnd) { this.send(`f ${BigInt(hwnd)}`); }

  // ---- Đổi chiều nguồn hình (orient.mjs) -----------------------------------------------------
  // Vị trí đặt cửa sổ: { show, l, t, r, b } (khung lúc thường, toạ độ vùng làm việc), null nếu đã đóng.
  async placement(hwnd) {
    const line = await this.ask(`P ${BigInt(hwnd)}`);
    if (line === 'null') return null;
    const [show, l, t, r, b] = line.split(' ').map(Number);
    return { show, l, t, r, b };
  }

  setPlacement(hwnd, p) { this.send(`Q ${BigInt(hwnd)} ${p.show | 0} ${p.l | 0} ${p.t | 0} ${p.r | 0} ${p.b | 0}`); }

  // Đưa cửa sổ về cỡ thường rồi đặt phần nhìn thấy đúng khung này (điểm ảnh thật của màn hình).
  setWindowBounds(hwnd, { x, y, width, height }) {
    this.send(`z ${BigInt(hwnd)} ${Math.round(x)} ${Math.round(y)} ${Math.round(width)} ${Math.round(height)}`);
  }

  // Hướng hiện tại của một màn hình (tên kiểu \\.\DISPLAY1): { orient 0..3, width, height }, null nếu lỗi.
  async displayMode(name) {
    const [orient, width, height] = (await this.ask(`O ${displayName(name)}`)).split(' ').map(Number);
    return orient >= 0 ? { orient, width, height } : null;
  }

  // Đổi hướng màn hình; trả mã của Windows (0 là được, -2 là card không cho chế độ đó).
  async setDisplayOrientation(name, orient) {
    return Number(await this.ask(`o ${displayName(name)} ${orient | 0}`));
  }

  moveTo(x, y) { this.send(`m ${Math.round(x)} ${Math.round(y)}`); }
  moveBy(dx, dy) { this.send(`r ${Math.round(dx)} ${Math.round(dy)}`); }
  button(b, down) { this.send(`${down ? 'd' : 'u'} ${b | 0}`); }
  wheel(dy, dx = 0) {
    if (dy) this.send(`w ${Math.round(dy)}`);
    if (dx) this.send(`h ${Math.round(dx)}`);
  }
  key(vk, down, extended = false) { this.send(`k ${vk | 0} ${down ? 1 : 0} ${extended ? 1 : 0}`); }
  text(s) {
    if (s) this.send(`t ${Buffer.from(String(s), 'utf8').toString('base64')}`);
  }

  // ---- Clipboard của máy này (clip.mjs) -------------------------------------------------------------
  async setClipboardText(s) {
    clipReply(await this.ask(`C ${b64(s)}`));
  }

  // Danh sách tệp như khi copy trong Explorer; image: đường dẫn một ảnh để clipboard có thêm chính ảnh đó.
  async setClipboardFiles(paths, image = null) {
    clipReply(await this.ask(`F ${b64(paths.join('\n'))}${image ? ` ${b64(image)}` : ''}`));
  }

  // Số thứ tự của clipboard: đổi mỗi lần có ai copy (kể cả chính Orbit đặt).
  async clipSeq() {
    return Number(await this.ask('n')) || 0;
  }

  // Thứ đang copy: { seq, files: [đường dẫn] } | { seq, text } | { seq, image: true } | { seq }.
  async readClipboard() {
    return JSON.parse(await this.ask('R'));
  }

  async saveClipboardImage(path) {
    clipReply(await this.ask(`I ${b64(path)}`));
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
  }
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function clipReply(line) {
  if (line !== 'ok') throw new Error(`Không đặt được clipboard của máy: ${String(line).replace(/^err\s*/, '').replace(/[.\s]+$/, '') || 'không rõ lý do'}.`);
}
