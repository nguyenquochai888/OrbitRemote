// Vẽ các sự kiện không tương tác của một dòng hội thoại: tin người dùng, tin chuyển từ phiên
// khác, chữ của Claude, dòng công cụ và kết quả của nó, mốc kết thúc lượt, thông báo, lỗi.
// Màn hội thoại (có duyệt quyền) và màn xem phiên ngoài app (chỉ đọc) dùng chung.

import { h, clockTime } from './dom.js';
import { icon, toolIcon } from './icons.js';
import { renderMarkdown } from './md.js';
import { store } from './store.js';
import { attachmentIcon, attachmentKind, attachmentUrl, openAttachment, sessionFileUrl } from '../views/viewer.js';

const FILE_THUMBS_MAX = 8; // ảnh nhỏ dưới một lời của Claude: nhiều hơn thì chỉ còn link trong chữ

// Tin người dùng có tag phiên (@Tên-phiên, views/mention.js): mỗi tag đã được trạm xác nhận thành nhãn, chạm là mở phiên
// đó. Chữ còn lại giữ nguyên.
function withMentions(text, mentions) {
  if (!Array.isArray(mentions) || !mentions.length) return text;
  const byTag = new Map(mentions.map((m) => [m.tag, m]));
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(/(^|\s)@([^\s@]+)/g)) {
    const raw = m[2];
    const tag = byTag.has(raw) ? raw : raw.replace(/[.,;:!?)\]}'"…]+$/, '');
    const hit = byTag.get(tag);
    if (!hit) continue;
    const start = m.index + m[1].length;
    parts.push(text.slice(last, start), h('a', { class: 'mention', href: `#/s/${hit.id}`, title: `${hit.name} · máy ${hit.machine}` }, `@${tag}`));
    last = start + 1 + tag.length;
  }
  parts.push(text.slice(last));
  return parts;
}

function fmtDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return 'dưới 1 giây';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} giây` : `${Math.floor(s / 60)} phút ${s % 60} giây`;
}

// sessionId: phiên của dòng hội thoại, để mở lại tệp đính kèm đã gửi (màn xem phiên ngoài app không có).
export function createRenderer({ sessionId = null } = {}) {
  const toolEls = new Map(); // id lượt gọi công cụ -> { row, out }, để kết quả về đúng dòng
  let lastUserAt = null;

  // Ảnh thu nhỏ, chạm thì mở khung xem. Máy chạy phiên đang tắt (hay tệp đã bị xoá): không để ô ảnh vỡ, hiện
  // thẻ tên như tệp thường.
  function thumbEl(name, src, open) {
    const img = h('img', { src, alt: '', loading: 'lazy', decoding: 'async' });
    const btn = h('button', { class: 'attach-thumb', type: 'button', title: name, 'aria-label': `Xem ${name}`, onclick: open }, img);
    img.addEventListener('error', () => {
      btn.className = 'attach-tag open';
      btn.replaceChildren(icon('layers', 12), h('span', { class: 'attach-tag-name' }, name));
    }, { once: true });
    return btn;
  }

  // Tệp đính kèm của một tin đã gửi: ảnh hiện thu nhỏ, tệp khác là thẻ tên; chạm thì mở khung xem.
  // Tin cũ (đầu máy bản cũ, hay nạp lại từ nhật ký) chỉ có tên tệp, không mở được.
  function attachEl(a) {
    const item = typeof a === 'string' ? { name: a } : a || {};
    if (!item.file || !sessionId) return h('span', { class: 'attach-tag' }, icon('clip', 12), item.name);
    const src = attachmentUrl(sessionId, item.file);
    const kind = attachmentKind(item.name, item.type);
    const open = () => openAttachment({ name: item.name, type: item.type, src });
    if (kind === 'image') return thumbEl(item.name, src, open);
    return h('button', { class: 'attach-tag open', type: 'button', title: `Xem ${item.name}`, onclick: open },
      icon(attachmentIcon(kind), 12), h('span', { class: 'attach-tag-name' }, item.name));
  }

  // Lời của Claude. Tệp trên máy chạy phiên mà nó nhắc tới (link file:///, đường dẫn tuyệt đối; lib/md.js dựng
  // thành a.file-link) chạm thì mở khung xem, trạm đọc tệp từ máy đó (GET /api/sessions/:id/file). Ảnh thì hiện
  // thêm hình nhỏ dưới tin, mỗi ảnh một lần, tối đa FILE_THUMBS_MAX. Màn xem phiên ngoài app (không có sessionId)
  // chỉ hiện tên tệp.
  function aiText(ev) {
    const el = h('div', { class: 'msg ai md', html: renderMarkdown(ev.text, { fileLinks: Boolean(sessionId) }) });
    if (!sessionId) return el;
    const thumbs = [];
    const seen = new Set();
    for (const a of el.querySelectorAll('a.file-link')) {
      const path = a.dataset.path || '';
      const name = path.split(/[\\/]/).pop();
      const src = sessionFileUrl(sessionId, path);
      const open = () => openAttachment({ name, src });
      a.addEventListener('click', open);
      a.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') open();
      });
      if (attachmentKind(name) === 'image' && !seen.has(path) && thumbs.length < FILE_THUMBS_MAX) {
        seen.add(path);
        thumbs.push(thumbEl(name, src, open));
      }
    }
    if (thumbs.length) el.append(h('div', { class: 'msg-files' }, thumbs));
    return el;
  }

  function userMsg(ev) {
    if (ev.from?.kind === 'session') {
      return h('div', { class: 'msg relay' },
        h('div', { class: 'relay-head' }, icon('channel', 14), 'Tin từ ', h('b', null, ev.from.name || 'phiên khác'),
          ev.from.machine ? ` · ${ev.from.machine}` : '', ev.from.group ? ` · nhóm ${ev.from.group}` : '',
          h('span', { class: 'msg-time' }, clockTime(ev.at))),
        h('div', { class: 'relay-body md', html: renderMarkdown(ev.from.raw || ev.text) }));
    }
    // Trạm đẩy thay cho chủ dự án của một nhóm (bấm Bắt đầu, đổi mục tiêu, thêm thành viên...).
    if (ev.from?.kind === 'group') {
      return h('div', { class: 'msg relay team-relay' },
        h('div', { class: 'relay-head' }, icon('group', 14), 'Nhóm ', ev.from.groupId ? h('a', { href: `#/g/${ev.from.groupId}` }, h('b', null, ev.from.name)) : h('b', null, ev.from.name),
          ' · từ chủ dự án', h('span', { class: 'msg-time' }, clockTime(ev.at))),
        h('div', { class: 'relay-body md', html: renderMarkdown(ev.from.raw || ev.text) }));
    }
    const who = ev.from?.name && ev.from.name !== store.me?.name ? ev.from.name : null;
    return h('div', { class: 'msg user' },
      ev.text ? h('div', { class: 'bubble' }, withMentions(ev.text, ev.mentions)) : null,
      ev.attachments?.length ? h('div', { class: 'msg-attach' }, ev.attachments.map(attachEl)) : null,
      h('div', { class: 'msg-meta' }, [who, clockTime(ev.at)].filter(Boolean).join(' · ')));
  }

  function toolRow(ev) {
    const out = h('pre', { class: 'tool-out hidden' });
    const row = h('div', { class: 'tool-row run', onclick: () => { if (out.textContent) out.classList.toggle('hidden'); } },
      h('span', { class: 'tool-ico' }, icon(toolIcon(ev.name), 15)),
      h('span', { class: 'tool-name' }, ev.name.replace(/^mcp__/, '').replace(/__/g, ' › ')),
      h('span', { class: 'tool-sum' }, ev.summary || ''),
      h('span', { class: 'tool-state' }));
    if (ev.id) toolEls.set(ev.id, { row, out });
    return h('div', { class: 'tool' }, row, out);
  }

  function toolResult(ev) {
    const el = toolEls.get(ev.id);
    if (!el) return null;
    el.row.classList.remove('run');
    el.row.classList.add(ev.ok ? 'ok' : 'err');
    el.out.textContent = ev.preview || '';
    if (!ev.ok && ev.preview) el.out.classList.remove('hidden');
    return null;
  }

  // Trả về phần tử cần chèn, hoặc null nếu sự kiện chỉ cập nhật phần tử đã có (hay không vẽ).
  function render(ev) {
    switch (ev.t) {
      case 'user':
        lastUserAt = ev.at;
        return userMsg(ev);
      case 'text':
        return aiText(ev);
      case 'tool':
        return toolRow(ev);
      case 'tool_result':
        return toolResult(ev);
      case 'result': {
        const took = ev.durationMs ? fmtDuration(ev.durationMs) : lastUserAt ? fmtDuration(new Date(ev.at) - new Date(lastUserAt)) : '';
        const parts = ev.cancelled ? ['Đã dừng lượt'] : ev.ok ? ['Xong', took] : ['Lượt hỏng', ev.text];
        return h('div', { class: `turn-end${ev.ok || ev.cancelled ? '' : ' bad'}` }, h('span', null, parts.filter(Boolean).join(' · ')));
      }
      case 'system':
        return h('div', { class: 'sys' }, ev.text);
      case 'error':
        return h('div', { class: 'msg err' }, icon('x', 15), h('span', null, ev.text));
      default:
        return null;
    }
  }

  return {
    render,
    reset: () => {
      toolEls.clear();
      lastUserAt = null;
    },
  };
}
