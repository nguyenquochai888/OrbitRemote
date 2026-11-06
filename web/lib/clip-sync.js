// Clipboard hai chiều giữa máy đang dùng và máy đang xem màn hình, như Remote Desktop (phía máy:
// src/clip.mjs, src/local-clip.mjs).
//
//   - Ctrl+V trên hình: thứ vừa copy ở máy này (tệp, thư mục, ảnh, chữ) vào clipboard máy kia rồi được dán.
//   - Copy trên máy kia (phím tắt hay chuột phải → Copy): máy kia mời; chữ vào clipboard máy này ngay, tệp
//     nhỏ (tới AUTO_MAX) chép về ngay, tệp lớn hơn thì chờ bấm "Chép về máy này".
//   - Copy ở máy này lúc đang xem: đưa sẵn sang máy kia (chữ, tệp nhỏ), nên chuột phải → Paste bên đó dán được.
//
// Hai chiều cuối cần đầu máy Orbit trên chính máy đang mở app (bản PC): trang web tự nó không đặt được danh
// sách tệp vào clipboard của Windows, cũng không biết lúc nào có ai copy. Trên iPhone, trình duyệt thường:
// chữ copy bên kia có nút "Copy về máy này"; Ctrl+V vẫn đưa được thứ đang copy sang máy kia.
//
// Bên nào mới hơn thì thắng: mỗi máy nhớ lúc thứ đang copy ở máy này đổi (localAt) và lúc clipboard máy kia
// đổi (remoteAt). Ctrl+V chỉ đưa thứ ở máy này sang khi nó mới hơn; không thì máy kia dán clipboard của nó
// (copy trên máy kia rồi dán bên đó vẫn đúng như khi ngồi tại máy đó).

export const AUTO_MAX = 64 * 1024 * 1024;
const CLIP_HEADER = 9;
const STATE = new Map(); // máy -> { lastLocalSig, localAt, remoteAt, lastPushedSig }, giữ qua các lần mở màn

const stateOf = (id) => {
  if (!STATE.has(id)) STATE.set(id, { lastLocalSig: undefined, localAt: 0, remoteAt: 0, lastPushedSig: undefined });
  return STATE.get(id);
};
const newId = () => (Math.random() * 0x100000000) >>> 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dấu nhận ra thứ đang copy: chữ theo nội dung; tệp theo tên, cỡ và giờ sửa của từng mục ở tầng đầu (thư
// mục không tính giờ: trình duyệt và máy báo khác nhau). Ảnh trong clipboard tới trang thành tệp mang giờ
// của lúc dán (vừa sinh ra), nên với tệp như vậy cũng không tính giờ.
export function clipSignature(text, tops = [], now = Date.now()) {
  if (text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    return `t${text.length}:${(hash >>> 0).toString(36)}`;
  }
  if (!tops.length) return '';
  return `f${tops.map((x) => `${x.name}|${x.dir ? 0 : x.size}|${x.dir || !(x.mtime < now - 5000) ? '' : x.mtime}`).join('/')}`;
}

const offerTops = (items) => items.filter((x) => !x.rel.includes('/')).map((x) => ({ name: x.rel, size: x.size, mtime: x.mtime, dir: x.dir }));

// Tệp và thư mục đã copy -> danh sách gửi đi theo thứ tự: thư mục trước rồi mọi thứ bên trong (kể cả thư
// mục rỗng). entries[i] là mục của tệp thứ i (webkitGetAsEntry), cho biết đó là thư mục để đi vào trong.
export async function gatherClip(files, entries = []) {
  const out = [];
  const read = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
  async function walk(dir, rel) {
    out.push({ rel, dir: true });
    const reader = dir.createReader();
    for (let batch = await read(reader); batch.length; batch = await read(reader)) {
      for (const entry of batch) {
        if (entry.isDirectory) await walk(entry, `${rel}/${entry.name}`);
        else out.push({ rel: `${rel}/${entry.name}`, file: await fileOf(entry) });
      }
    }
  }
  for (let i = 0; i < files.length; i += 1) {
    if (entries[i]?.isDirectory) await walk(entries[i], entries[i].name);
    else out.push({ rel: files[i].name, file: files[i] });
  }
  return out;
}

export function clipLabel(items) {
  const tops = [...new Set(items.map((x) => x.rel.split('/')[0]))];
  return tops.length === 1 ? `"${tops[0]}"` : `${tops.length} mục`;
}

export function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
}

