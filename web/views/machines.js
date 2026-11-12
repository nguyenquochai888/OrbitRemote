// Máy tính: thẻ duyệt máy mới xin nối, màn chi tiết một máy, và màn xem chỉ-đọc một phiên đang mở
// ngoài app (VS Code, terminal). Danh sách máy ở màn chính nằm trong cây của views/tree.js.
//
// Danh sách máy do trạm ghi nhớ, nên máy đang tắt vẫn hiện (mờ đi) cùng các phiên đã dừng
// của nó; bật máy lên là đầu máy tự nối lại và máy sáng lên, không cần làm gì.

import { h, add, clear, timeAgo, clockTime, baseName, toast, workDir } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { createRenderer } from '../lib/render.js';
import { openSheet, openNewSession } from './sheets.js';
import { NEW_SESSION_DEFAULTS } from '../lib/custom.js';
import { STATUS_LABEL } from './home.js';
import { claudeAccountBlock } from './claude-login.js';
import { mountScreenPanel } from './screen.js';
import { mountSession } from './session.js';
import { externalRow, loadPast, pastOf, pastRow } from '../lib/past.js';

const RUNNING = new Set(['starting', 'idle', 'busy', 'waiting']);
const WATCH_MS = 8000; // nhịp xem lại nhật ký của phiên ngoài app khi màn đang mở
const PAST_TTL_MS = 20000; // mở lại danh sách phiên trong chừng này thì dùng lại danh sách phiên cũ vừa đọc (lib/past.js)

const PLATFORM = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
// Setup báo kết quả sau mỗi bước; bước dài nhất (chờ duyệt, cài bằng winget) dưới 15 phút.
const SETUP_STALE_MS = 30 * 60 * 1000;
const SYNC_LABEL = {
  ok: 'Setup gần nhất: đủ cả',
  busy: 'Setup đang chạy',
  fail: 'Setup gần nhất: còn thiếu',
  stale: 'Setup dừng giữa chừng',
};
// Mức nhiệt (°C) cho cả GPU lẫn bo mạch: GPU máy bàn tự hạ xung quanh 83–90 °C, CPU quanh 95–100 °C.
const TEMP_LEVELS = [
  { id: 'cool', max: 60, label: 'Mát', range: 'dưới 60°' },
  { id: 'warm', max: 75, label: 'Ấm', range: '60–74°' },
  { id: 'hot', max: 85, label: 'Nóng', range: '75–84°' },
  { id: 'crit', max: Infinity, label: 'Rất nóng', range: 'từ 85°' },
];
const tempLevel = (c) => TEMP_LEVELS.find((l) => c < l.max);
const fmtTemp = (c) => `${Math.round(c)}°C`;
const TEMP_BAR_MIN = 20; // thanh nhiệt: 20 °C là rỗng, 100 °C là đầy
const TEMP_BAR_MAX = 100;

function sessionsOf(machineId) {
  return [...store.sessions.values()].filter((s) => s.machineId === machineId);
}

// ---- Máy mới xin nối ------------------------------------------------------------------
export function enrollmentCards() {
  if (!store.enrollments.length) return null;
  return h('div', { class: 'enroll-list' }, store.enrollments.map((e) => {
    const decide = async (approve, btn) => {
      for (const b of btn.parentNode.querySelectorAll('button')) b.disabled = true;
      try {
        await api.post(`/api/enroll/${e.requestId}/${approve ? 'approve' : 'reject'}`);
        toast(approve ? `Đã cho ${e.name} nối. Máy sẽ hiện sau vài giây.` : `Đã từ chối ${e.name}.`);
      } catch (err) {
        toast(err.message, 'error');
        for (const b of btn.parentNode.querySelectorAll('button')) b.disabled = false;
      }
    };
    const actions = h('div', { class: 'enroll-actions' });
    add(actions,
      h('button', { class: 'btn small danger-outline', onclick: (ev) => decide(false, ev.currentTarget) }, 'Từ chối'),
      h('button', { class: 'btn small primary', onclick: (ev) => decide(true, ev.currentTarget) }, icon('check', 14), 'Cho nối'));
    return h('div', { class: 'enroll-card' },
      h('div', { class: 'enroll-head' }, h('span', { class: 'enroll-orb' }, icon('machine', 18)),
        h('div', null,
          h('div', { class: 'enroll-title' }, 'Máy mới xin nối: ', h('b', null, e.name)),
          h('div', { class: 'enroll-sub' }, [PLATFORM[e.platform] || e.platform, e.ip?.replace(/^::ffff:/, ''), timeAgo(e.at)].filter(Boolean).join(' · ')))),
      h('div', { class: 'field-hint' }, 'Chỉ cho nối nếu đây đúng là máy của bạn. Máy được nối sẽ mở và điều khiển được phiên Claude từ app.'),
      actions);
  }));
}

