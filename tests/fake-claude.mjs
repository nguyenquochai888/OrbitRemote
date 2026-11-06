#!/usr/bin/env node
// Bản giả của Claude Code ở chế độ stream-json, nói đúng những gì bản thật đã được đo:
// sự kiện init, mẩu chữ chảy, khối assistant, hỏi quyền bằng can_use_tool, đổi chế độ quyền,
// cắt ngang lượt, và thoát khi stdin đóng. Dùng cho phép kiểm, không tốn token nào.
//
// Câu người dùng chứa:
//   WRITE  → xin quyền dùng Write, chờ trả lời, báo lại kết quả
//   ASK    → hỏi một câu nhiều lựa chọn qua AskUserQuestion, báo lại lựa chọn
//   SLEEP  → chạy lì cho tới khi bị cắt ngang
//   EFFORT → báo mức effort đang áp dụng (đổi bằng apply_flag_settings)
//   lượt có ảnh đính kèm → câu trả lời kèm "ảnh: <số ảnh>"
//   BIGCTX → ngữ cảnh (usage của khối assistant) nhảy lên 150k token
//   /compact [hướng] → nén ngữ cảnh còn 6k như bản thật (status compacting, compact_boundary)
//   /clear → xoá ngữ cảnh như bản thật: conversation_reset, mã phiên mới, init lại
//   còn lại → trả lời "echo: <câu>"
// Lệnh điều khiển remote_control bật/tắt Remote Control như bản thật (FAKE_RC_FAIL=1: báo lỗi như máy không đăng
// nhập bằng tài khoản Claude).

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argAfter = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
// "auth status --json" và "auth login" như bản thật (đo trên 2.1.317). Trạng thái đăng nhập giả nằm trong một tệp
// cạnh trạng thái của Orbit; mã đúng là "ma-dung#trang-thai", mã khác thì báo lỗi như bản thật.
if (args[0] === 'auth') {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const file = join(process.env.ORBIT_REMOTE_STATE || process.cwd(), 'fake-claude-auth.json');
  const read = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return { loggedIn: true, authMethod: 'claude.ai', email: 'cu@example.com', orgName: 'Tổ chức cũ', subscriptionType: 'max' };
    }
  };
  if (args[1] === 'status') {
    process.stdout.write(`${JSON.stringify({ ...read(), apiProvider: 'firstParty' }, null, 2)}\n`);
    process.exit(0);
  }
  if (args[1] === 'login') {
    const hint = argAfter('--email');
    process.stdout.write('Opening browser to sign in…\n');
    process.stdout.write(`If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback${hint ? `&login_hint=${encodeURIComponent(hint)}` : ''}&state=fake\n`);
    process.stdout.write('Paste code here if prompted > ');
    createInterface({ input: process.stdin }).once('line', (line) => {
      if (line.trim() === 'ma-dung#trang-thai') {
        writeFileSync(file, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: hint || 'moi@example.com', orgName: 'Tổ chức mới', subscriptionType: 'pro' }));
        process.stdout.write('\nLogin successful.\n');
        process.exit(0);
      }
      process.stderr.write("Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n");
      process.exit(1);
    });
    await new Promise(() => {}); // chờ mã; không chạy tiếp phần phiên stream-json bên dưới
  }
  process.exit(1);
}
let sessionId = argAfter('--session-id') || argAfter('--resume') || randomUUID();
// Như bản thật: "--resume" một mã chưa có nhật ký (phiên chưa từng có lượt nào) thì báo lỗi rồi thoát ngay.
const projects = process.env.ORBIT_REMOTE_PROJECTS;
if (argAfter('--resume') && projects && !(existsSync(projects) && readdirSync(projects, { withFileTypes: true })
  .some((d) => d.isDirectory() && existsSync(join(projects, d.name, `${sessionId}.jsonl`))))) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
}
let mode = argAfter('--permission-mode') === 'manual' ? 'default' : argAfter('--permission-mode') || 'default';
let cost = 0;
let initDone = false;
let sleeping = null;
let effort = argAfter('--effort') || '';
// Như bản thật: lượt trả lời mang mã model đang chạy (mã đầy đủ khi được mở bằng --model hay đổi bằng set_model).
let model = argAfter('--model') || 'fake-model';
let lastImages = 0; // số ảnh trong lượt người dùng gần nhất
let interruptPending = false; // lệnh cắt tới trước khi lượt kịp bắt đầu
const waitingPermission = new Map();
let context = 30000; // token đầu vào của lần gọi model gần nhất: lời dặn hệ thống, công cụ, hội thoại

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const assistantText = (text) => out({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text }], usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: context, output_tokens: 20 } } });
const result = (extra = {}) => {
  cost += 0.01;
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, duration_ms: 5, result: '', ...extra });
};

