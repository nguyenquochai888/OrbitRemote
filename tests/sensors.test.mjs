// Kiểm bộ đo nhiệt độ (src/sensors.mjs) bằng tiến trình đo giả: không chạy PowerShell hay nvidia-smi
// thật, phép kiểm tự đưa từng dòng số đo như tiến trình đo thật in ra.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Sensors, pickHelperItems } from '../src/sensors.mjs';

const noHelper = async () => null; // máy chưa cài chương trình đo quyền quản trị

function fakeSpawner() {
  const spawned = [];
  const spawnFn = (cmd, args) => {
    const p = new EventEmitter();
    p.stdout = new PassThrough();
    p.killed = false;
    p.kill = () => { p.killed = true; p.emit('exit', 0); };
    p.cmd = cmd;
    p.args = args;
    p.line = (obj) => new Promise((r) => { p.stdout.write(`${JSON.stringify(obj)}\n`); setImmediate(r); });
    spawned.push(p);
    return p;
  };
  return { spawned, spawnFn };
}

test('nhiệt độ: bật bộ đo ở lần hỏi đầu, GPU hiện ngay, vùng ACPI đứng yên bị ẩn, vùng đã nhích mới hiện', async () => {
  let t = 1000;
  const { spawned, spawnFn } = fakeSpawner();
  const s = new Sensors({ platform: 'win32', spawnFn, now: () => t, parentPid: 4242, ask: noHelper });
  const first = await s.read();
  assert.equal(first.state, 'warming', 'chưa có số đo thì báo đang đo');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'powershell.exe');
  const script = Buffer.from(spawned[0].args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Get-Process -Id 4242/, 'tiến trình đo tự thoát khi đầu máy không còn');
  assert.match(script, /Win32_PerfFormattedData_Counters_ThermalZoneInformation/);

  await s.read();
  assert.equal(spawned.length, 1, 'hỏi nhiều lần vẫn chỉ một tiến trình đo');

  // PowerShell 5.1 viết mảng một phần tử thành một đối tượng: vẫn phải đọc đúng.
  await spawned[0].line({ zones: [{ n: '\\_TZ.TZ00', t: 3010 }, { n: '\\_TZ.TZ10', t: 2900 }], gpus: { i: 0, n: 'NVIDIA GeForce GTX 1050 Ti', t: 35 }, smi: true });
  let r = await s.read();
  assert.equal(r.state, 'ready');
  assert.deepEqual(r.items, [{ id: 'gpu0', kind: 'gpu', label: 'GPU', detail: 'GeForce GTX 1050 Ti', c: 35 }]);
  assert.match(r.notes[0], /2 vùng nhiệt của bo mạch đang ẩn/, 'vùng chưa nhích lần nào là số chưa chắc thật');

  t += 5000;
  await spawned[0].line({ zones: [{ n: '\\_TZ.TZ00', t: 3021 }, { n: '\\_TZ.TZ10', t: 2900 }], gpus: [{ i: 0, n: 'NVIDIA GeForce GTX 1050 Ti', t: 41 }], smi: true });
  r = await s.read();
  assert.deepEqual(r.items.map((x) => [x.id, x.c]), [['gpu0', 41], ['zone:\\_TZ.TZ00', 29]], 'vùng đã nhích hiện đúng °C (3021 phần mười độ Kelvin = 28,95 °C)');
  assert.equal(r.items[1].detail, 'Vùng nhiệt ACPI TZ00');
  assert.match(r.notes[0], /^1 vùng nhiệt/, 'vùng còn đứng yên vẫn ẩn');

  t += 5000;
  await spawned[0].line({ zones: [{ n: '\\_TZ.TZ00', t: 5000 }], gpus: [], smi: false, gpuError: 'x' });
  r = await s.read();
  assert.deepEqual(r.items, [], 'số ngoài tầm hợp lý (226 °C) không hiện');
  assert.ok(r.notes.some((n) => /Không thấy nvidia-smi/.test(n)));
  assert.ok(r.notes.some((n) => /Lỗi khi đo: x/.test(n)));
});

