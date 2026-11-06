// Phần chạy ở máy đích của công cụ orbit_machine_* (src/remote-ops.mjs): chạy lệnh thật, đọc ghi sửa tìm tệp thật
// trong thư mục tạm, đổi toạ độ ảnh chụp ra toạ độ màn hình, và chuột phím qua bộ điều khiển giả.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ops = await import('../src/remote-ops.mjs');
const ROOT = mkdtempSync(join(tmpdir(), 'orbit-remote-ops-'));
const win = process.platform === 'win32';

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('chạy lệnh: ra đúng chữ có dấu, đúng mã thoát, đúng thư mục; hết giờ thì dừng', { skip: !win && 'lệnh PowerShell' }, async () => {
  const r = await ops.runCommand({ command: 'Write-Output "xin chào Việt Nam"; Write-Output (Get-Location).Path; cmd /c exit 3', cwd: ROOT });
  assert.match(r.text, /^Mã thoát 3 ·/);
  assert.match(r.text, /xin chào Việt Nam/);
  assert.ok(r.text.includes(ROOT), 'chạy trong đúng thư mục cwd');
  const err = await ops.runCommand({ command: 'Write-Error "hỏng rồi"', cwd: ROOT });
  assert.match(err.text, /--- stderr ---[\s\S]*hỏng rồi/);
  const long = await ops.runCommand({ command: `$s = "${'x'.repeat(9000)}"; Write-Output $s.Length`, cwd: ROOT });
  assert.match(long.text, /9000/, 'lệnh dài đi qua tệp .ps1 tạm');
  const t = Date.now();
  const slow = await ops.runCommand({ command: 'Start-Sleep 30', timeout_sec: 2 });
  assert.match(slow.text, /^Hết giờ sau 2 giây/);
  assert.ok(Date.now() - t < 15000, 'không chờ hết 30 giây');
  await assert.rejects(ops.runCommand({ command: 'dir', cwd: join(ROOT, 'khong-co') }), /Không thấy thư mục/);
  await assert.rejects(ops.runCommand({ command: '  ' }), /Thiếu command/);
});

test('đọc, ghi, sửa tệp: giữ kiểu xuống dòng, từ chối đường tương đối và đường mạng', async () => {
  const f = join(ROOT, 'thư mục', 'mới', 'a.txt');
  assert.match((await ops.writePath({ path: f, content: 'dòng 1\r\ndòng 2\r\ndòng 3\r\n' })).text, /^Đã ghi \d+ byte/);
  const all = await ops.readPath({ path: f });
  assert.match(all.text, /\(3 dòng; hiện dòng 1–3\)\n1\tdòng 1\n2\tdòng 2\n3\tdòng 3$/);
  const part = await ops.readPath({ path: f, offset: 2, limit: 1 });
  assert.match(part.text, /hiện dòng 2–2\)\n2\tdòng 2$/);
  assert.match((await ops.editPath({ path: f, old_string: 'dòng 2\ndòng 3', new_string: 'dòng HAI\ndòng BA' })).text, /Đã sửa 1 chỗ/);
  assert.equal(readFileSync(f, 'utf8'), 'dòng 1\r\ndòng HAI\r\ndòng BA\r\n', 'tệp \\r\\n vẫn là \\r\\n');
  await assert.rejects(ops.editPath({ path: f, old_string: 'dòng', new_string: 'x' }), /có 3 chỗ/);
  assert.match((await ops.editPath({ path: f, old_string: 'dòng', new_string: 'line', replace_all: true })).text, /Đã sửa 3 chỗ/);
  await assert.rejects(ops.editPath({ path: f, old_string: 'không có', new_string: 'x' }), /Không thấy old_string/);
  await assert.rejects(ops.readPath({ path: 'a.txt' }), /tuyệt đối/);
  await assert.rejects(ops.readPath({ path: '\\\\may\\chia-se\\a.txt' }), /đường mạng/);
  await assert.rejects(ops.readPath({ path: join(ROOT, 'khong-co.txt') }), /Không thấy/);
  const bin = join(ROOT, 'b.bin');
  writeFileSync(bin, Buffer.from([1, 0, 2, 3]));
  await assert.rejects(ops.readPath({ path: bin }), /nhị phân/);
  const png = join(ROOT, 'anh.png');
  writeFileSync(png, Buffer.from('89504e470d0a1a0a0000', 'hex'));
  const img = await ops.readPath({ path: png });
  assert.equal(img.image.mime, 'image/png', 'tệp ảnh trả về thành ảnh');
  const dir = await ops.readPath({ path: join(ROOT, 'thư mục') });
  assert.match(dir.text, /\[thư mục\] mới/, 'đọc thư mục thì liệt kê');
});

