// Kiểm danh sách "Phiên" ở màn một máy (web/views/machines.js) trên một DOM giả tối thiểu: ngoài phiên
// app đang giữ và phiên đang mở ngoài app, danh sách phải có mọi phiên Claude cũ trên máy (nhật ký
// Claude Code tự ghi, kể cả phiên VS Code đã đóng), không lặp phiên đã hiện ở nhóm trên.

import { test } from 'node:test';
import assert from 'node:assert/strict';

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
    this.scrollTop = 0;
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
  contains(el) { for (let x = el; x; x = x.parent) if (x === this) return true; return false; }
  querySelectorAll() { return []; }
  all(cls, out = []) { if (this.classList.contains(cls)) out.push(this); for (const c of this.children) c.all?.(cls, out); return out; }
  find(cls) { return this.all(cls)[0] || null; }
  text() { return this.tagName === '#text' ? this.textContent : this.textContent + this.children.map((c) => c.text?.() || '').join(''); }
}
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('Node', FakeNode);
define('window', globalThis);
define('document', {
  createElement: (t) => new FakeEl(t),
  createElementNS: (_ns, t) => new FakeEl(t),
  createTextNode: (s) => Object.assign(new FakeEl('#text'), { textContent: String(s) }),
  createDocumentFragment: () => new FakeEl('#fragment'),
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => new FakeEl('div'),
  body: new FakeEl('body'),
  visibilityState: 'visible',
});
define('localStorage', { getItem: () => null, setItem() {} });
define('location', { hash: '#/m/m1', protocol: 'http:', hostname: '192.168.1.10' });

// Máy thật đo ngày 2026-10-30: một phiên app đang chạy (cũng có nhật ký trên máy) và bốn phiên VS Code đã đóng.
const APP_CSID = '2e187877-ec71-44a0-9dbe-ae204da5c38a';
const csid = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const TRANSCRIPTS = [
  { claudeSessionId: APP_CSID, title: 'Kéo git về rồi restart đi', cwd: 'C:\\Orbit', modified: '2026-10-30T10:00:00Z', sizeKb: 46304, maybeActive: true },
  { claudeSessionId: csid(1), title: 'dựng trạm Orbit Remote trên máy này', cwd: 'C:\\Orbit', modified: '2026-10-28T14:51:00Z', sizeKb: 7492, maybeActive: false },
  { claudeSessionId: csid(2), title: 'Trả lời đúng một từ', cwd: 'C:\\Orbit', modified: '2026-10-27T15:04:00Z', sizeKb: 244, maybeActive: false },
  { claudeSessionId: csid(3), title: 'setup cho máy này', cwd: 'C:\\Orbit', modified: '2026-10-27T14:53:00Z', sizeKb: 447, maybeActive: false },
  { claudeSessionId: csid(4), title: 'Đang mở ở terminal', cwd: 'C:\\Orbit', modified: '2026-10-30T09:59:00Z', sizeKb: 12, maybeActive: true },
];
// Máy có nhiều phiên cũ (máy của một người vừa cài Orbit Remote, đã dùng Claude Code lâu): chín phiên VS Code đã đóng.
const MANY = Array.from({ length: 9 }, (_, i) => ({ claudeSessionId: `1000000${i}-0000-4000-8000-000000000000`, title: `Phiên cũ ${i}`, cwd: 'D:\\Game', modified: `2026-10-2${i}T08:00:00Z`, sizeKb: 300, maybeActive: false }));
const calls = [];
// Màn của máy còn hỏi nhiệt độ máy theo nhịp; phép kiểm này chỉ đếm lần hỏi danh sách phiên.
const transcriptCalls = (mid = '') => calls.filter((p) => p.endsWith('/transcripts') && (!mid || p === `/api/machines/${mid}/transcripts`));
let fail = false;
define('fetch', async (path) => {
  calls.push(path);
  if (fail) return { ok: false, status: 502, json: async () => ({ error: 'Máy không trả lời.' }) };
  return { ok: true, status: 200, json: async () => ({ transcripts: path.includes('/m4/') ? MANY : TRANSCRIPTS, dirs: ['C:\\Orbit'] }) };
});

const { store } = await import('../web/lib/store.js');
const { mountMachine, mountExternal } = await import('../web/views/machines.js');
const { resetText, tokenText } = await import('../web/views/home.js');
const tick = () => new Promise((r) => setTimeout(r, 0));

store.machines.set('m1', { id: 'm1', name: 'Mini PC', online: true, platform: 'win32', screen: null,
  external: [{ claudeSessionId: csid(4), title: 'Đang mở ở terminal', cwd: 'C:\\Orbit', modified: '2026-10-30T09:59:00Z', active: true, open: true }] });
store.sessions.set('s1', { id: 's1', machineId: 'm1', name: 'Phiên mới', status: 'idle', cwd: 'C:\\Orbit', claudeSessionId: APP_CSID, lastActivity: '2026-10-30T10:00:00Z' });
for (let i = 0; i < 8; i += 1) {
  store.sessions.set(`old${i}`, { id: `old${i}`, machineId: 'm1', name: `Phiên đã dừng ${i}`, status: 'stopped', cwd: 'C:\\Orbit', lastActivity: `2026-10-2${i}T10:00:00Z` });
}

