// Dựng DOM gọn mà an toàn: chuỗi luôn thành nút chữ, không bao giờ thành HTML.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'html') el.innerHTML = value; // chỉ dùng cho nội dung đã được làm sạch
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// Thêm con vào một phần tử có sẵn, bỏ qua null và false. Đừng dùng `el.append` gốc cho
// danh sách có nhánh điều kiện: nó in nguyên chữ "null" ra màn hình.
export function add(el, ...children) {
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return 'vừa xong';
  if (diff < 3600) return `${Math.round(diff / 60)} phút`;
  if (diff < 86400) return `${Math.round(diff / 3600)} giờ`;
  if (diff < 7 * 86400) return `${Math.round(diff / 86400)} ngày`;
  return new Date(iso).toLocaleDateString('vi-VN');
}

export function clockTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
}

export function baseName(path) {
  if (!path) return '';
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

// Phiên làm việc trên máy khác (s.remote, chọn "Làm việc trên máy" khi mở phiên): thư mục dự án là thư mục trên máy
// đó, chỗ làm việc ghi "máy chạy → máy làm việc". Phiên thường: thư mục và máy của chính nó.
export const workDir = (s) => s?.remote?.cwd || s?.cwd || '';
export const workPlace = (s) => (s?.remote?.machine ? `${s.machine} → ${s.remote.machine}` : s?.machine || '');

let toastTimer = null;
export function toast(text, kind = 'info') {
  const root = document.getElementById('toast-root');
  clear(root);
  const el = h('div', { class: `toast toast-${kind}` }, text);
  root.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, kind === 'error' ? 5000 : 2600);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Đã chép.');
  } catch {
    toast('Không chép được, hãy chọn và chép tay.', 'error');
  }
}
