// Số token Claude Code đã dùng trên máy này kể từ một mốc (đầu tuần của hạn mức usage), đếm từ nhật ký phiên
// mà Claude Code tự ghi ở ~/.claude/projects/**.jsonl, kể cả nhật ký của tác tử phụ nằm trong thư mục con.
// Chỉ đọc, không bao giờ ghi vào đó.
//
// Mỗi lần gọi model là một dòng "assistant" mang message.usage. Một lần gọi trả nhiều khối nội dung thì
// ghi nhiều dòng lặp lại cùng message.id, requestId và cùng usage (đo thật: 790 dòng lặp trong 20 098 dòng),
// phiên rẽ nhánh cũng chép lại lịch sử sang file mới; nên mỗi cặp message.id và requestId chỉ đếm một lần.
//
// Phiên chuyển từ máy khác sang (session-move.mjs) mang theo nguyên nhật ký, mà các lần gọi trong đó máy cũ
// đã đếm rồi: foreignRanges(mã phiên) cho các khoảng byte [đầu, cuối) chép từ máy khác sang, dòng bắt đầu
// trong đó thì bỏ, để trạm cộng các máy không đếm hai lần.
//
// Nhật ký chỉ được ghi nối đuôi, nên mỗi file nhớ chỗ đã đọc tới: lần sau chỉ đọc phần mới ghi thêm. Lần đầu
// phải đọc hết (đo thật: 99 MB) nên đọc từng khúc 1 MB, mỗi khúc nhường vòng sự kiện một lần để đầu máy
// (màn hình, phiên đang chạy) không khựng; dòng được tách ngay trên byte và chỉ dòng có "usage" mới được giải
// mã và parse. File sửa lần cuối trước mốc thì không mở. Mốc đổi (sang tuần mới) thì đếm lại từ đầu.

import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PROJECTS_DIR } from './transcripts.mjs';

const CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;
const USAGE = Buffer.from('"usage"');
export const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const emptyTotals = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const inRanges = (ranges, at) => ranges.some(([a, b]) => at >= a && at < b);

export function addTotals(into, from) {
  into.calls += from.calls || 0;
  for (const f of TOKEN_FIELDS) into[f] += from[f] || 0;
  return into;
}

export const tokenSum = (t) => TOKEN_FIELDS.reduce((n, f) => n + (t?.[f] || 0), 0);

async function listJsonl(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // máy chưa từng chạy Claude Code, hay thư mục vừa bị xoá
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) await listJsonl(path, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

export class TokenCounter {
  constructor({ projectsDir = PROJECTS_DIR, foreignRanges = () => null } = {}) {
    this.dir = projectsDir;
    this.foreignRanges = foreignRanges;
    this.queue = Promise.resolve();
    this.reset(NaN);
  }

  reset(since) {
    this.since = since;
    this.offsets = new Map(); // đường dẫn -> số byte đã đọc (luôn dừng ở đầu một dòng)
    this.seen = new Set(); // message.id:requestId đã đếm
    this.models = new Map(); // model -> { calls, input, output, cacheRead, cacheWrite }
    this.lastAt = 0;
  }

  // Tổng từ mốc sinceMs tới giờ. Các lần gọi chồng nhau thì xếp hàng: lần sau chỉ còn đọc phần mới ghi.
  count(sinceMs) {
    const run = this.queue.then(() => this.scan(sinceMs));
    this.queue = run.catch(() => {});
    return run;
  }

  async scan(sinceMs) {
    if (!Number.isFinite(sinceMs)) throw new Error('Chưa biết mốc đầu tuần để đếm token.');
    if (sinceMs !== this.since) this.reset(sinceMs);
    const files = await listJsonl(this.dir);
    const listed = new Set(files);
    for (const file of this.offsets.keys()) if (!listed.has(file)) this.offsets.delete(file); // file đã bị xoá
    for (const file of files) {
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs) continue; // không có dòng nào ghi sau mốc
      // File ngắn đi là đã bị viết lại: đọc lại từ đầu, dòng đã đếm bị gạt nhờ sổ message.id.
      const done = this.offsets.get(file) || 0;
      const from = st.size < done ? 0 : done;
      if (st.size > from) await this.readFrom(file, from, st.size);
    }
    return this.snapshot();
  }

  async readFrom(file, from, size) {
    const ranges = this.foreignRanges(basename(file, '.jsonl')) || null;
    let fh;
    try {
      fh = await open(file, 'r');
    } catch {
      return;
    }
    try {
      let pos = from;
      let carry = null; // phần dòng chưa hết ở cuối khúc trước
      let carryAt = from; // vị trí trong file của byte đầu `carry`
      while (pos < size) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        const data = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const dataAt = carry ? carryAt : pos;
        pos += bytesRead;
        const end = data.lastIndexOf(NEWLINE) + 1; // số byte của các dòng đã trọn
        if (end > 0) {
          this.consume(data, end, dataAt, ranges);
          // Dòng cuối chưa có dấu xuống dòng (Claude Code đang ghi dở) thì để lần sau đọc lại.
          this.offsets.set(file, dataAt + end);
        }
        carry = end < data.length ? data.subarray(end) : null; // một dòng dài hơn một khúc thì gom tiếp
        carryAt = dataAt + end;
      }
    } finally {
      await fh.close().catch(() => {});
    }
  }

  // Các dòng trọn trong data[0, end), byte đầu ở vị trí `base` của file.
  consume(data, end, base, ranges) {
    let hit = -1; // chỗ "usage" kế tiếp, dùng lại cho mọi dòng đứng trước nó
    for (let s = 0; s < end;) {
      if (hit < s) {
        hit = data.indexOf(USAGE, s);
        if (hit < 0 || hit >= end) return; // phần còn lại không dòng nào có usage
      }
      let e = data.indexOf(NEWLINE, s);
      if (e < 0 || e >= end) e = end;
      if (hit < e && !(ranges && inRanges(ranges, base + s))) this.take(data.toString('utf8', s, e));
      s = e + 1;
    }
  }

  take(line) {
    if (!line.includes('"assistant"')) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const msg = entry?.message;
    const u = msg?.usage;
    if (entry.type !== 'assistant' || !u || typeof u !== 'object') return;
    const at = Date.parse(entry.timestamp);
    if (!(at >= this.since)) return;
    const model = String(msg.model || 'unknown').slice(0, 80);
    if (model === '<synthetic>') return; // dòng báo lỗi do Claude Code tự sinh, không gọi model
    const key = msg.id || entry.requestId ? `${msg.id || ''}:${entry.requestId || ''}` : `uuid:${entry.uuid || ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    let t = this.models.get(model);
    if (!t) this.models.set(model, (t = emptyTotals()));
    t.calls += 1;
    t.input += num(u.input_tokens);
    t.output += num(u.output_tokens);
    t.cacheRead += num(u.cache_read_input_tokens);
    t.cacheWrite += num(u.cache_creation_input_tokens);
    if (at > this.lastAt) this.lastAt = at;
  }

  // { since, at, lastAt, total: { calls, input, output, cacheRead, cacheWrite }, models: { tên: cùng dạng } }
  snapshot(now = Date.now()) {
    const total = emptyTotals();
    const models = {};
    for (const [name, t] of this.models) {
      models[name] = { ...t };
      addTotals(total, t);
    }
    return {
      since: new Date(this.since).toISOString(),
      at: new Date(now).toISOString(),
      lastAt: this.lastAt ? new Date(this.lastAt).toISOString() : null,
      total,
      models,
    };
  }
}
