// Kiểm dán từ máy đang xem sang máy kia qua luồng màn hình: phần nhận tệp của đầu máy (src/clip.mjs) trên
// thư mục tạm thật, rồi đầu-cuối qua máy chủ màn hình thật (src/screen.mjs) và WebSocket thật với phần gửi
// của app (web/lib/screen-client.js). Clipboard và phím của máy là bản giả ghi lại lệnh: không đụng clipboard
// hay bàn phím thật (lệnh clipboard của win-input.cs đã chạy thật riêng, xem README).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ClipReceiver, CHUNK_HEADER, CHUNK_TYPE, safeSegment } from '../src/clip.mjs';

const chunk = (id, index, data) => {
  const b = Buffer.alloc(CHUNK_HEADER + data.length);
  b[0] = CHUNK_TYPE;
  b.writeUInt32LE(id, 1);
  b.writeUInt32LE(index, 5);
  Buffer.from(data).copy(b, CHUNK_HEADER);
  return b;
};

test('nhận tệp: thư mục (cả thư mục rỗng), tệp rỗng, tên tiếng Việt, đủ nội dung; clipboard trỏ tới tầng đầu như chỗ đã copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-clip-'));
  const r = new ClipReceiver({ root, now: () => new Date(2026, 9, 31, 4, 5, 6).getTime() });
  r.begin({ id: 7, files: [
    { rel: 'Báo cáo.txt', size: 5 },
    { rel: 'Dự án', dir: true },
    { rel: 'Dự án/Tài liệu', dir: true },
    { rel: 'Dự án/Tài liệu/rỗng.txt', size: 0 },
    { rel: 'Dự án/Thư mục rỗng', dir: true },
    { rel: 'Dự án/a.bin', size: 6 },
  ] });
  r.chunk(chunk(7, 0, 'xin c'));
  r.chunk(chunk(7, 5, 'abc'));
  r.chunk(chunk(7, 5, 'def'));
  const out = r.finish(7);
  assert.equal(basename(out.dir), '20261031-040506-7');
  assert.deepEqual(out.paths, [join(out.dir, 'Báo cáo.txt'), join(out.dir, 'Dự án')]);
  assert.deepEqual(out.names, ['Báo cáo.txt', 'Dự án']);
  assert.equal(out.count, 3);
  assert.equal(out.bytes, 11);
  assert.equal(out.image, null);
  assert.equal(readFileSync(join(out.dir, 'Báo cáo.txt'), 'utf8'), 'xin c');
  assert.equal(readFileSync(join(out.dir, 'Dự án', 'a.bin'), 'utf8'), 'abcdef');
  assert.equal(statSync(join(out.dir, 'Dự án', 'Tài liệu', 'rỗng.txt')).size, 0);
  assert.ok(statSync(join(out.dir, 'Dự án', 'Thư mục rỗng')).isDirectory());
});

test('nhận tệp: một ảnh thì clipboard kèm ảnh; tên cấm của Windows và tên trùng được đổi; đường dẫn không thoát ra ngoài', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-clip-'));
  const r = new ClipReceiver({ root });
  r.begin({ id: 1, files: [{ rel: 'image.png', size: 3 }] });
  r.chunk(chunk(1, 0, 'png'));
  const one = r.finish(1);
  assert.equal(one.image, one.paths[0], 'dán đúng một ảnh: kèm ảnh để dán vào Paint, ô chat');

  // Windows cũ: "con.txt" là thiết bị console, phải đổi tên; Windows 11 dùng được như tên thường thì giữ nguyên.
  const oldWin = new ClipReceiver({ root, reservedNames: false });
  oldWin.begin({ id: 2, files: [{ rel: 'a:b?.txt', size: 0 }, { rel: 'A:B?.txt', size: 0 }, { rel: 'con.txt', size: 0 }, { rel: '../../thoát.txt', size: 0 }] });
  const many = oldWin.finish(2);
  assert.deepEqual(many.names, ['a_b_.txt', 'A_B_ (2).txt', '_con.txt', 'thoát.txt']);
  assert.ok(many.paths.every((p) => p.startsWith(many.dir)), 'mọi tệp nằm trong thư mục của lần dán');
  const win11 = new ClipReceiver({ root, reservedNames: true });
  win11.begin({ id: 3, files: [{ rel: 'con/nul.txt', size: 0 }] });
  assert.deepEqual(win11.finish(3).names, ['con'], 'thư mục tên "con" (chữ "con" tiếng Việt) giữ nguyên trên máy cho phép');
  assert.equal(safeSegment('tên. . '), 'tên');
  assert.equal(safeSegment(''), 'tệp');
});

