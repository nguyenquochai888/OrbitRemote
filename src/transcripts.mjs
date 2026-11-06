// Đọc nhật ký phiên mà Claude Code tự ghi ra ~/.claude/projects/<thư mục>/<mã phiên>.jsonl.
//
// Nhờ đó app thấy được cả những phiên mở bằng tay trong VS Code hay terminal, và mở lại
// lịch sử của một phiên sau khi trạm khởi động lại. Chỉ đọc, không bao giờ ghi vào đó.
//
// File nhật ký có thể nặng hàng chục, thậm chí hàng trăm MB (đo trên máy thật: 140 MB), và
// đầu máy quét định kỳ để thấy phiên đang mở ngoài app. Vì vậy:
//   - siêu dữ liệu của mỗi file được nhớ theo thời điểm sửa; file không đổi thì không đọc lại;
//   - phần đầu file (thư mục, câu hỏi đầu) chỉ đọc một lần, vì nó không bao giờ đổi;
//   - lịch sử chỉ đọc phần ĐUÔI file, đủ cho vài trăm sự kiện cuối.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { summarizeTool } from './claude-session.mjs';

export const PROJECTS_DIR = process.env.ORBIT_REMOTE_PROJECTS || join(homedir(), '.claude', 'projects');
// Sổ phiên đang chạy của Claude Code nằm cạnh thư mục nhật ký: ~/.claude/sessions/<pid>.json.
const SESSIONS_DIR = process.env.ORBIT_REMOTE_CLAUDE_SESSIONS || join(dirname(PROJECTS_DIR), 'sessions');
const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 64 * 1024;
const HISTORY_TAIL_BYTES = 3 * 1024 * 1024;
export const ACTIVE_WINDOW_MS = 90 * 1000;
const CACHE_MAX = 400;

const cache = new Map(); // đường dẫn -> { mtime, size, head: { cwd, prompt }, title }

function readSlice(file, start, length) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue; // mẩu cắt ngang giữa dòng thì bỏ
    try {
      out.push(JSON.parse(line));
    } catch {
      // dòng cụt ở biên mẩu đọc
    }
  }
  return out;
}

function firstUserText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return '';
  const c = entry.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b?.type === 'text')?.text || '' : '';
  // Lệnh nội bộ và nội dung do hook chèn vào không phải câu người dùng hỏi.
  if (!text || text.startsWith('<')) return '';
  return text;
}

function allFiles() {
  if (!existsSync(PROJECTS_DIR)) return [];
  const files = [];
  for (const dir of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const full = join(PROJECTS_DIR, dir.name);
    let names;
    try {
      names = readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const st = statSync(join(full, name));
        files.push({ file: join(full, name), mtime: st.mtimeMs, size: st.size });
      } catch {
        // file vừa bị xoá giữa lúc quét
      }
    }
  }
  return files;
}

function describe({ file, mtime, size }) {
  let c = cache.get(file);
  if (c && c.mtime === mtime) return c;
  // File nhỏ thì đọc lại trọn (rẻ) để bắt tiêu đề mới; file lớn chỉ đọc đầu một lần.
  if (!c?.head || size <= HEAD_BYTES) {
    const head = parseLines(readSlice(file, 0, Math.min(size, HEAD_BYTES)));
    let cwd = '';
    let prompt = '';
    let title = '';
    for (const e of head) {
      if (!cwd && e.cwd) cwd = e.cwd;
      if (!prompt) prompt = firstUserText(e);
      if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    }
    c = { head: { cwd, prompt }, title };
  }
  // Tiêu đề do AI đặt được ghi lại nhiều lần trong đời phiên: lấy bản mới nhất ở đuôi file.
  if (size > HEAD_BYTES) {
    for (const e of parseLines(readSlice(file, Math.max(0, size - TAIL_BYTES), TAIL_BYTES))) {
      if (e.type === 'ai-title' && e.aiTitle) c.title = e.aiTitle;
      if (!c.head.cwd && e.cwd) c.head.cwd = e.cwd;
    }
  }
  c = { ...c, mtime, size };
  cache.set(file, c);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return c;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // tiến trình có đó, chỉ là không thuộc quyền mình
  }
};

// Phiên Claude đang chạy trên máy, theo sổ Claude Code tự ghi: mỗi phiên (VS Code, terminal, hay
// do app mở) có một file <pid>.json lúc mở và file đó bị xoá lúc đóng. File còn mà tiến trình đã
// chết (máy tắt ngang, phiên bị giết) thì bỏ qua. Trả null nếu máy không có sổ này (bản Claude Code
// cũ): khi đó chỉ còn cách đoán theo giờ ghi nhật ký.
export function listOpenSessions() {
  let names;
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return null;
  }
  const open = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let s;
    try {
      s = JSON.parse(readFileSync(join(SESSIONS_DIR, name), 'utf8'));
    } catch {
      continue; // đang được ghi dở hay vừa bị xoá
    }
    if (typeof s?.sessionId !== 'string' || !Number.isInteger(s.pid) || !pidAlive(s.pid)) continue;
    open.push(s);
  }
  return open;
}

function transcriptOf(claudeSessionId) {
  const file = findTranscript(claudeSessionId);
  if (!file) return null;
  try {
    const st = statSync(file);
    return { mtime: st.mtimeMs, d: describe({ file, mtime: st.mtimeMs, size: st.size }) };
  } catch {
    return null;
  }
}

