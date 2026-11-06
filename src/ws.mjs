// WebSocket tối giản (RFC 6455), chỉ phía máy chủ, không thư viện ngoài. Dùng cho luồng màn hình:
// khung hình đi một chiều ra điện thoại, thao tác chuột và phím đi chiều ngược lại.
//
// Chỉ làm đúng phần cần: bắt tay, khung chữ và khung nhị phân (kể cả bị chia mảnh), ping/pong,
// đóng. Không nén (permessage-deflate): khung hình H.264 đã nén sẵn, nén thêm chỉ tốn CPU và
// thêm trễ.

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024; // điện thoại chỉ gửi lệnh nhỏ; lớn hơn là bất thường

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function frameHeader(opcode, length) {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length < 65536) {
    const h = Buffer.alloc(4);
    h[0] = 0x80 | opcode;
    h[1] = 126;
    h.writeUInt16BE(length, 2);
    return h;
  }
  const h = Buffer.alloc(10);
  h[0] = 0x80 | opcode;
  h[1] = 127;
  h.writeBigUInt64BE(BigInt(length), 2);
  return h;
}

export class WsConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = 0;
    this.closed = false;
    socket.setNoDelay(true); // khung hình nhỏ phải đi ngay, không chờ gom
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    if (this.buffer.length) queueMicrotask(() => this.parse());
  }

  // Số byte còn nằm trong hàng đợi gửi: thước đo đường truyền đang nghẽn tới đâu.
  get buffered() {
    return this.socket.writableLength;
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.parse();
  }

  parse() {
    while (!this.closed && this.buffer.length >= 2) {
      const b = this.buffer;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let length = b[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (b.length < 4) return;
        length = b.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'Quá lớn');
        length = Number(big);
        offset = 10;
      }
      // Trình duyệt luôn che (mask) khung gửi lên; khung không che là trái giao thức.
      if (!masked) return this.close(1002, 'Khung không che');
      if (length > MAX_MESSAGE) return this.close(1009, 'Quá lớn');
      if (b.length < offset + 4 + length) return;
      const mask = b.subarray(offset, offset + 4);
      const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(offset + 4 + length);
      this.onFrame(fin, opcode, payload);
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === OP_PING) return this.write(OP_PONG, payload);
    if (opcode === OP_PONG) return undefined;
    if (opcode === OP_CLOSE) {
      this.close(1000);
      return undefined;
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (!fin) {
        this.fragmentOp = opcode;
        this.fragments = [payload];
        return undefined;
      }
      return this.deliver(opcode, payload);
    }
    if (opcode === OP_CONT && this.fragmentOp) {
      this.fragments.push(payload);
      const size = this.fragments.reduce((n, f) => n + f.length, 0);
      if (size > MAX_MESSAGE) return this.close(1009, 'Quá lớn');
      if (!fin) return undefined;
      const op = this.fragmentOp;
      const whole = Buffer.concat(this.fragments);
      this.fragments = [];
      this.fragmentOp = 0;
      return this.deliver(op, whole);
    }
    return this.close(1002, 'Khung lạ');
  }

  deliver(opcode, payload) {
    if (opcode === OP_TEXT) this.emit('text', payload.toString('utf8'));
    else this.emit('binary', payload);
  }

  // prefix: phần đầu riêng của tầng trên (kiểu khung, số thứ tự), ghép trước nội dung trong cùng
  // một tin mà không phải chép khung hình sang bộ nhớ mới.
  write(opcode, payload, prefix = null) {
    if (this.closed || this.socket.destroyed) return false;
    const header = frameHeader(opcode, payload.length + (prefix ? prefix.length : 0));
    this.socket.cork();
    this.socket.write(header);
    if (prefix) this.socket.write(prefix);
    const ok = this.socket.write(payload);
    this.socket.uncork();
    return ok;
  }

  sendText(text) {
    return this.write(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  sendJson(value) {
    return this.sendText(JSON.stringify(value));
  }

  sendBinary(buffer, prefix = null) {
    return this.write(OP_BINARY, buffer, prefix);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.write(OP_CLOSE, body);
    this.socket.end();
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

// Nhận lời xin nâng cấp lên WebSocket. Trả về kết nối, hoặc null nếu lời xin sai (đã trả lỗi).
export function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'));
  return new WsConnection(socket, head);
}
