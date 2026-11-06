// Nhóm phiên: nhiều phiên cùng làm một mục tiêu do chủ dự án đặt, có một trưởng nhóm.
//
// Trạm giữ nhóm (lưu chung hub.json): tên, mục tiêu, trưởng nhóm, thành viên kèm vai trò, bảng việc
// và trạng thái. Vai trò là một token trong bảng token custom/tokens.md ($code, $qa...): người nhận việc làm theo đúng
// đặc tả của token đó, nên chủ dự án chỉ cần đặt mục tiêu, gán vai trò và bấm Bắt đầu.
//
// Trạm không tự nghĩ thay Claude. Nó chỉ mở, dừng phiên và đẩy tin vào đúng phiên ở đúng bước:
//   - chủ dự án bấm Bắt đầu: chỉ trưởng nhóm chạy và nhận mục tiêu, thành viên, cách điều phối; thành viên dừng;
//   - trưởng nhóm giao việc hay trả lại việc: phiên được giao mở lại (đúng model trưởng nhóm chọn) và nhận việc
//     kèm token vai trò; đang bận việc khác thì việc vào hàng chờ của phiên đó;
//   - thành viên báo xong hay bị chặn: trưởng nhóm nhận tin (chính là bàn giao); hàng chờ còn việc thì trạm giao
//     việc kế, hết việc thì phiên dừng khi lượt đó kết thúc;
//   - bảng tin dụng cụ dùng chung: dụng cụ trống ra thì người chờ đầu tiên được đăng ký và báo một lần.
// Mỗi tin đẩy vào là một lượt Claude (tốn token), nên trạm không đẩy ở mọi lần sửa bảng việc; chi phí của
// từng phiên được cộng dồn để trưởng nhóm và chủ dự án theo dõi, có ngân sách và cảnh báo.

import { randomBytes } from 'node:crypto';
import { listTokens } from './tokens.mjs';

const RUNNING = new Set(['starting', 'idle', 'busy', 'waiting']);
const GROUPS_MAX = 40;
const TASKS_MAX = 200;
const NAME_MAX = 60;
const GOAL_MAX = 4000;
const TITLE_MAX = 160;
const DETAIL_MAX = 4000;
const NOTE_MAX = 4000;
// Thêm phiên vào nhóm đang chạy rồi chọn vai trò ngay sau đó là hai thay đổi liền nhau: gom lại, chờ yên
// chừng này rồi mới báo trưởng nhóm một lần, kèm vai trò cuối cùng (mỗi tin là một lượt Claude).
const MEMBER_NOTICE_MS = 8000;
// queued: đã giao nhưng người làm còn đang làm việc khác; tới lượt thì trạm tự giao (mỗi thành viên một việc một lúc).
const STATUSES = new Set(['todo', 'queued', 'doing', 'review', 'blocked', 'done']);
const MEMBER_STATUSES = new Set(['doing', 'review', 'blocked']);
const MODELS = new Set(['', 'haiku', 'sonnet', 'opus']);
const EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max']);
// Bảng tin dụng cụ dùng chung: thời gian đăng ký mặc định và tối đa (phút).
const TOOL_MINUTES = 30;
const TOOL_MINUTES_MAX = 8 * 60;
const TOOLS_MAX = 40;
// Ngữ cảnh: token đầu vào của mỗi lần gọi model (đo từ usage của Claude Code; phiên mới đã khoảng 35k cho lời dặn
// hệ thống, công cụ, CLAUDE.md). Mỗi lượt đọc lại toàn bộ ngữ cảnh, mở lại phiên thì ghi lại cả vào cache, nên ngữ
// cảnh càng lớn mọi lượt sau càng đắt. Thành viên nhận việc mới mà ngữ cảnh quá MEMBER_FRESH_TOKENS thì được xoá
// sạch rồi mới nhận việc; trưởng nhóm quá LEADER_COMPACT_TOKENS thì trạm tự nén lúc nó rảnh, mỗi phiên không quá
// một lần trong COMPACT_GAP_MS (nén hỏng mà số không giảm thì khỏi nén lặp).
const MEMBER_FRESH_TOKENS = 80000;
const LEADER_COMPACT_TOKENS = 120000;
const COMPACT_GAP_MS = 10 * 60 * 1000;
const LEADER_FOCUS = 'Giữ lại: mục tiêu và mọi lời dặn của chủ dự án, kế hoạch, các quyết định kèm lý do, tình trạng từng việc (ai làm, tới đâu, còn thiếu gì), việc chờ nghiệm thu, dụng cụ đang giữ, chi phí và ngân sách. Bỏ: nội dung file, log, kết quả công cụ đã xử lý xong.';
const MEMBER_FOCUS = 'Giữ lại: việc đang làm và tiêu chí xong, những gì đã làm và đã kiểm, file đã đụng, phần còn dở và bước kế tiếp, điều trưởng nhóm dặn. Bỏ: nội dung file, log, kết quả công cụ đã xử lý xong.';
// Bản bộ action của vỏ MCP (SHELL_VERSION trong mcp-server.mjs). Vỏ cũ không gửi số này.
const SHELL_VERSION = 2;
const OLD_SHELL = 'Công cụ orbit_remote_group của phiên này là bản cũ: máy chạy phiên chưa cập nhật Orbit Remote (hay phiên mở từ trước khi cập nhật), nên công cụ thiếu các action tools, claim_tool, release_tool, compact, reset và tham số model, effort. Báo chủ dự án bấm "Setup máy" cho máy đó trên app rồi chạy lại phiên này.';
const SESSION_STATUS = {
  starting: 'đang mở', idle: 'sẵn sàng', busy: 'đang làm', waiting: 'chờ duyệt quyền', stopped: 'đã dừng', crashed: 'hỏng',
};

const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const now = () => new Date().toISOString();
const hhmm = (iso) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;

// Bảng tin dụng cụ dùng chung: thay cho việc nhắn từng phiên để hỏi ai đang dùng.
const TOOL_RULES = 'Dụng cụ chỉ một phiên dùng được một lúc (Unity Editor, Blender, trình duyệt tự động, thiết bị chạy thử...): xem bảng tin bằng orbit_remote_group action "tools"; trống thì đăng ký bằng "claim_tool" (tool là tên dụng cụ kèm dự án, minutes là thời gian dự kiến); đang có phiên khác dùng thì claim_tool tự xếp bạn vào hàng chờ, dụng cụ trống là bạn nhận tin và được đăng ký luôn, nên trong lúc chờ làm việc khác hay kết thúc lượt, không gọi lại để hỏi. Dùng xong gọi "release_tool" ngay. Không nhắn từng phiên để hỏi dụng cụ.';

// Luật giữ ngữ cảnh gọn: gửi cho trưởng nhóm và thành viên.
const CONTEXT_RULES = [
  'Ngữ cảnh: mỗi lượt Claude đọc lại toàn bộ ngữ cảnh, nên ngữ cảnh lớn làm mọi lượt sau đắt lên. Giữ gọn: đọc file lớn theo đoạn cần, không in log hay kết quả dài khi không cần, không chép lại thứ đã có trên bảng việc. Cỡ ngữ cảnh từng phiên xem bằng action "view" (context).',
  `Trạm tự lo phần lớn: thành viên nhận việc mới mà ngữ cảnh trên ${MEMBER_FRESH_TOKENS / 1000}k token thì được xoá sạch rồi mới nhận việc (lời giao mang đủ mục tiêu, luật và ghi chú của việc); trưởng nhóm trên ${LEADER_COMPACT_TOKENS / 1000}k token thì trạm tự nén lúc rảnh.`,
  'Chủ động khi cần: ngữ cảnh đã lớn mà việc còn dài thì gọi action "compact" (focus: điều cần giữ; then: việc làm tiếp sau khi nén) để Claude Code tóm tắt hội thoại. Xong một mạch việc mà bảng việc và ghi chú đã đủ tình hình thì gọi action "reset" (note: điều phải nhớ, việc dở, bước kế tiếp) để xoá sạch và bắt đầu lại chỉ với ghi chú đó cùng lời giao mục tiêu: rẻ hơn nén. Gọi xong thì kết thúc lượt ngay, trạm làm khi lượt kết thúc. Không reset khi phần dở chưa được ghi lại.',
].join('\n');

// Luật tiết kiệm token của thành viên: gửi kèm lần giao việc đầu tiên.
const MEMBER_RULES = [
  'Cách làm trong nhóm: chỉ làm phần việc được giao; không sửa file mà thành viên khác đang làm. Xem mục tiêu, thành viên và bảng việc bằng orbit_remote_group (action "view").',
  'Tiết kiệm token mà không giảm chất lượng: chỉ đọc đúng file cần cho việc này, không dò cả dự án; không đọc lại thứ đã đọc; trả lời và ghi note gọn mà đủ ý; chỉ nhắn khi người nhận cần biết để làm việc; xong việc thì báo một lần. Không bỏ bước kiểm của việc để tiết kiệm.',
  CONTEXT_RULES,
  TOOL_RULES,
].join('\n\n');

function fail(text) {
  throw new Error(text);
}

// Token làm được vai trò: token nhận thêm nội dung sau nó ($code [yêu cầu]), không phải lệnh chạy
// thẳng. Danh sách đọc từ bảng token custom/tokens.md trên máy giữ trạm (tokens.mjs).
export function roleTokens() {
  return listTokens().filter((t) => t.arg).map((t) => ({ role: t.token.slice(1), hint: t.hint }));
}

