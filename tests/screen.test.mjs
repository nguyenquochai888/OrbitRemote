// Kiểm phần xem và điều khiển màn hình: WebSocket tự viết, tách khung FLV và JPEG, và một lần quay
// màn hình thật bằng ffmpeg trên máy chạy phép kiểm (bỏ qua nếu không phải Windows có ffmpeg).
// Phép kiểm chỉ ĐỌC màn hình và vị trí con trỏ, không bao giờ dời chuột hay gõ phím trên máy thật.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORBIT_REMOTE_STATE = mkdtempSync(join(tmpdir(), 'orbit-screen-test-'));

const { acceptWebSocket } = await import('../src/ws.mjs');
const { ScreenServer, ffmpegCommand, FlvSplitter, JpegSplitter } = await import('../src/screen.mjs');

async function waitFor(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Hết giờ chờ: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const opened = (ws) => new Promise((resolve) => {
  ws.onopen = () => resolve('mở');
  ws.onerror = () => resolve('bị chặn');
});

test('tách khung FLV và JPEG đúng ranh giới dù dữ liệu tới từng mẩu', () => {
  // Luồng FLV dựng tay: đầu tệp, thẻ siêu dữ liệu, cấu hình avcC, khung gốc, khung phụ, mốc thời gian quá 24 bit.
  const tag = (type, ts, data) => {
    const head = Buffer.alloc(11);
    head[0] = type;
    head.writeUIntBE(data.length, 1, 3);
    head.writeUIntBE(ts & 0xffffff, 4, 3);
    head[7] = (ts >>> 24) & 0xff;
    const prev = Buffer.alloc(4);
    prev.writeUInt32BE(11 + data.length);
    return Buffer.concat([head, data, prev]);
  };
  const avcC = Buffer.from([1, 0x4d, 0x40, 0x28, 0xff, 0xe1]);
  const video = (first, kind, body) => Buffer.concat([Buffer.from([first, kind, 0, 0, 0]), body]);
  const flv = Buffer.concat([
    Buffer.from([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]),
    tag(18, 0, Buffer.from('onMetaData')),
    tag(9, 0, video(0x17, 0, avcC)),
    tag(9, 0, video(0x17, 1, Buffer.alloc(3000, 7))),
    tag(9, 17, video(0x27, 1, Buffer.alloc(40, 9))),
    tag(9, 0x1000005, video(0x27, 1, Buffer.alloc(10, 1))),
  ]);
  const tags = [];
  const flvSplit = new FlvSplitter((t) => tags.push(t));
  for (let i = 0; i < flv.length; i += 7) flvSplit.push(flv.subarray(i, i + 7));
  assert.deepEqual(tags.map((t) => [t.kind, t.key ?? null, t.ts, t.data.length]),
    [['config', null, 0, 6], ['frame', true, 0, 3000], ['frame', false, 17, 40], ['frame', false, 0x1000005, 10]]);
  assert.deepEqual([...tags[0].data], [...avcC], 'cấu hình avcC nguyên vẹn');

  // Hai ảnh JPEG liền nhau, có rác phía trước và byte FF được chèn 00 bên trong.
  const jpegA = Buffer.from([0xff, 0xd8, 1, 0xff, 0x00, 2, 0xff, 0xd9]);
  const jpegB = Buffer.from([0xff, 0xd8, 3, 4, 5, 0xff, 0xd9]);
  const images = [];
  const jpegSplit = new JpegSplitter((img) => images.push(Buffer.from(img)));
  const stream = Buffer.concat([Buffer.from([9, 9]), jpegA, jpegB]);
  for (let i = 0; i < stream.length; i += 3) jpegSplit.push(stream.subarray(i, i + 3));
  assert.deepEqual(images, [jpegA, jpegB]);
});

test('WebSocket tự viết: chữ hai chiều, khung nhị phân có phần đầu riêng, khung dài hơn 65535 byte, đóng', async () => {
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head);
    ws.on('text', (text) => {
      const m = JSON.parse(text);
      if (m.t === 'echo') ws.sendJson({ t: 'echo', s: m.s });
      if (m.t === 'bin') ws.sendBinary(Buffer.alloc(m.n, 5), Buffer.from([1, 2, 3]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
    ws.binaryType = 'arraybuffer';
    const got = [];
    ws.onmessage = (e) => got.push(typeof e.data === 'string' ? JSON.parse(e.data) : new Uint8Array(e.data));
    assert.equal(await opened(ws), 'mở');
    const long = 'tiếng Việt có dấu '.repeat(5000);
    ws.send(JSON.stringify({ t: 'echo', s: long }));
    ws.send(JSON.stringify({ t: 'bin', n: 70000 }));
    await waitFor(() => got.length === 2, 'hai trả lời');
    assert.equal(got[0].s, long, 'chữ dài đi về nguyên vẹn');
    assert.equal(got[1].length, 70003, 'khung nhị phân dài (mã độ dài 64 bit) kèm phần đầu');
    assert.deepEqual([...got[1].subarray(0, 4)], [1, 2, 3, 5]);
    const closed = new Promise((r) => { ws.onclose = r; });
    ws.close();
    await closed;
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('đổi chiều nguồn theo điện thoại: màn xoay 90° rồi về đúng hướng gốc, cửa sổ đổi cỡ vừa vùng làm việc rồi về chỗ cũ, trả lại khi thôi xem và cả khi đầu máy tắt giữa chừng', async () => {
  // Bản giả của chương trình điều khiển: phép kiểm không bao giờ xoay màn hình hay đổi cỡ cửa sổ thật.
  const { Orienter, cleanOrient, turnedOrientation } = await import('../src/orient.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'orbit-orient-test-'));
  const file = join(dir, 'orient.json');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const calls = [];
  let mode = { orient: 0, width: 1920, height: 1080 };
  const windows = new Map([['77', { hwnd: '77', exe: 'Code.exe', x: 0, y: 0, width: 1920, height: 1032, min: false }]]);
  const input = {
    displayMode: async () => ({ ...mode }),
    setDisplayOrientation: async (name, o) => {
      calls.push(`xoay ${o}`);
      mode = (o & 1) !== (mode.orient & 1) ? { orient: o, width: mode.height, height: mode.width } : { ...mode, orient: o };
      return 0;
    },
    placement: async () => ({ show: 3, l: 0, t: 0, r: 1200, b: 800 }), // 3: đang phóng to
    setPlacement: (hwnd, p) => calls.push(`trả ${hwnd} ${p.show}`),
    setWindowBounds: (hwnd, r) => calls.push(`cỡ ${hwnd} ${r.x},${r.y},${r.width}x${r.height}`),
    window: async (hwnd) => windows.get(String(hwnd)) || null,
  };
  const o = new Orienter(input, { file, restoreDelayMs: 30, settleMs: 0 });
  const screen = { name: '\\\\.\\DISPLAY1', width: 1920, height: 1080 };
  const key = 'screen:\\\\.\\DISPLAY1';

  assert.equal(await o.screen(screen, 'landscape'), false, 'đã đúng chiều: không đụng');
  assert.equal(await o.screen(screen, 'portrait'), true);
  assert.deepEqual(calls, ['xoay 1']);
  assert.ok(existsSync(file), 'hướng gốc ghi xuống đĩa');
  assert.equal(await o.screen({ ...screen, width: 1080, height: 1920 }, 'landscape'), true);
  assert.equal(calls.at(-1), 'xoay 0', 'xem ngang lại: về đúng hướng gốc, không lật ngược');
  assert.equal(existsSync(file), false, 'đã về gốc thì không còn gì phải nhớ');
  assert.deepEqual([0, 1, 2, 3].map(turnedOrientation), [1, 0, 3, 2], 'màn đang dọc (hướng 1) về ngang là hướng gốc 0');

  await o.screen(screen, 'portrait');
  o.release(key);
  o.keep(key);
  await sleep(80);
  assert.equal(mode.orient, 1, 'xem lại trong lúc chờ: giữ nguyên chiều dọc');
  o.release(key);
  await sleep(80);
  assert.equal(mode.orient, 0, 'thôi xem: về hướng gốc sau lúc chờ');

  // Cửa sổ đang phóng to trên màn ngang 1920×1032 (vùng làm việc), xem dọc trên iPhone 390×844.
  calls.length = 0;
  const home = { index: 0, work: { x: 0, y: 0, width: 1920, height: 1032 } };
  const view = cleanOrient({ want: 'portrait', aspect: 390 / 844 });
  assert.equal(await o.window(windows.get('77'), home, view), true);
  assert.deepEqual(calls, ['cỡ 77 722,0,477x1032'], 'cao hết vùng làm việc, rộng theo tỉ lệ điện thoại, giữa quanh tâm cũ');
  windows.set('77', { ...windows.get('77'), x: 722, width: 477 });
  assert.equal(await o.window(windows.get('77'), home, view), false, 'đã dọc: không đổi nữa');
  assert.equal(await o.window(windows.get('77'), home, cleanOrient({ want: 'landscape', aspect: 844 / 390 })), true);
  assert.equal(calls.at(-1), 'trả 77 3', 'xem ngang lại: trả đúng vị trí cũ, kể cả trạng thái phóng to');

  // Đầu máy tắt giữa chừng: lần dựng sau trả lại ngay. Ghi từ trước lần khởi động máy thì bỏ.
  windows.set('77', { ...windows.get('77'), x: 0, width: 1920 });
  await o.window(windows.get('77'), home, view);
  calls.length = 0;
  assert.equal(await new Orienter(input, { file, settleMs: 0 }).restoreLeftovers(), 1);
  assert.deepEqual(calls, ['trả 77 3']);
  assert.equal(existsSync(file), false);
  writeFileSync(file, JSON.stringify({ at: 0, list: [{ kind: 'screen', name: screen.name, orient: 2, width: 1920, height: 1080 }] }));
  assert.equal(await new Orienter(input, { file, settleMs: 0 }).restoreLeftovers(), 0, 'ghi từ trước khi máy khởi động: Windows đã tự về như cũ');

  assert.equal(cleanOrient({ want: 'nghiêng' }), null);
  assert.equal(cleanOrient(null), null, 'tắt tính năng');
  assert.equal(cleanOrient({ want: 'portrait', aspect: 2 }).aspect, 0.5, 'tỉ lệ ngược chiều thì lật lại');
  assert.equal(cleanOrient({ want: 'landscape', aspect: 99 }).aspect, 3.5, 'tỉ lệ lạ bị chặn');
});

test('hai màn (A dọc, B ngang bên phải): trả A về ngang thì con trỏ vẫn ở đúng chỗ trên B; đổi nguồn thì trả màn cũ ngay rồi đo lại nguồn mới; người xem khác đo lại nguồn của mình', async () => {
  // Bản giả của chương trình điều khiển: không xoay màn hay dời chuột thật.
  const { Orienter } = await import('../src/orient.mjs');
  const { Viewer } = await import('../src/screen.mjs');
  const A = '\\\\.\\DISPLAY1';
  const B = '\\\\.\\DISPLAY2';
  let a = { orient: 1, width: 1080, height: 1920 }; // A đang bị xoay dọc theo điện thoại
  const screensNow = () => [
    { index: 0, name: A, x: 0, y: 0, width: a.width, height: a.height },
    { index: 1, name: B, x: a.width, y: 0, width: 1920, height: 1080 }, // B nằm sát bên phải A
  ];
  let cursor = { x: 1080 + 600, y: 300 }; // con trỏ đang ở B
  const moves = [];
  const input = {
    displayMode: async (name) => (name === A ? { ...a } : { orient: 0, width: 1920, height: 1080 }),
    setDisplayOrientation: async (name, o) => {
      if (name === A) a = o & 1 ? { orient: o, width: 1080, height: 1920 } : { orient: o, width: 1920, height: 1080 };
      return 0;
    },
    cursor: async () => ({ ...cursor }),
    screens: async () => screensNow(),
    moveTo: (x, y) => { moves.push([x, y]); cursor = { x, y }; },
  };
  const changes = [];
  const o = new Orienter(input, { file: join(mkdtempSync(join(tmpdir(), 'orbit-orient2-')), 'o.json'), settleMs: 0, onDisplayChange: (origin) => changes.push(origin) });
  o.remember(`screen:${A}`, { kind: 'screen', name: A, orient: 0, width: 1920, height: 1080 });
  await o.restore(`screen:${A}`, 'người xem 1');
  assert.equal(a.width, 1920, 'A về ngang, B bị đẩy sang x = 1920');
  assert.deepEqual(moves, [[1920 + 600, 300]], 'con trỏ vẫn ở B, đúng chỗ cũ trên B, không rơi sang A');
  assert.deepEqual(changes, ['người xem 1'], 'báo màn vừa đổi hướng, kèm người xem đã gây ra');

  // Đổi nguồn từ màn A (đã xoay) sang màn B: trả A ngay, không chờ 8 giây, rồi đo lại B.
  const restored = [];
  const v = Object.create(Viewer.prototype);
  Object.assign(v, {
    active: true, orient: null, orientKey: `screen:${A}`, ws: { sendJson() {}, closed: false },
    server: { orienter: { saved: new Map([[`screen:${A}`, {}]]), restore: async (k, origin) => restored.push([k, origin === v]) } },
  });
  v.refreshSource = async (s) => ({ ...s, x: 1920 });
  const next = await v.orientSource({ kind: 'screen', name: B, index: 1, x: 1080, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(restored, [[`screen:${A}`, true]], 'trả màn cũ ngay lúc đổi nguồn');
  assert.equal(next.x, 1920, 'nguồn mới đo lại sau khi màn cũ đổi hướng');
  assert.equal(v.orientKey, `screen:${B}`);

  // Người xem khác đang xem B: màn A đổi hướng thì đo lại B và quay lại cho khớp vùng mới.
  const w = Object.create(Viewer.prototype);
  let launches = 0;
  Object.assign(w, { active: true, ws: { sendJson() {}, closed: false }, queue: Promise.resolve(), screen: { kind: 'screen', name: B, x: 1080, y: 0, width: 1920, height: 1080 } });
  w.refreshSource = async (s) => ({ ...s, x: 1920 });
  w.stopCapture = () => {};
  w.launch = () => { launches += 1; };
  await w.refreshAfterDisplayChange();
  assert.deepEqual([launches, w.screen.x], [1, 1920]);
  await w.refreshAfterDisplayChange();
  assert.equal(launches, 1, 'vùng không đổi thì không quay lại');
});

test('máy đang khoá (màn đăng nhập) hay hiện bảng UAC: báo app một lần rồi chờ, mở khoá xong tự phát lại; người xem dừng giữa lúc chờ thì thôi chờ', async () => {
  const { Viewer } = await import('../src/screen.mjs');
  const sent = [];
  const make = (states) => {
    const v = Object.create(Viewer.prototype);
    const queue = [...states];
    let launches = 0;
    Object.assign(v, {
      active: true, capture: null, lockTimer: null, lockWatch: null, restarts: 4, lockPollMs: 10, secureCheck: async () => false,
      ws: { closed: false, sendJson: (m) => sent.push(m) },
      server: { input: { desktopState: async () => queue.shift() ?? 'unlocked' } },
    });
    v.launch = () => { launches += 1; };
    return { v, launches: () => launches };
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const a = make(['locked', 'locked', 'unlocked']);
  a.v.waitUnlock('locked');
  assert.deepEqual(sent, [{ t: 'locked', state: 'locked' }], 'báo app đúng một lần');
  await wait(120);
  assert.equal(a.launches(), 1, 'mở khoá xong thì phát lại đúng một lần');
  assert.equal(a.v.restarts, 0, 'số lần thử lại về 0: khoá không tính là hỏng');
  assert.deepEqual(sent, [{ t: 'locked', state: 'locked' }], 'không báo lặp mỗi lần hỏi lại');

  sent.length = 0;
  const b = make(['secure', 'secure', 'secure', 'secure']);
  b.v.waitUnlock('secure');
  assert.equal(sent[0].state, 'secure', 'bảng UAC báo riêng');
  await wait(15);
  b.v.stopCapture(); // người xem dừng hay chọn nguồn khác giữa lúc chờ
  await wait(80);
  assert.equal(b.launches(), 0, 'đã dừng thì không tự phát lại');
  assert.equal(b.v.lockTimer, null);

  const c = make([]);
  c.v.server.input = {}; // chương trình điều khiển chưa có lệnh này (bản cũ, hay máy không phải Windows)
  assert.equal(await c.v.desktopState(), 'unlocked', 'hỏi không được thì coi như không khoá');
});

test('mạng dài mà không chậm (4G: báo nhận sau 300 ms) không bị coi là nghẽn; đường tắc thật thì bỏ khung, thông lại thì quay lại ngay lấy khung gốc mà không che hình', async () => {
  const { Viewer, QUALITY } = await import('../src/screen.mjs');
  let now = 0;
  const sent = [];
  const v = Object.create(Viewer.prototype);
  const launched = [];
  Object.assign(v, {
    active: true, options: { quality: 'fast', codec: 'h264' }, seq: 0, acked: 0, inflight: [], inflightBytes: 0, waitKey: false, waitSince: 0,
    hardWindow: Math.max(256 * 1024, (QUALITY.fast.maxrate / 8) * 1.5),
    ws: { sendBinary: (_d, head) => sent.push(head.readUInt32BE(1)), sendJson() {}, buffered: 0, closed: false },
  });
  v.clock = () => now;
  v.stopCapture = () => {};
  v.launch = function () { launched.push(Boolean(this.quietRestart)); this.quietRestart = false; this.inflight = []; this.inflightBytes = 0; this.waitKey = false; };
  const acks = [];
  let ackDelay = 300;
  // 30 khung/giây, 8 KB mỗi khung (chừng 2 Mb/s), khung gốc mỗi 60 khung. Mỗi khung được báo nhận sau ackDelay.
  const run = (fromMs, toMs) => {
    for (now = fromMs; now < toMs; now += 33) {
      while (acks.length && acks[0][0] <= now) v.onAck(acks.shift()[1], now);
      const before = sent.length;
      v.onFrame({ key: Math.round(now / 33) % 60 === 0, ts: now, data: Buffer.alloc(8000) });
      if (sent.length > before) acks.push([now + ackDelay, sent.at(-1)]);
    }
  };
  run(0, 10000);
  assert.equal(v.waitKey, false, 'đường chỉ dài: không bỏ khung');
  assert.ok(sent.length >= 300, `gửi đủ mọi khung trong 10 giây (${sent.length})`);
  assert.ok(Math.abs(v.baseRtt - 300) <= 33, `đo đúng độ dài đường (${v.baseRtt} ms)`);

  // Đường tắc 2 giây (không tin báo nhận nào về), rồi thông lại.
  ackDelay = 2000;
  run(10000, 11000);
  assert.equal(v.waitKey, true, 'tắc thật: bỏ khung, chờ khung gốc');
  const frozenAt = sent.length;
  ackDelay = 300;
  run(11000, 14000);
  assert.deepEqual(launched, [true], 'đường thông lại: quay lại ngay lấy khung gốc, lặng lẽ (không che hình)');
  assert.ok(sent.length > frozenAt, 'hình chạy lại');
});

test('nén cho mạng chậm: nguồn dọc không nặng hơn nguồn ngang cùng mức, nén theo chất lượng có trần, nghẽn liên tục thì tự hạ một mức', async () => {
  const { QUALITY, outputSizeFor, encoderArgs, Viewer } = await import('../src/screen.mjs');
  // Ngân sách điểm ảnh: màn xoay dọc 1080×1920 trước đây không bị thu nhỏ (chỉ giới hạn bề rộng).
  assert.deepEqual(outputSizeFor(1920, 1080, QUALITY.fast), { width: 1280, height: 720 });
  assert.deepEqual(outputSizeFor(1080, 1920, QUALITY.fast), { width: 720, height: 1280 });
  assert.deepEqual(outputSizeFor(800, 600, QUALITY.fast), { width: 800, height: 600 }, 'nhỏ hơn ngân sách thì giữ nguyên');
  const fast = outputSizeFor(1080, 1920, QUALITY.fast);
  assert.ok(fast.width * fast.height <= QUALITY.fast.pixels);

  const x264 = encoderArgs({ ...QUALITY.saver }, 'h264', 'libx264');
  const at = (k) => x264[x264.indexOf(k) + 1];
  assert.equal(at('-c:v'), 'libx264');
  assert.equal(at('-crf'), String(QUALITY.saver.crf), 'nén theo chất lượng, không theo bitrate cố định');
  assert.equal(at('-maxrate'), String(QUALITY.saver.maxrate));
  assert.equal(at('-g'), String(QUALITY.saver.fps * 2), 'khung gốc mỗi 2 giây');
  assert.ok(!x264.includes('-b:v'), 'không đặt bitrate cố định (bộ nén sẽ cố lấp cho đủ)');
  assert.equal(encoderArgs({ ...QUALITY.fast }, 'h264', 'h264_mf')[1], 'h264_mf', 'không có libx264 thì dùng phần cứng');
  assert.ok(QUALITY.saver.maxrate <= 1.5e6 && QUALITY.fast.fps <= 30, 'mức thấp đủ nhẹ cho 4G');

  // Tự hạ mức: ba lần nghẽn trong 10 giây ở mức Nhanh thì chuyển Tiết kiệm và báo điện thoại.
  const sent = [];
  const v = Object.create(Viewer.prototype);
  Object.assign(v, { ws: { sendJson: (m) => sent.push(m), closed: false }, options: { quality: 'fast', codec: 'h264' }, active: true });
  let launches = 0;
  v.stopCapture = () => {};
  v.launch = () => { launches += 1; };
  v.onCongestion(1000);
  v.onCongestion(4000);
  assert.equal(launches, 0, 'hai lần nghẽn chưa đủ');
  v.onCongestion(20000); // lần đầu đã quá 10 giây: không tính
  assert.equal(launches, 0);
  v.onCongestion(21000);
  v.onCongestion(22000);
  assert.equal(launches, 1);
  assert.equal(v.options.quality, 'saver');
  assert.deepEqual(sent, [{ t: 'quality', id: 'saver', auto: true }]);
  for (let i = 0; i < 6; i += 1) v.onCongestion(30000 + i);
  assert.equal(launches, 1, 'đã ở mức thấp nhất thì thôi');

  // Vừa chọn nguồn: con trỏ vào giữa nguồn đó (màn dọc đặt bên phải màn ngang). Bộ ghi giả, không dời chuột thật.
  const moves = [];
  v.server = { input: { moveTo: (x, y) => moves.push([x, y]) } };
  v.screen = { kind: 'screen', x: 1920, y: -420, width: 1080, height: 1920 };
  v.centerCursor();
  assert.deepEqual(moves, [[2460, 540]]);
});

test('màn hình thật: vé dùng một lần, khung H.264 và ảnh JPEG đầu tiên tới trong vài giây', {
  skip: process.platform !== 'win32' || !ffmpegCommand() ? 'cần Windows có ffmpeg' : false,
}, async () => {
  const srv = new ScreenServer({ port: 0 });
  try {
    const ticket = await srv.ticket();
    assert.ok(ticket.screens.length >= 1, 'liệt kê được ít nhất một màn hình');
    const url = `ws://127.0.0.1:${ticket.port}/screen?t=${ticket.ticket}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const texts = [];
    const frames = [];
    ws.onmessage = (e) => (typeof e.data === 'string' ? texts.push(JSON.parse(e.data)) : frames.push(new Uint8Array(e.data)));
    assert.equal(await opened(ws), 'mở');
    await waitFor(() => texts.find((m) => m.t === 'screens'), 'danh sách màn hình');

    ws.send(JSON.stringify({ t: 'start', screen: ticket.screens[0].index, quality: 'saver', codec: 'h264' }));
    const started = await waitFor(() => texts.find((m) => m.t === 'started'), 'bắt đầu quay', 8000);
    assert.ok(started.width <= 960, 'chất lượng tiết kiệm thu nhỏ còn tối đa 960 px');
    await waitFor(() => frames.some((f) => f[0] === 1) && frames.some((f) => f[0] === 2), 'khung cấu hình và khung gốc', 12000);
    assert.equal(frames.find((f) => f[0] === 1)[9], 1, 'cấu hình là avcC phiên bản 1');
    const last = frames.at(-1);
    ws.send(JSON.stringify({ t: 'ack', seq: new DataView(last.buffer, last.byteOffset).getUint32(1) }));

    frames.length = 0;
    ws.send(JSON.stringify({ t: 'start', screen: ticket.screens[0].index, quality: 'saver', codec: 'jpeg' }));
    await waitFor(() => frames.some((f) => f[0] === 4), 'ảnh JPEG', 12000);
    const jpeg = frames.find((f) => f[0] === 4);
    assert.deepEqual([jpeg[9], jpeg[10]], [0xff, 0xd8], 'ảnh mở bằng FFD8');

    ws.send(JSON.stringify({ t: 'stop' }));
    await waitFor(() => texts.some((m) => m.t === 'stopped'), 'dừng');
    ws.close();

    assert.equal(await opened(new WebSocket(url)), 'bị chặn', 'vé chỉ dùng một lần');
    assert.equal(await opened(new WebSocket(`ws://127.0.0.1:${ticket.port}/screen?t=sai`)), 'bị chặn', 'vé sai bị chặn');

    // Chỉ đọc vị trí con trỏ: phép kiểm không bao giờ dời chuột của người đang dùng máy.
    const pos = await srv.input.cursor();
    assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y));
  } finally {
    srv.stop();
  }
});