test('danh sách phiên của máy: có mọi phiên cũ trên máy (kể cả phiên VS Code đã đóng), không lặp phiên đã hiện, đủ mọi phiên app đã dừng', async () => {
  const root = new FakeEl('div');
  const unmount = mountMachine(root, 'm1');
  try {
    const dropBtn = root.find('drop-btn');
    const drop = root.find('session-drop');
    dropBtn.dispatch('click');
    assert.match(drop.text(), /Đang đọc các phiên Claude trên máy/, 'đang hỏi máy thì báo đang đọc');
    for (let i = 0; i < 5; i += 1) await tick();
    assert.ok(calls.includes('/api/machines/m1/temps'), 'màn của máy đang bật thì hỏi nhiệt độ máy');
    assert.deepEqual(transcriptCalls(), ['/api/machines/m1/transcripts'], 'mở danh sách là hỏi máy các phiên cũ');

    const labels = drop.all('drop-label').map((l) => l.text());
    assert.deepEqual(labels.map((l) => l.replace(/\d+$/, '')), ['Đang chạy', 'Đang mở ngoài app', 'Đã dừng', 'Phiên cũ trên máy']);
    const past = drop.all('past');
    assert.deepEqual(past.map((r) => r.find('drop-name').text()), ['dựng trạm Orbit Remote trên máy này', 'Trả lời đúng một từ', 'setup cho máy này'],
      'đủ ba phiên VS Code đã đóng; phiên app đang chạy và phiên đang mở ở terminal không hiện lại');
    assert.equal(past[0].attrs.href, `#/x/m1/${csid(1)}`, 'chạm là xem hội thoại của phiên đó');
    assert.match(past[0].find('drop-meta').text(), /7\.3 MB/);
    assert.equal(labels[3], 'Phiên cũ trên máy3');
    assert.equal(drop.all('drop-row').filter((r) => /Phiên đã dừng/.test(r.text())).length, 8, 'mọi phiên app đã dừng, không cắt ở 6');

    dropBtn.dispatch('click'); // đóng
    dropBtn.dispatch('click'); // mở lại ngay
    await tick();
    assert.equal(transcriptCalls().length, 1, 'mở lại trong ít giây thì dùng lại danh sách vừa đọc');
  } finally {
    unmount();
  }
});

test('bảng mức dùng Claude: giờ reset theo giờ máy người xem, hôm nay, ngày mai hay thứ trong tuần, và thời gian còn lại', () => {
  const now = new Date(2026, 9, 30, 11, 57); // thứ Sáu 30/10, 11:57
  assert.equal(resetText(new Date(2026, 9, 30, 14, 20).toISOString(), now), 'Reset 14:20 hôm nay · còn 2 giờ 23 phút');
  assert.equal(resetText(new Date(2026, 9, 31, 22, 0).toISOString(), now), 'Reset 22:00 ngày mai · còn 1 ngày 10 giờ');
  assert.equal(resetText(new Date(2026, 10, 2, 8, 5).toISOString(), now), 'Reset 08:05 thứ hai 2/11 · còn 2 ngày 20 giờ');
  assert.equal(resetText(new Date(2026, 9, 30, 12, 4).toISOString(), now), 'Reset 12:04 hôm nay · còn 7 phút');
  assert.equal(resetText('không phải ngày', now), '');
});

test('bảng mức dùng Claude: số token viết gọn theo nghìn, triệu, tỷ, dấu phẩy thập phân', () => {
  assert.equal(tokenText(850), '850');
  assert.equal(tokenText(12345), '12,3 nghìn');
  assert.equal(tokenText(296412345), '296,4 triệu');
  assert.equal(tokenText(1254000000), '1,25 tỷ');
  assert.equal(tokenText(7000000), '7 triệu');
  assert.equal(tokenText(-3), '0');
});

test('xem một phiên cũ: tên đúng, báo phiên đã đóng, có nút thao tác để tiếp tục ở app; máy không trả lời thì báo lỗi trong danh sách', async () => {
  const root = new FakeEl('div');
  const stop = mountExternal(root, 'm1', csid(1));
  try {
    assert.equal(root.find('title').text(), 'dựng trạm Orbit Remote trên máy này');
    assert.match(root.find('readonly-bar').text(), /đã đóng/);
    const more = root.all('icon-btn').find((b) => b.attrs['aria-label'] === 'Thao tác');
    assert.ok(more && !more.classList.contains('hidden'), 'có nút thao tác (Tiếp tục ở app, Tách nhánh)');
  } finally {
    stop();
  }

  fail = true;
  store.machines.set('m2', { id: 'm2', name: 'Máy công ty', online: true, platform: 'win32', screen: null, external: [] });
  const root2 = new FakeEl('div');
  const unmount = mountMachine(root2, 'm2');
  try {
    root2.find('drop-btn').dispatch('click');
    for (let i = 0; i < 5; i += 1) await tick();
    assert.match(root2.find('session-drop').text(), /Không đọc được phiên cũ trên máy: Máy không trả lời/);
  } finally {
    unmount();
    fail = false;
  }
});