// '' là chưa có vai trò. Nhận cả "$code" lẫn "code", không phân biệt hoa thường; trả tên đúng như
// trong bảng token ("UI" chứ không phải "ui").
export function cleanRole(value) {
  const raw = String(value ?? '').trim().replace(/^\$/, '');
  if (!raw) return '';
  const known = roleTokens();
  if (!known.length) fail('Bảng token (custom/tokens.md) trên máy giữ trạm chưa có token nào nhận yêu cầu, nên chưa có vai trò nào để gán.');
  const hit = known.find((t) => t.role.toLowerCase() === raw.toLowerCase());
  if (!hit) fail(`Không có token $${raw} để làm vai trò. Vai trò là một token nhận yêu cầu trong custom/tokens.md: ${known.map((t) => `$${t.role}`).join(', ')}.`);
  return hit.role;
}

function normalize(g) {
  const members = [];
  for (const m of Array.isArray(g.members) ? g.members : []) {
    const id = typeof m === 'string' ? m : m?.id;
    if (id && !members.some((x) => x.id === id)) members.push({ id: String(id), role: String(m?.role || '') });
  }
  const leaderId = members.some((m) => m.id === g.leaderId) ? g.leaderId : members[0]?.id || '';
  const tasks = Array.isArray(g.tasks) ? g.tasks.slice(0, TASKS_MAX) : [];
  // Mỗi thành viên làm một việc một lúc. Nhóm lập từ bản trước có thể còn nhiều việc "doing" của một người (đã gặp
  // thật: việc giao thêm cứ vào hàng chờ sau các việc đó mà không ai mở phiên): giữ việc đầu, còn lại vào hàng chờ.
  const doing = new Set();
  for (const t of tasks) {
    if (t?.status !== 'doing' || !t.assignee || t.assignee === leaderId) continue;
    if (!doing.has(t.assignee)) doing.add(t.assignee);
    else Object.assign(t, { status: 'queued', pendingKind: t.pendingKind || 'assign' });
  }
  return {
    id: String(g.id),
    name: clip(g.name, NAME_MAX) || 'Nhóm',
    goal: clip(g.goal, GOAL_MAX),
    status: ['draft', 'running', 'paused', 'stopped', 'done'].includes(g.status) ? g.status : 'draft',
    leaderId,
    members,
    tasks,
    nextTask: Number(g.nextTask) || (Array.isArray(g.tasks) ? g.tasks.length + 1 : 1),
    briefed: Array.isArray(g.briefed) ? g.briefed.map(String) : [],
    summary: clip(g.summary, NOTE_MAX),
    createdAt: g.createdAt || now(),
    startedAt: g.startedAt || '',
    finishedAt: g.finishedAt || '',
    pausedAt: g.pausedAt || '',
    interrupted: Array.isArray(g.interrupted) ? g.interrupted.map(String) : [], // phiên bị cắt ngang lúc tạm dừng
    // Bảng tin dụng cụ dùng chung: ai đang giữ dụng cụ nào trên máy nào, và ai đang chờ.
    tools: Array.isArray(g.tools) ? g.tools.slice(0, TOOLS_MAX) : [],
    toolWait: Array.isArray(g.toolWait) ? g.toolWait.slice(0, TOOLS_MAX) : [],
    // Chi phí: cộng dồn theo phiên từ lúc nhóm chạy (USD theo total_cost_usd của Claude Code), ngân sách do chủ dự án đặt.
    cost: g.cost && typeof g.cost === 'object' ? g.cost : {},
    costSeen: g.costSeen && typeof g.costSeen === 'object' ? g.costSeen : {},
    budgetUsd: Number(g.budgetUsd) > 0 ? Number(g.budgetUsd) : 0,
    budgetAlert: Number(g.budgetAlert) || 0, // mức cảnh báo đã gửi trưởng nhóm: 0, 80, 100 (%)
  };
}

const costTotal = (g) => Object.values(g.cost).reduce((n, v) => n + (Number(v) || 0), 0);

// Phần gửi cho app: bỏ các trường chỉ trạm dùng (đếm mã việc, ai đã nhận mục tiêu, mốc chi phí đã thấy).
function publicGroup(g) {
  const { nextTask, briefed, costSeen, ...rest } = g;
  return { ...rest, costTotal: Math.round(costTotal(g) * 10000) / 10000 };
}

export class Groups {
  constructor(hub) {
    this.hub = hub;
    this.map = new Map();
    this.notices = new Map(); // groupId -> { timer, items: Map(sessionId -> 'add' | 'role') }
    this.noticeMs = MEMBER_NOTICE_MS;
    // Thành viên vừa bàn giao xong mà hết việc: đóng phiên khi lượt đang chạy của nó kết thúc (onSessionSnap).
    this.releasing = new Set();
    // Phiên trạm đã ra lệnh đóng mà tiến trình chưa tắt hẳn: giao việc cho nó thì chờ tắt rồi mới mở lại,
    // kẻo tin giao việc rơi vào tiến trình sắp tắt (đã gặp trong phép kiểm: giao việc ngay sau Bắt đầu).
    this.closing = new Set();
    // Nén hay xoá ngữ cảnh đang chờ chạy theo từng phiên (ctxRun), lần trạm nén gần nhất, phiên đã được báo vỏ cũ.
    this.ctx = new Map();
    this.compactAt = new Map();
    this.oldShell = new Set();
  }

  load(list) {
    for (const g of Array.isArray(list) ? list : []) {
      if (g?.id) this.map.set(String(g.id), normalize(g));
    }
  }

  toJSON() {
    return [...this.map.values()];
  }

  list() {
    return [...this.map.values()].map(publicGroup);
  }

  get(id) {
    const g = this.map.get(String(id || ''));
    if (!g) fail('Không có nhóm này.');
    return g;
  }

  // Nhóm có thật: kiểm trước khi mở phiên mới ngay trong nhóm, kẻo phiên mở rồi mới báo lỗi. Nhóm không giới hạn
  // số phiên.
  ensureRoom(id) {
    return this.get(id);
  }

  groupOf(sessionId) {
    for (const g of this.map.values()) if (g.members.some((m) => m.id === sessionId)) return g;
    return null;
  }

  snap(id) {
    return this.hub.sessions.get(id)?.snap || null;
  }

  changed(g) {
    this.hub.push('group', publicGroup(g));
    this.hub.scheduleSave();
    return publicGroup(g);
  }

  // ---- Việc của chủ dự án trên app ---------------------------------------------------
  create({ name, goal } = {}) {
    if (this.map.size >= GROUPS_MAX) fail(`Tối đa ${GROUPS_MAX} nhóm.`);
    const g = normalize({ id: randomBytes(4).toString('hex'), name: clip(name, NAME_MAX) || 'Nhóm mới', goal });
    this.map.set(g.id, g);
    return this.changed(g);
  }

  update(id, { name, goal, budgetUsd } = {}) {
    const g = this.get(id);
    if (name !== undefined) g.name = clip(name, NAME_MAX) || g.name;
    if (budgetUsd !== undefined) {
      const b = Number(budgetUsd);
      if (!Number.isFinite(b) || b < 0 || b > 100000) fail('Ngân sách là số đô từ 0 (không giới hạn) trở lên.');
      g.budgetUsd = Math.round(b * 100) / 100;
      g.budgetAlert = 0; // ngân sách mới: tính lại mốc cảnh báo
      this.checkBudget(g);
    }
    if (goal !== undefined) {
      const next = clip(goal, GOAL_MAX);
      const changedGoal = next !== g.goal;
      g.goal = next;
      if (changedGoal && g.status === 'running' && next) {
        this.notify(g, g.leaderId, null, `Chủ dự án đổi mục tiêu của nhóm "${g.name}" thành:\n\n${next}\n\nXem lại bảng việc (orbit_remote_group, action "view") và điều chỉnh các việc đang giao cho khớp mục tiêu mới.`);
      }
    }
    return this.changed(g);
  }

  remove(id) {
    const g = this.get(id);
    if (g.status === 'running') fail('Nhóm đang chạy: dừng nhóm trước khi xoá.');
    this.dropNotice(g.id);
    this.map.delete(g.id);
    this.hub.push('group_removed', { id: g.id });
    this.hub.scheduleSave();
    return true;
  }

  async addMember(id, sessionId, role) {
    const g = this.get(id);
    if (!this.hub.sessions.has(sessionId)) fail('Không có phiên này.');
    const wanted = role === undefined ? undefined : cleanRole(role);
    if (g.members.some((m) => m.id === sessionId)) {
      return wanted === undefined ? publicGroup(g) : this.setRole(id, sessionId, wanted);
    }
    const other = this.groupOf(sessionId);
    if (other) {
      if (other.status === 'running' && other.leaderId === sessionId) {
        fail(`Phiên này đang là trưởng nhóm "${other.name}" đang chạy: dừng nhóm đó hay đổi trưởng nhóm trước.`);
      }
      this.removeMember(other.id, sessionId);
    }
    g.members.push({ id: sessionId, role: wanted || '' });
    if (!g.leaderId) g.leaderId = sessionId;
    if (g.status === 'running' && sessionId !== g.leaderId) this.queueNotice(g, sessionId, 'add');
    return this.changed(g);
  }

