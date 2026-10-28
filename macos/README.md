# macOS 原生外壳

上游的桌面外壳是 Windows 专用的（`QuickMemo.exe` C# 启动器 + `msedge.exe --app=`）。这个目录提供一套 macOS 原生壳：**AppKit + WKWebView**，直接复用上游的 Node 后端与前端，不改一行页面代码。

## 前置

- macOS 13+（`SMAppService` 相关路径已移除，实际 12+ 也可）
- Xcode Command Line Tools（`swiftc`）
- Node.js 18+（Homebrew 安装即可，壳会自动探测路径）

## 构建

```bash
# 在仓库根目录
npm install
npm run build          # 产出 dist/

# 打包 .app
cd macos
./build.sh ..          # 参数为仓库根目录
open QuickMemoMac.app
```

产物：`macos/QuickMemoMac.app`（arm64 / x86_64 取决于本机，ad-hoc 签名）。

首次运行被 Gatekeeper 拦：右键 → 打开，或 `xattr -cr QuickMemoMac.app`。

## 架构

```
菜单栏 🐾  ──  常驻，⌥Space 呼出
   │
   ├── AppKit 外壳（Swift）
   │     ├── NSWindow + WKWebView，同源加载 http://127.0.0.1:1420
   │     ├── 全局热键 ⌥Space（Carbon RegisterEventHotKey，免辅助功能权限）
   │     ├── LaunchAgent 开机自启（--background 静默驻留菜单栏）
   │     ├── 单实例保护 + 自启路径自愈
   │     └── 90ms 轮询 .window-cmd.json（贴边收窄 / 置顶 / 显示）
   │
   └── Node 后端（同上游 server/standalone.js，零依赖）
         └── 127.0.0.1:1420 同时托管 dist 与 /api/*
```

**为什么必须同源加载**：前端用相对路径 `fetch('/api/...')`。若从 `tauri://localhost` 之类自定义 scheme 加载，请求会跨域，而后端不返回任何 CORS 头（已实测），AI 分类/抓取/同步会全盘失败。同源加载 = 不需要 CORS。

## 数据位置

配置与笔记落在 `~/Library/Application Support/QuickMemo/`，**不写进 .app 包内**（包内写入会破坏签名，且升级即丢数据）。

壳会给 Node 传 `QUICKMEMO_HOME` 环境变量；`server/vault-manager.js` 与 `server/standalone.js` 已支持该变量（见仓库根目录那次 macOS 适配提交）。

## 快捷键

`⌥Space` 呼出 / 隐藏。修饰键在 `AppDelegate.swift` 的 `registerHotkey()` 里，改成 `controlKey` 或 `optionKey|cmdKey` 都只需一行。

注意 `⌥Space` 会吃掉输入框里的「不间断空格」（macOS 默认 Option+Space 输入）。介意的话换 `⌃Space`。

## 与上游同步

```bash
git remote add upstream https://github.com/TeaGo-lab/quick-memo.git
git fetch upstream && git merge upstream/main
```

macOS 相关改动集中在两处，冲突面很小：

1. `server/standalone.js`、`server/vault-manager.js`、`src/main.js` 里的 `process.platform === 'darwin'` 分支
2. `macos/` 整个目录

前端布局的响应式修复走**注入**（`macos/mac-layout.css` 由 WKUserScript 注入），不动上游 `src/styles.css`，所以上游改样式不会冲突。

## 已知限制

- **单向同步**：本工具写入的笔记 Obsidian 立即可见；在 Obsidian 里改内容或新建笔记**不会**回写（列表以 `.quick-memo-index.json` 为准）。
- **自动更新**：上游更新通道是 PowerShell + `.exe`，macOS 下已禁用。
- **贴边悬浮条**：简化为「贴右边缘收窄到 420px」，没有悬停滑出。
- **未签名公证**：ad-hoc 签名，仅个人使用；对外分发需 Developer ID + notarization。

## 已知坑：别把 .app 放在符号链接目录下

如果把 `.app` 放进软链目录（最典型是 `/tmp` → `/private/tmp`），后端会**启动即退出、退出码 0、零输出**，界面停在加载占位。

这不是 node 坏了，而是 ESM 入口和符号链接的交互问题：`node /tmp/.../standalone.js` 立刻结束且无输出，`node /private/tmp/.../standalone.js` 则完全正常。

壳里已用 `realpath(3)` 解析 `appRoot` 规避（**不要**改用 Foundation 的 `resolvingSymlinksInPath()`，它会把 `/private/tmp` 反解析回 `/tmp`，反而制造这个问题）。日志里的 `后端启动: ... script=... cwd=...` 可直接看出是否踩中。
