// Một phiên Claude ở máy này làm việc trên một máy khác (công cụ orbit_machine_* của mcp-server.mjs): đây là phần
// chạy ở MÁY ĐÍCH. Trạm đã kiểm quyền (máy đích cho phép máy của phiên điều khiển, hub.mjs machineControl) rồi mới
// chuyển lệnh tới đây. Phiên vẫn tính vào tài khoản Claude của máy nó chạy; ở đây chỉ chạy lệnh, đọc sửa tệp,
// chụp màn hình, bấm chuột gõ phím và gọi Unity, như người ngồi điều khiển từ xa.
//
// Mỗi thao tác trả { text, image? } để công cụ MCP đưa thẳng cho Claude: chữ dễ đọc thay cho JSON, ảnh (màn hình,
// tệp ảnh) là ảnh thật Claude nhìn được.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';

export const CONTROL_ACTIONS = ['run', 'read', 'write', 'edit', 'find', 'screen', 'input', 'unity'];

const RUN_DEFAULT_S = 120;
const RUN_MAX_S = 600;
const OUT_CAP = 30000; // mỗi luồng ra: giữ 15k đầu và 15k cuối
const READ_LINES = 2000;
const READ_LINES_MAX = 5000;
const LINE_CAP = 2000;
const READ_BYTES_MAX = 20 * 1024 * 1024;
const WRITE_BYTES_MAX = 5 * 1024 * 1024;
const IMAGE_BYTES_MAX = 5 * 1024 * 1024;
const FIND_DEFAULT = 100;
const FIND_MAX = 500;
const FIND_SCAN_MAX = 200000; // số mục tối đa duyệt qua mỗi lần tìm
const FIND_FILE_MAX = 2 * 1024 * 1024; // tệp lớn hơn thì không tìm chữ bên trong
// Thư mục thường rất lớn mà hiếm khi cần tìm trong đó (Unity, git, gói).
const FIND_SKIP = new Set(['.git', 'node_modules', 'Library', 'Temp', 'Logs', 'obj', '.vs', '.idea', 'UserSettings']);
// Ảnh màn hình gửi Claude: cạnh dài nhất tối đa chừng này (cỡ Claude đọc rõ mà không tốn thêm token).
export const SHOT_MAX = 1568;
const UNITY_TIMEOUT_MS = 300000;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// Trạm và đầu máy của phiên chờ lâu hơn thời gian thao tác cần (lệnh chạy lâu, Unity), cộng một khoảng dự phòng.
export function controlTimeoutMs(action, args = {}) {
  if (action === 'run') return (clampNum(args.timeout_sec, 1, RUN_MAX_S, RUN_DEFAULT_S) + 20) * 1000;
  if (action === 'unity') return UNITY_TIMEOUT_MS + 20000;
  return 90000;
}

const fail = (text) => {
  throw new Error(text);
};
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
function absPath(p, what = 'path') {
  const s = String(p || '').trim();
  if (!s) fail(`Thiếu ${what}.`);
  if (s.length > 1000 || s.includes('\0')) fail(`${what} không hợp lệ.`);
  if (/^[\\/]{2}/.test(s)) fail('Không làm việc với đường mạng (\\\\máy\\...).');
  if (!isAbsolute(s)) fail(`${what} phải là đường dẫn tuyệt đối trên máy đích (ví dụ D:\\Project\\Game\\a.cs).`);
  return s;
}
// Giữ phần đầu và phần cuối của một luồng ra dài, bỏ đoạn giữa.
function capText(text) {
  if (text.length <= OUT_CAP) return text;
  const half = OUT_CAP / 2;
  return `${text.slice(0, half)}\n… (bỏ ${text.length - OUT_CAP} ký tự ở giữa) …\n${text.slice(-half)}`;
}

