// Gọi API của trạm. Thẻ truy cập nằm trong cookie HttpOnly nên mã ở đây không bao giờ
// chạm vào nó; chỉ cần gửi kèm cookie cùng nguồn.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('orbit:unpaired'));
    throw new ApiError(res.status, data?.error || `Trạm trả mã ${res.status}.`);
  }
  return data;
}

export const api = {
  get: (path) => call('GET', path),
  post: (path, body = {}) => call('POST', path, body),
  put: (path, body = {}) => call('PUT', path, body),
};
