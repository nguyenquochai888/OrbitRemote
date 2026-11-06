// Ghép đôi thiết bị và kiểm thẻ truy cập.
//
// Trạm điều khiển được phiên Claude ở chế độ bỏ qua quyền, tức là ai vào được trạm thì
// chạy được lệnh trên máy. Vì vậy MỌI yêu cầu đều phải mang thẻ, kể cả yêu cầu tới từ
// 127.0.0.1: một bộ chuyển tiếp (reverse proxy) đặt trên chính máy này sẽ đưa yêu cầu từ ngoài
// tới dưới dạng 127.0.0.1, nên tin địa chỉ nội bộ là mở cửa cho cả mạng ngoài.
//
// Thẻ chỉ được lưu dưới dạng băm. Lộ file trạng thái thì cũng không dùng lại được thẻ.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { STATE_DIR, readJson, writeJsonAtomic } from './paths.mjs';

const AUTH_FILE = join(STATE_DIR, 'auth.json');
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_MAX_FAILS = 5; // đoán sai bấy nhiêu lần liền thì mọi mã chết, phải xin mã mới
const PAIR_MAX_ACTIVE = 3;
const ENROLL_TTL_MS = 30 * 60 * 1000; // yêu cầu nối chưa ai duyệt thì tự hết hạn
const ENROLL_PICKUP_MS = 10 * 60 * 1000; // đã duyệt mà máy không tới lấy thẻ thì huỷ
const ENROLL_MAX_PENDING = 10;
const ENROLL_RATE_PER_MIN = 30; // chặn ai đó dội yêu cầu nối vào trạm

const hash = (token) => createHash('sha256').update(token).digest('hex');

export class Auth {
  constructor(file = AUTH_FILE) {
    this.file = file;
    this.data = readJson(file, { devices: [] });
    this.byHash = new Map(this.data.devices.map((d) => [d.tokenHash, d]));
    this.pairCodes = new Map(); // mã -> thời điểm hết hạn
    this.pairFails = 0;
    this.lastSeenDirty = false;
    // Yêu cầu nối của máy mới: chỉ trong bộ nhớ, trạm khởi động lại thì máy tự gửi lại.
    this.enrollments = new Map();
    this.enrollTimes = [];
  }

