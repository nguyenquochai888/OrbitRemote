// Bộ cài một máy cho Orbit Remote. `node src/main.mjs setup` (setup.cmd gọi lệnh này) kiểm từng
// thứ máy cần, thiếu thì cài hay sửa, rồi kiểm lại; `node src/main.mjs doctor` chỉ kiểm, không đụng gì.
//
// STEPS bên dưới là DANH SÁCH DUY NHẤT những gì một máy cần để chạy Orbit Remote (phiên, màn hình,
// chuột, phím, nối trạm). Thêm hay sửa một tính năng mà nó cần thêm thứ gì từ máy (chương trình,
// cổng, quyền, dịch vụ, tệp cấu hình) thì thêm hay sửa mục tương ứng ở đây trong cùng commit, để mọi
// máy chỉ cần nháy đúp setup.cmd lần nữa là đủ.
//
// Mỗi mục: check() đọc trạng thái THẬT của máy và trả { ok, detail }; fix() (nếu có) cài hay sửa,
// sau đó mục được kiểm lại; mục `optional` mà thiếu thì chỉ cảnh báo, không làm setup thất bại.

import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClaude } from './claude-session.mjs';
import { DDAGRAB_UNSUPPORTED, FFMPEG_WINGET_ID, GDI_MAX_FPS, captureInput, findFfmpeg, ffmpegUsable } from './ffmpeg.mjs';
import { InputHelper } from './input.mjs';
import { PIPE_PATH, TOOL_DIR, writeJsonAtomic } from './paths.mjs';
import { APP_ICON_FILE, APP_LAUNCHER_FILE, findAppBrowser, installShortcuts, launcherScript, readShortcuts } from './pc-app.mjs';
import { buildSecureExe, installScript, secureAvailable, secureStatus } from './secure-desk.mjs';
import { SCREEN_PORT } from './screen.mjs';
import { LHM_VERSION, LHM_ZIP_SHA256, LHM_ZIP_URL, SENSORS_PORT, SENSORS_SOURCE, askSensors, pickHelperItems, sensorsVersion } from './sensors.mjs';
import { findTailscale, readTailscaleStatus, tailnetFromStatus } from './tailnet.mjs';

const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPROVAL_WAIT_MS = 5 * 60 * 1000;
const PAWNIO_WINGET_ID = 'namazso.PawnIO'; // driver đo của LibreHardwareMonitor từ bản 0.9.5 (bản 2.2.0 lúc viết)
// Chương trình đo nhiệt độ chạy quyền quản trị: nằm trong Program Files (chỉ quản trị viên ghi được),
// để không tiến trình quyền thường nào thay được tệp mà task SYSTEM sẽ chạy.
const SENSORS_DIR = join(process.env.ProgramFiles || 'C:\\Program Files', 'Orbit Remote', 'sensors');
const SENSORS_TASK = 'Orbit Remote Sensors';

// ---- Công cụ nhỏ ------------------------------------------------------------------------------

