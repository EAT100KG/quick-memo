using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
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

    public class QuickMemoAppContext : ApplicationContext
    {
        #region Win32 API

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
        private const int HOTKEY_ID_DOCK = 9002;
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
        private const uint SWP_NOZORDER = 0x0004;
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

        // 贴边缩到屏幕外状态
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
            Icon icon = SystemIcons.Application;
            string icoPath = Path.Combine(_appRoot, "src-tauri", "icons", "icon.ico");
            if (File.Exists(icoPath))
            {
                try { icon = new Icon(icoPath); } catch { }
            }

            var menu = new ContextMenuStrip();

            var openItem = new ToolStripMenuItem("⚡ 显示 / 隐藏主窗口 (Alt+Space)");
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            openItem.Click += (s, e) => ToggleWindowByShortcut();

            var dockRightItem = new ToolStripMenuItem("⇥ 缩到屏幕右侧边缘 (鼠标移过去自动滑出)");
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
                Text = "QuickMemo · 闪念收纳盒 (Alt+Space 呼出 / 贴边自动缩起)",
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

            foreach (var proc in Process.GetProcesses())
            {
                try
                {
                    if (proc.MainWindowHandle != IntPtr.Zero &&
                        proc.MainWindowTitle != null &&
                        proc.MainWindowTitle.Contains("QuickMemo"))
                    {
                        _targetHwnd = proc.MainWindowHandle;
                        _wasWindowAlive = true;
                        return _targetHwnd;
                    }
                }
                catch { }
            }
            return IntPtr.Zero;
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

                // 模拟 Alt 键事件以允许后台进程将窗口置为前台焦点
                keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero);
                SetForegroundWindow(hwnd);
                keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero);
            }
            catch { }
        }

        /// <summary>
        /// 按 Alt+Space 时的切换逻辑：
        /// - 如果已隐藏、最小化、缩在屏幕外、或不在前台 -> 立即滑出/显示并置顶聚焦
        /// - 如果正在前台激活状态 -> 若处于贴边模式则缩回屏幕外，否则隐藏到后台托盘
        /// </summary>
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
                // 当前已在前台 -> 再按一次快捷键立即收起
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

            // 将窗口彻底移到屏幕可视区域外面（只留 1px 在屏幕外侧边缘）
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

            // 在屏幕边缘显示小巧的「⚡ 闪念」悬浮唤醒侧边条
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
                    // 用户点击了右上角 × 关闭了窗口 -> 保留在后台托盘
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

            // 如果当前已经缩在屏幕外面：检测鼠标是否碰到了屏幕边缘
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

            // 窗口处于展开状态：检查位置是否贴近屏幕左/右/上边缘
            RECT rect;
            if (!GetWindowRect(hwnd, out rect)) return;
            Rectangle winRect = rect.ToRectangle();
            Screen currentScreen = Screen.FromRectangle(winRect);
            Rectangle screenBounds = currentScreen.WorkingArea;

            // 当鼠标松开时，根据窗口距离屏幕边缘的距离自动判断贴边或解除贴边
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
                    // 如果用户把窗口拖离了边缘，自动解除贴边模式
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

            // 如果处于贴边模式，且鼠标移出了窗口范围 -> 延迟 450ms 自动缩到屏幕外面
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
                    // 退出前恢复窗口位置，避免下次打开留在屏幕外
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
    /// 当主窗口缩到屏幕外面时，贴在屏幕边缘的迷你「⚡ 闪念」唤醒条（鼠标移上去立即滑出主窗口）
    /// </summary>
    public class EdgePeekForm : Form
    {
        public event EventHandler MouseEnterTrigger;
        public event EventHandler ClickTrigger;

        public EdgePeekForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(37, 99, 235);
            ForeColor = Color.White;
            Opacity = 0.92;
            Width = 26;
            Height = 96;
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

        public void ShowAtEdge(DockEdge edge, Rectangle workArea, Rectangle expandedBounds)
        {
            if (edge == DockEdge.Top)
            {
                Width = 96;
                Height = 24;
                int x = Math.Max(workArea.Left + 20, Math.Min(expandedBounds.Left + expandedBounds.Width / 2 - 48, workArea.Right - 116));
                int y = workArea.Top;
                SetBounds(x, y, Width, Height);
            }
            else if (edge == DockEdge.Left)
            {
                Width = 26;
                Height = 96;
                int x = workArea.Left;
                int y = Math.Max(workArea.Top + 40, Math.Min(expandedBounds.Top + 80, workArea.Bottom - 120));
                SetBounds(x, y, Width, Height);
            }
            else
            {
                Width = 26;
                Height = 96;
                int x = workArea.Right - Width;
                int y = Math.Max(workArea.Top + 40, Math.Min(expandedBounds.Top + 80, workArea.Bottom - 120));
                SetBounds(x, y, Width, Height);
            }

            if (!Visible)
            {
                Show();
            }
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var font = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold))
            using (var brush = new SolidBrush(Color.White))
            {
                var sf = new StringFormat
                {
                    Alignment = StringAlignment.Center,
                    LineAlignment = StringAlignment.Center
                };
                if (Width > Height)
                {
                    e.Graphics.DrawString("⚡ 闪念", font, brush, ClientRectangle, sf);
                }
                else
                {
                    e.Graphics.DrawString("⚡\n闪\n念", font, brush, ClientRectangle, sf);
                }
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            bool createdNew;
            using (var mutex = new Mutex(true, "QuickMemo_Desktop_SingleInstance_Mutex", out createdNew))
            {
                string appRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
                if (!createdNew)
                {
                    // 已在后台运行 -> 写入唤醒指令唤醒主窗口
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
