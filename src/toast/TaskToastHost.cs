using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Management;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class ToastQuestion
{
    public string Question;
    public bool IsMultiSelect;
    public string NativeApprovalKey = "";
    public int NativeDenyIndex = -1;
    public HashSet<int> DisabledOptions = new HashSet<int>();
    public List<string> Options = new List<string>();
    public List<int> SelectedIndices = new List<int>();
}

internal sealed class ToastItem
{
    public string ConversationId;
    public string Kind; // "completed" or "action_required"
    public string StatusLabel;
    public string Title;
    public string Detail;
    public bool ShowDetailWithQuestions;
    public List<ToastQuestion> Questions = new List<ToastQuestion>();
    public int ActiveQuestionIndex;
    public string Workspace;
    public string CompletedTimeText;
    public string TurnKey = "";
    public volatile object Submission;
    public volatile bool Removed;
    public string SubmitStatus = "";
    public Rectangle CardBounds;
    public Rectangle CloseBounds;
    public List<Rectangle> OptionBounds = new List<Rectangle>();
    public Rectangle PrevButtonBounds;
    public Rectangle SubmitButtonBounds;
    public Rectangle OpenChatButtonBounds;
    public int ScrollOffsetPx;
    public int MaxScrollPx;
    public Rectangle ContentViewportBounds;
    public Rectangle ScrollTrackBounds;
    public Rectangle ScrollThumbBounds;
}

internal static class TaskToastProgram
{
    private static string NormalizeRootPath(string rawPath)
    {
        if (string.IsNullOrWhiteSpace(rawPath)) return "";
        string full = Path.GetFullPath(rawPath);
        string root = Path.GetPathRoot(full);
        if (!string.IsNullOrEmpty(root) && string.Equals(full, root, StringComparison.OrdinalIgnoreCase))
        {
            return full;
        }
        return full.TrimEnd('\\', '/');
    }

    private static string InferLaunchRootFromExeDir(string exeDir)
    {
        string norm = NormalizeRootPath(exeDir);
        string leaf = Path.GetFileName(norm) ?? "";
        string parent = Path.GetDirectoryName(norm);
        if (string.Equals(leaf, "toast", StringComparison.OrdinalIgnoreCase) &&
            !string.IsNullOrEmpty(parent) &&
            string.Equals(Path.GetFileName(parent), "src", StringComparison.OrdinalIgnoreCase))
        {
            string grand = Path.GetDirectoryName(parent);
            if (!string.IsNullOrEmpty(grand)) return NormalizeRootPath(grand);
        }
        if (!string.IsNullOrEmpty(parent)) return NormalizeRootPath(parent);
        return norm;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        EnablePerMonitorDpiAwareness();

        string exeDir = NormalizeRootPath(AppDomain.CurrentDomain.BaseDirectory);
        string launchRoot = InferLaunchRootFromExeDir(exeDir);
        string explicitPipeName = null;
        string singleActionPayload = null;
        string forceForeground = null;
        string openLogPath = null;
        string submitLogPath = null;
        bool allowCurrentDesktop = false;
        bool relaunchAttempted = false;

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--install-root" && i + 1 < args.Length)
            {
                launchRoot = NormalizeRootPath(args[++i]);
            }
            else if (args[i] == "--pipe-name" && i + 1 < args.Length)
            {
                explicitPipeName = args[++i];
            }
            else if (args[i] == "--test-foreground-ag" && i + 1 < args.Length)
            {
                forceForeground = args[++i];
            }
            else if (args[i] == "--open-log" && i + 1 < args.Length)
            {
                openLogPath = args[++i];
            }
            else if (args[i] == "--submit-log" && i + 1 < args.Length)
            {
                submitLogPath = args[++i];
            }
            else if (args[i] == "--allow-current-desktop")
            {
                allowCurrentDesktop = true;
            }
            else if (args[i] == "--relaunch-attempted")
            {
                relaunchAttempted = true;
            }
            else if (args[i] == "--status")
            {
                singleActionPayload = "{\"action\":\"status\"}";
            }
            else if (args[i] == "--dismiss-all")
            {
                singleActionPayload = "{\"action\":\"dismiss_all\"}";
            }
            else if (args[i] == "--shutdown")
            {
                singleActionPayload = "{\"action\":\"shutdown\"}";
            }
        }

        string pipeName = !string.IsNullOrEmpty(explicitPipeName)
            ? explicitPipeName
            : ("AgyPlus-TaskToast-" + ComputeHash20(launchRoot.ToLowerInvariant()));
        if (singleActionPayload != null)
        {
            Console.Out.WriteLine(SendSingleRequest(pipeName, singleActionPayload));
            return 0;
        }

        string candidateToastDir = Path.Combine(launchRoot, "src", "toast");
        string uiDir = Directory.Exists(candidateToastDir) ? candidateToastDir : exeDir;

        bool isTestRun = pipeName.StartsWith("AgyPlus-TaskToast-Test-", StringComparison.Ordinal) ||
            pipeName.StartsWith("Derrick-TaskToast-Test-", StringComparison.Ordinal) ||
            !string.IsNullOrEmpty(openLogPath) || !string.IsNullOrEmpty(submitLogPath) || forceForeground != null;
        string desktopName = GetCurrentDesktopName();
        if (!isTestRun && !allowCurrentDesktop && !relaunchAttempted &&
            desktopName.Length > 0 && !string.Equals(desktopName, "Default", StringComparison.OrdinalIgnoreCase))
        {
            if (TryRelaunchOnInteractiveDesktop(exeDir, args))
            {
                return 0;
            }
        }

        bool createdNew;
        string mutexName = @"Local\AgyPlus.TaskToast." + SanitizeName(pipeName);
        using (Mutex mutex = new Mutex(true, mutexName, out createdNew))
        {
            if (!createdNew)
            {
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (TaskToastForm form = new TaskToastForm(uiDir, launchRoot, pipeName, forceForeground, openLogPath, submitLogPath))
            {
                IntPtr handle = form.Handle;
                form.StartPipeServer();
                Application.Run();
            }
            GC.KeepAlive(mutex);
        }
        return 0;
    }

    private static string SendSingleRequest(string pipeName, string payload)
    {
        try
        {
            using (NamedPipeClientStream client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                client.Connect(1500);
                byte[] bytes = Encoding.UTF8.GetBytes(payload + "\n");
                using (CancellationTokenSource writeCts = new CancellationTokenSource(3000))
                using (writeCts.Token.Register(() => { try { client.Dispose(); } catch { } }))
                {
                    client.WriteAsync(bytes, 0, bytes.Length, writeCts.Token).GetAwaiter().GetResult();
                    client.FlushAsync(writeCts.Token).GetAwaiter().GetResult();
                }
                using (CancellationTokenSource readCts = new CancellationTokenSource(3000))
                using (readCts.Token.Register(() => { try { client.Dispose(); } catch { } }))
                using (MemoryStream ms = new MemoryStream(256))
                {
                    byte[] buf = new byte[4096];
                    while (true)
                    {
                        int n = client.ReadAsync(buf, 0, buf.Length, readCts.Token).GetAwaiter().GetResult();
                        if (n <= 0) break;
                        int nl = Array.IndexOf(buf, (byte)'\n', 0, n);
                        int take = nl >= 0 ? nl : n;
                        if (ms.Length + take > 2 * 1024 * 1024) break;
                        if (take > 0) ms.Write(buf, 0, take);
                        if (nl >= 0) break;
                    }
                    byte[] raw = ms.ToArray();
                    int len = raw.Length;
                    if (len > 0 && raw[len - 1] == (byte)'\r') len--;
                    string line = Encoding.UTF8.GetString(raw, 0, len);
                    return string.IsNullOrEmpty(line) ? "{\"ok\":false,\"error\":\"empty_response\"}" : line;
                }
            }
        }
        catch (Exception ex)
        {
            return new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                { "running", false },
                { "error", ex.Message }
            });
        }
    }

    private static string SanitizeName(string raw)
    {
        StringBuilder sb = new StringBuilder(raw.Length);
        for (int i = 0; i < raw.Length; i++)
        {
            char c = raw[i];
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')
                sb.Append(c);
            else
                sb.Append('_');
        }
        return sb.ToString();
    }

    private static void EnablePerMonitorDpiAwareness()
    {
        try
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
            if (NativeMethods.SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
        }
        catch { }
        try
        {
            // PROCESS_PER_MONITOR_DPI_AWARE = 2
            if (NativeMethods.SetProcessDpiAwareness(2) == 0) return;
        }
        catch { }
        try { NativeMethods.SetProcessDPIAware(); } catch { }
    }

    internal static string GetCurrentDesktopName()
    {
        try
        {
            IntPtr hDesk = NativeMethods.GetThreadDesktop(NativeMethods.GetCurrentThreadId());
            if (hDesk == IntPtr.Zero) return "";
            StringBuilder sb = new StringBuilder(256);
            int needed;
            if (NativeMethods.GetUserObjectInformation(hDesk, 2, sb, sb.Capacity * 2, out needed))
            {
                return sb.ToString();
            }
        }
        catch { }
        return "";
    }

    private static string QuoteCommandArg(string arg)
    {
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        for (int i = 0; i < arg.Length; i++)
        {
            char ch = arg[i];
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { quoted.Append('\\', slashes * 2 + 1); quoted.Append('"'); }
            else { quoted.Append('\\', slashes); quoted.Append(ch); }
            slashes = 0;
        }
        quoted.Append('\\', slashes * 2);
        return quoted.Append('"').ToString();
    }

    private static bool TryRelaunchOnInteractiveDesktop(string uiDir, string[] args)
    {
        try
        {
            string exePath = Process.GetCurrentProcess().MainModule.FileName;
            if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath)) return false;
            var parts = new List<string> { QuoteCommandArg(exePath) };
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--relaunch-attempted") continue;
                parts.Add(QuoteCommandArg(args[i]));
            }
            parts.Add("--relaunch-attempted");
            string cmdLine = string.Join(" ", parts.ToArray());

            using (var processClass = new ManagementClass("Win32_Process"))
            using (var inParams = processClass.GetMethodParameters("Create"))
            {
                inParams["CommandLine"] = cmdLine;
                inParams["CurrentDirectory"] = uiDir;
                using (var outParams = processClass.InvokeMethod("Create", inParams, null))
                {
                    if (outParams != null && outParams["ReturnValue"] != null)
                    {
                        uint rc = Convert.ToUInt32(outParams["ReturnValue"]);
                        return rc == 0;
                    }
                }
            }
        }
        catch { }
        return false;
    }

    internal static string ComputeHash20(string text)
    {
        return ComputeHash(text).Substring(0, 20);
    }

    internal static string ComputeHash(string text)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(text));
            StringBuilder sb = new StringBuilder(hash.Length * 2);
            for (int i = 0; i < hash.Length; i++)
            {
                sb.Append(hash[i].ToString("x2"));
            }
            return sb.ToString();
        }
    }
}

internal sealed class TaskToastForm : Form
{
    private const int MaxVisibleCards = 4;
    private const int MaxHistoryKeys = 256;