function powershell(script, { admin = false, timeout = 60000 } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (!admin) return spawnSync('powershell.exe', [...base, '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
  // Một hộp thoại UAC cho đúng phần cần quyền quản trị; người dùng từ chối thì Start-Process báo lỗi.
  const outer = `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
  return spawnSync('powershell.exe', [...base, '-Command', outer], { encoding: 'utf8', windowsHide: true, timeout });
}

// Cài đặt hiện tại của Tailscale (JSON của `tailscale debug prefs`), null nếu không đọc được.
function readTailscalePrefs(cmd) {
  const r = spawnSync(cmd, ['debug', 'prefs'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  try {
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

function hasWinget() {
  return isWin && spawnSync('winget', ['--version'], { windowsHide: true, timeout: 15000 }).status === 0;
}

function wingetInstall(id) {
  if (!hasWinget()) throw new Error('Máy thiếu winget (App Installer của Microsoft Store), không tự cài được.');
  // Hiện thẳng tiến độ của winget ra cửa sổ; gói cài cho cả máy thì winget tự hỏi quyền quản trị.
  spawnSync('winget', ['install', '-e', '--id', id, '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'],
    { stdio: 'inherit', timeout: 15 * 60 * 1000 });
}

// Chương trình vừa cài thêm thư mục của nó vào PATH của Windows, nhưng tiến trình này (và đầu máy nó
// sắp dựng) vẫn giữ PATH cũ: đọc lại PATH của máy và của người dùng, giữ thêm phần riêng đang có.
function refreshPath() {
  if (!isWin) return;
  const r = powershell("[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')");
  if (r.status !== 0) return;
  const seen = new Set();
  const parts = [...r.stdout.trim().split(';'), ...(process.env.PATH || '').split(';')]
    .map((p) => p.trim()).filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
  process.env.PATH = parts.join(';');
}

function pipeAsk(message, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const s = net.connect(PIPE_PATH);
    let buf = '';
    const done = (v) => { clearTimeout(timer); s.destroy(); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    s.setEncoding('utf8');
    s.once('connect', () => s.write(`${JSON.stringify({ ...message, rid: 'setup' })}\n`));
    s.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        try {
          const m = JSON.parse(line);
          if (m.rid === 'setup') return done(m);
        } catch {
          // dòng chưa trọn
        }
      }
      return undefined;
    });
    s.once('error', () => done(null));
  });
}

const STATUS_TEXT = { starting: 'đang mở', busy: 'đang làm', waiting: 'chờ duyệt quyền', idle: 'đang rảnh' };

// "2 phiên: "A" (đang làm), "B" (đang rảnh)"; đầu máy bản cũ chỉ báo số phiên.
function describeSessions({ running, sessions }) {
  if (!Array.isArray(sessions) || !sessions.length) return `${running} phiên`;
  return `${sessions.length} phiên: ${sessions.map((s) => `"${s.name}" (${STATUS_TEXT[s.status] || s.status})`).join(', ')}`;
}

// Phiên mở hay chạy tiếp từ app chạy ngầm dưới đầu máy, không có cửa sổ nào trên máy: người ngồi tại
// máy không thấy chúng, đóng VS Code cũng không đóng chúng. Khởi động lại đầu máy là đóng các phiên
// đó, nên hỏi người ngồi tại máy (setup.cmd) trước; chạy nền không hỏi được thì báo rõ rồi dừng.
async function allowClosing(ctx, what) {
  const why = `Đầu máy đang giữ ${what}, mở hay chạy tiếp từ app. Các phiên này chạy ngầm, không có cửa sổ trên máy, nên đóng VS Code không đóng chúng.`;
  if (!ctx.ask) throw new Error(`${why} Đóng chúng trên app (màn của máy, danh sách phiên) rồi chạy lại setup.`);
  process.stdout.write(`\n${why}\n`);
  const yes = await ctx.ask('Đóng các phiên này để cài tiếp? Hội thoại vẫn còn, trên app bấm "Chạy lại" là làm tiếp. Gõ c rồi Enter để đóng, chỉ Enter để thôi: ');
  if (!yes) throw new Error(`chưa khởi động lại đầu máy vì còn ${what}. Đóng chúng trên app hay chạy lại setup và gõ c.`);
}

// Tiến trình trạm và đầu máy Orbit Remote đang chạy trên máy: mã, vai, lúc mở, số phiên Claude con.
function orbitProcesses() {
  if (!isWin) return [];
  const script = String.raw`
$out = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  if ($_.CommandLine -match '[\\/]src[\\/]main\.mjs"?\s+(hub|node)\b') {
    $id = $_.ProcessId
    [pscustomobject]@{ pid = $id; mode = $Matches[1]; started = $_.CreationDate.ToUniversalTime().ToString('o');
      children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | Where-Object { $_.Name -like 'claude*' }).Count }
  }
})
ConvertTo-Json -InputObject $out -Compress`;
  const r = powershell(script);
  try {
    return JSON.parse(r.stdout || '[]') || [];
  } catch {
    return [];
  }
}

// Lần sửa mới nhất của code chạy trong trạm và đầu máy.
function newestSourceMtime() {
  const dir = join(TOOL_DIR, 'src');
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (/\.(mjs|cs)$/.test(name)) newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
  }
  return newest;
}

async function pingHub(url, hubId) {
  try {
    const res = await fetch(new URL('/api/ping', url), { signal: AbortSignal.timeout(4000) });
    const info = await res.json();
    return info.service === 'orbit-remote' && (!hubId || info.hubId === hubId);
  } catch {
    return false;
  }
}

// ---- Danh sách những gì một máy cần -------------------------------------------------------------

// Cổng điện thoại nối thẳng vào máy. Qua Tailscale thì bộ cài Tailscale đã tự mở ("Tailscale-In");
// luật dưới đây là cho đường mạng nhà (LAN).
function firewallRules(ctx) {
  const rules = [{ name: 'OrbitRemote-Screen-TCP', display: `Orbit Remote: xem màn hình (TCP ${SCREEN_PORT})`, protocol: 'TCP', port: SCREEN_PORT }];
  if (ctx.role === 'hub') {
    rules.push({ name: 'OrbitRemote-Hub-TCP', display: `Orbit Remote: trạm (TCP ${ctx.hubPort})`, protocol: 'TCP', port: ctx.hubPort });
    rules.push({ name: 'OrbitRemote-Hub-UDP', display: `Orbit Remote: dò tìm trạm (UDP ${ctx.hubPort})`, protocol: 'UDP', port: ctx.hubPort });
  }
  return rules;
}

function readFirewall() {
  const r = powershell(String.raw`
$allow = @(Get-NetFirewallRule -Name 'OrbitRemote-*' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | ForEach-Object { $_.Name })
$block = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*\node.exe' } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | ForEach-Object { $_.Name })
ConvertTo-Json -InputObject @{ allow = $allow; block = $block } -Compress`);
  try {
    const v = JSON.parse(r.stdout);
    return { allow: [].concat(v.allow || []), block: [].concat(v.block || []) };
  } catch {
    return null;
  }
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Card mạng có dây và các chỗ trong Windows quyết định máy có dậy được qua mạng không (đọc không cần
// quyền quản trị): "Wake on Magic Packet" và "Shutdown Wake-On-Lan" của card ('1' bật, '0' tắt, rỗng
// là card không có mục đó), card có trong danh sách được đánh thức máy, và Fast Startup.
function readWake() {
  const r = powershell(String.raw`
$armed = (powercfg /devicequery wake_armed) -join "|"
$hib = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -ErrorAction SilentlyContinue).HiberbootEnabled
$wired = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.MediaType -eq '802.3' } | ForEach-Object {
  $a = $_
  $props = @(Get-NetAdapterAdvancedProperty -Name $a.Name -ErrorAction SilentlyContinue)
  $val = { param($k) $p = $props | Where-Object { $_.RegistryKeyword -eq $k } | Select-Object -First 1; if ($p) { [string]($p.RegistryValue -join '') } else { '' } }
  [pscustomobject]@{ name = $a.Name; desc = $a.InterfaceDescription; magic = (& $val '*WakeOnMagicPacket'); s5 = (& $val 'S5WakeOnLan'); armed = ("|$armed|").Contains("|$($a.InterfaceDescription)|") }
})
ConvertTo-Json -InputObject @{ wired = $wired; fastStartup = $hib } -Depth 4 -Compress`);
  try {
    const v = JSON.parse(r.stdout);
    return { wired: [].concat(v.wired || []), fastStartup: v.fastStartup == null ? null : Number(v.fastStartup) };
  } catch {
    return null;
  }
}

// Lệnh PowerShell (chạy với quyền quản trị) mở các cổng của Orbit Remote cho mọi loại mạng, và tắt
// (không xoá) các luật đang chặn node.exe: muốn chặn lại thì bật lại được ngay trong tường lửa.
export function firewallScript(ctx, blockNames = []) {
  const lines = ["$ErrorActionPreference = 'Stop'"];
  for (const name of blockNames) lines.push(`Disable-NetFirewallRule -Name ${q(name)}`);
  for (const r of firewallRules(ctx)) {
    lines.push(`if (Get-NetFirewallRule -Name ${q(r.name)} -ErrorAction SilentlyContinue) { Set-NetFirewallRule -Name ${q(r.name)} -Enabled True -Action Allow -Direction Inbound -Profile Any }`
      + ` else { New-NetFirewallRule -Name ${q(r.name)} -DisplayName ${q(r.display)} -Direction Inbound -Protocol ${r.protocol} -LocalPort ${r.port} -Action Allow -Profile Any | Out-Null }`);
  }
  return lines.join('\n');
}

// Lệnh PowerShell (chạy với quyền quản trị) cài chương trình đo nhiệt độ; ghi từng bước vào tệp `log`
// để setup báo lại được lỗi của cửa sổ quyền quản trị (cửa sổ đó chạy ẩn). Gói tải về và tệp giải nén
// nằm luôn trong thư mục Program Files của chương trình đo: không qua thư mục người dùng ghi được, nên
// không ai tráo được tệp giữa lúc so SHA256 và lúc chép.
export function sensorsInstallScript(log) {
  const dir = SENSORS_DIR;
  return String.raw`
