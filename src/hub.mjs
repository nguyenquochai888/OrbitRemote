// Trạm: sổ cái của mọi máy và mọi phiên, và tổng đài chuyển tin giữa các phiên.
//
// Trạm không chạy Claude. Nó giữ:
//   - danh sách máy đang nối (mỗi máy một đầu máy, nối bằng `attachMachine`),
//   - ảnh chụp trạng thái của từng phiên, cộng một bộ đệm vòng các sự kiện gần nhất để
//     app mở lại một phiên là thấy ngay đoạn hội thoại,
//   - nhật ký tin nhắn giữa các phiên (chỉ trong bộ nhớ),
//   - các nhóm phiên cùng làm một mục tiêu (groups.mjs).
//
// Lớp HTTP (server.mjs) chỉ dịch yêu cầu của app thành lời gọi vào đây, và nghe sự kiện
// `push` để đẩy ra cho mọi app đang mở.

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { STATE_DIR, readJson, writeJsonAtomic } from './paths.mjs';
import { Rpc } from './rpc.mjs';
import { normalizeMac, sameSubnet } from './wake.mjs';
import { MAX_DELAY_SEC } from './power.mjs';
import { Groups, cleanRole } from './groups.mjs';
import { SessionMover } from './session-move.mjs';
import { TokenBook } from './token-book.mjs';
import { FAMILIES, modelTable, modelsView, refreshModels } from './models.mjs';
import { isIP } from 'node:net';
import { CONTROL_ACTIONS, controlTimeoutMs } from './remote-ops.mjs';

const BUFFER_MAX = 600; // sự kiện giữ lại cho mỗi phiên
const TEXT_MAX = 20000; // một khối chữ dài hơn thì cắt bớt trong bộ đệm
const CHANNEL_MAX = 300;
const RECENT_DIRS_MAX = 12;
const PENDING_RESTORE_MS = 1500; // chờ sự kiện xin quyền tới trước khi dựng lại thẻ duyệt (restorePending)
const MENTIONS_MAX = 20; // số phiên được tag tối đa trong một tin
const DELTA_FLUSH_MS = 60; // gộp từng mẩu chữ đang chảy để không bắn một gói cho mỗi token
const SAVE_DELAY_MS = 1500;
const RUNNING = new Set(['starting', 'idle', 'busy', 'waiting']);

// So đường dẫn tệp app xin với lời của phiên (readSessionFile): bỏ khác biệt \ và /, hoa thường, và mã %XX của
// link file:/// (Claude viết "My%20Game", app xin "My Game").
export function normFilePath(p) {
  const s = String(p || '').trim().replace(/\\/g, '/').toLowerCase();
  return s.length >= 3 && s.length <= 1000 ? s : '';
}
export function normFileText(text) {
  return String(text || '').replace(/(%[0-9a-f]{2})+/gi, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  }).replace(/\\/g, '/').toLowerCase();
}

// Lịch tắt máy một máy báo lên: { action, leftMs } (số mili giây còn lại), vì đồng hồ các máy có thể
// lệch nhau. Trạm đổi ra giờ tắt theo đồng hồ của chính nó; đầu máy bản trước chỉ báo giờ tắt (at).
const POWER_STALE_MS = 60 * 1000; // quá giờ tắt một phút mà máy vẫn chạy: lịch đã bị huỷ trên máy
function powerFromMachine(p) {
  if (p?.action !== 'shutdown') return null;
  const left = Number.isFinite(p.leftMs) ? p.leftMs : Number(p.at) - Date.now();
  if (!Number.isFinite(left) || left < -POWER_STALE_MS) return null;
  return { action: 'shutdown', at: Date.now() + left };
}

// Gửi cho app cũng là số mili giây còn lại: app đổi ra giờ theo đồng hồ của điện thoại.
function publicPower(p) {
  if (!p || p.at < Date.now() - POWER_STALE_MS) return null;
  return { action: p.action, leftMs: Math.max(0, p.at - Date.now()) };
}

// Card mạng một máy báo lên (wake.mjs): chỉ giữ MAC hợp lệ và địa chỉ IPv4.
function cleanWake(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const x of list.slice(0, 4)) {
    const mac = normalizeMac(x?.mac);
    if (!mac || isIP(String(x.address || '')) !== 4 || isIP(String(x.netmask || '')) !== 4) continue;
    out.push({ name: String(x.name || '').slice(0, 60), mac, address: x.address, netmask: x.netmask, broadcast: isIP(String(x.broadcast || '')) === 4 ? x.broadcast : '' });
  }
  return out.length ? out : null;
}

// Kết quả setup một máy gửi lên: chỉ giữ những gì app hiện, cắt chữ cho gọn.
function cleanSetup(r) {
  if (!r || typeof r !== 'object') return null;
  const items = (list) => (Array.isArray(list) ? list.slice(0, 20).map((x) => ({ title: String(x?.title || '').slice(0, 120), detail: String(x?.detail || '').slice(0, 300) })) : []);
  return {
    at: String(r.at || ''),
    mode: String(r.mode || ''),
    pull: String(r.pull || '').slice(0, 200),
    done: Boolean(r.done),
    ok: Boolean(r.ok),
    failed: items(r.failed),
    needsUser: items(r.needsUser),
    warnings: items(r.warnings),
  };
}

const META_FIELDS = [
  'id', 'claudeSessionId', 'name', 'cwd', 'model', 'effort', 'permissionMode', 'remoteControl', 'remote', 'status',
  'costUsd', 'lastText', 'createdAt', 'lastActivity', 'machineId', 'machine', 'movedFrom',
];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

export class Hub extends EventEmitter {
  constructor({ stateDir = STATE_DIR } = {}) {
    super();
    this.file = join(stateDir, 'hub.json');
    this.machines = new Map(); // machineId -> { id, name, platform, online, link, rpc, lastSeen }
    this.sessions = new Map(); // sessionId -> bản ghi phiên
    this.channel = [];
    this.recents = {};
    // Phiên ở máy này được làm việc trên máy kia (orbit_machine_*): { mã máy đích: [mã máy nguồn] }, người dùng bật
    // trong bảng của máy đích. lastControl: lần điều khiển gần nhất trên mỗi máy đích, để app báo cho người ngồi máy.
    this.controlGrants = {};
    this.lastControl = new Map();
    this.deltas = new Map();
    this.deltaTimer = null;
    this.saveTimer = null;
    this.groups = new Groups(this);
    this.mover = new SessionMover(this); // chuyển phiên sang máy khác (session-move.mjs)
    this.tokenBook = new TokenBook(join(stateDir, 'usage-tokens.json')); // token Claude Code từng máy trong tuần
    this.load();
  }

