// Xem và điều khiển màn hình của máy này từ app.
//
// Đường đi của hình: ffmpeg quay màn hình bằng DXGI Desktop Duplication (ddagrab), nén H.264 bằng
// bộ mã hoá phần cứng của card màn hình qua Media Foundation (h264_mf; card NVIDIA, AMD hay Intel
// đều có), đóng gói FLV để biết chính xác ranh giới từng khung, rồi đẩy từng khung qua WebSocket
// THẲNG tới điện thoại (qua Tailscale hoặc mạng nhà), không đi vòng qua trạm. Điện thoại giải mã
// bằng WebCodecs. Máy không có bộ mã hoá phần cứng thì lùi về libx264 chế độ trễ thấp nhất; điện
// thoại không có WebCodecs thì xin ảnh JPEG.
//
// Giữ trễ thấp: điện thoại báo đã nhận tới khung nào. Khung đã gửi mà điện thoại chưa nhận vượt
// quá khoảng một phần tư giây thì máy bỏ các khung kế tiếp và chờ khung gốc (keyframe) mới, thay vì
// để hình trôi chậm dần sau thực tế. Màn hình đứng yên thì ddagrab không sinh khung nào, nên lúc
// đó gần như không tốn băng thông.
//
// Mỗi người xem có ffmpeg riêng, dựng khi bấm phát và tắt ngay khi dừng hay đóng app; không ai
// xem thì không có tiến trình nào chạy. Không ghi gì ra đĩa.
//
// Vào cửa bằng vé: app xin trạm, trạm hỏi đầu máy qua đường nối có sẵn, đầu máy cấp một vé ngẫu
// nhiên dùng một lần, sống 60 giây. Cổng WebSocket không nhận ai không có vé.
//
// Nguồn hình là một màn hình hay một cửa sổ: cửa sổ được quay đúng vùng của nó.

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { acceptWebSocket } from './ws.mjs';
import { DDAGRAB_UNSUPPORTED, GDI_MAX_FPS, captureInput, findFfmpeg, ffmpegUsable, isArea } from './ffmpeg.mjs';
import { openSecureInput, secureAvailable, startSecureCapture } from './secure-desk.mjs';
import { InputHelper } from './input.mjs';
import { CHUNK_SIZE, ClipReceiver, ClipWatcher, PULL_TYPE, describeClipboard, ownedSet, publicOffer, readSlice } from './clip.mjs';
import { isCgnat, isPrivate } from './netaddr.mjs';
import { ORIENT_FILE, Orienter, cleanOrient } from './orient.mjs';
import { existsSync } from 'node:fs';

export const SCREEN_PORT = Number(process.env.ORBIT_REMOTE_SCREEN_PORT) || 8796;
const TICKET_TTL_MS = 60 * 1000;
const MAX_VIEWERS = 3;
const SCREENS_CACHE_MS = 10 * 1000;
const CURSOR_REPORT_MS = 30; // báo vị trí con trỏ tối đa khoảng 33 lần mỗi giây
const LOCK_POLL_MS = 2000; // máy đang khoá: cứ chừng này hỏi lại, mở khoá xong thì tự phát lại
const LOCK_WATCH_MS = 3000; // đang phát: cứ chừng này xem máy có vừa khoá không
// Kéo tệp về app (clipPull): app cất chậm hơn mạng thì dừng khi đã gửi quá 8 MB chưa báo cất xong; hàng đợi
// gửi của kết nối giữ dưới 1 MB để khung hình chen vào kịp.
const PULL_WINDOW = 8 * 1024 * 1024;
const PULL_BUFFER = 1024 * 1024;
// Màn khoá qua chương trình SYSTEM (secure-desk.mjs): ảnh JPEG, đủ để thấy ô mật khẩu và con trỏ.
const SECURE_PIXELS = 1280 * 720;
const SECURE_FPS = 8;
const SECURE_JPEG_QUALITY = 70;

// Kênh bấm vào màn khoá, cùng cách gọi như InputHelper (moveTo, button, key, text...).
function secureInputAdapter(channel) {
  return {
    moveTo: (x, y) => channel.send(`m ${Math.round(x)} ${Math.round(y)}`),
    moveBy: (dx, dy) => channel.send(`r ${Math.round(dx)} ${Math.round(dy)}`),
    button: (b, down) => channel.send(`${down ? 'd' : 'u'} ${b | 0}`),
    wheel: (dy, dx = 0) => {
      if (dy) channel.send(`w ${Math.round(dy)}`);
      if (dx) channel.send(`h ${Math.round(dx)}`);
    },
    key: (vk, down, extended = false) => channel.send(`k ${vk | 0} ${down ? 1 : 0} ${extended ? 1 : 0}`),
    text: (s) => { if (s) channel.send(`t ${Buffer.from(String(s), 'utf8').toString('base64')}`); },
    close: () => channel.close(),
  };
}
const MAX_WINDOWS = 60;
const WINDOW_FOCUS_WAIT_MS = 350; // chờ Windows làm xong hiệu ứng khôi phục cửa sổ rồi mới đo khung
const WINDOW_WATCH_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Kiểu khung gửi cho điện thoại: byte đầu, rồi số thứ tự và mốc thời gian (uint32, big-endian).
export const FRAME = { CONFIG: 1, KEY: 2, DELTA: 3, JPEG: 4 };

// Ba mức hình. Nén theo chất lượng có trần (libx264 CRF kèm maxrate), không theo bitrate cố định: đo
// trên một trang VS Code (3 giây đứng yên, 4 giây cuộn, 3 giây đứng yên), bitrate cố định 5 Mb/s tiêu
// đều 4,4 Mb/s vì bộ nén cố lấp cho đủ, còn mức "fast" dưới đây chỉ 0,62 Mb/s và "saver" 0,27 Mb/s.
// pixels: ngân sách điểm ảnh (rộng × cao) thay vì bề rộng tối đa, để nguồn dọc (màn xoay, cửa sổ đổi
// cỡ theo điện thoại) không nặng gấp đôi nguồn ngang cùng mức. maxrate: trần lúc màn đổi nhiều.
export const QUALITY = {
  sharp: { pixels: 1920 * 1080, fps: 60, crf: 23, maxrate: 8e6, preset: 'superfast', jpegQ: 5, jpegFps: 20 },
  fast: { pixels: 1280 * 720, fps: 30, crf: 26, maxrate: 2.5e6, preset: 'veryfast', jpegQ: 6, jpegFps: 15 },
  saver: { pixels: 960 * 540, fps: 24, crf: 30, maxrate: 1.2e6, preset: 'veryfast', jpegQ: 8, jpegFps: 10 },
};
// Mạng nghẽn liên tục ở một mức thì tự hạ một mức (xem Viewer.onCongestion).
const LOWER = { sharp: 'fast', fast: 'saver' };
const CONGESTION_WINDOW_MS = 10 * 1000;
const CONGESTION_LIMIT = 3;
const GOP_SECONDS = 2; // khung gốc mỗi 2 giây có thay đổi: khung gốc là khung nặng nhất
// Chống trễ dần khi mạng chậm (Viewer.congested): cho phép hàng đợi dài thêm LAG_EXTRA_MS trên độ dài của
// đường (vòng đi về nhỏ nhất trong RTT_WINDOW_S giây), và một trần cứng theo byte.
const LAG_EXTRA_MS = 300;
const LAG_MIN_MS = 450;
const LAG_DEFAULT_RTT_MS = 250; // chưa đo được vòng đi về nào
const RTT_WINDOW_S = 10;
const HARD_WINDOW_SECONDS = 1.5;
const HARD_WINDOW_MIN_BYTES = 256 * 1024;
const STALL_RESTART_MS = 1200; // bỏ khung chờ khung gốc quá chừng này mà đường đã thông: quay lại ngay
const ACK_LOST_MS = 5000;
let ffmpegHasX264 = false;

