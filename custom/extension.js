// Phần mở rộng của bạn cho Orbit Remote. App nạp file này sau khi khởi động và gọi hàm
// mặc định với đối tượng `orbit`:
//
//   orbit.store                 trạng thái sống: orbit.store.sessions, .machines, .channel
//   orbit.on(loại, hàm)         nghe sự kiện: 'session', 'any-event', 'channel', 'machine'...
//   orbit.send(mãPhiên, chữ)    gửi một lượt vào phiên
//   orbit.createSession(mẫu)    mở phiên mới, ví dụ { cwd, name, permissionMode, prompt }
//   orbit.addHomeButton({ label, run })      thêm nút ở màn chính
//   orbit.addSessionButton({ label, run })   thêm nút trong màn hội thoại; run(phiên, orbit)
//   orbit.toast(chữ)            hiện thông báo ngắn
//   orbit.api.get/post/put      gọi thẳng API của trạm
//
// File này đang để trống có chủ đích. Bỏ chú thích ví dụ dưới đây để thử.

export default function setup(orbit) {
  // Ví dụ 1: nút đóng mọi phiên đang rảnh.
  // orbit.addHomeButton({
  //   label: 'Đóng phiên rảnh',
  //   confirm: 'Đóng mọi phiên đang ở trạng thái Sẵn sàng?',
  //   run: async () => {
  //     const idle = [...orbit.store.sessions.values()].filter((s) => s.status === 'idle');
  //     await Promise.all(idle.map((s) => orbit.api.post(`/api/sessions/${s.id}/close`)));
  //     orbit.toast(`Đã đóng ${idle.length} phiên.`);
  //   },
  // });

  // Ví dụ 2: báo khi một phiên xin quyền.
  // orbit.on('any-event', ({ id, ev }) => {
  //   if (ev.t === 'permission') orbit.toast(`${orbit.store.sessions.get(id)?.name} cần duyệt ${ev.tool}`);
  // });
  void orbit;
}
