// Kiểm đầu-cuối Orbit Remote trên bản Claude giả: không tốn token, không đụng trạng thái thật.
//
//   1. Lớp phiên: chat, hỏi quyền (cho phép / từ chối), đổi chế độ, cắt ngang, đóng.
//   2. Trạm qua HTTP thật: ghép đôi, chặn yêu cầu không có thẻ, mở phiên, luồng SSE.
//   3. Hai máy: đầu máy thứ hai nối qua mạng, phiên ở máy này nhắn cho phiên ở máy kia
//      bằng đúng vỏ MCP mà phiên thật dùng.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'orbit-remote-test-'));
let hubRestarts = 0; // số lần trạm thử được bảo khởi động lại (lệnh nhanh Restart trạm)
process.env.ORBIT_REMOTE_STATE = join(ROOT, 'state');
process.env.ORBIT_REMOTE_PROJECTS = join(ROOT, 'projects');
process.env.ORBIT_MODELS_FILE = join(ROOT, 'no-models.json'); // bản model ghi sẵn trong repo, không đọc bảng của máy thật
mkdirSync(process.env.ORBIT_REMOTE_PROJECTS, { recursive: true });
// Thư mục custom/ tạm: bảng token thử (vai trò nhóm, Lệnh nhanh) thay cho bảng trống của repo, không đụng custom/ thật.
process.env.ORBIT_REMOTE_CUSTOM = join(ROOT, 'custom');
mkdirSync(join(ROOT, 'custom', 'tokens'), { recursive: true });
writeFileSync(join(ROOT, 'custom', 'tokens.md'), [
  '| Token | Việc làm | Đặc tả |',
  '|---|---|---|',
  '| `$gd [yêu cầu]` | Thiết kế lối chơi. | `tokens/gd.md` |',
  '| `$code [yêu cầu]` | Viết và sửa mã nguồn. | `tokens/code.md` |',
  '| `$env [yêu cầu]` | Dựng cảnh. | `tokens/env.md` |',
  '| `$qa [yêu cầu]` | Kiểm chất lượng. | `tokens/qa.md` |',
  '| `$c` | Chỉ commit. | `tokens/c.md` |',
  '',
].join('\n'));
for (const [name, title] of [['gd', 'thiết kế lối chơi'], ['code', 'viết và sửa mã nguồn'], ['env', 'dựng cảnh'], ['qa', 'kiểm chất lượng'], ['c', 'chỉ commit']]) {
  writeFileSync(join(ROOT, 'custom', 'tokens', `${name}.md`), `# \`$${name}\` — ${title}\n\nĐặc tả thử.\n`);
}
// Vỏ dòng lệnh Orbit Unity MCP giả cho orbit_machine_unity: in tham số rồi thoát 0.
process.env.ORBIT_UNITY_MCP_CLI = join(ROOT, 'fake-unity-cli.mjs');
writeFileSync(process.env.ORBIT_UNITY_MCP_CLI, "process.stdout.write(`cli ${process.argv.slice(2).join(' ')}\\n`);\n");
const WORK = join(ROOT, 'work');
mkdirSync(WORK, { recursive: true });

const FAKE = [process.execPath, join(HERE, 'fake-claude.mjs')];
const RUNNING_SET = new Set(['starting', 'idle', 'busy', 'waiting']);
const pipeName = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\orbit-remote-test-${randomBytes(4).toString('hex')}`
  : join(ROOT, `p-${randomBytes(4).toString('hex')}.sock`));

const { ClaudeSession } = await import('../src/claude-session.mjs');
const { Hub } = await import('../src/hub.mjs');
const { Auth } = await import('../src/auth.mjs');
const { NodeAgent } = await import('../src/node-agent.mjs');
const { createServer } = await import('../src/server.mjs');
const { runNodeLoop } = await import('../src/node-runner.mjs');
const { startDiscoveryResponder, discoverHubs } = await import('../src/discovery.mjs');
const { writeJsonAtomic, readJson } = await import('../src/paths.mjs');
const { toLine, lineSplitter } = await import('../src/lines.mjs');

async function waitFor(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Hết giờ chờ: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('lớp phiên: chat, hỏi quyền, đổi chế độ, cắt ngang, đóng', async () => {
  const s = new ClaudeSession({ cwd: WORK, claudeCommand: FAKE, name: 't1' });
  const events = [];
  let deltas = '';
  s.on('event', (e) => events.push(e));
  s.on('delta', (d) => { deltas += d; });
  s.start();
  await waitFor(() => s.status === 'idle', 'phiên sẵn sàng');

  s.send('xin chào');
  await waitFor(() => events.some((e) => e.t === 'result'), 'kết quả lượt 1');
  assert.equal(deltas, 'echo: xin chào');
  assert.ok(events.some((e) => e.t === 'text' && e.text === 'echo: xin chào'));
  assert.equal(s.status, 'idle');
  assert.equal(s.costUsd, 0.01);

  s.send('WRITE lần một');
  const ask1 = await waitFor(() => events.find((e) => e.t === 'permission'), 'yêu cầu quyền 1');
  assert.equal(s.status, 'waiting');
  assert.equal(ask1.tool, 'Write');
  assert.equal(ask1.canAlways, true);
  assert.ok(s.answerPermission(ask1.requestId, { behavior: 'allow' }));
  await waitFor(() => events.some((e) => e.t === 'text' && e.text === 'done: allowed'), 'cho phép có hiệu lực');

  s.send('WRITE lần hai');
  const ask2 = await waitFor(() => events.filter((e) => e.t === 'permission')[1], 'yêu cầu quyền 2');
  s.answerPermission(ask2.requestId, { behavior: 'deny', message: 'không' });
  await waitFor(() => events.some((e) => e.t === 'tool_result' && !e.ok && e.preview === 'không'), 'lời từ chối tới tay mô hình');

  await s.setPermissionMode('bypassPermissions');
  assert.equal(s.permissionMode, 'bypassPermissions');
  const before = events.filter((e) => e.t === 'permission').length;
  s.send('WRITE lần ba');
  await waitFor(() => events.filter((e) => e.t === 'text' && e.text === 'done: allowed').length === 2, 'bypass không hỏi');
  assert.equal(events.filter((e) => e.t === 'permission').length, before);

  s.send('SLEEP');
  await waitFor(() => s.status === 'busy', 'đang bận');
  assert.equal(await s.interrupt(), true);
  await waitFor(() => events.some((e) => e.t === 'result' && e.cancelled), 'lượt bị cắt được đánh dấu là huỷ, không phải lỗi');

  s.close();
  await waitFor(() => s.status === 'stopped', 'đóng sạch');
});

let server;
let port;
let hub;
let auth;
let agentA;
let agentB;
let nodeAbort;
const NODE_STATE = join(ROOT, 'node-b.json');
let cookie;
const sse = [];
let sseAbort;

async function call(path, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Cookie: cookie || '', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, res };
}

before(async () => {
  auth = new Auth(join(process.env.ORBIT_REMOTE_STATE, 'auth.json'));
  hub = new Hub();
  server = createServer({ hub, auth, localSecret: 'test-secret', version: 'test', hubInfo: () => ({ id: 'hubX', name: 'TramThu', urls: [] }), onRestart: () => { hubRestarts += 1; return 'restart.log'; } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  agentA = new NodeAgent({ machineId: 'mA', machineName: 'MayA', claudeCommand: FAKE, pipePath: pipeName() });
  await agentA.startPipe();
  const conn = hub.attachMachine({ send: (m) => queueMicrotask(() => agentA.handle(m)) }, { local: true });
  agentA.attach((m) => queueMicrotask(() => conn.receive(m)));
});

after(async () => {
  sseAbort?.abort();
  nodeAbort?.abort();
  agentA?.shutdown();
  agentB?.shutdown();
  server?.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

test('trạm: chặn khi chưa ghép đôi, ghép đôi, mở phiên, luồng SSE', async () => {
  assert.equal((await call('/api/state')).status, 401, 'chưa có thẻ thì không vào được');

  const local = await fetch(`http://127.0.0.1:${port}/api/local/pair-code`, {
    method: 'POST', headers: { 'X-Orbit-Local': 'sai', 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(local.status, 403, 'sai bí mật cục bộ thì không lấy được mã');

  const code = auth.newPairCode();
  const wrong = await call('/api/pair', { code: code === '000000' ? '111111' : '000000', name: 'x' });
  assert.equal(wrong.status, 403);
  const paired = await call('/api/pair', { code, name: 'iPhone' });
  assert.equal(paired.status, 200);
  cookie = paired.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/pair', { code, name: 'lần hai' })).status, 403, 'mã chỉ dùng một lần');

  const noJson = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}',
  });
  assert.equal(noJson.status, 415, 'POST không phải JSON bị từ chối (chống giả mạo yêu cầu)');

  sseAbort = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: { Cookie: cookie }, signal: sseAbort.signal });
  (async () => {
    const reader = stream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (type && data) sse.push({ type, data: JSON.parse(data) });
        }
      }
    } catch {
      // bị huỷ khi kết thúc phép kiểm
    }
  })();
  await waitFor(() => sse.some((e) => e.type === 'state'), 'SSE gửi trạng thái đầu');

  const created = await call('/api/sessions', { machineId: 'mA', name: 'Alpha', cwd: WORK, prompt: 'hello' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  await waitFor(() => sse.some((e) => e.type === 'event' && e.data.id === id && e.data.ev.t === 'result'), 'lượt đầu chạy xong');
  assert.ok(sse.some((e) => e.type === 'delta' && e.data.id === id), 'mẩu chữ chảy tới app');

  const history = await call(`/api/sessions/${id}/events`);
  const kinds = history.data.events.map((e) => e.t);
  assert.deepEqual(kinds.slice(0, 2), ['user', 'text']);
  assert.ok(history.data.events.every((e, i, a) => i === 0 || e.seq > a[i - 1].seq), 'số thứ tự tăng dần');

  await call(`/api/sessions/${id}/send`, { text: 'WRITE' });
  const ask = await waitFor(() => sse.find((e) => e.type === 'event' && e.data.id === id && e.data.ev.t === 'permission'), 'yêu cầu quyền tới app');
  const ans = await call(`/api/sessions/${id}/permission`, { requestId: ask.data.ev.requestId, behavior: 'allow' });
  assert.equal(ans.data.ok, true);
  await waitFor(() => sse.some((e) => e.type === 'event' && e.data.id === id && e.data.ev.t === 'permission_done'), 'đã trả lời quyền');

  assert.equal((await call(`/api/sessions/${id}/mode`, { mode: 'acceptEdits' })).status, 200);
  await waitFor(() => hub.sessions.get(id).snap.permissionMode === 'acceptEdits', 'chế độ quyền cập nhật trên trạm');

  await call(`/api/sessions/${id}/close`, {});
  await waitFor(() => hub.sessions.get(id).snap.status === 'stopped', 'phiên dừng');
  const resumed = await call(`/api/sessions/${id}/resume`, {});
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  await waitFor(() => hub.sessions.get(id).snap.status === 'idle', 'phiên chạy lại');
  assert.equal(hub.sessions.get(id).snap.claudeSessionId, created.data.claudeSessionId, 'nối lại đúng phiên Claude cũ');
});

