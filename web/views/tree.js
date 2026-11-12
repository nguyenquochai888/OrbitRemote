// Danh sách máy và phiên ở màn chính, dạng cây: hai mục lớn Online và Offline; trong mỗi mục là các máy;
// dưới mỗi máy là các nhóm và các phiên thuộc mục đó. Mục, máy và nhóm thu gọn hay xổ ra được bằng nút mũi
// tên, nhớ cho lần mở sau (localStorage).
//
// Phiên online: đang chạy (đang mở, sẵn sàng, đang làm, cần duyệt) trên máy đang nối. Nhóm online: đang
// chạy hay tạm dừng, có phiên online, hoặc là nhóm mới chưa có phiên nào (để còn kéo phiên vào). Nhóm nằm
// dưới máy của trưởng nhóm và chứa mọi phiên của nó (phiên ở máy khác ghi thêm tên máy), nên không phiên
// nào hiện hai lần. Máy đang bật mà có phiên đã dừng thì có mặt ở cả hai mục.
//
// Dưới mỗi máy đang bật còn có các phiên Claude sẵn có trên máy mà app không giữ: phiên đang mở trong VS Code hay
// terminal, và vài phiên cũ mới nhất (nhật ký Claude Code, lib/past.js), kèm nút xem tất cả. Máy vừa cài Orbit Remote
// chưa mở phiên nào từ app thì vẫn thấy ngay các phiên đã có của nó.

import { h, timeAgo } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { store } from '../lib/store.js';
import { externalRow, loadPast, pastOf, pastRow } from '../lib/past.js';
import { sessionCard, isOpenMachine } from './home.js';
import { GROUP_STATUS, STATUS_ORDER, isOpenGroup, openNewGroup } from './group.js';
import { openNewSession } from './sheets.js';

const RUNNING = new Set(['starting', 'idle', 'busy', 'waiting']);
// Phiên cũ trên máy ở màn chính: số dòng hiện sẵn (còn lại xem ở màn của máy), và bản đọc dùng lại được bao lâu. Màn
// chính luôn mở (cột trái của bản PC), nên không hỏi máy dày: đọc lại khi quá hạn, hay khi phiên ngoài app của máy đổi.
export const HOME_PAST_MAX = 5;
export const HOME_PAST_MS = 5 * 60 * 1000;

// ---- Thu gọn và xổ ra ------------------------------------------------------------------------------
// Khoá: "label:online", "label:offline", "m:<mục>:<máy>" (một máy có thể ở cả hai mục), "g:<nhóm>".
const STORE_KEY = 'orbit-tree-collapsed';
const DEFAULT_SHUT = { 'label:offline': true }; // phiên đã dừng có thể rất nhiều: mục Offline mặc định thu gọn
const KEYS_MAX = 300;
let shutMap = null;

function shutState() {
  if (!shutMap) {
    try {
      shutMap = { ...DEFAULT_SHUT, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
    } catch {
      shutMap = { ...DEFAULT_SHUT };
    }
  }
  return shutMap;
}

function setShut(key, shut) {
  const state = shutState();
  delete state[key]; // ghi lại ở cuối để phần cắt bỏ dưới đây luôn bỏ khoá lâu không đụng tới
  state[key] = shut;
  const keys = Object.keys(state);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEYS_MAX))) delete state[k];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // trình duyệt chặn lưu: chỉ mất phần nhớ cho lần mở sau
  }
}