// ---- Chạy lệnh ------------------------------------------------------------------------------------------
// Windows: PowerShell (-EncodedCommand, ra UTF-8 để tiếng Việt không vỡ; lệnh dài thì qua tệp .ps1 tạm); máy khác:
// bash -lc. Hết giờ thì giết cả cây tiến trình.
export async function runCommand({ command, cwd, timeout_sec: timeoutSec }) {
  const cmd = String(command ?? '');
  if (!cmd.trim()) fail('Thiếu command.');
  if (cmd.length > 200000) fail('Lệnh quá dài.');
  const dir = cwd ? absPath(cwd, 'cwd') : homedir();
  const dirStat = await stat(dir).catch(() => null);
  if (!dirStat) fail(`Không thấy thư mục trên máy đích: ${dir}`);
  if (!dirStat.isDirectory()) fail(`Không phải thư mục: ${dir}`);
  const ms = clampNum(timeoutSec, 1, RUN_MAX_S, RUN_DEFAULT_S) * 1000;
  let file = null;
  let exe;
  let args;
  if (process.platform === 'win32') {
    const prelude = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding\n";
    const body = `${prelude}& {\n${cmd}\n}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\n`;
    exe = 'powershell.exe';
    if (body.length > 8000) {
      file = join(tmpdir(), `orbit-remote-${randomBytes(6).toString('hex')}.ps1`);
      await writeFile(file, `\ufeff${body}`, 'utf8');
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file];
    } else {
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')];
    }
  } else {
    exe = 'bash';
    args = ['-lc', cmd];
  }
  const started = Date.now();
  try {
    const r = await new Promise((resolve) => {
      let out = '';
      let err = '';
      let timedOut = false;
      let proc;
      try {
        proc = spawn(exe, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ code: -1, out: '', err: e.message, timedOut });
        return;
      }
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      // Giữ tối đa gấp đôi mức cắt trong bộ nhớ: lệnh in vô hạn không làm phình đầu máy.
      proc.stdout.on('data', (d) => { out = out.length > OUT_CAP * 4 ? out.slice(0, OUT_CAP) + out.slice(-OUT_CAP) + d : out + d; });
      proc.stderr.on('data', (d) => { err = err.length > OUT_CAP * 4 ? err.slice(0, OUT_CAP) + err.slice(-OUT_CAP) + d : err + d; });
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(proc.pid);
      }, ms);
      proc.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: -1, out, err: `${err}${e.message}`, timedOut });
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out, err, timedOut });
      });
    });
    const took = ((Date.now() - started) / 1000).toFixed(1);
    const head = r.timedOut ? `Hết giờ sau ${ms / 1000} giây: đã dừng lệnh.` : `Mã thoát ${r.code} · ${took} giây · thư mục ${dir}`;
    const parts = [head];
    if (r.out.trim()) parts.push(`--- stdout ---\n${capText(r.out.replace(/\s+$/, ''))}`);
    if (r.err.trim()) parts.push(`--- stderr ---\n${capText(r.err.replace(/\s+$/, ''))}`);
    if (!r.out.trim() && !r.err.trim()) parts.push('(không in gì)');
    return { text: parts.join('\n') };
  } finally {
    if (file) unlink(file).catch(() => {});
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // đã thoát
      }
    }
  }
}