  removeMember(id, sessionId) {
    const g = this.get(id);
    const at = g.members.findIndex((m) => m.id === sessionId);
    if (at < 0) return publicGroup(g);
    if (g.status === 'running' && g.leaderId === sessionId) fail('Đây là trưởng nhóm của nhóm đang chạy: đổi trưởng nhóm hay dừng nhóm trước.');
    const name = this.snap(sessionId)?.name || sessionId;
    g.members.splice(at, 1);
    if (g.leaderId === sessionId) g.leaderId = g.members[0]?.id || '';
    const back = [];
    for (const t of g.tasks) {
      if (t.assignee !== sessionId || t.status === 'done') continue;
      t.assignee = '';
      t.status = 'todo';
      t.updatedAt = now();
      back.push(t.id);
    }
    this.releasing.delete(sessionId);
    this.releaseToolsOf(g, sessionId);
    this.ctxDrop(sessionId);
    // Vừa thêm mà chưa kịp báo thì bỏ luôn: trưởng nhóm chưa từng biết phiên này.
    const unseen = this.notices.get(g.id)?.items.get(sessionId) === 'add';
    this.notices.get(g.id)?.items.delete(sessionId);
    if (g.status === 'running' && !unseen) {
      this.notify(g, g.leaderId, null, `Chủ dự án đã đưa "${name}" ra khỏi nhóm "${g.name}".`
        + (back.length ? ` Các việc chưa xong của phiên đó (${back.join(', ')}) đã trở về trạng thái chưa giao.` : ''));
    }
    return this.changed(g);
  }

  // Trưởng nhóm là bộ não của nhóm: luôn chạy Opus bản mới nhất (models.mjs), vì nó lập kế
  // hoạch, giao việc và nghiệm thu bàn giao của thành viên. Phiên không chạy thì thôi: trạm không mở lại trưởng nhóm.
  ensureBrain(sid) {
    const s = this.snap(sid);
    if (!s || !RUNNING.has(s.status) || s.model === 'opus') return Promise.resolve();
    return Promise.resolve(this.hub.setModel(sid, 'opus')).catch(() => {});
  }

  setLeader(id, sessionId) {
    const g = this.get(id);
    if (!g.members.some((m) => m.id === sessionId)) fail('Trưởng nhóm phải là thành viên của nhóm.');
    if (g.leaderId === sessionId) return publicGroup(g);
    const old = g.leaderId;
    g.leaderId = sessionId;
    this.ensureBrain(sessionId);
    if (g.status === 'running') {
      if (!g.briefed.includes(sessionId)) g.briefed.push(sessionId);
      const oldName = this.snap(old)?.name;
      this.notify(g, sessionId, null, `${oldName ? `Bạn thay "${oldName}" làm trưởng nhóm. Bảng việc hiện tại vẫn giữ nguyên.\n\n` : ''}${this.leaderBrief(g)}`);
      if (old && old !== sessionId) {
        this.notify(g, old, null, `Bạn không còn là trưởng nhóm "${g.name}"; trưởng nhóm mới là "${this.snap(sessionId)?.name || sessionId}". Việc đang giao cho bạn vẫn giữ, xong thì báo như thường. Không cần trả lời tin này.`);
      }
    }
    return this.changed(g);
  }

  setRole(id, sessionId, role) {
    const g = this.get(id);
    const m = g.members.find((x) => x.id === sessionId);
    if (!m) fail('Phiên này không ở trong nhóm.');
    const next = cleanRole(role);
    if (next === m.role) return publicGroup(g);
    m.role = next;
    if (g.status === 'running' && sessionId !== g.leaderId) this.queueNotice(g, sessionId, 'role');
    return this.changed(g);
  }

  async start(id) {
    const g = this.get(id);
    if (g.status === 'running') fail('Nhóm đang chạy rồi.');
    if (g.status === 'paused') fail('Nhóm đang tạm dừng: bấm Tiếp tục để chạy tiếp từ chỗ dừng.');
    if (!g.goal) fail('Cần đặt mục tiêu trước khi bắt đầu.');
    const leader = this.snap(g.leaderId);
    if (!leader) fail('Cần chọn trưởng nhóm trước khi bắt đầu.');
    if (!RUNNING.has(leader.status)) fail(`Trưởng nhóm "${leader.name}" đang không chạy: chạy lại phiên đó trước.`);
    await this.ensureBrain(g.leaderId);
    const before = { status: g.status, startedAt: g.startedAt, finishedAt: g.finishedAt, summary: g.summary, briefed: g.briefed };
    Object.assign(g, { status: 'running', startedAt: now(), finishedAt: '', summary: '', briefed: [g.leaderId] });
    // Việc đang làm của lượt trước: người làm sẽ bị dừng, nên chuyển về hàng chờ để trưởng nhóm giao lại.
    for (const t of g.tasks) if (t.status === 'doing' && t.assignee && t.assignee !== g.leaderId) t.status = 'queued';
    const sent = await this.notify(g, g.leaderId, null, this.leaderBrief(g, before.status !== 'draft' && g.tasks.length > 0));
    if (!sent.ok) {
      Object.assign(g, before);
      fail(`Không gửi được mục tiêu cho trưởng nhóm: ${sent.error}`);
    }
    // Chỉ trưởng nhóm chạy. Thành viên khác dừng, trưởng nhóm giao việc cho ai thì trạm mới mở lại phiên đó
    // (dispatch). Mốc chi phí tính từ đây.
    const closed = [];
    for (const m of g.members) {
      const s = this.snap(m.id);
      g.costSeen[m.id] = Number(s?.costUsd) || 0;
      if (m.id !== g.leaderId && s && RUNNING.has(s.status)) {
        closed.push(s.name);
        this.closeMember(m.id);
      }
    }
    return { ...this.changed(g), closed };
  }

  // Tạm dừng: cắt ngang ngay lượt đang chạy của mọi thành viên (như bấm nút dừng ở từng phiên, không tốn
  // lượt nào), không đẩy tin nhóm nào và chặn công cụ nhóm cho tới khi chạy tiếp. Bảng việc giữ nguyên.
  async pause(id) {
    const g = this.get(id);
    if (g.status !== 'running') fail('Chỉ tạm dừng được nhóm đang chạy.');
    Object.assign(g, { status: 'paused', pausedAt: now(), interrupted: [] });
    // Thay đổi thành viên chờ báo thì bỏ: lúc chạy tiếp, trưởng nhóm nhận lại toàn bộ tình hình.
    this.dropNotice(g.id);
    this.changed(g); // chặn công cụ nhóm ngay, trước cả khi các lượt bị cắt xong
    await Promise.all(g.members.map(async (m) => {
      if (!['busy', 'waiting'].includes(this.snap(m.id)?.status)) return;
      try {
        if (await this.hub.interrupt(m.id)) g.interrupted.push(m.id);
      } catch {
        // máy của phiên đó rớt mạng: không cắt được, phiên đó cũng không với tới trạm để làm gì thêm
      }
    }));
    return this.changed(g);
  }

  async resume(id) {
    const g = this.get(id);
    if (g.status !== 'paused') fail('Nhóm không ở trạng thái tạm dừng.');
    if (!g.goal) fail('Cần đặt mục tiêu trước khi chạy tiếp.');
    const leader = this.snap(g.leaderId);
    if (!leader) fail('Cần chọn trưởng nhóm trước khi chạy tiếp.');
    if (!RUNNING.has(leader.status)) fail(`Trưởng nhóm "${leader.name}" đang không chạy: chạy lại phiên đó trước.`);
    const cut = new Set(g.interrupted.filter((sid) => g.members.some((m) => m.id === sid)));
    // Thành viên bị cắt ngang giữa việc thì tự làm tiếp; trưởng nhóm được báo để khỏi giao lại.
    const resumed = [...cut].filter((sid) => sid !== g.leaderId)
      .map((sid) => ({ sid, tasks: g.tasks.filter((t) => t.assignee === sid && t.status === 'doing') }))
      .filter((x) => x.tasks.length);
    g.status = 'running';
    const sent = await this.notify(g, g.leaderId, null, [
      `Chủ dự án cho nhóm "${g.name}" chạy tiếp sau khi tạm dừng. Bảng việc giữ nguyên; trong lúc tạm dừng, thành viên, vai trò hay mục tiêu có thể đã đổi, nên đọc lại tình hình dưới đây và bảng việc (action "view") trước khi giao việc tiếp.`,
      cut.has(g.leaderId) ? 'Lượt của bạn bị cắt ngang lúc tạm dừng: làm tiếp từ chỗ đã dừng.' : '',
      resumed.length ? `Các thành viên bị cắt ngang giữa việc đã được báo làm tiếp, không cần giao lại: ${resumed.map((x) => `"${this.snap(x.sid)?.name || x.sid}" (${x.tasks.map((t) => t.id).join(', ')})`).join(', ')}.` : '',
      this.leaderBrief(g, true),
    ].filter(Boolean).join('\n\n'));
    if (!sent.ok) {
      g.status = 'paused';
      fail(`Không gửi được tin chạy tiếp cho trưởng nhóm: ${sent.error}`);
    }
    for (const { sid, tasks } of resumed) {
      this.notify(g, sid, null, `Chủ dự án cho nhóm "${g.name}" chạy tiếp sau khi tạm dừng. Lượt của bạn bị cắt ngang giữa chừng: làm tiếp việc dở ${tasks.map((t) => `${t.id} (${t.title})`).join(', ')} từ chỗ đã dừng, kiểm lại phần đang làm dở trước. Xong thì đặt status "review" kèm note bằng orbit_remote_group như thường.`, this.roleOf(g, sid));
    }
    Object.assign(g, { pausedAt: '', interrupted: [] });
    return this.changed(g);
  }