// Một nút gập được: đầu luôn hiện, thân ẩn khi thu gọn. Bấm mũi tên là đổi tại chỗ, không vẽ lại cả cây;
// thân co giãn bằng grid-template-rows nên cao bao nhiêu cũng mượt mà không phải đo.
function fold(key, cls, headParts, body, { attrs = {}, wholeHead = false } = {}) {
  let shut = Boolean(shutState()[key]);
  const btn = h('button', { class: 'fold-btn', type: 'button', 'aria-expanded': String(!shut), 'aria-label': shut ? 'Xổ ra' : 'Thu gọn' }, icon('down', 16));
  const head = h('div', { class: 'fold-head' }, headParts, btn);
  // fold-inner co giãn (không có padding nên co được về đúng 0), fold-pad mang khoảng đệm của nội dung.
  const bodyEl = h('div', { class: 'fold-body' }, h('div', { class: 'fold-inner' }, h('div', { class: 'fold-pad' }, body)));
  const node = h('div', { class: `fold ${cls}${shut ? ' shut' : ''}`, ...attrs }, head, bodyEl);
  let settle = 0;
  const still = () => {
    clearTimeout(settle);
    node.classList.remove('moving');
  };
  const flip = () => {
    shut = !shut;
    node.classList.add('moving'); // đang co giãn: cắt phần tràn, hết co giãn thì bỏ để bóng của thẻ không bị cắt
    node.classList.toggle('shut', shut);
    btn.setAttribute('aria-expanded', String(!shut));
    btn.setAttribute('aria-label', shut ? 'Xổ ra' : 'Thu gọn');
    setShut(key, shut);
    // Người dùng tắt hiệu ứng chuyển động thì không có transitionend: tự thôi sau đúng thời gian co giãn.
    clearTimeout(settle);
    settle = setTimeout(still, 400);
  };
  bodyEl.addEventListener('transitionend', (e) => {
    if (e.target === bodyEl) still();
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    flip();
  });
  // Đầu của mục lớn: bấm vào đâu trên dòng cũng gập (trừ nút khác nằm trên dòng đó).
  if (wholeHead) head.addEventListener('click', (e) => { if (!e.target.closest('a, button')) flip(); });
  return node;
}

// ---- Phân loại ----------------------------------------------------------------------------------------
const sessionOnline = (s) => RUNNING.has(s.status) && store.machines.get(s.machineId)?.online !== false;

function groupOnline(g) {
  if (g.status === 'running' || g.status === 'paused') return true;
  const sessions = g.members.map((m) => store.sessions.get(m.id)).filter(Boolean);
  return sessions.some(sessionOnline) || (g.status === 'draft' && !sessions.length);
}

// Máy của nhóm: máy chạy phiên trưởng nhóm, không có thì máy của phiên đầu tiên còn trong danh sách.
function homeMachine(g) {
  const s = store.sessions.get(g.leaderId) || g.members.map((m) => store.sessions.get(m.id)).find(Boolean);
  return s?.machineId || '';
}