  // ---- Lưu và nạp -----------------------------------------------------------
  load() {
    const saved = readJson(this.file, null);
    if (!saved) return;
    this.recents = saved.recents || {};
    this.controlGrants = saved.controlGrants && typeof saved.controlGrants === 'object' ? saved.controlGrants : {};
    for (const meta of saved.sessions || []) {
      // Trạm vừa khởi động thì chưa phiên nào còn chạy dưới quyền nó; đầu máy nào còn
      // giữ phiên sống sẽ tự báo lại khi nối vào.
      const status = RUNNING.has(meta.status) ? 'stopped' : meta.status;
      this.sessions.set(meta.id, this.newRecord({ ...meta, status, pending: [] }));
    }
    for (const m of saved.machines || []) {
      this.machines.set(m.id, { ...m, online: false, link: null, rpc: null, external: [] });
    }
    this.groups.load(saved.groups);
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  saveNow() {
    writeJsonAtomic(this.file, {
      sessions: [...this.sessions.values()].map((r) => pick(r.snap, META_FIELDS)),
      machines: [...this.machines.values()].map((m) => ({
        id: m.id, name: m.name, alias: m.alias, platform: m.platform, lastSeen: m.lastSeen, firstSeen: m.firstSeen, local: m.local,
        screen: m.screen || undefined,
        wake: m.wake?.length ? m.wake : undefined, // card mạng: để bật lại máy khi nó đã tắt
      })),
      recents: this.recents,
      groups: this.groups.toJSON(),
      controlGrants: this.controlGrants,
    });
  }

  newRecord(snap) {
    return { snap, buffer: [], seq: 0, history: null };
  }

  // ---- Đẩy ra cho app ----------------------------------------------------------
  push(type, data) {
    this.emit('push', type, data);
  }

  publicMachine(m) {
    // Phiên do chính app mở (kể cả đã dừng) không tính là "ngoài app", dù nhật ký vừa được ghi.
    const ours = new Set([...this.sessions.values()].filter((r) => r.snap.machineId === m.id).map((r) => r.snap.claudeSessionId));
    return {
      id: m.id,
      name: m.alias || m.name,
      hostName: m.name,
      platform: m.platform,
      online: m.online,
      local: Boolean(m.local),
      lastSeen: m.lastSeen,
      firstSeen: m.firstSeen,
      screen: Boolean(m.screen),
      external: (m.external || []).filter((t) => !ours.has(t.claudeSessionId)),
      setup: m.setup || null, // kết quả lần setup gần nhất của máy (lệnh "Setup máy" hay setup.cmd)
      canWake: Boolean(m.wake?.length), // trạm biết card mạng của máy, bật qua mạng được
      power: m.online ? publicPower(m.power) : null, // lịch tắt máy đang chờ (đặt từ app)
      controlFrom: this.controlGrants[m.id] || [], // máy có phiên được làm việc trên máy này (orbit_machine_*)
      lastControl: this.lastControl.get(m.id) || null, // lần gần nhất một phiên ở máy khác thao tác trên máy này
    };
  }

  publicSession(r) {
    return r.snap;
  }

  state() {
    return {
      machines: [...this.machines.values()].map((m) => this.publicMachine(m)),
      sessions: [...this.sessions.values()].map((r) => this.publicSession(r)),
      channel: this.channel.slice(-100),
      recents: this.recents,
      groups: this.groups.list(),
    };
  }

  // ---- Đầu máy nối vào ---------------------------------------------------------
  // link: { send(message), close?() }. Trả về { receive, disconnect } cho tầng vận chuyển.
  // opts.machineId: thẻ của đầu máy gắn với đúng một máy; đầu máy chào bằng mã khác thì bị
  // từ chối, để thẻ lộ của máy này không giả được máy khác. opts.local: đầu máy chung tiến trình.
  attachMachine(link, opts = {}) {
    let machine = null;
    const rpc = new Rpc((m) => link.send(m));
    const receive = (message) => {
      if (rpc.handleReply(message)) return;
      if (message.op === 'hello') {
        if (opts.machineId && message.machine?.id !== opts.machineId) {
          link.close?.();
          return;
        }
        machine = this.onHello(message, link, rpc, opts);
        return;
      }
      if (!machine) return; // chưa chào thì chưa nhận gì
      machine.lastSeen = new Date().toISOString();
      this.onMachineMessage(machine, message, link);
    };
    const disconnect = () => {
      rpc.failAll('Mất kết nối tới máy.');
      // Máy vừa bị quên thì đường nối đứt theo; đừng báo nó "mất kết nối" làm nó hiện lại trên app.
      if (!machine || machine.link !== link || this.machines.get(machine.id) !== machine) return;
      machine.online = false;
      machine.link = null;
      machine.rpc = null;
      this.push('machine', this.publicMachine(machine));
      this.scheduleSave();
    };
    return { receive, disconnect };
  }

  onHello({ machine: info, sessions, screen, setup, wake, power }, link, rpc, opts = {}) {
    const old = this.machines.get(info.id);
    if (old?.link && old.link !== link) old.link.close?.();
    const now = new Date().toISOString();
    const machine = {
      id: info.id,
      name: info.name,
      alias: old?.alias,
      platform: info.platform,
      screen: screen && Array.isArray(screen.hosts) ? { port: Number(screen.port) || 0, hosts: screen.hosts.map(String).slice(0, 8) } : null,
      local: Boolean(opts.local),
      online: true,
      link,
      rpc,
      external: old?.external || [],
      setup: cleanSetup(setup) || old?.setup || null,
      wake: cleanWake(wake) || old?.wake || [],
      power: powerFromMachine(power),
      firstSeen: old?.firstSeen || now,
      lastSeen: now,
    };
    this.machines.set(info.id, machine);
    // Bảng bản model mới nhất trạm đang giữ: máy vừa nối (kể cả máy tắt lúc chủ dự án bấm cập nhật) nhận ngay, không
    // phải tự hỏi máy chủ Anthropic. Đầu máy bản cũ không hiểu lệnh thì thôi.
    const models = modelTable();
    if (models.source === 'api') rpc?.request({ op: 'models_set', table: { at: models.at, models: models.models } }).catch(() => {});

    // Đối chiếu: phiên trạm tưởng đang chạy trên máy này mà đầu máy không còn giữ
    // thì đã dừng (đầu máy khởi động lại chẳng hạn).
    const alive = new Set((sessions || []).map((s) => s.id));
    for (const r of this.sessions.values()) {
      if (r.snap.machineId === info.id && RUNNING.has(r.snap.status) && !alive.has(r.snap.id)) {
        const prev = r.snap;
        r.snap = { ...r.snap, status: 'stopped', pending: [] };
        this.push('session', this.publicSession(r));
        this.groups.onSessionSnap(prev, r.snap);
      }
    }
    for (const snap of sessions || []) this.upsertSession(machine, snap);
    this.push('machine', this.publicMachine(machine));
    this.scheduleSave();
    return machine;
  }

  onMachineMessage(machine, message, link) {
    switch (message.op) {
      case 'status':
        this.upsertSession(machine, message.session);
        return;
      case 'event':
        this.appendEvent(message.id, message.ev);
        return;
      case 'delta':
        this.queueDelta(message.id, message.text);
        return;
      case 'external':
        machine.external = Array.isArray(message.list) ? message.list.slice(0, 30) : [];
        this.push('machine', this.publicMachine(machine));
        return;
      case 'setup':
        machine.setup = cleanSetup(message.result);
        this.push('machine', this.publicMachine(machine));
        return;
      case 'power':
        machine.power = powerFromMachine(message.power);
        this.push('machine', this.publicMachine(machine));
        return;
      case 'tokens':
        // Máy tự báo số token Claude Code của nó trong tuần usage (node-agent.mjs pushTokens).
        this.tokenBook.record(machine.id, machine.alias || machine.name, message);
        return;
      case 'route':
        this.route(message.from, message.to, message.text, message.needsAction).then(
          (data) => link.send({ op: 'reply', rid: message.rid, ok: true, data }),
          (err) => link.send({ op: 'reply', rid: message.rid, ok: false, error: err.message }),
        );
        return;
      case 'query':
        link.send({ op: 'reply', rid: message.rid, ok: true, data: this.directory(message.from) });
        return;
      case 'machine':
        // Công cụ orbit_machine_* của một phiên: làm việc trên máy khác (machineControl).
        this.machineControl(machine, message.from, String(message.action || ''), message.args || {}).then(
          (data) => link.send({ op: 'reply', rid: message.rid, ok: true, data }),
          (err) => link.send({ op: 'reply', rid: message.rid, ok: false, error: err.message }),
        );
        return;
      case 'group': {
        // Công cụ orbit_remote_group của một phiên: chỉ nhận từ đúng máy đang chạy phiên đó.
        const own = this.sessions.get(message.from)?.snap.machineId === machine.id;
        (own ? this.groups.action(message.from, message.args || {}) : Promise.reject(new Error('Phiên này không chạy trên máy gửi lệnh.'))).then(
          (data) => link.send({ op: 'reply', rid: message.rid, ok: true, data }),
          (err) => link.send({ op: 'reply', rid: message.rid, ok: false, error: err.message }),
        );
        return;
      }
      default:
        // Đầu máy bản mới hỏi một lệnh trạm này chưa có: trả lời ngay thay vì để nó chờ hết giờ.
        if (message.rid) link.send({ op: 'reply', rid: message.rid, ok: false, error: `Trạm chưa hiểu lệnh ${message.op}: khởi động lại trạm để nạp bản mới.` });
    }
  }

  upsertSession(machine, snap) {
    let r = this.sessions.get(snap.id);
    const prev = r?.snap || null;
    const merged = { ...(r?.snap || {}), ...snap, machineId: machine.id, machine: machine.alias || machine.name };
    // Tên đặt lại trên app thắng tên lúc mở phiên.
    if (r?.snap.renamed) merged.name = r.snap.name;
    if (!r) {
      r = this.newRecord(merged);
      this.sessions.set(snap.id, r);
    } else {
      r.snap = merged;
    }
    this.push('session', this.publicSession(r));
    this.scheduleSave();
    // Nhóm phiên: cộng chi phí, trả dụng cụ khi phiên dừng, dừng thành viên đã bàn giao khi hết lượt.
    this.groups.onSessionSnap(prev, r.snap);
    if (r.snap.pending?.length) this.queuePendingRestore(r);
    return r;
  }

  // Yêu cầu duyệt còn treo ở đầu máy mà dòng hội thoại trên trạm không còn thẻ duyệt: trạm vừa khởi động lại (bộ đệm
  // sự kiện chỉ nằm trong bộ nhớ; nhật ký Claude Code không ghi yêu cầu duyệt), hay thẻ đã trôi khỏi bộ đệm. Khi đó
  // app không có chỗ bấm duyệt mà phiên chờ mãi (đã gặp thật: phiên Animation treo "cần duyệt Bash"). Dựng lại thẻ từ
  // trạng thái phiên. Chờ một nhịp rồi mới xét, vì sự kiện xin quyền có thể tới sau trạng thái báo đang chờ.
  queuePendingRestore(r) {
    if (r.restoreTimer) return;
    r.restoreTimer = setTimeout(() => {
      r.restoreTimer = null;
      this.restorePending(r.snap.id);
    }, PENDING_RESTORE_MS);
    r.restoreTimer.unref?.();
  }

  restorePending(id) {
    const r = this.sessions.get(id);
    if (!r || !Array.isArray(r.snap.pending) || !r.snap.pending.length) return;
    const seen = new Set(r.buffer.filter((e) => e.t === 'permission' || e.t === 'permission_done').map((e) => e.requestId));
    for (const p of r.snap.pending) {
      if (!p?.requestId || seen.has(p.requestId)) continue;
      // Đầu máy bản mới gửi đủ chi tiết; bản cũ chỉ có công cụ và tóm tắt, vẫn đủ để cho phép hay từ chối.
      this.appendEvent(id, {
        t: 'permission',
        requestId: p.requestId,
        tool: p.tool || '',
        displayName: p.displayName || p.tool || '',
        description: p.description || '',
        summary: p.summary || '',
        inputPreview: p.inputPreview || '',
        canAlways: Boolean(p.canAlways),
        ...(Array.isArray(p.questions) ? { questions: p.questions } : {}),
        restored: true,
        at: new Date().toISOString(),
      });
    }
  }

  appendEvent(id, ev) {
    const r = this.sessions.get(id);
    if (!r) return;
    // Khối chữ cuối cùng đã tới thì mẩu đang chảy của nó phải xả trước, kẻo app vẽ ngược thứ tự.
    this.flushDeltas(id);
    if (typeof ev.text === 'string' && ev.text.length > TEXT_MAX) {
      ev = { ...ev, text: `${ev.text.slice(0, TEXT_MAX)}… (đã cắt bớt trong bộ đệm)` };
    }
    r.seq += 1;
    const item = { seq: r.seq, ...ev };
    r.buffer.push(item);
    if (r.buffer.length > BUFFER_MAX) r.buffer.shift();
    this.push('event', { id, ev: item });
  }

  queueDelta(id, text) {
    this.deltas.set(id, (this.deltas.get(id) || '') + text);
    if (!this.deltaTimer) {
      this.deltaTimer = setTimeout(() => {
        this.deltaTimer = null;
        for (const sid of [...this.deltas.keys()]) this.flushDeltas(sid);
      }, DELTA_FLUSH_MS);
    }
  }

  flushDeltas(id) {
    const text = this.deltas.get(id);
    if (!text) return;
    this.deltas.delete(id);
    this.push('delta', { id, text });
  }

  // ---- Chuyển tin giữa các phiên -----------------------------------------------
  directory(fromId) {
    return [...this.sessions.values()]
      .filter((r) => RUNNING.has(r.snap.status))
      .map(({ snap }) => ({
        id: snap.id,
        name: snap.name,
        machine: snap.machine,
        status: snap.status,
        cwd: snap.cwd,
        group: this.groups.groupOf(snap.id)?.name || undefined,
        self: snap.id === fromId || undefined,
      }));
  }

  resolveTargets(fromId, to) {
    const key = String(to || '').trim();
    if (!key) throw new Error('Thiếu người nhận ("to").');
    const running = [...this.sessions.values()].filter((r) => RUNNING.has(r.snap.status) && r.snap.id !== fromId);
    if (key === '*') return running;
    if (key === '#group') {
      const g = this.groups.groupOf(fromId);
      if (!g) throw new Error('Phiên này chưa ở nhóm nào nên không gửi được "#group".');
      const mates = running.filter((r) => g.members.some((m) => m.id === r.snap.id));
      if (!mates.length) throw new Error(`Nhóm "${g.name}" không còn thành viên nào khác đang chạy.`);
      return mates;
    }
    const byId = running.filter((r) => r.snap.id === key);
    if (byId.length) return byId;
    const [name, machine] = key.includes('@') ? key.split('@') : [key, null];
    const lower = name.toLowerCase();
    const hits = running.filter((r) => r.snap.name.toLowerCase() === lower
      && (!machine || r.snap.machine.toLowerCase() === machine.toLowerCase()));
    if (hits.length > 1) {
      throw new Error(`Có ${hits.length} phiên cùng tên "${name}". Gửi theo mã phiên: ${hits.map((r) => `${r.snap.id} (${r.snap.machine})`).join(', ')}.`);
    }
    if (!hits.length) throw new Error(`Không thấy phiên nào đang chạy khớp "${key}". Dùng orbit_remote_sessions để xem danh sách.`);
    return hits;
  }

  // needsAction: người gửi tự khai tin có cần người nhận làm gì không; false thì đầu máy giữ tin lại, gộp vào lượt kế
  // tiếp của người nhận thay vì mở riêng một lượt Claude. Không khai (công cụ bản cũ) thì giao như thường.
  async route(fromId, to, text, needsAction = null) {
    const body = String(text || '').trim();
    if (!body) throw new Error('Tin nhắn trống.');
    const sender = this.sessions.get(fromId)?.snap;
    const from = sender ? { id: sender.id, name: sender.name, machine: sender.machine } : { id: fromId, name: fromId, machine: '?' };
    const targets = this.resolveTargets(fromId, to);
    // Nhóm đang tạm dừng: thành viên không nhắn được cho nhau (mỗi tin là một lượt của người nhận).
    const own = this.groups.groupOf(fromId);
    if (own?.status === 'paused' && targets.some((r) => own.members.some((m) => m.id === r.snap.id))) {
      throw new Error(`Nhóm "${own.name}" đang tạm dừng theo lệnh của chủ dự án: không nhắn trong nhóm cho tới khi nhóm chạy tiếp.`);
    }
    const g = String(to || '').trim() === '#group' ? own : null;
    const delivered = [];
    const failed = [];
    const held = [];
    const hold = needsAction === false;
    await Promise.all(targets.map(async (r) => {
      const who = { id: r.snap.id, name: r.snap.name, machine: r.snap.machine };
      try {
        const reply = await this.machineRpc(r.snap.machineId).request({ op: 'deliver', id: r.snap.id, from, text: body, ...(g ? { group: { id: g.id, name: g.name } } : {}), ...(hold ? { hold: true } : {}) });
        delivered.push(who);
        if (hold && reply?.held === true) held.push(who);
      } catch (err) {
        failed.push({ ...who, error: err.message });
      }
    }));
    this.logChannel({ from, to: delivered, failed, text: body, groupId: g?.id, held });
    return { delivered, failed, ...(held.length ? { held } : {}) };
  }

  // Kênh: mọi tin giữa các phiên, kể cả tin trạm đẩy vào phiên thay cho chủ dự án của một nhóm.
  // held: người nhận được đầu máy giữ tin lại vì người gửi khai tin chỉ để báo (tin tới họ ở lượt kế tiếp).
  logChannel({ from, to, failed, text, groupId, held }) {
    const entry = { at: new Date().toISOString(), from, to, failed, text: String(text).slice(0, 4000), ...(groupId ? { groupId } : {}), ...(held?.length ? { held } : {}) };
    this.channel.push(entry);
    if (this.channel.length > CHANNEL_MAX) this.channel.shift();
    this.push('channel', entry);
  }

  // ---- Bản model mới nhất (nút cập nhật trên app) -----------------------------------------
  // Máy giữ trạm hỏi máy chủ Anthropic một lần (models.mjs), phát bảng mới xuống mọi máy đang bật, rồi chuyển các
  // phiên đang chạy theo tên dòng ("opus", "sonnet", "haiku") sang bản mới. Phiên đang mở dở sẽ chạy bản mới từ lượt
  // gọi model kế tiếp.
  // opts đi thẳng vào refreshModels (phép kiểm thay máy chủ Anthropic bằng hàm giả).
  async updateModels(opts = {}) {
    const r = await refreshModels(opts);
    if (!r.ok) throw new Error(r.error);
    const table = { at: r.table.at, models: r.table.models };
    const machines = [];
    await Promise.all([...this.machines.values()].filter((m) => m.online && m.rpc).map(async (m) => {
      const name = m.alias || m.name;
      try {
        await m.rpc.request({ op: 'models_set', table });
        machines.push({ name, ok: true });
      } catch (err) {
        machines.push({ name, ok: false, error: err.message });
      }
    }));
    let switched = 0;
    for (const rec of this.sessions.values()) {
      const fam = String(rec.snap.model || '').toLowerCase();
      if (!FAMILIES.includes(fam) || !RUNNING.has(rec.snap.status) || rec.snap.status === 'starting') continue;
      if (rec.snap.activeModel === table.models[fam].id) continue;
      try {
        await this.setModel(rec.snap.id, fam);
        switched += 1;
      } catch {
        // phiên vừa dừng hay máy vừa mất kết nối: lần mở sau tự dùng bản mới
      }
    }
    const view = modelsView();
    this.push('models', view);
    return { ...view, machines, switched };
  }

  // ---- Hành động từ app ----------------------------------------------------------
  // ---- Phiên làm việc trên máy khác (orbit_machine_*, remote-ops.mjs) ------------------------------------
  // Máy theo tên hiển thị, tên máy hay mã (không phân biệt hoa thường).
  findMachine(ref) {
    const key = String(ref || '').trim().toLowerCase();
    if (!key) return null;
    return [...this.machines.values()].find((m) => m.id.toLowerCase() === key || (m.alias || '').toLowerCase() === key || m.name.toLowerCase() === key) || null;
  }

  // Lệnh của một phiên chạy trên máy `source`. "machines": danh sách máy và quyền; còn lại: kiểm phiên chạy đúng trên
  // máy gửi, máy đích cho phép máy nguồn (hay chính là máy nguồn), rồi chuyển tới đầu máy của máy đích.
  async machineControl(source, sessionId, action, args = {}) {
    const r = this.sessions.get(sessionId);
    if (!r || r.snap.machineId !== source.id) throw new Error('Phiên này không chạy trên máy gửi lệnh.');
    const allowed = (m) => m.id === source.id || (this.controlGrants[m.id] || []).includes(source.id);
    if (action === 'machines') {
      return {
        text: [...this.machines.values()].map((m) => `${m.alias || m.name}${m.id === source.id ? ' (máy của phiên này)' : ''}: ${m.online ? 'đang bật' : 'đang tắt'}, ${m.platform || '?'}, ${allowed(m) ? 'được điều khiển' : 'chưa cho phép'}`).join('\n')
          + `\nMáy chưa cho phép thì người dùng bật trong app: màn của máy đó → nút ba chấm → Cho phiên ở máy khác điều khiển, chọn ${source.alias || source.name}.`,
      };
    }
    if (!CONTROL_ACTIONS.includes(action)) throw new Error(`Không hiểu thao tác "${action}".`);
    const target = this.findMachine(args.machine);
    if (!target) throw new Error(`Không có máy "${args.machine || ''}". Các máy: ${[...this.machines.values()].map((m) => m.alias || m.name).join(', ')}.`);
    const tName = target.alias || target.name;
    const sName = source.alias || source.name;
    if (!allowed(target)) {
      throw new Error(`Máy ${tName} chưa cho phép phiên ở máy ${sName} điều khiển. Người dùng bật trong app: màn của máy ${tName} → nút ba chấm → Cho phiên ở máy khác điều khiển, chọn ${sName}.`);
    }
    if (!target.online || !target.rpc) throw new Error(`Máy ${tName} đang tắt hay mất kết nối.`);
    const { machine: _m, ...rest } = args;
    if (target.id !== source.id) {
      const what = action === 'run' ? String(rest.command || '').slice(0, 120) : String(rest.path || rest.args?.[0] || '').slice(0, 120);
      this.lastControl.set(target.id, { session: r.snap.name, sessionId, machine: sName, action, what, at: new Date().toISOString() });
      this.push('machine', this.publicMachine(target));
    }
    try {
      return await target.rpc.request({ op: 'remote', action, args: rest }, controlTimeoutMs(action, rest) + 5000);
    } catch (err) {
      if (/không hiểu lệnh/.test(err.message)) throw new Error(`Máy ${tName} cần setup bản Orbit Remote mới để phiên ở máy khác làm việc trên nó.`);
      throw err;
    }
  }

  // Phiên mở ở máy `machineId` nhưng làm việc trên máy khác: { machineId, machine, cwd } hay null. Người dùng vừa chọn
  // máy làm việc trong bảng mở phiên, nên trạm cho phép luôn máy chạy phiên điều khiển máy đó (giống bật trong bảng của
  // máy đích). Máy đích đang bật thì kiểm thư mục dự án có thật.
  async remoteWork(machineId, spec, cwd) {
    const wantId = String(spec.remote?.machineId || spec.workMachineId || '');
    if (!wantId || wantId === machineId) return null;
    const target = this.machines.get(wantId);
    if (!target) throw new Error('Không biết máy làm việc này.');
    const tName = target.alias || target.name;
    const dir = String(spec.remote?.cwd || cwd || '').trim();
    if (!dir) throw new Error(`Cần chọn thư mục làm việc trên máy ${tName}.`);
    if (target.online && target.rpc && !spec.resume) {
      try {
        await target.rpc.request({ op: 'remote', action: 'read', args: { path: dir, limit: 1 } }, 20000);
      } catch (err) {
        if (/không hiểu lệnh/.test(err.message)) throw new Error(`Máy ${tName} cần setup bản Orbit Remote mới để phiên ở máy khác làm việc trên nó.`);
        throw new Error(`Không thấy thư mục ${dir} trên máy ${tName}.`);
      }
    }
    const from = this.controlGrants[wantId] || [];
    if (!from.includes(machineId)) this.setControlGrants(wantId, [...from, machineId]);
    return { machineId: wantId, machine: tName, cwd: dir };
  }

  // Người dùng chọn máy nào có phiên được làm việc trên máy `targetId` (bảng của máy đích trên app).
  setControlGrants(targetId, fromIds) {
    const target = this.machines.get(targetId);
    if (!target) throw new Error('Không biết máy này.');
    const list = [...new Set((Array.isArray(fromIds) ? fromIds : []).map(String))].filter((id) => id !== targetId && this.machines.has(id));
    if (list.length) this.controlGrants[targetId] = list;
    else delete this.controlGrants[targetId];
    this.push('machine', this.publicMachine(target));
    this.scheduleSave();
    return list;
  }

  machineRpc(machineId) {
    const m = this.machines.get(machineId);
    if (!m) throw new Error('Không biết máy này.');
    if (!m.online || !m.rpc) throw new Error(`Máy ${m.name} đang mất kết nối.`);
    return m.rpc;
  }

  record(id) {
    const r = this.sessions.get(id);
    if (!r) throw new Error('Không có phiên này.');
    return r;
  }

  rememberDir(machineId, cwd) {
    const same = /^[a-z]:[\\/]/i.test(cwd) ? (d) => d.toLowerCase() === cwd.toLowerCase() : (d) => d === cwd;
    const list = (this.recents[machineId] || []).filter((d) => !same(d));
    list.unshift(cwd);
    this.recents[machineId] = list.slice(0, RECENT_DIRS_MAX);
  }

  async createSession(machineId, spec) {
    const clean = {
      name: String(spec.name || '').trim().slice(0, 60) || 'Phiên mới',
      cwd: String(spec.cwd || '').trim(),
      model: String(spec.model || '').trim(),
      effort: String(spec.effort || '').trim(),
      permissionMode: spec.permissionMode || 'manual',
      // Bật Remote Control của Claude Code ngay khi phiên chạy (claude-session.mjs setRemoteControl).
      remoteControl: Boolean(spec.remoteControl),
      prompt: String(spec.prompt || ''),
      from: spec.from || null,
      resume: Boolean(spec.resume),
      fork: Boolean(spec.fork),
      claudeSessionId: spec.claudeSessionId || undefined,
      id: spec.id || undefined,
      // Phiên vừa được chuyển từ máy khác: đầu máy dặn rõ chỗ làm việc mới trong lời dặn hệ thống.
      movedFrom: spec.movedFrom?.machine
        ? { machine: String(spec.movedFrom.machine).slice(0, 60), cwd: String(spec.movedFrom.cwd || '').slice(0, 500), at: String(spec.movedFrom.at || '') }
        : undefined,
    };
    // Phiên chạy ở máy này nhưng làm việc trên máy khác (orbit_machine_*): cwd là thư mục dự án trên máy đó; đầu máy
    // chạy Claude Code trong một thư mục làm việc riêng của nó.
    const remote = await this.remoteWork(machineId, spec, clean.cwd);
    if (remote) clean.remote = remote;
    if (!clean.cwd && !remote) throw new Error('Cần chọn thư mục làm việc.');
    // Mở phiên ngay trong một nhóm: kiểm nhóm và vai trò trước, kẻo phiên mở rồi mới báo lỗi.
    const groupId = spec.groupId ? this.groups.ensureRoom(spec.groupId).id : '';
    const role = groupId ? cleanRole(spec.role) : '';
    const rpc = this.machineRpc(machineId);
    const snap = await rpc.request({ op: 'create', spec: clean });
    const machine = this.machines.get(machineId);
    // Ảnh chụp trong câu trả lời có thể đã cũ: đầu máy báo trạng thái ngay khi đổi, và
    // qua mạng cả lô (starting, trả lời, idle) tới cùng lúc, mà phần chạy tiếp sau `await`
    // lại chạy SAU cùng. Bản ghi đã có thì giữ nguyên, chỉ dùng câu trả lời để lấy mã.
    const r = this.sessions.get(snap.id) || this.upsertSession(machine, snap);
    // Phiên mới tinh thì không có gì trong nhật ký để nạp lại.
    if (spec.history) r.history = spec.history;
    else if (!clean.resume) r.history = [];
    // Máy làm việc của phiên giữ trên trạm (đầu máy không báo lại), để chạy lại, chuyển máy vẫn làm đúng chỗ.
    if (remote || r.snap.remote) {
      r.snap = { ...r.snap, remote: remote || undefined };
      this.push('session', this.publicSession(r));
    }
    if (remote) this.rememberDir(remote.machineId, remote.cwd);
    else this.rememberDir(machineId, clean.cwd);
    this.scheduleSave();
    if (groupId) await this.groups.addMember(groupId, r.snap.id, role);
    return r.snap;
  }

  sessionRpc(id) {
    return this.machineRpc(this.record(id).snap.machineId);
  }

  // mentions: [{ id, tag }] các phiên người dùng tag (@Tên-phiên) trong tin, chọn từ danh sách trên app. Trạm kiểm
  // phiên có thật rồi gửi kèm tên, máy, trạng thái, thư mục để Claude biết đích danh phiên nào (claude-session.mjs).
  sendToSession(id, text, from, attachments = null, mentions = null) {
    const tagged = this.resolveMentions(mentions, text);
    return this.sessionRpc(id).request({ op: 'send', id, text, from, ...(attachments?.length ? { attachments } : {}), ...(tagged.length ? { mentions: tagged } : {}) });
  }

  resolveMentions(list, text) {
    if (!Array.isArray(list) || !list.length) return [];
    const body = String(text || '');
    const out = [];
    const seen = new Set();
    for (const m of list.slice(0, MENTIONS_MAX)) {
      const tag = String(m?.tag || '').replace(/^@/, '').slice(0, 80);
      const r = this.sessions.get(String(m?.id || ''));
      if (!tag || !r || seen.has(tag) || !body.includes(`@${tag}`)) continue;
      seen.add(tag);
      const s = r.snap;
      out.push({
        tag,
        id: s.id,
        name: s.name,
        machine: s.machine,
        status: s.status,
        cwd: s.remote?.cwd || s.cwd || '',
        ...(s.remote?.machine ? { workMachine: s.remote.machine } : {}),
      });
    }
    return out;
  }

  setEffort(id, effort) {
    return this.sessionRpc(id).request({ op: 'set_effort', id, effort });
  }

  // Một khúc tệp đính kèm đã gửi trong phiên, đọc từ máy chạy phiên: { size, offset, data (base64) }.
  readAttachment(id, file, offset = 0) {
    return this.sessionRpc(id).request({ op: 'attachment', id, file, offset });
  }

  // Một khúc của một tệp trên máy chạy phiên mà Claude đã nhắc tới trong lời của phiên đó (link file:///, đường dẫn
  // tuyệt đối; web/lib/md.js dựng thành link mở được): { size, mtime, offset, data }. Chỉ đọc tệp có trong lời của
  // chính phiên, không phải mọi tệp trên máy. head: chỉ cỡ và giờ sửa.
  async readSessionFile(id, path, offset = 0, head = false) {
    const r = this.record(id);
    const want = normFilePath(path);
    if (!want) throw new Error('Đường dẫn tệp không hợp lệ.');
    r.filesSaid ||= new Set();
    if (!r.filesSaid.has(want)) {
      if (!r.history) await this.loadHistory(r);
      const said = [...(r.history || []), ...r.buffer].some((e) => e.t === 'text' && typeof e.text === 'string' && normFileText(e.text).includes(want));
      if (!said) throw new Error('Phiên này chưa nhắc tới tệp đó.');
      r.filesSaid.add(want);
    }
    return this.sessionRpc(id).request({ op: 'session_file', id, path: String(path), offset, ...(head ? { head: true } : {}) });
  }

  // Vé xem màn hình: đầu máy cấp, app dùng để nối thẳng tới máy (screen.mjs).
  screenTicket(machineId) {
    return this.machineRpc(machineId).request({ op: 'screen_ticket' });
  }

  // Tài khoản Claude của Claude Code trên một máy (claude-auth.mjs): xem đang đăng nhập ai, mở lượt đăng nhập (đầu
  // máy trả link), gửi mã người dùng chép từ trang đăng nhập (chờ tới CODE_WAIT_MS của đầu máy), hay huỷ lượt đó.
  claudeAuth(machineId) {
    return this.machineRpc(machineId).request({ op: 'claude_auth' }, 30000);
  }

  claudeLogin(machineId, email = '') {
    return this.machineRpc(machineId).request({ op: 'claude_login', email: String(email || '').slice(0, 200) }, 30000);
  }

  claudeLoginCode(machineId, id, code) {
    return this.machineRpc(machineId).request({ op: 'claude_login_code', id: String(id || ''), code: String(code || '').slice(0, 2000) }, 90000);
  }

  claudeLoginCancel(machineId, id) {
    return this.machineRpc(machineId).request({ op: 'claude_login_cancel', id: String(id || '') });
  }

  // Lệnh "Setup máy": máy kéo code Orbit Remote mới rồi chạy setup tự động (xem node-agent, op "update").
  updateMachine(machineId) {
    return this.machineRpc(machineId).request({ op: 'update' });
  }

  // Tắt máy (ngay, sau một số giây, hay hẹn giờ) hoặc huỷ lịch tắt đang chờ (power.mjs). Đầu máy đặt
  // lịch rồi báo lại lịch đó (op "power"), app hiện giờ tắt và nút huỷ.
  powerMachine(machineId, { action, delaySec } = {}) {
    if (action === 'cancel') return this.machineRpc(machineId).request({ op: 'power', action: 'cancel' });
    if (action !== 'shutdown') throw new Error('Lệnh tắt máy không hợp lệ.');
    const n = Number(delaySec);
    if (!Number.isInteger(n) || n < 0 || n > MAX_DELAY_SEC) throw new Error(`Hẹn giờ tắt từ 0 giây tới ${MAX_DELAY_SEC / 3600} giờ.`);
    return this.machineRpc(machineId).request({ op: 'power', action: 'shutdown', delaySec: n });
  }

  // Bật một máy đang tắt qua mạng (wake.mjs). Gói bật máy chỉ đi trong mạng nội bộ, nên nhờ mọi máy
  // đang nối trạm mà cùng dải mạng với máy cần bật bắn hộ (máy giữ trạm ở nhà, hay một máy khác ở
  // công ty). Không máy nào cùng mạng thì vẫn thử từ máy giữ trạm, kèm lời báo.
  async wakeMachine(machineId) {
    const target = this.machines.get(machineId);
    if (!target) throw new Error('Không biết máy này.');
    if (target.online) throw new Error(`Máy ${target.alias || target.name} đang bật.`);
    if (!target.wake?.length) {
      throw new Error(`Trạm chưa biết card mạng của máy ${target.alias || target.name}: máy đó cần nối trạm ít nhất một lần bằng bản Orbit Remote mới.`);
    }
    const online = [...this.machines.values()].filter((m) => m.online && m.rpc);
    const near = online.filter((m) => m.wake?.some((mine) => target.wake.some((t) => sameSubnet(mine, t))));
    const senders = near.length ? near : online.filter((m) => m.local);
    if (!senders.length) throw new Error('Không có máy nào đang nối trạm để bắn gói bật máy.');
    const sentFrom = [];
    const failed = [];
    await Promise.all(senders.map(async (m) => {
      try {
        for (const t of target.wake) {
          await m.rpc.request({ op: 'wake', mac: t.mac, broadcasts: [t.broadcast, '255.255.255.255'].filter(Boolean) });
        }
        sentFrom.push(m.alias || m.name);
      } catch (err) {
        failed.push(`${m.alias || m.name}: ${err.message}`);
      }
    }));
    if (!sentFrom.length) throw new Error(`Không gửi được gói bật máy: ${failed.join('; ')}`);
    return { sentFrom, sameNetwork: near.length > 0, failed };
  }

  // Nguồn WebSocket mà trang app được phép gọi (CSP connect-src): địa chỉ màn hình mọi máy đã khai.
  screenSources() {
    const out = new Set();
    for (const m of this.machines.values()) {
      for (const host of m.screen?.hosts || []) {
        if (/^[\d.]+$/.test(host)) out.add(`ws://${host}:*`);
      }
    }
    return [...out];
  }

  interrupt(id) {
    return this.sessionRpc(id).request({ op: 'interrupt', id });
  }

  close(id) {
    return this.sessionRpc(id).request({ op: 'close', id });
  }

  answerPermission(id, requestId, decision, by) {
    return this.sessionRpc(id).request({ op: 'permission', id, requestId, decision, by });
  }

  setMode(id, mode) {
    return this.sessionRpc(id).request({ op: 'set_mode', id, mode });
  }

  setModel(id, model) {
    return this.sessionRpc(id).request({ op: 'set_model', id, model });
  }

  rename(id, name) {
    const r = this.record(id);
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) throw new Error('Tên trống.');
    r.snap = { ...r.snap, name: clean, renamed: true };
    this.push('session', this.publicSession(r));
    this.scheduleSave();
    return r.snap;
  }

