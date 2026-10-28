#!/usr/bin/env bash
# 打包 QuickMemoMac.app（个人使用，ad-hoc 签名）
# 用法：./build.sh /path/to/quick-memo
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-}"

if [ -z "$SRC" ] || [ ! -f "$SRC/server/standalone.js" ]; then
  echo "用法: ./build.sh /path/to/quick-memo   （需含 server/standalone.js 与 dist/）"
  exit 1
fi

echo "==> 1/4 编译 Swift 壳"
swiftc -O "$HERE/main.swift" "$HERE/AppDelegate.swift" \
  -o "$HERE/QuickMemoMac" \
  -framework AppKit -framework WebKit -framework Carbon -framework ServiceManagement

APP="$HERE/QuickMemoMac.app"
echo "==> 2/4 组装 .app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/QuickMemoMac" "$APP/Contents/MacOS/QuickMemoMac"
[ -f "$HERE/AppIcon.icns" ] && cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
[ -f "$HERE/mac-layout.css" ] && cp "$HERE/mac-layout.css" "$APP/Contents/Resources/mac-layout.css"

echo "==> 3/4 复制 server/ dist/ vault/ 到 Resources"
cp -R "$SRC/server" "$APP/Contents/Resources/server"
[ -d "$SRC/dist" ] && cp -R "$SRC/dist" "$APP/Contents/Resources/dist"
[ -d "$SRC/vault" ] && cp -R "$SRC/vault" "$APP/Contents/Resources/vault"
# 注意：不打包 .quick-memo-config.json，配置与 vault 运行时落到 ~/Library/Application Support/QuickMemo

echo "==> 4/4 ad-hoc 签名"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "（ad-hoc 签名跳过，可在系统设置里手动允许）"

echo "完成: $APP"
echo "建议：把 .app 移到 /Applications 或 ~/Applications 后再用菜单栏设置开机自启"
