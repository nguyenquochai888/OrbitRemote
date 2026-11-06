// Tag phiên trong ô soạn: gõ "@" ở đầu một từ thì xổ bảng chọn phiên (mọi máy, đang chạy hay đã dừng). Trên cùng là ô
// tìm theo tên (không phân biệt hoa thường, dấu); dưới là từng máy (máy đang bật trước), trong mỗi máy hai nhãn Active
// và In-Active. Chọn một phiên thì "@" thành "@Tên-phiên " trong ô soạn, và bảng nhớ tag đó trỏ đúng phiên nào; gửi tin
// thì app gửi kèm danh sách tag để trạm và đầu máy nói đích danh cho Claude (hub.mjs resolveMentions).
//
// Máy và nhãn Active, In-Active thu gọn hay xổ ra được (chạm vào dòng đầu), nhớ cho lần mở sau (localStorage). Lúc
// đang tìm thì mọi tầng có phiên khớp đều xổ ra, để không có kết quả nào bị giấu; gập lúc tìm chỉ có tác dụng tới khi
// xoá chữ tìm hay đóng bảng.
//
// Phím: mũi tên lên xuống chọn (bỏ qua phiên trong tầng đang thu gọn), Enter lấy, Esc đóng (giữ "@" đã gõ). Chạm
// ngoài bảng cũng đóng.

import { h, clear, baseName, workDir } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { store } from '../lib/store.js';
import { mentionGroups, mentionsIn, tagOf, atWordStart } from '../lib/mention-core.js';

const STATUS = { starting: 'Đang mở', idle: 'Sẵn sàng', busy: 'Đang chạy', waiting: 'Chờ duyệt', stopped: 'Đã dừng', crashed: 'Hỏng' };

// ---- Tầng thu gọn, nhớ cho lần mở sau --------------------------------------------------------------------------
// Khoá: "m:<máy>" (cả máy), "a:<máy>" (nhãn Active), "i:<máy>" (nhãn In-Active). Chỉ lưu khoá đang thu gọn.
const STORE_KEY = 'orbit-mention-collapsed';
const KEYS_MAX = 200;
const FOLD_MS = 400; // thời gian co giãn (styles.css .fold-body) cộng dư, cho khi không có transitionend
let savedShut = null;

function saved() {
  if (!savedShut) {
    try {
      const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      savedShut = new Set(Array.isArray(list) ? list.map(String) : []);
    } catch {
      savedShut = new Set();
    }
  }
  return savedShut;
}

function saveShut(key, shut) {
  const set = saved();
  set.delete(key); // thêm lại ở cuối để phần cắt bỏ dưới đây bỏ khoá lâu không đụng tới
  if (shut) set.add(key);
  const keys = [...set];
  if (keys.length > KEYS_MAX) savedShut = new Set(keys.slice(-KEYS_MAX));
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...savedShut]));
  } catch {
    // trình duyệt chặn lưu: chỉ mất phần nhớ cho lần mở sau
  }
}