  async resume(id) {
    const r = this.record(id);
    if (RUNNING.has(r.snap.status)) throw new Error('Phiên vẫn đang chạy.');
    if (this.mover.job(id)?.state === 'running') throw new Error('Phiên đang được chuyển sang máy khác: chờ chuyển xong.');
    if (!r.history && r.buffer.length === 0) await this.loadHistory(r);
    const s = r.snap;
    return this.createSession(s.machineId, {
      id: s.id, name: s.name, cwd: s.cwd, model: s.model, effort: s.effort, remoteControl: Boolean(s.remoteControl?.on),
      permissionMode: s.permissionMode, resume: true, claudeSessionId: s.claudeSessionId, movedFrom: s.movedFrom, remote: s.remote,
    });
  }

  // Bật hay tắt Remote Control của một phiên. Phiên đang chạy: đầu máy bật ngay (chờ Claude Code tới RC_ENABLE_MS,
  // 60 giây). Phiên đã dừng: chỉ ghi lựa chọn, chạy lại thì áp dụng (resume).
  setRemoteControl(id, enabled) {
    const r = this.record(id);
    if (RUNNING.has(r.snap.status)) return this.sessionRpc(id).request({ op: 'set_remote_control', id, enabled: Boolean(enabled) }, 70000);
    r.snap = { ...r.snap, remoteControl: enabled ? { on: true, state: '', url: '', error: '' } : null };
    this.push('session', this.publicSession(r));
    this.scheduleSave();
    return r.snap.remoteControl || { on: false };
  }

