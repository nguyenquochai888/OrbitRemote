// Phần thuần của việc tag phiên (web/lib/mention-core.js): so chữ không dấu, đặt tag, gom danh sách theo máy, đọc tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const m = await import('../web/lib/mention-core.js');

const machines = new Map([
  ['mOff', { id: 'mOff', name: 'Máy Văn Phòng', online: false }],
  ['mOn', { id: 'mOn', name: 'Máy Ở Nhà', online: true }],
]);
const S = (id, name, machineId, status, lastActivity) => ({ id, name, machineId, status, lastActivity, machine: machines.get(machineId)?.name });
const sessions = [
  S('a1111111', 'Animation Star Harbor', 'mOff', 'busy', '2026-11-05T01:00:00Z'),
  S('b2222222', 'QA Star Harbor', 'mOff', 'stopped', '2026-11-04T01:00:00Z'),
  S('c3333333', 'Phiên mới', 'mOn', 'idle', '2026-11-05T02:00:00Z'),
  S('d4444444', 'Đồ hoạ Trò chơi', 'mOn', 'stopped', '2026-11-05T03:00:00Z'),
  S('e5555555', 'Phiên Mới', 'mOff', 'waiting', '2026-11-05T00:00:00Z'),
  S('f6666666', 'Tool Image', 'mOn', 'crashed', '2026-11-01T00:00:00Z'),
];

test('so chữ không phân biệt hoa thường, dấu', () => {
  assert.equal(m.fold('Phiên Mới Đồ'), 'phien moi do');
  assert.equal(m.fold('ĐỒ HOẠ'), 'do hoa');
});

test('tag: dấu cách thành "-", trùng tên (kể cả khác hoa thường) thì thêm 4 ký tự mã', () => {
  assert.equal(m.tagOf(sessions[0], sessions), 'Animation-Star-Harbor');
  assert.equal(m.tagOf(sessions[2], sessions), 'Phiên-mới#c333');
  assert.equal(m.tagOf(sessions[4], sessions), 'Phiên-Mới#e555');
  assert.equal(m.tagOf({ id: 'x', name: '  a@b  c ' }, []), 'ab-c');
});

test('danh sách: máy đang bật trước, trong máy Active trước In-Active, phiên mới hoạt động lên đầu; bỏ chính phiên đang soạn', () => {
  const g = m.mentionGroups(sessions, machines, '', 'c3333333');
  assert.deepEqual(g.map((x) => x.machine.name), ['Máy Ở Nhà', 'Máy Văn Phòng']);
  assert.deepEqual(g[0].active.map((s) => s.id), [], 'phiên đang soạn không có trong danh sách');
  assert.deepEqual(g[0].inactive.map((s) => s.id), ['d4444444', 'f6666666'], 'In-Active: mới hoạt động trước');
  assert.deepEqual(g[1].active.map((s) => s.id), ['a1111111', 'e5555555']);
  assert.deepEqual(g[1].inactive.map((s) => s.id), ['b2222222']);
});

test('tìm theo tên không phân biệt hoa thường, dấu; máy không còn phiên khớp thì bỏ', () => {
  const g = m.mentionGroups(sessions, machines, 'PHIEN moi');
  assert.deepEqual(g.map((x) => x.machine.name), ['Máy Ở Nhà', 'Máy Văn Phòng']);
  assert.deepEqual(g.flatMap((x) => [...x.active, ...x.inactive]).map((s) => s.id).sort(), ['c3333333', 'e5555555']);
  assert.deepEqual(m.mentionGroups(sessions, machines, 'do hoa').flatMap((x) => [...x.active, ...x.inactive]).map((s) => s.id), ['d4444444']);
  assert.deepEqual(m.mentionGroups(sessions, machines, 'star-harbor').flatMap((x) => [...x.active, ...x.inactive]).map((s) => s.id), ['a1111111', 'b2222222'], 'gõ kiểu tag cũng khớp');
  assert.deepEqual(m.mentionGroups(sessions, machines, 'không có'), []);
});

test('đọc tag trong tin: tag đã chọn đúng phiên; tag gõ tay khớp đúng một phiên mới nhận; bỏ dấu câu dính sau; email không phải tag', () => {
  const picked = new Map([['Phiên-mới#c333', 'c3333333']]);
  const text = 'Nhờ @Animation-Star-Harbor, kiểm @Phiên-mới#c333 và @tool-image. Gửi a@b.com, @khong-co @Animation-Star-Harbor';
  assert.deepEqual(m.mentionsIn(text, sessions, picked), [
    { tag: 'Animation-Star-Harbor', id: 'a1111111' },
    { tag: 'Phiên-mới#c333', id: 'c3333333' },
    { tag: 'tool-image', id: 'f6666666' },
  ]);
  assert.deepEqual(m.mentionsIn('@Phiên-mới', sessions), [], 'tên trùng mà gõ tay không kèm mã: không đoán');
});

test('"@" chỉ mở bảng khi đứng đầu một từ', () => {
  assert.equal(m.atWordStart('@', 0), true);
  assert.equal(m.atWordStart('xin @', 4), true);
  assert.equal(m.atWordStart('dòng\n@', 5), true);
  assert.equal(m.atWordStart('a@', 1), false);
});