  stop(id) {
    const g = this.get(id);
    if (g.status !== 'running' && g.status !== 'paused') fail('Nhóm không chạy.');
    const wasPaused = g.status === 'paused';
    Object.assign(g, { status: 'stopped', pausedAt: '', interrupted: [] });
    this.dropNotice(g.id);
    // Đang tạm dừng thì các phiên đã thôi làm việc của nhóm: khỏi tốn thêm lượt để báo dừng.
    if (wasPaused) return this.changed(g);
    const text = `Chủ dự án đã dừng nhóm "${g.name}". Dừng phần việc của nhóm ở một điểm an toàn (không để file ở trạng thái hỏng) và không nhận thêm việc của nhóm cho tới khi nhóm được bắt đầu lại. Không cần trả lời tin này.`;
    const working = new Set([g.leaderId, ...g.tasks.filter((t) => t.status === 'doing' && t.assignee).map((t) => t.assignee)]);
    for (const sid of working) if (sid) this.notify(g, sid, null, text);
    return this.changed(g);
  }

  // Phiên bị xoá khỏi danh sách của app: bỏ khỏi nhóm, không báo ai (phiên đã dừng từ trước).
  dropSession(sessionId) {
    const g = this.groupOf(sessionId);
    if (!g) return;
    g.members = g.members.filter((m) => m.id !== sessionId);
    if (g.leaderId === sessionId) g.leaderId = g.members[0]?.id || '';
    for (const t of g.tasks) {
      if (t.assignee === sessionId && t.status !== 'done') Object.assign(t, { assignee: '', status: 'todo', updatedAt: now() });
    }
    this.releasing.delete(sessionId);
    this.releaseToolsOf(g, sessionId);
    this.ctxDrop(sessionId);
    this.changed(g);
  }

  // ---- Công cụ orbit_remote_group của các phiên trong nhóm ------------------------------
  async action(fromId, args = {}) {
    const out = await this.runAction(fromId, args);
    // Vỏ cũ không biết các action mới: báo một lần mỗi phiên (mỗi lần trạm chạy), kèm cách cập nhật.
    if (!(Number(args.shell) >= SHELL_VERSION) && out && typeof out === 'object' && !this.oldShell.has(fromId)) {
      this.oldShell.add(fromId);
      return { ...out, warning: OLD_SHELL };
    }
    return out;
  }

  async runAction(fromId, args = {}) {
    const g = this.groupOf(fromId);
    if (!g) fail('Phiên này chưa ở nhóm nào. Chủ dự án thêm phiên vào nhóm trên app Orbit Remote.');
    const act = String(args.action || 'view').trim();
    if (act === 'view') return this.view(g, fromId);
    if (act === 'tools') return this.toolBoard(g);
    if (act === 'release_tool') return this.releaseTool(g, fromId, args.tool);
    if (!['add_task', 'update_task', 'finish', 'claim_tool', 'compact', 'reset'].includes(act)) fail(`Không hiểu action "${act}". Dùng view, add_task, update_task, finish, tools, claim_tool, release_tool, compact hoặc reset.`);
    if (g.status === 'paused') fail(`Nhóm "${g.name}" đang tạm dừng theo lệnh của chủ dự án: dừng việc ở đây và chờ, khi nhóm chạy tiếp bạn sẽ nhận tin.`);
    if (act === 'claim_tool') {
      if (g.status !== 'running') fail(`Nhóm "${g.name}" chưa bắt đầu hoặc đã dừng.`);
      return this.claimTool(g, fromId, args);
    }
    if (g.status !== 'running') fail(`Nhóm "${g.name}" chưa bắt đầu hoặc đã dừng: chỉ xem được (action "view").`);
    if (act === 'compact' || act === 'reset') return this.selfContext(g, fromId, act, args);
    const leader = g.leaderId === fromId;
    const me = this.sender(fromId);
    if (act === 'add_task') {
      if (!leader) fail('Chỉ trưởng nhóm tạo được việc. Cần thêm việc thì nhắn trưởng nhóm bằng orbit_remote_send.');
      return this.addTask(g, me, args);
    }
    if (act === 'finish') {
      if (!leader) fail('Chỉ trưởng nhóm báo xong mục tiêu được.');
      const summary = clip(args.summary, NOTE_MAX);
      if (!summary) fail('Cần "summary": báo cáo kết quả cho chủ dự án.');
      Object.assign(g, { status: 'done', summary, finishedAt: now() });
      this.hub.logChannel({ from: me, to: [], failed: [], text: `Nhóm "${g.name}" báo đạt mục tiêu.\n\n${summary}`, groupId: g.id });
      // Xong mục tiêu: thành viên còn chạy thì dừng khi hết lượt đang chạy, dụng cụ đang giữ thì trả.
      for (const m of g.members) if (m.id !== g.leaderId) this.release(g, m.id);
      g.tools = [];
      g.toolWait = [];
      this.changed(g);
      return { ok: true, status: 'done', cost: this.costView(g) };
    }
    return this.updateTask(g, me, leader, args);
  }

  async addTask(g, me, args) {
    const title = clip(args.title, TITLE_MAX);
    if (!title) fail('Cần "title" cho việc.');
    if (g.tasks.length >= TASKS_MAX) fail(`Bảng việc tối đa ${TASKS_MAX} việc.`);
    const member = args.assignee ? this.resolveMember(g, args.assignee) : null;
    const task = {
      id: `T${g.nextTask}`,
      title,
      detail: clip(args.detail, DETAIL_MAX),
      assignee: member?.id || '',
      status: member ? 'doing' : 'todo',
      note: '',
      ...this.taskModel(args),
      updatedAt: now(),
    };
    g.nextTask += 1;
    g.tasks.push(task);
    const notified = member && member.id !== me.id ? await this.dispatch(g, task, me, 'assign') : null;
    this.changed(g);
    return { task: this.publicTask(g, task), notified };
  }

  // Model và effort trưởng nhóm chọn cho một việc (việc đơn giản giao model rẻ): áp lúc phiên được giao việc đó.
  taskModel(args) {
    const out = {};
    if (args.model !== undefined) {
      const m = String(args.model || '').trim().toLowerCase();
      if (!MODELS.has(m)) fail('model là một trong: haiku, sonnet, opus (để trống là giữ model của phiên).');
      out.model = m;
    }
    if (args.effort !== undefined) {
      const e = String(args.effort || '').trim().toLowerCase();
      if (!EFFORTS.has(e)) fail('effort là một trong: low, medium, high, xhigh, max.');
      out.effort = e;
    }
    return out;
  }

  async updateTask(g, me, leader, args) {
    const key = String(args.task || '').trim().toLowerCase();
    const t = g.tasks.find((x) => x.id.toLowerCase() === key);
    if (!t) fail(`Không có việc "${args.task || ''}". Xem mã việc bằng action "view".`);
    if (!leader && t.assignee !== me.id) fail(`Việc ${t.id} không giao cho bạn; chỉ trưởng nhóm sửa được.`);
    const status = args.status ? String(args.status).trim() : t.status;
    if (!STATUSES.has(status)) fail('status là một trong: todo, queued, doing, review, blocked, done.');
    if (!leader && !MEMBER_STATUSES.has(status)) fail('Thành viên chỉ đặt được status "doing", "review" hay "blocked"; nghiệm thu là việc của trưởng nhóm.');
    const prev = { status: t.status, assignee: t.assignee };
    if (leader) {
      if (args.assignee !== undefined) t.assignee = args.assignee ? this.resolveMember(g, args.assignee).id : '';
      if (args.title) t.title = clip(args.title, TITLE_MAX);
      if (args.detail !== undefined) t.detail = clip(args.detail, DETAIL_MAX);
      Object.assign(t, this.taskModel(args));
    }
    t.status = status;
    // Giao cho người mới mà không nói trạng thái: việc của người mới là đang làm (hay vào hàng chờ của họ).
    if (t.assignee !== prev.assignee && !args.status) t.status = t.assignee ? 'doing' : 'todo';
    if (args.note !== undefined) t.note = clip(args.note, NOTE_MAX);
    t.updatedAt = now();

    let notified = null;
    let next = null;
    if (!leader) {
      if ((t.status === 'review' || t.status === 'blocked') && t.status !== prev.status) {
        const head = t.status === 'review' ? `Việc ${t.id} xong, chờ nghiệm thu: ${t.title}` : `Việc ${t.id} bị chặn: ${t.title}`;
        const after = t.status === 'review'
          ? 'Nghiệm thu trên dữ liệu thật rồi đặt status "done" bằng orbit_remote_group (action "update_task"), hoặc trả lại bằng status "doing" kèm note nói rõ còn thiếu gì. Phần bàn giao trong note có liên quan tới phiên khác thì giao tiếp cho phiên đó.'
          : 'Gỡ chặn, giao lại hay sửa việc bằng orbit_remote_group (action "update_task").';
        notified = await this.notify(g, g.leaderId, me, `${head}\n\n${t.note || '(không có ghi chú)'}\n\n${after}`);
        next = await this.nextOrRelease(g, me.id, me);
      }
    } else if (t.assignee && t.assignee !== me.id && t.status === 'doing'
      && (t.assignee !== prev.assignee || prev.status !== 'doing' || !RUNNING.has(this.snap(t.assignee)?.status))) {
      // (Việc vẫn "doing" mà người làm đã dừng, ví dụ chủ dự án đóng phiên: đặt lại "doing" là đánh thức họ.)
      // Người làm cần biết mỗi khi việc của họ chuyển sang "đang làm": việc mới (todo, queued), bị trả lại
      // (review, blocked), hay việc đã xong bị mở lại (done; đã gặp thật khi QA tìm ra lỗi sau nghiệm thu).
      // Đánh thức người làm đã dừng thì giao lại đủ nội dung: phiên dừng trước khi Claude Code kịp ghi hội thoại
      // sẽ mở lại như phiên mới, không còn nhớ việc.
      const wake = t.assignee === prev.assignee && prev.status === 'doing';
      const kind = wake || t.assignee !== prev.assignee || prev.status === 'todo' || prev.status === 'queued' ? 'assign' : prev.status === 'done' ? 'reopen' : 'return';
      notified = await this.dispatch(g, t, me, kind);
    }
    // Trưởng nhóm tự chốt (hay đổi trạng thái) việc đang làm của một thành viên: giao việc kế trong hàng chờ của họ.
    if (leader && prev.assignee && prev.assignee !== me.id && prev.status === 'doing' && t.assignee === prev.assignee && t.status !== 'doing') {
      await this.nextOrRelease(g, prev.assignee, me);
    }
    // Người đang làm bị đổi sang người khác: báo để khỏi hai người làm một việc, rồi giao việc kế của họ.
    if (leader && prev.assignee && prev.assignee !== t.assignee && prev.assignee !== me.id && prev.status === 'doing') {
      this.notify(g, prev.assignee, me, `Trưởng nhóm đã chuyển việc ${t.id} (${t.title}) cho người khác: dừng phần việc đó ở một điểm an toàn. Không cần trả lời tin này.`);
      await this.nextOrRelease(g, prev.assignee, me);
    }
    this.changed(g);
    return { task: this.publicTask(g, t), notified, ...(next ? { next } : {}) };
  }

