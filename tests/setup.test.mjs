// Kiểm bộ cài một máy (src/setup.mjs) và những gì nó dựa vào: lệnh "shutdown" qua ống nội bộ của
// đầu máy (bộ cài dùng để chạy lại đầu máy trên code mới, không bao giờ được cắt phiên đang chạy),
// và cách dựng lệnh quay màn hình dùng chung giữa luồng màn hình và bộ cài.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'orbit-setup-test-'));
process.env.ORBIT_REMOTE_STATE = join(ROOT, 'state');
process.env.ORBIT_REMOTE_PROJECTS = join(ROOT, 'projects');
// Ống riêng cho phép kiểm: bộ cài không bao giờ được hỏi tới đầu máy thật đang chạy trên máy.
process.env.ORBIT_REMOTE_PIPE_TAG = `test-setup-${randomBytes(6).toString('hex')}`;

const { NodeAgent } = await import('../src/node-agent.mjs');
const { PIPE_PATH } = await import('../src/paths.mjs');
const { captureInput, GDI_MAX_FPS } = await import('../src/ffmpeg.mjs');
const { STEPS } = await import('../src/setup.mjs');

const pipeName = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\orbit-remote-test-${randomBytes(6).toString('hex')}`
  : join(ROOT, `${randomBytes(6).toString('hex')}.sock`));

function ask(pipe, message) {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipe);
    let buf = '';
    s.setEncoding('utf8');
    s.once('connect', () => s.write(`${JSON.stringify({ ...message, rid: 't' })}\n`));
    s.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.includes('"rid":"t"'));
      if (line) {
        s.destroy();
        resolve(JSON.parse(line));
      }
    });
    s.once('error', reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('đầu máy: bộ cài tắt được đầu máy chỉ giữ phiên rảnh, không bao giờ cắt phiên đang làm dở nếu không nói rõ force', async () => {
  const pipe = pipeName();
  let stops = 0;
  const agent = new NodeAgent({ machineId: 'mS', machineName: 'MayS', pipePath: pipe, screen: null, onShutdown: () => { stops += 1; } });
  await agent.startPipe();
  try {
    agent.sessions.set('s1', { name: 'Đang làm', status: 'busy', claudeSessionId: 'x', close() {} });
    agent.sessions.set('s2', { name: 'Rảnh', status: 'idle', claudeSessionId: 'y', close() {} });
    const refused = await ask(pipe, { op: 'shutdown' });
    assert.equal(refused.ok, false);
    assert.equal(refused.data.running, 1, 'chỉ phiên đang làm dở mới chặn');
    assert.deepEqual(refused.data.sessions, [{ name: 'Đang làm', status: 'busy' }, { name: 'Rảnh', status: 'idle' }], 'kèm tên mọi phiên sẽ bị đóng');
    assert.match(refused.error, /1 phiên đang làm dở/);
    agent.sessions.get('s1').status = 'waiting';
    assert.equal((await ask(pipe, { op: 'shutdown' })).ok, false, 'phiên chờ duyệt quyền cũng là đang làm dở');
    await wait(120);
    assert.equal(stops, 0, 'còn phiên làm dở thì không tắt');

    agent.sessions.get('s1').status = 'stopped';
    const idleOnly = await ask(pipe, { op: 'shutdown' });
    assert.equal(idleOnly.ok, true, 'phiên rảnh đóng được (mở lại trên app là làm tiếp), phiên đã dừng không tính');
    assert.deepEqual(idleOnly.data.sessions, [{ name: 'Rảnh', status: 'idle' }]);
    await wait(120);
    assert.equal(stops, 1);

    agent.sessions.set('s3', { name: 'Đang làm', status: 'busy', claudeSessionId: 'z', close() {} });
    assert.equal((await ask(pipe, { op: 'shutdown', force: true })).ok, true, 'force thì tắt dù còn phiên');
    await wait(120);
    assert.equal(stops, 2);
  } finally {
    agent.shutdown();
  }
});

test('bộ cài khởi động lại đầu máy: phiên rảnh tự đóng, phiên làm dở thì hỏi người tại máy, chạy nền thì dừng và nói rõ phiên nào', async () => {
  const step = STEPS.find((s) => s.id === 'agent');
  let up = false;
  let stops = 0;
  let agent = null;
  const asked = [];
  const ctx = (answer) => ({
    role: 'node',
    force: false,
    ask: answer === undefined ? null : async (q) => { asked.push(q); return answer; },
    pipeInUse: async () => up,
    spawnNode: () => { up = true; },
  });
  const start = async (sessions) => {
    agent = new NodeAgent({ machineId: 'mR', machineName: 'MayR', pipePath: PIPE_PATH, screen: null,
      onShutdown: () => { stops += 1; agent.shutdown(); up = false; } });
    for (const [id, s] of Object.entries(sessions)) agent.sessions.set(id, { claudeSessionId: id, close() {}, ...s });
    await agent.startPipe();
    up = true;
  };
  try {
    // Chỉ còn phiên rảnh (đúng ca đóng VS Code mà phiên mở từ app vẫn chạy ngầm): đóng luôn, không hỏi.
    await start({ a: { name: 'Bundle iOS', status: 'idle' } });
    await step.fix(ctx(true));
    assert.equal(stops, 1);
    assert.equal(asked.length, 0);

    const working = { a: { name: 'Bundle iOS', status: 'idle' }, b: { name: 'Dựng bản', status: 'busy' } };
    await start(working);
    await assert.rejects(step.fix(ctx(undefined)), /"Bundle iOS" \(đang rảnh\), "Dựng bản" \(đang làm\).*Đóng chúng trên app/s, 'chạy nền: dừng, nói rõ phiên nào');
    await assert.rejects(step.fix(ctx(false)), /chưa khởi động lại đầu máy/, 'người tại máy chọn thôi');
    assert.equal(stops, 1, 'chưa đồng ý thì không đóng phiên nào');
    assert.equal(asked.length, 1);
    await step.fix(ctx(true));
    assert.equal(stops, 2, 'đồng ý thì đóng phiên rồi khởi động lại đầu máy');

    // Đầu máy bản cũ (đếm cả phiên rảnh, không kèm tên): vẫn hỏi được, đồng ý thì gửi lại kèm force.
    const forced = [];
    const old = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.on('data', (d) => {
        const m = JSON.parse(d.trim().split('\n')[0]);
        forced.push(Boolean(m.force));
        sock.write(`${JSON.stringify({ op: 'reply', rid: m.rid, ok: Boolean(m.force), data: { running: 1 }, error: 'Đầu máy còn 1 phiên đang chạy.' })}\n`);
        if (m.force) setTimeout(() => { old.close(); up = false; }, 20);
      });
    });
    await new Promise((r) => old.listen(PIPE_PATH, r));
    up = true;
    await step.fix(ctx(true));
    assert.deepEqual(forced, [false, true]);
    assert.match(asked.at(-1), /Đóng các phiên này/);
  } finally {
    agent?.shutdown();
  }
});

test('đầu máy chung tiến trình với trạm: từ chối lệnh shutdown, chỉ khởi động lại bằng "restart"', async () => {
  const pipe = pipeName();
  const agent = new NodeAgent({ machineId: 'mH', machineName: 'MayH', pipePath: pipe, screen: null });
  await agent.startPipe();
  try {
    const reply = await ask(pipe, { op: 'shutdown', force: true });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /restart/);
  } finally {
    agent.shutdown();
  }
});

test('lệnh quay: ddagrab theo đúng màn, gdigrab bị giới hạn khung và cắt đúng vùng khi máy có nhiều màn', () => {
  const screen = { index: 1, x: 1920, y: -120, width: 2560, height: 1440 };
  const dda = captureInput('ddagrab', screen, 60);
  assert.deepEqual(dda.input, ['-f', 'lavfi', '-i', 'ddagrab=output_idx=1:framerate=60:dup_frames=0:draw_mouse=1']);
  assert.deepEqual(dda.filters, ['hwdownload', 'format=bgra'], 'khung ddagrab nằm trên card, phải tải về trước');

  const one = captureInput('gdigrab', screen, 60, true);
  assert.deepEqual(one.input, ['-f', 'gdigrab', '-framerate', String(GDI_MAX_FPS), '-draw_mouse', '1', '-i', 'desktop']);
  assert.deepEqual(one.filters, []);

  const win = { kind: 'window', index: 1, monX: 1920, monY: 0, x: 2000, y: 100, width: 600, height: 400 };
  assert.deepEqual(captureInput('ddagrab', win, 60).input,
    ['-f', 'lavfi', '-i', 'ddagrab=output_idx=1:framerate=60:dup_frames=0:draw_mouse=1:offset_x=80:offset_y=100:video_size=600x400'],
    'cửa sổ: quay đúng vùng của nó trên màn chứa nó, toạ độ tính từ góc màn đó');
  const many = captureInput('gdigrab', screen, 20, false);
  assert.deepEqual(many.input, ['-f', 'gdigrab', '-framerate', '20', '-draw_mouse', '1',
    '-offset_x', '1920', '-offset_y', '-120', '-video_size', '2560x1440', '-i', 'desktop']);
});

test('danh sách bước cài: mã không trùng, bước nào cũng kiểm được, bước cần quyền quản trị chỉ làm trên Windows', () => {
  const ids = STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of STEPS) {
    assert.equal(typeof s.title, 'string');
    assert.equal(typeof s.check, 'function', `${s.id} có check()`);
    if (s.admin) assert.ok(s.windowsOnly, `${s.id} cần quyền quản trị nên chỉ chạy trên Windows`);
  }
  for (const need of ['ffmpeg', 'capture', 'input', 'firewall', 'tailscale', 'autostart', 'agent', 'hub']) {
    assert.ok(ids.includes(need), `có bước ${need}`);
  }
});

test('bảng token (custom/tokens.md): đọc token và vai trò, ghi chú lấy từ tiêu đề đặc tả, đặc tả không được trỏ ra ngoài custom/; ghi chú cho Claude chỉ khi lời nhắn có token', async () => {
  const { parseTokens, listTokens, findToken, tokenNote } = await import('../src/tokens.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = join(ROOT, 'custom-tokens');
  mkdirSync(join(dir, 'tokens'), { recursive: true });
  const table = [
    '# Bảng token',
    'Ví dụ một dòng: `` | `$vd [yêu cầu]` | không phải dòng bảng | `tokens/vd.md` | ``',
    '| Token | Việc làm | Đặc tả |',
    '|---|---|---|',
    '| `$c` | Chỉ commit. | `tokens/c.md` |',
    '| `$qa [yêu cầu]` | Đóng vai QA. | `tokens/qa.md` |',
    '| `$QA [yêu cầu]` | Trùng tên, bỏ. | `tokens/qa.md` |',
    '| `$lo [yêu cầu]` | Trỏ ra ngoài custom/. | `../ngoai.md` |',
    '| không phải dòng token | x | y |',
  ].join('\n');
  writeFileSync(join(dir, 'tokens.md'), table);
  writeFileSync(join(dir, 'tokens', 'c.md'), '# `$c` — chỉ commit, không push\n');
  writeFileSync(join(dir, 'tokens', 'qa.md'), '# `$qa [nội dung yêu cầu]` — kiểm chất lượng toàn diện\n');
  const file = join(dir, 'tokens.md');
  const list = listTokens(file);
  assert.deepEqual(list.map(({ token, arg, hint }) => ({ token, arg, hint })), [
    { token: '$c', arg: '', hint: 'Chỉ commit, không push' },
    { token: '$qa', arg: 'yêu cầu', hint: 'Kiểm chất lượng toàn diện' },
    { token: '$lo', arg: 'yêu cầu', hint: 'Trỏ ra ngoài custom/.' },
  ], 'dòng ví dụ trong chữ và dòng trùng tên không thành token');
  assert.equal(list[1].spec, join(dir, 'tokens', 'qa.md'));
  assert.equal(list[2].spec, '', 'đặc tả trỏ ra ngoài custom/ thì bỏ');
  assert.equal(parseTokens(table, () => '', dir)[0].hint, 'Chỉ commit.', 'không đọc được đặc tả thì dùng mô tả trong bảng');
  assert.equal(findToken('QA', file)?.token, '$qa');
  assert.equal(findToken('$khong-co', file), null);

  const note = tokenNote('$qa kiểm màn đăng nhập', file);
  assert.match(note, /\$qa: Kiểm chất lượng toàn diện\. Đọc tệp đặc tả .*qa\.md/);
  assert.doesNotMatch(note, /\$c:/, 'chỉ nhắc token có trong lời nhắn');
  assert.equal(tokenNote('giá 5$qa hay email a$c', file), '', 'token phải đứng riêng một từ');
  assert.equal(tokenNote('không có token nào', file), '');
  assert.equal(tokenNote(`$qa ${join(dir, 'tokens', 'qa.md')}`, file), '', 'lời nhắn đã ghi đường dẫn đặc tả thì không nhắc lại');

  // Bảng của repo: có thật, đúng dạng, và đang trống có chủ đích.
  assert.deepEqual(listTokens(), [], 'custom/tokens.md của repo để trống cho người dùng tự thêm');
});

test('setup tự động (bấm từ app): không làm bước cần người, ghi lại để nhắc; buộc khởi động lại đầu máy; kết quả ghi sau mỗi bước', async () => {
  const { runSetup } = await import('../src/setup.mjs');
  const { readFileSync } = await import('node:fs');
  const resultFile = join(ROOT, 'setup-last.json');
  const calls = [];
  const state = { normal: false, person: false, admin: false };
  const steps = [
    { id: 'normal', title: 'Bước thường', check: () => ({ ok: state.normal, detail: state.normal ? 'xong' : 'thiếu' }), fix: () => { calls.push('normal'); state.normal = true; } },
    { id: 'person', title: 'Bước cần người', interactive: true, check: () => ({ ok: state.person, detail: 'chưa đăng nhập' }), fix: () => { calls.push('person'); state.person = true; } },
    { id: 'admin', title: 'Bước cần quyền quản trị', admin: true, check: () => ({ ok: state.admin, detail: 'thiếu luật' }), fix: () => { calls.push('admin'); state.admin = true; } },
    { id: 'agent', title: 'Chạy lại đầu máy', check: () => ({ ok: false, detail: 'bản cũ' }), fix: (ctx) => { calls.push(`agent force=${ctx.force}`); } },
  ];
  const quiet = process.stdout.write;
  process.stdout.write = () => true; // giấu chữ của setup trong lúc kiểm
  process.env.ORBIT_REMOTE_PULL = 'đã kéo bản mới';
  let code;
  try {
    code = await runSetup({ fix: true, args: ['--unattended'], ctx: { machine: 'May', role: 'node', resultFile }, steps });
  } finally {
    process.stdout.write = quiet;
    delete process.env.ORBIT_REMOTE_PULL;
  }
  assert.deepEqual(calls, ['normal', 'agent force=true'], 'không đụng bước cần người hay cần quyền quản trị');
  assert.equal(code, 1);
  const r = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.equal(r.mode, 'auto');
  assert.equal(r.done, true);
  assert.equal(r.ok, false);
  assert.equal(r.pull, 'đã kéo bản mới');
  assert.deepEqual(r.needsUser.map((x) => x.title), ['Bước cần người', 'Bước cần quyền quản trị']);
  assert.deepEqual(r.failed.map((x) => x.title), ['Chạy lại đầu máy']);

  // Chạy tay (setup.cmd): bước cần người được làm, không buộc khởi động lại.
  calls.length = 0;
  state.normal = false;
  process.stdout.write = () => true;
  try {
    await runSetup({ fix: true, args: [], ctx: { machine: 'May', role: 'node', resultFile }, steps });
  } finally {
    process.stdout.write = quiet;
  }
  assert.deepEqual(calls, ['normal', 'person', 'admin', 'agent force=false']);
  assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')).mode, 'setup');
});

test('lấy code trước setup: lỗi tranh chấp git (lệnh git khác chạy cùng lúc) thì thử lại, lỗi khác báo ngay; kéo hỏng thì kết quả setup là còn thiếu', async () => {
  const { pullRepo, runSetup, PULL_TITLE, PULL_TRIES } = await import('../src/setup.mjs');
  const { readFileSync } = await import('node:fs');
  // Đúng lời git khi một lệnh git khác fetch cùng lúc trên cùng kho.
  const RACE = 'error: fetching ref refs/remotes/origin/main failed: incorrect old value provided';
  const fake = (answers) => {
    const calls = [];
    const run = () => { calls.push(1); return answers[Math.min(calls.length, answers.length) - 1]; };
    return { run, calls };
  };
  const waits = [];
  const wait = async (ms) => { waits.push(ms); };

  let g = fake([{ status: 1, said: RACE }, { status: 1, said: RACE }, { status: 0, said: 'Updating 1401b17..850dc00\nFast-forward' }]);
  let r = await pullRepo('repo', { run: g.run, wait });
  assert.deepEqual([r.failed, r.pulled, r.attempts], [false, 'đã kéo bản mới', 3], 'hỏng vì tranh chấp hai lần, lần ba kéo được');
  assert.deepEqual(waits, [2000, 4000], 'chờ lâu dần giữa các lần');

  g = fake([{ status: 1, said: 'fatal: unable to access https://github.com/x: Could not resolve host' }]);
  r = await pullRepo('repo', { run: g.run, wait });
  assert.deepEqual([r.failed, g.calls.length], [true, 1], 'lỗi mạng: không thử lại vô ích');
  assert.match(r.pulled, /^không kéo được: fatal: unable to access/);

  g = fake([{ status: 1, said: RACE }]);
  r = await pullRepo('repo', { run: g.run, wait });
  assert.deepEqual([r.failed, g.calls.length], [true, PULL_TRIES], 'tranh chấp mãi: dừng sau số lần giới hạn');

  // Kéo hỏng: setup vẫn chạy bằng code đang có, nhưng kết quả là còn thiếu (app hiện dấu X), không "đủ cả".
  const resultFile = join(ROOT, 'setup-pull.json');
  const quiet = process.stdout.write;
  process.stdout.write = () => true;
  process.env.ORBIT_REMOTE_PULL = `không kéo được: ${RACE}`;
  process.env.ORBIT_REMOTE_PULL_FAILED = '1';
  try {
    await runSetup({ fix: true, args: ['--unattended'], ctx: { machine: 'May', role: 'node', resultFile }, steps: [] });
  } finally {
    process.stdout.write = quiet;
    delete process.env.ORBIT_REMOTE_PULL;
    delete process.env.ORBIT_REMOTE_PULL_FAILED;
  }
  const res = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.equal(res.ok, false);
  assert.equal(res.failed[0].title, PULL_TITLE);
  assert.match(res.failed[0].detail, /incorrect old value provided/);
});

test('gói bật máy: MAC viết kiểu nào cũng nhận, gói đúng 102 byte, quảng bá tính đúng dải, chỉ nhớ card mạng thật', async () => {
  const w = await import('../src/wake.mjs');
  for (const mac of ['AA:BB:CC:DD:EE:FF', 'aa-bb-cc-dd-ee-ff', 'AABBCCDDEEFF', 'aabb.ccdd.eeff']) assert.equal(w.normalizeMac(mac), 'aa:bb:cc:dd:ee:ff');
  assert.equal(w.normalizeMac('00:00:00:00:00:00'), null, 'card ảo không có MAC');
  assert.equal(w.normalizeMac('12:34'), null);
  const p = w.magicPacket('01:02:03:04:05:06');
  assert.equal(p.length, 102);
  assert.ok(p.subarray(0, 6).equals(Buffer.alloc(6, 0xff)));
  for (let i = 0; i < 16; i += 1) assert.ok(p.subarray(6 + i * 6, 12 + i * 6).equals(Buffer.from([1, 2, 3, 4, 5, 6])));
  assert.equal(w.directedBroadcast('192.168.1.32', '255.255.255.0'), '192.168.1.255');
  assert.equal(w.directedBroadcast('10.20.30.40', '255.255.240.0'), '10.20.31.255');
  assert.equal(w.sameSubnet({ address: '192.168.1.32', netmask: '255.255.255.0' }, { address: '192.168.1.200' }), true);
  assert.equal(w.sameSubnet({ address: '192.168.1.32', netmask: '255.255.255.0' }, { address: '192.168.2.37' }), false);
  const info = w.localWakeInfo({
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.50', netmask: '255.255.255.0', mac: '02:00:00:00:00:51', internal: false }],
    Ethernet: [{ family: 'IPv4', address: '192.168.1.32', netmask: '255.255.255.0', mac: '02:00:00:00:00:32', internal: false }],
    Tailscale: [{ family: 'IPv4', address: '100.101.102.103', netmask: '255.255.255.255', mac: '00:00:00:00:00:00', internal: false }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', mac: '00:00:00:00:00:00', internal: true }],
    vEthernet: [{ family: 'IPv4', address: '169.254.10.2', netmask: '255.255.0.0', mac: '00:15:5d:00:00:01', internal: false }],
  });
  assert.deepEqual(info.map((x) => x.name), ['Ethernet', 'Wi-Fi'], 'bỏ card ảo, loopback, địa chỉ tự gán; card có dây đứng trước');
  assert.equal(info[0].broadcast, '192.168.1.255');
});

test('tắt máy: đúng lệnh shutdown, có lịch cũ thì huỷ rồi đặt lại, huỷ khi không có lịch vẫn là xong, chặn thời gian lạ', async () => {
  const p = await import('../src/power.mjs');
  const calls = [];
  let pending = false;
  // Bắt chước shutdown.exe thật (mã lỗi đo trên máy giữ trạm): 1190 khi đã có lịch, 1116 khi huỷ mà không có lịch.
  const exec = (cmd, args) => {
    calls.push(args.slice(0, 4).join(' '));
    if (args[0] === '/a') { const was = pending; pending = false; return { status: was ? 0 : 1116 }; }
    if (pending) return { status: 1190 };
    pending = true;
    return { status: 0 };
  };
  const before = Date.now();
  const at = p.scheduleShutdown(30, exec, 'win32');
  assert.ok(at >= before + 30000 && at <= Date.now() + 30000);
  assert.deepEqual(calls, ['/s /f /t 30']);
  calls.length = 0;
  p.scheduleShutdown(900, exec, 'win32');
  assert.deepEqual(calls, ['/s /f /t 900', '/a', '/s /f /t 900'], 'có lịch cũ: huỷ rồi đặt lịch mới');
  p.cancelShutdown(exec, 'win32');
  p.cancelShutdown(exec, 'win32'); // không còn lịch nào: 1116, vẫn coi là đã huỷ
  assert.equal(pending, false);
  assert.deepEqual(p.shutdownArgs(0).slice(0, 4), ['/s', '/f', '/t', '0']);
  for (const bad of [-1, 1.5, 'abc', p.MAX_DELAY_SEC + 1]) assert.throws(() => p.shutdownArgs(bad));
  assert.throws(() => p.scheduleShutdown(10, exec, 'linux'), /chỉ làm cho Windows/);
});