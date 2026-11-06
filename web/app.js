// Lối vào của app: ghép đôi, định tuyến, nối luồng sự kiện, nạp phần tuỳ biến.

import { h, clear, toast } from './lib/dom.js';
import { api, ApiError } from './lib/api.js';
import { store } from './lib/store.js';
import { loadExtension } from './lib/custom.js';
import { mountHome } from './views/home.js';
import { mountSession } from './views/session.js';
import { mountSettings, applyPrefs } from './views/settings.js';
import { mountChannel } from './views/channel.js';
import { openNewSession } from './views/sheets.js';
import { mountMachine, mountExternal } from './views/machines.js';
import { mountGroup } from './views/group.js';
import { openPairSheet, showInstallGuide, isStandalone, mobilePlatform } from './views/pair.js';

const app = document.getElementById('app');
let unmount = null;

// Màn rộng (bản PC, iPad ngang, trình duyệt máy tính): hai cột. Cột trái luôn là màn chính (máy, phiên),
// cột phải là màn đang mở (phiên, máy, cài đặt...). Màn hẹp giữ một cột như trên điện thoại.
const wide = window.matchMedia?.('(min-width: 1100px)') || null;
let side = null; // { el, main, unmount } khi đang hai cột
function panes() {
  if (wide?.matches) {
    if (!side) {
      clear(app);
      const el = h('aside', { class: 'pane-side' }, sideResizer());
      const main = h('section', { class: 'pane-main' });
      app.classList.add('split');
      applySideWidth(savedSideWidth());
      app.append(el, main);
      side = { el, main, unmount: mountHome(el) };
    }
    return side.main;
  }
  dropPanes();
  return app;
}

// Thanh dọc giữa hai cột: kéo sang trái phải để đổi bề rộng cột trái, nhớ cho lần sau; nháy đúp là về
// bề rộng mặc định. Bề rộng giới hạn để cột phải luôn còn đủ chỗ cho hội thoại và màn hình máy.
const SIDE_MIN = 260;
const SIDE_KEY = 'orbit-side-width';
const sideMax = () => Math.max(SIDE_MIN, Math.min(640, window.innerWidth - 560));
function savedSideWidth() {
  try {
    return Number(localStorage.getItem(SIDE_KEY)) || 0;
  } catch {
    return 0;
  }
}
// 0: bề rộng mặc định của styles.css (theo cỡ cửa sổ).
function applySideWidth(px) {
  if (px) app.style.setProperty('--side-w', `${Math.round(Math.min(sideMax(), Math.max(SIDE_MIN, px)))}px`);
  else app.style.removeProperty('--side-w');
}
function sideResizer() {
  const bar = h('div', { class: 'pane-resizer', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Kéo để đổi bề rộng cột trái', title: 'Kéo để đổi bề rộng · nháy đúp để về mặc định' });
  let drag = null; // { id, left, frame, x }
  const apply = () => {
    drag.frame = 0;
    applySideWidth(drag.x - drag.left);
  };
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, left: app.getBoundingClientRect().left, frame: 0, x: e.clientX };
    document.documentElement.classList.add('resizing');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    if (!drag.frame) drag.frame = requestAnimationFrame(apply); // mỗi nhịp màn hình đổi một lần
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    cancelAnimationFrame(drag.frame);
    applySideWidth(drag.x - drag.left);
    drag = null;
    document.documentElement.classList.remove('resizing');
    try {
      localStorage.setItem(SIDE_KEY, String(parseInt(app.style.getPropertyValue('--side-w'), 10) || ''));
    } catch {
      // trình duyệt chặn lưu: chỉ mất phần nhớ bề rộng
    }
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', () => {
    applySideWidth(0);
    try {
      localStorage.removeItem(SIDE_KEY);
    } catch {
      // như trên
    }
  });
  return bar;
}
// Cửa sổ thu nhỏ lại: bề rộng đã nhớ vượt giới hạn mới thì kẹp lại.
window.addEventListener('resize', () => { if (side) applySideWidth(savedSideWidth()); });
function dropPanes() {
  if (!side) return;
  side.unmount();
  side = null;
  app.classList.remove('split');
  app.style.removeProperty('--side-w');
  clear(app);
}

