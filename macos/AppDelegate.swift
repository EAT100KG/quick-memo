import AppKit
import WebKit
import Carbon.HIToolbox
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {

    /// 开机自启时带 --background：只驻留菜单栏，不弹出主窗口
    static let isBackgroundLaunch = CommandLine.arguments.contains("--background")

    /// 与 Node 侧共用的 LaunchAgent 标识（状态唯一来源：~/Library/LaunchAgents/<label>.plist）
    private let launchAgentLabel = "com.quickmemo.mac"

    private var statusItem: NSStatusItem?
    private var window: NSWindow?
    private var webView: WKWebView?
    private var nodeProcess: Process?
    private var nodeLogHandle: FileHandle?
    private var cmdTimer: Timer?
    private var hotKeyRef: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?
    private var loadRetry = 0
    private var backendReady = false

    // 拖窗（页面顶栏空白处按住可拖动窗口）
    private var dragTimer: Timer?
    private var dragStartMouse: NSPoint?
    private var dragStartOrigin: NSPoint?

    /// 后台启动的窗口首次呼出要重新定位到鼠标所在屏
    private var hasShownOnce = false

    /// 文案自检开关（QUICKMEMO_SELFTEST=1），仅用于验证渲染结果
    private let isSelfTest = ProcessInfo.processInfo.environment["QUICKMEMO_SELFTEST"] == "1"

    private let port = 1420
    private let appURL = URL(string: "http://127.0.0.1:1420")!

    /// 数据目录：配置 / vault / 窗口命令都放这里，避免写进 .app 包内（破坏签名、升级丢失）
    private var dataHome: URL {
        if let env = ProcessInfo.processInfo.environment["QUICKMEMO_HOME"], !env.isEmpty {
            return URL(fileURLWithPath: (env as NSString).expandingTildeInPath)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("QuickMemo", isDirectory: true)
    }

    private var logsDir: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Logs", isDirectory: true)
    }
    private var nodeLogURL: URL { logsDir.appendingPathComponent("QuickMemo-node.log") }
    private var shellLogURL: URL { logsDir.appendingPathComponent("QuickMemo.log") }

    // MARK: - 日志
    private func qmLog(_ msg: String) {
        NSLog("[QuickMemo] \(msg)")
        try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
        let line = "[\(Date())] \(msg)\n"
        guard let data = line.data(using: .utf8) else { return }
        if let fh = try? FileHandle(forWritingTo: shellLogURL) {
            fh.seekToEndOfFile()
            fh.write(data)
            try? fh.close()
        } else {
            try? data.write(to: shellLogURL)
        }
    }

    // MARK: - 定位项目根目录（含 server/standalone.js）
    // 必须解析符号链接：若 .app 处在软链路径下（典型如 /tmp → /private/tmp），
    // 把软链路径当作 Node 的 ESM 入口会让 node 静默退出（退出码 0、无任何输出，极难排查）。
    // 注：Foundation 的 resolvingSymlinksInPath() 对 /tmp 这类路径实测不解析，故直接用 realpath(3)。
    private var appRoot: URL? { rawAppRoot.map(realPath) }

    private func realPath(_ url: URL) -> URL {
        var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
        return url.path.withCString { p in
            guard realpath(p, &buf) != nil else { return url }
            return URL(fileURLWithPath: String(cString: buf))
        }
    }

    private var rawAppRoot: URL? {
        let fm = FileManager.default
        if let res = Bundle.main.resourceURL,
           fm.fileExists(atPath: res.appendingPathComponent("server/standalone.js").path) {
            return res
        }
        let cwd = URL(fileURLWithPath: fm.currentDirectoryPath)
        if fm.fileExists(atPath: cwd.appendingPathComponent("server/standalone.js").path) {
            return cwd
        }
        let exeDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        let res = exeDir.deletingLastPathComponent().appendingPathComponent("Resources")
        if fm.fileExists(atPath: res.appendingPathComponent("server/standalone.js").path) {
            return res
        }
        return nil
    }

    // MARK: - 定位 node（关键修复：LaunchServices 启动时 PATH 极小，env node 会失败）
    private func resolveNode() -> String? {
        let fm = FileManager.default
        if let override = ProcessInfo.processInfo.environment["QUICKMEMO_NODE"], !override.isEmpty,
           fm.isExecutableFile(atPath: override) {
            return override
        }
        var candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/opt/local/bin/node",
            NSHomeDirectory() + "/.volta/bin/node",
            NSHomeDirectory() + "/.asdf/shims/node"
        ]
        // nvm 多版本
        let nvmRoot = NSHomeDirectory() + "/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvmRoot) {
            for v in versions.sorted(by: >) {
                candidates.append("\(nvmRoot)/\(v)/bin/node")
            }
        }
        for p in candidates where fm.isExecutableFile(atPath: p) {
            return p
        }
        // 兜底：问登录 shell（会读 .zshrc / .zprofile 里的 PATH）
        for shell in ["/bin/zsh", "/bin/bash"] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: shell)
            p.arguments = ["-lc", "command -v node"]
            let out = Pipe()
            p.standardOutput = out
            p.standardError = Pipe()
            guard (try? p.run()) != nil else { continue }
            p.waitUntilExit()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if fm.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    // MARK: - 生命周期
    func applicationDidFinishLaunching(_ notification: Notification) {
        // 单实例：launchd 自启的实例与手动打开不能并存（否则两个菜单栏图标、两份后端探测）
        if handOverToExistingInstance() { return }

        buildMainMenu()
        setupStatusItem()
        registerHotkey()
        syncAutostartIfMoved()
        createWindow()          // 先把窗口建好（内容预加载），任何情况下都不会"点了没反应"
        backendReady = startBackendIfNeeded()
        if backendReady {
            webView?.load(URLRequest(url: appURL))
        } else {
            showBackendError(reason: "本地 Node 服务未能启动")
        }
        if Self.isBackgroundLaunch {
            // 开机自启：静默驻留菜单栏，不弹主窗口
            qmLog("以 --background 启动：窗口保持隐藏，仅驻留菜单栏，⌥Space 可呼出")
        }
        startCmdMonitor()

        NotificationCenter.default.addObserver(self,
                                              selector: #selector(screenChanged),
                                              name: NSApplication.didChangeScreenParametersNotification,
                                              object: nil)
        qmLog("启动完成 屏幕数=\(NSScreen.screens.count) 后端=\(backendReady ? "就绪" : "失败") 模式=\(Self.isBackgroundLaunch ? "后台" : "前台")")
    }

    /// 单实例：launchd 自启（--background）与手动打开不应同时存在两份。
    /// - 后台实例发现自己多余 → 直接让位退出
    /// - 手动打开的实例发现已有后台实例 → 请求其显示窗口，自己退出
    private func handOverToExistingInstance() -> Bool {
        let bundleID = Bundle.main.bundleIdentifier ?? launchAgentLabel
        let myPID = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .filter { $0.processIdentifier != myPID }
        guard let first = others.first else { return false }

        if Self.isBackgroundLaunch {
            qmLog("已有实例在运行 pid=\(first.processIdentifier)，后台启动让位退出")
        } else {
            let cmdURL = dataHome.appendingPathComponent(".window-cmd.json")
            try? "{\"cmd\":\"show\"}".data(using: .utf8)?.write(to: cmdURL)
            first.activate(options: [.activateAllWindows])
            qmLog("已有实例在运行 pid=\(first.processIdentifier)，已请求其显示窗口，本次退出")
        }
        DispatchQueue.main.async { NSApp.terminate(nil) }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        cmdTimer?.invalidate()
        endDrag()
        if let ref = hotKeyRef { UnregisterEventHotKey(ref) }
        nodeProcess?.terminate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// 点 Dock 图标时把窗口叫回来
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    @objc private func screenChanged() {
        if let w = window { ensureOnScreen(w) }
    }

    // MARK: - 主菜单（没有 Edit 菜单，WKWebView 里的 ⌘C/⌘V 会失效）
    private func buildMainMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 QuickMemo",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 QuickMemo",
                        action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 QuickMemo",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "显示")
        let reload = viewMenu.addItem(withTitle: "重新载入页面", action: #selector(reloadPage), keyEquivalent: "r")
        reload.target = self
        let open = viewMenu.addItem(withTitle: "打开 Markdown 文件夹", action: #selector(openVault), keyEquivalent: "")
        open.target = self
        let toggle = viewMenu.addItem(withTitle: "显示 / 隐藏主窗口", action: #selector(toggleWindow), keyEquivalent: "")
        toggle.target = self
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        NSApp.mainMenu = main
    }

    // MARK: - 菜单栏
    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "square.and.pencil",
                                   accessibilityDescription: "QuickMemo")
        }
        let menu = NSMenu()

        let toggle = NSMenuItem(title: "显示 / 隐藏主窗口  ⌥Space",
                                action: #selector(toggleWindow), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)

        let vault = NSMenuItem(title: "打开本地 Markdown 文件夹",
                               action: #selector(openVault), keyEquivalent: "")
        vault.target = self
        menu.addItem(vault)

        menu.addItem(.separator())

        let auto = NSMenuItem(title: "开机自动启动",
                              action: #selector(toggleAutostart), keyEquivalent: "")
        auto.target = self
        auto.state = isAutostartEnabled() ? .on : .off
        auto.tag = 1001
        menu.addItem(auto)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "退出 QuickMemo",
                              action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        item.menu = menu
        statusItem = item
    }

    // MARK: - 屏幕定位（关键修复：不再用 center()，避免窗口跑到外接屏/屏幕外）
    private func preferredScreen() -> NSScreen {
        let mouse = NSEvent.mouseLocation
        for s in NSScreen.screens where NSMouseInRect(mouse, s.frame, false) { return s }
        if let key = NSApp.keyWindow?.screen { return key }
        return NSScreen.main ?? NSScreen.screens.first!
    }

    private func centeredFrame(on screen: NSScreen, size: NSSize) -> NSRect {
        let vf = screen.visibleFrame
        let w = max(640, min(size.width, vf.width - 80))
        let h = max(480, min(size.height, vf.height - 80))
        return NSRect(x: vf.midX - w / 2, y: vf.midY - h / 2, width: w, height: h).integral
    }

    /// 窗口中心点不在任何屏幕可见区里 → 拉回鼠标所在屏幕正中
    private func ensureOnScreen(_ w: NSWindow) {
        let f = w.frame
        let c = NSPoint(x: f.midX, y: f.midY)
        let visible = NSScreen.screens.contains { $0.visibleFrame.contains(c) }
        guard !visible else { return }
        let screen = preferredScreen()
        let target = centeredFrame(on: screen, size: f.size)
        w.setFrame(target, display: true)
        qmLog("窗口越界，已重定位到屏中心: \(target)")
    }

    // MARK: - 窗口
    private func createWindow() {
        let screen = preferredScreen()
        var size = NSSize(width: 1080, height: 740)
        // 便于验证自适应：QUICKMEMO_WIN_SIZE=900x640
        if let s = ProcessInfo.processInfo.environment["QUICKMEMO_WIN_SIZE"], !s.isEmpty {
            let parts = s.lowercased().split(separator: "x")
            if parts.count == 2, let aw = Double(parts[0]), let ah = Double(parts[1]) {
                size = NSSize(width: aw, height: ah)
            }
        }
        let frame = centeredFrame(on: screen, size: size)

        // 关键：不用 .fullSizeContentView —— 网页内容不再顶到 y=0 与红绿灯重叠，
        // 标题栏本身成为可靠的原生拖动区。
        let w = NSWindow(contentRect: frame,
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "QuickMemo"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        if #available(macOS 11.0, *) { w.titlebarSeparatorStyle = .none }
        // 白色底让透明标题栏与页面白色顶栏连成一片，视觉上是一个整体
        w.backgroundColor = NSColor.white
        // 网页本身是浅色 UI，强制浅色外观，避免深色模式下红绿灯在白底上看不见
        w.appearance = NSAppearance(named: .aqua)
        w.minSize = NSSize(width: 820, height: 600)
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.setFrame(frame, display: true)

        let config = WKWebViewConfiguration()
        installUserScripts(into: config)

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.loadHTMLString(Self.loadingHTML, baseURL: nil)   // 先给个"启动中"占位

        w.contentView = web
        web.frame = w.contentView!.bounds
        web.autoresizingMask = [.width, .height]
        self.webView = web
        self.window = w

        if Self.isBackgroundLaunch {
            qmLog("窗口已创建（后台模式，不显示）frame=\(w.frame) 屏幕=\(screen.frame)")
        } else {
            showWindow()
            qmLog("窗口已创建 frame=\(w.frame) 屏幕=\(screen.frame)")
        }
    }

    // MARK: - 注入：布局自适应样式 + 顶栏拖窗脚本（不改仓库源码）
    private func installUserScripts(into config: WKWebViewConfiguration) {
        let css = layoutCSS()
        let cssJS = """
        (function(){
          var s = document.createElement('style');
          s.id = '__qm_mac_layout__';
          s.textContent = \(jsStringLiteral(css));
          document.head.appendChild(s);
        })();
        """

        // 拖动：顶栏空白处按住即可拖窗（document 捕获阶段监听，innerHTML 重渲染后依然有效）
        let dragJS = """
        (function(){
          if (window.__qmDragInstalled) return;
          window.__qmDragInstalled = true;
          document.addEventListener('mousedown', function(e){
            if (e.button !== 0 || e.detail > 1) return;
            var t = e.target;
            if (!t || !t.closest) return;
            if (!t.closest('.topbar')) return;
            // 按钮、输入、标签这些交互元素不参与拖窗
            if (t.closest('button, a, input, textarea, select, kbd, .brand, .nav-tabs, .topbar-actions')) return;
            e.preventDefault();
            try { window.webkit.messageHandlers.qmDrag.postMessage({ phase: 'start' }); } catch (err) {}
          }, true);
          window.addEventListener('mouseup', function(){
            try { window.webkit.messageHandlers.qmDrag.postMessage({ phase: 'end' }); } catch (err) {}
          }, true);

          // 自检：把布局状态回报给壳（用于验证自适应是否生效，正常运行时无副作用）
          function diag(){
            var bar = document.querySelector('.topbar');
            var doc = document.documentElement;
            // 采样顶栏中线，统计有多少位置落在"可拖窗"的空白区（用于验证拖动可命中）
            var dragHits = 0;
            if (bar) {
              var r = bar.getBoundingClientRect();
              for (var x = r.left + 8; x < r.right - 8; x += 16) {
                var el = document.elementFromPoint(x, r.top + r.height / 2);
                if (el && el.closest && !el.closest('button, a, input, textarea, select, kbd, .brand, .nav-tabs, .topbar-actions')) dragHits++;
              }
            }
            try {
              window.webkit.messageHandlers.qmDrag.postMessage({
                phase: 'diag',
                w: window.innerWidth,
                h: window.innerHeight,
                cssOk: !!document.getElementById('__qm_mac_layout__'),
                topbarOverflow: bar ? (bar.scrollWidth > bar.clientWidth + 1) : null,
                topbarH: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
                dragHits: dragHits,
                docOverflowX: doc.scrollWidth > doc.clientWidth + 1,
                docOverflowY: doc.scrollHeight > doc.clientHeight + 1
              });
            } catch (err) {}
          }
          window.addEventListener('resize', function(){ clearTimeout(window.__qmDiagT); window.__qmDiagT = setTimeout(diag, 120); });
          [300, 1200, 2600].forEach(function(t){ setTimeout(diag, t); });

          // 文案自检：仅在 QUICKMEMO_SELFTEST=1 时执行，切到设置页读回真实渲染文本
          if (\(isSelfTest ? "true" : "false") && !window.__qmSelfTested) {
            window.__qmSelfTested = true;
            setTimeout(function(){
              var tab = document.querySelector('[data-tab="settings"]');
              if (tab) tab.click();
              setTimeout(function(){
                var card = document.querySelector('.autostart-card');
                var txt = card ? card.innerText.replace(/\\s+/g, ' ').trim().slice(0, 420) : '(未找到 .autostart-card)';
                var kbd = card ? Array.prototype.map.call(card.querySelectorAll('kbd'), function(k){ return k.innerText; }) : [];
                try {
                  window.webkit.messageHandlers.qmDrag.postMessage({ phase: 'selftest', text: txt, kbd: kbd.join('|') });
                } catch (err) {}
              }, 900);
            }, 1200);
          }
        })();
        """

        let ctrl = config.userContentController
        ctrl.addUserScript(WKUserScript(source: cssJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        ctrl.addUserScript(WKUserScript(source: dragJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        ctrl.add(self, name: "qmDrag")
    }

    private func jsStringLiteral(_ s: String) -> String {
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "")
        return "\"\(escaped)\""
    }

    private func layoutCSS() -> String {
        if let root = appRoot,
           let s = try? String(contentsOf: root.appendingPathComponent("mac-layout.css"), encoding: .utf8),
           !s.isEmpty {
            return s
        }
        qmLog("未找到 mac-layout.css，使用内置最小样式")
        return """
        .app-container{min-width:0!important;min-height:0!important}
        .topbar{height:auto!important;min-height:56px;flex-wrap:wrap!important;white-space:normal!important}
        .nav-tabs{flex-wrap:wrap!important;min-width:0}
        .topbar-actions{flex-wrap:wrap!important;margin-left:auto}
        """
    }

    // MARK: - 拖窗消息
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "qmDrag",
              let body = message.body as? [String: Any],
              let phase = body["phase"] as? String else { return }
        switch phase {
        case "start":
            beginDrag()
        case "end":
            endDrag()
        case "diag":
            let vw = body["w"] as? Int ?? 0
            let vh = body["h"] as? Int ?? 0
            let cssOk = body["cssOk"] as? Bool ?? false
            let overflow = body["topbarOverflow"] as? Bool
            let barH = body["topbarH"] as? Int ?? 0
            let ox = body["docOverflowX"] as? Bool ?? false
            let oy = body["docOverflowY"] as? Bool ?? false
            let dragHits = body["dragHits"] as? Int ?? -1
            qmLog("布局自检 视口=\(vw)x\(vh) CSS注入=\(cssOk) 顶栏溢出=\(overflow.map { $0 ? "是" : "否" } ?? "n/a") 顶栏高=\(barH) 可拖拽采样点=\(dragHits) 横向溢出=\(ox) 纵向溢出=\(oy)")
        case "selftest":
            let text = body["text"] as? String ?? ""
            let kbd = body["kbd"] as? String ?? ""
            qmLog("文案自检 快捷键kbd=[\(kbd)]")
            qmLog("文案自检 设置页文本: \(text)")
        default:
            break
        }
    }

    private func beginDrag() {
        guard let w = window else { return }
        dragStartOrigin = w.frame.origin
        dragStartMouse = NSEvent.mouseLocation
        dragTimer?.invalidate()
        let t = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            // 鼠标左键已松开 → 结束
            if NSEvent.pressedMouseButtons & 1 == 0 {
                timer.invalidate()
                self.dragTimer = nil
                return
            }
            guard let o = self.dragStartOrigin, let m = self.dragStartMouse, let win = self.window else { return }
            let now = NSEvent.mouseLocation
            win.setFrameOrigin(NSPoint(x: o.x + (now.x - m.x), y: o.y + (now.y - m.y)))
        }
        RunLoop.main.add(t, forMode: .common)   // 拖动期间 .default 可能不跑
        dragTimer = t
    }

    private func endDrag() {
        dragTimer?.invalidate()
        dragTimer = nil
        dragStartMouse = nil
        dragStartOrigin = nil
    }

    private func showWindow() {
        guard let w = window else { return }
        // 后台启动（--background）的实例被唤醒时恢复成常规应用，否则没有 Dock 图标可以切回来。
        // 注意 setActivationPolicy 是异步生效的，紧接着 activate 会被忽略，必须延后一拍再抢焦点。
        if NSApp.activationPolicy() == .accessory {
            NSApp.setActivationPolicy(.regular)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
                guard let self, let win = self.window else { return }
                win.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                NSRunningApplication.current.activate(options: [.activateAllWindows])
            }
        }
        // 后台启动时窗口没露过面，首次呼出按"此刻鼠标所在屏"重新居中，而不是沿用启动时算的位置
        if !hasShownOnce && Self.isBackgroundLaunch {
            w.setFrame(centeredFrame(on: preferredScreen(), size: w.frame.size), display: true)
        }
        hasShownOnce = true
        ensureOnScreen(w)
        if w.isMiniaturized { w.deminiaturize(nil) }
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        NSRunningApplication.current.activate(options: [.activateAllWindows])
        // 有些情况下首次 activate 会被系统忽略，下一轮 runloop 再抢一次焦点
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let w = self?.window, w.isVisible else { return }
            w.makeKeyAndOrderFront(nil)
            NSRunningApplication.current.activate(options: [.activateAllWindows])
        }
    }

    @objc private func toggleWindow() {
        guard let w = window else { return }
        if w.isVisible && w.isKeyWindow {
            w.orderOut(nil)
        } else {
            showWindow()
        }
    }

    @objc private func reloadPage() {
        loadRetry = 0
        if backendReady || isPortOpen(port) {
            webView?.load(URLRequest(url: appURL))
        } else {
            backendReady = startBackendIfNeeded()
            if backendReady { webView?.load(URLRequest(url: appURL)) }
            else { showBackendError(reason: "本地 Node 服务仍未启动") }
        }
    }

    // 点关闭按钮 = 隐藏窗口（应用继续在 Dock / 菜单栏活着）
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    // MARK: - 页面状态
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = webView.url, url.scheme == "http" else { return }
        loadRetry = 0
        qmLog("页面加载完成: \(url.absoluteString)")
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        qmLog("页面加载失败: \(error.localizedDescription) retry=\(loadRetry)")
        guard loadRetry < 8 else {
            showBackendError(reason: "本地服务无响应")
            return
        }
        loadRetry += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self else { return }
            self.webView?.load(URLRequest(url: self.appURL))
        }
    }

    // MARK: - 兜底提示页（白屏是最糟的体验，出问题要能自己说明原因）
    private static let loadingHTML = """
    <!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
           background:#faf7f2;color:#4a3a2c;
           font:14px/1.7 -apple-system,"PingFang SC","Helvetica Neue",sans-serif}
      .box{text-align:center}
      .dot{width:26px;height:26px;border:3px solid #ece2d4;border-top-color:#c17f43;border-radius:50%;
           margin:0 auto 16px;animation:spin .9s linear infinite}
      @keyframes spin{to{transform:rotate(360deg)}}
      .hint{color:#a1907c;font-size:12px;margin-top:6px}
    </style></head><body><div class="box">
      <div class="dot"></div><div>正在启动本地服务…</div>
      <div class="hint">首次启动约需 1–2 秒</div>
    </div></body></html>
    """

    private func showBackendError(reason: String) {
        let nodePath = resolveNode() ?? "未找到"
        let tail = (try? String(contentsOf: nodeLogURL, encoding: .utf8)) ?? ""
        let tailTrim = tail.split(separator: "\n").suffix(12).joined(separator: "\n")
        let escapedTail = escapeHTML(tailTrim.isEmpty ? "（无输出）" : tailTrim)
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><style>
          body{margin:0;padding:44px;background:#faf7f2;color:#3f3227;
               font:14px/1.75 -apple-system,"PingFang SC",sans-serif}
          h1{font-size:17px;margin:0 0 6px;color:#8a4a2f}
          p{margin:6px 0;color:#6b5b4b}
          code{background:#f0e8db;padding:2px 6px;border-radius:4px;font-size:12px}
          pre{background:#fffdf9;border:1px solid #eadfce;border-radius:8px;padding:12px;
              font-size:12px;line-height:1.6;color:#5a4a3a;overflow:auto;max-height:220px;white-space:pre-wrap}
          .k{font-weight:600;color:#3f3227}
        </style></head><body>
          <h1>QuickMemo 起不来了</h1>
          <p>\(escapeHTML(reason))，界面没能连上本地服务（<code>127.0.0.1:1420</code>）。</p>
          <p class="k">检查清单</p>
          <p>1. 终端执行 <code>node -v</code>，需 Node 18+。没装的话先装 Node。</p>
          <p>2. 本机 node 路径：<code>\(escapeHTML(nodePath))</code></p>
          <p>3. 自查命令：<code>node "\(escapeHTML(appRoot?.appendingPathComponent("server/standalone.js").path ?? "server/standalone.js"))"</code></p>
          <p>4. 完整日志：<code>~/Library/Logs/QuickMemo.log</code> 与 <code>~/Library/Logs/QuickMemo-node.log</code></p>
          <p class="k">后端输出（末尾）</p>
          <pre>\(escapedTail)</pre>
        </body></html>
        """
        webView?.loadHTMLString(html, baseURL: nil)
    }

    private func escapeHTML(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    // MARK: - 后端进程
    private func isPortOpen(_ port: Int) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/nc")
        p.arguments = ["-z", "-G", "1", "127.0.0.1", "\(port)"]
        p.standardOutput = Pipe()
        p.standardError = Pipe()
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    @discardableResult
    private func startBackendIfNeeded() -> Bool {
        if isPortOpen(port) {
            qmLog("端口 \(port) 已被占用，复用现有后端")
            return true
        }
        guard let root = appRoot else {
            qmLog("未找到 server/standalone.js")
            return false
        }
        guard let node = resolveNode() else {
            qmLog("未找到 node 可执行文件（PATH 里没有，常见路径也没有）")
            return false
        }
        let home = dataHome
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        seedVaultIfNeeded(home: home)
        try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)

        // 注意：这里切勿再调 resolvingSymlinksInPath()——Foundation 会把 /private/tmp 反解析回 /tmp
        let script = root.appendingPathComponent("server/standalone.js")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script.path]
        p.currentDirectoryURL = root
        qmLog("后端启动: node=\(node) script=\(script.path) cwd=\(root.path)")
        var env = ProcessInfo.processInfo.environment
        env["QUICKMEMO_HOME"] = home.path
        // 告知后端 App 自身可执行文件位置，用于生成开机自启的 LaunchAgent plist
        env["QUICKMEMO_APP_PATH"] = Bundle.main.executableURL?.path ?? CommandLine.arguments[0]
        // 给子进程补一份可靠 PATH，node 里若再调外部命令也能找到
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = env
        // 输出落文件：既避免 Pipe 缓冲区写满卡死，也方便事后排查。
        // FileHandle 必须保持强引用，否则可能在 Process 使用前就被释放（写 stdout 直接 EPIPE）。
        FileManager.default.createFile(atPath: nodeLogURL.path, contents: nil)
        if let fh = try? FileHandle(forWritingTo: nodeLogURL) {
            nodeLogHandle = fh
            p.standardOutput = fh
            p.standardError = fh
        }
        do {
            try p.run()
            nodeProcess = p
            qmLog("已拉起 Node: \(node) pid=\(p.processIdentifier)")
        } catch {
            qmLog("拉起 Node 失败: \(error)")
            return false
        }
        for _ in 0..<75 {
            if isPortOpen(port) {
                qmLog("后端就绪，端口 \(port) 已监听")
                return true
            }
            if !p.isRunning {
                qmLog("Node 进程已退出，退出码 \(p.terminationStatus)")
                return false
            }
            usleep(80_000)
        }
        qmLog("等待后端就绪超时")
        return false
    }

    /// 首次运行时，把 .app 内置的 vault 复制到数据目录
    private func seedVaultIfNeeded(home: URL) {
        let fm = FileManager.default
        let destVault = home.appendingPathComponent("vault")
        guard !fm.fileExists(atPath: destVault.path) else { return }
        if let root = appRoot {
            let srcVault = root.appendingPathComponent("vault")
            if fm.fileExists(atPath: srcVault.path) {
                try? fm.copyItem(at: srcVault, to: destVault)
                qmLog("已播种内置 vault → \(destVault.path)")
                return
            }
        }
        try? fm.createDirectory(at: destVault, withIntermediateDirectories: true)
    }

    // MARK: - 全局热键（⌥Space，Carbon，无需辅助功能权限）
    private func registerHotkey() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()

        InstallEventHandler(GetApplicationEventTarget(), { (_, _, userData) -> OSStatus in
            guard let userData = userData else { return noErr }
            let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
            delegate.performToggleFromHotkey()
            return noErr
        }, 1, &eventType, selfPtr, &hotKeyHandler)

        let hotKeyID = EventHotKeyID(signature: OSType(0x514D454D), id: 1) // 'QMEM'
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(UInt32(kVK_Space),
                                         UInt32(optionKey),
                                         hotKeyID,
                                         GetApplicationEventTarget(), 0, &ref)
        if status == noErr {
            hotKeyRef = ref
            qmLog("已注册全局热键 ⌥Space")
        } else {
            // -9878 (eventHotKeyExistsErr)：已被别的应用/输入法占用
            qmLog("注册全局热键 ⌥Space 失败 status=\(status)" + (status == -9878 ? "（已被其他程序占用）" : ""))
        }
    }

    fileprivate func performToggleFromHotkey() {
        DispatchQueue.main.async { [weak self] in self?.toggleWindow() }
    }

    // MARK: - 轮询 .window-cmd.json（复刻 C# 外壳的 90ms 轮询）
    private func startCmdMonitor() {
        cmdTimer = Timer.scheduledTimer(withTimeInterval: 0.09, repeats: true) { [weak self] _ in
            self?.pollWindowCmd()
        }
    }

    private func pollWindowCmd() {
        let url = dataHome.appendingPathComponent(".window-cmd.json")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String else { return }
        try? FileManager.default.removeItem(at: url)
        handleWindowCmd(cmd)
    }

    private func handleWindowCmd(_ cmd: String) {
        guard let w = window else { return }
        switch cmd {
        case "hide":
            w.orderOut(nil)
        case "show":
            showWindow()
        case "pin-on":
            w.level = .floating
        case "pin-off":
            w.level = .normal
        case "dock-right":
            // 贴到鼠标所在屏幕右侧并收窄。原来照搬 Windows 的 96px，Mac 上没有"悬停滑出"就成了不可用窄条，
            // 这里给一个仍能操作的最小宽度。
            let screen = preferredScreen()
            let vf = screen.visibleFrame
            let width: CGFloat = min(420, vf.width * 0.4)
            let frame = NSRect(x: vf.maxX - width, y: vf.minY, width: width, height: vf.height)
            w.setFrame(frame, display: true)
        default:
            break
        }
    }

    // MARK: - 打开仓库目录（Mac 用 open，不是 explorer.exe）
    @objc private func openVault() {
        var path: String? = nil
        if let data = try? Data(contentsOf: dataHome.appendingPathComponent(".quick-memo-config.json")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let vp = obj["vaultPath"] as? String, !vp.isEmpty {
            path = vp
        }
        if path == nil {
            path = dataHome.appendingPathComponent("vault").path
        }
        if let p = path {
            NSWorkspace.shared.open(URL(fileURLWithPath: p))
        }
    }

    // MARK: - 开机自启（LaunchAgent，与 Node 侧共用同一份 plist，避免两套机制打架）

    private var launchAgentPlistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(launchAgentLabel).plist")
    }

    private var appExecutablePath: String {
        Bundle.main.executableURL?.path ?? (
            URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
        )
    }

    private func isAutostartEnabled() -> Bool {
        FileManager.default.fileExists(atPath: launchAgentPlistURL.path)
    }

    private func runLaunchctl(_ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run(); p.waitUntilExit() } catch { qmLog("launchctl \(args.first ?? "") 失败: \(error)") }
    }

    /// 写入 / 移除 LaunchAgent。silent=true 时登录后静默驻留菜单栏
    @discardableResult
    private func setAutostart(_ enabled: Bool, silent: Bool = true) -> Bool {
        let fm = FileManager.default
        let uid = getuid()
        if enabled {
            var args = [appExecutablePath]
            if silent { args.append("--background") }
            let plist: [String: Any] = [
                "Label": launchAgentLabel,
                "ProgramArguments": args,
                "RunAtLoad": true,
                "ProcessType": "Interactive",
                "LimitLoadToSessionType": "Aqua"
            ]
            do {
                try fm.createDirectory(at: launchAgentPlistURL.deletingLastPathComponent(),
                                       withIntermediateDirectories: true)
                let data = try PropertyListSerialization.data(fromPropertyList: plist,
                                                              format: .xml,
                                                              options: 0)
                try data.write(to: launchAgentPlistURL)
                runLaunchctl(["bootout", "gui/\(uid)/\(launchAgentLabel)"])
                runLaunchctl(["bootstrap", "gui/\(uid)", launchAgentPlistURL.path])
                qmLog("已开启开机自启 → \(launchAgentPlistURL.path) (静默=\(silent))")
            } catch {
                qmLog("写入 LaunchAgent 失败: \(error)")
                return false
            }
        } else {
            runLaunchctl(["bootout", "gui/\(uid)/\(launchAgentLabel)"])
            try? fm.removeItem(at: launchAgentPlistURL)
            qmLog("已关闭开机自启（LaunchAgent 已移除）")
        }
        return isAutostartEnabled() == enabled
    }

    /// App 被移动过（比如从下载目录拖到 /Applications）时，plist 里的旧路径会失效 → 自动按当前路径重写。
    /// 顺便兜住"plist 在但 launchd 未加载"的情况（手动 bootout 过、或重装后）。
    private func syncAutostartIfMoved() {
        guard FileManager.default.fileExists(atPath: launchAgentPlistURL.path),
              let data = try? Data(contentsOf: launchAgentPlistURL),
              let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let args = dict["ProgramArguments"] as? [String],
              let oldExe = args.first else { return }
        let silent = args.contains("--background")

        if oldExe != appExecutablePath {
            qmLog("开机自启指向旧路径 \(oldExe)，按当前位置重写为 \(appExecutablePath)")
            setAutostart(true, silent: silent)
            return
        }
        if !isLaunchAgentLoaded() {
            qmLog("开机自启已配置但 launchd 未加载，重新加载")
            setAutostart(true, silent: silent)
        }
    }

    private func isLaunchAgentLoaded() -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["print", "gui/\(getuid())/\(launchAgentLabel)"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            p.waitUntilExit()
            return p.terminationStatus == 0
        } catch {
            return false
        }
    }

    @objc private func toggleAutostart(_ sender: NSMenuItem) {
        setAutostart(!isAutostartEnabled())
        sender.state = isAutostartEnabled() ? .on : .off
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
