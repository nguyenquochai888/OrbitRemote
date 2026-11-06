// Chương trình đo nhiệt độ của Orbit Remote: lõi CPU, GPU, ổ đĩa, bo mạch qua LibreHardwareMonitorLib
// (driver PawnIO). Đọc được các cảm biến này cần quyền quản trị, nên chương trình chạy dưới SYSTEM bằng
// Task Scheduler, nằm trong Program Files (chỉ quản trị viên ghi được) để không tiến trình quyền thường
// nào thay được nó. Đầu máy Orbit (quyền thường) hỏi qua 127.0.0.1: gửi một dòng "temps", nhận một dòng
// JSON. Chỉ đo khi được hỏi (mỗi lần cách nhau ít nhất MIN_UPDATE_MS), ngồi không thì gần như không tốn gì.
//
// Dịch bằng csc.exe của .NET Framework 4 (cú pháp C# 5), tham chiếu LibreHardwareMonitorLib.dll nằm cùng
// thư mục. Tham số: cổng nghe (mặc định 8798) và nhãn phiên bản (đầu máy so để biết cần cài lại không).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using LibreHardwareMonitor.Hardware;

static class OrbitSensors
{
    const int MIN_UPDATE_MS = 1500;
    static Computer computer;
    static string openError = null;
    static DateTime lastUpdate = DateTime.MinValue;
    static string version = "";

    static int Main(string[] args)
    {
        int port = 8798;
        if (args.Length > 0) int.TryParse(args[0], out port);
        if (args.Length > 1) version = args[1];
        var listener = new TcpListener(IPAddress.Loopback, port);
        try { listener.Start(); }
        catch (Exception e) { Console.Error.WriteLine("Không nghe được cổng " + port + ": " + e.Message); return 2; }
        while (true)
        {
            TcpClient client = null;
            try
            {
                client = listener.AcceptTcpClient();
                client.ReceiveTimeout = 3000;
                client.SendTimeout = 3000;
                Serve(client);
            }
            catch (Exception) { /* một lượt hỏi hỏng không làm chết chương trình */ }
            finally { if (client != null) client.Close(); }
        }
    }

    static void Serve(TcpClient client)
    {
        var stream = client.GetStream();
        var reader = new StreamReader(stream, Encoding.ASCII);
        string line = reader.ReadLine();
        string reply;
        if (line == "temps") reply = Measure();
        else if (line == "version") reply = "{\"ok\":true,\"version\":" + Q(version) + "}";
        else reply = "{\"ok\":false,\"error\":\"lệnh lạ\"}";
        var bytes = Encoding.UTF8.GetBytes(reply + "\n");
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    static string Measure()
    {
        if (computer == null && openError == null)
        {
            try
            {
                var c = new Computer();
                c.IsCpuEnabled = true;
                c.IsGpuEnabled = true;
                c.IsMotherboardEnabled = true;
                c.IsStorageEnabled = true;
                c.Open();
                computer = c;
            }
            catch (Exception e) { openError = e.Message; }
        }
        if (computer == null) return "{\"ok\":false,\"version\":" + Q(version) + ",\"error\":" + Q(openError) + "}";
        if ((DateTime.UtcNow - lastUpdate).TotalMilliseconds >= MIN_UPDATE_MS)
        {
            foreach (var hw in computer.Hardware) UpdateDeep(hw);
            lastUpdate = DateTime.UtcNow;
        }
        var sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"version\":").Append(Q(version)).Append(",\"admin\":").Append(IsAdmin() ? "true" : "false").Append(",\"sensors\":[");
        bool first = true;
        foreach (var hw in computer.Hardware) AppendTemps(sb, hw, hw, ref first);
        sb.Append("]}");
        return sb.ToString();
    }

    static void UpdateDeep(IHardware hw)
    {
        try { hw.Update(); } catch (Exception) { }
        foreach (var sub in hw.SubHardware) UpdateDeep(sub);
    }

    static void AppendTemps(StringBuilder sb, IHardware root, IHardware hw, ref bool first)
    {
        foreach (var s in hw.Sensors)
        {
            if (s.SensorType != SensorType.Temperature || !s.Value.HasValue) continue;
            float v = s.Value.Value;
            if (float.IsNaN(v) || float.IsInfinity(v)) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"hw\":").Append(Q(root.Name))
              .Append(",\"kind\":").Append(Q(root.HardwareType.ToString()))
              .Append(",\"sub\":").Append(Q(hw == root ? "" : hw.Name))
              .Append(",\"name\":").Append(Q(s.Name))
              .Append(",\"id\":").Append(Q(s.Identifier.ToString()))
              .Append(",\"c\":").Append(Math.Round(v, 1).ToString(CultureInfo.InvariantCulture))
              .Append('}');
        }
        foreach (var sub in hw.SubHardware) AppendTemps(sb, root, sub, ref first);
    }

    static bool IsAdmin()
    {
        try
        {
            var p = new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent());
            return p.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
        }
        catch (Exception) { return false; }
    }

    static string Q(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char ch in s)
        {
            if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
            else if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
            else sb.Append(ch);
        }
        return sb.Append('"').ToString();
    }
}
