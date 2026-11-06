// Phân loại địa chỉ IPv4: mạng nhà (địa chỉ nội bộ chuẩn) hay dải 100.64.0.0/10 mà Tailscale dùng.

function inRange(ip, base, bits) {
  const toInt = (s) => s.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

export const isCgnat = (ip) => inRange(ip, '100.64.0.0', 10);
export const isPrivate = (ip) => inRange(ip, '10.0.0.0', 8) || inRange(ip, '172.16.0.0', 12) || inRange(ip, '192.168.0.0', 16);
