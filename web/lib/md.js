// Markdown rút gọn cho câu trả lời của Claude, an toàn theo thiết kế: TOÀN BỘ chữ được
// thoát HTML trước, rồi mới gắn đúng vài thẻ của chính mình vào. Không có đường nào để
// chữ của mô hình (hay của ai đó nó trích lại) trở thành HTML chạy được.
//
// Tệp trên máy chạy phiên: Claude hay dẫn ảnh, tệp nó vừa tạo bằng link file:/// hay đường dẫn tuyệt đối (đã thấy:
// "[app_icon.png](file:///D:/Projects/My%20Game/art/app_icon.png)"). Trình duyệt trên điện
// thoại không mở được đường đó, mà tệp lại nằm ở máy kia. opts.fileLinks: dựng thành <a class="file-link"
// data-path="..."> để màn phiên mở qua trạm (lib/render.js); không có thì chỉ hiện tên, rê vào thấy đường dẫn.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// Đường dẫn tệp trên máy từ đích của một link: file:///D:/a%20b/c.png, file:///home/a/c.png, D:\a\c.png, D:/a/c.png,
// /home/a/c.png. Phải có đuôi tệp (thư mục thì không mở được). Đường mạng (file://máy/..., \\máy\...) thì bỏ.
// Trả '' nếu không phải tệp trên máy.
export function localPath(target) {
  let p = String(target || '').trim();
  if (/^file:/i.test(p)) {
    const m = /^file:\/\/(?:localhost)?(\/[^?#]*)$/i.exec(p);
    if (!m) return '';
    try {
      p = decodeURIComponent(m[1]);
    } catch {
      return '';
    }
    if (/^\/[a-z]:[\\/]/i.test(p)) p = p.slice(1); // /D:/a → D:/a
  } else if (!/^[a-z]:[\\/]/i.test(p) && !/^\/[^/\\]/.test(p)) {
    return '';
  }
  if (p.length > 1000 || /[\x00-\x1f]/.test(p) || !/[^\\/]\.[a-z0-9]{1,8}$/i.test(p)) return '';
  return p;
}

const baseName = (p) => p.split(/[\\/]/).pop();

// label: chữ đã thoát HTML.
function fileTag(path, label, opts) {
  const p = esc(path);
  return opts.fileLinks
    ? `<a class="file-link" role="link" tabindex="0" data-path="${p}" title="${p}">${label}</a>`
    : `<span class="file-ref" title="${p}">${label}</span>`;
}

function inline(text, opts) {
  const codes = [];
  let s = esc(text).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
    // [tên](đích) hay ![tên](đích) trỏ tới tệp trên máy. Đích có dấu cách thì Claude bọc <...>; đường ổ đĩa viết
    // thẳng (D:\a b\c (1).png, Program Files (x86)) thì cho cả dấu cách và một lớp ngoặc. Đích khác (http) để nguyên.
    .replace(/!?\[([^\]\n]*)\]\((?:&lt;([^\n]+?)&gt;|([a-z]:[\\/](?:[^()\n]|\([^()\n]*\))+)|([^)\s]+))\)/gi, (all, t, angled, drive, plain) => {
      const p = localPath(unesc(angled || drive || plain));
      return p ? fileTag(p, t || esc(baseName(p)), opts) : all;
    })
    .replace(/(^|[\s(])(file:\/\/\/[^\s<)]+)/gi, (all, pre, u) => {
      const p = localPath(unesc(u));
      return p ? `${pre}${fileTag(p, esc(baseName(p)), opts)}` : all;
    })
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  // Mã trong dấu ` chỉ gồm đúng một đường dẫn tệp tuyệt đối (cách Claude hay ghi đường dẫn): mở được như link.
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const c = codes[Number(i)];
    const p = opts.fileLinks && /^(?:[a-z]:[\\/]|file:\/\/\/)/i.test(c) ? localPath(unesc(c)) : '';
    return p ? fileTag(p, `<code>${c}</code>`, opts) : `<code>${c}</code>`;
  });
}

export function renderMarkdown(src, opts = {}) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items }

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(l, opts)).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, opts)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      flushList();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      out.push(`<pre class="code"${fence[1] ? ` data-lang="${esc(fence[1])}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      out.push(`<h${heading[1].length + 2}>${inline(heading[2], opts)}</h${heading[1].length + 2}>`);
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      flushList();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i -= 1;
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells);
      const [head, ...rest] = body;
      out.push(`<div class="table-wrap"><table><thead><tr>${(head || []).map((c) => `<th>${inline(c, opts)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c, opts)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('');
}
