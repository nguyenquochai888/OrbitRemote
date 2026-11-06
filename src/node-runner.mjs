// Vòng sống của một đầu máy đứng riêng: tìm trạm, xin nối nếu chưa có thẻ, nối, và tự tìm
// lại trạm khi mất (trạm đổi địa chỉ, máy đổi mạng). Không ai phải gõ địa chỉ hay mã nào:
// lần đầu, trạm hiện yêu cầu nối trên app và người dùng bấm duyệt một lần.
//
// Bị từ chối, hoặc bị trạm thu hồi thẻ (người dùng "quên máy"), thì nghỉ một ngày rồi mới
// xin lại, để không làm phiền bằng những yêu cầu lặp đi lặp lại.

import { platform } from 'node:os';
import { discoverHubs } from './discovery.mjs';
import { connectOnce } from './remote-link.mjs';
import { readJson, writeJsonAtomic } from './paths.mjs';
import { repoHubUrls } from './hub-decl.mjs';

const PAUSE_AFTER_REFUSAL_MS = 24 * 60 * 60 * 1000;
const ENROLL_POLL_MS = 3000;
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 60000;

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

async function postJson(url, path, body, headers = {}) {
  const res = await fetch(new URL(path, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Trạm trả mã ${res.status}.`);
  return data;
}

// Xin nối và chờ người dùng duyệt. Trả về thẻ, hoặc null kèm lý do.
async function enroll(hub, machine, { log, signal }) {
  let request = null;
  let url = null;
  for (const u of hub.urls) {
    try {
      request = await postJson(u, '/api/enroll', { machineId: machine.id, name: machine.name, platform: platform() });
      url = u;
      break;
    } catch (err) {
      log(`Không gửi được yêu cầu nối tới ${u}: ${err.message}`);
    }
  }
  if (!request) return { token: null, reason: 'unreachable' };
  log(`Đã xin nối vào trạm ${hub.hubName}. Mở Orbit Remote trên điện thoại và bấm "Cho nối".`);
  while (!signal?.aborted) {
    await sleep(ENROLL_POLL_MS, signal);
    let poll;
    try {
      const res = await fetch(new URL(`/api/enroll/${request.requestId}`, url), {
        headers: { 'X-Orbit-Poll': request.pollSecret },
        signal: AbortSignal.timeout(5000),
      });
      poll = await res.json();
    } catch {
      continue; // trạm chập chờn: hỏi lại nhịp sau
    }
    if (poll.status === 'approved' && poll.token) return { token: poll.token, url };
    if (poll.status === 'rejected') return { token: null, reason: 'rejected' };
    if (poll.status === 'expired') return { token: null, reason: 'expired' };
  }
  return { token: null, reason: 'stopped' };
}

export async function runNodeLoop(agent, { stateFile, port, log = () => {}, signal } = {}) {
  let backoff = BACKOFF_MIN_MS;
  const save = (patch) => {
    const next = { ...readJson(stateFile, {}), ...patch };
    writeJsonAtomic(stateFile, next);
    return next;
  };

  while (!signal?.aborted) {
    const saved = readJson(stateFile, {});
    if (saved.pausedUntil && Date.now() < saved.pausedUntil) {
      await sleep(Math.min(saved.pausedUntil - Date.now(), 10 * 60 * 1000), signal);
      continue;
    }

    // Địa chỉ Tailscale của trạm khai trong custom/hub.json: máy ở chỗ khác tìm được trạm ở nhà.
    const hubs = await discoverHubs({ knownUrls: [...(saved.urls || []), ...repoHubUrls()], port });
    // Đã thuộc về một trạm thì chỉ nhận đúng trạm đó (theo mã, không theo địa chỉ); máy mới thì
    // nhận trạm đầu tiên tìm thấy.
    const hub = saved.hubId ? hubs.find((h) => h.hubId === saved.hubId) : hubs[0];
    if (!hub) {
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      continue;
    }
    // Nhớ mọi địa chỉ của trạm (công khai, mạng nhà) để ra ngoài vẫn tìm thấy.
    const urls = [...new Set([...hub.urls, ...(hub.advertised || []), ...(saved.hubId === hub.hubId ? saved.urls || [] : [])])];
    let state = save({ hubId: hub.hubId, hubName: hub.hubName, urls });

    if (!state.token) {
      const result = await enroll({ ...hub, urls }, agent.machine, { log, signal });
      if (!result.token) {
        if (result.reason === 'rejected') {
          log('Yêu cầu nối bị từ chối. Thử lại sau một ngày.');
          save({ pausedUntil: Date.now() + PAUSE_AFTER_REFUSAL_MS });
        }
        await sleep(backoff, signal);
        continue;
      }
      state = save({ token: result.token, pausedUntil: 0 });
      log('Trạm đã duyệt máy này.');
    }

    let linked = false;
    for (const url of state.urls) {
      if (signal?.aborted) return;
      const r = await connectOnce(agent, { hubUrl: url, token: state.token, log, signal });
      if (r.reason === 'unauthorized') {
        log('Trạm đã thu hồi thẻ của máy này. Nghỉ một ngày rồi mới xin nối lại.');
        save({ token: null, pausedUntil: Date.now() + PAUSE_AFTER_REFUSAL_MS });
        break;
      }
      if (r.linked) {
        linked = true;
        log('Mất kết nối tới trạm, đang tìm lại…');
        break;
      }
    }
    backoff = linked ? BACKOFF_MIN_MS : Math.min(backoff * 2, BACKOFF_MAX_MS);
    await sleep(backoff, signal);
  }
}