// ---- Thao tác với một phiên ngoài app -----------------------------------------------------
export function openExternalSheet(machineId, t) {
  const { body, close } = openSheet('Phiên ngoài app');
  const open = async (fork) => {
    try {
      const snap = await api.post(`/api/machines/${machineId}/open`, {
        claudeSessionId: t.claudeSessionId, cwd: t.cwd, fork, name: (t.title || 'Phiên mở lại').slice(0, 60),
        ...NEW_SESSION_DEFAULTS,
      });
      close();
      location.hash = `#/s/${snap.id}/m/${machineId}`; // mở từ danh sách của màn máy: quay lại về màn máy
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  add(body,
    h('div', { class: 'ext-title' }, t.title),
    h('div', { class: 'field-hint' }, [baseName(t.cwd), timeAgo(t.modified)].filter(Boolean).join(' · ')),
    t.active ? h('div', { class: 'notice warn' }, `${t.open ? 'Phiên này đang mở ở VS Code hay terminal.' : 'Phiên này vừa được ghi trong 90 giây qua, nhiều khả năng vẫn đang mở ở VS Code hay terminal.'} "Tiếp tục" lúc này làm hai nơi ghi chồng một nhật ký; nên "Tách nhánh".`) : null,
    h('div', { class: 'danger-row' },
      h('button', { class: 'btn block', onclick: () => { close(); location.hash = `#/x/${machineId}/${t.claudeSessionId}`; } }, icon('history', 16), 'Xem hội thoại'),
      h('button', { class: `btn block${t.active ? '' : ' primary'}`, onclick: () => open(false) }, icon('play', 16), 'Tiếp tục ở app'),
      h('button', { class: `btn block${t.active ? ' primary' : ' ghost'}`, onclick: () => open(true) }, icon('link', 16), 'Tách nhánh mới ở app')));
}

// ---- Phiên ở máy khác làm việc trên máy này (orbit_machine_*, src/remote-ops.mjs) ---------------------------------
const CONTROL_ACTION = { run: 'chạy lệnh', read: 'đọc tệp', write: 'ghi tệp', edit: 'sửa tệp', find: 'tìm tệp', screen: 'chụp màn hình', input: 'bấm chuột, gõ phím', unity: 'gọi Unity' };
const CONTROL_SHOW_MS = 10 * 60 * 1000; // dòng báo "đang làm việc trên máy này" còn hiện chừng này sau thao tác cuối

// Bảng của máy: chọn máy nào có phiên được làm việc trên máy này. Chạm một máy là bật hay tắt ngay.
function controlBlock(m) {
  const others = [...store.machines.values()].filter((x) => x.id !== m.id);
  const chips = h('div', { class: 'chip-row wrap' });
  const paint = () => {
    const on = new Set(store.machines.get(m.id)?.controlFrom || []);
    clear(chips);
    if (!others.length) chips.append(h('span', { class: 'field-hint' }, 'Chưa có máy nào khác trong Orbit Remote.'));
    for (const x of others) {
      chips.append(h('button', {
        type: 'button',
        class: `chip small${on.has(x.id) ? ' active' : ''}`,
        'aria-pressed': String(on.has(x.id)),
        onclick: async () => {
          const next = new Set(store.machines.get(m.id)?.controlFrom || []);
          if (next.has(x.id)) next.delete(x.id); else next.add(x.id);
          try {
            const r = await api.post(`/api/machines/${m.id}/control`, { from: [...next] });
            const cur = store.machines.get(m.id);
            if (cur) cur.controlFrom = r.from;
            toast(r.from.includes(x.id) ? `Phiên ở máy ${x.name} đã được làm việc trên máy ${m.name}.` : `Đã thu quyền của máy ${x.name}.`);
          } catch (err) {
            toast(err.message, 'error');
          }
          paint();
        },
      }, on.has(x.id) ? icon('check', 14) : null, x.name));
    }
  };
  paint();
  return h('div', { class: 'field', role: 'group', 'aria-label': 'Cho phiên ở máy khác điều khiển' },
    h('span', { class: 'field-label' }, 'Cho phiên ở máy khác điều khiển'),
    chips,
    h('span', { class: 'field-hint' }, `Phiên Claude ở máy được chọn chạy lệnh, đọc sửa tệp, xem màn hình, bấm chuột gõ phím và gọi Unity trên máy ${m.name}. Phiên vẫn tính vào tài khoản Claude của máy nó chạy.`));
}

// Dòng báo trên màn của máy: phiên nào ở máy nào vừa làm gì trên máy này (10 phút gần nhất).
function renderControl(el, m) {
  const c = m.lastControl;
  const fresh = c && Date.now() - new Date(c.at).getTime() < CONTROL_SHOW_MS;
  el.classList.toggle('hidden', !fresh);
  if (!fresh) return;
  clear(el).append(icon('machine', 16), h('span', null,
    'Phiên ', h('b', null, c.session), ` ở máy ${c.machine} đang làm việc trên máy này: ${CONTROL_ACTION[c.action] || c.action}`,
    c.what ? h('code', null, ` ${c.what}`) : null, ` · ${clockTime(c.at)}`));
}

function machineMenu(m) {
  const { body, close } = openSheet(m.name);
  const nameInput = h('input', { class: 'input', value: m.name, maxlength: 40 });
  add(body,
    h('div', { class: 'info-grid' },
      h('span', null, 'Tên máy'), h('span', null, m.hostName),
      h('span', null, 'Hệ điều hành'), h('span', null, PLATFORM[m.platform] || m.platform || '—'),
      h('span', null, 'Nối lần đầu'), h('span', null, m.firstSeen ? new Date(m.firstSeen).toLocaleString('vi-VN') : '—'),
      h('span', null, 'Thấy gần nhất'), h('span', null, m.online ? 'đang nối' : timeAgo(m.lastSeen))),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Tên hiển thị'),
      h('div', { class: 'inline-form' }, nameInput, h('button', { class: 'btn small', onclick: async () => {
        try {
          await api.post(`/api/machines/${m.id}/rename`, { name: nameInput.value });
          toast('Đã đổi tên.');
          close();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, 'Lưu'))),
    claudeAccountBlock(m),
    controlBlock(m),
    m.local ? h('div', { class: 'field-hint' }, 'Đây là máy giữ trạm.') : h('div', { class: 'danger-row' },
      h('button', { class: 'btn danger-outline block', onclick: async () => {
        if (!window.confirm(`Quên máy "${m.name}"? Máy bị thu hồi quyền nối, và chỉ xin nối lại sau một ngày.`)) return;
        try {
          await api.post(`/api/machines/${m.id}/forget`);
          close();
          location.hash = '#/';
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, icon('trash', 16), 'Quên máy này')));
}

// ---- Danh sách phiên xổ xuống ------------------------------------------------------------------
// Một dòng gọn cho mỗi phiên; chạm là sang màn của phiên đó. Nút nổi bên phải: phiên nổi trên màn của máy
// (float: { id đang nổi, toggle }), chạm lại thì ẩn.
function sessionRow(s, float) {
  const row = h('a', { class: `drop-row status-${s.status}`, href: `#/s/${s.id}/m/${s.machineId}` },
    h('span', { class: 'status-dot' }),
    h('span', { class: 'drop-main' },
      h('span', { class: 'drop-name' }, s.name),
      h('span', { class: 'drop-meta' }, [s.remote?.machine ? `→ ${s.remote.machine}` : '', baseName(workDir(s)), STATUS_LABEL[s.status] || s.status].filter(Boolean).join(' · '))),
    h('span', { class: 'drop-time' }, timeAgo(s.lastActivity)));
  if (!float) return row;
  const on = float.id === s.id;
  const label = on ? 'Ẩn phiên nổi' : 'Nổi phiên này trên màn hình';
  return h('div', { class: 'drop-line' }, row,
    h('button', { class: `icon-btn drop-float${on ? ' on' : ''}`, 'aria-label': label, title: label, 'aria-pressed': String(on), onclick: () => float.toggle(s.id) },
      icon('pip', 18)));
}

// past: phiên cũ đọc từ máy { state: 'idle' | 'loading' | 'ready' | 'error', list, error } (lib/past.js).
function sessionDropContent(m, past, float) {
  const all = sessionsOf(m.id).sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  const running = all.filter((s) => RUNNING.has(s.status));
  const stopped = all.filter((s) => !RUNNING.has(s.status));
  const outside = m.external || [];
  // Phiên đã hiện ở nhóm trên (app giữ, đang mở ngoài app) thì không hiện lại ở nhóm phiên cũ.
  const shown = new Set([...all.map((s) => s.claudeSessionId), ...outside.map((t) => t.claudeSessionId)].filter(Boolean));
  const older = past.list.filter((t) => !shown.has(t.claudeSessionId));
  const note = (text) => h('div', { class: 'drop-note' }, text);
  let pastRows = older.map((t) => pastRow(m.id, t));
  if (!m.online && !older.length) pastRows = [];
  else if (past.state === 'loading' && !older.length) pastRows = [note('Đang đọc các phiên Claude trên máy…')];
  else if (past.state === 'error') pastRows = [...pastRows, note(`Không đọc được phiên cũ trên máy: ${past.error}`)];
  const group = (label, rows, count = rows.length) => (rows.length ? h('div', { class: 'drop-group' },
    h('div', { class: 'drop-label' }, label, count ? h('span', { class: 'group-count' }, count) : null), rows) : null);
  const closeAll = running.length > 1 ? h('button', { class: 'btn small danger-outline block', onclick: async () => {
    if (!window.confirm(`Đóng cả ${running.length} phiên trên ${m.name}? Có thể chạy lại sau, ngữ cảnh vẫn còn.`)) return;
    const results = await Promise.allSettled(running.map((s) => api.post(`/api/sessions/${s.id}/close`)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    toast(failed ? `${failed} phiên không đóng được.` : 'Đã đóng mọi phiên.', failed ? 'error' : 'info');
  } }, icon('stop', 14), 'Đóng mọi phiên') : null;
  const body = [
    group('Đang chạy', running.map((s) => sessionRow(s, float))),
    group('Đang mở ngoài app', outside.map((t) => externalRow(m.id, t))),
    group('Đã dừng', stopped.map((s) => sessionRow(s, float))),
    group('Phiên cũ trên máy', pastRows, older.length),
  ].filter(Boolean);
  if (!body.length) return [h('div', { class: 'drop-empty' }, m.online ? 'Máy này chưa có phiên nào. Bấm "Mở phiên" để bắt đầu.' : 'Máy đang tắt, chưa có phiên nào.')];
  return [...body, closeAll];
}

// ---- Màn chi tiết một máy ------------------------------------------------------------------
// fromSession: mở từ nút máy trong màn một phiên thì nút quay lại đưa về phiên đó, không về màn chính. fromGroup: phiên
// đó mở từ màn một nhóm, nên quay về phiên vẫn giữ đường về nhóm. openList: mở sẵn danh sách Phiên (nút "Xem tất cả"
// dưới máy ở màn chính, đường dẫn #/m/<máy>/list).
export function mountMachine(root, id, { fromSession = '', fromGroup = '', openList = false } = {}) {
  const title = h('div', { class: 'title' });
  const subtitle = h('div', { class: 'subtitle' });
  // Hàng nút gọn (nhỏ, sát thanh trên) để khung màn hình bên dưới có nhiều chỗ nhất.
  const newBtn = h('button', { class: 'btn primary', onclick: () => openNewSession({ machineId: id, fromMachine: true }) }, icon('plus', 16), 'Mở phiên');
  const countBadge = h('span', { class: 'count-badge' });
  const dropBtn = h('button', { class: 'btn drop-btn', 'aria-haspopup': 'true', onclick: () => toggleDrop() },
    icon('list', 16), 'Phiên', countBadge, icon('down', 14, 'drop-chevron'));
  const drop = h('div', { class: 'session-drop', role: 'menu' });
  // Máy đang tắt: nút "Bật máy" thay chỗ "Mở phiên" (Wake-on-LAN qua trạm, xem src/wake.mjs).
  const wakeBtn = h('button', { class: 'btn primary hidden', onclick: () => wake() }, icon('bolt', 16), 'Bật máy');
  // Máy đang bật: nút tắt máy (ngay, sau 15 giây, sau 30 giây, hẹn giờ; xem src/power.mjs).
  const powerBtn = h('button', { class: 'btn power-btn', 'aria-label': 'Tắt máy', title: 'Tắt máy', onclick: () => openPowerSheet() }, icon('power', 17));
  const actions = h('div', { class: 'machine-actions' }, wakeBtn, newBtn, dropBtn, powerBtn, drop);
  const notice = h('div', { class: 'field-hint center hidden' });
  const wakeNote = h('div', { class: 'notice wake-note hidden' });
  // Một phiên ở máy khác vừa làm việc trên máy này (orbit_machine_*): báo cho người đang xem máy.
  const controlNote = h('div', { class: 'notice control-note hidden' });
  const powerNote = h('div', { class: 'notice warn power-note hidden' });
  // Kết quả setup gần nhất: một biểu tượng trên thanh trên (xong, đang chạy, hỏng), chạm thì xổ chi tiết.
  const syncBadge = h('span', { class: 'sync-badge' });
  const syncBtn = h('button', { class: 'icon-btn sync-btn hidden', 'aria-haspopup': 'dialog', onclick: () => toggleSync() },
    icon('rotate', 20, 'sync-arrows'), syncBadge);
  const syncPop = h('div', { class: 'sync-pop', role: 'dialog' });
  // Nhiệt độ máy: nút info trên thanh trên, chấm màu ở góc theo chỗ nóng nhất; chạm thì xổ chi tiết.
  const tempDot = h('span', { class: 'temp-dot' });
  const tempBtn = h('button', { class: 'icon-btn temp-btn hidden', 'aria-haspopup': 'dialog', 'aria-label': 'Nhiệt độ máy', title: 'Nhiệt độ máy', onclick: () => toggleTemp() },
    icon('info', 21), tempDot);
  const tempPop = h('div', { class: 'sync-pop temp-pop', role: 'dialog', 'aria-label': 'Nhiệt độ máy' });
  const screenHost = h('div', { class: 'screen-host' });
  const main = h('main', { class: 'scroll machine-scroll' }, actions, powerNote, wakeNote, controlNote, notice, screenHost);
  const view = h('div', { class: 'view machine' },
    h('header', { class: 'topbar' },
      h('a', { class: 'icon-btn', href: fromSession ? `#/s/${fromSession}${fromGroup ? `/g/${fromGroup}` : ''}` : '#/', 'aria-label': fromSession ? 'Quay lại phiên' : 'Quay lại' }, icon('back')),
      h('div', { class: 'title-wrap static' }, title, subtitle),
      tempBtn,
      syncBtn,
      h('button', { class: 'icon-btn', 'aria-label': 'Tuỳ chọn máy', onclick: () => { const m = store.machines.get(id); if (m) machineMenu(m); } }, icon('more')),
      tempPop,
      syncPop),
    main);
  root.append(view);

  let dropOpen = false;
  let screenPanel = null;

  // ---- Phiên nổi --------------------------------------------------------------------------------
  // Một phiên chat ngay trên màn của máy: khung bên phải, nền mờ để vẫn thấy màn hình bên dưới. Nhớ theo máy
  // (localStorage) nên quay lại màn này vẫn còn. Xem toàn màn hình (thật, hay kiểu iPhone) thì chuyển khung nổi vào
  // trong khung hình, thoát thì đưa về (xem floatTarget). Khung nổi là anh em của vùng hình,
  // nên chuột, bánh xe và phím gõ trong đó không đi sang máy kia (screen.js chỉ bắt trên vùng hình và ô nhận phím).
  // Kéo thanh trên để dời khung, kéo mép hay góc để đổi cỡ; vị trí và cỡ cũng nhớ theo máy (FLOAT_BOX_KEY).
  const FLOAT_KEY = `orbit.float.${id}`;
  const FLOAT_BOX_KEY = `orbit.floatBox.${id}`;
  // Phiên dựng vào floatBody; các tay nắm đổi cỡ là anh em của nó nên dựng lại phiên không xoá mất tay nắm.
  const floatBody = h('div', { class: 'float-body' });
  const floatHost = h('div', { class: 'float-session hidden' }, floatBody,
    ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => h('div', { class: `float-grip ${edge}`, 'data-edge': edge, 'aria-hidden': 'true' })));
  view.append(floatHost);
  let floatId = '';
  let floatUnmount = null;

  function showFloat(sid) {
    floatUnmount?.();
    clear(floatBody);
    floatId = sid;
    floatUnmount = mountSession(floatBody, sid, { onClose: () => hideFloat() });
    floatHost.classList.remove('hidden');
    placeFloat();
    try {
      localStorage.setItem(FLOAT_KEY, sid);
    } catch {
      // trình duyệt chặn lưu: chỉ là lần sau không tự mở lại
    }
    renderDrop();
  }

  function hideFloat() {
    endFloatGesture(false);
    floatUnmount?.();
    floatUnmount = null;
    floatId = '';
    clear(floatBody);
    floatHost.classList.add('hidden');
    try {
      localStorage.removeItem(FLOAT_KEY);
    } catch {
      // như trên
    }
    renderDrop();
  }

  function toggleFloat(sid) {
    if (floatId === sid) hideFloat();
    else showFloat(sid);
  }

  // Vị trí và cỡ khung nổi lưu theo tỉ lệ của khung hình (x, y, w, h từ 0 tới 1), nên khung hình đổi cỡ (cửa sổ,
  // vào ra toàn màn hình) thì khung nổi co giãn theo và vẫn nằm đúng góc đã đặt. Chưa kéo lần nào thì null:
  // nằm sát mép phải, cao hết khung hình, để nút chọn màn ở trên và dãy nút ở dưới khung hình vẫn bấm được (đã
  // thấy trên ảnh chụp: khung cao hết màn che mất nút Toàn màn hình).
  const FLOAT_MIN_W = 280; // đủ cho thanh trên, ô gõ và vài dòng tin
  const FLOAT_MIN_H = 280;
  let floatBox = null;
  try {
    const b = JSON.parse(localStorage.getItem(FLOAT_BOX_KEY) || 'null');
    if (b && [b.x, b.y, b.w, b.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) floatBox = b;
  } catch {
    floatBox = null;
  }
  let floatRect = null; // khung đang đặt, theo toạ độ của khung chứa: { l, t, w, h } điểm ảnh
  let gesture = null; // một lần kéo hay đổi cỡ đang diễn ra

  const clampTo = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi));
  // Khung hình đang toàn màn hình thì khung nổi nằm trong khung hình: toàn màn hình thật thì chỉ phần trong khung đó
  // hiện ra; kiểu iPhone (không có toàn màn hình thật, khung hình tự phủ kín màn) thì khung hình rộng hơn màn của máy
  // (bản PC còn cột bên trái), nằm trong màn máy thì khung nổi không kéo sang được phần đó.
  const floatTarget = () => {
    const fs = document.fullscreenElement;
    if (fs && view.contains(fs)) return fs;
    return screenHost.querySelector('.screen-stage.fullscreen') || view;
  };
  // Vùng tính tỉ lệ (area) và vùng khung nổi được nằm (room), theo toạ độ của khung chứa. Trong màn của máy: area
  // là khung hình, room là phần khung hình còn thấy dưới thanh trên (cuộn màn máy thì khung nổi không trùm lên thanh
  // trên). Chưa có khung hình (máy tắt, không xem được màn hình): cả phần dưới thanh trên. Toàn màn hình: cả khung.
  function floatFrame(target) {
    const c = target.getBoundingClientRect();
    if (target !== view) {
      const all = { l: 0, t: 0, w: c.width, h: c.height };
      return { area: all, room: all, gap: 12 };
    }
    const top = view.querySelector('.topbar')?.offsetHeight || 56;
    const below = { l: 0, t: top, w: c.width, h: Math.max(0, c.height - top) };
    const st = screenHost.querySelector('.screen-stage')?.getBoundingClientRect();
    if (!st || st.height < 240) return { area: below, room: below, gap: 8 };
    const area = { l: st.left - c.left, t: st.top - c.top, w: st.width, h: st.height };
    const l = Math.max(area.l, below.l);
    const t = Math.max(area.t, below.t);
    const room = { l, t, w: Math.max(0, Math.min(area.l + area.w, below.l + below.w) - l), h: Math.max(0, Math.min(area.t + area.h, below.t + below.h) - t) };
    return { area, room, gap: 8 };
  }
  // Ép một khung vào room: không nhỏ hơn cỡ tối thiểu (trừ khi room còn nhỏ hơn), không lọt ra ngoài.
  function fitFloat(b, room) {
    const w = clampTo(b.w, Math.min(FLOAT_MIN_W, room.w), room.w);
    const h = clampTo(b.h, Math.min(FLOAT_MIN_H, room.h), room.h);
    return { l: clampTo(b.l, room.l, room.l + room.w - w), t: clampTo(b.t, room.t, room.t + room.h - h), w, h };
  }
  function applyFloat(r) {
    floatRect = r;
    Object.assign(floatHost.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.w}px`, height: `${r.h}px`, right: 'auto', bottom: 'auto' });
  }

  let watchedStage = null; // khung hình đang được theo dõi cỡ (vào ra toàn màn hình kiểu iPhone đổi cỡ của nó)

  function placeFloat() {
    const stage = screenHost.querySelector('.screen-stage');
    if (stage !== watchedStage && floatWatch) {
      if (watchedStage) floatWatch.unobserve(watchedStage);
      if (stage) floatWatch.observe(stage);
      watchedStage = stage;
    }
    const target = floatTarget();
    if (floatHost.parentNode !== target) {
      endFloatGesture(false); // dời khung chứa giữa chừng thì thôi lần kéo đang dở
      // Dời chỗ trong cây trang thì khung cuộn về đầu: giữ khoảng tới đáy để vẫn đọc đúng chỗ cũ.
      const tl = floatHost.querySelector('.timeline');
      const fromEnd = tl ? tl.scrollHeight - tl.scrollTop : 0;
      target.append(floatHost);
      if (tl) tl.scrollTop = tl.scrollHeight - fromEnd;
    }
    if (gesture?.live) return; // đang kéo: khung theo tay, đặt lại khi thả
    const { area, room, gap } = floatFrame(target);
    const want = floatBox
      ? { l: area.l + floatBox.x * area.w, t: area.t + floatBox.y * area.h, w: floatBox.w * area.w, h: floatBox.h * area.h }
      : { l: area.l + area.w - gap - Math.min(420, area.w - 2 * gap), t: area.t + gap, w: Math.min(420, area.w - 2 * gap), h: area.h - 2 * gap };
    applyFloat(fitFloat(want, room));
  }

  // Kéo: nhấn trên thanh trên của phiên nổi rồi dời quá vài điểm ảnh mới tính là kéo, nên chạm thường vẫn bấm được
  // nút X, tên phiên, nút mở phiên đầy đủ. Đổi cỡ: nhấn vào mép hay góc là đổi cỡ ngay, mép đối diện đứng yên.
  // Khi đã kéo thì khung nổi bắt con trỏ (setPointerCapture): rê qua khung hình cũng không gửi chuột sang máy kia.
  // Mỗi nhịp màn hình đặt khung một lần (requestAnimationFrame), thả ra thì lưu tỉ lệ.
  const FLOAT_MOVE_PX = 5;
  const GRIP_CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };

  function applyGesture(g) {
    g.frame = 0;
    const s = g.start;
    const dx = g.x - g.x0;
    const dy = g.y - g.y0;
    const { room } = g.frame0;
    if (!g.edge) {
      applyFloat(fitFloat({ ...s, l: s.l + dx, t: s.t + dy }, room));
      return;
    }
    const minW = Math.min(FLOAT_MIN_W, room.w);
    const minH = Math.min(FLOAT_MIN_H, room.h);
    let { l, t, w, h } = s;
    if (g.edge.includes('w')) {
      const right = s.l + s.w;
      w = clampTo(s.w - dx, minW, right - room.l);
      l = right - w;
    } else if (g.edge.includes('e')) {
      w = clampTo(s.w + dx, minW, room.l + room.w - s.l);
    }
    if (g.edge.includes('n')) {
      const bottom = s.t + s.h;
      h = clampTo(s.h - dy, minH, bottom - room.t);
      t = bottom - h;
    } else if (g.edge.includes('s')) {
      h = clampTo(s.h + dy, minH, room.t + room.h - s.t);
    }
    applyFloat({ l, t, w, h });
  }

  function liveFloatGesture(g) {
    g.live = true;
    try {
      floatHost.setPointerCapture(g.id);
    } catch {
      // con trỏ đã nhả trước khi kịp bắt: lần thả sẽ kết thúc lần kéo
    }
    const html = document.documentElement;
    html.style.setProperty('--float-cursor', g.edge ? GRIP_CURSOR[g.edge] : 'grabbing');
    html.classList.add('float-moving');
    floatHost.classList.add('moving');
  }

  const onFloatMove = (e) => {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    // Nghe ở pha bắt của window rồi chặn lại: chuột vọt nhanh ra khỏi thanh trên ngay nhịp đầu (trước khi kịp bắt
    // con trỏ) thì nhịp đó cũng không tới vùng hình, không dời chuột của máy kia (đã thấy khi kiểm).
    e.stopPropagation();
    g.x = e.clientX;
    g.y = e.clientY;
    if (!g.live) {
      if (Math.hypot(g.x - g.x0, g.y - g.y0) < FLOAT_MOVE_PX) return;
      liveFloatGesture(g);
    }
    if (!g.frame) g.frame = requestAnimationFrame(() => applyGesture(g));
  };
  // Thả tay, trình duyệt huỷ (pointercancel) hay khung nổi mất bắt con trỏ: khung ở yên chỗ đang đứng và được lưu.
  const onFloatUp = (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    // Thả tay lệch ra ngoài khung nổi (vừa trượt khỏi thanh trên, chưa kịp tính là kéo) thì không để lần nhả nút đó
    // tới vùng hình: screen.js sẽ gửi nhả chuột sang máy kia. Thả trong khung nổi thì để yên cho nút bấm như thường.
    if (e.type !== 'lostpointercapture' && !floatHost.contains(e.target)) e.stopPropagation();
    endFloatGesture(true);
  };
  // Chỉ tính lần khung nổi tự mất bắt. Màn cảm ứng tự bắt con trỏ vào chỗ ngón tay chạm (nút tên phiên); lúc khung
  // nổi giành lấy, nút đó nhận lostpointercapture và sự kiện nổi lên tới đây, không phải là thả tay (đã thấy khi
  // kiểm: kéo bằng ngón tay chỉ dời được một nhịp rồi dừng).
  const onFloatLost = (e) => {
    if (e.target === floatHost) onFloatUp(e);
  };

  // save: lưu chỗ mới. Không lưu khi ẩn khung hay khi khung đổi khung chứa (vào ra toàn màn hình) giữa chừng.
  function endFloatGesture(save) {
    const g = gesture;
    if (!g) return;
    gesture = null;
    window.removeEventListener('pointermove', onFloatMove, true);
    window.removeEventListener('pointerup', onFloatUp, true);
    window.removeEventListener('pointercancel', onFloatUp, true);
    floatHost.removeEventListener('lostpointercapture', onFloatLost);
    if (!g.live) return;
    cancelAnimationFrame(g.frame);
    document.documentElement.classList.remove('float-moving');
    floatHost.classList.remove('moving');
    try {
      if (floatHost.hasPointerCapture?.(g.id)) floatHost.releasePointerCapture(g.id);
    } catch {
      // con trỏ đã nhả
    }
    if (!save) return;
    applyGesture(g); // nhịp cuối chưa kịp vẽ
    saveFloatBox(g.frame0.area);
    // Cú bấm theo sau lần kéo (nếu trình duyệt còn gửi) không được bấm nút nằm dưới chỗ thả.
    const swallow = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    floatHost.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => floatHost.removeEventListener('click', swallow, { capture: true }), 0);
  }

  function saveFloatBox(area) {
    const r = floatRect;
    if (!r || area.w <= 0 || area.h <= 0) return;
    const frac = (n) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
    floatBox = { x: frac((r.l - area.l) / area.w), y: frac((r.t - area.t) / area.h), w: frac(r.w / area.w), h: frac(r.h / area.h) };
    try {
      localStorage.setItem(FLOAT_BOX_KEY, JSON.stringify(floatBox));
    } catch {
      // trình duyệt chặn lưu: lần sau khung về chỗ mặc định
    }
  }

  floatHost.addEventListener('pointerdown', (e) => {
    if (gesture || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const grip = e.target.closest?.('.float-grip');
    const bar = !grip && e.target.closest?.('.topbar');
    if (!grip && !bar) return;
    if (!floatRect) placeFloat();
    if (!floatRect) return;
    gesture = { id: e.pointerId, edge: grip ? grip.dataset.edge : '', x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, start: { ...floatRect }, frame0: floatFrame(floatTarget()), frame: 0, live: false };
    window.addEventListener('pointermove', onFloatMove, true);
    window.addEventListener('pointerup', onFloatUp, true);
    window.addEventListener('pointercancel', onFloatUp, true);
    floatHost.addEventListener('lostpointercapture', onFloatLost);
    if (grip) {
      e.preventDefault(); // không bôi đen chữ, không cuộn
      liveFloatGesture(gesture);
    }
  });
  // Khung hình đổi cỡ (cửa sổ, cột bên), cuộn màn máy, vào ra toàn màn hình: đặt lại, gộp trong một khung hình vẽ.
  let placeQueued = false;
  const queuePlace = () => {
    if (!floatId || placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      if (floatId) placeFloat();
    });
  };
  const floatWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(queuePlace) : null;
  floatWatch?.observe(screenHost);
  window.addEventListener?.('resize', queuePlace);
  main.addEventListener('scroll', queuePlace, { passive: true });
  document.addEventListener('fullscreenchange', queuePlace);

  function toggleDrop(force) {
    dropOpen = force ?? !dropOpen;
    drop.classList.toggle('open', dropOpen);
    dropBtn.classList.toggle('open', dropOpen);
    if (dropOpen) {
      loadPast(id, PAST_TTL_MS);
      renderDrop();
    }
  }
  const onOutside = (e) => { if (dropOpen && !actions.contains(e.target)) toggleDrop(false); };
  document.addEventListener('pointerdown', onOutside);

  // Phiên cũ trên máy: đầu máy đọc nhật ký Claude Code tự ghi (mọi phiên, kể cả phiên VS Code đã đóng), mỗi lần mở
  // danh sách, trừ khi vừa đọc trong PAST_TTL_MS (lib/past.js, chung với màn chính). Máy đang tắt thì giữ danh sách
  // đọc lần trước. Đọc xong thì lib/past.js báo "past" và danh sách vẽ lại.
  function renderDrop() {
    const m = store.machines.get(id);
    if (!m || !dropOpen) return;
    const scroll = drop.scrollTop; // dựng lại (máy báo trạng thái mới) không làm nhảy chỗ đang cuộn
    clear(drop);
    add(drop, sessionDropContent(m, pastOf(id), { id: floatId, toggle: toggleFloat }));
    drop.scrollTop = scroll;
  }

  // ---- Tắt máy -----------------------------------------------------------------------------------
  // Lịch tắt đang chờ: dòng báo giờ tắt, đếm ngược mỗi giây (chỉ khi có lịch), kèm nút huỷ. Dựng một
  // lần, mỗi giây chỉ đổi chữ số còn lại, để nút huỷ không bị thay giữa lúc đang chạm.
  // m.power.at đã theo đồng hồ điện thoại (store.js đổi từ số mili giây còn lại).
  let powerAt = 0;
  let powerTick = null;
  const powerWhen = h('b');
  const powerLeft = h('span', { class: 'power-left' });
  add(powerNote, h('div', { class: 'power-line' },
    icon('power', 16),
    h('span', null, powerWhen, powerLeft),
    h('button', { class: 'btn small danger-outline', onclick: () => cancelPower() }, 'Huỷ tắt máy')));

  function paintPower() {
    const ms = powerAt - Date.now();
    if (ms < -60 * 1000) {
      // Quá giờ một phút mà máy vẫn nối: lịch đã bị huỷ ngay trên máy.
      renderPower(null);
      return;
    }
    const left = Math.max(0, Math.round(ms / 1000));
    const hms = [Math.floor(left / 3600), Math.floor((left % 3600) / 60), left % 60]
      .map((n, i) => (i ? String(n).padStart(2, '0') : String(n))).join(':');
    powerLeft.textContent = `Còn ${hms}`;
  }

  function renderPower(m) {
    const at = m?.online ? m.power?.at || 0 : 0;
    powerNote.classList.toggle('hidden', !at);
    if (at !== powerAt) {
      powerAt = at;
      powerWhen.textContent = at ? `Máy sẽ tắt lúc ${new Date(at).toLocaleTimeString('vi-VN', { hour12: false })}` : '';
    }
    if (!at) {
      clearInterval(powerTick);
      powerTick = null;
      return;
    }
    paintPower();
    if (!powerTick) powerTick = setInterval(paintPower, 1000);
  }

  async function cancelPower() {
    try {
      await api.post(`/api/machines/${id}/power`, { action: 'cancel' });
      toast('Đã huỷ lịch tắt máy.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function schedulePower(delaySec, label) {
    try {
      await api.post(`/api/machines/${id}/power`, { action: 'shutdown', delaySec });
      toast(label);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Bảng chọn: tắt ngay (hỏi lại), sau 15 giây, sau 30 giây, hay hẹn giờ tự điền (giờ, phút).
  function openPowerSheet() {
    const m = store.machines.get(id);
    if (!m) return;
    const { body, close } = openSheet(`Tắt máy ${m.name}`);
    const running = sessionsOf(id).filter((s) => RUNNING.has(s.status)).length;
    const pick = (label, hint, delaySec) => h('button', {
      class: 'pick-option',
      onclick: async () => {
        if (delaySec === 0 && !window.confirm(`Tắt máy ${m.name} ngay bây giờ? Mọi ứng dụng đang mở sẽ bị đóng, việc chưa lưu sẽ mất.`)) return;
        close();
        await schedulePower(delaySec, delaySec ? `Máy ${m.name} sẽ tắt sau ${delaySec} giây.` : `Đang tắt máy ${m.name}.`);
      },
    }, h('span', { class: 'pick-label' }, label), h('span', { class: 'pick-hint' }, hint));
    const hours = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: 0, max: 168, value: 0, 'aria-label': 'Số giờ' });
    const minutes = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: 0, max: 59, value: 30, 'aria-label': 'Số phút' });
    const scheduleBtn = h('button', {
      class: 'btn primary',
      onclick: async () => {
        const hh = Math.max(0, Math.floor(Number(hours.value) || 0));
        const mm = Math.max(0, Math.floor(Number(minutes.value) || 0));
        const total = hh * 3600 + mm * 60;
        if (!total) {
          toast('Điền số giờ hay số phút lớn hơn 0.', 'error');
          return;
        }
        if (hh > 168) {
          toast('Hẹn tối đa 168 giờ (một tuần).', 'error');
          return;
        }
        close();
        const at = new Date(Date.now() + total * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
        await schedulePower(total, `Máy ${m.name} sẽ tắt lúc ${at}.`);
      },
    }, icon('power', 16), 'Hẹn tắt');
    add(body,
      m.local ? h('div', { class: 'notice warn' }, 'Đây là máy giữ trạm: tắt máy này thì app mất kết nối tới mọi máy cho tới khi nó được bật lại.') : null,
      running ? h('div', { class: 'notice warn' }, `${running} phiên đang chạy trên máy này sẽ bị cắt.`) : null,
      m.power?.at ? h('div', { class: 'notice' }, 'Máy đang có lịch tắt; chọn lịch mới sẽ thay lịch cũ.') : null,
      pick('Tắt ngay', 'Đóng mọi ứng dụng rồi tắt; hỏi lại trước khi tắt', 0),
      pick('Tắt sau 15 giây', 'Còn kịp huỷ trên app', 15),
      pick('Tắt sau 30 giây', 'Còn kịp huỷ trên app', 30),
      h('div', { class: 'power-schedule' },
        h('div', { class: 'field-label' }, 'Hẹn giờ tắt sau'),
        h('div', { class: 'power-inputs' },
          h('label', { class: 'power-unit' }, hours, h('span', null, 'giờ')),
          h('label', { class: 'power-unit' }, minutes, h('span', null, 'phút')),
          scheduleBtn)));
  }

  // Bật máy qua mạng: trạm nhờ các máy đang bật cùng mạng (hay chính nó) bắn gói bật máy. Máy lên
  // và nối lại trạm thì màn tự đổi sang "Đang nối" (render theo sự kiện máy).
  async function wake() {
    wakeBtn.disabled = true;
    try {
      const r = await api.post(`/api/machines/${id}/wake`);
      clear(wakeNote);
      wakeNote.className = `notice wake-note ${r.sameNetwork ? '' : 'warn'}`;
      add(wakeNote,
        h('b', null, `Đã gửi tín hiệu bật máy từ ${r.sentFrom.join(', ')}.`),
        h('div', null, 'Máy thường lên sau 30 đến 90 giây rồi tự hiện "Đang nối".'),
        r.sameNetwork ? null : h('div', null, 'Không có máy nào đang bật cùng mạng nội bộ với máy này, nên tín hiệu nhiều khả năng không tới: tín hiệu bật máy chỉ đi trong một mạng nội bộ.'),
        h('div', { class: 'dim' }, 'Không lên? Máy đó cần cắm dây mạng, BIOS bật Wake on LAN và tắt ErP, và đã chạy setup.cmd (bật Wake-on-LAN trong Windows, tắt Fast Startup).'));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      wakeBtn.disabled = false;
    }
  }

  // ---- Kết quả setup gần nhất (lệnh "Setup máy" hay setup.cmd) --------------------------------
  // Biểu tượng đồng bộ trên thanh trên: tick xanh là đủ cả, mũi tên xoay là đang chạy, dấu X là còn
  // thiếu (hay cần người ngồi tại máy). Chạm thì xổ bảng chi tiết, tự cập nhật khi máy báo bước mới.
  let syncOpen = false;
  function syncState(r) {
    if (!r?.at) return '';
    // Setup đang chạy mà quá lâu không báo bước nào (bị tắt giữa chừng): không xoay mãi. Mốc giờ là
    // đồng hồ của máy kia, có thể lệch vài phút, nên chừa rộng.
    if (!r.done) return Date.now() - Date.parse(r.at) > SETUP_STALE_MS ? 'stale' : 'busy';
    return r.ok ? 'ok' : 'fail';
  }

  // Máy đang bật thì luôn có biểu tượng (kể cả chưa từng báo kết quả setup), để mở bảng mà bấm Setup.
  function renderSync(m) {
    const r = m?.setup;
    const state = syncState(r);
    const shown = Boolean(state || m?.online);
    syncBtn.className = `icon-btn sync-btn ${shown ? state || 'none' : 'hidden'}${syncOpen && shown ? ' open' : ''}`;
    syncBtn.setAttribute('aria-label', SYNC_LABEL[state] || 'Setup máy này');
    syncBtn.title = SYNC_LABEL[state] || 'Setup máy này';
    clear(syncBadge);
    if (state === 'ok') syncBadge.append(icon('check', 11));
    else if (state === 'fail' || state === 'stale') syncBadge.append(icon('x', 11));
    if (!shown && syncOpen) toggleSync(false);
    if (syncOpen) renderSyncPop(m, state);
  }

  function renderSyncPop(m, state) {
    const r = m?.setup || {};
    const what = r.mode === 'auto' ? 'Setup tự động' : r.mode === 'doctor' ? 'Kiểm máy' : 'Setup';
    const when = r.at ? clockTime(r.at) : '';
    const head = {
      busy: `${what} đang chạy, bước gần nhất lúc ${when}…`,
      stale: `${what} không báo thêm bước nào từ ${when}: có thể đã dừng giữa chừng.`,
      ok: `${what} lúc ${when}: đủ cả.`,
      fail: `${what} lúc ${when}: còn thiếu.`,
    }[state] || 'Máy chưa báo kết quả setup nào.';
    const list = (label, items, cls) => (items?.length ? h('div', { class: `sync-group ${cls}` },
      h('div', { class: 'sync-label' }, label),
      items.map((x) => h('div', { class: 'sync-item' }, h('b', null, x.title), x.detail ? h('span', null, x.detail) : null))) : null);
    clear(syncPop);
    add(syncPop,
      h('div', { class: `sync-head ${state || 'none'}` }, icon(state === 'ok' ? 'check' : state === 'busy' ? 'rotate' : state ? 'x' : 'settings', 16), h('span', null, head)),
      // Kéo code hỏng thì đã có mục riêng (kèm lời git) trong "Chưa xong": khỏi ghi hai lần.
      r.pull && !r.failed?.some((x) => x.title.startsWith('Lấy code Orbit')) ? h('div', { class: 'sync-line' }, `Code Orbit Remote: ${r.pull}.`) : null,
      list('Chưa xong', r.failed, 'fail'),
      list('Cần người ngồi tại máy (nháy đúp setup.cmd)', r.needsUser, 'user'),
      list('Lưu ý', r.warnings, 'warn'),
      state === 'ok' && !r.warnings?.length ? h('div', { class: 'sync-line dim' }, 'Máy có đủ mọi thứ Orbit Remote cần.') : null,
      setupButton(m, state));
  }

  // Chạy setup cho máy này ngay từ bảng: như "Setup <máy>" ở Lệnh nhanh của một phiên. Máy kéo code Orbit Remote
  // mới, cài phần còn thiếu (trừ bước cần người ngồi tại máy) rồi chạy lại đầu máy; bảng tự cập nhật
  // theo từng bước máy báo về.
  function setupButton(m, state) {
    const busy = state === 'busy';
    const btn = h('button', {
      class: 'btn primary small block sync-run',
      disabled: busy || !m?.online || setupAsked,
      onclick: async () => {
        if (!window.confirm(`Setup máy ${m.name}? Máy sẽ kéo code Orbit Remote mới, cài những gì còn thiếu (trừ bước cần người ngồi tại máy) rồi chạy lại đầu máy: các phiên đang chạy trên máy đó sẽ bị cắt.`)) return;
        setupAsked = true;
        btn.disabled = true;
        try {
          await api.post(`/api/machines/${id}/update`);
          toast(`Đang setup máy ${m.name}. Bảng này cập nhật theo từng bước.`);
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          // Máy báo bước đầu thì nút tắt theo trạng thái "đang chạy"; chờ một lúc rồi cho bấm lại.
          setTimeout(() => { setupAsked = false; renderSync(store.machines.get(id)); }, 8000);
        }
      },
    }, icon('rotate', 15), busy ? 'Setup đang chạy…' : !m?.online ? 'Máy đang tắt' : 'Setup máy này');
    return h('div', { class: 'sync-actions' }, btn);
  }
  let setupAsked = false; // vừa bấm Setup: khỏi bấm chồng trong lúc chờ máy báo bước đầu

  function toggleSync(force) {
    syncOpen = force ?? !syncOpen;
    syncPop.classList.toggle('open', syncOpen);
    syncBtn.classList.toggle('open', syncOpen);
    const m = store.machines.get(id);
    if (syncOpen) renderSyncPop(m, syncState(m?.setup));
  }
  const onOutsideSync = (e) => { if (syncOpen && !syncPop.contains(e.target) && !syncBtn.contains(e.target)) toggleSync(false); };
  document.addEventListener('pointerdown', onOutsideSync);

  // ---- Nhiệt độ máy ---------------------------------------------------------------------------
  // Hỏi trạm theo nhịp đo của máy (src/sensors.mjs) khi màn đang mở, máy đang bật và app đang hiện. Đầu
  // máy chỉ đo khi còn người hỏi, nên rời màn này hay ẩn app là máy thôi đo.
  let temps = null; // câu trả lời gần nhất: { state, items: [{ id, label, detail, c }], notes, at, interval }
  let tempError = '';
  let tempOpen = false;
  let tempTimer = null;
  let tempBusy = false;
  let disposed = false;
  const tempRows = new Map(); // id cảm biến -> { row, val, fill }: cập nhật tại chỗ để thanh nhiệt trượt êm

  async function pollTemps() {
    clearTimeout(tempTimer);
    tempTimer = null;
    if (disposed || tempBusy || !store.machines.get(id)?.online || document.visibilityState === 'hidden') return;
    tempBusy = true;
    let wait;
    try {
      temps = await api.get(`/api/machines/${id}/temps`);
      tempError = '';
      // Lần hỏi đầu chỉ bật bộ đo trên máy: hỏi lại sớm cho số đầu tiên hiện nhanh.
      wait = temps.state === 'warming' ? 1500 : (temps.interval || 5) * 1000;
    } catch (err) {
      tempError = err.message;
      wait = 30000;
    } finally {
      tempBusy = false;
    }
    if (disposed) return;
    renderTemp();
    tempTimer = setTimeout(pollTemps, wait);
  }
  const ensureTempPoll = () => { if (!tempTimer && !tempBusy) pollTemps(); };
  const onVisible = () => { if (document.visibilityState === 'visible') ensureTempPoll(); };
  document.addEventListener('visibilitychange', onVisible);

  const hottestOf = (items) => items.reduce((a, x) => (!a || x.c > a.c ? x : a), null);

  function renderTemp() {
    const m = store.machines.get(id);
    const items = temps?.state === 'ready' ? temps.items || [] : [];
    const hottest = hottestOf(items);
    const level = hottest ? tempLevel(hottest.c) : null;
    const shown = Boolean(m?.online);
    tempBtn.className = `icon-btn temp-btn${shown ? '' : ' hidden'}${level ? ` lv-${level.id}` : ''}${tempOpen && shown ? ' open' : ''}`;
    const label = hottest ? `Nhiệt độ máy: ${hottest.label} ${fmtTemp(hottest.c)}, ${level.label.toLowerCase()}` : 'Nhiệt độ máy';
    tempBtn.setAttribute('aria-label', label);
    tempBtn.title = label;
    if (!shown && tempOpen) toggleTemp(false);
    if (tempOpen) renderTempPop();
  }

  function renderTempPop() {
    const items = temps?.state === 'ready' ? temps.items || [] : [];
    const level = items.length ? tempLevel(hottestOf(items).c) : null;
    const message = tempError || (!temps || temps.state === 'warming' ? 'Đang đo lần đầu…' : '');
    // Dàn khung một lần cho mỗi lần mở; các lần đo sau chỉ đổi số, màu và độ dài thanh.
    if (!tempPop.firstChild) {
      tempRows.clear();
      add(tempPop,
        h('div', { class: 'temp-top' },
          h('div', { class: 'sync-head none temp-head' }, icon('thermo', 16), h('span', null, 'Nhiệt độ máy')),
          h('span', { class: 'temp-state' })),
        h('div', { class: 'temp-msg sync-line' }),
        h('div', { class: 'temp-list' }),
        h('div', { class: 'temp-legend' }, TEMP_LEVELS.map((l) => h('span', { class: `lv-${l.id}` }, h('i'), l.range))),
        h('div', { class: 'temp-notes' }),
        h('div', { class: 'temp-foot' }));
    }
    const state = tempPop.querySelector('.temp-state');
    state.className = `temp-state${level ? ` lv-${level.id}` : ' hidden'}`;
    state.textContent = level ? level.label : '';
    const msg = tempPop.querySelector('.temp-msg');
    msg.textContent = message || (temps?.state === 'ready' && !items.length ? 'Máy này chưa có cảm biến nào đọc được.' : '');
    msg.classList.toggle('hidden', !msg.textContent);

    const listEl = tempPop.querySelector('.temp-list');
    const keep = new Set(items.map((x) => x.id));
    for (const [key, r] of tempRows) if (!keep.has(key)) { r.row.remove(); tempRows.delete(key); }
    for (const x of items) {
      let r = tempRows.get(x.id);
      if (!r) {
        const name = h('b');
        const detail = h('span');
        const val = h('div', { class: 'temp-val' });
        const fill = h('i');
        const row = h('div', { class: 'temp-row' }, h('div', { class: 'temp-name' }, name, detail), val, h('div', { class: 'temp-bar' }, fill));
        r = { row, name, detail, val, fill };
        tempRows.set(x.id, r);
        listEl.append(row);
      }
      const lv = tempLevel(x.c);
      r.row.className = `temp-row lv-${lv.id}`;
      r.name.textContent = x.label;
      r.detail.textContent = x.detail || '';
      r.val.textContent = fmtTemp(x.c);
      r.fill.style.width = `${Math.round(Math.max(0.04, Math.min(1, (x.c - TEMP_BAR_MIN) / (TEMP_BAR_MAX - TEMP_BAR_MIN))) * 100)}%`;
    }

    const notes = tempPop.querySelector('.temp-notes');
    clear(notes);
    if (!message) for (const n of temps?.notes || []) notes.append(h('div', { class: 'sync-line dim' }, n));
    const foot = tempPop.querySelector('.temp-foot');
    foot.textContent = temps?.at && !message
      ? `Đo lúc ${new Date(temps.at).toLocaleTimeString('vi-VN', { hour12: false })} · tự cập nhật mỗi ${temps.interval || 5} giây`
      : '';
  }

  function toggleTemp(force) {
    tempOpen = force ?? !tempOpen;
    tempPop.classList.toggle('open', tempOpen);
    tempBtn.classList.toggle('open', tempOpen);
    if (tempOpen) {
      clear(tempPop);
      renderTempPop();
      ensureTempPoll();
    }
  }
  const onOutsideTemp = (e) => { if (tempOpen && !tempPop.contains(e.target) && !tempBtn.contains(e.target)) toggleTemp(false); };
  document.addEventListener('pointerdown', onOutsideTemp);

  function render() {
    const m = store.machines.get(id);
    if (!m) {
      title.textContent = 'Máy không còn';
      clear(main).append(h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, 'Máy này đã bị quên')));
      screenPanel?.destroy();
      screenPanel = null;
      return;
    }
    title.textContent = m.name;
    subtitle.textContent = [m.online ? 'Đang nối' : `Đang tắt · ${timeAgo(m.lastSeen)} trước`, PLATFORM[m.platform] || m.platform, m.local ? 'máy giữ trạm' : '']
      .filter(Boolean).join(' · ');
    view.classList.toggle('offline', !m.online);
    newBtn.disabled = !m.online;
    newBtn.classList.toggle('hidden', !m.online);
    wakeBtn.classList.toggle('hidden', m.online);
    powerBtn.classList.toggle('hidden', !m.online);
    if (m.online) wakeNote.classList.add('hidden');
    renderPower(m);
    renderControl(controlNote, m);
    const running = sessionsOf(id).filter((s) => RUNNING.has(s.status)).length + (m.external?.length || 0);
    countBadge.textContent = running ? String(running) : '';
    countBadge.classList.toggle('hidden', !running);
    renderDrop();
    renderSync(m);
    renderTemp();
    if (m.online) ensureTempPoll();

    // Khung màn hình dựng một lần rồi giữ nguyên, để cập nhật trạng thái máy không cắt luồng hình.
    if (m.screen && !screenPanel) screenPanel = mountScreenPanel(screenHost, m);
    screenPanel?.setOnline(m.online);
    notice.classList.toggle('hidden', Boolean(m.screen) || !m.online); // máy tắt thì lời nhắc về màn hình không đúng lúc
    notice.textContent = m.screen ? '' : (m.platform === 'win32'
      ? 'Đầu máy trên máy này chưa có phần xem màn hình. Mở một phiên Claude trên máy đó để nó tự cập nhật.'
      : 'Xem và điều khiển màn hình hiện chỉ có cho máy Windows.');
  }

  render();
  const offs = [
    store.on('state', render),
    store.on('machine', (m) => { if (m.id === id) render(); }),
    store.on('machine_removed', (mid) => { if (mid === id) render(); }),
    store.on('session', (s) => { if (s.machineId === id) render(); }),
    store.on('session_removed', render),
    store.on('past', (mid) => { if (mid === id) renderDrop(); }),
  ];
  if (openList && store.machines.get(id)) toggleDrop(true);
  const tick = setInterval(render, 30000);
  // Phiên nổi lần trước của máy này (còn trong danh sách và vẫn thuộc máy này) thì mở lại.
  let savedFloat = '';
  try {
    savedFloat = localStorage.getItem(FLOAT_KEY) || '';
  } catch {
    savedFloat = '';
  }
  if (savedFloat && store.sessions.get(savedFloat)?.machineId === id) showFloat(savedFloat);
  return () => {
    offs.forEach((off) => off());
    clearInterval(tick);
    clearInterval(powerTick);
    endFloatGesture(false);
    floatUnmount?.();
    floatWatch?.disconnect();
    window.removeEventListener?.('resize', queuePlace);
    document.removeEventListener('fullscreenchange', queuePlace);
    disposed = true;
    clearTimeout(tempTimer);
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('pointerdown', onOutside);
    document.removeEventListener('pointerdown', onOutsideSync);
    document.removeEventListener('pointerdown', onOutsideTemp);
    screenPanel?.destroy();
  };
}

// ---- Xem chỉ-đọc một phiên ngoài app --------------------------------------------------------
// Phiên cũ (đã đóng) trong danh sách phiên của máy, đổi sang dạng của phiên ngoài app.
const fromPast = (t) => ({ claudeSessionId: t.claudeSessionId, title: t.title, cwd: t.cwd, modified: t.modified, active: Boolean(t.maybeActive), open: false, past: true });

// fromHome: mở từ màn chính (đường dẫn có đuôi /h) thì nút quay lại về màn chính, không sang màn của máy.
export function mountExternal(root, machineId, csid, { fromHome = false } = {}) {
  const machine = store.machines.get(machineId);
  const findEntry = () => {
    const open = store.machines.get(machineId)?.external?.find((t) => t.claudeSessionId === csid);
    if (open) return open;
    const old = pastOf(machineId).list.find((t) => t.claudeSessionId === csid);
    return old ? fromPast(old) : null;
  };
  const timeline = h('main', { class: 'timeline scroll' }, h('div', { class: 'loading' }, 'Đang đọc nhật ký…'));
  const renderer = createRenderer();
  const title = h('div', { class: 'title' });
  const subtitle = h('div', { class: 'subtitle' });
  const more = h('button', { class: 'icon-btn hidden', 'aria-label': 'Thao tác', onclick: () => { const e = findEntry(); if (e) openExternalSheet(machineId, e); } }, icon('more'));
  const barText = h('span');
  const view = h('div', { class: 'view external' },
    h('header', { class: 'topbar' },
      h('a', { class: 'icon-btn', href: fromHome ? '#/' : `#/m/${machineId}`, 'aria-label': 'Quay lại' }, icon('back')),
      h('div', { class: 'title-wrap static' }, title, subtitle),
      more),
    h('div', { class: 'readonly-bar' }, icon('history', 14), barText),
    timeline);
  root.append(view);

  function paintHead() {
    const entry = findEntry();
    title.textContent = entry?.title || 'Phiên trên máy';
    subtitle.textContent = [machine?.name, baseName(entry?.cwd), 'chỉ xem'].filter(Boolean).join(' · ');
    more.classList.toggle('hidden', !entry);
    barText.textContent = entry?.past
      ? 'Phiên này đã đóng. Ở đây chỉ xem; muốn làm tiếp thì bấm ⋯ rồi "Tiếp tục ở app".'
      : 'Phiên này đang chạy ngoài app. Ở đây chỉ xem; muốn điều khiển thì "Tiếp tục" hoặc "Tách nhánh".';
  }
  paintHead();
  // Mở thẳng bằng đường dẫn (tải lại trang) mà chưa có danh sách phiên cũ: hỏi máy một lần.
  if (!findEntry() && machine?.online) loadPast(machineId, 0).then(paintHead);

  let mtime = 0;
  let stopped = false;
  async function load() {
    if (stopped || document.visibilityState !== 'visible') return;
    try {
      const data = await api.get(`/api/machines/${machineId}/history/${csid}${mtime ? `?since=${mtime}` : ''}`);
      if (stopped || data.unchanged) return;
      mtime = data.mtime;
      const stick = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 140 || !timeline.childElementCount;
      clear(timeline);
      renderer.reset();
      const frag = document.createDocumentFragment();
      if (data.truncated) frag.append(h('div', { class: 'sys' }, 'Chỉ hiện phần cuối của một nhật ký rất dài.'));
      for (const ev of data.events) {
        const el = renderer.render(ev);
        if (el) frag.append(el);
      }
      timeline.append(frag);
      if (!data.events.length) timeline.append(h('div', { class: 'empty small' }, 'Nhật ký chưa có nội dung.'));
      if (stick) timeline.scrollTop = timeline.scrollHeight;
    } catch (err) {
      clear(timeline).append(h('div', { class: 'empty small' }, err.message));
    }
  }
  load();
  const timer = setInterval(load, WATCH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