// Mã phím ảo Windows cần cờ "phím mở rộng" để không bị hiểu thành phím số bên phải bàn phím.
const EXTENDED_VK = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d, 0x6f, 0xa3, 0xa5]);

// Bản ffmpeg dùng được thì nhớ luôn. Chưa có thì chỉ nhớ "chưa có" trong nửa phút: cài xong (bằng
// setup.cmd hay winget) là lần xin xem kế tiếp thấy ngay, không phải khởi động lại đầu máy.
const FFMPEG_RECHECK_MS = 30 * 1000;
let ffmpegFound = null;
let ffmpegMissingAt = 0;
let ffmpegProblem = '';
export function ffmpegCommand() {
  if (ffmpegFound) return ffmpegFound;
  if (ffmpegMissingAt && Date.now() - ffmpegMissingAt < FFMPEG_RECHECK_MS) return '';
  const p = findFfmpeg();
  if (ffmpegUsable(p)) {
    ffmpegFound = p.path;
    ffmpegHasX264 = Boolean(p.libx264);
    return ffmpegFound;
  }
  ffmpegMissingAt = Date.now();
  ffmpegProblem = !p ? 'Máy này chưa có ffmpeg.'
    : !p.ddagrab ? `ffmpeg ${p.version} ở ${p.path} thiếu bộ quay màn hình ddagrab (cần bản 6.1 trở lên).`
      : `ffmpeg ${p.version} ở ${p.path} không có bộ mã hoá H.264 nào.`;
  return '';
}

const SETUP_HINT = 'Trên máy đó, nháy đúp setup.cmd trong thư mục Orbit Remote để cài đủ.';
const missingFfmpeg = () => `${ffmpegProblem || 'Máy này chưa có ffmpeg.'} ${SETUP_HINT}`;

// Tách luồng FLV thành từng khung. FLV đơn giản: 9 byte đầu tệp, rồi lần lượt từng thẻ
// [loại 1B][độ dài 3B][mốc thời gian 3B + 1B][mã luồng 3B][dữ liệu][độ dài thẻ trước 4B].
// Thẻ video H.264: byte 0 = loại khung << 4 | mã codec (7), byte 1 = 0 (cấu hình avcC) hay 1 (khung).
export class FlvSplitter {
  constructor(onTag) {
    this.onTag = onTag;
    this.buf = Buffer.alloc(0);
    this.headerDone = false;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.headerDone) {
      if (this.buf.length < 13) return;
      if (this.buf.toString('latin1', 0, 3) !== 'FLV') throw new Error('Luồng ffmpeg không phải FLV.');
      this.buf = this.buf.subarray(this.buf.readUInt32BE(5) + 4);
      this.headerDone = true;
    }
    while (this.buf.length >= 11) {
      const size = this.buf.readUIntBE(1, 3);
      if (this.buf.length < 11 + size + 4) return;
      const type = this.buf[0];
      const ts = (this.buf.readUIntBE(4, 3) | (this.buf[7] << 24)) >>> 0;
      const data = this.buf.subarray(11, 11 + size);
      this.buf = this.buf.subarray(11 + size + 4);
      if (type === 9 && data.length > 5 && (data[0] & 0x0f) === 7) {
        if (data[1] === 0) this.onTag({ kind: 'config', ts, data: data.subarray(5) });
        else if (data[1] === 1) this.onTag({ kind: 'frame', key: data[0] >> 4 === 1, ts, data: data.subarray(5) });
      }
    }
  }
}

// Tách luồng MJPEG thành từng ảnh: mỗi ảnh mở bằng FFD8 và đóng bằng FFD9. Trong phần dữ liệu ảnh
// byte FF luôn được chèn 00 phía sau, nên FFD9 chỉ xuất hiện đúng ở cuối ảnh.
const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

export class JpegSplitter {
  constructor(onImage) {
    this.onImage = onImage;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const start = this.buf.indexOf(JPEG_START);
      if (start < 0) {
        // Giữ byte FF cuối: nó có thể là nửa đầu của FFD8 bị cắt đôi giữa hai mẩu dữ liệu.
        this.buf = this.buf.at(-1) === 0xff ? this.buf.subarray(-1) : Buffer.alloc(0);
        return;
      }
      const end = this.buf.indexOf(JPEG_END, start + 2);
      if (end < 0) {
        if (start > 0) this.buf = this.buf.subarray(start);
        return;
      }
      this.onImage(this.buf.subarray(start, end + 2));
      this.buf = this.buf.subarray(end + 2);
    }
  }
}

// Bộ mã hoá: libx264 nén theo chất lượng có trần (ít dữ liệu nhất, xem QUALITY); ffmpeg không có
// libx264 thì phần cứng qua Media Foundation (h264_mf chỉ nén theo bitrate cố định: đặt bằng trần của
// mức). Bộ nào không mở được trên máy này thì nhớ, lần sau khỏi thử lại.
let x264Failed = false;
let hardwareFailed = false;
const pickEncoder = () => (ffmpegHasX264 && !x264Failed ? 'libx264' : !hardwareFailed ? 'h264_mf' : 'libx264');
// Card màn hình không cho quay bằng ddagrab (xem ffmpeg.mjs): quay bằng gdigrab. Thử lại ddagrab sau
// một lúc, phòng khi vừa cắm màn hình hay cài driver.
const DDAGRAB_RETRY_MS = 10 * 60 * 1000;
// Màn ảo (driver IddCx, như Virtual Display Driver cho máy không cắm màn hình): ddagrab chạy, không báo lỗi, nhưng
// chỉ ra khung khi nội dung màn đổi. Màn đứng yên thì không có khung đầu, dời chuột cũng không ra khung (con trỏ
// phần cứng không nằm trong ảnh), và mỗi lần quay lại để lấy khung gốc lại trắng tay (đo trên máy mini không màn
// hình: 0 khung trong 10 giây). Card thật luôn trả khung đầu ngay khi bắt đầu. Nên quá chừng này mà chưa có khung
// nào thì coi như ddagrab không dùng được ở máy này: quay bằng gdigrab, như card không cho quay.
const FIRST_FRAME_MS = 3000;
let ddagrabFailedAt = 0;
const useGdi = () => Boolean(ddagrabFailedAt) && Date.now() - ddagrabFailedAt < DDAGRAB_RETRY_MS;

export function encoderArgs(q, codec, encoder = 'libx264') {
  if (codec === 'jpeg') return ['-c:v', 'mjpeg', '-q:v', String(q.jpegQ), '-f', 'mjpeg'];
  // Mất khung vì nghẽn thì chờ khung gốc kế tiếp: chậm nhất GOP_SECONDS giây sau hình về lại.
  const gop = String(Math.max(1, Math.round(q.fps * GOP_SECONDS)));
  const common = ['-g', gop, '-bf', '0', '-flush_packets', '1', '-f', 'flv', '-flvflags', 'no_duration_filesize'];
  const maxrate = String(Math.round(q.maxrate));
  if (encoder === 'h264_mf') {
    return ['-c:v', 'h264_mf', '-hw_encoding', '1', '-scenario', 'display_remoting', '-rate_control', 'cbr', '-b:v', maxrate, ...common];
  }
  // Bộ đệm nửa giây ở trần: khung gốc không phình quá, nên mạng chậm không bị dồn một cục lớn.
  return ['-c:v', 'libx264', '-preset', q.preset, '-tune', 'zerolatency', '-crf', String(q.crf),
    '-maxrate', maxrate, '-bufsize', String(Math.round(q.maxrate / 2)), ...common];
}

