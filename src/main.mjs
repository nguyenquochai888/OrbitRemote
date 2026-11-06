#!/usr/bin/env node
// Lối vào của Orbit Remote.
//
//   node src/main.mjs                  chạy trạm (kèm đầu máy của chính máy này)
//   node src/main.mjs start            dựng trạm nếu chưa chạy, in mã QR cho điện thoại (run.cmd gọi lệnh này)
//   node src/main.mjs open             như start, rồi mở app trên trình duyệt máy này
//   node src/main.mjs app [--pair]     bản PC: mở app thành cửa sổ riêng của Edge (lối tắt Orbit Remote gọi lệnh này)
//   node src/main.mjs pair             in một mã ghép đôi mới và các địa chỉ để mở app
//   node src/main.mjs node             chạy đầu máy đứng riêng: tự tìm trạm, xin nối, nối
//   node src/main.mjs ensure           dựng trạm hoặc đầu máy chạy nền nếu chưa chạy (autostart gọi)
//   node src/main.mjs join <url> [mã]  chỉ địa chỉ trạm cho máy này (khi tự dò không thấy)
//   node src/main.mjs autostart on|off tự chạy "ensure" mỗi lần đăng nhập Windows
//   node src/main.mjs disable|enable   tắt/bật việc tự dựng đầu máy trên máy này
//   node src/main.mjs tailnet setup | status | off   khai địa chỉ Tailscale của trạm, dùng được mọi nơi
//   node src/main.mjs restart [--force] khởi động lại trạm đang chạy để nhận cấu hình mới
//   node src/main.mjs setup [--no-admin] cài và kiểm mọi thứ máy này cần (setup.cmd gọi lệnh này)
//   node src/main.mjs doctor            chỉ kiểm máy này thiếu gì, không cài gì
//   node src/main.mjs update            git pull rồi setup tự động (lệnh "Setup máy" bấm từ app)

import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { APP_PORT, startAppProxy } from './app-proxy.mjs';
import { localClipHandler } from './local-clip.mjs';
import { Auth } from './auth.mjs';
import { discoverHubs, startDiscoveryResponder } from './discovery.mjs';
import { Hub } from './hub.mjs';
import { NodeAgent, machineIdentity } from './node-agent.mjs';
import { runNodeLoop } from './node-runner.mjs';
import { createServer } from './server.mjs';
import { encodeQR, qrToTerminal } from '../web/lib/qr.js';
import { MACHINE_NAME, PIPE_PATH, SETUP_RESULT_FILE, STATE_DIR, TOOL_DIR, ensureDir, readJson, writeJsonAtomic } from './paths.mjs';
import { isPrivate } from './netaddr.mjs';
import { findTailscale, readTailscaleStatus, tailnetFromStatus, tailnetUrls } from './tailnet.mjs';
import { APP_PROFILE_DIR, openAppWindow } from './pc-app.mjs';
import { pullRepo, runSetup } from './setup.mjs';
import { spawnMain } from './launch.mjs';
import { REPO_HUB, publishRepoHub, repoHub, repoHubUrls } from './hub-decl.mjs';

const VERSION = readJson(join(TOOL_DIR, 'package.json'), {}).version || '0';
const CONFIG_FILE = join(STATE_DIR, 'config.json');
const SECRET_FILE = join(STATE_DIR, 'local-secret.json');
const NODE_FILE = join(STATE_DIR, 'node.json');
const ROLE_FILE = join(STATE_DIR, 'role.json');
const DISABLED_FILE = join(STATE_DIR, 'disabled.json');
const SELF = fileURLToPath(import.meta.url);
const AUTOSTART_FILE = process.platform === 'win32' && process.env.APPDATA
  ? join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Orbit Remote.vbs') : '';

function config() {
  const c = readJson(CONFIG_FILE, {});
  const host = process.env.ORBIT_REMOTE_HOST || c.host || '0.0.0.0';
  return {
    port: Number(process.env.ORBIT_REMOTE_PORT || c.port || 8795),
    host,
    claudeCommand: c.claudeCommand || undefined,
    // { urls } khi đã chạy "tailnet setup": địa chỉ của trạm qua Tailscale, dùng được ở mọi nơi.
    tailnet: c.tailnet?.urls?.length ? { urls: c.tailnet.urls } : null,
  };
}

function saveConfig(patch) {
  writeJsonAtomic(CONFIG_FILE, { ...readJson(CONFIG_FILE, {}), ...patch });
}

