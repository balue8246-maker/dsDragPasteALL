# dsDragPasteALL

拖拽/粘贴本机**任意类型**文件到 DSH 页面（zip / Word / MD / PPTX / 视频…），
后台静默反查文件在磁盘上的**真实路径**，并把路径直接插入对话框输入框——
就像 Codex 里拖文件一样无感，实际不复制内容、不占空间。

## 工作方式

```
拖拽 / ⌘V 粘贴
   │  浏览器 document 捕获阶段接管（先于 dsh 内置"仅图片"处理）
   ▼
计算轻量指纹（首 1MiB + 尾 1MiB 拼接 SHA-256，大文件零压力）
   │  POST /dragpasteall/api { op: 'register' }
   ▼
Host 反查真实路径：mdfind（Spotlight 秒级全盘）→ find（桌面/文稿/下载兜底）
   → stat 比对大小+mtime → shasum 比对指纹
   ├─ 命中 → 只登记路径（不复制内容）
   └─ 未命中 → 分块 base64 上传，缓存到 ~/.dsh/dragpasteall-cache 兜底
   ▼
路径自动插入输入框 → 发送 → Agent 按路径直接读取文件
```

## 特性

- **任意文件类型**：不受 DSH 内置"仅支持 PNG/JPG/WebP/GIF 图片"限制；
- **路径优先**：桌面/文稿/下载等常规位置的文件 100% 反查真实路径，零复制；
- **缓存兜底**：藏在犄角旮旯或已改名的文件，内容缓存后仍可被读取；
- **多文件**：一次拖入多个文件，每个文件一行路径；
- **无感反馈**：全屏拖放浮层 + 右下角轻量 toast，无多余 UI；
- **收件箱持久化**：导入登记存 `~/.dsh/dragpasteall-inbox.json`，重启不丢；
- **Agent 工具**：`dragpasteall_inbox` 可随时查看全部导入记录（真实路径/缓存副本）。

## 安装（profile web）

```bash
# 1. 在 ~/.dsh/profiles/web 下执行
pnpm add "file:/Users/acegent/Documents/ds 插件/dsDragPasteALL"

# 2. 编辑 ~/.dsh/profiles/web/package.json，在 dsh.profile.bundles 里加入：
#    "dsdragpasteall"

# 3. 重启 dsh web 生效
```

## 布局

```
lib/index.js    Host 半：反查/缓存/持久化、/dragpasteall/api 路由、dragpasteall_inbox 工具
lib/client.js   Client 半：捕获阶段事件接管、指纹计算、路径插入输入框、拖放浮层与 toast
cordis.patch.yml  bundle patch：挂载插件行
```

## 平台

macOS 优先（mdfind / stat -f / shasum）；非 macOS 自动退化为 find + stat 常规目录，
仍走缓存兜底路径。

## 开发

```bash
bash scripts/smoke-test.sh   # 反查命令链路冒烟测试（依赖/stat 格式/指纹口径/mdfind）
bash scripts/ci.sh           # 语法检查 + ESM 加载 + 冒烟测试（GitHub Actions 同款）
```

## 许可

MIT © balue8246-maker — 详见 [LICENSE](LICENSE)。