// Cỡ ảnh gửi đi: thu nhỏ đều hai chiều cho vừa ngân sách điểm ảnh của mức, cỡ chẵn cho bộ mã hoá.
export function outputSizeFor(width, height, q) {
  const scale = Math.min(1, Math.sqrt(q.pixels / Math.max(1, width * height)));
  return { width: Math.round((width * scale) / 2) * 2, height: Math.round((height * scale) / 2) * 2 };
}

// Một lần quay một màn hình cho một người xem.
class Capture extends EventEmitter {
  constructor({ screen, quality, codec, wholeDesktop = true }) {
    super();
    this.screen = screen;
    this.wholeDesktop = wholeDesktop;
    this.q = QUALITY[quality] || QUALITY.sharp;
    this.codec = codec === 'jpeg' ? 'jpeg' : 'h264';
    this.proc = null;
    this.gotFrame = false;
    this.stderr = '';
    this.stopped = false;
  }

  get outputSize() {
    return outputSizeFor(this.screen.width, this.screen.height, this.q);
  }

  start() {
    // Cả màn hay một vùng (cửa sổ, khung game), bằng ddagrab; card không cho quay thì gdigrab (vùng: theo
    // vùng). Màn đang xoay (ngang thành dọc): ddagrab trả hình theo chiều gốc của màn, nên quay bằng gdigrab.
    const area = isArea(this.screen);
    const gdi = useGdi() || Boolean(this.screen.rotated);
    const method = gdi ? 'gdigrab' : 'ddagrab';
    const fps = Math.min(this.codec === 'jpeg' ? this.q.jpegFps : this.q.fps, gdi ? GDI_MAX_FPS : Infinity);
    const encoder = this.codec === 'h264' ? pickEncoder() : '';
    const { width, height } = this.outputSize;
    const { input, filters } = captureInput(method, this.screen, fps, this.wholeDesktop && !area);
    // gdigrab trọn màn hình có thể ra cỡ khác cỡ DXGI báo (màn có hệ số phóng chữ), vùng có thể có cỡ
    // lẻ: luôn ép về đúng cỡ chẵn đã báo cho điện thoại.
    if (gdi || area || width !== this.screen.width) filters.push(`scale=${width}:${height}:flags=bilinear`);
    filters.push(this.codec === 'jpeg' ? 'format=yuvj420p' : 'format=nv12');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...input,
      '-vf', filters.join(','),
      ...encoderArgs({ ...this.q, fps }, this.codec, encoder),
      'pipe:1',
    ];
    const proc = spawn(ffmpegCommand(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    const splitter = this.codec === 'jpeg'
      ? new JpegSplitter((img) => { this.gotFrame = true; this.emit('jpeg', img); })
      : new FlvSplitter((tag) => {
        if (tag.kind === 'frame') this.gotFrame = true;
        this.emit(tag.kind, tag);
      });
    proc.stdout.on('data', (chunk) => {
      try {
        splitter.push(chunk);
      } catch (err) {
        this.stderr += err.message;
        proc.kill();
      }
    });
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-600); });
    proc.on('error', (err) => { this.stderr += err.message; });
    if (!gdi) {
      this.firstFrameTimer = setTimeout(() => {
        if (this.stopped || this.gotFrame || this.proc !== proc) return;
        ddagrabFailedAt = Date.now();
        this.stop(); // tiến trình cũ thoát êm, không báo 'end'
        this.emit('retry');
      }, FIRST_FRAME_MS);
    }
    proc.on('exit', (code) => {
      clearTimeout(this.firstFrameTimer);
      if (this.stopped) return;
      // Card màn hình không cho quay bằng DXGI (máy không cắm màn hình, card chưa có driver): quay
      // bằng GDI và thử lại ngay.
      if (!gdi && !this.gotFrame && DDAGRAB_UNSUPPORTED.test(this.stderr)) {
        ddagrabFailedAt = Date.now();
        this.emit('retry');
        return;
      }
      // Bộ mã hoá không mở được (h264_mf: driver cũ, máy ảo): nhớ lại rồi thử ngay bộ còn lại.
      if (encoder && !this.gotFrame && /libx264|h264_mf|encoder|MFT/i.test(this.stderr)) {
        if (encoder === 'libx264') x264Failed = true;
        else hardwareFailed = true;
        const next = pickEncoder();
        if (next === 'libx264' ? ffmpegHasX264 && !x264Failed : !hardwareFailed) {
          this.emit('retry');
          return;
        }
      }
      this.emit('end', { code, error: this.stderr.trim() });
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.firstFrameTimer);
    this.proc?.kill();
    this.proc = null;
  }
}

// Một người xem: một kết nối WebSocket, tối đa một lần quay đang chạy.
export class Viewer {
  constructor(server, ws) {
    this.server = server;
    this.ws = ws;
    this.capture = null;
    this.screen = null;
    this.seq = 0;
    this.acked = 0;
    this.inflight = []; // [seq, bytes] đã gửi mà điện thoại chưa báo nhận
    this.inflightBytes = 0;
    this.waitKey = false;
    this.restarts = 0;
    this.lockTimer = null; // đang chờ máy mở khoá (waitUnlock)
    this.lockWatch = null; // đang phát: xem máy có vừa khoá không
    this.secure = null; // đang xem màn khoá qua chương trình SYSTEM: { mon, input, capture }
    this.heldButtons = new Set(); // nút chuột và phím người xem đang giữ: nhả hết khi họ rời đi
    this.heldKeys = new Set();
    this.cursorTimer = null;
    this.watchTimer = null; // theo dõi cửa sổ đang phát (đóng, dời chỗ, đổi cỡ)
    this.active = false; // người xem đang muốn phát (từ lệnh start tới lệnh stop hay lúc rời đi)
    this.orient = null; // chiều đang xem trên điện thoại { want, aspect }, null: không đổi chiều nguồn
    this.orientKey = ''; // nguồn đang xem, theo khoá của orient.mjs, để trả lại khi thôi xem
    this.queue = Promise.resolve(); // lệnh đổi nguồn (phát, đổi chiều) chạy lần lượt, không chen nhau
    this.clip = null; // lần dán tệp đang nhận từ máy đang xem (clip.mjs)
    ws.on('text', (text) => this.onCommand(text));
    ws.on('binary', (buf) => this.onClipChunk(buf));
    ws.on('close', () => this.dispose());
    // Báo app những gì máy này làm được: đầu máy bản cũ không báo, app dán bằng Ctrl+V của máy kia như trước.
    ws.sendJson({ t: 'caps', clip: true });
    server.screens().then((list) => ws.sendJson({ t: 'screens', list })).catch((err) => ws.sendJson({ t: 'error', text: err.message }));
  }