test('nhận tệp: mẩu lạ, nhiều hơn cỡ đã báo, thiếu dữ liệu đều bị chặn; huỷ thì xoá phần đã nhận; không đủ chỗ trống thì báo trước khi nhận', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-clip-'));
  const r = new ClipReceiver({ root });
  r.begin({ id: 3, files: [{ rel: 'a.txt', size: 4 }] });
  assert.throws(() => r.chunk(chunk(99, 0, 'ab')), /Mẩu tệp lạ/);
  assert.throws(() => r.chunk(chunk(3, 1, 'ab')), /Mẩu tệp lạ/);
  assert.throws(() => r.chunk(chunk(3, 0, 'abcde')), /nhiều hơn cỡ đã báo/);
  r.chunk(chunk(3, 0, 'ab'));
  assert.throws(() => r.finish(3), /Thiếu dữ liệu tệp a\.txt/);
  const dir = r.job.dir;
  r.abort();
  assert.equal(existsSync(dir), false, 'huỷ thì xoá phần đã nhận');

  const tight = new ClipReceiver({ root, free: () => 600 * 1024 ** 2 });
  assert.throws(() => tight.begin({ id: 4, files: [{ rel: 'lớn.bin', size: 200 * 1024 ** 2 }] }), /không đủ chỗ trống/);
  assert.throws(() => r.begin({ id: 5, files: [] }), /Không có tệp nào/);
});

test('nhận tệp: thư mục của lần dán cũ hơn 24 giờ bị dọn khi dán lần sau, lần dán gần đây còn giữ', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-clip-'));
  mkdirSync(join(root, 'cũ'));
  mkdirSync(join(root, 'mới'));
  const old = (Date.now() - 25 * 3600 * 1000) / 1000;
  utimesSync(join(root, 'cũ'), old, old);
  const r = new ClipReceiver({ root });
  r.begin({ id: 6, files: [{ rel: 'x.txt', size: 0 }] });
  const left = readdirSync(root);
  assert.ok(!left.includes('cũ'));
  assert.ok(left.includes('mới'));
});

// ---- Đầu-cuối: app gửi qua WebSocket thật tới máy chủ màn hình thật ------------------------------------

Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });

// Clipboard giả của một máy, đủ lệnh như InputHelper thật: số thứ tự đổi mỗi lần đặt; user() là người dùng
// copy (không phải Orbit đặt).
function fakeClipboard(calls) {
  const c = { seq: 100, content: {} };
  const put = (content) => { c.seq += 1; c.content = content; };
  return {
    state: c,
    user: put,
    clipSeq: async () => c.seq,
    readClipboard: async () => ({ seq: c.seq, ...c.content }),
    saveClipboardImage: async (path) => { (await import('node:fs')).writeFileSync(path, 'png'); },
    setClipboardText: async (s) => { calls.push(['chữ', s]); put({ text: s }); },
    setClipboardFiles: async (paths, image) => { calls.push(['tệp', paths, image]); put({ files: paths }); },
  };
}

