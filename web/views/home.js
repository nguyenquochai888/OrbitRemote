// Màn chính: máy mới xin nối, nút tuỳ biến, cây máy và phiên (Online, Offline; views/tree.js), và nút mở
// phiên mới. Thẻ phiên kéo thả được vào khối nhóm (lib/drag.js).

import { h, clear, timeAgo, baseName, workDir, workPlace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { store } from '../lib/store.js';
import { api } from '../lib/api.js';
import { actionsFor, runAction } from '../lib/custom.js';
import { openNewSession } from './sheets.js';
import { enrollmentCards } from './machines.js';
import { isOpenGroup, addToGroup } from './group.js';
import { homeTree } from './tree.js';
import { enableSessionDrag, isDragging } from '../lib/drag.js';
import { modelUpdateButton, sessionModel } from '../lib/models.js';
import { openClaudeLogin } from './claude-login.js';

export const STATUS_LABEL = {
  starting: 'Đang mở',
  idle: 'Sẵn sàng',
  busy: 'Đang làm',
  waiting: 'Cần duyệt',
  stopped: 'Đã dừng',
  crashed: 'Hỏng',
};

const RUNNING = new Set(['starting', 'idle', 'busy', 'waiting']);

// Màn đang mở ở cột phải (bản PC, hai cột): thẻ của nó trong cột trái được đánh dấu.
// Phiên mở từ màn nhóm hay màn máy mang thêm đuôi /g/<nhóm>, /m/<máy> (đường quay lại).
export const isOpenSession = (id) => {
  const hash = location.hash || '';
  return hash === `#/s/${id}` || hash.startsWith(`#/s/${id}/`);
};
export const isOpenMachine = (id) => {
  const hash = location.hash || '';
  return hash === `#/m/${id}` || hash.startsWith(`#/m/${id}/`) || hash.startsWith(`#/x/${id}/`);
};

export function topbarBrand() {
  return h('div', { class: 'brand-wrap' },
    h('img', { class: 'brand-icon', src: '/icons/icon-192.png', alt: '' }),
    h('span', { class: 'brand' }, 'Orbit Remote'),
    h('span', { class: `conn-dot ${store.connected ? 'on' : 'off'}`, title: store.connected ? 'Đang nối trạm' : 'Mất kết nối' }));
}

// showMachine: thẻ nằm dưới nhãn máy của nó thì khỏi nhắc lại tên máy.
export function sessionCard(s, { showMachine = true } = {}) {
  const machine = store.machines.get(s.machineId);
  const offline = machine && !machine.online && RUNNING.has(s.status);
  const meta = [showMachine ? workPlace(s) : s.remote?.machine ? `→ ${s.remote.machine}` : '', baseName(workDir(s)), sessionModel(s)].filter(Boolean).join(' · ');
  const team = store.groupOf(s.id);
  const role = team?.members.find((m) => m.id === s.id)?.role;
  return h('a', { class: `card session-card status-${s.status}${offline ? ' offline' : ''}${isOpenSession(s.id) ? ' current' : ''}`, href: `#/s/${s.id}`, 'data-sid': s.id },
    h('div', { class: 'card-top' },
      h('span', { class: 'status-dot' }),
      h('span', { class: 'card-name' }, s.name),
      team ? h('span', { class: 'team-tag', title: `Nhóm ${team.name}` }, icon('group', 12), role ? `$${role}` : team.name) : null,
      h('span', { class: 'card-time' }, timeAgo(s.lastActivity))),
    h('div', { class: 'card-meta' }, meta),
    s.lastText ? h('div', { class: 'card-preview' }, s.lastText) : null,
    s.pending?.length
      ? h('div', { class: 'card-pending' }, icon('shield', 14), `Cần duyệt: ${s.pending.map((p) => p.tool).join(', ')}`)
      : null,
    offline && showMachine ? h('div', { class: 'card-offline' }, `Máy ${s.machine} đang mất kết nối`) : null);
}

export function mountHome(root) {
  const brandSlot = h('div');
  const enrollSlot = h('div', { class: 'enroll-slot' });
  const quickRow = h('div', { class: 'chip-row quick-row' });
  const list = h('div', { class: 'home-list' });
  const channelBadge = h('span', { class: 'badge hidden' });

  // Cài đặt và Kênh: bấm lần nữa khi đang mở thì đóng, về đúng màn đang xem trước đó (bản PC hai cột,
  // nơi hai nút này vẫn nằm ở cột trái lúc màn đó mở bên phải).
  const isPanel = (hash) => /^#\/(settings|channel)/.test(hash || '');
  let lastMain = isPanel(location.hash) ? '#/' : location.hash || '#/';
  const panelBtn = (hash, label, content) => h('a', {
    class: 'icon-btn panel-btn', href: hash, 'aria-label': label, title: label,
    onclick: (e) => {
      if (!(location.hash || '').startsWith(hash)) return; // chưa mở: mở như thường
      e.preventDefault();
      location.hash = lastMain;
    },
  }, content);
  const channelBtn = panelBtn('#/channel', 'Kênh giữa các phiên', [icon('channel'), channelBadge]);
  const settingsBtn = panelBtn('#/settings', 'Cài đặt', icon('settings'));
  const usage = usagePanel();
  const models = modelUpdateButton(); // nút cập nhật bản model, bên phải nút Mức dùng Claude (lib/models.js)
  const view = h('div', { class: 'view home' },
    h('header', { class: 'topbar' },
      brandSlot,
      h('div', { class: 'topbar-actions' }, channelBtn, settingsBtn, usage.button, models.button),
      usage.pop),
    h('main', { class: 'scroll home-scroll' }, enrollSlot, quickRow, list),
    h('button', { class: 'fab', 'aria-label': 'Mở phiên mới', onclick: () => openNewSession() }, icon('plus', 26)));

  function renderBrand() {
    clear(brandSlot).append(topbarBrand());
  }

  function renderQuick() {
    clear(quickRow);
    const actions = actionsFor('home');
    quickRow.classList.toggle('hidden', !actions.length);
    for (const a of actions) {
      quickRow.append(h('button', { class: 'chip action-chip', onclick: () => runAction(a) }, a.icon ? icon(a.icon, 15) : null, a.label));
    }
  }

  function renderEnrollments() {
    clear(enrollSlot);
    const cards = enrollmentCards();
    if (cards) enrollSlot.append(cards);
  }

  // Đang kéo một thẻ phiên thì hoãn vẽ lại (chỗ thả đang sáng sẽ mất), thả tay xong mới vẽ bù.
  let deferred = false;
  function renderList() {
    if (isDragging()) {
      deferred = true;
      return;
    }
    deferred = false;
    clear(list);
    if (!store.sessions.size && !store.machines.size && !store.groups.size) {
      list.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-orb' }),
        h('div', { class: 'empty-title' }, 'Chưa có máy nào'),
        h('div', { class: 'empty-text' }, 'Bật một máy có Orbit Remote lên là nó tự xin nối vào trạm, rồi mở phiên Claude trên máy đó bằng nút +.')));
      return;
    }
    list.append(homeTree());
  }

  function renderBadge() {
    const unseen = store.channel.length - Number(sessionStorage.getItem('orbit-channel-seen') || 0);
    channelBadge.textContent = unseen > 9 ? '9+' : String(unseen);
    channelBadge.classList.toggle('hidden', unseen <= 0);
  }

  const renderAll = () => {
    renderBrand();
    renderEnrollments();
    renderQuick();
    renderList();
    renderBadge();
  };
  renderAll();
  root.append(view);

  const offs = [
    store.on('state', renderAll),
    store.on('session', renderList),
    store.on('session_removed', renderList),
    store.on('machine', renderList),
    store.on('machine_removed', renderList),
    store.on('enrollments', renderEnrollments),
    store.on('group', renderList),
    store.on('group_removed', renderList),
    store.on('actions', renderQuick),
    store.on('connection', renderBrand),
    store.on('channel', renderBadge),
    store.on('channel-seen', renderBadge),
    store.on('route', (hash) => {
      if (!isPanel(hash)) lastMain = hash || '#/';
      markCurrent();
    }),
  ];
  markCurrent();
  // Hai cột: đổi màn ở cột phải thì chỉ dời dấu "đang mở", không dựng lại danh sách (thẻ dựng lại chạy
  // lại hiệu ứng hiện lên, cả cột nháy mỗi lần chọn).
  function markCurrent() {
    const hash = location.hash || '';
    channelBtn.classList.toggle('current', hash.startsWith('#/channel'));
    settingsBtn.classList.toggle('current', hash.startsWith('#/settings'));
    for (const a of view.querySelectorAll('a.session-card, a.machine-label, a.team-head')) {
      const href = a.getAttribute('href') || '';
      const id = href.slice(4); // "#/s/<id>", "#/m/<id>" hay "#/g/<id>"
      a.classList.toggle('current', href.startsWith('#/s/') ? isOpenSession(id) : href.startsWith('#/g/') ? isOpenGroup(id) : isOpenMachine(id));
    }
  }
  const tick = setInterval(renderList, 30000); // "vừa xong", "5 phút" và lúc thấy máy lần cuối chạy theo giờ
  // Kéo thẻ phiên thả vào khối nhóm (hay vào màn của nhóm ở cột phải bản PC).
  const offDrag = enableSessionDrag(list, (sid, gid) => addToGroup(gid, sid), () => { if (deferred) renderList(); });
  return () => {
    offDrag();
    offs.forEach((off) => off());
    clearInterval(tick);
    usage.destroy();
    models.destroy();
  };
}

