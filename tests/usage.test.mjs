// Kiểm mức dùng Claude (src/usage.mjs, Hub.usage): đọc đúng câu trả lời có dạng như máy chủ Claude trả
// thật (lấy ngày 2026-10-30 trên máy mini, đã bỏ bớt trường không dùng), các trường hợp chưa đăng nhập,
// mã hết hạn, bị từ chối, nhớ 60 giây; trạm gộp theo tài khoản. Không gọi máy chủ Claude thật.
// Token tuần của từng máy (claude-tokens.mjs, token-book.mjs, NodeAgent): đếm từ nhật ký giả có dòng lặp,
// dòng trước mốc, dòng ghi dở; trạm cộng số các máy, giữ số máy đã tắt, ước số còn lại theo phần trăm tuần.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORBIT_REMOTE_STATE = mkdtempSync(join(tmpdir(), 'orbit-usage-test-'));
process.env.ORBIT_REMOTE_PROJECTS = mkdtempSync(join(tmpdir(), 'orbit-usage-projects-'));
const { parseUsage, parseWeek, readClaudeUsage } = await import('../src/usage.mjs');
const { Hub } = await import('../src/hub.mjs');
const { TokenCounter } = await import('../src/claude-tokens.mjs');
const { TokenBook } = await import('../src/token-book.mjs');
const { NodeAgent } = await import('../src/node-agent.mjs');

const REAL = {
  five_hour: { utilization: 9.0, resets_at: '2026-10-30T07:20:00.136271+00:00' },
  seven_day: { utilization: 5.0, resets_at: '2026-10-31T15:00:00.136292+00:00' },
  seven_day_opus: null,
  limits: [
    { kind: 'session', group: 'session', percent: 9, severity: 'normal', resets_at: '2026-10-30T07:20:00.136271+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 5, severity: 'normal', resets_at: '2026-10-31T15:00:00.136292+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: '2026-10-31T15:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
};

test('đọc usage: dùng danh sách hạn mức (phiên 5 giờ, tuần, tuần riêng theo model) kèm giờ reset; máy chủ cũ thì lấy five_hour và seven_day', () => {
  assert.deepEqual(parseUsage(REAL), [
    { kind: 'session', label: 'Phiên 5 giờ', percent: 9, resetsAt: '2026-10-30T07:20:00.000Z', severity: 'normal' },
    { kind: 'weekly_all', label: 'Tuần, mọi model', percent: 5, resetsAt: '2026-10-31T15:00:00.000Z', severity: 'normal' },
    { kind: 'weekly_scoped', label: 'Tuần, Fable', percent: 0, resetsAt: '2026-10-31T15:00:00.000Z', severity: 'normal' },
  ]);
  const old = parseUsage({ five_hour: REAL.five_hour, seven_day: REAL.seven_day });
  assert.deepEqual(old.map((l) => [l.label, l.percent]), [['Phiên 5 giờ', 9], ['Tuần, mọi model', 5]]);
  assert.equal(parseUsage({ limits: [{ kind: 'session', percent: 140 }] })[0].percent, 100, 'phần trăm lạ bị kẹp trong 0..100');
  assert.deepEqual(parseUsage(null), []);
});

test('đọc usage trên máy: chưa đăng nhập, mã hết hạn, bị từ chối đều báo rõ và không gọi máy chủ khi không cần; gọi được thì nhớ 60 giây; mã không bao giờ nằm trong kết quả', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-claude-'));
  const creds = join(dir, '.credentials.json');
  const profile = join(dir, '.claude.json');
  writeFileSync(profile, JSON.stringify({ oauthAccount: { accountUuid: 'acc-1', emailAddress: 'ban@vidu.vn' } }));
  let now = Date.parse('2026-10-30T05:00:00Z');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return { ok: true, status: 200, json: async () => REAL };
  };
  const read = (opts = {}) => readClaudeUsage({ fetchImpl, now: () => now, credentialsFile: creds, profileFile: profile, fresh: true, ...opts });

  const none = await read();
  assert.equal(none.reason, 'nologin');
  writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-bimat', expiresAt: now - 1000, subscriptionType: 'max' } }));
  const expired = await read();
  assert.equal(expired.reason, 'expired');
  assert.match(expired.error, /mở Claude Code/);
  assert.equal(calls.length, 0, 'chưa đăng nhập hay mã hết hạn thì không gọi máy chủ');

  writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-bimat', expiresAt: now + 3600000, subscriptionType: 'max' } }));
  const ok = await read();
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0].auth, 'Bearer sk-ant-oat-bimat');
  assert.deepEqual(ok.account, { id: 'acc-1', label: 'ban@vidu.vn' });
  assert.equal(ok.plan, 'max');
  assert.equal(ok.limits.length, 3);
  assert.ok(!JSON.stringify(ok).includes('bimat'), 'mã đăng nhập không nằm trong kết quả gửi đi');

  now += 30000;
  await read({ fresh: false });
  assert.equal(calls.length, 1, 'trong 60 giây dùng lại kết quả vừa hỏi');
  now += 40000;
  await read({ fresh: false });
  assert.equal(calls.length, 2, 'quá 60 giây thì hỏi lại');

  const denied = await read({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.equal(denied.reason, 'http401');
  assert.match(denied.error, /đăng nhập lại/);
});

