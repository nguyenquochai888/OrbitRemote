// Kiểm nút "Duyệt" ở ô thư mục làm việc khi mở phiên mới: đầu máy liệt kê thư mục con (src/dirs.mjs,
// đọc thư mục thật dựng trong thư mục tạm), và khung duyệt trong bảng Phiên mới (web/views/sheets.js,
// trên một DOM giả tối thiểu) đi vào, lên, chọn rồi điền đúng ô.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { dirRoots, listDirs } from '../src/dirs.mjs';

const names = (r) => r.entries.map((e) => e.name);

test('đầu máy liệt kê thư mục con: chỉ thư mục, xếp theo số tự nhiên, thư mục ẩn xuống cuối, bỏ thư mục hệ thống, có thư mục cha', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-dirs-'));
  try {
    for (const d of ['b', '.git', 'a10', 'a2', 'Ảnh', '$Recycle.Bin', 'System Volume Information']) mkdirSync(join(root, d));
    writeFileSync(join(root, 'ghi-chu.txt'), 'không phải thư mục');
    const r = listDirs(root);
    assert.equal(r.path, root);
    assert.equal(r.parent, dirname(root));
    assert.deepEqual(names(r), ['a2', 'a10', 'Ảnh', 'b', '.git'], 'a2 trước a10; .git cuối; tệp và thư mục hệ thống không hiện');
    assert.deepEqual(r.entries[0], { name: 'a2', path: join(root, 'a2'), kind: 'dir' });
    assert.equal(r.more, false);

    assert.throws(() => listDirs(join(root, 'khong-co')), /^Error: Không mở được .*khong-co: không có\.$/);
    assert.throws(() => listDirs(join(root, 'ghi-chu.txt')), /không phải thư mục\.$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('đầu máy liệt kê thư mục con: thư mục quá đông thì cắt ở 500 và báo còn nữa; gốc ổ đĩa không có thư mục cha', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-dirs-'));
  try {
    for (let i = 0; i < 501; i += 1) mkdirSync(join(root, `d${i}`));
    const r = listDirs(root);
    assert.equal(r.entries.length, 500);
    assert.equal(r.more, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(listDirs(parse(tmpdir()).root).parent, '', 'đứng ở gốc ổ thì "Lên" về danh sách ổ đĩa');
});

test('chỗ bắt đầu duyệt: thư mục quen dùng có thật trước, rồi các ổ đĩa đang có; máy không phải Windows thì có "/"', () => {
  const have = new Set(['C:\\Users\\A', join('C:\\Users\\A', 'Documents'), 'C:\\', 'E:\\']);
  const win = dirRoots({ home: 'C:\\Users\\A', platform: 'win32', exists: (p) => have.has(p) });
  assert.deepEqual(win.entries.map((e) => [e.name, e.kind]),
    [['Thư mục người dùng', 'place'], ['Documents', 'place'], ['Ổ C:', 'drive'], ['Ổ E:', 'drive']]);
  assert.equal(win.path, '');
  assert.equal(win.parent, null);
  assert.deepEqual(listDirs('', { roots: () => win }), win, 'đường dẫn trống là chỗ bắt đầu');

  const nix = dirRoots({ home: '/home/a', platform: 'linux', exists: () => false });
  assert.deepEqual(nix.entries, [{ name: '/', path: '/', kind: 'drive' }]);
});

// ---- Khung duyệt trong bảng Phiên mới -----------------------------------------------

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : Boolean(force);
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
}
class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.style = { setProperty() {} };
    this.dataset = {};
    this.attrs = {};
    this.classList = new FakeClassList();
    this.textContent = '';
  }
  set className(v) {
    this.classList = new FakeClassList();
    for (const c of String(v).split(/\s+/)) if (c) this.classList.add(c);
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(type, e = {}) { for (const fn of this.listeners[type] || []) fn(e); }
  append(...children) { for (const c of children) { c.parent = this; this.children.push(c); } }
  get firstChild() { return this.children[0] || null; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  all(cls, out = []) { if (this.classList.contains(cls)) out.push(this); for (const c of this.children) c.all?.(cls, out); return out; }
  find(cls) { return this.all(cls)[0] || null; }
  text() { return this.tagName === '#text' ? this.textContent : this.textContent + this.children.map((c) => c.text?.() || '').join(''); }
}
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const sheetRoot = new FakeEl('div');
define('Node', FakeNode);
define('window', globalThis);
define('document', {
  createElement: (t) => new FakeEl(t),
  createElementNS: (_ns, t) => new FakeEl(t),
  createTextNode: (s) => Object.assign(new FakeEl('#text'), { textContent: String(s) }),
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => sheetRoot,
  body: new FakeEl('body'),
  visibilityState: 'visible',
});
define('requestAnimationFrame', (fn) => setTimeout(fn, 0));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
define('localStorage', { getItem: () => null, setItem() {} });
define('location', { hash: '#/', protocol: 'http:', hostname: '192.168.1.10' });

// Cây thư mục giả của máy m1, trả theo đúng dạng listDirs.
const TREE = {
  '': { path: '', parent: null, entries: [{ name: 'Documents', path: 'C:\\Users\\A\\Documents', kind: 'place' }, { name: 'Ổ D:', path: 'D:\\', kind: 'drive' }], more: false },
  'D:\\': { path: 'D:\\', parent: '', entries: [{ name: 'Project', path: 'D:\\Project', kind: 'dir' }], more: false },
  'D:\\Project': { path: 'D:\\Project', parent: 'D:\\', entries: [{ name: 'Game', path: 'D:\\Project\\Game', kind: 'dir' }], more: false },
  'D:\\Project\\Game': { path: 'D:\\Project\\Game', parent: 'D:\\Project', entries: [], more: false },
};
const asked = [];
let oldAgent = false;
define('fetch', async (url) => {
  const u = new URL(url, 'http://hub');
  if (!u.pathname.endsWith('/dirs')) return { ok: true, status: 200, json: async () => ({ transcripts: [], dirs: [] }) };
  const path = u.searchParams.get('path');
  asked.push(path);
  if (oldAgent) return { ok: false, status: 500, json: async () => ({ error: 'Máy này cần setup bản Orbit Remote mới để duyệt thư mục.' }) };
  if (!(path in TREE)) return { ok: false, status: 500, json: async () => ({ error: `Không mở được ${path}: không có.` }) };
  return { ok: true, status: 200, json: async () => TREE[path] };
});

const { store } = await import('../web/lib/store.js');
const { openNewSession } = await import('../web/views/sheets.js');
const tick = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0)); };
store.machines.set('m1', { id: 'm1', name: 'Mini PC', online: true, platform: 'win32' });

