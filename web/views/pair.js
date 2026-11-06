// Ghép thiết bị bằng mã QR.
//
// Trên thiết bị đã ghép (thường là máy tính): bảng hiện mã QR chứa địa chỉ trạm kèm mã ghép
// đôi. Điện thoại quét bằng app Camera có sẵn là mở thẳng trang ghép, không phải gõ gì.
//
// Trên điện thoại vừa quét (trình duyệt thường, chưa cài app): trang hướng dẫn thêm vào màn
// hình chính. Mã được GIỮ trong địa chỉ trang và trong địa chỉ khởi động của manifest, để app
// mở lần đầu từ màn hình chính tự ghép, dù iOS lấy địa chỉ khởi động từ manifest hay từ trang.

import { h, add, clear, toast, copyText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { encodeQR, qrToSvg } from '../lib/qr.js';
import { openSheet } from './sheets.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const isLoopbackHost = (host) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]';

// Các địa chỉ điện thoại có thể dùng để tới trạm, cái nên dùng nhất đứng đầu. Có Tailscale thì địa
// chỉ tailnet đứng đầu: app cài từ đó dùng được mọi nơi (điện thoại bật Tailscale). Sau đó là địa chỉ
// mạng nhà.
function phoneTargets() {
  const hub = store.hub || {};
  const out = [];
  const push = (url, label) => { if (url && !out.some((t) => t.url === url)) out.push({ url, label }); };
  for (const u of hub.tailnet?.urls || []) push(u, out.length ? 'Tailscale (tên)' : 'Tailscale, mọi nơi');
  for (const a of hub.addresses || []) push(a.url, `Mạng nhà (${a.label})`);
  if (!isLoopbackHost(location.hostname)) push(location.origin, 'Địa chỉ đang dùng');
  return out;
}

export function openPairSheet() {
  const { body } = openSheet('Ghép điện thoại');
  const targets = phoneTargets();
  let target = targets[0];
  let code = '';
  let expires = 0;
  const qrBox = h('div', { class: 'qr-box' });
  const codeLine = h('div', { class: 'qr-code-line' });
  const expiry = h('div', { class: 'field-hint center' });
  const chips = h('div', { class: 'chip-row wrap center' });

  function draw() {
    clear(qrBox);
    if (!target) {
      qrBox.append(h('div', { class: 'empty small' }, 'Trạm chưa có địa chỉ nào điện thoại tới được (đang chỉ nghe trên 127.0.0.1).'));
      return;
    }
    const url = `${target.url}/?pair=${code}`;
    // SVG do chính bộ mã hoá sinh ra, không chứa chữ nào từ ngoài vào.
    qrBox.append(h('div', { class: 'qr', html: qrToSvg(encodeQR(url), { margin: 3 }) }),
      h('button', { class: 'qr-url', onclick: () => copyText(url) }, url));
    clear(chips);
    if (targets.length > 1) {
      for (const t of targets) {
        chips.append(h('button', { class: `chip small${t === target ? ' active' : ''}`, onclick: () => { target = t; draw(); } }, t.label));
      }
    }
  }

  async function fresh() {
    try {
      ({ code } = await api.post('/api/pair-code'));
      expires = Date.now() + CODE_TTL_MS;
      codeLine.textContent = code.replace(/(\d{3})(\d{3})/, '$1 $2');
      expiry.textContent = `Dùng một lần, còn hiệu lực tới ${new Date(expires).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}.`;
      draw();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  add(body,
    h('div', { class: 'qr-steps' },
      h('div', null, h('b', null, '1. '), 'Mở app ', h('b', null, 'Camera'), ' trên iPhone, hướng vào mã, chạm vào đường dẫn hiện ra.'),
      h('div', null, h('b', null, '2. '), 'Safari mở trang ghép: làm theo hướng dẫn để thêm Orbit Remote vào màn hình chính.')),
    qrBox, chips, codeLine, expiry,
    h('div', { class: 'btn-row center' }, h('button', { class: 'btn small ghost', onclick: fresh }, 'Mã mới')),
    h('div', { class: 'field-hint' }, 'Điện thoại phải tới được địa chỉ trong mã. Địa chỉ "Tailscale" cần điện thoại cài app Tailscale, đăng nhập cùng tài khoản với máy giữ trạm và đang bật. Địa chỉ ở nhà cần cùng wifi với máy giữ trạm.'));
  fresh();
}

// ---- Trang trên điện thoại vừa quét mã --------------------------------------------------
export function isStandalone() {
  return navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
}

export function mobilePlatform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return 'ios';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return '';
}

export function showInstallGuide(root, code, { onUseHere }) {
  const ios = mobilePlatform() === 'ios';
  const shareIcon = h('span', { class: 'share-glyph', 'aria-hidden': 'true' },
    h('span', { html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>' }));
  const useHere = h('button', { class: 'btn ghost block', onclick: async () => {
    useHere.disabled = true;
    try {
      await onUseHere();
    } finally {
      useHere.disabled = false;
    }
  } }, `Dùng luôn trong ${ios ? 'Safari' : 'trình duyệt'}`);
  clear(root).append(h('div', { class: 'view pair install' },
    h('div', { class: 'pair-hero' },
      h('div', { class: 'pair-orb' }, h('img', { src: '/icons/icon-192.png', alt: '' })),
      h('div', { class: 'brand big' }, 'Orbit Remote'),
      h('div', { class: 'pair-sub' }, 'Đã quét mã. Còn hai bước nữa.')),
    h('ol', { class: 'install-steps' },
      ios
        ? h('li', null, 'Bấm nút ', h('b', null, 'Chia sẻ'), ' ', shareIcon, ' ở thanh dưới Safari, chọn ', h('b', null, 'Thêm vào Màn hình chính'), '.')
        : h('li', null, 'Mở menu ', h('b', null, '⋮'), ' của trình duyệt, chọn ', h('b', null, 'Cài đặt ứng dụng'), ' hoặc ', h('b', null, 'Thêm vào màn hình chính'), '.'),
      h('li', null, 'Mở ', h('b', null, 'Orbit Remote'), ' từ màn hình chính. App tự ghép đôi, không phải gõ gì.')),
    h('div', { class: 'install-fallback' },
      h('div', { class: 'field-hint center' }, 'Nếu app mở ra mà vẫn hỏi mã, nhập:'),
      h('div', { class: 'qr-code-line' }, code.replace(/(\d{3})(\d{3})/, '$1 $2')),
      h('div', { class: 'field-hint center' }, 'Mã dùng một lần, sống 10 phút kể từ lúc hiện trên máy tính.')),
    useHere));
}
