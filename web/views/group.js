// Nhóm phiên: màn của một nhóm, và các bảng tạo nhóm, thêm phiên, chọn vai trò. Khối nhóm trong danh sách ở
// màn chính nằm ở views/tree.js.
//
// Chủ dự án lập nhóm, kéo phiên vào (hay mở phiên mới ngay trong nhóm), gán cho mỗi phiên một token vai
// trò ($code, $env, $qa...), đặt mục tiêu rồi bấm Bắt đầu. Từ đó trưởng nhóm tự chia việc theo vai trò;
// app chỉ hiện bảng việc và trao đổi của nhóm (trạm giữ mọi thứ, src/groups.mjs).

import { h, add, clear, timeAgo, baseName, toast, clockTime, workDir, workPlace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { renderMarkdown } from '../lib/md.js';
import { openSheet, openNewSession } from './sheets.js';
import { sessionModel } from '../lib/models.js';

// Model và bản thành viên đang dùng để làm việc ("Opus 5.5"): bản thật Claude Code báo trong từng lượt, chưa chạy lượt
// nào thì theo dòng model đã chọn cho phiên. Màu theo dòng (Opus, Sonnet, Haiku) để nhìn lướt là biết.
function modelChip(s) {
  const label = sessionModel(s);
  if (!label) return null;
  const fam = (/^(opus|sonnet|haiku)/i.exec(label)?.[1] || '').toLowerCase();
  return h('span', { class: `team-model${fam ? ` fam-${fam}` : ''}`, title: `Model đang dùng: ${s.activeModel || s.model}` }, label);
}

const RUNNING = new Set(['starting', 'idle', 'busy', 'waiting']);
export const GROUP_STATUS = { draft: 'Chưa bắt đầu', running: 'Đang chạy', paused: 'Tạm dừng', stopped: 'Đã dừng', done: 'Đã xong' };
export const STATUS_ORDER = ['running', 'paused', 'draft', 'stopped', 'done']; // thứ tự nhóm trong cây ở màn chính
const TASK_STATUS = { review: 'Chờ nghiệm thu', blocked: 'Bị chặn', doing: 'Đang làm', queued: 'Chờ tới lượt', todo: 'Chưa giao', done: 'Xong' };
const TASK_ORDER = ['review', 'blocked', 'doing', 'queued', 'todo', 'done'];
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const RUNNING_STATUS = new Set(['starting', 'idle', 'busy', 'waiting']);
const SESSION_STATUS = { starting: 'Đang mở', idle: 'Sẵn sàng', busy: 'Đang làm', waiting: 'Cần duyệt', stopped: 'Đã dừng', crashed: 'Hỏng' };
const FEED_MAX = 30;

export const isOpenGroup = (id) => (location.hash || '').startsWith(`#/g/${id}`);

const roleHint = (role) => store.roleTokens().find((t) => t.role === role)?.hint || '';
const taskNumber = (t) => Number(String(t.id).slice(1)) || 0;

function progress(g) {
  return { total: g.tasks.length, done: g.tasks.filter((t) => t.status === 'done').length };
}

// Gọi trạm và báo lỗi bằng toast; trả null khi hỏng để người gọi khỏi try/catch.
async function post(path, body, okText) {
  try {
    const r = await api.post(path, body);
    if (okText) toast(okText);
    return r;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

// ---- Bảng: tạo nhóm, chọn vai trò, thêm phiên -------------------------------------------------------
export function openNewGroup() {
  const { body, close } = openSheet('Nhóm mới');
  const form = { name: '', goal: '' };
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, icon('group', 16), 'Tạo nhóm');
  body.append(h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      const g = await post('/api/groups', form);
      if (!g) {
        submit.disabled = false;
        return;
      }
      store.groups.set(g.id, g);
      close();
      location.hash = `#/g/${g.id}`;
    },
  },
  field('Tên nhóm', h('input', { class: 'input', maxlength: 60, placeholder: 'Ví dụ: Màn chơi đầu tiên', oninput: (e) => { form.name = e.target.value; } })),
  field('Mục tiêu chung', h('textarea', { class: 'input', rows: 4, maxlength: 4000, placeholder: 'Nhóm cần đạt được gì? Ví dụ: Làm xong màn chơi đầu tiên, chơi được từ đầu tới cuối.', oninput: (e) => { form.goal = e.target.value; } }),
    'Có thể để trống và đặt sau. Nhóm chỉ bắt đầu làm khi bạn bấm Bắt đầu.'),
  submit));
}

