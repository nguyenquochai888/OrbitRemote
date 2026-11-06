# Bảng token / Token table

Token là lệnh tắt gõ trong ô soạn, bắt đầu bằng `$` (ví dụ `$qa kiểm màn đăng nhập`). Orbit Remote đọc bảng
dưới đây để:

- hiện các token trong danh sách **Lệnh nhanh** của màn một phiên;
- dùng token làm **vai trò** của phiên trong nhóm phiên (chỉ token có `[...]` sau tên, tức token nhận thêm nội dung);
- khi lời nhắn có một token trong bảng, gắn kèm cho Claude một ghi chú ẩn: token đó là gì và tệp đặc tả của nó nằm đâu
  trên máy chạy phiên, để Claude đọc đặc tả rồi làm đúng theo.

Bảng đang trống có chủ đích. Thêm token của riêng bạn như sau:

1. Viết tệp đặc tả trong thư mục `custom/tokens/`, ví dụ `custom/tokens/qa.md`. Dòng đầu có dạng
   `` # `$qa [yêu cầu]` — kiểm chất lượng toàn diện ``: phần sau dấu gạch là ghi chú hiện trong Lệnh nhanh.
   Phần còn lại là lời dặn Claude phải làm gì khi gặp token này.
2. Thêm một dòng vào bảng: tên token trong dấu `` ` ``, mô tả ngắn, và đường dẫn tệp đặc tả tính từ thư mục `custom/`.
   Token có `[...]` sau tên nhận thêm nội dung (Lệnh nhanh điền sẵn vào ô soạn, làm được vai trò trong nhóm); token không
   có `[...]` là lệnh chạy thẳng (Lệnh nhanh hỏi lại rồi gửi luôn).

Ví dụ một dòng: `` | `$qa [yêu cầu]` | Kiểm chất lượng toàn diện. | `tokens/qa.md` | ``

App đọc lại bảng mỗi lần tệp đổi. Máy giữ trạm dùng bảng của nó cho Lệnh nhanh và vai trò; mỗi máy chạy phiên dùng bảng
và tệp đặc tả của chính nó khi gắn ghi chú cho Claude, nên các máy nên có cùng bảng (chép sang, hoặc commit vào bản fork
riêng).

---

Tokens are shortcuts typed in the composer, starting with `$`. Orbit Remote reads the table below to list them under
**Quick commands**, to use tokens that take a request (`[...]` after the name) as **roles** in session groups, and to
attach a hidden note telling Claude where the token's spec file is. The table is empty on purpose: write a spec file in
`custom/tokens/` and add one row per token, with the spec path relative to `custom/`.

| Token | Việc làm / What it does | Đặc tả / Spec |
|---|---|---|
