// Đầu máy: giữ các phiên Claude của MỘT máy và nghe lệnh từ trạm.
//
// Mỗi máy chạy đúng một đầu máy. Máy giữ trạm thì đầu máy nằm chung tiến trình với trạm
// và nói chuyện bằng lời gọi hàm; máy khác thì đầu máy tự đứng, nối về trạm qua mạng
// (xem remote-link.mjs). Đầu máy không cần biết mình đang ở trường hợp nào: nó chỉ có
// một hàm `send` để nói ra, và nhận lệnh qua `handle`.
//
// Đầu máy cũng mở một ống nội bộ cho công cụ MCP của từng phiên (mcp-server.mjs). Phiên
// gọi `orbit_remote_send` thì tin đi: phiên → ống → đầu máy → trạm → đầu máy của máy
// đích → được bơm thẳng vào phiên đích như một lượt mới.

import net from 'node:net';
import { existsSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { ClaudeSession } from './claude-session.mjs';
import { lineSplitter, toLine } from './lines.mjs';
import { MACHINE_NAME, MCP_SERVER, PIPE_PATH, POWER_FILE, SETUP_RESULT_FILE, STATE_DIR, ensureDir, readJson, writeJsonAtomic } from './paths.mjs';
import { spawnMain } from './launch.mjs';
import { localWakeInfo, sendMagicPacket } from './wake.mjs';
import { cancelShutdown, scheduleShutdown } from './power.mjs';
import { Rpc, answer } from './rpc.mjs';
import { ScreenServer, ffmpegCommand } from './screen.mjs';
import { InputHelper } from './input.mjs';
import { controlTimeoutMs, remoteOp } from './remote-ops.mjs';
import { Sensors } from './sensors.mjs';
import { findTranscript, listExternalSessions, listTranscripts, loadHistory } from './transcripts.mjs';
import { forgetUsage, readClaudeUsage } from './usage.mjs';
import { ClaudeLogin, authStatus } from './claude-auth.mjs';
import { TokenCounter, tokenSum } from './claude-tokens.mjs';
import { listDirs } from './dirs.mjs';
import { gitInfo, pullTo, readTranscript, wipPush, writeTranscript } from './move-node.mjs';
import { findToken } from './tokens.mjs';
import { applyTable } from './models.mjs';

const EXTERNAL_SCAN_MS = 20000;
// Máy không có sổ phiên của Claude Code (bản cũ): nhật ký ghi gần hơn mốc này thì coi là đang mở.
const EXTERNAL_WINDOW_MS = 15 * 60 * 1000;
const EXTERNAL_MAX = 20;
const POWER_STALE_MS = 60 * 1000; // lịch tắt quá giờ một phút mà máy vẫn chạy: đã bị huỷ trên máy
const TOKEN_PUSH_MS = 5 * 60 * 1000; // máy tự báo số token Claude Code của tuần lên trạm (khi số đổi)
const WEEK_MS = 7 * 24 * 3600 * 1000;
// Sổ nhật ký chép từ máy khác sang: Claude Code tự xoá nhật ký sau 30 ngày, giữ sổ lâu hơn một chút.
const FOREIGN_KEEP_MS = 35 * 24 * 3600 * 1000;
// Phiên đang làm dở một lượt (đang mở, đang làm, chờ duyệt quyền): tắt đầu máy lúc này là cắt ngang.
const WORKING = new Set(['starting', 'busy', 'waiting']);
// Ảnh gửi thẳng cho Claude trong lượt nhắn; tệp khác đưa đường dẫn để Claude tự đọc. Mọi tệp đều được
// lưu vào thư mục riêng của phiên để app mở lại xem được (lệnh "attachment", đọc từng khúc).
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ATTACH_MAX = 8;
// Một khúc tệp đính kèm gửi về trạm: base64 của nó (~700 KB) vẫn dưới giới hạn 1 MB của một lô tin mà
// trạm bản cũ nhận từ đầu máy (remote-link.mjs chia lô theo dung lượng).
const ATTACH_CHUNK = 512 * 1024;
// Tên tệp đã lưu (prepareAttachments): mốc giờ, gạch nối, tên gốc đã bỏ mọi ký tự đường dẫn. Không có
// dấu gạch chéo nào thì không đi ra ngoài thư mục của phiên được, kể cả tên có "..".
const UPLOAD_FILE = /^[0-9a-z]+-[^\\/:*?"<>|\x00-\x1f]+$/;

export function machineIdentity(stateDir = STATE_DIR) {
  const file = join(stateDir, 'machine.json');
  const saved = readJson(file, null);
  if (saved?.id) return saved;
  const fresh = { id: randomBytes(5).toString('hex') };
  writeJsonAtomic(file, fresh);
  return fresh;
}

const HELD_MAX = 20; // tin giữ lại tối đa cho một phiên; quá thì bỏ tin cũ nhất (vẫn còn trong Kênh)
const HELD_TEXT_MAX = 2000;

// movedFrom: { machine, cwd, at } khi phiên vừa được chuyển sang máy này (session-move.mjs): hội thoại cũ còn
// nhắc đường dẫn của máy cũ, nên dặn rõ chỗ làm việc mới ngay trong lời dặn hệ thống, không tốn lượt nào.
function systemPromptFor(session, machineName, movedFrom = null, remote = null) {
  const moved = movedFrom?.machine
    ? `Phiên này đã được chuyển từ máy ${String(movedFrom.machine).slice(0, 60)} (thư mục ${String(movedFrom.cwd || '').slice(0, 300)}) sang máy ${machineName}, thư mục ${String(session.cwd || '').slice(0, 300)}: mã nguồn đã đồng bộ qua git, đường dẫn của máy cũ trong hội thoại không còn dùng được, mọi việc làm trong thư mục hiện tại.`
    : '';
  return [
    `Phiên này được mở từ Orbit Remote (mã phiên ${session.id}, tên "${session.name}", máy ${machineName}).`,
    'Người dùng có thể đang điều khiển phiên từ điện thoại, nên trả lời gọn và rõ.',
    'Có thể nhắn cho các phiên Claude khác, kể cả phiên ở máy khác, bằng công cụ orbit_remote_send;',
    'xem các phiên đang có bằng orbit_remote_sessions.',
    'Tin từ phiên khác tới thành một lượt bắt đầu bằng "[Orbit Remote]"; chỉ trả lời khi tin đó cần trả lời.',
    'Phiên được chủ dự án xếp vào một nhóm thì xem mục tiêu, thành viên và bảng việc của nhóm bằng orbit_remote_group.',
    moved,
    remoteLine(remote, machineName),
  ].filter(Boolean).join(' ');
}

// Phiên làm việc trên máy khác (người dùng chọn "Làm việc trên máy" khi mở phiên, hub.mjs remoteWork): dự án nằm ở
// máy đó, nên mọi việc với dự án đi qua công cụ orbit_machine_*; Read, Edit, Bash có sẵn chỉ chạm máy chạy phiên.
function remoteLine(remote, machineName) {
  if (!remote?.machine) return '';
  const m = String(remote.machine).slice(0, 60);
  const dir = String(remote.cwd || '').slice(0, 300);
  return `Phiên này chạy trên máy ${machineName} nhưng LÀM VIỆC TRÊN MÁY ${m}: dự án ở ${dir} trên máy ${m}, không có trên máy ${machineName}. `
    + `Mọi việc với dự án dùng công cụ orbit_machine_* với machine: "${m}": orbit_machine_run (cwd: "${dir}") để chạy lệnh, `
    + 'orbit_machine_read, orbit_machine_write, orbit_machine_edit, orbit_machine_find cho tệp, orbit_machine_screen và '
    + 'orbit_machine_input để xem và bấm màn hình, orbit_machine_unity cho Unity. Công cụ Read, Edit, Write, Bash, Glob, Grep '
    + `có sẵn chỉ chạm máy ${machineName} (thư mục làm việc tạm của phiên), không chạm dự án.`;
}

// Tệp đặc tả của token vai trò trong nhóm, theo bảng token custom/tokens.md trên chính máy này: phiên ở dự án
// khác vẫn tìm được đặc tả mà không phải đoán đường dẫn.
function roleSpecLine(role) {
  const name = String(role || '');
  if (!/^[A-Za-z_]\w{0,30}$/.test(name)) return '';
  const file = findToken(name)?.spec || '';
  return file && existsSync(file)
    ? `Tệp đặc tả của token $${name} trên máy này: ${file}`
    : `Máy này chưa có token $${name} trong bảng token (custom/tokens.md) hay chưa có tệp đặc tả của nó: thêm vào bảng token trên máy này, hoặc báo trưởng nhóm.`;
}

export class NodeAgent {
  constructor(options = {}) {
    this.stateDir = options.stateDir || STATE_DIR;
    this.machine = {
      id: options.machineId || machineIdentity(this.stateDir).id,
      name: options.machineName || MACHINE_NAME,
      platform: process.platform,
    };
    this.claudeCommand = options.claudeCommand;
    // Đăng nhập Claude Code trên máy này từ app (claude-auth.mjs); xong thì bỏ số liệu usage của tài khoản cũ.
    this.claudeLogin = new ClaudeLogin(this.claudeCommand, { onDone: () => forgetUsage() });
    this.extraArgs = options.extraArgs || [];
    this.pipePath = options.pipePath || PIPE_PATH;
    this.onYield = options.onYield || null; // đầu máy đứng riêng nhường chỗ khi trạm dựng trên máy này
    this.onShutdown = options.onShutdown || null; // đầu máy đứng riêng tắt theo yêu cầu của bộ cài
    this.sessions = new Map();
    this.out = null;
    this.rpc = new Rpc((m) => this.emitOut(m));
    this.pipeServer = null;
    this.scanTimer = null;
    this.lastExternal = '';
    this.setupFile = options.setupFile || SETUP_RESULT_FILE;
    this.setupMtime = 0;
    // Phép kiểm thay hàm này để không chạy git pull và setup thật.
    this.spawnUpdate = options.spawnUpdate || (() => spawnMain(['update'], 'setup.log'));
    this.sendWake = options.sendWake || ((mac, broadcasts) => sendMagicPacket(mac, broadcasts));
    // Phép kiểm thay hai hàm này để không tắt máy thật.
    this.powerSchedule = options.powerSchedule || ((delaySec) => scheduleShutdown(delaySec));
    this.powerCancel = options.powerCancel || (() => cancelShutdown());
    this.powerFile = options.powerFile || POWER_FILE;
    this.power = undefined; // đọc từ đĩa ở lần đầu cần
    // Xem và điều khiển màn hình (screen.mjs). Chỉ mở cổng khi có người xin vé lần đầu.
    this.screen = options.screen !== undefined ? options.screen : (ScreenServer.supported() ? new ScreenServer() : null);
    this.sensors = options.sensors || new Sensors(); // nhiệt độ máy, chỉ đo khi app đang xem (sensors.mjs)
    // Nhật ký phiên chuyển từ máy khác sang: mã phiên -> { ranges: [[đầu, cuối)], at } các khoảng byte đã được
    // máy khác đếm token (importTranscript), đọc từ đĩa ở lần đầu cần.
    this.foreignFile = join(this.stateDir, 'claude-foreign.json');
    this.foreign = null;
    this.tokens = options.tokens || new TokenCounter({ foreignRanges: (sid) => this.foreignOf(sid) }); // token Claude Code của máy trong tuần usage
    this.weekFile = join(this.stateDir, 'claude-week.json');
    this.week = undefined; // mốc tuần usage gần nhất, đọc từ đĩa ở lần đầu cần
    this.tokenTimer = null;
    this.lastTokens = '';
    this.held = new Map(); // mã phiên -> tin chỉ để báo (người gửi khai needs_action: false), gộp vào lượt kế tiếp của phiên
  }

  // ---- Phiên đang mở ngoài app (VS Code, terminal) --------------------------------
  // Chỉ báo lên trạm khi danh sách đổi, nên quét 20 giây một lần cũng gần như không tốn gì:
  // mỗi lượt là một lần liệt kê thư mục và đọc lại đúng những file vừa được ghi.
  startScanning(intervalMs = EXTERNAL_SCAN_MS) {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => {
      this.scanExternal();
      this.scanSetup();
    }, intervalMs);
    this.scanTimer.unref?.();
    this.tokenTimer = setInterval(() => this.pushTokens(), TOKEN_PUSH_MS);
    this.tokenTimer.unref?.();
  }

  scanExternal(force = false) {
    // Chưa nối được trạm nào thì chẳng có ai để báo: khỏi đọc đĩa.
    if (!this.out) return;
    let list;
    try {
      const managed = new Set([...this.sessions.values()].map((s) => s.claudeSessionId));
      list = listExternalSessions({ exclude: managed, max: EXTERNAL_MAX, windowMs: EXTERNAL_WINDOW_MS });
    } catch {
      return;
    }
    // So theo nội dung, bỏ thời điểm sửa của phiên không còn hoạt động khỏi phép so để
    // một phiên nằm yên không bắn cập nhật mỗi lượt quét.
    const key = JSON.stringify(list.map((t) => [t.claudeSessionId, t.title, t.active, t.active ? '' : t.modified]));
    if (!force && key === this.lastExternal) return;
    this.lastExternal = key;
    this.safeOut({ op: 'external', list });
  }

  // ---- Đường nói ra trạm -----------------------------------------------------
  attach(send) {
    this.out = send;
    this.emitOut({
      op: 'hello',
      machine: this.machine,
      // Cổng và các địa chỉ để điện thoại gọi thẳng tới khi xem màn hình; trạm ghi vào chính
      // sách bảo mật của trang (CSP) để trang được phép mở WebSocket tới đó.
      screen: this.screen ? this.screen.info() : null,
      sessions: [...this.sessions.values()].map((s) => s.snapshot()),
      setup: this.readSetup(),
      // Card mạng của máy: trạm nhớ lại để bật máy này qua mạng lúc nó đã tắt (wake.mjs).
      wake: localWakeInfo(),
      power: this.powerReport(),
    });
    this.scanExternal(true);
    this.lastTokens = '';
    this.pushTokens(); // trạm vừa nối (hay vừa khởi động lại) có ngay số của máy, không đợi lượt 5 phút
  }

  // ---- Token Claude Code của máy này trong tuần usage (claude-tokens.mjs) -------------
  // Máy tự đếm và tự báo lên trạm (lệnh "tokens") mỗi 5 phút khi số đổi, kể cả lúc không ai mở bảng
  // usage, để máy đã tắt vẫn còn số trên trạm. Mốc tuần lấy từ lần hỏi usage gần nhất và lưu xuống đĩa;
  // qua giờ reset thì tự lùi sang tuần kế (tuần usage dài đúng 7 ngày), không phải hỏi máy chủ Claude.
  currentWeek(now = Date.now()) {
    if (this.week === undefined) this.week = readJson(this.weekFile, null);
    const w = this.week;
    let start = Date.parse(w?.startedAt);
    let reset = Date.parse(w?.resetsAt);
    if (!w?.accountId || !(start < reset)) return null;
    while (reset <= now) {
      start = reset;
      reset += WEEK_MS;
    }
    return { accountId: w.accountId, startedAt: new Date(start).toISOString(), resetsAt: new Date(reset).toISOString() };
  }

  rememberWeek(account, week) {
    if (!account?.id || !week?.startedAt || !week?.resetsAt) return;
    const next = { accountId: String(account.id), startedAt: week.startedAt, resetsAt: week.resetsAt };
    const w = this.currentWeek();
    if (w && w.accountId === next.accountId && w.startedAt === next.startedAt && w.resetsAt === next.resetsAt) return;
    this.week = next;
    try {
      writeJsonAtomic(this.weekFile, next);
    } catch {
      // không ghi được đĩa: vẫn nhớ trong bộ nhớ tới lần khởi động sau
    }
  }

  // { accountId, week: { startedAt, resetsAt }, tokens } hay null khi máy chưa từng hỏi được usage.
  async tokenReport() {
    const w = this.currentWeek();
    if (!w) return null;
    const tokens = await this.tokens.count(Date.parse(w.startedAt));
    return { accountId: w.accountId, week: { startedAt: w.startedAt, resetsAt: w.resetsAt }, tokens };
  }

  // Gọi kiểu bắn rồi quên (hẹn giờ, lúc nối trạm): mọi lỗi nuốt ở đây, để lượt sau thử lại.
  async pushTokens() {
    try {
      if (!this.out) return;
      const r = await this.tokenReport();
      if (!r) return;
      const key = `${r.accountId}|${r.tokens.since}|${r.tokens.total.calls}|${tokenSum(r.tokens.total)}`;
      if (key === this.lastTokens) return;
      this.safeOut({ op: 'tokens', ...r });
      this.lastTokens = key;
    } catch {
      // nhật ký đọc lỗi hay đường nối vừa đứt
    }
  }

  foreignOf(claudeSessionId) {
    this.foreign ??= readJson(this.foreignFile, null) || {};
    return this.foreign[claudeSessionId]?.ranges || null;
  }

  // Lệnh "transcript_write" (chuyển phiên, session-move.mjs): nhật ký chép sang nguyên văn, các lần gọi model
  // trong đó máy cũ đã đếm; máy này chỉ đếm phần ghi thêm sau. Phiên từng ở máy này rồi mới đi thì bản mới
  // bắt đầu bằng đúng bản cũ của máy này (nhật ký chỉ ghi nối đuôi): phần đó giữ nguyên như sổ cũ, chỉ phần
  // từ cuối bản cũ tới cuối bản mới là của máy khác. Ghi sổ ngay sau khi đổi tên file, trước mọi lượt đọc của
  // bộ đếm (bộ đếm chỉ chạy tiếp khi có I/O xong, còn đoạn này chạy liền sau trong cùng lượt).
  async importTranscript(message) {
    const old = message.final ? findTranscript(String(message.claudeSessionId || '')) : null;
    let oldSize = 0;
    try {
      oldSize = old ? statSync(old).size : 0;
    } catch {
      oldSize = 0;
    }
    const result = await writeTranscript(message);
    if (!message.final || !result?.file) return result;
    const sid = String(message.claudeSessionId);
    this.foreignOf(sid);
    const ranges = (this.foreign[sid]?.ranges || []).filter(([a]) => a < oldSize).map(([a, b]) => [a, Math.min(b, oldSize)]);
    if (result.written > oldSize) ranges.push([oldSize, result.written]);
    this.foreign[sid] = { ranges, at: new Date().toISOString() };
    const stale = Date.now() - FOREIGN_KEEP_MS;
    for (const [id, f] of Object.entries(this.foreign)) if (!(Date.parse(f?.at) > stale)) delete this.foreign[id];
    try {
      writeJsonAtomic(this.foreignFile, this.foreign);
    } catch {
      // không ghi được đĩa: vẫn nhớ trong bộ nhớ tới lần khởi động sau
    }
    return result;
  }

  // Dụng cụ cho thao tác từ xa (remote-ops.mjs): chuột phím dùng chung bộ điều khiển của khung xem màn hình (máy
  // không xem được màn hình thì dựng riêng), ffmpeg để chụp màn hình, vỏ dòng lệnh của Orbit Unity MCP nếu máy có
  // (đường dẫn tới cli.mjs khai bằng biến môi trường ORBIT_UNITY_MCP_CLI).
  remoteCtx() {
    return {
      input: () => {
        if (this.screen?.input) return this.screen.input;
        if (!InputHelper.supported()) throw new Error('Máy này không điều khiển chuột, phím từ xa được (chỉ Windows).');
        this.remoteInput ||= new InputHelper();
        return this.remoteInput;
      },
      ffmpeg: () => ffmpegCommand(),
      unityCli: () => process.env.ORBIT_UNITY_MCP_CLI || '',
    };
  }

  // Lệnh "usage": mức dùng của tài khoản (usage.mjs) kèm số token máy này đã dùng từ đầu tuần.
  async usageWithTokens() {
    const u = await readClaudeUsage();
    if (!u.limits) return u;
    this.rememberWeek(u.account, u.week);
    let tokens = null;
    try {
      const r = await this.tokenReport();
      if (r && r.accountId === u.account?.id) tokens = r.tokens;
    } catch (err) {
      tokens = { error: err.message };
    }
    return { ...u, tokens };
  }

  // ---- Tắt máy theo lệnh từ app (power.mjs) ---------------------------------------
  // Lịch tắt đang chờ: { action: 'shutdown', at } (ms), lưu xuống đĩa và báo lên trạm để app hiện
  // giờ tắt kèm nút huỷ. Lịch đã quá giờ mà máy vẫn chạy (bị huỷ ngay trên máy) thì bỏ.
  currentPower() {
    const p = this.power === undefined ? readJson(this.powerFile, null) : this.power;
    this.power = p?.at && p.at > Date.now() - POWER_STALE_MS ? p : null;
    return this.power;
  }

  // Báo lên trạm số mili giây còn lại chứ không báo giờ tắt: đồng hồ máy này, máy giữ trạm và điện
  // thoại có thể lệch nhau hàng chục phút (đo thấy máy giữ trạm chậm 10 phút khi dịch vụ giờ của
  // Windows không chạy), còn số còn lại thì không phụ thuộc đồng hồ nào.
  powerReport() {
    const p = this.currentPower();
    return p ? { action: p.action, leftMs: p.at - Date.now() } : null;
  }

  setPower({ action, delaySec }) {
    if (action === 'cancel') {
      this.powerCancel();
      this.power = null;
    } else if (action === 'shutdown') {
      this.power = { action: 'shutdown', at: this.powerSchedule(delaySec), delaySec: Number(delaySec) };
    } else {
      fail('Lệnh tắt máy không hợp lệ.');
    }
    if (this.power) writeJsonAtomic(this.powerFile, this.power);
    else rmSync(this.powerFile, { force: true });
    const report = this.powerReport();
    this.safeOut({ op: 'power', power: report });
    return { power: report };
  }

  // ---- Kết quả setup gần nhất ------------------------------------------------------
  // setup.mjs ghi tệp kết quả sau mỗi bước; đầu máy gửi lên trạm lúc chào và mỗi khi tệp đổi (xem
  // trong lượt quét định kỳ), để màn của máy trên app hiện kết quả lệnh "Setup máy".
  readSetup() {
    try {
      this.setupMtime = statSync(this.setupFile).mtimeMs;
    } catch {
      this.setupMtime = 0;
      return null;
    }
    return readJson(this.setupFile, null);
  }

  scanSetup() {
    if (!this.out) return;
    let mtime = 0;
    try {
      mtime = statSync(this.setupFile).mtimeMs;
    } catch {
      return;
    }
    if (mtime === this.setupMtime) return;
    this.safeOut({ op: 'setup', result: this.readSetup() });
  }

  detach() {
    this.out = null;
    this.rpc.failAll('Mất kết nối tới trạm.');
  }

  emitOut(message) {
    if (!this.out) throw new Error('Chưa nối được tới trạm.');
    this.out(message);
  }

  safeOut(message) {
    if (this.out) this.out(message);
  }

  // ---- Lệnh từ trạm ----------------------------------------------------------
  handle(message) {
    if (this.rpc.handleReply(message)) return;
    const reply = (fn) => answer((m) => this.safeOut(m), message, fn);
    switch (message.op) {
      case 'create':
        return reply(() => this.create(message.spec));
      case 'send':
        return reply(() => {
          const s = this.mustGet(message.id);
          return this.sendWithHeld(s, message.text, message.from || null, this.prepareAttachments(s, message.attachments), Array.isArray(message.mentions) ? message.mentions : null)
            || fail('Phiên không nhận tin (có thể đã dừng).');
        });
      case 'set_effort':
        return reply(() => this.mustGet(message.id).setEffort(message.effort));
      case 'set_remote_control':
        return reply(() => this.mustGet(message.id).setRemoteControl(message.enabled));
      case 'attachment':
        return reply(() => this.readAttachment(message.id, message.file, message.offset));
      case 'session_file':
        return reply(() => this.readSessionFile(message.path, message.offset, message.head));
      case 'screen_ticket':
        return reply(() => (this.screen ? this.screen.ticket() : fail('Máy này chưa xem được màn hình (hiện chỉ làm cho Windows).')));
      case 'deliver':
        return reply(() => this.deliver(message));
      case 'interrupt':
        return reply(() => this.mustGet(message.id).interrupt());
      case 'close':
        return reply(() => {
          const s = this.sessions.get(message.id);
          if (s) s.close();
          return true;
        });
      case 'permission':
        return reply(() => this.mustGet(message.id).answerPermission(message.requestId, message.decision, message.by)
          || fail('Yêu cầu quyền này đã được trả lời hoặc đã hết hạn.'));
      case 'set_mode':
        return reply(() => this.mustGet(message.id).setPermissionMode(message.mode));
      case 'models_set':
        // Bảng bản model mới nhất trạm phát xuống (models.mjs): phiên mở sau và hook trên máy này dùng ngay.
        return reply(() => ({ changed: applyTable(message.table) }));
      case 'set_model':
        return reply(() => this.mustGet(message.id).setModel(message.model));
      case 'dirs':
        return reply(() => listDirs(String(message.path || '').slice(0, 1000))); // duyệt thư mục làm việc (dirs.mjs)
      case 'transcripts':
        return reply(() => {
          const list = listTranscripts(message.limit || 40);
          // Trên Windows "d:\Project" và "D:\Project" là một thư mục; nhật ký ghi lẫn cả hai.
          const seen = new Set();
          const dirs = [];
          for (const { cwd } of list) {
            const key = process.platform === 'win32' ? cwd?.toLowerCase() : cwd;
            if (!cwd || seen.has(key)) continue;
            seen.add(key);
            dirs.push(cwd);
          }
          return { transcripts: list, dirs };
        });
      case 'history':
        return reply(() => loadHistory(message.claudeSessionId, message.max || 400, { sinceMtime: message.sinceMtime || 0 }));
      case 'power':
        return reply(() => this.setPower(message));
      case 'usage':
        return reply(() => this.usageWithTokens()); // mức dùng Claude của tài khoản trên máy này (usage.mjs)
      case 'remote':
        // Một phiên ở máy khác làm việc trên máy này (orbit_machine_*); trạm đã kiểm quyền (hub.mjs machineControl).
        return reply(() => remoteOp(String(message.action || ''), message.args, this.remoteCtx()));
      case 'claude_auth':
        return reply(() => authStatus(this.claudeCommand)); // đang đăng nhập Claude Code bằng tài khoản nào
      case 'claude_login':
        return reply(() => this.claudeLogin.start({ email: message.email }));
      case 'claude_login_code':
        return reply(() => this.claudeLogin.code(String(message.id || ''), message.code));
      case 'claude_login_cancel':
        return reply(() => this.claudeLogin.cancel(String(message.id || '')));
      case 'temps':
        return reply(() => this.sensors.read()); // số đo mới nhất, không chờ; lần hỏi đầu bật bộ đo
      case 'wake':
        // Bắn hộ gói bật máy cho một máy khác cùng mạng với máy này.
        return reply(async () => ({ sent: await this.sendWake(String(message.mac || ''), Array.isArray(message.broadcasts) ? message.broadcasts.slice(0, 4).map(String) : []) }));
      case 'update':
        // Lệnh "Setup máy" bấm từ app: git pull rồi setup tự động, ở tiến trình tách riêng (setup sẽ
        // khởi động lại chính đầu máy này). Kết quả về app qua tệp kết quả setup (scanSetup).
        return reply(() => ({ log: this.spawnUpdate() }));
      // Chuyển phiên sang máy khác (move-node.mjs): trạng thái git, commit tạm rồi đẩy, kéo về, chép nhật ký.
      case 'git_info':
        return reply(() => gitInfo(String(message.cwd || '').slice(0, 1000)));
      case 'move_push':
        return reply(() => wipPush(String(message.cwd || ''), { message: message.message }));
      case 'move_pull':
        return reply(() => pullTo(String(message.cwd || ''), { url: message.url, branch: String(message.branch || ''), head: String(message.head || '') }));
      case 'transcript_read':
        return reply(() => readTranscript(message.claudeSessionId, message.offset));
      case 'transcript_write':
        return reply(() => this.importTranscript(message));
      default:
        return reply(() => fail(`Đầu máy không hiểu lệnh ${message.op}.`));
    }
  }

  mustGet(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Phiên này không chạy trên máy này nữa.');
    return s;
  }

  create(spec) {
    // Phiên làm việc trên máy khác: dự án ở máy đó, Claude Code ở đây chạy trong thư mục làm việc riêng cho máy đó
    // (nhật ký và bộ nhớ dự án của Claude Code không lẫn với dự án thật nào trên máy này).
    if (spec?.remote?.machineId) {
      const safe = String(spec.remote.machineId).replace(/[^\w-]/g, '_').slice(0, 40) || 'remote';
      spec = { ...spec, cwd: ensureDir(join(this.stateDir, 'remote-work', safe)) };
    }
    if (!spec?.cwd) fail('Thiếu thư mục làm việc.');
    let st;
    try {
      st = statSync(spec.cwd);
    } catch {
      fail(`Thư mục không tồn tại trên máy ${this.machine.name}: ${spec.cwd}`);
    }
    if (!st.isDirectory()) fail(`Không phải thư mục: ${spec.cwd}`);
    const existing = this.sessions.get(spec.id);
    if (existing && existing.proc && existing.proc.exitCode === null) fail('Phiên này đang chạy rồi.');

    const id = spec.id || randomBytes(4).toString('hex');
    const mcpConfigPath = join(ensureDir(join(this.stateDir, 'mcp')), `${id}.json`);
    writeJsonAtomic(mcpConfigPath, {
      mcpServers: {
        'orbit-remote': {
          type: 'stdio',
          command: process.execPath,
          args: [MCP_SERVER],
          env: { ORBIT_REMOTE_SESSION: id, ORBIT_REMOTE_PIPE: this.pipePath },
        },
      },
    });

    // Phiên chưa từng có lượt nào thì Claude Code chưa ghi nhật ký: mở lại bằng "--resume" sẽ thoát với lỗi
    // "No conversation found" (gặp khi nhóm phiên mở lại thành viên mới lập để giao việc đầu). Khi đó chạy như
    // phiên mới, giữ nguyên mã phiên.
    const resume = Boolean(spec.resume) && (Boolean(spec.fork) || findTranscript(spec.claudeSessionId) !== null);
    const session = new ClaudeSession({
      ...spec,
      resume,
      id,
      claudeCommand: this.claudeCommand,
      extraArgs: this.extraArgs,
      mcpConfigPath,
    });
    session.appendSystemPrompt = systemPromptFor(session, this.machine.name, spec.movedFrom, spec.remote);
    this.sessions.set(id, session);

    session.on('event', (ev) => this.safeOut({ op: 'event', id, ev }));
    session.on('delta', (text) => this.safeOut({ op: 'delta', id, text }));
    session.on('status', (snap) => this.safeOut({ op: 'status', session: snap }));
    session.on('exit', () => {
      this.held.delete(id); // tin giữ lại vẫn còn trong Kênh của trạm
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      try {
        unlinkSync(mcpConfigPath);
      } catch {
        // đã dọn
      }
    });
    session.start();
    if (spec.prompt) session.send(spec.prompt, spec.from || null);
    return session.snapshot();
  }

  // Tệp đính kèm từ app: [{ name, type, data (base64) }]. Ảnh nhỏ đi thẳng vào lượt nhắn như khi
  // dán ảnh vào Claude; tệp khác được lưu vào thư mục riêng của phiên trên máy này và Claude nhận
  // đường dẫn để tự đọc. Trả về { images, files } cho ClaudeSession.send.
  prepareAttachments(session, list) {
    if (!Array.isArray(list) || !list.length) return null;
    if (list.length > ATTACH_MAX) fail(`Mỗi lượt đính kèm tối đa ${ATTACH_MAX} tệp.`);
    const images = [];
    const files = [];
    let dir = null;
    const stamp = Date.now().toString(36);
    list.forEach((a, i) => {
      const data = Buffer.from(String(a?.data || ''), 'base64');
      if (!data.length) return;
      const type = String(a.type || '').toLowerCase();
      const name = String(a.name || 'tep').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'tep';
      dir ||= ensureDir(join(this.stateDir, 'uploads', session.id));
      const file = `${stamp}${i}-${name}`;
      const path = join(dir, file);
      writeFileSync(path, data);
      if (IMAGE_TYPES.has(type) && data.length <= IMAGE_MAX_BYTES) images.push({ name, type, file, data: data.toString('base64') });
      else files.push({ name, type, file, path });
    });
    return images.length || files.length ? { images, files } : null;
  }

  // Một khúc của tệp đính kèm đã lưu (prepareAttachments), để trạm phát lại cho app xem. Chỉ đọc đúng
  // tên tệp trong thư mục của phiên, không đi ra ngoài được.
  async readAttachment(sessionId, file, offset = 0) {
    const sid = String(sessionId || '');
    const name = String(file || '');
    if (!/^[\w-]{1,64}$/.test(sid) || !UPLOAD_FILE.test(name)) fail('Tên tệp không hợp lệ.');
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    let fh;
    try {
      fh = await openFile(join(this.stateDir, 'uploads', sid, name), 'r');
    } catch {
      fail('Tệp đính kèm không còn trên máy.');
    }
    try {
      const { size } = await fh.stat();
      const length = Math.max(0, Math.min(ATTACH_CHUNK, size - start));
      const buf = Buffer.alloc(length);
      const { bytesRead } = length ? await fh.read(buf, 0, length, start) : { bytesRead: 0 };
      return { size, offset: start, data: buf.subarray(0, bytesRead).toString('base64') };
    } finally {
      await fh.close();
    }
  }

  // Một khúc của một tệp trên máy này mà Claude nhắc tới trong câu trả lời (link file:///, đường dẫn tuyệt đối):
  // { size, mtime, offset, data (base64) }; head: chỉ cỡ và giờ sửa, để trạm trả 304 khi app đã có bản đó. Trạm
  // đã kiểm đường dẫn có trong lời của phiên (hub.mjs readSessionFile). Không đọc đường mạng (\\máy\chia sẻ):
  // mở nó là Windows tự gửi thông tin đăng nhập tới máy kia.
  async readSessionFile(path, offset = 0, head = false) {
    const p = String(path || '');
    if (!p || p.length > 1000 || p.includes('\0') || /^[\\/]{2}/.test(p) || !isAbsolute(p)) fail('Đường dẫn tệp không hợp lệ.');
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    let fh;
    try {
      fh = await openFile(p, 'r');
    } catch {
      fail('Không thấy tệp này trên máy.');
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) fail('Đường dẫn này không phải một tệp.');
      const mtime = Math.round(st.mtimeMs);
      if (head) return { size: st.size, mtime };
      const length = Math.max(0, Math.min(ATTACH_CHUNK, st.size - start));
      const buf = Buffer.alloc(length);
      const { bytesRead } = length ? await fh.read(buf, 0, length, start) : { bytesRead: 0 };
      return { size: st.size, mtime, offset: start, data: buf.subarray(0, bytesRead).toString('base64') };
    } finally {
      await fh.close();
    }
  }

  // group: { id, name } khi tin thuộc một nhóm phiên; không có `from` thì tin do trạm đẩy thay cho chủ
  // dự án (bấm Bắt đầu, đổi mục tiêu...) hay của chính nhóm (label: "Bảng tin dụng cụ", "Ngân sách").
  // role: token vai trò của phiên nhận khi tin là một việc được giao.
  // hold: người gửi khai tin này chỉ để báo (needs_action: false): giữ lại, không mở lượt riêng;
  // tin đi kèm lượt kế tiếp của phiên. Trả { held: true } để trạm biết đầu máy này đã giữ (bản cũ thì giao luôn).
  deliver({ id, from, text, group, role, label, hold }) {
    const s = this.mustGet(id);
    if (hold && from) {
      const list = this.held.get(id) || [];
      list.push({ at: new Date().toISOString(), from, group: group?.name || '', text: String(text).slice(0, HELD_TEXT_MAX) });
      if (list.length > HELD_MAX) list.splice(0, list.length - HELD_MAX);
      this.held.set(id, list);
      return { held: true };
    }
    const where = group?.name ? ` trong nhóm "${group.name}"` : '';
    const tag = String(label || '').slice(0, 40);
    const head = from
      ? `[Orbit Remote] Tin nhắn từ phiên "${from.name}" (máy ${from.machine}, mã ${from.id})${where}:`
      : group?.name && tag ? `[Orbit Remote] ${tag} của nhóm "${group.name}":`
        : group?.name ? `[Orbit Remote] Tin từ chủ dự án qua nhóm "${group.name}":` : '[Orbit Remote] Tin nhắn từ một phiên khác:';
    const spec = role ? roleSpecLine(role) : '';
    // Ghi rõ tên công cụ: đã thấy thật một phiên trả lời bằng SendMessage có sẵn của Claude
    // Code, công cụ đó chỉ tới được phiên cùng máy và không đi qua trạm.
    const body = `${head}\n\n${text}\n\n${spec ? `${spec}\n\n` : ''}`
      + (from ? `Muốn trả lời thì gọi công cụ orbit_remote_send (máy chủ MCP orbit-remote) với to="${from.id}"; `
        + 'không dùng SendMessage, vì nó không tới được phiên ở máy khác.' : '');
    // `raw` là nguyên văn người gửi viết, để app hiện gọn; mô hình thì nhận cả phần hướng dẫn.
    const meta = from
      ? { kind: 'session', ...from, ...(group?.name ? { group: group.name } : {}) }
      : group?.name ? { kind: 'group', name: group.name, groupId: group.id } : { kind: 'session' };
    if (!this.sendWithHeld(s, body, { ...meta, raw: String(text).slice(0, 4000) })) fail('Phiên đích không nhận tin.');
    return true;
  }

  // Gửi một lượt cho phiên, kèm các tin đang giữ lại ở đầu lời nhắn (một lượt cho tất cả). Lệnh của Claude Code
  // ("/compact", "/clear") thì gửi riêng, tin giữ lại chờ lượt sau. Gửi không được thì trả tin lại chỗ giữ.
  sendWithHeld(s, text, from = null, attachments = null, mentions = null) {
    const list = String(text || '').trimStart().startsWith('/') ? null : this.held.get(s.id);
    if (!list?.length) return s.send(text, from, attachments, { mentions });
    this.held.delete(s.id);
    const lines = list.map((x) => `- Từ phiên "${x.from.name}" (máy ${x.from.machine}, mã ${x.from.id})${x.group ? ` trong nhóm "${x.group}"` : ''}, lúc ${x.at}:\n${x.text}`);
    const prefix = `[Orbit Remote] ${list.length} tin từ phiên khác được giữ lại vì người gửi khai là chỉ để báo; đọc qua, cần thì trả lời bằng orbit_remote_send:\n\n${lines.join('\n\n')}`;
    const ok = s.send(text, from, attachments, { prefix, mentions });
    if (!ok) this.held.set(s.id, [...list, ...(this.held.get(s.id) || [])]);
    return ok;
  }

  // ---- Ống nội bộ cho công cụ MCP của từng phiên ------------------------------
  startPipe() {
    if (process.platform !== 'win32') {
      ensureDir(this.stateDir);
      if (existsSync(this.pipePath)) rmSync(this.pipePath, { force: true });
    }
    this.pipeServer = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let sessionId = null;
      const send = (m) => {
        if (!socket.destroyed) socket.write(toLine(m));
      };
      socket.on('data', lineSplitter((m) => {
        if (m.op === 'yield') {
          // Trạm vừa được dựng trên chính máy này và cần ống này: đầu máy đứng riêng rút lui.
          send({ op: 'reply', rid: m.rid, ok: Boolean(this.onYield), data: true, error: 'Đây là đầu máy của trạm, không nhường.' });
          if (this.onYield) setTimeout(() => this.onYield(), 50);
          return;
        }
        if (m.op === 'shutdown') {
          // Bộ cài (setup) khởi động lại đầu máy đứng riêng để nạp code và chương trình mới cài. Phiên mở
          // từ app chạy ngầm dưới đầu máy (không có cửa sổ), tắt đầu máy là đóng chúng. Phiên đang rảnh
          // thì đóng được: hội thoại nằm trong nhật ký của Claude Code, trên app bấm "Chạy lại" là làm
          // tiếp. Phiên đang làm dở một lượt thì từ chối, trừ khi nói rõ force.
          const open = [...this.sessions.values()].filter((s) => !['stopped', 'crashed'].includes(s.status));
          const running = open.filter((s) => WORKING.has(s.status)).length;
          const allowed = Boolean(this.onShutdown) && (!running || Boolean(m.force));
          const error = !this.onShutdown ? 'Đây là đầu máy của trạm: khởi động lại bằng "main.mjs restart".' : `Đầu máy còn ${running} phiên đang làm dở.`;
          const sessions = open.map((s) => ({ name: s.name, status: s.status }));
          send({ op: 'reply', rid: m.rid, ok: allowed, data: { running, sessions }, error });
          if (allowed) setTimeout(() => this.onShutdown(), 50);
          return;
        }
        if (m.op === 'hello') {
          sessionId = String(m.sessionId || '');
          send({ op: 'reply', rid: m.rid, ok: true, data: { machine: this.machine.name } });
          return;
        }
        answer(send, m, async () => {
          if (!sessionId) fail('Công cụ chưa tự giới thiệu.');
          if (m.op === 'send') return this.rpc.request({ op: 'route', from: sessionId, to: m.to, text: m.text, ...(typeof m.needs_action === 'boolean' ? { needsAction: m.needs_action } : {}) });
          if (m.op === 'list') return this.rpc.request({ op: 'query', what: 'sessions', from: sessionId });
          if (m.op === 'group') return this.rpc.request({ op: 'group', from: sessionId, args: m.args && typeof m.args === 'object' ? m.args : {} });
          if (m.op === 'machine') {
            // Công cụ orbit_machine_*: trạm kiểm quyền rồi chuyển tới máy đích; chờ lâu hơn thao tác cần (lệnh dài, Unity).
            const action = String(m.action || '');
            const args = m.args && typeof m.args === 'object' ? m.args : {};
            return this.rpc.request({ op: 'machine', from: sessionId, action, args }, controlTimeoutMs(action, args) + 15000);
          }
          return fail(`Không hiểu lệnh ${m.op}.`);
        });
      }));
      socket.on('error', () => {});
    });
    return new Promise((resolve, reject) => {
      this.pipeServer.once('error', reject);
      this.pipeServer.listen(this.pipePath, () => {
        this.pipeServer.off('error', reject);
        resolve();
      });
    });
  }

  shutdown() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    for (const s of this.sessions.values()) s.close();
    this.pipeServer?.close();
    this.claudeLogin.cancel();
    this.remoteInput?.stop();
    this.screen?.stop();
    this.sensors.stop();
  }
}

function fail(text) {
  throw new Error(text);
}