const byActivity = (a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting')
  || String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
const byGroup = (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
  || String(b.createdAt).localeCompare(String(a.createdAt));

function collect() {
  const make = () => ({ machines: new Map(), loose: [] });
  const lists = { online: make(), offline: make() };
  const bucket = (label, machineId) => {
    const map = lists[label].machines;
    if (!map.has(machineId)) map.set(machineId, { groups: [], sessions: [] });
    return map.get(machineId);
  };
  const grouped = new Set();
  for (const g of store.groups.values()) {
    for (const m of g.members) grouped.add(m.id);
    const label = groupOnline(g) ? 'online' : 'offline';
    const mid = homeMachine(g);
    if (mid) bucket(label, mid).groups.push(g);
    else lists[label].loose.push(g);
  }
  for (const s of store.sessions.values()) {
    if (!grouped.has(s.id)) bucket(sessionOnline(s) ? 'online' : 'offline', s.machineId).sessions.push(s);
  }
  // Mục Online có mọi máy đang nối (kể cả chưa có phiên); mục Offline có mọi máy đang tắt.
  for (const m of store.machines.values()) bucket(m.online ? 'online' : 'offline', m.id);
  return lists;
}

// Máy trạm chưa biết (phiên của máy đã bị quên): dựng tạm từ tên máy ghi trong phiên.
function machineOf(id, items) {
  const m = store.machines.get(id);
  if (m) return m;
  const s = items.sessions[0] || items.groups.map((g) => store.sessions.get(g.leaderId)).find(Boolean);
  return { id, name: s?.machine || 'Máy không rõ', online: false, lastSeen: '', external: [], unknown: true };
}

// ---- Vẽ ---------------------------------------------------------------------------------------------
function groupMembers(g) {
  const list = g.members.map((m) => store.sessions.get(m.id)).filter(Boolean);
  return list.sort((a, b) => Number(b.id === g.leaderId) - Number(a.id === g.leaderId));
}

function groupBlock(g, homeId) {
  const done = g.tasks.filter((t) => t.status === 'done').length;
  const members = groupMembers(g);
  const head = h('a', { class: `team-head${isOpenGroup(g.id) ? ' current' : ''}`, href: `#/g/${g.id}` },
    icon('group', 16, 'team-icon'),
    h('span', { class: 'team-head-name' }, g.name),
    g.tasks.length || g.costTotal ? h('span', { class: 'team-head-count' }, [g.tasks.length ? `${done}/${g.tasks.length} việc` : '', g.costTotal ? `$${g.costTotal.toFixed(2)}` : ''].filter(Boolean).join(' · ')) : null,
    h('span', { class: 'pill' }, GROUP_STATUS[g.status] || g.status));
  const cards = members.length
    ? h('div', { class: 'cards' }, members.map((s) => sessionCard(s, { showMachine: s.machineId !== homeId })))
    : h('div', { class: 'team-drop-hint' }, icon('drag', 14), 'Kéo thẻ phiên thả vào đây');
  return fold(`g:${g.id}`, `tree-group team-${g.status}`, head,
    [h('div', { class: `tree-goal${g.goal ? '' : ' unset'}` }, g.goal || 'Chưa đặt mục tiêu'), cards],
    { attrs: { 'data-drop-group': g.id } });
}

// Lúc thấy máy lần cuối: timeAgo trả "vừa xong", "5 phút" hay một ngày tháng (quá một tuần).
function lastSeenText(iso) {
  const ago = timeAgo(iso);
  if (!ago) return '';
  if (ago === 'vừa xong') return 'vừa tắt';
  return /\d+\/\d+/.test(ago) ? `thấy lần cuối ${ago}` : `thấy ${ago} trước`;
}

// Phiên Claude sẵn có trên một máy đang bật mà app không giữ: đang mở ngoài app, rồi vài phiên cũ mới nhất. Phiên app
// đang giữ (chạy hay đã dừng, kể cả trong nhóm) và phiên đang mở ngoài app thì không lặp lại ở nhóm phiên cũ.
function onMachine(m) {
  const outside = m.external || [];
  const shown = new Set(outside.map((t) => t.claudeSessionId));
  for (const s of store.sessions.values()) if (s.machineId === m.id && s.claudeSessionId) shown.add(s.claudeSessionId);
  const past = pastOf(m.id);
  const older = past.list.filter((t) => !shown.has(t.claudeSessionId));
  return { outside, older, loading: past.state === 'loading' && !past.list.length };
}

const isOpenExternal = (mid, csid) => (location.hash || '').startsWith(`#/x/${mid}/${csid}`);

function onMachineRows(m, { outside, older }) {
  if (!outside.length && !older.length) return null;
  const opts = (csid) => ({ fromHome: true, extraClass: `tree-ext${isOpenExternal(m.id, csid) ? ' current' : ''}` });
  const section = (title, count, rows) => h('div', { class: 'tree-ext-group' },
    h('div', { class: 'tree-ext-label' }, title, h('span', { class: 'group-count' }, count)), rows);
  return [
    outside.length ? section('Đang mở ngoài app', outside.length, outside.map((t) => externalRow(m.id, t, opts(t.claudeSessionId)))) : null,
    older.length ? section('Phiên cũ trên máy', older.length,
      [older.slice(0, HOME_PAST_MAX).map((t) => pastRow(m.id, t, opts(t.claudeSessionId))),
        older.length > HOME_PAST_MAX
          ? h('a', { class: 'tree-ext-more', href: `#/m/${m.id}/list` }, `Xem tất cả ${older.length} phiên cũ`, icon('chevron', 13))
          : null]) : null,
  ];
}

function machineBlock(label, m, items) {
  const cards = [...items.sessions].sort(byActivity);
  const members = items.groups.flatMap(groupMembers);
  const count = cards.length + members.length;
  const waiting = [...cards, ...members].filter((s) => s.status === 'waiting').length;
  const local = label === 'online' && m.online ? onMachine(m) : null;
  const outside = local?.outside.length || 0;
  const info = label === 'online'
    ? [count ? `${count} phiên` : '', outside ? `${outside} ngoài app` : '', !count && !outside ? 'chưa có phiên chạy' : ''].filter(Boolean).join(' · ')
    : m.online ? `đang bật · ${count} phiên đã dừng` : ['đang tắt', lastSeenText(m.lastSeen)].filter(Boolean).join(' · ');
  const head = h(m.unknown ? 'span' : 'a', { class: `machine-label tree-machine${!m.unknown && isOpenMachine(m.id) ? ' current' : ''}`, ...(m.unknown ? {} : { href: `#/m/${m.id}` }) },
    h('span', { class: `mini-dot ${m.online ? 'on' : 'off'}` }),
    icon('machine', 15),
    h('span', { class: 'machine-label-name' }, m.name),
    waiting ? h('span', { class: 'machine-label-alert' }, icon('shield', 12), `${waiting} cần duyệt`) : null,
    h('span', { class: 'machine-label-count' }, info));
  const body = [];
  for (const g of [...items.groups].sort(byGroup)) body.push(groupBlock(g, m.id));
  if (cards.length) body.push(h('div', { class: 'cards' }, cards.map((s) => sessionCard(s, { showMachine: false }))));
  const extra = local ? onMachineRows(m, local) : null;
  if (!body.length) {
    body.push(label === 'online'
      ? h('div', { class: 'tree-empty' }, extra ? 'Chưa mở phiên nào từ app.' : local?.loading ? 'Đang đọc các phiên Claude trên máy…' : 'Chưa có phiên đang chạy.',
        h('button', { class: 'tree-empty-action', type: 'button', onclick: () => openNewSession({ machineId: m.id }) }, icon('plus', 13), 'Mở phiên'))
      : h('div', { class: 'tree-empty' }, 'Không còn phiên nào.'));
  }
  if (extra) body.push(...extra.filter(Boolean));
  return fold(`m:${label}:${m.id}`, `tree-machine-block${m.online ? '' : ' offline'}${waiting ? ' attention' : ''}`, head, body);
}

function labelBlock(label, data) {
  const online = label === 'online';
  const entries = [...data.machines.entries()].map(([id, items]) => ({ m: machineOf(id, items), items }));
  entries.sort(online
    ? (a, b) => Number(Boolean(b.m.local)) - Number(Boolean(a.m.local)) || a.m.name.localeCompare(b.m.name)
    : (a, b) => Number(b.m.online) - Number(a.m.online) || String(b.m.lastSeen || '').localeCompare(String(a.m.lastSeen || '')));
  const sessions = entries.reduce((n, e) => n + e.items.sessions.length + e.items.groups.reduce((k, g) => k + groupMembers(g).length, 0), 0);
  const waiting = online && entries.some((e) => e.items.sessions.some((s) => s.status === 'waiting') || e.items.groups.some((g) => groupMembers(g).some((s) => s.status === 'waiting')));
  const head = [
    h('span', { class: `tree-label-dot ${online ? 'on' : 'off'}` }),
    h('span', { class: 'tree-label-title' }, online ? 'Online' : 'Offline'),
    h('span', { class: 'group-count' }, `${entries.length} máy · ${sessions} phiên`),
    waiting ? h('span', { class: 'machine-label-alert' }, icon('shield', 12), 'cần duyệt') : null,
    h('span', { class: 'fold-spacer' }),
    online ? h('button', { class: 'title-action', type: 'button', onclick: () => openNewGroup() }, icon('plus', 14), 'Tạo nhóm') : null,
  ];
  const body = [];
  if (online && !store.groups.size && sessions) {
    body.push(h('button', { class: 'team-empty', type: 'button', onclick: () => openNewGroup() }, icon('group', 20),
      h('span', null, 'Gom nhiều phiên vào một nhóm, gán vai trò cho từng phiên, đặt mục tiêu chung rồi bấm Bắt đầu.')));
  }
  for (const g of [...data.loose].sort(byGroup)) body.push(groupBlock(g, ''));
  for (const { m, items } of entries) body.push(machineBlock(label, m, items));
  if (!entries.length && !data.loose.length) {
    body.push(h('div', { class: 'tree-empty' }, online ? 'Chưa có máy nào đang nối.' : 'Không có máy nào đang tắt, cũng không có phiên nào đã dừng.'));
  }
  return fold(`label:${label}`, `tree-label tree-${label}${waiting ? ' attention' : ''}`, head, body, { wholeHead: true });
}

// Vẽ cây. Kèm hỏi phiên cũ của các máy đang bật khi bản nhớ đã quá hạn (lib/past.js chỉ báo "past" sau khi đọc
// xong, nên hỏi ngay trong lúc vẽ không làm vẽ lồng); màn chính nghe "past" để vẽ lại.
export function homeTree() {
  for (const m of store.machines.values()) if (m.online) loadPast(m.id, HOME_PAST_MS);
  const lists = collect();
  return h('div', { class: 'tree' }, labelBlock('online', lists.online), labelBlock('offline', lists.offline));
}
