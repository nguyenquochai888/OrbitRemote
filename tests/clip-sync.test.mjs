// Kiểm bộ điều phối clipboard hai chiều phía app (web/lib/clip-sync.js) với máy kia giả (ScreenClient giả)
// và cổng clipboard của máy đang dùng giả (fetch tới /local/clip/... trả lời như src/local-clip.mjs).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (ok()) return true;
  return ok();
};

// Cổng clipboard của máy đang dùng: ghi lại lệnh; watch trả lần lượt các lời mời đã xếp, hết thì chờ.
let local = null;
function fakeLocal({ available = true } = {}) {
  const l = { available, calls: [], watchQueue: [], files: new Map() };
  l.push = (offer) => { l.watchQueue.push(offer); l.wake?.(); };
  return l;
}
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: async (url, init = {}) => {
    const u = new URL(url, 'http://127.0.0.1');
    const name = u.pathname.replace('/local/clip/', '');
    const ok = (v) => ({ ok: true, status: 200, json: async () => v, arrayBuffer: async () => v });
    if (!local.available) return { ok: false, status: 404, json: async () => ({ error: 'Không có.' }) };
    if (name === 'ping') return ok({ ok: true, clip: true });
    if (name === 'watch') {
      while (!local.watchQueue.length) {
        await new Promise((r) => { local.wake = r; init.signal?.addEventListener('abort', r); });
        if (init.signal?.aborted) throw new Error('đã huỷ');
      }
      return ok(local.watchQueue.shift());
    }
    if (name === 'file') {
      const data = local.files.get(Number(u.searchParams.get('i')));
      const at = Number(u.searchParams.get('at'));
      return ok(data.slice(at, at + Number(u.searchParams.get('len'))).buffer);
    }
    const body = name === 'chunk' ? init.body : JSON.parse(init.body || '{}');
    local.calls.push([name, name === 'chunk' ? new TextDecoder().decode(body.subarray(9)) : body]);
    return ok({ ok: true, count: 1 });
  },
});

// Máy kia giả: ghi lại thứ app gửi sang; clipPull trả mẩu đã đặt sẵn.
function fakeClient() {
  const c = { caps: { clip: true }, sent: [], pullData: new Map() };
  c.clipWatch = (on) => c.sent.push(['theo dõi', on]);
  c.clipText = async (s, paste = true) => { c.sent.push(['chữ', s, paste]); return { ok: true }; };
  c.clipFiles = async (items, { paste = true } = {}) => {
    const read = [];
    for (const x of items) if (!x.dir) read.push(new TextDecoder().decode(x.read ? await x.read(0, x.size) : new Uint8Array(await x.file.arrayBuffer())));
    c.sent.push(['tệp', items.map((x) => x.rel), paste, read]);
    return { ok: true };
  };
  c.clipPull = async (seq, { onChunk, onProgress }) => {
    c.sent.push(['kéo về', seq]);
    let got = 0;
    for (const [i, s] of c.pullData) {
      await onChunk(i, new TextEncoder().encode(s));
      got += s.length;
      onProgress?.(got);
    }
    return { got };
  };
  c.key = (vk, down) => c.sent.push(['phím', `${vk}${down ? '↓' : '↑'}`]);
  c.tapKey = (vk) => { c.key(vk, true); c.key(vk, false); };
  return c;
}

const { createClipSync, resetClipState, AUTO_MAX } = await import('../web/lib/clip-sync.js');
let n = 0;
function setup({ withLocal = true } = {}) {
  resetClipState();
  local = fakeLocal({ available: withLocal });
  const client = fakeClient();
  const shows = [];
  const toasts = [];
  const sync = createClipSync(`m${(n += 1)}`, { live: () => true, client: () => client, machineName: 'Máy công ty', show: (s) => shows.push(s), toast: (t) => toasts.push(t) });
  return { sync, client, shows, toasts };
}
const keys = (c) => c.sent.filter((x) => x[0] === 'phím').map((x) => x[1]);
const CTRL_V = ['17↓', '86↓', '86↑', '17↑'];

beforeEach(() => { Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: async () => { throw new Error('trang không được dùng'); } } } }); });

test('copy chữ trên máy kia: vào clipboard máy này ngay; dán lại bên đó (Ctrl+V với đúng chữ ấy) là dán clipboard bên đó', async () => {
  const { sync, client } = setup();
  await sync.onRemote({ t: 'clip-remote', seq: 5, kind: 'text', text: 'chữ bên kia' });
  assert.deepEqual(local.calls, [['text', { text: 'chữ bên kia' }]]);
  client.sent.length = 0;
  await sync.onPaste({ text: 'chữ bên kia', files: [], entries: [] });
  assert.deepEqual(keys(client), CTRL_V, 'hai bên đã khớp: không đưa ngược lại');
  assert.equal(client.sent.some((x) => x[0] === 'chữ'), false);
});