const button = (box, text) => box.all('btn').find((b) => b.text().includes(text));
const cwdInput = (sheet) => {
  const found = [];
  const walk = (el) => { if (el.attrs?.['aria-label'] === 'Thư mục làm việc' && el.tagName === 'input') found.push(el); for (const c of el.children || []) walk(c); };
  walk(sheet);
  return found[0];
};

test('khung duyệt: mở từ ổ đĩa, đi vào thư mục, lên thư mục cha, chọn thì điền ô thư mục làm việc và đóng khung', async () => {
  asked.length = 0;
  clear(sheetRoot);
  openNewSession({ machineId: 'm1', cwd: '' });
  const browse = sheetRoot.find('browse-btn');
  assert.ok(browse, 'có nút Duyệt cạnh ô thư mục làm việc');
  assert.equal(sheetRoot.all('field').find((f) => f.text().startsWith('Thư mục làm việc'))?.tagName, 'div',
    'ô thư mục làm việc là nhóm, không phải <label>, vì nút trong <label> không bấm được trên iPhone');

  browse.dispatch('click');
  assert.ok(browse.classList.contains('on'));
  assert.match(sheetRoot.find('dir-browser').text(), /Đang đọc thư mục trên máy/);
  await tick();
  assert.deepEqual(asked, [''], 'ô trống thì bắt đầu ở các ổ đĩa và chỗ quen dùng');
  let box = sheetRoot.find('dir-browser');
  assert.deepEqual(box.all('dir-name').map((n) => n.text()), ['Documents', 'Ổ D:']);
  assert.equal(button(box, 'Chọn thư mục này').attrs.disabled, '', 'chưa vào thư mục nào thì chưa chọn được');
  assert.equal(box.find('dir-up'), null, 'ở chỗ bắt đầu thì không còn nút lên');

  box.all('dir-row')[1].dispatch('click');
  await tick();
  box.all('dir-row')[0].dispatch('click');
  await tick();
  box.all('dir-row')[0].dispatch('click');
  await tick();
  assert.equal(box.find('dir-path').text(), 'D:\\Project\\Game');
  assert.match(box.find('dir-list').text(), /Không có thư mục con/);
  box.find('dir-up').dispatch('click');
  await tick();
  assert.equal(box.find('dir-path').text(), 'D:\\Project');
  assert.deepEqual(asked, ['', 'D:\\', 'D:\\Project', 'D:\\Project\\Game', 'D:\\Project']);

  button(box, 'Chọn thư mục này').dispatch('click');
  assert.equal(cwdInput(sheetRoot).value, 'D:\\Project', 'chọn là điền đường dẫn vào ô');
  assert.equal(sheetRoot.find('dir-browser'), null, 'chọn xong thì khung duyệt đóng');
  assert.ok(!browse.classList.contains('on'));

  browse.dispatch('click');
  await tick();
  assert.equal(asked.at(-1), 'D:\\Project', 'mở lại thì bắt đầu ở thư mục đang có trong ô');
  browse.dispatch('click');
  assert.equal(sheetRoot.find('dir-browser'), null, 'bấm lại nút Duyệt là đóng khung');
});

test('khung duyệt: thư mục gõ sẵn không còn thì về chỗ bắt đầu; máy chạy bản cũ thì báo cần setup và đóng được', async () => {
  asked.length = 0;
  clear(sheetRoot);
  openNewSession({ machineId: 'm1', cwd: 'D:\\Da-xoa' });
  sheetRoot.find('browse-btn').dispatch('click');
  await tick();
  assert.deepEqual(asked, ['D:\\Da-xoa', '']);
  assert.deepEqual(sheetRoot.find('dir-browser').all('dir-name').map((n) => n.text()), ['Documents', 'Ổ D:']);

  oldAgent = true;
  try {
    clear(sheetRoot);
    openNewSession({ machineId: 'm1', cwd: '' });
    sheetRoot.find('browse-btn').dispatch('click');
    await tick();
    const box = sheetRoot.find('dir-browser');
    assert.match(box.text(), /cần setup bản Orbit Remote mới để duyệt thư mục/);
    button(box, 'Đóng').dispatch('click');
    assert.equal(sheetRoot.find('dir-browser'), null);
  } finally {
    oldAgent = false;
  }
});

function clear(el) { while (el.firstChild) el.firstChild.remove(); }
