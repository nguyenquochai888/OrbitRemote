// Nhận và vẽ màn hình của một máy, gửi thao tác chuột và phím ngược lại.
//
// Điện thoại nối THẲNG tới máy bằng WebSocket (qua Tailscale hoặc mạng nhà) với vé do trạm cấp,
// nên hình không đi vòng qua trạm. Khung H.264 giải mã bằng WebCodecs (phần cứng của điện thoại);
// trình duyệt không có WebCodecs thì xin ảnh JPEG.
//
// Không bao giờ để hình trễ dần: mỗi khung nhận được là báo ngay cho máy (máy dựa vào đó để bỏ bớt
// khung khi mạng nghẽn), và chỉ vẽ khung mới nhất ở mỗi nhịp màn hình, khung cũ hơn bị bỏ.

import { api } from './api.js';

const FRAME = { CONFIG: 1, KEY: 2, DELTA: 3, JPEG: 4 };
const CONNECT_TIMEOUT_MS = 2500;
const MAX_DECODE_QUEUE = 4;

const isTailnet = (host) => {
  const m = /^100\.(\d+)\./.exec(host);
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127;
};

// Địa chỉ cùng loại mạng với trang đang mở đứng trước: mở app qua Tailscale thì thử Tailscale trước.
function orderHosts(hosts) {
  const viaTailnet = isTailnet(location.hostname);
  return [...hosts].sort((a, b) => Number(isTailnet(b) === viaTailnet) - Number(isTailnet(a) === viaTailnet));
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

export function canDecodeH264() {
  return typeof window.VideoDecoder === 'function' && typeof window.EncodedVideoChunk === 'function';
}

export class ScreenClient {
  constructor({ machineId, canvas, onState = () => {}, onScreens = () => {}, onStats = () => {}, onCursor = () => {}, onWindows = () => {}, onCaps = () => {}, onClip = () => {} }) {
    this.machineId = machineId;
    this.onCaps = onCaps; // máy báo làm được gì (dán, đồng bộ clipboard)
    this.onClip = onClip; // lời mời: vừa có ai copy trên máy (clipWatch)
    this.pull = null; // lần kéo tệp đang chạy (clipPull)
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.onState = onState;
    this.onScreens = onScreens;
    this.onStats = onStats;
    this.onCursor = onCursor; // vị trí con trỏ thật trên màn đang xem (0..1), máy báo sau mỗi lần dời tương đối
    this.onWindows = onWindows; // danh sách cửa sổ đang mở trên máy, trả lời listWindows()
    this.ws = null;
    this.decoder = null;
    this.needKey = true;
    this.pending = null; // khung đã giải mã, chờ nhịp vẽ kế tiếp
    this.drawScheduled = false;
    this.jpegBusy = false;
    this.screens = [];
    this.current = null; // { screen, width, height, codec }
    this.closed = false;
    this.frames = 0;
    this.bytes = 0;
    this.statTimer = setInterval(() => this.reportStats(), 1000);
    this.moveQueued = null;
    this.relX = 0; // quãng dời tương đối đang chờ gửi, kể cả phần lẻ dưới một điểm ảnh
    this.relY = 0;
    this.relScheduled = false;
    this.caps = {}; // máy báo làm được gì (dán từ máy này: clip); đầu máy bản cũ không báo
    this.clipWaiters = new Map(); // mã lần dán -> hàm nhận tin "clip-ready", "clip-done"
  }

  // ---- Nối ---------------------------------------------------------------------------------
  async connect() {
    this.onState('connecting');
    const ticket = await api.post(`/api/machines/${this.machineId}/screen`);
    this.screens = ticket.screens || [];
    if (location.protocol === 'https:') {
      throw new Error('Xem màn hình cần mở app qua địa chỉ Tailscale hoặc mạng nhà (http), vì máy không có chứng chỉ HTTPS.');
    }
    let lastError = null;
    for (const host of orderHosts(ticket.hosts || [])) {
      if (this.closed) return;
      try {
        await this.open(`ws://${host}:${ticket.port}/screen?t=${encodeURIComponent(ticket.ticket)}`);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Máy không khai địa chỉ nào để xem màn hình.');
  }

  open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => { ws.close(); reject(new Error('Không với tới máy (quá thời gian).')); }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        this.onState('connected');
        resolve();
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Không nối được tới máy.')); };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.resetDecoder();
        this.failClips('Mất kết nối tới máy giữa lúc dán.');
        if (!this.closed) this.onState('closed');
      };
      ws.onmessage = (e) => (typeof e.data === 'string' ? this.onText(e.data) : this.onBinary(e.data));
    });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(message) {
    if (this.connected) this.ws.send(JSON.stringify(message));
  }

  onText(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.t === 'screens') {
      this.screens = m.list || [];
      this.onScreens(this.screens);
    } else if (m.t === 'caps') {
      this.caps = m;
      this.onCaps(m);
    } else if (m.t === 'clip-ready' || m.t === 'clip-done') {
      this.clipWaiters.get(m.id >>> 0)?.(m);
    } else if (m.t === 'clip-remote') {
      this.onClip(m);
    } else if (m.t === 'clip-pull-done') {
      if (this.pull?.seq === m.seq >>> 0) this.pull.finish(m);
    } else if (m.t === 'started') {
      this.current = m;
      this.needKey = true;
      // Máy có thể tự quay lại mà app không xin (đổi chiều nguồn khi xoay máy, cửa sổ dời chỗ hay đổi
      // cỡ): màn che "đang chờ khung hình đầu tiên" lại hiện, nên phải chờ khung đầu của luồng mới để
      // tắt nó, không thì màn che nằm mãi trên hình đang chạy.
      this.awaitFirst = true;
      this.onState('playing', m);
    } else if (m.t === 'windows') {
      this.onWindows(Array.isArray(m.list) ? m.list : [], m.error || '');
    } else if (m.t === 'cursor') {
      this.onCursor(Number(m.x) || 0, Number(m.y) || 0);
    } else if (m.t === 'stopped') {
      this.current = null;
      this.onState('stopped');
    } else if (m.t === 'quality') {
      this.onState('quality', String(m.id || '')); // máy tự hạ mức vì mạng nghẽn liên tục
    } else if (m.t === 'notice') {
      this.onState('notice', m.text); // báo mà vẫn phát tiếp (ví dụ màn hình không đổi được chiều)
    } else if (m.t === 'locked') {
      // Máy đang khoá hay đang hiện bảng UAC: máy chờ, mở khoá xong tự phát lại (gửi "started" như thường).
      // live: máy có phần xem màn khoá, hình màn khoá tới ngay sau đó và bấm được (gõ mật khẩu).
      this.onState('locked', { state: m.state === 'secure' ? 'secure' : 'locked', live: Boolean(m.live) });
    } else if (m.t === 'error') {
      this.onState('error', m.text);
    }
  }

  // ---- Hình ----------------------------------------------------------------------------------
  // source: số thứ tự màn hình, hoặc { kind: 'screen', index } / { kind: 'window', hwnd }.
  // orient: chiều đang xem { want: 'portrait' | 'landscape', aspect } để máy đổi chiều nguồn cho khớp,
  // null nếu không muốn đổi (xem src/orient.mjs).
  // center: người dùng vừa chọn nguồn này, máy đưa con trỏ vào giữa nguồn.
  start(source, quality, orient = null, center = false) {
    this.resetDecoder();
    this.awaitFirst = true; // báo "frame" khi khung đầu tiên đã vẽ, để màn che không tắt sớm thành màn đen
    const target = typeof source === 'object' && source
      ? (source.kind === 'window' ? { window: String(source.hwnd) } : { screen: source.index })
      : { screen: source };
    this.send({ t: 'start', ...target, quality, codec: canDecodeH264() ? 'h264' : 'jpeg', orient, ...(center ? { center: true } : {}) });
  }

  // Đổi chiều đang xem giữa lúc phát (xoay máy, "Xem ngang", bật hay tắt tính năng).
  orient(orient) {
    this.send({ t: 'orient', ...(orient || {}) });
  }

  // Hỏi máy con trỏ thật đang ở đâu; máy trả lời bằng onCursor(x, y).
  where() {
    this.send({ t: 'where' });
  }

  // Xin máy danh sách cửa sổ đang mở; máy trả lời bằng onWindows(list, error).
  listWindows() {
    this.send({ t: 'windows' });
  }

  stop() {
    this.send({ t: 'stop' });
    this.current = null;
    this.resetDecoder();
  }

  onBinary(buf) {
    const view = new DataView(buf);
    const type = view.getUint8(0);
    if (type === CLIP_PULL_TYPE) {
      // Mẩu tệp kéo về từ máy (clipPull), không phải khung hình: byte 1..4 mã lời mời, 5..8 số thứ tự tệp (LE).
      if (this.pull?.seq === view.getUint32(1, true)) this.pull.chunk(view.getUint32(5, true), new Uint8Array(buf, CLIP_HEADER));
      return;
    }
    const seq = view.getUint32(1);
    const ts = view.getUint32(5);
    const data = new Uint8Array(buf, 9);
    this.bytes += buf.byteLength;
    // Báo nhận ngay khi tới, trước cả lúc giải mã: máy đo độ nghẽn của đường truyền bằng số này.
    if (type !== FRAME.CONFIG) this.send({ t: 'ack', seq });
    if (type === FRAME.CONFIG) this.configure(data);
    else if (type === FRAME.JPEG) this.drawJpeg(data);
    else this.decode(type === FRAME.KEY, ts, data);
  }

  configure(avcC) {
    this.resetDecoder();
    // Chuỗi codec lấy từ chính bản khai avcC: profile, ràng buộc, level.
    const codec = `avc1.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`;
    const decoder = new VideoDecoder({
      output: (frame) => this.onDecoded(frame),
      error: () => { if (this.decoder === decoder) this.resetDecoder(); },
    });
    decoder.configure({ codec, description: avcC.slice(), optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    this.decoder = decoder;
    this.needKey = true;
  }

  decode(key, ts, data) {
    const d = this.decoder;
    if (!d || d.state !== 'configured') return;
    if (this.needKey && !key) return;
    // Giải mã không theo kịp thì bỏ tới khung gốc kế tiếp, không để hàng đợi dài ra thành độ trễ.
    if (!key && d.decodeQueueSize > MAX_DECODE_QUEUE) {
      this.needKey = true;
      return;
    }
    this.needKey = false;
    try {
      d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts * 1000, data }));
    } catch {
      this.resetDecoder();
    }
  }

  onDecoded(frame) {
    this.pending?.close();
    this.pending = frame;
    this.scheduleDraw();
  }

  scheduleDraw() {
    if (this.drawScheduled) return;
    this.drawScheduled = true;
    requestAnimationFrame(() => {
      this.drawScheduled = false;
      const frame = this.pending;
      this.pending = null;
      if (!frame) return;
      this.paint(frame, frame.displayWidth, frame.displayHeight);
      frame.close();
    });
  }

  // Vẽ đúng phần hình máy đã báo lúc bắt đầu phát (started: width × height). Bộ mã hoá phần cứng có
  // thể độn thêm hàng, cột cho tròn khối 16 điểm ảnh mà không khai phần cắt; vẽ cả phần độn thì hình
  // bị kéo giãn và cú chạm lệch dần về phía mép, càng phóng to càng lộ. Phần độn luôn nằm ở phải, dưới.
  paint(source, frameWidth, frameHeight) {
    const width = Math.min(frameWidth, this.current?.width || frameWidth);
    const height = Math.min(frameHeight, this.current?.height || frameHeight);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.onState('resized', { width, height });
    }
    this.ctx.drawImage(source, 0, 0, width, height, 0, 0, width, height);
    this.frames += 1;
    if (this.awaitFirst) {
      this.awaitFirst = false;
      this.onState('frame');
    }
  }

  async drawJpeg(data) {
    if (this.jpegBusy) return; // đang giải ảnh trước: bỏ ảnh này, ảnh sau mới hơn
    this.jpegBusy = true;
    try {
      const bitmap = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
      this.paint(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
    } catch {
      // ảnh hỏng: bỏ qua, ảnh sau thay thế
    } finally {
      this.jpegBusy = false;
    }
  }

  resetDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.pending?.close();
    this.pending = null;
    this.needKey = true;
  }

  reportStats() {
    this.onStats({ fps: this.frames, kbps: Math.round((this.bytes * 8) / 1000) });
    this.frames = 0;
    this.bytes = 0;
  }

  // ---- Thao tác ---------------------------------------------------------------------------
  // Toạ độ chuẩn hoá 0..1 trên màn hình đang xem. Nhiều lần rê trong một nhịp màn hình chỉ gửi lần cuối.
  move(x, y) {
    const first = !this.moveQueued;
    this.moveQueued = { x, y };
    if (!first) return;
    requestAnimationFrame(() => {
      const m = this.moveQueued;
      this.moveQueued = null;
      if (m) this.send({ t: 'move', x: m.x, y: m.y });
    });
  }

  moveNow(x, y) {
    this.moveQueued = null;
    this.send({ t: 'move', x, y });
  }

  // Dời tương đối (chế độ chuột): cộng dồn trong một nhịp màn hình rồi gửi một lần. Phần lẻ dưới
  // một điểm ảnh giữ lại cho lần sau, để ngón đi chậm vẫn dời được con trỏ.
  rel(dx, dy) {
    this.relX += dx;
    this.relY += dy;
    if (this.relScheduled) return;
    this.relScheduled = true;
    requestAnimationFrame(() => {
      this.relScheduled = false;
      this.flushRel();
    });
  }

  flushRel() {
    const dx = Math.round(this.relX);
    const dy = Math.round(this.relY);
    if (!dx && !dy) return;
    this.relX -= dx;
    this.relY -= dy;
    this.send({ t: 'rel', dx, dy });
  }

  // Nhấn hay nhả nút luôn đi sau mọi lần dời đang chờ, để rơi đúng chỗ con trỏ đã tới.
  button(b, down) {
    if (this.moveQueued) this.moveNow(this.moveQueued.x, this.moveQueued.y);
    this.flushRel();
    this.send({ t: 'btn', b, down });
  }
  click(b = 0) {
    this.button(b, true);
    this.button(b, false);
  }
  wheel(dy, dx = 0) { this.send({ t: 'wheel', dy, dx }); }
  key(vk, down) { this.send({ t: 'key', vk, down }); }
  tapKey(vk) {
    this.key(vk, true);
    this.key(vk, false);
  }
  text(s) { if (s) this.send({ t: 'text', s }); }

  // ---- Dán từ máy này sang máy kia (src/clip.mjs của đầu máy) -------------------------------------
  // Chữ: máy đặt clipboard rồi bấm Ctrl+V. Trả lời của máy: { ok, error }.
  clipText(s, paste = true) {
    const id = clipId();
    const message = JSON.stringify({ t: 'clip-text', id, s, paste });
    // Tin lớn hơn 1 MB máy bỏ (src/ws.mjs): báo rõ thay vì im lặng.
    if (new TextEncoder().encode(message).length > CLIP_TEXT_MAX) return Promise.reject(new Error('Đoạn chữ quá dài để dán qua màn hình.'));
    const done = this.clipWait(id, () => {});
    if (this.connected) this.ws.send(message);
    return done;
  }

  // Tệp (kể cả thư mục): items [{ rel: 'Thư mục/a.txt', file }, { rel: 'Thư mục/rỗng', dir: true }].
  // Báo danh sách, chờ máy sẵn sàng (đủ chỗ trống), rồi gửi từng mẩu theo đúng thứ tự, giữ hàng đợi gửi
  // ngắn để thao tác chuột và phím đi cùng đường không bị kẹt sau mẩu tệp.
  // Mỗi tệp là { rel, file } (tệp của trình duyệt) hay { rel, size, mtime, read(at, len) } (tệp đọc qua đầu
  // máy của chính máy này, local-clip.mjs). Giờ sửa đi kèm để bên kia giữ đúng như gốc.
  async clipFiles(items, { paste = true, onProgress = () => {}, signal = null } = {}) {
    const id = clipId();
    const sizeOf = (x) => (x.dir ? 0 : x.size ?? x.file.size);
    const readOf = (x) => x.read || ((at, len) => x.file.slice(at, at + len).arrayBuffer().then((b) => new Uint8Array(b)));
    const total = items.reduce((n, x) => n + sizeOf(x), 0);
    let ready;
    const isReady = new Promise((r) => { ready = r; });
    let result = null;
    const done = this.clipWait(id, (m) => {
      if (m.t === 'clip-ready') ready();
      else { result = m; ready(); }
    });
    done.catch(() => ready());
    this.send({ t: 'clip-files', id, files: items.map((x) => {
      const mtime = x.mtime ?? x.file?.lastModified;
      return { rel: x.rel, ...(x.dir ? { dir: true } : { size: sizeOf(x) }), ...(mtime ? { mtime } : {}) };
    }) });
    await isReady;
    if (result || !this.connected) return done;
    let sent = 0;
    try {
      for (let i = 0; i < items.length; i += 1) {
        const size = sizeOf(items[i]);
        if (items[i].dir || !size) continue;
        const read = readOf(items[i]);
        for (let at = 0; at < size;) {
          if (signal?.aborted) throw new Error('Đã huỷ dán.');
          while (this.connected && this.ws.bufferedAmount > CLIP_HIGH_WATER && !result) await sleep(15);
          if (result || !this.connected) return done;
          let data;
          try {
            data = await read(at, Math.min(CLIP_CHUNK, size - at));
          } catch {
            throw new Error(`Không đọc được tệp ${items[i].rel} trên máy này.`);
          }
          if (!data.length) throw new Error(`Tệp ${items[i].rel} trên máy này ngắn hơn lúc copy.`);
          const msg = new Uint8Array(CLIP_HEADER + data.length);
          const view = new DataView(msg.buffer);
          msg[0] = CLIP_CHUNK_TYPE;
          view.setUint32(1, id, true);
          view.setUint32(5, i, true);
          msg.set(data, CLIP_HEADER);
          this.ws.send(msg);
          at += data.length;
          sent += data.length;
          onProgress(Math.max(0, sent - this.ws.bufferedAmount), total);
        }
      }
    } catch (err) {
      this.send({ t: 'clip-cancel', id });
      this.clipWaiters.delete(id);
      throw err;
    }
    this.send({ t: 'clip-end', id, paste });
    onProgress(total, total);
    return done;
  }

  clipWait(id, onMessage) {
    return new Promise((resolve, reject) => {
      this.clipWaiters.set(id, (m) => {
        if (m.t === 'clip-ready') return onMessage(m);
        this.clipWaiters.delete(id);
        onMessage(m);
        return m.ok ? resolve(m) : reject(new Error(m.error || 'Máy không dán được.'));
      });
    });
  }

  failClips(text) {
    for (const fn of [...this.clipWaiters.values()]) fn({ t: 'clip-done', ok: false, error: text });
    this.clipWaiters.clear();
    this.pull?.finish({ ok: false, error: text });
  }

  // ---- Copy trên máy kia, dán ở máy này -------------------------------------------------------------
  // Bật thì máy báo mỗi lần có ai copy bên đó (onClip nhận lời mời: chữ, hay danh sách tệp).
  clipWatch(on) { this.send({ t: 'clip-watch', on }); }

  // Kéo tệp của lời mời seq về: onChunk(số thứ tự tệp, dữ liệu) cất từng mẩu theo đúng thứ tự (trả Promise);
  // cất xong mẩu nào thì báo máy (clip-pull-ack) để máy gửi tiếp, không dồn bộ nhớ khi cất chậm hơn mạng.
  clipPull(seq, { onChunk, onProgress = () => {}, signal = null } = {}) {
    this.pull?.finish({ ok: false, error: 'Đã có lần chép mới.' });
    return new Promise((resolve, reject) => {
      let got = 0;
      let chain = Promise.resolve();
      let failed = null;
      const pull = {
        seq,
        chunk: (index, data) => {
          chain = chain.then(async () => {
            if (failed) return;
            try {
              await onChunk(index, data);
              got += data.length;
              onProgress(got);
              this.send({ t: 'clip-pull-ack', seq, got });
            } catch (err) {
              failed = err;
              this.send({ t: 'clip-pull-cancel', seq });
            }
          });
        },
        finish: (m) => {
          if (this.pull !== pull) return;
          this.pull = null;
          signal?.removeEventListener?.('abort', onAbort);
          chain.then(() => (failed ? reject(failed) : m.ok ? resolve({ got }) : reject(new Error(m.error || 'Không chép được.'))));
        },
      };
      const onAbort = () => {
        this.send({ t: 'clip-pull-cancel', seq });
        pull.finish({ ok: false, error: 'Đã huỷ chép.' });
      };
      signal?.addEventListener?.('abort', onAbort);
      this.pull = pull;
      this.send({ t: 'clip-pull', seq });
    });
  }

  close() {
    this.closed = true;
    clearInterval(this.statTimer);
    this.resetDecoder();
    this.failClips('Đã đóng màn hình.');
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

// Khuôn mẩu tệp, khớp src/clip.mjs: byte 0 kiểu, 1..4 mã lần dán, 5..8 số thứ tự tệp (uint32 LE).
const CLIP_CHUNK_TYPE = 1;
const CLIP_PULL_TYPE = 16;
const CLIP_HEADER = 9;
const CLIP_CHUNK = 256 * 1024;
const CLIP_HIGH_WATER = 512 * 1024; // hàng đợi gửi quá chừng này thì chờ: chuột vẫn đi kịp
const CLIP_TEXT_MAX = 1000 * 1000 - 64;
const clipId = () => (Math.random() * 0x100000000) >>> 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