// ---- Tệp ------------------------------------------------------------------------------------------------
export async function readPath({ path, offset, limit }) {
  const p = absPath(path);
  let st;
  try {
    st = await stat(p);
  } catch {
    fail(`Không thấy trên máy đích: ${p}`);
  }
  if (st.isDirectory()) {
    const entries = await readdir(p, { withFileTypes: true });
    const rows = entries.slice(0, 500).map((e) => `${e.isDirectory() ? '[thư mục] ' : ''}${e.name}`);
    return { text: `${p} (${entries.length} mục${entries.length > 500 ? ', hiện 500 mục đầu' : ''})\n${rows.join('\n')}` };
  }
  const mime = IMAGE_MIME[extname(p).toLowerCase()];
  if (mime) {
    if (st.size > IMAGE_BYTES_MAX) fail(`Ảnh quá lớn để gửi (${Math.round(st.size / 1024)} KB, tối đa ${IMAGE_BYTES_MAX / 1024 / 1024} MB).`);
    return { text: `${p} (ảnh, ${Math.round(st.size / 1024)} KB)`, image: { data: (await readFile(p)).toString('base64'), mime } };
  }
  if (st.size > READ_BYTES_MAX) fail(`Tệp quá lớn (${Math.round(st.size / 1024 / 1024)} MB): dùng orbit_machine_run để đọc từng phần.`);
  const buf = await readFile(p);
  if (buf.subarray(0, 8192).includes(0)) fail(`Tệp nhị phân, không đọc thành chữ được: ${p}`);
  const lines = buf.toString('utf8').replace(/^\ufeff/, '').split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const from = Math.max(1, Math.floor(clampNum(offset, 1, Number.MAX_SAFE_INTEGER, 1)));
  const count = Math.floor(clampNum(limit, 1, READ_LINES_MAX, READ_LINES));
  const slice = lines.slice(from - 1, from - 1 + count);
  const width = String(from + slice.length).length;
  const body = slice.map((l, i) => `${String(from + i).padStart(width, ' ')}\t${l.length > LINE_CAP ? `${l.slice(0, LINE_CAP)}… (dòng dài, đã cắt)` : l}`).join('\n');
  const shown = slice.length ? `hiện dòng ${from}–${from + slice.length - 1}` : 'không còn dòng nào từ vị trí này';
  return { text: `${p} (${lines.length} dòng; ${shown})\n${body}` };
}

export async function writePath({ path, content }) {
  const p = absPath(path);
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > WRITE_BYTES_MAX) fail(`Nội dung quá lớn (${Math.round(bytes / 1024)} KB, tối đa ${WRITE_BYTES_MAX / 1024 / 1024} MB).`);
  if ((await stat(p).catch(() => null))?.isDirectory()) fail(`Đây là thư mục, không ghi đè được: ${p}`);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text, 'utf8');
  return { text: `Đã ghi ${bytes} byte vào ${p}.` };
}

// Thay đúng một đoạn chữ (hay mọi chỗ khi replace_all). Tệp xuống dòng kiểu Windows (\r\n) mà đoạn cần thay viết
// bằng \n thì vẫn khớp, và tệp giữ nguyên kiểu xuống dòng cũ.
export async function editPath({ path, old_string: oldString, new_string: newString, replace_all: replaceAll }) {
  const p = absPath(path);
  const from = String(oldString ?? '');
  const to = String(newString ?? '');
  if (!from) fail('Thiếu old_string.');
  if (from === to) fail('old_string và new_string giống nhau.');
  let raw;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    fail(`Không đọc được tệp trên máy đích: ${p}`);
  }
  const bom = raw.startsWith('\ufeff') ? '\ufeff' : '';
  let text = bom ? raw.slice(1) : raw;
  const crlf = text.includes('\r\n') && !from.includes('\r');
  if (crlf) text = text.replace(/\r\n/g, '\n');
  const count = text.split(from).length - 1;
  if (!count) fail(`Không thấy old_string trong ${p}. Đọc lại tệp bằng orbit_machine_read rồi chép đúng đoạn cần thay.`);
  if (count > 1 && !replaceAll) fail(`old_string có ${count} chỗ trong ${p}: thêm chữ xung quanh cho chỉ còn một chỗ, hay đặt replace_all.`);
  let next = replaceAll ? text.split(from).join(to) : text.replace(from, () => to);
  if (crlf) next = next.replace(/\n/g, '\r\n');
  await writeFile(p, bom + next, 'utf8');
  return { text: `Đã sửa ${replaceAll ? count : 1} chỗ trong ${p}.` };
}