// ---- Clipboard của chính máy này qua đầu máy (src/local-clip.mjs) ----------------------------------------
const LOCAL = { checked: null };
async function local(path, init = {}) {
  const res = await fetch(`/local/clip/${path}`, { ...init, headers: { 'X-Orbit-Clip': '1', ...(init.headers || {}) } });
  if (!res.ok) {
    let text = '';
    try { text = (await res.json()).error; } catch { /* không phải JSON */ }
    throw new Error(text || `Clipboard máy này trả mã ${res.status}.`);
  }
  return res;
}
const postJson = (path, body) => local(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

export const localClip = {
  // Có đầu máy trên máy này không (bản PC mở qua 127.0.0.1): hỏi một lần.
  available() {
    LOCAL.checked ||= local('ping').then((r) => r.json()).then((j) => Boolean(j.clip), () => false);
    return LOCAL.checked;
  },
  watch: (since, signal) => local(`watch?since=${since}`, { signal }).then((r) => r.json()),
  text: (text) => postJson('text', { text }),
  begin: (id, files) => postJson('begin', { id, files }),
  chunk: (id, index, data) => {
    const body = new Uint8Array(CLIP_HEADER + data.length);
    const view = new DataView(body.buffer);
    body[0] = 1;
    view.setUint32(1, id, true);
    view.setUint32(5, index, true);
    body.set(data, CLIP_HEADER);
    return local('chunk', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
  },
  end: (id) => postJson('end', { id }),
  cancel: () => postJson('cancel', {}).catch(() => {}),
  read: (seq, index, at, len) => local(`file?seq=${seq}&i=${index}&at=${at}&len=${len}`).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
};

// ---- Điều phối cho một màn hình ------------------------------------------------------------------------
// ui: { live(), client(), machineName, show({ text, action, cancel }) dòng trạng thái ở khung, toast(text, kind) }
export function createClipSync(machineId, ui) {
  const st = stateOf(machineId);
  let busy = null; // AbortController của lần chép đang chạy (một lần một lúc)
  let running = false;
  let watchAbort = null;
  let noticeTimer = null;

  const caps = () => Boolean(ui.client()?.caps?.clip);
  const synced = () => {
    const now = Date.now();
    st.localAt = now;
    st.remoteAt = now;
  };

  function pasteThere(shift = false) {
    const client = ui.client();
    if (!ui.live() || !client) return;
    const held = shift ? [17, 16] : [17];
    for (const vk of held) client.key(vk, true);
    client.tapKey(86);
    for (const vk of held.reverse()) client.key(vk, false);
  }

  function notice(text, action = null, ms = 0) {
    clearTimeout(noticeTimer);
    ui.show(text ? { text, action, cancel: false } : null);
    if (text && ms) noticeTimer = setTimeout(() => ui.show(null), ms);
  }

  // Chạy một lần chép (gửi đi hay kéo về), có dòng tiến độ và nút huỷ.
  async function transfer(label, run, { quiet = false } = {}) {
    if (busy) {
      if (!quiet) ui.toast('Đang chép dở lần trước, chờ xong rồi làm tiếp.');
      return false;
    }
    const ctrl = new AbortController();
    busy = ctrl;
    let shownAt = 0;
    const started = performance.now();
    const progress = (done, total) => {
      const now = performance.now();
      if ((quiet && now - started < 800) || (now - shownAt < 200 && done < total)) return; // vẽ lại tối đa 5 lần mỗi giây
      shownAt = now;
      ui.show({ text: `${label} · ${total ? Math.floor((done / total) * 100) : 100}% (${fmtBytes(done)}/${fmtBytes(total)})`, cancel: true });
    };
    if (!quiet) ui.show({ text: `${label}…`, cancel: true });
    try {
      await run(ctrl.signal, progress);
      return true;
    } catch (err) {
      ui.toast(ctrl.signal.aborted ? 'Đã huỷ chép.' : err.message, ctrl.signal.aborted ? 'info' : 'error');
      return false;
    } finally {
      busy = null;
      ui.show(null);
    }
  }

  // ---- Ctrl+V trên hình ---------------------------------------------------------------------------
  async function onPaste({ text, files, entries, shift = false }) {
    const tops = files.map((f, i) => ({ name: f.name, size: f.size, mtime: f.lastModified, dir: Boolean(entries[i]?.isDirectory) }));
    const sig = clipSignature(text, tops);
    if (!sig) return pasteThere(shift);
    if (sig !== st.lastLocalSig) {
      // Lần đầu thấy thì không biết copy lúc nào: coi như cũ hơn mọi lần copy trên máy kia đã biết.
      st.localAt = st.lastLocalSig === undefined ? 0 : Date.now();
      st.lastLocalSig = sig;
    }
    const newer = st.localAt > st.remoteAt || (st.remoteAt === 0 && sig !== st.lastPushedSig);
    if (!newer) return pasteThere(shift);
    if (!caps()) {
      ui.toast('Máy này chạy bản Orbit Remote cũ nên chưa nhận thứ copy từ máy đang dùng: chạy Setup máy đó. Lần này dán clipboard của chính máy đó.');
      return pasteThere(shift);
    }
    const client = ui.client();
    if (text) {
      try {
        await client.clipText(text);
        st.lastPushedSig = sig;
        synced();
      } catch (err) {
        ui.toast(err.message, 'error');
      }
      return undefined;
    }
    if (busy) {
      ui.toast('Đang chép dở lần trước, chờ xong rồi dán tiếp.');
      return undefined;
    }
    ui.show({ text: 'Đang đọc tệp…', cancel: false });
    let items;
    try {
      items = await gatherClip(files, entries);
    } catch (err) {
      ui.show(null);
      ui.toast(`Không đọc được thứ đang copy: ${err.message}`, 'error');
      return undefined;
    }
    const ok = await transfer(`Đang dán ${clipLabel(items)}`, (signal, progress) => client.clipFiles(items, { signal, onProgress: progress }));
    if (ok) {
      st.lastPushedSig = sig;
      synced();
      ui.toast(`Đã dán ${clipLabel(items)} sang ${ui.machineName || 'máy kia'}.`);
    }
    return undefined;
  }

  // ---- Máy kia vừa có ai copy -------------------------------------------------------------------------
  async function onRemote(m) {
    const items = m.items || [];
    const sig = m.kind === 'text' ? clipSignature(m.text) : m.kind === 'files' ? clipSignature('', offerTops(items)) : '';
    if (!sig || sig === st.lastPushedSig) return; // trống, hay chính thứ vừa đưa sang
    if (sig === st.lastLocalSig) {
      // Máy này đã có đúng thứ đó: hai bên khớp, không đặt lại (đặt lại sẽ thành thay đổi mới, mời qua mời lại).
      st.remoteAt = st.localAt;
      return;
    }
    st.remoteAt = Date.now();
    const hasLocal = await localClip.available();
    if (m.kind === 'text') {
      const applied = () => { st.lastLocalSig = sig; st.localAt = st.remoteAt; };
      try {
        if (hasLocal) await localClip.text(m.text);
        else await navigator.clipboard.writeText(m.text); // trang đang được dùng thì ghi được ngay
        applied();
      } catch {
        // Trình duyệt chỉ cho ghi khi người dùng vừa bấm: mời bấm.
        notice('Vừa copy chữ trên máy kia', { label: 'Copy về máy này', run: () => navigator.clipboard.writeText(m.text).then(() => { applied(); notice(''); }, () => {}) }, 15000);
      }
      return;
    }
    if (!hasLocal) return; // chép tệp về cần đầu máy trên máy này (bản PC)
    const pull = (quiet) => transfer(`Đang chép ${clipLabel(items)} về máy này`, async (signal, progress) => {
      const id = newId();
      await localClip.begin(id, items.map(({ rel, size, dir, mtime }) => ({ rel, size, dir, mtime })));
      try {
        await ui.client().clipPull(m.seq, { signal, onChunk: (i, data) => localClip.chunk(id, i, data), onProgress: (got) => progress(got, m.total) });
        await localClip.end(id);
      } catch (err) {
        await localClip.cancel();
        throw err;
      }
    }, { quiet }).then((ok) => {
      if (!ok) return;
      st.lastLocalSig = sig;
      st.localAt = st.remoteAt;
      if (!quiet) ui.toast(`Đã chép ${clipLabel(items)} về máy này: Ctrl+V ở đây để dán.`);
    });
    if (m.total <= AUTO_MAX && !m.more) return void pull(true);
    notice(`Vừa copy ${clipLabel(items)} (${fmtBytes(m.total)}) trên máy kia`, { label: 'Chép về máy này', run: () => { notice(''); pull(false); } }, 20000);
  }

  // ---- Có ai copy ở máy này lúc đang xem: đưa sẵn sang máy kia ------------------------------------------
  async function onLocal(offer) {
    const items = offer.items || [];
    const sig = offer.kind === 'text' ? clipSignature(offer.text) : clipSignature('', offerTops(items));
    if (!sig || sig === st.lastLocalSig) return;
    st.lastLocalSig = sig;
    st.localAt = Date.now();
    if (!ui.live() || !caps()) return; // Ctrl+V sau này sẽ đưa sang
    const client = ui.client();
    if (offer.kind === 'text') {
      try {
        await client.clipText(offer.text, false);
        st.lastPushedSig = sig;
        synced();
      } catch { /* Ctrl+V sau này sẽ thử lại */ }
      return;
    }
    if (offer.total > AUTO_MAX || offer.more) return; // lớn: chỉ chép khi Ctrl+V
    const list = items.map((x, i) => (x.dir ? x : { ...x, read: (at, len) => localClip.read(offer.seq, i, at, len) }));
    const ok = await transfer(`Đang đưa ${clipLabel(items)} sang máy kia`, (signal, progress) => client.clipFiles(list, { paste: false, signal, onProgress: progress }), { quiet: true });
    if (ok) {
      st.lastPushedSig = sig;
      synced();
    }
  }

  async function watchLocal() {
    let since = 0;
    while (running) {
      try {
        const r = await localClip.watch(since, watchAbort.signal);
        since = r.seq;
        if (r.kind !== 'none') onLocal(r);
      } catch {
        if (!running) return;
        await sleep(2000);
      }
    }
  }

  return {
    onPaste,
    onRemote,
    pasteThere,
    remoteCopied() { st.remoteAt = Date.now(); }, // Ctrl+C, Ctrl+X gửi sang máy kia
    // Máy kia vừa báo làm được việc dán (mỗi lần nối lại cũng vậy): bảo nó báo mỗi lần có ai copy bên đó,
    // và theo dõi clipboard máy này nếu có đầu máy ở đây.
    async start() {
      const client = ui.client();
      if (!client?.caps?.clip) return;
      client.clipWatch(true);
      if (running) return;
      running = true;
      if (await localClip.available()) {
        watchAbort = new AbortController();
        watchLocal();
      }
    },
    stop() {
      running = false;
      watchAbort?.abort();
      watchAbort = null;
      busy?.abort();
      clearTimeout(noticeTimer);
    },
    cancel() { busy?.abort(); },
  };
}

// Phép kiểm: bỏ trạng thái nhớ giữa các ca.
export function resetClipState() {
  STATE.clear();
  LOCAL.checked = null;
}