    private readonly string _uiDir;
    private readonly string _launchRoot;
    private readonly string _pipeName;
    private string _forceForegroundMode;
    private readonly string _openLogPath;
    private readonly string _submitLogPath;
    private bool IsTestHost { get { return (_pipeName.StartsWith("AgyPlus-TaskToast-Test-", StringComparison.Ordinal) ||
        _pipeName.StartsWith("Derrick-TaskToast-Test-", StringComparison.Ordinal)) &&
        !string.IsNullOrEmpty(_submitLogPath) && !string.IsNullOrEmpty(_openLogPath); } }
    private ToastItem _pressedSubmit;
    private ToastItem _pressedOpen;
    private ToastItem _pressedClose;
    private static JavaScriptSerializer _json { get { return new JavaScriptSerializer(); } }
    private static readonly System.Text.RegularExpressions.Regex SafeConversationIdRegex =
        new System.Text.RegularExpressions.Regex("^[A-Za-z0-9._-]{1,128}$", System.Text.RegularExpressions.RegexOptions.Compiled);
    private readonly SemaphoreSlim _pipeSlots = new SemaphoreSlim(16, 16);
    private readonly Dictionary<string, string> _dismissedWaitKeys = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, long> _dismissedCompletedAt = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _resolvedDedupKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    private readonly Queue<string> _resolvedOrder = new Queue<string>();
    private readonly List<ToastItem> _items = new List<ToastItem>();
    private readonly Dictionary<string, long> _seenTurnKeys = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
    private readonly Queue<string> _seenOrder = new Queue<string>();
    private readonly Dictionary<string, long> _lastNotifiedByConv = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);

    private volatile bool _stopping;
    private Thread _pipeThread;
    private string _lastActiveConversationId = "";
    private Rectangle _dismissAllBounds = Rectangle.Empty;
    private int _hoverCardIndex = -1;
    private int _hoverCloseIndex = -1;
    private int _hoverOptionIndex = -1;
    private int _hoverSubmitIndex = -1;
    private int _hoverPrevIndex = -1;
    private int _hoverOpenChatIndex = -1;
    private int _hoverScrollCardIndex = -1;
    private ToastItem _dragScrollItem;
    private int _dragScrollStartMouseY;
    private int _dragScrollStartOffset;
    private bool _hoverDismissAll;
    private float _dpiScale = 1.0f;
    private Rectangle _currentScreenBounds = Rectangle.Empty;
    private Bitmap _lastRenderedBitmap;
    private Rectangle _lastTargetWorkArea = Rectangle.Empty;
    private float _lastTargetDpiScale = 1.0f;
    private string _currentMonitorDevice = "";
    private IntPtr _lastKnownMonitor = IntPtr.Zero;
    private Rectangle _testWorkAreaOverride = Rectangle.Empty;
    private float _testDpiScaleOverride = 0f;
    private string _testMonitorDeviceOverride = null;
    private readonly string _desktopName;
    private bool _lastLayeredRenderOk = true;
    private readonly System.Windows.Forms.Timer _monitorTrackTimer;
    private readonly System.Windows.Forms.Timer _displayRefreshTimer;

    internal TaskToastForm(string uiDir, string launchRoot, string pipeName, string forceForegroundMode, string openLogPath, string submitLogPath)
    {
        _uiDir = uiDir;
        _launchRoot = launchRoot;
        _pipeName = pipeName;
        _forceForegroundMode = forceForegroundMode;
        _openLogPath = openLogPath;
        _submitLogPath = submitLogPath;
        _desktopName = TaskToastProgram.GetCurrentDesktopName();

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        Size = new Size(1, 1);
        Location = new Point(-32000, -32000);

        _monitorTrackTimer = new System.Windows.Forms.Timer();
        _monitorTrackTimer.Interval = 600;
        _monitorTrackTimer.Tick += OnMonitorTrackTick;

        _displayRefreshTimer = new System.Windows.Forms.Timer();
        _displayRefreshTimer.Interval = 350;
        _displayRefreshTimer.Tick += OnDisplayRefreshTick;

        UpdateDpiScale(IntPtr.Zero);
        SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
        SystemEvents.SessionSwitch += OnSessionSwitch;
    }

    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            // WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW
            // Do NOT set permanent WS_EX_NOACTIVATE here: WndProc returns MA_NOACTIVATE
            // for dismiss clicks, and MA_ACTIVATE for card clicks so Windows legally grants
            // this process the foreground lock to raise Antigravity above other apps.
            cp.ExStyle |= 0x00080000 | 0x00000008 | 0x00000080;
            return cp;
        }
    }

    protected override void Dispose(bool disposing)
    {
        _stopping = true;
        if (disposing)
        {
        }
        if (disposing && _monitorTrackTimer != null)
        {
            _monitorTrackTimer.Stop();
            _monitorTrackTimer.Dispose();
        }
        if (disposing && _displayRefreshTimer != null)
        {
            _displayRefreshTimer.Stop();
            _displayRefreshTimer.Dispose();
        }
        if (disposing && _lastRenderedBitmap != null)
        {
            _lastRenderedBitmap.Dispose();
            _lastRenderedBitmap = null;
        }
        SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        SystemEvents.SessionSwitch -= OnSessionSwitch;
        base.Dispose(disposing);
    }

    private void OnDisplayRefreshTick(object sender, EventArgs e)
    {
        _displayRefreshTimer.Stop();
        if (!IsDisposed && _items.Count > 0)
        {
            RenderToasts();
        }
    }

    private void ScheduleDisplayRefresh()
    {
        if (IsDisposed || !IsHandleCreated) return;
        try
        {
            BeginInvoke(new MethodInvoker(delegate
            {
                if (IsDisposed || _items.Count == 0) return;
                RenderToasts();
                _displayRefreshTimer.Stop();
                _displayRefreshTimer.Start();
            }));
        }
        catch (InvalidOperationException) { }
    }

    private void OnMonitorTrackTick(object sender, EventArgs e)
    {
        if (IsDisposed || _items.Count == 0)
        {
            _monitorTrackTimer.Stop();
            return;
        }
        float nextDpi;
        string nextDevice;
        Rectangle nextWork = ResolveTargetMonitorWorkArea(out nextDpi, out nextDevice);
        bool monitorChanged = nextWork != _lastTargetWorkArea ||
            Math.Abs(nextDpi - _lastTargetDpiScale) > 0.01f ||
            !string.Equals(nextDevice ?? "", _currentMonitorDevice ?? "", StringComparison.OrdinalIgnoreCase);

        bool windowDrifted = false;
        if (!monitorChanged && IsHandleCreated)
        {
            if (!NativeMethods.IsWindowVisible(Handle))
            {
                windowDrifted = true;
            }
            else if (_testWorkAreaOverride.IsEmpty && !_currentScreenBounds.IsEmpty)
            {
                NativeMethods.RECT actualRect;
                if (NativeMethods.GetWindowRect(Handle, out actualRect))
                {
                    if (actualRect.Left != _currentScreenBounds.Left ||
                        actualRect.Top != _currentScreenBounds.Top ||
                        (actualRect.Right - actualRect.Left) != _currentScreenBounds.Width ||
                        (actualRect.Bottom - actualRect.Top) != _currentScreenBounds.Height)
                    {
                        windowDrifted = true;
                    }
                }
                int exStyle = NativeMethods.GetWindowLong(Handle, -20);
                if ((exStyle & 0x00000008) == 0) // WS_EX_TOPMOST lost after display/session switch
                {
                    windowDrifted = true;
                }
            }
        }

        if (monitorChanged || windowDrifted || !_lastLayeredRenderOk)
        {
            RenderToasts();
        }
    }

    private void OnDisplaySettingsChanged(object sender, EventArgs e)
    {
        ScheduleDisplayRefresh();
    }

    private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        if (e == null) return;
        if (e.Reason == SessionSwitchReason.SessionUnlock ||
            e.Reason == SessionSwitchReason.RemoteConnect ||
            e.Reason == SessionSwitchReason.ConsoleConnect ||
            e.Reason == SessionSwitchReason.SessionLogon)
        {
            ScheduleDisplayRefresh();
        }
    }

    private void UpdateDpiScale(IntPtr hMonitor)
    {
        if (_testDpiScaleOverride > 0.1f)
        {
            _dpiScale = _testDpiScaleOverride;
            return;
        }
        if (hMonitor != IntPtr.Zero)
        {
            try
            {
                uint dpiX, dpiY;
                if (NativeMethods.GetDpiForMonitor(hMonitor, 0, out dpiX, out dpiY) == 0 && dpiX > 0)
                {
                    _dpiScale = dpiX / 96.0f;
                    if (_dpiScale < 1.0f) _dpiScale = 1.0f;
                    return;
                }
            }
            catch { }
        }
        IntPtr hdc = NativeMethods.GetDC(IntPtr.Zero);
        if (hdc != IntPtr.Zero)
        {
            try
            {
                int dpiX = NativeMethods.GetDeviceCaps(hdc, 88); // LOGPIXELSX
                if (dpiX > 0) _dpiScale = dpiX / 96.0f;
            }
            finally
            {
                NativeMethods.ReleaseDC(IntPtr.Zero, hdc);
            }
        }
        if (_dpiScale < 1.0f) _dpiScale = 1.0f;
    }

    private IntPtr FindAntigravityMainWindow(out uint matchedPid)
    {
        matchedPid = 0;
        Process[] procs = Process.GetProcessesByName("Antigravity");
        if (procs.Length == 0) return IntPtr.Zero;

        string configuredExe = ResolveConfiguredAntigravityExe();
        HashSet<uint> preferredPids = new HashSet<uint>();
        HashSet<uint> allAgPids = new HashSet<uint>();
        IntPtr fallbackMainHwnd = IntPtr.Zero;
        uint fallbackPid = 0;
        IntPtr preferredFallbackHwnd = IntPtr.Zero;
        uint preferredFallbackPid = 0;
        for (int i = 0; i < procs.Length; i++)
        {
            using (procs[i])
            {
                try
                {
                    uint pid = (uint)procs[i].Id;
                    allAgPids.Add(pid);
                    bool matchesConfigured = false;
                    if (!string.IsNullOrEmpty(configuredExe))
                    {
                        try
                        {
                            string modFile = procs[i].MainModule != null ? procs[i].MainModule.FileName : null;
                            if (!string.IsNullOrEmpty(modFile) &&
                                string.Equals(Path.GetFullPath(modFile), Path.GetFullPath(configuredExe), StringComparison.OrdinalIgnoreCase))
                            {
                                preferredPids.Add(pid);
                                matchesConfigured = true;
                            }
                        }
                        catch { }
                    }
                    if (matchesConfigured && preferredFallbackHwnd == IntPtr.Zero && procs[i].MainWindowHandle != IntPtr.Zero)
                    {
                        preferredFallbackHwnd = procs[i].MainWindowHandle;
                        preferredFallbackPid = pid;
                    }
                    if (fallbackMainHwnd == IntPtr.Zero && procs[i].MainWindowHandle != IntPtr.Zero)
                    {
                        fallbackMainHwnd = procs[i].MainWindowHandle;
                        fallbackPid = pid;
                    }
                }
                catch { }
            }
        }
        HashSet<uint> agPids = preferredPids.Count > 0 ? preferredPids : allAgPids;
        if (preferredPids.Count > 0)
        {
            fallbackMainHwnd = preferredFallbackHwnd;
            fallbackPid = preferredFallbackPid;
        }
        if (agPids.Count == 0) return IntPtr.Zero;

        // Prefer the currently focused Antigravity window when multiple windows span monitors.
        IntPtr fgHwnd = NativeMethods.GetForegroundWindow();
        if (fgHwnd != IntPtr.Zero && NativeMethods.IsWindowVisible(fgHwnd) && !NativeMethods.IsIconic(fgHwnd))
        {
            uint fgPid;
            NativeMethods.GetWindowThreadProcessId(fgHwnd, out fgPid);
            if (agPids.Contains(fgPid) && NativeMethods.GetWindow(fgHwnd, 4) == IntPtr.Zero)
            {
                int fgEx = NativeMethods.GetWindowLong(fgHwnd, -20);
                if ((fgEx & 0x00000080) == 0)
                {
                    matchedPid = fgPid;
                    return fgHwnd;
                }
            }
        }

        IntPtr foundHwnd = IntPtr.Zero;
        uint foundPid = 0;
        NativeMethods.EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint pid;
            NativeMethods.GetWindowThreadProcessId(hWnd, out pid);
            if (!agPids.Contains(pid)) return true;
            if (!NativeMethods.IsWindowVisible(hWnd)) return true;
            if (NativeMethods.GetWindow(hWnd, 4) != IntPtr.Zero) return true; // GW_OWNER == 4
            int exStyle = NativeMethods.GetWindowLong(hWnd, -20); // GWL_EXSTYLE
            if ((exStyle & 0x00000080) != 0) return true; // Skip WS_EX_TOOLWINDOW

            if (NativeMethods.IsIconic(hWnd))
            {
                foundHwnd = hWnd;
                foundPid = pid;
                return false;
            }

            NativeMethods.RECT r;
            if (NativeMethods.GetWindowRect(hWnd, out r))
            {
                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                if (w >= 220 && h >= 140)
                {
                    foundHwnd = hWnd;
                    foundPid = pid;
                    return false; // Topmost Z-order Antigravity Hub window found
                }
            }
            return true;
        }, IntPtr.Zero);

        if (foundHwnd != IntPtr.Zero)
        {
            matchedPid = foundPid;
            return foundHwnd;
        }
        matchedPid = fallbackPid;
        return fallbackMainHwnd;
    }

    private Rectangle ResolveTargetMonitorWorkArea(out float resolvedDpiScale, out string resolvedDevice)
    {
        if (!_testWorkAreaOverride.IsEmpty)
        {
            resolvedDpiScale = _testDpiScaleOverride > 0.1f ? _testDpiScaleOverride : _dpiScale;
            resolvedDevice = _testMonitorDeviceOverride ?? "TEST_MONITOR";
            return _testWorkAreaOverride;
        }

        uint agPid;
        IntPtr agHwnd = FindAntigravityMainWindow(out agPid);
        IntPtr hMonitor = IntPtr.Zero;

        if (agHwnd != IntPtr.Zero)
        {
            if (NativeMethods.IsIconic(agHwnd))
            {
                NativeMethods.WINDOWPLACEMENT wp = new NativeMethods.WINDOWPLACEMENT();
                wp.length = Marshal.SizeOf(wp);
                if (NativeMethods.GetWindowPlacement(agHwnd, ref wp))
                {
                    hMonitor = NativeMethods.MonitorFromRect(ref wp.rcNormalPosition, 2);
                }
            }
            if (hMonitor == IntPtr.Zero)
            {
                // MONITOR_DEFAULTTONEAREST = 2
                hMonitor = NativeMethods.MonitorFromWindow(agHwnd, 2);
            }
            if (hMonitor != IntPtr.Zero)
            {
                _lastKnownMonitor = hMonitor;
            }
        }

        if (hMonitor == IntPtr.Zero && _lastKnownMonitor != IntPtr.Zero)
        {
            NativeMethods.MONITORINFOEX probe = new NativeMethods.MONITORINFOEX();
            probe.cbSize = Marshal.SizeOf(probe);
            if (NativeMethods.GetMonitorInfo(_lastKnownMonitor, ref probe))
            {
                hMonitor = _lastKnownMonitor;
            }
        }

        if (hMonitor == IntPtr.Zero)
        {
            NativeMethods.POINT ptZero = new NativeMethods.POINT(0, 0);
            hMonitor = NativeMethods.MonitorFromPoint(ptZero, 1); // MONITOR_DEFAULTTOPRIMARY = 1
        }

        UpdateDpiScale(hMonitor);
        resolvedDpiScale = _dpiScale;

        if (hMonitor != IntPtr.Zero)
        {
            NativeMethods.MONITORINFOEX mi = new NativeMethods.MONITORINFOEX();
            mi.cbSize = Marshal.SizeOf(mi);
            if (NativeMethods.GetMonitorInfo(hMonitor, ref mi))
            {
                resolvedDevice = mi.szDevice ?? "";
                return Rectangle.FromLTRB(mi.rcWork.Left, mi.rcWork.Top, mi.rcWork.Right, mi.rcWork.Bottom);
            }
        }

        Screen fallback = Screen.PrimaryScreen ?? Screen.AllScreens[0];
        resolvedDevice = fallback.DeviceName ?? "";
        return fallback.WorkingArea;
    }

    private int S(int value)
    {
        return (int)Math.Round(value * _dpiScale);
    }

    internal void StartPipeServer()
    {
        _pipeThread = new Thread(PipeLoop);
        _pipeThread.IsBackground = true;
        _pipeThread.Name = "AgyPlusTaskToastPipe";
        _pipeThread.Start();
    }

    private const int MaxPipePayloadBytes = 2 * 1024 * 1024;
    private const int PipeReadTimeoutMs = 5000;
    private const int PipeWriteTimeoutMs = 3000;
    private PipeSecurity _cachedPipeSecurity;

    private PipeSecurity GetOrCreatePipeSecurity()
    {
        if (_cachedPipeSecurity != null) return _cachedPipeSecurity;
        try
        {
            using (WindowsIdentity id = WindowsIdentity.GetCurrent())
            {
                if (id != null && id.User != null)
                {
                    SecurityIdentifier worldSid = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
                    SecurityIdentifier anonSid = new SecurityIdentifier(WellKnownSidType.AnonymousSid, null);
                    SecurityIdentifier authUsersSid = new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null);
                    SecurityIdentifier builtinUsersSid = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
                    SecurityIdentifier networkSid = new SecurityIdentifier(WellKnownSidType.NetworkSid, null);
                    SecurityIdentifier restrictedSid = new SecurityIdentifier(WellKnownSidType.RestrictedCodeSid, null);

                    PipeSecurity ps = new PipeSecurity();
                    ps.SetAccessRuleProtection(true, false);
                    // Explicitly deny remote SMB network callers.
                    ps.AddAccessRule(new PipeAccessRule(
                        networkSid,
                        PipeAccessRights.FullControl,
                        AccessControlType.Deny));
                    // Grant full control to the current Windows user SID.
                    ps.AddAccessRule(new PipeAccessRule(
                        id.User,
                        PipeAccessRights.FullControl,
                        AccessControlType.Allow));
                    // Allow RestrictedCodeSid (S-1-5-12) so restricted-token child processes of THIS
                    // SAME user (whose primary token must still match id.User) can connect.
                    ps.AddAccessRule(new PipeAccessRule(
                        restrictedSid,
                        PipeAccessRights.ReadWrite,
                        AccessControlType.Allow));

                    // Inherit safe token-specific DACL entries (LocalSystem, Administrators, or this process's
                    // own AppContainer SID) while stripping broad groups (Everyone, Anonymous, AuthenticatedUsers, Users).
                    try
                    {
                        using (NamedPipeServerStream probe = new NamedPipeServerStream(
                            "AgyPlus-AclProbe-" + Guid.NewGuid().ToString("N"),
                            PipeDirection.InOut,
                            1,
                            PipeTransmissionMode.Byte,
                            PipeOptions.None))
                        {
                            PipeSecurity defAcl = probe.GetAccessControl();
                            foreach (PipeAccessRule rule in defAcl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                            {
                                if (rule.AccessControlType != AccessControlType.Allow) continue;
                                SecurityIdentifier sid = rule.IdentityReference as SecurityIdentifier;
                                if (sid == null || sid.Equals(worldSid) || sid.Equals(anonSid) ||
                                    sid.Equals(authUsersSid) || sid.Equals(builtinUsersSid)) continue;
                                ps.AddAccessRule(new PipeAccessRule(sid, rule.PipeAccessRights, AccessControlType.Allow));
                            }
                        }
                    }
                    catch
                    {
                        // Ignore probe failures; explicit user rule above still applies.
                    }

                    _cachedPipeSecurity = ps;
                    return _cachedPipeSecurity;
                }
            }
        }
        catch
        {
            // Fallback to default DACL if identity lookup fails under a restricted token.
        }
        return null;
    }

    private bool _pipeCreatedWithSecurity = false;

    private NamedPipeServerStream CreatePipeServerStream(bool allowDefaultFallback)
    {
        PipeSecurity ps = GetOrCreatePipeSecurity();
        if (ps != null)
        {
            try
            {
                var secured = new NamedPipeServerStream(
                    _pipeName,
                    PipeDirection.InOut,
                    NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous,
                    4096,
                    4096,
                    ps);
                _pipeCreatedWithSecurity = true;
                return secured;
            }
            catch (UnauthorizedAccessException)
            {
                // On Windows, the kernel applies the PipeSecurity DACL when the first instance
                // creates the named pipe; attaching additional concurrent instances while an earlier
                // instance is still alive inherits that DACL and may reject re-specifying WRITE_DAC.
                if (!_pipeCreatedWithSecurity && !allowDefaultFallback) throw;
            }
            catch (IOException)
            {
                if (!_pipeCreatedWithSecurity && !allowDefaultFallback) throw;
            }
        }
        return new NamedPipeServerStream(
            _pipeName,
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);
    }

    private static async Task<Tuple<bool, string, string>> TryReadBoundedLineAsync(NamedPipeServerStream stream, int maxBytes, int timeoutMs)
    {
        using (CancellationTokenSource cts = new CancellationTokenSource(timeoutMs))
        using (cts.Token.Register(() => { try { stream.Dispose(); } catch { } }))
        using (MemoryStream ms = new MemoryStream(1024))
        {
            byte[] buf = new byte[4096];
            while (true)
            {
                int read;
                try
                {
                    read = await stream.ReadAsync(buf, 0, buf.Length, cts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return Tuple.Create(false, (string)null, "request_timeout");
                }
                catch (ObjectDisposedException)
                {
                    return Tuple.Create(false, (string)null, cts.IsCancellationRequested ? "request_timeout" : "pipe_closed");
                }
                catch (IOException)
                {
                    if (cts.IsCancellationRequested)
                        return Tuple.Create(false, (string)null, "request_timeout");
                    throw;
                }
                if (read <= 0) break;
                int nlIdx = Array.IndexOf(buf, (byte)'\n', 0, read);
                int take = nlIdx >= 0 ? nlIdx : read;
                if (ms.Length + take > maxBytes)
                {
                    return Tuple.Create(false, (string)null, "payload_too_large");
                }
                if (take > 0) ms.Write(buf, 0, take);
                if (nlIdx >= 0) break;
            }
            byte[] raw = ms.ToArray();
            int len = raw.Length;
            if (len > 0 && raw[len - 1] == (byte)'\r') len--;
            return Tuple.Create(true, Encoding.UTF8.GetString(raw, 0, len), (string)null);
        }
    }

    private void PipeLoop()
    {
        int consecutiveFailures = 0;
        while (!_stopping)
        {
            NamedPipeServerStream server = null;
            try
            {
                server = CreatePipeServerStream(consecutiveFailures > 0);
                Task waitTask = Task.Factory.FromAsync(server.BeginWaitForConnection, server.EndWaitForConnection, null);
                waitTask.GetAwaiter().GetResult();
                consecutiveFailures = 0;
                if (_stopping)
                {
                    server.Dispose();
                    break;
                }
                NamedPipeServerStream connected = server;
                server = null;
                if (!_pipeSlots.Wait(0))
                {
                    try { connected.Dispose(); } catch { }
                    continue;
                }
                Task.Run(async () =>
                {
                    try { await HandleClientAsync(connected).ConfigureAwait(false); }
                    finally { try { _pipeSlots.Release(); } catch { } }
                });
            }
            catch
            {
                if (server != null)
                {
                    try { server.Dispose(); } catch { }
                }
                if (_stopping) break;
                consecutiveFailures++;
                if (consecutiveFailures >= 50)
                {
                    _stopping = true;
                    try { BeginInvoke(new MethodInvoker(delegate { Application.ExitThread(); })); } catch { }
                    break;
                }
                Thread.Sleep(Math.Min(500, 80 * consecutiveFailures));
            }
        }
    }

    private async Task HandleClientAsync(NamedPipeServerStream stream)
    {
        using (stream)
        {
            try
            {
                var readRes = await TryReadBoundedLineAsync(stream, MaxPipePayloadBytes, PipeReadTimeoutMs).ConfigureAwait(false);
                string response = readRes.Item1
                    ? ProcessJsonLine(readRes.Item2)
                    : ("{\"ok\":false,\"error\":\"" + (readRes.Item3 ?? "invalid_request") + "\"}");
                byte[] outBytes = Encoding.UTF8.GetBytes(response + "\n");
                using (CancellationTokenSource writeCts = new CancellationTokenSource(PipeWriteTimeoutMs))
                using (writeCts.Token.Register(() => { try { stream.Dispose(); } catch { } }))
                {
                    await stream.WriteAsync(outBytes, 0, outBytes.Length, writeCts.Token).ConfigureAwait(false);
                    await stream.FlushAsync(writeCts.Token).ConfigureAwait(false);
                }
            }
            catch
            {
                // Ignore broken or timed-out client pipe.
            }
        }
    }

    private string ProcessJsonLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return "{\"ok\":false,\"error\":\"empty_request\"}";
        }
        Dictionary<string, object> msg;
        try
        {
            msg = _json.Deserialize<Dictionary<string, object>>(line);
        }
        catch (Exception ex)
        {
            return _json.Serialize(new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } });
        }
        if (msg == null)
        {
            return "{\"ok\":false,\"error\":\"null_message\"}";
        }

        var response = new TaskCompletionSource<string>();
        try
        {
            BeginInvoke(new MethodInvoker(delegate
            {
                try { response.TrySetResult(HandleMessageOnUiThread(msg)); }
                catch (Exception ex) { response.TrySetResult(_json.Serialize(new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } })); }
            }));
            return response.Task.Wait(4000) ? response.Task.Result : "{\"ok\":false,\"error\":\"ui_timeout\"}";
        }
        catch (InvalidOperationException) { return "{\"ok\":false,\"error\":\"host_unavailable\"}"; }
    }

    private string HandleMessageOnUiThread(Dictionary<string, object> msg)
    {
        string action = GetStr(msg, "action");
        if (!IsTestHost && (action == "set_test_mode" || action == "save_preview" || action == "select_option" || action == "submit_question" || action == "test_pointer"))
            return "{\"ok\":false,\"error\":\"test_only\"}";
        if (action == "set_test_mode")
        {
            if (msg.ContainsKey("foregroundAg"))
            {
                _forceForegroundMode = GetStr(msg, "foregroundAg");
                if (_forceForegroundMode.Length == 0) _forceForegroundMode = null;
            }
            object workObj;
            if (msg.TryGetValue("workArea", out workObj))
            {
                if (workObj is Dictionary<string, object>)
                {
                    var wd = (Dictionary<string, object>)workObj;
                    int wx = Convert.ToInt32(wd["x"]);
                    int wy = Convert.ToInt32(wd["y"]);
                    int ww = Convert.ToInt32(wd["width"]);
                    int wh = Convert.ToInt32(wd["height"]);
                    _testWorkAreaOverride = new Rectangle(wx, wy, ww, wh);
                    _testDpiScaleOverride = wd.ContainsKey("dpiScale") ? Convert.ToSingle(wd["dpiScale"]) : 0f;
                    _testMonitorDeviceOverride = wd.ContainsKey("device") ? Convert.ToString(wd["device"]) : "TEST_MONITOR";
                }
                else
                {
                    _testWorkAreaOverride = Rectangle.Empty;
                    _testDpiScaleOverride = 0f;
                    _testMonitorDeviceOverride = null;
                }
                if (_items.Count > 0) RenderToasts();
            }
            return "{\"ok\":true}";
        }
        if (action == "status")
        {
            float liveDpi;
            string liveDevice;
            Rectangle liveWork = ResolveTargetMonitorWorkArea(out liveDpi, out liveDevice);
            var cards = new List<Dictionary<string, object>>();
            for (int i = 0; i < _items.Count; i++)
            {
                ToastItem item = _items[i];
                cards.Add(new Dictionary<string, object> {
                    { "conversationId", item.ConversationId },
                    { "kind", item.Kind ?? "completed" },
                    { "statusLabel", item.StatusLabel ?? "Task completed" },
                    { "title", item.Title },
                    { "detail", item.Detail ?? "" },
                    { "questionCount", item.Questions != null ? item.Questions.Count : 0 },
                    { "activeQuestionIndex", item.ActiveQuestionIndex },
                    { "hasSubmit", item.Questions != null && item.Questions.Count > 0 },
                    { "scrollable", item.MaxScrollPx > 0 },
                    { "scrollOffset", item.ScrollOffsetPx },
                    { "maxScroll", item.MaxScrollPx },
                    { "turnKey", item.TurnKey },
                    { "submitting", item.Submission != null },
                    { "submitStatus", item.SubmitStatus },
                    { "workspace", item.Workspace },
                    { "time", item.CompletedTimeText }
                });
                if (IsTestHost)
                {
                    cards[i]["hitBounds"] = new Dictionary<string, Rectangle> {
                        { "card", item.CardBounds }, { "content", item.ContentViewportBounds },
                        { "scrollThumb", item.ScrollThumbBounds }, { "open", item.OpenChatButtonBounds },
                        { "close", item.CloseBounds }, { "submit", item.SubmitButtonBounds }
                    };
                    cards[i]["options"] = item.Questions.Select(q => q.Options).ToArray();
                }
            }
            return _json.Serialize(new Dictionary<string, object> {
                { "ok", true },
                { "running", true },
                { "pid", Process.GetCurrentProcess().Id },
                { "protocolVersion", 2 },
                { "desktop", _desktopName },
                { "layeredRenderOk", _lastLayeredRenderOk },
                { "visible", (Visible || (IsHandleCreated && NativeMethods.IsWindowVisible(Handle))) && _items.Count > 0 },
                { "count", _items.Count },
                { "activeConversationId", _lastActiveConversationId },
                { "monitorDevice", _items.Count > 0 && _currentMonitorDevice.Length > 0 ? _currentMonitorDevice : liveDevice },
                { "dpiScale", Math.Round(liveDpi, 3) },
                { "targetWorkArea", new Dictionary<string, int> {
                    { "x", liveWork.X },
                    { "y", liveWork.Y },
                    { "width", liveWork.Width },
                    { "height", liveWork.Height }
                }},
                { "bounds", new Dictionary<string, int> {
                    { "x", _currentScreenBounds.X },
                    { "y", _currentScreenBounds.Y },
                    { "width", _currentScreenBounds.Width },
                    { "height", _currentScreenBounds.Height }
                }},
                { "items", cards }
            });
        }
        if (action == "save_preview")
        {
            string outPath = GetStr(msg, "path");
            if (outPath.Length == 0 || _lastRenderedBitmap == null)
            {
                return "{\"ok\":false,\"error\":\"no_rendered_bitmap\"}";
            }
            _lastRenderedBitmap.Save(outPath, ImageFormat.Png);
            return _json.Serialize(new Dictionary<string, object> {
                { "ok", true },
                { "width", _lastRenderedBitmap.Width },
                { "height", _lastRenderedBitmap.Height }
            });
        }
        if (action == "shutdown")
        {
            _stopping = true;
            BeginInvoke(new MethodInvoker(delegate
            {
                Close();
                Application.ExitThread();
            }));
            return "{\"ok\":true,\"shuttingDown\":true}";
        }
        if (action == "dismiss_all")
        {
            DismissAllItems();
            return "{\"ok\":true,\"count\":0}";
        }
        if (action == "dismiss")
        {
            string id = GetStr(msg, "conversationId");
            ToastItem item = FindItem(id);
            if (item != null) DismissItem(item);
            RenderToasts();
            return _json.Serialize(new Dictionary<string, object> { { "ok", true }, { "count", _items.Count } });
        }
        if (action == "test_pointer")
        {
            Point point = new Point(Convert.ToInt32(msg["x"]), Convert.ToInt32(msg["y"]));
            var mouse = new MouseEventArgs(MouseButtons.Left, 1, point.X, point.Y, 0);
            switch (GetStr(msg, "event"))
            {
                case "down": OnMouseDown(mouse); break;
                case "move": OnMouseMove(mouse); break;
                case "up": OnMouseUp(mouse); break;
                case "wheel": HandleWheelAt(point, Convert.ToInt32(msg["delta"])); break;
                default: OnMouseDown(mouse); OnMouseUp(mouse); break;
            }
            return "{\"ok\":true}";
        }
        if (action == "select_option")
        {
            string id = GetStr(msg, "conversationId");
            int qIdx = msg.ContainsKey("questionIndex") ? Convert.ToInt32(msg["questionIndex"]) : 0;
            int optIdx = msg.ContainsKey("optionIndex") ? Convert.ToInt32(msg["optionIndex"]) : 0;
            ToastItem target = FindItem(id);
            if (target != null && qIdx >= 0 && qIdx < target.Questions.Count)
            {
                if (target.ActiveQuestionIndex != qIdx) target.ScrollOffsetPx = 0;
                target.ActiveQuestionIndex = qIdx;
                ToggleQuestionOption(target.Questions[qIdx], optIdx);
                RenderToasts();
            }
            return "{\"ok\":true}";
        }
        if (action == "scroll_card")
        {
            string id = GetStr(msg, "conversationId");
            int delta = msg.ContainsKey("delta") ? Convert.ToInt32(msg["delta"]) : 0;
            ToastItem target = FindItem(id);
            if (target == null)
            {
                return "{\"ok\":false,\"error\":\"card_not_found\"}";
            }
            ScrollItemBy(target, delta);
            RenderToasts();
            return _json.Serialize(new Dictionary<string, object> {
                { "ok", true },
                { "scrollOffset", target.ScrollOffsetPx },
                { "maxScroll", target.MaxScrollPx }
            });
        }
        if (action == "submit_question")
        {
            string id = GetStr(msg, "conversationId");
            ToastItem target = FindItem(id);
            if (target == null || target.Questions.Count == 0)
            {
                return "{\"ok\":false,\"error\":\"no_interactive_question\"}";
            }
            if (target.Questions[0].NativeApprovalKey.Length > 0) return "{\"ok\":false,\"error\":\"use_submit_button\"}";
            if (!StartSubmission(target)) return "{\"ok\":false,\"error\":\"select_an_option\"}";
            RenderToasts();
            return _json.Serialize(new Dictionary<string, object> { { "ok", true }, { "submitted", true }, { "count", _items.Count } });
        }
        if (action == "activate")
        {
            string id = GetStr(msg, "conversationId").Trim();
            if (id.Length > 0 && !SafeConversationIdRegex.IsMatch(id))
            {
                return "{\"ok\":false,\"error\":\"invalid_conversation_id\"}";
            }
            RemoveConversation(id, true);
            RenderToasts();
            if (id.Length > 0)
            {
                OpenConversation(id);
            }
            return _json.Serialize(new Dictionary<string, object> { { "ok", true }, { "count", _items.Count } });
        }
        if (action == "sync_active")
        {
            string activeId = GetStr(msg, "activeConversationId");
            if (activeId.Length > 0)
            {
                _lastActiveConversationId = activeId;
            }
            else if (msg.ContainsKey("activeConversationId"))
            {
                _lastActiveConversationId = "";
            }

            bool changed = false;
            object titlesObj;
            if (msg.TryGetValue("titles", out titlesObj) && titlesObj is Dictionary<string, object>)
            {
                var titles = (Dictionary<string, object>)titlesObj;
                for (int i = 0; i < _items.Count; i++)
                {
                    object tVal;
                    if (titles.TryGetValue(_items[i].ConversationId, out tVal) && tVal != null)
                    {
                        string betterTitle = NormalizeTitle(Convert.ToString(tVal));
                        if (betterTitle.Length > 0 && betterTitle != _items[i].Title)
                        {
                            _items[i].Title = betterTitle;
                            changed = true;
                        }
                    }
                }
            }

            object resolvedObj;
            if (msg.TryGetValue("resolvedActionIds", out resolvedObj) && resolvedObj is ArrayList)
            {
                foreach (object value in (ArrayList)resolvedObj)
                {
                    var resolution = value as Dictionary<string, object>;
                    if (resolution == null) continue;
                    string id = GetStr(resolution, "conversationId");
                    string key = GetStr(resolution, "turnKey");
                    ToastItem item = FindItem(id);
                    if (item != null && item.Kind == "action_required" && item.TurnKey == key)
                    {
                        item.Removed = true;
                        _items.Remove(item);
                        ResetHover();
                        changed = true;
                    }
                    if (id.Length > 0 && key.Length > 0)
                    {
                        string resDedup = id + "|action_required|" + key;
                        if (_resolvedDedupKeys.Add(resDedup))
                        {
                            _resolvedOrder.Enqueue(resDedup);
                            while (_resolvedOrder.Count > MaxHistoryKeys)
                            {
                                _resolvedDedupKeys.Remove(_resolvedOrder.Dequeue());
                            }
                        }
                    }
                    string dismissed;
                    if (_dismissedWaitKeys.TryGetValue(id, out dismissed) && dismissed == key) _dismissedWaitKeys.Remove(id);
                }
            }

            if (_lastActiveConversationId.Length > 0 && IsAntigravityForeground())
                changed |= RemoveConversation(_lastActiveConversationId, true);

            if (changed)
            {
                RenderToasts();
            }
            return _json.Serialize(new Dictionary<string, object> { { "ok", true }, { "count", _items.Count } });
        }
        if (action == "notify")
        {
            return HandleNotify(msg);
        }

        return "{\"ok\":false,\"error\":\"unknown_action\"}";
    }

    private string HandleNotify(Dictionary<string, object> msg)
    {
        string conversationId = GetStr(msg, "conversationId").Trim();
        if (conversationId.Length == 0 || !SafeConversationIdRegex.IsMatch(conversationId)) return "{\"ok\":false,\"error\":\"invalid_conversation_id\"}";

        if (msg.ContainsKey("activeConversationId")) _lastActiveConversationId = GetStr(msg, "activeConversationId").Trim();
        string rawKind = GetStr(msg, "kind").Trim().ToLowerInvariant();
        string kind = (rawKind == "action_required" || rawKind == "waiting" || rawKind == "input_needed" || rawKind == "approval_needed")
            ? "action_required" : "completed";
        string turnKey = GetStr(msg, "turnKey").Trim();
        string dedupKey = turnKey.Length > 0 ? (conversationId + "|" + kind + "|" + turnKey) : "";
        string rateKey = conversationId + "|" + kind;
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        ToastItem item = FindItem(conversationId);

        if (kind == "completed" && item != null && item.Kind == "action_required")
            return NotifyResult(false, "waiting_for_native_resolution");
        string dismissed;
        if (kind == "action_required" && _dismissedWaitKeys.TryGetValue(conversationId, out dismissed) && dismissed == turnKey)
            return NotifyResult(false, "dismissed_request");
        long dismissedCompletedMs;
        if (kind == "completed" && _dismissedCompletedAt.TryGetValue(conversationId, out dismissedCompletedMs) && (nowMs - dismissedCompletedMs) < 8000)
            return NotifyResult(false, "dismissed_recently");

        string statusLabel = NormalizeSingleLine(GetStr(msg, "statusLabel"), 28);
        if (statusLabel.Length == 0) statusLabel = kind == "action_required" ? "Action needed" : "Task completed";
        string detail = GetStr(msg, "detail");
        string title = NormalizeTitle(GetStr(msg, "title"));
        string workspace = NormalizeSingleLine(GetStr(msg, "workspace"), 36);
        List<ToastQuestion> questions = ParseQuestions(msg);
        if (questions.Any(q => q.NativeApprovalKey.Length > 0) &&
            (questions.Count != 1 || !MatchesNativeApproval(questions[0], conversationId, turnKey, detail))) questions.Clear();

        if (dedupKey.Length > 0 && _seenTurnKeys.ContainsKey(dedupKey))
        {
            if (item == null || item.Kind != kind || item.TurnKey != turnKey)
            {
                // Keep resolved or completed requests suppressed, while allowing an active unresolved
                // waiting prompt to reappear if its card was displaced without user dismissal.
                if (kind != "action_required" || _resolvedDedupKeys.Contains(dedupKey))
                {
                    return NotifyResult(false, "seen_request");
                }
            }
            else
            {
                bool changed = false;
                if (title.Length > 0 && title != item.Title && !IsFallbackTitle(title))
                {
                    item.Title = title;
                    changed = true;
                }
                if (kind == "action_required" && detail != item.Detail)
                {
                    item.Detail = detail;
                    item.ShowDetailWithQuestions = item.Questions.Count > 0 && detail.Length > 0;
                    changed = true;
                }
                if (kind == "action_required" && !SameQuestions(item.Questions, questions))
                {
                    item.Questions = questions;
                    item.ShowDetailWithQuestions = questions.Count > 0 && detail.Length > 0;
                    item.ActiveQuestionIndex = 0;
                    item.ScrollOffsetPx = 0;
                    item.Submission = null;
                    item.SubmitStatus = "";
                    changed = true;
                }
                if (changed) RenderToasts();
                return NotifyResult(true, "", true);
            }
        }

        long prevConvMs;
        if (_lastNotifiedByConv.TryGetValue(rateKey, out prevConvMs))
        {
            // Cross-turnKey suppression for completed notifications (Stop Hook vs ui-core 1s poll)
            if (kind == "completed" && (nowMs - prevConvMs) < 8000)
            {
                if (item != null && title.Length > 0 && title != item.Title && !IsFallbackTitle(title))
                {
                    item.Title = title;
                    RenderToasts();
                }
                return NotifyResult(item != null, "recent_completed_dedup", true);
            }
            if (dedupKey.Length == 0 && (nowMs - prevConvMs) < 4000)
                return NotifyResult(item != null, "rate_limit", true);
        }

        RememberTurnKey(dedupKey, rateKey, nowMs);
        if (kind == "completed" && IsAntigravityForeground() && string.Equals(_lastActiveConversationId, conversationId, StringComparison.OrdinalIgnoreCase))
            return NotifyResult(false, "active_foreground_conversation");

        if (item != null)
        {
            item.Removed = true;
            _items.Remove(item);
        }
        if (title.Length == 0 || IsFallbackTitle(title)) title = item != null ? item.Title : ("Conversation " + conversationId.Substring(0, Math.Min(8, conversationId.Length)));
        _items.Add(new ToastItem {
            ConversationId = conversationId,
            Kind = kind,
            TurnKey = turnKey,
            StatusLabel = statusLabel,
            Title = title,
            Detail = detail,
            Questions = questions,
            ShowDetailWithQuestions = questions.Count > 0 && detail.Length > 0,
            Workspace = workspace.Length > 0 ? workspace : (item != null ? item.Workspace : "Antigravity"),
            CompletedTimeText = DateTime.Now.ToString("HH:mm")
        });
        ResetHover();
        RenderToasts();
        return NotifyResult(true, "");
    }

    private string NotifyResult(bool shown, string reason, bool deduplicated = false)
    {
        return _json.Serialize(new Dictionary<string, object> {
            { "ok", true }, { "shown", shown }, { "suppressedReason", reason }, { "count", _items.Count },
            { "deduplicated", deduplicated }
        });
    }

    private static bool SameQuestions(List<ToastQuestion> left, List<ToastQuestion> right)
    {
        if (left.Count != right.Count) return false;
        for (int i = 0; i < left.Count; i++)
        {
            var a = left[i];
            var b = right[i];
            if (a.Question != b.Question || a.IsMultiSelect != b.IsMultiSelect || a.NativeApprovalKey != b.NativeApprovalKey ||
                a.NativeDenyIndex != b.NativeDenyIndex || !a.Options.SequenceEqual(b.Options) ||
                !a.DisabledOptions.SetEquals(b.DisabledOptions)) return false;
        }
        return true;
    }

    private static bool MatchesNativeApproval(ToastQuestion question, string conversationId, string turnKey, string detail)
    {
        if (question.IsMultiSelect || question.NativeDenyIndex < -1 || question.NativeDenyIndex >= question.Options.Count ||
            !turnKey.StartsWith("wait:", StringComparison.Ordinal)) return false;
        var fields = new List<string> {
            conversationId, turnKey, detail, question.NativeDenyIndex.ToString(System.Globalization.CultureInfo.InvariantCulture)
        };
        for (int i = 0; i < question.Options.Count; i++)
        {
            fields.Add(question.Options[i]);
            fields.Add(question.DisabledOptions.Contains(i) ? "1" : "0");
        }
        var signature = new StringBuilder();
        foreach (string field in fields)
        {
            signature.Append(field.Length.ToString(System.Globalization.CultureInfo.InvariantCulture));
            signature.Append(':');
            signature.Append(field);
        }
        return TaskToastProgram.ComputeHash(signature.ToString()) == question.NativeApprovalKey;
    }

    private void RememberTurnKey(string dedupKey, string conversationId, long nowMs)
    {
        _lastNotifiedByConv[conversationId] = nowMs;
        if (dedupKey.Length == 0) return;
        if (!_seenTurnKeys.ContainsKey(dedupKey))
        {
            _seenTurnKeys[dedupKey] = nowMs;
            _seenOrder.Enqueue(dedupKey);
            while (_seenOrder.Count > MaxHistoryKeys)
            {
                string oldest = _seenOrder.Dequeue();
                _seenTurnKeys.Remove(oldest);
            }
        }
    }

    private static bool IsFallbackTitle(string title)
    {
        return string.IsNullOrWhiteSpace(title) || title.StartsWith("Conversation ", StringComparison.Ordinal);
    }

    private static string NormalizeTitle(string raw)
    {
        return NormalizeSingleLine(raw, 120);
    }

    private static string NormalizeSingleLine(string raw, int maxChars)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "";
        StringBuilder sb = new StringBuilder(raw.Length);
        bool prevSpace = false;
        for (int i = 0; i < raw.Length; i++)
        {
            char c = raw[i];
            if (char.IsWhiteSpace(c) || c == '\r' || c == '\n' || c == '\t')
            {
                if (!prevSpace && sb.Length > 0)
                {
                    sb.Append(' ');
                    prevSpace = true;
                }
            }
            else
            {
                sb.Append(c);
                prevSpace = false;
            }
        }
        string clean = sb.ToString().Trim();
        if (clean.Length > maxChars)
        {
            return clean.Substring(0, maxChars - 1).TrimEnd() + "…";
        }
        return clean;
    }

    private ToastItem FindItem(string conversationId)
    {
        for (int i = 0; i < _items.Count; i++)
        {
            if (string.Equals(_items[i].ConversationId, conversationId, StringComparison.OrdinalIgnoreCase))
            {
                return _items[i];
            }
        }
        return null;
    }

    private bool RemoveConversation(string conversationId, bool completedOnly = false)
    {
        ToastItem item = FindItem(conversationId);
        if (item == null || (completedOnly && item.Kind != "completed")) return false;
        item.Removed = true;
        _items.Remove(item);
        ResetHover();
        return true;
    }

    private void DismissItem(ToastItem item)
    {
        if (item.Kind == "action_required" && item.TurnKey.Length > 0) _dismissedWaitKeys[item.ConversationId] = item.TurnKey;
        if (item.Kind == "completed" && !string.IsNullOrEmpty(item.ConversationId))
        {
            _dismissedCompletedAt[item.ConversationId] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (_dismissedCompletedAt.Count > MaxHistoryKeys)
            {
                _dismissedCompletedAt.Clear();
                _dismissedCompletedAt[item.ConversationId] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
        }
        item.Removed = true;
        _items.Remove(item);
        ResetHover();
    }

    private void DismissAllItems()
    {
        foreach (ToastItem item in _items.ToArray()) DismissItem(item);
        RenderToasts();
    }

    private static List<ToastQuestion> ParseQuestions(Dictionary<string, object> msg)
    {
        List<ToastQuestion> questions = new List<ToastQuestion>();
        object raw;
        if (!msg.TryGetValue("questions", out raw) || !(raw is ArrayList)) return questions;
        foreach (object value in (ArrayList)raw)
        {
            var data = value as Dictionary<string, object>;
            if (data == null || !data.TryGetValue("options", out raw) || !(raw is ArrayList)) continue;
            ToastQuestion question = new ToastQuestion();
            question.Question = GetStr(data, "question");
            question.IsMultiSelect = data.ContainsKey("isMultiSelect") && Convert.ToBoolean(data["isMultiSelect"]);
            foreach (object option in (ArrayList)raw)
                question.Options.Add(Convert.ToString(option) ?? "");
            if (string.IsNullOrWhiteSpace(question.Question) || question.Options.Count == 0 ||
                question.Options.Any(string.IsNullOrWhiteSpace)) continue;

            string key = GetStr(data, "nativeApprovalKey");
            if (key.Length == 64 && key.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
            {
                question.NativeApprovalKey = key;
                question.NativeDenyIndex = data.ContainsKey("nativeDenyIndex") ? Convert.ToInt32(data["nativeDenyIndex"]) : -1;
                if (data.TryGetValue("disabledOptionIndices", out raw) && raw is ArrayList)
                {
                    foreach (object index in (ArrayList)raw) question.DisabledOptions.Add(Convert.ToInt32(index));
                }
            }
            else
            {
                for (int i = 0; i < question.Options.Count; i++)
                {
                    if (!question.Options[i].StartsWith("(Recommended)", StringComparison.OrdinalIgnoreCase)) continue;
                    question.SelectedIndices.Add(i);
                    if (!question.IsMultiSelect) break;
                }
                if (!question.IsMultiSelect && question.SelectedIndices.Count == 0) question.SelectedIndices.Add(0);
            }
            questions.Add(question);
        }
        return questions;
    }

    private static void ToggleQuestionOption(ToastQuestion q, int optIdx)
    {
        if (q == null || optIdx < 0 || optIdx >= q.Options.Count || q.DisabledOptions.Contains(optIdx)) return;
        if (q.IsMultiSelect)
        {
            if (q.SelectedIndices.Contains(optIdx)) q.SelectedIndices.Remove(optIdx);
            else q.SelectedIndices.Add(optIdx);
        }
        else
        {
            q.SelectedIndices.Clear();
            q.SelectedIndices.Add(optIdx);
        }
    }

    private static bool CanAdvance(ToastItem item)
    {
        if (item.Submission != null || item.Questions.Count == 0) return false;
        if (item.ActiveQuestionIndex < item.Questions.Count - 1)
            return item.Questions[item.ActiveQuestionIndex].SelectedIndices.Count > 0;
        return item.Questions.All(q => q.SelectedIndices.Count > 0);
    }

    private bool StartSubmission(ToastItem item)
    {
        if (!CanAdvance(item) || item.ActiveQuestionIndex != item.Questions.Count - 1) return false;
        string conversationId = item.ConversationId;
        string requestKey = item.TurnKey;
        ToastQuestion first = item.Questions[0];
        string approvalKey = first.NativeApprovalKey;
        int optionIndex = first.SelectedIndices[0];
        bool deny = optionIndex == first.NativeDenyIndex;
        var selections = item.Questions.Select(q => q.SelectedIndices.Select(i =>
            new Dictionary<string, object> { { "text", q.Options[i] }, { "index", i }, { "requestKey", item.TurnKey } }).ToList()).ToList();

        if (IsTestHost)
        {
            var labels = item.Questions.Select(q => q.SelectedIndices.Select(i => q.Options[i]).ToList()).ToList();
            File.AppendAllText(_submitLogPath, _json.Serialize(new Dictionary<string, object> {
                { "conversationId", conversationId }, { "selections", labels }, { "turnKey", item.TurnKey }
            }) + "\n", Encoding.UTF8);
            return true;
        }

        string answers = _json.Serialize(selections);
        var submission = new object();
        item.Submission = submission;
        item.SubmitStatus = "Submitting\u2026";
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                bool sent = false;
                try
                {
                    sent = approvalKey.Length > 0
                        ? NativeApproval.Submit(_launchRoot, conversationId, requestKey, approvalKey, optionIndex, deny)
                        : SendQuestionAnswers(conversationId, answers);
                }
                catch { }
                if (sent)
                {
                    var confirmWait = Stopwatch.StartNew();
                    while (!_stopping && confirmWait.ElapsedMilliseconds < 9500)
                    {
                        Thread.Sleep(250);
                        if (item.Removed || item.Submission != submission) return;
                    }
                }
                BeginInvoke(new MethodInvoker(delegate
                {
                    if (IsDisposed || item.Removed || !_items.Contains(item) || item.Submission != submission) return;
                    item.Submission = null;
                    item.SubmitStatus = "Submit not confirmed";
                    RenderToasts();
                }));
            }
            catch { }
        });
        return true;
    }

    private bool SendQuestionAnswers(string conversationId, string answers)
    {
        bool useElectronNode = false;
        string nodeExe = ResolveNode();
        if (nodeExe == null)
        {
            nodeExe = ResolveAntigravityExe();
            useElectronNode = true;
        }
        string script = Path.Combine(_uiDir, "submit-question.cjs");
        if (nodeExe == null || !File.Exists(script)) return false;
        var psi = new ProcessStartInfo(nodeExe);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        psi.WorkingDirectory = _uiDir;
        psi.EnvironmentVariables["AGY_PLUS_ROOT"] = _launchRoot;
        psi.EnvironmentVariables.Remove("NODE_OPTIONS");
        if (useElectronNode) psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        else psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        psi.RedirectStandardInput = true;
        psi.Arguments = QuoteArg(script) + " " + QuoteArg(conversationId) + " --stdin";
        using (Process process = Process.Start(psi))
        {
            if (process == null) return false;
            byte[] bytes = Encoding.UTF8.GetBytes(answers);
            process.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
            process.StandardInput.Close();
            if (!process.WaitForExit(9000))
            {
                try { process.Kill(); } catch { }
                return false;
            }
            return process.ExitCode == 0;
        }
    }

    private void ResetHover()
    {
        _hoverCardIndex = -1;
        _hoverCloseIndex = -1;
        _hoverOptionIndex = -1;
        _hoverSubmitIndex = -1;
        _hoverPrevIndex = -1;
        _hoverOpenChatIndex = -1;
        _hoverScrollCardIndex = -1;
        _hoverDismissAll = false;
    }

    private void ScrollItemBy(ToastItem item, int deltaPx)
    {
        if (item == null || item.MaxScrollPx <= 0) return;
        int next = item.ScrollOffsetPx + deltaPx;
        if (next < 0) next = 0;
        if (next > item.MaxScrollPx) next = item.MaxScrollPx;
        item.ScrollOffsetPx = next;
    }

    private bool IsAntigravityForeground()
    {
        if (_forceForegroundMode == "true") return true;
        if (_forceForegroundMode == "false") return false;

        IntPtr fg = NativeMethods.GetForegroundWindow();
        if (fg == IntPtr.Zero || NativeMethods.IsIconic(fg)) return false;
        uint pid;
        NativeMethods.GetWindowThreadProcessId(fg, out pid);
        if (pid == 0) return false;
        try
        {
            using (Process proc = Process.GetProcessById((int)pid))
            {
                return string.Equals(proc.ProcessName, "Antigravity", StringComparison.OrdinalIgnoreCase);
            }
        }
        catch
        {
            return false;
        }
    }

    private bool ActivateAntigravityWindow(out bool isForegrounded)
    {
        isForegrounded = false;
        try { NativeMethods.AllowSetForegroundWindow(-1); } catch { } // ASFW_ANY = -1

        uint targetPid;
        IntPtr targetHwnd = FindAntigravityMainWindow(out targetPid);
        if (targetHwnd == IntPtr.Zero) return false;

        try
        {
            NativeMethods.AllowSetForegroundWindow((int)targetPid);
            if (NativeMethods.IsIconic(targetHwnd))
            {
                NativeMethods.ShowWindow(targetHwnd, 9); // SW_RESTORE only when truly minimized
            }
            if (NativeMethods.GetForegroundWindow() != targetHwnd)
            {
                NativeMethods.SetForegroundWindow(targetHwnd);
            }
            isForegrounded = (NativeMethods.GetForegroundWindow() == targetHwnd);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private void OpenConversation(string conversationId)
    {
        if (!string.IsNullOrEmpty(_openLogPath))
        {
            try { File.AppendAllText(_openLogPath, conversationId + "\n", Encoding.UTF8); } catch { }
            return;
        }
        bool isForegrounded;
        bool hadWindow = ActivateAntigravityWindow(out isForegrounded);
        try
        {
            bool useElectronNode = false;
            string nodeExe = ResolveNode();
            if (nodeExe == null)
            {
                nodeExe = ResolveAntigravityExe();
                useElectronNode = true;
            }
            string script = Path.Combine(_uiDir, "open-conversation.cjs");
            if (nodeExe != null && File.Exists(script))
            {
                ProcessStartInfo psi = new ProcessStartInfo(nodeExe);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.WorkingDirectory = _uiDir;
                psi.EnvironmentVariables["AGY_PLUS_ROOT"] = _launchRoot;
                psi.EnvironmentVariables.Remove("NODE_OPTIONS");
                if (useElectronNode) psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
                else psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                string flags = (hadWindow ? " --window-activated" : "") + (isForegrounded ? " --window-foregrounded" : "");
                psi.Arguments = QuoteArg(script) + " " + QuoteArg(conversationId) + flags;
                using (Process p = Process.Start(psi)) { }
                return;
            }
        }
        catch
        {
            // Fall through to protocol launch.
        }

        try
        {
            string appExe = ResolveAntigravityExe();
            if (appExe != null)
            {
                ProcessStartInfo psi = new ProcessStartInfo(appExe);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.Arguments = QuoteArg("antigravity://agy-plus-open-conversation/" + conversationId);
                using (Process p = Process.Start(psi)) { }
            }
        }
        catch { }
    }

    private static string ResolveNode()
    {
        if (string.Equals(Environment.GetEnvironmentVariable("AGY_FORCE_ELECTRON_NODE"), "1", StringComparison.Ordinal))
        {
            return null;
        }
        string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        string[] dirs = pathEnv.Split(Path.PathSeparator);
        for (int i = 0; i < dirs.Length; i++)
        {
            string d = dirs[i].Trim('"');
            if (d.Length == 0) continue;
            try
            {
                string candidate = Path.Combine(d, "node.exe");
                if (candidate.IndexOf(@"\Programs\antigravity\", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        string programFilesNode = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (File.Exists(programFilesNode)) return programFilesNode;
        if (File.Exists(@"D:\Program Files\nodejs\node.exe")) return @"D:\Program Files\nodejs\node.exe";
        return null;
    }

    private string ResolveConfiguredAntigravityExe()
    {
        try
        {
            string receiptPath = Path.Combine(_launchRoot, "install-receipt.json");
            if (File.Exists(receiptPath))
            {
                var receipt = _json.Deserialize<Dictionary<string, object>>(File.ReadAllText(receiptPath, Encoding.UTF8));
                if (receipt != null)
                {
                    string exe = GetStr(receipt, "antigravityExePath").Trim();
                    if (exe.Length > 0 && File.Exists(exe)) return exe;
                    string resDir = GetStr(receipt, "antigravityResourcesDir").Trim();
                    if (resDir.Length > 0)
                    {
                        string parentDir = Path.GetDirectoryName(resDir.TrimEnd('\\', '/'));
                        if (!string.IsNullOrEmpty(parentDir))
                        {
                            string fromRes = Path.Combine(parentDir, "Antigravity.exe");
                            if (File.Exists(fromRes)) return fromRes;
                        }
                    }
                }
            }
            string rtStatePath = Path.Combine(_launchRoot, "runtime_state.json");
            if (File.Exists(rtStatePath))
            {
                var rt = _json.Deserialize<Dictionary<string, object>>(File.ReadAllText(rtStatePath, Encoding.UTF8));
                if (rt != null)
                {
                    string appExe = GetStr(rt, "AppExe").Trim();
                    if (appExe.Length > 0 && File.Exists(appExe)) return appExe;
                }
            }
        }
        catch { }
        return null;
    }

    private string ResolveAntigravityExe()
    {
        string configured = ResolveConfiguredAntigravityExe();
        if (!string.IsNullOrEmpty(configured)) return configured;
        string local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "antigravity", "Antigravity.exe");
        if (File.Exists(local)) return local;
        string pf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Antigravity", "Antigravity.exe");
        return File.Exists(pf) ? pf : null;
    }

    private static string QuoteArg(string arg)
    {
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        for (int i = 0; i < arg.Length; i++)
        {
            char ch = arg[i];
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { quoted.Append('\\', slashes * 2 + 1); quoted.Append('"'); }
            else { quoted.Append('\\', slashes); quoted.Append(ch); }
            slashes = 0;
        }
        quoted.Append('\\', slashes * 2);
        return quoted.Append('"').ToString();
    }

    private static string GetStr(Dictionary<string, object> dict, string key)
    {
        object val;
        return dict.TryGetValue(key, out val) && val != null ? Convert.ToString(val) : "";
    }

    private void RenderToasts()
    {
        if (IsDisposed) return;
        if (_items.Count == 0)
        {
            _monitorTrackTimer.Stop();
            _displayRefreshTimer.Stop();
            _dismissAllBounds = Rectangle.Empty;
            _currentScreenBounds = Rectangle.Empty;
            _lastTargetWorkArea = Rectangle.Empty;
            _lastLayeredRenderOk = true;
            if (_lastRenderedBitmap != null)
            {
                _lastRenderedBitmap.Dispose();
                _lastRenderedBitmap = null;
            }
            if (Visible || (IsHandleCreated && NativeMethods.IsWindowVisible(Handle)))
            {
                Hide();
                NativeMethods.ShowWindow(Handle, 0); // SW_HIDE
            }
            return;
        }

        float targetDpi;
        string targetDevice;
        Rectangle work = ResolveTargetMonitorWorkArea(out targetDpi, out targetDevice);
        _dpiScale = targetDpi;
        _lastTargetWorkArea = work;
        _lastTargetDpiScale = targetDpi;
        _currentMonitorDevice = targetDevice;
        if (!_monitorTrackTimer.Enabled)
        {
            _monitorTrackTimer.Start();
        }

        int pad = S(10);
        int hardMaxCardW = Math.Max(S(240), work.Width - pad * 2 - S(16));
        int maxAllowedCardW = Math.Min(hardMaxCardW, Math.Max(S(360), (int)Math.Floor(work.Width * 0.45) - pad * 2));
        int cardW = Math.Min(S(468), maxAllowedCardW);
        int gap = S(8);
        bool showHeader = _items.Count >= 2;
        int headerH = showHeader ? S(28) : 0;
        int headerGap = showHeader ? S(6) : 0;

        int visibleCount = Math.Min(_items.Count, MaxVisibleCards);
        int startIndex = _items.Count - visibleCount;

        for (int i = 0; i < startIndex; i++)
        {
            _items[i].CardBounds = Rectangle.Empty;
            _items[i].CloseBounds = Rectangle.Empty;
            _items[i].OptionBounds.Clear();
            _items[i].PrevButtonBounds = Rectangle.Empty;
            _items[i].SubmitButtonBounds = Rectangle.Empty;
            _items[i].ContentViewportBounds = Rectangle.Empty;
            _items[i].ScrollTrackBounds = Rectangle.Empty;
            _items[i].ScrollThumbBounds = Rectangle.Empty;
            _items[i].MaxScrollPx = 0;
        }

        int[] cardHeights = new int[visibleCount];
        int[] titleHeights = new int[visibleCount];
        int[] boxViewportHeights = new int[visibleCount];
        int[] contentTotalHeights = new int[visibleCount];
        bool[] needsScrollFlags = new bool[visibleCount];
        List<string>[] wrappedDetails = new List<string>[visibleCount];
        List<string>[] wrappedQPrompts = new List<string>[visibleCount];
        List<List<string>>[] wrappedOptLines = new List<List<string>>[visibleCount];
        List<int>[] optItemHeights = new List<int>[visibleCount];

        int scrollLaneW = S(14);
        int detailLineH = S(15);
        int qLineH = S(16);
        int hardMaxWinH = Math.Max(S(200), work.Height - S(16));
        int maxWinH = Math.Min(hardMaxWinH, Math.Max(S(260), (int)Math.Floor(work.Height * 0.82)));

        using (Bitmap measureBmp = new Bitmap(16, 16, PixelFormat.Format32bppArgb))
        {
            measureBmp.SetResolution(96.0f, 96.0f);
            using (Graphics mg = Graphics.FromImage(measureBmp))
            using (Font measureTitleFont = CreateUiFont(12.0f, FontStyle.Bold))
            using (Font measureDetailFont = CreateUiFont(10.5f, FontStyle.Regular))
            using (Font measureQFont = CreateUiFont(11.0f, FontStyle.Bold))
            {
                mg.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                int availTitleW = cardW - S(28);
                int singleLineH = S(18);
                int twoLineH = S(34);
                int fullBoxInnerW = cardW - S(24);

                Action<int, bool> measureCardContent = (int k, bool reserveScroll) =>
                {
                    ToastItem it = _items[startIndex + k];
                    int usableInnerW = fullBoxInnerW - (reserveScroll ? scrollLaneW : 0);

                    if (it.Questions != null && it.Questions.Count > 0)
                    {
                        if (it.ActiveQuestionIndex < 0 || it.ActiveQuestionIndex >= it.Questions.Count)
                            it.ActiveQuestionIndex = 0;
                        ToastQuestion activeQ = it.Questions[it.ActiveQuestionIndex];

                        int extraDetailH = 0;
                        if (it.ShowDetailWithQuestions && !string.IsNullOrEmpty(it.Detail))
                        {
                            List<string> dLines = WrapDetailLines(mg, it.Detail, measureDetailFont, Math.Max(S(110), usableInnerW - S(30)));
                            if (dLines.Count == 0) dLines.Add(it.Detail);
                            wrappedDetails[k] = dLines;
                            extraDetailH = dLines.Count * detailLineH + S(14) + S(8);
                        }
                        else
                        {
                            wrappedDetails[k] = null;
                        }

                        List<string> qLines = WrapDetailLines(mg, activeQ.Question ?? "", measureQFont, Math.Max(S(120), usableInnerW - S(18)));
                        if (qLines.Count == 0) qLines.Add(activeQ.Question ?? "");
                        wrappedQPrompts[k] = qLines;
                        int qH = qLines.Count * qLineH;

                        var optLinesList = new List<List<string>>(activeQ.Options.Count);
                        var optHeightsList = new List<int>(activeQ.Options.Count);
                        int optTextAvailW = Math.Max(S(100), usableInnerW - S(50));
                        int optsTotalH = 0;
                        for (int oi = 0; oi < activeQ.Options.Count; oi++)
                        {
                            List<string> ol = WrapDetailLines(mg, activeQ.Options[oi], measureDetailFont, optTextAvailW);
                            if (ol.Count == 0) ol.Add(activeQ.Options[oi]);
                            int oh = Math.Max(S(26), ol.Count * detailLineH + S(10));
                            optLinesList.Add(ol);
                            optHeightsList.Add(oh);
                            optsTotalH += oh;
                            if (oi > 0) optsTotalH += S(5);
                        }
                        wrappedOptLines[k] = optLinesList;
                        optItemHeights[k] = optHeightsList;
                        contentTotalHeights[k] = S(14) + extraDetailH + qH + S(6) + optsTotalH;
                    }
                    else if (!string.IsNullOrEmpty(it.Detail))
                    {
                        List<string> dLines = WrapDetailLines(mg, it.Detail, measureDetailFont, Math.Max(S(120), usableInnerW - S(18)));
                        if (dLines.Count == 0) dLines.Add(it.Detail);
                        wrappedDetails[k] = dLines;
                        contentTotalHeights[k] = dLines.Count * detailLineH + S(12);
                    }
                    else
                    {
                        wrappedDetails[k] = null;
                        contentTotalHeights[k] = 0;
                    }
                };

                int baseChromeTotal = pad * 2 + headerH + headerGap + Math.Max(0, visibleCount - 1) * gap;
                int[] cardChromeH = new int[visibleCount];
                int[] desiredBoxH = new int[visibleCount];

                for (int k = 0; k < visibleCount; k++)
                {
                    ToastItem it = _items[startIndex + k];
                    string t = it.Title ?? "";
                    SizeF sz = mg.MeasureString(t, measureTitleFont, availTitleW);
                    bool needsTwoLines = sz.Height > (singleLineH * 1.35f);
                    titleHeights[k] = needsTwoLines ? twoLineH : singleLineH;

                    measureCardContent(k, false);
                    bool hasQ = it.Questions != null && it.Questions.Count > 0;
                    if (hasQ)
                    {
                        cardChromeH[k] = S(66) + titleHeights[k];
                        int maxCap = it.ShowDetailWithQuestions ? S(316) : S(256);
                        desiredBoxH[k] = Math.Min(contentTotalHeights[k], maxCap);
                        needsScrollFlags[k] = contentTotalHeights[k] > maxCap;
                    }
                    else if (contentTotalHeights[k] > 0)
                    {
                        cardChromeH[k] = S(62) + titleHeights[k];
                        int maxCap = S(136);
                        desiredBoxH[k] = Math.Min(contentTotalHeights[k], maxCap);
                        needsScrollFlags[k] = contentTotalHeights[k] > maxCap;
                    }
                    else
                    {
                        cardChromeH[k] = S(56) + titleHeights[k];
                        desiredBoxH[k] = 0;
                        needsScrollFlags[k] = false;
                    }
                }

                // If stacked cards exceed screen height, shrink tall content viewports cleanly and enable scrollbars.
                int estTotalH = baseChromeTotal;
                for (int k = 0; k < visibleCount; k++) estTotalH += cardChromeH[k] + desiredBoxH[k];
                if (estTotalH > maxWinH)
                {
                    int excess = estTotalH - maxWinH;
                    int minBoxH = S(68);
                    for (int pass = 0; pass < 4 && excess > 0; pass++)
                    {
                        int shrinkableSum = 0;
                        for (int k = 0; k < visibleCount; k++)
                        {
                            if (desiredBoxH[k] > minBoxH) shrinkableSum += (desiredBoxH[k] - minBoxH);
                        }
                        if (shrinkableSum <= 0) break;
                        for (int k = 0; k < visibleCount && excess > 0; k++)
                        {
                            if (desiredBoxH[k] <= minBoxH) continue;
                            int avail = desiredBoxH[k] - minBoxH;
                            int cut = Math.Min(avail, Math.Max(1, (int)Math.Ceiling((double)excess * avail / shrinkableSum)));
                            desiredBoxH[k] -= cut;
                            excess -= cut;
                            needsScrollFlags[k] = true;
                        }
                    }
                }

                // Re-measure any card that needs a scrollbar so wrapping matches the narrower text column exactly.
                for (int k = 0; k < visibleCount; k++)
                {
                    if (desiredBoxH[k] > 0 && needsScrollFlags[k])
                    {
                        measureCardContent(k, true);
                    }
                    boxViewportHeights[k] = desiredBoxH[k];
                    cardHeights[k] = cardChromeH[k] + boxViewportHeights[k];
                }
            }
        }

        // If stacked cards still exceed the monitor work area at high DPI (e.g., 200% scaling),
        // drop oldest visible cards from the top while always keeping at least the newest card so
        // the bottom Submit button is never clipped behind the taskbar.
        int firstVisibleOffset = 0;
        int totalCardsH = 0;
        for (int k = 0; k < visibleCount; k++) totalCardsH += cardHeights[k];
        while ((visibleCount - firstVisibleOffset) > 1 &&
               (pad * 2 + headerH + headerGap + totalCardsH + (visibleCount - firstVisibleOffset - 1) * gap) > hardMaxWinH)
        {
            ToastItem hiddenItem = _items[startIndex + firstVisibleOffset];
            hiddenItem.CardBounds = Rectangle.Empty;
            hiddenItem.CloseBounds = Rectangle.Empty;
            hiddenItem.OptionBounds.Clear();
            hiddenItem.PrevButtonBounds = Rectangle.Empty;
            hiddenItem.SubmitButtonBounds = Rectangle.Empty;
            hiddenItem.OpenChatButtonBounds = Rectangle.Empty;
            hiddenItem.ContentViewportBounds = Rectangle.Empty;
            hiddenItem.ScrollTrackBounds = Rectangle.Empty;
            hiddenItem.ScrollThumbBounds = Rectangle.Empty;
            hiddenItem.MaxScrollPx = 0;
            totalCardsH -= cardHeights[firstVisibleOffset];
            firstVisibleOffset++;
        }
        int effectiveVisibleCount = visibleCount - firstVisibleOffset;

        int winW = cardW + pad * 2;
        int winH = pad * 2 + headerH + headerGap + totalCardsH + Math.Max(0, effectiveVisibleCount - 1) * gap;

        int winX = Math.Max(work.Left + S(8), work.Right - winW - S(8));
        int winY = Math.Max(work.Top + S(8), work.Bottom - winH - S(8));
        _currentScreenBounds = new Rectangle(winX, winY, winW, winH);

        using (Bitmap bmp = new Bitmap(winW, winH, PixelFormat.Format32bppArgb))
        {
            bmp.SetResolution(96.0f, 96.0f);
            List<Rectangle> opaqueRegions = new List<Rectangle>(visibleCount + 1);
            int cardRadius = S(11);
            int headerRadius = S(8);

            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.FromArgb(0, 0, 0, 0));

                int curY = pad;
                if (showHeader)
                {
                    Rectangle headerRect = new Rectangle(pad, curY, cardW, headerH);
                    DrawShadow(g, headerRect, headerRadius);
                    using (GraphicsPath hp = RoundedRect(headerRect, headerRadius))
                    using (SolidBrush hb = new SolidBrush(Color.FromArgb(255, 24, 24, 26)))
                    using (Pen hpen = new Pen(Color.FromArgb(255, 76, 76, 82), 1f))
                    {
                        g.FillPath(hb, hp);
                        g.DrawPath(hpen, hp);
                    }
                    opaqueRegions.Add(Rectangle.Inflate(headerRect, -headerRadius / 2 - 1, -2));

                    int actionTotal = 0;
                    for (int m = 0; m < _items.Count; m++)
                    {
                        if (_items[m].Kind == "action_required") actionTotal++;
                    }
                    string summaryText;
                    if (actionTotal == 0) summaryText = _items.Count + " tasks completed";
                    else if (actionTotal == _items.Count) summaryText = _items.Count + " chats waiting";
                    else summaryText = _items.Count + " notifications · " + actionTotal + " waiting";
                    g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                    using (Font metaFont = CreateUiFont(10.5f, FontStyle.Regular))
                    using (Font btnFont = CreateUiFont(10.5f, FontStyle.Bold))
                    using (SolidBrush mutedBrush = new SolidBrush(Color.FromArgb(255, 212, 212, 216)))
                    {
                        Rectangle leftTextRect = new Rectangle(headerRect.X + S(12), headerRect.Y, Math.Max(S(160), cardW - S(116)), headerRect.Height);
                        using (StringFormat sfLeft = new StringFormat())
                        {
                            sfLeft.LineAlignment = StringAlignment.Center;
                            sfLeft.FormatFlags = StringFormatFlags.NoWrap;
                            g.DrawString(summaryText, metaFont, mutedBrush, leftTextRect, sfLeft);
                        }

                        int btnW = S(82);
                        int btnH = S(20);
                        _dismissAllBounds = new Rectangle(headerRect.Right - btnW - S(6), headerRect.Y + (headerRect.Height - btnH) / 2, btnW, btnH);
                        if (_hoverDismissAll)
                        {
                            g.SmoothingMode = SmoothingMode.AntiAlias;
                            using (GraphicsPath bp = RoundedRect(_dismissAllBounds, S(5)))
                            using (SolidBrush bb = new SolidBrush(Color.FromArgb(255, 52, 52, 58)))
                            {
                                g.FillPath(bb, bp);
                            }
                        }
                        using (SolidBrush btnTextBrush = new SolidBrush(_hoverDismissAll ? Color.FromArgb(255, 255, 255, 255) : Color.FromArgb(255, 224, 224, 228)))
                        using (StringFormat sfCenter = new StringFormat())
                        {
                            sfCenter.Alignment = StringAlignment.Center;
                            sfCenter.LineAlignment = StringAlignment.Center;
                            g.DrawString("Dismiss all", btnFont, btnTextBrush, _dismissAllBounds, sfCenter);
                        }
                    }
                    curY += headerH + headerGap;
                }
                else
                {
                    _dismissAllBounds = Rectangle.Empty;
                }

                using (Font statusFont = CreateUiFont(10.5f, FontStyle.Regular))
                using (Font statusBoldFont = CreateUiFont(10.5f, FontStyle.Bold))
                using (Font titleFont = CreateUiFont(12.0f, FontStyle.Bold))
                using (Font qPromptFont = CreateUiFont(11.0f, FontStyle.Bold))
                using (Font detailFont = CreateUiFont(10.5f, FontStyle.Regular))
                using (Font footerFont = CreateUiFont(10.5f, FontStyle.Regular))
                using (Font submitBtnFont = CreateUiFont(10.5f, FontStyle.Bold))
                {
                    for (int k = firstVisibleOffset; k < visibleCount; k++)
                    {
                        int idx = startIndex + k;
                        int cardH = cardHeights[k];
                        int titleH = titleHeights[k];
                        int boxH = boxViewportHeights[k];
                        int totalContentH = contentTotalHeights[k];
                        ToastItem item = _items[idx];
                        item.OptionBounds.Clear();
                        item.PrevButtonBounds = Rectangle.Empty;
                        item.SubmitButtonBounds = Rectangle.Empty;
                        item.OpenChatButtonBounds = Rectangle.Empty;
                        item.ContentViewportBounds = Rectangle.Empty;
                        item.ScrollTrackBounds = Rectangle.Empty;
                        item.ScrollThumbBounds = Rectangle.Empty;

                        bool hasQuestions = (item.Questions != null && item.Questions.Count > 0);
                        bool isAction = (item.Kind == "action_required" || hasQuestions);
                        Rectangle cardRect = new Rectangle(pad, curY, cardW, cardH);
                        item.CardBounds = cardRect;
                        int closeSize = S(22);
                        item.CloseBounds = new Rectangle(cardRect.Right - closeSize - S(10), cardRect.Y + S(6), closeSize, closeSize);

                        bool onInnerControl = (_hoverCloseIndex == idx ||
                            (_hoverCardIndex == idx && _hoverOptionIndex >= 0) ||
                            _hoverSubmitIndex == idx ||
                            _hoverPrevIndex == idx ||
                            _hoverOpenChatIndex == idx ||
                            _hoverScrollCardIndex == idx ||
                            _dragScrollItem == item);
                        bool cardHovered = (_hoverCardIndex == idx && !onInnerControl);
                        bool closeHovered = (_hoverCloseIndex == idx);

                        Color bgCol = cardHovered
                            ? (isAction ? Color.FromArgb(255, 38, 33, 26) : Color.FromArgb(255, 34, 34, 38))
                            : (isAction ? Color.FromArgb(255, 28, 25, 20) : Color.FromArgb(255, 24, 24, 26));
                        Color borderCol = cardHovered
                            ? (isAction ? Color.FromArgb(255, 198, 142, 62) : Color.FromArgb(255, 118, 118, 126))
                            : (isAction ? Color.FromArgb(255, 142, 100, 40) : Color.FromArgb(255, 78, 78, 84));

                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        DrawShadow(g, cardRect, cardRadius);
                        using (GraphicsPath cp = RoundedRect(cardRect, cardRadius))
                        using (SolidBrush cb = new SolidBrush(bgCol))
                        using (Pen cpen = new Pen(borderCol, 1f))
                        {
                            g.FillPath(cb, cp);
                            g.DrawPath(cpen, cp);
                        }
                        opaqueRegions.Add(new Rectangle(cardRect.X + cardRadius, cardRect.Y + 2, cardRect.Width - cardRadius * 2, cardRect.Height - 4));
                        opaqueRegions.Add(new Rectangle(cardRect.X + 2, cardRect.Y + cardRadius, cardRect.Width - 4, cardRect.Height - cardRadius * 2));

                        // Status dot (Amber for action_required, Green for completed)
                        int dotSize = S(7);
                        int topRowY = cardRect.Y + S(8);
                        Rectangle dotRect = new Rectangle(cardRect.X + S(14), topRowY + S(4), dotSize, dotSize);
                        using (SolidBrush dotBrush = new SolidBrush(isAction ? Color.FromArgb(255, 245, 166, 35) : Color.FromArgb(255, 94, 206, 132)))
                        {
                            g.FillEllipse(dotBrush, dotRect);
                        }

                        // Close button (X)
                        if (closeHovered)
                        {
                            using (GraphicsPath xbg = RoundedRect(item.CloseBounds, S(5)))
                            using (SolidBrush xb = new SolidBrush(Color.FromArgb(255, 66, 66, 72)))
                            {
                                g.FillPath(xb, xbg);
                            }
                        }
                        using (Pen xPen = new Pen(closeHovered ? Color.FromArgb(255, 255, 255, 255) : Color.FromArgb(255, 176, 176, 182), Math.Max(1.35f, 1.35f * _dpiScale)))
                        {
                            xPen.StartCap = LineCap.Round;
                            xPen.EndCap = LineCap.Round;
                            int inset = S(7);
                            g.DrawLine(xPen, item.CloseBounds.Left + inset, item.CloseBounds.Top + inset, item.CloseBounds.Right - inset, item.CloseBounds.Bottom - inset);
                            g.DrawLine(xPen, item.CloseBounds.Right - inset, item.CloseBounds.Top + inset, item.CloseBounds.Left + inset, item.CloseBounds.Bottom - inset);
                        }

                        // Sharp ClearType text inside solid card body
                        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

                        Color statusTextCol = isAction ? Color.FromArgb(255, 250, 198, 108) : Color.FromArgb(255, 212, 212, 216);
                        using (SolidBrush statusBrush = new SolidBrush(statusTextCol))
                        using (SolidBrush timeBrush = new SolidBrush(Color.FromArgb(255, 172, 172, 178)))
                        using (StringFormat sfNoWrap = new StringFormat())
                        using (StringFormat sfRight = new StringFormat())
                        {
                            sfNoWrap.FormatFlags = StringFormatFlags.NoWrap;
                            sfNoWrap.LineAlignment = StringAlignment.Center;

                            string badgeStr = !string.IsNullOrEmpty(item.StatusLabel)
                                ? item.StatusLabel
                                : (isAction ? "Action needed" : "Task completed");
                            if (item.SubmitStatus.Length > 0) badgeStr = item.SubmitStatus;
                            if (hasQuestions && item.Questions.Count > 1)
                            {
                                badgeStr = badgeStr + " · Q" + (item.ActiveQuestionIndex + 1) + "/" + item.Questions.Count;
                            }
                            Rectangle labelRect = new Rectangle(dotRect.Right + S(7), topRowY, Math.Max(S(160), cardRect.Width - S(130)), S(16));
                            g.DrawString(badgeStr, isAction ? statusBoldFont : statusFont, statusBrush, labelRect, sfNoWrap);

                            sfRight.Alignment = StringAlignment.Far;
                            sfRight.LineAlignment = StringAlignment.Center;
                            sfRight.FormatFlags = StringFormatFlags.NoWrap;
                            Rectangle timeRect = new Rectangle(item.CloseBounds.Left - S(64), topRowY, S(58), S(16));
                            g.DrawString(item.CompletedTimeText ?? "", statusFont, timeBrush, timeRect, sfRight);
                        }

                        // Conversation title (1-2 lines, crisp white)
                        using (SolidBrush titleBrush = new SolidBrush(Color.FromArgb(255, 255, 255, 255)))
                        using (StringFormat sfTitle = new StringFormat())
                        {
                            sfTitle.Trimming = StringTrimming.EllipsisCharacter;
                            Rectangle titleRect = new Rectangle(cardRect.X + S(14), cardRect.Y + S(27), cardRect.Width - S(28), titleH + S(2));
                            g.DrawString(item.Title ?? "", titleFont, titleBrush, titleRect, sfTitle);
                        }

                        int contentTopY = cardRect.Y + S(30) + titleH;
                        if (boxH > 0)
                        {
                            Rectangle boxRect = new Rectangle(cardRect.X + S(12), contentTopY, cardRect.Width - S(24), boxH);
                            item.ContentViewportBounds = boxRect;
                            item.MaxScrollPx = Math.Max(0, totalContentH - boxH);
                            if (item.ScrollOffsetPx < 0) item.ScrollOffsetPx = 0;
                            if (item.ScrollOffsetPx > item.MaxScrollPx) item.ScrollOffsetPx = item.MaxScrollPx;
                            bool showScrollbar = item.MaxScrollPx > 0;
                            int usableRight = boxRect.Right - (showScrollbar ? scrollLaneW : 0);

                            g.SmoothingMode = SmoothingMode.AntiAlias;
                            using (GraphicsPath bp = RoundedRect(boxRect, S(7)))
                            using (SolidBrush bb = new SolidBrush(hasQuestions ? Color.FromArgb(255, 19, 19, 22) : Color.FromArgb(255, 18, 18, 21)))
                            using (Pen bpen = new Pen(hasQuestions ? Color.FromArgb(255, 64, 56, 44) : Color.FromArgb(255, 62, 56, 46), 1f))
                            {
                                g.FillPath(bb, bp);
                                g.DrawPath(bpen, bp);
                            }

                            Rectangle clipRect = new Rectangle(boxRect.X + 2, boxRect.Y + 2, Math.Max(10, usableRight - boxRect.X - 3), Math.Max(10, boxRect.Height - 4));
                            GraphicsState savedState = g.Save();
                            g.SetClip(clipRect);
                            using (StringFormat sfLine = new StringFormat(StringFormat.GenericTypographic))
                            {
                            sfLine.FormatFlags |= StringFormatFlags.NoWrap;

                            if (hasQuestions)
                            {
                                ToastQuestion activeQ = item.Questions[item.ActiveQuestionIndex];
                                List<string> qLines = wrappedQPrompts[k] ?? new List<string> { activeQ.Question ?? "" };
                                List<List<string>> optLinesList = wrappedOptLines[k];
                                List<int> optHeightsList = optItemHeights[k];

                                g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

                                int drawY = boxRect.Y + S(6) - item.ScrollOffsetPx;

                                if (item.ShowDetailWithQuestions && wrappedDetails[k] != null && wrappedDetails[k].Count > 0)
                                {
                                    List<string> dLines = wrappedDetails[k];
                                    int detailBlockH = dLines.Count * detailLineH + S(12);
                                    Rectangle innerDetailRect = new Rectangle(boxRect.X + S(8), drawY, Math.Max(S(120), usableRight - boxRect.X - S(16)), detailBlockH);
                                    g.SmoothingMode = SmoothingMode.AntiAlias;
                                    using (GraphicsPath idp = RoundedRect(innerDetailRect, S(5)))
                                    using (SolidBrush idb = new SolidBrush(Color.FromArgb(255, 13, 13, 16)))
                                    using (Pen idpen = new Pen(Color.FromArgb(255, 62, 54, 42), 1f))
                                    {
                                        g.FillPath(idb, idp);
                                        g.DrawPath(idpen, idp);
                                    }
                                    g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                                    using (SolidBrush detailTextBrush = new SolidBrush(Color.FromArgb(255, 240, 226, 200)))
                                    {
                                        int dlY = innerDetailRect.Y + S(6);
                                        for (int dl = 0; dl < dLines.Count; dl++)
                                        {
                                            if (dlY + detailLineH >= clipRect.Top && dlY <= clipRect.Bottom)
                                            {
                                                DrawUserLine(g, dLines[dl], detailFont, detailTextBrush, innerDetailRect.X + S(8), dlY, sfLine);
                                            }
                                            dlY += detailLineH;
                                        }
                                    }
                                    drawY = innerDetailRect.Bottom + S(8);
                                }

                                using (SolidBrush qBrush = new SolidBrush(Color.FromArgb(255, 245, 238, 226)))
                                {
                                    for (int ql = 0; ql < qLines.Count; ql++)
                                    {
                                        DrawUserLine(g, qLines[ql], qPromptFont, qBrush, boxRect.X + S(10), drawY, sfLine);
                                        drawY += qLineH;
                                    }
                                }

                                int optY = drawY + S(6);
                                int optBoxW = Math.Max(S(120), usableRight - boxRect.X - S(16));
                                for (int optIdx = 0; optIdx < activeQ.Options.Count; optIdx++)
                                {
                                    List<string> oLines = (optLinesList != null && optIdx < optLinesList.Count)
                                        ? optLinesList[optIdx]
                                        : new List<string> { activeQ.Options[optIdx] };
                                    int optH = (optHeightsList != null && optIdx < optHeightsList.Count)
                                        ? optHeightsList[optIdx]
                                        : Math.Max(S(26), oLines.Count * detailLineH + S(10));

                                    Rectangle optRect = new Rectangle(boxRect.X + S(8), optY, optBoxW, optH);
                                    Rectangle visibleOpt = Rectangle.Intersect(optRect, clipRect);
                                    item.OptionBounds.Add(visibleOpt.Height >= S(6) ? visibleOpt : Rectangle.Empty);

                                    if (optRect.Bottom >= clipRect.Top && optRect.Top <= clipRect.Bottom)
                                    {
                                        bool selected = activeQ.SelectedIndices.Contains(optIdx);
                                        bool enabled = !activeQ.DisabledOptions.Contains(optIdx);
                                        bool optHovered = enabled && _hoverCardIndex == idx && _hoverOptionIndex == optIdx;

                                        g.SmoothingMode = SmoothingMode.AntiAlias;
                                        Color optBg = selected
                                            ? (optHovered ? Color.FromArgb(255, 68, 52, 28) : Color.FromArgb(255, 56, 43, 24))
                                            : (optHovered ? Color.FromArgb(255, 44, 44, 50) : Color.FromArgb(255, 32, 32, 37));
                                        Color optBorder = selected
                                            ? Color.FromArgb(255, 218, 150, 44)
                                            : (optHovered ? Color.FromArgb(255, 96, 96, 106) : Color.FromArgb(255, 58, 58, 66));

                                        using (GraphicsPath op = RoundedRect(optRect, S(5)))
                                        using (SolidBrush ob = new SolidBrush(optBg))
                                        using (Pen open = new Pen(optBorder, 1f))
                                        {
                                            g.FillPath(ob, op);
                                            g.DrawPath(open, op);
                                        }

                                        // Radio circle or Checkbox square
                                        int indSize = S(12);
                                        int indY = optRect.Y + (oLines.Count > 1 ? S(7) : (optRect.Height - indSize) / 2);
                                        Rectangle indRect = new Rectangle(optRect.X + S(9), indY, indSize, indSize);
                                        if (activeQ.IsMultiSelect)
                                        {
                                            using (GraphicsPath sq = RoundedRect(indRect, S(3)))
                                            using (Pen indPen = new Pen(selected ? Color.FromArgb(255, 245, 166, 35) : Color.FromArgb(255, 138, 138, 148), 1.3f))
                                            {
                                                if (selected)
                                                {
                                                    using (SolidBrush sb = new SolidBrush(Color.FromArgb(255, 245, 166, 35)))
                                                    {
                                                        g.FillPath(sb, sq);
                                                    }
                                                    using (Pen ckPen = new Pen(Color.FromArgb(255, 22, 22, 24), Math.Max(1.5f, 1.5f * _dpiScale)))
                                                    {
                                                        g.DrawLine(ckPen, indRect.X + S(3), indRect.Y + S(6), indRect.X + S(5), indRect.Bottom - S(3));
                                                        g.DrawLine(ckPen, indRect.X + S(5), indRect.Bottom - S(3), indRect.Right - S(2), indRect.Y + S(3));
                                                    }
                                                }
                                                else
                                                {
                                                    g.DrawPath(indPen, sq);
                                                }
                                            }
                                        }
                                        else
                                        {
                                            using (Pen indPen = new Pen(selected ? Color.FromArgb(255, 245, 166, 35) : Color.FromArgb(255, 138, 138, 148), 1.3f))
                                            {
                                                g.DrawEllipse(indPen, indRect);
                                            }
                                            if (selected)
                                            {
                                                int inner = S(6);
                                                Rectangle innerDot = new Rectangle(indRect.X + (indSize - inner) / 2, indRect.Y + (indSize - inner) / 2, inner, inner);
                                                using (SolidBrush sb = new SolidBrush(Color.FromArgb(255, 245, 166, 35)))
                                                {
                                                    g.FillEllipse(sb, innerDot);
                                                }
                                            }
                                        }

                                        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                                        using (SolidBrush optTextBrush = new SolidBrush(!enabled ? Color.FromArgb(255, 145, 145, 153) : (selected ? Color.FromArgb(255, 255, 255, 255) : Color.FromArgb(255, 222, 222, 228))))
                                        {
                                            int textBlockH = oLines.Count * detailLineH;
                                            int textY = optRect.Y + Math.Max(S(5), (optRect.Height - textBlockH) / 2);
                                            int textX = indRect.Right + S(8);
                                            for (int olIdx = 0; olIdx < oLines.Count; olIdx++)
                                            {
                                                DrawUserLine(g, oLines[olIdx], detailFont, optTextBrush, textX, textY, sfLine);
                                                textY += detailLineH;
                                            }
                                        }
                                    }

                                    optY += optH + S(5);
                                }
                            }
                            else if (!string.IsNullOrEmpty(item.Detail))
                            {
                                g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                                using (SolidBrush detailBrush = new SolidBrush(Color.FromArgb(255, 236, 226, 208)))
                                {
                                    List<string> lines = wrappedDetails[k] ?? new List<string> { item.Detail };
                                    int lineY = boxRect.Y + S(6) - item.ScrollOffsetPx;
                                    for (int ln = 0; ln < lines.Count; ln++)
                                    {
                                        if (lineY + detailLineH >= clipRect.Top && lineY <= clipRect.Bottom)
                                        {
                                            DrawUserLine(g, lines[ln], detailFont, detailBrush, boxRect.X + S(9), lineY, sfLine);
                                        }
                                        lineY += detailLineH;
                                    }
                                }
                            }
                            }

                            g.Restore(savedState);

                            // Custom warm charcoal/amber scrollbar when content overflows
                            if (showScrollbar)
                            {
                                int trackInset = S(5);
                                int visualTrackW = Math.Max(S(6), 4);
                                int visualTrackX = boxRect.Right - S(4) - visualTrackW;
                                Rectangle visualTrack = new Rectangle(visualTrackX, boxRect.Y + trackInset, visualTrackW, Math.Max(S(20), boxRect.Height - trackInset * 2));
                                // Wider invisible hit target for easy touch/mouse dragging on iPad remote
                                item.ScrollTrackBounds = new Rectangle(boxRect.Right - S(16), boxRect.Y + 2, S(16), Math.Max(S(20), boxRect.Height - 4));

                                int thumbH = Math.Max(S(24), (int)Math.Round(visualTrack.Height * ((double)boxH / Math.Max(boxH + 1, totalContentH))));
                                if (thumbH > visualTrack.Height) thumbH = visualTrack.Height;
                                int maxThumbTravel = Math.Max(1, visualTrack.Height - thumbH);
                                int thumbY = visualTrack.Y + (int)Math.Round(maxThumbTravel * ((double)item.ScrollOffsetPx / Math.Max(1, item.MaxScrollPx)));
                                Rectangle visualThumb = new Rectangle(visualTrack.X, thumbY, visualTrack.Width, thumbH);
                                item.ScrollThumbBounds = new Rectangle(item.ScrollTrackBounds.X, Math.Max(boxRect.Y + 2, thumbY - S(2)), item.ScrollTrackBounds.Width, thumbH + S(4));

                                bool scrollActive = (_dragScrollItem == item || _hoverScrollCardIndex == idx);
                                g.SmoothingMode = SmoothingMode.AntiAlias;
                                using (GraphicsPath tp = RoundedRect(visualTrack, visualTrackW / 2))
                                using (SolidBrush tb = new SolidBrush(Color.FromArgb(255, 34, 32, 30)))
                                {
                                    g.FillPath(tb, tp);
                                }
                                Color thumbCol = scrollActive
                                    ? Color.FromArgb(255, 224, 158, 48)
                                    : (isAction ? Color.FromArgb(255, 138, 114, 76) : Color.FromArgb(255, 114, 114, 124));
                                using (GraphicsPath thp = RoundedRect(visualThumb, visualTrackW / 2))
                                using (SolidBrush thb = new SolidBrush(thumbCol))
                                {
                                    g.FillPath(thb, thp);
                                }
                            }
                        }
                        else
                        {
                            item.MaxScrollPx = 0;
                            item.ScrollOffsetPx = 0;
                        }

                        // Footer: Workspace + Open chat / Prev / Submit button
                        int bottomY = cardRect.Bottom - S(27);
                        if (hasQuestions)
                        {
                            int submitW = S(78);
                            int submitH = S(23);
                            item.SubmitButtonBounds = new Rectangle(cardRect.Right - submitW - S(12), bottomY - S(1), submitW, submitH);
                            bool canSubmit = CanAdvance(item);
                            bool submitHovered = canSubmit && _hoverSubmitIndex == idx;

                            g.SmoothingMode = SmoothingMode.AntiAlias;
                            using (GraphicsPath sp = RoundedRect(item.SubmitButtonBounds, S(6)))
                            using (SolidBrush sb = new SolidBrush(canSubmit ? (submitHovered ? Color.FromArgb(255, 255, 186, 66) : Color.FromArgb(255, 245, 166, 35)) : Color.FromArgb(255, 83, 75, 61)))
                            {
                                g.FillPath(sb, sp);
                            }

                            bool hasNextQuestion = (item.ActiveQuestionIndex < item.Questions.Count - 1);
                            string submitLabel = hasNextQuestion ? "Next \u2192" : "Submit";
                            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                            using (SolidBrush submitTextBrush = new SolidBrush(canSubmit ? Color.FromArgb(255, 22, 20, 16) : Color.FromArgb(255, 185, 176, 156)))
                            using (StringFormat sfCenter = new StringFormat())
                            {
                                sfCenter.Alignment = StringAlignment.Center;
                                sfCenter.LineAlignment = StringAlignment.Center;
                                g.DrawString(submitLabel, submitBtnFont, submitTextBrush, item.SubmitButtonBounds, sfCenter);
                            }

                            int rightLimitX = item.SubmitButtonBounds.Left - S(6);
                            if (item.ActiveQuestionIndex > 0)
                            {
                                int prevW = S(54);
                                item.PrevButtonBounds = new Rectangle(rightLimitX - prevW, bottomY - S(1), prevW, submitH);
                                bool prevHovered = (_hoverPrevIndex == idx);
                                g.SmoothingMode = SmoothingMode.AntiAlias;
                                using (GraphicsPath pp = RoundedRect(item.PrevButtonBounds, S(6)))
                                using (SolidBrush pb = new SolidBrush(prevHovered ? Color.FromArgb(255, 52, 52, 58) : Color.FromArgb(255, 38, 38, 44)))
                                {
                                    g.FillPath(pb, pp);
                                }
                                g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                                using (SolidBrush prevTextBrush = new SolidBrush(Color.FromArgb(255, 224, 224, 230)))
                                using (StringFormat sfPrev = new StringFormat())
                                {
                                    sfPrev.Alignment = StringAlignment.Center;
                                    sfPrev.LineAlignment = StringAlignment.Center;
                                    g.DrawString("\u2190 Prev", statusFont, prevTextBrush, item.PrevButtonBounds, sfPrev);
                                }
                                rightLimitX = item.PrevButtonBounds.Left - S(6);
                            }

                            int openBtnW = S(96);
                            item.OpenChatButtonBounds = new Rectangle(rightLimitX - openBtnW, bottomY - S(1), openBtnW, submitH);
                            bool openHovered = (_hoverOpenChatIndex == idx);
                            g.SmoothingMode = SmoothingMode.AntiAlias;
                            using (GraphicsPath obp = RoundedRect(item.OpenChatButtonBounds, S(6)))
                            using (SolidBrush obb = new SolidBrush(openHovered ? Color.FromArgb(255, 58, 56, 62) : Color.FromArgb(255, 38, 38, 44)))
                            using (Pen obpen = new Pen(openHovered ? Color.FromArgb(255, 160, 148, 124) : Color.FromArgb(255, 72, 70, 76), 1f))
                            {
                                g.FillPath(obb, obp);
                                g.DrawPath(obpen, obp);
                            }
                            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                            using (SolidBrush openTextBrush = new SolidBrush(openHovered ? Color.FromArgb(255, 255, 255, 255) : Color.FromArgb(255, 224, 224, 230)))
                            using (StringFormat sfOpen = new StringFormat())
                            {
                                sfOpen.Alignment = StringAlignment.Center;
                                sfOpen.LineAlignment = StringAlignment.Center;
                                g.DrawString("Open chat \u2197", statusFont, openTextBrush, item.OpenChatButtonBounds, sfOpen);
                            }
                            rightLimitX = item.OpenChatButtonBounds.Left - S(8);

                            using (SolidBrush wsBrush = new SolidBrush(cardHovered ? Color.FromArgb(255, 240, 240, 245) : Color.FromArgb(255, 188, 188, 198)))
                            using (StringFormat sfWs = new StringFormat())
                            {
                                sfWs.Trimming = StringTrimming.EllipsisCharacter;
                                sfWs.FormatFlags = StringFormatFlags.NoWrap;
                                sfWs.LineAlignment = StringAlignment.Center;
                                string leftInfo = item.Workspace ?? "Antigravity";
                                Rectangle wsRect = new Rectangle(cardRect.X + S(14), bottomY, Math.Max(S(50), rightLimitX - cardRect.X - S(14)), S(21));
                                g.DrawString(leftInfo, footerFont, wsBrush, wsRect, sfWs);
                            }
                        }
                        else
                        {
                            int stdBottomY = cardRect.Bottom - S(23);
                            Color ctaCol = isAction
                                ? (cardHovered ? Color.FromArgb(255, 255, 222, 158) : Color.FromArgb(255, 246, 193, 101))
                                : (cardHovered ? Color.FromArgb(255, 184, 222, 255) : Color.FromArgb(255, 144, 196, 248));
                            string ctaText = "Open chat \u2197";
                            using (SolidBrush wsBrush = new SolidBrush(Color.FromArgb(255, 204, 204, 210)))
                            using (SolidBrush actionBrush = new SolidBrush(ctaCol))
                            using (StringFormat sfWs = new StringFormat())
                            using (StringFormat sfAction = new StringFormat())
                            {
                                sfWs.Trimming = StringTrimming.EllipsisCharacter;
                                sfWs.FormatFlags = StringFormatFlags.NoWrap;
                                sfWs.LineAlignment = StringAlignment.Center;
                                Rectangle wsRect = new Rectangle(cardRect.X + S(14), stdBottomY, cardRect.Width - S(156), S(18));
                                g.DrawString(item.Workspace ?? "Antigravity", footerFont, wsBrush, wsRect, sfWs);

                                sfAction.Alignment = StringAlignment.Far;
                                sfAction.FormatFlags = StringFormatFlags.NoWrap;
                                sfAction.LineAlignment = StringAlignment.Center;
                                Rectangle actionRect = new Rectangle(cardRect.Right - S(138), stdBottomY, S(124), S(18));
                                item.OpenChatButtonBounds = actionRect;
                                g.DrawString(ctaText, footerFont, actionBrush, actionRect, sfAction);
                            }
                        }

                        curY += cardH + gap;
                    }
                }
            }

            EnsureOpaqueCardAlpha(bmp, opaqueRegions);
            if (_lastRenderedBitmap != null)
            {
                _lastRenderedBitmap.Dispose();
                _lastRenderedBitmap = null;
            }
            if (IsTestHost)
            {
                _lastRenderedBitmap = (Bitmap)bmp.Clone();
            }
            _lastLayeredRenderOk = ApplyLayeredBitmap(bmp, winX, winY);
        }

        if (!Visible || !NativeMethods.IsWindowVisible(Handle))
        {
            NativeMethods.ShowWindow(Handle, 4); // SW_SHOWNOACTIVATE
        }
        // SWP_NOACTIVATE | SWP_SHOWWINDOW = 0x0010 | 0x0040
        NativeMethods.SetWindowPos(Handle, new IntPtr(-1), winX, winY, winW, winH, 0x0010 | 0x0040);
    }

    private static void EnsureOpaqueCardAlpha(Bitmap bmp, List<Rectangle> regions)
    {
        if (regions == null || regions.Count == 0) return;
        Rectangle full = new Rectangle(0, 0, bmp.Width, bmp.Height);
        BitmapData data = bmp.LockBits(full, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        try
        {
            int stride = data.Stride;
            int totalBytes = Math.Abs(stride) * bmp.Height;
            byte[] buffer = new byte[totalBytes];
            Marshal.Copy(data.Scan0, buffer, 0, totalBytes);
            for (int rIdx = 0; rIdx < regions.Count; rIdx++)
            {
                Rectangle r = Rectangle.Intersect(full, regions[rIdx]);
                if (r.Width <= 0 || r.Height <= 0) continue;
                for (int y = r.Top; y < r.Bottom; y++)
                {
                    int rowOffset = y * stride;
                    int endX = r.Right;
                    for (int x = r.Left; x < endX; x++)
                    {
                        buffer[rowOffset + x * 4 + 3] = 255;
                    }
                }
            }
            Marshal.Copy(buffer, 0, data.Scan0, totalBytes);
        }
        finally
        {
            bmp.UnlockBits(data);
        }
    }

    private static void DrawUserLine(Graphics g, string text, Font font, Brush brush, float x, float y, StringFormat format)
    {
        int start = 0;
        for (int i = 0; i + 1 < text.Length; i++)
        {
            if (!char.IsSurrogatePair(text, i)) continue;
            if (i > start)
            {
                string prefix = text.Substring(start, i - start);
                g.DrawString(prefix, font, brush, new PointF(x, y), format);
                using (var measurement = new StringFormat(format))
                {
                    measurement.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces;
                    x += g.MeasureString(prefix, font, 4096, measurement).Width;
                }
            }
            int codePoint = char.ConvertToUtf32(text, i);
            using (var alternate = new Font(codePoint >= 0x20000 && codePoint < 0x32000 ? "SimSun-ExtB" : "Segoe UI Emoji",
                font.Size, FontStyle.Regular, GraphicsUnit.Pixel))
            {
                string glyph = text.Substring(i, 2);
                g.DrawString(glyph, alternate, brush, new PointF(x, y), format);
                x += g.MeasureString(glyph, alternate, 4096, format).Width;
            }
            start = i + 2;
            i++;
        }
        if (start < text.Length) g.DrawString(text.Substring(start), font, brush, new PointF(x, y), format);
    }

    private static List<string> WrapDetailLines(Graphics g, string text, Font font, int maxWidth)
    {
        var lines = new List<string>();
        if (string.IsNullOrEmpty(text) || maxWidth <= 10) return lines;
        using (var format = new StringFormat(StringFormat.GenericTypographic))
        {
            format.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces;
            foreach (string paragraph in text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
            {
                if (paragraph.Length == 0)
                {
                    lines.Add("");
                    continue;
                }
                string line = paragraph.Replace("\t", "    ");
                for (int start = 0; start < line.Length;)
                {
                    int low = start + 1;
                    int high = Math.Min(line.Length, start + Math.Max(16, maxWidth / 3));
                    while (high < line.Length && g.MeasureString(line.Substring(start, high - start), font, 4096, format).Width <= maxWidth)
                        high = Math.Min(line.Length, start + 2 * (high - start));
                    while (low < high)
                    {
                        int mid = low + (high - low + 1) / 2;
                        if (g.MeasureString(line.Substring(start, mid - start), font, 4096, format).Width <= maxWidth) low = mid;
                        else high = mid - 1;
                    }
                    int end = low;
                    if (end < line.Length && char.IsLowSurrogate(line[end]))
                        end = end - start > 1 ? end - 1 : end + 1;
                    if (end < line.Length)
                    {
                        int wordBreak = line.LastIndexOfAny(new[] { ' ', '\\', '/' }, end - 1, end - start);
                        if (wordBreak >= start + 8 && end - wordBreak <= 12) end = wordBreak + 1;
                    }
                    lines.Add(line.Substring(start, end - start));
                    start = end;
                }
            }
        }
        return lines;
    }

    private Font CreateUiFont(float logicalPixels, FontStyle style)
    {
        float pixelSize = Math.Max(10.0f, logicalPixels * _dpiScale);
        try
        {
            return new Font("Microsoft YaHei UI", pixelSize, style, GraphicsUnit.Pixel);
        }
        catch
        {
            using (Font sysFont = SystemFonts.MessageBoxFont)
            {
                return new Font(sysFont.FontFamily, pixelSize, style, GraphicsUnit.Pixel);
            }
        }
    }

    private void DrawShadow(Graphics g, Rectangle rect, int radius)
    {
        int[] spreads = new int[] { S(5), S(3), S(1) };
        int[] alphas = new int[] { 14, 24, 38 };
        for (int i = 0; i < spreads.Length; i++)
        {
            int sp = spreads[i];
            Rectangle sr = new Rectangle(rect.X - sp, rect.Y - sp + S(2), rect.Width + sp * 2, rect.Height + sp * 2);
            using (GraphicsPath path = RoundedRect(sr, radius + sp))
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(alphas[i], 0, 0, 0)))
            {
                g.FillPath(brush, path);
            }
        }
    }

    private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
    {
        GraphicsPath path = new GraphicsPath();
        int d = Math.Max(2, Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height)));
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private bool ApplyLayeredBitmap(Bitmap bitmap, int screenX, int screenY)
    {
        IntPtr screenDc = NativeMethods.GetDC(IntPtr.Zero);
        IntPtr memDc = NativeMethods.CreateCompatibleDC(screenDc);
        IntPtr hBitmap = IntPtr.Zero;
        IntPtr oldBitmap = IntPtr.Zero;
        try
        {
            hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
            oldBitmap = NativeMethods.SelectObject(memDc, hBitmap);
            NativeMethods.POINT topPos = new NativeMethods.POINT(screenX, screenY);
            NativeMethods.SIZE size = new NativeMethods.SIZE(bitmap.Width, bitmap.Height);
            NativeMethods.POINT srcPos = new NativeMethods.POINT(0, 0);
            NativeMethods.BLENDFUNCTION blend = new NativeMethods.BLENDFUNCTION();
            blend.BlendOp = 0; // AC_SRC_OVER
            blend.BlendFlags = 0;
            blend.SourceConstantAlpha = 255;
            blend.AlphaFormat = 1; // AC_SRC_ALPHA
            return NativeMethods.UpdateLayeredWindow(Handle, screenDc, ref topPos, ref size, memDc, ref srcPos, 0, ref blend, 2);
        }
        catch
        {
            return false;
        }
        finally
        {
            if (oldBitmap != IntPtr.Zero) NativeMethods.SelectObject(memDc, oldBitmap);
            if (hBitmap != IntPtr.Zero) NativeMethods.DeleteObject(hBitmap);
            if (memDc != IntPtr.Zero) NativeMethods.DeleteDC(memDc);
            if (screenDc != IntPtr.Zero) NativeMethods.ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    protected override void WndProc(ref Message m)
    {
        const int WM_MOUSEACTIVATE = 0x0021;
        const int MA_ACTIVATE = 1;
        const int MA_NOACTIVATE = 3;
        const int WM_DISPLAYCHANGE = 0x007E;
        const int WM_NCHITTEST = 0x0084;
        const int HTTRANSPARENT = -1;
        const int WM_MOUSEWHEEL = 0x020A;
        const int WM_DPICHANGED = 0x02E0;

        if (m.Msg == WM_DPICHANGED)
        {
            m.Result = IntPtr.Zero;
            if (_items.Count > 0) ScheduleDisplayRefresh();
            return;
        }
        if (m.Msg == WM_DISPLAYCHANGE)
        {
            if (_items.Count > 0) ScheduleDisplayRefresh();
        }
        if (m.Msg == WM_MOUSEACTIVATE)
        {
            Point screenPt = Cursor.Position;
            Point clientPt = new Point(screenPt.X - _currentScreenBounds.X, screenPt.Y - _currentScreenBounds.Y);
            m.Result = new IntPtr(IsCardJumpPoint(clientPt) ? MA_ACTIVATE : MA_NOACTIVATE);
            return;
        }
        if (m.Msg == WM_NCHITTEST)
        {
            long lp = m.LParam.ToInt64();
            int sx = (short)(lp & 0xFFFF);
            int sy = (short)((lp >> 16) & 0xFFFF);
            Point client = new Point(sx - _currentScreenBounds.X, sy - _currentScreenBounds.Y);
            if (!IsInteractivePoint(client))
            {
                m.Result = new IntPtr(HTTRANSPARENT);
                return;
            }
        }
        if (m.Msg == WM_MOUSEWHEEL)
        {
            long lp = m.LParam.ToInt64();
            int sx = (short)(lp & 0xFFFF);
            int sy = (short)((lp >> 16) & 0xFFFF);
            Point client = new Point(sx - _currentScreenBounds.X, sy - _currentScreenBounds.Y);
            int wheelDelta = (short)((m.WParam.ToInt64() >> 16) & 0xFFFF);
            if (HandleWheelAt(client, wheelDelta))
            {
                m.Result = IntPtr.Zero;
                return;
            }
        }
        base.WndProc(ref m);
    }

    private bool HandleWheelAt(Point clientPt, int wheelDelta)
    {
        if (wheelDelta == 0) return false;
        for (int i = _items.Count - 1; i >= 0; i--)
        {
            ToastItem item = _items[i];
            if (item.CardBounds.IsEmpty || !item.CardBounds.Contains(clientPt)) continue;
            if (item.MaxScrollPx > 0)
            {
                int step = (int)Math.Round((-wheelDelta / 120.0) * S(42));
                if (step == 0) step = wheelDelta > 0 ? -S(24) : S(24);
                int prev = item.ScrollOffsetPx;
                ScrollItemBy(item, step);
                if (item.ScrollOffsetPx != prev)
                {
                    RenderToasts();
                }
                return true;
            }
            return false;
        }
        return false;
    }

    private bool IsInteractivePoint(Point p)
    {
        if (!_dismissAllBounds.IsEmpty && _dismissAllBounds.Contains(p)) return true;
        for (int i = 0; i < _items.Count; i++)
        {
            if (!_items[i].CardBounds.IsEmpty && _items[i].CardBounds.Contains(p)) return true;
        }
        return false;
    }

    private static bool IsCardBodyJumpTarget(ToastItem item, Point p)
    {
        if (item == null || item.CardBounds.IsEmpty || !item.CardBounds.Contains(p)) return false;
        if (!item.CloseBounds.IsEmpty && item.CloseBounds.Contains(p)) return false;
        if (!item.ScrollTrackBounds.IsEmpty && item.ScrollTrackBounds.Contains(p)) return false;
        if (!item.OpenChatButtonBounds.IsEmpty && item.OpenChatButtonBounds.Contains(p)) return true;
        return item.Kind == "completed" && (item.Questions == null || item.Questions.Count == 0);
    }

    private bool IsCardJumpPoint(Point p)
    {
        return _items.Any(item => IsCardBodyJumpTarget(item, p));
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        _pressedSubmit = _items.Find(item => item.SubmitButtonBounds.Contains(e.Location));
        _pressedOpen = _items.Find(item => IsCardBodyJumpTarget(item, e.Location));
        _pressedClose = _items.Find(item => item.CloseBounds.Contains(e.Location));

        for (int i = _items.Count - 1; i >= 0; i--)
        {
            ToastItem item = _items[i];
            if (item.MaxScrollPx <= 0 || item.ScrollTrackBounds.IsEmpty) continue;
            if (item.ScrollTrackBounds.Contains(e.Location) || (!item.ScrollThumbBounds.IsEmpty && item.ScrollThumbBounds.Contains(e.Location)))
            {
                _dragScrollItem = item;
                if (!item.ScrollThumbBounds.IsEmpty && item.ScrollThumbBounds.Contains(e.Location))
                {
                    _dragScrollStartMouseY = e.Y;
                    _dragScrollStartOffset = item.ScrollOffsetPx;
                }
                else
                {
                    // Clicked on track above/below thumb -> jump to proportional position and allow continued dragging
                    int trackTop = item.ScrollTrackBounds.Top + S(5);
                    int trackH = Math.Max(1, item.ScrollTrackBounds.Height - S(10));
                    int thumbH = Math.Max(S(20), item.ScrollThumbBounds.Height);
                    int travel = Math.Max(1, trackH - thumbH);
                    double ratio = Math.Max(0.0, Math.Min(1.0, (double)(e.Y - trackTop - thumbH / 2) / travel));
                    item.ScrollOffsetPx = (int)Math.Round(ratio * item.MaxScrollPx);
                    _dragScrollStartMouseY = e.Y;
                    _dragScrollStartOffset = item.ScrollOffsetPx;
                }
                Capture = true;
                RenderToasts();
                return;
            }
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (_dragScrollItem != null && _items.Contains(_dragScrollItem))
        {
            ToastItem dragItem = _dragScrollItem;
            if (dragItem.MaxScrollPx > 0 && !dragItem.ScrollTrackBounds.IsEmpty)
            {
                int trackH = Math.Max(1, dragItem.ScrollTrackBounds.Height - S(10));
                int thumbH = Math.Max(S(20), dragItem.ScrollThumbBounds.Height);
                int travel = Math.Max(1, trackH - thumbH);
                int dy = e.Y - _dragScrollStartMouseY;
                int nextOffset = _dragScrollStartOffset + (int)Math.Round((double)dy * dragItem.MaxScrollPx / travel);
                if (nextOffset < 0) nextOffset = 0;
                if (nextOffset > dragItem.MaxScrollPx) nextOffset = dragItem.MaxScrollPx;
                if (nextOffset != dragItem.ScrollOffsetPx)
                {
                    dragItem.ScrollOffsetPx = nextOffset;
                    RenderToasts();
                }
            }
            return;
        }

        int nextCard = -1;
        int nextClose = -1;
        int nextOption = -1;
        int nextSubmit = -1;
        int nextPrev = -1;
        int nextOpenChat = -1;
        int nextScroll = -1;
        bool nextDismissAll = !_dismissAllBounds.IsEmpty && _dismissAllBounds.Contains(e.Location);

        if (!nextDismissAll)
        {
            for (int i = _items.Count - 1; i >= 0; i--)
            {
                ToastItem it = _items[i];
                if (!it.CardBounds.IsEmpty && it.CardBounds.Contains(e.Location))
                {
                    nextCard = i;
                    if (it.CloseBounds.Contains(e.Location))
                    {
                        nextClose = i;
                    }
                    else if (!it.ScrollTrackBounds.IsEmpty && it.ScrollTrackBounds.Contains(e.Location))
                    {
                        nextScroll = i;
                    }
                    else if (!it.SubmitButtonBounds.IsEmpty && it.SubmitButtonBounds.Contains(e.Location))
                    {
                        nextSubmit = i;
                    }
                    else if (!it.PrevButtonBounds.IsEmpty && it.PrevButtonBounds.Contains(e.Location))
                    {
                        nextPrev = i;
                    }
                    else if (!it.OpenChatButtonBounds.IsEmpty && it.OpenChatButtonBounds.Contains(e.Location))
                    {
                        nextOpenChat = i;
                    }
                    else
                    {
                        for (int optIdx = 0; optIdx < it.OptionBounds.Count; optIdx++)
                        {
                            if (!it.OptionBounds[optIdx].IsEmpty && it.OptionBounds[optIdx].Contains(e.Location))
                            {
                                nextOption = optIdx;
                                break;
                            }
                        }
                    }
                    break;
                }
            }
        }

        Cursor = (nextDismissAll || nextClose >= 0 || nextOption >= 0 || nextSubmit >= 0 || nextPrev >= 0 ||
            nextOpenChat >= 0 || nextScroll >= 0 ||
            (nextCard >= 0 && IsCardBodyJumpTarget(_items[nextCard], e.Location))) ? Cursors.Hand : Cursors.Default;
        if (nextCard != _hoverCardIndex ||
            nextClose != _hoverCloseIndex ||
            nextOption != _hoverOptionIndex ||
            nextSubmit != _hoverSubmitIndex ||
            nextPrev != _hoverPrevIndex ||
            nextOpenChat != _hoverOpenChatIndex ||
            nextScroll != _hoverScrollCardIndex ||
            nextDismissAll != _hoverDismissAll)
        {
            _hoverCardIndex = nextCard;
            _hoverCloseIndex = nextClose;
            _hoverOptionIndex = nextOption;
            _hoverSubmitIndex = nextSubmit;
            _hoverPrevIndex = nextPrev;
            _hoverOpenChatIndex = nextOpenChat;
            _hoverScrollCardIndex = nextScroll;
            _hoverDismissAll = nextDismissAll;
            RenderToasts();
        }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (_dragScrollItem != null) return;
        if (_hoverCardIndex != -1 || _hoverCloseIndex != -1 || _hoverOptionIndex != -1 ||
            _hoverSubmitIndex != -1 || _hoverPrevIndex != -1 || _hoverOpenChatIndex != -1 || _hoverScrollCardIndex != -1 || _hoverDismissAll)
        {
            ResetHover();
            RenderToasts();
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button != MouseButtons.Left) return;

        ToastItem pressedSubmit = _pressedSubmit;
        ToastItem pressedOpen = _pressedOpen;
        ToastItem pressedClose = _pressedClose;
        _pressedSubmit = _pressedOpen = _pressedClose = null;
        if (_dragScrollItem != null)
        {
            _dragScrollItem = null;
            Capture = false;
            RenderToasts();
            return;
        }

        if (!_dismissAllBounds.IsEmpty && _dismissAllBounds.Contains(e.Location))
        {
            DismissAllItems();
            return;
        }

        foreach (ToastItem item in _items)
        {
            if (!item.CardBounds.Contains(e.Location)) continue;
            if (item == pressedClose && item.CloseBounds.Contains(e.Location))
            {
                DismissItem(item);
                RenderToasts();
                return;
            }
            if (item == pressedOpen && IsCardBodyJumpTarget(item, e.Location))
            {
                if (item.Kind == "completed") RemoveConversation(item.ConversationId, true);
                OpenConversation(item.ConversationId);
                RenderToasts();
                return;
            }
            if (item.Submission != null || item.Questions.Count == 0 || item.ScrollTrackBounds.Contains(e.Location))
                return;
            for (int i = 0; i < item.OptionBounds.Count; i++)
            {
                if (!item.OptionBounds[i].Contains(e.Location)) continue;
                ToggleQuestionOption(item.Questions[item.ActiveQuestionIndex], i);
                item.SubmitStatus = "";
                RenderToasts();
                return;
            }
            if (item.PrevButtonBounds.Contains(e.Location) && item.ActiveQuestionIndex > 0)
            {
                item.ActiveQuestionIndex--;
                item.ScrollOffsetPx = 0;
                RenderToasts();
                return;
            }
            if (item == pressedSubmit && item.SubmitButtonBounds.Contains(e.Location) && CanAdvance(item))
            {
                if (item.ActiveQuestionIndex < item.Questions.Count - 1)
                {
                    item.ActiveQuestionIndex++;
                    item.ScrollOffsetPx = 0;
                }
                else
                {
                    StartSubmission(item);
                }
                ResetHover();
                RenderToasts();
            }
            return;
        }
    }
}

internal static class NativeMethods
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct POINT
    {
        public int X;
        public int Y;
        public POINT(int x, int y) { X = x; Y = y; }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SIZE
    {
        public int Width;
        public int Height;
        public SIZE(int w, int h) { Width = w; Height = h; }
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    internal struct BLENDFUNCTION
    {
        public byte BlendOp;
        public byte BlendFlags;
        public byte SourceConstantAlpha;
        public byte AlphaFormat;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    internal struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    internal delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("shcore.dll")]
    internal static extern int SetProcessDpiAwareness(int value);

    [DllImport("shcore.dll")]
    internal static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    [DllImport("user32.dll")]
    internal static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    internal static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    internal static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetClassName(IntPtr hWnd, StringBuilder className, int length);

    [DllImport("user32.dll")]
    internal static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    internal static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    internal static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    internal static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

    [DllImport("user32.dll")]
    internal static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll")]
    internal static extern IntPtr MonitorFromRect(ref RECT lprc, uint dwFlags);

    [DllImport("user32.dll")]
    internal static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    internal static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    internal static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    internal static extern IntPtr CreateCompatibleDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    internal static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    internal static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);

    [DllImport("gdi32.dll")]
    internal static extern bool DeleteObject(IntPtr hObject);

    [DllImport("gdi32.dll")]
    internal static extern int GetDeviceCaps(IntPtr hdc, int nIndex);

    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
    internal static extern bool UpdateLayeredWindow(
        IntPtr hwnd,
        IntPtr hdcDst,
        ref POINT pptDst,
        ref SIZE psize,
        IntPtr hdcSrc,
        ref POINT pptSrc,
        uint crKey,
        ref BLENDFUNCTION pblend,
        uint dwFlags);

    [DllImport("user32.dll")]
    internal static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    internal static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    internal static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    internal static extern IntPtr GetThreadDesktop(uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);

    [DllImport("user32.dll")]
    internal static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    internal static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    internal static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    internal static extern bool AllowSetForegroundWindow(int dwProcessId);

    [DllImport("user32.dll")]
    internal static extern bool IsIconic(IntPtr hWnd);
}
