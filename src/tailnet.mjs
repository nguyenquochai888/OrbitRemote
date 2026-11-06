// Tailscale: mạng riêng ảo giữa các máy đăng nhập cùng một tài khoản. Mỗi máy có một địa chỉ
// 100.x.y.z cố định, các máy gọi thẳng nhau dù đứng sau NAT hay ở mạng chỉ có IPv4, và đường đi
// đã được WireGuard mã hoá. Đây là đường dùng khi nhà không có IPv4 công khai (nhà mạng chia sẻ
// địa chỉ) mà mạng ở chỗ khác lại không có IPv6.
//
// Trạm không phải mở thêm cổng nào: trạm vốn nghe mọi địa chỉ IPv4 (0.0.0.0), và bộ cài Tailscale
// trên Windows tự thêm quy tắc tường lửa "Tailscale-In" cho mọi kết nối đi vào địa chỉ tailnet của
// máy (đọc trên máy giữ trạm, Tailscale 1.104.4). Module này chỉ hỏi Tailscale máy đang mang địa
// chỉ và tên gì, để trạm ghi vào kho cho các máy khác và app trên điện thoại tìm ra trạm.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';

// Bộ cài trên Windows thêm Tailscale vào PATH, nhưng tiến trình mở từ trước lúc cài thì chưa thấy:
// thử chỗ cài mặc định trước, rồi mới tới PATH.
const KNOWN_PATHS = {
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'],
};

const run = (cmd, args, timeout) => spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

export function findTailscale() {
  for (const cmd of [...(KNOWN_PATHS[process.platform] || []).filter((p) => existsSync(p)), 'tailscale']) {
    if (run(cmd, ['version'], 5000).status === 0) return cmd;
  }
  return null;
}

export function readTailscaleStatus(cmd) {
  try {
    return JSON.parse(run(cmd, ['status', '--json'], 8000).stdout);
  } catch {
    return null;
  }
}

// Phần cần dùng trong "tailscale status --json" (định dạng đo trên bản 1.104.4). Cố ý bỏ tên tailnet:
// đó thường là email của tài khoản, không được ghi vào kho.
export function tailnetFromStatus(status) {
  const self = status?.Self || {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  return {
    running: status?.BackendState === 'Running',
    state: status?.BackendState || '',
    ipv4: ips.find((ip) => isIP(ip) === 4) || '',
    dnsName: String(self.DNSName || '').replace(/\.$/, ''),
    magicDns: Boolean(status?.CurrentTailnet?.MagicDNSEnabled),
  };
}

// Địa chỉ của trạm qua tailnet: địa chỉ IP trước (không phụ thuộc DNS), tên MagicDNS sau.
export function tailnetUrls(info, port) {
  const out = [];
  if (info.ipv4) out.push(`http://${info.ipv4}:${port}`);
  if (info.magicDns && info.dnsName) out.push(`http://${info.dnsName}:${port}`);
  return out;
}