  async onCommand(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    // Máy đang khoá mà có phần xem màn khoá (trySecure): chạm và phím đi vào màn khoá qua chương trình SYSTEM.
    const input = this.secure?.input || this.server.input;
    switch (m.t) {
      case 'start':
        return this.serial(() => this.start(m));
      case 'orient':
        return this.serial(() => this.setOrient(m));
      case 'windows':
        return this.sendWindows();
      case 'where':
        return this.reportCursor(); // app hỏi con trỏ đang ở đâu (dấu con trỏ của tay cầm)
      case 'stop':
        this.active = false;
        this.stopWatch();
        this.stopCapture();
        this.releaseHeld();
        this.releaseOrient();
        return this.ws.sendJson({ t: 'stopped' });
      case 'ack':
        return this.onAck(m.seq >>> 0);
      case 'move': {
        const s = this.secure?.mon || this.screen || (await this.server.screens())[0];
        if (!s) return undefined;
        return input.moveTo(s.x + clamp01(m.x) * (s.width - 1), s.y + clamp01(m.y) * (s.height - 1));
      }
      case 'rel':
        input.moveBy(Number(m.dx) || 0, Number(m.dy) || 0);
        if (!this.secure) this.reportCursor(); // màn khoá: con trỏ đã vẽ sẵn trong ảnh
        return undefined;
      case 'btn': {
        const b = Number(m.b) || 0;
        if (b < 0 || b > 2) return undefined;
        if (m.down) this.heldButtons.add(b); else this.heldButtons.delete(b);
        return input.button(b, Boolean(m.down));
      }
      case 'wheel':
        return input.wheel(Number(m.dy) || 0, Number(m.dx) || 0);
      case 'key': {
        const vk = Number(m.vk) | 0;
        if (vk <= 0 || vk >= 256) return undefined;
        if (m.down) this.heldKeys.add(vk); else this.heldKeys.delete(vk);
        return input.key(vk, Boolean(m.down), EXTENDED_VK.has(vk));
      }
      case 'text':
        return input.text(String(m.s || '').slice(0, 2000));
      case 'clip-text':
        return this.clipText(m);
      case 'clip-files':
        return this.clipBegin(m);
      case 'clip-end':
        return this.clipEnd(m);
      case 'clip-cancel':
        return this.clip?.abort();
      case 'clip-watch':
        return this.clipWatch(Boolean(m.on));
      case 'clip-pull':
        return this.clipPull(m.seq >>> 0);
      case 'clip-pull-ack':
        if (this.pull?.seq === m.seq >>> 0) this.pull.acked = Math.max(this.pull.acked, Number(m.got) || 0);
        return undefined;
      case 'clip-pull-cancel':
        if (this.pull) this.pull.cancelled = true;
        return undefined;
      default:
        return undefined;
    }
  }

  // ---- Copy trên máy này, dán ở máy đang xem (clip.mjs) -------------------------------------------
  // App bật theo dõi khi đang xem: mỗi lần có ai copy trên máy này (phím tắt, chuột phải → Copy) thì gửi
  // lời mời; chữ đi luôn trong lời mời, tệp chờ app kéo về (clip-pull).
  clipWatch(on) {
    if (!on) {
      this.clipWatcher?.stop();
      this.clipWatcher = null;
      return;
    }
    this.clipWatcher ||= new ClipWatcher({ input: this.server.input, own: () => this.server.clipOwn, onChange: () => this.offerClip() });
    this.clipWatcher.start();
  }

  async offerClip() {
    if (this.secure || this.ws.closed) return;
    try {
      const offer = await describeClipboard(this.server.input, this.server.clipOptions || {});
      this.clipOffer = offer;
      this.ws.sendJson({ t: 'clip-remote', ...publicOffer(offer) });
    } catch (err) {
      this.server.log?.(`Không đọc được clipboard: ${err.message}`);
    }
  }

  // Gửi tệp của lời mời về app từng mẩu. Giữ hàng đợi gửi ngắn để khung hình vẫn đi kịp, và chờ app
  // báo đã cất xong (clip-pull-ack) khi bên đó cất chậm hơn mạng, để không dồn bộ nhớ ở trình duyệt.
  async clipPull(seq) {
    const offer = this.clipOffer;
    if (!offer || offer.seq !== seq || offer.kind !== 'files') {
      this.ws.sendJson({ t: 'clip-pull-done', seq, ok: false, error: 'Thứ copy trên máy kia đã đổi, copy lại rồi thử lại.' });
      return;
    }
    if (this.pull) this.pull.cancelled = true;
    const job = { seq, sent: 0, acked: 0, cancelled: false };
    this.pull = job;
    const stopped = () => job.cancelled || this.ws.closed;
    try {
      for (let i = 0; i < offer.items.length; i += 1) {
        const item = offer.items[i];
        if (item.dir) continue;
        for (let at = 0; at < item.size;) {
          while (!stopped() && (job.sent - job.acked > PULL_WINDOW || this.ws.buffered > PULL_BUFFER)) await sleep(10);
          if (stopped()) return;
          const data = await readSlice(item.abs, at, Math.min(CHUNK_SIZE, item.size - at));
          if (!data.length) throw new Error(`Tệp ${item.rel} trên máy kia ngắn hơn lúc copy.`);
          const head = Buffer.alloc(9);
          head[0] = PULL_TYPE;
          head.writeUInt32LE(seq, 1);
          head.writeUInt32LE(i, 5);
          this.ws.sendBinary(data, head);
          at += data.length;
          job.sent += data.length;
        }
      }
      if (!stopped()) this.ws.sendJson({ t: 'clip-pull-done', seq, ok: true });
    } catch (err) {
      if (!stopped()) this.ws.sendJson({ t: 'clip-pull-done', seq, ok: false, error: err.message });
    } finally {
      if (this.pull === job) this.pull = null;
    }
  }

  // ---- Dán từ máy đang xem sang máy này (clip.mjs) -------------------------------------------------
  // Chữ: đặt clipboard rồi bấm Ctrl+V. Màn khoá không có clipboard dùng được: gõ thẳng (ô mật khẩu).
  async clipText(m) {
    const id = m.id >>> 0;
    const text = String(m.s ?? '');
    try {
      if (this.secure) {
        this.secure.input.text(text.slice(0, 2000));
      } else {
        await ownedSet(this.server.clipOwn, this.server.input, () => this.server.input.setClipboardText(text));
        if (m.paste) this.pressPaste();
      }
      this.ws.sendJson({ t: 'clip-done', id, ok: true });
    } catch (err) {
      this.ws.sendJson({ t: 'clip-done', id, ok: false, error: err.message });
    }
  }

  // Tệp: app báo danh sách trước, chờ "clip-ready" rồi mới gửi mẩu (máy hết chỗ thì báo ngay, khỏi gửi phí).
  clipBegin(m) {
    const id = m.id >>> 0;
    try {
      if (this.secure) throw new Error('Máy đang khoá: mở khoá rồi hãy dán tệp.');
      this.clip ||= new ClipReceiver(this.server.clipOptions || {});
      this.clip.begin({ id, files: m.files });
      this.ws.sendJson({ t: 'clip-ready', id });
    } catch (err) {
      this.clip?.abort();
      this.ws.sendJson({ t: 'clip-done', id, ok: false, error: err.message });
    }
  }

  onClipChunk(buf) {
    if (!this.clip?.job) return; // mẩu của lần dán đã huỷ hay đã lỗi
    try {
      this.clip.chunk(buf);
    } catch (err) {
      const id = this.clip.job?.id;
      this.clip.abort();
      this.ws.sendJson({ t: 'clip-done', id, ok: false, error: err.message });
    }
  }

  async clipEnd(m) {
    const id = m.id >>> 0;
    try {
      if (!this.clip) throw new Error('Không có lần dán này.');
      const r = this.clip.finish(id);
      await ownedSet(this.server.clipOwn, this.server.input, () => this.server.input.setClipboardFiles(r.paths, r.image));
      if (m.paste) this.pressPaste();
      this.ws.sendJson({ t: 'clip-done', id, ok: true, count: r.count, bytes: r.bytes, names: r.names });
    } catch (err) {
      this.clip?.abort();
      this.ws.sendJson({ t: 'clip-done', id, ok: false, error: err.message });
    }
  }

  pressPaste() {
    const input = this.server.input;
    input.key(17, true);
    input.key(86, true);
    input.key(86, false);
    input.key(17, false);
  }

  // Cửa sổ đang mở trên máy, cho danh sách chọn nguồn trên điện thoại: ứng dụng và thư mục.
  async sendWindows() {
    try {
      const list = await this.server.input.windows();
      this.ws.sendJson({ t: 'windows', list: list.slice(0, MAX_WINDOWS).map(publicWindow) });
    } catch (err) {
      this.ws.sendJson({ t: 'windows', list: [], error: err.message });
    }
  }

