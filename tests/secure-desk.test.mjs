// Kiểm phần xem màn khoá (src/secure-desk.mjs, src/win-secure.cs) bằng chương trình thật dịch từ mã nguồn,
// chạy chế độ "desk" bằng quyền người dùng (không SYSTEM, nên chỉ chụp được màn thường) với khoá tạm và
// cổng riêng. Không gửi lệnh bấm nào: chuột và phím thật không bị đụng. Phần chạy bằng quyền SYSTEM (serve,
// chụp màn khoá thật) cần cài bằng quyền quản trị, không kiểm được ở đây.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const isWin = process.platform === 'win32';
process.env.ORBIT_REMOTE_STATE = mkdtempSync(join(tmpdir(), 'orbit-secure-test-'));
const keyFile = join(process.env.ORBIT_REMOTE_STATE, 'secure.key');
process.env.ORBIT_REMOTE_SECURE_KEY = keyFile;
process.env.ORBIT_REMOTE_SECURE_PORT = '18799';

const desk = await import('../src/secure-desk.mjs');
let proc = null;
before(async () => {
  if (!isWin) return;
  writeFileSync(keyFile, randomBytes(24).toString('hex'));
  proc = spawn(desk.buildSecureExe(), ['desk', '18799', keyFile], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 30 && !(await desk.secureAvailable()); i += 1) await new Promise((r) => setTimeout(r, 200));
});
after(() => proc?.kill());

test('phần xem màn khoá: khoá đúng thì trả lời, khoá sai hay chưa có khoá thì coi như chưa cài; chụp ra ảnh JPEG đúng cỡ đều đặn; kênh bấm mở được', { skip: !isWin }, async () => {
  assert.equal(await desk.secureAvailable(), true);
  const right = (await import('node:fs')).readFileSync(keyFile, 'utf8');
  writeFileSync(keyFile, 'sai'.repeat(16));
  assert.equal(await desk.secureAvailable(), false, 'khoá sai: chương trình đóng kết nối, không phục vụ');
  writeFileSync(keyFile, right);

  const frames = [];
  const cap = await desk.startSecureCapture({ x: 0, y: 0, w: 320, h: 240, ow: 160, oh: 120, fps: 10, quality: 60 }, (img) => frames.push(img));
  await new Promise((r) => setTimeout(r, 1300));
  cap.stop();
  assert.ok(frames.length >= 6 && frames.length <= 16, `chừng 10 ảnh mỗi giây (${frames.length} ảnh trong 1,3 giây)`);
  const img = frames[0];
  assert.equal(img[0], 0xff);
  assert.equal(img[1], 0xd8, 'mở đầu bằng FFD8 của JPEG');
  const sof = img.indexOf(Buffer.from([0xff, 0xc0]));
  assert.deepEqual([img.readUInt16BE(sof + 7), img.readUInt16BE(sof + 5)], [160, 120], 'thu nhỏ đúng cỡ đã xin');

  const channel = await desk.openSecureInput();
  channel.close();
});

test('luồng màn hình: máy khoá mà có phần xem màn khoá thì báo app "đang khoá, xem được", gửi khung "started" dạng JPEG rồi ảnh màn khoá; chạm đi vào kênh của chương trình SYSTEM; mở khoá thì thôi', { skip: !isWin }, async () => {
  const { Viewer } = await import('../src/screen.mjs');
  const json = [];
  const binary = [];
  const v = Object.create(Viewer.prototype);
  Object.assign(v, {
    active: true, capture: null, lockTimer: null, lockWatch: null, secure: null, restarts: 0, lockPollMs: 60000,
    seq: 0, acked: 0, inflight: [], inflightBytes: 0, screen: { kind: 'screen', index: 0, x: 0, y: 0, width: 320, height: 240 },
    ws: { closed: false, sendJson: (m) => json.push(m), sendBinary: (d, head) => binary.push(head[0]), buffered: 0 },
    server: { screens: async () => [{ index: 0, x: 0, y: 0, width: 320, height: 240 }], input: { desktopState: async () => 'locked' } },
  });
  v.waitUnlock('locked');
  for (let i = 0; i < 30 && binary.length < 3; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(json.map((m) => [m.t, m.state ?? m.codec, m.live ?? m.secure ?? null]), [
    ['locked', 'locked', null], // báo ngay: đang khoá
    ['locked', 'locked', true], // phần xem màn khoá trả lời: xem và bấm được
    ['started', 'jpeg', true],
  ]);
  assert.ok(binary.length >= 3 && binary.every((t) => t === 4), 'ảnh màn khoá đi tới app dạng khung JPEG');
  assert.ok(v.secure?.input, 'chạm và phím đi vào kênh của chương trình SYSTEM');
  v.stopCapture(); // người xem dừng hay máy mở khoá: thôi xem qua chương trình SYSTEM
  assert.equal(v.secure, null);
});

test('kịch bản cài bằng quyền quản trị: thư mục chỉ quản trị viên ghi được, khoá chỉ SYSTEM, Administrators và người cài đọc được, tác vụ SYSTEM lúc bật máy; mã tài khoản lạ thì từ chối', () => {
  const s = desk.installScript({ exePath: 'C:\\x\\orbit-secure.exe', userSid: 'S-1-5-21-1-2-3-1001' });
  assert.match(s, /icacls \$dir \/inheritance:r \/grant:r "\*S-1-5-18:\(OI\)\(CI\)F" "\*S-1-5-32-544:\(OI\)\(CI\)F" "\*S-1-5-32-545:\(OI\)\(CI\)RX"/);
  assert.match(s, /icacls \$key \/inheritance:r \/grant:r "\*S-1-5-18:F" "\*S-1-5-32-544:F" "\*S-1-5-21-1-2-3-1001:R"/);
  assert.equal((s.match(/if \(\$LASTEXITCODE\) \{ throw/g) || []).length, 2, 'icacls lỗi thì dừng, không để quyền sai');
  assert.match(s, /New-ScheduledTaskPrincipal -UserId 'SYSTEM'/);
  assert.match(s, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(s, /-Argument 'serve 18799'/, 'tác vụ nhận cổng từ JS, không để chương trình tự đoán cổng mặc định');
  assert.throws(() => desk.installScript({ exePath: 'C:\\x.exe', userSid: 'S-1-5-21"; rm -r C:\\' }), /Mã tài khoản lạ/);
});
