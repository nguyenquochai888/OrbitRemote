# Orbit Remote

[English](README.md) · **Tiếng Việt**

Điều khiển mọi phiên Claude Code trên mọi máy tính của bạn từ điện thoại: mở phiên, chat, duyệt quyền, xem và điều
khiển màn hình máy, cho các phiên nhắn tin và làm việc nhóm với nhau, kể cả khi chúng chạy trên những máy khác nhau.

- App là một **PWA** (trang web cài ra màn hình chính): không cần App Store, không cần tài khoản Apple Developer.
- **Không dùng thư viện ngoài nào**, chỉ cần Node.js 20 trở lên.
- Dữ liệu chỉ đi giữa các máy của bạn. Khi ra ngoài, app vào trạm qua **Tailscale** (mạng riêng của chính bạn).
- Giao diện app hiện bằng tiếng Việt.

## Tính năng

**Máy và phiên**

- Máy nào chạy Orbit Remote là **tự hiện** trên app: lần đầu bấm **Cho nối** một lần, từ đó máy được nhớ, kể cả lúc tắt.
  Màn chính là cây **Online / Offline**: máy, nhóm phiên và phiên của từng máy.
- **Mở phiên mới, đóng, chạy lại** trên đúng máy mình chọn; **mở lại phiên cũ** từ nhật ký Claude Code; xem (chỉ đọc),
  tiếp tục hay tách nhánh các phiên đang mở tay trong VS Code hoặc terminal.
- **Chat, dừng lượt đang chạy, duyệt quyền** (cho phép, từ chối, luôn cho phép) và trả lời câu hỏi nhiều lựa chọn của Claude.
- Ô soạn như app Claude: đính kèm tệp và ảnh (dán bằng Ctrl+V được), chọn model, effort, chế độ quyền, nói thay gõ,
  giữ phần soạn dở của từng phiên. Ảnh và tệp Claude nhắc tới trong câu trả lời mở xem được ngay trên điện thoại.
- **Duyệt thư mục làm việc** trên máy sẽ chạy phiên khi mở phiên mới.
- **Remote Control**: bật cho một phiên để tiếp tục nó trên claude.ai/code hay app Claude.
- **Tag phiên** bằng `@Tên-phiên` trong ô soạn để chỉ đích danh một phiên bất kỳ, ở máy nào cũng được.
- **Lệnh nhanh**: Tiếp tục, Báo tiến độ, Rà thay đổi, Chạy kiểm, Commit, Commit và push, Restart trạm, Setup máy, cùng
  mọi token trong bảng token (xem "Tuỳ biến").
- **Luôn dùng bản model mới nhất** của ba dòng Opus, Sonnet, Haiku: một nút trên app hỏi danh sách model của Anthropic rồi
  chuyển mọi máy và phiên đang chạy sang bản mới.

**Màn hình máy** (máy Windows)

- Xem và điều khiển màn hình qua `ffmpeg` (H.264 hay JPEG), chọn **màn hình, ứng dụng hay thư mục** đang mở, ba mức chất
  lượng (Nhanh, Nét, Tiết kiệm), tự hạ mức khi mạng nghẽn.
- Ba chế độ điều khiển: **chạm**, **chuột** (như bàn di chuột), **tay cầm** (cần ảo dời chuột, bốn nút nhấp và cuộn);
  phóng to, kéo thả, bàn phím iPhone gõ thẳng vào máy kể cả tiếng Việt, dãy phím Ctrl, Alt, Win, F5...
- **Xoay theo điện thoại**: màn hình hay cửa sổ đổi ngang dọc cho khớp chiều đang xem, thôi xem là trả như cũ.
- **Clipboard hai chiều** như Remote Desktop: dán chữ, tệp, cả thư mục sang máy đang xem và chép ngược về.
- **Xem và gõ mật khẩu ở màn khoá**, bấm bảng UAC (tuỳ chọn, cài một chương trình chạy bằng quyền SYSTEM).
- **Phiên nổi**: chat với một phiên trong khung nổi ngay trên màn hình đang xem.