test('nhiệt độ: không ai hỏi thì tắt bộ đo, hỏi lại thì bật lại; số đo cũ quá thì coi như chưa có', async () => {
  let t = 0;
  const { spawned, spawnFn } = fakeSpawner();
  const s = new Sensors({ platform: 'win32', spawnFn, now: () => t, ask: noHelper });
  await s.read();
  await spawned[0].line({ zones: [], gpus: [{ i: 0, n: 'GPU', t: 50 }], smi: true });
  t += 30000;
  s.checkIdle();
  assert.equal(spawned[0].killed, false, 'chưa quá lâu thì giữ bộ đo');
  t += 15000;
  s.checkIdle();
  assert.equal(spawned[0].killed, true, 'quá 40 giây không ai hỏi thì tắt');
  assert.equal(s.proc, null);
  const again = await s.read();
  assert.equal(spawned.length, 2, 'hỏi lại thì bật bộ đo mới');
  assert.equal(again.state, 'warming', 'số đo cũ 45 giây trước không đem ra hiện');
  s.stop();
});

test('nhiệt độ: bộ đo chết khi chưa đo được gì thì chờ rồi mới dựng lại; máy không phải Windows thì báo không hỗ trợ', async () => {
  let t = 0;
  const { spawned, spawnFn } = fakeSpawner();
  const s = new Sensors({ platform: 'win32', spawnFn, now: () => t, ask: noHelper });
  await s.read();
  spawned[0].emit('exit', 1);
  await s.read();
  assert.equal(spawned.length, 1, 'không dựng lại liên tục khi PowerShell hỏng');
  t += 16000;
  await s.read();
  assert.equal(spawned.length, 2, 'qua thời gian chờ thì thử lại');
  s.stop();

  const mac = new Sensors({ platform: 'darwin', spawnFn });
  assert.equal((await mac.read()).state, 'unsupported');
  assert.equal(spawned.length, 2, 'máy không phải Windows thì không chạy gì');
});

// Danh sách cảm biến chương trình đo (win-sensors.cs) trả thật ngày 2026-10-30 trên máy i5-10400F,
// bo mạch Gigabyte B460M DS3H V2, GTX 1050 Ti, một ổ cứng Seagate và một SSD Samsung.
const REAL = [
  ...[34, 38, 49, 91, 40, 95].map((c, i) => ({ hw: 'Gigabyte B460M DS3H V2', kind: 'Motherboard', sub: 'ITE IT8688E', name: `Temperature #${i + 1}`, c })),
  { hw: 'Intel Core i5-10400F', kind: 'Cpu', name: 'Core Max', c: 50 },
  { hw: 'Intel Core i5-10400F', kind: 'Cpu', name: 'Core Average', c: 44.7 },
  ...[45, 50, 43, 44, 43, 43].map((c, i) => ({ hw: 'Intel Core i5-10400F', kind: 'Cpu', name: `CPU Core #${i + 1}`, c })),
  { hw: 'Intel Core i5-10400F', kind: 'Cpu', name: 'CPU Package', c: 48 },
  ...[55, 50, 57, 56, 57, 57].map((c, i) => ({ hw: 'Intel Core i5-10400F', kind: 'Cpu', name: `CPU Core #${i + 1} Distance to TjMax`, c })),
  { hw: 'NVIDIA GeForce GTX 1050 Ti', kind: 'GpuNvidia', name: 'GPU Core', c: 36 },
  { hw: 'NVIDIA GeForce GTX 1050 Ti', kind: 'GpuNvidia', name: 'GPU Hot Spot', c: 44 },
  { hw: 'ST1000DM010-2EP102', kind: 'Storage', name: 'Temperature', c: 37 },
  { hw: 'Samsung SSD 860 EVO 250GB ', kind: 'Storage', name: 'Temperature', c: 42 },
];

