// Một phiên Claude Code chạy nền, điều khiển qua giao thức stream-json.
//
// Mọi hành vi dưới đây đã đo trên Claude Code 2.1.283 thật, không đoán:
//   - `--permission-prompt-tool stdio` khiến Claude Code hỏi quyền bằng một
//     `control_request` có `subtype: can_use_tool` trên stdout; trả `control_response`
//     là công cụ chạy hoặc bị chặn, và lời từ chối tới tay mô hình nguyên văn.
//   - Tin gửi lúc đang bận được chen vào ngay giữa lượt, ở ranh giới công cụ kế tiếp,
//     không xếp thành lượt riêng. Nên "bận" là một trạng thái tự sửa: thấy hoạt động
//     mới thì bật lại, thấy `result` thì tắt.
//   - Đổi sang `bypassPermissions` giữa chừng chỉ được khi phiên mở với
//     `--allow-dangerously-skip-permissions`, nên cờ đó luôn được bật.
//   - Lệnh `interrupt` cắt lượt ngay; lượt bị cắt kết thúc bằng `error_during_execution`.
//   - Đóng stdin thì tiến trình tự thoát.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { modelName, resolveModel } from './models.mjs';
import { tokenNote } from './tokens.mjs';

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk'];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Biến môi trường chỉ có nghĩa với phiên đã sinh ra trạm (khi trạm được chạy từ bên
// trong một phiên Claude). Để lọt xuống thì phiên con tưởng mình là phiên con của
// phiên kia: nhận nhầm mã phiên, nối nhầm ống nhắn tin của VS Code.
const SESSION_SCOPED_ENV = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_EMIT_STARTUP_TIMING',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT',
  'CLAUDE_CODE_ENABLE_TASKS',
];

const STDERR_KEEP = 30;
const TEXT_PREVIEW = 1500;
// Bật Remote Control phải nối tới máy chủ Anthropic (đo: 10 giây kể cả lúc Claude Code khởi động): chờ lâu hơn
// các lệnh điều khiển khác. Trạm chờ đầu máy lâu hơn mức này một chút (hub.mjs setRemoteControl).
export const RC_ENABLE_MS = 60000;
const INPUT_PREVIEW = 4000;

// Tìm đúng file chạy của Claude Code. Trên Windows bản cài gốc là claude.exe, bản cài
// qua npm là claude.cmd; file .cmd phải chạy qua vỏ lệnh, file .exe thì không được.
export function resolveClaude(command = process.env.ORBIT_REMOTE_CLAUDE || 'claude') {
  if (command.includes('/') || command.includes('\\')) return command;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  return command;
}

export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of SESSION_SCOPED_ENV) delete env[key];
  return { ...env, ...extra };
}

