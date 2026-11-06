// Phần tuỳ biến: nút bấm khai trong custom/actions.json và phần mở rộng custom/extension.js.
//
// Ba tầng, từ dễ tới mạnh:
//   1. actions.json  — thêm nút gửi câu lệnh, mở phiên theo mẫu, gửi cho mọi phiên.
//                      Sửa được ngay trên điện thoại ở màn Cài đặt.
//   2. theme.css     — đè biến màu, cỡ chữ, bo góc.
//   3. extension.js  — mã JS tuỳ ý, nhận một đối tượng `orbit` để gắn nút, nghe sự kiện,
//                      gọi API. Một phiên Claude mở từ chính app có thể tự viết file này.

import { api } from './api.js';
import { store } from './store.js';
import { toast } from './dom.js';

const extensionButtons = { home: [], session: [] };

// Phiên mở từ app (bảng Phiên mới, nút mẫu, mở lại phiên cũ) bắt đầu bằng Opus, effort rất cao và bỏ
// qua quyền. Mẫu nào khai riêng model, effort hay quyền thì mẫu đó thắng. Trạm thì không tự đặt gì
// (phiên mở qua API mà không nói gì vẫn là "Hỏi từng lần").
export const NEW_SESSION_DEFAULTS = Object.freeze({ model: 'opus', effort: 'xhigh', permissionMode: 'bypassPermissions' });

export function actionsFor(scope) {
  const fromJson = store.actions.filter((a) => (a.scope || 'session') === scope && !a.hidden);
  return [...fromJson, ...extensionButtons[scope]];
}

function confirmText(action) {
  if (!action.confirm) return null;
  return typeof action.confirm === 'string' ? action.confirm : `Chạy "${action.label}"?`;
}

// ctx: { sessionId?, fill?(text) }
export async function runAction(action, ctx = {}) {
  const ask = confirmText(action);
  if (ask && !window.confirm(ask)) return;
  try {
    if (typeof action.run === 'function') {
      await action.run(ctx.sessionId ? store.sessions.get(ctx.sessionId) : null, orbit);
    } else if (action.fill != null && ctx.fill) {
      ctx.fill(String(action.fill === true ? action.send || '' : action.fill));
    } else if (action.send != null) {
      if (!ctx.sessionId) throw new Error('Nút này cần mở trong một phiên.');
      await api.post(`/api/sessions/${ctx.sessionId}/send`, { text: String(action.send) });
    } else if (action.broadcast != null) {
      const targets = store.runningSessions();
      if (!targets.length) throw new Error('Không có phiên nào đang chạy.');
      await Promise.all(targets.map((s) => api.post(`/api/sessions/${s.id}/send`, { text: String(action.broadcast) })));
      toast(`Đã gửi cho ${targets.length} phiên.`);
    } else if (action.newSession) {
      if (action.newSession.direct) await createFromPreset(action.newSession);
      else store.emit('open-new-session', action.newSession);
    } else {
      throw new Error('Nút này chưa khai việc phải làm (send, fill, broadcast, newSession).');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

function pickMachine(preset) {
  const online = [...store.machines.values()].filter((m) => m.online);
  if (preset.machine) {
    const want = String(preset.machine).toLowerCase();
    const hit = online.find((m) => m.name.toLowerCase() === want || m.id === preset.machine);
    if (!hit) throw new Error(`Máy "${preset.machine}" đang không nối.`);
    return hit;
  }
  if (!online.length) throw new Error('Không có máy nào đang nối.');
  return online[0];
}

export async function createFromPreset(preset) {
  const machine = pickMachine(preset);
  const snap = await api.post('/api/sessions', { ...NEW_SESSION_DEFAULTS, ...preset, machineId: machine.id });
  location.hash = `#/s/${snap.id}`;
  return snap;
}

// Đối tượng trao cho custom/extension.js.
export const orbit = {
  store,
  api,
  toast,
  on: (type, fn) => store.on(type, fn),
  send: (sessionId, text) => api.post(`/api/sessions/${sessionId}/send`, { text }),
  createSession: (preset) => createFromPreset(preset),
  addHomeButton: (button) => {
    extensionButtons.home.push(button);
    store.emit('actions', store.actions);
  },
  addSessionButton: (button) => {
    extensionButtons.session.push(button);
    store.emit('actions', store.actions);
  },
};

export async function loadExtension() {
  try {
    const mod = await import(`/custom/extension.js?v=${Date.now()}`);
    if (typeof mod.default === 'function') await mod.default(orbit);
  } catch (err) {
    // Không có file, hoặc file hỏng: app vẫn chạy, chỉ báo nếu file có mà hỏng.
    if (!/Failed to fetch|404|Importing a module script failed/i.test(String(err))) {
      toast(`custom/extension.js lỗi: ${err.message}`, 'error');
    }
  }
}
