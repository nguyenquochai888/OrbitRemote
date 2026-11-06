// Kho trạng thái của app và luồng sự kiện từ trạm.
//
// Mọi màn hình đọc từ đây và nghe `store.on(...)` để vá đúng phần DOM cần đổi, không vẽ
// lại cả trang. Mẩu chữ đang chảy (delta) chỉ cộng dồn vào một chuỗi; tới khi khối chữ
// hoàn chỉnh tới thì chuỗi đó bị thay thế, nên không có gì phình ra theo thời gian.

import { api } from './api.js';

const LOG_MAX = 1200;

// Lịch tắt máy: trạm gửi số mili giây còn lại (đồng hồ máy tính có thể lệch xa đồng hồ điện thoại),
// app đổi ra giờ tắt theo đồng hồ của chính điện thoại ngay lúc nhận.
function localPower(m) {
  if (Number.isFinite(m?.power?.leftMs)) m.power = { ...m.power, at: Date.now() + m.power.leftMs };
  return m;
}

class Store {
  constructor() {
    this.listeners = new Map();
    this.me = null;
    this.version = '';
    this.machines = new Map();
    this.sessions = new Map();
    this.channel = [];
    this.recents = {};
    this.enrollments = []; // máy mới đang xin nối, chờ người dùng duyệt
    this.groups = new Map(); // nhóm phiên cùng làm một mục tiêu (src/groups.mjs)
    this.hub = {}; // mã, tên và các địa chỉ của trạm
    this.logs = new Map(); // id -> { history, events, lastSeq, live, loading }
    this.actions = [];
    this.tokens = []; // [{ token, arg, hint }]
    this.tokensError = ''; // vì sao chưa có danh sách token (hiện trong danh sách Lệnh nhanh)
    this.models = null; // bản mới nhất của từng dòng model trên trạm (/api/models, lib/models.js)
    this.connected = false;
    this.source = null;
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type, payload) {
    for (const fn of this.listeners.get(type) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(err);
      }
    }
  }

  applyState(state) {
    this.machines = new Map((state.machines || []).map((m) => [m.id, localPower(m)]));
    this.sessions = new Map((state.sessions || []).map((s) => [s.id, s]));
    this.channel = state.channel || [];
    this.recents = state.recents || {};
    this.enrollments = state.enrollments || [];
    this.groups = new Map((state.groups || []).map((g) => [g.id, g]));
    if (state.hub) this.hub = state.hub;
    if (state.me) this.me = state.me;
    if (state.version) this.version = state.version;
    this.emit('state');
    // Nối lại sau khi rớt mạng: lấy bù những sự kiện bị lỡ của các phiên đang mở.
    for (const id of this.logs.keys()) this.syncLog(id);
  }

  connect() {
    this.source?.close();
    const source = new EventSource('/api/stream');
    this.source = source;
    source.onopen = () => this.setConnected(true);
    source.onerror = () => {
      this.setConnected(false);
      // Thẻ bị thu hồi thì EventSource cứ nối lại mãi; hỏi trạm một lần để biết thật.
      api.get('/api/ping').then((p) => {
        if (p && !p.paired) window.dispatchEvent(new CustomEvent('orbit:unpaired'));
      }).catch(() => {});
    };
    const on = (type, fn) => source.addEventListener(type, (e) => fn(JSON.parse(e.data)));
    on('state', (s) => this.applyState(s));
    on('machine', (m) => {
      this.machines.set(m.id, localPower(m));
      this.emit('machine', m);
    });
    on('machine_removed', ({ id }) => {
      this.machines.delete(id);
      this.emit('machine_removed', id);
    });
    on('enrollments', (list) => {
      this.enrollments = list || [];
      this.emit('enrollments', this.enrollments);
    });
    on('session', (s) => {
      this.sessions.set(s.id, s);
      this.emit('session', s);
    });
    on('session_removed', ({ id }) => {
      this.sessions.delete(id);
      this.logs.delete(id);
      this.emit('session_removed', id);
    });
    on('event', ({ id, ev }) => this.onEvent(id, ev));
    on('delta', ({ id, text }) => {
      const log = this.logs.get(id);
      if (!log) return;
      log.live += text;
      this.emit('delta', { id, live: log.live });
    });
    on('channel', (entry) => {
      this.channel.push(entry);
      if (this.channel.length > 300) this.channel.shift();
      this.emit('channel', entry);
    });
    on('custom', () => this.loadActions());
    on('move', (ev) => this.emit('move', ev)); // tiến độ chuyển phiên sang máy khác (views/move.js)
    on('models', (m) => { this.models = m; this.emit('models', m); }); // vừa cập nhật bản model (lib/models.js)
    on('group', (g) => {
      this.groups.set(g.id, g);
      this.emit('group', g);
    });
    on('group_removed', ({ id }) => {
      this.groups.delete(id);
      this.emit('group_removed', id);
    });
  }

  setConnected(value) {
    if (this.connected === value) return;
    this.connected = value;
    this.emit('connection', value);
  }

  onEvent(id, ev) {
    this.emit('any-event', { id, ev });
    const log = this.logs.get(id);
    if (!log || log.loading) return;
    if (ev.seq !== log.lastSeq + 1) {
      // Lỡ mất một đoạn (rớt mạng giữa chừng): lấy bù từ trạm thay vì vẽ thiếu.
      this.syncLog(id);
      return;
    }
    this.pushEvent(id, log, ev);
  }

  pushEvent(id, log, ev) {
    log.lastSeq = ev.seq;
    log.events.push(ev);
    if (log.events.length > LOG_MAX) log.events.shift();
    if (ev.t === 'text' || ev.t === 'result' || ev.t === 'error') log.live = '';
    this.emit('event', { id, ev });
  }

  // `notify`: báo cho màn đang mở vẽ lại từ đầu. Lần mở bình thường thì không cần, vì
  // người gọi tự vẽ khi promise xong; chỉ lần tải lại do lỡ quá nhiều sự kiện mới cần.
  async openLog(id, notify = false) {
    const have = this.logs.get(id);
    if (have) {
      // Lần mở trước còn đang tải (màn vừa dựng lại: đổi bố cục, bật tắt phiên nổi): chờ đúng lần tải đó. Trả ngay
      // nhật ký rỗng thì màn vẽ ra "chưa có gì" rồi không vẽ lại nữa (đã gặp khi kiểm phiên nổi).
      if (have.ready) await have.ready;
      this.syncLog(id);
      return have;
    }
    const log = { history: [], events: [], lastSeq: 0, live: '', loading: true, ready: null };
    this.logs.set(id, log);
    log.ready = api.get(`/api/sessions/${id}/events`).then((data) => {
      log.history = data.history || [];
      log.events = data.events || [];
      log.lastSeq = log.events.length ? log.events[log.events.length - 1].seq : 0;
      if (data.session) this.sessions.set(id, data.session);
    }, (err) => {
      // Tải hỏng: bỏ nhật ký rỗng này, lần mở sau tải lại chứ không dùng mãi bản rỗng.
      if (this.logs.get(id) === log) this.logs.delete(id);
      throw err;
    }).finally(() => {
      log.loading = false;
      log.ready = null;
    });
    await log.ready;
    if (notify) this.emit('log-loaded', id);
    return log;
  }

  async syncLog(id) {
    const log = this.logs.get(id);
    if (!log || log.loading) return;
    log.loading = true;
    try {
      const data = await api.get(`/api/sessions/${id}/events?after=${log.lastSeq}`);
      log.loading = false;
      const fresh = (data.events || []).filter((e) => e.seq > log.lastSeq);
      // Bộ đệm trên trạm đã trôi qua chỗ mình đang đứng: tải lại từ đầu cho chắc.
      if (fresh.length && fresh[0].seq !== log.lastSeq + 1) {
        this.logs.delete(id);
        await this.openLog(id, true);
        return;
      }
      for (const ev of fresh) this.pushEvent(id, log, ev);
    } catch {
      log.loading = false;
    }
  }

  closeLog(id) {
    // Giữ lại nhật ký của vài phiên gần nhất cho lần mở sau được tức thì; bỏ phần còn lại.
    if (this.logs.size > 6) {
      const first = this.logs.keys().next().value;
      if (first !== id) this.logs.delete(first);
    }
  }

  // Token trong bảng token (custom/tokens.md) của máy giữ trạm. Không lấy được thì danh sách rỗng.
  async loadTokens() {
    try {
      const data = await api.get('/api/tokens');
      this.tokens = Array.isArray(data?.tokens) ? data.tokens : [];
      this.tokensError = '';
    } catch (err) {
      this.tokens = [];
      // Trạm bản cũ chưa có đường này (404) thì nói rõ cách sửa, để không tưởng là app thiếu token.
      this.tokensError = err.status === 404 ? 'Trạm đang chạy bản cũ chưa có danh sách token: khởi động lại trạm.' : 'Chưa tải được danh sách token từ trạm.';
    }
    this.emit('tokens', this.tokens);
  }

  // Bản mới nhất của từng dòng model (trạm tự hỏi máy chủ Anthropic, src/models.mjs). Trạm bản cũ thì giữ null:
  // ô chọn model hiện tên dòng không kèm số bản.
  async loadModels() {
    try {
      this.models = await api.get('/api/models');
    } catch {
      this.models = null;
    }
    this.emit('models', this.models);
  }

  async loadActions() {
    try {
      const res = await fetch('/custom/actions.json', { cache: 'no-store' });
      const data = res.ok ? await res.json() : { actions: [] };
      this.actions = Array.isArray(data.actions) ? data.actions : [];
    } catch {
      this.actions = [];
    }
    this.emit('actions', this.actions);
  }

  // Nhóm đang chứa phiên này (mỗi phiên ở nhiều nhất một nhóm), hay null.
  groupOf(sessionId) {
    for (const g of this.groups.values()) if (g.members.some((m) => m.id === sessionId)) return g;
    return null;
  }

  // Token làm được vai trò trong nhóm: token nhận thêm nội dung ($code [yêu cầu]), không phải lệnh chạy
  // thẳng. Cùng quy tắc với roleTokens() của trạm.
  roleTokens() {
    return this.tokens.filter((t) => t.arg).map((t) => ({ role: t.token.slice(1), hint: t.hint }));
  }

  runningSessions() {
    return [...this.sessions.values()].filter((s) => ['starting', 'idle', 'busy', 'waiting'].includes(s.status));
  }
}

export const store = new Store();