// input: ô soạn (textarea); host: khung chứa bảng (đáy bảng bám mép trên của host); selfId: phiên đang soạn (không
// hiện trong danh sách).
export function attachMentions(input, { host, selfId = '' }) {
  const picked = new Map(); // tag → mã phiên, chọn từ bảng
  let menu = null;
  let search = null;
  let at = -1; // vị trí "@" trong ô soạn
  let items = []; // mọi nút phiên đã vẽ, theo thứ tự trên xuống (kể cả nút trong tầng đang thu gọn)
  let current = null; // nút phiên đang được chọn bằng phím
  let searchShut = new Set(); // tầng gập trong lúc đang tìm (không lưu)

  const sessions = () => [...store.sessions.values()];
  const searching = () => Boolean(search?.value.trim());
  const isShut = (key) => (searching() ? searchShut.has(key) : saved().has(key));
  const shown = () => items.filter((el) => !el.closest('.mention-fold.shut'));

  function close(refocus = false) {
    if (!menu) return;
    menu.remove();
    menu = null;
    search = null;
    items = [];
    current = null;
    searchShut = new Set();
    document.removeEventListener('pointerdown', onOutside, true);
    if (refocus) {
      input.focus();
      input.setSelectionRange(at + 1, at + 1);
    }
  }
  function onOutside(e) {
    if (menu && !menu.contains(e.target) && e.target !== input) close();
  }

  function choose(s) {
    const all = sessions();
    const tag = tagOf(s, all);
    picked.set(tag, s.id);
    const v = input.value;
    const insert = `@${tag} `;
    input.value = v.slice(0, at) + insert + v.slice(at + 1);
    close();
    const caret = at + insert.length;
    input.focus();
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true })); // ô soạn tự giãn, bản nháp được lưu
  }

  function highlight(el, scroll = true) {
    current?.classList.remove('active');
    current = el || null;
    if (!current) return;
    current.classList.add('active');
    if (scroll) current.scrollIntoView({ block: 'nearest' });
  }

  function step(delta) {
    const list = shown();
    if (!list.length) return highlight(null);
    const i = list.indexOf(current);
    highlight(list[i < 0 ? 0 : (i + delta + list.length) % list.length]);
  }

  // Một tầng gập được: dòng đầu là nút (chạm vào đâu trên dòng cũng gập), thân co giãn bằng grid-template-rows như
  // cây ở màn chính (views/tree.js). Gập thì đổi tại chỗ, không vẽ lại bảng.
  function foldBlock(key, cls, headParts, body) {
    let shut = isShut(key);
    const head = h('button', {
      type: 'button',
      class: `mention-fold-head ${cls}`,
      'aria-expanded': String(!shut),
      // Giữ con trỏ ở ô tìm để mũi tên, Enter vẫn chạy sau khi gập.
      onmousedown: (e) => e.preventDefault(),
    }, headParts, h('span', { class: 'mention-fold-ico' }, icon('down', 14)));
    const bodyEl = h('div', { class: 'fold-body' }, h('div', { class: 'fold-inner' }, body));
    const node = h('div', { class: `fold mention-fold${shut ? ' shut' : ''}` }, head, bodyEl);
    let settle = 0;
    const still = () => {
      clearTimeout(settle);
      node.classList.remove('moving');
    };
    bodyEl.addEventListener('transitionend', (e) => {
      if (e.target === bodyEl) still();
    });
    head.addEventListener('click', () => {
      shut = !shut;
      node.classList.add('moving'); // đang co giãn: phần thân vẫn hiện để trượt, hết co giãn thì ẩn hẳn
      node.classList.toggle('shut', shut);
      head.setAttribute('aria-expanded', String(!shut));
      if (searching()) {
        if (shut) searchShut.add(key);
        else searchShut.delete(key);
      } else {
        saveShut(key, shut);
      }
      clearTimeout(settle);
      settle = setTimeout(still, FOLD_MS);
      // Phiên đang chọn bị gập mất (hay chưa chọn phiên nào): chọn phiên đầu tiên còn hiện.
      if (!current || current.closest('.mention-fold.shut')) highlight(shown()[0], false);
    });
    return node;
  }

  function paint(list) {
    clear(list);
    const query = search?.value || '';
    const groups = mentionGroups(sessions(), store.machines, query, selfId);
    items = [];
    current = null;
    const all = sessions();
    const row = (s) => {
      const btn = h('button', {
        type: 'button',
        class: `pick-option mention-item status-${s.status}`,
        role: 'option',
        onclick: () => choose(s),
      },
      h('span', { class: 'mention-name' }, h('span', { class: 'status-dot' }), s.name),
      h('span', { class: 'pick-hint' }, [`@${tagOf(s, all)}`, store.groupOf?.(s.id)?.name, baseName(workDir(s)), STATUS[s.status] || s.status].filter(Boolean).join(' · ')));
      items.push(btn);
      return btn;
    };
    const sub = (key, label, sessionsOfLabel) => foldBlock(key, 'mention-sub',
      [h('span', { class: 'mention-sub-label' }, label), h('span', { class: 'mention-sub-count' }, String(sessionsOfLabel.length))],
      sessionsOfLabel.map(row));
    for (const g of groups) {
      const id = g.machine.id;
      list.append(foldBlock(`m:${id}`, 'mention-machine', [
        h('span', { class: `mini-dot${g.machine.online ? ' on' : ''}` }),
        h('span', { class: 'mention-machine-name' }, g.machine.name),
        h('span', { class: 'group-count' }, String(g.active.length + g.inactive.length)),
      ], [
        g.active.length ? sub(`a:${id}`, 'Active', g.active) : null,
        g.inactive.length ? sub(`i:${id}`, 'In-Active', g.inactive) : null,
      ]));
    }
    if (!items.length) list.append(h('div', { class: 'mention-empty' }, query ? 'Không có phiên nào khớp.' : 'Chưa có phiên nào khác.'));
    highlight(shown()[0], false);
  }

  function open(pos) {
    close();
    at = pos;
    const list = h('div', { class: 'mention-list', role: 'listbox' });
    search = h('input', {
      class: 'input mention-search',
      type: 'search',
      placeholder: 'Tìm phiên theo tên (không cần dấu)',
      'aria-label': 'Tìm phiên để tag',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      autocomplete: 'off',
      oninput: () => {
        if (!searching()) searchShut = new Set(); // xoá chữ tìm: về lại các tầng đã nhớ
        paint(list);
      },
      onkeydown: (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          step(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          step(-1);
        } else if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          if (current && !current.closest('.mention-fold.shut')) current.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close(true);
        }
      },
    });
    menu = h('div', { class: 'mention-menu', role: 'dialog', 'aria-label': 'Tag phiên' },
      h('div', { class: 'quick-menu-title' }, 'Tag phiên', h('span', { class: 'mention-tip' }, 'chỉ đích danh một phiên')),
      search, list);
    paint(list);
    host.append(menu);
    document.addEventListener('pointerdown', onOutside, true);
    search.focus();
  }

  const onInput = (e) => {
    if (e.inputType && !/^insert/.test(e.inputType)) return;
    const caret = input.selectionStart;
    if (caret > 0 && atWordStart(input.value, caret - 1) && (e.data === '@' || input.value[caret - 1] === '@') && input.selectionEnd === caret) open(caret - 1);
  };
  input.addEventListener('input', onInput);

  return {
    // Các tag trong tin sắp gửi: [{ tag, id }].
    mentionsFor: (text) => mentionsIn(text, sessions(), picked),
    reset: () => picked.clear(),
    close: () => close(),
    destroy: () => {
      close();
      input.removeEventListener('input', onInput);
    },
  };
}
