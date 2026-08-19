#!/usr/bin/env bash
# 安装 dsDragPasteALL 到 dsh web profile（幂等：重复执行安全）
set -euo pipefail

PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "错误：找不到 profile $PROFILE_DIR" >&2
  exit 1
fi

cd "$PROFILE_DIR"
pnpm add "file:$PLUGIN_DIR"

node -e '
const fs = require("fs")
const p = JSON.parse(fs.readFileSync("package.json", "utf8"))
const bundles = p.dsh.profile.bundles
if (!bundles.includes("dsdragpasteall")) {
  const at = bundles.indexOf("dseyesopen")
  bundles.splice(at >= 0 ? at + 1 : bundles.length, 0, "dsdragpasteall")
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n")
  console.log("bundles 已加入 dsdragpasteall")
} else {
  console.log("bundles 已包含 dsdragpasteall")
}
'

echo "完成：重启 dsh web 后 dsDragPasteALL 生效"
