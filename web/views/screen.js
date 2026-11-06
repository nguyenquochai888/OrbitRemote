// Khung xem và điều khiển màn hình một máy: chọn màn hình, phát/dừng từng màn, chạm hoặc dùng như
// bàn di chuột, bàn phím ảo, phóng to bằng hai ngón, và chế độ toàn màn hình với dãy nút nổi.
// Xoay ngang điện thoại lúc đang phát là vào toàn màn hình; máy khoá xoay thì nút "Xem ngang" xoay
// khung 90° (cầm máy xoay ngược chiều kim đồng hồ để xem).
//
// Cử chỉ (rê một ngón KHÔNG BAO GIỜ tự giữ chuột trái; nhấp chỉ quyết định lúc nhấc ngón):
//   Chế độ chạm   rê = con trỏ theo ngón · chạm = nhấp trái tại chỗ chạm · giữ yên rồi nhấc = nhấp phải
//   Chế độ chuột  rê = dời con trỏ như bàn di chuột · chạm = nhấp trái · giữ yên rồi nhấc = nhấp phải
//   Nút "Kéo"     bật rồi chạm và rê = kéo giữ chuột trái (bôi đen, kéo thả); nhấc ngón là thả, nút tự tắt
//   Hai ngón      chụm/mở = phóng to/thu nhỏ khung xem · kéo khi đang phóng to = dời khung xem ·
//                 kéo khi chưa phóng to = cuộn · chạm hai ngón = nhấp phải
//   Chuột thật (trình duyệt máy tính) đi thẳng: rê, nhấp, cuộn.

import { h, add, clear, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { ScreenClient } from '../lib/screen-client.js';
import { createClipSync } from '../lib/clip-sync.js';

// Ghi chú lấy đúng số của QUALITY trong src/screen.mjs; đổi bên đó thì đổi theo ở đây. Màn đứng yên
// gần như không tốn dữ liệu; số Mb/s là trần lúc màn đổi nhiều (cuộn, kéo cửa sổ).
const QUALITIES = [
  { id: 'fast', label: 'Nhanh', hint: '1280×720 · 30 khung/giây · tối đa 2,5 Mb/s: mượt, đủ nét để đọc chữ' },
  { id: 'sharp', label: 'Nét', hint: '1920×1080 · 60 khung/giây · tối đa 8 Mb/s: nét nhất, cần mạng khoẻ' },
  { id: 'saver', label: 'Tiết kiệm', hint: '960×540 · 24 khung/giây · tối đa 1,2 Mb/s: cho 4G, mạng yếu' },
];
const MOVE_SLOP = 8; // px: dưới mức này vẫn tính là chạm, chưa phải kéo
const LONG_PRESS_MS = 550;
const TAP_MS = 260;
const ZOOM_MAX = 5;
const WHEEL_PER_PX = 2.4; // 120 đơn vị = một nấc cuộn, xấp xỉ 50 px nội dung
const PAD_FAST = 0.8; // px/ms: ngón đi nhanh cỡ này thì con trỏ đi gấp đôi
const PAD_BOOST_MAX = 2.5;
const FOLLOW_EDGE = 0.18; // con trỏ vào dải sát mép rộng cỡ này (phần của khung) thì khung đi theo
const FOLLOW_MIN_PX = 36;
const GLIDE_STEP = 0.28; // phần quãng còn lại khung đi được mỗi nhịp màn hình khi trượt theo con trỏ
const JOY_DEAD = 0.15; // cần tay cầm lệch dưới mức này (phần bán kính) thì chưa dời chuột
const JOY_SPEED = 0.225; // tốc độ chuẩn khi đẩy hết cỡ: phần cạnh dài màn máy mỗi giây (1920 px: chừng 430 px/giây)
const JOY_CURVE = 1.6; // đẩy nhẹ thì chậm hơn tỉ lệ thuận: chỉnh từng chút được
const JOY_BOOST_AFTER = 0.5; // giữ hết cỡ quá chừng này giây thì bắt đầu nhanh dần
const JOY_BOOST_RAMP = 0.8; // ... và sau thêm chừng này giây thì đạt gấp đôi
const JOY_SETTLE_MS = 250; // thôi đẩy cần chừng này thì dấu con trỏ khớp về chỗ máy báo
const JOY_REPEAT_DELAY_MS = 350; // giữ nút cuộn: cuộn một nấc, chờ chừng này rồi cuộn liên tục
const JOY_REPEAT_MS = 90;
const MODES = {
  touch: { icon: 'touch', label: 'Đang ở chế độ chạm' },
  pad: { icon: 'mouse', label: 'Đang ở chế độ chuột' },
  joy: { icon: 'joystick', label: 'Đang ở chế độ tay cầm' },
};

// Mã phím ảo Windows cho phím không phải chữ.
const VK = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, ' ': 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46, Meta: 91, F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118,
  F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};
const KEYBAR = [
  { label: 'Esc', vk: 27 }, { label: 'Tab', vk: 9 },
  { label: 'Ctrl', mod: 17 }, { label: 'Alt', mod: 18 }, { label: 'Shift', mod: 16 }, { label: 'Win', mod: 91 },
  { label: '←', vk: 37 }, { label: '↑', vk: 38 }, { label: '↓', vk: 40 }, { label: '→', vk: 39 },
  { label: 'Home', vk: 36 }, { label: 'End', vk: 35 }, { label: 'PgUp', vk: 33 }, { label: 'PgDn', vk: 34 },
  { label: 'Del', vk: 46 }, { label: '⌫', vk: 8 }, { label: 'F5', vk: 116 },
];

function pref(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // trình duyệt chặn lưu: chỉ mất phần nhớ lựa chọn
  }
}

// Ctrl+V mà trình duyệt không bắn sự kiện dán (clipboard bị chặn) thì chừng này sau vẫn gửi Ctrl+V sang máy kia.
const PASTE_FALLBACK_MS = 400;