test('trạm gộp usage theo tài khoản: hai máy cùng tài khoản là một dòng kèm tên cả hai máy; máy chưa đăng nhập hay đầu máy bản cũ thì bỏ qua; lỗi của tài khoản khác thì báo', async () => {
  const hub = new Hub({ stateDir: mkdtempSync(join(tmpdir(), 'orbit-usage-hub-')) });
  const answers = {
    m1: { ok: true, data: { account: { id: 'acc-1', label: 'ban@vidu.vn' }, plan: 'max', limits: parseUsage(REAL), at: '2026-10-30T05:00:00.000Z' } },
    m2: { ok: true, data: { account: { id: 'acc-1', label: 'ban@vidu.vn' }, plan: 'max', limits: parseUsage(REAL), at: '2026-10-30T05:01:00.000Z' } },
    m3: { ok: true, data: { error: 'chưa đăng nhập', reason: 'nologin', account: { id: '', label: '' } } },
    m4: { ok: false, error: 'Đầu máy không hiểu lệnh usage.' },
    m5: { ok: true, data: { error: 'Mã đăng nhập Claude trên máy này đã hết hạn', reason: 'expired', account: { id: 'acc-2', label: 'congty@vidu.vn' } } },
    m6: { ok: true, data: { error: 'Máy chủ Claude trả mã 500.', reason: 'http500', account: { id: 'acc-1', label: 'ban@vidu.vn' } } },
  };
  for (const [id, a] of Object.entries(answers)) {
    let receive;
    const link = { send: (m) => { if (m.op === 'usage') queueMicrotask(() => receive({ op: 'reply', rid: m.rid, ...a })); }, close() {} };
    ({ receive } = hub.attachMachine(link, {}));
    receive({ op: 'hello', machine: { id, name: `Máy ${id}`, platform: 'win32' }, sessions: [] });
  }
  const r = await hub.usage();
  assert.equal(r.accounts.length, 1);
  assert.deepEqual(r.accounts[0].machines, ['Máy m1', 'Máy m2']);
  assert.equal(r.accounts[0].at, '2026-10-30T05:01:00.000Z', 'lấy kết quả mới nhất của tài khoản');
  assert.equal(r.accounts[0].label, 'ban@vidu.vn');
  assert.deepEqual(r.problems.map((p) => p.machine), ['Máy m5'], 'chỉ báo lỗi của tài khoản chưa lấy được từ máy nào (m6 cùng tài khoản acc-1 đã có số)');
});

test('đọc tuần usage: mốc bắt đầu từ seven_day_breakdown, phần của Claude Code; mốc làm tròn tới phút; máy chủ không chia thì lùi 7 ngày từ giờ reset', () => {
  const body = {
    ...REAL,
    seven_day_breakdown: {
      window_started_at: '2026-10-24T15:00:00.034257+00:00',
      rows: [{ key: 'claude_code', percent: 82 }, { key: 'chat', percent: 18 }],
    },
  };
  assert.deepEqual(parseWeek(body), { startedAt: '2026-10-24T15:00:00.000Z', resetsAt: '2026-10-31T15:00:00.000Z', percent: 5, claudeCodeShare: 82 });
  // Cùng một giờ reset mà mỗi lần hỏi lệch chút ít (đo thật: 14:59:59.951): mốc vẫn y nguyên, giờ hiện ra vẫn tròn phút.
  const jitter = { ...REAL, limits: REAL.limits.map((l) => (l.kind === 'weekly_all' ? { ...l, resets_at: '2026-10-31T14:59:59.951+00:00' } : l)) };
  assert.deepEqual(parseWeek(jitter), { startedAt: '2026-10-24T15:00:00.000Z', resetsAt: '2026-10-31T15:00:00.000Z', percent: 5, claudeCodeShare: null });
  assert.equal(parseUsage(jitter)[1].resetsAt, '2026-10-31T15:00:00.000Z');
  assert.equal(parseWeek({ five_hour: REAL.five_hour }), null, 'không có hạn mức tuần thì không có tuần');
});

