// Bản mới nhất của từng dòng model (src/models.mjs) và việc phiên Claude thật sự chạy bản đó: chọn từ danh sách
// của máy chủ, ghi bảng, đổi tên dòng ra mã đầy đủ khi mở phiên và khi đổi model, báo đúng bản đang chạy.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'orbit-models-test-'));
process.env.ORBIT_REMOTE_STATE = join(ROOT, 'state');
process.env.ORBIT_REMOTE_PROJECTS = join(ROOT, 'projects');
mkdirSync(process.env.ORBIT_REMOTE_PROJECTS, { recursive: true });
const TABLE = join(ROOT, 'models.json');
process.env.ORBIT_MODELS_FILE = TABLE;

const { pickLatest, modelName, resolveModel, modelTable, refreshModels, modelsView, PINNED_FILE } = await import('../src/models.mjs');
const { ClaudeSession } = await import('../src/claude-session.mjs');

// Claude giả có thể chưa thoát hẳn (Windows không cho xoá thư mục đang là chỗ làm việc của nó): chờ một chút, xoá
// không được thì để hệ điều hành dọn sau.
after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // còn tiến trình con giữ thư mục
  }
});

// Đúng hình dạng danh sách máy chủ trả ngày 2026-11-03 (rút gọn), cố ý xáo thứ tự.
const LIST = [
  { id: 'claude-opus-5', created_at: '2026-07-24T00:00:00Z', display_name: 'Claude Opus 5' },
  { id: 'claude-haiku-5-5', created_at: '2026-10-07T18:00:00Z', display_name: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', created_at: '2026-10-30T00:00:00Z', display_name: 'Claude Fable 5.1' },
  { id: 'claude-sonnet-5', created_at: '2026-06-29T00:00:00Z', display_name: 'Claude Sonnet 5' },
  { id: 'claude-opus-5-5', created_at: '2026-09-21T16:24:00Z', display_name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', created_at: '2026-09-28T00:00:00Z', display_name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-4-5-20251001', created_at: '2025-10-15T00:00:00Z', display_name: 'Claude Haiku 4.5' },
];

test('chọn bản mới nhất: theo ngày ra mắt của từng dòng, không lấy Fable dù Fable mới hơn; thiếu một dòng thì không chọn', () => {
  const best = pickLatest(LIST);
  assert.deepEqual(Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.id])), { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' });
  assert.equal(best.haiku.name, 'Claude Haiku 5.5');
  assert.equal(pickLatest(LIST.filter((m) => !m.id.includes('haiku'))), null);
  assert.equal(pickLatest(null), null);
});

test('tên hiện trên app: "Opus 5.5", "Haiku 4.5", "Sonnet 5"; đuôi ngày và đuôi [1m] không lọt vào số bản', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelName('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelName('claude-opus-5-20260724'), 'Opus 5');
  assert.equal(modelName('claude-opus-5-5[1m]'), 'Opus 5.5');
});

test('đổi tên dòng ra mã đầy đủ: bảng máy tự hỏi thắng bản ghi sẵn trong kho; mã đầy đủ hay rỗng giữ nguyên', () => {
  rmSync(TABLE, { force: true });
  const pinned = JSON.parse(readFileSync(PINNED_FILE, 'utf8')).models;
  assert.equal(modelTable().source, 'pinned');
  assert.equal(resolveModel('opus'), pinned.opus.id, 'chưa hỏi được máy chủ thì dùng bản ghi sẵn');
  writeFileSync(TABLE, JSON.stringify({ at: 'x', models: { opus: { id: 'claude-opus-9-9' }, sonnet: { id: 'claude-sonnet-9-9' }, haiku: { id: 'claude-haiku-9-9' } } }));
  assert.equal(resolveModel('Haiku'), 'claude-haiku-9-9');
  assert.equal(resolveModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(resolveModel(''), '');
  // Bảng hỏng (thiếu dòng, mã lạ) thì không dùng.
  writeFileSync(TABLE, JSON.stringify({ models: { opus: { id: 'gpt-x' } } }));
  assert.equal(modelTable().source, 'pinned');
  assert.deepEqual(modelsView().families.map((f) => f.label), ['opus', 'sonnet', 'haiku'].map((f) => modelName(pinned[f].id)));
});

test('hỏi máy chủ: dùng đăng nhập Claude Code, ghi bảng mới; mã hết hạn hay máy chủ lỗi thì không ghi gì và nói rõ', async () => {
  rmSync(TABLE, { force: true });
  const creds = join(ROOT, 'creds.json');
  writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-123', expiresAt: Date.now() + 3600e3 } }));
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, headers: opts.headers };
    return { ok: true, json: async () => ({ data: LIST }) };
  };
  const r = await refreshModels({ fetchImpl, credentialsFile: creds });
  assert.equal(r.ok, true);
  assert.match(seen.url, /\/v1\/models/);
  assert.equal(seen.headers.Authorization, 'Bearer tok-123');
  assert.equal(seen.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(modelTable().source, 'api');
  assert.equal(resolveModel('sonnet'), 'claude-sonnet-5-5');
  assert.doesNotMatch(readFileSync(TABLE, 'utf8'), /tok-123/, 'mã đăng nhập không bao giờ nằm trong bảng');

  const before = readFileSync(TABLE, 'utf8');
  writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'old', expiresAt: Date.now() - 1000 } }));
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const expired = await refreshModels({ fetchImpl: () => assert.fail('không được gọi máy chủ'), credentialsFile: creds });
    assert.equal(expired.ok, false);
    writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-123', expiresAt: Date.now() + 3600e3 } }));
    const down = await refreshModels({ fetchImpl: async () => ({ ok: false, status: 503 }), credentialsFile: creds });
    assert.match(down.error, /503/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
  assert.equal(readFileSync(TABLE, 'utf8'), before, 'lỗi thì giữ nguyên bảng cũ');
});

