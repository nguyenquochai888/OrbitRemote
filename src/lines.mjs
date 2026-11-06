// Khung tin JSON một dòng cho ống nội bộ. Gói thành hàm để hai đầu không bao giờ lệch nhau.

export function toLine(message) {
  return `${JSON.stringify(message)}\n`;
}

// Cắt luồng chữ thành từng dòng JSON, gọi lại cho mỗi dòng đọc được. Dòng hỏng thì bỏ,
// không làm chết cả luồng.
export function lineSplitter(onMessage) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!text) continue;
      try {
        onMessage(JSON.parse(text));
      } catch {
        // dòng hỏng
      }
    }
  };
}
