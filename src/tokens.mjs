// Bảng token của Orbit Remote (custom/tokens.md): lệnh tắt gõ trong ô soạn ($qa, $code...) và vai trò
// của phiên trong nhóm.
//
// Mỗi dòng bảng là một token: | `$code [yêu cầu]` | mô tả | `tokens/code.md` |
//   - Token có "[...]" sau tên nhận thêm nội dung: làm được vai trò trong nhóm, và Lệnh nhanh điền sẵn
//     vào ô soạn để gõ tiếp. Token không có "[...]" là lệnh chạy thẳng: Lệnh nhanh hỏi lại rồi gửi.
//   - Cột cuối là tệp đặc tả, đường dẫn tính từ thư mục custom/. Dòng đầu của tệp có dạng
//     # `$code [yêu cầu]` — ghi chú ngắn
//     thì ghi chú ấy hiện trong Lệnh nhanh; không có thì hiện cột mô tả.
//
// Bảng được đọc lại khi tệp đổi, nên thêm hay bớt token là app tự theo ở lần mở kế tiếp.

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { CUSTOM_DIR } from './paths.mjs';

export const TOKENS_FILE = join(CUSTOM_DIR, 'tokens.md');

let cache = null; // { file, mtime, tokens }: đọc lại khi tokens.md đổi

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// Dòng bảng: | `$qa [yêu cầu]` | mô tả | `tokens/qa.md` |
const ROW = /^\|\s*`(\$[A-Za-z_]\w*)(?:\s+\[([^\]]+)\])?`\s*\|\s*(.+?)\s*\|\s*`([^`]+\.md)`\s*\|$/;
// Dòng tiêu đề của tệp đặc tả: # `$qa [nội dung yêu cầu]` — kiểm chất lượng toàn diện
const TITLE = /^#\s*`[^`]+`\s*[—–-]\s*(.+)$/;

const hintText = (text) => {
  const t = text.replace(/`/g, '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// Tệp đặc tả phải nằm trong custom/: bảng do người dùng sửa, không cho trỏ ra ngoài.
function specPath(spec, dir) {
  const file = join(dir, spec);
  const rel = relative(dir, file);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? file : '';
}

export function parseTokens(table, readSpec = () => '', dir = CUSTOM_DIR) {
  const out = [];
  const seen = new Set();
  for (const raw of table.split('\n')) {
    const m = ROW.exec(raw.trim());
    if (!m) continue;
    const [, token, arg = '', description, spec] = m;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const file = specPath(spec, dir);
    const title = file ? TITLE.exec(readSpec(file).split('\n')[0].trim())?.[1] || '' : '';
    out.push({ token, arg, hint: hintText(title || description), spec: file });
  }
  return out;
}

export function listTokens(file = TOKENS_FILE) {
  let mtime;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return [];
  }
  if (cache?.file === file && cache.mtime === mtime) return cache.tokens;
  const dir = join(file, '..');
  const tokens = parseTokens(readText(file), readText, dir);
  cache = { file, mtime, tokens };
  return tokens;
}

// Token trong bảng theo tên ("code", "$code", không phân biệt hoa thường), hay null.
export function findToken(name, file = TOKENS_FILE) {
  const key = `$${String(name || '').replace(/^\$/, '')}`.toLowerCase();
  return listTokens(file).find((t) => t.token.toLowerCase() === key) || null;
}

// Đoạn chỉ Claude đọc khi lời nhắn có token trong bảng: token đó nghĩa là gì và tệp đặc tả nằm đâu trên máy
// chạy phiên. Không có token nào thì chuỗi rỗng. Token phải đứng riêng một từ ("$qa", không phải "a$qa"); token mà
// lời nhắn đã ghi sẵn đường dẫn đặc tả (việc giao trong nhóm) thì không nhắc lại.
export function tokenNote(text, file = TOKENS_FILE) {
  const body = String(text || '');
  if (!body.includes('$')) return '';
  const lines = [];
  for (const t of listTokens(file)) {
    const re = new RegExp(`(^|[^\\w$])${t.token.replace('$', '\\$')}(?![\\w])`, 'i');
    if (!re.test(body) || (t.spec && body.includes(t.spec))) continue;
    lines.push(t.spec
      ? `- ${t.token}: ${t.hint}. Đọc tệp đặc tả ${t.spec} rồi làm đúng theo đó.`
      : `- ${t.token}: ${t.hint}.`);
  }
  return lines.length ? `[Orbit Remote] Lời nhắn có token trong bảng token (custom/tokens.md):\n${lines.join('\n')}` : '';
}