  forget(id) {
    const r = this.record(id);
    if (RUNNING.has(r.snap.status)) throw new Error('Đóng phiên trước khi xoá khỏi danh sách.');
    this.groups.dropSession(id);
    this.sessions.delete(id);
    this.push('session_removed', { id });
    this.scheduleSave();
    return true;
  }

  // Nhiệt độ của máy (sensors.mjs): số đo mới nhất, đầu máy chỉ đo khi app còn hỏi.
  async machineTemps(machineId) {
    try {
      return await this.machineRpc(machineId).request({ op: 'temps' });
    } catch (err) {
      if (/không hiểu lệnh/.test(err.message)) throw new Error('Máy này cần setup bản Orbit Remote mới để đo nhiệt độ.');
      throw err;
    }
  }

  // Thư mục con của `path` trên máy đó (trống: các chỗ bắt đầu và ổ đĩa), cho nút "Duyệt" khi mở phiên.
  async machineDirs(machineId, path) {
    try {
      return await this.machineRpc(machineId).request({ op: 'dirs', path: String(path || '').slice(0, 1000) });
    } catch (err) {
      if (/không hiểu lệnh/.test(err.message)) throw new Error('Máy này cần setup bản Orbit Remote mới để duyệt thư mục.');
      throw err;
    }
  }

