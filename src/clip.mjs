// Dán từ máy đang xem sang máy này qua luồng màn hình: Ctrl+V trên khung màn hình đưa thứ đang copy ở
// máy đang xem (tệp, cả thư mục, ảnh chụp màn hình, chữ) vào clipboard của máy này rồi bấm Ctrl+V ở đây,
// như dán qua Remote Desktop.
//
// Tệp đi thẳng trên kết nối WebSocket của màn hình (không qua trạm), từng mẩu nhị phân:
//   byte 0 = CHUNK_TYPE, byte 1..4 = mã lần dán (uint32 LE), byte 5..8 = số thứ tự tệp (uint32 LE), còn lại
//   là dữ liệu, theo đúng thứ tự trong tệp.
// Tệp được ghi vào thư mục tạm PASTE_ROOT/<giờ>-<mã>/, rồi clipboard trỏ tới đó như khi copy trong
// Explorer. Thư mục giữ 24 giờ (chỗ dán còn đọc tệp: Explorer chép ngay, nhưng có app đọc sau), lần dán
// sau dọn thư mục cũ hơn mốc đó.

//
// Chiều ngược lại (copy ở máy đang xem, dán ở máy đang dùng) và chuột phải → Paste: mỗi bên có một
// ClipWatcher theo dõi số thứ tự clipboard của máy mình; thấy đổi thì describeClipboard đọc thứ vừa copy
// thành "lời mời" (chữ, hay danh sách tệp kèm cỡ) gửi sang bên kia. Tệp chỉ được kéo về khi bên kia hỏi
// (clip-pull), mẩu đi theo khuôn như trên với byte 0 = PULL_TYPE. Thay đổi do chính Orbit đặt (dán từ bên
// kia sang) không được mời ngược lại.

import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, statfsSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';

export const PASTE_ROOT = join(tmpdir(), 'Orbit Remote', 'paste');
export const CHUNK_TYPE = 1;
export const PULL_TYPE = 16; // mẩu tệp máy đang xem gửi về, khác các kiểu khung hình 1..4 trên cùng kết nối
export const CHUNK_HEADER = 9;
export const CHUNK_SIZE = 256 * 1024;
export const TEXT_MAX = 900 * 1000; // byte UTF-8: tin trên kết nối màn hình tối đa 1 MB (ws.mjs)
const KEEP_MS = 24 * 3600 * 1000;
const MAX_FILES = 10000;
const MAX_TOTAL = 50 * 1024 ** 3;
const FREE_MARGIN = 512 * 1024 ** 2; // chừa lại trên ổ, không dán đầy ổ
// Dán đúng một ảnh (ảnh chụp màn hình, ảnh copy từ trình duyệt): clipboard có thêm chính ảnh đó, dán được
// vào Paint hay ô chat, không chỉ dán thành tệp trong Explorer.
const IMAGE = /\.(png|jpe?g|gif|bmp)$/i;
const IMAGE_MAX = 30 * 1024 * 1024;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

// Một phần của đường dẫn, đặt được trên Windows: bỏ ký tự cấm, dấu chấm và dấu cách cuối. Tên thiết bị
// (con, nul, com1...) chỉ đổi khi máy coi chúng là thiết bị (reserved = true, xem reservedNamesWork).
export function safeSegment(name, { reserved = true } = {}) {
  let s = String(name ?? '').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s) s = 'tệp';
  if (reserved && RESERVED.test(s)) s = `_${s}`;
  return s.slice(0, 180);
}