const SINCE = '2026-10-31T15:00:00.000Z';
const call = (id, rid, timestamp, usage, model = 'claude-opus-5-5') => `${JSON.stringify({ type: 'assistant', timestamp, requestId: rid, uuid: `${id}-${rid}`, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage } })}\n`;
const U = (input, output, read, write) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_1h_input_tokens: write } });

test('đếm token trên máy: mỗi lần gọi model đếm một lần dù nhật ký lặp dòng hay phiên rẽ nhánh chép lại; bỏ dòng trước mốc, dòng lỗi tự sinh; dòng ghi dở thì đợi; tác tử phụ trong thư mục con cũng tính', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-tokens-'));
  const proj = join(dir, 'C--Project');
  mkdirSync(join(proj, 'sess-1', 'subagents'), { recursive: true });
  const main = join(proj, 'sess-1.jsonl');
  const tail = call('m2', 'r2', '2026-11-01T09:00:00.000Z', U(5, 50, 500, 0));
  writeFileSync(main, [
    `${JSON.stringify({ type: 'user', timestamp: '2026-11-01T08:00:00.000Z', message: { role: 'user', content: 'chào' } })}\n`,
    call('m0', 'r0', '2026-10-31T14:59:00.000Z', U(9, 9, 9, 9)), // trước mốc tuần
    call('m1', 'r1', '2026-11-01T08:00:01.000Z', U(10, 100, 1000, 50)),
    call('m1', 'r1', '2026-11-01T08:00:02.000Z', U(10, 100, 1000, 50)), // khối nội dung thứ hai của cùng lần gọi
    call('e1', 'e1', '2026-11-01T08:00:03.000Z', U(0, 0, 0, 0), '<synthetic>'),
    tail.slice(0, 40), // Claude Code đang ghi dở dòng này
  ].join(''));
  writeFileSync(join(proj, 'sess-1', 'subagents', 'agent-a.jsonl'), call('m3', 'r3', '2026-11-01T08:30:00.000Z', U(1, 2, 3, 4), 'claude-haiku-5-5'));
  // File sửa lần cuối trước mốc thì không mở (trên máy thật nó không thể có dòng sau mốc).
  const old = join(proj, 'old.jsonl');
  writeFileSync(old, call('m9', 'r9', '2026-11-01T08:00:00.000Z', U(7, 7, 7, 7)));
  utimesSync(old, new Date('2026-10-30T00:00:00Z'), new Date('2026-10-30T00:00:00Z'));

  const counter = new TokenCounter({ projectsDir: dir });
  const since = Date.parse(SINCE);
  let r = await counter.count(since);
  assert.equal(r.since, SINCE);
  assert.deepEqual(r.total, { calls: 2, input: 11, output: 102, cacheRead: 1003, cacheWrite: 54 });
  assert.deepEqual(Object.keys(r.models).sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.equal(r.lastAt, '2026-11-01T08:30:00.000Z');

  appendFileSync(main, tail.slice(40)); // dòng ghi dở đã xong
  r = await counter.count(since);
  assert.deepEqual(r.total, { calls: 3, input: 16, output: 152, cacheRead: 1503, cacheWrite: 54 });

  // Phiên rẽ nhánh chép lại lịch sử sang file mới, rồi gọi thêm một lần.
  writeFileSync(join(proj, 'sess-2.jsonl'), call('m1', 'r1', '2026-11-01T08:00:01.000Z', U(10, 100, 1000, 50)) + call('m4', 'r4', '2026-11-01T10:00:00.000Z', U(0, 1, 0, 0)));
  r = await counter.count(since);
  assert.equal(r.total.calls, 4, 'lần gọi chép sang file rẽ nhánh không đếm lại');
  assert.equal(r.total.output, 153);

  // File bị viết lại ngắn hơn: đọc lại từ đầu, lần gọi đã đếm vẫn không đếm lại.
  writeFileSync(main, call('m1', 'r1', '2026-11-01T08:00:01.000Z', U(10, 100, 1000, 50)) + call('m5', 'r5', '2026-11-01T11:00:00.000Z', U(0, 0, 0, 10)));
  r = await counter.count(since);
  assert.equal(r.total.calls, 5);
  assert.equal(r.total.cacheWrite, 64);

  // Sang tuần mới: đếm lại từ đầu theo mốc mới.
  r = await counter.count(Date.parse('2026-11-01T09:30:00.000Z'));
  assert.deepEqual(r.total, { calls: 2, input: 0, output: 1, cacheRead: 0, cacheWrite: 10 });
  // Quay lại mốc cũ thì đếm lại từ nhật ký hiện có (m1, m3, m4, m5; m2 đã mất khi file bị viết lại).
  // Hai lần gọi chồng nhau thì xếp hàng, cùng ra một số.
  const [a, b] = await Promise.all([counter.count(since), counter.count(since)]);
  assert.deepEqual(a.total, b.total);
  assert.equal(a.total.calls, 4);
});