export function openRolePicker(gid, sid, { title = '' } = {}) {
  const s = store.sessions.get(sid);
  const current = store.groups.get(gid)?.members.find((m) => m.id === sid)?.role || '';
  const { body, close } = openSheet(title || `Vai trò của ${s?.name || 'phiên'}`);
  const roles = store.roleTokens();
  body.append(h('div', { class: 'field-hint role-intro' }, 'Vai trò là một token trong bảng token (custom/tokens.md). Trưởng nhóm chỉ giao cho phiên này việc thuộc vai trò đó, và phiên làm theo đặc tả của token.'));
  if (!roles.length) body.append(h('div', { class: 'empty small' }, store.tokensError || 'Bảng token (custom/tokens.md) trên máy giữ trạm chưa có token nào nhận yêu cầu. Thêm token vào bảng để có vai trò.'));
  const pick = async (role) => {
    if (await post(`/api/groups/${gid}/role`, { sessionId: sid, role })) close();
  };
  body.append(h('div', { class: 'role-list' }, roles.map((r) => h('button', {
    type: 'button',
    class: `role-opt${r.role === current ? ' active' : ''}`,
    onclick: () => pick(r.role),
  }, h('span', { class: 'role-token' }, `$${r.role}`), h('span', { class: 'role-hint' }, r.hint), r.role === current ? icon('check', 16) : null))));
  body.append(current
    ? h('button', { class: 'btn ghost block role-clear', type: 'button', onclick: () => pick('') }, 'Bỏ vai trò')
    : h('button', { class: 'btn ghost block role-clear', type: 'button', onclick: close }, 'Để sau'));
}

// Thả một phiên vào nhóm (kéo thả, hay chọn trong bảng "Thêm phiên"): thêm rồi hỏi luôn vai trò.
export async function addToGroup(gid, sid) {
  const g = store.groups.get(gid);
  const s = store.sessions.get(sid);
  if (!g || !s) return;
  if (g.members.some((m) => m.id === sid)) {
    toast(`${s.name} đã ở trong nhóm ${g.name}.`);
    return;
  }
  const prev = store.groupOf(sid);
  const r = await post(`/api/groups/${gid}/members`, { sessionId: sid });
  if (!r) return;
  store.groups.set(r.id, r);
  toast(prev ? `Đã chuyển ${s.name} từ nhóm ${prev.name} sang ${g.name}.` : `Đã thêm ${s.name} vào nhóm ${g.name}.`);
  openRolePicker(gid, sid, { title: `${s.name}: vai trò trong nhóm` });
}