// ---- Mức dùng Claude -----------------------------------------------------------------------------
// Nút bên phải Cài đặt: bảng phần trăm đã dùng của phiên 5 giờ, của tuần (và hạn mức tuần riêng của
// từng model), kèm giờ reset và thời gian còn lại. Số do đầu máy mỗi máy hỏi máy chủ Claude bằng tài khoản
// đăng nhập trên máy đó (src/usage.mjs), trạm gộp theo tài khoản. Bấm lại nút hay bấm ra ngoài là đóng;
// đang mở thì mỗi phút hỏi lại, đồng hồ còn lại chạy theo.
const USAGE_REFRESH_MS = 60 * 1000;
const WEEKDAYS = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const PLAN = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };

function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// "Reset 14:20 hôm nay · còn 2 giờ 15 phút"
export function resetText(iso, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(now)) / 86400000);
  const date = days === 0 ? 'hôm nay' : days === 1 ? 'ngày mai'
    : `${WEEKDAYS[at.getDay()].toLowerCase()} ${at.getDate()}/${at.getMonth() + 1}`;
  const left = Math.max(0, Math.round((at - now) / 60000));
  const d = Math.floor(left / 1440);
  const hrs = Math.floor((left % 1440) / 60);
  const min = left % 60;
  const span = d ? `${d} ngày ${hrs} giờ` : hrs ? `${hrs} giờ ${min} phút` : `${min} phút`;
  return `Reset ${hhmm(at)} ${date} · còn ${span}`;
}