**Quản lý máy**

- **Tắt máy** ngay hay hẹn giờ; **bật máy qua mạng** (Wake-on-LAN), trạm nhờ một máy đang bật cùng mạng bắn gói hộ.
- **Nhiệt độ** CPU, GPU, ổ đĩa, bo mạch (đầy đủ khi cài chương trình đo tuỳ chọn; không có thì GPU NVIDIA và vùng nhiệt ACPI).
- **Tài khoản Claude của từng máy**: xem đang đăng nhập bằng gì, đăng nhập tài khoản khác ngay từ điện thoại.
- **Mức dùng Claude**: phiên 5 giờ, tuần, giờ reset, và tổng token Claude Code mọi máy đã dùng trong tuần kèm số ước còn lại.
- **Setup từ xa**: một nút để máy kéo code mới, cài phần còn thiếu và chạy lại; kết quả hiện trên app.
- **Bản PC**: app mở thành cửa sổ riêng của Edge, bố cục hai cột khi cửa sổ rộng; lối tắt ở Start và Desktop.

**Nhiều phiên làm việc cùng nhau**

- **Các phiên nhắn tin cho nhau**, kể cả khác máy: tin được đẩy thẳng vào phiên nhận thành một lượt mới. Tin chỉ để báo
  (`needs_action: false`) được giữ lại và gộp vào lượt kế tiếp của người nhận, đỡ tốn token.
- **Phiên làm việc trên máy khác**: một phiên chạy ở máy A chạy lệnh, đọc sửa tệp, chụp và bấm màn hình của máy B (máy B phải
  cho phép).
- **Chuyển phiên sang máy khác**: commit tạm phần sửa dở, đẩy lên, máy đích kéo về, chép nhật ký phiên, chạy tiếp với đủ
  ngữ cảnh.
- **Nhóm phiên**: gom nhiều phiên vào một nhóm có trưởng nhóm và mục tiêu chung, gán cho mỗi phiên một vai trò (một token
  trong bảng token), bấm Bắt đầu. Trưởng nhóm chia việc, giao việc, nghiệm thu; có bảng việc, hàng chờ cho từng thành viên,
  bảng tin dụng cụ dùng chung (Unity, Blender...), chi phí và ngân sách token, tự nén ngữ cảnh, tạm dừng và chạy tiếp.

## Cần gì

- **Windows 10 hay 11** cho đầy đủ tính năng (màn hình, chuột phím, tắt bật máy, nhiệt độ). Bộ cài và tự chạy hiện chỉ
  làm cho Windows; trên macOS hay Linux thì chạy tay `node src/main.mjs node` (phần trạm, phiên và nhắn tin, chưa kiểm kỹ
  ngoài Windows).
- **Node.js 20+**, **Git**, **Claude Code** đã đăng nhập. `setup.cmd` tự cài những thứ còn thiếu bằng winget, kể cả
  `ffmpeg`.
- **Tailscale** (không bắt buộc) nếu muốn dùng khi ra ngoài.

## Bắt đầu

Trạm là máy chủ nhỏ của Orbit Remote; app trên điện thoại gắn với địa chỉ của trạm. Đặt trạm trên một máy luôn bật ở nhà.
Mọi máy khác là **máy chạy phiên**: chúng tự tìm trạm và xin nối.

1. Trên máy định giữ trạm: clone repo này, nháy đúp **`setup.cmd`** (chạy lại bao nhiêu lần cũng được: bước đã xong chỉ được
   kiểm lại), rồi nháy đúp **`run.cmd`**. Cửa sổ in mã QR và mã ghép đôi 6 số.
2. Trên iPhone: mở **Camera**, quét mã, chạm đường dẫn. Safari mở trang ghép: **Chia sẻ → Thêm vào Màn hình chính**, rồi mở
   Orbit Remote từ màn hình chính (app tự ghép bằng mã trong địa chỉ).
