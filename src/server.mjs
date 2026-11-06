// Lớp HTTP của trạm: phục vụ app, API, luồng sự kiện cho app, và đường nối cho đầu máy.
//
// Không dùng thư viện ngoài. Luồng sự kiện là SSE (server-sent events): Safari trên iPhone
// hỗ trợ sẵn, tự nối lại khi rớt mạng, và đi qua mọi proxy như HTTP thường. Chiều ngược
// lại (app gửi lệnh) là POST JSON bình thường.
//
// Chống giả mạo yêu cầu từ trang khác: mọi POST phải mang Content-Type JSON (trình duyệt
// không tự gửi loại này sang miền khác khi chưa xin phép, mà trạm không bao giờ cho phép),
// và cookie đặt SameSite=Lax.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { CUSTOM_DIR, WEB_DIR, writeJsonAtomic } from './paths.mjs';
import { listTokens } from './tokens.mjs';
import { modelsView } from './models.mjs';

const COOKIE = 'orbit_remote_token';
const BODY_LIMIT = 1024 * 1024;
// Lượt nhắn có tệp đính kèm (base64): tối đa 8 tệp, đủ cho vài ảnh chụp màn hình điện thoại.
const SEND_LIMIT = 16 * 1024 * 1024;
// Một lô tin từ đầu máy ở xa (đã có thẻ đầu máy). Đầu máy tự chia lô quanh 768 KB (remote-link.mjs),
// nhưng một tin riêng lẻ vẫn có thể lớn hơn (lịch sử dài của một phiên): quá mức là đứt đường nối.
const NODE_PUSH_LIMIT = 16 * 1024 * 1024;
const ATTACH_MAX = 8;
const SSE_PING_MS = 20000;
// Tệp đính kèm mở lại trên app. Chỉ loại trình duyệt tự hiện mà không chạy mã mới mở tại chỗ; mọi loại
// chữ (kể cả html, svg) trả về dạng chữ trơn; loại khác chỉ cho tải về.
const ATTACH_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
};
const ATTACH_TEXT = new Set(('.txt .md .json .jsonl .csv .tsv .log .xml .yaml .yml .ini .cfg .conf .toml .env .js .mjs .cjs .ts .tsx .jsx '
  + '.py .cs .c .h .cpp .hpp .java .kt .swift .go .rs .rb .php .lua .sh .ps1 .psm1 .bat .cmd .sql .html .htm .css .scss .svg '
  + '.shader .hlsl .cginc .compute .uss .uxml .asmdef .meta .prefab .unity .asset .mat .anim .controller .gradle .diff .patch').split(' '));
const ATTACH_TOTAL_MAX = 64 * 1024 * 1024;

function attachmentType(file) {
  const ext = extname(file).toLowerCase();
  return ATTACH_TEXT.has(ext) ? 'text/plain; charset=utf-8' : ATTACH_TYPES[ext] || '';
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// extraConnect: thêm đúng một nguồn được phép gọi tới (địa chỉ HTTPS riêng của trạm), để trang
// cài chứng chỉ mở bằng HTTP mạng nhà thử được địa chỉ an toàn đã dùng được chưa.
// blob: ở ảnh, khung và media: xem trước tệp đính kèm chưa gửi (còn nằm trong bộ nhớ của app).
const csp = (extraConnect = '') => `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'${extraConnect ? ` ${extraConnect}` : ''}; frame-ancestors 'none'`;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': csp(),
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

function tokenOf(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return parseCookies(req.headers.cookie)[COOKIE] || '';
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

async function readBody(req, limit = BODY_LIMIT) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Chỉ nhận JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Nội dung quá lớn.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON hỏng.');
  }
}

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });
  res.write('retry: 3000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
  res.on('close', () => clearInterval(ping));
}

async function serveStatic(res, root, rel, extraConnect = '') {
  const full = normalize(join(root, rel));
  if (!full.startsWith(normalize(root) + sep)) throw new HttpError(404, 'Không có.');
  let data;
  try {
    data = await readFile(full);
  } catch {
    throw new HttpError(404, 'Không có.');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
    // App nhỏ và hay đổi; luôn hỏi lại máy chủ. Service worker tự lo chạy khi mất mạng.
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
    'Content-Security-Policy': csp(extraConnect),
  });
  res.end(data);
}