// Số token gọn mà vẫn đọc được: "850", "12,3 nghìn", "296,4 triệu", "1,25 tỷ".
export function tokenText(n) {
  const v = Math.max(0, Number(n) || 0);
  const fmt = (x, unit) => `${x.toLocaleString('vi-VN', { maximumFractionDigits: x < 10 ? 2 : 1 })} ${unit}`;
  if (v >= 1e9) return fmt(v / 1e9, 'tỷ');
  if (v >= 1e6) return fmt(v / 1e6, 'triệu');
  if (v >= 1e3) return fmt(v / 1e3, 'nghìn');
  return String(Math.round(v));
}

const TOKEN_TYPES = [['cacheRead', 'Đọc cache'], ['cacheWrite', 'Ghi cache'], ['output', 'Output'], ['input', 'Input']];

// Giờ của một con số: "18:05" trong hôm nay, "18:05 1/11" ngày khác.
function stamp(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === now.toDateString() ? hhmm(d) : `${hhmm(d)} ${d.getDate()}/${d.getMonth() + 1}`;
}

function usagePanel() {
  const pop = h('div', { class: 'usage-pop', role: 'dialog', 'aria-label': 'Mức dùng Claude' });
  const button = h('button', { class: 'icon-btn usage-btn', 'aria-label': 'Mức dùng Claude', title: 'Mức dùng Claude', 'aria-haspopup': 'dialog', onclick: () => toggle() }, icon('gauge'));
  let open = false;
  let data = null; // câu trả lời gần nhất của /api/usage
  let error = '';
  let loading = false;
  let timer = null;
  let clock = null;
  let typesOpen = false; // khối "Theo loại token" đang mở: giữ nguyên qua mỗi lần vẽ lại

  // Token Claude Code của tuần (trạm cộng số từng máy tự đếm, token-book.mjs): đã dùng, ước còn lại theo
  // phần trăm tuần đã dùng, từng máy (máy tắt thì kèm giờ của số báo lần cuối), và chia theo loại token.
  const tokenBlock = (t) => {
    if (!t) return null;
    const est = t.estimate;
    const row = (label, value, cls = '') => h('div', { class: 'usage-tok-row' }, h('span', null, label), h('span', { class: `usage-tok-num ${cls}` }, value));
    const types = h('details', { class: 'usage-tok-types', open: typesOpen, ontoggle: (e) => { typesOpen = e.currentTarget.open; } },
      h('summary', null, 'Theo loại token'),
      TOKEN_TYPES.map(([key, label]) => row(label, `${tokenText(t.total[key])}${est ? ` · còn ≈ ${tokenText(est.byType[key])}` : ''}`)));
    const share = t.claudeCodeShare != null && t.claudeCodeShare < 100 ? `, Claude Code chiếm ${t.claudeCodeShare}% mức đó` : '';
    const note = est
      ? `Ước theo ${t.percent}% tuần đã dùng${share}, giả định dùng tiếp như từ đầu tuần. Chỉ đếm Claude Code trên các máy nối Orbit.`
      : t.sum ? 'Máy chủ vẫn báo tuần này mới dùng 0%: chưa đủ số liệu để ước số còn lại.' : 'Tuần này các máy chưa dùng token nào.';
    return h('div', { class: 'usage-tok' },
      h('div', { class: 'usage-label' }, 'Token tuần này'),
      row('Đã dùng', tokenText(t.sum)),
      row('Còn lại (ước tính)', est ? `≈ ${tokenText(est.remaining)}` : '—', 'accent'),
      h('div', { class: 'usage-tok-machines' }, t.machines.map((m) => h('div', { class: `usage-tok-machine${m.online ? '' : ' off'}` },
        row(m.name, tokenText(m.sum)),
        m.online ? null : h('div', { class: 'usage-tok-sub' }, `Máy tắt · số báo lúc ${stamp(m.at)}`)))),
      types,
      h('div', { class: 'usage-tok-note' }, note));
  };

  const bar = (l) => {
    const level = l.severity === 'critical' || l.percent >= 90 ? 'crit' : l.severity === 'warning' || l.percent >= 75 ? 'warn' : '';
    return h('div', { class: 'usage-row' },
      h('div', { class: 'usage-top' }, h('span', { class: 'usage-label' }, l.label), h('span', { class: `usage-pct ${level}` }, `${l.percent}%`)),
      h('div', { class: 'usage-bar' }, h('div', { class: `usage-fill ${level}`, style: { width: `${Math.max(l.percent, 1.5)}%` } })),
      l.resetsAt ? h('div', { class: 'usage-reset' }, resetText(l.resetsAt)) : null);
  };

  function render() {
    clear(pop);
    pop.append(h('div', { class: 'usage-title' }, 'Mức dùng Claude'));
    if (!data && loading) {
      pop.append(h('div', { class: 'usage-note' }, 'Đang hỏi các máy…'));
      return;
    }
    if (!data) {
      pop.append(h('div', { class: 'usage-note err' }, error || 'Chưa lấy được số liệu.'));
      return;
    }
    const many = data.accounts.length > 1;
    for (const a of data.accounts) {
      pop.append(h('div', { class: 'usage-acc' },
        many ? h('div', { class: 'usage-acc-head' }, a.label || a.machines.join(', ')) : null,
        a.limits.map(bar),
        tokenBlock(a.tokens),
        h('div', { class: 'usage-foot' }, [PLAN[a.plan] ? `Gói ${PLAN[a.plan]}` : '', `cập nhật ${hhmm(new Date(a.at))}`, `qua ${a.machines.join(', ')}`].filter(Boolean).join(' · '))));
    }
    if (!data.accounts.length) pop.append(h('div', { class: 'usage-note' }, 'Không máy nào đang bật có đăng nhập Claude Code bằng tài khoản Claude.'));
    // Máy chưa đăng nhập, mã đăng nhập hết hạn hay bị từ chối: kèm nút đăng nhập ngay từ app (claude-login.js).
    const loginBtn = (machineId) => {
      const m = store.machines.get(machineId);
      return m?.online ? h('button', { class: 'btn small usage-login', type: 'button', onclick: () => openClaudeLogin(m, () => load()) }, 'Đăng nhập') : null;
    };
    for (const p of data.problems || []) {
      pop.append(h('div', { class: 'usage-note err' }, h('span', null, `${p.machine}: ${p.error}`), ['expired', 'http401'].includes(p.reason) ? loginBtn(p.machineId) : null));
    }
    for (const p of data.noLogin || []) {
      pop.append(h('div', { class: 'usage-note' }, h('span', null, `${p.machine}: chưa đăng nhập Claude Code bằng tài khoản Claude.`), loginBtn(p.machineId)));
    }
    if (error) pop.append(h('div', { class: 'usage-note err' }, `Lần hỏi mới nhất lỗi: ${error}`));
  }

  async function load() {
    loading = true;
    if (!data) render();
    try {
      data = await api.get('/api/usage');
      error = '';
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
    if (open) render();
  }

  function onOutside(e) {
    if (open && !pop.contains(e.target) && !button.contains(e.target)) toggle(false);
  }

  function toggle(force) {
    open = force ?? !open;
    pop.classList.toggle('open', open);
    button.classList.toggle('open', open);
    clearInterval(timer);
    clearInterval(clock);
    timer = null;
    clock = null;
    if (open) {
      render();
      load();
      timer = setInterval(load, USAGE_REFRESH_MS);
      clock = setInterval(() => { if (data) render(); }, 30000); // thời gian còn lại chạy theo
      document.addEventListener('pointerdown', onOutside, true);
    } else {
      document.removeEventListener('pointerdown', onOutside, true);
    }
  }

  return { button, pop, destroy: () => toggle(false) };
}
