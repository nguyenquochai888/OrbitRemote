// Khung xem tệp đính kèm: ảnh, chữ (mã, nhật ký, json...), PDF, video, âm thanh; loại khác thì chỉ mở
// hay tải về. Dùng cho tệp đã gửi trong hội thoại (trạm phát lại từ máy chạy phiên) và tệp đang chờ
// gửi ở ô soạn (còn nằm trong bộ nhớ của app, xem bằng địa chỉ blob:).

import { h, add, clear } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openSheet } from './sheets.js';

// Chữ dài hơn mức này chỉ hiện phần đầu: một tệp nhật ký 10 MB dựng thành một khối chữ là đơ trang.
const TEXT_SHOW_MAX = 256 * 1024;
const TEXT_EXT = new Set(('txt md json jsonl csv tsv log xml yaml yml ini cfg conf toml env js mjs cjs ts tsx jsx '
  + 'py cs c h cpp hpp java kt swift go rs rb php lua sh ps1 psm1 bat cmd sql html htm css scss svg '
  + 'shader hlsl cginc compute uss uxml asmdef meta prefab unity asset mat anim controller gradle diff patch').split(' '));
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg']);

const extOf = (name) => (/\.([^.\\/]+)$/.exec(String(name || ''))?.[1] || '').toLowerCase();

// Cách hiện một tệp: 'image' | 'text' | 'pdf' | 'video' | 'audio' | 'other'. Theo đuôi tên trước (trạm
// cũng chọn kiểu nội dung theo đuôi), loại MIME trình duyệt báo chỉ để bù khi tên không có đuôi quen.
export function attachmentKind(name, type = '') {
  const ext = extOf(name);
  const t = String(type || '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  if (ext === 'pdf') return 'pdf';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (ext) return 'other';
  if (t.startsWith('image/') && t !== 'image/svg+xml') return 'image';
  if (t.startsWith('text/') || t === 'application/json') return 'text';
  return 'other';
}

export const attachmentIcon = (kind) => ({ image: 'layers', video: 'play', audio: 'play', text: 'file', pdf: 'file' }[kind] || 'clip');

// Địa chỉ trạm phát lại một tệp đã gửi trong phiên (server.mjs, GET /api/sessions/:id/attachment).
export const attachmentUrl = (sessionId, file) => `/api/sessions/${encodeURIComponent(sessionId)}/attachment?f=${encodeURIComponent(file)}`;

// Địa chỉ trạm phát một tệp trên máy chạy phiên mà Claude nhắc tới trong lời của nó (server.mjs, GET /api/sessions/:id/file).
export const sessionFileUrl = (sessionId, path) => `/api/sessions/${encodeURIComponent(sessionId)}/file?p=${encodeURIComponent(path)}`;

// Mở khung xem. src: địa chỉ tải được (đường trạm hay blob:). bytes: nội dung đã có sẵn trong bộ nhớ
// (tệp chưa gửi), dùng cho chữ thay vì tải lại, vì CSP của app không cho fetch địa chỉ blob:.
// onClose: dọn dẹp khi đóng (thu hồi blob:).
export function openAttachment({ name, type = '', src, bytes = null, onClose = null }) {
  const kind = attachmentKind(name, type);
  let media = null;
  const { body } = openSheet(name, {
    tall: kind !== 'audio' && kind !== 'other',
    // Lớp của bảng không được trùng lớp của phần nội dung (viewer-text là khối chữ bên trong).
    cls: `viewer kind-${kind}`,
    onClose: () => {
      media?.pause?.();
      onClose?.();
    },
  });
  const stage = h('div', { class: 'viewer-stage' });
  if (kind === 'image') {
    const img = h('img', { class: 'viewer-img', src, alt: name, decoding: 'async' });
    img.addEventListener('error', () => clear(stage).append(note('Không mở được ảnh này. Có thể máy chạy phiên đang tắt, hoặc tệp đã bị xoá khỏi máy.')));
    stage.append(img);
  } else if (kind === 'video' || kind === 'audio') {
    media = h(kind, { class: `viewer-${kind}`, src, controls: true, playsinline: true, preload: 'metadata' });
    stage.append(media);
  } else if (kind === 'pdf') {
    stage.append(h('iframe', { class: 'viewer-frame', src, title: name }));
  } else if (kind === 'text') {
    const pre = h('pre', { class: 'viewer-text' }, 'Đang tải…');
    stage.append(pre);
    if (bytes) showText(pre, bytes);
    else loadText(src, pre);
  } else {
    stage.append(h('div', { class: 'viewer-other' }, icon('file', 40), note('Loại tệp này không xem trước được trên app. Tải về để mở bằng ứng dụng trên máy.')));
  }
  // Loại không xem trước được thì trạm cũng chỉ cho tải về: nút "Mở ở thẻ mới" không có gì để mở.
  add(body, stage, h('div', { class: 'viewer-actions' },
    kind === 'other' ? null : h('a', { class: 'btn small', href: src, target: '_blank', rel: 'noopener' }, icon('external', 15), 'Mở ở thẻ mới'),
    h('a', { class: 'btn small', href: src, download: name }, icon('download', 15), 'Tải về')));
}

const note = (text) => h('div', { class: 'viewer-note' }, text);

async function loadText(src, pre) {
  try {
    const res = await fetch(src, { credentials: 'same-origin' });
    if (!res.ok) {
      let message = `Trạm trả mã ${res.status}.`;
      try {
        message = (await res.json()).error || message;
      } catch {
        // không phải JSON
      }
      throw new Error(message);
    }
    showText(pre, new Uint8Array(await res.arrayBuffer()));
  } catch (err) {
    pre.replaceWith(note(`Không mở được tệp: ${err.message}`));
  }
}

function showText(pre, bytes) {
  const cut = bytes.byteLength > TEXT_SHOW_MAX;
  // Không đặt fatal: tệp không phải UTF-8 thì vài ký tự hiện thành dấu thay thế, không hỏng cả khung.
  pre.textContent = new TextDecoder('utf-8').decode(cut ? bytes.subarray(0, TEXT_SHOW_MAX) : bytes);
  if (cut) pre.after(note(`Chỉ hiện ${Math.round(TEXT_SHOW_MAX / 1024)} KB đầu trong ${Math.round(bytes.byteLength / 1024)} KB. Tải về để xem đủ.`));
}
