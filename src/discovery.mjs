// Tìm trạm mà không cần ai gõ địa chỉ.
//
// Đầu máy hỏi theo hai đường, đường nào trả lời trước thì dùng:
//   1. địa chỉ đã biết: từ lần trước (node.json) và địa chỉ Tailscale khai trong custom/hub.json, nên máy ở
//      chỗ khác vẫn tìm được trạm ở nhà;
//   2. phát một gói UDP hỏi trong mạng nhà; trạm nghe cùng số cổng với HTTP và trả lời.
// Trạm được nhận ra bằng chính câu trả lời của /api/ping (`service: "orbit-remote"`), không
// bằng tên máy hay địa chỉ, nên trạm đổi địa chỉ (DHCP cấp IP mới) vẫn tìm lại được.

import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';

const ASK = 'orbit-remote:discover';
const SERVICE = 'orbit-remote';

// ---- Phía trạm ----------------------------------------------------------------------
export function startDiscoveryResponder({ port, info }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket.close(); } catch { /* đã đóng */ }
  };
  socket.on('message', (msg, rinfo) => {
    if (closed || msg.toString('utf8') !== ASK) return;
    const reply = Buffer.from(JSON.stringify({ service: SERVICE, port, ...info() }));
    try {
      socket.send(reply, rinfo.port, rinfo.address, () => {});
    } catch {
      // người hỏi đã đi
    }
  });
  // Không có quyền nghe UDP (tường lửa, cổng bận) thì chỉ mất đường dò trong mạng nhà, trạm
  // vẫn chạy. Mọi lỗi ở đây đều phải nuốt: một ngoại lệ lọt ra là sập cả trạm.
  socket.on('error', close);
  socket.bind(port);
  return { close };
}

// ---- Phía đầu máy -------------------------------------------------------------------
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

function askLan(port, timeoutMs) {
  return new Promise((resolve) => {
    const found = [];
    const socket = dgram.createSocket('udp4');
    let done = false;
    let timer = null;
    // Gọi được nhiều lần (lỗi gửi, rồi hết giờ) mà chỉ đóng socket đúng một lần.
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* đã đóng */ }
      resolve(found);
    };
    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      try {
        const info = JSON.parse(msg.toString('utf8'));
        if (info.service === SERVICE) found.push({ ...info, url: `http://${rinfo.address}:${info.port}` });
      } catch {
        // gói lạ
      }
    });
    socket.bind(0, () => {
      if (done) return;
      try {
        socket.setBroadcast(true);
        const ask = Buffer.from(ASK);
        for (const addr of broadcastAddresses()) socket.send(ask, port, addr, () => {});
      } catch {
        finish();
      }
    });
    timer = setTimeout(finish, timeoutMs);
  });
}

async function ping(url, timeoutMs) {
  try {
    const res = await fetch(new URL('/api/ping', url), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return body.service === SERVICE && body.hubId ? { ...body, url } : null;
  } catch {
    return null;
  }
}

// Trả về danh sách trạm tìm thấy, mỗi trạm một lần (gộp theo hubId), địa chỉ đã biết đứng trước.
export async function discoverHubs({ knownUrls = [], port = 8795, timeoutMs = 2500 } = {}) {
  const [known, lan] = await Promise.all([
    Promise.all([...new Set(knownUrls)].map((u) => ping(u, timeoutMs))).then((r) => r.filter(Boolean)),
    askLan(port, timeoutMs),
  ]);
  const byId = new Map();
  for (const hub of [...known, ...lan]) {
    if (!hub.hubId) continue;
    // urls: địa chỉ vừa trả lời được. advertised: địa chỉ trạm tự khai (công khai, mạng nhà),
    // để đầu máy nhớ mà dùng khi ra khỏi mạng hiện tại.
    const entry = byId.get(hub.hubId) || { hubId: hub.hubId, hubName: hub.hubName, urls: [], advertised: [] };
    if (!entry.urls.includes(hub.url)) entry.urls.push(hub.url);
    for (const u of Array.isArray(hub.urls) ? hub.urls : []) if (!entry.advertised.includes(u)) entry.advertised.push(u);
    byId.set(hub.hubId, entry);
  }
  return [...byId.values()];
}

export { ping as pingHub };
