import AppKit

// 常规桌面应用：有 Dock 图标 + 菜单栏图标，双击即显示主窗口
// 开机自启（--background）时以配件方式静默驻留菜单栏，不抢 Dock 与前台
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(AppDelegate.isBackgroundLaunch ? .accessory : .regular)
app.run()