// Windows 11 cho đặt thư mục, tệp tên "con", "nul.txt"... như tên thường (đo trên bản 26200: tạo và đọc
// lại được), còn Windows cũ hơn coi đó là thiết bị: ghi vào "con.txt" là ghi ra console, mất dữ liệu mà
// không báo lỗi. Thử tạo một tệp như vậy một lần để biết, không đoán theo số phiên bản.
let reservedProbe = null;
function reservedNamesWork(root) {
  if (process.platform !== 'win32') return true;
  if (reservedProbe !== null) return reservedProbe;
  const name = 'con.orbit-thu';
  try {
    writeFileSync(join(root, name), '');
    reservedProbe = readdirSync(root).includes(name);
  } catch {
    reservedProbe = false;
  }
  try { rmSync(join(root, name), { force: true }); } catch { /* máy cũ: tên thiết bị, không có tệp để xoá */ }
  return reservedProbe;
}

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function freeSpace(dir) {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

// Tên trùng ở cùng chỗ (Windows không phân biệt hoa thường): "a.txt", "a (2).txt"...
function uniqueRel(parts, used) {
  const last = parts[parts.length - 1];
  const dot = last.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [last.slice(0, dot), last.slice(dot)] : [last, ''];
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? last : `${stem} (${n})${ext}`;
    const rel = [...parts.slice(0, -1), name].join(sep);
    if (!used.has(rel.toLowerCase())) {
      used.add(rel.toLowerCase());
      return rel;
    }
  }
}

export class ClipReceiver {
  constructor({ root = PASTE_ROOT, now = () => Date.now(), free = freeSpace, reservedNames = null } = {}) {
    this.root = root;
    this.now = now;
    this.free = free;
    this.reservedNames = reservedNames; // null: thử trên máy (reservedNamesWork); true/false: phép kiểm đặt sẵn
    this.job = null; // lần dán đang nhận: { id, dir, entries, tops, total, got }
  }

  // files: [{ rel: 'Thư mục/con/a.txt', size }, { rel: 'Thư mục/rỗng', dir: true }] theo thứ tự mẩu sẽ tới.
  begin({ id, files }) {
    this.abort();
    if (!Array.isArray(files) || !files.length) throw new Error('Không có tệp nào để dán.');
    if (files.length > MAX_FILES) throw new Error(`Dán tối đa ${MAX_FILES} tệp một lần.`);
    const sizes = files.map((f) => (f?.dir ? 0 : Math.max(0, Math.floor(Number(f?.size) || 0))));
    const total = sizes.reduce((a, b) => a + b, 0);
    if (total > MAX_TOTAL) throw new Error('Quá 50 GB, quá lớn để dán qua màn hình.');
    this.sweep();
    mkdirSync(this.root, { recursive: true });
    const free = this.free(this.root);
    if (free !== null && total > free - FREE_MARGIN) {
      throw new Error(`Máy này không đủ chỗ trống: cần ${(total / 1024 ** 3).toFixed(1)} GB, ổ chứa thư mục tạm còn ${(Math.max(0, free) / 1024 ** 3).toFixed(1)} GB.`);
    }
    const dir = join(this.root, `${stamp(this.now())}-${(id >>> 0).toString(16)}`);
    mkdirSync(dir, { recursive: true });
    const reserved = !(this.reservedNames ?? reservedNamesWork(this.root));
    const used = new Set();
    const tops = [];
    const entries = files.map((f, i) => {
      const parts = String(f?.rel ?? f?.name ?? '').split(/[\\/]/).filter((x) => x && x !== '.' && x !== '..').map((x) => safeSegment(x, { reserved }));
      if (!parts.length) parts.push('tệp');
      const rel = f?.dir && used.has(parts.join(sep).toLowerCase()) ? parts.join(sep) : uniqueRel(parts, used);
      const path = join(dir, rel);
      const top = join(dir, rel.split(sep)[0]);
      if (!tops.includes(top)) tops.push(top);
      const mtime = Number(f?.mtime) > 0 ? Number(f.mtime) : 0;
      return { path, size: sizes[i], got: 0, fd: null, dir: Boolean(f?.dir), mtime };
    });
    // Thư mục (cả thư mục rỗng) và tệp rỗng có ngay; tệp có nội dung mở lúc mẩu đầu tới.
    for (const e of entries) {
      mkdirSync(e.dir ? e.path : join(e.path, '..'), { recursive: true });
      if (!e.dir && e.size === 0) writeFileSync(e.path, '');
    }
    this.job = { id: id >>> 0, dir, entries, tops, total, got: 0 };
    return { total };
  }

