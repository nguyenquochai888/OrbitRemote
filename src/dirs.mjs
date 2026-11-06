// Duyệt thư mục trên máy này để chọn thư mục làm việc khi mở phiên từ app (nút "Duyệt" ở bảng Phiên mới).
// Chỉ đọc tên thư mục con, không đọc tệp hay nội dung gì; app đã ghép đôi vốn mở được phiên Claude ở bất
// kỳ thư mục nào của máy.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAX_ENTRIES = 500;
// Thư mục hệ thống không ai chọn làm thư mục làm việc: $Recycle.Bin, System Volume Information...
const HIDDEN = /^(\$|System Volume Information$|Recovery$|Config\.Msi$|DumpStack\.log)/i;

// Điểm bắt đầu: vài thư mục quen dùng của người dùng, rồi các ổ đĩa (Windows) hay thư mục gốc.
export function dirRoots({ home = homedir(), platform = process.platform, exists = existsSync } = {}) {
  const places = [
    ['Thư mục người dùng', home],
    ['Desktop', join(home, 'Desktop')],
    ['Documents', join(home, 'Documents')],
    ['GitHub', join(home, 'Documents', 'GitHub')],
  ].filter(([, p]) => exists(p)).map(([name, path]) => ({ name, path, kind: 'place' }));
  const drives = platform === 'win32'
    ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((p) => exists(p)).map((p) => ({ name: `Ổ ${p.slice(0, 2)}`, path: p, kind: 'drive' }))
    : [{ name: '/', path: '/', kind: 'drive' }];
  return { path: '', parent: null, entries: [...places, ...drives], more: false };
}

// Thư mục con của `path` (chỉ thư mục thật: lối tắt kiểu junction như "Application Data" bị bỏ, mở ra
// toàn bị từ chối), xếp theo tên như File Explorer (số theo giá trị: 2 trước 10), thư mục ẩn kiểu ".git"
// xuống cuối vì hiếm khi là thư mục làm việc. Trống thì về dirRoots.
export function listDirs(path, { roots = dirRoots } = {}) {
  if (!path) return roots();
  const full = resolve(String(path));
  let items;
  try {
    items = readdirSync(full, { withFileTypes: true });
  } catch (err) {
    const why = { ENOENT: 'không có', EACCES: 'không được phép đọc', EPERM: 'không được phép đọc', ENOTDIR: 'không phải thư mục' }[err.code] || err.code || err.message;
    throw new Error(`Không mở được ${full}: ${why}.`);
  }
  const entries = items
    .filter((d) => d.isDirectory() && !HIDDEN.test(d.name))
    .map((d) => ({ name: d.name, path: join(full, d.name), kind: 'dir' }))
    .sort((a, b) => (a.name.startsWith('.') - b.name.startsWith('.'))
      || a.name.localeCompare(b.name, 'vi', { sensitivity: 'base', numeric: true }));
  const parent = dirname(full);
  return { path: full, parent: parent === full ? '' : parent, entries: entries.slice(0, MAX_ENTRIES), more: entries.length > MAX_ENTRIES };
}