test('đếm token trên máy: dòng dài hơn một khúc đọc 1 MB vẫn đếm đúng; khoảng byte chép từ máy khác nằm vắt qua ranh giới khúc thì vẫn bỏ đúng dòng', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-tokens-big-'));
  mkdirSync(join(dir, 'P'));
  const sid = 'big-session';
  const big = `${JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T08:00:00.000Z', requestId: 'rbig', message: { id: 'big', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ố'.repeat(900 * 1024) }], usage: U(0, 5, 0, 0) } })}\n`;
  const foreign = call('f1', 'rf1', '2026-11-01T08:10:00.000Z', U(0, 1000, 0, 0)) + 'x'.repeat(600 * 1024) + '\n';
  const own = call('o1', 'ro1', '2026-11-01T08:20:00.000Z', U(0, 7, 0, 0));
  writeFileSync(join(dir, 'P', `${sid}.jsonl`), big + foreign + own);
  const start = Buffer.byteLength(big);
  assert.ok(start > 1024 * 1024, 'dòng đầu dài hơn một khúc (ký tự nhiều byte)');
  const counter = new TokenCounter({ projectsDir: dir, foreignRanges: (s) => (s === sid ? [[start, start + Buffer.byteLength(foreign)]] : null) });
  const r = await counter.count(Date.parse(SINCE));
  assert.deepEqual([r.total.calls, r.total.output], [2, 12]);
});

const WEEK = { startedAt: SINCE, resetsAt: '2026-11-07T15:00:00.000Z', percent: 40, claudeCodeShare: 100 };
const tok = (total, at = '2026-11-02T10:00:00.000Z', since = SINCE) => ({ since, at, lastAt: at, total, models: { 'claude-opus-5-5': total } });

test('sổ token trên trạm: cộng số các máy, ước còn lại theo phần trăm tuần và phần của Claude Code; số tuần cũ bị bỏ; tuần mới xoá số cũ; lưu xuống đĩa', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'orbit-book-')), 'usage-tokens.json');
  const book = new TokenBook(file);
  assert.equal(book.record('m1', 'Máy 1', { accountId: 'acc-1', tokens: tok({ calls: 10, input: 100, output: 1000, cacheRead: 300000, cacheWrite: 98900 }) }), true);
  book.record('m2', 'Máy 2', { accountId: 'acc-1', tokens: tok({ calls: 5, input: 0, output: 0, cacheRead: 100000, cacheWrite: 0 }) });
  assert.equal(book.record('m3', 'Máy 3', { tokens: tok({ calls: 1 }) }), false, 'không rõ tài khoản thì bỏ');
  const info = (id) => (id === 'm1' ? { name: 'Mini', online: true } : null);

  let s = book.summary('acc-1', WEEK, info);
  assert.equal(s.sum, 500000);
  assert.deepEqual(s.machines.map((m) => [m.name, m.online, m.sum]), [['Mini', true, 400000], ['Máy 2', false, 100000]]);
  assert.equal(s.estimate.remaining, 750000, '500 nghìn token là 40% thì còn 60% ứng với 750 nghìn');
  assert.equal(s.estimate.budget, 1250000);
  assert.equal(s.estimate.byType.cacheRead, 600000);
  // Claude Code chỉ chiếm một nửa mức đã dùng: 500 nghìn token ứng với 20% của tuần.
  s = book.summary('acc-1', { ...WEEK, claudeCodeShare: 50 }, info);
  assert.equal(s.estimate.remaining, 1500000);
  assert.equal(book.summary('acc-1', { ...WEEK, percent: 0 }, info).estimate, null, 'tuần mới 0% thì chưa ước được');
  assert.equal(book.summary('acc-1', { ...WEEK, percent: 100 }, info).estimate.remaining, 0);

  // Số do máy gửi lên bị làm sạch: chỉ giữ số nguyên không âm của các trường biết.
  book.record('m2', 'Máy 2', { accountId: 'acc-1', tokens: tok({ calls: '3', input: -5, output: 'x', cacheRead: 10.6, cacheWrite: null, extra: 9 }) });
  assert.deepEqual(book.summary('acc-1', WEEK, info).machines[1].total, { calls: 3, input: 0, output: 0, cacheRead: 11, cacheWrite: 0 });

  // Lưu xuống đĩa: trạm khởi động lại vẫn còn số.
  book.saveNow(Date.parse('2026-11-02T10:00:00Z'));
  assert.equal(new TokenBook(file).summary('acc-1', WEEK, info).sum, 400011);

  assert.equal(book.record('m1', 'Máy 1', { accountId: 'acc-1', tokens: tok({ calls: 1 }, undefined, '2026-10-24T15:00:00.000Z') }), false, 'số tuần trước tới muộn thì bỏ');
  const next = '2026-11-07T15:00:00.000Z';
  book.record('m1', 'Máy 1', { accountId: 'acc-1', tokens: tok({ calls: 1, output: 7 }, '2026-11-07T16:00:00.000Z', next) });
  assert.equal(book.summary('acc-1', WEEK, info), null, 'sang tuần mới thì số tuần cũ hết nghĩa');
  assert.deepEqual(book.summary('acc-1', { ...WEEK, startedAt: next, percent: 1 }, info).machines.map((m) => m.name), ['Mini'], 'máy chưa báo số tuần mới thì chưa có dòng');
});

