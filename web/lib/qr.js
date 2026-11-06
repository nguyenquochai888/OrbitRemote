// Mã QR tự viết theo ISO/IEC 18004: chế độ byte, mức sửa lỗi M, phiên bản 1 đến 10 (tối đa
// 213 byte, thừa cho một địa chỉ kèm mã ghép đôi). Module thuần, không chạm DOM, nên trạm
// (in QR ra cửa sổ console) và app (vẽ SVG) dùng chung một bản.
//
// Đã đối chiếu bằng một bộ giải mã độc lập (zxing-cpp 2026-10-27): 74 chuỗi phủ đủ mười
// phiên bản, cộng tám mặt nạ ép buộc trên bốn phiên bản; 106/106 đọc lại đúng từng ký tự.
// tests/remote.test.mjs giữ ma trận của một địa chỉ mẫu đã được xác nhận như thế, để sửa
// bộ mã hoá mà làm lệch ma trận thì phép kiểm báo ngay.

// Mỗi phiên bản ở mức M: [số mã sửa lỗi mỗi khối, [[số khối, số mã dữ liệu mỗi khối], ...]].
const EC_M = [
  null,
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const ECL_M_BITS = 0; // mã hai bit của mức M trong thông tin định dạng

// ---- Trường Galois GF(256), đa thức nguyên thuỷ 0x11D --------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j += 1) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsRemainder(data, degree) {
  const g = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let j = 0; j < degree; j += 1) rem[j] ^= gfMul(g[j + 1], factor);
  }
  return rem;
}

// ---- Mã hoá ---------------------------------------------------------------------------
function dataCodewords(version) {
  const [, groups] = EC_M[version];
  return groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

function encodeData(bytes, version) {
  const capacity = dataCodewords(version) * 8;
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // chế độ byte
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity - bits.length)); // dấu kết thúc
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    out.push(byte);
  }
  return out;
}

function withErrorCorrection(data, version) {
  const [ecLen, groups] = EC_M[version];
  const blocks = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i += 1) {
      const chunk = data.slice(at, at + size);
      at += size;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, ecLen) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i += 1) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLen; i += 1) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ---- Ma trận --------------------------------------------------------------------------