  // Đưa một việc tới người làm: người đó đang làm việc khác thì vào hàng chờ của họ (tới lượt trạm tự giao);
  // phiên đang dừng thì mở lại trước (đúng model và effort trưởng nhóm chọn cho việc), rồi gửi việc.
  async dispatch(g, task, me, kind) {
    const sid = task.assignee;
    const others = sid === g.leaderId ? [] : g.tasks.filter((x) => x !== task && x.assignee === sid && x.status === 'doing');
    if (others.length) {
      if (RUNNING.has(this.snap(sid)?.status)) {
        task.status = 'queued';
        task.pendingKind = kind; // tới lượt thì báo đúng kiểu (giao mới, trả lại, mở lại) kèm ghi chú
        const ahead = g.tasks.filter((x) => x !== task && x.assignee === sid && x.status === 'queued').length;
        return { ok: true, queued: true, to: this.snap(sid)?.name || sid, position: ahead + 1 };
      }
      // Người làm đã dừng mà còn việc "doing" (phiên chết, bị đóng bằng tay): không ai đang làm các việc đó. Việc vừa
      // giao được làm ngay, các việc kia vào hàng chờ của họ (đã gặp thật: việc giao thêm cứ xếp sau một phiên đã
      // dừng mà không ai mở nó).
      for (const x of others) Object.assign(x, { status: 'queued', pendingKind: x.pendingKind || 'assign' });
    }
    task.status = 'doing';
    if (task.pendingKind) {
      kind = task.pendingKind;
      delete task.pendingKind;
    }
    this.releasing.delete(sid);
    // Ngữ cảnh đã lớn (đo trước khi mở lại): xoá sạch rồi mới giao. Lời giao khi đó mang đủ mục tiêu, luật và ghi
    // chú của việc, vì phiên không còn nhớ gì.
    const fresh = sid !== g.leaderId && (Number(this.snap(sid)?.contextTokens) || 0) > MEMBER_FRESH_TOKENS;
    const up = await this.activate(sid, task);
    if (!up.ok) return up;
    const role = this.roleOf(g, sid);
    if (fresh) {
      g.briefed = g.briefed.filter((x) => x !== sid);
      this.ctxRun(g, sid, [{ raw: '/clear' }, { text: this.assignText(g, task, kind), from: me, extra: role }], true);
      return { ok: true, to: this.snap(sid)?.name || sid, fresh: true };
    }
    if (kind === 'assign') return this.assign(g, task, me);
    const verb = kind === 'reopen' ? 'mở lại việc đã xong' : 'trả lại việc';
    return this.notify(g, sid, me, `Trưởng nhóm ${verb} ${task.id} (${task.title}) để làm tiếp:\n\n${task.note || '(không có ghi chú)'}\n\nXong thì lại đặt status "review" kèm note bàn giao bằng orbit_remote_group.`, role);
  }

  // Mở lại phiên đang dừng (Claude Code --resume, giữ hội thoại) và đặt model, effort của việc nếu trưởng nhóm có chọn.
  async activate(sid, task = {}) {
    const r = this.hub.sessions.get(sid);
    if (!r) return { ok: false, error: 'Phiên không còn.' };
    let s = r.snap;
    try {
      if (this.closing.has(sid)) {
        await this.waitClosed(sid);
        s = r.snap;
      }
      if (RUNNING.has(s.status)) {
        if (task.model && task.model !== s.model) await this.hub.setModel(sid, task.model);
        if (task.effort && task.effort !== s.effort) await this.hub.setEffort(sid, task.effort);
        return { ok: true };
      }
      if (task.model) r.snap = { ...r.snap, model: task.model };
      if (task.effort) r.snap = { ...r.snap, effort: task.effort };
      await this.hub.resume(sid);
      return { ok: true, started: true };
    } catch (err) {
      return { ok: false, to: s.name, error: `Không mở lại được phiên "${s.name}": ${err.message}` };
    }
  }

  // Thành viên vừa xong (hay bị chặn) một việc: còn việc trong hàng chờ thì giao việc kế ngay; hết việc thì
  // phiên được dừng khi lượt đang chạy kết thúc (lời báo xong vừa gửi trưởng nhóm chính là bàn giao).
  async nextOrRelease(g, sid, me) {
    if (sid === g.leaderId) return null;
    if (g.tasks.some((x) => x.assignee === sid && x.status === 'doing')) return null;
    const queued = g.tasks.find((x) => x.assignee === sid && x.status === 'queued');
    if (queued) {
      await this.dispatch(g, queued, me, 'assign');
      return { task: queued.id, text: `Việc kế trong hàng chờ của bạn là ${queued.id} (${queued.title}); tin giao việc tới ngay sau lượt này.` };
    }
    this.release(g, sid);
    return { release: true, text: 'Hàng chờ của bạn trống: phiên này được dừng khi lượt này kết thúc; trưởng nhóm giao việc mới thì phiên được mở lại.' };
  }

  closeMember(sid) {
    this.closing.add(sid);
    this.hub.close(sid).catch(() => this.closing.delete(sid));
  }

  async waitClosed(sid, ms = 15000) {
    const end = Date.now() + ms;
    while (this.closing.has(sid) && RUNNING.has(this.snap(sid)?.status)) {
      if (Date.now() > end) throw new Error('phiên chưa đóng xong để mở lại');
      await new Promise((r) => setTimeout(r, 100));
    }
    this.closing.delete(sid);
  }

  release(g, sid) {
    if (sid === g.leaderId) return;
    const s = this.snap(sid);
    if (!s || !RUNNING.has(s.status)) return;
    if (s.status === 'idle') this.closeMember(sid);
    else this.releasing.add(sid);
  }

  assign(g, task, me) {
    return this.notify(g, task.assignee, me, this.assignText(g, task), this.roleOf(g, task.assignee));
  }

  // Lời giao việc đủ để làm mà không cần nhớ gì trước đó (lần giao đầu kèm mục tiêu và luật). kind: assign, return,
  // reopen (trưởng nhóm giao, trả lại, mở lại), resume (phiên tự xoá ngữ cảnh giữa việc).
  assignText(g, task, kind = 'assign') {
    const m = g.members.find((x) => x.id === task.assignee);
    const role = m?.role ? `$${m.role}` : '';
    const first = !g.briefed.includes(task.assignee);
    if (first) g.briefed.push(task.assignee);
    const head = {
      return: `Trưởng nhóm trả lại việc ${task.id} cho bạn làm tiếp: ${task.title}`,
      reopen: `Trưởng nhóm mở lại việc đã xong ${task.id} cho bạn làm tiếp: ${task.title}`,
      resume: `Việc bạn đang làm dở: ${task.id}: ${task.title}`,
    }[kind] || `Trưởng nhóm giao việc ${task.id} cho bạn: ${task.title}`;
    const parts = [head];
    if (task.detail) parts.push(task.detail);
    if (task.note) parts.push(`Ghi chú mới nhất của việc: ${task.note}`);
    parts.push(role
      ? `Vai trò của bạn trong nhóm là ${role}: làm việc này theo đúng đặc tả của token ${role}, như khi chủ dự án gõ "${role} ${task.title}". Đọc tệp đặc tả của token trước khi làm.`
      : 'Bạn chưa được gán vai trò trong nhóm: làm theo chỉ dẫn của trưởng nhóm.');
    if (first) {
      parts.push(`Bạn đang ở nhóm "${g.name}". Mục tiêu chung do chủ dự án đặt:\n${g.goal}`, MEMBER_RULES);
    }
    parts.push(`Xong thì gọi orbit_remote_group với action "update_task", task "${task.id}", status "review" và note bàn giao: kết quả, file đã đụng, cách đã kiểm, phần còn liên quan tới phiên khác (nếu có). Bị chặn thì status "blocked" kèm lý do. Trưởng nhóm nhận tin tự động.`);
    return parts.join('\n\n');
  }

