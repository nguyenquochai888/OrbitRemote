// Bật máy đang tắt qua mạng (Wake-on-LAN).
//
// Card mạng của máy đã tắt vẫn được nuôi một dòng điện nhỏ và nghe một gói đặc biệt (magic packet):
// 6 byte FF rồi địa chỉ MAC của chính nó lặp 16 lần. Gói này chỉ đi trong mạng nội bộ, nên phải có
// một máy đang bật CÙNG mạng bắn hộ: trạm (máy luôn bật ở nhà), hay bất kỳ máy nào đang nối trạm mà
// cùng dải mạng với máy cần bật (máy ở công ty bật được máy khác ở công ty).
//
// Vì máy cần bật đang tắt thì không tự báo được gì, mỗi đầu máy báo sẵn card mạng của nó (MAC, địa
// chỉ, mặt nạ) mỗi lần chào trạm, và trạm nhớ thông tin đó cả khi máy đã tắt.
//
// Máy cần bật còn phải được chuẩn bị (setup.cmd kiểm và bật phần trong Windows): cắm dây mạng; BIOS
// bật Wake on LAN và tắt ErP; card mạng bật "Wake on Magic Packet" và được phép đánh thức máy; tắt
// Fast Startup (tắt máy kiểu ngủ đông lai làm nhiều card không dậy được).

import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

export const WAKE_PORTS = [9, 7];

// Mọi cách viết MAC (AA:BB:.., aa-bb-.., AABBCC.., aabb.ccdd.eeff) về dạng aa:bb:cc:dd:ee:ff, hay null.
export function normalizeMac(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length !== 12 || /^0+$/.test(hex) || /^f+$/.test(hex)) return null;
  return hex.match(/../g).join(':');
}

export function magicPacket(mac) {
  const norm = normalizeMac(mac);
  if (!norm) throw new Error(`Địa chỉ MAC không hợp lệ: ${mac}`);
  const bytes = Buffer.from(norm.replace(/:/g, ''), 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

const toInt = (ip) => ip.split('.').reduce((n, part) => ((n << 8) | (Number(part) & 255)) >>> 0, 0);
const toIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

// Địa chỉ quảng bá của dải mạng: gửi tới đây thì gói đi đúng card mạng của dải đó (gửi tới
// 255.255.255.255 thì Windows chỉ đẩy ra một card, và nhiều router bỏ qua).
export function directedBroadcast(address, netmask) {
  if (isIP(address) !== 4 || isIP(netmask) !== 4) return '';
  return toIp((toInt(address) & toInt(netmask)) | (~toInt(netmask) >>> 0));
}

export function sameSubnet(a, b) {
  if (!a?.address || !b?.address || !a.netmask) return false;
  const mask = toInt(a.netmask);
  return (toInt(a.address) & mask) === (toInt(b.address) & mask);
}

// Card mạng thật của máy này: bỏ loopback, card ảo không có MAC (Tailscale...), địa chỉ tự gán
// 169.254.x.x. Card có dây (tên kiểu Ethernet) đứng trước vì đánh thức qua Wi-Fi hầu như không chạy.
export function localWakeInfo(ifaces = networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      const mac = normalizeMac(a.mac);
      if (a.family !== 'IPv4' || a.internal || !mac || a.address.startsWith('169.254.')) continue;
      out.push({ name, mac, address: a.address, netmask: a.netmask, broadcast: directedBroadcast(a.address, a.netmask) });
    }
  }
  const wireless = (n) => /wi-?fi|wlan|wireless/i.test(n);
  return out.sort((x, y) => Number(wireless(x.name)) - Number(wireless(y.name))).slice(0, 4);
}

// Bắn gói tới mọi tổ hợp địa chỉ quảng bá × cổng; trả về các đích gửi được, ném lỗi nếu không gửi
// được đích nào.
export function sendMagicPacket(mac, broadcasts, ports = WAKE_PORTS) {
  const packet = magicPacket(mac);
  const targets = [...new Set(broadcasts.filter((b) => isIP(b) === 4))];
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', (err) => { sock.close(); reject(err); });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const sent = [];
      const errors = [];
      let left = targets.length * ports.length;
      if (!left) {
        sock.close();
        reject(new Error('Không có địa chỉ nào để gửi.'));
        return;
      }
      for (const address of targets) {
        for (const port of ports) {
          sock.send(packet, port, address, (err) => {
            if (err) errors.push(`${address}:${port} ${err.code || err.message}`);
            else sent.push(`${address}:${port}`);
            left -= 1;
            if (left) return;
            sock.close();
            if (sent.length) resolve(sent);
            else reject(new Error(`Không gửi được gói bật máy: ${errors.join('; ')}`));
          });
        }
      }
    });
  });
}