3. Trên mỗi máy khác: clone repo, nháy đúp `setup.cmd`. Màn chính của app hiện thẻ **Máy mới xin nối**: bấm **Cho nối**.

Chỉ chạy **một trạm** cho mỗi app: `run.cmd` trên máy khác chỉ dựng đầu máy và báo không cần quét gì. Muốn chuyển vai trạm
sang máy khác (hiếm khi cần): `node src/main.mjs start --hub` trên máy đó.

Lấy mã ghép đôi mới: chạy lại `run.cmd`, `node src/main.mjs pair`, hoặc trên thiết bị đã ghép vào **Cài đặt → Ghép điện
thoại bằng mã QR**.

### Bộ cài làm gì

`setup.cmd` kéo code mới nhất (`git pull --ff-only`), cài Node.js nếu thiếu, rồi chạy `node src/main.mjs setup`, kiểm từng
bước trên máy thật, thiếu thì cài và kiểm lại:

| Bước | Ghi chú |
|---|---|
| Node.js 20+, Git, Claude Code | Cài bằng winget hay npm. Đăng nhập Claude Code thì gõ `claude` một lần (chỉ nhắc). |
| `ffmpeg` có `ddagrab`, quay thử một khung | Để xem màn hình. Thử đúng chuỗi lùi DXGI rồi GDI, nén phần cứng rồi `libx264`. |
| Chuột và phím | Dịch `src/win-input.cs` bằng `csc.exe` có sẵn trong Windows. |
| Màn khoá (không bắt buộc) | Một hộp thoại UAC: cài `src/win-secure.cs` thành tác vụ "Orbit Remote Secure Desktop" chạy bằng SYSTEM. |
| Nhiệt độ (không bắt buộc) | Một hộp thoại UAC: driver PawnIO, LibreHardwareMonitor 0.9.6 (so SHA256), tác vụ "Orbit Remote Sensors". |
| Tường lửa | Một hộp thoại UAC: mở TCP 8796 (màn hình); trên máy giữ trạm thêm TCP/UDP 8795. |
| Tailscale | Cài và đăng nhập cùng tài khoản với máy giữ trạm; `tailscale set --unattended` để chạy cả trước khi đăng nhập Windows. |
| Wake-on-LAN (không bắt buộc) | Một hộp thoại UAC: bật đánh thức qua mạng cho card có dây, tắt Fast Startup. BIOS thì chỉ nhắc. |
| Tự chạy, lối tắt bản PC | Tự chạy khi đăng nhập Windows; lối tắt **Orbit Remote** ở Start và Desktop. |
| Chạy bản code mới nhất, nối trạm | Khởi động lại đầu máy (hỏi trước nếu còn phiên làm dở), chờ bạn bấm **Cho nối** trên app. |

Chỉ kiểm, không đụng gì: `node src/main.mjs doctor`. Không muốn hộp thoại UAC: `setup.cmd --no-admin`.

## Dùng khi ra ngoài: Tailscale