async function setup({ free } = {}) {
  const { ScreenServer } = await import('../src/screen.mjs');
  const { ScreenClient } = await import('../web/lib/screen-client.js');
  const root = mkdtempSync(join(tmpdir(), 'orbit-clip-e2e-'));
  const calls = [];
  const srv = new ScreenServer({ port: 0 });
  srv.clipOptions = { root, ...(free ? { free } : {}) };
  srv.input = {
    ...fakeClipboard(calls),
    screens: async () => [{ index: 0, x: 0, y: 0, width: 1920, height: 1080 }],
    key: (vk, down) => calls.push(['phím', vk, down]),
    button() {}, moveTo() {}, moveBy() {}, wheel() {}, text() {}, stop() {},
  };
  await srv.listen();
  srv.tickets.set('ve', Date.now() + 60000);
  const offers = [];
  const client = new ScreenClient({ machineId: 'm', canvas: { getContext: () => ({}) }, onClip: (m) => offers.push(m) });
  await client.open(`ws://127.0.0.1:${srv.port}/screen?t=ve`);
  for (let i = 0; i < 50 && !client.caps.clip; i += 1) await new Promise((r) => setTimeout(r, 10));
  return { srv, client, root, calls, offers, close: () => { client.close(); srv.stop(); } };
}

const until = async (ok, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (ok()) return true;
  return ok();
};

const CTRL_V = [['phím', 17, true], ['phím', 86, true], ['phím', 86, false], ['phím', 17, false]];

test('đầu-cuối: máy báo làm được việc dán; dán chữ là đặt clipboard rồi bấm Ctrl+V; tệp và thư mục (nhiều mẩu) tới đủ, đúng nội dung, rồi mới dán', async () => {
  const { client, root, calls, close } = await setup();
  try {
    assert.equal(client.caps.clip, true, 'máy bản mới báo làm được việc dán');
    await client.clipText('Xin chào\nmáy công ty');
    assert.deepEqual(calls.splice(0), [['chữ', 'Xin chào\nmáy công ty'], ...CTRL_V]);

    const big = randomBytes(3 * 1024 * 1024 + 123); // 13 mẩu 256 KB, mẩu cuối lẻ
    const progress = [];
    const r = await client.clipFiles([
      { rel: 'Dự án', dir: true },
      { rel: 'Dự án/dữ liệu.bin', file: new File([big], 'dữ liệu.bin') },
      { rel: 'Dự án/rỗng', dir: true },
      { rel: 'ghi chú.txt', file: new File(['nội dung'], 'ghi chú.txt') },
    ], { onProgress: (sent, total) => progress.push([sent, total]) });
    assert.equal(r.ok, true);
    assert.equal(r.count, 2);
    assert.deepEqual(r.names, ['Dự án', 'ghi chú.txt']);
    const dir = join(root, readdirSync(root)[0]);
    assert.ok(readFileSync(join(dir, 'Dự án', 'dữ liệu.bin')).equals(big), 'tệp lớn tới đủ và đúng từng byte');
    assert.equal(readFileSync(join(dir, 'ghi chú.txt'), 'utf8'), 'nội dung');
    assert.ok(statSync(join(dir, 'Dự án', 'rỗng')).isDirectory());
    const [[kind, paths, image], ...keys] = calls.splice(0);
    assert.equal(kind, 'tệp');
    assert.deepEqual(paths, [join(dir, 'Dự án'), join(dir, 'ghi chú.txt')], 'clipboard trỏ tới thư mục và tệp ở tầng đầu');
    assert.equal(image, null);
    assert.deepEqual(keys, CTRL_V, 'clipboard đặt xong mới bấm Ctrl+V');
    const total = big.length + Buffer.byteLength('nội dung');
    assert.deepEqual(progress.at(-1), [total, total], 'tiến độ kết thúc ở 100%');
    assert.ok(progress.length > 3, 'có báo tiến độ trong lúc gửi');
  } finally {
    close();
  }
});