  serial(fn) {
    this.queue = this.queue.then(fn).catch((err) => this.ws.sendJson({ t: 'error', text: err.message }));
    return this.queue;
  }

  // Nguồn là một màn hình (screen = số thứ tự) hay một cửa sổ (window = mã cửa sổ). orient: chiều đang xem
  // trên điện thoại (app cũ không gửi thì giữ nguyên, không đổi chiều nguồn).
  async start({ screen, window: hwnd, quality, codec, ...rest }) {
    this.active = true;
    this.stopCapture();
    this.stopWatch();
    if ('orient' in rest) this.orient = cleanOrient(rest.orient);
    const list = await this.server.screens(true);
    if (!ffmpegCommand()) return this.ws.sendJson({ t: 'error', text: missingFfmpeg() });
    this.restarts = 0;
    this.options = { quality, codec, wholeDesktop: list.length <= 1 };
    if (hwnd != null && hwnd !== '') {
      if (!/^\d{1,20}$/.test(String(hwnd))) return this.ws.sendJson({ t: 'error', text: 'Mã cửa sổ không hợp lệ.' });
      const source = await this.openWindow(String(hwnd), list);
      if (!source) return undefined;
      this.screen = await this.orientSource(source);
      if (!this.active) return undefined;
      if (rest.center) this.centerCursor();
      this.watchWindow();
      return this.launch();
    }
    const s = list.find((x) => x.index === Number(screen)) || list[0];
    if (!s) return this.ws.sendJson({ t: 'error', text: 'Không tìm thấy màn hình nào.' });
    this.screen = await this.orientSource(s);
    if (rest.center && this.active) this.centerCursor();
    return this.launch();
  }

  // Người dùng vừa chọn nguồn này (app gửi center): đưa con trỏ vào giữa màn hình hay cửa sổ đó để
  // thấy ngay nó ở đâu. Phát lại vì đổi chất lượng, đổi chiều hay nối lại thì không đụng con trỏ.
  centerCursor() {
    const s = this.screen;
    if (!s) return;
    this.server.input.moveTo(s.x + s.width / 2, s.y + s.height / 2);
    this.reportCursor();
  }

  // ---- Đổi chiều nguồn theo điện thoại (orient.mjs) -----------------------------------------
  static keyOf(source) {
    return source.kind === 'window' ? `window:${source.hwnd}` : `screen:${source.name}`;
  }

  // Đổi chiều nguồn sắp phát cho khớp chiều đang xem; trả nguồn đo lại sau khi đổi (hay nguồn cũ).
  // Nguồn xem trước đó (khác nguồn này) được trả về như cũ ngay, rồi nguồn mới được đo lại: màn cũ đổi
  // hướng là toạ độ cả bàn làm việc đổi theo, nguồn mới bị đẩy đi chỗ khác (trước đây trả sau 8 giây
  // chờ, lúc người xem đã làm việc trên nguồn mới, nên con trỏ nhảy về màn cũ và hình lệch vùng).
  async orientSource(source) {
    const orienter = this.server.orienter;
    const key = Viewer.keyOf(source);
    const old = this.orientKey;
    this.orientKey = key;
    if (old && old !== key && orienter.saved.has(old)) {
      try {
        await orienter.restore(old, this);
        if (old.startsWith('screen:')) source = await this.refreshSource(source);
      } catch {
        // trả không được (chương trình điều khiển vừa dừng): vẫn phát nguồn mới
      }
    }
    if (!this.orient) return source;
    try {
      let changed;
      if (source.kind === 'window') {
        const w = await this.server.input.window(source.hwnd).catch(() => null);
        const home = (await this.server.screens()).find((s) => s.index === source.index);
        changed = Boolean(w && home) && (await orienter.window(w, home, this.orient));
      } else {
        changed = await orienter.screen(source, this.orient.want, this);
      }
      // Người xem vừa dừng hay rời đi trong lúc máy đang đổi: lệnh trả lại lúc đó chưa thấy gì để trả,
      // nên trả ở đây, kẻo màn hình nằm xoay mãi.
      if (!this.active) {
        orienter.release(key);
        return source;
      }
      return changed ? await this.refreshSource(source) : source;
    } catch (err) {
      this.ws.sendJson({ t: 'notice', text: err.message });
      return source;
    }
  }

  // Đo lại nguồn sau khi đổi chiều hay trả lại như cũ. Màn hình đổi hướng thì gửi lại danh sách màn
  // (cỡ đã đổi) cho điện thoại.
  // Đổi hướng màn thì orient.mjs đã chờ Windows xếp xong; đổi cỡ cửa sổ thì chờ ở đây.
  async refreshSource(source) {
    if (source.kind === 'window') await sleep(WINDOW_FOCUS_WAIT_MS);
    const list = await this.server.screens(true);
    if (source.kind === 'window') {
      const w = await this.server.input.window(source.hwnd).catch(() => null);
      return windowSource(w, list) || source;
    }
    this.ws.sendJson({ t: 'screens', list });
    return list.find((s) => s.name === source.name) || source;
  }

  // Điện thoại đổi chiều (xoay máy, bấm "Xem ngang") hay bật, tắt tính năng giữa lúc đang phát.
  async setOrient(m) {
    const next = cleanOrient(m);
    const same = next && this.orient ? next.want === this.orient.want && Math.abs(next.aspect - this.orient.aspect) < 0.02 : next === this.orient;
    if (same) return;
    this.orient = next;
    const cur = this.screen;
    if (!cur || this.ws.closed) return;
    let source;
    if (next) {
      source = await this.orientSource(cur);
    } else {
      // Tắt tính năng: trả nguồn đang xem về như cũ ngay.
      const had = this.server.orienter.saved.has(this.orientKey);
      await this.server.orienter.restore(this.orientKey, this);
      source = had ? await this.refreshSource(cur) : cur;
    }
    if (!this.active || source === cur || this.screen !== cur) return;
    this.screen = source;
    this.stopCapture();
    this.launch();
  }

  // Một màn khác vừa đổi hướng (người xem khác xoay nó, hay nó vừa được trả về như cũ): toạ độ cả bàn
  // làm việc đổi theo, nên đo lại nguồn đang xem; vùng đã đổi thì quay lại cho khớp.
  refreshAfterDisplayChange() {
    return this.serial(async () => {
      const cur = this.screen;
      if (!this.active || !cur || this.ws.closed) return;
      const next = await this.refreshSource(cur);
      if (!this.active || this.screen !== cur) return;
      const same = next.x === cur.x && next.y === cur.y && next.width === cur.width && next.height === cur.height
        && Boolean(next.rotated) === Boolean(cur.rotated);
      if (same) return;
      this.screen = next;
      this.stopCapture();
      this.launch();
    });
  }

  // Thôi xem (dừng, rời đi): nguồn đã đổi chiều được trả lại sau một lúc chờ.
  releaseOrient() {
    if (this.orientKey) this.server.orienter.release(this.orientKey);
    this.orientKey = '';
  }

  // Khôi phục (nếu thu nhỏ) và đưa cửa sổ lên trước, để chuột và phím từ điện thoại rơi đúng cửa sổ
  // đó, rồi lấy khung của nó sau khi Windows làm xong hiệu ứng khôi phục.
  async openWindow(hwnd, screens) {
    const input = this.server.input;
    input.focus(hwnd);
    await new Promise((r) => setTimeout(r, WINDOW_FOCUS_WAIT_MS));
    const w = await input.window(hwnd).catch(() => null);
    if (!w) {
      this.ws.sendJson({ t: 'error', text: 'Cửa sổ này đã đóng.' });
      return null;
    }
    const source = windowSource(w, screens);
    if (!source) {
      this.ws.sendJson({ t: 'error', text: w.min ? 'Không mở được cửa sổ đang thu nhỏ.' : 'Cửa sổ này đang nằm ngoài mọi màn hình.' });
      return null;
    }
    return source;
  }