// Phiên đang mở ngoài app (VS Code, terminal), trừ các mã trong `exclude` (phiên do app giữ).
// Có sổ phiên thì lấy đúng phiên đang chạy, dù đã ngồi yên bao lâu; không có thì lấy nhật ký được
// ghi trong `windowMs` vừa qua.
export function listExternalSessions({ exclude = new Set(), max = 20, windowMs = 15 * 60 * 1000 } = {}) {
  const open = listOpenSessions();
  if (!open) {
    return listTranscripts(max, { sinceMs: windowMs })
      .filter((t) => !exclude.has(t.claudeSessionId))
      .map(({ claudeSessionId, title, cwd, modified, maybeActive }) => ({ claudeSessionId, title, cwd, modified, active: maybeActive, open: false }));
  }
  return open
    .filter((s) => !exclude.has(s.sessionId))
    .sort((a, b) => (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0))
    .slice(0, max)
    .map((s) => {
      const t = transcriptOf(s.sessionId);
      const named = s.nameSource === 'user' && s.name;
      return {
        claudeSessionId: s.sessionId,
        title: String(named || t?.d.title || t?.d.head.prompt.slice(0, 80) || s.name || '(chưa có câu hỏi)').slice(0, 120),
        cwd: s.cwd || t?.d.head.cwd || '',
        modified: new Date(t?.mtime || s.updatedAt || s.startedAt || Date.now()).toISOString(),
        active: true, // đang mở thật: "tiếp tục" ở app lúc này sẽ ghi chồng một nhật ký
        open: true,
      };
    });
}

// limit: số file mới nhất; sinceMs: chỉ lấy file được ghi trong khoảng này.
export function listTranscripts(limit = 40, { sinceMs = 0 } = {}) {
  const now = Date.now();
  let files = allFiles().sort((a, b) => b.mtime - a.mtime);
  if (sinceMs) files = files.filter((f) => now - f.mtime < sinceMs);
  const open = listOpenSessions();
  const openIds = open ? new Set(open.map((s) => s.sessionId)) : null;
  return files.slice(0, limit).map((f) => {
    const d = describe(f);
    const claudeSessionId = basename(f.file, '.jsonl');
    return {
      claudeSessionId,
      title: d.title || d.head.prompt.slice(0, 80) || '(chưa có câu hỏi)',
      prompt: d.head.prompt.slice(0, 200),
      cwd: d.head.cwd,
      modified: new Date(f.mtime).toISOString(),
      sizeKb: Math.round(f.size / 1024),
      // Có sổ phiên thì biết chắc phiên nào đang mở; không có thì đoán: file vừa được ghi rất gần
      // đây thì nhiều khả năng phiên đó vẫn đang mở ở đâu đó.
      maybeActive: openIds ? openIds.has(claudeSessionId) : now - f.mtime < ACTIVE_WINDOW_MS,
    };
  });
}

export function findTranscript(claudeSessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(claudeSessionId) || !existsSync(PROJECTS_DIR)) return null;
  for (const dir of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const candidate = join(PROJECTS_DIR, dir.name, `${claudeSessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function toEvents(e, push) {
  if (e.isSidechain || e.isMeta) return;
  const at = e.timestamp;
  const content = e.message?.content;
  if (e.type === 'user') {
    if (typeof content === 'string') {
      if (!content.startsWith('<')) push({ t: 'user', text: content, at });
      return;
    }
    for (const b of content || []) {
      if (b?.type === 'text' && b.text && !b.text.startsWith('<')) push({ t: 'user', text: b.text, at });
      else if (b?.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join('\n') : '';
        push({ t: 'tool_result', id: b.tool_use_id, ok: !b.is_error, preview: text.slice(0, 1500), at });
      }
    }
  } else if (e.type === 'assistant') {
    for (const b of content || []) {
      if (b?.type === 'text' && b.text) push({ t: 'text', text: b.text, at });
      else if (b?.type === 'tool_use') push({ t: 'tool', id: b.id, name: b.name, summary: summarizeTool(b.name, b.input), at });
    }
  }
}

// Dựng lại dòng sự kiện của app từ phần đuôi nhật ký, giữ đúng `max` sự kiện cuối.
// `sinceMtime`: file chưa đổi kể từ lần đọc trước thì trả `unchanged` cho khỏi gửi lại.
export function loadHistory(claudeSessionId, max = 400, { sinceMtime = 0 } = {}) {
  const file = findTranscript(claudeSessionId);
  if (!file) return { events: [], mtime: 0 };
  const fd = openSync(file, 'r');
  let text;
  let mtime;
  try {
    const st = fstatSync(fd);
    mtime = st.mtimeMs;
    if (sinceMtime && mtime === sinceMtime) return { unchanged: true, mtime };
    const start = Math.max(0, st.size - HISTORY_TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    text = buf.subarray(0, n).toString('utf8');
    // Bắt đầu giữa chừng file thì dòng đầu là mẩu cụt: bỏ tới hết dòng.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } finally {
    closeSync(fd);
  }
  const events = [];
  const push = (ev) => {
    events.push(ev);
    if (events.length > max) events.shift();
  };
  for (const line of text.split('\n')) {
    if (!line.startsWith('{"') || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
    try {
      toEvents(JSON.parse(line), push);
    } catch {
      // dòng hỏng
    }
  }
  return { events, mtime, truncated: text.length >= HISTORY_TAIL_BYTES - 1 };
}