test('nhiệt độ (chương trình đo quyền quản trị): mỗi phần cứng một dòng, bỏ cảm biến bo mạch vô nghĩa và khoảng cách tới TjMax', () => {
  const items = pickHelperItems(REAL);
  assert.deepEqual(items.map((x) => [x.kind, x.label, x.detail, x.c]), [
    ['cpu', 'CPU', 'Intel Core i5-10400F · lõi nóng nhất 50°C', 48],
    ['gpu', 'GPU', 'GeForce GTX 1050 Ti · điểm nóng 44°C', 36],
    ['disk', 'Ổ đĩa', 'ST1000DM010-2EP102', 37],
    ['disk', 'Ổ đĩa', 'Samsung SSD 860 EVO 250GB', 42],
  ], 'chân SuperIO "Temperature #4/#6" báo 91 và 95 °C mà không nối gì: không được hiện thành "rất nóng"');

  // AMD: "Core (Tctl/Tdie)"; không có cảm biến cả chip thì lấy lõi nóng nhất, không bao giờ lấy TjMax.
  assert.equal(pickHelperItems([{ hw: 'AMD Ryzen 7 5800X', kind: 'Cpu', name: 'Core (Tctl/Tdie)', c: 61.3 }])[0].c, 61.3);
  const noPackage = pickHelperItems([
    { hw: 'CPU', kind: 'Cpu', name: 'CPU Core #1', c: 40 }, { hw: 'CPU', kind: 'Cpu', name: 'CPU Core #2', c: 47 },
    { hw: 'CPU', kind: 'Cpu', name: 'CPU Core #1 Distance to TjMax', c: 60 },
  ]);
  assert.equal(noPackage[0].c, 47);
  // Bo mạch có cảm biến tên rõ nghĩa thì hiện; ngoài tầm hợp lý thì bỏ.
  const board = pickHelperItems([
    { hw: 'B650', kind: 'Motherboard', sub: 'NCT6799D', name: 'System', c: 33 },
    { hw: 'B650', kind: 'Motherboard', sub: 'NCT6799D', name: 'PCH', c: -128 },
  ]);
  assert.deepEqual(board.map((x) => [x.label, x.detail, x.c]), [['Bo mạch', 'System', 33]]);
});

test('nhiệt độ: có chương trình đo thì dùng nó, không chạy PowerShell; mất nó thì lùi về đường cũ', async () => {
  let t = 0;
  let asked = 0;
  let helperUp = true;
  const { spawned, spawnFn } = fakeSpawner();
  const { sensorsVersion } = await import('../src/sensors.mjs');
  const ask = async () => { asked += 1; return helperUp ? { ok: true, version: sensorsVersion(), admin: true, sensors: REAL } : null; };
  const s = new Sensors({ platform: 'win32', spawnFn, now: () => t, ask });
  let r = await s.read();
  assert.equal(r.source, 'admin');
  assert.equal(r.items[0].label, 'CPU');
  assert.deepEqual(r.notes, [], 'bản đúng, có CPU: không có gì phải ghi chú');
  assert.equal(spawned.length, 0, 'không dựng PowerShell khi đã có chương trình đo');
  t += 1000;
  await s.read();
  assert.equal(asked, 1, 'hai lần đọc trong một nhịp đo dùng chung một câu trả lời');

  const old = new Sensors({ platform: 'win32', spawnFn, now: () => t, ask: async () => ({ ok: true, version: 'cu', sensors: REAL.filter((x) => x.kind !== 'Cpu') }) });
  r = await old.read();
  assert.ok(r.notes.some((n) => /bản cũ/.test(n)));
  assert.ok(r.notes.some((n) => /Chưa đọc được nhiệt độ lõi CPU/.test(n)));

  helperUp = false;
  t += 6000;
  r = await s.read();
  assert.equal(r.source, 'basic', 'chương trình đo không trả lời: lùi về nvidia-smi và vùng ACPI');
  assert.equal(spawned.length, 1);
  s.stop();
});

test('nhiệt độ: lõi nóng nhất bằng số cả con chip thì không ghi thêm', () => {
  const [cpu] = pickHelperItems([
    { hw: 'Intel Core i5-10400F', kind: 'Cpu', name: 'CPU Package', c: 42 },
    { hw: 'Intel Core i5-10400F', kind: 'Cpu', name: 'Core Max', c: 42.4 },
  ]);
  assert.equal(cpu.detail, 'Intel Core i5-10400F');
});
