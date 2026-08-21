# dsDragPasteALL

拖拽/粘贴本机**任意类型**文件到 DSH 页面（zip / Word / MD / PPTX / 视频…），
后台静默反查文件在磁盘上的**真实路径**，并把路径直接插入对话框输入框——
就像 Codex 里拖文件一样无感，实际不复制内容、不占空间。

> **与识图插件（dseyesopen）的协作**：**纯图片粘贴**（macOS/Windows 截图 ⌘V、
> 复制的图片文件）一律放行给 dsh 原生粘贴流程，成为**真图片附件**，由
> dseyesopen 自动识别——拖拽仍然全类型接管。只有**含非图片文件**的粘贴
> （Finder 复制的 pdf/docx/zip 等）才由本插件反查路径插入。
> AI 运行中（输入框锁定）粘贴截图也不会丢：图片排队，解锁后自动补发成图。

## 工作方式

```
拖拽任意文件 / ⌘V 粘贴含非图片文件
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

- **任意文件类型**：拖拽不受 DSH 内置"仅支持 PNG/JPG/WebP/GIF 图片"限制；
- **粘贴分流**：纯图片粘贴交还 dsh 原生流程（成图附件、识图插件可用），
  含非图片文件的粘贴才由本插件接管反查路径；
- **锁定排队**：AI 运行中拖入的文件路径、粘贴的截图都会排队，解锁后自动插入
  （截图以合成 paste 事件补发给原生成图，不降级为路径文本）；
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

**改代码后如何让已安装的 profile 生效**（重要，易踩坑）：
`pnpm add "file:..."` 对 file: 目录依赖创建的是**硬链接**——用编辑器/工具
"复制+替换"方式改源码会换掉 inode，硬链接随即断开，安装副本停留在旧内容，
页面刷新后仍是旧行为（表现：改了 client 半但完全不生效）。修改源码后请执行：

```bash
cd ~/.dsh/profiles/web
rm -rf node_modules/dsdragpasteall && pnpm install   # 重新硬链接全部文件
# 或直接覆盖同步（更快）：
cp "/path/to/dsDragPasteALL/lib/client.js" node_modules/dsdragpasteall/lib/client.js
```

然后**硬刷新页面**（⌘⇧R）即可，无需重启 dsh web——client bundle 由
`/plugins/<id>/client.js` 路由按请求实时读取（`cache-control: no-cache`）。

## 许可

MIT © balue8246-maker — 详见 [LICENSE](LICENSE)。

