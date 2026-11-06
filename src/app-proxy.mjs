// Cổng mở app trên máy tính không giữ trạm (bản PC, lệnh "app" của main.mjs). Cửa sổ app mở
// http://127.0.0.1:<APP_PORT>, cổng này chuyển nguyên mọi yêu cầu tới trạm theo đúng địa chỉ đầu máy
// đang nối được (mạng nhà, Tailscale, HTTPS riêng).
//
// Vì sao không mở thẳng địa chỉ trạm: qua Tailscale trạm chỉ có http://, trình duyệt coi đó là nguồn
// không an toàn nên tắt bộ giải mã video (WebCodecs, màn hình máy phải lùi về ảnh JPEG nặng) và service
// worker. 127.0.0.1 thì trình duyệt coi là an toàn. Một nguồn cố định cũng giữ được cookie ghép đôi
// khi đầu máy đổi địa chỉ trạm (ở nhà đi mạng nhà, ở công ty đi Tailscale).
//
// Chỉ nghe 127.0.0.1. Cổng không mang thẻ nào của riêng nó: trình duyệt vẫn phải ghép đôi như mọi
// thiết bị, cookie đi thẳng tới trạm. Màn hình máy (WebSocket) không đi qua đây: app nối thẳng tới máy.

import http from 'node:http';
import https from 'node:https';

export const APP_PORT = Number(process.env.ORBIT_REMOTE_APP_PORT) || 8797;
// Cổng bận thì thử nghe lại sau 1 giây, 2 giây... rồi đều đặn mỗi 5 giây.
const RETRY_MS = 1000;
const RETRY_MAX_MS = 5000;

// Tiêu đề không chuyển: của riêng chặng này (hop-by-hop), và tiêu đề mà trạm tin là do chính nó hay
// bộ chuyển tiếp của nó đặt (không để trang nào giả).
const DROP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'x-forwarded-proto', 'x-forwarded-for', 'x-forwarded-host', 'x-orbit-local']);

function forwardHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!DROP.has(k.toLowerCase())) out[k] = v;
  return out;
}

// target(): địa chỉ gốc của trạm lúc này (vd. http://100.101.102.103:8795), hoặc rỗng khi chưa nối.
// local: bộ xử lý clipboard của chính máy này (local-clip.mjs) cho mọi đường dẫn /local/clip/..., không
// chuyển tới trạm.
export function startAppProxy({ target, port = APP_PORT, host = '127.0.0.1', log = () => {}, local = null }) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/local/clip/')) {
      if (local) {
        local(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Không có.');
      }
      return;
    }
    const base = target();
    if (!base) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Đầu máy chưa nối được tới trạm. Thử lại sau ít giây.');
      return;
    }
    let url;
    try {
      // Chỉ lấy đường dẫn và tham số của yêu cầu; máy đích luôn là trạm ("//máy-khác/..." không đổi được đích).
      const asked = new URL(req.url, 'http://x');
      url = new URL(base);
      url.pathname = asked.pathname;
      url.search = asked.search;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const upstream = lib.request(url, { method: req.method, headers: { ...forwardHeaders(req.headers), host: url.host } }, (up) => {
      res.writeHead(up.statusCode || 502, forwardHeaders(up.headers));
      // Luồng sự kiện (SSE) đi từng mẩu ngay khi tới, không gom.
      res.flushHeaders?.();
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Không với tới trạm.');
      } else {
        res.destroy();
      }
    });
    // Trang đóng giữa chừng (luồng sự kiện dài) thì cắt luôn chặng tới trạm.
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  // Cổng đang bị giữ thì nghe lại sau ít giây, không bỏ cuộc. Đã gặp thật trên máy công ty (31/10): bộ cài
  // khởi động lại đầu máy, tiến trình cũ đã nhả đường ống nhưng chưa thoát hẳn nên còn giữ cổng này đúng
  // một giây; đầu máy mới gặp EADDRINUSE rồi để cổng trống mãi, cửa sổ app báo "Không với tới trạm".
  let failures = 0;
  let retry = null;
  let stopped = false;
  server.on('error', (err) => {
    if (stopped) return;
    failures += 1;
    if (failures === 1) log(`Cổng app ${host}:${port} không mở được: ${err.message}. Đang thử lại.`);
    retry = setTimeout(() => server.listen(port, host), Math.min(RETRY_MAX_MS, RETRY_MS * failures));
  });
  server.on('listening', () => {
    if (failures) log(`Cổng app ${host}:${port} đã mở sau ${failures} lần thử lại.`);
    failures = 0;
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    stopped = true;
    clearTimeout(retry);
    return close(callback);
  };
  server.listen(port, host);
  return server;
}
