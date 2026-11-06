// Nhiệt độ của máy. Hai đường, đường đầu có thì dùng đường đầu:
//
// 1. Chương trình đo quyền quản trị (win-sensors.cs, do bước "sensors" của setup cài): LibreHardwareMonitorLib
//    với driver PawnIO đọc lõi CPU, GPU, ổ đĩa, bo mạch. Nó chạy dưới SYSTEM, nằm trong Program Files, nghe
//    ở 127.0.0.1:SENSORS_PORT; đầu máy (quyền thường) hỏi một dòng "temps", nhận một dòng JSON.
// 2. Không có chương trình đó thì đọc những gì Windows cho tài khoản thường, không cài thêm gì:
//    - GPU NVIDIA: nvidia-smi (đi kèm driver), khoảng 70 ms mỗi lần.
//    - Vùng nhiệt ACPI (lớp hiệu năng Win32_PerfFormattedData_Counters_ThermalZoneInformation, tên lớp
//      không đổi theo ngôn ngữ Windows). Nhiều bo mạch máy bàn trả số giả đứng yên: đã đo trên một máy
//      i5-10400F, ba vùng 27,9 / 16,9 / 16,9 °C không nhích một chữ số nào dưới tải 6 luồng trong 20 giây.
//      Nên một vùng chỉ được hiện khi số của nó đã đổi ít nhất một lần kể từ lúc đầu máy chạy.
//    - Lõi CPU và ổ đĩa: cần quyền quản trị kèm driver (MSAcpi_ThermalZoneTemperature và
//      Get-StorageReliabilityCounter đều bị từ chối với tài khoản thường), nên không đọc.
//    Đường này bật một tiến trình PowerShell đo lặp mỗi INTERVAL_S giây khi có người xem (một tiến trình cho
//    mọi lần đọc), không ai hỏi trong IDLE_MS thì tắt, và nó tự thoát khi đầu máy không còn.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { lineSplitter } from './lines.mjs';
import { TOOL_DIR } from './paths.mjs';

export const INTERVAL_S = 5;
export const SENSORS_PORT = Number(process.env.ORBIT_REMOTE_SENSORS_PORT) || 8798; // 8795 trạm, 8796 màn hình, 8797 app PC, 8799 chương trình màn khoá (secure-desk.mjs)
export const SENSORS_SOURCE = join(TOOL_DIR, 'src', 'win-sensors.cs');
// LibreHardwareMonitor tải thẳng từ bản phát hành, so SHA256 cố định (đọc bằng `winget show
// LibreHardwareMonitor.LibreHardwareMonitor`); đổi bản thì đổi cả ba dòng.
export const LHM_VERSION = '0.9.6';
export const LHM_ZIP_URL = `https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v${LHM_VERSION}/LibreHardwareMonitor.zip`;
export const LHM_ZIP_SHA256 = '086D9F1B5A99E643EDC2CFAAAC16051685B551E4C5AC0B32A57C58C0E529C001';

// Nhãn phiên bản của chương trình đo: bản LibreHardwareMonitor cộng dấu của mã nguồn. Chương trình đo trả
// lại nhãn nó được cài kèm; khác nhãn này là bản cũ, setup cài lại.
export function sensorsVersion() {
  let tag = 'nosrc';
  try {
    tag = createHash('sha256').update(readFileSync(SENSORS_SOURCE)).digest('hex').slice(0, 12);
  } catch {
    // không đọc được mã nguồn: nhãn không khớp, setup báo cần cài lại
  }
  return `${LHM_VERSION}-${tag}`;
}

// Hỏi chương trình đo một lệnh ("temps" hay "version"); trả JSON nó trả, hay null khi không có ai nghe,
// không trả lời kịp, hay trả thứ không đọc được.
export function askSensors(cmd = 'temps', { port = SENSORS_PORT, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    const done = (v) => { clearTimeout(timer); s.destroy(); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    s.setEncoding('utf8');
    s.on('connect', () => s.write(`${cmd}\n`));
    s.on('data', (d) => {
      buf += d;
      const at = buf.indexOf('\n');
      if (at < 0) return;
      try {
        done(JSON.parse(buf.slice(0, at)));
      } catch {
        done(null);
      }
    });
    s.on('error', () => done(null));
    s.on('close', () => done(null));
  });
}
const IDLE_MS = 40000;
const STALE_MS = (INTERVAL_S * 3 + 5) * 1000; // tiến trình đo kẹt quá chừng này thì số đo coi như hết hạn
const RETRY_MS = 15000; // tiến trình đo vừa chết mà chưa đo được gì: chờ chừng này mới dựng lại
const ZONE_MIN_C = 5;
const ZONE_MAX_C = 125;

