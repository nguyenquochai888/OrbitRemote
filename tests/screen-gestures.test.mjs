// Kiểm cử chỉ trên khung màn hình (web/views/screen.js + web/lib/screen-client.js): chạy đúng mã
// của app trên một DOM giả tối thiểu, bấm chuỗi chạm như ngón tay thật, rồi xem đúng các lệnh chuột
// gửi sang máy. Phía máy kiểm bằng bộ ghi lệnh giả: phép kiểm không bao giờ dời chuột thật.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORBIT_REMOTE_STATE = mkdtempSync(join(tmpdir(), 'orbit-gesture-test-'));

// ---- DOM giả: chỉ đủ những gì khung màn hình dùng ------------------------------------------------
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
    this.clientWidth = 390;
    this.clientHeight = 219;
  }
  set className(v) {
    this.classList = new FakeClassList();
    for (const c of String(v).split(/\s+/)) if (c) this.classList.add(c);
  }
  get className() { return [...this.classList.set].join(' '); }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === 'width' || k === 'height') this[k] = Number(v); // như thuộc tính width/height của canvas thật
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(type, e) { for (const fn of this.listeners[type] || []) fn(e); }
  append(...children) {
    for (const c of children) {
      c.parent = this;
      this.children.push(c);
    }
  }
  get firstChild() { return this.children[0] || null; }
  contains(el) { for (let x = el; x; x = x.parent) if (x === this) return true; return false; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  // Hộp bao trên màn hình (sau mọi phép xoay); clientWidth/clientHeight là cỡ riêng của phần tử.
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  getContext() { return { drawImage() {} }; }
  setPointerCapture() {}
  querySelectorAll() { return []; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = null; }
  find(cls) {
    if (this.classList.contains(cls)) return this;
    for (const c of this.children) {
      const hit = c.find?.(cls);
      if (hit) return hit;
    }
    return null;
  }
}

const RealWebSocket = globalThis.WebSocket; // ca kiểm phía máy cần đường nối thật
const toastRoot = new FakeEl('div');
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('Node', FakeNode);
define('window', globalThis);
define('document', {
  createElement: (t) => new FakeEl(t),
  createElementNS: (_ns, t) => new FakeEl(t),
  createTextNode: (s) => Object.assign(new FakeEl('#text'), { textContent: s }),
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => toastRoot,
  body: new FakeEl('body'),
  activeElement: null,
  fullscreenElement: null,
});
const store = new Map();
define('localStorage', { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) });
// Như bản thật: báo một lần ngay khi bắt đầu theo dõi; phép kiểm gọi resizeAll() khi đổi cỡ khung.
const observers = new Set();
const resizeAll = () => { for (const o of observers) o.cb([]); };
define('ResizeObserver', class {
  constructor(cb) { this.cb = cb; }
  observe() { observers.add(this); queueMicrotask(() => this.cb([])); }
  disconnect() { observers.delete(this); }
});
// Truy vấn màn hình: điện thoại (chạm thô), đang cầm dọc; phép kiểm đổi chiều bằng media.landscape.flip().
const fakeQuery = (matches) => ({
  matches,
  listeners: [],
  addEventListener(_t, fn) { this.listeners.push(fn); },
  removeEventListener(_t, fn) { this.listeners = this.listeners.filter((f) => f !== fn); },
  flip(on) { this.matches = on; for (const fn of this.listeners) fn({ matches: on }); },
});
const media = { landscape: fakeQuery(false), coarse: fakeQuery(true) };
define('matchMedia', (q) => (q.includes('orientation: landscape') ? media.landscape : q.includes('pointer: coarse') ? media.coarse : fakeQuery(false)));
define('location', { protocol: 'http:', hostname: '192.168.1.10' });

// Đồng hồ và nhịp màn hình do phép kiểm cầm: chạm nhanh hay chậm là do mình quyết định.
let clock = 1000;
define('performance', { now: () => clock });
let frames = [];
define('requestAnimationFrame', (fn) => frames.push(fn));
const nextFrame = () => {
  const run = frames;
  frames = [];
  for (const fn of run) fn();
};

const SCREEN = { index: 0, x: 0, y: 0, width: 1920, height: 1080 };
define('fetch', async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ticket: 't', port: 1, hosts: ['192.168.1.20'], screens: [SCREEN] }),
}));
const sockets = [];
define('WebSocket', class FakeWebSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  bufferedAmount = 0;
  send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : { t: '#mẩu', bytes: data.length }); }
  close() { this.readyState = 3; }
});

const { mountScreenPanel } = await import('../web/views/screen.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
const textOf = (el) => (el.textContent || '') + el.children.map(textOf).join('');

// Khung nào đã mở thì đóng sau mỗi ca, kể cả ca hỏng giữa chừng, để bộ đếm giờ không giữ tiến trình.
const opened = [];
afterEach(() => { for (const p of opened.splice(0)) p.destroy(); });

// Mở khung, bấm phát, nhận danh sách màn hình: tới lúc này thao tác mới được gửi đi.
async function openPanel(mode) {
  store.set('orbit-screen-mode', mode);
  const container = new FakeEl('div');
  const panel = mountScreenPanel(container, { id: 'm1', online: true });
  opened.push(panel);
  container.find('screen-bigplay').dispatch('click', {});
  for (let i = 0; i < 5; i += 1) await tick();
  const ws = sockets.at(-1);
  assert.equal(ws.readyState, 1, 'đã nối tới máy');
  ws.onmessage({ data: JSON.stringify({ t: 'screens', list: [SCREEN] }) });
  const viewport = container.find('screen-viewport');
  const badge = container.find('screen-hold');
  const ev = (id, x, y) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0, preventDefault() {} });
  const finger = {
    down(x, y, id = 1) { viewport.dispatch('pointerdown', ev(id, x, y)); },
    move(x, y, id = 1) { clock += 16; viewport.dispatch('pointermove', ev(id, x, y)); },
    up(x, y, id = 1) { viewport.dispatch('pointerup', ev(id, x, y)); },
  };
  const input = () => ws.sent.filter((m) => ['move', 'rel', 'btn', 'wheel'].includes(m.t));
  const reset = () => { ws.sent.length = 0; };
  const stage = container.find('screen-stage');
  const button = (label) => [...container.find('screen-toolbar').children, ...container.find('fs-dock').children]
    .find((b) => b.attrs['aria-label'] === label);
  return { panel, ws, finger, input, reset, badge, container, viewport, stage, button };
}

const buttons = (list) => list.filter((m) => m.t === 'btn').map((m) => `${m.b}${m.down ? '↓' : '↑'}`);
const relSum = (list) => list.filter((m) => m.t === 'rel').reduce((s, m) => ({ dx: s.dx + m.dx, dy: s.dy + m.dy }), { dx: 0, dy: 0 });