  // Mỗi giây xem lại cửa sổ đang phát: đóng thì báo; dời chỗ hay đổi cỡ (và đứng yên ở chỗ mới qua
  // một lượt, để không quay lại liên tục lúc đang kéo) thì quay lại cho khớp vùng mới.
  watchWindow() {
    let pending = null;
    this.watchTimer = setInterval(async () => {
      const cur = this.screen;
      if (cur?.kind !== 'window' || this.ws.closed) return;
      // Danh sách màn mới nhất (giữ đệm vài giây, bỏ đệm khi một màn đổi hướng), không phải danh sách
      // lúc bắt đầu phát: màn đổi hướng thì toạ độ các màn đổi theo.
      const screens = await this.server.screens().catch(() => null);
      const w = screens && await this.server.input.window(cur.hwnd).catch(() => null);
      if (!screens) return;
      if (this.screen !== cur) return;
      if (!w) {
        this.stopWatch();
        this.stopCapture();
        this.ws.sendJson({ t: 'error', text: `Cửa sổ "${cur.title}" đã đóng.` });
        return;
      }
      if (w.min) return; // thu nhỏ: giữ nguyên, mở lại là hình về
      const next = windowSource(w, screens);
      const key = next && `${next.x},${next.y},${next.width},${next.height}`;
      if (!next || key === `${cur.x},${cur.y},${cur.width},${cur.height}`) {
        pending = null;
        return;
      }
      if (pending !== key) {
        pending = key;
        return;
      }
      pending = null;
      this.screen = next;
      this.stopCapture();
      this.launch();
    }, WINDOW_WATCH_MS);
  }