// Cột phải lúc chưa chọn gì.
function mountWelcome(root) {
  const online = [...store.machines.values()].filter((m) => m.online).length;
  root.append(h('div', { class: 'view welcome' },
    h('div', { class: 'welcome-body' },
      h('img', { class: 'welcome-icon', src: '/icons/icon-192.png', alt: '' }),
      h('div', { class: 'welcome-title' }, 'Orbit Remote'),
      h('div', { class: 'welcome-text' }, online
        ? 'Chọn một máy để xem và điều khiển màn hình, hay một phiên để làm việc với Claude.'
        : 'Chưa có máy nào đang nối vào trạm.'),
      online ? h('button', { class: 'btn primary', onclick: () => openNewSession() }, 'Mở phiên mới') : null)));
  return () => {};
}

// Bàn phím iOS thu nhỏ vùng nhìn thấy mà không thu nhỏ trang; lúc bàn phím mở thì app bám theo
// visualViewport để ô soạn luôn nằm ngay trên bàn phím thay vì bị che. Lúc bàn phím đóng thì app phủ
// kín màn bằng CSS (styles.css, .app): ở chế độ app cài trên màn hình chính, visualViewport.height của
// iOS đã trừ hai vùng an toàn trên dưới, lấy số đó làm chiều cao thì đáy app hụt một dải.
const KEYBOARD_MIN_PX = 150; // vùng nhìn thấy thấp hơn trang cỡ này trở lên thì coi là bàn phím đang mở
function trackViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const set = () => {
    const height = vv ? vv.height : window.innerHeight;
    const page = Math.max(window.innerHeight, root.clientHeight);
    const keyboard = page - height > KEYBOARD_MIN_PX;
    root.classList.toggle('kbd-open', keyboard);
    if (keyboard) root.style.setProperty('--app-h', `${height}px`);
    else root.style.removeProperty('--app-h');
    if (vv) window.scrollTo(0, 0);
  };
  set();
  (vv || window).addEventListener('resize', set);
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Máy tính Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'Thiết bị';
}

function showPairing(prefill = '') {
  unmount?.();
  unmount = null;
  dropPanes();
  clear(app);
  const code = h('input', {
    class: 'input pair-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7,
    placeholder: '000 000', value: prefill,
  });
  const name = h('input', { class: 'input', value: guessDeviceName(), maxlength: 60 });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Ghép đôi');
  app.append(h('div', { class: 'view pair' },
    h('div', { class: 'pair-hero' },
      h('div', { class: 'pair-orb' }, h('img', { src: '/icons/icon-192.png', alt: '' })),
      h('div', { class: 'brand big' }, 'Orbit Remote'),
      h('div', { class: 'pair-sub' }, 'Điều khiển mọi phiên Claude trên mọi máy.')),
    h('form', {
      class: 'form pair-form',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          await api.post('/api/pair', { code: code.value.replace(/\D/g, ''), name: name.value });
          start();
        } catch (err) {
          toast(err.message, 'error');
          submit.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Mã ghép đôi'), code,
      h('span', { class: 'field-hint' }, 'Lấy mã trên một thiết bị đã ghép (điện thoại hay máy tính): Cài đặt → Ghép điện thoại bằng mã QR. Bảng đó có mã QR để quét bằng app Camera và mã 6 số để gõ vào đây. Hoặc chạy "node src/main.mjs pair" trên máy giữ trạm.')),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Tên thiết bị này'), name),
    submit)));
  if (!prefill) setTimeout(() => code.focus(), 300);
}

function route() {
  unmount?.();
  unmount = null;
  const root = panes();
  clear(root);
  const hash = location.hash || '#/';
  // #/s/<phiên>/g/<nhóm> hay #/s/<phiên>/m/<máy>: mở từ màn một nhóm hay một máy, nút quay lại của màn phiên đưa về
  // đúng màn đó; mở từ màn chính (#/s/<phiên>) thì về màn chính.
  const session = /^#\/s\/([\w-]+)(?:\/([gm])\/([\w-]+))?/.exec(hash);
  // #/m/<máy>/s/<phiên>[/g/<nhóm>]: mở từ màn một phiên, nút quay lại của màn máy đưa về đúng phiên đó (giữ cả nhóm).
  const machine = /^#\/m\/([\w-]+)(?:\/s\/([\w-]+)(?:\/g\/([\w-]+))?)?/.exec(hash);
  const external = /^#\/x\/([\w-]+)\/([0-9a-f-]{36})/i.exec(hash);
  const group = /^#\/g\/([\w-]+)/.exec(hash);
  if (session) unmount = mountSession(root, session[1], { fromGroup: session[2] === 'g' ? session[3] : '', fromMachine: session[2] === 'm' ? session[3] : '' });
  else if (group) unmount = mountGroup(root, group[1]);
  else if (machine) unmount = mountMachine(root, machine[1], { fromSession: machine[2] || '', fromGroup: machine[3] || '' });
  else if (external) unmount = mountExternal(root, external[1], external[2]);
  else if (hash.startsWith('#/settings')) unmount = mountSettings(root);
  else if (hash.startsWith('#/channel')) unmount = mountChannel(root);
  else unmount = side ? mountWelcome(root) : mountHome(root);
  store.emit('route', hash); // cột trái đánh dấu máy hay phiên đang mở
}