test('chế độ tay cầm: cần như tay cầm thật (đẩy nhẹ nhích chậm, hết cỡ đúng tốc chuẩn, giữ lâu nhanh dần), dấu con trỏ đi theo tức thì, X giữ và nhả chuột trái, B chuột phải, Y và A cuộn, chạm vào hình không nhấp gì', async () => {
  const { finger, input, reset, container, button, ws } = await openPanel('joy');
  const pad = container.find('joy-pad');
  assert.ok(!pad.classList.contains('hidden'), 'đang phát ở chế độ tay cầm thì hiện cần và bốn nút');
  assert.equal(button('Kéo (giữ chuột trái)'), undefined, 'tay cầm có X để giữ chuột trái, không cần nút Kéo');
  const ev = (x, y, id = 9) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });

  // Cần đặt ở (14, 60), bán kính 64: tâm (78, 124). Đẩy hết sang phải trong 10 nhịp (160 ms).
  const stick = container.find('joy-stick');
  Object.assign(stick, { offsetLeft: 14, offsetTop: 60, offsetWidth: 128 });
  reset();
  stick.dispatch('pointerdown', ev(78 + 90, 124)); // ngón ra ngoài vành: tính như đẩy hết cỡ
  for (let i = 0; i < 10; i += 1) { clock += 16; nextFrame(); }
  stick.dispatch('pointerup', ev(78 + 90, 124));
  nextFrame();
  nextFrame();
  const full = relSum(input());
  // Hết cỡ: tốc chuẩn 0,225 × 1920 = 432 px/giây, 160 ms là chừng 69 px.
  assert.ok(full.dx > 55 && full.dx < 85 && Math.abs(full.dy) < 1, `đẩy hết sang phải: dời phải đúng tốc chuẩn (${full.dx}, ${full.dy})`);
  assert.equal(container.find('joy-knob').style.transform, '', 'nhả ra thì cần bật về tâm');
  // Dấu con trỏ trên điện thoại đi theo ngay (không chờ hình qua mạng): từ giữa nguồn sang phải.
  const ghost = container.find('joy-ghost');
  assert.ok(!ghost.classList.contains('hidden'), 'đẩy cần là hiện dấu con trỏ');
  assert.match(ghost.style.transform, /^translate\(/);

  reset();
  stick.dispatch('pointerdown', ev(78, 124 - 16)); // nhích lên một phần tư bán kính: nhích chậm để chỉnh
  for (let i = 0; i < 10; i += 1) { clock += 16; nextFrame(); }
  stick.dispatch('pointerup', ev(78, 124 - 16));
  nextFrame();
  const slow = relSum(input());
  assert.ok(slow.dy < 0 && -slow.dy < full.dx / 8 && Math.abs(slow.dx) < 1, `đẩy nhẹ lên: dời lên, chậm hẳn (${slow.dy})`);

  // Giữ hết cỡ lâu: sau nửa giây nhanh dần, tới gấp đôi.
  reset();
  stick.dispatch('pointerdown', ev(78 + 90, 124));
  for (let i = 0; i < 100; i += 1) { clock += 16; nextFrame(); } // 1,6 giây
  const early = relSum(input()).dx;
  reset();
  for (let i = 0; i < 10; i += 1) { clock += 16; nextFrame(); }
  stick.dispatch('pointerup', ev(78 + 90, 124));
  nextFrame();
  const late = relSum(input()).dx;
  // late gồm cả một nhịp còn chờ gửi từ trước lúc reset: chừng 11 nhịp ở tốc gấp đôi.
  assert.ok(late > full.dx * 1.8 && late < full.dx * 2.5, `giữ hết cỡ 1,6 giây: nhanh gấp đôi (${late} so với ${full.dx})`);
  assert.ok(early > 0);

  // Thả cần: dấu khớp về chỗ con trỏ thật máy báo.
  ws.onmessage({ data: JSON.stringify({ t: 'cursor', x: 0.25, y: 0.75 }) });
  await new Promise((r) => setTimeout(r, 300));
  clock += 300;
  ws.onmessage({ data: JSON.stringify({ t: 'cursor', x: 0.25, y: 0.75 }) });
  const at = /translate\(([\d.]+)px, ([\d.]+)px\)/.exec(ghost.style.transform);
  const vp = container.find('screen-viewport');
  assert.ok(at && Math.abs(Number(at[1]) - vp.clientWidth * 0.25) < 30, `dấu khớp về chỗ máy báo (${ghost.style.transform})`);
  reset();
  stick.dispatch('pointerdown', ev(78 + 5, 124)); // trong vùng chết giữa cần: không dời
  for (let i = 0; i < 5; i += 1) { clock += 16; nextFrame(); }
  stick.dispatch('pointerup', ev(78 + 5, 124));
  nextFrame();
  assert.deepEqual(input(), [], 'ngón đặt gần tâm cần: chuột không tự trôi');

  const joyBtn = (label) => container.find('joy-buttons').children.find((b) => b.attrs['aria-label'] === label);
  reset();
  joyBtn('Chuột trái').dispatch('pointerdown', ev(0, 0, 3));
  assert.equal(container.find('screen-hold').textContent, 'Đang giữ chuột trái', 'giữ X là giữ chuột trái (kéo được)');
  joyBtn('Chuột trái').dispatch('pointerup', ev(0, 0, 3));
  joyBtn('Chuột phải').dispatch('pointerdown', ev(0, 0, 4));
  joyBtn('Chuột phải').dispatch('pointerup', ev(0, 0, 4));
  assert.deepEqual(buttons(input()), ['0↓', '0↑', '1↓', '1↑']);

  reset();
  joyBtn('Cuộn lên').dispatch('pointerdown', ev(0, 0, 5));
  joyBtn('Cuộn lên').dispatch('pointerup', ev(0, 0, 5));
  joyBtn('Cuộn xuống').dispatch('pointerdown', ev(0, 0, 6));
  await new Promise((r) => setTimeout(r, 560)); // giữ quá 350 ms: cuộn tiếp mỗi 90 ms
  joyBtn('Cuộn xuống').dispatch('pointerup', ev(0, 0, 6));
  const wheels = input().filter((m) => m.t === 'wheel').map((m) => m.dy);
  assert.equal(wheels[0], 120, 'Y cuộn lên một nấc');
  assert.ok(wheels.slice(1).length >= 2 && wheels.slice(1).every((d) => d === -120), `giữ A cuộn xuống liên tục (${wheels})`);
  const after = input().length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(input().length, after, 'nhả A thì thôi cuộn');

  reset();
  finger.down(200, 100);
  finger.up(200, 100);
  assert.deepEqual(input(), [], 'chạm vào hình ở chế độ tay cầm không nhấp gì');

  // Chọn chế độ trong danh sách xổ ở dãy nút dưới khung.
  const pick = (label) => {
    container.find('screen-toolbar').find('mode-btn').dispatch('click', {});
    const rows = [];
    const walk = (el) => { if (el.classList?.contains('pick-option')) rows.push(el); for (const c of el.children || []) walk(c); };
    walk(container.find('mode-menu'));
    assert.deepEqual(rows.map((r) => r.find('pick-label').children[0].textContent), ['Chạm', 'Chuột', 'Tay cầm']);
    rows.find((r) => r.find('pick-label').children[0].textContent === label).dispatch('click', {});
  };
  pick('Chạm');
  assert.ok(container.find('joy-pad').classList.contains('hidden'), 'rời chế độ tay cầm thì ẩn cần và bốn nút');
  assert.equal(container.find('mode-menu'), null, 'chọn xong thì danh sách đóng');
  assert.equal(container.find('screen-toolbar').find('mode-btn').attrs['aria-label'], 'Đang ở chế độ chạm');
  pick('Tay cầm');
  assert.ok(!container.find('joy-pad').classList.contains('hidden'));
});

test('máy đang khoá: thay dòng lỗi của ffmpeg bằng lời báo rõ (màn khoá hay bảng UAC), vẫn đang chờ chứ không hiện nút phát; máy mở khoá và phát lại thì màn che tự tắt', async () => {
  const { container, ws } = await openPanel('touch');
  const text = () => container.find('screen-overlay-text').textContent;
  ws.onmessage({ data: JSON.stringify({ t: 'locked', state: 'locked' }) });
  assert.match(text(), /màn khoá \(màn đăng nhập\)/);
  assert.match(text(), /mở khoá xong hình tự hiện/);
  assert.ok(container.find('screen-bigplay').classList.contains('hidden'), 'vẫn đang phát (chờ), không hiện nút phát');
  assert.ok(container.find('screen-overlay').classList.contains('busy'));
  assert.match(text(), /setup\.cmd/, 'chỉ cách cài phần xem và gõ mật khẩu ở màn khoá');
  ws.onmessage({ data: JSON.stringify({ t: 'locked', state: 'secure' }) });
  assert.match(text(), /UAC/);
  // Máy có phần xem màn khoá: không che hình, hình màn khoá tới ngay sau ("started" dạng JPEG).
  const before = text();
  ws.onmessage({ data: JSON.stringify({ t: 'locked', state: 'locked', live: true }) });
  assert.equal(text(), before, 'xem được màn khoá: không thay màn che bằng lời báo không xem được');
  ws.onmessage({ data: JSON.stringify({ t: 'started', screen: 0, width: 1280, height: 720, codec: 'jpeg', source: { kind: 'screen', index: 0 }, sourceWidth: 1920, sourceHeight: 1080 }) });
  assert.equal(text(), 'Đang chờ khung hình đầu tiên…', 'máy mở khoá và phát lại: màn che chuyển sang chờ khung đầu');
});