  stopWatch() {
    clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  launch() {
    // Lệnh đổi nguồn hay quay lại tới muộn, sau khi người xem đã dừng hay rời đi: không quay cho ai cả.
    if (!this.active || this.ws.closed) return;
    const capture = new Capture({ screen: this.screen, ...this.options });
    this.capture = capture;
    // Số thứ tự khung tăng mãi qua các lần quay lại: tin báo nhận của luồng cũ tới muộn không xoá nhầm
    // khung của luồng mới.
    this.seq = this.seq || 0;
    this.acked = this.seq;
    this.inflight = [];
    this.inflightBytes = 0;
    this.waitKey = false;
    this.waitSince = 0;
    // Trần cứng của dữ liệu đang trên đường: chừng 1,5 giây ở trần của mức. Cái chặn trễ chính là tuổi
    // của khung cũ nhất chưa được nhận (xem congested), không phải số byte.
    this.hardWindow = Math.max(HARD_WINDOW_MIN_BYTES, (capture.q.maxrate / 8) * HARD_WINDOW_SECONDS);
    const quiet = Boolean(this.quietRestart);
    this.quietRestart = false;
    const { width, height } = capture.outputSize;
    const s = this.screen;
    this.ws.sendJson({
      t: 'started', screen: s.index, width, height, codec: capture.codec,
      quiet, // quay lại chỉ để lấy khung gốc: app giữ hình cũ, không hiện màn che "đang chờ"
      // Nguồn đang phát và cỡ thật của nó (điểm ảnh), để điện thoại ghi tên và dời con trỏ đúng tỉ lệ.
      source: s.kind === 'window' ? { kind: 'window', hwnd: String(s.hwnd), title: s.title, exe: s.exe, folder: s.folder }
        : { kind: 'screen', index: s.index },
      sourceWidth: s.width,
      sourceHeight: s.height,
    });
    capture.on('config', (tag) => this.sendFrame(FRAME.CONFIG, tag.ts, tag.data, true));
    capture.on('frame', (tag) => this.onFrame(tag));
    capture.on('jpeg', (img) => this.onJpeg(img));
    capture.on('retry', () => { if (this.capture === capture) this.launch(); });
    // Máy khoá giữa lúc đang xem: ddagrab tự hỏng (bắt ở 'end'), còn gdigrab có thể chỉ ra màn đen, nên
    // cứ LOCK_WATCH_MS hỏi trạng thái màn một lần (lệnh rất nhẹ), thấy khoá thì dừng và chờ mở khoá.
    clearInterval(this.lockWatch);
    this.lockWatch = setInterval(async () => {
      const state = await this.desktopState();
      if (this.capture !== capture || (state !== 'locked' && state !== 'secure')) return;
      this.stopCapture();
      this.waitUnlock(state);
    }, LOCK_WATCH_MS);
    capture.on('end', async ({ error }) => {
      if (this.capture !== capture) return;
      this.capture = null;
      clearInterval(this.lockWatch);
      this.lockWatch = null;
      // Máy đang khoá hay đang hiện bảng UAC: thử lại cũng vô ích, báo rõ và chờ mở khoá (waitUnlock).
      const state = await this.desktopState();
      if (this.capture || !this.active || this.ws.closed) return;
      if (state === 'locked' || state === 'secure') {
        this.waitUnlock(state);
        return;
      }
      // Hỏng vì lý do khác (ffmpeg lỗi chốc lát, màn vừa đổi): thử lại vài lần.
      if (this.restarts < 5 && !this.ws.closed) {
        this.restarts += 1;
        setTimeout(() => { if (!this.capture && this.screen && !this.ws.closed) this.launch(); }, 800);
        return;
      }
      this.ws.sendJson({ t: 'error', text: `Quay màn hình dừng: ${error || 'không rõ lý do'}` });
    });
    capture.start();
  }

  clock() {
    return Date.now();
  }

  // Điện thoại báo nhận khung tới số seq (báo ngay khi tới, trước cả lúc giải mã). Thời gian từ lúc gửi
  // tới lúc nhận tin báo là một vòng đi về; nhỏ nhất trong mười giây gần đây là độ dài của đường (lúc
  // không có hàng đợi), dùng để biết lúc nào hàng đợi thật sự dồn.
  onAck(seq, now = this.clock()) {
    if (seq <= this.acked) return;
    this.acked = seq;
    let sample = -1;
    while (this.inflight.length && this.inflight[0][0] <= seq) {
      const [s, bytes, at] = this.inflight.shift();
      this.inflightBytes -= bytes;
      if (s === seq) sample = now - at;
    }
    if (sample >= 0) this.noteRtt(sample, now);
  }

  noteRtt(sample, now) {
    const bucket = Math.floor(now / 1000);
    const list = (this.rttMins ||= []);
    const last = list.at(-1);
    if (last && last.b === bucket) last.min = Math.min(last.min, sample);
    else list.push({ b: bucket, min: sample });
    while (list.length && list[0].b <= bucket - RTT_WINDOW_S) list.shift();
    this.baseRtt = Math.min(...list.map((x) => x.min));
  }

  // Nghẽn là khi hàng đợi thật sự dồn: khung cũ nhất chưa được nhận đã nằm trên đường quá độ dài của
  // đường cộng một khoảng chờ cho phép. Đường dài mà không chậm (4G, Tailscale: một vòng đi về 0,2 tới
  // 0,4 giây) thì không tính là nghẽn, như khi chỉ đếm byte trước đây (làm hình đứng ở 0 khung/giây).
  congested(now = this.clock()) {
    const oldest = this.inflight[0];
    const age = oldest ? now - oldest[2] : 0;
    if (age > ACK_LOST_MS) {
      // Tin báo nhận mất (không bao giờ tới): coi như đã nhận, kẻo bỏ khung mãi.
      this.inflight = [];
      this.inflightBytes = 0;
      return false;
    }
    const lagLimit = Math.max(LAG_MIN_MS, (this.baseRtt ?? LAG_DEFAULT_RTT_MS) + LAG_EXTRA_MS);
    return age > lagLimit || this.inflightBytes > this.hardWindow || this.ws.buffered > this.hardWindow;
  }

  onFrame(tag) {
    const now = this.clock();
    if (tag.key) {
      // Khung gốc vẫn bỏ nếu đường truyền đang nghẽn nặng: gửi nó chỉ làm hàng đợi dài thêm.
      if (this.inflightBytes > this.hardWindow * 2) return;
      this.waitKey = false;
      this.sendFrame(FRAME.KEY, tag.ts, tag.data, false, now);
      return;
    }
    if (this.waitKey) {
      // Đang bỏ khung chờ khung gốc, mà đường đã thông: khung gốc kế tiếp có thể còn xa (chỉ có sau một
      // loạt khung có thay đổi), nên quay lại ngay để có khung gốc thay vì đứng hình.
      if (!this.congested(now) && now - this.waitSince > STALL_RESTART_MS) this.restartForKey();
      return;
    }
    if (this.congested(now)) {
      this.waitKey = true; // bỏ một khung phụ thì các khung phụ sau giải mã sai: chờ khung gốc
      this.waitSince = now;
      this.onCongestion(now);
      return;
    }
    this.sendFrame(FRAME.DELTA, tag.ts, tag.data, false, now);
  }

  // Quay lại chỉ để lấy khung gốc (ffmpeg mới bắt đầu bằng khung gốc); app giữ hình đang có.
  restartForKey() {
    this.quietRestart = true;
    this.stopCapture();
    this.launch();
  }

  // Nghẽn lặp lại nhiều lần trong ít giây ở một mức (4G chậm, sóng yếu): tự hạ một mức để hình đi kịp
  // thay vì cứ đứng rồi giật, và báo điện thoại để nút chất lượng ghi đúng mức đang dùng.
  onCongestion(now = Date.now()) {
    this.congestion = (this.congestion || []).filter((t) => now - t < CONGESTION_WINDOW_MS);
    this.congestion.push(now);
    const lower = LOWER[this.options?.quality];
    if (this.congestion.length < CONGESTION_LIMIT || !lower) return;
    this.congestion = [];
    this.options = { ...this.options, quality: lower };
    this.ws.sendJson({ t: 'quality', id: lower, auto: true });
    this.stopCapture();
    this.launch();
  }

  onJpeg(img) {
    if (this.congested()) return; // ảnh JPEG độc lập: bỏ ảnh nào cũng không hỏng ảnh sau
    this.sendFrame(FRAME.JPEG, 0, img);
  }

  sendFrame(type, ts, data, untracked = false, now = this.clock()) {
    this.seq += 1;
    const head = Buffer.alloc(9);
    head[0] = type;
    head.writeUInt32BE(this.seq >>> 0, 1);
    head.writeUInt32BE(ts >>> 0, 5);
    if (!untracked) {
      this.inflight.push([this.seq, data.length, now]);
      this.inflightBytes += data.length;
    }
    this.ws.sendBinary(data, head);
  }

  stopCapture() {
    clearTimeout(this.lockTimer); // đang chờ máy mở khoá thì thôi chờ: nguồn mới, dừng hay rời đi
    this.lockTimer = null;
    this.stopSecure();
    clearInterval(this.lockWatch);
    this.lockWatch = null;
    this.capture?.stop();
    this.capture = null;
  }

  // Trạng thái màn của máy (win-input.cs, lệnh L). Hỏi không được (chương trình điều khiển đang dựng lại,
  // máy không phải Windows) thì coi như không khoá: luồng chạy như trước.
  async desktopState() {
    try {
      return await this.server.input.desktopState();
    } catch {
      return 'unlocked';
    }
  }

  // Máy đang khoá (màn đăng nhập) hay đang hiện hộp thoại UAC: Windows chuyển sang màn bảo mật, chương
  // trình chạy bằng quyền người dùng không được quay (ddagrab báo "access denied", gdigrab ra màn đen).
  // Báo app một lần rồi cứ LOCK_POLL_MS hỏi lại; mở khoá xong thì tự phát lại, không cần bấm gì.
  waitUnlock(state) {
    this.ws.sendJson({ t: 'locked', state });
    const check = async () => {
      this.lockTimer = null;
      if (!this.active || this.ws.closed || this.capture) return;
      const now = await this.desktopState();
      if (!this.active || this.ws.closed || this.capture || this.lockTimer) return;
      if (now !== 'unlocked') {
        this.lockTimer = setTimeout(check, this.lockPollMs || LOCK_POLL_MS);
        return;
      }
      this.stopSecure(); // mở khoá xong: thôi xem qua chương trình SYSTEM, quay như thường
      this.restarts = 0;
      this.launch();
    };
    clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(check, this.lockPollMs || LOCK_POLL_MS);
    this.trySecure(state);
  }

  // Máy có phần xem màn khoá (secure-desk.mjs, cài bằng setup.cmd): xem màn khoá hay bảng UAC bằng ảnh
  // JPEG vài khung mỗi giây do chương trình SYSTEM chụp, chạm và phím đi vào đó (gõ được mật khẩu). Không
  // có thì giữ lời báo "đăng nhập tại máy". Vòng hỏi của waitUnlock vẫn chạy: mở khoá xong thì quay như thường.
  async trySecure(state) {
    if (this.secure || !(await (this.secureCheck || secureAvailable)())) return false;
    if (!this.active || this.ws.closed || this.capture || this.secure) return false;
    let mon;
    try {
      const list = await this.server.screens();
      const want = !this.screen?.kind || this.screen.kind === 'screen' ? this.screen?.index : -1;
      mon = list.find((s) => s.index === want) || list[0];
    } catch {
      return false;
    }
    if (!mon) return false;
    const { width: ow, height: oh } = outputSizeFor(mon.width, mon.height, { pixels: SECURE_PIXELS });
    const secure = { mon, input: null, capture: null };
    this.secure = secure;
    try {
      secure.input = secureInputAdapter(await openSecureInput());
      secure.capture = await startSecureCapture({ x: mon.x, y: mon.y, w: mon.width, h: mon.height, ow, oh, fps: SECURE_FPS, quality: SECURE_JPEG_QUALITY },
        (img) => { if (this.secure === secure) this.onJpeg(img); },
        () => {
          // Chương trình SYSTEM dừng giữa chừng: về lời báo "đăng nhập tại máy", vòng hỏi vẫn chạy.
          if (this.secure !== secure) return;
          this.stopSecure();
          this.ws.sendJson({ t: 'locked', state });
        });
    } catch {
      if (this.secure === secure) this.stopSecure();
      return false;
    }
    if (this.secure !== secure) {
      secure.capture?.stop();
      secure.input?.close();
      return false;
    }
    this.inflight = [];
    this.inflightBytes = 0;
    this.hardWindow = HARD_WINDOW_MIN_BYTES;
    this.ws.sendJson({ t: 'locked', state, live: true });
    this.ws.sendJson({
      t: 'started', screen: mon.index, width: ow, height: oh, codec: 'jpeg', secure: true,
      source: { kind: 'screen', index: mon.index }, sourceWidth: mon.width, sourceHeight: mon.height,
    });
    return true;
  }

  stopSecure() {
    const s = this.secure;
    this.secure = null;
    s?.capture?.stop();
    s?.input?.close();
  }

  // Chế độ chuột trên điện thoại chỉ gửi quãng dời nên không biết con trỏ thật đang ở đâu: báo lại vị
  // trí thật (chuẩn hoá 0..1 theo màn đang xem) để khung xem đang phóng to đi theo con trỏ. Gộp lại:
  // nhiều lần dời trong CURSOR_REPORT_MS chỉ hỏi và báo một lần, sau lần dời cuối.
  reportCursor() {
    if (this.cursorTimer) return;
    this.cursorTimer = setTimeout(async () => {
      this.cursorTimer = null;
      const s = this.screen;
      if (!s || this.ws.closed) return;
      try {
        const p = await this.server.input.cursor();
        this.ws.sendJson({ t: 'cursor', x: clamp01((p.x - s.x) / Math.max(1, s.width - 1)), y: clamp01((p.y - s.y) / Math.max(1, s.height - 1)) });
      } catch {
        // chương trình điều khiển chuột vừa dừng: lần dời sau hỏi lại
      }
    }, CURSOR_REPORT_MS);
  }

  // Mất kết nối hay dừng giữa một cú kéo thì lệnh nhả không bao giờ tới: nhả thay, kẻo chuột trái
  // kẹt ở trạng thái nhấn và mọi lần dời sau đó đều thành bôi đen.
  releaseHeld() {
    const input = this.server.input;
    for (const b of this.heldButtons) input.button(b, false);
    for (const vk of this.heldKeys) input.key(vk, false, EXTENDED_VK.has(vk));
    this.heldButtons.clear();
    this.heldKeys.clear();
  }

  dispose() {
    this.active = false;
    this.stopWatch();
    clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
    this.stopCapture();
    this.releaseHeld();
    this.releaseOrient();
    this.clip?.abort(); // rời đi giữa lúc dán: xoá phần tệp đã nhận
    this.clipWatcher?.stop();
    if (this.pull) this.pull.cancelled = true;
    this.server.viewers.delete(this);
  }
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

// Cửa sổ gửi cho điện thoại: chỉ những gì cần để chọn. Thư mục là cửa sổ File Explorer (CabinetWClass).
export function publicWindow(w) {
  return {
    hwnd: String(w.hwnd),
    title: String(w.title || '').slice(0, 160),
    exe: String(w.exe || '').slice(0, 80),
    kind: w.cls === 'CabinetWClass' ? 'folder' : 'app',
    width: Number(w.width) || 0,
    height: Number(w.height) || 0,
    min: Boolean(w.min),
  };
}

// Nguồn quay của một cửa sổ: phần cửa sổ nằm trên màn chứa tâm của nó (ddagrab quay từng màn một;
// phần thò sang màn khác hay ra ngoài bị cắt), cỡ chẵn cho bộ mã hoá. Toạ độ là toạ độ màn hình thật,
// cùng hệ với chuột, nên ảnh và cú chạm khớp từng điểm ảnh. Null nếu không còn phần nào đủ lớn nằm
// trên màn hình (đang thu nhỏ, hay bị kéo hẳn ra ngoài).
export function windowSource(w, screens) {
  if (!w || w.min || !screens.length) return null;
  const cx = w.x + w.width / 2;
  const cy = w.y + w.height / 2;
  const home = screens.find((s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height)
    || screens.find((s) => w.x < s.x + s.width && w.x + w.width > s.x && w.y < s.y + s.height && w.y + w.height > s.y);
  if (!home) return null;
  const x = Math.max(w.x, home.x);
  const y = Math.max(w.y, home.y);
  const width = Math.floor((Math.min(w.x + w.width, home.x + home.width) - x) / 2) * 2;
  const height = Math.floor((Math.min(w.y + w.height, home.y + home.height) - y) / 2) * 2;
  if (width < 16 || height < 16) return null;
  return {
    kind: 'window',
    hwnd: String(w.hwnd),
    title: String(w.title || ''),
    exe: String(w.exe || ''),
    folder: w.cls === 'CabinetWClass',
    index: home.index,
    rotated: Boolean(home.rotated), // màn chứa cửa sổ đang xoay: quay bằng gdigrab
    monX: home.x, // góc màn chứa cửa sổ: ddagrab tính vùng quay từ góc này
    monY: home.y,
    x,
    y,
    width,
    height,
  };
}

export class ScreenServer {
  constructor({ port = SCREEN_PORT, log = () => {} } = {}) {
    this.port = port;
    this.log = log;
    this.server = null;
    this.listening = null;
    this.tickets = new Map(); // vé -> hạn dùng
    this.viewers = new Set();
    this.input = new InputHelper();
    this.clipOwn = { busy: false, seq: -1 }; // lần Orbit tự đặt clipboard gần nhất (clip.mjs ownedSet)
    this.screenCache = null;
    this.orienter = new Orienter(this.input, { log, onDisplayChange: (origin) => this.displaysChanged(origin) });
    // Lần chạy trước đổi chiều màn hình hay cửa sổ mà chưa kịp trả (đầu máy tắt giữa chừng): trả ngay.
    if (ScreenServer.supported() && existsSync(ORIENT_FILE)) {
      this.orienter.restoreLeftovers().then((n) => { if (n) log(`Đã trả ${n} màn hình, cửa sổ về chiều cũ.`); }).catch(() => {});
    }
  }

  static supported() {
    return process.platform === 'win32';
  }

  // Địa chỉ điện thoại có thể gọi thẳng tới: địa chỉ Tailscale trước, rồi địa chỉ mạng nhà.
  hosts() {
    const tailnet = [];
    const lan = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        if (isCgnat(a.address)) tailnet.push(a.address);
        else if (isPrivate(a.address)) lan.push(a.address);
      }
    }
    return [...tailnet, ...lan];
  }

  info() {
    return { port: this.port, hosts: this.hosts() };
  }

  // Một màn vừa đổi hướng (orient.mjs): bỏ danh sách màn đang giữ đệm, và mọi người xem khác người
  // gây ra việc đó đo lại nguồn của mình.
  displaysChanged(origin) {
    this.screenCache = null;
    for (const v of this.viewers) if (v !== origin) v.refreshAfterDisplayChange();
  }

  async screens(fresh = false) {
    if (!fresh && this.screenCache && Date.now() - this.screenCache.at < SCREENS_CACHE_MS) return this.screenCache.list;
    const list = await this.input.screens();
    this.screenCache = { at: Date.now(), list };
    return list;
  }

  listen() {
    if (this.listening) return this.listening;
    const server = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Không có.');
    });
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    this.listening = new Promise((resolve, reject) => {
      server.once('error', (err) => {
        this.listening = null;
        reject(new Error(`Không mở được cổng màn hình ${this.port}: ${err.message}`));
      });
      server.listen(this.port, '0.0.0.0', () => {
        this.server = server;
        this.port = server.address().port; // cổng 0 (phép kiểm): lấy cổng hệ điều hành vừa cấp
        this.log(`Cổng xem màn hình đang mở: ${this.port}`);
        resolve();
      });
    });
    return this.listening;
  }

  async ticket() {
    if (!ScreenServer.supported()) throw new Error('Xem màn hình hiện chỉ làm cho Windows.');
    if (!ffmpegCommand()) throw new Error(missingFfmpeg());
    await this.listen();
    const now = Date.now();
    for (const [t, until] of this.tickets) if (until < now) this.tickets.delete(t);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, now + TICKET_TTL_MS);
    return { ticket, port: this.port, hosts: this.hosts(), screens: await this.screens(true) };
  }

  onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const url = new URL(req.url, 'http://local');
    const ticket = url.searchParams.get('t') || '';
    const until = this.tickets.get(ticket);
    if (url.pathname !== '/screen' || !until || until < Date.now()) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    this.tickets.delete(ticket); // vé dùng một lần
    if (this.viewers.size >= MAX_VIEWERS) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(req, socket, head);
    if (ws) this.viewers.add(new Viewer(this, ws));
  }

  stop() {
    for (const v of this.viewers) v.ws.close(1001);
    this.viewers.clear();
    this.input.stop();
    this.server?.close();
    this.server = null;
    this.listening = null;
  }
}
