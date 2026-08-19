# 架构说明

## 模块划分

```
lib/index.js    Host 半（Node 进程）
lib/client.js   Client 半（浏览器 bundle，window.__ModuleLoader__.load）
cordis.patch.yml  bundle patch：挂载插件行
install.sh      一键安装到 dsh web profile（幂等）
registry.yml    dshmarket 市场清单
```

## 数据流

```
拖拽 / ⌘V 粘贴
  │  Client：document 捕获阶段监听（先于内置"仅图片"处理，preventDefault + stopPropagation）
  ▼
Client 计算轻量指纹：首 1MiB + 尾 1MiB 拼接 SHA-256（crypto.subtle，大文件零压力）
  │  POST /dragpasteall/api { op: 'register', name, size, mtime, fhash }
  ▼
Host 反查：
  1. mdfind "kMDItemFSName == '<name>'"（Spotlight，秒级全盘）
  2. find ~/Desktop ~/Documents ~/Downloads（常规目录兜底）
  3. stat -f '%z|%m' 比对大小与 mtime
  4. { head -c 1M; tail -c 1M; } | shasum -a 256 比对指纹
  ├─ 命中 → source: 'resolved'，只登记路径
  └─ 未命中 → { op: 'content', chunk } 分块 base64 → base64 -d 写 ~/.dsh/dragpasteall-cache
  ▼
Client：路径插入输入框（execCommand insertText → 原生 setter + input 事件兜底）
  ├─ 输入框锁定（AI 运行中）→ 路径排队，interval 800ms 轮询，解锁后自动插入
  └─ 发送消息 → Agent 按路径读取文件
```

## 关键设计

### 指纹口径一致性（易错点）
Client 用 `file.slice(0, 1MiB) ++ file.slice(size-1MiB, size)` 拼 SHA-256；
Host 用 `{ head -c 1048576; tail -c 1048576; } | shasum -a 256`。
**两边都是无条件 head+tail**：小文件重叠拼接（同一文件拼两次），两侧结果一致。
若只改一侧（例如小文件省略 tail），反查将永远 miss。

### 捕获阶段接管
dsh 内置 UI 在 `document` 冒泡阶段监听拖放且仅接受图片（"仅支持 PNG、JPG、WebP、GIF"）。
本插件监听器全部以 `capture: true` 注册在捕获阶段（先于冒泡），命中文件即
`preventDefault + stopPropagation`，内置处理收不到事件。

### 输入框锁定与排队
AI 运作时 dsh 将输入框置为 `readOnly`，任何注入都会被 React 状态还原。
方案：锁定时不插入，路径入队；`interval(800ms)` 轮询检测解锁后逐个插入。

### 信任围栏
`/dragpasteall/api` 仅接受回环 / trustedHosts 来源，拒绝跨站（sec-fetch-site）
与 Origin 不一致请求——与 dsh /api 网关同一信任模型。

### 持久化
收件箱登记写入 `~/.dsh/dragpasteall-inbox.json`（每次变更全量写），启动时加载
并恢复 `nextId` 计数；缓存文件在 `~/.dsh/dragpasteall-cache/`。

## 平台差异

- macOS：mdfind + stat -f + shasum，反查命中率最高。
- 其他平台：mdfind 不存在时自动跳过，走 find + stat 常规目录；仍可缓存兜底。
- 指纹依赖 `crypto.subtle`（secure context）；非 localhost 访问时 Client 回退
  为无指纹模式（仅 name+size+mtime 匹配）。