test('bản PC: bấm vào hình (phím đi sang máy) rồi bấm một nút có danh sách xổ thì danh sách mở ngay lần bấm đầu: tiêu điểm đổi không dựng lại dãy nút, nút Bàn phím đổi màu tại chỗ', async () => {
  const { viewport, container, ws } = await openPanel('touch');
  ws.onmessage({ data: JSON.stringify({ t: 'started', screen: 0, width: 1280, height: 720, codec: 'jpeg', source: { kind: 'screen', index: 0 }, sourceWidth: 1920, sourceHeight: 1080 }) });
  const toolbar = container.find('screen-toolbar');
  const sink = container.find('kbd-sink');
  const modeBtn = toolbar.find('mode-btn');
  const kbd = toolbar.children.find((b) => b.attrs?.['aria-label'] === 'Bàn phím');
  const mouse = { pointerId: 7, pointerType: 'mouse', clientX: 200, clientY: 100, button: 0, target: viewport, preventDefault() {} };
  viewport.dispatch('pointerdown', mouse);
  viewport.dispatch('pointerup', mouse);
  assert.equal(document.activeElement, sink, 'bấm chuột vào hình: phím đi sang máy');
  assert.ok(kbd.classList.contains('on'), 'nút Bàn phím sáng');
  // Nhấn chuột xuống một nút khác: tiêu điểm rời ô nhập trước cả lúc nhả chuột.
  sink.blur();
  sink.dispatch('blur', {});
  assert.equal(toolbar.find('mode-btn'), modeBtn, 'nút chế độ vẫn là nút cũ: không bị thay giữa lúc nhấn và nhả (cú bấm không mất)');
  assert.ok(!kbd.classList.contains('on'), 'nút Bàn phím tắt sáng ngay tại chỗ');
  modeBtn.dispatch('click', {});
  assert.ok(container.find('mode-menu'), 'danh sách chế độ mở ngay lần bấm đầu');
});
test('chạm đúp phóng to trang của Safari: chặn ở chế độ tay cầm (cần, nút, khung hình), giữ nguyên ở chế độ chạm và chuột, không bao giờ chặn dãy nút nổi', async () => {
  const touchEnd = (stage, onPad) => {
    let blocked = false;
    stage.dispatch('touchend', { target: { closest: () => (onPad ? {} : null) }, preventDefault() { blocked = true; } });
    return blocked;
  };
  const joy = await openPanel('joy');
  assert.ok(joy.stage.classList.contains('joy-mode'));
  assert.equal(touchEnd(joy.stage, true), true, 'tay cầm: chạm vào cần, nút hay khung hình thì chặn chạm đúp');
  assert.equal(touchEnd(joy.stage, false), false, 'tay cầm: dãy nút nổi, danh sách xổ vẫn bấm bình thường');
  for (const mode of ['touch', 'pad']) {
    const p = await openPanel(mode);
    assert.ok(!p.stage.classList.contains('joy-mode'));
    assert.equal(touchEnd(p.stage, true), false, `${mode}: giữ như cũ`);
  }
});

test('chế độ chuột: chạm để nhấp rồi rê ngay đi chỗ khác chỉ dời con trỏ, không bôi đen', async () => {
  const { finger, input, reset, panel } = await openPanel('pad');
  finger.down(100, 100);
  clock += 60;
  finger.up(100, 100);
  assert.deepEqual(buttons(input()), ['0↓', '0↑'], 'chạm là một cú nhấp trái');
  reset();

  clock += 80; // đặt ngón xuống lại ngay sau cú chạm, gần chỗ cũ, rồi rê
  finger.down(104, 102);
  for (let x = 110; x <= 200; x += 6) finger.move(x, 102);
  nextFrame();
  finger.up(200, 102);
  nextFrame();
  assert.deepEqual(buttons(input()), [], 'không có lần nhấn nút nào: rê không được kéo giữ chuột');
  assert.ok(relSum(input()).dx > 0, 'con trỏ có dời sang phải');
});

test('chế độ chuột: quãng rê đầu tiên (dưới ngưỡng chạm) không bị nuốt, ngón chậm vẫn dời đủ', async () => {
  const { finger, input, panel } = await openPanel('pad');
  finger.down(100, 100);
  for (let i = 1; i <= 15; i += 1) finger.move(100 + 2 * i, 100); // 2 px mỗi 16 ms, tổng 30 px
  nextFrame();
  finger.up(130, 100);
  const pxPerCss = SCREEN.width / 390;
  const expected = 30 * pxPerCss * (1 + (2 / 16) / 0.8);
  const { dx, dy } = relSum(input());
  assert.ok(Math.abs(dx - expected) <= 2, `dời ${dx} px, mong ${expected.toFixed(1)} px`);
  assert.equal(dy, 0);
  assert.deepEqual(buttons(input()), [], 'rê chậm cũng không nhấn nút');
});

test('chế độ chuột: mỗi nhịp màn hình gửi nhiều nhất một lệnh dời', async () => {
  const { finger, input, panel } = await openPanel('pad');
  finger.down(100, 100);
  for (let i = 1; i <= 8; i += 1) finger.move(100 + 5 * i, 100);
  nextFrame();
  assert.equal(input().filter((m) => m.t === 'rel').length, 1, 'tám lần rê trong một nhịp gộp thành một lệnh');
  finger.up(140, 100);
});

test('giữ yên rồi nhấc là nhấp phải; khi ngón còn trên màn không có gì được bấm hộ', async () => {
  for (const mode of ['pad', 'touch']) {
    const { finger, input, badge } = await openPanel(mode);
    finger.down(195, 109);
    await new Promise((r) => setTimeout(r, 620)); // để mọi hẹn giờ (nếu còn) kịp chạy
    clock += 620;
    assert.deepEqual(buttons(input()), [], `${mode}: ngón còn đặt trên màn thì chưa nhấn nút nào`);
    assert.equal(badge.classList.contains('hidden'), true, `${mode}: không có nhãn giữ chuột`);
    finger.up(195, 109);
    assert.deepEqual(buttons(input()), ['1↓', '1↑'], `${mode}: nhấc ngón sau khi giữ yên là nhấp phải`);
  }
});

test('đặt ngón, ngập ngừng một lúc rồi mới rê: chỉ dời con trỏ, không nhấp, không giữ nút', async () => {
  for (const mode of ['pad', 'touch']) {
    const { finger, input } = await openPanel(mode);
    finger.down(100, 100);
    clock += 900;
    for (let x = 110; x <= 200; x += 6) finger.move(x, 100);
    nextFrame();
    finger.up(200, 100);
    nextFrame();
    assert.deepEqual(buttons(input()), [], `${mode}: không có lần nhấn nút nào`);
    assert.ok(input().some((m) => m.t === (mode === 'pad' ? 'rel' : 'move')), `${mode}: con trỏ có dời`);
  }
});

