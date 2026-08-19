#!/usr/bin/env bash
# CI：语法检查 + 冒烟测试（GitHub Actions 使用）
set -euo pipefail

echo "== node --check =="
node --check lib/index.js
node --check lib/client.js

echo "== ESM 加载 =="
node --input-type=module -e "
const m = await import('./lib/index.js')
if (m.name !== 'dsdragpasteall') throw new Error('plugin name mismatch')
if (typeof m.apply !== 'function') throw new Error('apply missing')
console.log('plugin:', m.name, '/ inject:', m.inject.join(','))
"

echo "== 冒烟测试 =="
bash scripts/smoke-test.sh

echo "== 全部通过 =="
