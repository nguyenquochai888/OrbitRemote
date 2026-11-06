// Bản PC của Orbit Remote: cửa sổ app riêng của Edge (không thanh địa chỉ, không tab) mở đúng app web
// của trạm, cộng lối tắt "Orbit Remote" ở Start và Desktop. Không cài thêm gì: Edge có sẵn trong mọi
// Windows, app tự cập nhật theo trạm như bản điện thoại.
//
// Cửa sổ dùng hồ sơ trình duyệt riêng (thư mục app-profile trong thư mục trạng thái): không lẫn cookie,
// tiện ích hay cửa sổ với trình duyệt thường của người dùng, và ghép đôi với trạm đúng một lần.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, TOOL_DIR, ensureDir } from './paths.mjs';

export const APP_PROFILE_DIR = join(STATE_DIR, 'app-profile');
export const APP_ICON_FILE = join(STATE_DIR, 'orbit-remote.ico');
export const APP_LAUNCHER_FILE = join(STATE_DIR, 'Orbit Remote app.vbs');
const FIRST_SIZE = [1440, 900]; // cỡ cửa sổ lần mở đầu; sau đó trình duyệt nhớ chỗ và cỡ người dùng kéo
const SHORTCUT_NAME = 'Orbit Remote.lnk';

// Edge trước (có trong mọi Windows), không có thì Chrome. Cả hai có chế độ cửa sổ app (--app).
export function findAppBrowser(env = process.env, exists = existsSync) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  for (const [vendor, app, exe] of [['Microsoft', 'Edge', 'msedge.exe'], ['Google', 'Chrome', 'chrome.exe']]) {
    for (const root of roots) {
      const p = join(root, vendor, app, 'Application', exe);
      if (exists(p)) return p;
    }
  }
  return null;
}

// Tham số mở cửa sổ app. firstRun: trình duyệt chưa nhớ chỗ cửa sổ (xem hasSavedPlacement) thì đặt cỡ
// cửa sổ cho vừa màn máy tính; các lần sau để trình duyệt tự nhớ chỗ và cỡ người dùng kéo.
export function appWindowArgs(url, { profileDir = APP_PROFILE_DIR, firstRun = false } = {}) {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(firstRun ? [`--window-size=${FIRST_SIZE[0]},${FIRST_SIZE[1]}`] : []),
  ];
}

// Trình duyệt chỉ ghi chỗ và cỡ cửa sổ app khi cửa sổ được đóng đàng hoàng. Chưa có bản ghi đó (lần mở
// đầu, hay lần trước trình duyệt bị tắt ngang) thì coi như lần đầu để đặt cỡ, kẻo cửa sổ mở ra bé xíu.
export function hasSavedPlacement(profileDir = APP_PROFILE_DIR) {
  try {
    return readFileSync(join(profileDir, 'Default', 'Preferences'), 'utf8').includes('"app_window_placement"');
  } catch {
    return false;
  }
}

export function openAppWindow(url, { browser = findAppBrowser(), profileDir = APP_PROFILE_DIR } = {}) {
  if (!browser) throw new Error('Máy này không có Microsoft Edge hay Google Chrome để mở cửa sổ app.');
  const firstRun = !hasSavedPlacement(profileDir);
  spawn(browser, appWindowArgs(url, { profileDir, firstRun }), { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { browser, firstRun };
}

// Tệp .ico từ ảnh PNG: Windows (từ Vista) đọc được ảnh PNG đặt thẳng trong tệp .ico, cỡ tới 256.
export function icoFromPng(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('Không phải ảnh PNG.');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width > 256 || height > 256) throw new Error('Ảnh trong tệp .ico tối đa 256×256.');
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); // dự phòng
  head.writeUInt16LE(1, 2); // loại: biểu tượng
  head.writeUInt16LE(1, 4); // một ảnh
  head[6] = width === 256 ? 0 : width;
  head[7] = height === 256 ? 0 : height;
  head[8] = 0; // không bảng màu
  head[9] = 0;
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bit mỗi điểm ảnh
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18); // ảnh nằm ngay sau phần đầu
  return Buffer.concat([head, png]);
}