  transcripts(machineId) {
    // 100 phiên mới nhất: danh sách phiên của máy hiện cả phiên cũ (đã đóng) trên máy.
    return this.machineRpc(machineId).request({ op: 'transcripts', limit: 100 });
  }

  // Mức dùng Claude (usage.mjs) của mọi tài khoản đăng nhập trên các máy đang bật: hỏi song song mọi máy,
  // gộp theo tài khoản (nhiều máy cùng một tài khoản là một dòng), mỗi tài khoản lấy kết quả mới nhất.
  // Máy chưa đăng nhập Claude hay đầu máy bản cũ (chưa có lệnh này) thì bỏ qua; lỗi khác chỉ báo khi
  // tài khoản của máy đó không lấy được từ máy nào khác. Mỗi tài khoản kèm số token Claude Code từng máy đã
  // dùng trong tuần và số ước còn lại (token-book.mjs), tính cả máy đang tắt bằng số nó báo lần cuối.
  async usage() {
    const online = [...this.machines.values()].filter((m) => m.online && m.rpc);
    const answers = await Promise.all(online.map((m) => m.rpc.request({ op: 'usage' })
      .then((r) => ({ m, r }), (err) => ({ m, r: { error: err.message, reason: 'rpc' } }))));
    const accounts = new Map();
    const failed = [];
    const noLogin = []; // máy chưa đăng nhập Claude Code bằng tài khoản Claude: app gợi ý đăng nhập (claude-login.js)
    for (const { m, r } of answers) {
      const name = m.alias || m.name;
      if (r?.tokens && !r.tokens.error && r.account?.id) this.tokenBook.record(m.id, name, { accountId: r.account.id, tokens: r.tokens });
      if (Array.isArray(r?.limits)) {
        const key = r.account?.id || `machine:${m.id}`;
        const prev = accounts.get(key);
        const machines = [...(prev?.machines || []), name];
        accounts.set(key, !prev || String(r.at || '') > String(prev.at || '') ? { ...r, machines } : { ...prev, machines });
      } else if (r?.reason === 'nologin') {
        noLogin.push({ machine: name, machineId: m.id });
      } else if (!/không hiểu lệnh/.test(String(r?.error || ''))) {
        failed.push({ machine: name, machineId: m.id, reason: String(r?.reason || ''), accountId: r?.account?.id || '', error: String(r?.error || 'Không rõ lỗi.') });
      }
    }
    const problems = failed.filter((f) => !f.accountId || !accounts.has(f.accountId)).map(({ machine, machineId, reason, error }) => ({ machine, machineId, reason, error }));
    const machineInfo = (id) => {
      const m = this.machines.get(id);
      return m ? { name: m.alias || m.name, online: m.online } : null;
    };
    return {
      accounts: [...accounts.values()].map((a) => ({
        label: a.account?.label || '', plan: a.plan || '', machines: a.machines, limits: a.limits, at: a.at,
        tokens: a.account?.id ? this.tokenBook.summary(a.account.id, a.week, machineInfo) : null,
      })),
      problems,
      noLogin,
    };
  }