test('yêu cầu duyệt còn treo mà thẻ duyệt đã mất (trạm khởi động lại): trạm dựng lại thẻ, duyệt được, phiên chạy tiếp', async () => {
  const created = await call('/api/sessions', { machineId: 'mA', cwd: WORK, name: 'Treo duyệt', permissionMode: 'manual' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  await waitFor(() => hub.sessions.get(id)?.snap.status === 'idle', 'phiên sẵn sàng');
  await call(`/api/sessions/${id}/send`, { text: 'WRITE' });
  const r = hub.sessions.get(id);
  const original = await waitFor(() => r.buffer.find((e) => e.t === 'permission'), 'phiên xin quyền');
  await waitFor(() => r.snap.status === 'waiting' && r.snap.pending?.length === 1, 'phiên chờ duyệt');
  // Trạng thái phiên mang đủ chi tiết để dựng lại thẻ (đầu máy bản mới).
  assert.equal(r.snap.pending[0].displayName, original.displayName);
  assert.equal(r.snap.pending[0].inputPreview, original.inputPreview);

  // Trạm khởi động lại: bộ đệm sự kiện mất, đầu máy nối lại báo trạng thái còn chờ duyệt.
  r.buffer = [];
  hub.upsertSession(hub.machines.get('mA'), { ...r.snap });
  const restored = await waitFor(() => r.buffer.find((e) => e.t === 'permission' && e.restored), 'trạm dựng lại thẻ duyệt', 5000);
  assert.equal(restored.requestId, original.requestId);
  assert.equal(restored.displayName, original.displayName, 'thẻ dựng lại đủ chi tiết như thẻ gốc');
  assert.equal(restored.inputPreview, original.inputPreview);
  hub.upsertSession(hub.machines.get('mA'), { ...r.snap });
  await new Promise((done) => setTimeout(done, 1800));
  assert.equal(r.buffer.filter((e) => e.t === 'permission').length, 1, 'không dựng thẻ trùng');

  // Duyệt trên thẻ dựng lại: phiên chạy tiếp và hết chờ.
  const ans = await call(`/api/sessions/${id}/permission`, { requestId: restored.requestId, behavior: 'allow' });
  assert.equal(ans.data.ok, true, JSON.stringify(ans.data));
  await waitFor(() => r.buffer.some((e) => e.t === 'permission_done' && e.requestId === restored.requestId), 'đã trả lời');
  await waitFor(() => r.snap.status === 'idle' && !r.snap.pending?.length, 'phiên hết chờ duyệt, chạy tiếp');

  // Đầu máy bản cũ chỉ báo công cụ và tóm tắt: vẫn dựng được thẻ tối thiểu để bấm duyệt.
  r.buffer = [];
  hub.upsertSession(hub.machines.get('mA'), { ...r.snap, status: 'waiting', pending: [{ requestId: 'cu-1', tool: 'Bash', summary: 'cd D:/Game && python x.py' }] });
  const minimal = await waitFor(() => r.buffer.find((e) => e.t === 'permission' && e.requestId === 'cu-1'), 'thẻ tối thiểu', 5000);
  assert.equal(minimal.displayName, 'Bash');
  assert.equal(minimal.summary, 'cd D:/Game && python x.py');
  assert.equal(minimal.restored, true);
  await call(`/api/sessions/${id}/close`, {});
  await waitFor(() => r.snap.status === 'stopped', 'phiên dừng');
});

test('tag phiên (@Tên-phiên) trong tin: trạm kiểm phiên có thật, Claude nhận đích danh phiên được tag, app hiện tin như gõ', async () => {
  const target = await call('/api/sessions', { machineId: 'mA', cwd: WORK, name: 'Đích Tag' });
  const sender = await call('/api/sessions', { machineId: 'mA', cwd: WORK, name: 'Người Gửi' });
  const tid = target.data.id;
  const id = sender.data.id;
  await waitFor(() => hub.sessions.get(id)?.snap.status === 'idle' && hub.sessions.get(tid)?.snap.status === 'idle', 'hai phiên sẵn sàng');
  await call(`/api/sessions/${tid}/close`, {}); // phiên được tag đã dừng vẫn tag được
  await waitFor(() => hub.sessions.get(tid).snap.status === 'stopped', 'phiên đích dừng');
  const text = 'Nhờ kiểm @Đích-Tag, và @khong-co nữa';
  const sent = await call(`/api/sessions/${id}/send`, {
    text,
    mentions: [{ tag: 'Đích-Tag', id: tid }, { tag: 'khong-co', id: 'khong-co-ma' }, { tag: 'Khác', id: tid }],
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const r = hub.sessions.get(id);
  const user = await waitFor(() => r.buffer.find((e) => e.t === 'user' && e.text === text), 'tin người dùng');
  assert.deepEqual(user.mentions, [{ tag: 'Đích-Tag', id: tid, name: 'Đích Tag', machine: 'MayA' }], 'chỉ tag có thật và có trong tin');
  assert.ok(!user.text.includes('[Orbit Remote]'), 'app hiện đúng lời gõ, không kèm đoạn cho Claude');
  // Claude giả đáp lại đúng lời nhận được: lời đó có đoạn nói đích danh phiên được tag.
  const reply = await waitFor(() => r.buffer.find((e) => e.t === 'text' && e.text.includes('tag đích danh')), 'Claude nhận đoạn nói đích danh');
  assert.match(reply.text, new RegExp(`@Đích-Tag: phiên "Đích Tag", mã ${tid}, máy MayA, đã dừng`));
  assert.match(reply.text, new RegExp(`orbit_remote_send với to: "${tid}"`));
  assert.ok(!reply.text.includes('khong-co-ma'), 'tag không có thật thì bỏ');
  await call(`/api/sessions/${id}/close`, {});
});

test('hai máy: phiên ở máy A nhắn cho phiên ở máy B qua vỏ MCP thật', async () => {
  // Máy B chưa có thẻ, chỉ biết địa chỉ trạm (đường dò "địa chỉ đã biết"); nó tự xin nối.
  writeJsonAtomic(NODE_STATE, { urls: [`http://127.0.0.1:${port}`] });
  agentB = new NodeAgent({ machineId: 'mB0001', machineName: 'MayB', claudeCommand: FAKE, pipePath: pipeName() });
  await agentB.startPipe();
  nodeAbort = new AbortController();
  runNodeLoop(agentB, { stateFile: NODE_STATE, port: 9, signal: nodeAbort.signal });
  const pending = await waitFor(() => auth.pendingEnrollments().find((e) => e.machineId === 'mB0001'), 'yêu cầu nối hiện trên trạm', 10000);
  assert.equal(hub.machines.has('mB0001'), false, 'chưa duyệt thì máy chưa được nối');
  const state = await call('/api/state');
  assert.ok(state.data.enrollments.some((e) => e.requestId === pending.requestId), 'app thấy yêu cầu nối');
  assert.equal((await call(`/api/enroll/${pending.requestId}/approve`, {})).status, 200);
  await waitFor(() => hub.machines.get('mB0001')?.online, 'máy B nối vào trạm qua mạng sau khi duyệt', 12000);
  const saved = readJson(NODE_STATE, {});
  assert.equal(saved.hubId, 'hubX', 'máy B nhớ trạm theo mã');
  assert.ok(saved.token, 'máy B giữ thẻ để lần sau tự nối');

  const b = await call('/api/sessions', { machineId: 'mB0001', name: 'Beta', cwd: WORK });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const a = [...hub.sessions.values()].find((r) => r.snap.name === 'Alpha').snap;
  await waitFor(() => hub.sessions.get(b.data.id).snap.status === 'idle', 'phiên B sẵn sàng');

  // Chạy đúng vỏ MCP mà phiên Claude thật sẽ chạy, trỏ vào ống của máy A.
  const mcp = spawn(process.execPath, [join(HERE, '..', 'src', 'mcp-server.mjs')], {
    env: { ...process.env, ORBIT_REMOTE_SESSION: a.id, ORBIT_REMOTE_PIPE: agentA.pipePath },
  });
  const replies = new Map();
  createInterface({ input: mcp.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    replies.set(m.id, m);
  });
  const rpc = (id, method, params) => {
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return waitFor(() => replies.get(id), `MCP trả lời ${method}`, 8000);
  };
  await rpc(1, 'initialize', {});
  const tools = await rpc(2, 'tools/list', {});
  assert.deepEqual(tools.result.tools.map((t) => t.name), ['orbit_remote_sessions', 'orbit_remote_send', 'orbit_remote_group',
    'orbit_machines', 'orbit_machine_run', 'orbit_machine_read', 'orbit_machine_write', 'orbit_machine_edit', 'orbit_machine_find',
    'orbit_machine_screen', 'orbit_machine_input', 'orbit_machine_unity']);

  const list = await rpc(3, 'tools/call', { name: 'orbit_remote_sessions', arguments: {} });
  const dir = JSON.parse(list.result.content[0].text);
  assert.ok(dir.some((s) => s.name === 'Beta' && s.machine === 'MayB'), 'thấy phiên ở máy kia');
  assert.ok(dir.some((s) => s.id === a.id && s.self), 'đánh dấu chính mình');

  const sent = await rpc(4, 'tools/call', { name: 'orbit_remote_send', arguments: { to: 'Beta@MayB', text: 'chào từ A' } });
  const outcome = JSON.parse(sent.result.content[0].text);
  assert.equal(outcome.delivered.length, 1);
  assert.equal(outcome.delivered[0].machine, 'MayB');

  const got = await waitFor(() => hub.sessions.get(b.data.id).buffer.find((e) => e.t === 'user' && e.from?.kind === 'session'), 'phiên B nhận tin', 8000);
  assert.equal(got.from.name, 'Alpha');
  assert.match(got.text, /chào từ A/);
  assert.match(got.text, new RegExp(`to="${a.id}"`), 'tin kèm cách trả lời');
  await waitFor(() => hub.sessions.get(b.data.id).buffer.some((e) => e.t === 'text' && /chào từ A/.test(e.text)), 'phiên B xử lý tin như một lượt');
  assert.ok(hub.channel.some((c) => c.from.id === a.id && c.to[0].id === b.data.id), 'nhật ký kênh ghi lại');

  const bad = await rpc(5, 'tools/call', { name: 'orbit_remote_send', arguments: { to: 'KhongCo', text: 'x' } });
  assert.equal(bad.result.isError, true, 'người nhận không tồn tại thì báo lỗi rõ');

  mcp.stdin.end();
  await call(`/api/sessions/${b.data.id}/close`, {});
  await waitFor(() => hub.sessions.get(b.data.id).snap.status === 'stopped', 'phiên B dừng');
});

test('phiên ở máy A làm việc trên máy B (orbit_machine_*): cần máy B cho phép; lệnh, tệp, màn hình, Unity đi trọn đường thật', async () => {
  const { readFileSync: readText, writeFileSync: writeText } = await import('node:fs');
  const alpha = [...hub.sessions.values()].find((r) => r.snap.name === 'Alpha' && r.snap.machineId === 'mA')?.snap;
  assert.ok(alpha && RUNNING_SET.has(alpha.status), 'phiên Alpha ở máy A còn chạy');
  const mcp = spawn(process.execPath, [join(HERE, '..', 'src', 'mcp-server.mjs')], {
    env: { ...process.env, ORBIT_REMOTE_SESSION: alpha.id, ORBIT_REMOTE_PIPE: agentA.pipePath },
  });
  const replies = new Map();
  createInterface({ input: mcp.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    replies.set(m.id, m);
  });
  let seq = 100;
  const tool = async (name, args = {}, ms = 20000) => {
    seq += 1;
    const id = seq;
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    const r = (await waitFor(() => replies.get(id), `MCP ${name}`, ms)).result;
    return { error: Boolean(r.isError), text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), image: r.content.find((c) => c.type === 'image') };
  };
  try {
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    await waitFor(() => replies.get(1), 'MCP initialize');

    const list = await tool('orbit_machines');
    assert.match(list.text, /MayA \(máy của phiên này\): đang bật/);
    assert.match(list.text, /MayB: đang bật, \w+, chưa cho phép/);
    const denied = await tool('orbit_machine_run', { machine: 'MayB', command: 'Write-Output hi' });
    assert.equal(denied.error, true);
    assert.match(denied.text, /Máy MayB chưa cho phép phiên ở máy MayA điều khiển/);

    // Người dùng cho phép trên app (bảng của máy B).
    const grant = await call('/api/machines/mB0001/control', { from: ['mA', 'mB0001', 'khong-co'] });
    assert.equal(grant.status, 200, JSON.stringify(grant.data));
    assert.deepEqual(grant.data.from, ['mA'], 'bỏ chính máy B và máy lạ');
    assert.deepEqual(hub.publicMachine(hub.machines.get('mB0001')).controlFrom, ['mA']);

    const dir = join(ROOT, 'may-b');
    const ran = await tool('orbit_machine_run', { machine: 'mayb', command: 'Write-Output "chạy trên máy B"; cmd /c exit 4', cwd: ROOT });
    assert.equal(ran.error, false, ran.text);
    assert.match(ran.text, /^Mã thoát 4 ·[\s\S]*chạy trên máy B/);
    const last = hub.publicMachine(hub.machines.get('mB0001')).lastControl;
    assert.equal(last.machine, 'MayA');
    assert.equal(last.session, 'Alpha');
    assert.equal(last.action, 'run');

    const file = join(dir, 'Assets', 'Player.cs');
    assert.match((await tool('orbit_machine_write', { machine: 'MayB', path: file, content: 'class Player {\r\n  int hp = 10;\r\n}\r\n' })).text, /^Đã ghi/);
    assert.match((await tool('orbit_machine_read', { machine: 'MayB', path: file })).text, /\n2\t {2}int hp = 10;/);
    assert.match((await tool('orbit_machine_edit', { machine: 'MayB', path: file, old_string: 'hp = 10', new_string: 'hp = 25' })).text, /Đã sửa 1 chỗ/);
    assert.equal(readText(file, 'utf8'), 'class Player {\r\n  int hp = 25;\r\n}\r\n', 'tệp trên máy B đổi thật, giữ \\r\\n');
    assert.match((await tool('orbit_machine_find', { machine: 'MayB', path: dir, pattern: '**/*.cs', contains: 'hp = 25' })).text, /Player\.cs:2: int hp = 25;/);
    writeText(join(dir, 'anh.png'), Buffer.from('89504e470d0a1a0a0000', 'hex'));
    const pic = await tool('orbit_machine_read', { machine: 'MayB', path: join(dir, 'anh.png') });
    assert.equal(pic.image?.mimeType, 'image/png', 'tệp ảnh về thành ảnh cho Claude nhìn');
    const bad = await tool('orbit_machine_edit', { machine: 'MayB', path: file, old_string: 'không có', new_string: 'x' });
    assert.equal(bad.error, true);
    assert.match(bad.text, /Không thấy old_string/);

    if (process.platform === 'win32') {
      const shot = await tool('orbit_machine_screen', { machine: 'MayB' }, 30000);
      if (!/chưa có ffmpeg/.test(shot.text)) {
        assert.equal(shot.error, false, shot.text);
        assert.equal(shot.image?.mimeType, 'image/jpeg', 'màn hình về thành ảnh');
        assert.match(shot.text, /Toạ độ x, y cho orbit_machine_input tính theo ảnh này/);
      }
    }
    const unity = await tool('orbit_machine_unity', { machine: 'MayB', args: ['recipes'] }, 60000);
    assert.equal(unity.error, false, unity.text);
    assert.match(unity.text, /^Orbit Unity MCP recipes: mã thoát 0/);
    assert.match(unity.text, /cli recipes/, 'gọi đúng vỏ dòng lệnh khai trong ORBIT_UNITY_MCP_CLI');

    const nowhere = await tool('orbit_machine_run', { machine: 'MayZ', command: 'x' });
    assert.match(nowhere.text, /Không có máy "MayZ"\. Các máy: .*MayA.*MayB/);
    // Thu hồi: lại bị từ chối.
    await call('/api/machines/mB0001/control', { from: [] });
    assert.match((await tool('orbit_machine_read', { machine: 'MayB', path: file })).text, /chưa cho phép/);
    // Máy của chính phiên thì không cần cho phép.
    const self = await tool('orbit_machine_read', { machine: 'MayA', path: file });
    assert.equal(self.error, false, self.text);
  } finally {
    mcp.stdin.end();
  }
});

test('mở phiên ở máy A làm việc trên máy B: trạm cho phép A điều khiển B, kiểm thư mục trên B, dặn phiên dùng orbit_machine_*', async () => {
  const projB = join(ROOT, 'du-an-tren-may-b');
  mkdirSync(projB, { recursive: true });
  await call('/api/machines/mB0001/control', { from: [] }); // bắt đầu từ chỗ chưa cho phép
  const missing = await call('/api/sessions', { machineId: 'mA', workMachineId: 'mB0001', cwd: join(ROOT, 'khong-co-tren-b'), name: 'Xa' });
  assert.notEqual(missing.status, 200);
  assert.match(missing.data.error, /Không thấy thư mục .* trên máy MayB/);

  const made = await call('/api/sessions', { machineId: 'mA', workMachineId: 'mB0001', cwd: projB, name: 'Xa', permissionMode: 'bypassPermissions' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.id;
  await waitFor(() => hub.sessions.get(id)?.snap.status === 'idle', 'phiên làm việc trên máy B sẵn sàng');
  const snap = hub.sessions.get(id).snap;
  assert.deepEqual(snap.remote, { machineId: 'mB0001', machine: 'MayB', cwd: projB });
  assert.equal(snap.machineId, 'mA', 'phiên vẫn chạy ở máy A (tài khoản của máy A)');
  assert.ok(snap.cwd.includes('remote-work'), `Claude Code ở máy A chạy trong thư mục làm việc riêng: ${snap.cwd}`);
  assert.deepEqual(hub.controlGrants.mB0001, ['mA'], 'mở phiên là cho phép máy A điều khiển máy B');
  const prompt = agentA.sessions.get(id).appendSystemPrompt;
  assert.match(prompt, /LÀM VIỆC TRÊN MÁY MayB/);
  assert.ok(prompt.includes(`orbit_machine_run (cwd: "${projB}")`), 'dặn đúng thư mục dự án trên máy B');
  assert.equal((hub.recents.mB0001 || [])[0], projB, 'thư mục nhớ theo máy B');
  const blocked = await call(`/api/sessions/${id}/move-check`, { machineId: 'mB0001', cwd: projB });
  assert.ok(blocked.data.blockers?.some((b) => /làm việc trên máy MayB/.test(b)), JSON.stringify(blocked.data));

  // Đóng rồi chạy lại: vẫn làm việc trên máy B.
  await call(`/api/sessions/${id}/close`, {});
  await waitFor(() => hub.sessions.get(id).snap.status === 'stopped', 'phiên dừng');
  await call(`/api/sessions/${id}/resume`, {});
  await waitFor(() => hub.sessions.get(id)?.snap.status === 'idle', 'chạy lại');
  assert.deepEqual(hub.sessions.get(id).snap.remote, { machineId: 'mB0001', machine: 'MayB', cwd: projB });
  assert.match(agentA.sessions.get(id).appendSystemPrompt, /LÀM VIỆC TRÊN MÁY MayB/);
  // Chọn đúng máy chạy phiên thì là phiên thường.
  const same = await call('/api/sessions', { machineId: 'mA', workMachineId: 'mA', cwd: WORK, name: 'Thường' });
  assert.equal(same.status, 200, JSON.stringify(same.data));
  assert.equal(hub.sessions.get(same.data.id).snap.remote, undefined);
  for (const sid of [id, same.data.id]) await call(`/api/sessions/${sid}/close`, {});
  await call('/api/machines/mB0001/control', { from: [] });
});

test('tệp đính kèm lớn được phát qua nhiều khúc, kể cả từ máy nối qua mạng', async () => {
  const created = await call('/api/sessions', { machineId: 'mB0001', cwd: WORK, name: 'tệp lớn' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  await waitFor(() => hub.sessions.get(id)?.snap.status === 'idle', 'phiên ở máy B sẵn sàng');
  const big = Buffer.alloc(1300 * 1024);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 31 + 7) & 0xff;
  const sent = await call(`/api/sessions/${id}/send`, { text: 'tệp lớn', attachments: [{ name: 'du-lieu.bin', type: 'application/octet-stream', data: big.toString('base64') }] });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const ev = await waitFor(() => hub.sessions.get(id).buffer.find((e) => e.t === 'user' && e.attachments), 'tin có tệp về trạm');
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/attachment?f=${encodeURIComponent(ev.attachments[0].file)}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment;/, 'loại tệp lạ chỉ cho tải về, không mở tại chỗ');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(big), 'tệp 1,3 MB qua ba khúc về đủ và đúng');
  // Nhiều người xem cùng lúc (vài ảnh thu nhỏ tải song song): các khúc dồn vào cùng một lô gửi về
  // trạm mà không làm đứt đường nối của máy.
  const many = await Promise.all([0, 1, 2, 3].map(() => fetch(`http://127.0.0.1:${port}/api/sessions/${id}/attachment?f=${encodeURIComponent(ev.attachments[0].file)}`, { headers: { Cookie: cookie } })
    .then(async (r) => Buffer.from(await r.arrayBuffer()))));
  assert.ok(many.every((b) => b.equals(big)), 'bốn lượt tải song song đều về đủ');
  assert.ok(hub.machines.get('mB0001')?.online, 'đường nối của máy B vẫn còn');
  await call(`/api/sessions/${id}/close`, {});
});

test('tệp Claude nhắc tới bằng link file:/// mở được qua trạm; tệp phiên chưa nhắc thì không', async () => {
  const { writeFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const dir = join(ROOT, 'thư mục ảnh'); // ngoài WORK: bài duyệt thư mục đếm thư mục con của WORK
  mkdirSync(dir, { recursive: true });
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(700 * 1024)]); // hơn một khúc 512 KB
  const shown = join(dir, 'ảnh 1.png');
  const hidden = join(dir, 'bí mật.txt');
  writeFileSync(shown, png);
  writeFileSync(hidden, 'không được đọc');
  const created = await call('/api/sessions', { machineId: 'mB0001', cwd: WORK, name: 'tệp nhắc tới' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  await waitFor(() => hub.sessions.get(id)?.snap.status === 'idle', 'phiên ở máy B sẵn sàng');
  // Claude giả đáp lại đúng chữ nhận được: lời của nó có link file:/// (mã %XX như Claude thật viết), một đường
  // mạng và một thư mục.
  const link = pathToFileURL(shown).href;
  await call(`/api/sessions/${id}/send`, { text: `Ảnh: [ảnh 1](${link}) và [mạng](\\\\may-khac\\chia-se\\a.png) và [thư mục](${pathToFileURL(dir).href}/)` });
  await waitFor(() => hub.sessions.get(id).buffer.some((e) => e.t === 'text' && e.text.includes(link)), 'lời của phiên có link tệp');
  // App xin bằng đường dẫn đã giải mã (lib/md.js localPath): C:/.../thư mục ảnh/ảnh 1.png.
  const asked = decodeURIComponent(new URL(link).pathname).replace(/^\/([a-z]:)/i, '$1');
  const get = (p, headers = {}) => fetch(`http://127.0.0.1:${port}/api/sessions/${id}/file?p=${encodeURIComponent(p)}`, { headers: { Cookie: cookie, ...headers } });
  const res = await get(asked);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-disposition'), /^inline;/);
  assert.match(res.headers.get('content-security-policy'), /sandbox/, 'tệp từ máy không chạy mã trên nguồn của trạm');
  assert.equal(res.headers.get('cache-control'), 'private, no-cache', 'Claude hay ghi đè ảnh cùng tên: không giữ mãi');
  const etag = res.headers.get('etag');
  assert.ok(etag, 'có ETag theo cỡ và giờ sửa');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(png), 'ảnh 700 KB qua hai khúc về đủ và đúng');
  // Viết \ hay /, hoa hay thường đều là một tệp (Windows).
  assert.equal((await get(asked.replace(/\//g, '\\').toUpperCase())).status, process.platform === 'win32' ? 200 : 404);
  const same = await get(asked, { 'If-None-Match': etag });
  assert.equal(same.status, 304, 'app đã có đúng bản này: không tải lại');
  const part = await get(asked, { Range: 'bytes=8-15' });
  assert.equal(part.status, 206);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(png.subarray(8, 16)), 'tua đúng khoảng');
  writeFileSync(shown, Buffer.concat([png, Buffer.from('thêm')]));
  assert.equal((await get(asked, { 'If-None-Match': etag })).status, 200, 'ảnh bị ghi đè thì tải bản mới');

  const secret = await get(hidden);
  assert.equal(secret.status, 404, 'tệp phiên chưa nhắc tới thì không đọc được');
  assert.match((await secret.json()).error, /chưa nhắc/);
  assert.equal((await get('\\\\may-khac\\chia-se\\a.png')).status, 404, 'đường mạng không đọc, kể cả khi phiên có nhắc');
  assert.equal((await get(dir)).status, 404, 'thư mục không phải tệp');
  await call(`/api/sessions/${id}/close`, {});
});

test('Remote Control: bật lúc mở phiên, tắt bật giữa phiên, giữ khi chạy lại; bật hỏng thì báo rõ, phiên vẫn chạy', async () => {
  const snapOf = (id) => hub.sessions.get(id)?.snap;
  const created = await call('/api/sessions', { machineId: 'mA', cwd: WORK, name: 'RC', remoteControl: true, prompt: 'chào' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  const on = await waitFor(() => (snapOf(id)?.remoteControl?.state === 'connected' && snapOf(id).remoteControl.url ? snapOf(id).remoteControl : null), 'Remote Control nối xong');
  assert.equal(on.on, true);
  assert.match(on.url, /^https:\/\/claude\.ai\/code\/session_/, 'có link mở phiên trên claude.ai');
  await waitFor(() => hub.sessions.get(id).buffer.some((e) => e.t === 'text' && /echo: chào/.test(e.text)), 'lượt đầu vẫn chạy bình thường');
  assert.ok(hub.sessions.get(id).buffer.some((e) => e.t === 'system' && /Đã bật Remote Control/.test(e.text)), 'dòng hội thoại báo đã bật');

  const off = await call(`/api/sessions/${id}/remote-control`, { enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  await waitFor(() => snapOf(id)?.remoteControl === null, 'tắt thì hết trạng thái Remote Control');
  const back = await call(`/api/sessions/${id}/remote-control`, { enabled: true });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.match(back.data.url, /^https:\/\/claude\.ai\/code\/session_/, 'bật lại giữa phiên trả link');

  // Đóng rồi chạy lại: vẫn bật như người dùng đã chọn.
  await call(`/api/sessions/${id}/close`, {});
  await waitFor(() => snapOf(id)?.status === 'stopped', 'phiên dừng');
  assert.equal(snapOf(id).remoteControl?.on, true, 'trạm nhớ lựa chọn bật');
  await call(`/api/sessions/${id}/resume`, {});
  await waitFor(() => RUNNING_SET.has(snapOf(id)?.status) && snapOf(id)?.remoteControl?.state === 'connected', 'chạy lại thì tự bật lại');
  await call(`/api/sessions/${id}/close`, {});
  await waitFor(() => snapOf(id)?.status === 'stopped', 'phiên dừng lần hai');
  // Phiên đã dừng: tắt hay bật chỉ ghi lựa chọn, chạy lại thì áp dụng.
  const offStopped = await call(`/api/sessions/${id}/remote-control`, { enabled: false });
  assert.equal(offStopped.status, 200, JSON.stringify(offStopped.data));
  assert.equal(snapOf(id).remoteControl, null, 'tắt khi đã dừng thì bỏ lựa chọn');
  await call(`/api/sessions/${id}/resume`, {});
  await waitFor(() => snapOf(id)?.status === 'idle', 'chạy lại khi đã tắt');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(snapOf(id).remoteControl ?? null, null, 'chạy lại không bật Remote Control');
  await call(`/api/sessions/${id}/close`, {});
  await waitFor(() => snapOf(id)?.status === 'stopped', 'phiên dừng lần ba');
  const onStopped = await call(`/api/sessions/${id}/remote-control`, { enabled: true });
  assert.equal(onStopped.status, 200, JSON.stringify(onStopped.data));
  assert.equal(snapOf(id).remoteControl?.on, true, 'bật khi đã dừng thì ghi lựa chọn');
  await call(`/api/sessions/${id}/resume`, {});
  await waitFor(() => snapOf(id)?.remoteControl?.state === 'connected', 'chạy lại thì bật theo lựa chọn');
  await call(`/api/sessions/${id}/close`, {});
  await waitFor(() => snapOf(id)?.status === 'stopped', 'phiên dừng lần bốn');

  // Máy không đăng nhập bằng tài khoản Claude: Claude Code từ chối; phiên vẫn chạy và trả lời.
  process.env.FAKE_RC_FAIL = '1';
  let bad;
  try {
    bad = await call('/api/sessions', { machineId: 'mA', cwd: WORK, name: 'RC hỏng', remoteControl: true, prompt: 'vẫn chạy' });
    assert.equal(bad.status, 200, JSON.stringify(bad.data));
    const failed = await waitFor(() => (snapOf(bad.data.id)?.remoteControl?.state === 'failed' ? snapOf(bad.data.id).remoteControl : null), 'bật hỏng thì báo hỏng');
    assert.match(failed.error, /subscription/, 'kèm lý do của Claude Code');
    await waitFor(() => hub.sessions.get(bad.data.id).buffer.some((e) => e.t === 'text' && /echo: vẫn chạy/.test(e.text)), 'phiên vẫn trả lời');
    assert.ok(hub.sessions.get(bad.data.id).buffer.some((e) => e.t === 'system' && /Không bật được Remote Control/.test(e.text)), 'dòng hội thoại báo lý do');
    const retry = await call(`/api/sessions/${bad.data.id}/remote-control`, { enabled: true });
    assert.equal(retry.status, 409, 'bật giữa phiên hỏng thì API báo lỗi');
    assert.match(retry.data.error, /subscription/);
  } finally {
    delete process.env.FAKE_RC_FAIL;
  }
  await call(`/api/sessions/${bad.data.id}/close`, {});
  await waitFor(() => snapOf(bad.data.id)?.status === 'stopped', 'phiên hỏng dừng');
  // Phiên mở không bật thì không có trạng thái Remote Control, không gửi lệnh nào.
  const plain = await call('/api/sessions', { machineId: 'mA', cwd: WORK, name: 'RC tắt' });
  await waitFor(() => snapOf(plain.data.id)?.status === 'idle', 'phiên thường sẵn sàng');
  assert.equal(snapOf(plain.data.id).remoteControl ?? null, null);
  await call(`/api/sessions/${plain.data.id}/close`, {});
});

test('tài khoản Claude của máy: xem, đăng nhập bằng link và mã dán từ app; mã sai, lượt cũ, huỷ đều báo rõ', async () => {
  const base = '/api/machines/mB0001'; // máy nối qua mạng: đi trọn đường trạm → đầu máy ở xa
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Cookie: cookie } });
    return { status: res.status, data: await res.json() };
  };
  const before = await get(`${base}/claude-auth`);
  assert.equal(before.status, 200, JSON.stringify(before.data));
  assert.deepEqual(before.data, { loggedIn: true, method: 'claude.ai', email: 'cu@example.com', org: 'Tổ chức cũ', plan: 'max' });

  // Mã sai: Claude Code từ chối, đăng nhập cũ giữ nguyên.
  const first = await call(`${base}/claude-login`, {});
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.match(first.data.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/, 'có link đăng nhập');
  const bad = await call(`${base}/claude-login/code`, { id: first.data.id, code: 'ma-sai#x' });
  assert.equal(bad.status, 409);
  assert.match(bad.data.error, /^Login failed: That code wasn't accepted/);
  assert.equal((await get(`${base}/claude-auth`)).data.email, 'cu@example.com', 'mã sai không đổi tài khoản');
  const stale = await call(`${base}/claude-login/code`, { id: first.data.id, code: 'ma-dung#trang-thai' });
  assert.equal(stale.status, 409, 'lượt đã dùng xong không nhận mã nữa');
  assert.match(stale.data.error, /đã hết/);

  // Huỷ: lượt bị huỷ không nhận mã.
  const cancelled = await call(`${base}/claude-login`, {});
  assert.equal((await call(`${base}/claude-login/cancel`, { id: cancelled.data.id })).data.ok, true);
  assert.equal((await call(`${base}/claude-login/code`, { id: cancelled.data.id, code: 'ma-dung#trang-thai' })).status, 409);

  // Mã đúng, kèm email gợi ý: đổi sang tài khoản mới, trả trạng thái mới.
  const good = await call(`${base}/claude-login`, { email: 'moi@vi-du.vn' });
  assert.match(good.data.url, /login_hint=moi%40vi-du\.vn/, 'email gợi ý đi vào link');
  const done = await call(`${base}/claude-login/code`, { id: good.data.id, code: '  ma-dung#trang-thai  ' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual(done.data, { loggedIn: true, method: 'claude.ai', email: 'moi@vi-du.vn', org: 'Tổ chức mới', plan: 'pro' });
  assert.equal((await get(`${base}/claude-auth`)).data.email, 'moi@vi-du.vn');

  assert.equal((await call(`${base}/claude-login`, { email: 'khong-phai-email' })).status, 409, 'email lạ bị từ chối');
  assert.equal((await call(`${base}/claude-login/code`, { id: 'khong-co', code: 'x' })).status, 409);
  rmSync(join(process.env.ORBIT_REMOTE_STATE, 'fake-claude-auth.json'), { force: true });
});

test('đường ống: công cụ chưa tự giới thiệu thì không gửi được', async () => {
  const net = await import('node:net');
  const s = net.connect(agentA.pipePath);
  s.setEncoding('utf8');
  const got = [];
  s.on('data', lineSplitter((m) => got.push(m)));
  await new Promise((r) => s.once('connect', r));
  s.write(toLine({ op: 'send', to: '*', text: 'x', rid: 'r1' }));
  const reply = await waitFor(() => got.find((m) => m.rid === 'r1'), 'trả lời');
  assert.equal(reply.ok, false);
  s.destroy();
});

test('phiên ngoài app: hiện trên máy, xem được lịch sử, không lẫn phiên của chính app', async () => {
  const { writeFileSync, utimesSync } = await import('node:fs');
  const dir = join(process.env.ORBIT_REMOTE_PROJECTS, 'D--Fake-Project');
  mkdirSync(dir, { recursive: true });
  const outside = '11111111-2222-3333-4444-555555555555';
  const line = (o) => `${JSON.stringify(o)}\n`;
  writeFileSync(join(dir, `${outside}.jsonl`),
    line({ type: 'user', cwd: 'D:\Fake\Project', timestamp: '2026-10-27T01:00:00Z', message: { role: 'user', content: 'sửa lỗi đăng nhập' } })
    + line({ type: 'assistant', timestamp: '2026-10-27T01:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Đã sửa.' }] } })
    + line({ type: 'ai-title', aiTitle: 'Sửa lỗi đăng nhập' }));
  // Nhật ký mang mã của một phiên do chính app mở (Alpha) thì không được tính là "ngoài app".
  const alpha = [...hub.sessions.values()].find((r) => r.snap.name === 'Alpha').snap;
  writeFileSync(join(dir, `${alpha.claudeSessionId}.jsonl`), line({ type: 'user', cwd: WORK, message: { role: 'user', content: 'x' } }));
  // Một nhật ký cũ (2 giờ trước) thì không còn coi là đang mở.
  const old = '99999999-2222-3333-4444-555555555555';
  writeFileSync(join(dir, `${old}.jsonl`), line({ type: 'user', cwd: 'D:\Old', message: { role: 'user', content: 'cũ' } }));
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  utimesSync(join(dir, `${old}.jsonl`), twoHoursAgo, twoHoursAgo);

  agentA.scanExternal(true);
  const ext = await waitFor(() => {
    const m = hub.publicMachine(hub.machines.get('mA'));
    return m.external.length ? m.external : null;
  }, 'trạm nhận danh sách phiên ngoài app');
  const ids = ext.map((t) => t.claudeSessionId);
  assert.ok(ids.includes(outside), 'phiên mở ngoài app có mặt');
  assert.ok(!ids.includes(alpha.claudeSessionId), 'phiên của chính app bị lọc');
  assert.ok(!ids.includes(old), 'nhật ký cũ không tính là đang mở');
  assert.equal(ext.find((t) => t.claudeSessionId === outside).title, 'Sửa lỗi đăng nhập');
  assert.equal(ext.find((t) => t.claudeSessionId === outside).active, true);

  const hist = await call(`/api/machines/mA/history/${outside}`);
  assert.deepEqual(hist.data.events.map((e) => e.t), ['user', 'text']);
  const again = await call(`/api/machines/mA/history/${outside}?since=${hist.data.mtime}`);
  assert.equal(again.data.unchanged, true, 'file không đổi thì không gửi lại');
});

test('phiên ngoài app theo sổ phiên của Claude Code: phiên mở lâu mà ngồi yên vẫn hiện, phiên đã đóng thì không', async () => {
  const { writeFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  // Sổ nằm cạnh thư mục nhật ký, như ~/.claude/sessions cạnh ~/.claude/projects.
  const sessionsDir = join(ROOT, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const idle = '99999999-2222-3333-4444-555555555555'; // nhật ký ghi lần cuối 2 giờ trước (ca trên)
  const crashed = '77777777-2222-3333-4444-555555555555';
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid; // tiến trình đã thoát
  const alpha = [...hub.sessions.values()].find((r) => r.snap.name === 'Alpha').snap;
  const entry = (pid, sessionId, extra = {}) => writeFileSync(join(sessionsDir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: 'D:\\Old', kind: 'interactive', entrypoint: 'claude-vscode', startedAt: Date.now() - 3 * 3600 * 1000, ...extra }));
  entry(process.pid, idle);
  entry(deadPid, crashed);
  entry(process.ppid, alpha.claudeSessionId); // tiến trình còn sống, nhưng là phiên do app giữ: không tính là ngoài app
  writeFileSync(join(sessionsDir, 'rac.json'), '{hỏng');
  try {
    agentA.scanExternal(true);
    const ext = await waitFor(() => {
      const m = hub.publicMachine(hub.machines.get('mA'));
      return m.external.some((t) => t.claudeSessionId === idle) ? m.external : null;
    }, 'trạm nhận phiên đang mở theo sổ');
    const ids = ext.map((t) => t.claudeSessionId);
    assert.deepEqual(ids, [idle], 'chỉ phiên đang chạy thật: không có phiên đã đóng, phiên chết, phiên của app');
    const t = ext[0];
    assert.equal(t.open, true);
    assert.equal(t.active, true);
    assert.equal(t.cwd, 'D:\\Old');
    assert.equal(t.title, 'cũ', 'tiêu đề lấy từ nhật ký');
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test('lệnh nhanh Restart trạm và Setup máy: trạm tự khởi động lại, máy được bảo kéo code và setup, kết quả setup hiện trên app', async () => {
  const restart = await call('/api/hub/restart', {});
  assert.equal(restart.status, 200);
  assert.equal(hubRestarts, 1, 'trạm gọi đúng việc khởi động lại');

  let updates = 0;
  agentA.spawnUpdate = () => { updates += 1; return 'setup.log'; }; // không chạy git pull và setup thật
  const update = await call('/api/machines/mA/update', {});
  assert.equal(update.status, 200);
  assert.equal(update.data.log, 'setup.log');
  assert.equal(updates, 1, 'đầu máy của đúng máy đó nhận lệnh');

  // setup.mjs ghi kết quả; đầu máy thấy tệp đổi thì gửi lên trạm, app đọc qua máy.
  const { writeFileSync } = await import('node:fs');
  agentA.setupFile = join(ROOT, 'setup-last-mA.json');
  writeFileSync(agentA.setupFile, JSON.stringify({ at: '2026-10-29T01:52:00Z', mode: 'auto', pull: 'đã kéo bản mới', done: true, ok: false,
    failed: [], needsUser: [{ title: 'Tường lửa', detail: 'thiếu luật' }], warnings: [] }));
  agentA.scanSetup();
  const m = await waitFor(() => {
    const pm = hub.publicMachine(hub.machines.get('mA'));
    return pm.setup?.at ? pm : null;
  }, 'trạm nhận kết quả setup');
  assert.equal(m.setup.mode, 'auto');
  assert.deepEqual(m.setup.needsUser.map((x) => x.title), ['Tường lửa']);
  const before = hub.publicMachine(hub.machines.get('mA')).setup;
  agentA.scanSetup(); // tệp không đổi thì không gửi lại
  assert.deepEqual(hub.publicMachine(hub.machines.get('mA')).setup, before);
});
test('bật máy qua mạng: trạm nhờ máy đang bật cùng dải mạng bắn gói, không có thì thử từ máy giữ trạm; nhớ card mạng cả khi máy tắt', async () => {
  // Không bắn gói thật trong lúc kiểm: ghi lại ai được nhờ bắn, bắn cho MAC nào, tới đâu.
  const shots = [];
  agentA.sendWake = async (mac, broadcasts) => { shots.push(['MayA', mac, broadcasts.join(',')]); return ['ok']; };
  if (agentB) agentB.sendWake = async (mac, broadcasts) => { shots.push(['MayB', mac, broadcasts.join(',')]); return ['ok']; };
  const a = hub.machines.get('mA');
  assert.ok(a.wake?.length, 'đầu máy báo card mạng lúc chào trạm');
  const home = a.wake[0];

  // Máy tắt ở mạng khác hẳn: không ai cùng mạng, thử từ máy giữ trạm và báo rõ.
  hub.machines.set('mZ', { id: 'mZ', name: 'MayTat', online: false, link: null, rpc: null, external: [],
    wake: [{ name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:01', address: '10.99.0.20', netmask: '255.255.255.0', broadcast: '10.99.0.255' }] });
  let r = await call('/api/machines/mZ/wake', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.sameNetwork, false);
  assert.deepEqual(shots, [['MayA', 'aa:bb:cc:dd:ee:01', '10.99.0.255,255.255.255.255']]);

  // Máy tắt cùng dải với máy đang bật: mọi máy cùng dải đều bắn hộ.
  shots.length = 0;
  hub.machines.get('mZ').wake = [{ name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:02', address: home.address.replace(/\d+$/, '250'), netmask: home.netmask, broadcast: home.broadcast }];
  r = await call('/api/machines/mZ/wake', {});
  assert.equal(r.data.sameNetwork, true);
  assert.ok(shots.length >= 1 && shots.every((x) => x[1] === 'aa:bb:cc:dd:ee:02' && x[2].startsWith(home.broadcast)));

  // Trạm lưu card mạng xuống đĩa để còn bật được sau khi chính trạm khởi động lại.
  hub.saveNow();
  const { readFileSync } = await import('node:fs');
  const saved = JSON.parse(readFileSync(join(process.env.ORBIT_REMOTE_STATE, 'hub.json'), 'utf8'));
  assert.equal(saved.machines.find((m) => m.id === 'mZ').wake[0].mac, 'aa:bb:cc:dd:ee:02');
  assert.equal(hub.publicMachine(hub.machines.get('mZ')).canWake, true);

  // Máy đang bật, hay chưa từng báo card mạng: báo lỗi rõ ràng.
  assert.equal((await call('/api/machines/mA/wake', {})).status, 500);
  hub.machines.get('mZ').wake = [];
  const unknown = await call('/api/machines/mZ/wake', {});
  assert.equal(unknown.status, 500);
  assert.match(unknown.data.error, /chưa biết card mạng/);
  hub.machines.delete('mZ');
});
test('tắt máy từ app: đặt lịch qua trạm, app thấy thời gian còn lại; huỷ thì hết; thời gian lạ bị từ chối', async () => {
  const calls = [];
  agentA.powerSchedule = (delaySec) => { calls.push(`tắt sau ${delaySec}`); return Date.now() + delaySec * 1000; };
  agentA.powerCancel = () => calls.push('huỷ');
  agentA.powerFile = join(ROOT, 'power-mA.json');
  let r = await call('/api/machines/mA/power', { action: 'shutdown', delaySec: 900 });
  assert.equal(r.status, 200);
  const m = await waitFor(() => hub.publicMachine(hub.machines.get('mA')).power, 'trạm nhận lịch tắt');
  // Chỉ gửi số mili giây còn lại, không gửi giờ: đồng hồ máy tính và điện thoại có thể lệch nhau.
  assert.equal(m.at, undefined);
  assert.ok(m.leftMs > 890000 && m.leftMs <= 900000, String(m.leftMs));
  const seen = (await call('/api/state')).data.machines.find((x) => x.id === 'mA').power;
  assert.ok(seen.leftMs > 890000 && seen.leftMs <= 900000, 'app nhận đúng số còn lại');

  // Đồng hồ máy tính lệch (máy giữ trạm đo thấy chậm 10 phút): đầu máy báo số còn lại theo đồng hồ của
  // nó, trạm đổi theo đồng hồ của trạm, nên app vẫn thấy đúng 15 giây.
  hub.onMachineMessage(hub.machines.get('mA'), { op: 'power', power: { action: 'shutdown', leftMs: 15000 } });
  const skewed = hub.publicMachine(hub.machines.get('mA')).power.leftMs;
  assert.ok(skewed > 14000 && skewed <= 15000, String(skewed));
  // Đầu máy bản trước chỉ báo giờ tắt: vẫn nhận.
  hub.onMachineMessage(hub.machines.get('mA'), { op: 'power', power: { action: 'shutdown', at: Date.now() + 30000 } });
  assert.ok(hub.publicMachine(hub.machines.get('mA')).power.leftMs > 29000);
  hub.onMachineMessage(hub.machines.get('mA'), { op: 'power', power: { action: 'shutdown', leftMs: 900000 } });
  const { readFileSync, existsSync } = await import('node:fs');
  assert.equal(JSON.parse(readFileSync(agentA.powerFile, 'utf8')).action, 'shutdown', 'lịch được lưu, đầu máy khởi động lại vẫn báo đúng');
  r = await call('/api/machines/mA/power', { action: 'cancel' });
  assert.equal(r.status, 200);
  await waitFor(() => hub.publicMachine(hub.machines.get('mA')).power === null, 'huỷ thì app hết thấy lịch');
  assert.equal(existsSync(agentA.powerFile), false);
  assert.deepEqual(calls, ['tắt sau 900', 'huỷ']);
  for (const bad of [{ action: 'shutdown', delaySec: -5 }, { action: 'shutdown', delaySec: 'x' }, { action: 'reboot' }]) {
    assert.equal((await call('/api/machines/mA/power', bad)).status, 500, JSON.stringify(bad));
  }
  assert.deepEqual(calls, ['tắt sau 900', 'huỷ'], 'giá trị lạ không tới được máy');
});
test('đổi tên máy và quên máy: thu hồi thẻ, đầu máy tự nghỉ chứ không xin nối lại liên tục', async () => {
  const renamed = await call('/api/machines/mB0001/rename', { name: 'Máy văn phòng' });
  assert.equal(renamed.data.name, 'Máy văn phòng');
  assert.ok([...hub.sessions.values()].filter((r) => r.snap.machineId === 'mB0001').every((r) => r.snap.machine === 'Máy văn phòng'),
    'phiên của máy đổi theo tên mới');
  assert.equal((await call('/api/machines/mA/forget', {})).status, 500, 'không quên được máy giữ trạm');

  assert.equal((await call('/api/machines/mB0001/forget', {})).status, 200);
  assert.equal(hub.machines.has('mB0001'), false);
  assert.equal(auth.list().some((d) => d.machineId === 'mB0001'), false, 'thẻ của máy bị thu hồi');
  const paused = await waitFor(() => {
    const s = readJson(NODE_STATE, {});
    return s.pausedUntil > Date.now() && !s.token ? s : null;
  }, 'đầu máy bị từ chối thẻ thì nghỉ', 15000);
  assert.ok(paused.pausedUntil - Date.now() > 23 * 3600 * 1000, 'nghỉ khoảng một ngày');
  assert.equal(auth.pendingEnrollments().length, 0, 'không xin nối lại ngay');
});

test('dò tìm: trạm trả lời gói UDP hỏi, và nhận ra trạm qua địa chỉ đã biết', async () => {
  const dgram = await import('node:dgram');
  const udpPort = 40000 + Math.floor(Math.random() * 20000);
  const responder = startDiscoveryResponder({ port: udpPort, info: () => ({ hubId: 'hubX', hubName: 'TramThu', urls: ['https://x.example'] }) });
  await new Promise((r) => setTimeout(r, 100));
  const reply = await new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const timer = setTimeout(() => { s.close(); reject(new Error('không có trả lời UDP')); }, 2000);
    s.on('message', (msg) => { clearTimeout(timer); s.close(); resolve(JSON.parse(msg.toString())); });
    s.send(Buffer.from('orbit-remote:discover'), udpPort, '127.0.0.1');
  });
  responder.close();
  assert.equal(reply.service, 'orbit-remote');
  assert.equal(reply.hubId, 'hubX');
  assert.equal(reply.port, udpPort);

  const hubs = await discoverHubs({ knownUrls: [`http://127.0.0.1:${port}`, 'http://127.0.0.1:1'], port: 9, timeoutMs: 1500 });
  assert.equal(hubs.length, 1);
  assert.equal(hubs[0].hubId, 'hubX');
  assert.deepEqual(hubs[0].urls, [`http://127.0.0.1:${port}`]);
});

test('mã ghép đôi: hai mã cùng sống, mỗi mã dùng một lần, đoán sai năm lần liền thì mọi mã chết', () => {
  const a = new Auth(join(ROOT, 'auth-codes.json'));
  const forBrowser = a.newPairCode();
  const forPhone = a.newPairCode();
  assert.notEqual(forBrowser, forPhone);
  assert.ok(a.redeem(forBrowser, 'Trình duyệt').token);
  assert.ok(a.redeem(forPhone, 'iPhone').token, 'mã cho điện thoại vẫn dùng được sau khi trình duyệt đã ghép');
  assert.ok(a.redeem(forPhone, 'Lần hai').error, 'mã chỉ dùng một lần');
  const live = a.newPairCode();
  const wrong = live === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) a.redeem(wrong, 'Đoán');
  assert.ok(a.redeem(live, 'Muộn').error, 'sai năm lần liền thì mã đang sống cũng chết');
});

test('mã QR: ma trận của địa chỉ mẫu khớp bản đã được bộ giải mã độc lập (zxing-cpp) xác nhận', async () => {
  const { createHash } = await import('node:crypto');
  const { encodeQR, qrToSvg, qrToTerminal } = await import('../web/lib/qr.js');
  const qr = encodeQR('http://192.168.2.37:8795/?pair=549146');
  let rows = '';
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) rows += qr.get(x, y) ? '1' : '0';
    rows += '\n';
  }
  assert.equal(qr.version, 3);
  assert.equal(createHash('sha256').update(rows).digest('hex'), '2a29a61fb247486227904f390357241dafd1777d22072915388460f441b9f9db');
  assert.match(qrToSvg(qr), /^<svg [^>]*viewBox="0 0 37 37"/);
  const term = qrToTerminal(qr).split('\n');
  assert.equal(term.length, Math.ceil((qr.size + 6) / 2));
  assert.ok(term.every((l) => [...l].length === qr.size + 6), 'mọi dòng cùng bề ngang');
  assert.throws(() => encodeQR('x'.repeat(214)), /quá dài/);
});

test('quét QR: trang có mã ghép đôi trỏ manifest tới địa chỉ khởi động mang sẵn mã', async () => {
  const page = await fetch(`http://127.0.0.1:${port}/?pair=123456`);
  const html = await page.text();
  assert.match(html, /href="\/manifest\.webmanifest\?pair=123456"/);
  const manifest = await (await fetch(`http://127.0.0.1:${port}/manifest.webmanifest?pair=123456`)).json();
  assert.equal(manifest.start_url, '/?pair=123456');
  const plain = await (await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)).json();
  assert.equal(plain.start_url, '/');
  const evil = await (await fetch(`http://127.0.0.1:${port}/?pair=%22%3E%3Cscript%3E`)).text();
  assert.ok(!evil.includes('<script>'), 'chỉ nhận đúng 6 chữ số, không chèn được gì vào trang');
});

test('đổi trạm: custom/hub.json khai trạm ở máy khác thì trạm cũ tự thôi, không dựng trạm thứ hai', async () => {
  const net = await import('node:net');
  const { existsSync } = await import('node:fs');
  const MAIN = join(HERE, '..', 'src', 'main.mjs');
  const state = join(ROOT, 'old-hub-state');
  const custom = join(ROOT, 'old-hub-custom');
  mkdirSync(custom, { recursive: true });
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const env = {
    ...process.env,
    ORBIT_REMOTE_STATE: state,
    ORBIT_REMOTE_CUSTOM: custom,
    ORBIT_REMOTE_PORT: String(port),
    ORBIT_REMOTE_HOST: '127.0.0.1',
    ORBIT_REMOTE_PIPE_TAG: `test-${randomBytes(4).toString('hex')}`,
  };
  const alive = async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1000) })).json()).service === 'orbit-remote';
    } catch {
      return false;
    }
  };
  const until = async (fn, label) => {
    for (const end = Date.now() + 8000; !(await fn());) {
      if (Date.now() > end) throw new Error(`Hết giờ chờ: ${label}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const run = (command) => new Promise((resolve) => {
    const p = spawn(process.execPath, [MAIN, command], { env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
  // Không cho "start" dựng đầu máy chạy nền: phép kiểm không được để lại tiến trình nào.
  writeJsonAtomic(join(state, 'disabled.json'), { since: 'test' });

  // Kho khai chính máy này là trạm: giữ nguyên.
  let hub = spawn(process.execPath, [MAIN, 'hub'], { env, stdio: 'ignore' });
  try {
    await until(alive, 'trạm lên');
    writeJsonAtomic(join(custom, 'hub.json'), { hubId: readJson(join(state, 'machine.json'), {}).id, hubName: 'MAY-NAY', tailnet: ['http://127.0.0.1:1'] });
    const kept = await run('start');
    assert.equal(kept.code, 0, kept.out);
    assert.doesNotMatch(kept.out, /thôi làm trạm/);
    assert.ok(await alive(), 'trạm được khai đúng là máy này thì vẫn chạy');
  } finally {
    hub.kill();
  }
  await until(async () => hub.exitCode !== null || hub.signalCode !== null, 'trạm tắt');

  // custom/hub.json khai trạm ở máy khác (chưa tới được): trạm cũ tắt, bỏ vai trạm, không dựng trạm mới.
  hub = spawn(process.execPath, [MAIN, 'hub'], { env, stdio: 'ignore' });
  try {
    await until(alive, 'trạm lên lần hai');
    writeJsonAtomic(join(custom, 'hub.json'), { hubId: 'tram-nha-01', hubName: 'TRAM-NHA', tailnet: ['http://127.0.0.1:1'] });
    const moved = await run('start');
    assert.equal(moved.code, 0, moved.out);
    assert.match(moved.out, /thôi làm trạm/);
    assert.doesNotMatch(moved.out, /nhận làm trạm/, 'không dựng trạm thứ hai khi chưa tới được trạm khai trong custom/hub.json');
    assert.ok(!existsSync(join(state, 'role.json')), 'bỏ vai trạm');
    assert.equal(await alive(), false, 'trạm cũ đã tắt');
    await until(async () => hub.exitCode !== null, 'tiến trình trạm cũ thoát');
  } finally {
    hub.kill();
  }
});

test('Tailscale: đọc đúng địa chỉ tailnet, khai vào custom/hub.json theo kiểu gộp, không lộ tên tài khoản', async () => {
  const { tailnetFromStatus, tailnetUrls } = await import('../src/tailnet.mjs');
  const { publishRepoHub, repoHub, repoHubUrls } = await import('../src/hub-decl.mjs');
  // Đúng hình dạng "tailscale status --json" của bản 1.104.4 (giá trị giả, trường thật).
  const status = {
    BackendState: 'Running',
    Self: { HostName: 'TRAM', DNSName: 'tram.tail0000.ts.net.', TailscaleIPs: ['100.64.1.2', 'fd7a:115c:a1e0::1'] },
    CurrentTailnet: { Name: 'ai-do@example.com', MagicDNSSuffix: 'tail0000.ts.net', MagicDNSEnabled: true },
  };
  const info = tailnetFromStatus(status);
  assert.deepEqual(info, { running: true, state: 'Running', ipv4: '100.64.1.2', dnsName: 'tram.tail0000.ts.net', magicDns: true });
  assert.ok(!JSON.stringify(info).includes('example.com'), 'tên tailnet (thường là email) không được ghi');
  assert.deepEqual(tailnetUrls(info, 8795), ['http://100.64.1.2:8795', 'http://tram.tail0000.ts.net:8795']);
  assert.deepEqual(tailnetUrls({ ...info, magicDns: false }, 8795), ['http://100.64.1.2:8795'], 'tắt MagicDNS thì chỉ khai địa chỉ IP');
  assert.equal(tailnetFromStatus({ BackendState: 'NeedsLogin', Self: { TailscaleIPs: [] } }).running, false);
  assert.equal(tailnetFromStatus(null).ipv4, '');

  // Ghi vào một custom/hub.json tạm, không đụng file thật.
  const file = join(ROOT, 'hub-repo.json');
  publishRepoHub({ hubId: 'hubA', hubName: 'TRAM', note: 'giữ' }, file);
  publishRepoHub({ hubId: 'hubA', hubName: 'TRAM', tailnet: tailnetUrls(info, 8795) }, file);
  assert.equal(repoHub(file).note, 'giữ', '"tailnet setup" gộp vào file, không xoá khoá khác');
  assert.deepEqual(repoHubUrls(repoHub(file)), ['http://100.64.1.2:8795', 'http://tram.tail0000.ts.net:8795']);
  publishRepoHub({ tailnet: undefined }, file);
  assert.deepEqual(repoHubUrls(repoHub(file)), [], '"tailnet off" bỏ địa chỉ Tailscale');
  assert.equal(repoHub(file).hubId, 'hubA', '"tailnet off" giữ mã trạm');
  publishRepoHub({ hubId: 'hubB', hubName: 'TRAM2', tailnet: ['http://100.64.9.9:8795'] }, file);
  assert.deepEqual(repoHub(file), { hubId: 'hubB', hubName: 'TRAM2', tailnet: ['http://100.64.9.9:8795'] }, 'trạm khác thì không trộn với trạm cũ');
  assert.deepEqual(repoHubUrls(null), []);
});

test('ô soạn: đổi effort giữa phiên, ảnh đi thẳng vào lượt nhắn, tệp khác lưu lại cho Claude đọc', async () => {
  const { readFileSync } = await import('node:fs');
  const created = await call('/api/sessions', { machineId: 'mA', cwd: WORK, name: 'đính kèm' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  const s = agentA.sessions.get(id);
  await waitFor(() => s.status === 'idle', 'phiên sẵn sàng');
  const events = [];
  s.on('event', (e) => events.push(e));

  const eff = await call(`/api/sessions/${id}/effort`, { effort: 'high' });
  assert.equal(eff.status, 200, JSON.stringify(eff.data));
  assert.equal(s.effort, 'high');
  await call(`/api/sessions/${id}/send`, { text: 'EFFORT' });
  await waitFor(() => events.some((e) => e.t === 'text' && e.text === 'effort: high'), 'Claude nhận mức effort mới');
  assert.notEqual((await call(`/api/sessions/${id}/effort`, { effort: 'cao-vut' })).status, 200, 'mức lạ bị từ chối');

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const sent = await call(`/api/sessions/${id}/send`, {
    text: 'xem',
    attachments: [
      { name: 'a.png', type: 'image/png', data: png },
      { name: '../ghi chú.txt', type: 'text/plain', data: Buffer.from('nội dung').toString('base64') },
    ],
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const user = await waitFor(() => events.find((e) => e.t === 'user' && e.attachments), 'tin người dùng có tệp');
  assert.deepEqual(user.attachments.map((a) => a.name), ['a.png', '.._ghi chú.txt'], 'tên tệp bỏ ký tự đường dẫn');
  assert.deepEqual(user.attachments.map((a) => a.type), ['image/png', 'text/plain']);
  assert.ok(user.attachments.every((a) => /^[0-9a-z]+-[^\\/]+$/.test(a.file)), 'mỗi tệp (cả ảnh) có tên đã lưu để mở lại');
  const reply = await waitFor(() => events.find((e) => e.t === 'text' && e.text.includes('ảnh: 1')), 'ảnh tới tay mô hình');
  const path = /- \.\._ghi chú\.txt: (.+?) \| ảnh: 1/.exec(reply.text)?.[1];
  assert.ok(path && path.startsWith(join(process.env.ORBIT_REMOTE_STATE, 'uploads', id)), `tệp lưu trong thư mục riêng của phiên: ${path}`);
  assert.equal(readFileSync(path, 'utf8'), 'nội dung');

  // Mở lại tệp đã gửi: trạm phát đúng nội dung, đúng kiểu, không cho chạy mã; tên lạ bị chặn.
  const get = (file, headers = {}) => fetch(`http://127.0.0.1:${port}/api/sessions/${id}/attachment?f=${encodeURIComponent(file)}`, { headers: { Cookie: cookie, ...headers } });
  const [img, txt] = user.attachments;
  const imgRes = await get(img.file);
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get('content-type'), 'image/png');
  assert.match(imgRes.headers.get('content-security-policy'), /sandbox/, 'tệp người dùng gửi chạy trong hộp cát');
  assert.deepEqual(Buffer.from(await imgRes.arrayBuffer()), Buffer.from(png, 'base64'), 'ảnh phát lại đúng từng byte');
  const txtRes = await get(txt.file);
  assert.equal(txtRes.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await txtRes.text(), 'nội dung');
  const part = await get(txt.file, { Range: 'bytes=0-2' });
  assert.equal(part.status, 206, 'nhận khoảng Range (video trên iPhone cần)');
  assert.equal(part.headers.get('content-range'), `bytes 0-2/${Buffer.byteLength('nội dung')}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), Buffer.from('nội dung').subarray(0, 3));
  for (const bad of ['../auth.json', '..\\auth.json', 'auth.json', `x-../../${img.file}`]) {
    assert.notEqual((await get(bad)).status, 200, `chặn tên tệp lạ: ${bad}`);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/attachment?f=${encodeURIComponent(img.file)}`)).status, 401, 'chưa ghép đôi thì không xem được');
  await call(`/api/sessions/${id}/close`, {});
});


test('nhiệt độ máy: app hỏi qua trạm, đầu máy trả số đo mới nhất; người chưa ghép đôi bị chặn', async () => {
  const real = agentA.sensors;
  let asked = 0;
  agentA.sensors = { read: () => { asked += 1; return { state: 'ready', items: [{ id: 'gpu0', kind: 'gpu', label: 'GPU', detail: 'GTX', c: 61 }], notes: [], interval: 5 }; }, stop() {} };
  try {
    const r = await call('/api/machines/mA/temps');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.items[0].c, 61);
    assert.equal(asked, 1, 'mỗi lần app hỏi là một lần đọc, đầu máy tự lo nhịp đo');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/machines/mA/temps`)).status, 401);
    assert.notEqual((await call('/api/machines/khong-co/temps')).status, 200, 'máy không có thì báo lỗi');
  } finally {
    agentA.sensors = real;
  }
});

test('duyệt thư mục khi mở phiên: app hỏi qua trạm, đầu máy đọc thư mục thật; thư mục không có thì báo rõ; người chưa ghép đôi bị chặn', async () => {
  mkdirSync(join(WORK, 'GameA'), { recursive: true });
  mkdirSync(join(WORK, 'Tool'), { recursive: true });
  const r = await call(`/api/machines/mA/dirs?path=${encodeURIComponent(WORK)}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.path, WORK);
  assert.equal(r.data.parent, ROOT);
  assert.deepEqual(r.data.entries.map((e) => e.name), ['GameA', 'Tool']);

  const roots = await call('/api/machines/mA/dirs');
  assert.equal(roots.status, 200);
  assert.ok(roots.data.entries.some((e) => e.kind === 'drive'), 'không ghi đường dẫn là các ổ đĩa');

  const missing = await call(`/api/machines/mA/dirs?path=${encodeURIComponent(join(WORK, 'khong-co'))}`);
  assert.notEqual(missing.status, 200);
  assert.match(missing.data.error, /không có\.$/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/machines/mA/dirs`)).status, 401);
});

// Vỏ MCP thật của một phiên (đúng chương trình phiên Claude chạy), trỏ vào ống của máy A.
function mcpAs(sessionId) {
  const proc = spawn(process.execPath, [join(HERE, '..', 'src', 'mcp-server.mjs')], {
    env: { ...process.env, ORBIT_REMOTE_SESSION: sessionId, ORBIT_REMOTE_PIPE: agentA.pipePath },
  });
  const replies = new Map();
  createInterface({ input: proc.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    replies.set(m.id, m);
  });
  let n = 0;
  const rpc = async (method, params) => {
    n += 1;
    const id = n;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return waitFor(() => replies.get(id), `MCP trả lời ${method}`, 8000);
  };
  const tool = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result.content[0].text;
    return r.result.isError ? { error: text } : JSON.parse(text);
  };
  return { rpc, tool, close: () => proc.stdin.end() };
}

test('nhóm phiên: lập nhóm, gán token vai trò, bắt đầu, trưởng nhóm giao việc theo vai trò, thành viên báo xong, nghiệm thu, báo đạt mục tiêu', async () => {
  const open = async (name) => {
    const r = await call('/api/sessions', { machineId: 'mA', name, cwd: WORK });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await waitFor(() => hub.sessions.get(r.data.id)?.snap.status === 'idle', `phiên ${name} sẵn sàng`);
    return r.data.id;
  };
  const lead = await open('Trưởng');
  const dev = await open('Dev');
  const userTurns = (sid) => hub.sessions.get(sid).buffer.filter((e) => e.t === 'user');

  const made = await call('/api/groups', { name: 'Game bắn tàu', goal: '' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const gid = made.data.id;
  await waitFor(() => sse.some((e) => e.type === 'group' && e.data.id === gid), 'app nhận nhóm mới qua SSE');

  assert.equal((await call(`/api/groups/${gid}/members`, { sessionId: lead, role: '$gd' })).status, 200);
  assert.equal(hub.groups.get(gid).leaderId, lead, 'phiên đầu tiên vào nhóm làm trưởng nhóm');
  const added = await call(`/api/groups/${gid}/members`, { sessionId: dev, role: 'code' });
  assert.deepEqual(added.data.members, [{ id: lead, role: 'gd' }, { id: dev, role: 'code' }], 'vai trò lưu theo tên token, nhận cả "$gd" lẫn "code"');
  const badRole = await call(`/api/groups/${gid}/role`, { sessionId: dev, role: '$c' });
  assert.notEqual(badRole.status, 200, '$c là lệnh chạy thẳng, không làm vai trò được');
  assert.match(badRole.data.error, /\$code/, 'lời báo kể các token làm được vai trò');

  // Mở phiên mới ngay trong nhóm, kèm vai trò.
  const art = await call('/api/sessions', { machineId: 'mA', name: 'Art', cwd: WORK, groupId: gid, role: '$env' });
  assert.equal(art.status, 200, JSON.stringify(art.data));
  await waitFor(() => hub.groups.get(gid).members.some((m) => m.id === art.data.id && m.role === 'env'), 'phiên mới vào nhóm với vai trò $env');
  const ghost = await call('/api/sessions', { machineId: 'mA', name: 'Lạc', cwd: WORK, groupId: 'khongco' });
  assert.notEqual(ghost.status, 200, 'nhóm không có thì không mở phiên');
  assert.ok(![...hub.sessions.values()].some((r) => r.snap.name === 'Lạc'), 'và không để lại phiên mồ côi');

  const noGoal = await call(`/api/groups/${gid}/start`, {});
  assert.notEqual(noGoal.status, 200);
  assert.match(noGoal.data.error, /mục tiêu/);
  assert.equal(userTurns(lead).length, 0, 'chưa bắt đầu thì chưa đẩy lượt nào vào phiên');

  await call(`/api/groups/${gid}/update`, { goal: 'Làm màn chơi đầu tiên của game bắn tàu.' });
  const started = await call(`/api/groups/${gid}/start`, {});
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.status, 'running');
  const brief = await waitFor(() => userTurns(lead).find((e) => e.from?.kind === 'group'), 'trưởng nhóm nhận mục tiêu');
  assert.match(brief.text, /^\[Orbit Remote\] Tin từ chủ dự án qua nhóm "Game bắn tàu"/);
  assert.match(brief.text, /Làm màn chơi đầu tiên/);
  assert.match(brief.text, /"Dev" \(mã \w+, máy MayA, .*vai trò \$code \(Viết và sửa mã nguồn\)/, 'trưởng nhóm thấy vai trò kèm ghi chú của token');
  assert.match(brief.text, /vai trò \$gd .* — trưởng nhóm/);
  assert.match(brief.text, /Bạn là bộ não của nhóm \(chạy Opus bản mới nhất\)/, 'trưởng nhóm biết mình là người nghiệm thu');
  assert.equal(hub.sessions.get(lead).snap.model, 'opus', 'Bắt đầu thì trưởng nhóm chạy Opus (bộ não)');
  assert.equal(userTurns(dev).length, 0, 'thành viên chỉ nhận lượt khi được giao việc');
  await waitFor(() => hub.sessions.get(dev).snap.status === 'stopped' && hub.sessions.get(art.data.id).snap.status === 'stopped', 'Bắt đầu thì thành viên dừng, chỉ trưởng nhóm chạy');
  assert.equal(hub.sessions.get(lead).snap.status, 'idle');
  assert.deepEqual(started.data.closed.sort(), ['Art', 'Dev'], 'trạm báo đã dừng phiên nào');

  const L = mcpAs(lead);
  const D = mcpAs(dev);
  await L.rpc('initialize', {});
  await D.rpc('initialize', {});
  const view = await D.tool('orbit_remote_group', { action: 'view' });
  assert.equal(view.you, 'thành viên');
  assert.equal(view.members.find((m) => m.self).role, '$code');
  assert.match((await D.tool('orbit_remote_group', { action: 'add_task', title: 'x' })).error, /Chỉ trưởng nhóm/);

  // Giao theo token vai trò: "$code" là đúng một thành viên.
  const t1 = await L.tool('orbit_remote_group', { action: 'add_task', title: 'Viết điều khiển tàu', detail: 'WASD, bắn bằng Space.', assignee: '$code' });
  assert.equal(t1.task.id, 'T1');
  assert.equal(t1.task.status, 'doing');
  assert.equal(t1.notified.ok, true, 'người được giao nhận tin ngay');
  assert.equal(t1.notified.ok, true);
  const job = await waitFor(() => userTurns(dev).find((e) => /giao việc T1/.test(e.text)), 'Dev nhận việc');
  assert.ok(RUNNING_SET.has(hub.sessions.get(dev).snap.status), 'được giao việc thì phiên đang dừng được mở lại');
  assert.equal(job.from.kind, 'session');
  assert.equal(job.from.id, lead);
  assert.match(job.text, /Vai trò của bạn trong nhóm là \$code/);
  assert.match(job.text, /Mục tiêu chung do chủ dự án đặt:\nLàm màn chơi đầu tiên/, 'lần giao đầu kèm mục tiêu chung');
  assert.match(job.text, /Tệp đặc tả của token \$code trên máy này: .*custom[\\/]tokens[\\/]code\.md/, 'kèm đường dẫn thật tới đặc tả token');

  assert.match((await D.tool('orbit_remote_group', { action: 'update_task', task: 'T1', status: 'done' })).error, /nghiệm thu là việc của trưởng nhóm/);
  const leadBefore = userTurns(lead).length;
  const rep = await D.tool('orbit_remote_group', { action: 'update_task', task: 't1', status: 'review', note: 'Đã chạy thử, tàu đi đủ bốn hướng.' });
  assert.equal(rep.notified.ok, true);
  assert.equal(rep.next.release, true, 'hết việc thì báo cho thành viên là phiên sẽ dừng');
  const review = await waitFor(() => userTurns(lead).slice(leadBefore).find((e) => /Việc T1 xong, chờ nghiệm thu/.test(e.text)), 'trưởng nhóm nhận tin chờ nghiệm thu');
  assert.match(review.text, /tàu đi đủ bốn hướng/);
  await waitFor(() => hub.sessions.get(dev).snap.status === 'stopped', 'bàn giao xong mà hết việc thì phiên Dev dừng');

  // Trả lại thì phiên Dev được mở lại và nhận việc kèm ghi chú.
  const devBefore = userTurns(dev).length;
  const ret = await L.tool('orbit_remote_group', { action: 'update_task', task: 'T1', status: 'doing', note: 'Thiếu giới hạn tàu trong khung màn.' });
  assert.equal(ret.notified.ok, true, JSON.stringify(ret.notified));
  const back = await waitFor(() => userTurns(dev).slice(devBefore).find((e) => /trả lại việc T1/.test(e.text)), 'Dev nhận việc bị trả lại');
  assert.match(back.text, /Thiếu giới hạn/);

  // Dev đang bận T1: việc thứ hai vào hàng chờ, không có lượt nào cho tới khi T1 xong.
  const t2 = await L.tool('orbit_remote_group', { action: 'add_task', title: 'Thêm kẻ địch', assignee: dev, model: 'haiku' });
  assert.equal(t2.task.status, 'queued');
  assert.equal(t2.notified.queued, true);
  assert.equal(t2.notified.position, 1);
  assert.ok(!userTurns(dev).some((e) => /giao việc T2/.test(e.text)), 'việc trong hàng chờ chưa đẩy lượt nào');
  const v2 = await L.tool('orbit_remote_group', { action: 'view' });
  assert.deepEqual(v2.members.find((m) => m.id === dev).queue, ['T2']);
  assert.equal(v2.members.find((m) => m.id === dev).current, 'T1');

  // Nhắn cả nhóm: chỉ tới thành viên đang chạy, không đánh thức phiên đang dừng.
  const all = await L.tool('orbit_remote_send', { to: '#group', text: 'Họp nhanh: nhớ commit theo việc.' });
  assert.deepEqual(all.delivered.map((x) => x.name), ['Dev'], 'Art đang dừng nên không bị đánh thức');
  assert.ok(hub.channel.some((c) => c.groupId === gid && /Họp nhanh/.test(c.text)), 'Kênh ghi tin của nhóm');

  // Dev xong T1: việc kế T2 tự tới, không nhắc lại mục tiêu, đúng model trưởng nhóm chọn cho việc.
  const rep2 = await D.tool('orbit_remote_group', { action: 'update_task', task: 'T1', status: 'review', note: 'Đã giới hạn.' });
  assert.equal(rep2.next.task, 'T2');
  const job2 = await waitFor(() => userTurns(dev).find((e) => /giao việc T2/.test(e.text)), 'Dev nhận việc thứ hai từ hàng chờ');
  assert.doesNotMatch(job2.text, /Mục tiêu chung/, 'mục tiêu chỉ gửi ở lần giao đầu');
  await waitFor(() => hub.sessions.get(dev).snap.model === 'haiku', 'phiên Dev đổi sang model trưởng nhóm chọn cho T2');

  await L.tool('orbit_remote_group', { action: 'update_task', task: 'T1', status: 'done' });
  // Việc đã xong bị mở lại lúc Dev đang bận T2: vào hàng chờ, tới lượt thì Dev nhận đúng lời "mở lại" kèm ghi chú.
  const devAfterDone = userTurns(dev).length;
  const reopened = await L.tool('orbit_remote_group', { action: 'update_task', task: 'T1', status: 'doing', note: 'QA thấy -0 chưa chuẩn hoá.' });
  assert.equal(reopened.notified.queued, true);
  await D.tool('orbit_remote_group', { action: 'update_task', task: 'T2', status: 'review', note: 'Có ba loại địch.' });
  const again1 = await waitFor(() => userTurns(dev).slice(devAfterDone).find((e) => /mở lại việc đã xong T1/.test(e.text)), 'Dev nhận việc bị mở lại');
  assert.match(again1.text, /-0 chưa chuẩn hoá/);
  await L.tool('orbit_remote_group', { action: 'update_task', task: 'T1', status: 'done' });
  await L.tool('orbit_remote_group', { action: 'update_task', task: 'T2', status: 'done' });
  await waitFor(() => hub.sessions.get(dev).snap.status === 'stopped', 'trưởng nhóm chốt việc cuối của Dev thì phiên Dev dừng');
  const fin = await L.tool('orbit_remote_group', { action: 'finish', summary: 'Màn đầu chơi được từ đầu tới cuối.' });
  assert.equal(fin.status, 'done');
  const g = hub.groups.get(gid);
  assert.equal(g.status, 'done');
  assert.equal(g.summary, 'Màn đầu chơi được từ đầu tới cuối.');
  await waitFor(() => sse.some((e) => e.type === 'group' && e.data.id === gid && e.data.status === 'done'), 'app thấy nhóm xong');
  assert.match((await L.tool('orbit_remote_group', { action: 'add_task', title: 'x' })).error, /chưa bắt đầu hoặc đã dừng/);
  L.close();
  D.close();

  // Lưu xuống đĩa và nạp lại: nhóm, vai trò và bảng việc còn nguyên.
  hub.saveNow();
  const g2 = new Hub().groups.get(gid);
  assert.deepEqual(g2.members.map((m) => m.role), ['gd', 'code', 'env']);
  assert.deepEqual(g2.tasks.map((t) => [t.id, t.status]), [['T1', 'done'], ['T2', 'done']]);

  // Kéo phiên sang nhóm khác: rời nhóm cũ. Nhóm không chạy thì xoá được.
  const other = await call('/api/groups', { name: 'Nhóm hai' });
  await call(`/api/groups/${other.data.id}/members`, { sessionId: art.data.id });
  assert.ok(!hub.groups.get(gid).members.some((m) => m.id === art.data.id), 'phiên chỉ ở một nhóm');
  assert.equal(hub.groups.get(other.data.id).leaderId, art.data.id);
  assert.equal((await call(`/api/groups/${other.data.id}/delete`, {})).status, 200);
  await waitFor(() => sse.some((e) => e.type === 'group_removed' && e.data.id === other.data.id), 'app thấy nhóm bị xoá');

  for (const sid of [lead, dev, art.data.id]) await call(`/api/sessions/${sid}/close`, {});
});

test('nhóm đang chạy: thêm phiên rồi chọn vai trò liền nhau thì trưởng nhóm chỉ nhận một lượt mang vai trò cuối; thêm rồi bỏ ngay thì không báo', async () => {
  const open = async (name) => {
    const r = await call('/api/sessions', { machineId: 'mA', name, cwd: WORK });
    await waitFor(() => hub.sessions.get(r.data.id)?.snap.status === 'idle', `phiên ${name} sẵn sàng`);
    return r.data.id;
  };
  const lead = await open('Trưởng 2');
  const qa = await open('Kiểm thử');
  const temp = await open('Tạm');
  const notices = () => hub.sessions.get(lead).buffer.filter((e) => e.t === 'user' && /cập nhật thành viên/.test(e.text));
  hub.groups.noticeMs = 150;
  try {
    const gid = (await call('/api/groups', { name: 'Nhóm hai', goal: 'Kiểm màn đầu.' })).data.id;
    await call(`/api/groups/${gid}/members`, { sessionId: lead, role: 'gd' });
    assert.equal((await call(`/api/groups/${gid}/start`, {})).status, 200);

    await call(`/api/groups/${gid}/members`, { sessionId: qa });
    await call(`/api/groups/${gid}/role`, { sessionId: qa, role: '$qa' });
    await waitFor(() => notices().length === 1, 'trưởng nhóm nhận tin thành viên mới');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(notices().length, 1, 'hai thay đổi liền nhau gom thành một lượt');
    assert.match(notices()[0].text, /Thành viên mới: "Kiểm thử" .*vai trò \$qa/, 'tin mang vai trò cuối cùng');

    await call(`/api/groups/${gid}/members`, { sessionId: temp });
    await call(`/api/groups/${gid}/remove`, { sessionId: temp });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(notices().length, 1, 'thêm rồi bỏ trước lúc báo thì không có tin nào');
    assert.ok(!hub.sessions.get(lead).buffer.some((e) => e.t === 'user' && /ra khỏi nhóm/.test(e.text)), 'cũng không báo bỏ phiên trưởng nhóm chưa từng biết');

    await call(`/api/groups/${gid}/stop`, {});
    assert.equal((await call(`/api/groups/${gid}/delete`, {})).status, 200);
  } finally {
    hub.groups.noticeMs = 8000;
    for (const sid of [lead, qa, temp]) await call(`/api/sessions/${sid}/close`, {});
  }
});

test('tạm dừng nhóm: cắt ngang ngay lượt đang chạy, chặn công cụ và tin trong nhóm, không báo ai; tiếp tục thì trưởng nhóm nhận lại tình hình, phiên bị cắt làm tiếp việc dở', async () => {
  const open = async (name) => {
    const r = await call('/api/sessions', { machineId: 'mA', name, cwd: WORK });
    await waitFor(() => hub.sessions.get(r.data.id)?.snap.status === 'idle', `phiên ${name} sẵn sàng`);
    return r.data.id;
  };
  const lead = await open('Trưởng 3');
  const dev = await open('Dev 3');
  const extra = await open('Phụ 3');
  const turns = (sid) => hub.sessions.get(sid).buffer.filter((e) => e.t === 'user');
  hub.groups.noticeMs = 150;
  const L = mcpAs(lead);
  const D = mcpAs(dev);
  try {
    const gid = (await call('/api/groups', { name: 'Nhóm ba', goal: 'Làm màn hai.' })).data.id;
    await call(`/api/groups/${gid}/members`, { sessionId: lead, role: 'gd' });
    await call(`/api/groups/${gid}/members`, { sessionId: dev, role: 'code' });
    assert.notEqual((await call(`/api/groups/${gid}/pause`, {})).status, 200, 'chưa chạy thì không tạm dừng được');
    await call(`/api/groups/${gid}/start`, {});
    await L.rpc('initialize', {});
    await D.rpc('initialize', {});
    await L.tool('orbit_remote_group', { action: 'add_task', title: 'Viết kẻ địch', assignee: dev });
    await waitFor(() => turns(dev).some((e) => /giao việc T1/.test(e.text)), 'Dev nhận việc');
    await waitFor(() => hub.sessions.get(dev).snap.status === 'idle', 'Dev xong lượt nhận việc');

    // Dev đang chạy một lượt dài đúng lúc chủ dự án bấm tạm dừng.
    await call(`/api/sessions/${dev}/send`, { text: 'SLEEP' });
    await waitFor(() => hub.sessions.get(dev).snap.status === 'busy', 'Dev đang bận');
    const paused = await call(`/api/groups/${gid}/pause`, {});
    assert.equal(paused.status, 200, JSON.stringify(paused.data));
    assert.equal(paused.data.status, 'paused');
    assert.deepEqual(paused.data.interrupted, [dev], 'chỉ phiên đang chạy lượt bị cắt ngang');
    await waitFor(() => hub.sessions.get(dev).buffer.some((e) => e.t === 'result' && e.cancelled), 'lượt của Dev bị cắt ngang ngay');
    const leadTurns = turns(lead).length;
    const devTurns = turns(dev).length;

    assert.match((await D.tool('orbit_remote_group', { action: 'update_task', task: 'T1', status: 'review', note: 'x' })).error, /đang tạm dừng/, 'công cụ nhóm từ chối sửa bảng việc');
    assert.ok((await D.tool('orbit_remote_group', { action: 'view' })).status === 'paused', 'vẫn xem được, thấy nhóm đang tạm dừng');
    assert.match((await L.tool('orbit_remote_send', { to: '#group', text: 'còn đó không' })).error, /đang tạm dừng/, 'không nhắn được cả nhóm');
    assert.match((await L.tool('orbit_remote_send', { to: dev, text: 'làm tiếp đi' })).error, /đang tạm dừng/, 'không nhắn riêng được trong nhóm');
    assert.match((await call(`/api/groups/${gid}/start`, {})).data.error, /Tiếp tục/, 'đang tạm dừng thì không Bắt đầu lại');

    // Chủ dự án sửa nhóm trong lúc tạm dừng: không đẩy lượt nào.
    await call(`/api/groups/${gid}/members`, { sessionId: extra, role: 'qa' });
    await call(`/api/groups/${gid}/update`, { goal: 'Làm màn hai, thêm trùm cuối.' });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(turns(lead).length, leadTurns, 'trưởng nhóm không nhận lượt nào lúc tạm dừng');
    assert.equal(turns(dev).length, devTurns, 'Dev không nhận lượt nào lúc tạm dừng');

    const resumed = await call(`/api/groups/${gid}/resume`, {});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
    assert.equal(resumed.data.status, 'running');
    assert.deepEqual(resumed.data.interrupted, []);
    const back = await waitFor(() => turns(lead).slice(leadTurns).find((e) => /chạy tiếp sau khi tạm dừng/.test(e.text)), 'trưởng nhóm nhận tin chạy tiếp');
    assert.match(back.text, /"Dev 3" \(T1\)/, 'biết Dev được báo làm tiếp T1');
    assert.match(back.text, /thêm trùm cuối/, 'nhận mục tiêu mới');
    assert.match(back.text, /"Phụ 3" .*vai trò \$qa/, 'thấy thành viên thêm lúc tạm dừng');
    const cont = await waitFor(() => turns(dev).slice(devTurns).find((e) => /làm tiếp việc dở T1/.test(e.text)), 'Dev nhận tin làm tiếp việc dở');
    assert.match(cont.text, /Tệp đặc tả của token \$code/);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!turns(lead).slice(leadTurns).some((e) => /cập nhật thành viên/.test(e.text)), 'không báo lại riêng thay đổi đã gộp vào tin chạy tiếp');

    // Tạm dừng rồi dừng hẳn: các phiên đã thôi làm, không tốn thêm lượt nào để báo dừng.
    await call(`/api/groups/${gid}/pause`, {});
    const l2 = turns(lead).length;
    const d2 = turns(dev).length;
    const stopped = await call(`/api/groups/${gid}/stop`, {});
    assert.equal(stopped.data.status, 'stopped');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(turns(lead).length, l2);
    assert.equal(turns(dev).length, d2);
    assert.equal((await call(`/api/groups/${gid}/delete`, {})).status, 200);
  } finally {
    L.close();
    D.close();
    hub.groups.noticeMs = 8000;
    for (const sid of [lead, dev, extra]) await call(`/api/sessions/${sid}/close`, {});
  }
});

test('bảng tin dụng cụ và chi phí nhóm: đăng ký, bận thì xếp hàng, trả thì người chờ được đăng ký và báo một lần, phiên dừng thì tự trả; chi phí cộng dồn qua các lần mở lại, chạm ngân sách thì trưởng nhóm được báo', async () => {
  const open = async (name) => {
    const r = await call('/api/sessions', { machineId: 'mA', name, cwd: WORK });
    await waitFor(() => hub.sessions.get(r.data.id)?.snap.status === 'idle', `phiên ${name} sẵn sàng`);
    return r.data.id;
  };
  const lead = await open('Trưởng 4');
  const art = await open('Art 4');
  const dev = await open('Dev 4');
  const turns = (sid) => hub.sessions.get(sid).buffer.filter((e) => e.t === 'user');
  const L = mcpAs(lead);
  const A = mcpAs(art);
  const B = mcpAs(dev);
  try {
    const gid = (await call('/api/groups', { name: 'Nhóm bốn', goal: 'Dựng cảnh đầu.' })).data.id;
    await call(`/api/groups/${gid}/members`, { sessionId: lead, role: 'gd' });
    await call(`/api/groups/${gid}/members`, { sessionId: art, role: 'env' });
    await call(`/api/groups/${gid}/members`, { sessionId: dev, role: 'code' });
    assert.equal((await call(`/api/groups/${gid}/update`, { budgetUsd: -1 })).status, 500, 'ngân sách âm bị từ chối');
    assert.equal((await call(`/api/groups/${gid}/update`, { budgetUsd: 0.04 })).data.budgetUsd, 0.04);
    await call(`/api/groups/${gid}/start`, {});
    for (const x of [L, A, B]) await x.rpc('initialize', {});
    await L.tool('orbit_remote_group', { action: 'add_task', title: 'Dựng cảnh', assignee: '$env' });
    await L.tool('orbit_remote_group', { action: 'add_task', title: 'Viết script', assignee: '$code' });
    await waitFor(() => turns(art).some((e) => /giao việc T1/.test(e.text)) && turns(dev).some((e) => /giao việc T2/.test(e.text)), 'hai thành viên nhận việc');
    assert.match(turns(art).find((e) => /giao việc T1/.test(e.text)).text, /Dụng cụ chỉ một phiên dùng được một lúc/, 'lần giao đầu kèm luật bảng tin dụng cụ');
    assert.match(turns(art).find((e) => /giao việc T1/.test(e.text)).text, /Tiết kiệm token/, 'và luật tiết kiệm token');

    // Bảng tin: trưởng nhóm giữ Unity, hai thành viên lần lượt xếp hàng.
    const tool = 'Unity Editor (MyGame)';
    assert.equal((await L.tool('orbit_remote_group', { action: 'claim_tool', tool, minutes: 20 })).ok, true);
    const busyA = await A.tool('orbit_remote_group', { action: 'claim_tool', tool: 'unity editor (mygame)' });
    assert.equal(busyA.ok, false, 'tên không phân biệt hoa thường');
    assert.equal(busyA.busy.by, 'Trưởng 4');
    assert.equal(busyA.queued, 1);
    assert.equal((await B.tool('orbit_remote_group', { action: 'claim_tool', tool })).queued, 2);
    let board = await B.tool('orbit_remote_group', { action: 'tools' });
    assert.deepEqual(board.inUse.map((e) => e.by), ['Trưởng 4']);
    assert.deepEqual(board.waiting.map((w) => w.by), ['Art 4', 'Dev 4']);
    const artBefore = turns(art).length;
    await L.tool('orbit_remote_group', { action: 'release_tool', tool });
    const handed = await waitFor(() => turns(art).slice(artBefore).find((e) => /đã được đăng ký cho bạn/.test(e.text)), 'Art nhận tin dụng cụ trống');
    assert.match(handed.text, /^\[Orbit Remote\] Bảng tin dụng cụ của nhóm "Nhóm bốn"/);
    board = await B.tool('orbit_remote_group', { action: 'tools' });
    assert.deepEqual(board.inUse.map((e) => e.by), ['Art 4'], 'dụng cụ chuyển thẳng cho người chờ đầu tiên');
    assert.deepEqual(board.waiting.map((w) => w.by), ['Dev 4']);
    // Phiên đang giữ dừng: dụng cụ tự trả, người chờ kế tiếp được đăng ký và báo.
    const devBefore = turns(dev).length;
    await call(`/api/sessions/${art}/close`, {});
    await waitFor(() => turns(dev).slice(devBefore).some((e) => /đã được đăng ký cho bạn/.test(e.text)), 'Dev nhận dụng cụ khi Art dừng');
    board = await L.tool('orbit_remote_group', { action: 'tools' });
    assert.deepEqual(board.inUse.map((e) => e.by), ['Dev 4']);
    assert.equal(board.waiting.length, 0);
    // Chủ dự án gỡ dòng trên bảng tin.
    const key = hub.groups.get(gid).tools[0].key;
    assert.equal((await call(`/api/groups/${gid}/free-tool`, { key })).data.tools.length, 0);

    // Chi phí: Claude giả tính 0,01 đô mỗi lượt. Cộng dồn qua lần mở lại (tiến trình mới đếm lại từ 0).
    await waitFor(() => (hub.groups.get(gid).cost[art] || 0) > 0 && (hub.groups.get(gid).cost[lead] || 0) > 0, 'chi phí của từng phiên được cộng');
    const artCost = hub.groups.get(gid).cost[art];
    await L.tool('orbit_remote_group', { action: 'update_task', task: 'T1', status: 'doing', note: 'Thêm cây.' });
    await waitFor(() => hub.groups.get(gid).cost[art] > artCost, 'Art mở lại, chi phí cộng tiếp chứ không đếm lại', 8000);
    const view = await L.tool('orbit_remote_group', { action: 'view' });
    assert.ok(view.cost.totalUsd >= 0.04, JSON.stringify(view.cost));
    assert.equal(view.cost.budgetUsd, 0.04);
    assert.ok(view.cost.perSession.find((p) => p.name === 'Art 4').usd >= 0.02, 'Art có ít nhất hai lượt từ hai lần mở');
    await waitFor(() => turns(lead).some((e) => /^\[Orbit Remote\] Ngân sách của nhóm "Nhóm bốn"/.test(e.text)), 'trưởng nhóm được báo về ngân sách');
    assert.ok(hub.groups.get(gid).budgetAlert >= 80);
    const alerts = turns(lead).filter((e) => /Ngân sách của nhóm/.test(e.text)).length;
    assert.ok(alerts <= 2, 'mỗi mốc báo một lần');

    // Thành viên chết giữa chừng: trưởng nhóm được báo; đặt lại "doing" thì phiên được mở lại và nhận lại đủ nội
    // dung việc. Dev chưa có nhật ký nên mở như phiên mới (Claude giả, như bản thật, thoát ngay nếu bị "--resume").
    await waitFor(() => hub.sessions.get(dev).snap.status === 'idle', 'Dev rảnh');
    const killed = agentA.sessions.get(dev);
    killed.proc.kill();
    await waitFor(() => turns(lead).some((e) => /Trạm của nhóm "Nhóm bốn"[\s\S]*"Dev 4" dừng giữa chừng khi đang làm T2/.test(e.text)), 'trưởng nhóm được báo Dev dừng giữa chừng');
    await L.tool('orbit_remote_group', { action: 'update_task', task: 'T2', status: 'doing' });
    await waitFor(() => agentA.sessions.get(dev) && agentA.sessions.get(dev) !== killed && /giao việc T2 cho bạn: Viết script/.test(turns(dev).at(-1)?.text || ''), 'Dev mở lại và nhận lại đủ việc');
    assert.equal(hub.sessions.get(dev).snap.claudeSessionId, killed.claudeSessionId, 'giữ nguyên mã phiên Claude');

    await call(`/api/groups/${gid}/stop`, {});
    assert.equal((await call(`/api/groups/${gid}/delete`, {})).status, 200);
  } finally {
    for (const x of [L, A, B]) x.close();
    for (const sid of [lead, art, dev]) await call(`/api/sessions/${sid}/close`, {});
  }
});

test('nhóm: việc "doing" của phiên đã dừng không chặn việc mới; ngữ cảnh lớn thì trưởng nhóm được nén, thành viên nhận việc mới được xoá sạch; tự nén, tự xoá kèm giữ tin; vỏ cũ được báo', async () => {
  // Nhóm lập từ bản trước còn nhiều việc "doing" của một người: nạp lại thì mỗi người một việc, còn lại vào hàng chờ.
  const { Groups } = await import('../src/groups.mjs');
  const loaded = new Groups({ sessions: new Map(), push() {}, scheduleSave() {} });
  loaded.load([{ id: 'g0', status: 'running', leaderId: 'a', members: [{ id: 'a' }, { id: 'b' }], tasks: [
    { id: 'T1', assignee: 'b', status: 'doing' }, { id: 'T2', assignee: 'b', status: 'doing' },
    { id: 'T3', assignee: 'a', status: 'doing' }, { id: 'T4', assignee: 'a', status: 'doing' }] }]);
  assert.deepEqual(loaded.get('g0').tasks.map((t) => `${t.id}:${t.status}${t.pendingKind ? `:${t.pendingKind}` : ''}`),
    ['T1:doing', 'T2:queued:assign', 'T3:doing', 'T4:doing'], 'thành viên giữ một việc, trưởng nhóm giữ nguyên');

  const open = async (name) => {
    const r = await call('/api/sessions', { machineId: 'mA', name, cwd: WORK });
    await waitFor(() => hub.sessions.get(r.data.id)?.snap.status === 'idle', `phiên ${name} sẵn sàng`);
    return r.data.id;
  };
  const lead = await open('Trưởng 5');
  const dev = await open('Dev 5');
  const qa = await open('QA 5');
  const turns = (sid) => hub.sessions.get(sid).buffer.filter((e) => e.t === 'user');
  const snap = (sid) => hub.sessions.get(sid).snap;
  const L = mcpAs(lead);
  const B = mcpAs(dev);
  try {
    const gid = (await call('/api/groups', { name: 'Nhóm năm', goal: 'Làm màn hai.' })).data.id;
    await call(`/api/groups/${gid}/members`, { sessionId: lead, role: 'gd' });
    await call(`/api/groups/${gid}/members`, { sessionId: dev, role: 'code' });
    await call(`/api/groups/${gid}/members`, { sessionId: qa, role: 'qa' });
    await call(`/api/groups/${gid}/start`, {});
    for (const x of [L, B]) await x.rpc('initialize', {});
    const g = hub.groups.get(gid);
    await waitFor(() => snap(dev).status === 'stopped' && snap(qa).status === 'stopped', 'thành viên dừng lúc bắt đầu');

    // Vỏ cũ (không gửi số bản) được báo một lần; vỏ mới thì không.
    const oldView = await hub.groups.action(lead, { action: 'view' });
    assert.match(oldView.warning || '', /bản cũ/);
    assert.equal((await hub.groups.action(lead, { action: 'view' })).warning, undefined, 'chỉ báo một lần');
    assert.equal((await L.tool('orbit_remote_group', { action: 'view' })).warning, undefined);

    // Kẹt như nhóm thật: QA đã dừng mà còn hai việc "doing". Giao việc mới thì QA được mở và làm ngay việc mới.
    g.tasks.push({ id: 'T90', title: 'Việc cũ một', assignee: qa, status: 'doing', note: '' }, { id: 'T91', title: 'Việc cũ hai', assignee: qa, status: 'doing', note: '' });
    const fresh = await L.tool('orbit_remote_group', { action: 'add_task', title: 'Kiểm màn hai', assignee: '$qa' });
    assert.equal(fresh.notified.ok, true, JSON.stringify(fresh));
    assert.equal(fresh.notified.queued, undefined, 'không vào hàng chờ sau việc của một phiên đã dừng');
    await waitFor(() => turns(qa).some((e) => /giao việc T1 cho bạn: Kiểm màn hai/.test(e.text)), 'QA được mở lại và nhận việc');
    assert.deepEqual(g.tasks.filter((t) => t.assignee === qa).map((t) => `${t.id}:${t.status}`), ['T90:queued', 'T91:queued', 'T1:doing']);

    // Trưởng nhóm có ngữ cảnh trên 120k: lúc rảnh thì trạm tự nén.
    await call(`/api/sessions/${lead}/send`, { text: 'BIGCTX' });
    await waitFor(() => turns(lead).some((e) => /^\/compact Giữ lại: mục tiêu/.test(e.text)), 'trạm tự nén ngữ cảnh trưởng nhóm');
    await waitFor(() => snap(lead).contextTokens === 6000 && snap(lead).status === 'idle', 'ngữ cảnh còn 6k sau khi nén');

    // Thành viên ngữ cảnh lớn nhận việc kế trong hàng chờ: xoá sạch rồi mới giao, lời giao kèm lại mục tiêu và luật.
    await L.tool('orbit_remote_group', { action: 'add_task', title: 'Viết màn hai', assignee: '$code' });
    await waitFor(() => turns(dev).some((e) => /giao việc T2 cho bạn/.test(e.text)) && snap(dev).status === 'idle', 'Dev nhận T2');
    await call(`/api/sessions/${dev}/send`, { text: 'BIGCTX' });
    await waitFor(() => snap(dev).contextTokens >= 150000 && snap(dev).status === 'idle', 'ngữ cảnh Dev lên 150k');
    assert.equal((await L.tool('orbit_remote_group', { action: 'add_task', title: 'Sửa lỗi màn hai', assignee: '$code' })).notified.queued, true);
    const oldClaudeId = snap(dev).claudeSessionId;
    const before = turns(dev).length;
    const rep = await B.tool('orbit_remote_group', { action: 'update_task', task: 'T2', status: 'review', note: 'Xong màn hai.' });
    assert.equal(rep.next.task, 'T3');
    const t3 = await waitFor(() => turns(dev).slice(before).find((e) => /giao việc T3 cho bạn: Sửa lỗi màn hai/.test(e.text)), 'Dev nhận T3 sau khi xoá ngữ cảnh');
    const after = turns(dev).slice(before).map((e) => e.text);
    assert.ok(after.indexOf('/clear') >= 0 && after.indexOf('/clear') < after.indexOf(t3.text), after.join(' | '));
    assert.match(t3.text, /Mục tiêu chung do chủ dự án đặt/, 'lời giao sau khi xoá kèm lại mục tiêu');
    assert.match(t3.text, /Ngữ cảnh: mỗi lượt Claude đọc lại toàn bộ ngữ cảnh/, 'và luật ngữ cảnh');
    assert.notEqual(snap(dev).claudeSessionId, oldClaudeId, 'Claude Code bắt đầu hội thoại mới');

    // Thành viên tự xoá ngữ cảnh giữa việc khi đang bận: tin nhóm tới trong lúc đó được giữ, đi sau lời nhắc lại việc.
    await waitFor(() => snap(dev).status === 'idle', 'Dev rảnh');
    await call(`/api/sessions/${dev}/send`, { text: 'SLEEP' });
    await waitFor(() => snap(dev).status === 'busy', 'Dev đang làm');
    const reset = await B.tool('orbit_remote_group', { action: 'reset', note: 'Đã sửa xong hai trong ba lỗi; còn lỗi nhảy cóc.' });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.match((await B.tool('orbit_remote_group', { action: 'compact' })).error || '', /đang nén hay xoá/);
    const held = await hub.groups.notify(g, dev, null, 'TIN GIỮ LẠI');
    assert.equal(held.held, true, 'tin tới lúc đang xoá ngữ cảnh được giữ');
    const mark = turns(dev).length;
    await hub.interrupt(dev);
    const tail = await waitFor(() => {
      const list = turns(dev).slice(mark).map((e) => e.text);
      return list.some((t) => t.includes('TIN GIỮ LẠI')) && list;
    }, 'tin giữ lại tới sau cùng');
    const iClear = tail.indexOf('/clear');
    const iCarry = tail.findIndex((t) => /Ghi chú bạn để lại trước khi xoá:[\s\S]*lỗi nhảy cóc[\s\S]*Việc bạn đang làm dở: T3/.test(t));
    const iHeld = tail.findIndex((t) => t.includes('TIN GIỮ LẠI'));
    assert.ok(iClear >= 0 && iClear < iCarry && iCarry < iHeld, tail.join(' | '));

    // Trưởng nhóm tự nén kèm việc làm tiếp.
    await waitFor(() => snap(lead).status === 'idle', 'trưởng nhóm rảnh');
    const leadMark = turns(lead).length;
    assert.equal((await L.tool('orbit_remote_group', { action: 'compact', focus: 'Giữ kế hoạch màn hai', then: 'Xem bảng việc rồi giao tiếp.' })).ok, true);
    await waitFor(() => {
      const list = turns(lead).slice(leadMark).map((e) => e.text);
      return list.includes('/compact Giữ kế hoạch màn hai') && list.some((t) => /Ngữ cảnh đã được nén theo yêu cầu của bạn\. Xem bảng việc rồi giao tiếp\./.test(t));
    }, 'trưởng nhóm nén rồi nhận lời làm tiếp');

    const view = await L.tool('orbit_remote_group', { action: 'view' });
    assert.match(view.members.find((m) => m.name === 'Dev 5').context || '', /k token$/, 'view có cỡ ngữ cảnh');
    await call(`/api/groups/${gid}/stop`, {});
    assert.equal((await call(`/api/groups/${gid}/delete`, {})).status, 200);
  } finally {
    for (const x of [L, B]) x.close();
    for (const sid of [lead, dev, qa]) await call(`/api/sessions/${sid}/close`, {});
  }
});

test('chuyển phiên sang máy khác: kiểm trước, commit tạm phần sửa dở rồi đẩy, máy đích kéo về, chép nhật ký nhiều khúc, mở lại cùng phiên ở máy đích; push bị chặn thì gỡ commit tạm', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, readFileSync, existsSync, readdirSync } = await import('node:fs');
  const { projectDirName } = await import('../src/move-node.mjs');
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const ident = (cwd) => { g(cwd, 'config', 'user.name', 'Orbit Test'); g(cwd, 'config', 'user.email', 'test@orbit.local'); };
  // Kho chung (bare), máy A làm trong một bản clone, máy B trong bản clone khác.
  const bare = join(ROOT, 'kho-chung.git');
  const dirA = join(ROOT, 'may-a', 'GameQuangCao');
  const dirB = join(ROOT, 'may-b', 'GameQuangCao');
  mkdirSync(dirA, { recursive: true });
  g(ROOT, 'init', '--bare', '-b', 'main', bare);
  g(dirA, 'init', '-b', 'main');
  ident(dirA);
  writeFileSync(join(dirA, 'game.js'), 'export const ten = "Game";\n');
  g(dirA, 'add', '-A');
  g(dirA, 'commit', '-m', 'khởi tạo');
  g(dirA, 'remote', 'add', 'origin', bare);
  g(dirA, 'push', '-u', 'origin', 'main');
  g(ROOT, 'clone', bare, dirB);
  ident(dirB);

  // Máy đích riêng của phép kiểm (các phép kiểm trước có thể đã quên máy B).
  const agentC = new NodeAgent({ machineId: 'mC', machineName: 'MayC', claudeCommand: FAKE, pipePath: pipeName() });
  await agentC.startPipe();
  const connC = hub.attachMachine({ send: (m) => queueMicrotask(() => agentC.handle(m)) }, { local: false });
  agentC.attach((m) => queueMicrotask(() => connC.receive(m)));
  await waitFor(() => hub.machines.get('mC')?.online, 'máy C nối vào trạm');

  const made = await call('/api/sessions', { machineId: 'mA', name: 'Xem quảng cáo', cwd: dirA });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.id;
  await waitFor(() => hub.sessions.get(id)?.snap.status === 'idle', 'phiên ở máy A sẵn sàng');
  const claudeId = hub.sessions.get(id).snap.claudeSessionId;
  // Nhật ký Claude Code giả lớn hơn 1 MB: phải đi qua nhiều khúc 512 KB.
  const projects = process.env.ORBIT_REMOTE_PROJECTS;
  mkdirSync(join(projects, projectDirName(dirA)), { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd: dirA, sessionId: claudeId, message: { role: 'user', content: 'x'.repeat(900) } });
  const transcript = `${Array.from({ length: 1400 }, () => line).join('\n')}\n`;
  writeFileSync(join(projects, projectDirName(dirA), `${claudeId}.jsonl`), transcript);
  // Phần đang sửa dở ở máy A: một file sửa, một file mới.
  writeFileSync(join(dirA, 'game.js'), 'export const ten = "Game";\nexport const quangCao = true;\n');
  writeFileSync(join(dirA, 'quang-cao.js'), 'export function xemQuangCao() { return 30; }\n');

  const target = { machineId: 'mC', cwd: dirB };
  const missing = await call(`/api/sessions/${id}/move-check`, { machineId: 'mC', cwd: join(ROOT, 'khong-co') });
  assert.equal(missing.data.ok, false);
  assert.match(missing.data.blockers.join(' '), /không có trên máy MayC/);
  writeFileSync(join(dirB, 'nhap.txt'), 'dở');
  const dirtyB = await call(`/api/sessions/${id}/move-check`, target);
  assert.match(dirtyB.data.blockers.join(' '), /1 file chưa commit/, 'máy đích có thay đổi chưa commit thì không cho chuyển');
  rmSync(join(dirB, 'nhap.txt'));
  const plan = await call(`/api/sessions/${id}/move-check`, target);
  assert.equal(plan.data.ok, true, JSON.stringify(plan.data));
  assert.ok(plan.data.steps.some((s) => /Commit tạm 2 file/.test(s)), JSON.stringify(plan.data.steps));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dirA, encoding: 'utf8' }).trim().split('\n').length, 2, 'kiểm trước không đổi gì');

  const started = await call(`/api/sessions/${id}/move`, target);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const end = await waitFor(() => sse.find((e) => e.type === 'move' && e.data.id === id && (e.data.state === 'done' || e.data.state === 'failed')), 'chuyển xong', 30000);
  assert.equal(end.data.state, 'done', end.data.text);
  const steps = sse.filter((e) => e.type === 'move' && e.data.id === id && e.data.stepState === 'ok').map((e) => e.data.step);
  assert.deepEqual(steps, ['check', 'close', 'push', 'pull', 'transcript', 'open'], 'đủ các bước, đúng thứ tự');

  assert.equal(g(dirA, 'status', '--porcelain'), '', 'máy A sạch sau commit tạm');
  assert.match(g(dirB, 'log', '-1', '--format=%s'), /^WIP: chuyển phiên "Xem quảng cáo" từ máy MayA sang máy MayC/);
  assert.equal(g(dirB, 'rev-parse', 'HEAD'), g(dirA, 'rev-parse', 'HEAD'), 'máy B ở đúng commit máy A vừa đẩy');
  assert.match(readFileSync(join(dirB, 'quang-cao.js'), 'utf8'), /xemQuangCao/, 'file mới ở máy A đã sang máy B');
  const moved = join(projects, projectDirName(dirB), `${claudeId}.jsonl`);
  assert.equal(readFileSync(moved, 'utf8'), transcript, 'nhật ký sang đủ từng byte qua nhiều khúc');
  const copies = readdirSync(projects).filter((d) => existsSync(join(projects, d, `${claudeId}.jsonl`)));
  assert.deepEqual(copies, [projectDirName(dirB)], 'chỉ còn một bản nhật ký, ở chỗ của máy đích');

  const snap = await waitFor(() => { const s = hub.sessions.get(id).snap; return s.machineId === 'mC' && s.status === 'idle' && s; }, 'phiên chạy ở máy C', 10000);
  assert.equal(snap.cwd, dirB);
  assert.equal(snap.claudeSessionId, claudeId, 'cùng phiên Claude Code');
  assert.equal(snap.movedFrom.machine, 'MayA');
  assert.match(agentC.sessions.get(id).appendSystemPrompt, /đã được chuyển từ máy MayA .*sang máy MayC, thư mục .*GameQuangCao/, 'lời dặn hệ thống nói rõ chỗ làm việc mới');
  assert.equal(agentA.sessions.has(id), false, 'máy A không còn giữ phiên');
  await call(`/api/sessions/${id}/send`, { text: 'làm tiếp' });
  await waitFor(() => hub.sessions.get(id).buffer.some((e) => e.t === 'text' && /làm tiếp/.test(e.text)), 'phiên ở máy C trả lời');

  // Hook trước push của kho chặn: gỡ commit tạm, máy A như trước, phiên vẫn thuộc máy A.
  const two = (await call('/api/sessions', { machineId: 'mA', name: 'Phiên hai', cwd: dirA })).data.id;
  await waitFor(() => hub.sessions.get(two)?.snap.status === 'idle', 'phiên hai sẵn sàng');
  writeFileSync(join(dirA, 'dang-lam.js'), 'export const dangLam = 1;\n');
  writeFileSync(join(dirA, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho "kho chặn để thử" >&2\nexit 1\n');
  const headBefore = g(dirA, 'rev-parse', 'HEAD');
  assert.equal((await call(`/api/sessions/${two}/move`, target)).status, 200);
  const fail2 = await waitFor(() => sse.find((e) => e.type === 'move' && e.data.id === two && (e.data.state === 'done' || e.data.state === 'failed')), 'lần chuyển bị chặn kết thúc', 30000);
  assert.equal(fail2.data.state, 'failed');
  assert.match(fail2.data.text, /git push hỏng \(đã gỡ commit tạm/);
  assert.match(fail2.data.text, /kho chặn để thử/, 'lời hook báo được chuyển nguyên văn');
  assert.equal(g(dirA, 'rev-parse', 'HEAD'), headBefore, 'commit tạm đã gỡ');
  assert.match(g(dirA, 'status', '--porcelain'), /dang-lam\.js/, 'phần sửa dở vẫn còn ở máy A');
  assert.equal(hub.sessions.get(two).snap.machineId, 'mA', 'phiên vẫn thuộc máy A');
  assert.equal((await call(`/api/sessions/${two}/resume`, {})).status, 200, 'chạy lại ở máy A được');
  rmSync(join(dirA, '.git', 'hooks', 'pre-push'));
  for (const sid of [id, two]) await call(`/api/sessions/${sid}/close`, {});
  await waitFor(() => hub.sessions.get(id).snap.status === 'stopped', 'phiên ở máy C đóng');
  agentC.shutdown();
  connC.disconnect();
});
