// Orbit Remote: xem và bấm màn khoá (màn đăng nhập) và hộp thoại UAC của Windows từ app (secure-desk.mjs).
//
// Chương trình thường (đầu máy, chạy bằng quyền người dùng) không được quay hay bấm vào màn bảo mật của
// Windows (Winlogon). Chỉ tiến trình chạy bằng quyền SYSTEM ngay trong phiên đang ngồi trước máy mới được.
// Hai chế độ:
//
//   serve [cổng]   chạy bằng quyền SYSTEM (tác vụ "Orbit Remote Secure Desktop" của Task Scheduler, bật cùng
//                  máy, do setup.cmd cài với một hộp thoại UAC): giữ một tiến trình "desk" chạy bằng quyền
//                  SYSTEM trong phiên đang ngồi trước máy (console session); phiên đổi hay "desk" dừng thì
//                  dựng lại.
//   desk [cổng] [tệp khoá]   nghe 127.0.0.1:<cổng> (mặc định 8799), chỉ phục vụ ai đưa đúng khoá bí mật (tệp
//                  secure.key cạnh chương trình: chỉ SYSTEM, Administrators và đúng người cài đọc được). Mỗi
//                  kết nối, dòng đầu là "auth <khoá>", rồi một trong:
//                    state         in locked (màn khoá), secure (màn bảo mật khác, như UAC) hay unlocked
//                    cap x y w h ow oh fps q   chụp vùng (x, y, w, h) toạ độ màn ảo của màn đang nhận phím chuột
//                                  (kể cả màn khoá), thu về ow x oh, nén JPEG chất lượng q, fps lần mỗi giây;
//                                  trả "ok" rồi gửi liên tục [độ dài 4 byte big-endian][ảnh JPEG] tới khi đóng
//                    in            trả "ok" rồi nhận từng dòng lệnh bấm như win-input.cs: m x y | r dx dy |
//                                  d b | u b | w n | k vk 1|0 e | t base64, bấm vào màn đang nhận phím chuột
//                    ping          in pong
//
// Chỉ nhận số và một tập lệnh cố định: không chạy chương trình nào khác, không đọc ghi tệp nào theo lệnh,
// không nghe ngoài 127.0.0.1. Dịch bằng csc.exe của .NET Framework 4 (C# 5).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class OrbitSecure {
  const int DEFAULT_PORT = 8799; // cổng của riêng chương trình này; 8798 là của chương trình đo nhiệt độ

  // ---- Win32 -------------------------------------------------------------------------------------
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_PRIVILEGES { public int PrivilegeCount; public LUID Luid; public int Attributes; }

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
  static extern bool WTSQuerySessionInformation(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr dup);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint value, int length);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValue(string system, string name, out LUID luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TOKEN_PRIVILEGES state, int length, IntPtr previous, IntPtr returned);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  static void Main(string[] args) {
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); }
    string mode = args.Length > 0 ? args[0] : "";
    int port = args.Length > 1 ? Clamp(ParseInt(args[1], DEFAULT_PORT), 1024, 65535) : DEFAULT_PORT;
    if (mode == "serve") Serve(port);
    else if (mode == "desk") Desk(port, args.Length > 2 ? args[2] : Path.Combine(AppDir(), "secure.key"));
    else Console.Error.WriteLine("Cách dùng: orbit-secure serve [cổng] | desk [cổng] [tệp khoá]");
  }

  static string AppDir() { return Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName); }
  static int ParseInt(string s, int fallback) { int v; return int.TryParse(s, out v) ? v : fallback; }
  static int Clamp(int v, int lo, int hi) { return Math.Min(hi, Math.Max(lo, v)); }

  // ---- serve: giữ "desk" chạy trong phiên đang ngồi trước máy ------------------------------------------
  static void Serve(int port) {
    foreach (string p in new[] { "SeTcbPrivilege", "SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege" }) EnablePrivilege(p);
    string exe = Process.GetCurrentProcess().MainModule.FileName;
    IntPtr child = IntPtr.Zero;
    uint childSession = 0xFFFFFFFF;
    for (;;) {
      uint session = WTSGetActiveConsoleSessionId();
      bool alive = child != IntPtr.Zero && WaitForSingleObject(child, 0) == 0x102; // WAIT_TIMEOUT: còn chạy
      if (session != 0xFFFFFFFF && (!alive || session != childSession)) {
        if (alive) TerminateProcess(child, 0);
        if (child != IntPtr.Zero) CloseHandle(child);
        child = SpawnInSession(exe, "desk " + port, session);
        childSession = session;
      }
      Thread.Sleep(2000);
    }
  }

  static void EnablePrivilege(string name) {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0020 | 0x0008, out token)) return; // ADJUST_PRIVILEGES | QUERY
    var tp = new TOKEN_PRIVILEGES { PrivilegeCount = 1, Attributes = 2 }; // SE_PRIVILEGE_ENABLED
    if (LookupPrivilegeValue(null, name, out tp.Luid)) AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
    CloseHandle(token);
  }

  // Tiến trình SYSTEM mới trong phiên `session`: nhân bản thẻ SYSTEM của chính mình rồi đổi số phiên.
  static IntPtr SpawnInSession(string exe, string arguments, uint session) {
    IntPtr token, dup;
    if (!OpenProcessToken(GetCurrentProcess(), 0x000F01FF, out token)) return IntPtr.Zero; // TOKEN_ALL_ACCESS
    try {
      if (!DuplicateTokenEx(token, 0x02000000, IntPtr.Zero, 2, 1, out dup)) return IntPtr.Zero; // MAXIMUM_ALLOWED, Impersonation, Primary
    } finally {
      CloseHandle(token);
    }
    try {
      if (!SetTokenInformation(dup, 12, ref session, 4)) return IntPtr.Zero; // TokenSessionId
      var si = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), lpDesktop = "winsta0\\default" };
      PROCESS_INFORMATION pi;
      if (!CreateProcessAsUser(dup, exe, "\"" + exe + "\" " + arguments, IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, AppDir(), ref si, out pi)) return IntPtr.Zero;
      CloseHandle(pi.hThread);
      return pi.hProcess;
    } finally {
      CloseHandle(dup);
    }
  }

  // ---- desk: phục vụ đầu máy trên 127.0.0.1 --------------------------------------------------------
  static string key;

  static void Desk(int port, string keyFile) {
    key = File.ReadAllText(keyFile).Trim();
    if (key.Length < 32) throw new Exception("Khoá bí mật quá ngắn.");
    var listener = new TcpListener(IPAddress.Loopback, port);
    listener.Start();
    for (;;) {
      TcpClient client = listener.AcceptTcpClient();
      var t = new Thread(() => Serve1(client));
      t.IsBackground = true;
      t.Start();
    }
  }

  static bool SameKey(string given) {
    if (given == null || given.Length != key.Length) return false;
    int diff = 0;
    for (int i = 0; i < key.Length; i++) diff |= given[i] ^ key[i];
    return diff == 0;
  }

  static void Serve1(TcpClient client) {
    try {
      client.NoDelay = true;
      using (client)
      using (NetworkStream net = client.GetStream()) {
        var reader = new StreamReader(net, Encoding.ASCII);
        string first = reader.ReadLine();
        if (first == null || !first.StartsWith("auth ") || !SameKey(first.Substring(5))) return;
        string line = reader.ReadLine();
        if (line == null) return;
        string[] a = line.Split(' ');
        if (a[0] == "ping") Reply(net, "pong");
        else if (a[0] == "state") Reply(net, DesktopState());
        else if (a[0] == "cap" && a.Length >= 9) Capture(net, a);
        else if (a[0] == "in") {
          Reply(net, "ok");
          for (string cmd; (cmd = reader.ReadLine()) != null;) {
            try { Input(cmd.Split(' ')); } catch { }
          }
        }
      }
    } catch {
      // kết nối đứt, lệnh hỏng: bỏ kết nối này
    }
  }

  static void Reply(Stream net, string text) {
    byte[] b = Encoding.ASCII.GetBytes(text + "\n");
    net.Write(b, 0, b.Length);
    net.Flush();
  }

  // Luồng gọi gắn vào màn đang nhận phím chuột (màn thường, màn khoá hay UAC) để chụp và bấm đúng màn đó.
  // Luồng không có cửa sổ nào nên đổi màn được (SetThreadDesktop). Trả về tên màn.
  static string AttachInputDesktop(ref IntPtr current) {
    IntPtr desk = OpenInputDesktop(0, false, 0x10000000); // GENERIC_ALL
    if (desk == IntPtr.Zero) return "";
    if (!SetThreadDesktop(desk)) {
      CloseDesktop(desk);
      return "";
    }
    if (current != IntPtr.Zero) CloseDesktop(current);
    current = desk;
    var name = new StringBuilder(64);
    int need;
    GetUserObjectInformation(desk, 2, name, name.Capacity * 2, out need);
    return name.ToString();
  }

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
    IntPtr desk = OpenInputDesktop(0, false, 0x0001);
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

  // ---- Chụp: GDI trên màn đang nhận phím chuột, thu nhỏ, nén JPEG ---------------------------------------
  static void Capture(Stream net, string[] a) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int w = Clamp(ParseInt(a[3], 0), 16, Math.Max(16, vw)), h = Clamp(ParseInt(a[4], 0), 16, Math.Max(16, vh));
    int x = Clamp(ParseInt(a[1], 0), vx, vx + vw - w), y = Clamp(ParseInt(a[2], 0), vy, vy + vh - h);
    int ow = Clamp(ParseInt(a[5], 0), 16, 3840) & ~1, oh = Clamp(ParseInt(a[6], 0), 16, 2160) & ~1;
    int fps = Clamp(ParseInt(a[7], 0), 1, 15);
    long quality = Clamp(ParseInt(a[8], 0), 30, 95);
    ImageCodecInfo jpeg = null;
    foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
    var ep = new EncoderParameters(1);
    ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
    Reply(net, "ok");
    IntPtr desk = IntPtr.Zero;
    using (var shot = new Bitmap(w, h, PixelFormat.Format24bppRgb))
    using (var small = new Bitmap(ow, oh, PixelFormat.Format24bppRgb))
    using (var gs = Graphics.FromImage(shot))
    using (var gd = Graphics.FromImage(small))
    using (var mem = new MemoryStream()) {
      gd.InterpolationMode = InterpolationMode.Bilinear;
      gd.PixelOffsetMode = PixelOffsetMode.HighSpeed;
      byte[] head = new byte[4];
      var watch = Stopwatch.StartNew();
      long next = 0;
      for (;;) {
        AttachInputDesktop(ref desk); // màn có thể vừa đổi (mở khoá, bảng UAC hiện ra)
        try {
          gs.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
          DrawCursor(gs, x, y);
        } catch {
          // màn vừa đổi giữa chừng: giữ ảnh cũ, lần sau gắn lại màn mới
        }
        gd.DrawImage(shot, 0, 0, ow, oh);
        mem.SetLength(0);
        small.Save(mem, jpeg, ep);
        int n = (int)mem.Length;
        head[0] = (byte)(n >> 24); head[1] = (byte)(n >> 16); head[2] = (byte)(n >> 8); head[3] = (byte)n;
        net.Write(head, 0, 4);
        net.Write(mem.GetBuffer(), 0, n); // kết nối đóng thì ném lỗi, thoát vòng
        next += 1000 / fps;
        long wait = next - watch.ElapsedMilliseconds;
        if (wait > 0) Thread.Sleep((int)wait);
        else next = watch.ElapsedMilliseconds;
      }
    }
  }

  // Vẽ con trỏ chuột lên ảnh (GDI không chụp con trỏ): để thấy mình đang trỏ vào đâu trên màn khoá.
  static void DrawCursor(Graphics g, int x, int y) {
    var ci = new CURSORINFO { cbSize = Marshal.SizeOf(typeof(CURSORINFO)) };
    if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0 || ci.hCursor == IntPtr.Zero) return;
    ICONINFO ii;
    int hx = 0, hy = 0;
    if (GetIconInfo(ci.hCursor, out ii)) {
      hx = ii.xHotspot;
      hy = ii.yHotspot;
      if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
      if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
    }
    IntPtr hdc = g.GetHdc();
    try {
      DrawIconEx(hdc, ci.ptScreenPos.X - x - hx, ci.ptScreenPos.Y - y - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3); // DI_NORMAL
    } finally {
      g.ReleaseHdc(hdc);
    }
  }

  // ---- Bấm: như win-input.cs, trên màn đang nhận phím chuột ---------------------------------------------
  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000, WHEEL = 0x0800, HWHEEL = 0x1000;
  const uint KEY_EXTENDED = 0x0001, KEY_UP = 0x0002, KEY_UNICODE = 0x0004;
  static readonly uint[] DOWN = { 0x0002, 0x0008, 0x0020 };
  static readonly uint[] UP = { 0x0004, 0x0010, 0x0040 };
  [ThreadStatic] static IntPtr inputDesk;

  static void Input(string[] a) {
    AttachInputDesktop(ref inputDesk);
    switch (a[0]) {
      case "m": MoveTo(int.Parse(a[1]), int.Parse(a[2])); break;
      case "r": {
        POINT p;
        GetCursorPos(out p);
        MoveTo(p.X + int.Parse(a[1]), p.Y + int.Parse(a[2]));
        break;
      }
      case "d": Mouse(DOWN[Clamp(ParseInt(a[1], 0), 0, 2)], 0); break;
      case "u": Mouse(UP[Clamp(ParseInt(a[1], 0), 0, 2)], 0); break;
      case "w": Mouse(WHEEL, (uint)int.Parse(a[1])); break;
      case "h": Mouse(HWHEEL, (uint)int.Parse(a[1])); break;
      case "k": Key((ushort)Clamp(ParseInt(a[1], 0), 1, 254), a[2] == "1", a.Length > 3 && a[3] == "1"); break;
      case "t": TypeText(Encoding.UTF8.GetString(Convert.FromBase64String(a[1]))); break;
    }
  }

  static void Send(INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

  static void MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = Math.Max(1, GetSystemMetrics(78)), vh = Math.Max(1, GetSystemMetrics(79));
    x = Clamp(x, vx, vx + vw - 1);
    y = Clamp(y, vy, vy + vh - 1);
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

  static INPUT KeyInput(ushort vk, bool down, bool extended) {
    var i = new INPUT { type = INPUT_KEYBOARD };
    i.ki.wVk = vk;
    i.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    i.ki.dwFlags = (down ? 0 : KEY_UP) | (extended ? KEY_EXTENDED : 0);
    return i;
  }

  static void Key(ushort vk, bool down, bool extended) { Send(new[] { KeyInput(vk, down, extended) }); }

  // Ô mật khẩu của màn khoá nhận phím thật đáng tin hơn ký tự Unicode: chữ có trên bàn phím thì bấm đúng
  // phím (kèm Shift, Ctrl, Alt nếu cần), chữ không có mới gửi dạng Unicode.
  static void TypeText(string s) {
    var list = new List<INPUT>();
    foreach (char ch in s) {
      short scan = VkKeyScan(ch);
      if (scan != -1 && (scan & 0xFF) != 0xFF) {
        ushort vk = (ushort)(scan & 0xFF);
        int shift = (scan >> 8) & 0xFF;
        var mods = new List<ushort>();
        if ((shift & 1) != 0) mods.Add(0x10);
        if ((shift & 2) != 0) mods.Add(0x11);
        if ((shift & 4) != 0) mods.Add(0x12);
        foreach (ushort m in mods) list.Add(KeyInput(m, true, false));
        list.Add(KeyInput(vk, true, false));
        list.Add(KeyInput(vk, false, false));
        for (int i = mods.Count - 1; i >= 0; i--) list.Add(KeyInput(mods[i], false, false));
      } else {
        foreach (bool down in new[] { true, false }) {
          var i = new INPUT { type = INPUT_KEYBOARD };
          i.ki.wScan = ch;
          i.ki.dwFlags = KEY_UNICODE | (down ? 0 : KEY_UP);
          list.Add(i);
        }
      }
    }
    if (list.Count > 0) Send(list.ToArray());
  }
}