  async openTranscript(machineId, { claudeSessionId, cwd, fork, name, model, effort, permissionMode, remoteControl, groupId, role }) {
    if (!/^[0-9a-f-]{36}$/i.test(String(claudeSessionId || ''))) throw new Error('Mã phiên không hợp lệ.');
    const { events } = await this.machineRpc(machineId).request({ op: 'history', claudeSessionId, max: 400 });
    return this.createSession(machineId, {
      name: name || 'Phiên mở lại', cwd, resume: true, fork: Boolean(fork), claudeSessionId,
      model, effort, permissionMode, remoteControl, history: events, groupId, role,
    });
  }

  // Lịch sử của một phiên bất kỳ trên máy (kể cả phiên đang mở ngoài app), chỉ để xem.
  machineHistory(machineId, claudeSessionId, sinceMtime = 0) {
    if (!/^[0-9a-f-]{36}$/i.test(String(claudeSessionId || ''))) throw new Error('Mã phiên không hợp lệ.');
    return this.machineRpc(machineId).request({ op: 'history', claudeSessionId, max: 300, sinceMtime });
  }

  renameMachine(machineId, alias) {
    const m = this.machines.get(machineId);
    if (!m) throw new Error('Không biết máy này.');
    m.alias = String(alias || '').trim().slice(0, 40) || undefined;
    const display = m.alias || m.name;
    for (const r of this.sessions.values()) {
      if (r.snap.machineId !== machineId) continue;
      r.snap = { ...r.snap, machine: display };
      this.push('session', this.publicSession(r));
    }
    this.push('machine', this.publicMachine(m));
    this.scheduleSave();
    return this.publicMachine(m);
  }