test('copy tệp trên máy kia: nhỏ thì tự chép về clipboard máy này; lớn thì mời bấm "Chép về máy này"', async () => {
  const { sync, client, shows, toasts } = setup();
  client.pullData = new Map([[1, 'abc']]);
  await sync.onRemote({ seq: 7, kind: 'files', total: 3, items: [{ rel: 'Thư mục', dir: true, size: 0 }, { rel: 'Thư mục/a.txt', size: 3, mtime: 1 }] });
  assert.ok(await until(() => local.calls.some((c) => c[0] === 'end')));
  assert.deepEqual(local.calls.map((c) => c[0]), ['begin', 'chunk', 'end']);
  assert.deepEqual(local.calls[0][1].files, [{ rel: 'Thư mục', size: 0, dir: true, mtime: undefined }, { rel: 'Thư mục/a.txt', size: 3, dir: undefined, mtime: 1 }].map((f) => JSON.parse(JSON.stringify(f))));
  assert.equal(local.calls[1][1], 'abc');
  assert.deepEqual(toasts, [], 'chép tự động thì không báo ồn');

  local.calls.length = 0;
  await sync.onRemote({ seq: 8, kind: 'files', total: AUTO_MAX + 1, items: [{ rel: 'phim.mkv', size: AUTO_MAX + 1, mtime: 2 }] });
  assert.deepEqual(local.calls, [], 'tệp lớn không tự chép');
  const offer = shows.findLast((s) => s?.action);
  assert.match(offer.text, /Vừa copy "phim\.mkv" \(64,0 MB\) trên máy kia/);
  assert.equal(offer.action.label, 'Chép về máy này');
  client.pullData = new Map([[0, 'phim']]);
  offer.action.run();
  assert.ok(await until(() => local.calls.some((c) => c[0] === 'end')));
  assert.ok(await until(() => toasts.some((t) => /Đã chép "phim\.mkv" về máy này: Ctrl\+V/.test(t))));
});

test('copy ở máy này lúc đang xem: chữ và tệp nhỏ đưa sẵn sang máy kia (chuột phải → Paste bên đó dán được), không bấm Ctrl+V; tệp lớn để dành Ctrl+V', async () => {
  const { sync, client } = setup();
  local.files.set(0, new TextEncoder().encode('nội dung'));
  sync.start();
  assert.ok(await until(() => client.sent.some((x) => x[0] === 'theo dõi')));
  local.push({ seq: 2, kind: 'none' });
  local.push({ seq: 3, kind: 'text', text: 'copy ở máy này' });
  assert.ok(await until(() => client.sent.some((x) => x[0] === 'chữ')));
  assert.deepEqual(client.sent.find((x) => x[0] === 'chữ'), ['chữ', 'copy ở máy này', false]);

  local.push({ seq: 4, kind: 'files', total: 10, items: [{ rel: 'ghi chú.txt', size: Buffer.byteLength('nội dung'), mtime: 3 }] });
  assert.ok(await until(() => client.sent.some((x) => x[0] === 'tệp')));
  assert.deepEqual(client.sent.find((x) => x[0] === 'tệp'), ['tệp', ['ghi chú.txt'], false, ['nội dung']]);

  const before = client.sent.length;
  local.push({ seq: 5, kind: 'files', total: AUTO_MAX + 1, items: [{ rel: 'lớn.bin', size: AUTO_MAX + 1, mtime: 4 }] });
  await sleep(100);
  assert.equal(client.sent.length, before, 'tệp lớn: chờ Ctrl+V mới chép');
  sync.stop();
});

test('dán (Ctrl+V): thứ copy ở máy này mới hơn thì đưa sang rồi dán; copy trên máy kia sau đó thì Ctrl+V dán clipboard bên kia; copy mới ở máy này lại đưa sang', async () => {
  const { sync, client } = setup();
  await sync.onPaste({ text: 'A', files: [], entries: [] });
  assert.deepEqual(client.sent, [['chữ', 'A', true]], 'lần đầu, máy kia chưa copy gì: đưa sang và dán');
  client.sent.length = 0;
  sync.remoteCopied(); // Ctrl+C trong khung
  await sleep(5);
  await sync.onPaste({ text: 'A', files: [], entries: [] });
  assert.deepEqual(keys(client), CTRL_V);
  client.sent.length = 0;
  await sleep(5);
  await sync.onPaste({ text: 'B', files: [], entries: [] });
  assert.deepEqual(client.sent, [['chữ', 'B', true]]);
  client.sent.length = 0;
  await sync.onPaste({ text: '', files: [], entries: [], shift: true });
  assert.deepEqual(keys(client), ['17↓', '16↓', '86↓', '86↑', '16↑', '17↑'], 'clipboard trống: Ctrl+Shift+V đi nguyên sang');
});

test('không có đầu máy trên máy này (iPhone, trình duyệt thường): chữ copy bên kia có nút "Copy về máy này"; tệp không tự chép', async () => {
  const { sync, shows } = setup({ withLocal: false });
  let written = null;
  await sync.onRemote({ seq: 9, kind: 'text', text: 'mật khẩu wifi' });
  const offer = shows.findLast((s) => s?.action);
  assert.equal(offer.action.label, 'Copy về máy này');
  globalThis.navigator.clipboard.writeText = async (t) => { written = t; };
  offer.action.run();
  await sleep(10);
  assert.equal(written, 'mật khẩu wifi');
  await sync.onRemote({ seq: 10, kind: 'files', total: 1, items: [{ rel: 'a', size: 1 }] });
  assert.deepEqual(local.calls, []);
});