async function turn(text) {
  if (!initDone) {
    initDone = true;
    out({ type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode: mode });
  }
  // Lệnh của Claude Code: không gọi model, như bản thật đo ngày 2026-11-02.
  if (/^\/compact\b/.test(text)) {
    out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId });
    out({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, compact_metadata: { trigger: 'manual', pre_tokens: context, post_tokens: 6000 } });
    context = 6000;
    result({ num_turns: 0 });
    return;
  }
  if (/^\/clear\b/.test(text)) {
    sessionId = randomUUID();
    out({ type: 'conversation_reset', new_conversation_id: sessionId, trigger: 'clear', session_id: sessionId });
    out({ type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode: mode });
    context = 30000;
    result({ num_turns: 0 });
    return;
  }
  context = text.includes('BIGCTX') ? 150000 : context + 2000 + text.length;
  if (text.includes('WRITE')) {
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    const input = { file_path: 'a.txt', content: 'one' };
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Write', input }] } });
    let verdict = { behavior: 'allow' };
    if (mode !== 'bypassPermissions' && mode !== 'acceptEdits') {
      const requestId = randomUUID();
      verdict = await new Promise((resolve) => {
        waitingPermission.set(requestId, resolve);
        out({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input, description: 'a.txt',
            permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], tool_use_id: toolUseId,
          },
        });
      });
      if (verdict === null) return; // bị cắt ngang
    }
    const ok = verdict.behavior === 'allow';
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: !ok, content: ok ? 'File created' : verdict.message }] } });
    assistantText(ok ? 'done: allowed' : 'done: denied');
    result();
    return;
  }
  if (text.includes('ASK')) {
    const requestId = randomUUID();
    const input = { questions: [{ question: 'Chọn màu?', header: 'Màu', multiSelect: false, options: [
      { label: 'Đỏ', description: 'Màu đỏ' }, { label: 'Xanh', description: 'Màu xanh' }] }] };
    const verdict = await new Promise((resolve) => {
      waitingPermission.set(requestId, resolve);
      out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: 'toolu_ask' } });
    });
    if (verdict === null) return;
    assistantText(verdict.behavior === 'allow' ? `chọn: ${Object.values(verdict.updatedInput.answers || {}).join(', ')}` : 'bỏ qua');
    result();
    return;
  }
  if (text.includes('SLEEP')) {
    if (!interruptPending) {
      await new Promise((resolve) => {
        sleeping = resolve;
      });
    }
    interruptPending = false;
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: cost });
    return;
  }
  let reply = text.includes('EFFORT') ? `effort: ${effort || 'mặc định'}` : `echo: ${text}`;
  if (lastImages) reply += ` | ảnh: ${lastImages}`;
  for (const piece of [reply.slice(0, 4), reply.slice(4)]) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
  }
  assistantText(reply);
  result();
}

let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'user') {
    const text = m.message.content.map((b) => b.text || '').join('');
    lastImages = m.message.content.filter((b) => b.type === 'image' && b.source?.data).length;
    chain = chain.then(() => turn(text));
  } else if (m.type === 'control_response') {
    const resolve = waitingPermission.get(m.response.request_id);
    if (resolve) {
      waitingPermission.delete(m.response.request_id);
      resolve(m.response.response);
    }
  } else if (m.type === 'control_request') {
    const r = m.request;
    if (r.subtype === 'set_permission_mode') {
      mode = r.mode;
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { mode } } });
      out({ type: 'system', subtype: 'status', permissionMode: mode, session_id: sessionId });
    } else if (r.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } } });
      if (sleeping) {
        sleeping();
        sleeping = null;
      } else if (!waitingPermission.size) {
        interruptPending = true;
      }
      for (const resolve of waitingPermission.values()) resolve(null);
      if (waitingPermission.size) {
        waitingPermission.clear();
        out({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: cost });
      }
    } else if (r.subtype === 'apply_flag_settings') {
      effort = r.settings?.effortLevel || '';
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    } else if (r.subtype === 'set_model') {
      model = r.model || 'fake-model';
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    } else if (r.subtype === 'remote_control') {
      // Như bản thật (đo trên Claude Code 2.1.317): bật thì bridge_state "ready", trả session_url, rồi "connected";
      // tắt thì trả thành công không kèm gì. FAKE_RC_FAIL: máy không đăng nhập bằng tài khoản Claude.
      if (process.env.FAKE_RC_FAIL && r.enabled) {
        out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Remote Control requires a claude.ai subscription.' } });
      } else if (r.enabled) {
        const bridge = `cse_fake${sessionId.slice(0, 8)}`;
        out({ type: 'system', subtype: 'bridge_state', state: 'ready', session_id: sessionId });
        out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { session_url: `https://claude.ai/code/session_${bridge}`, connect_url: 'https://claude.ai/code?environment=', environment_id: '', bridge_epoch: 1, bridge_session_id: bridge } } });
        out({ type: 'system', subtype: 'bridge_state', state: 'connected', bridge_epoch: 1, session_id: sessionId });
      } else {
        out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
      }
    }
  }
}).on('close', () => {
  chain.then(() => process.exit(0));
});
