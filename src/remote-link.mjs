// Đường nối của một đầu máy đứng riêng (máy không giữ trạm) về trạm qua mạng.
//
// Đầu máy luôn là bên chủ động gọi ra: một luồng SSE dài để nhận lệnh, cộng các POST gộp
// lô để báo sự kiện. Nhờ vậy máy này không phải mở cổng nào, chỉ cần với tới được trạm
// (cùng mạng nhà, hoặc qua địa chỉ HTTPS công khai của trạm).
//
// `connectOnce` chạy đúng một lần nối và trả về lý do kết thúc. Việc thử lại, dò lại trạm
// khi trạm đổi địa chỉ, hay xin nối lại khi bị thu hồi thẻ là của vòng ngoài (node-runner.mjs).

const FLUSH_MS = 40;
const BATCH_MAX = 200;
// Một lô POST không vượt chừng này (đo bằng độ dài chuỗi JSON): khúc tệp đính kèm ~700 KB mỗi tin, vài
// lượt xem song song dồn vào một lô thì vượt giới hạn 1 MB mà trạm bản cũ nhận, làm đứt đường nối.
const BATCH_CHARS = 768 * 1024;

// Trả về { reason: 'closed' | 'unauthorized' | 'unreachable', linked: boolean }.
export async function connectOnce(agent, { hubUrl, token, log = () => {}, signal }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  let res;
  try {
    res = await fetch(new URL('/node/link', hubUrl), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
  } catch {
    signal?.removeEventListener('abort', abort);
    return { reason: 'unreachable', linked: false };
  }
  if (res.status === 401) return { reason: 'unauthorized', linked: false };
  if (!res.ok || !res.body) return { reason: 'unreachable', linked: false };

  let linkId = null;
  let queue = [];
  let timer = null;
  let posting = Promise.resolve();

  const flush = () => {
    timer = null;
    if (!queue.length || !linkId) return;
    // Luôn lấy ít nhất một tin, kể cả khi riêng nó đã quá BATCH_CHARS.
    const parts = [];
    let chars = 0;
    for (let i = 0; i < queue.length && parts.length < BATCH_MAX; i += 1) {
      const text = JSON.stringify(queue[i]);
      if (parts.length && chars + text.length > BATCH_CHARS) break;
      parts.push(text);
      chars += text.length;
    }
    queue.splice(0, parts.length);
    const body = `[${parts.join(',')}]`;
    posting = posting.then(async () => {
      const r = await fetch(new URL('/node/push', hubUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Orbit-Link': linkId },
        body,
      });
      if (!r.ok) controller.abort(); // đường nối đã đứt phía trạm: dựng lại từ đầu
    }).catch(() => controller.abort());
    if (queue.length) timer = setTimeout(flush, 0);
  };
  const send = (message) => {
    queue.push(message);
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let message;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        if (message.op === 'linked') {
          linkId = message.linkId;
          agent.hubUrl = hubUrl; // địa chỉ trạm đang nối được, cho cổng mở app trên máy này (app-proxy.mjs)
          agent.attach(send);
          log(`Đã nối tới trạm ${hubUrl}`);
        } else {
          agent.handle(message);
        }
      }
    }
  } catch {
    // bị huỷ hoặc rớt mạng giữa chừng
  } finally {
    if (timer) clearTimeout(timer);
    if (linkId) agent.detach();
    signal?.removeEventListener('abort', abort);
  }
  return { reason: 'closed', linked: Boolean(linkId) };
}