[Tailscale](https://tailscale.com) nối các máy đăng nhập cùng một tài khoản thành một mạng riêng, mã hoá đầu cuối. Trạm
không phải mở cổng hay cấp chứng chỉ gì.

Trên máy giữ trạm, trong thư mục repo, sau khi cài và đăng nhập Tailscale:

```
node src/main.mjs tailnet setup      # khai địa chỉ Tailscale của trạm
node src/main.mjs restart            # trạm khai địa chỉ mới cho app và các máy
node src/main.mjs tailnet status     # Tailscale có chạy không, trạm trả lời qua đó không
```

- **Điện thoại**: cài app Tailscale, đăng nhập cùng tài khoản, bật lên, rồi quét lại mã QR (mã giờ trỏ vào địa chỉ
  Tailscale). App cài từ địa chỉ này dùng được cả ở nhà lẫn bên ngoài.
- **Máy khác ở mạng khác**: cài Tailscale cùng tài khoản. `tailnet setup` ghi địa chỉ trạm vào `custom/hub.json`; máy nào có
  file đó thì tự tìm ra trạm. File này là của riêng bạn nên `.gitignore` bỏ qua nó: chép sang máy kia, commit vào bản fork
  riêng bằng `git add -f custom/hub.json`, hoặc trên máy kia chạy một lần `node src/main.mjs join http://<IP Tailscale của trạm>:8795`.

Qua Tailscale trạm chỉ có `http://`, mà trình duyệt chặn bộ giải mã video và service worker trên trang `http://` lạ. Vì
vậy bản PC mở app qua cổng `127.0.0.1:8797` của đầu máy (chuyển tiếp tới trạm), và màn hình máy nối thẳng tới máy bằng
WebSocket chứ không vòng qua trạm.

## Bản PC

Nháy đúp lối tắt **Orbit Remote** (do `setup.cmd` tạo) hay chạy `node src/main.mjs app`: app mở thành cửa sổ riêng của
Edge (không có Edge thì Chrome), hồ sơ trình duyệt riêng. Cửa sổ rộng từ 1100 px thì chia hai cột: cột trái là màn chính,
cột phải là màn đang mở; kéo thanh giữa để đổi bề rộng. Trên máy giữ trạm cửa sổ tự ghép đôi; trên máy khác thì gõ mã lấy ở
**Cài đặt → Ghép điện thoại bằng mã QR** trên một thiết bị đã ghép.

## Tuỳ biến

Mọi thứ tuỳ biến nằm trong `custom/`:

| Tệp | Việc |
|---|---|
| `custom/actions.json` | Nút bấm: một dòng trong **Lệnh nhanh** của màn phiên (`"scope": "session"`) hay nút ở màn chính (`"home"`). Sửa được ngay trên app ở **Cài đặt → Nút bấm tuỳ biến**. |
| `custom/tokens.md` | Bảng token: lệnh tắt `$tên` gõ trong ô soạn và vai trò của phiên trong nhóm. Để trống sẵn. |
| `custom/theme.css` | Đè biến màu, cỡ chữ, bo góc (danh sách biến ở đầu `web/styles.css`). |
| `custom/extension.js` | Mã JS tuỳ ý: nghe sự kiện, gửi tin, mở phiên, thêm nút, gọi API của trạm. Ví dụ nằm sẵn trong file. |

### Nút bấm (`actions.json`)

| Khoá | Ý nghĩa |
|---|---|
| `label` | Chữ trên nút (bắt buộc). |
| `scope` | `"session"`: một dòng trong Lệnh nhanh. `"home"`: nút ở màn chính. |
| `hint` | Dòng ghi chú dưới tên trong Lệnh nhanh. |
| `send` | Gửi ngay câu này vào phiên đang mở. |
| `fill` | Điền sẵn câu này vào ô soạn để sửa tiếp. |
| `broadcast` | Gửi câu này cho mọi phiên đang chạy. |
| `newSession` | Mở phiên theo mẫu: `cwd`, `name`, `model`, `permissionMode`, `prompt`, `machine`; thêm `"direct": true` để mở luôn. |
| `confirm` | `true` hay một câu hỏi: hỏi lại trước khi chạy. |
| `icon` | Tên biểu tượng trong `web/lib/icons.js` (chỉ cho nút ở màn chính). |

### Bảng token (`tokens.md`)

Mỗi token là một dòng bảng kèm một tệp đặc tả trong `custom/tokens/`:

```
| `$qa [yêu cầu]` | Kiểm chất lượng toàn diện. | `tokens/qa.md` |
```

- Dòng đầu của tệp đặc tả có dạng `` # `$qa [yêu cầu]` — kiểm chất lượng toàn diện ``; phần sau dấu gạch hiện trong Lệnh
  nhanh. Phần còn lại là lời dặn Claude phải làm gì khi gặp token.
- Token có `[...]` nhận thêm nội dung: Lệnh nhanh điền sẵn vào ô soạn, và token **làm được vai trò** trong nhóm phiên.
  Token không có `[...]` là lệnh chạy thẳng: Lệnh nhanh hỏi lại rồi gửi.
- Lời nhắn có token trong bảng thì Claude nhận kèm một ghi chú ẩn: token đó là gì và tệp đặc tả nằm đâu trên máy chạy
  phiên. Thành viên nhóm nhận việc thì nhận kèm đường dẫn tệp đặc tả của vai trò mình.
- Máy giữ trạm dùng bảng của nó cho Lệnh nhanh và vai trò; mỗi máy chạy phiên dùng bảng của chính nó khi gắn ghi chú, nên
  các máy nên có cùng bảng.

### Mặc định của phiên mới

Phiên mở từ app bắt đầu bằng **Opus**, effort **rất cao** và quyền **Bỏ qua quyền** (`NEW_SESSION_DEFAULTS` trong
`web/lib/custom.js`); bảng Phiên mới đổi được từng thứ. Muốn mặc định an toàn hơn thì sửa hằng đó, ví dụ
`permissionMode: 'default'` (hỏi từng lần).

## Công cụ MCP của mỗi phiên

Mỗi phiên do Orbit Remote mở có thêm các công cụ sau (máy chủ MCP `orbit-remote`):

| Công cụ | Việc |
|---|---|
| `orbit_remote_sessions` | Liệt kê phiên đang chạy trên mọi máy. |
| `orbit_remote_send` | Gửi tin tới một phiên (mã, tên, `tên@máy`), `*` cho tất cả, `#group` cho cả nhóm. `needs_action` bắt buộc: `false` là tin chỉ để báo. |
| `orbit_remote_group` | Làm việc trong nhóm: xem, giao việc, báo xong, nghiệm thu, đăng ký dụng cụ, nén hay xoá ngữ cảnh, báo đạt mục tiêu. |
| `orbit_machines` | Các máy và phiên này có được làm việc trên máy nào. |
| `orbit_machine_run`, `_read`, `_write`, `_edit`, `_find` | Chạy lệnh, đọc, ghi, sửa, tìm tệp trên máy khác. |
| `orbit_machine_screen`, `_input` | Chụp màn hình, bấm chuột và gõ phím trên máy khác (Windows). |
| `orbit_machine_unity` | Gọi vỏ dòng lệnh của Orbit Unity MCP trên máy khác; máy đó phải khai đường dẫn tới `cli.mjs` bằng biến môi trường `ORBIT_UNITY_MCP_CLI`. |

Máy đích phải cho phép: màn của máy đó → nút ba chấm → **Cho phiên ở máy khác điều khiển**.

## Lệnh

```
node src/main.mjs                   chạy trạm (kèm đầu máy của chính máy này)
node src/main.mjs start             dựng trạm nếu chưa chạy, in mã QR (run.cmd)
node src/main.mjs open              như start, rồi mở app trên trình duyệt máy này
node src/main.mjs app [--pair]      bản PC: cửa sổ app riêng của Edge
node src/main.mjs pair              in mã ghép đôi mới
node src/main.mjs node              chạy đầu máy: tự tìm trạm, xin nối, nối (run-node.cmd)
node src/main.mjs ensure            dựng trạm hoặc đầu máy chạy nền nếu chưa chạy
node src/main.mjs join <url> [mã]   chỉ địa chỉ trạm cho máy này
node src/main.mjs autostart on|off  tự chạy "ensure" mỗi lần đăng nhập Windows
node src/main.mjs disable|enable    tắt hay bật Orbit Remote trên máy này
node src/main.mjs tailnet setup|status|off
node src/main.mjs restart [--force] khởi động lại trạm
node src/main.mjs setup [--no-admin]  cài và kiểm (setup.cmd)
node src/main.mjs doctor            chỉ kiểm
node src/main.mjs update            git pull rồi setup tự động (nút Setup máy trên app)
```

Biến môi trường `ORBIT_REMOTE_OFF=1` cũng tắt Orbit Remote trên một máy.

## An toàn

- Mọi yêu cầu tới trạm phải mang thẻ, kể cả từ 127.0.0.1. Thẻ chỉ lưu dạng băm SHA-256.
- Mã ghép đôi 6 số dùng một lần, sống 10 phút, sai 5 lần thì mọi mã chết.
- Máy mới chỉ nhận thẻ khi bạn bấm **Cho nối**; thẻ của một máy gắn với mã của máy đó.
- POST chỉ nhận JSON, cookie `SameSite=Lax` và `HttpOnly`; chữ của Claude được thoát HTML trước khi dựng markdown; CSP chặn
  script ngoài.
- Màn hình vào cửa bằng vé dùng một lần, sống 60 giây. Chương trình màn khoá và chương trình đo chỉ nghe 127.0.0.1; chương
  trình màn khoá đòi khoá bí mật chỉ SYSTEM, Administrators và người cài đọc được.
- Thu hồi một thiết bị: **Cài đặt → Thiết bị đã ghép → Thu hồi**. Thu hồi một máy: màn của máy → **Quên máy này**.

Cổng mặc định: 8795 trạm (HTTP, UDP dò tìm), 8796 màn hình, 8797 cổng app của bản PC (chỉ 127.0.0.1), 8798 chương trình đo
nhiệt độ, 8799 chương trình màn khoá (hai cái cuối chỉ 127.0.0.1).

## Giới hạn đã biết

- Phiên mở tay trong VS Code hay terminal thì xem, tiếp tục (sau khi đóng bên kia) hay tách nhánh được, nhưng không điều
  khiển trực tiếp lúc nó đang chạy ở đó; trường hợp đó dùng Remote Control của Anthropic.
- Tự dò trạm qua UDP chỉ đi trong cùng mạng nhà; ở mạng khác cần `custom/hub.json` hay lệnh `join`.
- Màn hình chỉ có cho máy Windows có `ffmpeg`, chỉ các màn nối vào card màn hình thứ nhất. iPhone không cho toàn màn hình
  thật nên "toàn màn hình" là khung phủ kín app.
- Chưa có thông báo đẩy khi app đang đóng. Trạm tắt thì các phiên nó mở dừng theo (chạy lại được, ngữ cảnh còn nguyên).
- Chuyển phiên cần git có remote chung và thư mục đích đã clone sẵn; tệp ngoài git không đi theo.

## Tệp trạng thái

Riêng từng máy, ở `~/.orbit/state/remote/`, không vào git: `config.json` (cổng, host, `claudeCommand`, địa chỉ Tailscale),
`auth.json` (thiết bị và máy đã ghép, thẻ dạng băm), `hub.json` (phiên, máy, nhóm), `machine.json`, `node.json`,
`role.json`, `local-secret.json`, `uploads/`, `app-profile/`, nhật ký `hub.log` và `node.log`. Bảng bản model mới nhất ở
`~/.orbit/state/models.json`; máy chưa có bảng thì dùng `data/models.json` của repo.

## Gỡ phần cài thêm

```
Unregister-ScheduledTask -TaskName 'Orbit Remote Sensors' -Confirm:$false
Get-Process orbit-sensors -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item 'C:\Program Files\Orbit Remote\sensors' -Recurse -Force
winget uninstall -e --id namazso.PawnIO
Unregister-ScheduledTask -TaskName 'Orbit Remote Secure Desktop' -Confirm:$false
Get-Process orbit-secure -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item 'C:\ProgramData\OrbitRemote' -Recurse -Force
node src/main.mjs autostart off
```

(Mọi dòng trừ dòng cuối chạy trong PowerShell quyền quản trị.)

## Kiểm

```
node --test "tests/*.test.mjs"
```

Bộ kiểm chạy trên bản Claude giả (`tests/fake-claude.mjs`), thư mục trạng thái tạm và ống nội bộ riêng: không tốn token,
không đụng trạm hay đầu máy thật đang chạy. Phần màn hình chỉ đọc màn hình, không bao giờ dời chuột hay gõ phím.