test('nút Kéo (chế độ chuột): bật rồi chạm và rê là kéo giữ chuột trái, nhấc ngón thì thả sau lần dời cuối, nút tự tắt', async () => {
  const { finger, input, badge, button } = await openPanel('pad');
  button('Kéo (giữ chuột trái)').dispatch('click', {});
  assert.equal(badge.textContent, 'Chạm rồi rê để kéo');
  assert.equal(button('Tắt kéo')?.classList.contains('on'), true, 'nút sáng khi đang bật');
  assert.deepEqual(buttons(input()), [], 'bật nút chưa nhấn gì');
  finger.down(100, 100);
  assert.deepEqual(buttons(input()), ['0↓'], 'chạm xuống thì nhấn chuột trái');
  assert.equal(badge.textContent, 'Đang giữ chuột trái');
  for (let x = 110; x <= 160; x += 5) finger.move(x, 100);
  finger.up(160, 100); // nhấc ngón trước nhịp màn hình kế tiếp: lần dời đang chờ phải đi trước
  const list = input();
  assert.deepEqual(buttons(list), ['0↓', '0↑']);
  const lastRel = list.map((m) => m.t).lastIndexOf('rel');
  const upAt = list.findIndex((m) => m.t === 'btn' && !m.down);
  assert.ok(lastRel >= 0 && lastRel < upAt, 'nhả nút đi sau lần dời cuối');
  assert.equal(badge.classList.contains('hidden'), true, 'nhãn tắt khi thả');
  assert.ok(button('Kéo (giữ chuột trái)'), 'nút tự tắt sau một cú kéo');
});

test('nút Kéo (chế độ chạm): nhấn tại chỗ chạm, kéo theo ngón, thả tại chỗ nhấc', async () => {
  const { finger, input, button } = await openPanel('touch');
  button('Kéo (giữ chuột trái)').dispatch('click', {});
  finger.down(195, 109);
  for (let x = 200; x <= 290; x += 10) finger.move(x, 109);
  finger.up(290, 109);
  const list = input();
  assert.deepEqual(buttons(list), ['0↓', '0↑']);
  const down = list.findIndex((m) => m.t === 'btn' && m.down);
  assert.ok(list[down - 1].t === 'move' && Math.abs(list[down - 1].x - 0.5) < 0.01, 'nhấn đúng chỗ chạm');
  const up = list.findIndex((m) => m.t === 'btn' && !m.down);
  assert.ok(list[up - 1].t === 'move' && list[up - 1].x > 0.7, 'thả đúng chỗ nhấc ngón');
});

test('chế độ chuột: chạm hai lần là nhấp đúp tại chỗ, con trỏ không xê dịch', async () => {
  const { finger, input, panel } = await openPanel('pad');
  finger.down(100, 100);
  clock += 50;
  finger.up(101, 100);
  clock += 90;
  finger.down(102, 101);
  clock += 50;
  finger.up(102, 101);
  nextFrame();
  assert.deepEqual(buttons(input()), ['0↓', '0↑', '0↓', '0↑']);
  assert.equal(input().filter((m) => m.t === 'rel').length, 0);
});

test('đang kéo mà dừng phát: nút chuột được nhả trước khi dừng', async () => {
  const { finger, ws, button } = await openPanel('touch');
  button('Kéo (giữ chuột trái)').dispatch('click', {});
  finger.down(100, 100);
  for (let x = 110; x <= 150; x += 10) finger.move(x, 100);
  button('Dừng').dispatch('click', {});
  const tail = ws.sent.filter((m) => m.t === 'btn' || m.t === 'stop').map((m) => (m.t === 'stop' ? 'stop' : `${m.b}${m.down ? '↓' : '↑'}`));
  assert.deepEqual(tail, ['0↓', '0↑', 'stop']);
});

test('chế độ chạm: chạm là nhấp tại chỗ chạm, rê là con trỏ theo ngón và không nhấn nút', async () => {
  const { finger, input, reset } = await openPanel('touch');
  finger.down(195, 109);
  clock += 60;
  finger.up(195, 109);
  const tap = input();
  assert.equal(tap[0].t, 'move');
  assert.ok(Math.abs(tap[0].x - 0.5) < 0.01 && Math.abs(tap[0].y - 0.5) < 0.01, 'nhấp đúng chỗ chạm');
  assert.deepEqual(buttons(tap), ['0↓', '0↑']);
  reset();
  finger.down(100, 100);
  for (let x = 110; x <= 200; x += 10) finger.move(x, 100);
  nextFrame();
  finger.up(200, 100);
  nextFrame();
  assert.deepEqual(buttons(input()), [], 'rê không nhấn nút nào');
  assert.ok(input().filter((m) => m.t === 'move').at(-1).x > 0.45, 'con trỏ đi theo ngón');
});

test('chất lượng hình: chạm nút là xổ danh sách ba mức có ghi chú, chọn một mức là đổi luồng ngay', async () => {
  const { ws, container, reset } = await openPanel('touch');
  const bar = container.find('screen-toolbar');
  const wrap = bar.find('quality-wrap');
  wrap.children[0].dispatch('click', {});
  const menu = wrap.find('quality-menu');
  assert.ok(menu, 'danh sách hiện ra');
  const options = menu.children.filter((c) => c.classList.contains('pick-option'));
  assert.equal(options.length, 3);
  assert.ok(options.every((o) => o.find('pick-hint')?.children[0]?.textContent.includes('khung/giây')), 'mỗi mức có ghi chú cỡ hình, số khung');
  reset();
  options.find((o) => o.find('pick-label').children[0].textContent === 'Nét').dispatch('click', {});
  assert.deepEqual(ws.sent.filter((m) => m.t === 'start').map((m) => m.quality), ['sharp'], 'phát lại ở mức mới');
  const label = container.find('screen-toolbar').find('quality-btn').children[0].textContent;
  assert.equal(label, 'Nét', 'nút ghi mức đang dùng');
  assert.equal(container.find('quality-menu'), null, 'chọn xong thì danh sách đóng');
});

// Khung xoay 90° theo chiều kim đồng hồ trên iPhone cầm dọc 390×844: cỡ riêng của khung là 844×390,
// hộp bao trên màn hình vẫn là 390×844. Điểm (x, y) trong khung nằm ở (390 − y, x) trên màn hình.
function layRotated(viewport) {
  viewport.clientWidth = 844;
  viewport.clientHeight = 390;
  viewport.rect = { left: 0, top: 0, width: 390, height: 844 };
  resizeAll();
}
const near = (a, b, eps = 0.005) => Math.abs(a - b) <= eps;

test('xem ngang khi máy khoá xoay: khung xoay, chạm vẫn rơi đúng chỗ trên màn hình máy', async () => {
  const { finger, input, reset, stage, viewport, button } = await openPanel('touch');
  button('Xem ngang').dispatch('click', {});
  assert.ok(stage.classList.contains('fullscreen') && stage.classList.contains('rotated'), 'vào toàn màn hình và xoay khung');
  layRotated(viewport);
  reset();
  finger.down(195, 422); // giữa khung
  clock += 60;
  finger.up(195, 422);
  const mid = input()[0];
  assert.ok(near(mid.x, 0.5) && near(mid.y, 0.5), `giữa khung là giữa màn hình máy: ${mid.x}, ${mid.y}`);
  reset();
  // Hình 16:9 trong khung 844×390 rộng 693,3 px, lề trái 75,3 px. Điểm (10 %, 10 %) của màn hình máy
  // nằm ở (144,7; 39) trong khung, tức (351; 144,7) trên màn hình điện thoại.
  finger.down(351, 144.67);
  clock += 60;
  finger.up(351, 144.67);
  const corner = input()[0];
  assert.ok(near(corner.x, 0.1) && near(corner.y, 0.1), `điểm 10 %: ${corner.x}, ${corner.y}`);
  button('Xem dọc').dispatch('click', {});
  assert.ok(stage.classList.contains('fullscreen') && !stage.classList.contains('rotated'), 'bấm lại thì thôi xoay, vẫn toàn màn hình');
});