test('trạm gộp token tuần: máy đang bật trả kèm lệnh usage, máy đã tắt dùng số nó tự báo lần cuối', async () => {
  const hub = new Hub({ stateDir: mkdtempSync(join(tmpdir(), 'orbit-usage-hub-')) });
  const account = { id: 'acc-1', label: 'ban@vidu.vn' };
  const week = { ...WEEK, percent: 25 };
  let receive;
  const link = { send: (m) => { if (m.op === 'usage') queueMicrotask(() => receive({ op: 'reply', rid: m.rid, ok: true, data: { account, plan: 'max', limits: parseUsage(REAL), week, at: '2026-11-02T10:00:00.000Z', tokens: tok({ calls: 9, input: 0, output: 1000, cacheRead: 2000, cacheWrite: 0 }) } })); }, close() {} };
  ({ receive } = hub.attachMachine(link, {}));
  receive({ op: 'hello', machine: { id: 'm1', name: 'Mini', platform: 'win32' }, sessions: [] });

  const off = hub.attachMachine({ send() {}, close() {} }, {});
  off.receive({ op: 'hello', machine: { id: 'm2', name: 'Công Ty', platform: 'win32' }, sessions: [] });
  off.receive({ op: 'tokens', accountId: 'acc-1', week: { startedAt: SINCE, resetsAt: WEEK.resetsAt }, tokens: tok({ calls: 3, input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 }, '2026-11-02T08:00:00.000Z') });
  off.disconnect();

  const r = await hub.usage();
  const t = r.accounts[0].tokens;
  assert.deepEqual(t.machines.map((m) => [m.name, m.online, m.sum]), [['Mini', true, 3000], ['Công Ty', false, 1000]]);
  assert.equal(t.sum, 4000);
  assert.equal(t.estimate.remaining, 12000, '4 nghìn token là 25% thì còn 75% ứng với 12 nghìn');
  assert.equal(t.machines[1].at, '2026-11-02T08:00:00.000Z');
});

