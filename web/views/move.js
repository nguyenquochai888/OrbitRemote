// Bảng "Chuyển sang máy khác" của một phiên: chọn máy và thư mục đích, kiểm trước, rồi chuyển và theo dõi từng
// bước (trạm: src/session-move.mjs). Mã nguồn đi qua git bằng một commit tạm, hội thoại đi bằng nhật ký của
// Claude Code; phiên giữ nguyên mã của app nên nhóm, vai trò và Kênh không đổi.

import { h, add, clear, baseName, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { openSheet, segmented, dirBrowser } from './sheets.js';

const STEP_LABEL = {
  check: 'Kiểm hai máy',
  close: 'Đóng phiên ở máy nguồn',
  push: 'Commit tạm và đẩy lên kho',
  pull: 'Máy đích kéo về',
  transcript: 'Chép hội thoại',
  open: 'Mở lại phiên ở máy đích',
  error: 'Dừng giữa chừng',
};

const sameDir = (a, b) => String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();

export function openMoveSheet(id) {
  const s = store.sessions.get(id);
  if (!s) return;
  const { body } = openSheet('Chuyển sang máy khác', { tall: true });
  const online = [...store.machines.values()].filter((m) => m.online).sort((a, b) => a.name.localeCompare(b.name));
  // Thư mục đích đoán sẵn: thư mục cùng tên đã dùng trên máy đó, không thì cùng đường dẫn như máy nguồn.
  const guessDir = (machineId) => {
    const recents = store.recents[machineId] || [];
    const named = recents.find((d) => baseName(d).toLowerCase() === baseName(s.cwd).toLowerCase() && !(machineId === s.machineId && sameDir(d, s.cwd)));
    return named || (machineId === s.machineId ? '' : s.cwd);
  };
  const form = { machineId: (online.find((m) => m.id !== s.machineId) || online[0])?.id || '', cwd: '' };
  form.cwd = guessDir(form.machineId);
  let plan = null; // kết quả "Kiểm trước" khớp với form hiện tại
  let jobState = '';

  const intro = h('div', { class: 'field-hint move-intro' },
    `Phiên "${s.name}" đang ở máy ${s.machine}, thư mục ${s.cwd}. Phần đang sửa dở được commit tạm ("WIP") và đẩy lên kho chung, máy đích kéo về, hội thoại được chép sang, rồi phiên chạy tiếp ở máy đích với đủ ngữ cảnh. Nhóm và vai trò của phiên giữ nguyên.`);
  const formBox = h('div', { class: 'form' });
  const planBox = h('div', { class: 'move-plan' });
  const progress = h('div', { class: 'move-steps' });
  const actions = h('div', { class: 'move-actions' });
  body.append(intro, formBox, planBox, progress, actions);

  const resetPlan = () => {
    plan = null;
    clear(planBox);
    renderActions();
  };

  function renderForm() {
    clear(formBox);
    if (!online.length) {
      formBox.append(h('div', { class: 'empty small' }, 'Không có máy nào đang nối.'));
      return;
    }
    const cwdInput = h('input', { class: 'input', value: form.cwd, placeholder: 'D:\\Project\\TenDuAn', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', oninput: (e) => { form.cwd = e.target.value; resetPlan(); } });
    const browseSlot = h('div');
    const browseBtn = h('button', { type: 'button', class: 'btn browse-btn', title: 'Duyệt thư mục trên máy đích' }, icon('folder', 17), 'Duyệt');
    browseBtn.addEventListener('click', () => {
      if (browseSlot.firstChild) {
        clear(browseSlot);
        browseBtn.classList.remove('on');
        return;
      }
      browseBtn.classList.add('on');
      browseSlot.append(dirBrowser(form.machineId, form.cwd.trim(), (path) => {
        clear(browseSlot);
        browseBtn.classList.remove('on');
        if (!path) return;
        form.cwd = path;
        cwdInput.value = path;
        resetPlan();
      }));
    });
    const chips = h('div', { class: 'chip-row wrap' }, (store.recents[form.machineId] || []).slice(0, 8).map((d) => h('button', {
      type: 'button',
      class: 'chip small',
      title: d,
      onclick: () => { form.cwd = d; cwdInput.value = d; resetPlan(); },
    }, baseName(d))));
    add(formBox,
      h('div', { class: 'field', role: 'group', 'aria-label': 'Máy đích' },
        h('span', { class: 'field-label' }, 'Máy đích'),
        segmented(online.map((m) => ({ id: m.id, label: m.id === s.machineId ? `${m.name} (máy hiện tại)` : m.name })), form.machineId, (mid) => {
          form.machineId = mid;
          form.cwd = guessDir(mid);
          resetPlan();
          renderForm();
        })),
      h('div', { class: 'field', role: 'group', 'aria-label': 'Thư mục ở máy đích' },
        h('span', { class: 'field-label' }, 'Thư mục ở máy đích'),
        h('div', { class: 'cwd-row' }, cwdInput, browseBtn), chips, browseSlot,
        h('span', { class: 'field-hint' }, 'Thư mục đó phải là một bản clone của cùng kho git, không có thay đổi chưa commit.')));
  }

  function renderPlan(p) {
    clear(planBox);
    const list = (items, cls, ico) => items.map((t) => h('div', { class: `move-line ${cls}` }, icon(ico, 15), h('span', null, t)));
    add(planBox,
      h('div', { class: 'group-title' }, p.ok ? 'Sẽ làm' : 'Chưa chuyển được'),
      list(p.blockers, 'block', 'x'),
      p.ok ? list(p.steps, 'step', 'check') : null,
      list(p.warnings, 'warn', 'shield'),
      p.git?.dirty ? h('details', { class: 'move-files' },
        h('summary', null, `${p.git.dirty} file sẽ vào commit tạm`),
        h('div', { class: 'move-file-list' }, p.git.files.map((f) => h('div', null, f)), p.git.dirty > p.git.files.length ? h('div', null, `… và ${p.git.dirty - p.git.files.length} file nữa`) : null)) : null);
  }

  function renderActions() {
    clear(actions);
    if (jobState === 'running') return;
    if (jobState === 'done') {
      actions.append(h('a', { class: 'btn primary block', href: `#/s/${id}` }, icon('channel', 16), 'Mở phiên ở máy mới'));
      return;
    }
    const checkBtn = h('button', {
      type: 'button',
      class: `btn block${plan?.ok ? '' : ' primary'}`,
      disabled: !form.machineId || !form.cwd.trim(),
      onclick: async () => {
        checkBtn.disabled = true;
        clear(planBox).append(h('div', { class: 'field-hint' }, 'Đang hỏi hai máy…'));
        try {
          plan = await api.post(`/api/sessions/${id}/move-check`, { machineId: form.machineId, cwd: form.cwd.trim() });
          renderPlan(plan);
        } catch (err) {
          clear(planBox).append(h('div', { class: 'move-line block' }, icon('x', 15), h('span', null, err.message)));
          plan = null;
        }
        renderActions();
      },
    }, icon('search', 16), plan ? 'Kiểm lại' : 'Kiểm trước');
    const goBtn = h('button', {
      type: 'button',
      class: 'btn primary block',
      disabled: !plan?.ok,
      onclick: async () => {
        if (!window.confirm(`Chuyển phiên "${s.name}" sang máy ${plan.to.machine}? Phiên ở máy ${s.machine} sẽ đóng${plan.git?.dirty ? `, ${plan.git.dirty} file đang sửa dở được commit tạm và đẩy lên kho` : ''}.`)) return;
        goBtn.disabled = true;
        try {
          await api.post(`/api/sessions/${id}/move`, { machineId: form.machineId, cwd: form.cwd.trim() });
          jobState = 'running';
          clear(formBox);
          renderActions();
        } catch (err) {
          toast(err.message, 'error');
          goBtn.disabled = false;
        }
      },
    }, icon('send', 16), 'Chuyển');
    add(actions, checkBtn, plan?.ok ? goBtn : null);
  }

  // Một bước: đang chạy (vòng xoay), xong (dấu tích), hỏng (dấu x). Bước đang chạy được thay bằng kết quả của nó.
  function step(ev) {
    const prev = progress.querySelector(`[data-step="${ev.step}"]`);
    const row = h('div', { class: `move-step ${ev.stepState}`, 'data-step': ev.step },
      h('span', { class: 'move-step-ico' }, icon(ev.stepState === 'ok' ? 'check' : ev.stepState === 'fail' ? 'x' : 'rotate', 15)),
      h('span', { class: 'move-step-text' }, h('b', null, STEP_LABEL[ev.step] || ev.step), h('span', null, ev.text)));
    if (prev) prev.replaceWith(row);
    else progress.append(row);
  }

  function onMove(ev) {
    if (ev.id !== id) return;
    jobState = ev.state;
    if (!progress.childElementCount) clear(planBox);
    step(ev);
    if (ev.state === 'done') toast(`Đã chuyển phiên sang máy ${ev.target?.machine || 'mới'}.`);
    if (ev.state === 'failed') {
      // Bước đang chạy dở lúc hỏng thì không quay mãi.
      for (const row of progress.querySelectorAll('.move-step.run')) row.className = 'move-step fail';
      jobState = '';
      plan = null;
      renderForm();
    }
    renderActions();
  }

  renderForm();
  renderActions();
  // Đang có một lần chuyển chạy dở (mở lại bảng giữa chừng): hiện tiếp tiến độ.
  api.get(`/api/sessions/${id}/move`).then(({ job }) => {
    if (job?.state !== 'running') return;
    jobState = 'running';
    clear(formBox);
    for (const e of job.log) step({ step: e.step, stepState: e.state, text: e.text });
    renderActions();
  }).catch(() => {});
  const off = store.on('move', onMove);
  const observer = new MutationObserver(() => {
    if (!body.isConnected) {
      off();
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('sheet-root'), { childList: true });
}