  // Quên một máy: bỏ khỏi danh sách cùng mọi phiên đã dừng của nó. Thẻ của máy do tầng HTTP
  // thu hồi; đầu máy bị từ chối thẻ thì tự nghỉ, không xin nối lại ngay.
  forgetMachine(machineId) {
    const m = this.machines.get(machineId);
    if (!m) throw new Error('Không biết máy này.');
    if (m.local) throw new Error('Đây là máy giữ trạm, không quên được.');
    const running = [...this.sessions.values()].filter((r) => r.snap.machineId === machineId && RUNNING.has(r.snap.status));
    if (running.length && m.online) throw new Error(`Máy còn ${running.length} phiên đang chạy. Đóng các phiên đó trước.`);
    m.link?.close?.();
    this.machines.delete(machineId);
    for (const [id, r] of this.sessions) {
      if (r.snap.machineId !== machineId) continue;
      this.sessions.delete(id);
      this.push('session_removed', { id });
    }
    this.push('machine_removed', { id: machineId });
    this.scheduleSave();
    return true;
  }

  async loadHistory(r) {
    const m = this.machines.get(r.snap.machineId);
    if (!m?.online || !r.snap.claudeSessionId) return;
    try {
      let { events } = await m.rpc.request({ op: 'history', claudeSessionId: r.snap.claudeSessionId, max: 400 });
      // Phần đã có trong bộ đệm sống thì không lấy lại từ nhật ký, kẻo hiện hai lần.
      const firstLive = r.buffer[0]?.at;
      if (firstLive) events = events.filter((e) => !e.at || e.at < firstLive);
      r.history = events;
    } catch {
      r.history = null;
    }
  }

  async events(id, after = 0) {
    const r = this.record(id);
    if (!r.history) await this.loadHistory(r);
    return {
      session: r.snap,
      history: after > 0 ? [] : r.history || [],
      events: r.buffer.filter((e) => e.seq > after),
    };
  }
}
