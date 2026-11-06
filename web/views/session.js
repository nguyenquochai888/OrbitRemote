// Màn hội thoại của một phiên: dòng sự kiện, duyệt quyền, ô soạn và nút tuỳ biến.
//
// Mỗi sự kiện được vẽ đúng một lần rồi để yên; chỉ những chỗ phải đổi mới bị chạm tới:
// dòng công cụ nhận kết quả của nó, thẻ xin quyền chuyển sang "đã trả lời", và bong bóng
// chữ đang chảy được thay bằng khối chữ hoàn chỉnh. Không vẽ lại cả dòng thời gian.

import { h, add, clear, baseName, toast, workDir, workPlace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { renderMarkdown } from '../lib/md.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { actionsFor, runAction } from '../lib/custom.js';
import { createRenderer } from '../lib/render.js';
import { STATUS_LABEL } from './home.js';
import { openSessionMenu, openSheet, MODES, EFFORTS } from './sheets.js';
import { modelOptions, sessionModel } from '../lib/models.js';
import { attachmentIcon, attachmentKind, openAttachment } from './viewer.js';
import { attachMentions } from './mention.js';

const RUNNING = new Set(['starting', 'idle', 'busy', 'waiting']);
const NEAR_BOTTOM_PX = 140;
const ATTACH_MAX = 8;
const FILE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_EDGE = 2000;
const SESSION_WAIT_MS = 6000;
// Hai lệnh luôn đứng đầu danh sách "Lệnh nhanh". custom/actions.json khai nút cùng tên thì nút đó
// thay chỗ (đổi được câu gửi); không khai thì dùng câu mặc định dưới đây.
const QUICK_FIRST = [
  { label: 'Tiếp tục', send: 'Tiếp tục.' },
  { label: 'Báo tiến độ', send: 'Tóm tắt ngắn tiến độ hiện tại: đã xong gì, đang làm gì, việc tiếp theo. Tối đa 4 câu.' },
];

// opts.onClose: dựng thành phiên nổi trên màn của máy (views/machines.js). Nút đầu thanh trên là X gọi onClose thay
// cho nút quay lại, nút máy thành nút mở phiên đầy đủ (đang ở màn của máy rồi).
// opts.fromGroup, opts.fromMachine: mở từ màn một nhóm (#/s/<phiên>/g/<nhóm>) hay một máy (#/s/<phiên>/m/<máy>), nút
// quay lại đưa về đúng màn đó; không có thì về màn chính.
export function mountSession(root, id, opts = {}) {
  const floating = typeof opts.onClose === 'function';
  const fromGroup = opts.fromGroup || '';
  const fromMachine = opts.fromMachine || '';
  const backHref = fromGroup ? `#/g/${fromGroup}` : fromMachine ? `#/m/${fromMachine}` : '#/';
  // Nhóm hay máy đã bị xoá (quên) trong lúc đang xem phiên: về màn chính thay vì một màn trống.
  const backGone = () => (fromGroup && !store.groups.has(fromGroup)) || (fromMachine && !store.machines.has(fromMachine));
  const goBack = (e) => {
    if (!backGone()) return;
    e?.preventDefault();
    location.hash = '#/';
  };
  const leading = () => (floating
    ? h('button', { class: 'icon-btn', 'aria-label': 'Ẩn phiên nổi', title: 'Ẩn phiên nổi', onclick: () => opts.onClose() }, icon('x'))
    : h('a', { class: 'icon-btn', href: backHref, 'aria-label': fromGroup ? 'Quay lại nhóm' : fromMachine ? 'Quay lại máy' : 'Quay lại', onclick: goBack }, icon('back')));
  let session = store.sessions.get(id);
  if (!session) {
    // Vừa mở phiên mới: lệnh tạo phiên có thể trả về trước khi luồng sự kiện kịp báo phiên đó. Chờ
    // một lúc rồi mới kết luận là không có.
    const body = h('div', { class: 'loading' }, 'Đang mở phiên…');
    const waiting = h('div', { class: 'view' }, h('header', { class: 'topbar' }, leading()), body);
    root.append(waiting);
    let inner = null;
    const check = () => {
      if (inner || !store.sessions.has(id)) return;
      stopWaiting();
      waiting.remove();
      inner = mountSession(root, id, opts);
    };
    const offs = [store.on('session', check), store.on('state', check)];
    const timer = setTimeout(() => {
      clear(body).append(h('div', { class: 'empty-title' }, 'Không tìm thấy phiên này'));
      body.className = 'empty';
    }, SESSION_WAIT_MS);
    function stopWaiting() {
      offs.forEach((off) => off());
      clearTimeout(timer);
    }
    return () => {
      stopWaiting();
      inner?.();
    };
  }

  const title = h('div', { class: 'title' });
  const subtitle = h('div', { class: 'subtitle' });
  const pill = h('span', { class: 'pill' });
  // Nút máy cạnh trạng thái: sang thẳng màn của máy chạy phiên này (xem và điều khiển màn hình), nút
  // quay lại bên đó đưa về đúng phiên này.
  const machineDot = h('span', { class: 'mini-dot' });
  const machineBtn = h('a', { class: 'icon-btn machine-jump' }, icon('machine', 20), machineDot);
  const busyBar = h('div', { class: 'busy-bar' });
  const timeline = h('main', { class: 'timeline scroll' });
  const jump = h('button', { class: 'jump-pending hidden', onclick: () => scrollToPending() }, icon('shield', 15), 'Cần duyệt');
  const chips = h('div', { class: 'quick-bar' }); // chỗ của nút "Lệnh nhanh" (xem renderChips)
  const input = h('textarea', { class: 'composer-input', rows: 1, placeholder: 'Nhắn cho Claude…', enterkeyhint: 'send' });
  // Khối bóng để đo chiều cao chữ cần (autosize): cùng chữ, đệm, viền, bề rộng với ô soạn, nằm ngoài luồng,
  // không hiện. Là khối chữ thường chứ không phải ô nhập: ô nhập thấp hơn chữ thì scrollHeight bỏ phần đệm dưới.
  const sizer = h('div', { class: 'composer-input composer-sizer', 'aria-hidden': 'true' });
  const stopBtn = h('button', { class: 'round-btn stop hidden', 'aria-label': 'Dừng lượt đang chạy' }, icon('stop', 18));
  const sendBtn = h('button', { class: 'round-btn send', 'aria-label': 'Gửi' }, icon('send', 20));
  const fileInput = h('input', { type: 'file', multiple: true, class: 'hidden', onchange: () => addFiles(fileInput.files) });
  const attachRow = h('div', { class: 'attach-row hidden' });
  const modelChip = h('button', { class: 'pick-chip', onclick: () => pickModel() });
  const effortChip = h('button', { class: 'pick-chip', onclick: () => pickEffort() });
  const modeChip = h('button', { class: 'pick-chip', onclick: () => pickMode() });
  const micBtn = h('button', { class: 'tool-round', 'aria-label': 'Nói để nhập', onclick: () => toggleVoice() }, icon('mic', 19));
  const tools = h('div', { class: 'composer-tools' },
    h('button', { class: 'tool-round', 'aria-label': 'Đính kèm tệp', onclick: () => fileInput.click() }, icon('plus', 20)),
    h('div', { class: 'pick-row' }, modelChip, effortChip, modeChip),
    micBtn, stopBtn, sendBtn);
  const composerRow = h('div', { class: 'composer-box' }, attachRow, input, tools, fileInput, sizer);
  const stoppedRow = h('div', { class: 'stopped-row hidden' },
    h('span', null, 'Phiên đã dừng.'),
    h('button', { class: 'btn primary small', onclick: () => resume() }, icon('play', 14), 'Chạy lại'));
  const composer = h('footer', { class: 'composer' }, chips, composerRow, stoppedRow);
  // Gõ "@" đầu một từ: xổ bảng tag phiên (views/mention.js), bảng nổi ngay trên ô soạn.
  const mentions = attachMentions(input, { host: composer, selfId: id });

  const view = h('div', { class: `view session${floating ? ' floating' : ''}` },
    h('header', { class: 'topbar session-bar' },
      leading(),
      h('button', { class: 'title-wrap', onclick: () => openSessionMenu(id) }, title, subtitle),
      pill,
      // Phiên nổi nằm trên màn của máy: mở đầy đủ thì quay lại vẫn về màn máy đó.
      floating ? h('a', { class: 'icon-btn', href: `#/s/${id}/m/${session.machineId}`, 'aria-label': 'Mở phiên đầy đủ', title: 'Mở phiên đầy đủ' }, icon('external', 19)) : machineBtn,
      h('button', { class: 'icon-btn', 'aria-label': 'Tuỳ chọn', onclick: () => openSessionMenu(id) }, icon('more')),
      busyBar),
    timeline, jump, composer);
  root.append(view);

  const renderer = createRenderer({ sessionId: id });
  const permEls = new Map();
  let liveEl = null;

  // ---- Đầu trang và ô soạn theo trạng thái phiên ---------------------------------
  function renderHeader() {
    session = store.sessions.get(id) || session;
    const s = session;
    title.textContent = s.name;
    const mode = MODES.find((m) => m.id === s.permissionMode)?.label || s.permissionMode;
    // Remote Control đang bật (và chưa hỏng) trên phiên đang chạy: ghi ngay đầu trang để biết phiên này cũng đang mở
    // được từ claude.ai hay app Claude.
    const rc = ['starting', 'idle', 'busy', 'waiting'].includes(s.status) && s.remoteControl?.on && !s.remoteControl.error ? 'Remote Control' : '';
    subtitle.textContent = [workPlace(s), baseName(workDir(s)), mode, rc].filter(Boolean).join(' · ');
    pill.className = `pill status-${s.status}`;
    pill.textContent = STATUS_LABEL[s.status] || s.status;
    const machine = store.machines.get(s.machineId);
    // Mở từ màn máy thì nút máy chính là đường quay lại màn đó (không vòng phiên → máy → phiên); còn lại thì màn máy
    // quay lại đúng phiên này, giữ cả đường về nhóm.
    machineBtn.setAttribute('href', fromMachine ? `#/m/${s.machineId}` : `#/m/${s.machineId}/s/${id}${fromGroup ? `/g/${fromGroup}` : ''}`);
    machineBtn.setAttribute('aria-label', `Sang màn của máy ${machine?.name || s.machine || ''}`.trim());
    machineBtn.setAttribute('title', machine?.name || s.machine || 'Máy');
    machineDot.classList.toggle('on', Boolean(machine?.online));
    view.classList.toggle('is-busy', s.status === 'busy' || s.status === 'starting');
    const running = RUNNING.has(s.status);
    composerRow.classList.toggle('hidden', !running);
    chips.classList.toggle('hidden', !running || !chips.childElementCount);
    stoppedRow.classList.toggle('hidden', running);
    const busy = s.status === 'busy' || s.status === 'waiting';
    stopBtn.classList.toggle('hidden', !busy);
    renderPickers();
  }

  // ---- Model, effort, quyền ---------------------------------------------------------
  // Bản model thật phiên đang chạy (Claude Code báo trong từng lượt trả lời), ví dụ "Opus 5.5".
  const shortModel = (s) => sessionModel(s) || 'Model';
  function renderPickers() {
    const s = session;
    clear(modelChip);
    add(modelChip, icon('spark', 14), shortModel(s));
    clear(effortChip);
    add(effortChip, icon('gauge', 14), EFFORTS.find((e) => e.id === (s.effort || ''))?.short || s.effort);
    clear(modeChip);
    add(modeChip, icon('shield', 14), MODES.find((m) => m.id === s.permissionMode)?.label || s.permissionMode);
  }

  function pick(title, options, current, apply) {
    const { body, close } = openSheet(title);
    for (const o of options) {
      body.append(h('button', {
        class: `pick-option${o.id === current ? ' active' : ''}`,
        onclick: async () => {
          close();
          if (o.id === current) return;
          try {
            await apply(o.id);
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, h('span', { class: 'pick-label' }, o.label), o.hint ? h('span', { class: 'pick-hint' }, o.hint) : null,
      o.id === current ? icon('check', 18) : null));
    }
  }
  const pickModel = () => pick('Model', modelOptions(), session.model || '', (model) => api.post(`/api/sessions/${id}/model`, { model }));
  const pickEffort = () => pick('Effort', EFFORTS, session.effort || '', (effort) => api.post(`/api/sessions/${id}/effort`, { effort }));
  const pickMode = () => pick('Quyền', MODES, session.permissionMode, (mode) => api.post(`/api/sessions/${id}/mode`, { mode }));

  // ---- Tệp đính kèm --------------------------------------------------------------------
  // Tệp đính kèm chưa gửi của phiên này được giữ khi chuyển sang phiên hay màn khác (xem draftFiles).
  const attachments = draftFiles.get(id) || []; // { name, type, data, url }
  draftFiles.set(id, attachments);
  async function addFiles(list) {
    for (const file of [...list]) {
      if (attachments.length >= ATTACH_MAX) {
        toast(`Mỗi lượt đính kèm tối đa ${ATTACH_MAX} tệp.`, 'error');
        break;
      }
      if (file.size > FILE_MAX_BYTES) {
        toast(`${file.name} lớn quá ${FILE_MAX_BYTES / 1024 / 1024} MB.`, 'error');
        continue;
      }
      try {
        attachments.push(await readAttachment(file));
      } catch {
        toast(`Không đọc được ${file.name}.`, 'error');
      }
    }
    fileInput.value = '';
    renderAttachments();
  }

  function renderAttachments() {
    clear(attachRow);
    attachRow.classList.toggle('hidden', !attachments.length);
    attachments.forEach((a, i) => {
      attachRow.append(h('div', { class: 'attach-chip' },
        // Chạm vào ảnh hay tên để xem tệp trước khi gửi; nút x bên phải vẫn là bỏ tệp.
        h('button', { class: 'attach-open', type: 'button', title: `Xem ${a.name}`, onclick: () => previewDraft(a) },
          a.url ? h('img', { src: a.url, alt: '' }) : h('span', { class: 'attach-ico' }, icon(attachmentIcon(attachmentKind(a.name, a.type)), 16)),
          h('span', { class: 'attach-name' }, a.name)),
        h('button', { class: 'attach-x', 'aria-label': `Bỏ ${a.name}`, onclick: () => {
          if (a.url) URL.revokeObjectURL(a.url);
          attachments.splice(i, 1);
          renderAttachments();
        } }, icon('x', 13))));
    });
  }

  // Tệp chưa gửi chỉ có trong bộ nhớ của app: ảnh đã có địa chỉ blob: để xem trước, tệp khác dựng một
  // địa chỉ tạm từ dữ liệu base64 và thu hồi khi đóng khung xem.
  function previewDraft(a) {
    if (a.url) return openAttachment({ name: a.name, type: a.type, src: a.url });
    const bin = atob(a.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const src = URL.createObjectURL(new Blob([bytes], { type: a.type || 'application/octet-stream' }));
    return openAttachment({ name: a.name, type: a.type, src, bytes, onClose: () => setTimeout(() => URL.revokeObjectURL(src), 400) });
  }

  // ---- Giọng nói ----------------------------------------------------------------------
  let recognizer = null;
  function toggleVoice() {
    if (recognizer) {
      recognizer.stop();
      return;
    }
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) {
      toast('Trình duyệt này chưa cho nhận giọng nói. Chạm vào ô nhập rồi dùng nút micro trên bàn phím iPhone.');
      input.focus();
      return;
    }
    const base = input.value ? `${input.value.replace(/\s+$/, '')} ` : '';
    const rec = new Speech();
    rec.lang = 'vi-VN';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i += 1) text += e.results[i][0].transcript;
      input.value = base + text;
      autosize();
    };
    rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Không nhận được giọng nói (${e.error}).`, 'error'); };
    rec.onend = () => {
      recognizer = null;
      micBtn.classList.remove('listening');
    };
    recognizer = rec;
    micBtn.classList.add('listening');
    rec.start();
  }

  // ---- Lệnh nhanh -------------------------------------------------------------------------
  // Một nút trên ô soạn, chạm thì xổ danh sách cuộn được (hiện tối đa sáu dòng): Tiếp tục, Báo tiến
  // độ, các nút tự khai (custom/actions.json, extension.js), rồi mọi token trong bảng token
  // (custom/tokens.md). Nút tự khai trùng một token thì gộp vào dòng của token đó.
  let quickMenu = null;
  const quickBtn = h('button', { class: 'chip quick-btn', 'aria-haspopup': 'listbox', onclick: () => toggleQuick() },
    icon('bolt', 14), 'Lệnh nhanh', icon('down', 13));

  function quickItems() {
    const actions = actionsFor('session');
    const tokens = store.tokens || [];
    const tokenNames = new Set(tokens.map((t) => t.token));
    const leadingToken = (a) => /^\$\w+/.exec(String(a.send ?? a.fill ?? a.label ?? '').trim())?.[0];
    const first = QUICK_FIRST.map((q) => actions.find((a) => a.label === q.label) || q);
    // Lệnh của Orbit Remote, chạy thẳng qua trạm chứ không gửi cho Claude. Cả hai cắt phiên đang chạy
    // trên máy đó, nên luôn hỏi lại.
    const machineName = store.machines.get(session.machineId)?.name || session.machine || 'máy này';
    const system = [
      {
        label: 'Restart trạm',
        hint: 'Khởi động lại trạm Orbit Remote; phiên trên máy trạm bị cắt, mở lại được',
        confirm: 'Khởi động lại trạm? Mọi phiên đang chạy trên máy giữ trạm sẽ bị cắt (mở lại bằng nút mở lại phiên), app mất kết nối vài giây.',
        run: async () => {
          await api.post('/api/hub/restart');
          toast('Trạm đang khởi động lại, app tự nối lại sau vài giây.');
        },
      },
      {
        label: `Setup ${machineName}`,
        hint: 'Kéo code Orbit Remote mới, cài phần còn thiếu, chạy lại đầu máy; kết quả hiện ở màn của máy',
        confirm: `Setup máy ${machineName}? Máy sẽ kéo code Orbit Remote mới, cài những gì còn thiếu (trừ bước cần người ngồi tại máy) rồi chạy lại đầu máy: các phiên đang chạy trên máy đó sẽ bị cắt.`,
        run: async () => {
          await api.post(`/api/machines/${session.machineId}/update`);
          toast(`Đang setup máy ${machineName}. Kết quả hiện ở màn của máy.`);
        },
      },
    ];
    const custom = actions.filter((a) => !QUICK_FIRST.some((q) => q.label === a.label) && !tokenNames.has(leadingToken(a)));
    // Token cần thêm nội dung thì điền sẵn vào ô soạn để gõ tiếp; token chạy thẳng thì hỏi lại trước
    // khi gửi, vì nhiều token có hệ quả thật (commit, push, tắt máy).
    const fromTokens = tokens.map((t) => (t.arg
      ? { label: t.token, hint: `${t.hint} · thêm ${t.arg}`, fill: `${t.token} ` }
      : { label: t.token, hint: t.hint, send: t.token, confirm: `Gửi ${t.token}: ${t.hint}?` }));
    return [...first, ...system, ...custom, ...fromTokens];
  }

  function closeQuick() {
    if (!quickMenu) return;
    quickMenu.remove();
    quickMenu = null;
    quickBtn.classList.remove('open');
    document.removeEventListener('pointerdown', onOutsideQuick, true);
  }
  function onOutsideQuick(e) {
    if (!chips.contains(e.target)) closeQuick();
  }
  function toggleQuick() {
    if (quickMenu) return closeQuick();
    const items = quickItems();
    quickMenu = h('div', { class: 'quick-menu', role: 'listbox' },
      h('div', { class: 'quick-menu-title' }, 'Lệnh nhanh', h('span', { class: 'group-count' }, items.length)),
      h('div', { class: 'quick-list' }, items.map((a) => h('button', {
        class: 'pick-option quick-item', role: 'option',
        onclick: () => {
          closeQuick();
          runAction(a, { sessionId: id, fill });
        },
      }, h('span', { class: 'pick-label' }, a.label), h('span', { class: 'pick-hint' }, a.hint || a.send || a.fill || '')))),
      store.tokensError ? h('div', { class: 'quick-note' }, store.tokensError) : null);
    chips.append(quickMenu);
    quickBtn.classList.add('open');
    document.addEventListener('pointerdown', onOutsideQuick, true);
    return undefined;
  }

  function renderChips() {
    closeQuick();
    clear(chips);
    chips.append(quickBtn);
    renderHeader();
  }

  function fill(text) {
    input.value = text;
    autosize();
    input.focus();
    input.setSelectionRange(text.length, text.length);
  }

  // ---- Cuộn ---------------------------------------------------------------------
  const nearBottom = () => timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < NEAR_BOTTOM_PX;
  const toBottom = () => { timeline.scrollTop = timeline.scrollHeight; };
  function withScroll(fn) {
    const stick = nearBottom();
    fn();
    if (stick) toBottom();
    updateJump();
  }

  function scrollToPending() {
    const card = [...permEls.values()].find((el) => !el.classList.contains('done'));
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function updateJump() {
    const open = [...permEls.values()].filter((el) => !el.classList.contains('done'));
    if (!open.length) {
      jump.classList.add('hidden');
      return;
    }
    const box = timeline.getBoundingClientRect();
    const visible = open.some((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > box.top && r.top < box.bottom;
    });
    jump.classList.toggle('hidden', visible);
  }
  timeline.addEventListener('scroll', updateJump, { passive: true });

  // ---- Vẽ từng loại sự kiện --------------------------------------------------------
  // Phần không tương tác do bộ vẽ dùng chung lo; màn này chỉ giữ thẻ duyệt quyền.
  function permissionCard(ev, live) {
    const card = h('div', { class: 'perm-card' });
    const state = h('div', { class: 'perm-state' });
    const actions = h('div', { class: 'perm-actions' });
    const answer = async (behavior, extra = {}) => {
      for (const b of actions.querySelectorAll('button')) b.disabled = true;
      try {
        await api.post(`/api/sessions/${id}/permission`, { requestId: ev.requestId, behavior, ...extra });
      } catch (err) {
        toast(err.message, 'error');
        for (const b of actions.querySelectorAll('button')) b.disabled = false;
      }
    };

    if (ev.questions?.length) {
      // Câu hỏi nhiều lựa chọn của Claude: chọn rồi gửi, câu trả lời đi về đúng đường hỏi quyền.
      const picked = ev.questions.map(() => new Set());
      actions.classList.add('q-actions');
      add(card, h('div', { class: 'perm-head' }, icon('channel', 16), 'Claude hỏi bạn'));
      ev.questions.forEach((q, qi) => {
        const opts = h('div', { class: 'q-options' });
        for (const o of q.options || []) {
          const btn = h('button', {
            class: 'q-option',
            onclick: () => {
              if (q.multiSelect) {
                if (picked[qi].has(o.label)) picked[qi].delete(o.label); else picked[qi].add(o.label);
              } else {
                picked[qi].clear();
                picked[qi].add(o.label);
                for (const b of opts.children) b.classList.remove('active');
              }
              btn.classList.toggle('active', picked[qi].has(o.label));
            },
          }, h('span', { class: 'q-label' }, o.label), o.description ? h('span', { class: 'q-desc' }, o.description) : null);
          opts.append(btn);
        }
        add(card, h('div', { class: 'question' },
          q.header ? h('span', { class: 'tag' }, q.header) : null,
          h('div', { class: 'q-text' }, q.question), opts));
      });
      add(actions,
        h('button', { class: 'btn small ghost', onclick: () => answer('deny', { message: 'Người dùng bỏ qua câu hỏi.' }) }, 'Bỏ qua'),
        h('button', { class: 'btn small primary', onclick: () => {
          const answers = {};
          ev.questions.forEach((q, qi) => { if (picked[qi].size) answers[q.question] = [...picked[qi]].join(', '); });
          if (!Object.keys(answers).length) { toast('Chọn ít nhất một câu trả lời.'); return; }
          answer('allow', { answers });
        } }, 'Gửi trả lời'));
    } else {
      const details = h('details', { class: 'perm-details' }, h('summary', null, 'Xem đầy đủ tham số'), h('pre', null, ev.inputPreview || ''));
      add(card,
        h('div', { class: 'perm-head' }, icon('shield', 16), 'Claude muốn dùng ', h('b', null, ev.displayName || ev.tool)),
        ev.description && ev.description !== ev.summary ? h('div', { class: 'perm-desc' }, ev.description) : null,
        ev.summary ? h('pre', { class: 'perm-summary' }, ev.summary) : null,
        details);
      add(actions,
        h('button', { class: 'btn small danger-outline', onclick: () => {
          const reason = window.prompt('Lý do từ chối (Claude sẽ đọc được, có thể để trống):', '');
          if (reason === null) return;
          answer('deny', reason ? { message: reason } : {});
        } }, icon('x', 14), 'Từ chối'),
        ev.canAlways ? h('button', { class: 'btn small ghost', onclick: () => answer('allow', { always: true }) }, 'Luôn cho phép') : null,
        h('button', { class: 'btn small primary', onclick: () => answer('allow') }, icon('check', 14), 'Cho phép'));
    }
    // Thẻ trạm dựng lại cho yêu cầu còn treo khi thẻ gốc đã mất (hub.mjs restorePending): trả lời vẫn tới đúng phiên.
    if (ev.restored) add(card, h('div', { class: 'perm-restored' }, 'Yêu cầu này còn chờ từ trước (thẻ gốc không còn trong dòng hội thoại). Trả lời ở đây vẫn tới đúng phiên.'));
    add(card, actions, state);
    if (!live) markPerm(card, { behavior: 'expired', by: '' });
    permEls.set(ev.requestId, card);
    return card;
  }

  function markPerm(card, ev) {
    card.classList.add('done', `perm-${ev.behavior}`);
    const label = ev.behavior === 'allow' ? 'Đã cho phép' : ev.behavior === 'deny' ? 'Đã từ chối' : 'Đã hết hạn';
    card.querySelector('.perm-state').textContent = [label, ev.by].filter(Boolean).join(' · ');
  }

  function render(ev, live = true) {
    if (ev.t === 'permission') return permissionCard(ev, live);
    if (ev.t === 'permission_done') {
      const card = permEls.get(ev.requestId);
      if (card) markPerm(card, ev);
      return null;
    }
    return renderer.render(ev);
  }

  function placeLive() {
    const log = store.logs.get(id);
    const text = log?.live || '';
    if (!text) {
      liveEl?.remove();
      liveEl = null;
      return;
    }
    if (!liveEl) liveEl = h('div', { class: 'msg ai md live' });
    liveEl.innerHTML = renderMarkdown(text);
    if (timeline.lastChild !== liveEl) timeline.append(liveEl); // luôn nằm cuối dòng thời gian
  }

  function renderAllEvents() {
    const log = store.logs.get(id);
    clear(timeline);
    renderer.reset();
    permEls.clear();
    liveEl = null;
    if (!log) return;
    if (log.history.length) {
      const frag = document.createDocumentFragment();
      for (const ev of log.history) {
        const el = render(ev, false);
        if (el) frag.append(el);
      }
      timeline.append(frag, h('div', { class: 'history-divider' }, h('span', null, 'Lịch sử từ nhật ký')));
    }
    const frag = document.createDocumentFragment();
    for (const ev of log.events) {
      const el = render(ev, true);
      if (el) frag.append(el);
    }
    timeline.append(frag);
    if (!log.history.length && !log.events.length) {
      timeline.append(h('div', { class: 'empty small' }, RUNNING.has(session.status)
        ? 'Phiên đã sẵn sàng. Gửi việc đầu tiên ở ô bên dưới.'
        : 'Phiên này chưa có nội dung.'));
    }
    placeLive();
    toBottom();
    updateJump();
  }

  // ---- Gửi -----------------------------------------------------------------------
  // Ô soạn cao theo chữ, tối đa 160 px. Đo trên ô bóng `sizer` rồi chỉ đổi cao ô thật khi số dòng đổi. Cách
  // cũ đặt "auto" lên chính ô thật rồi đọc lại: mỗi phím bắt trình duyệt tính lại bố cục cả hội thoại phía
  // trên ba lần (đo trên Edge, phiên 2.100 phần tử: 12 ms mỗi lần, gõ trễ 36 ms mỗi ký tự).
  let shownHeight = 0;
  function autosize() {
    const width = input.offsetWidth;
    if (!width) return; // ô đang ẩn (phiên đã dừng): đo lúc hiện lại
    sizer.style.width = `${width}px`;
    sizer.textContent = `${input.value}\u200b`; // ký tự không bề rộng: dòng trống cuối (vừa Enter) vẫn được tính
    const want = Math.min(sizer.offsetHeight, 160);
    if (want === shownHeight) return;
    shownHeight = want;
    input.style.height = `${want}px`;
  }
  input.addEventListener('input', autosize);
  // Chữ đang gõ dở được giữ theo từng phiên: chuyển sang phiên khác, màn của máy, cài đặt rồi quay lại
  // vẫn còn nguyên, kể cả khi tải lại app (lưu trên máy này). Gửi xong thì xoá.
  input.value = loadDraft(id);
  input.addEventListener('input', () => saveDraft(id, input.value));
  renderAttachments(); // tệp đính kèm còn giữ từ lần trước
  requestAnimationFrame(autosize); // ô soạn cao theo chữ còn giữ, sau khi đã gắn vào trang
  // Máy tính (chuột, bàn phím thật): Enter là gửi, Ctrl + Enter (hay Shift + Enter) là xuống dòng.
  // Điện thoại và máy tính bảng: Enter vẫn là xuống dòng, gửi bằng nút (Ctrl + Enter có bàn phím rời
  // thì gửi). Đang gõ dở bằng bộ gõ có khung chữ (bộ gõ tiếng Việt của Windows, IME) thì Enter là của bộ
  // gõ, không gửi.
  // Nhận máy tính là "con trỏ chính không phải ngón tay": máy không cắm chuột (máy mini điều khiển từ
  // xa) báo không có con trỏ nào, chứ không báo con trỏ chuột, mà vẫn là máy tính có bàn phím thật.
  const touchFirst = window.matchMedia?.('(pointer: coarse)') || null;
  const desktop = () => !touchFirst?.matches;
  if (desktop()) input.placeholder = 'Nhắn cho Claude… (Enter gửi, Ctrl + Enter xuống dòng)';
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!desktop()) {
      if (mod) {
        e.preventDefault();
        send();
      }
      return;
    }
    if (e.shiftKey && !mod) return; // Shift + Enter: ô soạn tự xuống dòng
    e.preventDefault();
    if (mod) newline();
    else send();
  });
  // Ctrl + Enter không tự xuống dòng trong ô soạn: chèn bằng insertText để Ctrl + Z vẫn hoàn tác được.
  function newline() {
    if (!document.execCommand?.('insertText', false, '\n')) input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
    autosize();
  }

  // Dán tệp đã chép (ảnh chụp màn hình, tệp chép từ File Explorer, ảnh chép từ trang web) thành tệp
  // đính kèm, như chọn bằng nút +. Bộ nhớ tạm có chữ thì dán chữ như thường: chép ô Excel hay đoạn Word
  // có kèm cả một ảnh của chính đoạn đó, mà người dùng muốn dán chữ.
  input.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    const files = [...(data?.files || [])];
    if (!files.length || data.getData('text/plain')) return;
    e.preventDefault();
    addFiles(files.map(pastedName));
  });

  async function send() {
    const text = input.value.trim();
    if (!text && !attachments.length) return;
    recognizer?.stop();
    sendBtn.disabled = true;
    try {
      const tagged = mentions.mentionsFor(text); // phiên được tag (@Tên-phiên): trạm nói đích danh cho Claude
      await api.post(`/api/sessions/${id}/send`, {
        text,
        ...(tagged.length ? { mentions: tagged } : {}),
        ...(attachments.length ? { attachments: attachments.map(({ name, type, data }) => ({ name, type, data })) } : {}),
      });
      input.value = '';
      saveDraft(id, '');
      mentions.reset();
      for (const a of attachments) if (a.url) URL.revokeObjectURL(a.url);
      attachments.length = 0;
      renderAttachments();
      autosize();
      toBottom();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      sendBtn.disabled = false;
    }
  }
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', async () => {
    try {
      await api.post(`/api/sessions/${id}/interrupt`);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function resume() {
    try {
      await api.post(`/api/sessions/${id}/resume`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---- Nối với kho ------------------------------------------------------------------
  renderHeader();
  renderChips();
  timeline.append(h('div', { class: 'loading' }, 'Đang tải hội thoại…'));
  store.openLog(id).then(renderAllEvents).catch((err) => {
    clear(timeline).append(h('div', { class: 'empty small' }, err.message));
  });

  const offs = [
    store.on('event', ({ id: sid, ev }) => {
      if (sid !== id) return;
      withScroll(() => {
        const el = render(ev, true);
        if (el) {
          timeline.querySelector('.empty.small')?.remove();
          if (liveEl && liveEl.parentNode === timeline) timeline.insertBefore(el, liveEl);
          else timeline.append(el);
        }
        if (ev.t === 'text' || ev.t === 'result' || ev.t === 'error') placeLive();
      });
    }),
    store.on('delta', ({ id: sid }) => {
      if (sid === id) withScroll(placeLive);
    }),
    store.on('session', (s) => { if (s.id === id) renderHeader(); }),
    store.on('machine', (m) => { if (m.id === session.machineId) renderHeader(); }), // chấm nối trên nút máy
    store.on('session_removed', (sid) => {
      if (sid !== id) return;
      saveDraft(id, ''); // phiên bị xoá khỏi danh sách: bỏ luôn phần soạn dở của nó
      input.value = '';
      if (floating) opts.onClose();
      else location.hash = backGone() ? '#/' : backHref;
    }),
    store.on('log-loaded', (sid) => { if (sid === id) renderAllEvents(); }),
    store.on('actions', renderChips),
    store.on('tokens', renderChips),
  ];
  if (store.tokensError) store.loadTokens(); // thử lại mỗi lần mở một phiên: trạm có thể vừa khởi động lại

  return () => {
    offs.forEach((off) => off());
    closeQuick();
    mentions.destroy();
    store.closeLog(id);
    recognizer?.abort();
    saveDraft(id, input.value);
    // Tệp đính kèm chưa gửi ở lại draftFiles (kèm ảnh xem trước) cho lần mở phiên sau; trống thì bỏ.
    if (!attachments.length) draftFiles.delete(id);
  };
}

// ---- Nội dung đang soạn dở của từng phiên --------------------------------------------------
// Chữ: lưu trên máy này (localStorage) nên còn cả sau khi tải lại app. Tệp đính kèm: giữ trong bộ nhớ
// tới khi gửi, bỏ hay đóng app (nặng, không lưu xuống đĩa).
const DRAFT_PREFIX = 'orbit-draft-';
const draftFiles = new Map(); // mã phiên -> danh sách tệp đính kèm chưa gửi
function loadDraft(sid) {
  try {
    return localStorage.getItem(DRAFT_PREFIX + sid) || '';
  } catch {
    return '';
  }
}
function saveDraft(sid, text) {
  try {
    if (text) localStorage.setItem(DRAFT_PREFIX + sid, text);
    else localStorage.removeItem(DRAFT_PREFIX + sid);
  } catch {
    // trình duyệt chặn lưu: chỉ mất phần giữ chữ qua lần tải lại
  }
}

// Ảnh dán từ bộ nhớ tạm (ảnh chụp màn hình) luôn tên "image.png": đặt tên theo giờ dán để nhiều ảnh
// trong một lượt không trùng tên. Tệp chép từ File Explorer giữ nguyên tên.
let pasteCount = 0;
function pastedName(file) {
  if (!/^image\.\w+$/i.test(file.name || '') && file.name) return file;
  const t = new Date();
  const stamp = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
  pasteCount += 1;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return new File([file], `anh-dan-${stamp}-${pasteCount}.${ext}`, { type: file.type || 'image/png' });
}

// Ảnh lớn được thu nhỏ ngay trên điện thoại (cạnh dài tối đa 2000 px, JPEG) trước khi gửi: ảnh chụp
// 12 MP còn vài trăm KB, gửi nhanh hơn nhiều mà Claude vẫn đọc rõ. Tệp khác giữ nguyên.
async function readAttachment(file) {
  let blob = file;
  let type = file.type || 'application/octet-stream';
  let name = file.name || 'tep';
  if (/^image\/(png|jpeg|webp|heic|heif)$/.test(type)) {
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
      if (scale < 1 || /heic|heif/.test(type)) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
        type = 'image/jpeg';
        name = name.replace(/\.[^.]+$/, '') + '.jpg';
      }
      bitmap.close();
    } catch {
      // trình duyệt không giải được ảnh này: gửi nguyên tệp
    }
  }
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { name, type, data, url: type.startsWith('image/') ? URL.createObjectURL(blob) : null };
}