function log(text) {
  const t = new Date().toLocaleString('vi-VN', { hour12: false });
  process.stdout.write(`[${t}] ${text}\n`);
}

function localSecret(create) {
  const saved = readJson(SECRET_FILE, null);
  if (saved?.secret || !create) return saved?.secret || null;
  const secret = randomBytes(24).toString('hex');
  writeJsonAtomic(SECRET_FILE, { secret });
  return secret;
}

const isLoopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

// Địa chỉ trong mạng nhà để mở app từ thiết bị khác cùng mạng. Bỏ địa chỉ tự gán 169.254.x.x:
// Windows gán nó cho card mạng chưa nhận được địa chỉ (đã gặp thật trên một card mạng ảo), không
// thiết bị nào tới được, mà mã QR lại lấy địa chỉ đầu danh sách. Địa chỉ nội bộ chuẩn đứng trước.
function addresses(port) {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ url: `http://${a.address}:${port}`, label: name, kind: 'lan', standard: isPrivate(a.address) });
    }
  }
  return out.sort((x, y) => Number(y.standard) - Number(x.standard)).map(({ standard, ...a }) => a);
}

function spawnDetached(command) {
  spawnMain([command], command === 'hub' ? 'hub.log' : 'node.log');
}

async function localPairCode(port) {
  const secret = localSecret(false);
  if (!secret) throw new Error('Trạm chưa từng chạy trên máy này.');
  const res = await fetch(`http://127.0.0.1:${port}/api/local/pair-code`, {
    method: 'POST',
    headers: { 'X-Orbit-Local': secret, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`Trạm trả mã ${res.status}.`);
  return (await res.json()).code;
}

async function hubAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.json()).service === 'orbit-remote';
  } catch {
    return false;
  }
}

