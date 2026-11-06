// Bảng trượt từ dưới lên: khung chung, bảng mở phiên mới, và bảng tuỳ chọn của một phiên.
//
// Bảng theo ngón tay khi kéo xuống và bật lại như có lò xo nếu thả chưa đủ xa. Chỉ dùng
// transform và opacity, nên trình duyệt đẩy hết sang GPU, không vẽ lại bố cục.

import { h, add, clear, timeAgo, baseName, toast, copyText, workDir } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { actionsFor, runAction, NEW_SESSION_DEFAULTS } from '../lib/custom.js';
import { addToGroup, openRolePicker } from './group.js';
import { openMoveSheet } from './move.js';
import { modelOptions, sessionModel } from '../lib/models.js';


export const MODES = [
  { id: 'manual', label: 'Hỏi từng lần', hint: 'Mọi thao tác có rủi ro đều chờ bạn duyệt trên app.' },
  { id: 'acceptEdits', label: 'Tự sửa file', hint: 'Tự sửa file trong dự án; lệnh shell vẫn hỏi.' },
  { id: 'auto', label: 'Tự động', hint: 'Claude tự quyết, chỉ hỏi khi thật sự rủi ro.' },
  { id: 'plan', label: 'Lập kế hoạch', hint: 'Chỉ đọc và lập kế hoạch, không sửa gì.' },
  { id: 'bypassPermissions', label: 'Bỏ qua quyền', hint: 'Không hỏi gì cả. Chỉ dùng khi tin hoàn toàn.' },
];

export const EFFORTS = [
  { id: '', label: 'Mặc định', short: 'Effort', hint: 'Theo cài đặt của Claude Code trên máy.' },
  { id: 'low', label: 'Thấp', short: 'Thấp', hint: 'Nhanh, ít suy nghĩ.' },
  { id: 'medium', label: 'Vừa', short: 'Vừa' },
  { id: 'high', label: 'Cao', short: 'Cao' },
  { id: 'xhigh', label: 'Rất cao', short: 'Rất cao' },
  { id: 'max', label: 'Tối đa', short: 'Tối đa', hint: 'Suy nghĩ sâu nhất, chậm và tốn nhất.' },
];

let openCount = 0;

// cls: lớp thêm cho bảng (ví dụ "viewer" của khung xem tệp); onClose: chạy một lần khi bảng đóng.
export function openSheet(title, { tall = false, cls = '', onClose = null } = {}) {
  const root = document.getElementById('sheet-root');
  const body = h('div', { class: 'sheet-body' });
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Đóng' }, icon('x'));
  const head = h('div', { class: 'sheet-head' }, h('h3', { title }, title), closeBtn);
  const grip = h('div', { class: 'sheet-grip' });
  const sheet = h('div', { class: `sheet${tall ? ' tall' : ''}${cls ? ` ${cls}` : ''}`, role: 'dialog', 'aria-label': title }, grip, head, body);
  const backdrop = h('div', { class: 'sheet-backdrop' });
  root.append(backdrop, sheet);
  openCount += 1;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => {
    backdrop.classList.add('show');
    sheet.classList.add('show');
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose?.();
    sheet.style.transform = '';
    sheet.classList.remove('show');
    backdrop.classList.remove('show');
    setTimeout(() => {
      sheet.remove();
      backdrop.remove();
      openCount -= 1;
      if (!openCount) document.body.classList.remove('sheet-open');
    }, 320);
    window.removeEventListener('hashchange', close);
  };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  window.addEventListener('hashchange', close);

  // Kéo xuống để đóng: theo ngón tay, thả đủ xa hoặc vuốt đủ nhanh thì đóng.
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let dragging = false;
  const onDown = (e) => {
    dragging = true;
    startY = lastY = e.clientY;
    lastT = performance.now();
    velocity = 0;
    sheet.classList.add('dragging');
    e.target.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragging) return;
    const now = performance.now();
    velocity = (e.clientY - lastY) / Math.max(1, now - lastT);
    lastY = e.clientY;
    lastT = now;
    const dy = Math.max(0, e.clientY - startY);
    // Kéo lên quá đỉnh thì có lực cản, như kéo một vật có trọng lượng.
    const pull = e.clientY - startY < 0 ? (e.clientY - startY) / 6 : dy;
    sheet.style.transform = `translateY(${pull}px)`;
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    const dy = lastY - startY;
    if (dy > 110 || velocity > 0.6) close();
    else sheet.style.transform = '';
  };
  for (const el of [grip, head]) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }
  return { body, close, sheet };
}

export function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'segmented' });
  const render = (current) => {
    clear(wrap);
    for (const o of options) {
      wrap.append(h('button', {
        type: 'button',
        class: `seg${o.id === current ? ' active' : ''}`,
        disabled: Boolean(o.disabled),
        onclick: () => { render(o.id); onChange(o.id); },
      }, o.label));
    }
  };
  render(value);
  return wrap;
}