export function createServer({ hub, auth, localSecret, version, hubInfo = () => ({}), onLocalShutdown = null, onRestart = null, localClip = null }) {
  const appClients = new Set();
  const nodeLinks = new Map(); // linkId -> { receive, disconnect }

  const fullState = () => ({ ...hub.state(), enrollments: auth.pendingEnrollments(), hub: hubInfo() });
  // Nguồn trang app được phép gọi thêm: cổng màn hình của các máy (điện thoại nối thẳng tới máy bằng
  // WebSocket khi xem màn hình).
  const pageConnect = () => hub.screenSources().filter(Boolean).join(' ');
  const pushEnrollments = () => hub.push('enrollments', auth.pendingEnrollments());

  hub.on('push', (type, data) => {
    if (!appClients.size) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of appClients) res.write(frame);
  });

  const broadcast = (type, data) => hub.push(type, data);

  // Phát một tệp từ máy chạy phiên: đọc từng khúc (đầu máy ở xa gửi về qua lô tin giới hạn 1 MB) và ghi thẳng ra
  // câu trả lời, không gom cả tệp vào bộ nhớ trạm. Nhận một khoảng "Range" để video trên iPhone tua và phát được.
  // read(offset, head): một khúc { size, offset, data, mtime }; head thì chỉ cỡ và giờ sửa. name: tên tệp (chọn kiểu
  // nội dung theo đuôi). fixed: tệp không bao giờ đổi (tệp đã gửi), trình duyệt giữ lâu; không thì giữ theo ETag (cỡ,
  // giờ sửa) và hỏi lại mỗi lần, vì Claude hay ghi đè ảnh cùng tên. oldMsg: báo khi đầu máy là bản cũ.
  async function sendRemoteFile(req, res, { read, name, fixed, oldMsg }) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    let start = range && range[1] ? Number(range[1]) : 0;
    const ask = async (offset, head = false) => {
      try {
        return await read(offset, head);
      } catch (err) {
        if (/không hiểu lệnh/.test(err.message)) throw new HttpError(501, oldMsg);
        throw new HttpError(404, err.message);
      }
    };
    const etagOf = (p) => `"${Number(p.size) || 0}-${Number(p.mtime) || 0}"`;
    const cache = fixed ? { 'Cache-Control': 'private, max-age=604800, immutable' } : { 'Cache-Control': 'private, no-cache' };
    if (!fixed && !range && req.headers['if-none-match']) {
      const st = await ask(0, true);
      if (req.headers['if-none-match'] === etagOf(st)) {
        res.writeHead(304, { ETag: etagOf(st), ...cache, ...SECURITY_HEADERS });
        res.end();
        return undefined;
      }
    }
    let part = await ask(start);
    const size = Number(part.size) || 0;
    if (size > ATTACH_TOTAL_MAX) throw new HttpError(413, 'Tệp quá lớn để mở trên app.');
    let end = size - 1;
    if (range) {
      if (!range[1] && range[2]) start = Math.max(0, size - Number(range[2])); // "bytes=-500": 500 byte cuối
      else if (range[2]) end = Math.min(end, Number(range[2]));
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...SECURITY_HEADERS });
        res.end();
        return undefined;
      }
      if (start !== Number(part.offset)) part = await ask(start);
    }
    const type = attachmentType(name);
    res.writeHead(range ? 206 : 200, {
      'Content-Type': type || 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      ...cache,
      ...(fixed ? {} : { ETag: etagOf(part) }),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Tệp từ máy (người dùng gửi lên, hay Claude tạo ra) không bao giờ được chạy mã trên nguồn của trạm (sandbox).
      // PDF thì để ngoài hộp cát vì trình xem PDF của trình duyệt không mở trong đó, mà PDF cũng không chạy mã trang.
      'Content-Security-Policy': `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'${type === 'application/pdf' ? '' : '; sandbox'}`,
    });
    const drained = () => new Promise((resolve) => {
      const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
      res.on('drain', done);
      res.on('close', done);
    });
    try {
      for (let at = start; at <= end;) {
        const chunk = Buffer.from(String(part.data || ''), 'base64').subarray(0, end - at + 1);
        if (!chunk.length) throw new Error('Tệp ngắn hơn đã báo.');
        if (!res.write(chunk)) await drained();
        if (res.destroyed) return undefined;
        at += chunk.length;
        if (at <= end) part = await read(at);
      }
      res.end();
    } catch {
      res.destroy();
    }
    return undefined;
  }

  // Tệp đính kèm đã gửi trong phiên.
  const sendAttachment = (req, res, id, file) => sendRemoteFile(req, res, {
    read: (offset) => hub.readAttachment(id, file, offset),
    name: file.replace(/^[0-9a-z]+-/, ''),
    fixed: true,
    oldMsg: 'Máy chạy phiên này cần setup bản Orbit Remote mới để mở tệp đính kèm.',
  });

  // Tệp trên máy chạy phiên mà Claude nhắc tới trong lời của phiên (link file:///, đường dẫn tuyệt đối).
  const sendSessionFile = (req, res, id, path) => sendRemoteFile(req, res, {
    read: (offset, head) => hub.readSessionFile(id, path, offset, head),
    name: path.split(/[\\/]/).pop() || 'tep',
    fixed: false,
    oldMsg: 'Máy chạy phiên này cần setup bản Orbit Remote mới để mở tệp phiên nhắc tới.',
  });

  async function api(req, res, url, device) {
    const path = url.pathname;
    const parts = path.split('/').filter(Boolean); // ['api', ...]
    const method = req.method;
    const by = device ? { kind: 'user', name: device.name } : null;

    if (method === 'GET' && path === '/api/state') {
      return sendJson(res, 200, { ...fullState(), me: { id: device.id, name: device.name }, version });
    }

    if (method === 'GET' && path === '/api/stream') {
      openSse(res);
      res.write(`event: state\ndata: ${JSON.stringify(fullState())}\n\n`);
      appClients.add(res);
      res.on('close', () => appClients.delete(res));
      return undefined;
    }

    if (parts[1] === 'sessions') {
      const id = parts[2];
      const action = parts[3];
      if (method === 'POST' && !id) {
        const body = await readBody(req);
        const snap = await hub.createSession(body.machineId, { ...body, from: by });
        return sendJson(res, 200, snap);
      }
      if (method === 'GET' && id && action === 'events') {
        return sendJson(res, 200, await hub.events(id, Number(url.searchParams.get('after')) || 0));
      }
      if (method === 'GET' && id && action === 'attachment') {
        return sendAttachment(req, res, id, url.searchParams.get('f') || '');
      }
      if (method === 'GET' && id && action === 'file') {
        return sendSessionFile(req, res, id, String(url.searchParams.get('p') || '').slice(0, 1000));
      }
      // Lần chuyển máy gần nhất của phiên (session-move.mjs): app mở lại bảng chuyển thì thấy tiếp tiến độ.
      if (method === 'GET' && id && action === 'move') {
        return sendJson(res, 200, { job: hub.mover.job(id) });
      }
      if (method === 'POST' && id) {
        const body = await readBody(req, action === 'send' ? SEND_LIMIT : BODY_LIMIT);
        switch (action) {
          case 'send': {
            const attachments = Array.isArray(body.attachments)
              ? body.attachments.slice(0, ATTACH_MAX).map((a) => ({ name: String(a?.name || ''), type: String(a?.type || ''), data: String(a?.data || '') }))
              : null;
            return sendJson(res, 200, { ok: await hub.sendToSession(id, body.text, by, attachments, body.mentions) });
          }
          case 'effort':
            return sendJson(res, 200, await hub.setEffort(id, body.effort));
          case 'remote-control':
            try {
              return sendJson(res, 200, await hub.setRemoteControl(id, body.enabled));
            } catch (err) {
              if (/không hiểu lệnh/.test(err.message)) throw new HttpError(501, 'Máy chạy phiên này cần setup bản Orbit Remote mới để bật Remote Control.');
              throw new HttpError(409, err.message);
            }
          case 'interrupt':
            return sendJson(res, 200, { ok: await hub.interrupt(id) });
          case 'close':
            return sendJson(res, 200, { ok: await hub.close(id) });
          case 'resume':
            return sendJson(res, 200, await hub.resume(id));
          case 'forget':
            return sendJson(res, 200, { ok: hub.forget(id) });
          case 'rename':
            return sendJson(res, 200, hub.rename(id, body.name));
          case 'mode':
            return sendJson(res, 200, await hub.setMode(id, body.mode));
          case 'model':
            return sendJson(res, 200, await hub.setModel(id, body.model));
          // Chuyển phiên sang máy khác: kiểm trước (không đổi gì), rồi bắt đầu chuyển (chạy ngầm, theo dõi qua SSE "move").
          case 'move-check':
            return sendJson(res, 200, await hub.mover.check(id, { machineId: String(body.machineId || ''), cwd: String(body.cwd || '') }));
          case 'move':
            return sendJson(res, 200, await hub.mover.start(id, { machineId: String(body.machineId || ''), cwd: String(body.cwd || '') }));
          case 'permission':
            return sendJson(res, 200, {
              ok: await hub.answerPermission(id, body.requestId, {
                behavior: body.behavior === 'allow' ? 'allow' : 'deny',
                message: body.message,
                answers: body.answers,
                always: Boolean(body.always),
              }, device.name),
            });
          default:
        }
      }
    }

    // Nhóm phiên (groups.mjs): lập nhóm, đặt mục tiêu, thêm và bỏ phiên, gán vai trò, bắt đầu, tạm dừng, chạy tiếp, dừng.
    if (parts[1] === 'groups' && method === 'POST') {
      const gid = parts[2];
      const body = await readBody(req);
      const groups = hub.groups;
      const sid = String(body.sessionId || '');
      if (!gid) return sendJson(res, 200, groups.create({ name: body.name, goal: body.goal }));
      switch (parts[3]) {
        case 'update':
          return sendJson(res, 200, groups.update(gid, { name: body.name, goal: body.goal, budgetUsd: body.budgetUsd }));
        case 'free-tool': // chủ dự án gỡ một dòng trên bảng tin dụng cụ (phiên giữ quên trả)
          return sendJson(res, 200, groups.freeTool(gid, String(body.key || '')));
        case 'delete':
          return sendJson(res, 200, { ok: groups.remove(gid) });
        case 'members':
          return sendJson(res, 200, await groups.addMember(gid, sid, body.role));
        case 'remove':
          return sendJson(res, 200, groups.removeMember(gid, sid));
        case 'leader':
          return sendJson(res, 200, groups.setLeader(gid, sid));
        case 'role':
          return sendJson(res, 200, groups.setRole(gid, sid, body.role));
        case 'start':
          return sendJson(res, 200, await groups.start(gid));
        case 'pause':
          return sendJson(res, 200, await groups.pause(gid));
        case 'resume':
          return sendJson(res, 200, await groups.resume(gid));
        case 'stop':
          return sendJson(res, 200, groups.stop(gid));
        default:
      }
    }

    if (parts[1] === 'machines' && parts[2]) {
      const machineId = parts[2];
      if (method === 'GET' && parts[3] === 'transcripts') return sendJson(res, 200, await hub.transcripts(machineId));
      if (method === 'GET' && parts[3] === 'dirs') return sendJson(res, 200, await hub.machineDirs(machineId, url.searchParams.get('path') || ''));
      if (method === 'GET' && parts[3] === 'temps') return sendJson(res, 200, await hub.machineTemps(machineId));
      if (method === 'GET' && parts[3] === 'history' && parts[4]) {
        return sendJson(res, 200, await hub.machineHistory(machineId, parts[4], Number(url.searchParams.get('since')) || 0));
      }
      if (method === 'POST' && parts[3] === 'open') {
        return sendJson(res, 200, await hub.openTranscript(machineId, await readBody(req)));
      }
      if (method === 'POST' && parts[3] === 'rename') {
        return sendJson(res, 200, hub.renameMachine(machineId, (await readBody(req)).name));
      }
      if (method === 'POST' && parts[3] === 'screen') {
        await readBody(req);
        return sendJson(res, 200, await hub.screenTicket(machineId));
      }
      if (method === 'POST' && parts[3] === 'update') {
        await readBody(req);
        return sendJson(res, 200, await hub.updateMachine(machineId));
      }
      // Máy nào có phiên được làm việc trên máy này (orbit_machine_*, hub.setControlGrants).
      if (method === 'POST' && parts[3] === 'control') {
        const body = await readBody(req);
        return sendJson(res, 200, { from: hub.setControlGrants(machineId, body.from) });
      }
      // Tài khoản Claude của máy (claude-auth.mjs): xem, đăng nhập bằng link và mã dán từ app, huỷ lượt đăng nhập.
      if (parts[3] === 'claude-auth' || parts[3] === 'claude-login') {
        const body = method === 'POST' ? await readBody(req) : {};
        try {
          if (method === 'GET' && parts[3] === 'claude-auth') return sendJson(res, 200, await hub.claudeAuth(machineId));
          if (method === 'POST' && parts[3] === 'claude-login' && !parts[4]) return sendJson(res, 200, await hub.claudeLogin(machineId, body.email));
          if (method === 'POST' && parts[4] === 'code') return sendJson(res, 200, await hub.claudeLoginCode(machineId, body.id, body.code));
          if (method === 'POST' && parts[4] === 'cancel') return sendJson(res, 200, { ok: await hub.claudeLoginCancel(machineId, body.id) });
        } catch (err) {
          if (/không hiểu lệnh/.test(err.message)) throw new HttpError(501, 'Máy này cần setup bản Orbit Remote mới để đăng nhập Claude từ app.');
          throw new HttpError(409, err.message);
        }
      }
      if (method === 'POST' && parts[3] === 'wake') {
        await readBody(req);
        return sendJson(res, 200, await hub.wakeMachine(machineId));
      }
      if (method === 'POST' && parts[3] === 'power') {
        return sendJson(res, 200, await hub.powerMachine(machineId, await readBody(req)));
      }
      if (method === 'POST' && parts[3] === 'forget') {
        await readBody(req);
        hub.forgetMachine(machineId);
        auth.revokeMachine(machineId);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (parts[1] === 'enroll' && parts[2] && method === 'POST' && (parts[3] === 'approve' || parts[3] === 'reject')) {
      await readBody(req);
      const decided = auth.decideEnroll(parts[2], parts[3] === 'approve');
      if (!decided) throw new HttpError(404, 'Yêu cầu nối này không còn.');
      pushEnrollments();
      return sendJson(res, 200, { ok: true, status: decided.status });
    }

    if (path === '/api/custom/actions') {
      if (method === 'PUT' || method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || !Array.isArray(body.actions)) {
          throw new HttpError(400, 'Cần một đối tượng có mảng "actions".');
        }
        writeJsonAtomic(join(CUSTOM_DIR, 'actions.json'), body);
        broadcast('custom', { file: 'actions.json' });
        return sendJson(res, 200, { ok: true });
      }
    }

    if (method === 'GET' && path === '/api/devices') return sendJson(res, 200, auth.list());
    // Mức dùng Claude (phiên 5 giờ, tuần) của các tài khoản trên các máy đang bật (hub.usage).
    if (method === 'GET' && path === '/api/usage') return sendJson(res, 200, await hub.usage());
    // Bản mới nhất của từng dòng model trên máy giữ trạm (models.mjs): ô chọn model hiện đúng số bản.
    if (method === 'GET' && path === '/api/models') return sendJson(res, 200, modelsView());
    // Nút cập nhật bản model: máy giữ trạm hỏi danh sách mới nhất rồi phát xuống mọi máy (hub.updateModels).
    if (method === 'POST' && path === '/api/models/update') {
      await readBody(req);
      try {
        return sendJson(res, 200, await hub.updateModels());
      } catch (err) {
        throw new HttpError(502, err.message);
      }
    }
    // Bảng token (custom/tokens.md) trên máy giữ trạm (xem tokens.mjs). Đường dẫn tệp đặc tả không gửi đi.
    if (method === 'GET' && path === '/api/tokens') return sendJson(res, 200, { tokens: listTokens().map(({ token, arg, hint }) => ({ token, arg, hint })) });
    // Lệnh "Restart trạm" bấm từ app: trả lời trước, rồi một tiến trình tách riêng khởi động lại trạm.
    if (method === 'POST' && path === '/api/hub/restart') {
      await readBody(req);
      if (!onRestart) throw new HttpError(501, 'Trạm này không tự khởi động lại được.');
      const log = onRestart();
      return sendJson(res, 200, { ok: true, log });
    }
    if (method === 'POST' && parts[1] === 'devices' && parts[3] === 'revoke') {
      await readBody(req);
      return sendJson(res, 200, { ok: auth.revoke(parts[2]) });
    }
    if (method === 'POST' && path === '/api/pair-code') {
      await readBody(req);
      return sendJson(res, 200, { code: auth.newPairCode() });
    }

    throw new HttpError(404, 'Không có API này.');
  }

  async function nodeRoutes(req, res, url) {
    const device = auth.check(tokenOf(req), 'node');
    if (!device) throw new HttpError(401, 'Thẻ đầu máy không hợp lệ.');

    if (req.method === 'GET' && url.pathname === '/node/link') {
      openSse(res);
      const linkId = randomBytes(8).toString('hex');
      const link = {
        send: (m) => res.write(`data: ${JSON.stringify(m)}\n\n`),
        close: () => res.end(),
      };
      const conn = hub.attachMachine(link, { machineId: device.machineId });
      nodeLinks.set(linkId, conn);
      res.write(`data: ${JSON.stringify({ op: 'linked', linkId })}\n\n`);
      res.on('close', () => {
        nodeLinks.delete(linkId);
        conn.disconnect();
      });
      return undefined;
    }

    if (req.method === 'POST' && url.pathname === '/node/push') {
      const conn = nodeLinks.get(String(req.headers['x-orbit-link'] || ''));
      if (!conn) throw new HttpError(409, 'Đường nối đã đứt, nối lại.');
      const body = await readBody(req, NODE_PUSH_LIMIT);
      for (const message of Array.isArray(body) ? body : [body]) conn.receive(message);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Không có.');
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;

    // Clipboard của chính máy giữ trạm cho cửa sổ app mở trên máy này (local-clip.mjs tự chặn mọi yêu
    // cầu không từ 127.0.0.1 hay không từ đúng trang của app).
    if (path.startsWith('/local/clip/')) {
      if (!localClip) throw new HttpError(404, 'Không có.');
      return localClip(req, res);
    }

    // Trạm tự giới thiệu: đầu máy dò tìm nhận ra trạm bằng chính câu trả lời này.
    if (path === '/api/ping') {
      const info = hubInfo();
      return sendJson(res, 200, {
        service: 'orbit-remote', hubId: info.id, hubName: info.name, urls: info.urls || [], version,
        // Có Tailscale: địa chỉ tailnet của trạm, dùng được ở mọi nơi.
        tailnet: info.tailnet ? { urls: info.tailnet.urls } : undefined,
        paired: Boolean(auth.check(tokenOf(req), 'device')),
      });
    }

    // Máy mới xin nối: không cần thẻ, nhưng chỉ được cấp thẻ khi người dùng bấm duyệt trên app.
    if (req.method === 'POST' && path === '/api/enroll') {
      const body = await readBody(req);
      const result = auth.requestEnroll({ ...body, ip: req.socket.remoteAddress });
      if (result.error) throw new HttpError(429, result.error);
      pushEnrollments();
      return sendJson(res, 200, result);
    }
    const enrollPoll = /^\/api\/enroll\/([0-9a-f]{16})$/.exec(path);
    if (req.method === 'GET' && enrollPoll) {
      const result = auth.pollEnroll(enrollPoll[1], req.headers['x-orbit-poll']);
      if (result.status === 'approved' || result.status === 'rejected') pushEnrollments();
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && path === '/api/pair') {
      const body = await readBody(req);
      const kind = body.kind === 'node' ? 'node' : 'device';
      const result = auth.redeem(body.code, body.name, kind);
      if (result.error) throw new HttpError(403, result.error);
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      const headers = kind === 'device'
        ? { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` }
        : {};
      return sendJson(res, 200, { ok: true, device: result.device, token: kind === 'node' ? result.token : undefined }, headers);
    }

    // Lấy mã ghép đôi từ chính máy giữ trạm: phải đọc được file bí mật trên đĩa của máy đó.
    if (req.method === 'POST' && path === '/api/local/pair-code') {
      if (!isLoopback(req) || req.headers['x-orbit-local'] !== localSecret) throw new HttpError(403, 'Không được phép.');
      return sendJson(res, 200, { code: auth.newPairCode() });
    }
    // Lệnh "restart" trên chính máy giữ trạm: cùng điều kiện như lấy mã cục bộ.
    if (req.method === 'POST' && path === '/api/local/shutdown') {
      if (!isLoopback(req) || req.headers['x-orbit-local'] !== localSecret || !onLocalShutdown) throw new HttpError(403, 'Không được phép.');
      const body = await readBody(req);
      const result = onLocalShutdown(Boolean(body.force));
      return sendJson(res, result.ok ? 200 : 409, result);
    }

    if (path.startsWith('/node/')) return nodeRoutes(req, res, url);

    if (path.startsWith('/api/')) {
      const device = auth.check(tokenOf(req), 'device');
      if (!device) throw new HttpError(401, 'Thiết bị chưa ghép đôi.');
      return api(req, res, url, device);
    }

    if (req.method !== 'GET') throw new HttpError(405, 'Không hỗ trợ.');
    if (path.startsWith('/custom/')) return serveStatic(res, CUSTOM_DIR, decodeURIComponent(path.slice('/custom/'.length)));

    // Quét QR: điện thoại mở /?pair=<mã>. Trang trỏ manifest tới một bản có địa chỉ khởi động
    // mang sẵn mã, để app thêm vào màn hình chính mở lần đầu là tự ghép, không phải gõ gì.
    // Chỉ nhận đúng 6 chữ số, nên không có cách nào chèn chữ lạ vào trang.
    const pairParam = url.searchParams.get('pair') || '';
    if (/^\d{6}$/.test(pairParam) && (path === '/' || path === '/index.html')) {
      const html = (await readFile(join(WEB_DIR, 'index.html'), 'utf8'))
        .replace('href="/manifest.webmanifest"', `href="/manifest.webmanifest?pair=${pairParam}"`);
      res.writeHead(200, {
        'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', ...SECURITY_HEADERS,
        'Content-Security-Policy': csp(pageConnect()),
      });
      res.end(html);
      return undefined;
    }
    if (path === '/manifest.webmanifest' && /^\d{6}$/.test(pairParam)) {
      const manifest = JSON.parse(await readFile(join(WEB_DIR, 'manifest.webmanifest'), 'utf8'));
      manifest.start_url = `/?pair=${pairParam}`;
      res.writeHead(200, { 'Content-Type': TYPES['.webmanifest'], 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end(JSON.stringify(manifest));
      return undefined;
    }
    return serveStatic(res, WEB_DIR, path === '/' ? 'index.html' : decodeURIComponent(path.slice(1)), pageConnect());
  }

  const handler = (req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, err.status || 500, { error: err.message });
    });
  };
  const server = tuneServer(http.createServer(handler));
  server.handler = handler;
  return server;
}

export function tuneServer(server) {
  server.keepAliveTimeout = 65000;
  // Luồng SSE sống lâu; không để máy chủ tự cắt yêu cầu sau vài phút.
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  return server;
}
