// Clipboard của chính máy đang mở app (bản PC), cho đồng bộ clipboard hai chiều với máy đang xem
// (clip.mjs): trang theo dõi thứ vừa copy ở máy này để đưa sẵn sang máy kia (chuột phải → Paste bên đó
// dán được), và đặt vào clipboard máy này thứ vừa copy bên kia (chữ, cả tệp và thư mục: trang web tự
// nó không đặt được danh sách tệp vào clipboard của Windows).
//
// Trang gọi /local/clip/... trên chính cổng của app: app-proxy.mjs ở máy thường, server.mjs ở máy giữ
// trạm. Chỉ nhận yêu cầu từ chính máy này (127.0.0.1), từ đúng trang của app (Host là 127.0.0.1 hay
// localhost: chặn tên miền lạ trỏ về máy này; Sec-Fetch-Site hay Origin cùng nguồn) và có tiêu đề
// X-Orbit-Clip (trang lạ gửi tiêu đề riêng thì trình duyệt phải hỏi trước, mà cổng không cho).
//
//   GET  ping                       { ok, clip }
//   GET  watch?since=n              chờ tới 25 giây: { seq, kind: 'none' } hay lời mời như clip.mjs
//   GET  file?seq=&i=&at=&len=      một đoạn của tệp thứ i trong lời mời gần nhất
//   POST text { text }              đặt chữ vào clipboard
//   POST begin { id, files }, chunk (mẩu nhị phân), end { id }, cancel   nhận tệp rồi đặt clipboard

import { ClipReceiver, describeClipboard, ownedSet, publicOffer, readSlice } from './clip.mjs';

const WATCH_MS = 25 * 1000;
const WATCH_POLL_MS = 300;
const BODY_MAX = 1024 * 1024 + 64;
const SLICE_MAX = 1024 * 1024;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function allowedLocal(req) {
  const a = req.socket?.remoteAddress || '';
  const loopback = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  const host = String(req.headers.host || '');
  const site = req.headers['sec-fetch-site'];
  const origin = req.headers.origin;
  const sameOrigin = site ? site === 'same-origin' : Boolean(origin) && origin.replace(/^https?:\/\//, '') === host;
  return loopback && LOCAL_HOST.test(host) && sameOrigin && req.headers['x-orbit-clip'] === '1' && !req.headers['x-forwarded-for'];
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = BODY_MAX) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Quá lớn.'));
        req.destroy();
      } else {
        parts.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

// input: InputHelper của máy này (input.mjs). Trả về hàm (req, res) cho mọi đường dẫn /local/clip/...
export function localClipHandler({ input, receiver = new ClipReceiver(), imageDir, log = () => {} }) {
  const own = { busy: false, seq: -1 };
  let offer = null; // lời mời gần nhất đã đưa cho trang (có đường dẫn thật để đọc tệp)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function watch(req, res, since) {
    let gone = false;
    req.on('close', () => { gone = true; });
    // Lần đầu (since = 0): chỉ lấy số hiện tại, không mời thứ đã nằm sẵn trong clipboard.
    const first = await input.clipSeq();
    if (!since) return send(res, 200, { seq: first, kind: 'none' });
    const until = Date.now() + WATCH_MS;
    let seq = first;
    while (!gone && Date.now() < until && (seq === since || own.busy)) {
      await sleep(WATCH_POLL_MS);
      seq = await input.clipSeq();
    }
    if (gone) return undefined;
    // Thay đổi do chính Orbit đặt (thứ vừa chép từ máy kia về): chỉ báo số mới, không mời ngược lại.
    if (seq === since || seq === own.seq) return send(res, 200, { seq, kind: 'none' });
    offer = await describeClipboard(input, imageDir ? { imageDir } : {});
    return send(res, 200, publicOffer(offer));
  }

  return async function handle(req, res) {
    if (!allowedLocal(req)) return send(res, 403, { error: 'Không được phép.' });
    const url = new URL(req.url, 'http://local');
    const name = url.pathname.replace(/^\/local\/clip\//, '');
    try {
      if (req.method === 'GET' && name === 'ping') return send(res, 200, { ok: true, clip: true });
      if (req.method === 'GET' && name === 'watch') return await watch(req, res, Number(url.searchParams.get('since')) || 0);
      if (req.method === 'GET' && name === 'file') {
        const item = offer?.seq === Number(url.searchParams.get('seq')) ? offer.items?.[Number(url.searchParams.get('i'))] : null;
        if (!item || item.dir) return send(res, 404, { error: 'Thứ copy ở máy này đã đổi.' });
        const at = Math.max(0, Number(url.searchParams.get('at')) || 0);
        const data = await readSlice(item.abs, at, Math.min(SLICE_MAX, Math.max(0, Number(url.searchParams.get('len')) || 0), Math.max(0, item.size - at)));
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': data.length });
        return res.end(data);
      }
      if (req.method !== 'POST') return send(res, 404, { error: 'Không có.' });
      const body = await readBody(req);
      if (name === 'chunk') {
        receiver.chunk(body);
        return send(res, 200, { ok: true });
      }
      const m = body.length ? JSON.parse(body.toString('utf8')) : {};
      if (name === 'text') {
        await ownedSet(own, input, () => input.setClipboardText(String(m.text ?? '')));
        return send(res, 200, { ok: true });
      }
      if (name === 'begin') {
        receiver.begin({ id: m.id >>> 0, files: m.files });
        return send(res, 200, { ok: true });
      }
      if (name === 'end') {
        const r = receiver.finish(m.id >>> 0);
        await ownedSet(own, input, () => input.setClipboardFiles(r.paths, r.image));
        return send(res, 200, { ok: true, count: r.count, names: r.names });
      }
      if (name === 'cancel') {
        receiver.abort();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Không có.' });
    } catch (err) {
      if (name === 'chunk' || name === 'end') receiver.abort();
      log(`Clipboard máy này: ${err.message}`);
      return send(res, 500, { error: err.message });
    }
  };
}
