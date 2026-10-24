using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace QuickMemo
{
    public enum DockEdge
    {
        None,
        Left,
        Right,
        Top
    }

    /// <summary>
    /// 绘制 macOS 风格流光渐变圆角图标（便签折页 + AI 四角星芒）
    /// </summary>
    public static class AppIconRenderer
    {
        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        public static Bitmap RenderIconBitmap(int size)
        {
            var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.Transparent);

                float pad = size * 0.06f;
                float boxSize = size - pad * 2f;
                float radius = boxSize * 0.24f;
                RectangleF rect = new RectangleF(pad, pad, boxSize, boxSize);

                // 1. macOS 风格流光渐变底板 (靛紫 -> 科技蓝 -> 冰川青)
                using (GraphicsPath bgPath = CreateRoundedRectPath(rect, radius))
                {
                    using (var bgBrush = new LinearGradientBrush(
                        new PointF(rect.Left, rect.Top),
                        new PointF(rect.Right, rect.Bottom),
                        Color.FromArgb(255, 99, 102, 241), // #6366F1
                        Color.FromArgb(255, 6, 182, 212))) // #06B6D4
                    {
                        var blend = new ColorBlend(3)
                        {
                            Colors = new[]
                            {
                                Color.FromArgb(255, 99, 102, 241),
                                Color.FromArgb(255, 37, 99, 235),
                                Color.FromArgb(255, 6, 182, 212)
                            },
                            Positions = new[] { 0f, 0.52f, 1f }
                        };
                        bgBrush.InterpolationColors = blend;
                        g.FillPath(bgBrush, bgPath);
                    }

                    // 顶部柔光玻璃折射层
                    RectangleF glossRect = new RectangleF(rect.Left, rect.Top, rect.Width, rect.Height * 0.55f);
                    using (var glossBrush = new LinearGradientBrush(
                        glossRect,
                        Color.FromArgb(75, 255, 255, 255),
                        Color.FromArgb(0, 255, 255, 255),
                        LinearGradientMode.Vertical))
                    {
                        g.SetClip(bgPath);
                        g.FillEllipse(glossBrush, rect.Left - rect.Width * 0.2f, rect.Top - rect.Height * 0.35f, rect.Width * 1.4f, rect.Height * 0.9f);
                        g.ResetClip();
                    }

                    // 镜面内高光边框
                    using (var borderPen = new Pen(Color.FromArgb(115, 255, 255, 255), Math.Max(1f, size * 0.022f)))
                    {
                        g.DrawPath(borderPen, bgPath);
                    }
                }

                // 2. 中心悬浮磨砂白便签卡片
                float cardW = boxSize * 0.54f;
                float cardH = boxSize * 0.60f;
                float cardX = pad + (boxSize - cardW) * 0.44f;
                float cardY = pad + (boxSize - cardH) * 0.52f;
                float cardRadius = cardW * 0.18f;
                RectangleF cardRect = new RectangleF(cardX, cardY, cardW, cardH);

                // 卡片柔和投影
                RectangleF shadowRect = new RectangleF(cardX + size * 0.015f, cardY + size * 0.03f, cardW, cardH);
                using (GraphicsPath shadowPath = CreateRoundedRectPath(shadowRect, cardRadius))
                using (var shadowBrush = new SolidBrush(Color.FromArgb(55, 15, 23, 42)))
                {
                    g.FillPath(shadowBrush, shadowPath);
                }

                // 卡片本体
                using (GraphicsPath cardPath = CreateRoundedRectPath(cardRect, cardRadius))
                using (var cardBrush = new LinearGradientBrush(
                    cardRect,
                    Color.FromArgb(250, 255, 255, 255),
                    Color.FromArgb(230, 241, 245, 249),
                    LinearGradientMode.Vertical))
                {
                    g.FillPath(cardBrush, cardPath);
                }

                // 卡片上的三行精致分类笔记横线
                float lineLeft = cardX + cardW * 0.20f;
                float lineThickness = Math.Max(1.5f, size * 0.048f);
                using (var linePen1 = new Pen(Color.FromArgb(235, 59, 130, 246), lineThickness) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                using (var linePen2 = new Pen(Color.FromArgb(180, 99, 102, 241), lineThickness) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                using (var linePen3 = new Pen(Color.FromArgb(140, 148, 163, 184), lineThickness) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                {
                    float y1 = cardY + cardH * 0.30f;
                    float y2 = cardY + cardH * 0.52f;
                    float y3 = cardY + cardH * 0.74f;
                    g.DrawLine(linePen1, lineLeft, y1, cardX + cardW * 0.78f, y1);
                    g.DrawLine(linePen2, lineLeft, y2, cardX + cardW * 0.68f, y2);
                    g.DrawLine(linePen3, lineLeft, y3, cardX + cardW * 0.52f, y3);
                }

                // 3. 右上角璀璨 AI 四角星芒 (Sparkle)
                float starCx = pad + boxSize * 0.74f;
                float starCy = pad + boxSize * 0.27f;
                float starR = boxSize * 0.21f;
                using (GraphicsPath starPath = CreateFourPointStarPath(starCx, starCy, starR, starR * 0.28f))
                using (var starBrush = new LinearGradientBrush(
                    new RectangleF(starCx - starR, starCy - starR, starR * 2, starR * 2),
                    Color.FromArgb(255, 255, 251, 235),
                    Color.FromArgb(255, 251, 191, 36),
                    LinearGradientMode.ForwardDiagonal))
                {
                    g.FillPath(starBrush, starPath);
                    using (var starPen = new Pen(Color.FromArgb(220, 255, 255, 255), Math.Max(1f, size * 0.015f)))
                    {
                        g.DrawPath(starPen, starPath);
                    }
                }
            }
            return bmp;
        }

        public static Icon CreateRuntimeIcon(int size)
        {
            using (Bitmap bmp = RenderIconBitmap(size))
            {
                IntPtr hIcon = bmp.GetHicon();
                using (Icon temp = Icon.FromHandle(hIcon))
                {
                    Icon cloned = (Icon)temp.Clone();
                    DestroyIcon(hIcon);
                    return cloned;
                }
            }
        }

        public static void SaveIconFiles(string pngPath, string icoPath)
        {
            using (Bitmap bmp256 = RenderIconBitmap(256))
            {
                bmp256.Save(pngPath, ImageFormat.Png);
            }

            // 生成包含 256, 64, 32, 16 的多分辨率标准 ICO
            int[] sizes = new[] { 256, 64, 32, 16 };
            byte[][] pngBuffers = new byte[sizes.Length][];
            for (int i = 0; i < sizes.Length; i++)
            {
                using (Bitmap b = RenderIconBitmap(sizes[i]))
                using (var ms = new MemoryStream())
                {
                    b.Save(ms, ImageFormat.Png);
                    pngBuffers[i] = ms.ToArray();
                }
            }

            using (var fs = new FileStream(icoPath, FileMode.Create, FileAccess.Write))
            using (var bw = new BinaryWriter(fs))
            {
                bw.Write((ushort)0); // Reserved
                bw.Write((ushort)1); // Type: ICO
                bw.Write((ushort)sizes.Length); // Count

                int offset = 6 + 16 * sizes.Length;
                for (int i = 0; i < sizes.Length; i++)
                {
                    int s = sizes[i];
                    bw.Write((byte)(s >= 256 ? 0 : s));
                    bw.Write((byte)(s >= 256 ? 0 : s));
                    bw.Write((byte)0);
                    bw.Write((byte)0);
                    bw.Write((ushort)1);
                    bw.Write((ushort)32);
                    bw.Write((uint)pngBuffers[i].Length);
                    bw.Write((uint)offset);
                    offset += pngBuffers[i].Length;
                }

                for (int i = 0; i < sizes.Length; i++)
                {
                    bw.Write(pngBuffers[i]);
                }
            }
        }

        public static GraphicsPath CreateRoundedRectPath(RectangleF rect, float radius)
        {
            float d = Math.Min(radius * 2f, Math.Min(rect.Width, rect.Height));
            var path = new GraphicsPath();
            path.AddArc(rect.Left, rect.Top, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Top, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.Left, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        public static GraphicsPath CreateFourPointStarPath(float cx, float cy, float outerR, float innerR)
        {
            var pts = new PointF[8];
            for (int i = 0; i < 8; i++)
            {
                double angle = i * Math.PI / 4.0 - Math.PI / 2.0;
                float r = (i % 2 == 0) ? outerR : innerR;
                pts[i] = new PointF(
                    cx + (float)(Math.Cos(angle) * r),
                    cy + (float)(Math.Sin(angle) * r)
                );
            }
            var path = new GraphicsPath();
            path.AddPolygon(pts);
            return path;
        }
    }

    public class QuickMemoAppContext : ApplicationContext
    {
        #region Win32 API

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;

            public int Width { get { return Right - Left; } }
            public int Height { get { return Bottom - Top; } }
            public Rectangle ToRectangle() { return new Rectangle(Left, Top, Width, Height); }
        }

        private const int HOTKEY_ID_TOGGLE = 9001;
        private const uint MOD_ALT = 0x0001;
        private const uint VK_SPACE = 0x20;
        private const int VK_LBUTTON = 0x01;
        private const byte VK_MENU = 0x12;
        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;

        private const int SW_HIDE = 0;
        private const int SW_SHOW = 5;
        private const int SW_RESTORE = 9;

        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_SHOWWINDOW = 0x0040;

        #endregion

        private readonly string _appRoot;
        private readonly string _appUrl = "http://127.0.0.1:1420";
        private readonly string _cmdFilePath;
        private Process _nodeServerProcess;
        private NotifyIcon _trayIcon;
        private HotKeyMessageWindow _hotKeyWindow;
        private System.Windows.Forms.Timer _monitorTimer;
        private EdgePeekForm _edgePeekForm;

        private IntPtr _targetHwnd = IntPtr.Zero;
        private bool _hiddenToTray = false;
        private bool _hasShownCloseTip = false;
        private bool _wasWindowAlive = false;

        private DockEdge _dockEdge = DockEdge.None;
        private bool _isCollapsedOutside = false;
        private Rectangle _expandedBounds = new Rectangle(200, 120, 1060, 720);
        private DateTime _mouseLeftTime = DateTime.MinValue;

        public QuickMemoAppContext(string appRoot)
        {
            _appRoot = appRoot;
            _cmdFilePath = Path.Combine(_appRoot, ".window-cmd.json");
            if (File.Exists(_cmdFilePath))
            {
                try { File.Delete(_cmdFilePath); } catch { }
            }

            // 同步更新本地图标文件
            try
            {
                string iconDir = Path.Combine(_appRoot, "src-tauri", "icons");
                if (!Directory.Exists(iconDir)) Directory.CreateDirectory(iconDir);
                AppIconRenderer.SaveIconFiles(
                    Path.Combine(iconDir, "icon.png"),
                    Path.Combine(iconDir, "icon.ico")
                );
            }
            catch { }

            EnsureBackendRunning();
            SetupTrayIcon();
            SetupEdgePeekForm();
            SetupGlobalHotKey();
            OpenOrActivateWindow();

            _monitorTimer = new System.Windows.Forms.Timer { Interval = 80 };
            _monitorTimer.Tick += OnMonitorTick;
            _monitorTimer.Start();
        }

        private bool IsPortOpen(int port)
        {
            try
            {
                using (var client = new TcpClient())
                {
                    var result = client.BeginConnect("127.0.0.1", port, null, null);
                    var success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(200));
                    if (!success) return false;
                    client.EndConnect(result);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private void EnsureBackendRunning()
        {
            if (IsPortOpen(1420)) return;

            string scriptPath = Path.Combine(_appRoot, "server", "standalone.js");
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "\"" + scriptPath + "\"",
                WorkingDirectory = _appRoot,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            try
            {
                _nodeServerProcess = Process.Start(psi);
                for (int i = 0; i < 30; i++)
                {
                    if (IsPortOpen(1420)) break;
                    Thread.Sleep(80);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "启动本地服务失败，请确认已安装 Node.js：\n" + ex.Message,
                    "QuickMemo 启动错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private void SetupTrayIcon()
        {
            Icon icon;
            try
            {
                icon = AppIconRenderer.CreateRuntimeIcon(32);
            }
            catch
            {
                icon = SystemIcons.Application;
            }

            var menu = new ContextMenuStrip();

            var openItem = new ToolStripMenuItem("✦ 显示 / 隐藏主窗口 (Alt+Space)");
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            openItem.Click += (s, e) => ToggleWindowByShortcut();

            var dockRightItem = new ToolStripMenuItem("⇥ 缩到屏幕右侧边缘 (苹果磨砂悬浮条)");
            dockRightItem.Click += (s, e) => DockWindowToRightEdgeAndCollapse();

            var undockItem = new ToolStripMenuItem("🗔 恢复居中普通窗口");
            undockItem.Click += (s, e) => RestoreCenterNormalWindow();

            var vaultItem = new ToolStripMenuItem("📂 打开本地 Markdown 文件夹");
            vaultItem.Click += (s, e) => OpenVaultFolder();

            var exitItem = new ToolStripMenuItem("❌ 彻底退出程序");
            exitItem.Click += (s, e) => ExitApplication();

            menu.Items.Add(openItem);
            menu.Items.Add(dockRightItem);
            menu.Items.Add(undockItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(vaultItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            _trayIcon = new NotifyIcon
            {
                Icon = icon,
                Text = "QuickMemo · 闪念收纳盒 (Alt+Space)",
                ContextMenuStrip = menu,
                Visible = true
            };

            _trayIcon.DoubleClick += (s, e) => OpenOrActivateWindow();
        }

        private void SetupEdgePeekForm()
        {
            _edgePeekForm = new EdgePeekForm();
            _edgePeekForm.MouseEnterTrigger += (s, e) => ExpandFromOutside(true);
            _edgePeekForm.ClickTrigger += (s, e) => ExpandFromOutside(true);
        }

        private void SetupGlobalHotKey()
        {
            _hotKeyWindow = new HotKeyMessageWindow(this);
            RegisterHotKey(_hotKeyWindow.Handle, HOTKEY_ID_TOGGLE, MOD_ALT, VK_SPACE);
        }

        private IntPtr FindQuickMemoWindow()
        {
            if (_targetHwnd != IntPtr.Zero && IsWindow(_targetHwnd))
            {
                return _targetHwnd;
            }

            IntPtr found = IntPtr.Zero;
            EnumWindows((hWnd, lParam) =>
            {
                var sb = new System.Text.StringBuilder(256);
                if (GetWindowText(hWnd, sb, sb.Capacity) > 0)
                {
                    string title = sb.ToString();
                    if (title.Contains("QuickMemo · 闪念") || title.StartsWith("QuickMemo"))
                    {
                        var cls = new System.Text.StringBuilder(128);
                        GetClassName(hWnd, cls, cls.Capacity);
                        string clsName = cls.ToString();
                        if (clsName.Contains("Chrome_WidgetWin"))
                        {
                            found = hWnd;
                            return false;
                        }
                    }
                }
                return true;
            }, IntPtr.Zero);

            if (found != IntPtr.Zero)
            {
                _targetHwnd = found;
                _wasWindowAlive = true;
            }
            return found;
        }

        private void ForceForeground(IntPtr hwnd)
        {
            try
            {
                if (IsIconic(hwnd))
                {
                    ShowWindow(hwnd, SW_RESTORE);
                }
                else
                {
                    ShowWindow(hwnd, SW_SHOW);
                }

                keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero);
                SetForegroundWindow(hwnd);
                keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero);
            }
            catch { }
        }

        public void ToggleWindowByShortcut()
        {
            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero)
            {
                OpenOrActivateWindow();
                return;
            }

            if (_hiddenToTray || !IsWindowVisible(hwnd) || IsIconic(hwnd))
            {
                _hiddenToTray = false;
                if (_dockEdge != DockEdge.None)
                {
                    ExpandFromOutside(true);
                }
                else
                {
                    ForceForeground(hwnd);
                }
                return;
            }

            if (_isCollapsedOutside)
            {
                ExpandFromOutside(true);
                return;
            }

            IntPtr fg = GetForegroundWindow();
            if (fg == hwnd)
            {
                if (_dockEdge != DockEdge.None)
                {
                    CollapseToOutside();
                }
                else
                {
                    HideWindowToTray();
                }
            }
            else
            {
                ForceForeground(hwnd);
            }
        }

        public void OpenOrActivateWindow()
        {
            EnsureBackendRunning();
            _hiddenToTray = false;

            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd != IntPtr.Zero)
            {
                if (_isCollapsedOutside)
                {
                    ExpandFromOutside(true);
                }
                else
                {
                    ForceForeground(hwnd);
                }
                return;
            }

            string profileDir = Path.Combine(_appRoot, ".webview-profile");
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "msedge.exe",
                    Arguments = "--app=\"" + _appUrl + "\" --user-data-dir=\"" + profileDir + "\" --window-size=1060,720",
                    UseShellExecute = true
                };
                Process.Start(psi);
            }
            catch
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = _appUrl,
                    UseShellExecute = true
                });
            }
        }

        public void HideWindowToTray()
        {
            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd != IntPtr.Zero && IsWindow(hwnd))
            {
                ShowWindow(hwnd, SW_HIDE);
                _hiddenToTray = true;
                _edgePeekForm.Hide();
            }
        }

        public void DockWindowToRightEdgeAndCollapse()
        {
            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero)
            {
                OpenOrActivateWindow();
                return;
            }

            _hiddenToTray = false;
            ShowWindow(hwnd, SW_SHOW);

            RECT r;
            if (GetWindowRect(hwnd, out r))
            {
                Screen scr = Screen.FromHandle(hwnd);
                int w = Math.Min(Math.Max(r.Width, 520), 920);
                int h = Math.Min(Math.Max(r.Height, 540), scr.WorkingArea.Height - 40);
                int x = scr.WorkingArea.Right - w;
                int y = Math.Max(scr.WorkingArea.Top + 20, Math.Min(r.Top, scr.WorkingArea.Bottom - h - 20));
                _expandedBounds = new Rectangle(x, y, w, h);
                _dockEdge = DockEdge.Right;
                CollapseToOutside();
            }
        }

        public void RestoreCenterNormalWindow()
        {
            _dockEdge = DockEdge.None;
            _isCollapsedOutside = false;
            _hiddenToTray = false;
            _edgePeekForm.Hide();

            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero)
            {
                OpenOrActivateWindow();
                return;
            }

            Screen scr = Screen.PrimaryScreen;
            int w = 1060;
            int h = 720;
            int x = scr.WorkingArea.Left + (scr.WorkingArea.Width - w) / 2;
            int y = scr.WorkingArea.Top + (scr.WorkingArea.Height - h) / 2;

            SetWindowPos(hwnd, HWND_NOTOPMOST, x, y, w, h, SWP_SHOWWINDOW);
            ForceForeground(hwnd);
        }

        private void CollapseToOutside()
        {
            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero || _dockEdge == DockEdge.None) return;

            Screen scr = Screen.FromRectangle(_expandedBounds);
            Rectangle work = scr.Bounds;
            int targetX = _expandedBounds.X;
            int targetY = _expandedBounds.Y;

            if (_dockEdge == DockEdge.Right)
            {
                targetX = work.Right - 1;
            }
            else if (_dockEdge == DockEdge.Left)
            {
                targetX = work.Left - _expandedBounds.Width + 1;
            }
            else if (_dockEdge == DockEdge.Top)
            {
                targetY = work.Top - _expandedBounds.Height + 1;
            }

            SetWindowPos(hwnd, HWND_TOPMOST, targetX, targetY, _expandedBounds.Width, _expandedBounds.Height, SWP_NOACTIVATE);
            _isCollapsedOutside = true;

            _edgePeekForm.ShowAtEdge(_dockEdge, scr.WorkingArea, _expandedBounds);
        }

        private void ExpandFromOutside(bool activateFocus)
        {
            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero) return;

            _edgePeekForm.Hide();
            _isCollapsedOutside = false;
            _mouseLeftTime = DateTime.MinValue;

            Screen scr = Screen.FromRectangle(_expandedBounds);
            Rectangle work = scr.WorkingArea;
            int targetX = _expandedBounds.X;
            int targetY = _expandedBounds.Y;

            if (_dockEdge == DockEdge.Right)
            {
                targetX = work.Right - _expandedBounds.Width;
            }
            else if (_dockEdge == DockEdge.Left)
            {
                targetX = work.Left;
            }
            else if (_dockEdge == DockEdge.Top)
            {
                targetY = work.Top;
            }

            _expandedBounds.X = targetX;
            _expandedBounds.Y = targetY;

            SetWindowPos(hwnd, HWND_TOPMOST, targetX, targetY, _expandedBounds.Width, _expandedBounds.Height, SWP_SHOWWINDOW);
            if (activateFocus)
            {
                ForceForeground(hwnd);
            }
        }

        private void OnMonitorTick(object sender, EventArgs e)
        {
            CheckWindowCommandFile();

            IntPtr hwnd = FindQuickMemoWindow();
            if (hwnd == IntPtr.Zero)
            {
                if (_wasWindowAlive)
                {
                    _wasWindowAlive = false;
                    _targetHwnd = IntPtr.Zero;
                    _isCollapsedOutside = false;
                    _edgePeekForm.Hide();

                    if (!_hasShownCloseTip)
                    {
                        _hasShownCloseTip = true;
                        _trayIcon.ShowBalloonTip(
                            2500,
                            "QuickMemo 仍在后台运行",
                            "按 Alt + Space 可随时呼出窗口，或右键托盘图标操作。",
                            ToolTipIcon.Info
                        );
                    }
                }
                return;
            }

            if (_hiddenToTray || !IsWindowVisible(hwnd) || IsIconic(hwnd))
            {
                return;
            }

            bool isMouseDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
            Point cursor = Cursor.Position;

            if (_isCollapsedOutside)
            {
                Screen scr = Screen.FromRectangle(_expandedBounds);
                Rectangle work = scr.Bounds;
                bool hitEdge = false;

                if (_dockEdge == DockEdge.Right && cursor.X >= work.Right - 4 &&
                    cursor.Y >= _expandedBounds.Top && cursor.Y <= _expandedBounds.Bottom)
                {
                    hitEdge = true;
                }
                else if (_dockEdge == DockEdge.Left && cursor.X <= work.Left + 4 &&
                         cursor.Y >= _expandedBounds.Top && cursor.Y <= _expandedBounds.Bottom)
                {
                    hitEdge = true;
                }
                else if (_dockEdge == DockEdge.Top && cursor.Y <= work.Top + 4 &&
                         cursor.X >= _expandedBounds.Left && cursor.X <= _expandedBounds.Right)
                {
                    hitEdge = true;
                }

                if (hitEdge)
                {
                    ExpandFromOutside(true);
                }
                return;
            }

            RECT rect;
            if (!GetWindowRect(hwnd, out rect)) return;
            Rectangle winRect = rect.ToRectangle();
            Screen currentScreen = Screen.FromRectangle(winRect);
            Rectangle screenBounds = currentScreen.WorkingArea;

            if (!isMouseDown)
            {
                const int snapThreshold = 18;
                const int unsnapThreshold = 36;

                if (Math.Abs(winRect.Right - screenBounds.Right) <= snapThreshold || winRect.Right > screenBounds.Right)
                {
                    _dockEdge = DockEdge.Right;
                    _expandedBounds = new Rectangle(screenBounds.Right - winRect.Width, winRect.Top, winRect.Width, winRect.Height);
                }
                else if (Math.Abs(winRect.Left - screenBounds.Left) <= snapThreshold || winRect.Left < screenBounds.Left)
                {
                    _dockEdge = DockEdge.Left;
                    _expandedBounds = new Rectangle(screenBounds.Left, winRect.Top, winRect.Width, winRect.Height);
                }
                else if (Math.Abs(winRect.Top - screenBounds.Top) <= snapThreshold || winRect.Top < screenBounds.Top)
                {
                    _dockEdge = DockEdge.Top;
                    _expandedBounds = new Rectangle(winRect.Left, screenBounds.Top, winRect.Width, winRect.Height);
                }
                else if (_dockEdge != DockEdge.None)
                {
                    bool farFromRight = Math.Abs(winRect.Right - screenBounds.Right) > unsnapThreshold;
                    bool farFromLeft = Math.Abs(winRect.Left - screenBounds.Left) > unsnapThreshold;
                    bool farFromTop = Math.Abs(winRect.Top - screenBounds.Top) > unsnapThreshold;
                    if (farFromRight && farFromLeft && farFromTop)
                    {
                        _dockEdge = DockEdge.None;
                        SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | 0x0002);
                    }
                }
            }

            if (_dockEdge != DockEdge.None && !isMouseDown)
            {
                Rectangle inflated = Rectangle.Inflate(winRect, 12, 12);
                if (!inflated.Contains(cursor))
                {
                    if (_mouseLeftTime == DateTime.MinValue)
                    {
                        _mouseLeftTime = DateTime.Now;
                    }
                    else if ((DateTime.Now - _mouseLeftTime).TotalMilliseconds >= 450)
                    {
                        CollapseToOutside();
                    }
                }
                else
                {
                    _mouseLeftTime = DateTime.MinValue;
                }
            }
        }

        private void CheckWindowCommandFile()
        {
            if (!File.Exists(_cmdFilePath)) return;
            try
            {
                string raw = File.ReadAllText(_cmdFilePath);
                File.Delete(_cmdFilePath);
                if (raw.Contains("\"hide\""))
                {
                    HideWindowToTray();
                }
                else if (raw.Contains("\"dock-right\""))
                {
                    DockWindowToRightEdgeAndCollapse();
                }
                else if (raw.Contains("\"restore\""))
                {
                    RestoreCenterNormalWindow();
                }
            }
            catch { }
        }

        private void OpenVaultFolder()
        {
            string vaultDir = Path.Combine(_appRoot, "vault");
            if (!Directory.Exists(vaultDir))
            {
                Directory.CreateDirectory(vaultDir);
            }
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = "\"" + vaultDir + "\"",
                UseShellExecute = true
            });
        }

        public void ExitApplication()
        {
            _monitorTimer.Stop();
            try
            {
                if (_hotKeyWindow != null)
                {
                    UnregisterHotKey(_hotKeyWindow.Handle, HOTKEY_ID_TOGGLE);
                    _hotKeyWindow.DestroyHandle();
                }
            }
            catch { }

            try
            {
                if (_edgePeekForm != null)
                {
                    _edgePeekForm.Close();
                }
            }
            catch { }

            try
            {
                if (_trayIcon != null)
                {
                    _trayIcon.Visible = false;
                    _trayIcon.Dispose();
                }
            }
            catch { }

            try
            {
                IntPtr hwnd = FindQuickMemoWindow();
                if (hwnd != IntPtr.Zero && _isCollapsedOutside)
                {
                    ExpandFromOutside(false);
                }
            }
            catch { }

            try
            {
                if (_nodeServerProcess != null && !_nodeServerProcess.HasExited)
                {
                    _nodeServerProcess.Kill();
                }
            }
            catch { }

            Application.Exit();
        }

        private class HotKeyMessageWindow : NativeWindow
        {
            private const int WM_HOTKEY = 0x0312;
            private readonly QuickMemoAppContext _ctx;

            public HotKeyMessageWindow(QuickMemoAppContext ctx)
            {
                _ctx = ctx;
                CreateHandle(new CreateParams());
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_HOTKEY)
                {
                    _ctx.ToggleWindowByShortcut();
                }
                base.WndProc(ref m);
            }
        }
    }

    /// <summary>
    /// 苹果 macOS / iPadOS 风格透明磨砂毛玻璃侧边悬浮胶囊 (Frosted Acrylic Glass Pill)
    /// 结合 Windows DWM SetWindowCompositionAttribute 实时背景高斯模糊 + GDI+ 镜面高光内边框渲染
    /// </summary>
    public class EdgePeekForm : Form
    {
        #region DWM Frosted Acrylic Glass Interop

        [DllImport("user32.dll")]
        private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        [StructLayout(LayoutKind.Sequential)]
        private struct AccentPolicy
        {
            public int AccentState;
            public int AccentFlags;
            public uint GradientColor;
            public int AnimationId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WindowCompositionAttributeData
        {
            public int Attribute;
            public IntPtr Data;
            public int SizeOfData;
        }

        private const int WCA_ACCENT_POLICY = 19;
        private const int ACCENT_ENABLE_BLURBEHIND = 3;
        private const int ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;
        private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        private const int DWMWCP_ROUND = 2;

        #endregion

        public event EventHandler MouseEnterTrigger;
        public event EventHandler ClickTrigger;

        private DockEdge _currentEdge = DockEdge.Right;

        public EdgePeekForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            // 使用纯黑底配合 DWM Acrylic 透明通道合成，让背后桌面呈现真实高斯模糊磨砂感
            BackColor = Color.Black;
            Width = 28;
            Height = 108;
            Cursor = Cursors.Hand;
            DoubleBuffered = true;

            MouseEnter += (s, e) =>
            {
                if (MouseEnterTrigger != null) MouseEnterTrigger(this, EventArgs.Empty);
            };
            Click += (s, e) =>
            {
                if (ClickTrigger != null) ClickTrigger(this, EventArgs.Empty);
            };
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
                // WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOREDIRECTIONBITMAP compatible
                cp.ExStyle |= 0x00000080;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            EnableAppleFrostedBlur();
        }

        private void EnableAppleFrostedBlur()
        {
            try
            {
                // 1. 启用 Windows 11 硬件抗锯齿圆角 (DWMWCP_ROUND)
                int cornerPref = DWMWCP_ROUND;
                DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref cornerPref, sizeof(int));
            }
            catch { }

            try
            {
                // 2. 启用 DWM Acrylic 实时高斯模糊磨砂背景 (AABBGGRR: 半透明冰川灰白磨砂层)
                var accent = new AccentPolicy
                {
                    AccentState = ACCENT_ENABLE_ACRYLICBLURBEHIND,
                    AccentFlags = 2,
                    GradientColor = 0x50F8FAFC // 约 31% 冰白磨砂叠加高斯模糊
                };

                int size = Marshal.SizeOf(accent);
                IntPtr ptr = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(accent, ptr, false);
                    var data = new WindowCompositionAttributeData
                    {
                        Attribute = WCA_ACCENT_POLICY,
                        Data = ptr,
                        SizeOfData = size
                    };
                    SetWindowCompositionAttribute(Handle, ref data);
                }
                finally
                {
                    Marshal.FreeHGlobal(ptr);
                }
            }
            catch
            {
                Opacity = 0.86;
            }
        }

        public void ShowAtEdge(DockEdge edge, Rectangle workArea, Rectangle expandedBounds)
        {
            _currentEdge = edge;
            if (edge == DockEdge.Top)
            {
                Width = 108;
                Height = 28;
                int x = Math.Max(workArea.Left + 24, Math.Min(expandedBounds.Left + expandedBounds.Width / 2 - 54, workArea.Right - 132));
                int y = workArea.Top + 4;
                SetBounds(x, y, Width, Height);
            }
            else if (edge == DockEdge.Left)
            {
                Width = 28;
                Height = 108;
                int x = workArea.Left + 4;
                int y = Math.Max(workArea.Top + 40, Math.Min(expandedBounds.Top + 90, workArea.Bottom - 130));
                SetBounds(x, y, Width, Height);
            }
            else
            {
                Width = 28;
                Height = 108;
                int x = workArea.Right - Width - 4;
                int y = Math.Max(workArea.Top + 40, Math.Min(expandedBounds.Top + 90, workArea.Bottom - 130));
                SetBounds(x, y, Width, Height);
            }

            if (!Visible)
            {
                Show();
                EnableAppleFrostedBlur();
            }
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;

            RectangleF rect = new RectangleF(1f, 1f, Width - 2f, Height - 2f);
            float radius = Math.Min(Width, Height) * 0.46f;

            using (GraphicsPath pillPath = AppIconRenderer.CreateRoundedRectPath(rect, radius))
            {
                // 苹果磨砂柔光渐变层 (冰川白高光 -> 半透蓝灰微光)
                using (var glassBrush = new LinearGradientBrush(
                    rect,
                    Color.FromArgb(68, 255, 255, 255),
                    Color.FromArgb(32, 148, 163, 184),
                    LinearGradientMode.Vertical))
                {
                    g.FillPath(glassBrush, pillPath);
                }

                // 苹果标志性的 1px 镜面高光内边框 (Specular Highlight Border)
                using (var borderBrush = new LinearGradientBrush(
                    rect,
                    Color.FromArgb(185, 255, 255, 255),
                    Color.FromArgb(75, 255, 255, 255),
                    LinearGradientMode.ForwardDiagonal))
                using (var borderPen = new Pen(borderBrush, 1.25f))
                {
                    g.DrawPath(borderPen, pillPath);
                }
            }

            if (_currentEdge == DockEdge.Top)
            {
                // 水平胶囊布局：左侧微光圆标 + 右侧 iOS 风格磨砂呼吸握把条
                float badgeSize = 16f;
                float badgeX = 10f;
                float badgeY = (Height - badgeSize) / 2f;
                DrawMiniBadge(g, badgeX, badgeY, badgeSize);

                RectangleF barRect = new RectangleF(34f, (Height - 4.5f) / 2f, 58f, 4.5f);
                using (GraphicsPath barPath = AppIconRenderer.CreateRoundedRectPath(barRect, 2.25f))
                using (var barBrush = new SolidBrush(Color.FromArgb(215, 255, 255, 255)))
                {
                    g.FillPath(barBrush, barPath);
                }
            }
            else
            {
                // 垂直胶囊布局：上方微光星芒徽标 + 下方 iOS 风格磨砂呼吸握把条
                float badgeSize = 17f;
                float badgeX = (Width - badgeSize) / 2f;
                float badgeY = 12f;
                DrawMiniBadge(g, badgeX, badgeY, badgeSize);

                RectangleF barRect = new RectangleF((Width - 4.5f) / 2f, 38f, 4.5f, 52f);
                using (GraphicsPath barPath = AppIconRenderer.CreateRoundedRectPath(barRect, 2.25f))
                using (var barBrush = new LinearGradientBrush(
                    barRect,
                    Color.FromArgb(230, 255, 255, 255),
                    Color.FromArgb(145, 226, 232, 240),
                    LinearGradientMode.Vertical))
                {
                    g.FillPath(barBrush, barPath);
                }
            }
        }

        private void DrawMiniBadge(Graphics g, float x, float y, float size)
        {
            RectangleF r = new RectangleF(x, y, size, size);
            using (var brush = new LinearGradientBrush(
                r,
                Color.FromArgb(235, 99, 102, 241),
                Color.FromArgb(235, 6, 182, 212),
                LinearGradientMode.ForwardDiagonal))
            {
                g.FillEllipse(brush, r);
            }

            float cx = x + size / 2f;
            float cy = y + size / 2f;
            float sr = size * 0.34f;
            using (GraphicsPath star = AppIconRenderer.CreateFourPointStarPath(cx, cy, sr, sr * 0.30f))
            using (var sb = new SolidBrush(Color.White))
            {
                g.FillPath(sb, star);
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            string appRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');

            // 支持命令行仅生成图标 (--gen-icons)
            if (args != null && args.Length > 0 && args[0] == "--gen-icons")
            {
                string iconDir = Path.Combine(appRoot, "src-tauri", "icons");
                if (!Directory.Exists(iconDir)) Directory.CreateDirectory(iconDir);
                AppIconRenderer.SaveIconFiles(
                    Path.Combine(iconDir, "icon.png"),
                    Path.Combine(iconDir, "icon.ico")
                );
                return;
            }

            bool createdNew;
            using (var mutex = new Mutex(true, "QuickMemo_Desktop_SingleInstance_Mutex", out createdNew))
            {
                if (!createdNew)
                {
                    try
                    {
                        string cmdFile = Path.Combine(appRoot, ".window-cmd.json");
                        File.WriteAllText(cmdFile, "{\"cmd\":\"restore\"}");
                    }
                    catch { }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new QuickMemoAppContext(appRoot));
            }
        }
    }
}