test('xem ngang ở chế độ chuột: rê ngón dọc màn điện thoại là dời con trỏ ngang trên máy', async () => {
  const { finger, input, reset, stage, viewport, button } = await openPanel('pad');
  button('Xem ngang').dispatch('click', {});
  layRotated(viewport);
  reset();
  finger.down(200, 300);
  for (let y = 306; y <= 360; y += 6) finger.move(200, y); // ngón đi xuống trên màn điện thoại
  nextFrame();
  finger.up(200, 360);
  const { dx, dy } = relSum(input());
  assert.ok(dx > 100 && Math.abs(dy) <= 1, `con trỏ sang phải (${dx}, ${dy})`);
  button('Thoát toàn màn hình').dispatch('click', {});
  assert.ok(!stage.classList.contains('fullscreen') && !stage.classList.contains('rotated'), 'thoát toàn màn hình thì thôi xoay');
});

test('xem ngang rồi mở bàn phím: thôi xoay để bàn phím và dãy phím nằm đúng chỗ', async () => {
  const { stage, viewport, button } = await openPanel('touch');
  button('Xem ngang').dispatch('click', {});
  layRotated(viewport);
  button('Bàn phím').dispatch('click', {});
  assert.ok(!stage.classList.contains('rotated'));
  globalThis.document.activeElement = null;
});

test('xoay máy thật: đang phát mà xoay ngang thì vào toàn màn hình, xoay dọc lại thì ra', async () => {
  const { stage, button } = await openPanel('touch');
  try {
    media.landscape.flip(true);
    assert.ok(stage.classList.contains('fullscreen'), 'xoay ngang: toàn màn hình');
    assert.equal(button('Xem ngang'), undefined, 'máy đã ngang thật thì không có nút xoay khung');
    media.landscape.flip(false);
    assert.ok(!stage.classList.contains('fullscreen'), 'xoay dọc lại: ra khỏi toàn màn hình');
    button('Toàn màn hình').dispatch('click', {});
    media.landscape.flip(true);
    media.landscape.flip(false);
    assert.ok(stage.classList.contains('fullscreen'), 'tự bấm toàn màn hình thì xoay qua lại vẫn giữ');
  } finally {
    media.landscape.matches = false;
  }
});

// Phóng to bằng hai ngón (mở từ 90 px ra 190 px, khoảng 2,1 lần), rồi nhấc cả hai ngón.
function pinchOut(finger) {
  finger.down(150, 100, 1);
  finger.down(240, 100, 2);
  finger.move(100, 100, 1);
  finger.move(290, 100, 2);
  finger.up(100, 100, 1);
  finger.up(290, 100, 2);
}
const transformOf = (container) => {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(container.find('screen-canvas').style.transform || '');
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
};

test('chế độ chạm, đang phóng to: rê một ngón kéo khung xem theo ngón, tới mép hình thì đứng yên, không dời con trỏ', async () => {
  const { finger, input, reset, container } = await openPanel('touch');
  pinchOut(finger);
  const z = transformOf(container);
  assert.ok(z.z > 1.5, `đã phóng to (${z.z})`);
  reset();
  finger.down(200, 120);
  finger.move(180, 110);
  finger.move(160, 100);
  const moved = transformOf(container);
  assert.ok(Math.abs(moved.x - (z.x - 40)) < 0.01 && Math.abs(moved.y - (z.y - 20)) < 0.01, 'khung đi đúng theo ngón');
  for (let x = 150; x >= -2000; x -= 100) finger.move(x, 100); // kéo quá mép phải của hình
  const edge = transformOf(container);
  finger.move(-2500, 100);
  assert.deepEqual(transformOf(container), edge, 'đã chạm mép thì đứng yên');
  const minX = 389.33 - 389.33 * edge.z; // mép phải của hình chạm mép phải của khung
  assert.ok(Math.abs(edge.x - minX) < 0.5, `dừng đúng ở mép (${edge.x} so với ${minX.toFixed(1)})`);
  finger.up(-2500, 100);
  nextFrame();
  assert.deepEqual(buttons(input()), [], 'kéo khung không nhấp');
  assert.equal(input().filter((m) => m.t === 'move').length, 0, 'kéo khung không dời con trỏ');
});

test('chế độ chuột, đang phóng to: khung trượt êm theo con trỏ thật ra gần mép, tới mép hình thì thôi', async () => {
  const { finger, ws, container } = await openPanel('pad');
  pinchOut(finger);
  nextFrame();
  const start = transformOf(container);
  // Con trỏ ở giữa vùng đang thấy: khung đứng yên.
  const visible = (x) => (x * 389.33 * start.z + start.x + 0.33) / 390;
  ws.onmessage({ data: JSON.stringify({ t: 'cursor', x: (0.5 * 390 - start.x - 0.33) / (389.33 * start.z), y: 0.4 }) });
  for (let i = 0; i < 5; i += 1) nextFrame();
  assert.deepEqual(transformOf(container), start, 'con trỏ còn giữa vùng thấy thì khung không đi');
  // Con trỏ ra sát mép phải vùng đang thấy: khung trượt sang, nhiều nhịp chứ không nhảy một lần.
  const nx = (380 - start.x - 0.33) / (389.33 * start.z);
  ws.onmessage({ data: JSON.stringify({ t: 'cursor', x: nx, y: 0.4 }) });
  nextFrame();
  const step1 = transformOf(container);
  for (let i = 0; i < 60; i += 1) nextFrame();
  const settled = transformOf(container);
  assert.ok(step1.x < start.x && settled.x < step1.x, `khung trượt dần sang phải (${start.x} → ${step1.x} → ${settled.x})`);
  assert.ok(visible(nx) > 0, 'kiểm tính toán');
  const cursorOnScreen = nx * 389.33 * settled.z + settled.x + 0.33;
  assert.ok(cursorOnScreen <= 390 - 0.18 * 390 + 1, `con trỏ đã nằm trong vùng thấy (${cursorOnScreen.toFixed(1)} px)`);
  // Con trỏ ở tận mép phải màn hình máy: khung tới mép hình rồi đứng yên.
  for (let k = 0; k < 4; k += 1) {
    ws.onmessage({ data: JSON.stringify({ t: 'cursor', x: 1, y: 0.4 }) });
    for (let i = 0; i < 60; i += 1) nextFrame();
  }
  const edge = transformOf(container);
  ws.onmessage({ data: JSON.stringify({ t: 'cursor', x: 1, y: 0.4 }) });
  for (let i = 0; i < 30; i += 1) nextFrame();
  assert.deepEqual(transformOf(container), edge, 'tới mép hình thì không đi nữa');
  assert.ok(Math.abs(edge.x - (389.33 - 389.33 * edge.z)) < 0.5, 'đúng mép phải');
});