function openAddMembers(gid) {
  const g = store.groups.get(gid);
  const { body, close } = openSheet('Thêm phiên vào nhóm', { tall: true });
  const list = [...store.sessions.values()]
    .filter((s) => !g?.members.some((m) => m.id === s.id))
    .sort((a, b) => Number(RUNNING.has(b.status)) - Number(RUNNING.has(a.status)) || String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  body.append(h('div', { class: 'field-hint role-intro' }, 'Chạm một phiên để thêm vào nhóm, rồi chọn vai trò cho nó. Phiên đang ở nhóm khác sẽ chuyển sang nhóm này.'));
  if (!list.length) {
    body.append(h('div', { class: 'empty small' }, 'Không còn phiên nào ngoài nhóm. Bấm "Phiên mới" để mở phiên ngay trong nhóm.'));
    return;
  }
  body.append(h('div', { class: 'add-list' }, list.map((s) => {
    const other = store.groupOf(s.id);
    return h('button', {
      type: 'button',
      class: `add-row status-${s.status}`,
      onclick: () => { close(); addToGroup(gid, s.id); },
    },
    h('span', { class: 'status-dot' }),
    h('span', { class: 'add-main' },
      h('span', { class: 'add-name' }, s.name, other ? h('span', { class: 'tag' }, other.name) : null),
      h('span', { class: 'add-meta' }, [workPlace(s), baseName(workDir(s)), SESSION_STATUS[s.status]].filter(Boolean).join(' · '))),
    icon('plus', 18));
  })));
}

function openMemberMenu(gid, sid) {
  const g = store.groups.get(gid);
  const s = store.sessions.get(sid);
  if (!g || !s) return;
  const leader = g.leaderId === sid;
  const { body, close } = openSheet(s.name);
  const run = async (path, extra, okText) => {
    if (await post(path, { sessionId: sid, ...extra }, okText)) close();
  };
  body.append(h('div', { class: 'menu-list' },
    h('a', { class: 'menu-row', href: `#/s/${sid}/g/${gid}` }, icon('channel', 18), 'Mở phiên'),
    h('button', { type: 'button', class: 'menu-row', onclick: () => { close(); openRolePicker(gid, sid); } }, icon('tool', 18), 'Đổi vai trò'),
    leader ? null : h('button', {
      type: 'button',
      class: 'menu-row',
      onclick: () => run(`/api/groups/${gid}/leader`, {}, `${s.name} giờ là trưởng nhóm.`),
    }, icon('crown', 18), 'Làm trưởng nhóm'),
    h('button', {
      type: 'button',
      class: 'menu-row danger',
      onclick: () => run(`/api/groups/${gid}/remove`, {}, `Đã đưa ${s.name} ra khỏi nhóm.`),
    }, icon('x', 18), 'Bỏ khỏi nhóm')));
  if (leader && g.status === 'running') body.append(h('div', { class: 'field-hint' }, 'Trưởng nhóm của nhóm đang chạy: đổi trưởng nhóm hay dừng nhóm trước khi bỏ phiên này ra.'));
}

function openGroupMenu(gid) {
  const g = store.groups.get(gid);
  if (!g) return;
  const { body, close } = openSheet('Nhóm');
  const name = h('input', { class: 'input', value: g.name, maxlength: 60 });
  add(body,
    field('Tên nhóm', h('div', { class: 'inline-form' }, name,
      h('button', { class: 'btn small', type: 'button', onclick: async () => { if (await post(`/api/groups/${gid}/update`, { name: name.value }, 'Đã đổi tên.')) close(); } }, 'Lưu'))),
    h('div', { class: 'danger-row' }, h('button', {
      class: 'btn danger-outline block',
      type: 'button',
      disabled: g.status === 'running',
      onclick: async () => {
        if (!window.confirm(`Xoá nhóm "${g.name}"? Các phiên vẫn còn, chỉ bỏ nhóm và bảng việc.`)) return;
        if (await post(`/api/groups/${gid}/delete`, {})) {
          close();
          location.hash = '#/';
        }
      },
    }, icon('trash', 16), 'Xoá nhóm')),
    g.status === 'running' ? h('div', { class: 'field-hint' }, 'Nhóm đang chạy: dừng nhóm trước khi xoá.') : null);
}

// ---- Màn của một nhóm ----------------------------------------------------------------------------------
export function mountGroup(root, id) {
  const title = h('div', { class: 'title' });
  const subtitle = h('div', { class: 'subtitle' });
  const pill = h('span', { class: 'pill' });
  // Ô mục tiêu dựng một lần, không vẽ lại theo sự kiện, kẻo đang gõ thì mất chữ.
  const goalInput = h('textarea', { class: 'input team-goal-input', rows: 4, maxlength: 4000, placeholder: 'Nhóm cần đạt được gì? Ví dụ: Làm xong màn chơi đầu tiên, chơi được từ đầu tới cuối.' });
  const goalSave = h('button', { class: 'btn small primary hidden', type: 'button', onclick: () => saveGoal(true) }, icon('check', 15), 'Lưu mục tiêu');
  const goalNote = h('span', { class: 'field-hint' });
  const runSlot = h('div', { class: 'team-run' });
  const summarySlot = h('div');
  const membersTitle = h('div', { class: 'group-title' });
  const membersList = h('div', { class: 'team-members' });
  const tasksTitle = h('div', { class: 'group-title' });
  const tasksSlot = h('div');
  const feedSlot = h('div');
  const costSlot = h('div');
  const toolsSlot = h('div');
  const membersBox = h('section', { class: 'team-block team-drop', 'data-drop-group': id }, membersTitle, membersList,
    h('div', { class: 'team-member-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () => openAddMembers(id) }, icon('plus', 15), 'Thêm phiên'),
      h('button', { class: 'btn small', type: 'button', onclick: () => openNewSession({ groupId: id }) }, icon('play', 14), 'Phiên mới trong nhóm')),
    h('div', { class: 'team-drop-hint wide-only' }, icon('drag', 14), 'Hoặc kéo thẻ phiên ở cột trái thả vào đây'),
    h('div', { class: 'team-drop-hint narrow-only' }, icon('drag', 14), 'Ở màn chính: giữ một thẻ phiên rồi kéo vào thẻ nhóm'));
  const main = h('main', { class: 'scroll team-scroll' },
    h('section', { class: 'team-block' },
      h('div', { class: 'group-title' }, icon('target', 14), 'Mục tiêu chung'),
      goalInput,
      h('div', { class: 'team-goal-foot' }, goalNote, goalSave)),
    runSlot, summarySlot, costSlot, membersBox,
    h('section', { class: 'team-block' }, tasksTitle, tasksSlot),
    toolsSlot, feedSlot);
  const view = h('div', { class: 'view team-view' },
    h('header', { class: 'topbar' },
      h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Quay lại' }, icon('back')),
      h('button', { class: 'title-wrap', type: 'button', onclick: () => openGroupMenu(id) }, title, subtitle),
      pill,
      h('button', { class: 'icon-btn', 'aria-label': 'Tuỳ chọn nhóm', onclick: () => openGroupMenu(id) }, icon('more'))),
    main);
  root.append(view);

  let savedGoal = null;
  const dirty = () => savedGoal !== null && goalInput.value.trim() !== savedGoal;
  goalInput.addEventListener('input', () => {
    goalSave.classList.toggle('hidden', !dirty());
    goalNote.textContent = dirty() ? 'Chưa lưu.' : '';
    const g = store.groups.get(id);
    if (g) renderRun(g); // nút Bắt đầu theo ô mục tiêu ngay khi gõ
  });

  async function saveGoal(notify) {
    const g = await post(`/api/groups/${id}/update`, { goal: goalInput.value }, notify ? 'Đã lưu mục tiêu.' : '');
    if (!g) return false;
    savedGoal = g.goal;
    store.groups.set(g.id, g);
    goalSave.classList.add('hidden');
    goalNote.textContent = g.status === 'running' ? 'Trưởng nhóm đã nhận mục tiêu mới.' : '';
    render();
    return true;
  }

  function syncGoal(g) {
    // Mục tiêu đổi từ nơi khác (thiết bị khác): chỉ thay khi ô không đang được sửa dở.
    if (savedGoal === g.goal) return;
    if (!dirty() && document.activeElement !== goalInput) goalInput.value = g.goal;
    savedGoal = g.goal;
    goalSave.classList.toggle('hidden', !dirty());
  }

  function render() {
    const g = store.groups.get(id);
    if (!g) {
      clear(main).append(h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, 'Nhóm không còn'), h('a', { class: 'btn', href: '#/' }, 'Về màn chính')));
      return;
    }
    const { total, done } = progress(g);
    title.textContent = g.name;
    subtitle.textContent = [`${g.members.length} phiên`, total ? `${done}/${total} việc xong` : '', g.costTotal ? usd(g.costTotal) : ''].filter(Boolean).join(' · ');
    pill.textContent = GROUP_STATUS[g.status] || g.status;
    view.className = `view team-view team-${g.status}`;
    syncGoal(g);
    renderRun(g);
    renderSummary(g);
    renderCost(g);
    renderMembers(g);
    renderTasks(g);
    renderTools(g);
    renderFeed(g);
  }

  // Chi phí: tổng và từng phiên (cộng dồn qua các lần phiên được mở lại), ngân sách do bạn đặt; trưởng nhóm được
  // báo khi chạm 80% và 100%.
  let budgetDraft = null;
  function renderCost(g) {
    // Đang gõ ngân sách: không vẽ lại khối này kẻo mất chỗ đang gõ (chi phí đổi sau mỗi lượt của nhóm).
    if (document.activeElement?.classList.contains('team-budget-input') && costSlot.contains(document.activeElement)) return;
    clear(costSlot);
    if (!g.costTotal && !g.budgetUsd && g.status === 'draft') return;
    const pct = g.budgetUsd ? Math.min(100, (g.costTotal / g.budgetUsd) * 100) : 0;
    const level = pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '';
    const budget = h('input', {
      class: 'input team-budget-input', type: 'number', min: '0', step: '0.5', inputmode: 'decimal',
      value: budgetDraft ?? (g.budgetUsd || ''), placeholder: 'Không giới hạn',
      oninput: (e) => { budgetDraft = e.target.value; save.classList.toggle('hidden', Number(budgetDraft || 0) === (g.budgetUsd || 0)); },
    });
    const save = h('button', {
      class: 'btn small hidden', type: 'button',
      onclick: async () => {
        const r = await post(`/api/groups/${id}/update`, { budgetUsd: Number(budget.value || 0) }, 'Đã lưu ngân sách.');
        if (!r) return;
        budget.blur();
        budgetDraft = null;
        store.groups.set(r.id, r);
        render();
      },
    }, 'Lưu');
    const per = g.members.map((m) => ({ name: store.sessions.get(m.id)?.name || 'Phiên đã xoá', usd: Number(g.cost?.[m.id]) || 0 })).filter((x) => x.usd > 0).sort((a, b) => b.usd - a.usd);
    costSlot.append(h('section', { class: `team-block team-cost${level}` },
      h('div', { class: 'group-title' }, icon('gauge', 14), 'Chi phí token'),
      h('div', { class: 'team-cost-top' },
        h('span', { class: 'team-cost-total' }, usd(g.costTotal)),
        h('span', { class: 'field-hint' }, g.budgetUsd ? `/ ${usd(g.budgetUsd)} ngân sách (${Math.round((g.costTotal / g.budgetUsd) * 100)}%)` : 'chưa đặt ngân sách')),
      g.budgetUsd ? h('div', { class: 'team-bar big' }, h('div', { class: 'team-fill', style: { width: `${pct}%` } })) : null,
      per.length ? h('div', { class: 'team-cost-list' }, per.map((x) => h('div', null, h('span', null, x.name), h('span', null, usd(x.usd))))) : null,
      h('div', { class: 'team-budget-row' }, h('span', { class: 'field-label' }, 'Ngân sách (USD)'), budget, save),
      h('div', { class: 'field-hint' }, 'Tính theo chi phí Claude Code báo cho từng lượt, cộng cả các lần phiên được mở lại. Trưởng nhóm chịu trách nhiệm chi phí của nhóm và được báo khi chạm 80% và 100% ngân sách.')));
  }

  // Bảng tin dụng cụ chỉ một phiên dùng được một lúc: ai đang giữ dụng cụ nào, tới mấy giờ, ai đang chờ. Phiên
  // giữ quên trả thì bạn gỡ được; dụng cụ chuyển ngay cho người chờ kế tiếp.
  function renderTools(g) {
    clear(toolsSlot);
    const tools = g.tools || [];
    const wait = g.toolWait || [];
    if (!tools.length && !wait.length && g.status !== 'running') return;
    const nowMs = Date.now();
    toolsSlot.append(h('section', { class: 'team-block' },
      h('div', { class: 'group-title' }, icon('tool', 14), 'Bảng tin dụng cụ dùng chung', tools.length ? h('span', { class: 'group-count' }, tools.length) : null),
      tools.length ? h('div', { class: 'team-tools' }, tools.map((e) => {
        const late = Date.parse(e.until) < nowMs;
        const waiting = wait.filter((w) => w.key === e.key).map((w) => w.name);
        return h('div', { class: `team-tool${late ? ' late' : ''}` },
          h('div', { class: 'team-tool-main' },
            h('div', { class: 'team-tool-name' }, e.tool, h('span', { class: 'tag' }, e.machine)),
            h('div', { class: 'team-tool-meta' }, [`${e.name} đang dùng`, `tới ${clockTime(e.until)}${late ? ' (quá giờ)' : ''}`, waiting.length ? `chờ: ${waiting.join(', ')}` : '', e.note].filter(Boolean).join(' · '))),
          h('button', { class: 'btn small ghost', type: 'button', title: 'Gỡ dòng này: dụng cụ chuyển cho người chờ kế tiếp', onclick: () => post(`/api/groups/${id}/free-tool`, { key: e.key }, 'Đã gỡ.') }, 'Gỡ'));
      })) : h('div', { class: 'field-hint' }, 'Chưa phiên nào đăng ký dụng cụ. Phiên cần một dụng cụ chỉ một phiên dùng được một lúc (Unity Editor, Blender...) thì đăng ký ở đây thay vì nhắn hỏi từng phiên.')));
  }

  // Nút đổi trạng thái nhóm (bắt đầu, tạm dừng, tiếp tục): khoá lại trong lúc chờ trạm, rồi vẽ lại theo trạng thái mới.
  function runButton(cls, iconName, label, path, okText, disabled = false) {
    const btn = h('button', {
      class: `btn ${cls}`,
      type: 'button',
      disabled,
      onclick: async () => {
        btn.disabled = true;
        if (dirty() && !(await saveGoal(false))) {
          btn.disabled = false;
          return;
        }
        if (path === 'start') {
          const g = store.groups.get(id);
          const live = (g?.members || []).filter((m) => m.id !== g.leaderId && RUNNING_STATUS.has(store.sessions.get(m.id)?.status)).map((m) => store.sessions.get(m.id).name);
          if (live.length && !window.confirm(`Bắt đầu: chỉ trưởng nhóm chạy, ${live.length} phiên đang chạy (${live.join(', ')}) sẽ dừng và được mở lại khi trưởng nhóm giao việc cho chúng. Phiên nào đang làm dở một lượt thì lượt đó bị cắt.`)) {
            btn.disabled = false;
            return;
          }
        }
        const r = await post(`/api/groups/${id}/${path}`, {}, okText);
        if (r) store.groups.set(r.id, r);
        render();
      },
    }, icon(iconName, 16), label);
    return btn;
  }

  function renderRun(g) {
    clear(runSlot);
    const leader = store.sessions.get(g.leaderId);
    const unassigned = g.members.filter((m) => !m.role).length;
    const paused = g.status === 'paused';
    const stopBtn = () => h('button', {
      class: 'btn danger-outline',
      type: 'button',
      onclick: async () => {
        const ask = paused
          ? 'Dừng hẳn nhóm? Các phiên đã thôi làm việc của nhóm từ lúc tạm dừng; muốn làm lại thì bấm Bắt đầu lại.'
          : 'Dừng nhóm? Trưởng nhóm và người đang làm việc của nhóm được báo dừng ở điểm an toàn.';
        if (!window.confirm(ask)) return;
        await post(`/api/groups/${id}/stop`, {}, 'Đã dừng nhóm.');
      },
    }, icon('stop', 15), 'Dừng nhóm');
    if (g.status === 'running') {
      add(runSlot,
        h('div', { class: 'team-run-row' }, runButton('team-pause', 'pause', 'Tạm dừng', 'pause', 'Đã tạm dừng nhóm.'), stopBtn()),
        h('div', { class: 'field-hint center' }, `Trưởng nhóm ${leader ? `"${leader.name}"` : ''} đang điều phối. Tạm dừng thì mọi phiên trong nhóm thôi làm ngay; Tiếp tục thì làm tiếp từ chỗ dừng.`));
      return;
    }
    let reason = '';
    let fix = null;
    if (!g.members.length) reason = 'Thêm ít nhất một phiên vào nhóm.';
    else if (!leader) reason = 'Chọn trưởng nhóm (nút ⋯ ở một thành viên).';
    else if (!RUNNING.has(leader.status)) {
      reason = `Trưởng nhóm "${leader.name}" đang dừng: chạy lại phiên đó trước.`;
      fix = h('button', { class: 'btn small', type: 'button', onclick: () => post(`/api/sessions/${leader.id}/resume`, {}, 'Đang chạy lại trưởng nhóm.') }, icon('play', 14), 'Chạy lại trưởng nhóm');
    } else if (!goalInput.value.trim()) reason = 'Đặt mục tiêu chung trước.';
    if (paused) {
      const cut = (g.interrupted || []).map((sid) => store.sessions.get(sid)?.name).filter(Boolean);
      add(runSlot,
        h('div', { class: 'team-run-row' }, runButton('primary team-start', 'play', 'Tiếp tục', 'resume', 'Nhóm chạy tiếp.', Boolean(reason)), stopBtn()),
        h('div', { class: `field-hint center${reason ? ' warn' : ''}` }, reason
          || [`Nhóm tạm dừng${g.pausedAt ? ` lúc ${clockTime(g.pausedAt)}` : ''}`, cut.length ? `đã cắt ngang lượt đang chạy của ${cut.join(', ')}` : '']
            .filter(Boolean).join(', ') + '. Không phiên nào nhận việc hay tin của nhóm cho tới khi bấm Tiếp tục; khi đó trưởng nhóm nhận lại tình hình, phiên bị cắt ngang làm tiếp việc dở.'),
        fix ? h('div', { class: 'team-fix' }, fix) : null);
      return;
    }
    const start = runButton('primary block team-start', 'play', g.status === 'draft' ? 'Bắt đầu' : 'Bắt đầu lại', 'start', 'Đã giao mục tiêu cho trưởng nhóm.', Boolean(reason));
    add(runSlot, start,
      h('div', { class: `field-hint center${reason ? ' warn' : ''}` }, reason
        || 'Chỉ trưởng nhóm chạy và nhận mục tiêu; phiên nào được giao việc thì mới được mở, hết việc thì bàn giao rồi dừng.'),
      fix ? h('div', { class: 'team-fix' }, fix) : null,
      !reason && unassigned ? h('div', { class: 'field-hint center warn' }, `${unassigned} phiên chưa có vai trò: trưởng nhóm sẽ khó giao đúng việc.`) : null);
  }

  function renderSummary(g) {
    clear(summarySlot);
    if (!g.summary) return;
    summarySlot.append(h('section', { class: 'notice ok team-summary' },
      h('div', { class: 'team-summary-head' }, icon('check', 16), `Trưởng nhóm báo đạt mục tiêu${g.finishedAt ? ` · ${timeAgo(g.finishedAt)}` : ''}`),
      h('div', { class: 'md', html: renderMarkdown(g.summary) })));
  }

  function renderMembers(g) {
    clear(membersTitle).append('Thành viên', h('span', { class: 'group-count' }, g.members.length));
    clear(membersList);
    if (!g.members.length) {
      membersList.append(h('div', { class: 'field-hint' }, 'Chưa có phiên nào. Phiên đầu tiên vào nhóm làm trưởng nhóm.'));
      return;
    }
    for (const m of g.members) {
      const s = store.sessions.get(m.id);
      const leader = m.id === g.leaderId;
      const status = s?.status || 'stopped';
      const busyOn = g.tasks.filter((t) => t.assignee === m.id && t.status === 'doing').map((t) => t.id);
      const queue = g.tasks.filter((t) => t.assignee === m.id && t.status === 'queued').map((t) => t.id);
      membersList.append(h('div', { class: `team-member status-${status}${leader ? ' leader' : ''}` },
        h('a', { class: 'team-member-main', href: `#/s/${m.id}/g/${g.id}` },
          h('span', { class: 'status-dot' }),
          h('span', { class: 'team-member-text' },
            h('span', { class: 'team-member-name' }, leader ? icon('crown', 14, 'team-crown') : null,
              h('span', { class: 'team-member-label' }, s?.name || 'Phiên đã xoá'), modelChip(s)),
            h('span', { class: 'team-member-meta' }, [leader ? 'Trưởng nhóm' : '', s?.machine, baseName(s?.cwd), SESSION_STATUS[status], busyOn.length ? `làm ${busyOn.join(', ')}` : '', queue.length ? `chờ ${queue.join(', ')}` : '', s?.contextTokens ? `ngữ cảnh ${Math.round(s.contextTokens / 1000)}k` : ''].filter(Boolean).join(' · ')))),
        h('button', {
          type: 'button',
          class: `team-role-btn${m.role ? '' : ' unset'}`,
          title: m.role ? roleHint(m.role) : 'Gán vai trò',
          onclick: () => openRolePicker(id, m.id),
        }, m.role ? `$${m.role}` : 'Gán vai trò'),
        h('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Tuỳ chọn thành viên', onclick: () => openMemberMenu(id, m.id) }, icon('more', 18))));
    }
  }

  function renderTasks(g) {
    const { total, done } = progress(g);
    add(clear(tasksTitle), 'Bảng việc', total ? h('span', { class: 'group-count' }, `${done}/${total}`) : null);
    clear(tasksSlot);
    if (!total) {
      tasksSlot.append(h('div', { class: 'field-hint' }, g.status === 'running'
        ? 'Trưởng nhóm đang đọc mục tiêu và chia việc.'
        : 'Sau khi bắt đầu, trưởng nhóm chia mục tiêu thành việc và giao cho từng phiên ở đây.'));
      return;
    }
    tasksSlot.append(h('div', { class: 'team-bar big' }, h('div', { class: 'team-fill', style: { width: `${(done / total) * 100}%` } })));
    const tasks = [...g.tasks].sort((a, b) => TASK_ORDER.indexOf(a.status) - TASK_ORDER.indexOf(b.status) || taskNumber(a) - taskNumber(b));
    for (const t of tasks) {
      const who = t.assignee ? store.sessions.get(t.assignee) : null;
      const role = t.assignee ? g.members.find((m) => m.id === t.assignee)?.role : '';
      const note = t.note ? h('div', { class: 'team-task-note' }, t.note) : null;
      const detail = t.detail ? h('div', { class: 'team-task-detail hidden' }, t.detail) : null;
      tasksSlot.append(h('div', {
        class: `team-task task-${t.status}`,
        onclick: () => {
          detail?.classList.toggle('hidden');
          note?.classList.toggle('open');
        },
      },
      h('div', { class: 'team-task-top' },
        h('span', { class: 'team-task-id' }, t.id),
        h('span', { class: 'team-task-title' }, t.title),
        h('span', { class: 'team-task-status' }, TASK_STATUS[t.status] || t.status)),
      h('div', { class: 'team-task-meta' }, [who ? `${who.name}${role ? ` ($${role})` : ''}` : 'Chưa giao', t.updatedAt ? timeAgo(t.updatedAt) : ''].filter(Boolean).join(' · ')),
      detail, note));
    }
  }

  function renderFeed(g) {
    clear(feedSlot);
    const ids = new Set(g.members.map((m) => m.id));
    const items = store.channel.filter((c) => c.groupId === id || (ids.has(c.from?.id) && c.to?.some((t) => ids.has(t.id)))).slice(-FEED_MAX);
    if (!items.length) return;
    // Tin dài (lời giao mục tiêu, giao việc) chỉ hiện mấy dòng đầu, mờ dần ở đáy; chạm vào thì mở hết.
    const feed = h('div', { class: 'team-feed' }, items.map((c) => h('div', { class: 'team-feed-item' },
      h('div', { class: 'team-feed-head' },
        h('b', null, c.from?.name || 'Chủ dự án'), icon('chevron', 12),
        h('span', null, c.to?.length ? c.to.map((t) => t.name).join(', ') : 'không ai nhận'),
        h('span', { class: 'msg-time' }, clockTime(c.at))),
      h('div', { class: 'team-feed-body md', html: renderMarkdown(c.text), onclick: (e) => e.currentTarget.classList.toggle('open') }),
      c.failed?.length ? h('div', { class: 'field-hint warn' }, `Không tới: ${c.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`) : null)));
    feedSlot.append(h('section', { class: 'team-block' }, h('div', { class: 'group-title' }, icon('channel', 14), 'Trao đổi trong nhóm'), feed));
    requestAnimationFrame(() => {
      for (const body of feed.querySelectorAll('.team-feed-body')) body.classList.toggle('clipped', body.scrollHeight > body.clientHeight + 2);
      feed.scrollTop = feed.scrollHeight; // tin mới nhất ở đáy
    });
  }

  render();
  const memberOf = (sid) => store.groups.get(id)?.members.some((m) => m.id === sid);
  const offs = [
    store.on('state', render),
    store.on('group', (g) => { if (g.id === id) render(); }),
    store.on('group_removed', (gid) => { if (gid === id) render(); }),
    store.on('session', (s) => { if (memberOf(s.id)) render(); }),
    store.on('channel', () => { const g = store.groups.get(id); if (g) renderFeed(g); }),
    store.on('tokens', render),
  ];
  return () => offs.forEach((off) => off());
}
