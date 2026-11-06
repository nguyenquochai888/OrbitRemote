// Orbit Remote: chuột, bàn phím và danh sách màn hình cho luồng màn hình (chỉ Windows).
//
// Đầu máy dịch file này bằng csc.exe có sẵn trong Windows ở lần dùng đầu (input.mjs), rồi giữ
// một tiến trình chạy suốt và nói qua stdin: mỗi dòng một lệnh, không chờ trả lời, nên mỗi cú
// chạm trên điện thoại chỉ tốn vài micro giây ở phía máy. Toạ độ là điểm ảnh thật của màn hình
// (tiến trình bật nhận biết DPI), cùng hệ toạ độ với ảnh do ffmpeg ddagrab quay.
//
// Lệnh:
//   s              in danh sách màn hình (một dòng JSON), đúng thứ tự output của ddagrab
//   m x y          đưa con trỏ tới (x, y)
//   r dx dy        dời con trỏ một đoạn (chế độ bàn di chuột)
//   d b | u b      nhấn | nhả nút chuột b (0 trái, 1 phải, 2 giữa)
//   w n | h n      cuộn dọc | ngang n đơn vị (120 = một nấc)
//   k vk 1|0 e     nhấn | nhả phím mã vk; e = 1 nếu là phím mở rộng (mũi tên, Insert, Delete...)
//   t base64       gõ chuỗi UTF-8 (đã mã base64) bằng ký tự Unicode, không phụ thuộc bố cục phím
//   p              in vị trí con trỏ "x y"
//   l              in danh sách cửa sổ đang mở (một dòng JSON): cửa sổ ứng dụng và thư mục, bỏ cửa
//                  sổ ẩn, cửa sổ phụ, cửa sổ công cụ và cửa sổ bị Windows giấu (cloaked)
//   g hwnd         in một cửa sổ (một dòng JSON), hoặc "null" nếu cửa sổ đã đóng
//   f hwnd         khôi phục cửa sổ nếu đang thu nhỏ và đưa nó lên trước (không in gì)
//   P hwnd         in vị trí đặt cửa sổ "showCmd trái trên phải dưới" (khung lúc không phóng to), hay "null"
//   Q hwnd c l t r b  đặt lại vị trí đó (trả cửa sổ về như cũ, kể cả đang phóng to); không in gì
//   z hwnd x y w h đưa cửa sổ về cỡ thường rồi đặt khung nhìn thấy đúng (x, y, w, h); không in gì
//   O tên          in hướng và cỡ hiện tại của một màn hình "hướng rộng cao" (hướng 0..3, -1 nếu lỗi)
//   o tên n        đổi hướng màn hình sang n (0 gốc, 1 xoay 90°, 2 xoay 180°, 3 xoay 270°) chỉ cho phiên
//                  đăng nhập này (không ghi registry); in mã kết quả của Windows (0 là được)
//   L              in trạng thái màn của phiên đăng nhập này: "locked" (màn khoá, màn đăng nhập),
//                  "secure" (màn bảo mật khác: hộp thoại UAC, Ctrl+Alt+Del) hay "unlocked"
//   C base64       đặt clipboard thành chuỗi UTF-8 (đã mã base64); in "ok" hay "err lý do"
//   F base64 [base64]  đặt clipboard thành danh sách tệp như khi copy trong Explorer (các đường dẫn cách
//                  nhau bằng xuống dòng, mã base64); có đường dẫn ảnh ở sau thì kèm luôn ảnh đó để dán
//                  vào Paint, ô chat; in "ok" hay "err lý do"
//   n              in số thứ tự của clipboard (GetClipboardSequenceNumber): đổi mỗi lần có ai copy
//   R              in thứ đang có trong clipboard (một dòng JSON): {"seq":n,"files":[...]} khi copy tệp,
//                  {"seq":n,"text":"..."} khi copy chữ, {"seq":n,"image":true} khi chỉ có ảnh, {"seq":n} khi trống
//   I base64       lưu ảnh trong clipboard thành tệp PNG ở đường dẫn này (đã mã base64); in "ok" hay "err lý do"

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

