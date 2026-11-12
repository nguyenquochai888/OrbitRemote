// Phiên Claude cũ trên một máy: nhật ký Claude Code tự ghi trên máy đó (mọi phiên, kể cả phiên mở bằng VS Code
// hay terminal rồi đã đóng), đầu máy đọc qua GET /api/machines/<mã>/transcripts (100 phiên mới nhất). Dùng chung
// cho màn chính, màn của máy và màn xem chỉ-đọc, nên mỗi máy chỉ có một bản nhớ và một lượt đọc một lúc.
//
// Đọc xong (hay hỏng) thì báo sự kiện "past" kèm mã máy qua store để màn đang mở vẽ lại. Không bao giờ báo ngay
// trong lúc gọi loadPast, nên gọi nó giữa lúc đang vẽ không dẫn tới vẽ lồng vào nhau.

import { api } from './api.js';
import { store } from './store.js';
import { h, timeAgo, baseName } from './dom.js';

const EMPTY = Object.freeze({ state: 'idle', list: [], error: '', at: 0, outside: '' });
const entries = new Map(); // mã máy -> { state: 'idle' | 'loading' | 'ready' | 'error', list, error, at, outside }
const inflight = new Map(); // mã máy -> lời hứa của lượt đọc đang chạy

export function pastOf(machineId) {
  return entries.get(machineId) || EMPTY;
}

// Phiên đang mở ngoài app của máy lúc này: đổi (một phiên VS Code vừa mở hay vừa đóng) thì danh sách phiên cũ
// cũng đổi, nên đọc lại không chờ hết hạn.
const outsideKey = (m) => (m?.external || []).map((t) => t.claudeSessionId).join(',');

// maxAgeMs: bản nhớ trẻ hơn chừng này (và phiên ngoài app chưa đổi) thì dùng lại. Máy đang tắt, hay app đang ẩn,
// thì giữ bản đọc lần trước, không hỏi. Trả lời hứa xong khi lượt đọc (nếu có) kết thúc.
export function loadPast(machineId, maxAgeMs) {
  const running = inflight.get(machineId);
  if (running) return running;
  const m = store.machines.get(machineId);
  const cur = pastOf(machineId);
  const fresh = Date.now() - cur.at < maxAgeMs && cur.outside === outsideKey(m);
  if (!m?.online || fresh || globalThis.document?.visibilityState === 'hidden') return Promise.resolve(cur);
  const outside = outsideKey(m);
  entries.set(machineId, { ...cur, state: 'loading' });
  const job = api.get(`/api/machines/${machineId}/transcripts`).then(
    ({ transcripts }) => {
      entries.set(machineId, { state: 'ready', list: Array.isArray(transcripts) ? transcripts : [], error: '', at: Date.now(), outside });
    },
    (err) => {
      // Hỏng (máy chạy bản cũ, mất kết nối giữa chừng) thì giữ danh sách cũ và chờ hết hạn mới hỏi lại, kẻo mỗi lần
      // vẽ lại màn chính lại bắn một yêu cầu hỏng nữa.
      entries.set(machineId, { ...pastOf(machineId), state: 'error', error: err.message, at: Date.now(), outside });
    },
  ).then(() => {
    inflight.delete(machineId);
    store.emit('past', machineId);
    return pastOf(machineId);
  });
  inflight.set(machineId, job);
  return job;
}

// ---- Dòng phiên ---------------------------------------------------------------------------------
// fromHome: mở từ màn chính thì nút quay lại của màn xem đưa về màn chính (đuôi /h), không sang màn của máy.
const viewHref = (machineId, csid, fromHome) => `#/x/${machineId}/${csid}${fromHome ? '/h' : ''}`;

// Phiên đang mở ngoài app (VS Code, terminal) mà app không giữ.
export function externalRow(machineId, t, { fromHome = false, extraClass = '' } = {}) {
  return h('a', { class: `drop-row ext${t.active ? ' active' : ''}${extraClass ? ` ${extraClass}` : ''}`, href: viewHref(machineId, t.claudeSessionId, fromHome) },
    h('span', { class: 'status-dot' }),
    h('span', { class: 'drop-main' },
      h('span', { class: 'drop-name' }, t.title),
      h('span', { class: 'drop-meta' }, [baseName(t.cwd), 'ngoài app'].filter(Boolean).join(' · '))),
    h('span', { class: 'drop-time' }, timeAgo(t.modified)));
}

// Phiên Claude cũ trên máy mà app không giữ: mở bằng VS Code hay terminal rồi đã đóng. Chạm là xem hội thoại
// (chỉ đọc), từ đó "Tiếp tục ở app" hay "Tách nhánh".
const sizeLabel = (kb) => (!kb ? '' : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`);
export function pastRow(machineId, t, { fromHome = false, extraClass = '' } = {}) {
  return h('a', { class: `drop-row ext past${t.maybeActive ? ' active' : ''}${extraClass ? ` ${extraClass}` : ''}`, href: viewHref(machineId, t.claudeSessionId, fromHome) },
    h('span', { class: 'status-dot' }),
    h('span', { class: 'drop-main' },
      h('span', { class: 'drop-name' }, t.title),
      h('span', { class: 'drop-meta' }, [baseName(t.cwd), sizeLabel(t.sizeKb)].filter(Boolean).join(' · '))),
    h('span', { class: 'drop-time' }, timeAgo(t.modified)));
}