  // Một mẩu tệp (Buffer theo khuôn ở đầu tệp). Trả số byte đã nhận của cả lần dán.
  chunk(buf) {
    const job = this.job;
    if (!job) throw new Error('Không có lần dán nào đang nhận.');
    if (buf.length < CHUNK_HEADER || buf[0] !== CHUNK_TYPE || buf.readUInt32LE(1) !== job.id) throw new Error('Mẩu tệp lạ.');
    const e = job.entries[buf.readUInt32LE(5)];
    if (!e || e.dir) throw new Error('Mẩu tệp lạ.');
    const data = buf.subarray(CHUNK_HEADER);
    if (e.got + data.length > e.size) throw new Error(`Tệp ${basename(e.path)} nhận được nhiều hơn cỡ đã báo.`);
    if (e.fd === null) e.fd = openSync(e.path, 'w');
    writeSync(e.fd, data);
    e.got += data.length;
    job.got += data.length;
    if (e.got === e.size) {
      closeSync(e.fd);
      e.fd = null;
    }
    return job.got;
  }

  // Nhận đủ: trả đường dẫn để đặt clipboard (thư mục và tệp ở tầng đầu, như chỗ đã copy).
  finish(id) {
    const job = this.job;
    if (!job || job.id !== id >>> 0) throw new Error('Không có lần dán này.');
    const short = job.entries.find((e) => !e.dir && e.got !== e.size);
    if (short) throw new Error(`Thiếu dữ liệu tệp ${basename(short.path)}.`);
    this.job = null;
    // Giữ giờ sửa như ở máy gốc (bên gửi có báo): thư mục đặt sau cùng, sâu trước, vì ghi tệp con làm đổi
    // giờ của thư mục chứa nó.
    const timed = job.entries.filter((e) => e.mtime).sort((a, b) => Number(a.dir) - Number(b.dir) || b.path.length - a.path.length);
    for (const e of timed) {
      try { utimesSync(e.path, e.mtime / 1000, e.mtime / 1000); } catch { /* giờ sửa chỉ là phụ */ }
    }
    const files = job.entries.filter((e) => !e.dir);
    const only = files.length === 1 && job.tops.length === 1 && job.tops[0] === files[0].path ? files[0] : null;
    const image = only && IMAGE.test(only.path) && only.size <= IMAGE_MAX ? only.path : null;
    return { paths: job.tops, image, dir: job.dir, count: files.length, bytes: job.total, names: job.tops.map((p) => relative(job.dir, p)) };
  }

  // Bỏ lần dán đang dở (người xem huỷ, rớt mạng, lỗi): đóng tệp và xoá phần đã nhận.
  abort() {
    const job = this.job;
    this.job = null;
    if (!job) return;
    for (const e of job.entries) {
      if (e.fd !== null) {
        try { closeSync(e.fd); } catch { /* đã đóng */ }
        e.fd = null;
      }
    }
    rmSync(job.dir, { recursive: true, force: true });
  }

  // Dọn thư mục của những lần dán cũ hơn 24 giờ (cả ảnh lưu ra từ clipboard cho lời mời).
  sweep() {
    let names;
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    const limit = this.now() - KEEP_MS;
    for (const name of names) {
      const p = join(this.root, name);
      try {
        if (statSync(p).mtimeMs < limit) rmSync(p, { recursive: true, force: true });
      } catch {
        // đang bị dùng: để lần sau
      }
    }
  }
}

