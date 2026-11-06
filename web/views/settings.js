// Cài đặt: thiết bị đã ghép, ghép thêm thiết bị hay máy, sửa nút tuỳ biến, giao diện.

import { h, clear, timeAgo, toast, copyText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { openPairSheet } from './pair.js';

const ACTIONS_EXAMPLE = `{
  "actions": [
    { "label": "Báo tiến độ", "scope": "session", "send": "Tóm tắt tiến độ trong 3 câu." },
    { "label": "Commit", "scope": "session", "send": "Commit các thay đổi hiện tại. Không push.", "confirm": "Commit?" },
    { "label": "Viết thêm …", "scope": "session", "fill": "Viết thêm " },
    { "label": "Hỏi mọi phiên", "scope": "home", "broadcast": "Đang làm gì? Trả lời một câu." },
    { "label": "Dự án của tôi", "scope": "home",
      "newSession": { "cwd": "D:\\\\Projects\\\\MyApp", "name": "MyApp", "permissionMode": "acceptEdits" } }
  ]
}`;

export function applyPrefs() {
  const size = Number(localStorage.getItem('orbit-font') || 15);
  document.documentElement.style.setProperty('--font-size', `${size}px`);
  document.documentElement.classList.toggle('compact', localStorage.getItem('orbit-compact') === '1');
}

function section(title, ...children) {
  return h('section', { class: 'settings-section' }, h('h2', null, title), ...children);
}

const cmd = (text) => h('div', { class: 'copy-box' }, h('code', null, text), h('button', { class: 'icon-btn', 'aria-label': 'Chép', onclick: () => copyText(text) }, icon('copy', 18)));

// Dùng khi ra ngoài: cho biết app đang mở bằng địa chỉ nào, địa chỉ đó có dùng được khi rời mạng nhà không,
// và cách vào trạm từ mọi nơi qua Tailscale.
function remoteSection() {
  const hub = store.hub || {};
  const here = location.hostname;
  const lan = /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(here) || here === '127.0.0.1' || here === 'localhost';
  const tailnetUrls = hub.tailnet?.urls || [];
  const onTailnet = tailnetUrls.some((u) => new URL(u).origin === location.origin);
  const status = onTailnet
    ? h('div', { class: 'notice ok' }, 'App đang mở qua Tailscale: dùng được cả ở nhà lẫn khi ra ngoài, miễn điện thoại bật Tailscale.')
    : lan ? h('div', { class: 'notice warn' }, 'App đang mở bằng địa chỉ mạng nhà. Ra khỏi wifi này thì không vào được trạm.')
      : null;
  const children = [status];
  if (tailnetUrls.length) {
    children.push(h('div', { class: 'field-hint' }, 'Địa chỉ qua Tailscale (điện thoại và máy khác cài Tailscale, đăng nhập cùng tài khoản):'), cmd(tailnetUrls[0]));
  } else {
    children.push(
      h('div', { class: 'field-hint' }, 'Trạm chưa khai địa chỉ Tailscale. Làm trên máy giữ trạm, trong thư mục Orbit Remote:'),
      h('ol', { class: 'steps' },
        h('li', null, 'Cài Tailscale (https://tailscale.com/download) và đăng nhập, rồi khai địa chỉ Tailscale của trạm:'),
        cmd('node src/main.mjs tailnet setup'),
        h('li', null, 'Chạy lại trạm để nó khai địa chỉ mới:'),
        cmd('node src/main.mjs restart'),
        h('li', null, 'Điện thoại cài app Tailscale, đăng nhập cùng tài khoản, rồi quét lại mã QR ở mục Ghép điện thoại.')));
  }
  if (hub.addresses?.length) {
    children.push(h('div', { class: 'list' }, hub.addresses.map((a) => h('div', { class: 'list-item' },
      icon('link', 18),
      h('div', { class: 'list-main' }, h('div', { class: 'mono' }, a.url),
        h('div', { class: 'list-sub' }, tailnetUrls.includes(a.url) ? 'Tailscale' : `Mạng nhà (${a.label})`))))));
  }
  return section('Dùng khi ra ngoài', ...children.filter(Boolean));
}

export function mountSettings(root) {
  const devicesBox = h('div', { class: 'list' });
  const pairBox = h('div');
  const actionsArea = h('textarea', { class: 'input mono code-area', rows: 14, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' });
  const actionsHint = h('div', { class: 'field-hint' });

  async function loadDevices() {
    try {
      const devices = await api.get('/api/devices');
      clear(devicesBox);
      for (const d of devices) {
        const me = d.id === store.me?.id;
        devicesBox.append(h('div', { class: 'list-item' },
          icon(d.kind === 'node' ? 'machine' : 'link', 18),
          h('div', { class: 'list-main' },
            h('div', null, d.name, me ? h('span', { class: 'tag' }, 'thiết bị này') : null),
            h('div', { class: 'list-sub' }, `${d.kind === 'node' ? 'Máy chạy phiên' : 'Thiết bị điều khiển'} · thấy ${timeAgo(d.lastSeen)}`)),
          me ? null : h('button', { class: 'btn small danger-outline', onclick: async () => {
            if (!window.confirm(`Thu hồi quyền của "${d.name}"?`)) return;
            await api.post(`/api/devices/${d.id}/revoke`);
            loadDevices();
          } }, 'Thu hồi')));
      }
    } catch (err) {
      clear(devicesBox).append(h('div', { class: 'field-hint' }, err.message));
    }
  }

  // Máy chạy phiên thường tự tìm trạm (mạng nhà, hoặc địa chỉ Tailscale khai trong custom/hub.json); lệnh
  // join chỉ cần khi máy ở mạng khác mà không có custom/hub.json của trạm.
  function showJoinCommand() {
    const joinCmd = `node src/main.mjs join ${store.hub?.tailnet?.urls?.[0] || location.origin}`;
    clear(pairBox).append(
      h('div', { class: 'field-hint' }, 'Máy chạy phiên Claude tự tìm trạm: trong mạng nhà, hoặc qua địa chỉ Tailscale khai trong custom/hub.json. Chỉ khi cả hai đều không có mới cần chạy lệnh này trên máy đó (trong thư mục Orbit Remote), rồi duyệt yêu cầu nối ở màn chính:'),
      cmd(joinCmd));
  }

  async function loadActions() {
    try {
      const res = await fetch('/custom/actions.json', { cache: 'no-store' });
      actionsArea.value = res.ok ? await res.text() : ACTIONS_EXAMPLE;
    } catch {
      actionsArea.value = ACTIONS_EXAMPLE;
    }
  }

  function validate() {
    try {
      const data = JSON.parse(actionsArea.value);
      if (!Array.isArray(data.actions)) throw new Error('Thiếu mảng "actions".');
      for (const [i, a] of data.actions.entries()) {
        if (!a.label) throw new Error(`Nút thứ ${i + 1} thiếu "label".`);
        if (a.send == null && a.fill == null && a.broadcast == null && !a.newSession) {
          throw new Error(`Nút "${a.label}" chưa khai việc làm (send, fill, broadcast hoặc newSession).`);
        }
      }
      actionsHint.textContent = `Hợp lệ: ${data.actions.length} nút.`;
      actionsHint.className = 'field-hint ok';
      return data;
    } catch (err) {
      actionsHint.textContent = err.message;
      actionsHint.className = 'field-hint warn';
      return null;
    }
  }

  const fontSlider = h('input', {
    type: 'range', min: 13, max: 19, step: 1, value: localStorage.getItem('orbit-font') || 15,
    oninput: (e) => { localStorage.setItem('orbit-font', e.target.value); applyPrefs(); },
  });
  const compact = h('input', {
    type: 'checkbox', checked: localStorage.getItem('orbit-compact') === '1',
    onchange: (e) => { localStorage.setItem('orbit-compact', e.target.checked ? '1' : '0'); applyPrefs(); },
  });

  const machines = [...store.machines.values()];
  const view = h('div', { class: 'view settings' },
    h('header', { class: 'topbar' },
      h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Quay lại' }, icon('back')),
      h('div', { class: 'title-wrap static' }, h('div', { class: 'title' }, 'Cài đặt'))),
    h('main', { class: 'scroll settings-scroll' },
      remoteSection(),
      section('Máy tính',
        h('div', { class: 'list' }, machines.map((m) => h('a', { class: 'list-item link', href: `#/m/${m.id}` },
          icon('machine', 18),
          h('div', { class: 'list-main' }, h('div', null, m.name, m.local ? h('span', { class: 'tag' }, 'giữ trạm') : null),
            h('div', { class: 'list-sub' }, m.online ? 'Đang nối' : `Đang tắt · thấy ${timeAgo(m.lastSeen)} trước`)),
          h('span', { class: `mini-dot ${m.online ? 'on' : 'off'}` }), icon('chevron', 16)))),
        h('div', { class: 'field-hint' }, 'Máy nào chạy Orbit Remote (setup.cmd bật tự chạy khi đăng nhập Windows) thì tự tìm trạm và xin nối; bạn chỉ bấm duyệt một lần ở màn chính. Máy đã nối được nhớ mãi, kể cả lúc đang tắt.')),
      section('Thiết bị đã ghép', devicesBox,
        h('button', { class: 'btn primary block', onclick: openPairSheet }, icon('plus', 16), 'Ghép điện thoại bằng mã QR'),
        h('button', { class: 'btn ghost block small', onclick: showJoinCommand }, 'Nối máy ở mạng khác'), pairBox),
      section('Nút bấm tuỳ biến',
        h('div', { class: 'field-hint' }, 'Mỗi nút là một dòng trong custom/actions.json. "scope": "session" hiện trong màn hội thoại, "home" hiện ở màn chính. Việc làm: "send" gửi ngay, "fill" điền sẵn vào ô soạn, "broadcast" gửi cho mọi phiên đang chạy, "newSession" mở phiên theo mẫu. Thêm "confirm" để hỏi lại trước khi chạy.'),
        actionsArea, actionsHint,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small ghost', onclick: () => { actionsArea.value = ACTIONS_EXAMPLE; validate(); } }, 'Mẫu'),
          h('button', { class: 'btn small ghost', onclick: validate }, 'Kiểm tra'),
          h('button', { class: 'btn small primary', onclick: async () => {
            const data = validate();
            if (!data) return;
            try {
              await api.put('/api/custom/actions', data);
              toast('Đã lưu. Mọi thiết bị đang mở sẽ nhận nút mới.');
            } catch (err) {
              toast(err.message, 'error');
            }
          } }, 'Lưu')),
        h('div', { class: 'field-hint' }, 'Muốn tuỳ biến sâu hơn: sửa custom/theme.css (màu, cỡ chữ) hoặc custom/extension.js (mã JS tuỳ ý) trong thư mục Orbit Remote. Có thể nhờ chính một phiên Claude mở từ app này viết giúp.')),
      section('Giao diện',
        h('label', { class: 'field row' }, h('span', { class: 'field-label' }, 'Cỡ chữ'), fontSlider),
        h('label', { class: 'field row' }, h('span', { class: 'field-label' }, 'Gọn hơn'), compact)),
      section('Thông tin',
        h('div', { class: 'info-grid' },
          h('span', null, 'Phiên bản'), h('span', null, store.version),
          h('span', null, 'Thiết bị này'), h('span', null, store.me?.name || ''),
          h('span', null, 'Trạm'), h('span', { class: 'mono' }, location.origin)))));

  root.append(view);
  loadDevices();
  loadActions().then(validate);
  actionsArea.addEventListener('input', () => { actionsHint.textContent = ''; });
  return () => {};
}