const SCRIPT = (parentPid) => String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$smi = $null
$cmd = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
foreach ($p in @($(if ($cmd) { $cmd.Source }), "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe", "$env:SystemRoot\System32\nvidia-smi.exe")) {
  if ($p -and (Test-Path -LiteralPath $p)) { $smi = $p; break }
}
while (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) {
  $out = @{ zones = @(); gpus = @(); smi = [bool]$smi }
  try {
    $out.zones = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation | ForEach-Object { @{ n = [string]$_.Name; t = [int]$_.HighPrecisionTemperature } })
  } catch { $out.zoneError = $_.Exception.Message }
  if ($smi) {
    try {
      $out.gpus = @(& $smi --query-gpu=index,name,temperature.gpu --format=csv,noheader,nounits 2>$null | Where-Object { $_ } | ForEach-Object {
        $f = $_ -split ',\s*'; $t = 0
        if ($f.Count -ge 3 -and [int]::TryParse($f[2].Trim(), [ref]$t)) { @{ i = [int]$f[0]; n = $f[1].Trim(); t = $t } }
      })
    } catch { $out.gpuError = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
  Start-Sleep -Seconds ${INTERVAL_S}
}
`;

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const round1 = (x) => Math.round(x * 10) / 10;
// "NVIDIA GeForce GTX 1050 Ti" -> "GeForce GTX 1050 Ti": tên hãng đã nằm ở nhãn GPU.
const gpuName = (name) => String(name || '').replace(/^NVIDIA\s+/i, '').trim();
// "\_TZ.TZ00" -> "TZ00"
const zoneName = (name) => String(name || '').split(/[.\\]/).filter(Boolean).pop() || String(name || '');
const plausible = (c) => Number.isFinite(c) && c >= ZONE_MIN_C && c <= ZONE_MAX_C;
const NO_ADMIN_NOTE = 'Lõi CPU, ổ đĩa và bo mạch cần chương trình đo quyền quản trị (driver PawnIO): chạy setup.cmd tại máy này để cài.';

// Chọn từ danh sách cảm biến của chương trình đo những dòng đáng hiện, mỗi phần cứng một dòng:
//   CPU: nhiệt độ cả con chip (Intel "CPU Package", AMD "Core (Tctl/Tdie)"), không có thì lõi nóng nhất.
//   GPU: lõi GPU, kèm điểm nóng nhất trong chữ phụ.
//   Ổ đĩa: nhiệt độ chung của ổ (NVMe "Composite Temperature", SATA "Temperature").
//   Bo mạch: chỉ cảm biến có tên rõ nghĩa (hệ thống, chipset, VRM); cảm biến chung chung "Temperature #3"
//   của chip SuperIO thường không nối với gì, đọc ra số vô nghĩa.
const CPU_PRIORITY = [/^CPU Package$/i, /^Core \(Tctl\/Tdie\)$/i, /^Core \(Tctl\)$/i, /^Tdie$/i, /^Core Max$/i, /^CPU Die/i, /^Core Average$/i];
const BOARD_NAME = /system|motherboard|chipset|pch|vrm|mos/i;
export function pickHelperItems(sensors) {
  const groups = new Map(); // tên phần cứng -> { kind, list }
  for (const s of list(sensors)) {
    // "CPU Core #1 Distance to TjMax" cũng mang loại nhiệt độ nhưng là khoảng cách tới ngưỡng tự hạ xung.
    if (!s || !plausible(s.c) || /distance/i.test(s.name)) continue;
    const key = `${s.kind}|${s.hw}`;
    if (!groups.has(key)) groups.set(key, { kind: String(s.kind || ''), hw: String(s.hw || '').trim(), list: [] });
    groups.get(key).list.push(s);
  }
  const items = [];
  const gpus = [...groups.values()].filter((g) => /^Gpu/i.test(g.kind));
  for (const g of groups.values()) {
    const byName = (re) => g.list.find((s) => re.test(s.name));
    if (/^Cpu$/i.test(g.kind)) {
      let pick = null;
      for (const re of CPU_PRIORITY) if ((pick = byName(re))) break;
      if (!pick) pick = g.list.filter((s) => /core|cpu/i.test(s.name)).reduce((a, s) => (!a || s.c > a.c ? s : a), null);
      const hottest = byName(/^Core Max$/i);
      if (pick) {
        items.push({
          id: `cpu:${g.hw}`, kind: 'cpu', label: 'CPU',
          // Lõi nóng nhất chỉ đáng ghi khi nó nóng hơn số của cả con chip.
          detail: `${g.hw}${hottest && Math.round(hottest.c) > Math.round(pick.c) ? ` · lõi nóng nhất ${Math.round(hottest.c)}°C` : ''}`, c: round1(pick.c),
        });
      }
    } else if (/^Gpu/i.test(g.kind)) {
      const core = byName(/^GPU Core$/i) || byName(/^GPU Temperature$/i) || g.list[0];
      const hot = byName(/hot ?spot/i);
      const n = gpus.indexOf(g);
      items.push({
        id: `gpu:${g.hw}`, kind: 'gpu', label: gpus.length > 1 ? `GPU ${n + 1}` : 'GPU',
        detail: `${gpuName(g.hw)}${hot && hot !== core ? ` · điểm nóng ${Math.round(hot.c)}°C` : ''}`, c: round1(core.c),
      });
    } else if (/^Storage$/i.test(g.kind)) {
      const t = byName(/^Composite Temperature$/i) || byName(/^Temperature$/i) || g.list[0];
      items.push({ id: `disk:${g.hw}`, kind: 'disk', label: 'Ổ đĩa', detail: g.hw, c: round1(t.c) });
    } else if (/^Motherboard$/i.test(g.kind)) {
      for (const s of g.list.filter((x) => BOARD_NAME.test(x.name)).slice(0, 2)) {
        items.push({ id: `board:${s.id || s.name}`, kind: 'board', label: 'Bo mạch', detail: s.name, c: round1(s.c) });
      }
    }
  }
  const order = { cpu: 0, gpu: 1, board: 2, disk: 3 };
  return items.sort((a, b) => order[a.kind] - order[b.kind]);
}

let versionTag = null; // nhãn của mã nguồn lúc đầu máy khởi động: setup cài lại thì đầu máy cũng chạy lại
const expectedVersion = () => (versionTag ??= sensorsVersion());

export class Sensors {
  constructor({ platform = process.platform, spawnFn = spawn, now = () => Date.now(), parentPid = process.pid, ask = askSensors } = {}) {
    this.platform = platform;
    this.spawnFn = spawnFn;
    this.now = now;
    this.parentPid = parentPid;
    this.ask = ask;
    this.proc = null;
    this.last = null; // lần đo gần nhất của đường PowerShell: { at, zones, gpus, smi, errors }
    this.zones = new Map(); // tên vùng -> { first, live }: vùng chỉ hiện khi số đã đổi ít nhất một lần
    this.lastAsk = 0;
    this.retryAt = 0;
    this.idleTimer = null;
    this.helper = null; // lần hỏi chương trình đo gần nhất: { at, view }
    this.helperPending = null;
  }

  // Trả số đo mới nhất: { state, source, items, notes, at, interval }. state: 'ready' (đã có số đo),
  // 'warming' (vừa bật tiến trình đo, chưa có số), 'unsupported' (máy không phải Windows). source:
  // 'admin' (chương trình đo quyền quản trị) hay 'basic' (nvidia-smi và vùng ACPI).
  async read() {
    if (this.platform !== 'win32') {
      return { state: 'unsupported', items: [], notes: ['Đo nhiệt độ hiện chỉ làm cho máy Windows.'], interval: INTERVAL_S };
    }
    this.lastAsk = this.now();
    const admin = await this.fromHelper();
    if (admin) {
      this.stop(); // đã có số của chương trình đo thì thôi đường PowerShell
      return admin;
    }
    this.ensure();
    const fresh = this.last && this.now() - this.last.at <= STALE_MS;
    if (!fresh) return { state: 'warming', source: 'basic', items: [], notes: [], interval: INTERVAL_S };
    return this.view();
  }

  // Hỏi chương trình đo, nhiều lần đọc trong một nhịp dùng chung một câu trả lời. null: không có chương
  // trình đo, hay nó chưa đọc được gì.
  async fromHelper() {
    if (this.helper && this.now() - this.helper.at < INTERVAL_S * 1000 - 500) return this.helper.view;
    this.helperPending ??= this.ask('temps').finally(() => { this.helperPending = null; });
    const d = await this.helperPending;
    const view = d?.ok && Array.isArray(d.sensors) ? this.helperView(d) : null;
    this.helper = { at: this.now(), view };
    return view;
  }

  helperView(d) {
    const items = pickHelperItems(d.sensors);
    const notes = [];
    if (d.version !== expectedVersion()) notes.push('Chương trình đo trên máy này là bản cũ: chạy setup.cmd tại máy để cập nhật.');
    if (!items.some((x) => x.kind === 'cpu')) notes.push('Chưa đọc được nhiệt độ lõi CPU: driver PawnIO có thể chưa nạp; chạy setup.cmd tại máy này.');
    return { state: 'ready', source: 'admin', items, notes, at: new Date(this.now()).toISOString(), interval: INTERVAL_S };
  }

  ensure() {
    if (this.proc || this.now() < this.retryAt) return;
    const script = SCRIPT(this.parentPid);
    let proc;
    try {
      proc = this.spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      this.retryAt = this.now() + RETRY_MS;
      return;
    }
    this.proc = proc;
    let got = false;
    proc.stdout.setEncoding?.('utf8');
    proc.stdout.on('data', lineSplitter((d) => {
      got = true;
      this.ingest(d);
    }));
    const gone = () => {
      if (this.proc !== proc) return;
      this.proc = null;
      clearInterval(this.idleTimer);
      this.idleTimer = null;
      if (!got) this.retryAt = this.now() + RETRY_MS;
    };
    proc.on('exit', gone);
    proc.on('error', gone);
    this.idleTimer = setInterval(() => this.checkIdle(), 5000);
    this.idleTimer.unref?.();
  }

  // Không ai hỏi nữa thì tắt tiến trình đo; số đo cuối vẫn giữ (vùng nào đã chứng tỏ là thật thì nhớ luôn).
  checkIdle() {
    if (this.proc && this.now() - this.lastAsk > IDLE_MS) this.stop();
  }

  ingest(d) {
    if (!d || typeof d !== 'object') return;
    const zones = list(d.zones).filter((z) => z && typeof z.n === 'string' && Number.isFinite(z.t));
    for (const z of zones) {
      const seen = this.zones.get(z.n);
      if (!seen) this.zones.set(z.n, { first: z.t, live: false });
      else if (!seen.live && seen.first !== z.t) seen.live = true;
    }
    const gpus = list(d.gpus).filter((g) => g && Number.isFinite(g.t));
    const errors = [d.zoneError, d.gpuError].filter(Boolean).map(String);
    this.last = { at: this.now(), zones, gpus, smi: Boolean(d.smi), errors };
  }

  view() {
    const { zones, gpus, smi, errors, at } = this.last;
    const items = [];
    gpus.forEach((g) => items.push({
      id: `gpu${g.i ?? 0}`, kind: 'gpu', label: gpus.length > 1 ? `GPU ${(g.i ?? 0) + 1}` : 'GPU', detail: gpuName(g.n), c: g.t,
    }));
    let hidden = 0;
    for (const z of zones) {
      const c = round1(z.t / 10 - 273.15);
      if (!this.zones.get(z.n)?.live || c < ZONE_MIN_C || c > ZONE_MAX_C) {
        hidden += 1;
        continue;
      }
      items.push({ id: `zone:${z.n}`, kind: 'zone', label: 'Bo mạch', detail: `Vùng nhiệt ACPI ${zoneName(z.n)}`, c });
    }
    const notes = [];
    if (hidden) notes.push(`${hidden} vùng nhiệt của bo mạch đang ẩn: số đứng yên từ lúc đo, nhiều khả năng là số giả của bo mạch, chưa phải số đo thật.`);
    if (!smi) notes.push('Không thấy nvidia-smi: máy không có GPU NVIDIA, hay driver chưa cài.');
    notes.push(NO_ADMIN_NOTE);
    for (const e of errors) notes.push(`Lỗi khi đo: ${e}`);
    return { state: 'ready', source: 'basic', items, notes, at: new Date(at).toISOString(), interval: INTERVAL_S };
  }

  stop() {
    clearInterval(this.idleTimer);
    this.idleTimer = null;
    const proc = this.proc;
    this.proc = null;
    try {
      proc?.kill();
    } catch {
      // đã thoát
    }
  }
}