// ---- Thứ vừa copy trên máy này, mời bên kia dán ------------------------------------------------------
// { seq, kind: 'files', items: [{ rel, size, dir, mtime, abs }], total, more } | { seq, kind: 'text', text }
// | { seq, kind: 'none' }. Thư mục được đi hết bên trong (bỏ lối tắt kiểu junction, có thể trỏ vòng lại);
// ảnh trơn (ảnh chụp màn hình) được lưu ra PNG để đi như một tệp.
export async function describeClipboard(input, { imageDir = PASTE_ROOT } = {}) {
  const c = await input.readClipboard();
  const seq = Number(c.seq) >>> 0;
  if (Array.isArray(c.files) && c.files.length) {
    const items = [];
    let total = 0;
    let more = false;
    const add = async (abs, rel) => {
      if (items.length >= MAX_FILES) {
        more = true;
        return;
      }
      let s;
      try {
        s = await lstat(abs);
      } catch {
        return; // vừa bị xoá, hay không được phép đọc
      }
      if (s.isSymbolicLink()) return;
      if (s.isDirectory()) {
        items.push({ rel, dir: true, size: 0, mtime: Math.floor(s.mtimeMs), abs });
        let names = [];
        try { names = await readdir(abs); } catch { /* không đọc được bên trong: gửi thư mục rỗng */ }
        for (const name of names) await add(join(abs, name), `${rel}/${name}`);
      } else {
        items.push({ rel, size: s.size, mtime: Math.floor(s.mtimeMs), abs });
        total += s.size;
      }
    };
    for (const p of c.files) await add(p, basename(p) || 'tệp');
    return { seq, kind: 'files', items, total, more };
  }
  if (typeof c.text === 'string' && c.text) {
    return Buffer.byteLength(c.text) > TEXT_MAX ? { seq, kind: 'none', reason: 'Đoạn chữ quá dài để chép qua màn hình.' } : { seq, kind: 'text', text: c.text };
  }
  if (c.image) {
    mkdirSync(imageDir, { recursive: true });
    const abs = join(imageDir, `ảnh-${seq}.png`);
    await input.saveClipboardImage(abs);
    const { size } = statSync(abs);
    return { seq, kind: 'files', items: [{ rel: 'Ảnh.png', size, abs }], total: size, more: false };
  }
  return { seq, kind: 'none' };
}

// Lời mời gửi qua mạng: bỏ đường dẫn thật trên máy.
export const publicOffer = ({ seq, kind, text, items, total, more, reason }) => (kind === 'files'
  ? { seq, kind, items: items.map(({ abs, ...x }) => x), total, more }
  : { seq, kind, ...(text !== undefined ? { text } : {}), ...(reason ? { reason } : {}) });

// Đọc một đoạn của một tệp trong lời mời (kéo về từng mẩu).
export async function readSlice(abs, at, length) {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, at);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// Theo dõi clipboard của máy này: hỏi số thứ tự mỗi chừng ấy mili giây (lệnh "n" của win-input.cs, gần
// như không tốn gì), đổi thì gọi onChange(seq). Không báo thứ đã có sẵn lúc bắt đầu, và không báo thay đổi
// do chính Orbit đặt: own() cho biết { busy: đang đặt, seq: số sau lần đặt gần nhất }.
export class ClipWatcher {
  constructor({ input, onChange, own = () => ({ busy: false, seq: -1 }), interval = 500 }) {
    this.input = input;
    this.onChange = onChange;
    this.own = own;
    this.interval = interval;
    this.last = undefined;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = undefined;
    this.tick();
  }

  async tick() {
    try {
      const seq = await this.input.clipSeq();
      const own = this.own();
      if (this.last === undefined) this.last = seq;
      else if (seq !== this.last && !own.busy) {
        this.last = seq;
        if (seq !== own.seq) this.onChange(seq);
      }
    } catch {
      // chương trình điều khiển đang dựng lại: lượt sau hỏi tiếp
    }
    if (this.running) this.timer = setTimeout(() => this.tick(), this.interval);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

// Lần đặt clipboard của Orbit: đánh dấu đang đặt, đặt xong ghi lại số thứ tự để ClipWatcher bỏ qua.
export async function ownedSet(holder, input, set) {
  holder.busy = true;
  try {
    await set();
    holder.seq = await input.clipSeq();
  } finally {
    holder.busy = false;
  }
}
