// Hỏi-đáp trên một đường thông điệp một chiều mỗi bên.
//
// Trạm và đầu máy nói chuyện bằng thông điệp JSON rời rạc (ống nội bộ, luồng SSE, hay
// gọi hàm trực tiếp khi cùng tiến trình). Lớp này gắn mã `rid` vào mỗi câu hỏi và khớp
// câu trả lời về đúng chỗ, để hai bên khỏi tự đếm.

let counter = 0;

export class Rpc {
  constructor(send, timeoutMs = 20000) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.waiting = new Map();
  }

  // timeoutMs: lệnh chạy lâu (git push chạy cả hook của kho) cho thời gian chờ riêng.
  request(message, timeoutMs = this.timeoutMs) {
    counter += 1;
    const rid = `q${counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(rid);
        reject(new Error('Không nhận được trả lời kịp lúc.'));
      }, timeoutMs);
      this.waiting.set(rid, { resolve, reject, timer });
      try {
        this.send({ ...message, rid });
      } catch (err) {
        clearTimeout(timer);
        this.waiting.delete(rid);
        reject(err);
      }
    });
  }

  // Trả true nếu thông điệp là câu trả lời cho một câu hỏi của mình.
  handleReply(message) {
    if (message.op !== 'reply') return false;
    const w = this.waiting.get(message.rid);
    if (!w) return true;
    this.waiting.delete(message.rid);
    clearTimeout(w.timer);
    if (message.ok) w.resolve(message.data);
    else w.reject(new Error(message.error || 'Bên kia báo hỏng.'));
    return true;
  }

  failAll(reason) {
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
    this.waiting.clear();
  }
}

// Chạy một hàm xử lý rồi gửi trả lời đúng định dạng, kể cả khi hàm ném lỗi.
export async function answer(send, message, handler) {
  try {
    const data = await handler();
    send({ op: 'reply', rid: message.rid, ok: true, data });
  } catch (err) {
    send({ op: 'reply', rid: message.rid, ok: false, error: err.message });
  }
}