test('đầu máy: nhớ mốc tuần xuống đĩa, qua giờ reset tự lùi sang tuần kế; tự báo số token lên trạm khi số đổi, chưa biết tuần thì không báo', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'orbit-usage-agent-'));
  let output = 100;
  const tokens = { count: async (since) => ({ since: new Date(since).toISOString(), at: new Date().toISOString(), lastAt: null, total: { calls: 1, input: 0, output, cacheRead: 0, cacheWrite: 0 }, models: {} }) };
  const make = () => new NodeAgent({ machineId: 'mT', machineName: 'MayT', stateDir, screen: null, sensors: { stop() {} }, tokens, pipePath: join(stateDir, 'pipe') });
  const agent = make();
  const sent = [];
  agent.out = (m) => sent.push(m);

  await agent.pushTokens();
  assert.equal(sent.length, 0, 'chưa từng hỏi được usage thì chưa biết tuần nào');

  agent.rememberWeek({ id: 'acc-1' }, { startedAt: '2026-10-24T15:00:00.000Z', resetsAt: '2026-10-31T15:00:00.000Z' });
  assert.deepEqual(agent.currentWeek(Date.parse('2026-11-02T00:00:00Z')), { accountId: 'acc-1', startedAt: '2026-10-31T15:00:00.000Z', resetsAt: '2026-11-07T15:00:00.000Z' });
  assert.equal(agent.currentWeek(Date.parse('2026-10-30T00:00:00Z')).startedAt, '2026-10-24T15:00:00.000Z');
  assert.equal(make().currentWeek(Date.parse('2026-11-02T00:00:00Z')).startedAt, '2026-10-31T15:00:00.000Z', 'mốc tuần còn sau khi khởi động lại');

  await agent.pushTokens();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, 'tokens');
  assert.equal(sent[0].accountId, 'acc-1');
  assert.equal(sent[0].tokens.since, agent.currentWeek().startedAt);
  await agent.pushTokens();
  assert.equal(sent.length, 1, 'số không đổi thì không báo lại');
  output = 150;
  await agent.pushTokens();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].tokens.total.output, 150);

  agent.out = () => { throw new Error('đường nối vừa đứt'); };
  output = 200;
  await agent.pushTokens(); // không được ném ra ngoài
  agent.shutdown();
});

test('chuyển phiên sang máy này: các lần gọi trong nhật ký chép sang không đếm lại (máy cũ đã đếm), chỉ đếm phần ghi thêm; phiên từng ở đây rồi quay về thì phần cũ của máy này vẫn tính', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'orbit-usage-move-'));
  const agent = new NodeAgent({ machineId: 'mB', machineName: 'MayB', stateDir, screen: null, sensors: { stop() {} }, pipePath: join(stateDir, 'pipe') });
  const since = Date.parse(SINCE);
  const b64 = (s) => Buffer.from(s).toString('base64');
  const send = (claudeSessionId, text) => agent.importTranscript({ claudeSessionId, cwd: 'C:\\Orbit', offset: 0, data: b64(text), size: Buffer.byteLength(text), final: true });

  // Lần đầu sang máy này: cả nhật ký là của máy khác.
  const sid = '11111111-2222-4333-8444-555555555555';
  const moved = call('a1', 'ra1', '2026-11-01T08:00:00.000Z', U(1, 10, 100, 0)) + call('a2', 'ra2', '2026-11-01T08:01:00.000Z', U(1, 10, 100, 0));
  const { file } = await send(sid, moved);
  let r = await agent.tokens.count(since);
  assert.equal(r.total.calls, 0, 'hai lần gọi của máy cũ không đếm ở máy mới');
  appendFileSync(file, call('b1', 'rb1', '2026-11-01T09:00:00.000Z', U(0, 7, 0, 0)));
  r = await agent.tokens.count(since);
  assert.deepEqual([r.total.calls, r.total.output], [1, 7], 'lần gọi sau khi chuyển sang là của máy này');

  // Phiên từng ở máy này (bản cũ còn trên máy), đi sang máy khác ghi thêm rồi quay về.
  const back = '66666666-7777-4888-8999-000000000000';
  const mine = call('c1', 'rc1', '2026-11-01T07:00:00.000Z', U(0, 3, 0, 0));
  const dir = join(process.env.ORBIT_REMOTE_PROJECTS, 'C--Orbit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${back}.jsonl`), mine);
  await send(back, mine + call('d1', 'rd1', '2026-11-01T10:00:00.000Z', U(0, 1000, 0, 0)));
  // Bộ đếm mới (như sau khi khởi động lại) đọc từ đầu mọi file theo sổ đã lưu.
  const again = new NodeAgent({ machineId: 'mB', machineName: 'MayB', stateDir, screen: null, sensors: { stop() {} }, pipePath: join(stateDir, 'pipe2') });
  r = await again.tokens.count(since);
  assert.deepEqual([r.total.calls, r.total.output], [2, 10], 'tính c1 (của máy này từ trước) và b1; không tính a1, a2, d1 của máy khác');
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'claude-foreign.json'), 'utf8'))[back].ranges, [[Buffer.byteLength(mine), Buffer.byteLength(mine) + Buffer.byteLength(call('d1', 'rd1', '2026-11-01T10:00:00.000Z', U(0, 1000, 0, 0)))]]);
  agent.shutdown();
  again.shutdown();
});