test('đầu-cuối: máy không đủ chỗ thì báo ngay, không gửi mẩu nào; huỷ giữa chừng và rớt kết nối thì máy xoá phần đã nhận', async () => {
  let s = await setup({ free: () => 1024 });
  try {
    await assert.rejects(s.client.clipFiles([{ rel: 'a.bin', file: new File([randomBytes(2048)], 'a.bin') }]), /không đủ chỗ trống/);
    assert.deepEqual(s.calls, []);
  } finally {
    s.close();
  }

  s = await setup();
  try {
    const ctrl = new AbortController();
    const file = new File([randomBytes(4 * 1024 * 1024)], 'lớn.bin');
    const sending = s.client.clipFiles([{ rel: 'lớn.bin', file }], {
      signal: ctrl.signal,
      onProgress: (sent) => { if (sent > 600 * 1024) ctrl.abort(); },
    });
    await assert.rejects(sending, /Đã huỷ dán/);
    for (let i = 0; i < 50 && readdirSync(s.root).length; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(readdirSync(s.root), [], 'huỷ thì máy xoá phần đã nhận');
    assert.deepEqual(s.calls, [], 'huỷ thì không đặt clipboard, không dán');

    const again = s.client.clipFiles([{ rel: 'lớn.bin', file }], { onProgress: (sent) => { if (sent > 600 * 1024) s.client.ws.close(); } });
    await assert.rejects(again, /Mất kết nối|đóng/);
    for (let i = 0; i < 100 && readdirSync(s.root).length; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(readdirSync(s.root), [], 'rớt kết nối thì máy xoá phần đã nhận');
  } finally {
    s.close();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('đầu-cuối chiều ngược lại: copy trên máy đang xem (phím tắt hay chuột phải) là app được mời; tệp kéo về đủ, đúng thứ tự; thứ chính Orbit đặt không mời ngược lại; thôi theo dõi thì thôi mời', async () => {
  const s = await setup();
  const src = mkdtempSync(join(tmpdir(), 'orbit-clip-src-'));
  try {
    s.client.clipWatch(true);
    await sleep(700); // lấy mốc: thứ đã có sẵn trong clipboard không được mời
    s.srv.input.user({ text: 'chữ copy trên máy kia' });
    assert.ok(await until(() => s.offers.length === 1), 'có lời mời');
    assert.deepEqual([s.offers[0].kind, s.offers[0].text], ['text', 'chữ copy trên máy kia']);

    await s.client.clipText('từ app sang', false);
    await sleep(1200);
    assert.equal(s.offers.length, 1, 'thứ chính Orbit vừa đặt không thành lời mời ngược lại');

    mkdirSync(join(src, 'Thư mục', 'Tài liệu'), { recursive: true });
    writeFileSync(join(src, 'Thư mục', 'Tài liệu', 'a.txt'), 'aaa');
    const big = randomBytes(1024 * 1024 + 5);
    writeFileSync(join(src, 'b.bin'), big);
    s.srv.input.user({ files: [join(src, 'Thư mục'), join(src, 'b.bin')] });
    assert.ok(await until(() => s.offers.length === 2));
    const offer = s.offers[1];
    assert.equal(offer.kind, 'files');
    assert.deepEqual(offer.items.map((x) => [x.rel, x.dir ? 'thư mục' : x.size]),
      [['Thư mục', 'thư mục'], ['Thư mục/Tài liệu', 'thư mục'], ['Thư mục/Tài liệu/a.txt', 3], ['b.bin', big.length]]);
    assert.equal(offer.total, big.length + 3);
    assert.ok(offer.items.every((x) => !('abs' in x)), 'lời mời không mang đường dẫn thật của máy');
    assert.equal(offer.items[3].mtime, Math.floor(statSync(join(src, 'b.bin')).mtimeMs), 'kèm giờ sửa');

    const got = new Map();
    const r = await s.client.clipPull(offer.seq, { onChunk: async (i, d) => { await sleep(1); got.set(i, Buffer.concat([got.get(i) || Buffer.alloc(0), Buffer.from(d)])); } });
    assert.equal(r.got, big.length + 3);
    assert.equal(got.get(2).toString(), 'aaa');
    assert.ok(got.get(3).equals(big), 'tệp lớn về đủ, đúng từng byte, cất chậm vẫn không mất mẩu');
    await assert.rejects(s.client.clipPull(offer.seq - 1, { onChunk: async () => {} }), /đã đổi/);

    s.client.clipWatch(false);
    s.srv.input.user({ text: 'sau khi thôi xem' });
    await sleep(900);
    assert.equal(s.offers.length, 2, 'thôi theo dõi thì không mời nữa');
  } finally {
    s.close();
  }
});

test('clipboard của máy đang dùng (cổng nội bộ): chặn yêu cầu không từ đúng trang của app; theo dõi, đọc tệp, đặt chữ, nhận tệp giữ giờ sửa rồi đặt clipboard; thứ chính nó đặt không báo lại', async () => {
  const http = await import('node:http');
  const { localClipHandler } = await import('../src/local-clip.mjs');
  const calls = [];
  const input = fakeClipboard(calls);
  const root = mkdtempSync(join(tmpdir(), 'orbit-clip-local-'));
  const server = http.createServer(localClipHandler({ input, receiver: new ClipReceiver({ root }) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: `/local/clip/${path}`,
      headers: { host: `127.0.0.1:${port}`, 'x-orbit-clip': '1', 'sec-fetch-site': 'same-origin', ...headers } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
    });
    r.on('error', reject);
    r.end(body);
  });
  const json = async (method, path, value) => {
    const r = await req(method, path, value === undefined ? {} : { body: JSON.stringify(value), headers: { 'content-type': 'application/json' } });
    return { status: r.status, data: JSON.parse(r.body.toString('utf8')) };
  };
  try {
    assert.equal((await req('GET', 'ping', { headers: { 'x-orbit-clip': '' } })).status, 403, 'thiếu tiêu đề riêng');
    assert.equal((await req('GET', 'ping', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'trang lạ gọi chéo');
    assert.equal((await req('GET', 'ping', { headers: { host: 'la.example:8797' } })).status, 403, 'tên miền lạ trỏ về máy này');
    assert.equal((await json('GET', 'ping')).data.clip, true);

    const base = (await json('GET', 'watch?since=0')).data;
    assert.equal(base.kind, 'none', 'lần đầu chỉ lấy mốc, không mời thứ có sẵn');
    const waiting = json('GET', `watch?since=${base.seq}`);
    await sleep(400);
    input.user({ text: 'copy ở máy này' });
    const offer = (await waiting).data;
    assert.deepEqual([offer.kind, offer.text], ['text', 'copy ở máy này']);

    assert.equal((await json('POST', 'text', { text: 'từ máy kia về' })).status, 200);
    assert.deepEqual(calls.at(-1), ['chữ', 'từ máy kia về']);
    const own = (await json('GET', `watch?since=${offer.seq}`)).data;
    assert.deepEqual([own.kind, own.seq], ['none', input.state.seq], 'thứ chính nó đặt: chỉ báo số mới, không mời');

    const src = mkdtempSync(join(tmpdir(), 'orbit-clip-src-'));
    writeFileSync(join(src, 'x.bin'), '0123456789');
    const w2 = json('GET', `watch?since=${own.seq}`);
    await sleep(400);
    input.user({ files: [join(src, 'x.bin')] });
    const fo = (await w2).data;
    assert.deepEqual(fo.items.map((x) => [x.rel, x.size]), [['x.bin', 10]]);
    assert.equal((await req('GET', `file?seq=${fo.seq}&i=0&at=3&len=4`)).body.toString(), '3456');
    assert.equal((await req('GET', `file?seq=${fo.seq - 1}&i=0&at=0&len=4`)).status, 404, 'lời mời cũ không đọc được');

    await json('POST', 'begin', { id: 9, files: [{ rel: 'về.txt', size: 3, mtime: 1700000000000 }] });
    await req('POST', 'chunk', { body: chunk(9, 0, 'abc'), headers: { 'content-type': 'application/octet-stream' } });
    assert.equal((await json('POST', 'end', { id: 9 })).data.count, 1);
    const [kind, paths] = calls.at(-1);
    assert.equal(kind, 'tệp');
    assert.equal(readFileSync(paths[0], 'utf8'), 'abc');
    assert.equal(Math.round(statSync(paths[0]).mtimeMs), 1700000000000, 'giữ giờ sửa như ở máy gốc');
  } finally {
    server.close();
  }
});
