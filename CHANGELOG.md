# Changelog

## 1.0.0 — 2026-08-20

- 首次发布：拖拽/粘贴本机任意文件到 DSH 页面。
- 路径反查：mdfind（Spotlight 秒级全盘）→ find（桌面/文稿/下载兜底）→ stat 比对大小与 mtime → shasum 比对首尾 1MiB 指纹，命中即只登记路径、不复制内容。
- 缓存兜底：反查未命中时客户端分块 base64 上传，缓存到 `~/.dsh/dragpasteall-cache`。
- 路径插入输入框：命中后路径直接写入对话框草稿（受控 textarea 原生注入）。
- 排队插入：AI 运行中（输入框锁定）拖入的文件路径排队，解锁后自动插入。
- 捕获阶段接管：先于 dsh 内置"仅图片"拖放处理执行，任意文件类型可导入。
- 持久化收件箱：`~/.dsh/dragpasteall-inbox.json`，重启不丢。
- Agent 工具：`dragpasteall_inbox` 查看全部导入记录。