test('màn chính: máy vừa cài, chưa mở phiên nào từ app, vẫn thấy phiên đang mở ngoài app và phiên cũ trên máy; không hỏi máy lặp lại, phiên ngoài app đổi thì đọc lại', async () => {
  const { homeTree, HOME_PAST_MAX } = await import('../web/views/tree.js');
  const blockOf = (tree, name) => tree.all('tree-machine-block').find((b) => b.find('machine-label-name').text() === name);
  store.machines.set('m3', { id: 'm3', name: 'Máy bạn', online: true, platform: 'win32', screen: null,
    external: [{ claudeSessionId: csid(4), title: 'Đang mở ở terminal', cwd: 'C:\\Orbit', modified: '2026-10-30T09:59:00Z', active: true, open: true }] });

  let block = blockOf(homeTree(), 'Máy bạn');
  assert.deepEqual(transcriptCalls('m3'), ['/api/machines/m3/transcripts'], 'màn chính tự hỏi máy đang bật các phiên cũ');
  assert.match(block.find('machine-label-count').text(), /1 ngoài app/);
  for (let i = 0; i < 5; i += 1) await tick();

  block = blockOf(homeTree(), 'Máy bạn');
  assert.match(block.find('tree-empty').text(), /Chưa mở phiên nào từ app/, 'không còn báo "chưa có phiên" khi máy đã có phiên');
  const labels = block.all('tree-ext-label').map((l) => l.text().replace(/\d+$/, ''));
  assert.deepEqual(labels, ['Đang mở ngoài app', 'Phiên cũ trên máy']);
  const outside = block.all('ext').filter((r) => !r.classList.contains('past'));
  assert.deepEqual(outside.map((r) => r.find('drop-name').text()), ['Đang mở ở terminal']);
  assert.equal(outside[0].attrs.href, `#/x/m3/${csid(4)}/h`, 'chạm là xem hội thoại, quay lại về màn chính');
  const past = block.all('past');
  assert.deepEqual(past.map((r) => r.find('drop-name').text()), ['Kéo git về rồi restart đi', 'dựng trạm Orbit Remote trên máy này', 'Trả lời đúng một từ', 'setup cho máy này'],
    'mọi phiên cũ trên máy, trừ phiên đang mở ngoài app (đã hiện ở trên)');
  assert.equal(block.find('tree-ext-more'), null, 'ít phiên cũ thì không cần nút xem tất cả');

  homeTree();
  await tick();
  assert.equal(transcriptCalls('m3').length, 1, 'vẽ lại màn chính không hỏi lại máy trong hạn');
  store.machines.get('m3').external = []; // phiên ở terminal vừa đóng: thành phiên cũ
  homeTree();
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(transcriptCalls('m3').length, 2, 'phiên ngoài app đổi thì đọc lại danh sách phiên cũ');
  block = blockOf(homeTree(), 'Máy bạn');
  assert.equal(block.all('past').length, 5, 'phiên vừa đóng hiện ở nhóm phiên cũ');

  store.machines.set('m4', { id: 'm4', name: 'Máy nhiều phiên', online: true, platform: 'win32', screen: null, external: [] });
  homeTree();
  for (let i = 0; i < 5; i += 1) await tick();
  block = blockOf(homeTree(), 'Máy nhiều phiên');
  assert.equal(block.all('past').length, HOME_PAST_MAX, 'chỉ hiện vài phiên cũ mới nhất');
  const more = block.find('tree-ext-more');
  assert.equal(more.attrs.href, '#/m/m4/list');
  assert.match(more.text(), /Xem tất cả 9 phiên cũ/);

  store.machines.set('m5', { id: 'm5', name: 'Máy tắt', online: false, platform: 'win32', screen: null, external: [] });
  homeTree();
  assert.equal(transcriptCalls('m5').length, 0, 'máy đang tắt thì không hỏi');
});

test('nút xem tất cả mở sẵn danh sách Phiên của máy; phiên mở từ màn chính thì nút quay lại về màn chính', async () => {
  const root = new FakeEl('div');
  const unmount = mountMachine(root, 'm4', { openList: true });
  try {
    assert.ok(root.find('session-drop').classList.contains('open'), 'danh sách Phiên mở sẵn');
    for (let i = 0; i < 5; i += 1) await tick();
    assert.equal(root.find('session-drop').all('past').length, 9, 'màn của máy có đủ mọi phiên cũ');
  } finally {
    unmount();
  }
  const root2 = new FakeEl('div');
  const stop = mountExternal(root2, 'm4', MANY[0].claudeSessionId, { fromHome: true });
  try {
    const back = root2.all('icon-btn').find((b) => b.attrs['aria-label'] === 'Quay lại');
    assert.equal(back.attrs.href, '#/');
    assert.equal(root2.find('title').text(), 'Phiên cũ 0', 'dùng chung danh sách phiên cũ đã đọc ở màn chính');
  } finally {
    stop();
  }
});