// <label> chỉ được bọc đúng một ô nhập. Dãy nút (chọn máy, chọn quyền) bọc trong <label> thì trên
// iPhone không chọn được gì (đã gặp thật; Chromium thì không bị), có lẽ vì segmented vẽ lại nút ngay
// lúc đang xử lý cú chạm nên <label> chuyển cú chạm sang nút đầu tiên. Dãy nút dùng <div role="group">.
function field(label, control, hint, { group = false } = {}) {
  return h(group ? 'div' : 'label', { class: 'field', ...(group ? { role: 'group', 'aria-label': label } : {}) },
    h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

// Remote Control của Claude Code (src/claude-session.mjs setRemoteControl): bật thì phiên hiện trên claude.ai/code
// và app Claude của tài khoản đăng nhập trên máy chạy phiên, điều khiển tiếp được từ đó. Bảng mở phiên nhớ lựa
// chọn lần trước.
const RC_KEY = 'orbit.newSession.remoteControl';
const RC_OPTIONS = [{ id: 'off', label: 'Tắt' }, { id: 'on', label: 'Bật' }];
const RC_HINT = 'Bật thì phiên hiện trên claude.ai/code và app Claude của tài khoản đăng nhập trên máy chạy phiên, điều khiển tiếp được từ đó. Máy phải đăng nhập Claude Code bằng tài khoản Claude, không dùng API key.';
const RC_STATE = { pending: 'Đang bật…', ready: 'Đang nối…', connected: 'Đã nối với claude.ai', failed: 'Hỏng' };
const rcRemembered = () => {
  try {
    return localStorage.getItem(RC_KEY) === '1';
  } catch {
    return false;
  }
};
const rcRemember = (on) => {
  try {
    localStorage.setItem(RC_KEY, on ? '1' : '0');
  } catch {
    // trình duyệt chặn lưu: lần sau về Tắt
  }
};
function rcPicker(on, onChange, status = null) {
  return h('div', null, segmented(RC_OPTIONS, on ? 'on' : 'off', (v) => onChange(v === 'on')), status, h('div', { class: 'field-hint' }, RC_HINT));
}
// Trạng thái Remote Control của một phiên đang chạy: đang nối, đã nối (kèm link mở trên claude.ai), hay hỏng (lý do).
function rcStatus(rc) {
  if (!rc || (!rc.on && !rc.error)) return null;
  const text = rc.error ? `${RC_STATE.failed}: ${rc.error}` : RC_STATE[rc.state] || rc.state || RC_STATE.pending;
  return h('div', { class: `rc-status${rc.error ? ' bad' : rc.state === 'connected' ? ' ok' : ''}` },
    h('span', null, text),
    rc.url ? h('a', { href: rc.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 14), 'Mở trên claude.ai') : null);
}

function modePicker(value, onChange) {
  const hint = h('div', { class: 'field-hint' });
  const setHint = (id) => { hint.textContent = MODES.find((m) => m.id === id)?.hint || ''; };
  setHint(value);
  return h('div', null, segmented(MODES, value, (id) => { setHint(id); onChange(id); }), hint);
}

// Duyệt thư mục trên một máy (đầu máy đọc, src/dirs.mjs), dùng ở bảng mở phiên mới và bảng chuyển phiên:
// ổ đĩa và chỗ quen dùng, chạm để vào, "Lên" để ra, "Chọn thư mục này" để điền vào ô thư mục làm việc.
export function dirBrowser(machineId, startPath, onPick) {
  const box = h('div', { class: 'dir-browser' });
  let current = null; // câu trả lời của máy cho thư mục đang xem
  let turn = 0;
  async function go(path) {
    const mine = ++turn;
    clear(box).append(h('div', { class: 'dir-note' }, 'Đang đọc thư mục trên máy…'));
    try {
      const r = await api.get(`/api/machines/${machineId}/dirs?path=${encodeURIComponent(path || '')}`);
      if (mine !== turn) return;
      current = r;
      draw();
    } catch (err) {
      if (mine !== turn) return;
      // Thư mục gõ sẵn trong ô không mở được (gõ dở, đã xoá): về chỗ bắt đầu thay vì kẹt ở lỗi.
      if (path && !current) return go('');
      clear(box).append(h('div', { class: 'dir-note err' }, err.message),
        h('div', { class: 'dir-actions' },
          h('button', { type: 'button', class: 'btn small ghost', onclick: () => onPick(null) }, 'Đóng'),
          current ? h('button', { type: 'button', class: 'btn small', onclick: () => draw() }, 'Quay lại') : null));
    }
  }
  function draw() {
    const r = current;
    const atRoots = !r.path;
    const up = atRoots ? null : h('button', { type: 'button', class: 'icon-btn dir-up', 'aria-label': 'Lên thư mục cha', title: 'Lên', onclick: () => go(r.parent || '') }, icon('back', 18));
    const rows = r.entries.map((e) => h('button', { type: 'button', class: `dir-row ${e.kind}`, title: e.path, onclick: () => go(e.path) },
      icon(e.kind === 'drive' ? 'drive' : 'folder', 17), h('span', { class: 'dir-name' }, e.name), icon('chevron', 14)));
    clear(box).append(
      h('div', { class: 'dir-head' }, up, atRoots
        ? h('div', { class: 'dir-path roots' }, 'Chọn ổ đĩa hay thư mục quen dùng')
        : h('div', { class: 'dir-path', title: r.path }, r.path)),
      h('div', { class: 'dir-list' }, rows.length ? rows : h('div', { class: 'dir-note' }, 'Không có thư mục con.'),
        r.more ? h('div', { class: 'dir-note' }, 'Chỉ hiện 500 thư mục đầu.') : null),
      h('div', { class: 'dir-actions' },
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => onPick(null) }, 'Đóng'),
        h('button', { type: 'button', class: 'btn small primary', disabled: atRoots, onclick: () => onPick(r.path) }, icon('check', 15), 'Chọn thư mục này')));
  }
  go(startPath);
  return box;
}

