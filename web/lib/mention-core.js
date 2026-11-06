// Phần thuần của việc tag phiên (@Tên-phiên) trong ô soạn: so chữ không dấu, đặt tag, gom danh sách theo máy, đọc
// các tag trong một tin. Không đụng giao diện, để kiểm được bằng node (tests/mention.test.mjs). Phần giao diện ở
// views/mention.js.

export const ACTIVE = new Set(['starting', 'idle', 'busy', 'waiting']);

// Không phân biệt hoa thường, có dấu hay không dấu: "Phiên Mới" khớp "phien moi", "PHIEN", "đ" khớp "d".
export function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

// Tag của một phiên: tên với dấu cách thành "-" (một tag là một từ liền). Trùng tên với phiên khác (không kể hoa
// thường, dấu) thì thêm "#" và 4 ký tự đầu của mã phiên, để tag luôn chỉ đúng một phiên.
export function tagOf(session, all = []) {
  const base = String(session.name || 'phien').trim().replace(/\s+/g, '-').replace(/@/g, '') || 'phien';
  const key = fold(session.name).trim();
  const dup = all.some((x) => x.id !== session.id && fold(x.name).trim() === key);
  return dup ? `${base}#${String(session.id).slice(0, 4)}` : base;
}

// Danh sách cho bảng tag: [{ machine: { id, name, online }, active: [phiên], inactive: [phiên] }]. Máy đang bật lên
// trước (rồi theo tên); trong mỗi máy phiên đang chạy (Active) trước phiên đã dừng (In-Active), mỗi nhóm phiên mới hoạt
// động gần nhất lên đầu. query lọc theo tên phiên (và tag), không phân biệt hoa thường, dấu. Bỏ phiên excludeId (chính
// phiên đang soạn) và máy không còn phiên nào khớp.
export function mentionGroups(sessions, machines, query = '', excludeId = '') {
  const q = fold(query).trim();
  const qDash = q.replace(/\s+/g, '-');
  const hit = (s) => !q || fold(s.name).includes(q) || fold(s.name).replace(/\s+/g, '-').includes(qDash);
  const byMachine = new Map();
  for (const s of sessions) {
    if (!s || s.id === excludeId || !hit(s)) continue;
    const key = s.machineId || '?';
    if (!byMachine.has(key)) byMachine.set(key, []);
    byMachine.get(key).push(s);
  }
  const recent = (a, b) => String(b.lastActivity || b.createdAt || '').localeCompare(String(a.lastActivity || a.createdAt || ''));
  const groups = [...byMachine.entries()].map(([id, list]) => {
    const m = machines.get?.(id) || machines.find?.((x) => x.id === id) || null;
    return {
      machine: { id, name: m?.name || list[0]?.machine || 'Máy khác', online: Boolean(m?.online) },
      active: list.filter((s) => ACTIVE.has(s.status)).sort(recent),
      inactive: list.filter((s) => !ACTIVE.has(s.status)).sort(recent),
    };
  });
  return groups.sort((a, b) => Number(b.machine.online) - Number(a.machine.online) || a.machine.name.localeCompare(b.machine.name, 'vi'));
}

// Các tag trong một tin: [{ tag, id }]. picked: tag → mã phiên đã chọn từ bảng (chính xác nhất). Tag gõ tay (hay còn
// trong bản nháp sau khi tải lại app) thì so với tag của mọi phiên, khớp đúng một phiên mới nhận. Bỏ dấu câu dính sau
// tag ("@Alpha," là tag "Alpha").
export function mentionsIn(text, sessions, picked = new Map()) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(/(^|\s)@([^\s@]+)/g)) {
    const raw = m[2];
    const tag = picked.has(raw) ? raw : raw.replace(/[.,;:!?)\]}'"…]+$/, '');
    if (!tag || seen.has(tag)) continue;
    let id = picked.get(tag) || '';
    if (!id) {
      const want = fold(tag);
      const same = sessions.filter((s) => fold(tagOf(s, sessions)) === want);
      if (same.length === 1) id = same[0].id;
    }
    if (!id) continue;
    seen.add(tag);
    out.push({ tag, id });
  }
  return out;
}

// "@" vừa gõ có đứng đầu một từ không (đầu tin hay sau dấu cách, xuống dòng): chỉ khi đó mới xổ bảng tag, để gõ
// email (a@b.com) không bị bật bảng.
export function atWordStart(value, at) {
  return value[at] === '@' && (at === 0 || /\s/.test(value[at - 1]));
}