// Tệp VBScript chạy "node main.mjs app" không kèm cửa sổ console (như tệp tự chạy của autostart).
// Chỉ ký tự ASCII: Windows Script Host không đọc UTF-8 không BOM; đường dẫn có dấu thì thôi dùng tệp này.
export function launcherScript(nodeExe, mainFile) {
  const raw = `"${nodeExe}" "${mainFile}" app`;
  return `' Orbit Remote: open the Orbit Remote app window (Edge app mode) without a console window.\r\nCreateObject("WScript.Shell").Run "${raw.replace(/"/g, '""')}", 0, False\r\n`;
}

function powershell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
}
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Lối tắt ở Start (thư mục Programs của người dùng) và Desktop. Hỏi Windows chỗ thật của hai thư mục:
// Desktop hay bị OneDrive dời sang OneDrive\Desktop.
let folders = null;
export function shortcutPaths() {
  if (!folders) {
    const r = powershell("[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('Programs'); [Environment]::GetFolderPath('Desktop')");
    folders = (r.stdout || '').trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  return folders.map((dir) => join(dir, SHORTCUT_NAME));
}

// Lối tắt nào đang có và trỏ đúng tệp mở app: { path, ok }[]. Đọc bằng WScript.Shell (chỉ đọc).
export function readShortcuts(paths = shortcutPaths()) {
  const present = paths.filter((p) => existsSync(p));
  if (!present.length) return paths.map((path) => ({ path, ok: false }));
  const r = powershell(`[Console]::OutputEncoding = [Text.Encoding]::UTF8; $s = New-Object -ComObject WScript.Shell; foreach ($p in @(${present.map(psq).join(',')})) { $l = $s.CreateShortcut($p); "$($l.TargetPath)|$($l.Arguments)" }`);
  const lines = (r.stdout || '').trim().split(/\r?\n/);
  return paths.map((path) => {
    const i = present.indexOf(path);
    const line = i >= 0 ? lines[i] || '' : '';
    return { path, ok: i >= 0 && /wscript\.exe\|/i.test(line) && line.includes(APP_LAUNCHER_FILE) };
  });
}

// Dựng tệp mở app, biểu tượng, rồi lối tắt ở Start và Desktop. Không cần quyền quản trị.
export function installShortcuts({ nodeExe = process.execPath, mainFile = join(TOOL_DIR, 'src', 'main.mjs'), paths = shortcutPaths() } = {}) {
  ensureDir(STATE_DIR);
  writeFileSync(APP_ICON_FILE, icoFromPng(readFileSync(join(TOOL_DIR, 'web', 'icons', 'icon-192.png'))));
  const script = launcherScript(nodeExe, mainFile);
  if (!/^[\x20-\x7e\r\n]*$/.test(script)) throw new Error('Đường dẫn tới node hay thư mục Orbit Remote có ký tự ngoài ASCII; Windows Script Host không đọc được.');
  writeFileSync(APP_LAUNCHER_FILE, script, 'ascii');
  const wscript = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
  const lines = ['$s = New-Object -ComObject WScript.Shell'];
  for (const p of paths) {
    lines.push(`$l = $s.CreateShortcut(${psq(p)})`, `$l.TargetPath = ${psq(wscript)}`, `$l.Arguments = ${psq(`"${APP_LAUNCHER_FILE}"`)}`,
      `$l.WorkingDirectory = ${psq(TOOL_DIR)}`, `$l.IconLocation = ${psq(`${APP_ICON_FILE},0`)}`,
      `$l.Description = ${psq('Orbit Remote: điều khiển mọi phiên Claude và màn hình các máy')}`, '$l.Save()');
  }
  const r = powershell(lines.join('\n'));
  if (r.status !== 0) throw new Error(`Không tạo được lối tắt: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
}