  roleOf(g, sessionId) {
    const role = g.members.find((m) => m.id === sessionId)?.role;
    return role ? { role } : {};
  }

  resolveMember(g, value) {
    const key = String(value || '').trim();
    const lower = key.toLowerCase();
    const byId = g.members.find((m) => m.id === key);
    if (byId) return byId;
    const roleKey = lower.replace(/^\$/, '');
    let hits = g.members.filter((m) => (this.snap(m.id)?.name || '').toLowerCase() === lower);
    if (!hits.length) hits = g.members.filter((m) => m.role && m.role.toLowerCase() === roleKey);
    if (hits.length === 1) return hits[0];
    const list = g.members.map((m) => `${this.snap(m.id)?.name || m.id} (mã ${m.id}${m.role ? `, $${m.role}` : ''})`).join('; ');
    if (hits.length > 1) fail(`"${key}" khớp ${hits.length} thành viên; giao theo mã phiên. Thành viên: ${list}.`);
    return fail(`Không có thành viên "${key}" trong nhóm. Thành viên: ${list}.`);
  }

  sender(id) {
    const s = this.snap(id);
    return s ? { id: s.id, name: s.name, machine: s.machine } : { id, name: id, machine: '?' };
  }

  publicTask(g, t) {
    return { ...t, assignee: t.assignee ? `${this.snap(t.assignee)?.name || t.assignee} (${t.assignee})` : '' };
  }

  view(g, fromId) {
    return {
      group: g.name,
      status: g.status,
      you: g.leaderId === fromId ? 'trưởng nhóm' : 'thành viên',
      goal: g.goal,
      members: g.members.map((m) => {
        const s = this.snap(m.id);
        return {
          id: m.id,
          name: s?.name || m.id,
          machine: s?.machine || '',
          cwd: s?.cwd || '',
          status: s?.status || 'stopped',
          role: m.role ? `$${m.role}` : '',
          leader: m.id === g.leaderId || undefined,
          self: m.id === fromId || undefined,
          // Bản model thật thành viên đang dùng (Claude Code báo trong lượt), chưa chạy lượt nào thì dòng model đã chọn.
          model: s?.activeModel || s?.model || undefined,
          context: s?.contextTokens ? `${Math.round(s.contextTokens / 1000)}k token` : undefined,
          current: g.tasks.find((t) => t.assignee === m.id && t.status === 'doing')?.id,
          queue: g.tasks.filter((t) => t.assignee === m.id && t.status === 'queued').map((t) => t.id),
        };
      }),
      tasks: g.tasks.map((t) => this.publicTask(g, t)),
      tools: this.toolBoard(g),
      cost: this.costView(g),
      summary: g.summary || undefined,
    };
  }

  // ---- Bảng tin dụng cụ dùng chung ------------------------------------------------------------
  // Một dụng cụ là một tên trên một máy: Unity Editor ở máy A và Unity Editor ở máy B là hai dụng cụ khác nhau.
  toolKey(machineId, tool) {
    return `${machineId}|${String(tool).trim().toLowerCase()}`;
  }

  toolBoard(g) {
    const t = Date.now();
    return {
      inUse: g.tools.map((e) => ({ tool: e.tool, machine: e.machine, by: e.name, session: e.by, since: e.since, until: e.until, overdue: Date.parse(e.until) < t || undefined, note: e.note || undefined })),
      waiting: g.toolWait.map((w) => ({ tool: w.tool, machine: w.machine, by: w.name, session: w.by, since: w.since })),
    };
  }

  claimTool(g, sid, args) {
    const tool = clip(args.tool, 80);
    if (!tool) fail('Cần "tool": tên dụng cụ kèm dự án, ví dụ "Unity Editor (MyGame)".');
    const s = this.snap(sid);
    const minutes = Math.min(TOOL_MINUTES_MAX, Math.max(1, Math.round(Number(args.minutes) || TOOL_MINUTES)));
    const key = this.toolKey(s?.machineId || '', tool);
    const until = new Date(Date.now() + minutes * 60000).toISOString();
    const held = g.tools.find((e) => e.key === key);
    if (held?.by === sid) {
      held.until = until;
      if (args.note !== undefined) held.note = clip(args.note, 200);
      this.changed(g);
      return { ok: true, extended: true, until, text: `Đã gia hạn "${tool}" tới ${hhmm(until)}.` };
    }
    if (held) {
      const holder = this.snap(held.by);
      if (holder && RUNNING.has(holder.status)) {
        if (!g.toolWait.some((w) => w.key === key && w.by === sid)) {
          g.toolWait.push({ key, tool, machineId: s?.machineId || '', machine: s?.machine || '', by: sid, name: s?.name || sid, minutes, since: now() });
        }
        this.changed(g);
        const pos = g.toolWait.filter((w) => w.key === key).findIndex((w) => w.by === sid) + 1;
        return {
          ok: false,
          busy: { by: held.name, since: held.since, until: held.until },
          queued: pos,
          text: `"${tool}" trên máy ${held.machine} đang được "${held.name}" dùng (đăng ký tới ${hhmm(held.until)}). Bạn đứng thứ ${pos} trong hàng chờ: dụng cụ trống thì bạn nhận tin và được đăng ký luôn. Trong lúc chờ làm việc khác hay kết thúc lượt; đừng gọi lại để hỏi.`,
        };
      }
      g.tools = g.tools.filter((e) => e !== held); // người giữ đã dừng: chỗ đó coi như trống
    }
    if (g.tools.length >= TOOLS_MAX) fail('Bảng tin dụng cụ đã đầy.');
    g.tools.push({ key, tool, machineId: s?.machineId || '', machine: s?.machine || '', by: sid, name: s?.name || sid, since: now(), until, note: clip(args.note, 200) });
    g.toolWait = g.toolWait.filter((w) => !(w.key === key && w.by === sid));
    this.changed(g);
    return { ok: true, until, text: `Đã đăng ký "${tool}" trên máy ${s?.machine || '?'} tới ${hhmm(until)}. Dùng xong gọi release_tool ngay.` };
  }

  releaseTool(g, sid, tool) {
    const key = this.toolKey(this.snap(sid)?.machineId || '', clip(tool, 80));
    const held = g.tools.some((e) => e.key === key && e.by === sid);
    const waited = g.toolWait.some((w) => w.key === key && w.by === sid);
    if (!held && !waited) return { ok: true, text: 'Bạn không giữ và không chờ dụng cụ này.' };
    g.tools = g.tools.filter((e) => !(e.key === key && e.by === sid));
    g.toolWait = g.toolWait.filter((w) => !(w.key === key && w.by === sid));
    if (held) this.handOver(g, key);
    this.changed(g);
    return { ok: true, text: held ? 'Đã trả dụng cụ.' : 'Đã rời hàng chờ.' };
  }

  // Dụng cụ vừa trống: đăng ký luôn cho người chờ đầu tiên còn chạy và báo họ một lần, không ai phải hỏi lại.
  handOver(g, key) {
    for (;;) {
      const w = g.toolWait.find((x) => x.key === key);
      if (!w) return;
      g.toolWait = g.toolWait.filter((x) => x !== w);
      if (!RUNNING.has(this.snap(w.by)?.status)) continue; // người chờ đã dừng: bỏ qua
      const until = new Date(Date.now() + (w.minutes || TOOL_MINUTES) * 60000).toISOString();
      g.tools.push({ key, tool: w.tool, machineId: w.machineId, machine: w.machine, by: w.by, name: w.name, since: now(), until, note: '' });
      if (g.status === 'running') {
        this.notify(g, w.by, null, `Dụng cụ "${w.tool}" trên máy ${w.machine} đã trống và đã được đăng ký cho bạn tới ${hhmm(until)}. Làm phần việc cần dụng cụ đó; dùng xong gọi orbit_remote_group action "release_tool" ngay.`, { label: 'Bảng tin dụng cụ' });
      }
      return;
    }
  }

  // Phiên dừng hay rời nhóm: trả mọi dụng cụ nó đang giữ và bỏ nó khỏi hàng chờ.
  releaseToolsOf(g, sid) {
    const keys = g.tools.filter((e) => e.by === sid).map((e) => e.key);
    const waiting = g.toolWait.some((w) => w.by === sid);
    if (!keys.length && !waiting) return;
    g.tools = g.tools.filter((e) => e.by !== sid);
    g.toolWait = g.toolWait.filter((w) => w.by !== sid);
    for (const key of keys) this.handOver(g, key);
    this.changed(g);
  }

  // Chủ dự án gỡ một dòng trên bảng tin (phiên giữ quên trả): dụng cụ chuyển cho người chờ kế tiếp.
  freeTool(id, key) {
    const g = this.get(id);
    if (!g.tools.some((e) => e.key === key)) fail('Dòng này không còn trên bảng tin.');
    g.tools = g.tools.filter((e) => e.key !== key);
    this.handOver(g, key);
    return this.changed(g);
  }