function clip(text, max) {
  if (typeof text !== 'string') text = text == null ? '' : String(text);
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} ký tự)` : text;
}

// Một dòng ngắn nói công cụ đang làm gì, đủ để đọc trên màn hình điện thoại.
export function summarizeTool(name, input = {}) {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.query
    ?? input.pattern ?? input.description ?? input.prompt ?? input.skill;
  if (pick != null) return clip(String(pick), 300);
  try {
    return clip(JSON.stringify(input), 300);
  } catch {
    return '';
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '[ảnh]' : '')).join('\n');
  }
  return '';
}

// Phiên người dùng tag trong tin (@Tên-phiên, chọn từ danh sách trên app; trạm đã kiểm, hub.mjs resolveMentions):
// một đoạn chỉ Claude đọc, nói đích danh mỗi tag là phiên nào và cách nhắn cho phiên đó. App vẫn chỉ hiện lời gõ.
const RUNNING_STATUS = new Set(['starting', 'idle', 'busy', 'waiting']);
function mentionNote(list) {
  const lines = list.map((m) => {
    const state = RUNNING_STATUS.has(m.status) ? 'đang chạy' : 'đã dừng';
    const where = m.workMachine ? `chạy ở máy ${m.machine}, làm việc trên máy ${m.workMachine}` : `máy ${m.machine}`;
    return `- @${m.tag}: phiên "${m.name}", mã ${m.id}, ${where}, ${state}${m.cwd ? `, thư mục ${m.cwd}` : ''}. Nhắn cho phiên này bằng orbit_remote_send với to: "${m.id}".`;
  });
  return `[Orbit Remote] Tin này tag đích danh các phiên sau (tag là để chỉ đúng phiên đó, không phải phiên khác cùng tên):\n${lines.join('\n')}`;
}

// Một yêu cầu duyệt như app cần để vẽ thẻ: dùng cho sự kiện "permission" và cho trạng thái phiên.
function permissionView(req) {
  return {
    requestId: req.requestId,
    tool: req.tool,
    displayName: req.displayName,
    description: req.description,
    summary: req.summary,
    inputPreview: req.inputPreview,
    canAlways: req.suggestions.length > 0,
    // Câu hỏi nhiều lựa chọn đi qua đúng đường hỏi quyền; app cần nguyên danh sách để vẽ nút.
    questions: req.tool === 'AskUserQuestion' ? req.input?.questions || [] : undefined,
  };
}

export class ClaudeSession extends EventEmitter {
  constructor(spec) {
    super();
    this.id = spec.id || randomUUID();
    this.claudeSessionId = spec.claudeSessionId || randomUUID();
    this.resume = Boolean(spec.resume);
    this.fork = Boolean(spec.fork);
    this.name = spec.name || 'Phiên mới';
    this.cwd = spec.cwd;
    this.model = spec.model || '';
    this.effort = spec.effort || '';
    this.permissionMode = PERMISSION_MODES.includes(spec.permissionMode) ? spec.permissionMode : 'manual';
    this.claudeCommand = spec.claudeCommand;
    this.extraArgs = spec.extraArgs || [];
    this.mcpConfigPath = spec.mcpConfigPath || null;
    this.appendSystemPrompt = spec.appendSystemPrompt || '';
    this.env = spec.env || {};

    this.status = 'starting';
    this.busy = false;
    this.pending = new Map(); // requestId -> yêu cầu quyền đang chờ
    this.controlWaiters = new Map(); // request_id -> { resolve, reject }
    this.costUsd = 0;
    // Cỡ ngữ cảnh: token đầu vào của lần gọi model gần nhất (kể cả phần đọc từ cache), nén xong thì là cỡ sau
    // khi nén. Nhóm phiên dựa vào số này để nén hay xoá ngữ cảnh cho đỡ tốn (groups.mjs).
    this.contextTokens = 0;
    this.lastText = '';
    // Remote Control của Claude Code: điều khiển tiếp phiên này từ claude.ai/code hay app Claude của tài khoản đăng
    // nhập trên máy. Phiên chạy -p (stream-json) nên cờ --remote-control bị bỏ qua (đo trên 2.1.317: không có bản ghi
    // nào); bật bằng lệnh điều khiển remote_control như app Claude Desktop (setRemoteControl). remoteControl: người
    // dùng muốn bật (giữ qua các lần mở lại); rc: trạng thái thật Claude Code báo (bridge_state) và link của phiên.
    this.remoteControl = Boolean(spec.remoteControl);
    this.rc = { state: '', url: '', error: '' };
    this.createdAt = spec.createdAt || new Date().toISOString();
    this.lastActivity = this.createdAt;
    this.exitCode = null;
    this.stderrTail = [];
    this.proc = null;
    this.closing = false;
    this.cancelling = false;
  }

  buildArgs() {
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', this.permissionMode,
      '--allow-dangerously-skip-permissions',
    ];
    if (this.resume) {
      args.push('--resume', this.claudeSessionId);
      if (this.fork) args.push('--fork-session');
    } else {
      args.push('--session-id', this.claudeSessionId);
    }
    if (this.name) args.push('--name', this.name);
    // Tên dòng ("opus", "sonnet", "haiku") đổi ra mã bản mới nhất: tên tắt của Claude Code có thể ra bản cũ (models.mjs).
    if (this.model) args.push('--model', resolveModel(this.model));
    if (this.effort) args.push('--effort', this.effort);
    if (this.mcpConfigPath) args.push('--mcp-config', this.mcpConfigPath);
    if (this.appendSystemPrompt) args.push('--append-system-prompt', this.appendSystemPrompt);
    return args.concat(this.extraArgs);
  }

  start() {
    // Lệnh dạng mảng (["node", "fake-claude.mjs"]) để phép kiểm chạy bản giả mà không cần vỏ lệnh.
    const [command, ...prefix] = Array.isArray(this.claudeCommand)
      ? this.claudeCommand
      : [resolveClaude(this.claudeCommand)];
    const needsShell = /\.(cmd|bat)$/i.test(command);
    // Ép phát trạng thái ngay cả khi vẫn là "starting": trạm phải biết phiên tồn tại TRƯỚC
    // sự kiện đầu tiên của nó, nếu không sự kiện ấy rơi vào khoảng không.
    this.setStatus('starting', true);
    try {
      this.proc = spawn(command, [...prefix, ...this.buildArgs()], {
        cwd: this.cwd,
        env: childEnv(this.env),
        windowsHide: true,
        shell: needsShell,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.fail(`Không chạy được Claude Code: ${err.message}`);
      return;
    }

    this.proc.on('spawn', () => this.setStatus('idle'));
    this.proc.on('error', (err) => this.fail(`Không chạy được Claude Code (${command}): ${err.message}`));
    this.proc.stdin.on('error', () => {}); // tiến trình chết giữa lúc ghi: sự kiện exit lo phần báo
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: this.proc.stderr }).on('line', (line) => {
      if (!line.trim()) return;
      this.stderrTail.push(line.slice(0, 400));
      if (this.stderrTail.length > STDERR_KEEP) this.stderrTail.shift();
    });
    this.proc.on('exit', (code) => this.onExit(code));
    // Không chờ: bật Remote Control mất vài giây (đo: 10 giây kể cả lúc Claude Code khởi động), phiên vẫn nhận lượt
    // đầu ngay. Bật hỏng thì đã ghi vào trạng thái và dòng hội thoại (setRemoteControl).
    if (this.remoteControl) this.setRemoteControl(true).catch(() => {});
  }

  fail(text) {
    this.emitEvent({ t: 'error', text });
    this.exitCode = -1;
    this.setStatus('crashed');
    this.emit('exit', -1);
  }

  write(message) {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || !proc.stdin.writable) return false;
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  // Gửi một lượt người dùng. `from` cho biết nguồn: người dùng trên app, hay một phiên khác.
  // attachments: { images: [{ name, type, file, data }], files: [{ name, type, file, path }] } do đầu
  // máy chuẩn bị; ảnh đi thẳng vào lượt nhắn, tệp khác được nêu đường dẫn để Claude tự đọc. `file` là
  // tên tệp đã lưu trong thư mục của phiên, để app mở lại xem.
  // prefix: chữ đặt trước lời nhắn chỉ cho Claude đọc (tin từ phiên khác được giữ lại, node-agent.mjs); app vẫn
  // hiện đúng lời người gửi viết.
  send(text, from = null, attachments = null, { prefix = '', mentions = null } = {}) {
    const body = String(text || '').trim();
    const images = attachments?.images || [];
    const files = attachments?.files || [];
    if (!body && !images.length && !files.length) return false;
    let prompt = prefix ? `${prefix}\n\n---\n\n${body}` : body;
    const tagged = Array.isArray(mentions) ? mentions.filter((m) => m?.tag && m?.id) : [];
    if (tagged.length) prompt += `\n\n${mentionNote(tagged)}`;
    // Token trong bảng token (custom/tokens.md): nói Claude token đó là gì và tệp đặc tả nằm đâu. Lệnh của Claude Code
    // ("/compact") thì gửi nguyên.
    const tokens = body.startsWith('/') ? '' : tokenNote(prompt);
    if (tokens) prompt += `\n\n${tokens}`;
    if (files.length) {
      prompt += `${prompt ? '\n\n' : ''}Tệp đính kèm (đã lưu trên máy này, đọc bằng công cụ Read):\n${files.map((f) => `- ${f.name}: ${f.path}`).join('\n')}`;
    }
    const content = [{ type: 'text', text: prompt || 'Xem ảnh đính kèm.' }];
    for (const img of images) content.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } });
    if (!this.write({ type: 'user', message: { role: 'user', content } })) {
      return false;
    }
    const list = [...images, ...files].map(({ name, type, file }) => ({ name, type: type || '', ...(file ? { file } : {}) }));
    this.emitEvent({
      t: 'user', text: body, from, ...(list.length ? { attachments: list } : {}), ...(prefix ? { withHeld: true } : {}),
      ...(tagged.length ? { mentions: tagged.map(({ tag, id, name, machine }) => ({ tag, id, name, machine })) } : {}),
    });
    // Tin chen vào lúc đang có lượt (hay đang cắt ngang) không xoá dấu cắt ngang của lượt đó.
    if (!this.busy) this.cancelling = false;
    this.busy = true;
    this.refreshStatus();
    return true;
  }

  control(request, timeoutMs = 15000) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      if (!this.write({ type: 'control_request', request_id: requestId, request })) {
        reject(new Error('Phiên không còn chạy.'));
        return;
      }
      const timer = setTimeout(() => {
        this.controlWaiters.delete(requestId);
        reject(new Error('Claude Code không trả lời lệnh điều khiển.'));
      }, timeoutMs);
      this.controlWaiters.set(requestId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  // Bật hay tắt Remote Control giữa phiên. Đo trên Claude Code 2.1.317: bật thì Claude Code báo bridge_state
  // "ready", trả { session_url, bridge_session_id, ... } rồi báo "connected"; tắt thì thành công, bản ghi Remote
  // Control trong ~/.claude.json mất. Máy không đăng nhập bằng tài khoản Claude (API key) thì Claude Code từ chối.
  async setRemoteControl(on) {
    const enabled = Boolean(on);
    this.remoteControl = enabled;
    if (!enabled) {
      if (this.rc.state || this.rc.url) await this.control({ subtype: 'remote_control', enabled: false });
      this.rc = { state: '', url: '', error: '' };
      this.emitEvent({ t: 'system', text: 'Đã tắt Remote Control.' });
      this.refreshStatus(true);
      return this.rc;
    }
    this.rc = { ...this.rc, state: this.rc.state || 'pending', error: '' };
    this.refreshStatus(true);
    try {
      const r = await this.control({ subtype: 'remote_control', enabled: true }, RC_ENABLE_MS);
      this.rc = { state: this.rc.state === 'connected' ? 'connected' : 'ready', url: String(r.session_url || ''), error: '' };
      this.emitEvent({ t: 'system', text: 'Đã bật Remote Control: điều khiển tiếp phiên này được từ claude.ai/code hay app Claude.' });
      return this.rc;
    } catch (err) {
      this.rc = { state: 'failed', url: '', error: String(err.message || err).slice(0, 300) };
      this.emitEvent({ t: 'system', text: `Không bật được Remote Control: ${this.rc.error}` });
      throw err;
    } finally {
      this.refreshStatus(true);
    }
  }

  async interrupt() {
    if (!this.busy && this.pending.size === 0) return false;
    this.cancelling = true;
    await this.control({ subtype: 'interrupt' });
    return true;
  }

  async setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) throw new Error(`Chế độ quyền không hợp lệ: ${mode}`);
    // Claude Code gọi chế độ hỏi từng lần là "default"; "manual" chỉ là tên dễ đọc của nó.
    await this.control({ subtype: 'set_permission_mode', mode: mode === 'manual' ? 'default' : mode });
    this.permissionMode = mode;
    this.emitEvent({ t: 'system', text: `Đã đổi chế độ quyền sang ${mode}.` });
    this.refreshStatus(true);
  }

  async setModel(model) {
    const id = resolveModel(model);
    await this.control({ subtype: 'set_model', model: id || undefined });
    this.model = model || '';
    if (id) this.activeModel = id;
    this.emitEvent({ t: 'system', text: `Đã đổi model sang ${id ? modelName(id) : 'mặc định'}${id && id !== model ? ` (${id})` : ''}.` });
    this.refreshStatus(true);
  }

  // Đổi mức effort ngay giữa phiên, không khởi động lại. Đã đo trên Claude Code 2.1.283: lệnh
  // apply_flag_settings với effortLevel được nhận, get_settings sau đó báo "applied.effort" đúng mức mới.
  async setEffort(effort) {
    const level = effort || '';
    if (level && !EFFORT_LEVELS.includes(level)) throw new Error(`Mức effort không hợp lệ: ${level}`);
    await this.control({ subtype: 'apply_flag_settings', settings: { effortLevel: level || null } });
    this.effort = level;
    this.emitEvent({ t: 'system', text: `Đã đổi effort sang ${level || 'mặc định'}.` });
    this.refreshStatus(true);
  }

  // decision: { behavior: 'allow' | 'deny', message?, answers?, always? }
  answerPermission(requestId, decision, by = null) {
    const req = this.pending.get(requestId);
    if (!req) return false;
    let response;
    if (decision.behavior === 'allow') {
      const updatedInput = decision.answers ? { ...req.input, answers: decision.answers } : req.input;
      response = { behavior: 'allow', updatedInput };
      if (decision.always && req.suggestions?.length) response.updatedPermissions = req.suggestions;
    } else {
      response = { behavior: 'deny', message: decision.message || 'Người dùng đã từ chối trên Orbit Remote.' };
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.pending.delete(requestId);
    this.emitEvent({ t: 'permission_done', requestId, behavior: decision.behavior, by });
    this.refreshStatus();
    return true;
  }

  close() {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    this.closing = true;
    try {
      proc.stdin.end();
    } catch {
      // stdin đã đóng sẵn
    }
    const killer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill();
    }, 8000);
    killer.unref?.();
  }

  onLine(line) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    this.lastActivity = new Date().toISOString();

    switch (e.type) {
      case 'stream_event': {
        const ev = e.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          this.markBusy();
          this.emit('delta', ev.delta.text);
        }
        return;
      }

      case 'system':
        if (e.subtype === 'init') {
          if (e.session_id) this.claudeSessionId = e.session_id;
          if (e.model) this.activeModel = e.model;
          this.refreshStatus(true);
        } else if (e.subtype === 'status' && e.permissionMode) {
          this.permissionMode = e.permissionMode === 'default' ? 'manual' : e.permissionMode;
          this.refreshStatus(true);
        } else if (e.subtype === 'bridge_state') {
          // Trạng thái đường nối Remote Control: ready, connected, failed (kèm detail), ... Chỉ theo dõi khi đang bật.
          if (!this.remoteControl) return;
          const state = String(e.state || '');
          this.rc = { ...this.rc, state, error: state === 'failed' ? String(e.detail || 'Đường nối Remote Control hỏng.').slice(0, 300) : '' };
          if (state === 'failed') this.emitEvent({ t: 'system', text: `Remote Control mất kết nối: ${this.rc.error}` });
          this.refreshStatus(true);
        } else if (e.subtype === 'compact_boundary') {
          const post = Number(e.compact_metadata?.post_tokens);
          if (post > 0) this.contextTokens = post;
          this.emitEvent({ t: 'system', text: 'Claude đã nén ngữ cảnh.' });
        }
        return;

      case 'conversation_reset':
        // "/clear": Claude Code bắt đầu hội thoại mới (mã phiên mới tới ngay sau trong sự kiện init).
        this.contextTokens = 0;
        this.emitEvent({ t: 'system', text: 'Đã xoá ngữ cảnh, hội thoại bắt đầu lại từ đầu.' });
        return;

      case 'assistant': {
        this.markBusy();
        // Mã model thật của lượt trả lời: app hiện đúng bản đang chạy (đổi model giữa chừng cũng thấy ngay).
        const used = e.message?.model;
        if (used && used !== this.activeModel && /^claude-/.test(used)) {
          this.activeModel = used;
          this.refreshStatus(true);
        }
        const u = e.message?.usage;
        if (u) this.contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        for (const block of e.message?.content || []) {
          if (block.type === 'text' && block.text) {
            this.lastText = clip(block.text, 300);
            this.emitEvent({ t: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            this.emitEvent({ t: 'tool', id: block.id, name: block.name, summary: summarizeTool(block.name, block.input) });
          }
        }
        return;
      }

      case 'user': {
        const content = e.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block?.type === 'tool_result') {
            this.emitEvent({
              t: 'tool_result',
              id: block.tool_use_id,
              ok: !block.is_error,
              preview: clip(resultText(block.content), TEXT_PREVIEW),
            });
          }
        }
        return;
      }

      case 'result': {
        // Chỉ lượt kết thúc vì bị cắt mới dùng dấu cắt ngang: có hai lượt nối đuôi nhau thì lượt trước kết
        // thúc bình thường không được xoá dấu của lượt sau (đã gặp khi phiên vừa mở lại nhận ngay việc mới).
        const cancelled = this.cancelling && e.subtype === 'error_during_execution';
        if (e.subtype === 'error_during_execution') this.cancelling = false;
        this.busy = false;
        if (typeof e.total_cost_usd === 'number') this.costUsd = e.total_cost_usd;
        // Lượt kết thúc thì mọi yêu cầu quyền còn treo đã vô nghĩa.
        this.dropPending('Lượt đã kết thúc.');
        this.emitEvent({
          t: 'result',
          ok: !e.is_error,
          cancelled,
          subtype: e.subtype,
          costUsd: e.total_cost_usd,
          durationMs: e.duration_ms,
          text: cancelled ? '' : clip(e.is_error ? String(e.result || e.subtype || '') : '', 600),
        });
        this.refreshStatus(true);
        return;
      }

      case 'control_request':
        if (e.request?.subtype === 'can_use_tool') this.onPermissionRequest(e.request_id, e.request);
        return;

      case 'control_response': {
        const r = e.response || {};
        const waiter = this.controlWaiters.get(r.request_id);
        if (!waiter) return;
        this.controlWaiters.delete(r.request_id);
        if (r.subtype === 'error') waiter.reject(new Error(r.error || 'Claude Code từ chối lệnh.'));
        else waiter.resolve(r.response || {});
        return;
      }

      default:
    }
  }

  onPermissionRequest(requestId, request) {
    let inputText = '';
    try {
      inputText = JSON.stringify(request.input ?? {}, null, 2);
    } catch {
      inputText = '(không đọc được tham số)';
    }
    const req = {
      requestId,
      tool: request.tool_name,
      displayName: request.display_name || request.tool_name,
      description: request.description || '',
      summary: summarizeTool(request.tool_name, request.input),
      input: request.input ?? {},
      inputPreview: clip(inputText, INPUT_PREVIEW),
      suggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [],
      at: new Date().toISOString(),
    };
    this.pending.set(requestId, req);
    this.emitEvent({ t: 'permission', ...permissionView(req) });
    this.refreshStatus();
  }

  dropPending(reason) {
    for (const requestId of this.pending.keys()) {
      this.emitEvent({ t: 'permission_done', requestId, behavior: 'expired', by: reason });
    }
    this.pending.clear();
  }

  onExit(code) {
    this.exitCode = code;
    this.busy = false;
    this.dropPending('Phiên đã dừng.');
    for (const waiter of this.controlWaiters.values()) waiter.reject(new Error('Phiên đã dừng.'));
    this.controlWaiters.clear();
    const expected = this.closing;
    if (!expected) {
      const tail = this.stderrTail.slice(-6).join('\n');
      this.emitEvent({ t: 'error', text: `Claude Code đã thoát bất ngờ (mã ${code}).${tail ? `\n${tail}` : ''}` });
    } else {
      this.emitEvent({ t: 'system', text: 'Phiên đã đóng.' });
    }
    this.setStatus(expected ? 'stopped' : 'crashed');
    this.emit('exit', code);
  }

  markBusy() {
    if (!this.busy) {
      this.busy = true;
      this.refreshStatus();
    }
  }

  refreshStatus(force = false) {
    if (this.status === 'stopped' || this.status === 'crashed') return;
    const next = this.pending.size > 0 ? 'waiting' : this.busy ? 'busy' : this.status === 'starting' ? 'starting' : 'idle';
    this.setStatus(next, force);
  }

  setStatus(status, force = false) {
    if (status === this.status && !force) return;
    this.status = status;
    this.emit('status', this.snapshot());
  }

  emitEvent(ev) {
    ev.at = new Date().toISOString();
    this.lastActivity = ev.at;
    this.emit('event', ev);
  }

  snapshot() {
    return {
      id: this.id,
      claudeSessionId: this.claudeSessionId,
      name: this.name,
      cwd: this.cwd,
      model: this.model,
      activeModel: this.activeModel || '',
      effort: this.effort,
      permissionMode: this.permissionMode,
      status: this.status,
      costUsd: this.costUsd,
      contextTokens: this.contextTokens,
      lastText: this.lastText,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      // Đủ chi tiết để trạm dựng lại thẻ duyệt khi thẻ gốc đã mất (trạm khởi động lại; hub.mjs restorePending).
      pending: [...this.pending.values()].map(permissionView),
      exitCode: this.exitCode,
      // Có khi người dùng bật, hay lần bật vừa hỏng (để app báo lý do).
      remoteControl: this.remoteControl || this.rc.error ? { on: this.remoteControl, ...this.rc } : null,
    };
  }
}