test('chưa phóng to: vị trí con trỏ máy báo về không làm khung xê dịch', async () => {
  const { ws, container } = await openPanel('pad');
  const before = transformOf(container);
  ws.onmessage({ data: JSON.stringify({ t: 'cursor', x: 1, y: 1 }) });
  for (let i = 0; i < 10; i += 1) nextFrame();
  assert.deepEqual(transformOf(container), before);
});
test('phía máy: người xem rời đi hay dừng giữa cú kéo thì máy tự nhả nút và phím đang giữ', async () => {
  const { ScreenServer } = await import('../src/screen.mjs');
  const calls = [];
  const srv = new ScreenServer({ port: 0 });
  srv.input = {
    screens: async () => [SCREEN],
    button: (b, down) => calls.push(`btn ${b} ${down ? 'xuống' : 'lên'}`),
    key: (vk, down) => calls.push(`key ${vk} ${down ? 'xuống' : 'lên'}`),
    moveTo() {}, moveBy() {}, wheel() {}, text() {}, stop() {},
  };
  await srv.listen();
  const connect = async () => {
    srv.tickets.set('ve', Date.now() + 60000);
    const ws = new RealWebSocket(`ws://127.0.0.1:${srv.port}/screen?t=ve`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    return ws;
  };
  const waitCalls = async (n) => {
    for (let i = 0; i < 100 && calls.length < n; i += 1) await new Promise((r) => setTimeout(r, 20));
  };
  try {
    let ws = await connect();
    ws.send(JSON.stringify({ t: 'btn', b: 0, down: true }));
    ws.send(JSON.stringify({ t: 'key', vk: 17, down: true }));
    await waitCalls(2);
    ws.close();
    await waitCalls(4);
    assert.deepEqual(calls, ['btn 0 xuống', 'key 17 xuống', 'btn 0 lên', 'key 17 lên']);

    calls.length = 0;
    ws = await connect();
    ws.send(JSON.stringify({ t: 'btn', b: 0, down: true }));
    ws.send(JSON.stringify({ t: 'btn', b: 0, down: false }));
    ws.send(JSON.stringify({ t: 'btn', b: 1, down: true }));
    ws.send(JSON.stringify({ t: 'stop' }));
    await waitCalls(4);
    assert.deepEqual(calls, ['btn 0 xuống', 'btn 0 lên', 'btn 1 xuống', 'btn 1 lên'], 'dừng thì nhả nút còn giữ, nút đã nhả không nhả lại');
    ws.close();
  } finally {
    srv.stop();
  }
});

test('phía máy: sau các lần dời tương đối, máy báo vị trí con trỏ thật một lần, chuẩn hoá theo màn đang xem', async () => {
  const { ScreenServer } = await import('../src/screen.mjs');
  const moves = [];
  const srv = new ScreenServer({ port: 0 });
  srv.input = {
    screens: async () => [SCREEN],
    cursor: async () => ({ x: 1919, y: 540 }),
    moveBy: (dx, dy) => moves.push([dx, dy]),
    button() {}, key() {}, moveTo() {}, wheel() {}, text() {}, stop() {},
  };
  await srv.listen();
  srv.tickets.set('ve2', Date.now() + 60000);
  const ws = new RealWebSocket(`ws://127.0.0.1:${srv.port}/screen?t=ve2`);
  const texts = [];
  ws.onmessage = (e) => texts.push(JSON.parse(e.data));
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    for (let i = 0; i < 50 && !srv.viewers.size; i += 1) await new Promise((r) => setTimeout(r, 10));
    [...srv.viewers][0].screen = SCREEN; // như sau lệnh start, mà không phải quay màn hình thật
    for (const dx of [5, 7, 9]) ws.send(JSON.stringify({ t: 'rel', dx, dy: 0 }));
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(moves, [[5, 0], [7, 0], [9, 0]]);
    const reports = texts.filter((m) => m.t === 'cursor');
    assert.equal(reports.length, 1, 'ba lần dời liền nhau chỉ báo một lần');
    assert.equal(reports[0].x, 1);
    assert.ok(Math.abs(reports[0].y - 540 / 1079) < 1e-9);
    ws.close();
  } finally {
    srv.stop();
  }
});

test('nguồn hình: danh sách gồm màn hình, ứng dụng và thư mục đang mở; chọn một cửa sổ là phát riêng cửa sổ đó', async () => {
  const { ws, container, reset } = await openPanel('touch');
  const head = container.find('screen-source');
  head.find('source-btn').dispatch('click', {});
  await tick();
  assert.ok(ws.sent.some((m) => m.t === 'windows'), 'mở danh sách là xin máy danh sách cửa sổ');
  ws.onmessage({ data: JSON.stringify({ t: 'screens', list: [SCREEN] }) }); // máy gửi lại danh sách màn hình: thanh nút dựng lại
  assert.ok(head.find('source-menu'), 'danh sách vẫn mở dù thanh nút vừa dựng lại');
  const loading = head.find('source-menu');
  assert.ok(loading.find('pop-note')?.children[0]?.textContent.includes('Đang lấy'), 'chờ máy trả lời thì báo đang lấy');
  ws.onmessage({ data: JSON.stringify({ t: 'windows', list: [
    { hwnd: '1001', title: 'Visual Studio Code', exe: 'Code.exe', kind: 'app', width: 1600, height: 900, min: false },
    { hwnd: '1002', title: 'Tài liệu', exe: 'explorer.exe', kind: 'folder', width: 900, height: 600, min: true },
  ] }) });
  const menu = head.find('source-menu');
  const sections = [];
  const walk = (el) => { if (el.classList?.contains('pop-section')) sections.push(el.children[0].textContent); for (const c of el.children || []) walk(c); };
  walk(menu);
  assert.deepEqual(sections, ['Màn hình', 'Ứng dụng', 'Thư mục']);
  const optionsOf = (el) => {
    const rows = [];
    const collect = (x) => { if (x.classList?.contains('pick-option')) rows.push(x); for (const c of x.children || []) collect(c); };
    collect(el);
    return rows;
  };
  const [orientRow, ...rows] = optionsOf(menu);
  const labels = rows.map((r) => r.find('pick-label').children[0].textContent);
  assert.deepEqual(labels, ['Màn 1', 'Visual Studio Code', 'Tài liệu']);
  assert.equal(orientRow.find('pick-label').children[0].textContent, 'Xoay theo điện thoại', 'dòng bật/tắt xoay nguồn đứng đầu danh sách');
  assert.ok(orientRow.classList.contains('active'), 'xoay theo điện thoại bật sẵn');
  assert.ok(rows[2].find('pick-hint').children[0].textContent.includes('thu nhỏ'), 'cửa sổ đang thu nhỏ có ghi chú');
  reset();
  rows[1].dispatch('click', {});
  await tick();
  const start = ws.sent.find((m) => m.t === 'start');
  assert.equal(start.window, '1001', 'phát đúng cửa sổ đã chọn');
  assert.equal(start.screen, undefined);
  assert.ok(['portrait', 'landscape'].includes(start.orient?.want), 'lệnh phát kèm chiều đang xem để máy đổi chiều nguồn');
  assert.equal(start.center, true, 'vừa chọn nguồn: xin máy đưa con trỏ vào giữa nguồn');
  assert.ok(start.orient.aspect > 0);
  assert.equal(container.find('source-menu'), null, 'chọn xong thì danh sách đóng');
  assert.equal(container.find('screen-source').find('source-name').children[0].textContent, 'Visual Studio Code', 'nút nguồn ghi tên cửa sổ');

  // Đang phát mà tắt "Xoay theo điện thoại": báo máy ngay (lệnh orient không kèm chiều) để máy trả
  // nguồn về như cũ; bật lại thì báo lại chiều đang xem.
  ws.onmessage({ data: JSON.stringify({ t: 'started', screen: 0, width: 1600, height: 900, codec: 'h264', source: { kind: 'window', hwnd: '1001' } }) });
  container.find('screen-source').find('source-btn').dispatch('click', {});
  await tick();
  reset();
  optionsOf(container.find('source-menu'))[0].dispatch('click', {});
  const off = ws.sent.filter((m) => m.t === 'orient');
  assert.equal(off.length, 1);
  assert.equal(off[0].want, undefined, 'tắt: không kèm chiều');
  assert.ok(!optionsOf(container.find('source-menu'))[0].classList.contains('active'), 'dòng bật/tắt đổi ngay, danh sách vẫn mở');
  optionsOf(container.find('source-menu'))[0].dispatch('click', {});
  assert.equal(ws.sent.filter((m) => m.t === 'orient').at(-1).want, start.orient.want, 'bật lại: báo lại chiều đang xem');
});