// ---- Mở phiên mới / mở lại phiên cũ ------------------------------------------------
export function openNewSession(preset = {}) {
  const machines = [...store.machines.values()].sort((a, b) => Number(b.online) - Number(a.online));
  const online = machines.filter((m) => m.online);
  // Mở từ màn một nhóm: phiên mới vào thẳng nhóm đó, kèm vai trò chọn ngay ở đây.
  const group = preset.groupId ? store.groups.get(preset.groupId) : null;
  const { body, close } = openSheet(group ? `Phiên mới trong nhóm ${group.name}` : 'Phiên mới', { tall: true });
  if (!online.length) {
    body.append(h('div', { class: 'empty small' }, 'Chưa có máy nào đang nối. Bật một máy có Orbit Remote lên là nó tự nối vào trạm.'));
    return;
  }

  const wantMachine = (preset.machineId && online.find((m) => m.id === preset.machineId))
    || (preset.machine && online.find((m) => m.name.toLowerCase() === String(preset.machine).toLowerCase()));
  const form = {
    machineId: (wantMachine || online[0]).id,
    cwd: preset.cwd || '',
    name: preset.name || '',
    model: preset.model ?? NEW_SESSION_DEFAULTS.model,
    effort: preset.effort ?? NEW_SESSION_DEFAULTS.effort,
    permissionMode: preset.permissionMode || NEW_SESSION_DEFAULTS.permissionMode,
    remoteControl: preset.remoteControl ?? rcRemembered(),
    // Máy phiên làm việc trên đó; '' là chính máy chạy phiên (workId).
    workMachineId: preset.workMachineId && preset.workMachineId !== (wantMachine || online[0]).id ? preset.workMachineId : '',
    prompt: preset.prompt || '',
    ...(group ? { groupId: group.id, role: preset.role || '' } : {}),
  };
  // Phiên mở trong nhóm thì về lại màn của nhóm để thêm tiếp; phiên thường thì vào thẳng phiên. Mở từ màn một máy
  // (preset.fromMachine) thì nút quay lại của phiên đưa về màn máy đó.
  const opened = (snap) => {
    location.hash = group ? `#/g/${group.id}` : preset.fromMachine ? `#/s/${snap.id}/m/${snap.machineId || form.machineId}` : `#/s/${snap.id}`;
  };
  const workId = () => form.workMachineId || form.machineId;
  if (!form.cwd) form.cwd = (store.recents[workId()] || [])[0] || '';

  const tabNew = h('button', { class: 'tab active', type: 'button' }, 'Phiên mới');
  const tabOld = h('button', { class: 'tab', type: 'button' }, 'Mở lại phiên cũ');
  const pane = h('div');
  body.append(h('div', { class: 'tabs' }, tabNew, tabOld), pane);
  const transcriptCache = new Map();

  // Máy phiên làm việc trên đó (orbit_machine_*, src/remote-ops.mjs): mặc định chính máy chạy phiên. Chọn máy khác thì
  // phiên chạy (và tính vào tài khoản Claude) ở máy trên, còn lệnh, tệp, màn hình, Unity là của máy được chọn ở đây;
  // thư mục làm việc bên dưới là thư mục trên máy đó.
  const workPicker = () => {
    if (machines.length < 2) return null;
    const runName = store.machines.get(form.machineId)?.name || '';
    const workName = store.machines.get(workId())?.name || '';
    const hint = form.workMachineId
      ? `Phiên chạy ở máy ${runName} (tính vào tài khoản Claude của máy đó) và làm việc trên máy ${workName} bằng công cụ orbit_machine_*. Mở phiên là cho phép máy ${runName} điều khiển máy ${workName}; thu lại trong bảng của máy ${workName}.`
      : 'Mặc định làm việc ngay trên máy chạy phiên. Chọn máy khác khi dự án nằm ở máy đó mà muốn dùng tài khoản Claude của máy chạy phiên.';
    const options = machines.map((m) => ({ id: m.id, label: m.id === form.machineId ? `${m.name} (máy chạy phiên)` : m.online ? m.name : `${m.name} (đang tắt)`, disabled: !m.online }));
    return field('Làm việc trên máy', h('div', null, segmented(options, workId(), (id) => {
      form.workMachineId = id === form.machineId ? '' : id;
      form.cwd = (store.recents[workId()] || [])[0] || '';
      renderNew();
    }), h('div', { class: 'field-hint' }, hint)), null, { group: true });
  };

  // Hiện cả máy đang tắt (không bấm được) để danh sách máy luôn đủ và quen mắt.
  const machinePicker = (onPick) => (machines.length > 1
    ? field('Máy', segmented(machines.map((m) => ({ id: m.id, label: m.online ? m.name : `${m.name} (đang tắt)`, disabled: !m.online })),
      form.machineId, (id) => { form.machineId = id; onPick(); }), null, { group: true })
    : h('div', { class: 'machine-solo' }, icon('machine', 16), online[0].name));

  async function transcriptsFor(machineId) {
    if (!transcriptCache.has(machineId)) {
      transcriptCache.set(machineId, api.get(`/api/machines/${machineId}/transcripts`).catch((err) => {
        transcriptCache.delete(machineId);
        throw err;
      }));
    }
    return transcriptCache.get(machineId);
  }

  function renderNew() {
    clear(pane);
    const presets = actionsFor('home').filter((a) => a.newSession);
    const cwdInput = h('input', { class: 'input', value: form.cwd, placeholder: 'D:\\Project\\TenDuAn', 'aria-label': 'Thư mục làm việc', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', oninput: (e) => { form.cwd = e.target.value; } });
    const browseSlot = h('div');
    const browseBtn = h('button', { type: 'button', class: 'btn browse-btn', 'aria-label': 'Duyệt thư mục trên máy', title: 'Duyệt thư mục trên máy' }, icon('folder', 17), 'Duyệt');
    browseBtn.addEventListener('click', () => {
      if (browseSlot.firstChild) {
        clear(browseSlot);
        browseBtn.classList.remove('on');
        return;
      }
      browseBtn.classList.add('on');
      browseSlot.append(dirBrowser(workId(), form.cwd.trim(), (path) => {
        clear(browseSlot);
        browseBtn.classList.remove('on');
        if (!path) return;
        form.cwd = path;
        cwdInput.value = path;
      }));
    });
    const dirChips = h('div', { class: 'chip-row wrap' });
    const fillDirs = (dirs) => {
      clear(dirChips);
      // Đường dẫn Windows không phân biệt hoa thường: gộp "d:\x" với "D:\x".
      const byKey = new Map();
      for (const d of dirs) {
        const key = /^[a-z]:[\\/]/i.test(d) ? d.toLowerCase().replace(/\//g, '\\') : d;
        if (!byKey.has(key)) byKey.set(key, d);
      }
      const picked = [...byKey.values()].slice(0, 10);
      // Hai thư mục khác nhau cùng tên cuối (…\probe\work và …\qa\work) thì hiện thêm thư mục cha.
      const count = new Map();
      for (const d of picked) count.set(baseName(d).toLowerCase(), (count.get(baseName(d).toLowerCase()) || 0) + 1);
      const label = (d) => {
        if (count.get(baseName(d).toLowerCase()) < 2) return baseName(d);
        const parts = d.split(/[\\/]/).filter(Boolean);
        return parts.slice(-2).join('/');
      };
      for (const d of picked) {
        dirChips.append(h('button', { type: 'button', class: 'chip small', title: d, onclick: () => { form.cwd = d; cwdInput.value = d; } }, label(d)));
      }
    };
    fillDirs(store.recents[workId()] || []);
    transcriptsFor(workId()).then((t) => fillDirs([...(store.recents[workId()] || []), ...t.dirs])).catch(() => {});

    // Mỗi dòng model một mục, nhãn kèm số bản mới nhất (trạm tự hỏi máy chủ Anthropic); dòng gợi ý dưới ô ghi mã
    // đầy đủ và vai trò của dòng đó. Không còn mục "Mặc định": Orbit luôn dùng bản mới nhất của một dòng.
    if (!['opus', 'sonnet', 'haiku'].includes(form.model)) form.model = 'opus';
    const modelHint = h('span', { class: 'field-hint' });
    const showModelHint = () => { modelHint.textContent = modelOptions().find((m) => m.id === form.model)?.hint || ''; };
    const modelSelect = h('select', { class: 'input', onchange: (e) => { form.model = e.target.value; showModelHint(); } },
      modelOptions().map((m) => h('option', { value: m.id, selected: m.id === form.model }, m.label)));
    showModelHint();
    const effortSelect = h('select', { class: 'input', onchange: (e) => { form.effort = e.target.value; } },
      EFFORTS.map((x) => h('option', { value: x.id, selected: x.id === form.effort }, x.label)));
    const presetChips = presets.length ? h('div', { class: 'chip-row wrap' }, presets.map((a) => h('button', {
      type: 'button',
      class: 'chip action-chip',
      onclick: () => { Object.assign(form, { ...a.newSession }); if (a.newSession.machine) { const m = online.find((x) => x.name.toLowerCase() === String(a.newSession.machine).toLowerCase()); if (m) form.machineId = m.id; } renderNew(); },
    }, a.label))) : null;
    // Thông tin dùng chung: một phiên lẻ hay cả loạt phiên trong nhóm đều mở với đúng các giá trị này.
    const shared = [
      machinePicker(() => {
        if (form.workMachineId === form.machineId) form.workMachineId = '';
        renderNew();
      }),
      workPicker(),
      // Nhóm (không phải <label>): có nút bên trong, mà nút trong <label> trên iPhone không bấm được.
      field(form.workMachineId ? `Thư mục làm việc trên ${store.machines.get(form.workMachineId)?.name || 'máy làm việc'}` : 'Thư mục làm việc', h('div', null, h('div', { class: 'cwd-row' }, cwdInput, browseBtn), dirChips, browseSlot), null, { group: true }),
      field('Model', h('div', null, modelSelect, modelHint), null, { group: true }),
      field('Effort', effortSelect),
      field('Quyền', modePicker(form.permissionMode, (id) => { form.permissionMode = id; }), null, { group: true }),
      field('Remote Control', rcPicker(form.remoteControl, (on) => { form.remoteControl = on; rcRemember(on); }), null, { group: true }),
    ];
    if (group) {
      renderBatch(presetChips, shared);
      return;
    }
    const prompt = h('textarea', { class: 'input', rows: 4, placeholder: 'Việc đầu tiên cho phiên này (có thể để trống)', oninput: (e) => { form.prompt = e.target.value; } }, form.prompt);
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, icon('play', 16), 'Mở phiên');

    pane.append(h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          const snap = await api.post('/api/sessions', form);
          close();
          opened(snap);
        } catch (err) {
          toast(err.message, 'error');
          submit.disabled = false;
        }
      },
    },
    presetChips,
    shared[0], // máy chạy phiên
    shared[1], // làm việc trên máy (null khi chỉ có một máy)
    shared[2], // thư mục làm việc
    field('Tên phiên', h('input', { class: 'input', value: form.name, placeholder: 'Ví dụ: Sửa lỗi đăng nhập', oninput: (e) => { form.name = e.target.value; } })),
    shared.slice(3),
    field('Câu lệnh đầu', prompt),
    submit));
  }

  // ---- Nhiều phiên một lần trong nhóm -----------------------------------------------------------
  // Thông tin dùng chung (máy, thư mục, model, effort, quyền) ở trên; mỗi phiên chỉ có tên (để trống thì Orbit đặt theo
  // vai trò và tên nhóm, như "QA Star Harbor") và vai trò. Không có câu lệnh đầu: trưởng nhóm giao việc. Bấm mở thì
  // mở lần lượt đúng số phiên trong danh sách; một phiên lỗi thì dừng, các phiên đã mở bỏ khỏi danh sách để bấm lại.
  const batch = group ? [{ name: preset.name || '', role: preset.role || '' }] : null;
  const roleLabel = (r) => (r.length <= 3 ? r.toUpperCase() : `${r[0].toUpperCase()}${r.slice(1)}`);
  function batchNames() {
    const taken = new Set(group.members.map((m) => (store.sessions.get(m.id)?.name || '').toLowerCase()));
    return batch.map((item) => {
      const own = item.name.trim();
      if (own) {
        taken.add(own.toLowerCase());
        return own.slice(0, 60);
      }
      const base = `${item.role ? roleLabel(item.role) : 'Phiên'} ${group.name}`.slice(0, 55).trim();
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} ${n}`;
      taken.add(name.toLowerCase());
      return name;
    });
  }

  function renderBatch(presetChips, shared) {
    const roles = store.roleTokens();
    const list = h('div', { class: 'batch-list' });
    const submitText = h('span');
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, icon('play', 16), submitText);
    const addBtn = h('button', { type: 'button', class: 'btn small batch-add', onclick: () => {
      batch.push({ name: '', role: '' });
      paint();
      list.lastChild?.querySelector('input')?.focus();
    } }, icon('plus', 15), 'Thêm phiên');
    const roomNote = h('span', { class: 'field-hint' });
    const paint = () => {
      clear(list);
      const names = batchNames(); // tên tự đặt hiện mờ trong ô, để biết trước phiên sẽ mang tên gì
      batch.forEach((item, i) => list.append(h('div', { class: 'batch-row' },
        h('span', { class: 'batch-no' }, String(i + 1)),
        h('input', {
          class: 'input batch-name', value: item.name, placeholder: names[i], 'aria-label': `Tên phiên ${i + 1}`,
          autocapitalize: 'off', spellcheck: 'false',
          oninput: (e) => { item.name = e.target.value; },
          onchange: () => paint(), // tên mới có thể đổi tên tự đặt của các phiên sau (trùng tên thì đánh số)
        }),
        h('select', { class: 'input batch-role', 'aria-label': `Vai trò phiên ${i + 1}`, onchange: (e) => { item.role = e.target.value; paint(); } },
          h('option', { value: '' }, 'Chưa gán vai trò'),
          roles.map((r) => h('option', { value: r.role, selected: r.role === item.role, title: r.hint }, `$${r.role} — ${r.hint}`))),
        batch.length > 1
          ? h('button', { type: 'button', class: 'icon-btn batch-remove', 'aria-label': `Bỏ phiên ${i + 1}`, title: 'Bỏ phiên này', onclick: () => { batch.splice(i, 1); paint(); } }, icon('x', 16))
          : h('span', { class: 'batch-gap' }))));
      submitText.textContent = batch.length > 1 ? `Mở ${batch.length} phiên` : 'Mở phiên';
      submit.disabled = !batch.length;
      roomNote.textContent = `Nhóm đang có ${group.members.length} phiên; mở xong sẽ có ${group.members.length + batch.length} phiên.`;
    };
    paint();
    pane.append(h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        addBtn.disabled = true;
        const names = batchNames();
        const total = batch.length;
        let done = 0;
        for (let i = 0; i < total; i += 1) {
          submitText.textContent = `Đang mở ${i + 1}/${total}…`;
          try {
            await api.post('/api/sessions', {
              machineId: form.machineId, cwd: form.cwd, model: form.model, effort: form.effort, permissionMode: form.permissionMode,
              remoteControl: form.remoteControl, workMachineId: form.workMachineId || undefined, groupId: group.id, role: batch[i].role, name: names[i],
            });
            done += 1;
          } catch (err) {
            toast(done ? `Đã mở ${done} phiên; phiên thứ ${i + 1} lỗi: ${err.message}` : err.message, 'error');
            batch.splice(0, done); // các phiên đã mở bỏ khỏi danh sách, bấm lại là mở tiếp phần còn lại
            paint();
            return;
          }
        }
        toast(total > 1 ? `Đã mở ${total} phiên trong nhóm ${group.name}.` : `Đã mở phiên trong nhóm ${group.name}.`);
        close();
        location.hash = `#/g/${group.id}`;
      },
    },
    presetChips,
    h('div', { class: 'batch-shared-label' }, 'Dùng chung cho mọi phiên'),
    shared,
    field('Các phiên', h('div', null, list, addBtn), null, { group: true }),
    h('div', { class: 'batch-note' }, roomNote, h('span', { class: 'field-hint' }, 'Để trống tên thì Orbit đặt theo vai trò và tên nhóm. Không cần câu lệnh đầu: trưởng nhóm giao việc cho từng phiên.')),
    submit));
  }

  // Vai trò của phiên trong nhóm: một token trong bảng token (custom/tokens.md), trưởng nhóm giao việc theo đó.
  function roleField() {
    const roles = store.roleTokens();
    const select = h('select', { class: 'input', onchange: (e) => { form.role = e.target.value; } },
      h('option', { value: '' }, 'Chưa gán vai trò'),
      roles.map((r) => h('option', { value: r.role, selected: r.role === form.role }, `$${r.role} — ${r.hint}`)));
    return field('Vai trò trong nhóm', select, `Phiên vào nhóm ${group.name}. Trưởng nhóm chỉ giao cho phiên này việc thuộc token đã chọn.`);
  }

  async function renderOld() {
    clear(pane);
    const list = h('div', { class: 'transcripts' }, h('div', { class: 'loading' }, 'Đang đọc nhật ký phiên…'));
    add(pane, group ? roleField() : null, machinePicker(renderOld), list);
    try {
      const { transcripts } = await transcriptsFor(form.machineId);
      clear(list);
      if (!transcripts.length) list.append(h('div', { class: 'empty small' }, 'Máy này chưa có phiên Claude nào.'));
      for (const t of transcripts) {
        const actions = h('div', { class: 'transcript-actions hidden' });
        const open = async (fork) => {
          try {
            const snap = await api.post(`/api/machines/${form.machineId}/open`, {
              claudeSessionId: t.claudeSessionId, cwd: t.cwd, fork, name: t.title.slice(0, 60), ...NEW_SESSION_DEFAULTS,
              ...(group ? { groupId: group.id, role: form.role } : {}),
            });
            close();
            opened(snap);
          } catch (err) {
            toast(err.message, 'error');
          }
        };
        add(actions,
          h('button', { class: 'btn small', onclick: () => open(false) }, 'Tiếp tục phiên này'),
          h('button', { class: 'btn small ghost', onclick: () => open(true) }, 'Tách nhánh mới'),
          t.maybeActive ? h('div', { class: 'field-hint warn' }, 'Phiên này vừa được ghi gần đây, có thể vẫn đang mở ở VS Code hay terminal. Nên tách nhánh để hai bên không ghi chồng lên nhau.') : null,
        );
        list.append(h('div', { class: 'transcript' },
          h('button', { class: 'transcript-main', type: 'button', onclick: () => actions.classList.toggle('hidden') },
            h('div', { class: 'transcript-title' }, t.title, t.maybeActive ? h('span', { class: 'tag live' }, 'đang mở?') : null),
            h('div', { class: 'transcript-meta' }, [baseName(t.cwd), timeAgo(t.modified),
              t.sizeKb >= 1024 ? `${(t.sizeKb / 1024).toFixed(1)} MB` : `${t.sizeKb} KB`].filter(Boolean).join(' · '))),
          actions));
      }
    } catch (err) {
      clear(list).append(h('div', { class: 'empty small' }, err.message));
    }
  }

  tabNew.addEventListener('click', () => { tabNew.classList.add('active'); tabOld.classList.remove('active'); renderNew(); });
  tabOld.addEventListener('click', () => { tabOld.classList.add('active'); tabNew.classList.remove('active'); renderOld(); });
  renderNew();
}