$ErrorActionPreference = 'Stop'
$log = ${q(log)}
function Say($m) { Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $dir = ${q(dir)}
  $task = ${q(SENSORS_TASK)}
  & winget list -e --id ${PAWNIO_WINGET_ID} --accept-source-agreements --disable-interactivity *> $null
  if ($LASTEXITCODE -ne 0) {
    Say 'Cài driver PawnIO bằng winget…'
    & winget install -e --id ${PAWNIO_WINGET_ID} --silent --accept-source-agreements --accept-package-agreements --disable-interactivity *> $null
    if ($LASTEXITCODE -ne 0) { throw "winget cài PawnIO báo mã $LASTEXITCODE" }
  }
  Say 'Dừng bản đang chạy…'
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  Get-Process -Name orbit-sensors -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 800
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $zip = Join-Path $dir 'lhm.zip'
  $stage = Join-Path $dir 'lhm'
  Say 'Tải LibreHardwareMonitor ${LHM_VERSION}…'
  Invoke-WebRequest -UseBasicParsing -Uri ${q(LHM_ZIP_URL)} -OutFile $zip
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
  if ($hash -ne ${q(LHM_ZIP_SHA256)}) { throw "Gói LibreHardwareMonitor tải về sai SHA256 ($hash)" }
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
  Get-ChildItem -LiteralPath $stage -Filter *.dll | Copy-Item -Destination $dir -Force
  Copy-Item -LiteralPath ${q(SENSORS_SOURCE)} -Destination (Join-Path $dir 'win-sensors.cs') -Force
  Remove-Item -LiteralPath $zip, $stage -Recurse -Force
  Say 'Dịch chương trình đo…'
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $built = & $csc -nologo -optimize+ -platform:x64 -target:exe "-out:$dir\orbit-sensors.exe" "-r:$dir\LibreHardwareMonitorLib.dll" (Join-Path $dir 'win-sensors.cs') 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Dịch win-sensors.cs không được: $built" }
  Say 'Đăng ký task SYSTEM…'
  $action = New-ScheduledTaskAction -Execute (Join-Path $dir 'orbit-sensors.exe') -Argument ${q(`${SENSORS_PORT} ${sensorsVersion()}`)} -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $task
  Say 'Xong.'
  exit 0
} catch {
  Say "Lỗi: $($_.Exception.Message)"
  exit 1
}
`;
}

export const STEPS = [
  {
    id: 'node',
    title: 'Node.js 20 trở lên',
    check: () => {
      const major = Number(process.versions.node.split('.')[0]);
      return { ok: major >= 20, detail: `v${process.versions.node}${major >= 20 ? '' : ' (cần 20 trở lên: winget install -e --id OpenJS.NodeJS.LTS)'}` };
    },
  },
  {
    // Lấy code Orbit Remote mới (Setup máy) và chuyển phiên sang máy khác (commit tạm, đẩy, kéo về) đều gọi git.
    id: 'git',
    title: 'Git (lấy code Orbit Remote mới, chuyển phiên sang máy khác)',
    check: () => {
      const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      const ok = r.status === 0;
      return { ok, detail: ok ? String(r.stdout).trim() : 'chưa có lệnh git trên máy' };
    },
    fix: () => {
      if (!isWin) throw new Error('Cài git bằng trình quản lý gói của máy (apt, brew).');
      wingetInstall('Git.Git');
      refreshPath();
    },
  },
  {
    id: 'claude',
    title: 'Claude Code (lệnh claude, để mở phiên từ app)',
    check: (ctx) => {
      const found = resolveClaude(ctx.claudeCommand || undefined);
      const ok = /[\\/]/.test(found) && existsSync(found);
      return { ok, detail: ok ? found : 'chưa có lệnh claude trên máy' };
    },
    fix: () => {
      const npm = join(process.execPath, '..', isWin ? 'npm.cmd' : 'npm');
      // npm.cmd chỉ chạy qua cmd.exe; đường dẫn có dấu cách nên phải đặt trong ngoặc kép.
      spawnSync(isWin ? `"${npm}"` : npm, ['install', '-g', '@anthropic-ai/claude-code'], { stdio: 'inherit', shell: isWin, timeout: 10 * 60 * 1000 });
      refreshPath();
    },
  },
  {
    id: 'claude-login',
    title: 'Claude Code đã đăng nhập',
    optional: true,
    check: () => {
      const ok = existsSync(join(homedir(), '.claude', '.credentials.json')) || Boolean(process.env.ANTHROPIC_API_KEY);
      return { ok, detail: ok ? 'có thông tin đăng nhập' : 'chưa thấy: mở một cửa sổ dòng lệnh, gõ claude rồi đăng nhập một lần' };
    },
  },
  {
    id: 'ffmpeg',
    title: 'ffmpeg có bộ quay màn hình ddagrab (xem màn hình)',
    windowsOnly: true,
    check: () => {
      const p = findFfmpeg();
      if (ffmpegUsable(p)) return { ok: true, detail: `${p.version} · ${p.libx264 ? 'libx264' : 'h264_mf (phần cứng)'} · ${p.path}` };
      return { ok: false, detail: !p ? 'chưa có' : !p.ddagrab ? `${p.path} (${p.version}) thiếu ddagrab` : `${p.path} thiếu bộ mã hoá H.264` };
    },
    fix: () => {
      wingetInstall(FFMPEG_WINGET_ID);
      refreshPath();
    },
  },
  {
    id: 'capture',
    title: 'Quay và nén thử một khung hình',
    windowsOnly: true,
    // Thử đúng chuỗi lùi mà luồng màn hình dùng (screen.mjs): ddagrab rồi gdigrab, libx264 rồi phần cứng.
    check: () => {
      const p = findFfmpeg();
      if (!ffmpegUsable(p)) return { ok: false, detail: 'chưa có ffmpeg dùng được' };
      const screen = { index: 0, x: 0, y: 0, width: 0, height: 0 };
      const tryOne = (method, enc) => {
        const { input, filters } = captureInput(method, screen, 10);
        return spawnSync(p.path, ['-hide_banner', '-loglevel', 'error', ...input, '-frames:v', '1', '-vf', [...filters, 'format=nv12'].join(','),
          ...enc, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      };
      const encoders = [p.libx264 && ['libx264', ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency']], p.h264mf && ['h264_mf', ['-c:v', 'h264_mf', '-hw_encoding', '1']]].filter(Boolean);
      let last = null;
      for (const method of ['ddagrab', 'gdigrab']) {
        for (const [name, enc] of encoders) {
          last = tryOne(method, enc);
          if (last.status !== 0) {
            if (method === 'ddagrab' && DDAGRAB_UNSUPPORTED.test(last.stderr || '')) break; // card không cho quay: sang GDI
            continue;
          }
          const how = method === 'ddagrab' ? 'quay bằng card màn hình (DXGI)' : `quay bằng GDI vì card màn hình không cho quay (máy không cắm màn hình?), tối đa ${GDI_MAX_FPS} khung/giây`;
          return { ok: true, detail: `${how}, nén bằng ${name === 'h264_mf' ? 'phần cứng' : 'libx264'}` };
        }
      }
      const err = (last?.stderr || '').trim().split('\n').pop() || 'không rõ lỗi';
      return { ok: false, detail: `không quay được: ${err.slice(0, 200)} (quay màn hình không chạy trong phiên Remote Desktop hay khi máy đang khoá)` };
    },
  },
  {
    id: 'input',
    title: 'Điều khiển chuột và phím (csc.exe của .NET Framework 4)',
    windowsOnly: true,
    check: async () => {
      const helper = new InputHelper();
      try {
        const screens = await Promise.race([helper.screens(), sleep(20000).then(() => { throw new Error('quá thời gian'); })]);
        return { ok: screens.length > 0, detail: screens.map((s) => `màn ${s.index + 1}: ${s.width}×${s.height}`).join(', ') || 'không thấy màn hình nào' };
      } catch (err) {
        return { ok: false, detail: `${err.message} (bật .NET Framework 4.8 trong "Turn Windows features on or off")` };
      } finally {
        helper.stop();
      }
    },
  },
  {
    // Xem và gõ mật khẩu ở màn khoá, bấm hộp thoại UAC từ app (secure-desk.mjs, win-secure.cs): đầu máy chạy
    // bằng quyền người dùng không được quay hay bấm vào màn bảo mật của Windows, chỉ chương trình SYSTEM
    // trong phiên đang ngồi trước máy mới được. Cài một lần với một hộp thoại UAC: chương trình vào thư mục
    // chỉ quản trị viên ghi được, khoá bí mật chỉ SYSTEM, Administrators và người cài đọc được, tác vụ SYSTEM
    // chạy lúc bật máy. Mã nguồn đổi thì bước này báo cũ và cài lại bản mới.
    id: 'secure-desk',
    title: 'Xem và gõ mật khẩu ở màn khoá (chương trình chạy bằng quyền SYSTEM)',
    windowsOnly: true,
    optional: true,
    admin: true,
    check: async () => {
      const s = await secureStatus();
      return { ok: Boolean(s.installed && s.current && s.running && s.task), detail: s.detail };
    },
    fix: async () => {
      const exePath = buildSecureExe();
      const sid = (powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value').stdout || '').trim();
      const res = powershell(installScript({ exePath, userSid: sid }), { admin: true, timeout: 120000 });
      if (res.status !== 0) throw new Error('chưa được quyền quản trị (hộp thoại UAC bị từ chối hay bị đóng).');
      // Tác vụ vừa chạy: chờ nó dựng chương trình trong phiên này (vài giây) rồi mới kiểm.
      for (let i = 0; i < 10 && !(await secureAvailable()); i += 1) await sleep(1000);
    },
  },
  {
    // Nhiệt độ lõi CPU, ổ đĩa, bo mạch trên app (sensors.mjs): Windows chỉ cho đọc bằng driver và quyền
    // quản trị. Một hộp thoại UAC làm hết: cài driver PawnIO (winget), tải LibreHardwareMonitor bản cố định
    // và so SHA256, dịch win-sensors.cs, rồi cho Task Scheduler chạy nó dưới SYSTEM mỗi lần máy khởi động
    // (đo được cả khi chưa ai đăng nhập). Không bắt buộc: thiếu thì app vẫn hiện GPU NVIDIA như trước.
    id: 'sensors',
    title: 'Đo nhiệt độ CPU, ổ đĩa, bo mạch (driver PawnIO + LibreHardwareMonitor)',
    windowsOnly: true,
    optional: true,
    admin: true,
    check: async () => {
      const d = await askSensors('temps', { timeoutMs: 15000 });
      if (!d) return { ok: false, detail: 'chưa cài (chương trình đo quyền quản trị không trả lời ở cổng ' + SENSORS_PORT + ')' };
      if (!d.ok) return { ok: false, detail: `chương trình đo báo lỗi: ${d.error || 'không rõ'}` };
      if (d.version !== sensorsVersion()) return { ok: false, detail: `chương trình đo là bản cũ (${d.version || 'không rõ'}), cần cài lại` };
      const items = pickHelperItems(d.sensors);
      if (!items.some((x) => x.kind === 'cpu')) return { ok: false, detail: 'chương trình đo chạy nhưng chưa đọc được nhiệt độ CPU (driver PawnIO chưa nạp?)' };
      return { ok: true, detail: items.map((x) => `${x.label} ${Math.round(x.c)}°C`).join(', ') };
    },
    fix: async () => {
      const log = join(tmpdir(), `orbit-sensors-setup-${process.pid}.log`);
      rmSync(log, { force: true });
      const res = powershell(sensorsInstallScript(log), { admin: true, timeout: 15 * 60 * 1000 });
      let said = '';
      try {
        said = readFileSync(log, 'utf8').replace(/^﻿/, '').trim();
        rmSync(log, { force: true });
      } catch {
        // không có nhật ký: script quyền quản trị chưa chạy (UAC bị từ chối hay bị đóng)
      }
      if (res.status !== 0) throw new Error(said.split('\n').pop() || 'chưa được quyền quản trị (hộp thoại UAC bị từ chối hay bị đóng).');
      // Lần đầu mở driver và dò phần cứng mất vài giây: chờ chương trình đo trả lời rồi mới kiểm lại.
      for (let i = 0; i < 30 && !(await askSensors('version', { timeoutMs: 1000 })); i += 1) await sleep(1000);
    },
  },
  {
    id: 'firewall',
    title: 'Tường lửa cho điện thoại nối vào máy qua mạng nhà',
    windowsOnly: true,
    admin: true,
    check: (ctx) => {
      const fw = readFirewall();
      if (!fw) return { ok: false, detail: 'không đọc được tường lửa' };
      const missing = firewallRules(ctx).filter((r) => !fw.allow.includes(r.name));
      const parts = [];
      if (missing.length) parts.push(`thiếu luật cho ${missing.map((r) => `${r.protocol} ${r.port}`).join(', ')}`);
      if (fw.block.length) parts.push(`${fw.block.length} luật đang CHẶN node.exe (do từng bấm Huỷ ở hộp thoại tường lửa)`);
      return { ok: !parts.length, detail: parts.join('; ') || firewallRules(ctx).map((r) => `${r.protocol} ${r.port}`).join(', ') + ' đã mở' };
    },
    fix: (ctx) => {
      const fw = readFirewall() || { block: [] };
      const res = powershell(firewallScript(ctx, fw.block), { admin: true, timeout: 120000 });
      if (res.status !== 0) throw new Error('chưa được quyền quản trị (hộp thoại UAC bị từ chối hay bị đóng).');
    },
  },
  {
    id: 'tailscale',
    title: 'Tailscale đã đăng nhập (xem máy từ ngoài mạng nhà)',
    interactive: true, // cài cần UAC, đăng nhập cần trình duyệt: phải có người ngồi tại máy
    check: () => {
      const cmd = findTailscale();
      if (!cmd) return { ok: false, detail: 'chưa cài' };
      const info = tailnetFromStatus(readTailscaleStatus(cmd));
      return { ok: info.running && Boolean(info.ipv4), detail: info.running ? `địa chỉ ${info.ipv4}` : `chưa đăng nhập (${info.state || 'không rõ trạng thái'})` };
    },
    fix: () => {
      if (!findTailscale()) {
        wingetInstall('Tailscale.Tailscale');
        refreshPath();
      }
      const cmd = findTailscale();
      if (!cmd) throw new Error('cài Tailscale không xong.');
      process.stdout.write('\nĐăng nhập Tailscale bằng CÙNG tài khoản với máy giữ trạm (trình duyệt sẽ mở, hoặc mở đường dẫn in ra dưới đây).\n');
      spawnSync(cmd, ['up'], { stdio: 'inherit', timeout: APPROVAL_WAIT_MS });
    },
  },
  {
    // Tailscale cài mặc định trên Windows chỉ nối khi có người đã đăng nhập: máy bật lên mà đứng ở màn
    // đăng nhập thì không ai tới được, app thấy máy tắt dù máy đang chạy (đã gặp thật: card
    // mạng vẫn trả lời, Tailscale ngoại tuyến 9 tiếng). "Unattended Mode" giữ Tailscale chạy cả khi chưa
    // ai đăng nhập. Đo trên Tailscale 1.104: `tailscale set --unattended` chạy được không cần quyền quản
    // trị, không đụng các cài đặt khác; `tailscale debug prefs` báo ForceDaemon.
    id: 'tailscale-unattended',
    title: 'Tailscale chạy cả khi chưa đăng nhập Windows',
    windowsOnly: true,
    optional: true,
    check: () => {
      const cmd = findTailscale();
      if (!cmd) return { ok: false, detail: 'chưa có Tailscale' };
      const prefs = readTailscalePrefs(cmd);
      if (!prefs) return { ok: false, detail: 'không đọc được cài đặt của Tailscale' };
      return prefs.ForceDaemon
        ? { ok: true, detail: 'đang bật' }
        : { ok: false, detail: 'đang tắt: máy đứng ở màn đăng nhập thì Tailscale không nối, app thấy máy tắt' };
    },
    fix: () => {
      const cmd = findTailscale();
      if (!cmd) throw new Error('chưa có Tailscale.');
      const r = spawnSync(cmd, ['set', '--unattended'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (r.status !== 0) throw new Error(`tailscale set --unattended báo lỗi: ${`${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 200)}`);
    },
  },
  {
    // Để bật máy này từ app lúc nó đã tắt (wake.mjs). Phần trong Windows kiểm và bật được; BIOS (bật
    // Wake on LAN, tắt ErP) thì phần mềm không chạm tới, chỉ nhắc. Không bắt buộc: chỉ cần cho máy
    // muốn bật từ xa.
    id: 'wake',
    title: 'Bật được máy này qua mạng (Wake-on-LAN)',
    windowsOnly: true,
    optional: true,
    admin: true,
    check: () => {
      const w = readWake();
      if (!w) return { ok: false, detail: 'không đọc được card mạng' };
      if (!w.wired.length) return { ok: false, detail: 'không có card mạng có dây (bật máy qua Wi-Fi hầu như không chạy)' };
      const problems = [];
      for (const a of w.wired) {
        if (a.magic === '0') problems.push(`${a.name}: "Wake on Magic Packet" đang tắt`);
        if (a.s5 === '0') problems.push(`${a.name}: "Shutdown Wake-On-Lan" đang tắt`);
        if (!a.armed) problems.push(`${a.name}: chưa được phép đánh thức máy`);
      }
      if (w.fastStartup !== 0) problems.push('Fast Startup đang bật (tắt máy kiểu ngủ đông lai làm card mạng không dậy)');
      const bios = 'BIOS: bật Wake on LAN, tắt ErP (phần mềm không kiểm được)';
      return { ok: !problems.length, detail: problems.length ? `${problems.join('; ')}. ${bios}` : `${w.wired.map((a) => a.name).join(', ')} sẵn sàng. ${bios}` };
    },
    fix: () => {
      const w = readWake() || { wired: [] };
      const lines = ["$ErrorActionPreference = 'Continue'"];
      for (const a of w.wired) {
        // Đổi thuộc tính card có thể làm mạng chớp tắt vài giây: chỉ đổi thứ đang tắt.
        if (a.magic === '0') lines.push(`Set-NetAdapterAdvancedProperty -Name ${q(a.name)} -RegistryKeyword '*WakeOnMagicPacket' -RegistryValue 1`);
        if (a.s5 === '0') lines.push(`Set-NetAdapterAdvancedProperty -Name ${q(a.name)} -RegistryKeyword 'S5WakeOnLan' -RegistryValue 1`);
        if (!a.armed) lines.push(`powercfg /deviceenablewake ${q(a.desc)}`);
      }
      if (w.fastStartup !== 0) lines.push("Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power' -Name HiberbootEnabled -Value 0 -Type DWord");
      if (lines.length === 1) return;
      const res = powershell(lines.join('\n'), { admin: true, timeout: 120000 });
      if (res.status !== 0) throw new Error('chưa được quyền quản trị (hộp thoại UAC bị từ chối hay bị đóng).');
    },
  },
  {
    id: 'enabled',
    title: 'Orbit Remote đang bật trên máy này',
    check: (ctx) => {
      if (process.env.ORBIT_REMOTE_OFF === '1') return { ok: false, detail: 'biến môi trường ORBIT_REMOTE_OFF=1 đang tắt nó (xoá biến này đi)' };
      return { ok: !existsSync(ctx.disabledFile), detail: existsSync(ctx.disabledFile) ? 'đang tắt ("main.mjs disable")' : 'đang bật' };
    },
    fix: (ctx) => rmSync(ctx.disabledFile, { force: true }),
  },
  {
    id: 'autostart',
    title: 'Tự chạy khi đăng nhập Windows',
    windowsOnly: true,
    check: (ctx) => {
      let text = '';
      try {
        text = readFileSync(ctx.autostartFile, 'ascii');
      } catch {
        return { ok: false, detail: 'chưa bật' };
      }
      const ok = text.includes(ctx.selfPath) && text.includes(process.execPath);
      return { ok, detail: ok ? ctx.autostartFile : 'tệp tự chạy trỏ tới chỗ cũ' };
    },
    fix: (ctx) => ctx.autostartOn(),
  },
  {
    // Bản PC (pc-app.mjs): lối tắt "Orbit Remote" ở Start và Desktop mở app thành cửa sổ riêng của Edge.
    // Không cần quyền quản trị; tệp mở app trỏ tới node và thư mục Orbit Remote hiện tại, dời chỗ thì làm lại.
    id: 'pc-app',
    title: 'Lối tắt Orbit Remote cho máy tính (cửa sổ app Edge)',
    windowsOnly: true,
    optional: true,
    check: () => {
      if (!findAppBrowser()) return { ok: false, detail: 'máy không có Microsoft Edge hay Google Chrome' };
      let script = '';
      try {
        script = readFileSync(APP_LAUNCHER_FILE, 'ascii');
      } catch {
        return { ok: false, detail: 'chưa có' };
      }
      if (script !== launcherScript(process.execPath, join(TOOL_DIR, 'src', 'main.mjs'))) return { ok: false, detail: 'tệp mở app trỏ tới chỗ cũ' };
      if (!existsSync(APP_ICON_FILE)) return { ok: false, detail: 'thiếu biểu tượng' };
      const links = readShortcuts();
      const missing = links.filter((l) => !l.ok);
      if (!links.length) return { ok: false, detail: 'không đọc được thư mục Start và Desktop' };
      return missing.length
        ? { ok: false, detail: `thiếu lối tắt: ${missing.map((l) => l.path).join(', ')}` }
        : { ok: true, detail: links.map((l) => l.path).join(', ') };
    },
    fix: () => installShortcuts(),
  },
  {
    id: 'agent',
    title: 'Trạm hay đầu máy đang chạy bản code mới nhất',
    // Trạm đang có phiên chạy thì không tự khởi động lại (cắt phiên): chỉ nhắc, không tính là hỏng.
    optional: (ctx) => ctx.role === 'hub',
    check: (ctx) => {
      const procs = orbitProcesses().filter((p) => p.mode === (ctx.role === 'hub' ? 'hub' : 'node'));
      if (!procs.length) return { ok: false, detail: 'chưa chạy' };
      const newest = newestSourceMtime();
      const stale = procs.find((p) => Date.parse(p.started) < newest);
      if (stale || ctx.installed) return { ok: false, detail: stale ? 'đang chạy bản code cũ hơn bản trên đĩa' : 'vừa cài thêm chương trình, cần chạy lại để thấy' };
      return { ok: true, detail: `mở lúc ${new Date(procs[0].started).toLocaleString('vi-VN', { hour12: false })}` };
    },
    // ctx.force (setup tự động bấm từ app): khởi động lại dù còn phiên chạy, vì người bấm đã đồng ý cắt.
    fix: async (ctx) => {
      if (ctx.role === 'hub') {
        const r = await ctx.restartHub(Boolean(ctx.force));
        if (!r.ok) throw new Error(`trạm đang có ${r.running} phiên Claude chạy; đóng các phiên đó rồi chạy "node src/main.mjs restart".`);
        ctx.installed = false;
        return;
      }
      if (await ctx.pipeInUse()) {
        let reply = await pipeAsk({ op: 'shutdown', force: Boolean(ctx.force) });
        // Đầu máy biết lệnh này luôn trả kèm số phiên đang chạy. Bản cũ chưa biết thì trả lỗi "chưa tự
        // giới thiệu" (không kèm số phiên), hoặc không trả gì.
        const knows = typeof reply?.data?.running === 'number';
        if (knows && !reply.ok && reply.data.running > 0) {
          await allowClosing(ctx, describeSessions(reply.data));
          reply = await pipeAsk({ op: 'shutdown', force: true });
        }
        if (knows && !reply?.ok) throw new Error(reply?.error || 'đầu máy không trả lời lệnh tắt.');
        const closed = knows ? reply.data?.sessions?.length || 0 : 0;
        if (closed) process.stdout.write(`Đã đóng ${closed} phiên mở từ app; muốn làm tiếp thì mở phiên trên app rồi bấm "Chạy lại".\n`);
        if (!knows) {
          // Đầu máy bản cũ chưa biết lệnh "shutdown": tắt tiến trình, hỏi trước nếu nó còn giữ phiên.
          for (const p of orbitProcesses().filter((x) => x.mode === 'node')) {
            if (p.children && !ctx.force) await allowClosing(ctx, `${p.children} phiên`);
            // Còn phiên mà được phép cắt: tắt cả cây tiến trình, để không sót phiên Claude mồ côi.
            if (p.children) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
            else process.kill(p.pid);
          }
        }
        for (let i = 0; i < 40 && (await ctx.pipeInUse()); i += 1) await sleep(250);
      }
      ctx.spawnNode();
      for (let i = 0; i < 40 && !(await ctx.pipeInUse()); i += 1) await sleep(250);
      ctx.installed = false;
    },
  },
  {
    id: 'hub',
    title: 'Đã nối vào trạm',
    interactive: true, // chờ người bấm "Cho nối" trên điện thoại
    check: async (ctx) => {
      if (ctx.role === 'hub') return { ok: true, detail: 'máy này là trạm' };
      const state = ctx.nodeState();
      const urls = ctx.hubUrls();
      const reachable = [];
      for (const u of urls) if (await pingHub(u, state.hubId)) reachable.push(u);
      if (!state.token) {
        return { ok: false, detail: `chưa được duyệt${reachable.length ? ` (thấy trạm ở ${reachable[0]})` : urls.length ? `; chưa tới được trạm ở ${urls.join(', ')}` : '; chưa biết trạm ở đâu'}` };
      }
      if (!reachable.length) return { ok: false, detail: `đã được duyệt nhưng chưa tới được trạm ở ${urls.join(', ') || '(không có địa chỉ)'}: bật Tailscale cùng tài khoản với máy trạm` };
      return { ok: true, detail: `trạm ${state.hubName || ''} ở ${reachable[0]}` };
    },
    fix: async (ctx) => {
      const state = ctx.nodeState();
      const urls = ctx.hubUrls();
      let seen = false;
      for (const u of urls) if (!seen && (await pingHub(u, state.hubId))) seen = true;
      // Địa chỉ trạm khai trong kho mà không tới được cái nào thì chờ duyệt cũng vô ích. Kho chưa khai
      // trạm thì đầu máy vẫn có thể tự dò ra trạm trong mạng nhà, nên vẫn chờ.
      if (urls.length && !seen) throw new Error(`chưa tới được trạm ở ${urls.join(', ')}. Bật máy giữ trạm, và đăng nhập Tailscale cùng tài khoản với máy đó.`);
      if (!(await ctx.pipeInUse())) ctx.spawnNode();
      process.stdout.write('\nMở Orbit Remote trên điện thoại: ở màn chính có thẻ "Máy mới xin nối" mang tên máy này, bấm "Cho nối".\n'
        + `Đang chờ duyệt (tối đa ${APPROVAL_WAIT_MS / 60000} phút)…\n`);
      const until = Date.now() + APPROVAL_WAIT_MS;
      while (Date.now() < until && !ctx.nodeState().token) await sleep(2000);
    },
  },
];

