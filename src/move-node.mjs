// Phía đầu máy của "Chuyển phiên sang máy khác" (trạm điều phối ở session-move.mjs).
//
// Mã nguồn đi qua git: máy nguồn commit tạm phần sửa dở rồi đẩy lên kho chung, máy đích kéo về (chỉ tua
// nhanh). Hội thoại đi bằng file nhật ký Claude Code tự ghi (~/.claude/projects/<thư mục>/<mã phiên>.jsonl),
// chép từng khúc. Đã đo trên Claude Code 2.1.311: "--resume <mã>" tìm nhật ký theo mã trong mọi thư mục dự
// án, nên đặt file vào thư mục dự án nào trên máy đích cũng làm tiếp được, và lệnh chạy ở thư mục mới.
//
// Không bao giờ lách hook của kho (không --no-verify): hook chặn thì báo lại nguyên văn và gỡ commit tạm.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECTS_DIR } from './transcripts.mjs';

export const CHUNK = 512 * 1024; // một khúc nhật ký: base64 (~700 KB) vẫn dưới giới hạn một lô tin của đường nối
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Không bao giờ chờ người gõ mật khẩu: lệnh git chạy ngầm, không có ai ngồi trước cửa sổ đó.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
const QUICK_MS = 30 * 1000;
const NET_MS = 15 * 60 * 1000; // push chạy cả hook trước push của kho (có kho chạy hook lâu)

function fail(text) {
  throw new Error(text);
}

const tail = (text, n = 700) => (text.length > n ? `…${text.slice(-n)}` : text);

function git(cwd, args, timeout = QUICK_MS) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd, env: GIT_ENV, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim() || err?.message || '' });
    });
  });
}

// Hai địa chỉ remote trỏ cùng một kho: bỏ ".git", đổi dạng ssh "git@host:a/b" về "host/a/b", không phân biệt hoa thường.
export function repoKey(url) {
  const u = String(url || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const scp = /^[^@\s/]+@([^:/]+):(.+)$/.exec(u);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const p = new URL(u);
    if (p.protocol !== 'file:') return `${p.hostname}${p.pathname}`.toLowerCase();
  } catch {
    // đường dẫn thư mục (remote nằm trên đĩa)
  }
  return u.replace(/\\/g, '/').toLowerCase();
}

// Trạng thái git của một thư mục làm việc: có không, có phải kho không, nhánh, commit, upstream, remote,
// số commit chưa đẩy, file chưa commit.
export async function gitInfo(cwd) {
  const dir = String(cwd || '');
  try {
    if (!statSync(dir).isDirectory()) return { exists: false };
  } catch {
    return { exists: false };
  }
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { exists: true, repo: false };
  const [branch, head, up, status, remotesOut] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['rev-parse', 'HEAD']),
    git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    git(dir, ['status', '--porcelain=v1', '-uall']),
    git(dir, ['remote', '-v']),
  ]);
  const remotes = {};
  for (const line of remotesOut.out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m) remotes[m[1]] = m[2];
  }
  const upstream = up.ok ? up.out : '';
  const remote = upstream ? upstream.split('/')[0] : remotes.origin ? 'origin' : Object.keys(remotes)[0] || '';
  const ahead = upstream ? Number((await git(dir, ['rev-list', '--count', `${upstream}..HEAD`])).out) || 0 : null;
  const dirty = status.out ? status.out.split('\n') : [];
  return {
    exists: true,
    repo: true,
    top: top.out,
    branch: branch.out,
    head: head.ok ? head.out : '',
    upstream,
    remote,
    remotes,
    ahead,
    dirty: dirty.length,
    dirtyFiles: dirty.slice(0, 30).map((l) => l.slice(3)),
  };
}

// Máy nguồn: commit tạm mọi thay đổi chưa commit rồi đẩy nhánh hiện tại lên. Hỏng ở đâu thì gỡ commit tạm
// (git reset --mixed) để thư mục trở lại như trước khi bấm chuyển.
export async function wipPush(cwd, { message }) {
  const info = await gitInfo(cwd);
  if (!info.repo) fail('Thư mục ở máy nguồn không phải kho git.');
  if (info.branch === 'HEAD') fail('Kho ở máy nguồn đang không đứng trên nhánh nào (detached HEAD): chuyển sang một nhánh trước.');
  if (!info.remote) fail('Kho ở máy nguồn chưa có remote để đẩy lên.');
  let committed = false;
  if (info.dirty) {
    const add = await git(cwd, ['add', '-A'], NET_MS);
    if (!add.ok) fail(`git add hỏng: ${tail(add.err)}`);
    const commit = await git(cwd, ['commit', '-m', String(message).slice(0, 300)], NET_MS);
    if (!commit.ok) {
      await git(cwd, ['reset', '--mixed', '-q']);
      fail(`git commit hỏng (hook của kho chặn, hay chưa đặt tên người commit?): ${tail(commit.err || commit.out)}`);
    }
    committed = true;
  }
  const needPush = committed || !info.upstream || info.ahead > 0;
  if (needPush) {
    const push = await git(cwd, info.upstream ? ['push'] : ['push', '-u', info.remote, info.branch], NET_MS);
    if (!push.ok) {
      if (committed) await git(cwd, ['reset', '--mixed', '-q', 'HEAD~1']);
      fail(`git push hỏng${committed ? ' (đã gỡ commit tạm, thư mục ở máy nguồn như trước)' : ''}: ${tail(push.err || push.out)}`);
    }
  }
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).out;
  return { committed, files: info.dirty, pushed: needPush, head, branch: info.branch, remote: info.remote, url: info.remotes[info.remote] || '' };
}