// ---- Tuỳ chọn của một phiên -------------------------------------------------------
export function openSessionMenu(id) {
  const { body, close } = openSheet('Phiên');
  const render = () => {
    const s = store.sessions.get(id);
    clear(body);
    if (!s) {
      body.append(h('div', { class: 'empty small' }, 'Phiên không còn.'));
      return;
    }
    const running = ['starting', 'idle', 'busy', 'waiting'].includes(s.status);
    const resumeCmd = `cd "${s.cwd}"; claude --resume ${s.claudeSessionId}`;
    const nameInput = h('input', { class: 'input', value: s.name });

    body.append(
      h('div', { class: 'info-grid' },
        h('span', null, 'Máy'), h('span', null, s.machine),
        ...(s.remote?.machine ? [h('span', null, 'Làm việc trên'), h('span', null, `máy ${s.remote.machine} (công cụ orbit_machine_*)`)] : []),
        h('span', null, 'Thư mục'), h('span', { class: 'mono' }, workDir(s)),
        h('span', null, 'Model'), h('span', null, s.activeModel ? `${sessionModel(s)} (${s.activeModel})` : sessionModel(s) || 'mặc định của Claude Code'),
        // total_cost_usd của Claude Code cộng dồn theo tiến trình (đo thật: 0,104 → 0,115 → 0,135
        // qua ba lượt), nên chạy lại phiên là đếm lại từ đầu.
        h('span', null, 'Chi phí'), h('span', null, s.costUsd ? `$${s.costUsd.toFixed(3)} (từ lần chạy này)` : '—'),
        h('span', null, 'Mã phiên'), h('span', { class: 'mono' }, s.claudeSessionId)),
      field('Tên', h('div', { class: 'inline-form' }, nameInput,
        h('button', { class: 'btn small', onclick: async () => {
          try { await api.post(`/api/sessions/${id}/rename`, { name: nameInput.value }); toast('Đã đổi tên.'); } catch (err) { toast(err.message, 'error'); }
        } }, 'Lưu'))),
    );

    // Nhóm của phiên: chọn nhóm là thêm (hay chuyển) vào nhóm đó rồi hỏi vai trò; bỏ chọn là rời nhóm.
    const team = store.groupOf(id);
    const groups = [...store.groups.values()];
    if (groups.length) {
      const role = team?.members.find((m) => m.id === id)?.role || '';
      body.append(field('Nhóm', h('div', { class: 'inline-form' },
        h('select', {
          class: 'input',
          onchange: async (e) => {
            const gid = e.target.value;
            if (gid) {
              close();
              addToGroup(gid, id);
              return;
            }
            try { await api.post(`/api/groups/${team.id}/remove`, { sessionId: id }); toast(`Đã rời nhóm ${team.name}.`); } catch (err) { toast(err.message, 'error'); render(); }
          },
        }, h('option', { value: '' }, 'Không ở nhóm nào'), groups.map((g) => h('option', { value: g.id, selected: g.id === team?.id }, g.name))),
        team ? h('button', { class: 'btn small', type: 'button', onclick: () => { close(); openRolePicker(team.id, id); } }, role ? `$${role}` : 'Gán vai trò') : null)));
    }

    if (running) {
      body.append(
        field('Quyền', modePicker(s.permissionMode, async (mode) => {
          try { await api.post(`/api/sessions/${id}/mode`, { mode }); } catch (err) { toast(err.message, 'error'); }
        }), null, { group: true }),
        field('Model', h('select', {
          class: 'input',
          onchange: async (e) => {
            try { await api.post(`/api/sessions/${id}/model`, { model: e.target.value }); toast('Đã đổi model.'); } catch (err) { toast(err.message, 'error'); }
          },
        }, modelOptions().map((m) => h('option', { value: m.id, selected: m.id === s.model }, m.label)))),
      );
    }

    // Remote Control: phiên đang chạy thì bật/tắt ngay (mất vài giây để Claude Code nối tới claude.ai; trạng thái về
    // theo phiên nên bảng tự vẽ lại). Phiên đã dừng thì ghi lựa chọn, chạy lại phiên là áp dụng.
    body.append(field('Remote Control', rcPicker(Boolean(s.remoteControl?.on), async (on) => {
      try {
        await api.post(`/api/sessions/${id}/remote-control`, { enabled: on });
        toast(running ? (on ? 'Đã bật Remote Control.' : 'Đã tắt Remote Control.') : (on ? 'Remote Control sẽ bật khi chạy lại phiên.' : 'Đã tắt Remote Control.'));
      } catch (err) {
        toast(err.message, 'error');
        render();
      }
    }, running ? rcStatus(s.remoteControl) : s.remoteControl?.on ? h('div', { class: 'rc-status' }, h('span', null, 'Bật khi chạy lại phiên.')) : null), null, { group: true }));

    body.append(field('Mở tiếp trên máy tính', h('div', { class: 'copy-box' },
      h('code', null, resumeCmd),
      h('button', { class: 'icon-btn', 'aria-label': 'Chép', onclick: () => copyText(resumeCmd) }, icon('copy', 18))),
    running ? 'Đóng phiên trên app trước, rồi chạy lệnh này trong terminal để làm tiếp đúng phiên đó.' : null));

    // Chuyển phiên sang máy khác (views/move.js): cần máy nguồn đang nối để lấy nhật ký và mã nguồn.
    if (s.claudeSessionId && !s.remote?.machine && store.machines.get(s.machineId)?.online) { // phiên làm việc trên máy khác: không có mã nguồn để chuyển
      body.append(h('button', { class: 'btn block move-open', type: 'button', onclick: () => { close(); openMoveSheet(id); } }, icon('machine', 16), 'Chuyển sang máy khác'));
    }

    const sessionActions = actionsFor('session');
    if (sessionActions.length) {
      body.append(field('Nút tuỳ biến', h('div', { class: 'chip-row wrap' },
        sessionActions.map((a) => h('button', { class: 'chip action-chip', onclick: () => { close(); runAction(a, { sessionId: id }); } }, a.label)))));
    }

    const danger = h('div', { class: 'danger-row' });
    if (running) {
      danger.append(h('button', { class: 'btn danger block', onclick: async () => {
        if (!window.confirm('Đóng phiên này? Có thể chạy lại sau, ngữ cảnh vẫn còn.')) return;
        try { await api.post(`/api/sessions/${id}/close`); close(); } catch (err) { toast(err.message, 'error'); }
      } }, icon('stop', 16), 'Đóng phiên'));
    } else {
      danger.append(
        h('button', { class: 'btn primary block', onclick: async () => {
          try { await api.post(`/api/sessions/${id}/resume`); close(); } catch (err) { toast(err.message, 'error'); }
        } }, icon('play', 16), 'Chạy lại phiên'),
        h('button', { class: 'btn danger-outline block', onclick: async () => {
          if (!window.confirm('Xoá phiên khỏi danh sách? Nhật ký trên máy vẫn còn, mở lại được ở mục "Mở lại phiên cũ".')) return;
          try { await api.post(`/api/sessions/${id}/forget`); close(); location.hash = '#/'; } catch (err) { toast(err.message, 'error'); }
        } }, icon('trash', 16), 'Xoá khỏi danh sách'),
      );
    }
    body.append(danger);
  };
  render();
  // Chỉ vẽ lại khi thứ hiển thị trên bảng thật sự đổi, kẻo đang gõ tên thì bị xoá mất.
  let lastKey = '';
  const keyOf = (s) => `${s.status}|${s.permissionMode}|${s.model}|${s.activeModel}|${s.remoteControl?.on}|${s.remoteControl?.state}|${s.remoteControl?.url}|${s.remoteControl?.error}`;
  const first = store.sessions.get(id);
  if (first) lastKey = keyOf(first);
  const off = store.on('session', (s) => {
    if (s.id !== id || keyOf(s) === lastKey) return;
    lastKey = keyOf(s);
    render();
  });
  const observer = new MutationObserver(() => {
    if (!body.isConnected) {
      off();
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('sheet-root'), { childList: true });
}
