// Tài khoản Claude của Claude Code trên máy này: xem đang đăng nhập ai, và đăng nhập (hay đổi tài khoản) ngay từ app.
//
// Đo trên Claude Code 2.1.317:
// - "claude auth status --json" trả { loggedIn, authMethod, email, orgName, subscriptionType, ... }.
// - "claude auth login --claudeai" chạy qua ống (không có màn hình dòng lệnh) thì in "Opening browser to sign in…",
//   một link đăng nhập (redirect về platform.claude.com/oauth/code/callback, trang này hiện mã cho người dùng chép),
//   rồi chờ "Paste code here if prompted >". Mã phải gõ vào đúng tiến trình đã sinh link (mã gắn với tiến trình đó).
// - Mã sai: in "Login failed: That code wasn't accepted…" và thoát 1; đăng nhập cũ không đổi.
// - BROWSER=none: không bật trình duyệt trên máy (đo: không có cửa sổ trình duyệt nào mở ra).
//
// Nên đầu máy giữ tiến trình đăng nhập chạy, đưa link cho app, người dùng đăng nhập trên điện thoại rồi dán mã trên
// app, đầu máy gõ mã vào và đọc lại trạng thái. Mỗi máy một lượt đăng nhập; quá LOGIN_TTL_MS thì tự huỷ.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { childEnv, resolveClaude } from './claude-session.mjs';

const STATUS_MS = 20000;
const URL_WAIT_MS = 20000;
export const CODE_WAIT_MS = 60000;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const OUT_KEEP = 8000;

// command: lệnh Claude Code của đầu máy, chuỗi ("claude") hay mảng (["node", "fake-claude.mjs"] khi kiểm).
function launch(command, args) {
  const [cmd, ...prefix] = Array.isArray(command) ? command : [resolveClaude(command)];
  return spawn(cmd, [...prefix, ...args], {
    env: childEnv({ BROWSER: 'none' }),
    windowsHide: true,
    shell: /\.(cmd|bat)$/i.test(cmd),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const lastLine = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';

// { loggedIn, method, email, org, plan }. Không chạy được Claude Code thì ném lỗi rõ.
export function authStatus(command) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = launch(command, ['auth', 'status', '--json']);
    } catch (err) {
      reject(new Error(`Không chạy được Claude Code: ${err.message}`));
      return;
    }
    let out = '';
    let err = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdin.end();
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Claude Code không trả lời lệnh xem tài khoản.'));
    }, STATUS_MS);
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Không chạy được Claude Code: ${e.message}`));
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.slice(out.indexOf('{')));
        resolve({
          loggedIn: Boolean(j.loggedIn),
          method: String(j.authMethod || ''),
          email: String(j.email || ''),
          org: String(j.orgName || ''),
          plan: String(j.subscriptionType || ''),
        });
      } catch {
        reject(new Error(lastLine(err) || lastLine(out) || 'Claude Code trả trạng thái tài khoản lạ.'));
      }
    });
  });
}

export class ClaudeLogin {
  constructor(command, { onDone = null } = {}) {
    this.command = command;
    this.onDone = onDone; // gọi khi đăng nhập xong (đầu máy xoá số liệu usage đã nhớ của tài khoản cũ)
    this.job = null;
  }

  // Mở một lượt đăng nhập: { id, url }. Lượt cũ (nếu còn) bị huỷ.
  async start({ email = '' } = {}) {
    this.cancel();
    const args = ['auth', 'login', '--claudeai'];
    const mail = String(email || '').trim();
    if (mail) {
      if (mail.length > 200 || !/^[^\s@]+@[^\s@]+$/.test(mail)) throw new Error('Email không hợp lệ.');
      args.push('--email', mail);
    }
    const proc = launch(this.command, args);
    const job = { id: randomBytes(6).toString('hex'), proc, out: '', url: '', exitCode: undefined };
    this.job = job;
    job.exited = new Promise((resolve) => {
      proc.on('exit', (code) => {
        job.exitCode = code;
        resolve(code);
      });
      proc.on('error', (e) => {
        job.out += `\n${e.message}`;
        job.exitCode = -1;
        resolve(-1);
      });
    });
    const onData = (d) => {
      job.out = (job.out + d).slice(-OUT_KEEP);
      if (!job.url) job.url = /https:\/\/\S*oauth\S*/.exec(job.out)?.[0] || '';
    };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.stdin.on('error', () => {});
    job.timer = setTimeout(() => this.cancel(job.id), LOGIN_TTL_MS);
    const until = Date.now() + URL_WAIT_MS;
    while (!job.url && job.exitCode === undefined && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    if (!job.url) {
      this.cancel(job.id);
      throw new Error(lastLine(job.out) || 'Claude Code không đưa link đăng nhập.');
    }
    return { id: job.id, url: job.url };
  }

  // Gõ mã người dùng chép từ trang đăng nhập vào đúng tiến trình đã sinh link, chờ kết quả, đọc lại trạng thái.
  async code(id, code) {
    const job = this.job;
    if (!job || job.id !== id) throw new Error('Lượt đăng nhập này đã hết (quá 10 phút hay đã huỷ): bấm Đăng nhập để lấy link mới.');
    const clean = String(code || '').trim();
    if (!clean || clean.length > 2000 || /\s/.test(clean)) throw new Error('Mã không hợp lệ: chép đúng cả dòng mã trang đăng nhập hiện ra.');
    if (job.exitCode !== undefined) {
      this.cancel(id);
      throw new Error(lastLine(job.out) || 'Lượt đăng nhập đã dừng: bấm Đăng nhập để lấy link mới.');
    }
    job.proc.stdin.write(`${clean}\n`);
    const exit = await Promise.race([job.exited, new Promise((r) => setTimeout(() => r('timeout'), CODE_WAIT_MS))]);
    this.cancel(id);
    if (exit !== 0) {
      const why = /Login failed:[^\r\n]*/.exec(job.out)?.[0] || lastLine(job.out);
      throw new Error(exit === 'timeout' ? 'Claude Code không trả lời sau khi nhận mã.' : why || 'Đăng nhập không thành công.');
    }
    const status = await authStatus(this.command);
    this.onDone?.(status);
    return status;
  }

  cancel(id = '') {
    const job = this.job;
    if (!job || (id && job.id !== id)) return false;
    this.job = null;
    clearTimeout(job.timer);
    if (job.exitCode === undefined) {
      try {
        job.proc.kill();
      } catch {
        // đã thoát
      }
    }
    return true;
  }
}
