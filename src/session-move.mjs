// Chuyển một phiên sang máy khác (hay sang thư mục khác): trạm điều phối, đầu máy hai bên làm phần việc của
// mình (move-node.mjs).
//
// Thứ tự: kiểm lại hai máy → đóng phiên ở máy nguồn → commit tạm phần sửa dở và đẩy lên kho chung → máy
// đích kéo về (chỉ tua nhanh) → chép nhật ký phiên của Claude Code từng khúc → mở lại phiên ở máy đích, cùng
// mã phiên của app (nhóm, vai trò, Kênh giữ nguyên). Mỗi bước đẩy một sự kiện "move" cho app theo dõi.
// Hỏng trước khi mở được ở máy đích thì phiên vẫn thuộc máy nguồn (đã dừng), bấm Chạy lại là làm tiếp ở đó.

import { repoKey } from './move-node.mjs';

const RUNNING = new Set(['starting', 'idle', 'busy', 'waiting']);
const GIT_MS = 16 * 60 * 1000; // push và pull: hook trước push của kho có thể chạy vài phút
const CHUNK_MS = 60 * 1000;
const CLOSE_WAIT_MS = 30 * 1000;
const LOG_MAX = 40;

const sameDir = (a, b) => (/^[a-z]:[\\/]/i.test(a) ? a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase() : a === b);
const inside = (dir, top) => {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const t = top.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(d) ? `${d.toLowerCase()}/`.startsWith(`${t.toLowerCase()}/`) : `${d}/`.startsWith(`${t}/`);
};
const size = (bytes) => (bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`);

export class SessionMover {
  constructor(hub) {
    this.hub = hub;
    this.jobs = new Map(); // id phiên -> { state, target, log: [{ step, state, text, at }] }
  }

  rpc(machineId, message, timeoutMs) {
    return this.hub.machineRpc(machineId).request(message, timeoutMs).catch((err) => {
      const m = this.hub.machines.get(machineId);
      if (/không hiểu lệnh/.test(err.message)) throw new Error(`Máy ${m?.alias || m?.name || machineId} cần setup bản Orbit Remote mới để chuyển phiên (bấm Setup máy).`);
      throw err;
    });
  }

  // Kiểm trước, không đổi gì: trả về các bước sẽ làm, điều cần biết và điều chặn không cho chuyển.
  async check(id, { machineId, cwd } = {}) {
    const r = this.hub.record(id);
    const s = r.snap;
    const src = this.hub.machines.get(s.machineId);
    const dst = this.hub.machines.get(machineId);
    const target = String(cwd || '').trim();
    const name = (m) => m?.alias || m?.name || '?';
    const blockers = [];
    const warnings = [];
    const steps = [];
    if (!src?.online) blockers.push(`Máy ${s.machine} đang tắt hay mất kết nối: không lấy được nhật ký và mã nguồn trên đó.`);
    if (!dst) blockers.push('Chọn máy đích.');
    else if (!dst.online) blockers.push(`Máy ${name(dst)} đang tắt hay mất kết nối.`);
    if (!target) blockers.push('Chọn thư mục làm việc ở máy đích.');
    if (!s.claudeSessionId) blockers.push('Phiên chưa có mã phiên Claude Code.');
    // Phiên làm việc trên máy khác (orbit_machine_*): mã nguồn không nằm ở máy chạy phiên nên không có gì để chuyển.
    if (s.remote?.machine) blockers.push(`Phiên này làm việc trên máy ${s.remote.machine}, mã nguồn không ở máy ${s.machine}: không chuyển được. Muốn đổi máy chạy phiên thì mở phiên mới ở máy đó, chọn Làm việc trên máy ${s.remote.machine}.`);
    if (dst && src && dst.id === src.id && target && sameDir(target, s.cwd)) blockers.push('Máy và thư mục đích trùng với chỗ hiện tại.');
    if (this.jobs.get(id)?.state === 'running') blockers.push('Phiên này đang được chuyển.');
    const plan = { ok: false, blockers, warnings, steps, from: { machineId: s.machineId, machine: s.machine, cwd: s.cwd }, to: { machineId, machine: name(dst), cwd: target }, git: null };
    if (blockers.length) return plan;

    const [a, b] = await Promise.all([
      this.rpc(src.id, { op: 'git_info', cwd: s.cwd }),
      this.rpc(dst.id, { op: 'git_info', cwd: target }),
    ]);
    if (!b.exists) blockers.push(`Thư mục ${target} không có trên máy ${name(dst)}: clone kho về đó trước.`);
    if (RUNNING.has(s.status)) {
      steps.push(`Đóng phiên ở máy ${s.machine}${s.status === 'busy' || s.status === 'waiting' ? ' (đang làm dở một lượt: lượt đó bị cắt ngang)' : ''}.`);
    }
    if (a.repo) {
      const url = a.remotes[a.remote] || '';
      if (a.branch === 'HEAD') blockers.push(`Kho ở máy ${s.machine} đang không đứng trên nhánh nào (detached HEAD): chuyển sang một nhánh trước.`);
      if (!url) blockers.push(`Kho ở máy ${s.machine} chưa có remote để đẩy lên.`);
      if (b.exists && !b.repo) blockers.push(`Thư mục ${target} ở máy ${name(dst)} không phải kho git: clone kho về đó trước.`);
      else if (b.repo && url && !Object.values(b.remotes).some((u) => repoKey(u) === repoKey(url))) blockers.push(`Thư mục ở máy ${name(dst)} là một kho khác (không có remote trỏ tới ${url}).`);
      else if (b.repo && b.dirty) blockers.push(`Thư mục ở máy ${name(dst)} có ${b.dirty} file chưa commit: commit hay cất đi trước, để kéo về không đè lên.`);
      plan.git = { branch: a.branch, remote: a.remote, url, dirty: a.dirty, files: a.dirtyFiles, ahead: a.ahead, upstream: a.upstream };
      if (a.dirty) steps.push(`Commit tạm ${a.dirty} file chưa commit ở máy ${s.machine} ("WIP: chuyển phiên…") rồi đẩy lên ${a.remote}/${a.branch}.`);
      else if (!a.upstream) steps.push(`Đẩy nhánh ${a.branch} lên ${a.remote} (nhánh chưa có upstream).`);
      else if (a.ahead) steps.push(`Đẩy ${a.ahead} commit chưa đẩy ở máy ${s.machine} lên ${a.upstream}.`);
      else steps.push(`Máy ${s.machine} không có gì chưa đẩy.`);
      if (b.repo && b.branch && b.branch !== a.branch) steps.push(`Máy ${name(dst)} đang ở nhánh ${b.branch}: chuyển sang nhánh ${a.branch} rồi kéo về (chỉ tua nhanh).`);
      else steps.push(`Máy ${name(dst)} kéo nhánh ${a.branch} về (chỉ tua nhanh).`);
      // Phiên khác cùng máy nguồn đang làm trong cùng kho: phần sửa dở của nó cũng vào commit tạm.
      for (const other of this.hub.sessions.values()) {
        const o = other.snap;
        if (o.id !== id && o.machineId === s.machineId && RUNNING.has(o.status) && o.cwd && inside(o.cwd, a.top)) {
          warnings.push(`Phiên "${o.name}" trên máy ${s.machine} cũng đang làm trong kho này: phần nó đang sửa dở cũng vào commit tạm.`);
        }
      }
    } else {
      warnings.push(`Thư mục ở máy ${s.machine} không phải kho git: chỉ chuyển được hội thoại, mã nguồn ở máy ${name(dst)} bạn tự lo cho khớp.`);
    }
    steps.push(`Chép hội thoại sang máy ${name(dst)} rồi mở lại phiên ở thư mục ${target}.`);
    plan.ok = !blockers.length;
    return plan;
  }

  job(id) {
    return this.jobs.get(id) || null;
  }

  // Bắt đầu chuyển; chạy ngầm, app theo dõi qua sự kiện "move". Trả lời ngay sau khi kiểm xong.
  async start(id, target) {
    const plan = await this.check(id, target);
    if (!plan.ok) throw new Error(plan.blockers.join(' '));
    const job = { id, state: 'running', target: plan.to, from: plan.from, log: [], at: new Date().toISOString() };
    this.jobs.set(id, job);
    this.emit(job, 'check', 'ok', 'Đã kiểm hai máy.');
    this.run(job, plan).catch((err) => this.emit(job, 'error', 'fail', err.message, 'failed'));
    return { ok: true, plan };
  }

  emit(job, step, state, text, final = '') {
    job.log.push({ step, state, text, at: new Date().toISOString() });
    if (job.log.length > LOG_MAX) job.log.shift();
    if (final) job.state = final;
    this.hub.push('move', { id: job.id, state: job.state, step, stepState: state, text, target: job.target });
  }

  async waitStopped(id) {
    const end = Date.now() + CLOSE_WAIT_MS;
    while (RUNNING.has(this.hub.record(id).snap.status)) {
      if (Date.now() > end) throw new Error('Phiên ở máy nguồn không đóng được.');
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async run(job, plan) {
    const hub = this.hub;
    const r = hub.record(job.id);
    const s = r.snap;
    const fromId = s.machineId;
    const toId = plan.to.machineId;

    if (RUNNING.has(s.status)) {
      this.emit(job, 'close', 'run', `Đóng phiên ở máy ${s.machine}…`);
      await hub.close(job.id);
      await this.waitStopped(job.id);
      this.emit(job, 'close', 'ok', `Đã đóng phiên ở máy ${s.machine}.`);
    }

    let head = '';
    if (plan.git) {
      const g = plan.git;
      this.emit(job, 'push', 'run', g.dirty ? `Commit tạm ${g.dirty} file rồi đẩy lên ${g.remote}/${g.branch} (hook của kho có thể chạy vài phút)…` : `Đẩy nhánh ${g.branch} lên ${g.remote}…`);
      let pushed;
      try {
        pushed = await this.rpc(fromId, { op: 'move_push', cwd: s.cwd, message: `WIP: chuyển phiên "${s.name}" từ máy ${s.machine} sang máy ${plan.to.machine}` }, GIT_MS);
      } catch (err) {
        throw new Error(`${err.message} Phiên vẫn ở máy ${s.machine} (đã dừng): bấm Chạy lại để làm tiếp ở đó.`);
      }
      head = pushed.head;
      this.emit(job, 'push', 'ok', pushed.committed
        ? `Đã commit tạm ${pushed.files} file (${head.slice(0, 7)}) và đẩy lên ${pushed.remote}/${pushed.branch}.`
        : pushed.pushed ? `Đã đẩy nhánh ${pushed.branch} (${head.slice(0, 7)}).` : `Không có gì cần đẩy (${head.slice(0, 7)}).`);
      this.emit(job, 'pull', 'run', `Máy ${plan.to.machine} kéo nhánh ${g.branch} về…`);
      try {
        await this.rpc(toId, { op: 'move_pull', cwd: plan.to.cwd, url: g.url, branch: g.branch, head }, GIT_MS);
      } catch (err) {
        throw new Error(`${err.message} Mã đã đẩy lên kho (commit ${head.slice(0, 7)}); phiên vẫn ở máy ${s.machine} (đã dừng): bấm Chạy lại để làm tiếp ở đó, hay sửa chỗ hỏng ở máy đích rồi chuyển lại.`);
      }
      this.emit(job, 'pull', 'ok', `Máy ${plan.to.machine} đã ở đúng commit ${head.slice(0, 7)}.`);
    }

    this.emit(job, 'transcript', 'run', 'Chép hội thoại…');
    let offset = 0;
    let total = 0;
    do {
      const part = await this.rpc(fromId, { op: 'transcript_read', claudeSessionId: s.claudeSessionId, offset }, CHUNK_MS);
      total = part.size;
      const bytes = Buffer.byteLength(part.data, 'base64');
      const final = offset + bytes >= total;
      await this.rpc(toId, { op: 'transcript_write', claudeSessionId: s.claudeSessionId, cwd: plan.to.cwd, offset, data: part.data, size: total, final }, CHUNK_MS);
      offset += bytes;
      if (!bytes && !final) throw new Error('Nhật ký đọc ra rỗng giữa chừng.');
    } while (offset < total);
    this.emit(job, 'transcript', 'ok', `Đã chép hội thoại (${size(total)}).`);

    this.emit(job, 'open', 'run', `Mở lại phiên ở máy ${plan.to.machine}…`);
    const movedFrom = { machine: s.machine, cwd: s.cwd, at: new Date().toISOString() };
    const dst = hub.machines.get(toId);
    r.snap = { ...r.snap, machineId: toId, machine: dst.alias || dst.name, cwd: plan.to.cwd, movedFrom };
    hub.push('session', hub.publicSession(r));
    hub.scheduleSave();
    try {
      await hub.createSession(toId, {
        id: s.id, name: s.name, cwd: plan.to.cwd, model: s.model, effort: s.effort, permissionMode: s.permissionMode, remoteControl: Boolean(s.remoteControl?.on),
        resume: true, claudeSessionId: s.claudeSessionId, movedFrom,
      });
    } catch (err) {
      throw new Error(`${err.message} Hội thoại và mã nguồn đã ở máy ${plan.to.machine}: bấm Chạy lại để mở phiên ở đó.`);
    }
    this.emit(job, 'open', 'ok', `Phiên đã chạy ở máy ${plan.to.machine}, thư mục ${plan.to.cwd}.`, 'done');
  }
}