async function waitFor(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Hết giờ chờ: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('phiên Claude: mở bằng tên dòng thì chạy bản mới nhất, đổi model giữa chừng cũng vậy; app thấy đúng bản đang chạy', async () => {
  writeFileSync(TABLE, JSON.stringify({ at: 'x', models: { opus: { id: 'claude-opus-9-9' }, sonnet: { id: 'claude-sonnet-9-9' }, haiku: { id: 'claude-haiku-9-9' } } }));
  const work = join(ROOT, 'work');
  mkdirSync(work, { recursive: true });
  const s = new ClaudeSession({ cwd: work, claudeCommand: [process.execPath, join(HERE, 'fake-claude.mjs')], name: 'm', model: 'haiku' });
  const events = [];
  s.on('event', (e) => events.push(e));
  s.start();
  try {
    await waitFor(() => s.status === 'idle', 'phiên sẵn sàng');
    s.send('xin chào');
    await waitFor(() => events.some((e) => e.t === 'result'), 'lượt đầu');
    assert.equal(s.snapshot().model, 'haiku', 'phiên vẫn nhớ dòng đã chọn');
    assert.equal(s.snapshot().activeModel, 'claude-haiku-9-9', 'Claude Code chạy đúng bản mới nhất của dòng');
    await s.setModel('sonnet');
    assert.equal(s.snapshot().activeModel, 'claude-sonnet-9-9');
    assert.ok(events.some((e) => e.t === 'system' && e.text === 'Đã đổi model sang Sonnet 9.9 (claude-sonnet-9-9).'));
    s.send('lượt hai');
    await waitFor(() => events.filter((e) => e.t === 'result').length === 2, 'lượt hai');
    assert.equal(s.snapshot().activeModel, 'claude-sonnet-9-9', 'lượt trả lời mang đúng mã model mới');
  } finally {
    s.close();
  }
});

test('nút cập nhật bản model: trạm hỏi máy chủ một lần, phát bảng xuống mọi máy, phiên đang chạy chuyển sang bản mới', async () => {
  const { Hub } = await import('../src/hub.mjs');
  const { NodeAgent } = await import('../src/node-agent.mjs');
  const { randomBytes } = await import('node:crypto');
  writeFileSync(TABLE, JSON.stringify({ at: 'cũ', models: { opus: { id: 'claude-opus-9-9' }, sonnet: { id: 'claude-sonnet-9-9' }, haiku: { id: 'claude-haiku-9-9' } } }));
  const hub = new Hub({ stateDir: join(ROOT, 'hub') });
  const agent = new NodeAgent({
    machineId: 'mM', machineName: 'MayModel', stateDir: join(ROOT, 'agent'), claudeCommand: [process.execPath, join(HERE, 'fake-claude.mjs')],
    pipePath: process.platform === 'win32' ? `\\\\.\\pipe\\orbit-models-test-${randomBytes(4).toString('hex')}` : join(ROOT, 'p.sock'),
  });
  await agent.startPipe();
  const conn = hub.attachMachine({ send: (m) => queueMicrotask(() => agent.handle(m)) }, { local: true });
  agent.attach((m) => queueMicrotask(() => conn.receive(m)));
  try {
    await waitFor(() => hub.machines.get('mM')?.online, 'đầu máy nối trạm');
    const work = join(ROOT, 'work2');
    mkdirSync(work, { recursive: true });
    const snap = await hub.createSession('mM', { name: 'H', cwd: work, model: 'haiku', permissionMode: 'bypassPermissions' });
    await waitFor(() => hub.sessions.get(snap.id).snap.status === 'idle', 'phiên sẵn sàng');
    await hub.sendToSession(snap.id, 'xin chào', null);
    await waitFor(() => hub.sessions.get(snap.id).snap.activeModel === 'claude-haiku-9-9', 'phiên chạy bản cũ của bảng');

    const creds = join(ROOT, 'creds2.json');
    writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: Date.now() + 3600e3 } }));
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ data: LIST }) };
    };
    const pushed = [];
    hub.on('push', (type, data) => { if (type === 'models') pushed.push(data); });
    const r = await hub.updateModels({ fetchImpl, credentialsFile: creds });
    assert.equal(calls, 1, 'chỉ hỏi máy chủ Anthropic đúng một lần cho mọi máy');
    assert.deepEqual(r.families.map((f) => f.label), ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
    assert.deepEqual(r.machines, [{ name: 'MayModel', ok: true }]);
    assert.equal(r.switched, 1);
    assert.equal(pushed.length, 1, 'app đang mở nhận bảng mới');
    await waitFor(() => hub.sessions.get(snap.id).snap.activeModel === 'claude-haiku-5-5', 'phiên đang chạy chuyển sang bản mới');
    assert.equal(hub.sessions.get(snap.id).snap.model, 'haiku');

    // Máy chủ lỗi: báo rõ, không đụng bảng đang dùng.
    await assert.rejects(hub.updateModels({ fetchImpl: async () => ({ ok: false, status: 500 }), credentialsFile: creds }), /500/);
    assert.equal(resolveModel('haiku'), 'claude-haiku-5-5');
  } finally {
    agent.shutdown();
  }
});