test('phía máy: vùng của một cửa sổ được cắt vào trong màn hình, cỡ chẵn; cửa sổ thu nhỏ thì không có vùng', async () => {
  const { windowSource, publicWindow } = await import('../src/screen.mjs');
  const screens = [{ index: 0, x: 0, y: 0, width: 1920, height: 1080 }, { index: 1, x: 1920, y: 0, width: 1280, height: 1024 }];
  const inside = windowSource({ hwnd: 7, title: 'A', exe: 'a.exe', cls: 'X', x: 100, y: 50, width: 801, height: 601, min: false }, screens);
  assert.deepEqual([inside.x, inside.y, inside.width, inside.height, inside.index], [100, 50, 800, 600, 0]);
  const spill = windowSource({ hwnd: 8, title: 'B', exe: 'b.exe', cls: 'X', x: -40, y: -10, width: 500, height: 300, min: false }, screens);
  assert.deepEqual([spill.x, spill.y, spill.width, spill.height], [0, 0, 460, 290]);
  assert.deepEqual([spill.monX, spill.monY], [0, 0], 'vùng tính theo góc màn chứa cửa sổ');
  const straddle = windowSource({ hwnd: 10, title: 'D', exe: 'd.exe', cls: 'X', x: 1500, y: 100, width: 600, height: 400, min: false }, screens);
  assert.deepEqual([straddle.index, straddle.x, straddle.width], [0, 1500, 420], 'cửa sổ vắt qua hai màn: chỉ phần trên màn chứa tâm');
  const second = windowSource({ hwnd: 9, title: 'C', exe: 'c.exe', cls: 'CabinetWClass', x: 2000, y: 100, width: 600, height: 400, min: false }, screens);
  assert.equal(second.index, 1, 'thuộc màn chứa tâm cửa sổ');
  assert.deepEqual([second.monX, second.monY], [1920, 0]);
  assert.equal(second.folder, true);
  assert.equal(windowSource({ hwnd: 1, x: -32000, y: -32000, width: 160, height: 28, min: true }, screens), null);
  assert.equal(windowSource({ hwnd: 2, x: 5000, y: 0, width: 300, height: 300, min: false }, screens), null, 'nằm hẳn ngoài màn hình');
  assert.equal(publicWindow({ hwnd: 123, title: 'T', exe: 'explorer.exe', cls: 'CabinetWClass', width: 1, height: 2, min: 0 }).kind, 'folder');
  assert.equal(publicWindow({ hwnd: 123, title: 'T', exe: 'code.exe', cls: 'Chrome_WidgetWin_1' }).kind, 'app');
});

test('máy tự quay lại (đổi chiều khi xoay máy, cửa sổ đổi cỡ): màn che "đang chờ khung đầu tiên" tắt khi khung mới tới', async () => {
  const { ScreenClient } = await import('../web/lib/screen-client.js');
  const canvas = new FakeEl('canvas');
  canvas.getContext = () => ({ drawImage() {} });
  const states = [];
  const client = new ScreenClient({ machineId: 'm', canvas, onState: (s) => states.push(s) });
  try {
    const started = (w, h) => client.onText(JSON.stringify({ t: 'started', screen: 0, width: w, height: h, codec: 'h264' }));
    started(1080, 1920); // app bấm phát
    client.paint({}, 1080, 1920);
    client.paint({}, 1080, 1920);
    assert.deepEqual(states.filter((s) => s === 'playing' || s === 'frame'), ['playing', 'frame'], 'một lần "frame" cho khung đầu');
    states.length = 0;
    started(1920, 1080); // máy tự quay lại sau khi đổi chiều, app không xin
    client.paint({}, 1920, 1080);
    assert.deepEqual(states.filter((s) => s === 'playing' || s === 'frame'), ['playing', 'frame'], 'khung đầu của luồng mới tắt màn che');
  } finally {
    client.close();
  }
});

test('khung hình bị bộ mã hoá độn thêm hàng: app chỉ vẽ đúng cỡ máy đã báo, nên chạm không lệch', async () => {
  const { ScreenClient } = await import('../web/lib/screen-client.js');
  const calls = [];
  const canvas = new FakeEl('canvas');
  canvas.getContext = () => ({ drawImage: (...a) => calls.push(a) });
  const client = new ScreenClient({ machineId: 'm', canvas });
  try {
    client.current = { width: 1600, height: 874 }; // máy báo lúc bắt đầu phát
    const frame = { displayWidth: 1600, displayHeight: 880 }; // bộ mã hoá độn lên bội số của 16
    client.paint(frame, frame.displayWidth, frame.displayHeight);
    assert.deepEqual([canvas.width, canvas.height], [1600, 874]);
    assert.deepEqual(calls[0].slice(1), [0, 0, 1600, 874, 0, 0, 1600, 874], 'cắt bỏ 6 hàng độn ở đáy');
    client.current = null; // ảnh JPEG cũ không có cỡ báo trước: vẽ nguyên ảnh
    client.paint({}, 800, 450);
    assert.deepEqual([canvas.width, canvas.height], [800, 450]);
  } finally {
    client.close();
  }
});