  // ---- Chi phí và vòng đời phiên ----------------------------------------------------------------
  // hub.upsertSession gọi mỗi khi một phiên báo trạng thái: cộng chi phí, trả dụng cụ khi phiên dừng, và dừng
  // thành viên đã bàn giao xong khi lượt của nó kết thúc.
  onSessionSnap(prev, snap) {
    const g = this.groupOf(snap.id);
    if (!g) return;
    this.trackCost(g, snap);
    const ordered = this.closing.has(snap.id); // trạm tự đóng (Bắt đầu nhóm, hết việc)
    if (!RUNNING.has(snap.status)) this.closing.delete(snap.id);
    if (prev && RUNNING.has(prev.status) && !RUNNING.has(snap.status)) {
      this.releasing.delete(snap.id);
      this.releaseToolsOf(g, snap.id);
      if (!ordered) this.reportStop(g, snap);
    }
    const op = this.ctx.get(snap.id);
    if (op) {
      if (!RUNNING.has(snap.status)) this.ctxDrop(snap.id);
      else if (snap.status !== 'idle') op.armed = true;
      else if (op.armed) this.ctxStep(snap.id);
    } else if (snap.id === g.leaderId && g.status === 'running' && snap.status === 'idle'
      && (Number(snap.contextTokens) || 0) > LEADER_COMPACT_TOKENS && Date.now() - (this.compactAt.get(snap.id) || 0) > COMPACT_GAP_MS) {
      this.compactAt.set(snap.id, Date.now());
      this.ctxRun(g, snap.id, [{ raw: `/compact ${LEADER_FOCUS}` }]);
    }
    if (snap.status === 'idle' && this.releasing.has(snap.id)) {
      this.releasing.delete(snap.id);
      const busy = g.tasks.some((t) => t.assignee === snap.id && t.status === 'doing');
      if (!busy && snap.id !== g.leaderId) this.closeMember(snap.id);
    }
  }

  // ---- Ngữ cảnh của phiên: nén, xoá -----------------------------------------------------------
  // Các bước chạy lần lượt, mỗi bước khi phiên rảnh: lệnh của Claude Code ("/compact", "/clear": không gọi model,
  // đo thật trên Claude Code ngày 2026-11-02) hay một tin mang lại những gì cần nhớ. hold: tin của nhóm gửi phiên
  // này được giữ lại tới khi xong, kẻo rơi vào ngữ cảnh sắp bị xoá.
  ctxRun(g, sid, steps, hold = false) {
    const op = this.ctx.get(sid);
    if (op) {
      op.steps.push(...steps);
      op.hold = op.hold || hold;
    } else {
      // armed: bước đầu chạy ở lần rảnh kế tiếp (phiên đang bận thì là lúc lượt đó kết thúc).
      this.ctx.set(sid, { gid: g.id, steps: [...steps], hold, held: [], armed: true, sending: false });
    }
    if (this.snap(sid)?.status === 'idle') this.ctxStep(sid);
  }

  async ctxStep(sid) {
    const op = this.ctx.get(sid);
    if (!op || op.sending) return;
    const g = this.map.get(op.gid);
    const step = op.steps.shift();
    if (!step || !g) {
      this.ctxEnd(sid);
      return;
    }
    op.sending = true;
    op.armed = false; // bước kế chạy ở lần rảnh sau khi phiên đã nhận bước này
    let ok = true;
    try {
      if (step.raw) {
        ok = Boolean(await this.hub.sendToSession(sid, step.raw, { id: '', name: `Trạm (nhóm ${g.name})`, machine: '' }));
      } else {
        ok = (await this.notify(g, sid, step.from || null, step.text, { label: 'Trạm', ...step.extra, force: true })).ok;
      }
    } catch {
      ok = false;
    }
    op.sending = false;
    if (!ok) op.steps = [];
    // Bước cuối đã gửi: tin giữ lại đi ngay sau nó, phiên xử lý theo đúng thứ tự.
    if (!op.steps.length) this.ctxEnd(sid);
  }

  ctxEnd(sid) {
    const op = this.ctx.get(sid);
    if (!op) return;
    this.ctx.delete(sid);
    for (const h of op.held) this.notify(h.g, sid, h.from, h.text, h.extra);
  }

  ctxDrop(sid) {
    const op = this.ctx.get(sid);
    if (op) op.steps = [];
    this.ctxEnd(sid);
  }

  // Phiên tự xin nén ("compact") hay xoá ("reset") ngữ cảnh của chính nó; trạm làm khi lượt đang chạy kết thúc.
  selfContext(g, sid, act, args) {
    if (this.ctx.has(sid)) fail('Trạm đang nén hay xoá ngữ cảnh của bạn rồi: kết thúc lượt và chờ.');
    const leader = sid === g.leaderId;
    const task = leader ? null : g.tasks.find((t) => t.assignee === sid && t.status === 'doing');
    const role = leader ? {} : this.roleOf(g, sid);
    if (act === 'compact') {
      const focus = clip(args.focus, 1000) || (leader ? LEADER_FOCUS : MEMBER_FOCUS);
      const then = clip(args.then, 2000);
      const next = task
        ? `Ngữ cảnh đã được nén theo yêu cầu của bạn. Làm tiếp việc ${task.id} (${task.title})${then ? `: ${then}` : ' từ chỗ đang dở'}.`
        : then ? `Ngữ cảnh đã được nén theo yêu cầu của bạn. ${then}` : '';
      this.compactAt.set(sid, Date.now());
      this.ctxRun(g, sid, [{ raw: `/compact ${focus}` }, ...(next ? [{ text: next, extra: role }] : [])]);
      return { ok: true, text: `Trạm sẽ nén ngữ cảnh của bạn ngay khi lượt này kết thúc${next ? ', rồi nhắc bạn làm tiếp' : ''}. Kết thúc lượt ngay, đừng làm thêm gì sau lời gọi này.` };
    }
    const note = clip(args.note, NOTE_MAX);
    if (!note) fail('Cần "note": những gì phải nhớ sau khi xoá ngữ cảnh (kế hoạch, quyết định, việc dở, bước kế tiếp).');
    const head = `Bạn vừa tự xoá ngữ cảnh để tiết kiệm token. Ghi chú bạn để lại trước khi xoá:\n\n${note}`;
    let carry;
    if (leader) {
      carry = `${head}\n\n${this.leaderBrief(g, true)}`;
    } else {
      g.briefed = g.briefed.filter((x) => x !== sid);
      if (task) {
        carry = `${head}\n\n${this.assignText(g, task, 'resume')}`;
      } else {
        g.briefed.push(sid);
        carry = `${head}\n\nBạn đang ở nhóm "${g.name}". Mục tiêu chung do chủ dự án đặt:\n${g.goal}\n\n${MEMBER_RULES}\n\nHiện bạn không có việc nào đang làm: chờ trưởng nhóm giao việc.`;
      }
    }
    this.ctxRun(g, sid, [{ raw: '/clear' }, { text: carry, extra: role }], true);
    return { ok: true, text: `Trạm sẽ xoá ngữ cảnh của bạn ngay khi lượt này kết thúc, rồi gửi lại ghi chú này cùng ${leader ? 'lời giao mục tiêu' : task ? `mục tiêu, luật và việc ${task.id}` : 'mục tiêu và luật'}. Kết thúc lượt ngay, đừng làm thêm gì sau lời gọi này.` };
  }

  // Thành viên đang làm việc mà dừng không do trạm ra lệnh (Claude Code thoát lỗi, chủ dự án đóng phiên): báo
  // trưởng nhóm, kẻo cả nhóm ngồi chờ một phiên đã tắt (đã gặp thật: phiên thoát ngay sau khi nhận việc).
  reportStop(g, snap) {
    if (g.status !== 'running' || snap.id === g.leaderId) return;
    const task = g.tasks.find((t) => t.assignee === snap.id && t.status === 'doing');
    if (!task) return;
    const why = snap.status === 'crashed' ? `Claude Code thoát lỗi (mã ${snap.exitCode ?? '?'})` : 'phiên đã bị đóng';
    this.notify(g, g.leaderId, null, `Phiên "${snap.name}" dừng giữa chừng khi đang làm ${task.id} (${task.title}): ${why}. Đặt lại status "doing" cho việc đó để trạm mở lại phiên và giao lại đủ nội dung, hoặc giao cho người khác.`, { label: 'Trạm' });
  }

  // total_cost_usd của Claude Code cộng dồn theo tiến trình: phiên mở lại thì số đếm lại từ 0, nên cộng phần
  // tăng thêm so với lần thấy trước (số nhỏ hơn lần trước là tiến trình mới). Chỉ tính lúc nhóm chạy hay tạm dừng.
  trackCost(g, snap) {
    if (snap.costUsd === undefined) return;
    const cur = Number(snap.costUsd) || 0;
    const seen = g.costSeen[snap.id];
    g.costSeen[snap.id] = cur;
    if (g.status !== 'running' && g.status !== 'paused') return;
    if (seen === undefined) return; // lần đầu thấy phiên này: chỉ lấy mốc
    const delta = cur >= seen ? cur - seen : cur;
    if (delta <= 0) return;
    g.cost[snap.id] = (Number(g.cost[snap.id]) || 0) + delta;
    this.checkBudget(g);
    this.changed(g);
  }

  // Báo trưởng nhóm một lần khi chi phí chạm 80% và 100% ngân sách.
  checkBudget(g) {
    if (!g.budgetUsd) return;
    const spent = costTotal(g);
    const pct = (spent / g.budgetUsd) * 100;
    const level = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
    if (level <= g.budgetAlert) return;
    g.budgetAlert = level;
    if (g.status !== 'running') return;
    this.notify(g, g.leaderId, null, level === 100
      ? `Nhóm "${g.name}" đã tiêu hết ngân sách chủ dự án đặt (${usd(spent)} / ${usd(g.budgetUsd)}). Chốt những việc đang dở quan trọng nhất cho mục tiêu, tạm không mở việc mới tốn kém, và báo chủ dự án nếu cần thêm ngân sách (finish kèm tình hình, hay nhắn trong note).`
      : `Nhóm "${g.name}" đã tiêu ${Math.round(pct)}% ngân sách (${usd(spent)} / ${usd(g.budgetUsd)}). Rà lại kế hoạch để về đích trong ngân sách: gom việc nhỏ, giao việc đơn giản cho model rẻ, bỏ bước thừa, nhưng không bỏ bước kiểm.`, { label: 'Ngân sách' });
  }

