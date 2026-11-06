// Tài khoản Claude của Claude Code trên một máy: xem đang đăng nhập ai, và đăng nhập (hay đổi tài khoản) ngay từ app.
//
// Cách đăng nhập theo đúng cách Claude Code làm khi không mở được trình duyệt (src/claude-auth.mjs): đầu máy chạy
// "claude auth login", app nhận link đăng nhập, người dùng mở link trên chính điện thoại này, đăng nhập, trang của
// Claude hiện một mã; dán mã vào app là đầu máy gõ mã vào đúng tiến trình đã sinh link. Mã gắn với lượt đó: mã sai
// hay lượt quá 10 phút thì phải lấy link mới. Đóng bảng giữa chừng là huỷ lượt trên máy.

import { h, clear, toast, copyText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { openSheet } from './sheets.js';

const PLAN = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };

export function accountText(s) {
  if (!s?.loggedIn) return 'Chưa đăng nhập tài khoản Claude.';
  const plan = PLAN[s.plan] || s.plan;
  return [s.email || 'Đã đăng nhập', plan ? `gói ${plan}` : '', s.method && s.method !== 'claude.ai' ? s.method : ''].filter(Boolean).join(' · ');
}

// Mục "Tài khoản Claude" trong bảng của một máy (views/machines.js): hỏi máy đang đăng nhập ai, kèm nút đăng nhập.
export function claudeAccountBlock(machine) {
  const line = h('span', { class: 'acct-line' }, 'Đang hỏi máy…');
  const btn = h('button', { class: 'btn small', type: 'button', onclick: () => openClaudeLogin(machine, (s) => { line.textContent = accountText(s); btn.textContent = 'Đăng nhập tài khoản khác'; }) }, 'Đăng nhập Claude');
  const wrap = h('div', { class: 'field', role: 'group', 'aria-label': 'Tài khoản Claude' },
    h('span', { class: 'field-label' }, 'Tài khoản Claude'),
    h('div', { class: 'acct-row' }, line, btn),
    h('span', { class: 'field-hint' }, 'Tài khoản Claude Code dùng trên máy này: phiên chạy ở đây tính vào hạn mức của tài khoản đó.'));
  if (!machine.online) {
    line.textContent = 'Máy đang tắt.';
    btn.disabled = true;
    return wrap;
  }
  api.get(`/api/machines/${machine.id}/claude-auth`).then((s) => {
    line.textContent = accountText(s);
    if (s.loggedIn) btn.textContent = 'Đăng nhập tài khoản khác';
  }, (err) => {
    line.textContent = err.message;
    line.classList.add('bad');
  });
  return wrap;
}

// Bảng đăng nhập Claude cho một máy. onDone(trạng thái mới) khi đăng nhập xong.
export function openClaudeLogin(machine, onDone = null) {
  let loginId = '';
  let finished = false;
  let lastEmail = ''; // giữ email đã điền khi phải lấy link mới (mã sai, lượt hết hạn)
  const cancel = () => {
    if (!loginId || finished) return;
    const id = loginId;
    loginId = '';
    api.post(`/api/machines/${machine.id}/claude-login/cancel`, { id }).catch(() => {});
  };
  const { body, close } = openSheet(`Đăng nhập Claude · ${machine.name}`, { onClose: cancel });
  const pane = h('div', { class: 'login-pane' });
  body.append(pane);

  // Bước đầu: email gợi ý (không bắt buộc) rồi xin link đăng nhập từ máy.
  function askLink(note = '') {
    clear(pane);
    const email = h('input', { class: 'input', type: 'email', value: lastEmail, placeholder: 'ban@vi-du.com', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Email' });
    const go = h('button', { class: 'btn primary block', type: 'submit' }, icon('external', 16), 'Lấy link đăng nhập');
    pane.append(h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        go.disabled = true;
        go.lastChild.textContent = 'Đang hỏi máy…';
        try {
          lastEmail = email.value.trim();
          const r = await api.post(`/api/machines/${machine.id}/claude-login`, { email: lastEmail });
          loginId = r.id;
          showSteps(r.url);
        } catch (err) {
          toast(err.message, 'error');
          go.disabled = false;
          go.lastChild.textContent = 'Lấy link đăng nhập';
        }
      },
    },
    note ? h('div', { class: 'notice warn' }, note) : null,
    h('p', { class: 'login-lead' }, `Đăng nhập Claude Code trên máy ${machine.name} bằng tài khoản Claude (gói Pro, Max, Team hay Enterprise). Tài khoản mới thay cho tài khoản đang dùng trên máy đó.`),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Email (không bắt buộc)'), email,
      h('span', { class: 'field-hint' }, 'Điền sẵn email trên trang đăng nhập.')),
    go));
  }

  // Bước hai: mở trang đăng nhập, chép mã trang hiện ra, dán vào đây.
  function showSteps(url) {
    clear(pane);
    const code = h('input', { class: 'input mono', placeholder: 'Dán mã ở đây', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Mã đăng nhập' });
    const send = h('button', { class: 'btn primary block', type: 'submit' }, 'Đăng nhập');
    pane.append(h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!code.value.trim()) {
          code.focus();
          return;
        }
        send.disabled = true;
        send.textContent = 'Đang đăng nhập…';
        try {
          const s = await api.post(`/api/machines/${machine.id}/claude-login/code`, { id: loginId, code: code.value.trim() });
          finished = true;
          loginId = '';
          showDone(s);
          onDone?.(s);
        } catch (err) {
          // Mã sai hay lượt đã hết: lượt trên máy đã dừng, phải lấy link mới.
          loginId = '';
          askLink(err.message);
        }
      },
    },
    h('div', { class: 'login-step' }, h('b', null, '1. '), 'Mở trang đăng nhập và đăng nhập bằng tài khoản Claude muốn dùng trên máy này.'),
    h('div', { class: 'login-link' },
      h('a', { class: 'btn block', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 16), 'Mở trang đăng nhập'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Chép link', title: 'Chép link', onclick: () => copyText(url) }, icon('copy', 18))),
    h('div', { class: 'login-step' }, h('b', null, '2. '), 'Đăng nhập xong, trang hiện một mã. Chép mã đó rồi dán vào đây.'),
    code,
    send,
    h('span', { class: 'field-hint' }, 'Link và mã chỉ dùng được cho lượt này, trong 10 phút.')));
  }

  function showDone(s) {
    clear(pane);
    pane.append(
      h('div', { class: 'notice ok' }, icon('check', 16), h('span', null, `Đã đăng nhập: ${accountText(s)}`)),
      h('p', { class: 'field-hint' }, 'Phiên đang chạy trên máy này nên chạy lại để chắc chắn dùng tài khoản mới.'),
      h('button', { class: 'btn primary block', type: 'button', onclick: () => close() }, 'Xong'));
  }

  askLink();
  return { close };
}