// ---- Chạy --------------------------------------------------------------------------------------

const MARK = { ok: '[  OK  ]', miss: '[ THIẾU]', warn: '[LƯU Ý]', skip: '[BỎ QUA]', fail: '[ HỎNG]', user: '[CẦN NGƯỜI]' };

async function checkStep(step, ctx) {
  try {
    return await step.check(ctx);
  } catch (err) {
    return { ok: false, detail: `kiểm không được: ${err.message}` };
  }
}

// Kết quả cho app (màn của máy): ghi sau mỗi bước, nên dù setup tự khởi động lại đầu máy giữa chừng,
// đầu máy mới vẫn đọc được tới bước gần nhất. needsUser: bước setup tự động không làm hộ được.
// Lấy code Orbit Remote mới nhất trước khi setup (lệnh "Setup máy" bấm từ app). Một lệnh git khác chạy cùng
// lúc trên cùng kho (VS Code tự fetch định kỳ chẳng hạn) làm
// git báo lỗi tranh chấp khi cập nhật nhánh, ví dụ "fetching ref refs/remotes/origin/main failed:
// incorrect old value provided" (đã gặp thật). Lỗi đó tự hết khi lệnh kia xong: chờ một
// chút rồi thử lại. Lỗi khác (mạng, đăng nhập, nhánh rẽ đôi) thì báo ngay.
const GIT_RACE = /incorrect old value provided|cannot lock ref|unable to update local ref|Unable to create '[^']*\.lock'/i;
export const PULL_TRIES = 4;