// Mẫu kiểu glob ("**/*.cs", "Assets/**/Player*.prefab", "*.{png,jpg}") thành biểu thức chính quy trên đường dẫn
// tương đối dùng dấu /. Không phân biệt hoa thường (Windows).
export function globToRegex(pattern) {
  const p = String(pattern || '**/*').replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const slash = p[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end < 0) {
        re += '\\{';
      } else {
        re += `(?:${p.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

export async function findPaths({ path, pattern, contains, max_results: maxResults }) {
  const root = absPath(path, 'path (thư mục gốc để tìm)');
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat) fail(`Không thấy thư mục trên máy đích: ${root}`);
  if (!rootStat.isDirectory()) fail(`Không phải thư mục: ${root}`);
  const match = globToRegex(pattern || '**/*');
  let grep = null;
  if (contains) {
    try {
      grep = new RegExp(String(contains), 'i');
    } catch (err) {
      fail(`contains không phải biểu thức chính quy hợp lệ: ${err.message}`);
    }
  }
  const max = Math.floor(clampNum(maxResults, 1, FIND_MAX, FIND_DEFAULT));
  const out = [];
  let scanned = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      scanned += 1;
      if (scanned > FIND_SCAN_MAX) {
        truncated = true;
        stack.length = 0;
        break;
      }
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!FIND_SKIP.has(e.name)) stack.push(full);
        continue;
      }
      const rel = relative(root, full).replace(/\\/g, '/');
      if (!match.test(rel)) continue;
      if (!grep) {
        out.push(full);
      } else {
        let st;
        try {
          st = await stat(full);
        } catch {
          continue;
        }
        if (st.size > FIND_FILE_MAX) continue;
        let buf;
        try {
          buf = await readFile(full);
        } catch {
          continue;
        }
        if (buf.subarray(0, 8192).includes(0)) continue;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length && out.length < max; i += 1) {
          if (grep.test(lines[i])) out.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
        }
      }
      if (out.length >= max) {
        truncated = true;
        break;
      }
    }
  }
  const head = `${out.length} kết quả trong ${root}${truncated ? ' (đã dừng ở giới hạn; thu hẹp path, pattern hay contains)' : ''}`;
  return { text: out.length ? `${head}\n${out.join('\n')}` : `Không thấy gì trong ${root} khớp ${pattern || '**/*'}${contains ? ` có "${contains}"` : ''}.` };
}

// ---- Màn hình, chuột, phím ------------------------------------------------------------------------------
// Cỡ ảnh gửi Claude cho một màn (cạnh dài tối đa SHOT_MAX, giữ tỉ lệ, cạnh chẵn). Toạ độ trong orbit_machine_input
// tính theo đúng ảnh này, nên đổi về toạ độ thật bằng cùng một phép tính, không cần nhớ gì giữa hai lệnh.
export function shotSize(mon) {
  const k = Math.min(1, SHOT_MAX / Math.max(mon.width, mon.height));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(mon.width * k), height: even(mon.height * k), scale: k };
}

async function pickScreen(ctx, index) {
  const list = await ctx.input().screens();
  if (!Array.isArray(list) || !list.length) fail('Máy đích không báo màn hình nào.');
  if (index !== undefined && index !== null && index !== '') {
    const hit = list.find((s) => Number(s.index) === Number(index));
    if (!hit) fail(`Không có màn ${index}. Các màn: ${list.map((s) => `${s.index} (${s.width}x${s.height})`).join(', ')}.`);
    return { mon: hit, list };
  }
  return { mon: list.find((s) => s.primary) || list[0], list };
}

export async function captureScreen(ctx, { screen } = {}) {
  if (process.platform !== 'win32') fail('Chụp màn hình từ xa hiện chỉ làm cho máy Windows.');
  const ff = ctx.ffmpeg();
  if (!ff) fail('Máy đích chưa có ffmpeg (winget install -e --id Gyan.FFmpeg).');
  const { mon, list } = await pickScreen(ctx, screen);
  const size = shotSize(mon);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'gdigrab', '-framerate', '5', '-draw_mouse', '1',
    '-offset_x', String(mon.x), '-offset_y', String(mon.y), '-video_size', `${mon.width}x${mon.height}`, '-i', 'desktop',
    '-frames:v', '1', '-vf', `scale=${size.width}:${size.height}:flags=bicubic`, '-q:v', '4', '-f', 'mjpeg', 'pipe:1'];
  const data = await new Promise((resolve, reject) => {
    const proc = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    const timer = setTimeout(() => proc.kill(), 20000);
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) reject(new Error(`Không chụp được màn hình: ${err.trim() || 'ffmpeg không trả ảnh'}`));
      else resolve(buf);
    });
  });
  const others = list.length > 1 ? ` Máy có ${list.length} màn: ${list.map((s) => `${s.index}${s.primary ? ' (chính)' : ''}`).join(', ')}; chọn bằng "screen".` : '';
  return {
    text: `Màn ${mon.index}: ${mon.width}x${mon.height} điểm ảnh thật; ảnh ${size.width}x${size.height}. Toạ độ x, y cho orbit_machine_input tính theo ảnh này (góc trên trái là 0, 0).${others}`,
    image: { data: data.toString('base64'), mime: 'image/jpeg' },
    size,
    mon,
  };
}

// Tên phím → mã phím ảo của Windows. Tổ hợp viết "ctrl+s", "alt+f4", "win+r", "shift+tab".
const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, windows: 0x5b, cmd: 0x5b,
  enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27, space: 0x20,
  capslock: 0x14, printscreen: 0x2c, menu: 0x5d,
};
for (let i = 1; i <= 12; i += 1) VK[`f${i}`] = 0x6f + i;
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d]);
function vkOf(name) {
  const k = String(name || '').trim().toLowerCase();
  if (VK[k] !== undefined) return VK[k];
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  return fail(`Phím lạ: "${name}". Dùng tên như enter, esc, tab, ctrl, shift, alt, win, up, f5, a, 1.`);
}

const BUTTON = { left: 0, right: 1, middle: 2 };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// actions: [{ type: 'move'|'click'|'double_click'|'drag'|'scroll'|'type'|'key', x, y, to_x, to_y, button, dy, text,
// keys }]. Toạ độ theo ảnh của orbit_machine_screen cho cùng màn. screenshot: chụp lại sau khi làm xong.
export async function sendInput(ctx, { screen, actions, screenshot }) {
  if (process.platform !== 'win32') fail('Điều khiển chuột, phím từ xa hiện chỉ làm cho máy Windows.');
  if (!Array.isArray(actions) || !actions.length) fail('Thiếu actions.');
  if (actions.length > 50) fail('Mỗi lần tối đa 50 thao tác.');
  const input = ctx.input();
  const { mon } = await pickScreen(ctx, screen);
  const size = shotSize(mon);
  const at = (x, y) => {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) fail('Thiếu x, y.');
    if (nx < 0 || ny < 0 || nx > size.width || ny > size.height) fail(`Toạ độ (${nx}, ${ny}) nằm ngoài ảnh ${size.width}x${size.height} của màn ${mon.index}.`);
    return { x: mon.x + Math.min(mon.width - 1, nx / size.scale), y: mon.y + Math.min(mon.height - 1, ny / size.scale) };
  };
  const done = [];
  for (const a of actions) {
    const type = String(a?.type || '');
    if (type === 'move' || type === 'click' || type === 'double_click' || type === 'scroll' || type === 'drag') {
      const p = at(a.x, a.y);
      input.moveTo(p.x, p.y);
      await pause(40);
    }
    if (type === 'click' || type === 'double_click') {
      const b = BUTTON[String(a.button || 'left')] ?? fail(`Nút chuột lạ: ${a.button}`);
      for (let n = 0; n < (type === 'double_click' ? 2 : 1); n += 1) {
        input.button(b, true);
        await pause(30);
        input.button(b, false);
        await pause(60);
      }
    } else if (type === 'drag') {
      const p0 = at(a.x, a.y);
      const to = at(a.to_x, a.to_y);
      input.button(0, true);
      await pause(60);
      for (let i = 1; i <= 10; i += 1) {
        input.moveTo(p0.x + ((to.x - p0.x) * i) / 10, p0.y + ((to.y - p0.y) * i) / 10);
        await pause(25);
      }
      input.button(0, false);
    } else if (type === 'scroll') {
      input.wheel(Math.round(clampNum(a.dy, -5000, 5000, -120)));
    } else if (type === 'type') {
      const text = String(a.text ?? '');
      if (text.length > 5000) fail('Mỗi lần gõ tối đa 5000 ký tự.');
      input.text(text);
      await pause(Math.min(2000, 20 + text.length * 2));
    } else if (type === 'key') {
      const keys = String(a.keys || a.key || '').split('+').map((k) => k.trim()).filter(Boolean);
      if (!keys.length) fail('Thiếu keys (ví dụ "ctrl+s").');
      const codes = keys.map(vkOf);
      for (const vk of codes) input.key(vk, true, EXTENDED.has(vk));
      await pause(40);
      for (const vk of [...codes].reverse()) input.key(vk, false, EXTENDED.has(vk));
    } else if (type !== 'move') {
      fail(`Loại thao tác lạ: "${type}". Dùng move, click, double_click, drag, scroll, type, key.`);
    }
    await pause(60);
    done.push(type === 'key' ? `key ${a.keys || a.key}` : type === 'type' ? `type ${JSON.stringify(String(a.text).slice(0, 40))}` : `${type} ${a.x},${a.y}${type === 'drag' ? ` → ${a.to_x},${a.to_y}` : ''}`);
  }
  const text = `Đã làm ${done.length} thao tác trên màn ${mon.index}: ${done.join('; ')}.`;
  if (!screenshot) return { text };
  await pause(400); // chờ màn vẽ lại sau thao tác
  const shot = await captureScreen(ctx, { screen: mon.index });
  return { text: `${text}\n${shot.text}`, image: shot.image };
}

// ---- Unity (Orbit Unity MCP trên máy đích) ----------------------------------------------------------------
export async function unityCli(ctx, { args }) {
  if (!Array.isArray(args) || !args.length) fail('Thiếu args, ví dụ ["ping"] hay ["exec", "--project", "D:\\\\Game", "--code", "Debug.Log(1);"].');
  if (args.length > 40) fail('Quá nhiều tham số.');
  const cli = ctx.unityCli();
  if (!cli || !existsSync(cli)) fail('Máy đích chưa khai Orbit Unity MCP: đặt biến môi trường ORBIT_UNITY_MCP_CLI là đường dẫn tới src/cli.mjs của nó rồi chạy lại đầu máy.');
  const list = args.map((a) => String(a));
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [cli, ...list], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => killTree(proc.pid), UNITY_TIMEOUT_MS);
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ text: `Không chạy được Orbit Unity MCP: ${e.message}` });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const parts = [`Orbit Unity MCP ${list[0]}: mã thoát ${code}`];
      if (out.trim()) parts.push(capText(out.trim()));
      if (err.trim()) parts.push(`--- stderr ---\n${capText(err.trim())}`);
      resolve({ text: parts.join('\n') });
    });
  });
}

// ctx: { input(): InputHelper, ffmpeg(): đường dẫn ffmpeg hay '', unityCli(): đường dẫn cli.mjs }
export async function remoteOp(action, args = {}, ctx = {}) {
  const a = args && typeof args === 'object' ? args : {};
  switch (action) {
    case 'run': return runCommand(a);
    case 'read': return readPath(a);
    case 'write': return writePath(a);
    case 'edit': return editPath(a);
    case 'find': return findPaths(a);
    case 'screen': {
      const shot = await captureScreen(ctx, a);
      return { text: shot.text, image: shot.image };
    }
    case 'input': return sendInput(ctx, a);
    case 'unity': return unityCli(ctx, a);
    default: return fail(`Không hiểu thao tác "${action}".`);
  }
}