// Máy đích: lấy về rồi tua nhanh tới đúng commit máy nguồn vừa đẩy. Thư mục có thay đổi chưa commit hay có
// commit riêng chưa đẩy thì dừng, không đụng vào.
export async function pullTo(cwd, { url, branch, head }) {
  const info = await gitInfo(cwd);
  if (!info.exists) fail('Thư mục ở máy đích không còn.');
  if (!info.repo) fail('Thư mục ở máy đích không phải kho git.');
  if (info.dirty) fail(`Thư mục ở máy đích có ${info.dirty} file chưa commit: commit hay cất đi trước.`);
  const remote = Object.keys(info.remotes).find((name) => repoKey(info.remotes[name]) === repoKey(url));
  if (!remote) fail('Kho ở máy đích không trỏ tới cùng kho với máy nguồn.');
  const fetch = await git(cwd, ['fetch', remote], NET_MS);
  if (!fetch.ok) fail(`git fetch hỏng: ${tail(fetch.err)}`);
  if (info.branch !== branch) {
    const local = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    const co = await git(cwd, local.ok ? ['checkout', branch] : ['checkout', '-b', branch, '--track', `${remote}/${branch}`], NET_MS);
    if (!co.ok) fail(`Không chuyển được sang nhánh ${branch}: ${tail(co.err || co.out)}`);
  }
  const merge = await git(cwd, ['merge', '--ff-only', `${remote}/${branch}`], NET_MS);
  if (!merge.ok) fail(`Không tua nhanh được nhánh ${branch} ở máy đích (có commit riêng chưa đẩy?): ${tail(merge.err || merge.out)}`);
  const now = (await git(cwd, ['rev-parse', 'HEAD'])).out;
  if (head && now !== head) fail(`Máy đích đang ở commit ${now.slice(0, 7)}, khác commit máy nguồn vừa đẩy (${head.slice(0, 7)}).`);
  return { head: now, branch };
}

// ---- Nhật ký phiên của Claude Code --------------------------------------------------------------------
function copiesOf(claudeSessionId) {
  if (!existsSync(PROJECTS_DIR)) return [];
  const out = [];
  for (const dir of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = join(PROJECTS_DIR, dir.name, `${claudeSessionId}.jsonl`);
    if (existsSync(file)) out.push(file);
  }
  return out;
}

// Thư mục dự án theo cách Claude Code đặt tên ("C:\Users\a\Game" → "C--Users-a-Game"). Đặt lệch cũng không sao:
// Claude Code tìm phiên theo mã trong mọi thư mục dự án.
export const projectDirName = (cwd) => String(cwd).replace(/[^A-Za-z0-9-]/g, '-').slice(0, 200) || 'orbit-moved';

export async function readTranscript(claudeSessionId, offset = 0) {
  if (!UUID.test(String(claudeSessionId))) fail('Mã phiên không hợp lệ.');
  // Nhiều bản (đã chuyển qua lại): lấy bản ghi gần nhất.
  const file = copiesOf(claudeSessionId).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!file) fail('Máy nguồn không có nhật ký của phiên này (Claude Code chưa ghi, hay đã bị xoá).');
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, Math.min(size, Math.floor(Number(offset) || 0)));
    const length = Math.min(CHUNK, size - start);
    const buf = Buffer.alloc(length);
    const { bytesRead } = length ? await fh.read(buf, 0, length, start) : { bytesRead: 0 };
    return { size, offset: start, data: buf.subarray(0, bytesRead).toString('base64') };
  } finally {
    await fh.close();
  }
}

// Ghi từng khúc vào file tạm cạnh chỗ đích; khúc cuối thì kiểm đủ cỡ, bỏ các bản cũ của cùng phiên trên máy
// này (để Claude Code không làm tiếp nhầm bản cũ) rồi đổi tên file tạm thành file thật.
export async function writeTranscript({ claudeSessionId, cwd, offset, data, size, final }) {
  if (!UUID.test(String(claudeSessionId))) fail('Mã phiên không hợp lệ.');
  const dir = join(PROJECTS_DIR, projectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const part = join(dir, `${claudeSessionId}.jsonl.part`);
  const at = Math.floor(Number(offset) || 0);
  let have = 0;
  try {
    have = statSync(part).size;
  } catch {
    have = 0;
  }
  if (at !== 0 && at !== have) fail(`Khúc nhật ký tới sai chỗ (${at}, đã có ${have}).`);
  const fh = await open(part, at === 0 ? 'w' : 'a');
  try {
    await fh.write(Buffer.from(String(data || ''), 'base64'));
  } finally {
    await fh.close();
  }
  if (!final) return { written: statSync(part).size };
  const got = statSync(part).size;
  if (Number.isFinite(Number(size)) && got !== Number(size)) {
    rmSync(part, { force: true });
    fail(`Nhật ký chép sang thiếu (${got}/${size} byte).`);
  }
  for (const old of copiesOf(claudeSessionId)) rmSync(old, { force: true });
  const file = join(dir, `${claudeSessionId}.jsonl`);
  renameSync(part, file);
  return { written: got, file };
}