  costView(g) {
    return {
      totalUsd: Math.round(costTotal(g) * 10000) / 10000,
      budgetUsd: g.budgetUsd || undefined,
      perSession: g.members.map((m) => ({ name: this.snap(m.id)?.name || m.id, usd: Math.round((Number(g.cost[m.id]) || 0) * 10000) / 10000 })),
    };
  }

  // ---- Tin trạm đẩy vào phiên -------------------------------------------------------------
  // Mỗi thay đổi mới dời lúc báo ra sau; thêm rồi đổi vai trò vẫn tính là "thành viên mới".
  queueNotice(g, sessionId, kind) {
    let n = this.notices.get(g.id);
    if (!n) {
      n = { timer: null, items: new Map() };
      this.notices.set(g.id, n);
    }
    if (n.items.get(sessionId) !== 'add') n.items.set(sessionId, kind);
    clearTimeout(n.timer);
    n.timer = setTimeout(() => this.flushNotice(g.id), this.noticeMs);
    n.timer.unref?.();
  }

  dropNotice(groupId) {
    clearTimeout(this.notices.get(groupId)?.timer);
    this.notices.delete(groupId);
  }

  flushNotice(groupId) {
    const n = this.notices.get(groupId);
    this.notices.delete(groupId);
    const g = this.map.get(groupId);
    if (!n || !g || g.status !== 'running') return;
    const lines = [];
    for (const [sid, kind] of n.items) {
      const m = g.members.find((x) => x.id === sid);
      if (m && sid !== g.leaderId) lines.push(`- ${kind === 'add' ? 'Thành viên mới' : 'Đổi vai trò'}: ${this.memberLine(g, m).slice(2)}`);
    }
    if (!lines.length) return;
    this.notify(g, g.leaderId, null, `Chủ dự án cập nhật thành viên của nhóm "${g.name}":\n${lines.join('\n')}\n\nGiao việc cho đúng vai trò của từng người.`);
  }

  memberLine(g, m) {
    const s = this.snap(m.id);
    const hint = m.role ? roleTokens().find((t) => t.role === m.role)?.hint : '';
    const role = m.role ? `vai trò $${m.role}${hint ? ` (${hint})` : ''}` : 'chưa có vai trò';
    return `- "${s?.name || m.id}" (mã ${m.id}, máy ${s?.machine || '?'}, thư mục ${s?.cwd || '?'}, ${SESSION_STATUS[s?.status] || 'không rõ'}), ${role}${m.id === g.leaderId ? ' — trưởng nhóm' : ''}`;
  }

  leaderBrief(g, again = false) {
    const leader = g.members.find((m) => m.id === g.leaderId);
    const others = g.members.filter((m) => m.id !== g.leaderId);
    return [
      `Bạn là trưởng nhóm "${g.name}". Mục tiêu chung do chủ dự án đặt:\n\n${g.goal}`,
      `Thành viên:\n${g.members.map((m) => this.memberLine(g, m)).join('\n')}`,
      [
        'Cách nhóm chạy: lúc này chỉ phiên của bạn chạy. Bạn giao việc cho ai thì trạm mở lại phiên đó và gửi việc kèm token vai trò của họ. Mỗi thành viên làm một việc một lúc: giao thêm khi họ đang bận thì việc vào hàng chờ của họ (status "queued"), họ xong việc hiện tại thì trạm tự giao việc kế. Thành viên hết việc thì lời báo xong (note) chính là bàn giao cho bạn, rồi phiên đó được dừng; bàn giao có phần liên quan tới phiên khác thì bạn giao tiếp cho phiên đó.',
        'Cách điều phối:',
        '1. Đọc hiện trạng rồi chia mục tiêu thành các việc có kết quả rõ. Mỗi việc giao cho đúng một thành viên có vai trò hợp với việc đó (cùng máy và thư mục với phần cần đụng tới); thành viên chỉ nhận việc thuộc vai trò của mình. Vai trò nào có người thì việc thuộc vai trò đó giao cho người đó, không tự làm thay: nhóm có thành viên vai trò $qa thì việc kiểm chất lượng là việc của thành viên đó. Việc phụ thuộc nhau thì giao việc sau khi việc trước đã xong. Không giao hai người sửa cùng một file một lúc.',
        '2. Tạo việc bằng công cụ orbit_remote_group, action "add_task" (title, detail, assignee là mã, tên hay token vai trò của thành viên; model và effort nếu muốn đổi cho việc đó).',
        '3. Bạn là bộ não của nhóm (chạy Opus bản mới nhất); thành viên Haiku, Sonnet là tay chân. Thành viên báo xong (status "review") hay bị chặn ("blocked") thì bạn nhận tin và là người nghiệm thu: tự kiểm kết quả trên dữ liệu thật rồi đặt "done", hoặc trả lại bằng status "doing" kèm note nói rõ còn thiếu gì.',
        `4. ${leader?.role ? `Vai trò của bạn là $${leader.role}: việc thuộc vai trò đó thì tự làm (assignee là chính bạn).` : 'Việc không ai trong nhóm hợp vai trò thì tự làm (assignee là chính bạn).'}`,
        '5. Khi mục tiêu đã đạt và đã kiểm, gọi action "finish" kèm summary là báo cáo cho chủ dự án. Chủ dự án theo dõi bảng việc trên app.',
      ].join('\n'),
      [
        `Tiết kiệm token: bạn chịu trách nhiệm chi phí token của cả nhóm (xem chi phí từng phiên${g.budgetUsd ? ` và ngân sách ${usd(g.budgetUsd)}` : ''} bằng action "view"). Tự lên chiến lược tiết kiệm khôn ngoan, nhưng không được giảm chất lượng hay lệch mục tiêu:`,
        '- Lên kế hoạch trước khi giao: việc vừa đủ lớn, gom các sửa nhỏ cùng chỗ vào một việc, vì mỗi lần mở một phiên lại tốn ngữ cảnh.',
        '- Mô tả việc chính xác (file, chỗ cần sửa, tiêu chí xong) để thành viên khỏi phải dò cả dự án.',
        '- Chọn model theo độ khó bằng tham số model của add_task (trạm tự dùng bản mới nhất của dòng đó): haiku cho việc máy móc (sửa nhỏ, đổi tên, chạy kiểm), sonnet cho việc thường, opus chỉ cho việc khó (thiết kế, gỡ lỗi khó); effort thấp cho việc đơn giản.',
        '- Mỗi tin nhắn là một lượt Claude của người nhận: không nhắn để báo đã giao việc, đã nghiệm thu hay để cảm ơn; không nhắn cả nhóm (to="#group") khi chỉ một người cần biết.',
        '- Nghiệm thu bằng phép kiểm rẻ nhất mà vẫn chắc (chạy bộ kiểm, đọc đúng chỗ đổi), không đọc lại toàn bộ; việc rủi ro thì vẫn kiểm kỹ.',
        '- Ngữ cảnh của bạn lớn dần theo mỗi lần điều phối: ghi tình hình lên bảng việc (note của việc) thay vì giữ trong đầu, để reset được bất cứ lúc nào mà không mất gì.',
      ].join('\n'),
      CONTEXT_RULES,
      TOOL_RULES,
      others.length ? '' : 'Nhóm hiện chỉ có bạn: tự làm theo mục tiêu, chủ dự án có thể thêm thành viên sau.',
      again ? 'Bảng việc của lượt trước vẫn còn: xem bằng action "view" trước khi tạo việc mới. Việc đang chờ (queued) của lượt trước bắt đầu khi bạn đặt status "doing" cho nó.' : '',
    ].filter(Boolean).join('\n\n');
  }

  // Không bao giờ ném lỗi: trả { ok, error } để người gọi quyết có báo lại hay không. Mọi tin đều ghi
  // vào Kênh để chủ dự án thấy nhóm đang trao đổi gì.
  async notify(g, targetId, from, text, extra = {}) {
    const { force, ...pass } = extra;
    const op = this.ctx.get(targetId);
    if (op?.hold && !force) {
      op.held.push({ g, from, text, extra: pass });
      return { ok: true, to: this.snap(targetId)?.name || targetId, held: true };
    }
    const r = this.hub.sessions.get(targetId);
    const who = r ? { id: r.snap.id, name: r.snap.name, machine: r.snap.machine } : { id: targetId, name: targetId, machine: '?' };
    let error = '';
    if (!r || !RUNNING.has(r.snap.status)) error = 'Phiên không chạy.';
    else {
      try {
        await this.hub.machineRpc(r.snap.machineId).request({ op: 'deliver', id: targetId, from, text, group: { id: g.id, name: g.name }, ...pass });
      } catch (err) {
        error = err.message;
      }
    }
    this.hub.logChannel({
      from: from || { id: '', name: pass.label || 'Chủ dự án', machine: '' },
      to: error ? [] : [who],
      failed: error ? [{ ...who, error }] : [],
      text,
      groupId: g.id,
    });
    return error ? { ok: false, to: who.name, error } : { ok: true, to: who.name };
  }
}