  issue(name, kind, extra = {}) {
    const token = randomBytes(32).toString('base64url');
    const device = {
      id: randomBytes(6).toString('hex'),
      name: String(name || 'Thiết bị').slice(0, 60),
      kind,
      ...extra,
      tokenHash: hash(token),
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    this.data.devices.push(device);
    this.byHash.set(device.tokenHash, device);
    this.save();
    return { token, device };
  }

  save() {
    writeJsonAtomic(this.file, this.data);
  }

  prunePairCodes() {
    const now = Date.now();
    for (const [code, expires] of this.pairCodes) if (now > expires) this.pairCodes.delete(code);
  }

  // Vài mã cùng sống một lúc: run.cmd cần một mã cho trình duyệt máy này tự ghép và một mã
  // khác in ra cho điện thoại. Nếu chỉ giữ một mã thì mã in ra chính là mã trình duyệt vừa
  // dùng mất (đã gặp thật). Giữ tối đa PAIR_MAX_ACTIVE mã, mã cũ nhất bị bỏ trước.
  newPairCode() {
    this.prunePairCodes();
    while (this.pairCodes.size >= PAIR_MAX_ACTIVE) this.pairCodes.delete(this.pairCodes.keys().next().value);
    let code;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0'); while (this.pairCodes.has(code));
    this.pairCodes.set(code, Date.now() + PAIR_TTL_MS);
    return code;
  }

  // Đổi mã ghép đôi lấy một thẻ dài hạn. Mã dùng một lần: ghép xong là mã chết. Đoán sai
  // PAIR_MAX_FAILS lần liền thì mọi mã đang sống đều chết, phải xin mã mới.
  redeem(code, name, kind = 'device') {
    this.prunePairCodes();
    if (!this.pairCodes.size) return { error: 'Mã ghép đôi đã hết hạn. Lấy mã mới trên máy tính.' };
    const given = String(code || '').replace(/\D/g, '');
    if (!this.pairCodes.has(given)) {
      this.pairFails += 1;
      if (this.pairFails >= PAIR_MAX_FAILS) {
        this.pairCodes.clear();
        this.pairFails = 0;
      }
      return { error: 'Sai mã ghép đôi.' };
    }
    this.pairCodes.delete(given);
    this.pairFails = 0;
    const { token, device } = this.issue(name, kind);
    return { token, device: publicDevice(device) };
  }

  // ---- Máy mới xin nối, người dùng duyệt trên app --------------------------------
  pruneEnrollments() {
    const now = Date.now();
    for (const [id, e] of this.enrollments) {
      const ttl = e.status === 'pending' ? ENROLL_TTL_MS : ENROLL_PICKUP_MS;
      if (now - e.updatedAt > ttl) this.enrollments.delete(id);
    }
  }

  requestEnroll({ machineId, name, platform, ip }) {
    const now = Date.now();
    this.enrollTimes = this.enrollTimes.filter((t) => now - t < 60000);
    if (this.enrollTimes.length >= ENROLL_RATE_PER_MIN) return { error: 'Quá nhiều yêu cầu nối, thử lại sau.' };
    this.enrollTimes.push(now);
    this.pruneEnrollments();
    const mid = String(machineId || '').slice(0, 40);
    if (!/^[\w-]{4,40}$/.test(mid)) return { error: 'Mã máy không hợp lệ.' };
    // Một máy chỉ giữ một yêu cầu: gửi lại thì thay yêu cầu cũ.
    for (const [id, e] of this.enrollments) if (e.machineId === mid && e.status === 'pending') this.enrollments.delete(id);
    if ([...this.enrollments.values()].filter((e) => e.status === 'pending').length >= ENROLL_MAX_PENDING) {
      return { error: 'Đang có quá nhiều máy chờ duyệt.' };
    }
    const entry = {
      requestId: randomBytes(8).toString('hex'),
      pollSecret: randomBytes(24).toString('base64url'),
      machineId: mid,
      name: String(name || 'Máy tính').slice(0, 60),
      platform: String(platform || '').slice(0, 20),
      ip: String(ip || '').slice(0, 60),
      at: new Date(now).toISOString(),
      updatedAt: now,
      status: 'pending',
      token: null,
    };
    this.enrollments.set(entry.requestId, entry);
    return { requestId: entry.requestId, pollSecret: entry.pollSecret };
  }

  pollEnroll(requestId, secret) {
    this.pruneEnrollments();
    const e = this.enrollments.get(requestId);
    if (!e) return { status: 'expired' };
    const given = Buffer.from(String(secret || ''));
    const want = Buffer.from(e.pollSecret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return { status: 'expired' };
    if (e.status === 'approved') {
      // Thẻ chỉ trao đúng một lần rồi xoá khỏi bộ nhớ.
      this.enrollments.delete(requestId);
      return { status: 'approved', token: e.token };
    }
    if (e.status === 'rejected') this.enrollments.delete(requestId);
    return { status: e.status };
  }

  decideEnroll(requestId, approve) {
    const e = this.enrollments.get(requestId);
    if (!e || e.status !== 'pending') return null;
    e.updatedAt = Date.now();
    if (!approve) {
      e.status = 'rejected';
      return e;
    }
    // Máy xin nối lại (mất thẻ cũ) thì thu hồi thẻ cũ của chính máy đó.
    this.revokeMachine(e.machineId, false);
    const { token } = this.issue(e.name, 'node', { machineId: e.machineId });
    e.status = 'approved';
    e.token = token;
    return e;
  }

  pendingEnrollments() {
    this.pruneEnrollments();
    return [...this.enrollments.values()]
      .filter((e) => e.status === 'pending')
      .map(({ requestId, machineId, name, platform, ip, at }) => ({ requestId, machineId, name, platform, ip, at }));
  }

  revokeMachine(machineId, persist = true) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => !(d.kind === 'node' && d.machineId === machineId));
    if (this.data.devices.length === before) return false;
    this.byHash = new Map(this.data.devices.map((d) => [d.tokenHash, d]));
    if (persist) this.save();
    return true;
  }

  check(token, kind) {
    if (!token) return null;
    const device = this.byHash.get(hash(token));
    if (!device || (kind && device.kind !== kind)) return null;
    device.lastSeen = new Date().toISOString();
    this.lastSeenDirty = true;
    return device;
  }

  list() {
    return this.data.devices.map(publicDevice);
  }

  revoke(id) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    if (this.data.devices.length === before) return false;
    this.byHash = new Map(this.data.devices.map((d) => [d.tokenHash, d]));
    this.save();
    return true;
  }

  // Ghi lần thấy cuối theo lô, không ghi đĩa ở mỗi yêu cầu.
  flushLastSeen() {
    if (!this.lastSeenDirty) return;
    this.lastSeenDirty = false;
    this.save();
  }
}

function publicDevice(d) {
  return { id: d.id, name: d.name, kind: d.kind, machineId: d.machineId, createdAt: d.createdAt, lastSeen: d.lastSeen };
}
