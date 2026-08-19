#!/usr/bin/env bash
# dsDragPasteALL 反查命令链路冒烟测试。
# 验证反查依赖的命令可用、stat 输出格式、head/tail 指纹口径。
# 用法：bash scripts/smoke-test.sh [临时测试文件路径]
set -uo pipefail

TEST_FILE="${1:-}"
TMP_DIR=""
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}
trap cleanup EXIT

fail() { echo "✗ $1" >&2; exit 1; }
ok() { echo "✓ $1"; }

# 1. 依赖命令
for cmd in stat find shasum; do
  command -v "$cmd" >/dev/null 2>&1 || fail "缺少命令: $cmd"
done
ok "依赖命令 stat/find/shasum 存在"
if command -v mdfind >/dev/null 2>&1; then
  ok "mdfind 存在（macOS）"
  HAS_MDFIND=1
else
  echo "（mdfind 不存在，跳过 Spotlight 用例）"
  HAS_MDFIND=0
fi

# 2. 测试文件
if [ -z "$TEST_FILE" ]; then
  TMP_DIR="$(mktemp -d)"
  TEST_FILE="$TMP_DIR/dragpasteall-冒烟-测试.md"
  printf '# smoke\n' > "$TEST_FILE"
fi
[ -f "$TEST_FILE" ] || fail "测试文件不存在: $TEST_FILE"
SIZE="$(stat -f '%z' "$TEST_FILE" 2>/dev/null || stat -c '%s' "$TEST_FILE")"
ok "stat 大小读取: $SIZE"

# 3. stat 格式 '%z|%m'（Host 侧 matchCandidates 依赖）
STAT_OUT="$(stat -f '%z|%m' "$TEST_FILE")"
case "$STAT_OUT" in
  *\|*) ok "stat '%z|%m' 输出格式: $STAT_OUT" ;;
  *) fail "stat '%z|%m' 输出格式异常: $STAT_OUT（非 macOS 需改用 stat -c）" ;;
esac

# 4. 指纹口径：无条件 head+tail 拼接 shasum（与 Client 侧 slice 拼接一致）
HASH_SHELL="$({ head -c 1048576 "$TEST_FILE"; tail -c 1048576 "$TEST_FILE"; } | shasum -a 256 | awk '{print $1}')"
HASH_NODE="$(node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const p = process.argv[1]
const buf = readFileSync(p)
const HEAD = 1048576
const a = buf.subarray(0, Math.min(HEAD, buf.length))
const b = buf.subarray(Math.max(0, buf.length - HEAD), buf.length)
console.log(createHash('sha256').update(Buffer.concat([a, b])).digest('hex'))
" "$TEST_FILE")"
if [ -n "$HASH_NODE" ] && [ "$HASH_SHELL" = "$HASH_NODE" ]; then
  ok "指纹口径一致: $HASH_SHELL"
else
  fail "指纹口径不一致: shell=$HASH_SHELL node=$HASH_NODE"
fi

# 5. mdfind 精确查询（macOS）
if [ "$HAS_MDFIND" = "1" ]; then
  NAME="$(basename "$TEST_FILE")"
  HIT="$(mdfind "kMDItemFSName == '$NAME'" 2>/dev/null | head -1)"
  if [ -n "$HIT" ]; then
    ok "mdfind 命中: $HIT"
  else
    echo "（mdfind 未命中——Spotlight 未索引该路径，属正常）"
  fi
fi

echo ""
echo "全部通过 ✅"