test('tìm tệp theo mẫu và theo chữ bên trong; bỏ qua thư mục nặng', async () => {
  mkdirSync(join(ROOT, 'game', 'Assets', 'Scripts'), { recursive: true });
  mkdirSync(join(ROOT, 'game', 'Library'), { recursive: true });
  writeFileSync(join(ROOT, 'game', 'Assets', 'Scripts', 'Player.cs'), 'class Player {\n  int hp = 10;\n}\n');
  writeFileSync(join(ROOT, 'game', 'Assets', 'Scripts', 'Enemy.cs'), 'class Enemy {}\n');
  writeFileSync(join(ROOT, 'game', 'Library', 'Player.cs'), 'class Player {}\n');
  const byName = await ops.findPaths({ path: join(ROOT, 'game'), pattern: '**/*.cs' });
  assert.match(byName.text, /^2 kết quả/);
  assert.ok(!byName.text.includes('Library'), 'không vào Library');
  const byText = await ops.findPaths({ path: join(ROOT, 'game'), pattern: 'Assets/**/*.cs', contains: 'hp\\s*=' });
  assert.match(byText.text, /Player\.cs:2: int hp = 10;/);
  assert.match((await ops.findPaths({ path: join(ROOT, 'game'), pattern: '*.png' })).text, /^Không thấy gì/);
  assert.equal(ops.globToRegex('Assets/**/*.{cs,shader}').test('Assets/A/B/x.shader'), true);
  assert.equal(ops.globToRegex('*.cs').test('a/b.cs'), false, '* không qua dấu /');
  assert.equal(ops.globToRegex('**/*.CS').test('a/b.cs'), true, 'không phân biệt hoa thường');
});

test('chuột phím: toạ độ trên ảnh đổi ra toạ độ thật của đúng màn; phím tổ hợp nhấn và nhả đúng thứ tự', { skip: !win && 'chỉ Windows' }, async () => {
  const sent = [];
  const fake = {
    screens: async () => [{ index: 1, x: 0, y: 0, width: 1280, height: 720, primary: true }, { index: 2, x: 1920, y: -100, width: 3136, height: 1764 }],
    moveTo: (x, y) => sent.push(`m ${Math.round(x)} ${Math.round(y)}`),
    button: (b, down) => sent.push(`${down ? 'd' : 'u'} ${b}`),
    wheel: (dy) => sent.push(`w ${dy}`),
    key: (vk, down, ext) => sent.push(`k ${vk} ${down ? 1 : 0}${ext ? ' e' : ''}`),
    text: (s) => sent.push(`t ${s}`),
  };
  const ctx = { input: () => fake };
  assert.deepEqual(ops.shotSize({ width: 3136, height: 1764 }), { width: 1568, height: 882, scale: 0.5 });
  assert.deepEqual(ops.shotSize({ width: 1280, height: 720 }), { width: 1280, height: 720, scale: 1 });
  await ops.sendInput(ctx, { screen: 2, actions: [{ type: 'click', x: 100, y: 50 }, { type: 'key', keys: 'ctrl+shift+s' }, { type: 'type', text: 'Xin chào' }, { type: 'scroll', x: 10, y: 10, dy: -240 }] });
  assert.deepEqual(sent.slice(0, 3), ['m 2120 0', 'd 0', 'u 0'], 'ảnh thu nửa: (100, 50) trên màn 2 là (1920+200, -100+100)');
  assert.deepEqual(sent.slice(3, 9), ['k 17 1', 'k 16 1', 'k 83 1', 'k 83 0', 'k 16 0', 'k 17 0']);
  assert.ok(sent.includes('t Xin chào') && sent.includes('w -240'));
  sent.length = 0;
  await ops.sendInput(ctx, { actions: [{ type: 'double_click', x: 5, y: 5, button: 'right' }, { type: 'key', keys: 'up' }] });
  assert.deepEqual(sent, ['m 5 5', 'd 1', 'u 1', 'd 1', 'u 1', 'k 38 1 e', 'k 38 0 e'], 'không chọn màn thì dùng màn chính; phím mũi tên là phím mở rộng');
  await assert.rejects(ops.sendInput(ctx, { actions: [{ type: 'click', x: 5000, y: 5 }] }), /ngoài ảnh/);
  await assert.rejects(ops.sendInput(ctx, { screen: 9, actions: [{ type: 'click', x: 1, y: 1 }] }), /Không có màn 9/);
  await assert.rejects(ops.sendInput(ctx, { actions: [{ type: 'key', keys: 'ctrl+phimla' }] }), /Phím lạ/);
});

test('chụp màn hình thật của máy này: ra ảnh JPEG đúng cỡ đã báo', { skip: !win && 'chỉ Windows' }, async () => {
  const { InputHelper } = await import('../src/input.mjs');
  const { ffmpegCommand } = await import('../src/screen.mjs');
  const ff = ffmpegCommand();
  if (!ff) return;
  const helper = new InputHelper();
  try {
    const shot = await ops.captureScreen({ input: () => helper, ffmpeg: () => ff }, {});
    const jpg = Buffer.from(shot.image.data, 'base64');
    assert.deepEqual([jpg[0], jpg[1]], [0xff, 0xd8], 'là ảnh JPEG');
    assert.match(shot.text, new RegExp(`ảnh ${shot.size.width}x${shot.size.height}\\.`));
    assert.ok(Math.max(shot.size.width, shot.size.height) <= ops.SHOT_MAX);
  } finally {
    helper.stop();
  }
});