[StructLayout(LayoutKind.Sequential)]
struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

// Bản x64: phần hợp (union) bắt đầu ở byte 8. Tool dịch với /platform:x64 nên luôn đúng.
[StructLayout(LayoutKind.Explicit)]
struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }

[StructLayout(LayoutKind.Sequential)]
struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

[StructLayout(LayoutKind.Sequential)]
struct POINT { public int X; public int Y; }

[StructLayout(LayoutKind.Sequential)]
struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

[StructLayout(LayoutKind.Sequential)]
struct WINDOWPLACEMENT { public int length; public int flags; public int showCmd; public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition; }

// DEVMODE bản cho màn hình (phần hợp dùng dmPosition, dmDisplayOrientation).
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct DEVMODE {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
  public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra; public int dmFields;
  public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
  public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
  public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
  public int dmDisplayFlags; public int dmDisplayFrequency;
  public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
  public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct DXGI_OUTPUT_DESC {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
  public RECT DesktopCoordinates;
  public int AttachedToDesktop;
  public int Rotation;
  public IntPtr Monitor;
}

// Chỉ khai đủ chỗ trong bảng hàm ảo để gọi đúng hàm cần; các hàm giữ chỗ không bao giờ được gọi.
[ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIFactory1 {
  void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
  [PreserveSig] int EnumAdapters(uint index, out IDXGIAdapter adapter);
}

[ComImport, Guid("2411e7e1-12ac-4ccf-bd14-9798e8534dc0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIAdapter {
  void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
  [PreserveSig] int EnumOutputs(uint index, out IDXGIOutput output);
}

[ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIOutput {
  void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
  [PreserveSig] int GetDesc(out DXGI_OUTPUT_DESC desc);
}

static class OrbitInput {
  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000, WHEEL = 0x0800, HWHEEL = 0x1000;
  const uint KEY_EXTENDED = 0x0001, KEY_UP = 0x0002, KEY_UNICODE = 0x0004;
  static readonly uint[] DOWN = { 0x0002, 0x0008, 0x0020 };
  static readonly uint[] UP = { 0x0004, 0x0010, 0x0040 };

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IDXGIFactory1 factory);

  delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmRect(IntPtr hwnd, int attr, out RECT rect, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmInt(IntPtr hwnd, int attr, out int value, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT wp);
  [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT wp);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string name, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string name, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr param);

  static int vx, vy, vw, vh;

  static void Main() {
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); }
    RefreshDesktop();
    // In ra UTF-8 (input.mjs đọc UTF-8): bảng mã mặc định của console biến chữ có dấu thành "?", đo thật
    // tên cửa sổ "Thư mục - File Explorer" ra thành "Thu m?c - File Explorer" trong danh sách nguồn hình.
    Console.OutputEncoding = new UTF8Encoding(false);
    var stdout = Console.Out;
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      try {
        Run(line, stdout);
      } catch (Exception e) {
        Console.Error.WriteLine("orbit-input: " + e.Message);
      }
    }
  }

  static void RefreshDesktop() {
    vx = GetSystemMetrics(76); vy = GetSystemMetrics(77);
    vw = Math.Max(1, GetSystemMetrics(78)); vh = Math.Max(1, GetSystemMetrics(79));
  }

  static void Run(string line, System.IO.TextWriter stdout) {
    string[] a = line.Split(' ');
    switch (a[0]) {
      case "s": stdout.WriteLine(ScreensJson()); stdout.Flush(); RefreshDesktop(); break;
      case "m": MoveTo(int.Parse(a[1]), int.Parse(a[2])); break;
      case "r": {
        POINT p; GetCursorPos(out p);
        int x = Math.Min(vx + vw - 1, Math.Max(vx, p.X + int.Parse(a[1])));
        int y = Math.Min(vy + vh - 1, Math.Max(vy, p.Y + int.Parse(a[2])));
        MoveTo(x, y);
        break;
      }
      case "d": Mouse(DOWN[Button(a[1])], 0); break;
      case "u": Mouse(UP[Button(a[1])], 0); break;
      case "w": Mouse(WHEEL, (uint)int.Parse(a[1])); break;
      case "h": Mouse(HWHEEL, (uint)int.Parse(a[1])); break;
      case "k": Key(ushort.Parse(a[1]), a[2] == "1", a.Length > 3 && a[3] == "1"); break;
      case "t": TypeText(Encoding.UTF8.GetString(Convert.FromBase64String(a[1]))); break;
      case "p": { POINT p; GetCursorPos(out p); stdout.WriteLine(p.X + " " + p.Y); stdout.Flush(); break; }
      case "l": stdout.WriteLine(WindowsJson()); stdout.Flush(); break;
      case "g": {
        IntPtr h = new IntPtr(long.Parse(a[1]));
        stdout.WriteLine(IsWindow(h) ? WindowJson(h) : "null"); stdout.Flush();
        break;
      }
      case "f": Focus(new IntPtr(long.Parse(a[1]))); break;
      case "P": stdout.WriteLine(PlacementOf(new IntPtr(long.Parse(a[1])))); stdout.Flush(); break;
      case "Q": SetPlacement(new IntPtr(long.Parse(a[1])), int.Parse(a[2]), int.Parse(a[3]), int.Parse(a[4]), int.Parse(a[5]), int.Parse(a[6])); break;
      case "z": SetBounds(new IntPtr(long.Parse(a[1])), int.Parse(a[2]), int.Parse(a[3]), int.Parse(a[4]), int.Parse(a[5])); break;
      case "O": stdout.WriteLine(DisplayMode(a[1])); stdout.Flush(); break;
      case "o": stdout.WriteLine(SetOrientation(a[1], int.Parse(a[2]))); stdout.Flush(); break;
      case "L": stdout.WriteLine(DesktopState()); stdout.Flush(); break;
      case "C": case "F": case "I": stdout.WriteLine(Clip(a)); stdout.Flush(); break;
      case "n": stdout.WriteLine(GetClipboardSequenceNumber()); stdout.Flush(); break;
      case "R": stdout.WriteLine(ReadClip()); stdout.Flush(); break;
    }
  }

  // ---- Clipboard (clip.mjs): dán tệp, ảnh, chữ từ máy đang xem sang máy này ----------------------
  // Lệnh có trả lời: luôn in đúng một dòng, kể cả khi lỗi, để hàng chờ trả lời ở input.mjs không lệch.
  static string Clip(string[] a) {
    try {
      string first = Encoding.UTF8.GetString(Convert.FromBase64String(a.Length > 1 ? a[1] : ""));
      if (a[0] == "C") return OnSta(() => SetClipText(first));
      if (a[0] == "I") return OnSta(() => SaveClipImage(first));
      string image = a.Length > 2 ? Encoding.UTF8.GetString(Convert.FromBase64String(a[2])) : null;
      return OnSta(() => SetClipFiles(first.Split('\n'), image));
    } catch (Exception e) {
      return "err " + OneLine(e.Message);
    }
  }

  static string OneLine(string s) { return (s ?? "").Replace('\r', ' ').Replace('\n', ' '); }

  // Clipboard của Windows Forms cần luồng STA, còn tiến trình này chạy MTA: mỗi lần đặt dùng một luồng STA
  // riêng. copy = true: dữ liệu nằm lại clipboard sau khi luồng xong (OleFlushClipboard); clipboard đang bị
  // app khác giữ thì thử lại 10 lần cách nhau 100 ms.
  static string OnSta(Action action) {
    Exception error = null;
    var t = new System.Threading.Thread(() => { try { action(); } catch (Exception e) { error = e; } });
    t.SetApartmentState(System.Threading.ApartmentState.STA);
    t.Start();
    t.Join();
    return error == null ? "ok" : "err " + OneLine(error.Message);
  }

  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();

  // Thứ đang copy, theo thứ tự ưu tiên như khi dán: tệp (copy trong Explorer), chữ (copy chữ trong Word cũng
  // kèm ảnh của đoạn chữ, nhưng dán phải ra chữ), rồi mới tới ảnh trơn (ảnh chụp màn hình).
  static string ReadClip() {
    uint seq = GetClipboardSequenceNumber();
    string body = null;
    string error = OnSta(() => {
      if (System.Windows.Forms.Clipboard.ContainsFileDropList()) {
        var sb = new StringBuilder("[");
        foreach (string p in System.Windows.Forms.Clipboard.GetFileDropList()) {
          if (sb.Length > 1) sb.Append(',');
          sb.Append(Json(p));
        }
        body = ",\"files\":" + sb.Append(']');
      } else if (System.Windows.Forms.Clipboard.ContainsText()) {
        body = ",\"text\":" + Json(System.Windows.Forms.Clipboard.GetText());
      } else if (System.Windows.Forms.Clipboard.ContainsImage()) {
        body = ",\"image\":true";
      }
    });
    if (error != "ok") return "{\"seq\":" + seq + ",\"error\":" + Json(error.Substring(4)) + "}";
    return "{\"seq\":" + seq + (body ?? "") + "}";
  }

  static void SaveClipImage(string path) {
    using (var img = System.Windows.Forms.Clipboard.GetImage()) {
      if (img == null) throw new Exception("clipboard không có ảnh");
      img.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
  }

  static void SetClipText(string text) {
    System.Windows.Forms.Clipboard.SetDataObject(new System.Windows.Forms.DataObject(System.Windows.Forms.DataFormats.UnicodeText, text), true, 10, 100);
  }

  static void SetClipFiles(string[] paths, string image) {
    var data = new System.Windows.Forms.DataObject();
    var list = new System.Collections.Specialized.StringCollection();
    list.AddRange(paths);
    data.SetFileDropList(list);
    // Explorer đọc "Preferred DropEffect" để biết dán là chép hay chuyển: 1 là chép, tệp tạm vẫn còn.
    data.SetData("Preferred DropEffect", new System.IO.MemoryStream(BitConverter.GetBytes(1)));
    System.Drawing.Bitmap bitmap = null;
    try {
      if (image != null) {
        byte[] bytes = System.IO.File.ReadAllBytes(image);
        using (var ms = new System.IO.MemoryStream(bytes))
        using (var img = System.Drawing.Image.FromStream(ms)) bitmap = new System.Drawing.Bitmap(img);
        data.SetImage(bitmap);
        // Kèm bản PNG gốc: app biết đọc (trình duyệt, Office) giữ được nền trong suốt.
        if (image.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) data.SetData("PNG", new System.IO.MemoryStream(bytes));
      }
      System.Windows.Forms.Clipboard.SetDataObject(data, true, 10, 100);
    } finally {
      if (bitmap != null) bitmap.Dispose();
    }
  }

  // ---- Màn khoá (screen.mjs) ------------------------------------------------------------------
  // Máy khoá hay đang hiện hộp thoại UAC thì Windows chuyển sang màn bảo mật (Winlogon): chương trình chạy
  // bằng quyền người dùng không quay (ddagrab báo access denied) hay bấm được gì trên đó. Trạng thái khoá
  // đọc từ WTSINFOEX của phiên này: SessionFlags nằm ở byte 16 (Level 4 byte, phần hợp căn 8 byte, rồi
  // SessionId, SessionState), 0 là khoá, 1 là không khoá (Windows 7 đảo ngược hai số này; Orbit chỉ cho
  // Windows 10, 11). Đo trên máy thật: SessionId đúng ở byte 8, cờ 1 ở byte 16 lúc đang mở.
  [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
  static extern bool WTSQuerySessionInformation(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);

  static string DesktopState() {
    IntPtr buf;
    int bytes;
    if (WTSQuerySessionInformation(IntPtr.Zero, -1, 25, out buf, out bytes)) { // phiên này, WTSSessionInfoEx
      try {
        if (bytes >= 20 && Marshal.ReadInt32(buf, 0) == 1 && Marshal.ReadInt32(buf, 16) == 0) return "locked";
      } finally {
        WTSFreeMemory(buf);
      }
    }
    // Không khoá mà màn đang nhận phím chuột không phải màn thường "Default" (hay không mở được nó):
    // một màn bảo mật khác đang hiện, như hộp thoại UAC.
    IntPtr desk = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS
    if (desk == IntPtr.Zero) return "secure";
    try {
      var name = new StringBuilder(64);
      int need;
      if (GetUserObjectInformation(desk, 2, name, name.Capacity * 2, out need) && !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase)) return "secure";
    } finally {
      CloseDesktop(desk);
    }
    return "unlocked";
  }

  // ---- Đổi chiều nguồn hình theo điện thoại (orient.mjs) ---------------------------------
  const int SW_RESTORE = 9;
  const uint SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010;
  const int DM_DISPLAYORIENTATION = 0x80, DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000;

  // Vị trí đặt cửa sổ: trạng thái (thường, phóng to) và khung lúc thường, theo toạ độ vùng làm việc.
  static string PlacementOf(IntPtr h) {
    if (!IsWindow(h)) return "null";
    var wp = new WINDOWPLACEMENT { length = Marshal.SizeOf(typeof(WINDOWPLACEMENT)) };
    if (!GetWindowPlacement(h, ref wp)) return "null";
    var r = wp.rcNormalPosition;
    return wp.showCmd + " " + r.Left + " " + r.Top + " " + r.Right + " " + r.Bottom;
  }

  static void SetPlacement(IntPtr h, int showCmd, int l, int t, int r, int b) {
    if (!IsWindow(h)) return;
    var wp = new WINDOWPLACEMENT { length = Marshal.SizeOf(typeof(WINDOWPLACEMENT)), showCmd = showCmd };
    wp.rcNormalPosition = new RECT { Left = l, Top = t, Right = r, Bottom = b };
    SetWindowPlacement(h, ref wp);
  }

  // Khung cửa sổ gồm cả viền đổi cỡ vô hình quanh phần nhìn thấy: tính viền đó rồi bù vào, để phần
  // nhìn thấy (đúng vùng được quay) rơi đúng (x, y, w, h).
  static void SetBounds(IntPtr h, int x, int y, int w, int hh) {
    if (!IsWindow(h)) return;
    if (IsZoomed(h) || IsIconic(h)) ShowWindow(h, SW_RESTORE);
    RECT win;
    GetWindowRect(h, out win);
    RECT vis = BoundsOf(h);
    int l = vis.Left - win.Left, t = vis.Top - win.Top, r = win.Right - vis.Right, b = win.Bottom - vis.Bottom;
    SetWindowPos(h, IntPtr.Zero, x - l, y - t, w + l + r, hh + t + b, SWP_NOZORDER | SWP_NOACTIVATE);
  }

  static DEVMODE CurrentMode(string name, out bool ok) {
    var dm = new DEVMODE { dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)) };
    ok = EnumDisplaySettings(name, -1, ref dm); // ENUM_CURRENT_SETTINGS
    return dm;
  }

  static bool IsTurned(string name) {
    bool ok;
    var dm = CurrentMode(name, out ok);
    return ok && dm.dmDisplayOrientation != 0;
  }

  static string DisplayMode(string name) {
    bool ok;
    var dm = CurrentMode(name, out ok);
    return ok ? dm.dmDisplayOrientation + " " + dm.dmPelsWidth + " " + dm.dmPelsHeight : "-1 0 0";
  }

  // Xoay lệch 90° thì rộng và cao đổi chỗ. Cờ 0: đổi ngay cho phiên này, không ghi registry, nên khởi
  // động lại máy là màn hình về hướng cũ.
  static int SetOrientation(string name, int orient) {
    bool ok;
    var dm = CurrentMode(name, out ok);
    if (!ok) return -100;
    if (orient < 0 || orient > 3) return -101;
    if ((dm.dmDisplayOrientation & 1) != (orient & 1)) {
      int w = dm.dmPelsWidth;
      dm.dmPelsWidth = dm.dmPelsHeight;
      dm.dmPelsHeight = w;
    }
    dm.dmDisplayOrientation = orient;
    dm.dmFields = DM_DISPLAYORIENTATION | DM_PELSWIDTH | DM_PELSHEIGHT;
    return ChangeDisplaySettingsEx(name, ref dm, IntPtr.Zero, 0, IntPtr.Zero);
  }

  // ---- Cửa sổ ------------------------------------------------------------------------------
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x80;
  const uint GW_OWNER = 4;
  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;

  // Cửa sổ người dùng thấy và chuyển tới được bằng Alt+Tab: hiện, có tên, không có chủ, không phải
  // cửa sổ công cụ, không bị Windows giấu (cửa sổ app Store đang nền, bàn phím chạm...).
  static bool Listed(IntPtr h) {
    if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0 || GetWindow(h, GW_OWNER) != IntPtr.Zero) return false;
    if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return false;
    int cloaked;
    if (DwmInt(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return false;
    string cls = ClassOf(h);
    return cls != "Progman" && cls != "WorkerW" && cls != "Shell_TrayWnd" && cls != "Windows.UI.Core.CoreWindow";
  }

  static string ClassOf(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassName(h, sb, sb.Capacity);
    return sb.ToString();
  }

  static string ExeOf(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    IntPtr ph = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (ph == IntPtr.Zero) return "";
    try {
      var sb = new StringBuilder(1024);
      int size = sb.Capacity;
      if (!QueryFullProcessImageName(ph, 0, sb, ref size)) return "";
      string path = sb.ToString();
      return path.Substring(path.LastIndexOfAny(new[] { '\\', '/' }) + 1);
    } finally {
      CloseHandle(ph);
    }
  }

  // Khung nhìn thấy của cửa sổ (không gồm viền đổ bóng vô hình), đúng vùng mà ảnh chụp cửa sổ ra.
  static RECT BoundsOf(IntPtr h) {
    RECT r;
    if (DwmRect(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }

  static string WindowJson(IntPtr h) {
    int len = GetWindowTextLength(h);
    var title = new StringBuilder(len + 1);
    GetWindowText(h, title, title.Capacity);
    RECT r = BoundsOf(h);
    return new StringBuilder("{\"hwnd\":").Append(h.ToInt64())
      .Append(",\"title\":").Append(Json(title.ToString()))
      .Append(",\"cls\":").Append(Json(ClassOf(h)))
      .Append(",\"exe\":").Append(Json(ExeOf(h)))
      .Append(",\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top)
      .Append(",\"width\":").Append(r.Right - r.Left).Append(",\"height\":").Append(r.Bottom - r.Top)
      .Append(",\"min\":").Append(IsIconic(h) ? "true" : "false")
      .Append('}').ToString();
  }

  static string WindowsJson() {
    var list = new List<string>();
    EnumWindows((h, p) => { if (Listed(h)) list.Add(WindowJson(h)); return true; }, IntPtr.Zero);
    return "[" + string.Join(",", list.ToArray()) + "]";
  }

  // Windows chỉ cho tiến trình đang nhận phím chuột cuối cùng đổi cửa sổ trước: nhấn nhả Alt bằng
  // SendInput để có quyền đó, rồi khôi phục (nếu đang thu nhỏ) và đưa cửa sổ lên trước.
  static void Focus(IntPtr h) {
    if (!IsWindow(h)) return;
    Send(new[] { KeyInput(0x12, 0), KeyInput(0x12, KEY_UP) });
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    BringWindowToTop(h);
    SetForegroundWindow(h);
  }

  static string Json(string s) {
    var sb = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }

  static int Button(string s) { int b = int.Parse(s); return b < 0 || b > 2 ? 0 : b; }

  static void Send(INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

  // Đi bằng SendInput (không phải SetCursorPos) để ứng dụng nhận đúng sự kiện rê chuột như chuột thật.
  static void MoveTo(int x, int y) {
    var i = new INPUT { type = INPUT_MOUSE };
    i.mi.dx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    i.mi.dy = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    i.mi.dwFlags = MOVE | ABSOLUTE | VIRTUALDESK;
    Send(new[] { i });
  }

  static void Mouse(uint flags, uint data) {
    var i = new INPUT { type = INPUT_MOUSE };
    i.mi.dwFlags = flags;
    i.mi.mouseData = data;
    Send(new[] { i });
  }

  static void Key(ushort vk, bool down, bool extended) {
    var i = new INPUT { type = INPUT_KEYBOARD };
    i.ki.wVk = vk;
    i.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    i.ki.dwFlags = (extended ? KEY_EXTENDED : 0) | (down ? 0 : KEY_UP);
    Send(new[] { i });
  }

  static void TypeText(string text) {
    var list = new List<INPUT>(text.Length * 2);
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { // Enter thật, để ô nhập nhiều dòng và lệnh trong terminal đều nhận
        list.Add(KeyInput(0x0D, 0)); list.Add(KeyInput(0x0D, KEY_UP));
        continue;
      }
      var down = new INPUT { type = INPUT_KEYBOARD };
      down.ki.wScan = c; down.ki.dwFlags = KEY_UNICODE;
      var up = down; up.ki.dwFlags = KEY_UNICODE | KEY_UP;
      list.Add(down); list.Add(up);
    }
    if (list.Count > 0) Send(list.ToArray());
  }

  static INPUT KeyInput(ushort vk, uint flags) {
    var i = new INPUT { type = INPUT_KEYBOARD };
    i.ki.wVk = vk; i.ki.wScan = (ushort)MapVirtualKey(vk, 0); i.ki.dwFlags = flags;
    return i;
  }

  // Các output của card màn hình thứ nhất, đúng thứ tự ddagrab đánh số (output_idx).
  static string ScreensJson() {
    var sb = new StringBuilder("[");
    var iid = typeof(IDXGIFactory1).GUID;
    IDXGIFactory1 factory;
    if (CreateDXGIFactory1(ref iid, out factory) == 0) {
      IDXGIAdapter adapter;
      if (factory.EnumAdapters(0, out adapter) == 0) {
        for (uint i = 0; i < 16; i++) {
          IDXGIOutput output;
          if (adapter.EnumOutputs(i, out output) != 0) break;
          DXGI_OUTPUT_DESC d;
          if (output.GetDesc(out d) == 0) {
            var r = d.DesktopCoordinates;
            if (sb.Length > 1) sb.Append(',');
            sb.Append("{\"index\":").Append(i)
              .Append(",\"name\":\"").Append((d.DeviceName ?? "").Replace("\\", "\\\\")).Append('"')
              .Append(",\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top)
              .Append(",\"width\":").Append(r.Right - r.Left).Append(",\"height\":").Append(r.Bottom - r.Top)
              .Append(",\"primary\":").Append(r.Left == 0 && r.Top == 0 ? "true" : "false")
              // Màn đang xoay (Rotation khác IDENTITY, hay hướng trong cài đặt hiển thị khác hướng gốc):
              // ddagrab trả hình theo chiều gốc của màn, con trỏ vẽ lên hình đi lệch hướng với chuột thật,
              // nên phải quay bằng GDI. Đọc cả hai phòng driver không báo Rotation.
              .Append(",\"rotated\":").Append(d.Rotation > 1 || IsTurned(d.DeviceName) ? "true" : "false");
            var mi = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
            if (GetMonitorInfo(d.Monitor, ref mi)) {
              var wk = mi.rcWork; // vùng làm việc: trừ thanh tác vụ
              sb.Append(",\"work\":{\"x\":").Append(wk.Left).Append(",\"y\":").Append(wk.Top)
                .Append(",\"width\":").Append(wk.Right - wk.Left).Append(",\"height\":").Append(wk.Bottom - wk.Top).Append('}');
            }
            sb.Append('}');
          }
          Marshal.ReleaseComObject(output);
        }
        Marshal.ReleaseComObject(adapter);
      }
      Marshal.ReleaseComObject(factory);
    }
    return sb.Append(']').ToString();
  }
}
