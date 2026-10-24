using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace QuickMemo
{
    public class QuickMemoAppContext : ApplicationContext
    {
        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        private const int HOTKEY_ID = 9001;
        private const uint MOD_ALT = 0x0001;
        private const uint VK_SPACE = 0x20;
        private const int SW_RESTORE = 9;

        private readonly string _appRoot;
        private readonly string _appUrl = "http://127.0.0.1:1420";
        private Process _nodeServerProcess;
        private NotifyIcon _trayIcon;
        private HotKeyMessageWindow _hotKeyWindow;

        public QuickMemoAppContext(string appRoot)
        {
            _appRoot = appRoot;

            EnsureBackendRunning();
            SetupTrayIcon();
            SetupGlobalHotKey();
            OpenOrActivateWindow();
        }

        private bool IsPortOpen(int port)
        {
            try
            {
                using (var client = new TcpClient())
                {
                    var result = client.BeginConnect("127.0.0.1", port, null, null);
                    var success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(250));
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
            if (IsPortOpen(1420))
            {
                return;
            }

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
                // 等待端口就绪（最多 3 秒）
                for (int i = 0; i < 30; i++)
                {
                    if (IsPortOpen(1420)) break;
                    Thread.Sleep(100);
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
            var openItem = new ToolStripMenuItem("⚡ 打开 QuickMemo (Alt+Space)");
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            openItem.Click += (s, e) => OpenOrActivateWindow();

            var vaultItem = new ToolStripMenuItem("📂 打开本地 Markdown 文件夹");
            vaultItem.Click += (s, e) => OpenVaultFolder();

            var exitItem = new ToolStripMenuItem("❌ 退出程序");
            exitItem.Click += (s, e) => ExitApplication();

            menu.Items.Add(openItem);
            menu.Items.Add(vaultItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            _trayIcon = new NotifyIcon
            {
                Icon = icon,
                Text = "QuickMemo · 闪念与文件收纳盒 (Alt+Space 呼出)",
                ContextMenuStrip = menu,
                Visible = true
            };

            _trayIcon.DoubleClick += (s, e) => OpenOrActivateWindow();
        }

        private void SetupGlobalHotKey()
        {
            _hotKeyWindow = new HotKeyMessageWindow(this);
            RegisterHotKey(_hotKeyWindow.Handle, HOTKEY_ID, MOD_ALT, VK_SPACE);
        }

        public void OpenOrActivateWindow()
        {
            EnsureBackendRunning();

            // 查找是否已有打开的 QuickMemo 窗口
            foreach (var proc in Process.GetProcesses())
            {
                try
                {
                    if (proc.MainWindowHandle != IntPtr.Zero &&
                        proc.MainWindowTitle != null &&
                        proc.MainWindowTitle.Contains("QuickMemo"))
                    {
                        ShowWindow(proc.MainWindowHandle, SW_RESTORE);
                        SetForegroundWindow(proc.MainWindowHandle);
                        return;
                    }
                }
                catch { }
            }

            // 使用 Edge App 模式打开独立桌面窗口（无地址栏、无黑框）
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "msedge.exe",
                    Arguments = "--app=\"" + _appUrl + "\" --window-size=1080,740",
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
            try
            {
                if (_hotKeyWindow != null)
                {
                    UnregisterHotKey(_hotKeyWindow.Handle, HOTKEY_ID);
                    _hotKeyWindow.DestroyHandle();
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
                    _ctx.OpenOrActivateWindow();
                }
                base.WndProc(ref m);
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
                    // 如果已在运行，直接唤醒窗口后退出当前实例
                    try
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = "msedge.exe",
                            Arguments = "--app=\"http://127.0.0.1:1420\" --window-size=1080,740",
                            UseShellExecute = true
                        });
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