let started = false;
async function start() {
  const state = await api.get('/api/state');
  store.applyState(state);
  if (!started) {
    started = true;
    window.addEventListener('hashchange', route);
    wide?.addEventListener?.('change', route); // kéo cửa sổ hẹp lại hay rộng ra: đổi giữa một và hai cột
    store.on('open-new-session', (preset) => openNewSession(preset));
    store.connect();
    store.loadActions();
    store.loadTokens();
    store.loadModels();
    loadExtension();
    // Quay lại app sau khi để nền lâu: iOS có thể đã cắt luồng sự kiện, nối lại ngay.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && store.source?.readyState === EventSource.CLOSED) store.connect();
    });
  }
  route();
}

async function boot() {
  applyPrefs();
  trackViewport();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('orbit:unpaired', () => {
    store.source?.close();
    showPairing();
  });

  const params = new URLSearchParams(location.search);
  const pairCode = /^\d{6}$/.test(params.get('pair') || '') ? params.get('pair') : '';
  const wantsPhonePair = params.get('phone') === '1'; // run.cmd mở app kèm cờ này: hiện ngay mã QR cho điện thoại
  const stripQuery = () => history.replaceState(null, '', location.pathname + location.hash);
  const redeem = async () => {
    await api.post('/api/pair', { code: pairCode, name: guessDeviceName() });
    stripQuery();
  };

  try {
    let ping = await api.get('/api/ping');
    // Đã ghép rồi thì bỏ qua mã trong địa chỉ: chạy lại run.cmd không được sinh thêm một
    // "thiết bị" trùng mỗi lần (đã gặp thật: một trình duyệt thành hai thiết bị).
    if (pairCode && !ping.paired) {
      // Điện thoại vừa quét QR, đang ở trình duyệt thường: hướng dẫn cài app thay vì tiêu mã
      // ở đây, để app trên màn hình chính tự ghép bằng chính mã này. Mã giữ nguyên trong địa chỉ.
      if (mobilePlatform() && !isStandalone()) {
        showInstallGuide(app, pairCode, {
          onUseHere: async () => {
            try {
              await redeem();
              await start();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        });
        return;
      }
      try {
        await redeem();
        ping = await api.get('/api/ping');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    if (pairCode || wantsPhonePair) stripQuery();
    if (!ping.paired) {
      showPairing();
      return;
    }
    await start();
    if (wantsPhonePair) openPairSheet();
  } catch (err) {
    // Không nối được (mạng rớt; trạm hay đầu máy đang khởi động lại: bản PC đi qua cổng app nằm trong đầu
    // máy, cổng tắt vài giây mỗi lần Setup máy): tự hỏi lại trạm vài giây một lần, tới được thì tải lại trang.
    // Trạm trả lời mà báo lỗi khác thì chờ người bấm, không tải lại vòng vòng.
    const unreachable = !(err instanceof ApiError) || [502, 503, 504].includes(err.status);
    clear(app).append(h('div', { class: 'view' }, h('div', { class: 'empty' },
      h('div', { class: 'empty-title' }, 'Không với tới trạm'),
      h('div', { class: 'empty-text' }, err.message),
      unreachable ? h('div', { class: 'empty-text' }, 'Đang tự thử lại, nối được là vào ngay.') : null,
      h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Thử lại'))));
    if (unreachable) {
      const again = () => setTimeout(() => api.get('/api/ping').then(() => location.reload(), again), 3000);
      again();
    }
  }
}

boot();