test('bản PC (chuột thật): bấm vào hình là bàn phím của máy tính gõ thẳng sang máy, Enter đi bằng mã phím, dãy phím chỉ hiện khi tự mở bằng nút', async () => {
  media.coarse.flip(false); // máy tính: chuột thật, không có bàn phím ảo
  try {
    const { container, viewport, ws, reset, button } = await openPanel('touch');
    const sink = container.find('kbd-sink');
    const keybar = container.find('keybar');
    assert.notEqual(globalThis.document.activeElement, sink, 'chưa bấm vào hình thì phím chưa đi sang máy');

    viewport.dispatch('pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 10, button: 0, preventDefault() {} });
    assert.equal(globalThis.document.activeElement, sink, 'bấm chuột vào hình: bàn phím thật gõ được ngay, không phải mở dãy phím trước');
    assert.ok(keybar.classList.contains('hidden'), 'máy tính đã có bàn phím thật: dãy phím không tự hiện che hình');

    reset();
    sink.value = 'bimat';
    sink.dispatch('input', {});
    assert.deepEqual(ws.sent.filter((m) => m.t === 'text').map((m) => m.s), ['bimat'], 'chữ gõ vào đi sang máy');

    reset();
    sink.value = 'bimat\n';
    sink.dispatch('input', {});
    assert.deepEqual(ws.sent.filter((m) => m.t === 'key').map((m) => `${m.vk}${m.down ? '↓' : '↑'}`), ['13↓', '13↑'],
      'Enter đi bằng mã phím: ký tự xuống dòng qua VkKeyScan ra Ctrl+Enter (0x020D) nên ô mật khẩu không nhận');
    assert.equal(ws.sent.filter((m) => m.t === 'text').length, 0, 'không gửi kèm ký tự xuống dòng');

    button('Bàn phím').dispatch('click', {});
    assert.ok(!keybar.classList.contains('hidden'), 'nút Bàn phím mở dãy phím để bấm phím bàn phím thật không gửi được (Ctrl+Alt+Del)');
    button('Bàn phím').dispatch('click', {});
    assert.ok(keybar.classList.contains('hidden'));
    assert.equal(globalThis.document.activeElement, null, 'bấm lần nữa là thôi gửi phím sang máy');
  } finally {
    media.coarse.flip(true);
    globalThis.document.activeElement = null;
  }
});

test('dán từ máy này: copy ở máy này rồi Ctrl+V trên hình là dán sang máy kia (chữ, tệp, cả thư mục); copy trên máy kia rồi dán bên đó vẫn dán clipboard máy kia; máy bản cũ dán như trước', async () => {
  media.coarse.flip(false);
  try {
    const { container, viewport, ws, reset } = await openPanel('touch');
    const sink = container.find('kbd-sink');
    viewport.dispatch('pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 10, button: 0, preventDefault() {} });
    const reply = (m) => ws.onmessage({ data: JSON.stringify(m) });
    reply({ t: 'caps', clip: true });
    const keys = () => ws.sent.filter((m) => m.t === 'key').map((m) => `${m.vk}${m.down ? '↓' : '↑'}`);
    const CTRL_V = ['17↓', '86↓', '86↑', '17↑'];
    const ticks = async () => { for (let i = 0; i < 12; i += 1) await tick(); };
    const clip = ({ text = '', files = [], entries = [] }) => ({
      getData: (type) => (type === 'text/plain' ? text : ''),
      files,
      items: files.map((_, i) => ({ kind: 'file', webkitGetAsEntry: () => entries[i] || null })),
    });
    const ctrl = (key) => {
      let prevented = false;
      sink.dispatch('keydown', { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, preventDefault() { prevented = true; } });
      return prevented;
    };
    const paste = (data) => {
      assert.equal(ctrl('v'), false, 'Ctrl+V để trình duyệt bắn sự kiện dán, không chặn');
      sink.dispatch('paste', { clipboardData: clip(data), preventDefault() {} });
    };

    // Chữ vừa copy ở máy này: máy kia đặt clipboard rồi tự bấm Ctrl+V; app không gửi Ctrl+V riêng.
    reset();
    paste({ text: 'chữ từ máy này' });
    const t1 = ws.sent.find((m) => m.t === 'clip-text');
    assert.deepEqual([t1.s, t1.paste], ['chữ từ máy này', true]);
    assert.deepEqual(keys(), []);
    reply({ t: 'clip-done', id: t1.id, ok: true });
    await ticks();

    // Copy ngay trên máy kia (Ctrl+C trong khung) rồi dán: thứ copy ở máy này không đổi nên dán clipboard máy kia.
    assert.equal(ctrl('c'), true, 'Ctrl+C đi sang máy kia');
    reset();
    paste({ text: 'chữ từ máy này' });
    assert.deepEqual(keys(), CTRL_V);
    assert.equal(ws.sent.some((m) => m.t === 'clip-text'), false);

    // Tệp và thư mục vừa copy trong Explorer của máy này: đi cả những gì bên trong thư mục, có tiến độ.
    const fileEntry = (name, body) => ({ isDirectory: false, isFile: true, name, file: (ok) => ok(new File([body], name)) });
    const dirEntry = (name, kids) => ({
      isDirectory: true, isFile: false, name,
      createReader: () => { let given = false; return { readEntries: (ok) => { ok(given ? [] : kids); given = true; } }; },
    });
    reset();
    paste({ files: [new File(['xin chào'], 'ghi chú.txt'), new File([], 'Dự án')], entries: [null, dirEntry('Dự án', [fileEntry('a.txt', 'abc'), dirEntry('rỗng', [])])] });
    await ticks();
    const begin = ws.sent.find((m) => m.t === 'clip-files');
    assert.ok(begin.files.filter((f) => !f.dir).every((f) => f.mtime > 0), 'tệp kèm giờ sửa để máy kia giữ đúng như gốc');
    assert.deepEqual(begin.files.map(({ mtime, ...f }) => f), [
      { rel: 'ghi chú.txt', size: Buffer.byteLength('xin chào') },
      { rel: 'Dự án', dir: true },
      { rel: 'Dự án/a.txt', size: 3 },
      { rel: 'Dự án/rỗng', dir: true },
    ]);
    const badge = container.find('clip-badge');
    assert.ok(!badge.classList.contains('hidden'), 'đang dán thì hiện tiến độ và nút huỷ');
    assert.equal(ws.sent.some((m) => m.t === '#mẩu'), false, 'chờ máy báo sẵn sàng (đủ chỗ) rồi mới gửi mẩu');
    reply({ t: 'clip-ready', id: begin.id });
    await ticks();
    assert.equal(ws.sent.filter((m) => m.t === '#mẩu').length, 2, 'mỗi tệp một mẩu');
    assert.equal(ws.sent.find((m) => m.t === 'clip-end')?.paste, true);
    reply({ t: 'clip-done', id: begin.id, ok: true, count: 2 });
    await ticks();
    assert.ok(badge.classList.contains('hidden'));
    assert.match(textOf(toastRoot), /Đã dán 2 mục sang máy kia/);
    assert.deepEqual(keys(), [], 'máy kia tự bấm Ctrl+V sau khi đặt clipboard');

    // Trình duyệt không bắn sự kiện dán: chốc lát sau vẫn gửi Ctrl+V để máy kia dán clipboard của nó.
    reset();
    ctrl('v');
    await new Promise((r) => setTimeout(r, 450));
    assert.deepEqual(keys(), CTRL_V);
    reset();
    sink.dispatch('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, preventDefault() {} });
    await new Promise((r) => setTimeout(r, 450));
    assert.deepEqual(keys(), ['17↓', '16↓', '86↓', '86↑', '16↑', '17↑'], 'Ctrl+Shift+V (dán chữ trơn) sang máy kia giữ Shift');
  } finally {
    media.coarse.flip(true);
    globalThis.document.activeElement = null;
  }

  // Đầu máy bản cũ (không báo làm được việc dán): dán clipboard của máy kia như trước và nhắc chạy Setup.
  const old = await openPanel('touch');
  const sink = old.container.find('kbd-sink');
  old.reset();
  sink.dispatch('paste', { clipboardData: { getData: () => 'chữ khác', files: [], items: [] }, preventDefault() {} });
  assert.deepEqual(old.ws.sent.filter((m) => m.t === 'key').map((m) => `${m.vk}${m.down ? '↓' : '↑'}`), ['17↓', '86↓', '86↑', '17↑']);
  assert.match(textOf(toastRoot), /bản Orbit Remote cũ.*Setup máy/);
});

test('dấu của thứ đang copy: ảnh trong clipboard (tệp vừa sinh lúc dán) không tính giờ, tệp thật thì tính, thư mục không tính giờ', async () => {
  const { clipSignature } = await import('../web/lib/clip-sync.js');
  const now = 1_000_000_000;
  const shot = (at) => ({ name: 'image.png', size: 147, mtime: at });
  assert.equal(clipSignature('', [shot(now - 10)], now), clipSignature('', [shot(now - 2000)], now), 'cùng một ảnh dán hai lần là cùng dấu');
  assert.notEqual(clipSignature('', [{ name: 'a.txt', size: 1, mtime: 5 }], now), clipSignature('', [{ name: 'a.txt', size: 1, mtime: 6 }], now));
  assert.equal(clipSignature('', [{ name: 'D', size: 0, mtime: 5, dir: true }], now), clipSignature('', [{ name: 'D', size: 4096, mtime: 9, dir: true }], now), 'trình duyệt và máy báo thư mục khác nhau');
  assert.notEqual(clipSignature('a', [], now), clipSignature('b', [], now));
  assert.equal(clipSignature('', [], now), '');
});

test('màn chạm: chạm vào hình không mở bàn phím ảo, vẫn phải bấm nút Bàn phím mới gõ', async () => {
  const { container, finger } = await openPanel('touch');
  const sink = container.find('kbd-sink');
  try {
    finger.down(10, 10);
    finger.up(10, 10);
    assert.notEqual(globalThis.document.activeElement, sink, 'chạm để nhấp không được làm mọc bàn phím ảo che hình');
    container.find('screen-toolbar').children.find((b) => b.attrs['aria-label'] === 'Bàn phím').dispatch('click', {});
    assert.equal(globalThis.document.activeElement, sink);
    assert.ok(!container.find('keybar').classList.contains('hidden'), 'màn chạm: mở bàn phím là có dãy phím thay bàn phím thật');
  } finally {
    globalThis.document.activeElement = null;
  }
});