class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.dark = new Uint8Array(this.size * this.size);
    this.fixed = new Uint8Array(this.size * this.size); // ô thuộc mẫu chức năng, không chứa dữ liệu
  }

  get(x, y) {
    return this.dark[y * this.size + x] === 1;
  }

  setFixed(x, y, isDark) {
    this.dark[y * this.size + x] = isDark ? 1 : 0;
    this.fixed[y * this.size + x] = 1;
  }

  drawFunctionPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i += 1) {
      this.setFixed(6, i, i % 2 === 0);
      this.setFixed(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(n - 4, 3);
    this.drawFinder(3, n - 4);
    const pos = ALIGN[this.version];
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = 0; j < pos.length; j += 1) {
        // Ba góc trùng mẫu định vị thì bỏ.
        if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
        this.drawAlignment(pos[i], pos[j]);
      }
    }
    this.drawFormat(0);
    this.drawVersion();
  }

  drawFinder(cx, cy) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        this.setFixed(x, y, d !== 2 && d !== 4);
      }
    }
  }

  drawAlignment(cx, cy) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) this.setFixed(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  drawFormat(mask) {
    const data = (ECL_M_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    const n = this.size;
    for (let i = 0; i <= 5; i += 1) this.setFixed(8, i, bit(i));
    this.setFixed(8, 7, bit(6));
    this.setFixed(8, 8, bit(7));
    this.setFixed(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) this.setFixed(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) this.setFixed(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) this.setFixed(8, n - 15 + i, bit(i));
    this.setFixed(8, n - 8, true); // ô tối cố định
  }

  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const isDark = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFixed(a, b, isDark);
      this.setFixed(b, a, isDark);
    }
  }

  drawCodewords(codewords) {
    const n = this.size;
    let i = 0;
    const total = codewords.length * 8;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // cột định thời không chứa dữ liệu
      for (let vert = 0; vert < n; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          const k = y * n + x;
          if (this.fixed[k] || i >= total) continue;
          this.dark[k] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
          i += 1;
        }
      }
    }
  }

  applyMask(mask) {
    const n = this.size;
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const k = y * n + x;
        if (this.fixed[k]) continue;
        let flip;
        switch (mask) {
          case 0: flip = (x + y) % 2 === 0; break;
          case 1: flip = y % 2 === 0; break;
          case 2: flip = x % 3 === 0; break;
          case 3: flip = (x + y) % 3 === 0; break;
          case 4: flip = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: flip = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: flip = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: flip = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (flip) this.dark[k] ^= 1;
      }
    }
  }

  // Bốn luật chấm điểm của chuẩn; điểm càng thấp càng dễ quét.
  penalty() {
    const n = this.size;
    const at = (x, y) => this.dark[y * n + x];
    let score = 0;
    const runs = (line) => {
      let s = 0;
      let run = 1;
      for (let i = 1; i <= line.length; i += 1) {
        if (i < line.length && line[i] === line[i - 1]) run += 1;
        else {
          if (run >= 5) s += 3 + (run - 5);
          run = 1;
        }
      }
      const str = line.join('');
      for (const p of ['10111010000', '00001011101']) {
        for (let from = str.indexOf(p); from >= 0; from = str.indexOf(p, from + 1)) s += 40;
      }
      return s;
    };
    for (let y = 0; y < n; y += 1) {
      const row = [];
      const col = [];
      for (let x = 0; x < n; x += 1) {
        row.push(at(x, y));
        col.push(at(y, x));
      }
      score += runs(row) + runs(col);
    }
    for (let y = 0; y < n - 1; y += 1) {
      for (let x = 0; x < n - 1; x += 1) {
        const c = at(x, y);
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
      }
    }
    let dark = 0;
    for (let k = 0; k < n * n; k += 1) dark += this.dark[k];
    score += (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
    return score;
  }
}

// opts.mask: ép một mặt nạ (0-7) thay vì chọn theo điểm; chỉ để kiểm đủ tám mặt nạ.
export function encodeQR(text, opts = {}) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let version = 1;
  while (version <= 10 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) version += 1;
  if (version > 10) throw new Error('Chuỗi quá dài cho mã QR (tối đa 213 byte).');
  const codewords = withErrorCorrection(encodeData(bytes, version), version);
  const m = new Matrix(version);
  m.drawFunctionPatterns();
  m.drawCodewords(codewords);
  let best = Number.isInteger(opts.mask) ? opts.mask : 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8 && !Number.isInteger(opts.mask); mask += 1) {
    m.applyMask(mask);
    m.drawFormat(mask);
    const score = m.penalty();
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    m.applyMask(mask); // lật lại về như cũ
  }
  m.applyMask(best);
  m.drawFormat(best);
  return { version, mask: best, size: m.size, get: (x, y) => m.get(x, y) };
}

// SVG một đường path duy nhất cho mọi ô tối: nhẹ, nét căng ở mọi cỡ.
export function qrToSvg(qr, { margin = 4, dark = '#0b0c10', light = '#ffffff' } = {}) {
  const total = qr.size + margin * 2;
  let d = '';
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) if (qr.get(x, y)) d += `M${x + margin} ${y + margin}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

// Mã QR cho cửa sổ console: mỗi ký tự là hai ô dọc (nửa khối). Ô sáng in thành khối trắng,
// ô tối để trống cho nền đen hiện ra, nên trên console nền tối vẫn là "tối trên nền sáng".
export function qrToTerminal(qr, margin = 3) {
  const n = qr.size;
  const light = (x, y) => x < 0 || y < 0 || x >= n || y >= n || !qr.get(x, y);
  const lines = [];
  for (let y = -margin; y < n + margin; y += 2) {
    let line = '';
    for (let x = -margin; x < n + margin; x += 1) {
      const top = light(x, y);
      const bottom = y + 1 < n + margin ? light(x, y + 1) : true;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
