// Tìm ffmpeg dùng được cho luồng màn hình: chạy được, có bộ quay DXGI (ddagrab), và có ít nhất
// một bộ mã hoá H.264 (h264_mf dùng phần cứng, hay libx264 dự phòng).
//
// Không chỉ trông vào PATH: winget cài ffmpeg rồi mới thêm thư mục của nó vào PATH của người dùng,
// mà đầu máy chạy nền được mở từ trước (từ hook đầu phiên) vẫn giữ PATH cũ cho tới khi tắt. Nên tìm
// cả ở những chỗ winget, Chocolatey, Scoop hay đặt, để cài xong là dùng được ngay, không phải khởi
// động lại gì. Máy có ffmpeg cũ thiếu ddagrab trên PATH thì bản có ddagrab ở chỗ khác được ưu tiên.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const FFMPEG_WINGET_ID = 'Gyan.FFmpeg';

const run = (cmd, args) => spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024 });

function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const ext of exts) {
      const file = dir && join(dir, name + ext);
      if (file && existsSync(file)) return file;
    }
  }
  return null;
}

// Gói winget dạng tệp nén: Packages\Gyan.FFmpeg_<nguồn>\ffmpeg-<bản>-full_build\bin\ffmpeg.exe.
function wingetPackages(root) {
  const out = [];
  let dirs = [];
  try {
    dirs = readdirSync(root).filter((d) => d.startsWith(`${FFMPEG_WINGET_ID}_`) || d.startsWith(`${FFMPEG_WINGET_ID}.`));
  } catch {
    return out;
  }
  for (const d of dirs) {
    let builds = [];
    try {
      builds = readdirSync(join(root, d));
    } catch {
      continue;
    }
    for (const b of builds) out.push(join(root, d, b, 'bin', 'ffmpeg.exe'));
  }
  return out;
}

export function ffmpegCandidates() {
  const list = [];
  if (process.env.ORBIT_REMOTE_FFMPEG) list.push(process.env.ORBIT_REMOTE_FFMPEG);
  const fromPath = onPath('ffmpeg');
  if (fromPath) list.push(fromPath);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    if (local) list.push(join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
    list.push(join(programFiles, 'WinGet', 'Links', 'ffmpeg.exe'));
    if (local) list.push(...wingetPackages(join(local, 'Microsoft', 'WinGet', 'Packages')));
    list.push(...wingetPackages(join(programFiles, 'WinGet', 'Packages')));
    list.push('C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe');
    if (process.env.USERPROFILE) list.push(join(process.env.USERPROFILE, 'scoop', 'shims', 'ffmpeg.exe'));
    list.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  }
  return [...new Set(list)].filter((p) => p && (!/[\\/]/.test(p) || existsSync(p)));
}

// Hỏi một bản ffmpeg nó làm được gì. Trả null nếu không chạy được.
export function probeFfmpeg(cmd) {
  const version = run(cmd, ['-hide_banner', '-version']);
  if (version.status !== 0) return null;
  const filters = run(cmd, ['-hide_banner', '-filters']).stdout || '';
  const encoders = run(cmd, ['-hide_banner', '-encoders']).stdout || '';
  return {
    path: cmd,
    version: /ffmpeg version (\S+)/.exec(version.stdout || '')?.[1] || '',
    ddagrab: /\bddagrab\b/.test(filters),
    h264mf: /\bh264_mf\b/.test(encoders),
    libx264: /\blibx264\b/.test(encoders),
  };
}

const usable = (p) => p && p.ddagrab && (p.h264mf || p.libx264);

// Bản dùng được đầu tiên; không có thì bản chạy được đầu tiên (để báo đúng chỗ thiếu); không có gì
// thì null.
export function findFfmpeg() {
  let fallback = null;
  for (const cmd of ffmpegCandidates()) {
    const p = probeFfmpeg(cmd);
    if (usable(p)) return p;
    if (p && !fallback) fallback = p;
  }
  return fallback;
}

export const ffmpegUsable = usable;

// Hai cách quay màn hình. ddagrab (DXGI Desktop Duplication) chép thẳng trên card màn hình, gần như
// không tốn CPU và chỉ sinh khung khi màn hình đổi. Nhưng nó cần một card tạo được thiết bị D3D11 có
// tăng tốc video cho màn đó: máy không cắm màn hình (chỉ còn màn ảo của Windows) hay card chưa có
// driver thì không quay được (đo trên một máy mini không màn hình: "Failed to create D3D11VA device").
// Khi đó lùi về gdigrab (GDI): chạy ở mọi máy, nhưng chép bằng CPU và sinh khung đều đặn, nên giới
// hạn ở GDI_MAX_FPS để không đè nặng CPU.
export const DDAGRAB_UNSUPPORTED = /Failed to create D3D11VA device|DXGI_ERROR_UNSUPPORTED|D3D11CreateDevice/i;
export const GDI_MAX_FPS = 30;

// Nguồn là một vùng trên một màn (cửa sổ), không phải trọn một màn.
export const isArea = (source) => source?.kind === 'window';

// Phần đầu vào của lệnh ffmpeg và các bộ lọc phải đứng đầu chuỗi lọc (ddagrab trả khung nằm trên
// card màn hình, phải tải về bộ nhớ trước). `wholeDesktop`: máy chỉ có một màn hình thì gdigrab quay
// trọn màn hình; nhiều màn thì cắt đúng vùng của màn được chọn (toạ độ màn hình của Windows).
export function captureInput(method, screen, fps, wholeDesktop = true) {
  if (method === 'ddagrab' && isArea(screen)) {
    // Một vùng (cửa sổ, khung game): quay đúng vùng đó trên màn hình chứa nó (toạ độ tính từ góc màn
    // đó). Ảnh và chuột dùng chung một hệ toạ độ màn hình nên khớp từng điểm ảnh. Máy đã đưa cửa sổ lên
    // trước; thứ gì che lên thì hiện đúng thứ đó, cũng là thứ cú chạm sẽ bấm vào.
    const opts = [`output_idx=${screen.index}`, `framerate=${fps}`, 'dup_frames=0', 'draw_mouse=1',
      `offset_x=${screen.x - screen.monX}`, `offset_y=${screen.y - screen.monY}`, `video_size=${screen.width}x${screen.height}`];
    return { input: ['-f', 'lavfi', '-i', `ddagrab=${opts.join(':')}`], filters: ['hwdownload', 'format=bgra'] };
  }
  if (method === 'gdigrab') {
    const area = wholeDesktop ? [] : ['-offset_x', String(screen.x), '-offset_y', String(screen.y), '-video_size', `${screen.width}x${screen.height}`];
    return { input: ['-f', 'gdigrab', '-framerate', String(Math.min(fps, GDI_MAX_FPS)), '-draw_mouse', '1', ...area, '-i', 'desktop'], filters: [] };
  }
  return { input: ['-f', 'lavfi', '-i', `ddagrab=output_idx=${screen.index}:framerate=${fps}:dup_frames=0:draw_mouse=1`], filters: ['hwdownload', 'format=bgra'] };
}