function pipeInUse() {
  return new Promise((resolve) => {
    const s = net.connect(PIPE_PATH);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

// Bảo đầu máy đứng riêng (nếu có) trên máy này nhường ống nội bộ cho trạm.
function askNodeToYield() {
  return new Promise((resolve) => {
    const s = net.connect(PIPE_PATH);
    s.once('connect', () => {
      s.write(`${JSON.stringify({ op: 'yield', rid: 'y' })}\n`);
      setTimeout(() => { s.destroy(); resolve(); }, 400);
    });
    s.once('error', () => resolve());
  });
}

// Địa chỉ in vào mã QR cho điện thoại. Có Tailscale thì địa chỉ tailnet đứng trước: app cài từ địa
// chỉ đó dùng được cả ở nhà lẫn bên ngoài, miễn điện thoại bật Tailscale. Không có thì dùng địa chỉ
// mạng nhà.
function phoneBaseUrl(port) {
  return config().tailnet?.urls[0] || addresses(port)[0]?.url || '';
}

// code: mã cho điện thoại. localCode: mã riêng cho đường dẫn mở trên chính máy này, để nhấp vào
// đường dẫn đó không tiêu mất mã điện thoại đang định quét. Không có thì in đường dẫn trơn.
function printPairing(port, code, localCode = '', host = config().host) {
  log(`Mã ghép đôi cho điện thoại hay máy khác (dùng một lần, sống 10 phút): ${code}`);
  log(`Trên máy này: http://127.0.0.1:${port}/${localCode ? `?pair=${localCode}` : ''}`);
  // Trạm chỉ nghe trên địa chỉ nội bộ thì thiết bị khác không vào được; đừng in địa chỉ dụ người ta thử.
  if (isLoopback(host)) {
    log('Trạm đang chỉ nghe trên máy này (host = 127.0.0.1), thiết bị khác chưa vào được.');
    return;
  }
  for (const a of addresses(port)) log(`Từ thiết bị khác (${a.label}): ${a.url}`);
  for (const u of config().tailnet?.urls || []) log(`Qua Tailscale (mọi nơi, điện thoại bật Tailscale): ${u}`);
  const target = phoneBaseUrl(port);
  if (target) {
    log(`Quét mã này bằng Camera của điện thoại (mở ${target}):`);
    process.stdout.write(`\n${qrToTerminal(encodeQR(`${target}/?pair=${code}`))}\n\n`);
  }
}

async function runHub() {
  ensureDir(STATE_DIR);
  const cfg = config();
  writeJsonAtomic(ROLE_FILE, { role: 'hub', since: new Date().toISOString() });
  const auth = new Auth();
  const hub = new Hub();
  const secret = localSecret(true);
  const identity = machineIdentity();

  // Địa chỉ trạm tự khai cho đầu máy và app: Tailscale (dùng được mọi nơi) nếu có, rồi địa chỉ mạng nhà.
  const tailnetList = isLoopback(cfg.host) ? [] : cfg.tailnet?.urls || [];
  const hubInfo = () => ({
    id: identity.id,
    name: MACHINE_NAME,
    urls: [...new Set([
      ...tailnetList,
      ...(isLoopback(cfg.host) ? [] : addresses(cfg.port).map((a) => a.url)),
    ])],
    addresses: isLoopback(cfg.host) ? [] : addresses(cfg.port),
    tailnet: tailnetList.length ? { urls: tailnetList } : null,
  });

  let shutdown = () => process.exit(0);
  let localClip = null; // clipboard của máy này cho cửa sổ app mở ngay trên máy giữ trạm (gắn khi đầu máy dựng xong)
  const server = createServer({
    hub, auth, localSecret: secret, version: VERSION, hubInfo,
    localClip: (req, res) => {
      if (localClip) return localClip(req, res);
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Đầu máy đang dựng.');
    },
    // Lệnh "restart" gọi qua đây. Khởi động lại là cắt mọi phiên Claude đang chạy dưới trạm,
    // nên có phiên đang chạy thì từ chối, trừ khi người gọi nói rõ --force.
    onLocalShutdown: (force) => {
      const running = [...hub.sessions.values()].filter((r) => ['starting', 'idle', 'busy', 'waiting'].includes(r.snap.status)).length;
      if (running && !force) return { ok: false, running };
      setTimeout(() => shutdown(), 100);
      return { ok: true, running };
    },
    // Lệnh "Restart trạm" bấm từ app: một tiến trình tách riêng chạy "restart --force" (bảo trạm này
    // tắt rồi dựng trạm mới), nên nó sống tiếp khi trạm này tắt.
    onRestart: () => spawnMain(['restart', '--force'], 'restart.log'),
  });
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log(`Cổng ${cfg.port} đã có tiến trình khác giữ (có thể trạm đang chạy rồi).`);
        process.exit(0);
      }
      reject(err);
    });
    server.listen(cfg.port, cfg.host, resolve);
  });
  if (!isLoopback(cfg.host)) startDiscoveryResponder({ port: cfg.port, info: () => ({ hubId: identity.id, hubName: MACHINE_NAME, version: VERSION, urls: hubInfo().urls }) });
  // Đầu máy của chính máy giữ trạm: cùng tiến trình, nói bằng lời gọi hàm. Tách nhịp bằng
  // queueMicrotask để hai bên không gọi lồng vào nhau giữa chừng một thao tác.
  const agent = new NodeAgent({ claudeCommand: cfg.claudeCommand, machineId: identity.id });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await agent.startPipe();
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt >= 4) throw new Error(`Không mở được ống nội bộ ${PIPE_PATH}: ${err.message}`);
      await askNodeToYield();
    }
  }
  const conn = hub.attachMachine({ send: (m) => queueMicrotask(() => agent.handle(m)) }, { local: true });
  agent.attach((m) => queueMicrotask(() => conn.receive(m)));
  agent.startScanning();
  if (agent.screen) localClip = localClipHandler({ input: agent.screen.input, log });

  setInterval(() => auth.flushLastSeen(), 60000).unref();

  log(`Orbit Remote ${VERSION} đang chạy trên cổng ${cfg.port}, máy ${MACHINE_NAME}.`);
  if (!auth.list().some((d) => d.kind === 'device')) printPairing(cfg.port, auth.newPairCode(), auth.newPairCode());

  shutdown = () => {
    agent.shutdown();
    hub.saveNow();
    auth.flushLastSeen();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runNode() {
  ensureDir(STATE_DIR);
  if (existsSync(DISABLED_FILE)) {
    log('Orbit Remote đang bị tắt trên máy này (node src/main.mjs enable để bật lại).');
    return;
  }
  const cfg = config();
  const agent = new NodeAgent({
    claudeCommand: cfg.claudeCommand,
    onYield: () => {
      log('Trạm vừa dựng trên chính máy này, đầu máy đứng riêng rút lui.');
      agent.shutdown();
      process.exit(0);
    },
    onShutdown: () => {
      log('Bộ cài yêu cầu tắt đầu máy để chạy lại bằng code và chương trình mới.');
      agent.shutdown();
      process.exit(0);
    },
  });
  try {
    await agent.startPipe();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      log('Trên máy này đã có trạm hoặc đầu máy khác đang chạy.');
      return;
    }
    throw err;
  }
  agent.startScanning();
  // Cổng mở app trên máy này (bản PC, lệnh "app"): chuyển tới trạm theo địa chỉ đầu máy đang nối.
  startAppProxy({ target: () => agent.hubUrl || '', log, local: agent.screen ? localClipHandler({ input: agent.screen.input, log }) : null });
  log(`Đầu máy ${MACHINE_NAME} đang tìm trạm…`);
  const controller = new AbortController();
  const shutdown = () => {
    controller.abort();
    agent.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await runNodeLoop(agent, { stateFile: NODE_FILE, port: cfg.port, log, signal: controller.signal });
}

// Bảo trạm đang chạy trên máy này tự tắt, rồi chờ nó tắt hẳn. Trạm còn phiên Claude đang chạy thì
// từ chối (tắt là cắt các phiên đó), trừ khi force. Trả về số phiên đang chạy khi bị từ chối, 0 khi đã tắt.
async function stopLocalHub(port, force) {
  const res = await fetch(`http://127.0.0.1:${port}/api/local/shutdown`, {
    method: 'POST',
    headers: { 'X-Orbit-Local': localSecret(false), 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return body.running || 1;
  if (!res.ok) throw new Error(body.error || `Trạm trả mã ${res.status}.`);
  for (let i = 0; i < 25 && (await hubAlive(port)); i += 1) await new Promise((r) => setTimeout(r, 200));
  return 0;
}

// Trạm khai trong custom/hub.json (do "tailnet setup" ghi) là máy khác.
function hubDeclaredElsewhere() {
  const declared = repoHub();
  return declared?.hubId && declared.hubId !== machineIdentity().id ? declared : null;
}

// Mỗi app trên điện thoại chỉ gắn với một trạm, và custom/hub.json khai trạm đó là máy nào. Máy này
// từng giữ trạm mà file đã khai trạm ở máy khác thì thôi làm trạm, để chuyển sang làm đầu máy của trạm
// mới; nếu không, nó dựng lại trạm cũ ở mỗi phiên và mãi không hiện trên app. Trạm cũ còn phiên
// Claude đang chạy thì để yên, lần sau thử lại. Trả về true khi máy này vẫn còn là trạm.
async function stepDownIfReplaced(port) {
  const isHub = readJson(ROLE_FILE, {}).role === 'hub';
  const declared = hubDeclaredElsewhere();
  if (!isHub || !declared) return isHub;
  const running = (await hubAlive(port)) ? await stopLocalHub(port, false) : 0;
  if (running) {
    log(`custom/hub.json đã khai trạm ${declared.hubName}, nhưng trạm cũ trên máy này còn ${running} phiên Claude đang chạy: giữ tới khi đóng hết.`);
    return true;
  }
  rmSync(ROLE_FILE, { force: true });
  log(`custom/hub.json đã khai trạm ${declared.hubName} (${repoHubUrls(declared).join(', ')}): máy này thôi làm trạm, chuyển sang nối vào trạm đó.`);
  return false;
}

// Tự chạy lúc đăng nhập Windows (autostart) gọi lệnh này: đầu máy (hoặc trạm, nếu máy này đã từng
// giữ trạm) được dựng chạy nền. Đã chạy rồi thì không làm gì.
async function runEnsure() {
  if (existsSync(DISABLED_FILE) || process.env.ORBIT_REMOTE_OFF === '1') return;
  const { port } = config();
  await stepDownIfReplaced(port);
  if (await hubAlive(port)) return;
  const role = readJson(ROLE_FILE, {}).role;
  if (role === 'hub') {
    spawnDetached('hub');
    return;
  }
  if (await pipeInUse()) return;
  spawnDetached('node');
}

function openBrowser(url) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

// Dựng trạm chạy nền nếu chưa chạy, chờ nó lên. Trả về true nếu vừa dựng.
async function ensureHubRunning(port) {
  if (await hubAlive(port)) return false;
  spawnDetached('hub');
  for (let i = 0; i < 50 && !(await hubAlive(port)); i += 1) await new Promise((r) => setTimeout(r, 200));
  if (!(await hubAlive(port))) throw new Error(`Trạm không lên. Xem ${join(STATE_DIR, 'hub.log')}.`);
  return true;
}

async function startAsHub(port) {
  log(await ensureHubRunning(port) ? 'Đã dựng trạm chạy nền.' : 'Trạm đang chạy sẵn.');
  printPairing(port, await localPairCode(port), await localPairCode(port));
  log('Muốn mở app trên máy tính này: giữ Ctrl và nhấp vào địa chỉ "Trên máy này" ở trên.');
}

// Lệnh của run.cmd. Mỗi mạng chỉ nên có MỘT trạm, vì app trên điện thoại gắn với địa chỉ của
// trạm: một trạm thứ hai là một app thứ hai, và máy của trạm đó tách khỏi app đang có. Nên:
//   - máy giữ trạm (hoặc gọi kèm --hub): dựng trạm nếu cần, in mã QR cho điện thoại;
//   - máy khác: tìm trạm trong mạng, dựng đầu máy, báo không cần quét gì (duyệt trên app);
//   - chưa có trạm nào và máy này chưa từng thuộc trạm nào: máy này nhận làm trạm;
//   - máy đã thuộc một trạm mà giờ không thấy trạm đó: KHÔNG tự dựng trạm thứ hai, chỉ báo.
// Cố ý không mở trình duyệt: mã QR đã nằm trong cửa sổ (người dùng phàn nàn chuyện tự bật web).
async function runStart() {
  const { port } = config();
  const forceHub = process.argv.includes('--hub');
  const isHub = forceHub ? true : await stepDownIfReplaced(port);
  if (isHub || (await hubAlive(port))) {
    if (forceHub && hubDeclaredElsewhere()) log(`Lưu ý: custom/hub.json đang khai trạm ${repoHub().hubName}. Máy này sẽ tự thôi làm trạm ở lần dựng kế tiếp, trừ khi chạy "tailnet setup" để khai trạm mới.`);
    await startAsHub(port);
    return;
  }

  const saved = readJson(NODE_FILE, {});
  log('Đang tìm trạm trong mạng…');
  const hubs = await discoverHubs({ knownUrls: [...(saved.urls || []), ...repoHubUrls()], port });
  const hub = saved.hubId ? hubs.find((h) => h.hubId === saved.hubId) : hubs[0];

  // custom/hub.json đã khai trạm ở máy khác mà chưa tới được (khác mạng, trạm tắt): không dựng trạm thứ hai.
  if (!hub && !saved.hubId && !hubDeclaredElsewhere()) {
    log('Chưa có trạm nào trong mạng: máy này nhận làm trạm.');
    await startAsHub(port);
    return;
  }

  // Máy chạy phiên: chỉ cần đầu máy chạy nền, nó tự nối và tự xin duyệt.
  if (existsSync(DISABLED_FILE)) {
    log('Orbit Remote đang bị tắt trên máy này. Bật lại: node src/main.mjs enable');
    return;
  }
  if (!(await pipeInUse())) spawnDetached('node');
  if (!hub) {
    log(`Không thấy trạm ${saved.hubName || repoHub()?.hubName || ''} lúc này. Bật máy giữ trạm lên, hoặc xem mạng ở đây có đi tới ${repoHubUrls().join(' hay ') || 'trạm'} không (địa chỉ Tailscale cần máy này bật Tailscale cùng tài khoản); máy này sẽ tự nối khi thấy trạm.`);
    log('Máy này KHÔNG tự dựng trạm thứ hai, để iPhone vẫn chỉ cần một app.');
    return;
  }
  log(`Máy này là máy chạy phiên của trạm ${hub.hubName} (${hub.urls[0]}).`);
  log('Không cần quét mã QR nào: trên iPhone vẫn dùng đúng app Orbit Remote đang có.');
  if (saved.token && saved.hubId === hub.hubId) {
    log('Máy đã được duyệt, đang hiện trong dải "Máy tính" của app.');
  } else {
    log('Lần đầu: mở Orbit Remote trên iPhone, ở màn chính bấm "Cho nối" trên thẻ của máy này.');
  }
  log('Muốn máy này làm trạm thay (hiếm khi cần): node src/main.mjs start --hub');
}

// Mở app trên trình duyệt máy này và tự ghép đôi (chỉ khi gọi đích danh lệnh này).
async function runOpen() {
  const { port } = config();
  await ensureHubRunning(port);
  // Hai mã riêng: một cho trình duyệt máy này tự ghép, một in ra cho điện thoại. Dùng chung
  // một mã thì trình duyệt ghép trước và mã in ra đã chết khi người dùng gõ trên điện thoại.
  const browserCode = await localPairCode(port);
  const phoneCode = await localPairCode(port);
  openBrowser(`http://127.0.0.1:${port}/?pair=${browserCode}&phone=1`);
  log('Đã mở app trên trình duyệt máy này.');
  printPairing(port, phoneCode);
}

// Bản PC: mở app thành cửa sổ riêng của Edge (pc-app.mjs).
//   - Máy giữ trạm: mở thẳng trạm trên 127.0.0.1. Lần mở đầu (hồ sơ riêng chưa có) hay gọi kèm --pair
//     thì kèm một mã ghép đôi riêng để cửa sổ tự ghép.
//   - Máy khác: mở cổng app của đầu máy (app-proxy.mjs) trên 127.0.0.1, chuyển tới trạm theo địa chỉ
//     đầu máy đang nối. Lần đầu cửa sổ hỏi mã ghép đôi: lấy trên điện thoại, Cài đặt → Ghép điện thoại.
async function runApp() {
  const { port } = config();
  const forcePair = process.argv.includes('--pair');
  let url;
  if (readJson(ROLE_FILE, {}).role === 'hub' || (await hubAlive(port))) {
    await ensureHubRunning(port);
    url = `http://127.0.0.1:${port}/`;
    if (forcePair || !existsSync(APP_PROFILE_DIR)) url += `?pair=${await localPairCode(port)}`;
  } else {
    if (existsSync(DISABLED_FILE)) throw new Error('Orbit Remote đang bị tắt trên máy này. Bật lại: node src/main.mjs enable');
    if (!(await pipeInUse())) spawnDetached('node');
    // Chờ đầu máy nối được trạm (cổng app trả lời thay trạm). Chưa nối thì vẫn mở: trang tự báo và thử lại.
    for (let i = 0; i < 40; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${APP_PORT}/api/ping`, { signal: AbortSignal.timeout(1500) });
        if (r.ok && (await r.json()).service === 'orbit-remote') break;
      } catch {
        // đầu máy đang dựng
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    url = `http://127.0.0.1:${APP_PORT}/`;
  }
  const { browser, firstRun } = openAppWindow(url);
  log(`Đã mở cửa sổ Orbit Remote (${browser.split(/[\\/]/).pop()}${firstRun ? ', lần đầu' : ''}).`);
}

async function runPair() {
  const { port } = config();
  if (!(await hubAlive(port))) throw new Error('Trạm chưa chạy. Chạy run.cmd hoặc "node src/main.mjs start" trước.');
  printPairing(port, await localPairCode(port), await localPairCode(port));
}

// Chỉ địa chỉ trạm khi tự dò không thấy (máy ở mạng khác và custom/hub.json chưa khai trạm).
// Có mã ghép đôi thì nhận thẻ ngay; không có thì lần sau đầu máy xin nối, duyệt trên app.
async function runJoin(hubUrl, code) {
  if (!hubUrl) throw new Error('Cách dùng: node src/main.mjs join <địa chỉ trạm> [mã ghép đôi]');
  const pingRes = await fetch(new URL('/api/ping', hubUrl), { signal: AbortSignal.timeout(5000) });
  const info = await pingRes.json().catch(() => ({}));
  if (info.service !== 'orbit-remote') throw new Error(`${hubUrl} không phải trạm Orbit Remote.`);
  const patch = { hubId: info.hubId, hubName: info.hubName, urls: [...new Set([hubUrl, ...(info.urls || [])])], pausedUntil: 0 };
  if (code) {
    const res = await fetch(new URL('/api/pair', hubUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: MACHINE_NAME, kind: 'node' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Trạm trả mã ${res.status}.`);
    patch.token = body.token;
  }
  writeJsonAtomic(NODE_FILE, { ...readJson(NODE_FILE, {}), ...patch });
  log(`Đã ghi trạm ${info.hubName} (${hubUrl}) cho máy ${MACHINE_NAME}.${code ? '' : ' Khi đầu máy chạy, duyệt yêu cầu nối trên app.'}`);
}

// Tự chạy "ensure" mỗi lần đăng nhập Windows, ẩn. Dùng VBScript vì đó là cách gọn nhất để
// chạy một lệnh không kèm cửa sổ console từ thư mục Startup.
function runAutostart(mode) {
  if (process.platform !== 'win32') throw new Error('Lệnh autostart hiện chỉ làm cho Windows.');
  const file = AUTOSTART_FILE;
  if (mode === 'off') {
    rmSync(file, { force: true });
    log('Đã tắt tự chạy. Trạm hay đầu máy đang chạy (nếu có) vẫn chạy tới khi tắt máy.');
    return;
  }
  if (mode !== 'on') throw new Error('Cách dùng: node src/main.mjs autostart on|off');
  const raw = `"${process.execPath}" "${SELF}" ensure`;
  // File VBScript chỉ chứa ký tự ASCII: Windows Script Host không đọc UTF-8 không BOM.
  writeFileSync(file, `' Orbit Remote: start the hub or the machine agent hidden at Windows sign-in.\r\nCreateObject("WScript.Shell").Run "${raw.replace(/"/g, '""')}", 0, False\r\n`, 'ascii');
  log(`Đã bật tự chạy: ${file}`);
}

// Tailscale (xem tailnet.mjs): khai địa chỉ tailnet của máy giữ trạm vào cấu hình và custom/hub.json, để
// app trên điện thoại và các máy khác tới được trạm ở mọi nơi, kể cả mạng chỉ có IPv4.
//   tailnet setup    đọc địa chỉ Tailscale của máy này rồi khai; cần khởi động lại trạm
//   tailnet status   Tailscale có chạy không, địa chỉ đã khai, trạm có trả lời qua đó không
//   tailnet off      thôi khai địa chỉ tailnet (Tailscale vẫn chạy như cũ)
async function runTailnet(args) {
  const [mode = 'status'] = args;
  const { port } = config();
  const usage = 'Cách dùng: node src/main.mjs tailnet setup | status | off';
  if (mode === 'off') {
    saveConfig({ tailnet: undefined });
    if (repoHub()?.hubId === machineIdentity().id) publishRepoHub({ tailnet: undefined });
    log(`Đã thôi khai địa chỉ Tailscale (${REPO_HUB}). Chạy "node src/main.mjs restart" để trạm nhận cấu hình mới.`);
    return;
  }
  if (mode !== 'setup' && mode !== 'status') throw new Error(usage);
  const cmd = findTailscale();
  if (!cmd) throw new Error('Không thấy Tailscale trên máy này. Cài từ https://tailscale.com/download, đăng nhập, rồi chạy lại.');
  const info = tailnetFromStatus(readTailscaleStatus(cmd));
  if (mode === 'setup') {
    if (!info.running || !info.ipv4) throw new Error(`Tailscale chưa sẵn sàng (trạng thái: ${info.state || 'không đọc được'}). Đăng nhập bằng "${cmd}" up rồi chạy lại.`);
    const urls = tailnetUrls(info, port);
    saveConfig({ tailnet: { urls } });
    publishRepoHub({ hubId: machineIdentity().id, hubName: MACHINE_NAME, tailnet: urls });
    log(`Đã khai địa chỉ Tailscale của trạm: ${urls.join(', ')}`);
    log(`Đã ghi ${REPO_HUB}. Máy khác tự tìm ra trạm khi có file này (chép sang, hoặc commit vào bản fork riêng bằng "git add -f"); không thì chạy "node src/main.mjs join ${urls[0]}" một lần trên máy đó.`);
    log('Việc còn lại: chạy "node src/main.mjs restart" để trạm khai địa chỉ mới; điện thoại và máy khác cài Tailscale, đăng nhập cùng tài khoản.');
    return;
  }
  log(`Tailscale: ${info.state || 'không đọc được trạng thái'}${info.ipv4 ? `, máy này là ${info.ipv4}${info.dnsName ? ` (${info.dnsName})` : ''}` : ''}`);
  const urls = config().tailnet?.urls || [];
  if (!urls.length) {
    log(`Trạm chưa khai địa chỉ Tailscale. ${usage}`);
    return;
  }
  for (const u of urls) {
    try {
      const ping = await (await fetch(`${u}/api/ping`, { signal: AbortSignal.timeout(4000) })).json();
      log(`${u}: trạm ${ping.hubName} trả lời${ping.tailnet?.urls?.includes(u) ? '' : ' (trạm đang chạy chưa nhận cấu hình mới: restart)'}`);
    } catch (err) {
      log(`${u}: không trả lời (${err.cause?.code || err.message})`);
    }
  }
}

// Khởi động lại trạm đang chạy trên máy này để nhận cấu hình mới (Tailscale, cổng...).
async function runRestart(args) {
  const { port } = config();
  if (await hubAlive(port)) {
    const running = await stopLocalHub(port, args.includes('--force'));
    if (running) throw new Error(`Trạm đang có ${running} phiên Claude chạy; khởi động lại sẽ cắt các phiên đó. Đóng phiên trước, hoặc thêm --force.`);
  }
  await ensureHubRunning(port);
  log('Trạm đã chạy lại với cấu hình mới.');
}

function runToggle(on) {
  ensureDir(STATE_DIR);
  if (on) {
    rmSync(DISABLED_FILE, { force: true });
    log('Đã bật lại Orbit Remote trên máy này.');
  } else {
    writeJsonAtomic(DISABLED_FILE, { since: new Date().toISOString() });
    log('Đã tắt việc tự dựng đầu máy trên máy này. Đầu máy đang chạy (nếu có) vẫn chạy tới khi tắt máy.');
  }
}

// Những gì bộ cài (setup.mjs) cần biết hay làm mà chỉ main.mjs nắm: vai của máy, tệp trạng thái,
// cách dựng đầu máy và khởi động lại trạm.
async function setupContext() {
  const cfg = config();
  const isHub = readJson(ROLE_FILE, {}).role === 'hub' || (await hubAlive(cfg.port));
  return {
    role: isHub ? 'hub' : 'node',
    machine: MACHINE_NAME,
    hubPort: cfg.port,
    claudeCommand: cfg.claudeCommand,
    selfPath: SELF,
    disabledFile: DISABLED_FILE,
    autostartFile: AUTOSTART_FILE,
    autostartOn: () => runAutostart('on'),
    nodeState: () => readJson(NODE_FILE, {}),
    hubUrls: () => [...new Set([...(readJson(NODE_FILE, {}).urls || []), ...repoHubUrls()])],
    pipeInUse,
    spawnNode: () => spawnDetached('node'),
    restartHub: async (force = false) => {
      const running = (await hubAlive(cfg.port)) ? await stopLocalHub(cfg.port, force) : 0;
      if (running) return { ok: false, running };
      await ensureHubRunning(cfg.port);
      return { ok: true };
    },
    resultFile: SETUP_RESULT_FILE,
    // Hỏi người ngồi tại máy (setup.cmd mở cửa sổ dòng lệnh); setup chạy nền thì không hỏi được.
    ask: process.stdin.isTTY ? askYes : null,
  };
}

// Câu hỏi có/không trong cửa sổ dòng lệnh: "c" (hay "có", "y") là đồng ý, còn lại là thôi.
function askYes(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^\s*(c|có|co|y|yes)\s*$/i.test(answer));
    });
  });
}

async function runSetupCommand(fix) {
  process.exitCode = await runSetup({ fix, args: rest, ctx: await setupContext() });
}

// Lệnh "Setup máy" bấm từ app (đầu máy chạy lệnh này ở tiến trình tách riêng): lấy code Orbit Remote
// mới nhất rồi chạy setup tự động bằng một tiến trình mới, để setup chạy đúng code vừa kéo về.
async function runUpdate() {
  log('Lấy code Orbit Remote mới nhất (git pull --ff-only)…');
  const { failed, pulled } = await pullRepo(TOOL_DIR, { log });
  const r = spawnSync(process.execPath, [SELF, 'setup', '--unattended'], {
    stdio: 'inherit', windowsHide: true,
    // Kéo hỏng thì setup ghi kết quả là còn thiếu (máy vẫn chạy code cũ), không báo "đủ cả".
    env: { ...process.env, ORBIT_REMOTE_PULL: pulled, ORBIT_REMOTE_PULL_FAILED: failed ? '1' : '' },
  });
  process.exitCode = r.status ?? 1;
}

const [command = 'hub', ...rest] = process.argv.slice(2);
const commands = {
  setup: () => runSetupCommand(true),
  doctor: () => runSetupCommand(false),
  update: runUpdate,
  hub: runHub,
  start: runStart,
  open: runOpen,
  app: runApp,
  pair: runPair,
  node: runNode,
  ensure: runEnsure,
  join: () => runJoin(...rest),
  autostart: async () => runAutostart(rest[0]),
  tailnet: () => runTailnet(rest),
  restart: () => runRestart(rest),
  disable: async () => runToggle(false),
  enable: async () => runToggle(true),
};

if (!commands[command]) {
  process.stderr.write(`Không có lệnh "${command}". Các lệnh: ${Object.keys(commands).join(', ')}\n`);
  process.exit(2);
}
commands[command]().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