export function mountScreenPanel(container, machine) {
  let client = null;
  let screens = [];
  let selected = Number(pref(`orbit-screen-${machine.id}`, '0')) || 0;
  // Nguồn hình: một màn hình hay một cửa sổ (ứng dụng, thư mục) đang mở trên máy. Màn hình được nhớ qua lần
  // mở sau; cửa sổ thì không (mã cửa sổ đổi mỗi lần mở lại ứng dụng).
  let source = { kind: 'screen', index: selected };
  let windows = []; // cửa sổ đang mở, máy liệt kê mỗi lần mở danh sách nguồn
  let windowsState = 'idle'; // 'loading' | 'ready' | 'error'
  let windowsError = '';
  let liveSource = null; // thông tin máy báo khi bắt đầu phát (gồm cỡ thật của nguồn)
  let playing = false; // người dùng muốn phát (kể cả lúc đang nối lại)
  let quality = pref('orbit-screen-quality', 'fast');
  let mode = pref('orbit-screen-mode', 'touch'); // 'touch' | 'pad' | 'joy'
  if (!MODES[mode]) mode = 'touch';
  // Tay cầm (dời chuột): điều khiển bằng nút trên khung, chạm vào hình không nhấp gì.
  const handsOff = () => mode === 'joy';
  let fullscreen = false;
  let autoFullscreen = false; // toàn màn hình do xoay ngang máy đưa vào: xoay dọc lại thì tự ra
  let rotated = false; // khung đang tự xoay ngang (máy khoá xoay, vẫn cầm dọc)
  // Máy đổi chiều nguồn theo chiều đang xem (src/orient.mjs): màn hình chuyển ngang/dọc, cửa sổ đổi
  // cỡ cho vừa khung. Bật sẵn; tắt trong danh sách nguồn hình, nhớ cho lần sau.
  let autoOrient = pref('orbit-screen-orient', '1') === '1';
  let sentOrient = ''; // chiều đã báo cho máy ('portrait' | 'landscape' | 'off'), chỉ báo lại khi đổi
  let dockOpen = true;
  // Điện thoại đang nằm ngang thật. Máy tính bảng và máy tính đủ chỗ ở mọi chiều nên không tính.
  const phoneLandscape = window.matchMedia?.('(orientation: landscape) and (max-height: 540px) and (pointer: coarse)') || null;
  const coarsePointer = window.matchMedia?.('(pointer: coarse)') || null;
  const canRotate = () => Boolean(coarsePointer?.matches) && !phoneLandscape?.matches;
  let retries = 0;
  let resumeOnShow = false;
  const mods = new Set(); // phím bổ trợ đang giữ dính trên dãy phím

  // ---- Khung ------------------------------------------------------------------------------
  const canvas = h('canvas', { class: 'screen-canvas', width: 16, height: 9 });
  const viewport = h('div', { class: 'screen-viewport' }, canvas);
  const overlayText = h('div', { class: 'screen-overlay-text' });
  const bigPlay = h('button', { class: 'screen-bigplay', 'aria-label': 'Phát màn hình', onclick: () => play() }, icon('play', 30));
  const overlay = h('div', { class: 'screen-overlay' }, bigPlay, overlayText);
  const hud = h('div', { class: 'screen-hud hidden' });
  const holdBadge = h('div', { class: 'screen-hold hidden' }, 'Đang giữ chuột trái');
  // Clipboard hai chiều (clip-sync.js): tiến độ chép kèm nút huỷ, hay lời mời kèm nút (chép tệp lớn về).
  const clipText = h('span');
  const clipAction = h('button', { class: 'clip-action hidden', onpointerdown: (e) => e.preventDefault() });
  const clipCancel = h('button', { class: 'clip-cancel hidden', 'aria-label': 'Huỷ chép', title: 'Huỷ chép', onpointerdown: (e) => e.preventDefault(), onclick: () => clip.cancel() }, icon('x', 14));
  const clipBadge = h('div', { class: 'clip-badge hidden', role: 'status' }, icon('clip', 14), clipText, clipAction, clipCancel);
  const sink = h('textarea', {
    class: 'kbd-sink', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
    'aria-label': 'Bàn phím', rows: 1,
  });
  const keybar = h('div', { class: 'keybar hidden' });
  const dock = h('div', { class: 'fs-dock' });
  const dockToggle = h('button', { class: 'fs-toggle', 'aria-label': 'Ẩn hoặc hiện nút', onclick: () => setDock(!dockShown()) }, icon('sliders', 20));
  const stage = h('div', { class: 'screen-stage' }, viewport, overlay, holdBadge, clipBadge, dockToggle, dock, keybar, sink);
  const sourceSlot = h('div', { class: 'screen-source' });
  const toolbar = h('div', { class: 'screen-toolbar' });
  // Dòng khung hình/giây và tốc độ không đè lên hình: nằm dưới dãy nút, toàn màn hình thì vào khung,
  // cạnh nút tròn ở góc dưới (setFullscreen chuyển chỗ).
  const panel = h('section', { class: 'screen-panel' },
    h('div', { class: 'screen-head' }, h('div', { class: 'group-title' }, 'Màn hình'), sourceSlot),
    stage, toolbar, hud);
  container.append(panel);

  // ---- Nút ----------------------------------------------------------------------------------
  const btn = (name, label, onclick, cls = '') => h('button', { class: `tool-btn ${cls}`, 'aria-label': label, title: label, onclick }, icon(name, 19));

  const kbdButtons = []; // nút Bàn phím đang có (dãy dưới khung, dãy nút nổi)
  function renderControls() {
    clear(toolbar);
    clear(dock);
    const playBtn = (where) => btn(playing ? 'stop' : 'play', playing ? 'Dừng' : 'Phát', () => (playing ? stop() : play()), `${playing ? 'danger' : 'primary'} ${where}`);
    const modeBtn = (where) => modePicker(where);
    // Nút Bàn phím sáng khi phím đang đi sang máy; syncKeyboardUi đổi màu tại chỗ qua kbdButtons.
    kbdButtons.length = 0;
    const kbdBtn = () => {
      const b = btn('keyboard', 'Bàn phím', toggleKeyboard, document.activeElement === sink ? 'on' : '');
      kbdButtons.push(b);
      return b;
    };
    const qualityBtn = (where) => qualityPicker(where);
    const sourceBtn = (where) => sourcePicker(where);
    const zoomBtn = () => (zoom.z > 1.01 ? h('button', { class: 'tool-btn text', onclick: resetZoom }, `${zoom.z.toFixed(1)}×`) : null);
    // Tay cầm có nút X để giữ chuột trái, tay cầm game không dùng chuột: không cần nút Kéo.
    const dragBtn = () => (handsOff() ? null : btn('drag', dragArmed ? 'Tắt kéo' : 'Kéo (giữ chuột trái)', () => setDragArmed(!dragArmed), dragArmed ? 'on' : ''));
    // Thanh nút dựng lại (máy gửi danh sách màn hình, đổi trạng thái phát...) thì danh sách đang mở
    // được mở lại ở nút mới, không bị đóng ngang lúc người dùng đang chọn.
    const reopen = openMenu ? { key: openMenu.key, scroll: menuScroll() } : null;
    closeMenu();
    menuSlots.clear();
    add(toolbar, playBtn(''), modeBtn('bar'), dragBtn(), kbdBtn(), qualityBtn('bar'), zoomBtn(), h('span', { class: 'flex' }),
      canRotate() ? btn('rotate', 'Xem ngang', () => { setFullscreen(true); setRotated(true); }) : null,
      btn('expand', 'Toàn màn hình', () => setFullscreen(true)));
    add(dock,
      btn('shrink', 'Thoát toàn màn hình', () => setFullscreen(false)),
      playBtn(''),
      canRotate() ? btn('rotate', rotated ? 'Xem dọc' : 'Xem ngang', () => setRotated(!rotated), rotated ? 'on' : '') : null,
      sourceBtn('dock'),
      modeBtn('dock'), dragBtn(), kbdBtn(), qualityBtn('dock'), zoomBtn());
    clear(sourceSlot).append(sourceBtn('head'));
    if (reopen) {
      showMenu(reopen.key, false);
      restoreScroll(reopen.scroll);
    }
    syncJoyPad(); // bốn nút và cần tay cầm chỉ hiện ở chế độ tay cầm, lúc đang phát
  }

  function setOverlay(text, { showPlay = false, busy = false } = {}) {
    overlay.classList.toggle('hidden', !text && !showPlay);
    overlay.classList.toggle('busy', busy);
    bigPlay.classList.toggle('hidden', !showPlay);
    overlayText.textContent = text || '';
  }

  // ---- Phát / dừng -------------------------------------------------------------------------
  async function ensureClient() {
    if (client?.connected) return client;
    client?.close();
    client = new ScreenClient({
      machineId: machine.id,
      canvas,
      onState,
      onScreens: (list) => {
        screens = list;
        if (!list.some((s) => s.index === selected) && list.length) selected = list[0].index;
        if (source.kind === 'screen') source = { kind: 'screen', index: selected };
        renderControls();
        refreshMenu();
      },
      onCursor: (x, y) => { followCursor(x, y); onRemoteCursor(x, y); },
      onWindows: (list, error) => {
        windows = list;
        windowsState = error ? 'error' : 'ready';
        windowsError = error || '';
        refreshMenu();
      },
      onStats: ({ fps, kbps }) => {
        if (!playing) return;
        hud.textContent = `${fps} khung/giây · ${kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${kbps} kb/s`}`;
      },
      onCaps: () => clip.start(), // máy bản mới: bật clipboard hai chiều
      onClip: (m) => clip.onRemote(m),
    });
    await client.connect();
    return client;
  }

  async function play() {
    playing = true;
    renderControls();
    setOverlay('Đang nối tới máy…', { busy: true });
    try {
      const c = await ensureClient();
      startSource(c);
      setOverlay(source.kind === 'screen' ? 'Đang mở màn hình…' : `Đang mở "${source.title}"…`, { busy: true });
    } catch (err) {
      playing = false;
      renderControls();
      setOverlay(err.message, { showPlay: true });
    }
  }

  // Vừa chọn nguồn (màn, ứng dụng, thư mục) thì lần phát kế tiếp xin máy đưa con trỏ vào giữa nguồn.
  let centerNext = false;
  function startSource(c) {
    const o = viewOrient();
    sentOrient = o ? o.want : 'off';
    c.start(source, quality, o, centerNext);
    centerNext = false;
  }

  // Chiều đang xem: ngang khi khung xoay ngang ("Xem ngang") hay máy đang nằm ngang thật (trình duyệt
  // máy tính: theo cửa sổ trình duyệt). Tỉ lệ lấy theo cả màn hình điện thoại ở chiều đó, vì xem toàn
  // màn hình là lúc cần hình phủ kín nhất. Null khi tắt tính năng.
  function viewOrient() {
    if (!autoOrient) return null;
    const iw = window.innerWidth || 1;
    const ih = window.innerHeight || 1;
    const landscape = rotated || Boolean(phoneLandscape?.matches) || iw > ih;
    const long = Math.max(iw, ih);
    const short = Math.min(iw, ih);
    return { want: landscape ? 'landscape' : 'portrait', aspect: landscape ? long / short : short / long };
  }

  // Báo máy khi chiều đang xem đổi (xoay máy, "Xem ngang", bật hay tắt tính năng) lúc đang phát.
  function syncOrient() {
    const o = viewOrient();
    const key = o ? o.want : 'off';
    if (key === sentOrient || !playing || !client?.connected) return;
    sentOrient = key;
    client.orient(o);
  }

  function toggleAutoOrient() {
    autoOrient = !autoOrient;
    savePref('orbit-screen-orient', autoOrient ? '1' : '0');
    toast(autoOrient ? 'Máy sẽ xoay nguồn hình theo chiều đang xem.' : 'Đã tắt xoay theo điện thoại; nguồn đang xem được trả như cũ.');
    syncOrient();
    refreshMenu();
  }

  let orientTimer = null;
  function onWindowResize() {
    clearTimeout(orientTimer);
    orientTimer = setTimeout(syncOrient, 300);
  }
  window.addEventListener?.('resize', onWindowResize);

  function stop() {
    endGestures();
    playing = false;
    client?.stop();
    hud.classList.add('hidden');
    setOverlay('', { showPlay: true });
    renderControls();
  }

  function select(index, start) {
    centerNext = Boolean(start);
    selected = index;
    source = { kind: 'screen', index };
    savePref(`orbit-screen-${machine.id}`, String(index));
    resetZoom();
    if (start) play();
    else renderControls();
  }

  function selectWindow(w) {
    centerNext = true;
    source = { kind: 'window', hwnd: w.hwnd, title: w.title, exe: w.exe, folder: w.kind === 'folder' };
    resetZoom();
    play();
  }

  function onState(state, info) {
    if (state === 'playing') {
      liveSource = info;
      retries = 0;
      // Máy quay lại chỉ để lấy khung gốc (gỡ đứng hình khi mạng vừa nghẽn): giữ hình đang có, khỏi che.
      if (!info?.quiet) setOverlay('Đang chờ khung hình đầu tiên…', { busy: true });
    } else if (state === 'frame') {
      setOverlay('');
      hud.classList.remove('hidden');
      layout();
    } else if (state === 'resized') {
      layout();
    } else if (state === 'notice') {
      toast(info);
    } else if (state === 'locked') {
      // Máy có phần xem màn khoá (chạy bằng quyền SYSTEM, cài bằng setup.cmd): hình màn khoá tới ngay sau
      // đây và bấm được, chỉ nhắc cách gõ mật khẩu. Không có thì Windows không cho xem hay bấm màn đó: báo
      // rõ, máy tự phát lại khi mở khoá xong (vẫn đang "phát", nên không hiện nút phát).
      if (info?.live) {
        toast(info.state === 'secure'
          ? 'Máy đang hiện hộp thoại quản trị (UAC): bấm được ngay trên hình.'
          : coarsePointer?.matches
            ? 'Máy đang ở màn khoá: chạm vào hình cho hiện ô mật khẩu, mở bàn phím rồi gõ mật khẩu và Enter.'
            : 'Máy đang ở màn khoá: bấm vào hình cho hiện ô mật khẩu, rồi gõ mật khẩu bằng bàn phím của máy này và Enter.');
        return;
      }
      hud.classList.add('hidden');
      const setup = ' Muốn xem và gõ mật khẩu từ xa: chạy setup.cmd tại máy một lần (bước "Xem và gõ mật khẩu ở màn khoá").';
      setOverlay(info?.state === 'secure'
        ? `Máy đang hiện hộp thoại quản trị (UAC) hay một màn bảo mật của Windows. Windows không cho chương trình thường xem hay bấm vào màn này. Xử lý xong tại máy thì hình tự hiện.${setup}`
        : `Máy đang ở màn khoá (màn đăng nhập) của Windows. Windows không cho chương trình thường xem hay điều khiển màn này, nên chưa xem được. Đăng nhập tại máy; mở khoá xong hình tự hiện.${setup}`, { busy: true });
    } else if (state === 'quality') {
      // Máy tự hạ mức vì mạng nghẽn liên tục: chỉ cho lần xem này, không ghi đè lựa chọn đã nhớ.
      const q = QUALITIES.find((x) => x.id === info);
      if (!q || q.id === quality) return;
      quality = q.id;
      renderControls();
      toast(`Mạng chậm: tự chuyển sang mức "${q.label}" cho hình đi kịp.`);
    } else if (state === 'error') {
      setOverlay(info, { showPlay: true });
      playing = false;
      renderControls();
    } else if (state === 'closed' && playing) {
      // Mất đường nối giữa chừng (đổi mạng, máy ngủ): xin vé mới và nối lại vài lần.
      if (retries < 3) {
        retries += 1;
        setOverlay('Mất kết nối, đang nối lại…', { busy: true });
        setTimeout(() => { if (playing) play(); }, 900 * retries);
      } else {
        playing = false;
        setOverlay('Mất kết nối tới máy.', { showPlay: true });
        renderControls();
      }
    }
  }

  function setQuality(id) {
    closeMenu();
    if (id === quality) return;
    quality = id;
    savePref('orbit-screen-quality', quality);
    if (playing && client?.connected) startSource(client);
    renderControls();
  }

  // ---- Danh sách xổ dùng chung (nguồn hình, chất lượng) ------------------------------------
  // Nút ghi lựa chọn đang dùng kèm mũi tên; chạm thì xổ danh sách ngay cạnh nút, trong khung, nên dùng
  // được cả lúc toàn màn hình thật và lúc xem ngang. `where`: 'head' xổ xuống (đầu khung), 'bar' xổ
  // lên (dãy nút dưới khung), 'dock' xổ sang bên hay xuống dưới (dãy nút nổi, xem styles.css).
  let openMenu = null; // { key, wrap, menu, build }
  const menuSlots = new Map(); // `${kind}:${where}` -> { wrap, build, kind, where }: nút đang có trên khung
  function closeMenu() {
    if (!openMenu) return;
    openMenu.menu.remove();
    openMenu = null;
    document.removeEventListener('pointerdown', onOutsideMenu, true);
  }
  function onOutsideMenu(e) {
    if (openMenu && !openMenu.wrap.contains(e.target)) closeMenu();
  }
  const menuScroll = () => openMenu?.menu.querySelector?.('.pop-list')?.scrollTop || 0;
  function restoreScroll(scroll) {
    const list = openMenu?.menu.querySelector?.('.pop-list');
    if (list) list.scrollTop = scroll;
  }
  // fresh = false: mở lại tại chỗ sau khi thanh nút được dựng lại, không chạy lại hiệu ứng mở.
  function showMenu(key, fresh = true) {
    const slot = menuSlots.get(key);
    if (!slot) return;
    const menu = h('div', { class: `pop-menu ${slot.kind}-menu ${slot.where}${fresh ? '' : ' still'}`, role: 'listbox' }, slot.build());
    slot.wrap.append(menu);
    openMenu = { key, wrap: slot.wrap, menu, build: slot.build };
    document.addEventListener('pointerdown', onOutsideMenu, true);
    if (slot.where !== 'dock') keepInView(menu);
  }
  // Danh sách đang mở dựng lại tại chỗ (ví dụ khi máy vừa gửi danh sách cửa sổ), giữ chỗ cuộn.
  function refreshMenu() {
    if (!openMenu) return;
    const scroll = menuScroll();
    clear(openMenu.menu);
    add(openMenu.menu, openMenu.build());
    restoreScroll(scroll);
  }
  function menuButton({ kind, where, title, content, build, onOpen, label }) {
    const key = `${kind}:${where}`;
    const wrap = h('span', { class: `menu-wrap ${kind}-wrap` });
    menuSlots.set(key, { wrap, build, kind, where });
    wrap.append(h('button', {
      class: `tool-btn text menu-btn ${kind}-btn ${where}`, title, 'aria-label': label || title, 'aria-haspopup': 'listbox',
      onclick: () => {
        const open = openMenu?.key === key;
        closeMenu();
        if (open) return;
        showMenu(key);
        onOpen?.();
      },
    }, content));
    return wrap;
  }
  const option = ({ label, hint, active, onPick }) => h('button', { class: `pick-option${active ? ' active' : ''}`, role: 'option', onclick: onPick },
    h('span', { class: 'pick-label' }, label), hint ? h('span', { class: 'pick-hint' }, hint) : null, active ? icon('check', 18) : null);

  function qualityPicker(where) {
    const current = QUALITIES.find((q) => q.id === quality) || QUALITIES[0];
    return menuButton({
      kind: 'quality', where, title: 'Chất lượng hình',
      content: [current.label, icon('down', 14)],
      build: () => [h('div', { class: 'pop-menu-title' }, 'Chất lượng hình'),
        ...QUALITIES.map((q) => option({ label: q.label, hint: q.hint, active: q.id === quality, onPick: () => setQuality(q.id) }))],
    });
  }

  // Chọn nguồn hình: các màn hình, rồi cửa sổ ứng dụng và thư mục đang mở (máy liệt kê lại mỗi lần mở danh
  // sách). Chọn cửa sổ thì máy đưa nó lên trước và chỉ phát riêng cửa sổ đó.
  function sourceLabel() {
    if (source.kind === 'window') return source.title || 'Cửa sổ';
    const s = screens.find((x) => x.index === source.index);
    return s ? `Màn ${s.index + 1} · ${s.width}×${s.height}` : `Màn ${source.index + 1}`;
  }
  function sourceMenu() {
    const screenRows = (screens.length ? screens : [{ index: selected, width: 0, height: 0 }]).map((s) => option({
      label: `Màn ${s.index + 1}`, hint: s.width ? `${s.width}×${s.height}` : '',
      active: source.kind === 'screen' && source.index === s.index,
      onPick: () => { closeMenu(); select(s.index, true); },
    }));
    const windowRow = (w) => option({
      label: w.title,
      hint: [w.kind === 'folder' ? 'Thư mục' : w.exe, w.min ? 'đang thu nhỏ, sẽ được mở ra' : ''].filter(Boolean).join(' · '),
      active: source.kind === 'window' && source.hwnd === w.hwnd,
      onPick: () => { closeMenu(); selectWindow(w); },
    });
    const note = (text) => h('div', { class: 'pop-note' }, text);
    const apps = windows.filter((w) => w.kind !== 'folder');
    const folders = windows.filter((w) => w.kind === 'folder');
    const section = (title) => h('div', { class: 'pop-section' }, title);
    let appRows;
    if (windowsState === 'loading' && !windows.length) appRows = [note('Đang lấy danh sách cửa sổ…')];
    else if (windowsState === 'error') appRows = [note(`Không lấy được danh sách cửa sổ: ${windowsError}`)];
    else appRows = apps.length ? apps.map(windowRow) : [note('Không có ứng dụng nào đang mở.')];
    return [h('div', { class: 'pop-menu-title' }, 'Nguồn hình'),
      option({
        label: 'Xoay theo điện thoại',
        hint: 'Màn hình, cửa sổ đổi ngang dọc theo chiều đang xem; thôi xem là trả như cũ',
        active: autoOrient,
        onPick: toggleAutoOrient,
      }),
      h('div', { class: 'pop-list' },
        section('Màn hình'), screenRows,
        section('Ứng dụng'), appRows,
        folders.length ? [section('Thư mục'), folders.map(windowRow)] : null)];
  }
  function sourcePicker(where) {
    const live = playing ? ' live' : '';
    return menuButton({
      kind: 'source', where, title: 'Chọn nguồn hình', label: `Nguồn hình: ${sourceLabel()}`,
      content: where === 'dock'
        ? [icon(source.kind === 'window' ? 'layers' : 'machine', 19)]
        : [h('span', { class: `source-dot${live}` }), h('span', { class: 'source-name' }, sourceLabel()), icon('down', 14)],
      build: sourceMenu,
      onOpen: async () => {
        windowsState = 'loading';
        refreshMenu();
        try {
          (await ensureClient()).listWindows();
        } catch (err) {
          windowsState = 'error';
          windowsError = err.message;
          refreshMenu();
        }
      },
    });
  }
  // Danh sách dưới khung không được tràn ra ngoài phần nhìn thấy: mép màn hình điện thoại, và trên bản
  // PC là mép cột phải (khung cuộn của cột cắt mất phần tràn sang cột trái). Dịch bằng lề trái, không
  // bằng transform: hiệu ứng mở (rise) giữ transform của khung cuối và sẽ đè lên.
  function keepInView(menu) {
    const r = menu.getBoundingClientRect?.();
    if (!r || !window.innerWidth) return;
    let left = 0;
    let right = window.innerWidth;
    for (let p = menu.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowX === 'visible') continue;
      const b = p.getBoundingClientRect();
      left = Math.max(left, b.left);
      right = Math.min(right, b.right);
    }
    const shift = Math.min(0, right - 8 - r.right) || Math.max(0, left + 8 - r.left);
    if (shift) menu.style.marginLeft = `${parseFloat(getComputedStyle(menu).marginLeft || '0') + shift}px`;
  }

  // Chọn chế độ điều khiển trong danh sách xổ (chạm, chuột, tay cầm), như chọn chất lượng hình.
  const MODE_LIST = [
    { id: 'touch', label: 'Chạm', hint: 'Con trỏ theo ngón, chạm vào đâu nhấp vào đó' },
    { id: 'pad', label: 'Chuột', hint: 'Rê ngón dời con trỏ như bàn di chuột, chạm để nhấp' },
    { id: 'joy', label: 'Tay cầm', hint: 'Cần trái dời chuột; X nhấp trái, B nhấp phải, Y cuộn lên, A cuộn xuống' },
  ];
  function modePicker(where) {
    return menuButton({
      kind: 'mode', where, title: 'Chế độ điều khiển', label: MODES[mode].label,
      // Chỉ biểu tượng (góc có tam giác nhỏ báo là danh sách xổ): đủ chỗ cho cả dãy nút trên một hàng.
      content: [icon(MODES[mode].icon, where === 'dock' ? 19 : 18)],
      build: () => [h('div', { class: 'pop-menu-title' }, 'Chế độ điều khiển'),
        ...MODE_LIST.map((x) => option({ label: x.label, hint: x.hint, active: x.id === mode, onPick: () => setMode(x.id) }))],
    });
  }

  function setMode(next) {
    closeMenu();
    if (next === mode || !MODES[next]) return;
    if (dragArmed) setDragArmed(false);
    mode = next;
    savePref('orbit-screen-mode', mode);
    toast({
      touch: 'Chế độ chạm: con trỏ theo ngón, chạm vào đâu nhấp vào đó.',
      pad: 'Chế độ chuột: rê ngón để dời con trỏ, chạm để nhấp.',
      joy: 'Chế độ tay cầm: cần trái dời chuột, X nhấp trái (giữ để kéo), B nhấp phải, Y cuộn lên, A cuộn xuống.',
    }[mode]);
    if (fullscreen) setDock(!handsOff()); // dãy nút nổi đóng lại cho khỏi che các nút của tay cầm
    renderControls();
  }

  // ---- Toàn màn hình và dãy nút nổi --------------------------------------------------------
  function setFullscreen(on) {
    fullscreen = on;
    autoFullscreen = false;
    if (!on && rotated) setRotated(false);
    stage.classList.toggle('fullscreen', on);
    (on ? stage : panel).append(hud);
    document.body.classList.toggle('screen-fullscreen', on);
    // iPad và trình duyệt máy tính có toàn màn hình thật; iPhone thì khung tự phủ kín màn hình.
    const el = stage;
    if (on && el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setDock(!handsOff()); // tay cầm: dãy nút nổi đóng sẵn cho khỏi che các nút của tay cầm
    resetZoom();
    requestAnimationFrame(layout);
  }

  let dockChangedAt = 0;
  function setDock(open) {
    dockOpen = open;
    dockChangedAt = performance.now();
    dock.classList.toggle('closed', !open);
    dockToggle.classList.toggle('closed', !open);
  }
  // Nút tròn bật tắt theo cái đang thấy thật trên màn (lớp, độ mờ, hiển thị), không chỉ theo cờ: dãy nút
  // mà bị ẩn đi theo đường nào khác thì một lần bấm vẫn mở ngay, không phải bấm hai lần. Ngay sau một lần
  // bật tắt (dãy nút còn đang mờ dần hiện ra) thì tin cờ, để bấm nhanh hai lần vẫn mở rồi đóng.
  function dockShown() {
    if (!dockOpen || dock.classList.contains('closed')) return false;
    if (performance.now() - dockChangedAt < 400) return true;
    const cs = window.getComputedStyle?.(dock);
    return !cs || (cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.1);
  }

  document.addEventListener('fullscreenchange', onFsChange);
  function onFsChange() {
    if (!document.fullscreenElement && fullscreen) setFullscreen(false);
  }

  // Xem ngang khi máy khoá xoay: khung dựng theo chiều ngang rồi xoay 90° bằng CSS (lớp "rotated").
  // Mọi toạ độ chạm đi qua local() nên vẫn rơi đúng chỗ trên khung đã xoay.
  function setRotated(on) {
    if (rotated === on) return;
    rotated = on;
    stage.classList.toggle('rotated', on);
    resetZoom();
    renderControls();
    requestAnimationFrame(layout);
    syncOrient();
  }

  // Xoay máy thật: đang phát mà xoay ngang thì vào toàn màn hình, xoay dọc lại thì ra (chỉ khi chính
  // việc xoay đã đưa vào). Máy đã nằm ngang thật thì khung không tự xoay thêm.
  function onOrientation() {
    if (phoneLandscape.matches) {
      if (rotated) setRotated(false);
      if (playing && !fullscreen) {
        setFullscreen(true);
        autoFullscreen = true;
      }
    } else if (autoFullscreen && fullscreen) {
      setFullscreen(false);
    }
    renderControls();
    syncOrient();
  }
  phoneLandscape?.addEventListener?.('change', onOrientation);

  // ---- Bố cục khung hình và phóng to --------------------------------------------------------
  const zoom = { z: 1, x: 0, y: 0 };
  let fit = { left: 0, top: 0, width: 0, height: 0 };

  function layout() {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const cw = canvas.width;
    const ch = canvas.height;
    if (!vw || !vh) return;
    if (!cw || !ch) return;
    // Khung lấp hết chỗ còn lại của màn máy (styles.css), hình đặt vừa giữa khung theo đúng tỉ lệ.
    const scale = Math.min(vw / cw, vh / ch);
    const top = (vh - ch * scale) / 2;
    fit = { width: cw * scale, height: ch * scale, left: (vw - cw * scale) / 2, top };
    canvas.style.width = `${fit.width}px`;
    canvas.style.height = `${fit.height}px`;
    canvas.style.left = `${fit.left}px`;
    canvas.style.top = `${fit.top}px`;
    applyZoom();
  }

  // Không cho kéo khung ra khỏi vùng nhìn: mép hình luôn chạm hoặc vượt mép khung. Khung đã chạm mép
  // thì mọi cách dời (hai ngón, một ngón ở chế độ chạm, đi theo con trỏ) đều đứng yên ở đó.
  function clampPan(x, y) {
    const minX = Math.min(0, fit.width - fit.width * zoom.z);
    const minY = Math.min(0, fit.height - fit.height * zoom.z);
    return { x: Math.min(0, Math.max(minX, x)), y: Math.min(0, Math.max(minY, y)) };
  }

  function clampZoom() {
    zoom.z = Math.min(ZOOM_MAX, Math.max(1, zoom.z));
    const p = clampPan(zoom.x, zoom.y);
    zoom.x = p.x;
    zoom.y = p.y;
  }

  function applyZoom() {
    clampZoom();
    canvas.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.z})`;
    paintGhost(); // dấu con trỏ của tay cầm đi theo khung khi phóng to, dời khung
  }

  // Khung đi theo con trỏ (chế độ chuột, đang phóng to): con trỏ thật mà ra gần mép vùng đang thấy
  // thì khung trượt êm tới chỗ con trỏ lại nằm trong vùng. Mỗi nhịp màn hình khung đi một phần quãng
  // còn lại (nhanh lúc đầu, chậm dần, dừng đúng chỗ), nên không giật theo từng lần máy báo vị trí.
  let glide = null; // đích đã kẹp trong giới hạn
  function glideTo(x, y) {
    const running = Boolean(glide);
    glide = clampPan(x, y);
    if (!running) requestAnimationFrame(stepGlide);
  }
  function stepGlide() {
    if (!glide) return;
    const dx = glide.x - zoom.x;
    const dy = glide.y - zoom.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      zoom.x = glide.x;
      zoom.y = glide.y;
      glide = null;
    } else {
      zoom.x += dx * GLIDE_STEP;
      zoom.y += dy * GLIDE_STEP;
      requestAnimationFrame(stepGlide);
    }
    applyZoom();
  }
  const stopGlide = () => { glide = null; };

  function followCursor(nx, ny) {
    if (mode === 'touch' || zoom.z <= 1.01 || !fit.width) return; // chuột và tay cầm: khung đi theo con trỏ
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const base = glide || zoom; // tính từ chỗ khung đang trượt tới, không phải chỗ nó đang đi ngang qua
    const cx = fit.left + base.x + nx * fit.width * zoom.z;
    const cy = fit.top + base.y + ny * fit.height * zoom.z;
    const mx = Math.max(FOLLOW_MIN_PX, vw * FOLLOW_EDGE);
    const my = Math.max(FOLLOW_MIN_PX, vh * FOLLOW_EDGE);
    let tx = base.x;
    let ty = base.y;
    if (cx < mx) tx += mx - cx; else if (cx > vw - mx) tx -= cx - (vw - mx);
    if (cy < my) ty += my - cy; else if (cy > vh - my) ty -= cy - (vh - my);
    if (tx !== base.x || ty !== base.y) glideTo(tx, ty);
  }

  function resetZoom() {
    stopGlide();
    const was = zoom.z > 1.01;
    zoom.z = 1;
    zoom.x = 0;
    zoom.y = 0;
    applyZoom();
    if (was) renderControls();
  }

  const resizeObserver = new ResizeObserver(() => layout());
  resizeObserver.observe(viewport);

  // Điểm chạm trong hệ toạ độ riêng của khung: gốc ở góc trên trái khung, trục theo chiều khung
  // đang hiện. Khung xoay ngang (xoay 90° theo chiều kim đồng hồ) thì xoay ngược điểm chạm lại.
  function local(e) {
    const r = viewport.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return rotated ? { x: y, y: r.width - x } : { x, y };
  }

  // Toạ độ chuẩn hoá 0..1 trên màn hình máy, từ một điểm trong khung (xem local()).
  function toRemote(x, y) {
    const w = fit.width * zoom.z;
    const hh = fit.height * zoom.z;
    if (!w || !hh) return { x: 0.5, y: 0.5 };
    return {
      x: Math.min(1, Math.max(0, (x - fit.left - zoom.x) / w)),
      y: Math.min(1, Math.max(0, (y - fit.top - zoom.y) / hh)),
    };
  }

  // Điểm ảnh máy trên mỗi điểm CSS đang thấy: để chế độ chuột dời con trỏ đúng tỉ lệ.
  function remotePxPerCss() {
    const srcWidth = liveSource?.sourceWidth || screens.find((x) => x.index === selected)?.width;
    const w = fit.width * zoom.z;
    return srcWidth && w ? srcWidth / w : 1;
  }

  // ---- Cử chỉ -------------------------------------------------------------------------------
  const pointers = new Map(); // id -> { x, y, t }
  let gesture = null; // trạng thái của một lần chạm cho tới khi nhấc hết ngón

  const live = () => playing && client?.connected;

  // Rê một ngón KHÔNG BAO GIỜ tự giữ chuột trái, ở cả hai chế độ: đoán ý người dùng (chạm rồi rê
  // ngay, giữ yên một chút rồi rê) đều từng làm bôi đen ngoài ý muốn. Muốn kéo thì bấm nút "Kéo": nút
  // trái được nhấn lúc ngón chạm xuống, rê là kéo, nhấc ngón là thả, rồi nút tự tắt.
  let dragArmed = false;
  let holding = false;

  function updateHoldBadge() {
    const text = holding ? 'Đang giữ chuột trái' : dragArmed ? 'Chạm rồi rê để kéo' : '';
    holdBadge.textContent = text;
    holdBadge.classList.toggle('hidden', !text);
  }
  // Mọi lần giữ và nhả đều đi qua đây để nhãn trên khung luôn khớp với nút thật.
  function holdLeft() {
    if (holding) return;
    holding = true;
    client.button(0, true);
    updateHoldBadge();
  }
  function releaseLeft() {
    if (!holding) return;
    holding = false;
    client?.button(0, false);
    updateHoldBadge();
  }
  function setDragArmed(on) {
    dragArmed = on;
    if (!on) releaseLeft();
    updateHoldBadge();
    renderControls();
  }

  // Dừng phát, ẩn app hay đóng khung giữa chừng: nhả nút đang giữ, bỏ cử chỉ dở.
  function endGestures() {
    releaseJoy();
    releaseLeft();
    dragArmed = false;
    updateHoldBadge();
    gesture = null;
    pointers.clear();
  }

  // ---- Chế độ tay cầm -------------------------------------------------------------------------
  // Cần bên trái dời chuột theo hướng kéo, tốc độ đều (đẩy xa hay gần chỉ đổi hướng, không đổi tốc độ,
  // cho dễ lường); bốn nút bên phải xếp như tay cầm Xbox: Y trên cuộn lên, B phải nhấp phải, A dưới cuộn xuống,
  // X trái nhấp trái. X và B là nút thật: nhấn là nhấn, nhả là nhả, nên giữ X rồi đẩy cần là kéo.
  // Giữ Y hay A thì cuộn tiếp. Nền trong mờ, không làm mờ hình phía sau.
  const joyKnob = h('div', { class: 'joy-knob' });
  const joyStick = h('div', { class: 'joy-stick', 'aria-label': 'Cần dời chuột' }, joyKnob);
  const joyReleases = [];
  function joyButton(cls, label, aria, { down, up, repeat = false }) {
    const b = h('div', { class: `joy-btn ${cls}`, role: 'button', 'aria-label': aria }, label);
    let held = null;
    let timer = null;
    const release = () => {
      if (held === null) return;
      held = null;
      clearTimeout(timer);
      clearInterval(timer);
      timer = null;
      b.classList.remove('down');
      up?.();
    };
    b.addEventListener('pointerdown', (e) => {
      if (!live() || held !== null) return;
      e.preventDefault();
      e.stopPropagation();
      b.setPointerCapture?.(e.pointerId);
      held = e.pointerId;
      b.classList.add('down');
      down();
      if (repeat) timer = setTimeout(() => { timer = setInterval(down, JOY_REPEAT_MS); }, JOY_REPEAT_DELAY_MS);
    });
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    joyReleases.push(release);
    return b;
  }
  const joyButtons = h('div', { class: 'joy-buttons' },
    joyButton('top', 'Y', 'Cuộn lên', { down: () => client.wheel(120), repeat: true }),
    joyButton('right', 'B', 'Chuột phải', { down: () => client.button(1, true), up: () => client?.button(1, false) }),
    joyButton('bottom', 'A', 'Cuộn xuống', { down: () => client.wheel(-120), repeat: true }),
    joyButton('left', 'X', 'Chuột trái', { down: () => holdLeft(), up: () => releaseLeft() }));
  const joyPad = h('div', { class: 'joy-pad hidden' }, joyStick, joyButtons);
  stage.append(joyPad);

  let joy = null; // { id, vx, vy, last, full }: cần đang được giữ, hướng và độ xa tâm (0..1)
  // Cỡ nguồn đang xem (điểm ảnh của máy). Tốc độ theo cạnh dài, để màn to hay nhỏ, ngang hay dọc đều
  // như nhau: đẩy hết cỡ đi hết màn chừng bốn giây, giữ hết cỡ thì nhanh dần tới gấp đôi.
  function sourceSize() {
    const s = liveSource || screens.find((x) => x.index === selected) || {};
    return { w: s.sourceWidth || s.width || 1920, h: s.sourceHeight || s.height || 1080 };
  }
  function joySpeed() {
    const { w, h: hh } = sourceSize();
    return Math.max(w, hh) * JOY_SPEED;
  }

  // Dấu chỗ con trỏ ngay trên điện thoại: hình qua mạng tới trễ 0,2 tới 0,5 giây, nhìn con trỏ trong
  // hình mà đẩy cần thì luôn quá tay. Vòng này đi theo cần tức thì (đoán theo đúng quãng đã gửi), thả cần
  // thì khớp về chỗ con trỏ thật máy báo lại.
  const ghost = h('div', { class: 'joy-ghost hidden' });
  viewport.append(ghost);
  let ghostPos = null; // { x, y } chuẩn hoá 0..1 trên nguồn đang xem
  let lastCursor = null; // chỗ con trỏ thật máy báo gần nhất
  let joyIdleAt = 0; // lúc cần thôi đẩy: sau đó mới tin vị trí máy báo
  function paintGhost() {
    const show = mode === 'joy' && playing && Boolean(ghostPos) && fit.width > 0;
    ghost.classList.toggle('hidden', !show);
    if (!show) return;
    const x = fit.left + zoom.x + ghostPos.x * fit.width * zoom.z;
    const y = fit.top + zoom.y + ghostPos.y * fit.height * zoom.z;
    ghost.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
  function onRemoteCursor(x, y) {
    lastCursor = { x, y };
    // Đang đẩy cần thì vị trí máy báo là của một lúc trước: tin chỗ đoán; thôi đẩy một chút thì khớp về.
    if (!joy && performance.now() - joyIdleAt > JOY_SETTLE_MS) {
      ghostPos = { x, y };
      paintGhost();
    }
  }
  function moveGhost(dxPx, dyPx) {
    const { w, h: hh } = sourceSize();
    const base = ghostPos || lastCursor || { x: 0.5, y: 0.5 };
    ghostPos = { x: Math.min(1, Math.max(0, base.x + dxPx / w)), y: Math.min(1, Math.max(0, base.y + dyPx / hh)) };
    paintGhost();
  }
  function joyAim(e) {
    // Toạ độ trong khung (local), nên khung xoay ngang vẫn đẩy cần đúng hướng nhìn thấy.
    const q = local(e);
    const r = joyStick.offsetWidth / 2 || 1;
    let dx = q.x - (joyStick.offsetLeft + r);
    let dy = q.y - (joyStick.offsetTop + r);
    const d = Math.hypot(dx, dy);
    if (d > r) {
      dx *= r / d;
      dy *= r / d;
    }
    joy.vx = dx / r;
    joy.vy = dy / r;
    joyKnob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
  }
  function joyStep() {
    if (!joy) return;
    const now = performance.now(); // cùng mốc với thời gian nhịp màn hình trình duyệt đưa vào
    const dt = Math.min(0.05, Math.max(0, (now - joy.last) / 1000));
    joy.last = now;
    const m = Math.hypot(joy.vx, joy.vy);
    if (m > JOY_DEAD && live()) {
      // Như cần của tay cầm thật: đẩy nhẹ nhích chậm (đường cong, chỉnh được từng chút), đẩy hết cỡ đi
      // đúng tốc độ chuẩn; giữ hết cỡ quá nửa giây thì nhanh dần, tối đa gấp đôi, để đi xa đỡ lâu.
      const s = Math.min(1, (m - JOY_DEAD) / (1 - JOY_DEAD));
      joy.full = s > 0.92 ? joy.full + dt : 0;
      const boost = 1 + Math.min(1, Math.max(0, (joy.full - JOY_BOOST_AFTER) / JOY_BOOST_RAMP));
      const speed = joySpeed() * s ** JOY_CURVE * boost;
      const dx = (joy.vx / m) * speed * dt;
      const dy = (joy.vy / m) * speed * dt;
      client.rel(dx, dy);
      moveGhost(dx, dy);
    } else {
      joy.full = 0;
    }
    requestAnimationFrame(joyStep);
  }
  joyStick.addEventListener('pointerdown', (e) => {
    if (!live() || joy) return;
    e.preventDefault();
    e.stopPropagation();
    joyStick.setPointerCapture?.(e.pointerId);
    joy = { id: e.pointerId, vx: 0, vy: 0, last: performance.now(), full: 0 };
    joyStick.classList.add('active');
    joyAim(e);
    requestAnimationFrame(joyStep);
  });
  joyStick.addEventListener('pointermove', (e) => { if (joy && e.pointerId === joy.id) joyAim(e); });
  const joyEnd = (e) => { if (joy && (!e || e.pointerId === joy.id)) releaseStick(); };
  joyStick.addEventListener('pointerup', joyEnd);
  joyStick.addEventListener('pointercancel', joyEnd);
  function releaseStick() {
    joy = null;
    joyIdleAt = performance.now();
    joyStick.classList.remove('active');
    joyKnob.style.transform = ''; // cần bật về tâm (styles.css)
    // Khớp dấu về chỗ con trỏ thật khi máy báo lần cuối (sau lần dời cuối) đã tới.
    setTimeout(() => { if (!joy && lastCursor) onRemoteCursor(lastCursor.x, lastCursor.y); }, JOY_SETTLE_MS + 20);
  }
  function releaseJoy() {
    if (joy) releaseStick();
    for (const release of joyReleases) release();
  }
  // Bấm nhanh hai lần ở chế độ tay cầm (Y, A liên tiếp để cuộn; chạm vào hình) bị Safari trên iPhone
  // hiểu là chạm đúp phóng to cả trang. Chặn ở cần, bốn nút và khung hình, chỉ ở chế độ tay cầm (hai chế
  // độ kia giữ như cũ). Dãy nút nổi, danh sách xổ, dãy phím vẫn nhận cú chạm thường (cần sự kiện click).
  const blockDoubleTap = (e) => {
    if (handsOff() && e.target?.closest?.('.joy-pad, .screen-viewport')) e.preventDefault();
  };
  stage.addEventListener('touchend', blockDoubleTap, { passive: false });
  stage.addEventListener('dblclick', blockDoubleTap);

  function syncJoyPad() {
    const on = mode === 'joy' && playing;
    stage.classList.toggle('joy-mode', handsOff());
    joyPad.classList.toggle('hidden', !on);
    if (mode !== 'joy') releaseJoy();
    // Vào chế độ tay cầm lúc đang phát: hỏi máy con trỏ đang ở đâu để dấu hiện đúng chỗ ngay.
    if (on && !ghostPos && client?.connected) client.where();
    paintGhost();
  }

  viewport.addEventListener('pointerdown', (e) => {
    if (!live()) return;
    if (e.pointerType === 'mouse') return mouseDown(e);
    e.preventDefault();
    viewport.setPointerCapture?.(e.pointerId);
    const q = local(e);
    pointers.set(e.pointerId, { x: q.x, y: q.y, t: performance.now() });
    if (pointers.size === 1) startOne(q);
    else if (pointers.size === 2) startTwo();
    return undefined;
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!live()) return;
    const q = local(e);
    if (e.pointerType === 'mouse') {
      const r = toRemote(q.x, q.y);
      client.move(r.x, r.y);
      return;
    }
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const now = performance.now();
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const dt = now - p.t;
    p.x = q.x;
    p.y = q.y;
    p.t = now;
    if (pointers.size === 1 && gesture?.kind === 'one') moveOne(p, dx, dy, dt);
    else if (pointers.size === 2 && gesture?.kind === 'two') moveTwo();
  });

  const end = (e) => {
    if (e.pointerType === 'mouse') return mouseUp(e);
    if (!pointers.has(e.pointerId)) return undefined;
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (gesture?.kind === 'one' && pointers.size === 0) endOne(p);
    else if (gesture?.kind === 'two' && pointers.size < 2) endTwo();
    if (pointers.size === 0) gesture = null;
    return undefined;
  };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', (e) => {
    // Hệ điều hành cướp cú chạm (vuốt từ mép, thông báo): bỏ cử chỉ dở; đang kéo thì thả.
    pointers.delete(e.pointerId);
    if (pointers.size) return;
    if (gesture?.drag) setDragArmed(false);
    gesture = null;
  });

  function startOne(q) {
    gesture = { kind: 'one', mode, moved: false, drag: dragArmed, t: performance.now(), sx: q.x, sy: q.y, padX: 0, padY: 0 };
    if (handsOff()) {
      // Tay cầm, tay cầm game: hình chỉ để xem. Đang phóng to thì một ngón kéo khung; chạm không nhấp gì
      // (khỏi bấm nhầm).
      if (zoom.z > 1.01) {
        stopGlide();
        Object.assign(gesture, { pan: true, x0: zoom.x, y0: zoom.y });
      } else gesture.ignore = true;
      return;
    }
    // Chế độ chạm, đang phóng to: rê một ngón là kéo khung xem (chạm vẫn là nhấp). Chưa phóng to thì
    // khung không có chỗ nào để đi, nên rê vẫn là con trỏ theo ngón.
    if (!dragArmed && mode === 'touch' && zoom.z > 1.01) {
      stopGlide();
      Object.assign(gesture, { pan: true, x0: zoom.x, y0: zoom.y });
    }
    if (!dragArmed) return;
    // Nút "Kéo" đang bật: nhấn chuột trái ngay lúc chạm (chế độ chạm: tại chỗ chạm; chế độ chuột:
    // tại con trỏ), rê là kéo.
    if (mode === 'touch') {
      const r = toRemote(q.x, q.y);
      client.moveNow(r.x, r.y);
    }
    holdLeft();
  }

  function moveOne(p, dx, dy, dt) {
    const g = gesture;
    if (g.ignore) return;
    let mx = dx;
    let my = dy;
    if (!g.moved) {
      // Chưa vượt ngưỡng thì vẫn có thể là một cú chạm: chưa dời gì, chỉ cộng dồn quãng ngón đã đi.
      g.padX += dx;
      g.padY += dy;
      if (Math.hypot(p.x - g.sx, p.y - g.sy) <= MOVE_SLOP) return;
      g.moved = true;
      mx = g.padX; // chế độ chuột: quãng đầu còn trong ngưỡng cũng được tính, con trỏ không bị khựng
      my = g.padY;
    }
    if (g.pan) {
      // Khung theo ngón từ chỗ chạm; tới mép hình thì đứng yên (applyZoom kẹp lại).
      zoom.x = g.x0 + (p.x - g.sx);
      zoom.y = g.y0 + (p.y - g.sy);
      applyZoom();
      return;
    }
    if (g.mode === 'touch') {
      // Con trỏ theo ngón; chỉ giữ nút khi nút "Kéo" đã bật (xem startOne).
      const r = toRemote(p.x, p.y);
      client.move(r.x, r.y);
      return;
    }
    // Ngón đi càng nhanh con trỏ đi càng xa. Tốc độ tính theo thời gian, nên màn 60 Hz hay 120 Hz như nhau.
    const speed = Math.hypot(dx, dy) / Math.max(4, dt);
    const gain = remotePxPerCss() * (1 + Math.min(speed / PAD_FAST, PAD_BOOST_MAX));
    client.rel(mx * gain, my * gain);
  }

  // Mọi quyết định nhấp đều đợi lúc nhấc ngón, không có hẹn giờ nào bấm hộ khi ngón còn trên màn:
  // chạm nhanh = nhấp trái; giữ yên đủ lâu rồi nhấc = nhấp phải; đã rê thì chỉ là dời con trỏ.
  function endOne(p) {
    const g = gesture;
    if (g.drag) {
      if (g.mode === 'touch') {
        const r = toRemote(p.x, p.y);
        client.moveNow(r.x, r.y);
      }
      setDragArmed(false); // nhả nút, tắt "Kéo": mỗi lần bật là một cú kéo
      return;
    }
    if (g.moved || g.mode === 'joy') return;
    if (g.mode === 'touch') {
      const r = toRemote(g.sx, g.sy);
      client.moveNow(r.x, r.y);
    }
    client.click(performance.now() - g.t >= LONG_PRESS_MS ? 1 : 0);
  }

  function twoInfo() {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  function startTwo() {
    // Ngón thứ hai chạm xuống giữa một cú kéo: thả nút, tắt "Kéo" (hai ngón là phóng to, cuộn).
    if (gesture?.kind === 'one' && gesture.drag) setDragArmed(false);
    stopGlide(); // hai ngón tự dời khung thì thôi trượt theo con trỏ
    // Ngón đầu đã kéo khung đi: chụm hay kéo hai ngón tính tiếp từ chỗ khung đang đứng.
    const info = twoInfo();
    gesture = {
      kind: 'two', mode, what: null, t: performance.now(), dist0: info.dist, mx0: info.mx, my0: info.my,
      lastMx: info.mx, lastMy: info.my, z0: zoom.z, x0: zoom.x, y0: zoom.y, acc: 0, accX: 0,
    };
  }

  function moveTwo() {
    const g = gesture;
    const info = twoInfo();
    if (!g.what) {
      if (Math.abs(info.dist - g.dist0) / Math.max(1, g.dist0) > 0.12) g.what = 'pinch';
      else if (Math.hypot(info.mx - g.mx0, info.my - g.my0) > 10) g.what = zoom.z > 1.01 ? 'pan' : 'scroll';
      else return;
    }
    if (g.what === 'pinch') {
      // Giữ đúng điểm nội dung dưới tâm hai ngón khi phóng to (toạ độ trong khung, xem local()).
      const left = fit.left;
      const top = fit.top;
      const z = Math.min(ZOOM_MAX, Math.max(1, g.z0 * (info.dist / g.dist0)));
      const ux = (g.mx0 - left - g.x0) / g.z0;
      const uy = (g.my0 - top - g.y0) / g.z0;
      zoom.z = z;
      zoom.x = info.mx - left - ux * z;
      zoom.y = info.my - top - uy * z;
      applyZoom();
    } else if (g.what === 'pan') {
      zoom.x = g.x0 + (info.mx - g.mx0);
      zoom.y = g.y0 + (info.my - g.my0);
      applyZoom();
    } else {
      g.acc += (info.my - g.lastMy) * WHEEL_PER_PX;
      g.accX += (info.mx - g.lastMx) * WHEEL_PER_PX;
      if (Math.abs(g.acc) >= 30 || Math.abs(g.accX) >= 30) {
        client.wheel(Math.round(g.acc), Math.round(-g.accX));
        g.acc = 0;
        g.accX = 0;
      }
    }
    g.lastMx = info.mx;
    g.lastMy = info.my;
  }

  function endTwo() {
    const g = gesture;
    if (!g.what && performance.now() - g.t < TAP_MS) {
      // Chạm hai ngón: nhấp phải (chế độ chạm: tại tâm hai ngón; chế độ chuột: tại con trỏ).
      if (g.mode === 'touch') {
        const r = toRemote(g.mx0, g.my0);
        client.moveNow(r.x, r.y);
      }
      client.click(1);
    }
    if (g.what === 'pinch' || g.what === 'pan') renderControls();
    gesture = { kind: 'done' }; // ngón còn lại không được tính thành một lần chạm mới
  }

  // Chuột thật: nút DOM 0 trái, 1 giữa, 2 phải; phía máy 0 trái, 1 phải, 2 giữa.
  const mouseButton = (b) => (b === 2 ? 1 : b === 1 ? 2 : 0);
  function mouseDown(e) {
    e.preventDefault();
    viewport.setPointerCapture?.(e.pointerId);
    // Máy tính có bàn phím thật: bấm vào hình là bàn phím gõ thẳng sang máy, không phải mở dãy phím
    // trước (phím chỉ đi sang máy khi ô nhập ẩn giữ tiêu điểm). Chuột vừa bấm vào hình nên tiêu điểm
    // rời ô soạn của trang, không gõ lẫn vào chỗ khác. Màn chạm không làm vậy: sẽ mọc bàn phím ảo mỗi
    // lần chạm.
    if (document.activeElement !== sink) {
      sink.focus({ preventScroll: true });
      syncKeyboardUi();
    }
    const q = local(e);
    const p = toRemote(q.x, q.y);
    client.moveNow(p.x, p.y);
    client.button(mouseButton(e.button), true);
  }
  function mouseUp(e) {
    if (!live()) return;
    client.button(mouseButton(e.button), false);
  }
  viewport.addEventListener('contextmenu', (e) => e.preventDefault());
  viewport.addEventListener('wheel', (e) => {
    if (!live()) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 40 : 1;
    client.wheel(Math.round(-e.deltaY * unit * 1.2), Math.round(e.deltaX * unit * 1.2));
  }, { passive: false });

  // ---- Bàn phím ----------------------------------------------------------------------------
  let sinkValue = '';
  let composing = false;

  // Dãy phím (Esc, Tab, mũi tên, phím bổ trợ) là bàn phím thay thế cho màn chạm, nên màn chạm hiện nó
  // ngay khi gõ được. Máy tính đã có bàn phím thật nên chỉ hiện khi người dùng tự mở bằng nút, để bấm
  // những phím bàn phím thật không gửi đi được (Ctrl+Alt+Del) mà không che hình mỗi lần bấm vào hình.
  let keybarWanted = false;
  let kbdUi = { typing: false, bar: false };

  function toggleKeyboard() {
    if (!keybar.classList.contains('hidden')) {
      keybarWanted = false;
      sink.blur();
    } else {
      // Bàn phím iPhone luôn mọc theo chiều dọc của máy: thôi xem ngang để dãy phím nằm đúng chỗ.
      if (rotated) setRotated(false);
      keybarWanted = true;
      sink.focus({ preventScroll: true });
    }
    // Không chỉ trông vào sự kiện focus/blur: trang chưa có tiêu điểm hệ thống thì trình duyệt hoãn chúng.
    syncKeyboardUi();
  }
  function syncKeyboardUi() {
    const typing = document.activeElement === sink; // phím đang đi sang máy
    if (!typing) keybarWanted = false;
    const bar = typing && (keybarWanted || Boolean(coarsePointer?.matches));
    if (kbdUi.typing === typing && kbdUi.bar === bar) return;
    kbdUi = { typing, bar };
    keybar.classList.toggle('hidden', !bar);
    stage.classList.toggle('kbd', bar); // nút tròn và dãy nút nổi đứng trên dãy phím (styles.css)
    if (bar) updateKeyboardOffset();
    // Chỉ đổi màu nút Bàn phím tại chỗ, không dựng lại dãy nút: tiêu điểm rời ô nhập đúng lúc nhấn chuột
    // xuống một nút khác, mà nút bị thay bằng nút mới giữa lúc nhấn và lúc nhả thì trình duyệt bỏ cú bấm
    // (bấm vào hình rồi bấm nút nguồn hình, chế độ... phải bấm hai lần mới xổ danh sách).
    for (const b of kbdButtons) b.classList.toggle('on', typing);
  }
  sink.addEventListener('focus', syncKeyboardUi);
  sink.addEventListener('blur', syncKeyboardUi);

  for (const k of KEYBAR) {
    const b = h('button', {
      class: `key${k.mod ? ' mod' : ''}`,
      // Giữ bàn phím mở: không cho nút cướp tiêu điểm của ô nhập.
      onpointerdown: (e) => e.preventDefault(),
      onclick: () => {
        if (!live()) return;
        if (k.mod) {
          if (mods.has(k.mod)) mods.delete(k.mod); else mods.add(k.mod);
          b.classList.toggle('on', mods.has(k.mod));
          return;
        }
        pressVk(k.vk);
      },
    }, k.label);
    keybar.append(b);
  }

  function releaseMods() {
    for (const m of mods) client.key(m, false);
    mods.clear();
    for (const b of keybar.querySelectorAll('.mod.on')) b.classList.remove('on');
  }

  function pressVk(vk) {
    for (const m of mods) client.key(m, true);
    client.tapKey(vk);
    releaseMods();
  }

  // Xuống dòng (Enter trên bàn phím thật, phím Return của bàn phím ảo) phải đi bằng mã phím: máy gõ chữ
  // bằng VkKeyScan, mà ký tự 0x0A cho ra Ctrl+Enter (đo trên Windows: 0x020D) chứ không phải Enter, nên
  // ô mật khẩu của màn khoá không nhận.
  function typeText(text) {
    if (!text) return;
    const lines = String(text).split(/\r\n|[\r\n]/);
    for (let i = 0; i < lines.length; i += 1) {
      if (i) pressVk(13);
      const part = lines[i];
      if (!part) continue;
      if (mods.size) {
        // Có Ctrl/Alt/Win đang giữ: chữ và số đi bằng mã phím để thành phím tắt (Ctrl+C, Win+R...).
        for (const ch of part) {
          if (/^[a-z0-9]$/i.test(ch)) pressVkKeepMods(ch.toUpperCase().charCodeAt(0));
          else client.text(ch);
        }
        releaseMods();
      } else {
        client.text(part);
      }
    }
  }

  function pressVkKeepMods(vk) {
    for (const m of mods) client.key(m, true);
    client.tapKey(vk);
  }

  // So nội dung ô nhập trước và sau mỗi lần đổi: bàn phím tiếng Việt (Telex, VNI), gõ đoán và sửa
  // chính tả trên iPhone đều thay chữ đã gõ, nên phải gửi đúng số phím xoá rồi phần chữ mới.
  function syncSink() {
    if (composing || !live()) return;
    const next = sink.value;
    let same = 0;
    while (same < sinkValue.length && same < next.length && sinkValue[same] === next[same]) same += 1;
    for (let i = same; i < sinkValue.length; i += 1) client.tapKey(8);
    typeText(next.slice(same));
    sinkValue = next;
    if (next.length > 80 || next.endsWith('\n')) {
      sink.value = '';
      sinkValue = '';
    }
  }
  sink.addEventListener('input', syncSink);
  sink.addEventListener('compositionstart', () => { composing = true; });
  sink.addEventListener('compositionend', () => { composing = false; syncSink(); });
  sink.addEventListener('keydown', (e) => {
    if (!live()) return;
    // Xoá khi ô đã trống thì không có sự kiện input: gửi thẳng phím xoá.
    if (e.key === 'Backspace' && !sink.value) {
      e.preventDefault();
      pressVk(8);
      return;
    }
    // Ctrl+V: để trình duyệt bắn sự kiện dán, clip.onPaste đọc thứ đang copy ở máy này. Không có sự kiện nào
    // (trình duyệt chặn) thì chốc lát sau gửi Ctrl+V như cũ để máy kia dán clipboard của nó.
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.code === 'KeyV' || e.key.toLowerCase() === 'v')) {
      pasteShift = e.shiftKey; // Ctrl+Shift+V (dán chữ trơn) sang máy kia vẫn giữ Shift
      clearTimeout(pasteFallback);
      pasteFallback = setTimeout(pasteThere, PASTE_FALLBACK_MS);
      return;
    }
    const named = VK[e.key];
    const shortcut = (e.ctrlKey || e.altKey || e.metaKey) && /^[a-z0-9]$/i.test(e.key);
    if (shortcut) {
      e.preventDefault();
      const held = [e.ctrlKey && 17, e.altKey && 18, e.metaKey && 91, e.shiftKey && 16].filter(Boolean);
      for (const m of held) client.key(m, true);
      client.tapKey(e.key.toUpperCase().charCodeAt(0));
      for (const m of held.reverse()) client.key(m, false);
      if (e.ctrlKey && /^[cx]$/i.test(e.key)) clip.remoteCopied(); // vừa copy trên máy kia
    } else if (named && e.key.length > 1 && e.key !== 'Enter' && e.key !== 'Backspace' && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
      // Phím không ra chữ (mũi tên, Esc, F5...) trên bàn phím thật: gửi mã phím.
      e.preventDefault();
      pressVk(named);
    }
  });

  // ---- Clipboard hai chiều với máy kia (clip-sync.js) ---------------------------------------------------
  // Ctrl+V trên hình đưa thứ đang copy ở máy này sang (nếu nó mới hơn clipboard máy kia); copy trên máy kia
  // thì về máy này; bản PC còn đưa sẵn thứ vừa copy ở máy này sang, nên chuột phải → Paste bên đó cũng dán được.
  let pasteFallback = null;
  let pasteShift = false;
  const clip = createClipSync(machine.id, {
    live,
    client: () => client,
    machineName: machine.name,
    toast,
    show: (s) => {
      clipBadge.classList.toggle('hidden', !s);
      if (!s) return;
      clipText.textContent = s.text;
      clipCancel.classList.toggle('hidden', !s.cancel);
      clipAction.classList.toggle('hidden', !s.action);
      clipAction.textContent = s.action?.label || '';
      clipAction.onclick = s.action ? () => s.action.run() : null;
    },
  });
  const pasteThere = () => {
    clip.pasteThere(pasteShift);
    pasteShift = false;
  };

  sink.addEventListener('paste', (e) => {
    clearTimeout(pasteFallback);
    if (!live()) return;
    e.preventDefault();
    // Lấy hết ngay trong sự kiện: xong sự kiện là trình duyệt khoá dữ liệu dán (tệp đã lấy vẫn đọc được).
    const d = e.clipboardData;
    const text = d?.getData('text/plain') || '';
    const files = d ? [...d.files] : [];
    const entries = d ? [...d.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.() || null) : [];
    clip.onPaste({ text, files, entries: entries.length === files.length ? entries : [], shift: pasteShift });
    pasteShift = false;
  });

  // Bàn phím iPhone che nửa dưới màn hình: đẩy dãy phím lên ngay trên bàn phím.
  function updateKeyboardOffset() {
    const vv = window.visualViewport;
    if (!vv) return;
    const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    stage.style.setProperty('--kb-offset', `${offset}px`);
  }
  window.visualViewport?.addEventListener('resize', updateKeyboardOffset);
  window.visualViewport?.addEventListener('scroll', updateKeyboardOffset);

  // ---- Ẩn app thì dừng, mở lại thì phát tiếp ----------------------------------------------------
  function onVisibility() {
    if (document.hidden && playing) {
      resumeOnShow = true;
      stop();
    } else if (!document.hidden && resumeOnShow) {
      resumeOnShow = false;
      play();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  setOverlay(machine.online ? '' : 'Máy đang tắt hoặc mất mạng.', { showPlay: machine.online });
  renderControls();

  return {
    setOnline(online) {
      if (!online && playing) stop();
      if (!playing) setOverlay(online ? '' : 'Máy đang tắt hoặc mất mạng.', { showPlay: online });
    },
    destroy() {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFsChange);
      phoneLandscape?.removeEventListener?.('change', onOrientation);
      window.removeEventListener?.('resize', onWindowResize);
      clearTimeout(orientTimer);
      window.visualViewport?.removeEventListener('resize', updateKeyboardOffset);
      window.visualViewport?.removeEventListener('scroll', updateKeyboardOffset);
      resizeObserver.disconnect();
      if (fullscreen) setFullscreen(false);
      endGestures();
      clip.stop();
      client?.close();
      client = null;
      panel.remove();
    },
  };
}