function gitPullOnce(repo) {
  // Chạy nền, không ai gõ mật khẩu: git cần đăng nhập thì báo lỗi ngay thay vì treo chờ.
  const r = spawnSync('git', ['-C', repo, 'pull', '--ff-only'], {
    encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { status: r.status, said: `${r.stdout || ''}${r.stderr || ''}`.trim() || r.error?.message || '' };
}

export async function pullRepo(repo, { run = gitPullOnce, wait = sleep, log = () => {} } = {}) {
  let result;
  for (let attempt = 1; ; attempt += 1) {
    result = run(repo);
    if (result.said) log(result.said);
    if (result.status === 0 || attempt >= PULL_TRIES || !GIT_RACE.test(result.said)) {
      const failed = result.status !== 0;
      const pulled = !failed
        ? (/Already up to date|Đã cập nhật/i.test(result.said) ? 'đã là bản mới nhất' : 'đã kéo bản mới')
        : `không kéo được: ${result.said.split('\n').pop()}`;
      return { failed, pulled, attempts: attempt };
    }
    log(`Một lệnh git khác đang chạy trên kho này; thử lại sau ${attempt * 2} giây (lần ${attempt + 1}/${PULL_TRIES})…`);
    await wait(attempt * 2000);
  }
}

// Bước lấy code mới nhất chạy trước setup (lệnh "Setup máy", hay setup.cmd): hỏng thì máy vẫn chạy
// code cũ, nên kết quả là còn thiếu chứ không phải "đủ cả".
export const PULL_TITLE = 'Lấy code Orbit Remote mới nhất (git pull)';
function pullProblem() {
  if (process.env.ORBIT_REMOTE_PULL_FAILED !== '1') return null;
  const said = (process.env.ORBIT_REMOTE_PULL || '').replace(/^không kéo được:\s*/, '');
  return { title: PULL_TITLE, detail: `${said || 'git pull --ff-only hỏng (xem cửa sổ setup)'}. Setup đã chạy bằng code đang có trên máy; bấm "Setup máy" lần nữa để thử lại.` };
}

function writeResult(ctx, mode, results, done) {
  if (!ctx.resultFile) return;
  const pick = (state) => results.filter((x) => x.state === state).map((x) => ({ title: x.step.title, detail: x.detail }));
  const pull = pullProblem();
  try {
    writeJsonAtomic(ctx.resultFile, {
      at: new Date().toISOString(),
      mode,
      pull: process.env.ORBIT_REMOTE_PULL || (pull ? 'không kéo được' : ''),
      done,
      ok: done && !pull && !results.some((x) => x.state === 'fail' || x.state === 'user'),
      failed: [...(pull ? [pull] : []), ...pick('fail')],
      needsUser: pick('user'),
      warnings: pick('warn'),
    });
  } catch {
    // không ghi được thì app chỉ thiếu dòng kết quả
  }
}

// args: --no-admin bỏ bước cần quyền quản trị; --unattended (lệnh "Setup máy" bấm từ app, không ai
// ngồi tại máy): bỏ mọi bước cần người (UAC, đăng nhập, bấm duyệt), và khởi động lại đầu máy dù còn
// phiên chạy, vì người bấm đã đồng ý cắt.
export async function runSetup({ fix, args = [], ctx, steps = STEPS }) {
  const out = (line) => process.stdout.write(`${line}\n`);
  const unattended = args.includes('--unattended');
  const noAdmin = unattended || args.includes('--no-admin');
  const mode = !fix ? 'doctor' : unattended ? 'auto' : 'setup';
  ctx.force = unattended;
  ctx.noAdmin = noAdmin; // bước tự cài thứ cần UAC xem cờ này: chạy tự động thì khỏi đứng chờ hộp thoại
  out(`Orbit Remote: ${fix ? 'cài' : 'kiểm'} máy ${ctx.machine} (${ctx.role === 'hub' ? 'máy giữ trạm' : 'máy chạy phiên, không phải trạm'})${unattended ? ', tự động' : ''}`);
  if (process.env.ORBIT_REMOTE_PULL) out(`Code Orbit Remote: ${process.env.ORBIT_REMOTE_PULL}`);
  const pull = pullProblem();
  if (pull) out(`${MARK.fail} ${pull.title}: ${pull.detail}`);
  out('');
  const results = [];
  for (const step of steps) {
    if (step.windowsOnly && !isWin) {
      results.push({ step, state: 'skip', detail: 'chỉ làm cho Windows' });
      out(`${MARK.skip} ${step.title}: chỉ làm cho Windows`);
      continue;
    }
    let r = await checkStep(step, ctx);
    const needsPerson = unattended && (step.interactive || step.admin);
    if (!r.ok && needsPerson) {
      // Setup tự động không làm hộ được: ghi lại để app nhắc người ngồi tại máy chạy setup.cmd. Bước
      // không bắt buộc thì chỉ là lưu ý, không tính là còn thiếu.
      const isOptional = typeof step.optional === 'function' ? step.optional(ctx) : Boolean(step.optional);
      const state = isOptional ? 'warn' : 'user';
      results.push({ step, state, detail: `${r.detail} (cần làm tại máy: nháy đúp setup.cmd)` });
      out(`${MARK[state]} ${step.title}: ${r.detail} (cần làm tại máy: nháy đúp setup.cmd)`);
      writeResult(ctx, mode, results, false);
      continue;
    }
    if (!r.ok && fix && step.fix && !(step.admin && noAdmin)) {
      out(`${MARK.miss} ${step.title}: ${r.detail} → đang sửa…`);
      try {
        await step.fix(ctx);
        if (['claude', 'ffmpeg', 'tailscale', 'firewall', 'enabled'].includes(step.id)) ctx.installed = true;
      } catch (err) {
        out(`         sửa không xong: ${err.message}`);
      }
      r = await checkStep(step, ctx);
    }
    const optional = typeof step.optional === 'function' ? step.optional(ctx) : Boolean(step.optional);
    const state = r.ok ? 'ok' : optional ? 'warn' : 'fail';
    results.push({ step, state, detail: r.detail });
    out(`${MARK[state]} ${step.title}: ${r.detail}${!r.ok && step.admin && noAdmin ? ' (bỏ qua vì --no-admin)' : ''}`);
    writeResult(ctx, mode, results, false);
  }
  writeResult(ctx, mode, results, true);
  const failed = [...(pull ? [pull.title] : []), ...results.filter((x) => x.state === 'fail').map((x) => x.step.title)];
  const user = results.filter((x) => x.state === 'user');
  if (user.length) out(`\nCần người ngồi tại máy: ${user.map((x) => x.step.title).join('; ')}. Nháy đúp setup.cmd trên máy đó.`);
  out('');
  if (!failed.length) out(fix ? 'Xong: máy này đã đủ để dùng Orbit Remote, kể cả xem và điều khiển màn hình.' : 'Đủ cả.');
  else out(`Còn ${failed.length} mục chưa xong: ${failed.join('; ')}.${fix ? ' Sửa theo ghi chú ở trên rồi chạy lại setup.cmd.' : ' Chạy setup.cmd để cài.'}`);
  return failed.length || user.length ? 1 : 0;
}
