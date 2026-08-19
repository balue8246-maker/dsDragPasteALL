/**
 * dsDragPasteALL — 拖拽/粘贴本机任意文件到 DSH 页面，静默反查真实路径并插入输入框。
 *
 * 流程：
 *  1. Client 半（lib/client.js）在浏览器捕获阶段接管 dragenter/dragover/drop/paste，
 *     计算文件轻量指纹（首 1MiB + 尾 1MiB 拼接 SHA-256，与 shasum head/tail 口径一致）；
 *  2. POST /dragpasteall/api { op: 'register' } → 本插件按 文件名 → mdfind / find 候选 →
 *     stat 比对大小与 mtime → shasum 比对指纹 反查真实绝对路径；
 *  3. 命中 → 只记录路径（不复制内容）；未命中 → 客户端分块 base64 上传，缓存到
 *     ~/.dsh/dragpasteall-cache，记录缓存路径兜底；
 *  4. Client 把路径插入输入框，Agent 收到消息后按路径读取；
 *  5. 收件箱登记持久化在 ~/.dsh/dragpasteall-inbox.json，dragpasteall_inbox 工具可查全部导入。
 *
 * 平台：macOS 优先（mdfind/stat -f/shasum），非 macOS 自动退化为 find + stat 常规目录。
 */
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsdragpasteall'
export const inject = ['tools', 'webServer', 'webRuntime']

const CACHE_DIR = join(homedir(), '.dsh', 'dragpasteall-cache')
const STATE_PATH = join(homedir(), '.dsh', 'dragpasteall-inbox.json')

const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const dq = (s) => '"' + String(s).replace(/"/g, '\\"') + '"'

export function apply(ctx) {
  const shell = ctx.get('shell')
  if (shell === undefined) return

  // ---- 收件箱（内存 + 磁盘持久化） ----
  const inbox = new Map()
  let nextId = 1
  try {
    if (existsSync(STATE_PATH)) {
      const arr = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
      if (Array.isArray(arr)) {
        for (const it of arr) {
          if (!it || typeof it.id !== 'string' || typeof it.name !== 'string') continue
          inbox.set(it.id, { _dir: CACHE_DIR, ...it })
          const n = parseInt(String(it.id).replace(/^\D*/, ''), 10)
          if (!Number.isNaN(n) && n >= nextId) nextId = n + 1
        }
      }
    }
  } catch (err) {
    console.error('[dsdragpasteall] inbox load failed', err)
  }
  const save = () => {
    try {
      const arr = [...inbox.values()].map((e) => ({
        id: e.id, name: e.name, size: e.size, mtime: e.mtime, fhash: e.fhash,
        status: e.status, source: e.source, path: e.path, warning: e.warning,
        received: e.received, chunks: e.chunks, addedAt: e.addedAt,
      }))
      mkdirSync(join(homedir(), '.dsh'), { recursive: true })
      writeFileSync(STATE_PATH, JSON.stringify(arr, null, 2))
    } catch (err) {
      console.error('[dsdragpasteall] inbox save failed', err)
    }
  }

  // ---- shell 工具 ----
  const run = async (command, timeoutMs) => {
    const spec = shell.resolve({ command, timeoutMs: timeoutMs || 30000, stdoutMaxBytes: 4 * 1024 * 1024 })
    const res = await shell.run(spec)
    return { code: res.exitCode, out: (res.stdout && res.stdout.text) || '', err: (res.stderr && res.stderr.text) || '' }
  }
  const targetPath = (e) => e._dir + '/' + e.id + '-' + String(e.name).replace(/[\\/]/g, '_')
  const summary = (e) => ({
    id: e.id, name: e.name, size: e.size, mtime: e.mtime, path: e.path || null,
    source: e.source, status: e.status, warning: e.warning || null, addedAt: e.addedAt,
  })

  // 与客户端同口径的轻量指纹：首 1MiB + 尾 1MiB 拼接后的 SHA-256（无条件 head+tail）
  const fhashOf = async (p) => {
    const r = await run('{ head -c 1048576 ' + sq(p) + '; tail -c 1048576 ' + sq(p) + '; } | shasum -a 256', 30000)
    if (r.code !== 0) return null
    const h = (r.out || '').split(/\s+/)[0]
    return h ? h.toLowerCase() : null
  }
  const matchCandidates = async (paths, e) => {
    for (const p of paths) {
      const st = await run("stat -f '%z|%m' " + sq(p), 5000)
      if (st.code !== 0) continue
      const parts = (st.out || '').trim().split('|')
      const sz = parts[0]
      const mt = parts[1]
      if (sz !== String(e.size)) continue
      if (e.mtime && mt && String(mt) !== String(e.mtime)) continue
      if (e.fhash) {
        const h = await fhashOf(p)
        if (h && h === e.fhash) return p
      } else {
        return p
      }
    }
    return null
  }
  const resolvePath = async (e) => {
    // 1. Spotlight（macOS 秒级全盘）
    const esc = String(e.name).replace(/'/g, "\\'")
    for (const q of ["kMDItemFSName == '" + esc + "'", "kMDItemFSName ==[c] '" + esc + "'"]) {
      const r = await run('mdfind ' + dq(q) + ' 2>/dev/null | head -200', 8000)
      const lines = (r.out || '').split('\n').map((s) => s.trim()).filter(Boolean)
      if (lines.length === 0) continue
      const hit = await matchCandidates(lines, e)
      if (hit) return hit
    }
    // 2. 常规目录 find 兜底
    const fe = String(e.name).replace(/([\[\]*?\\])/g, '\\$1')
    const home = homedir()
    const r = await run('find ' + sq(home + '/Desktop') + ' ' + sq(home + '/Documents') + ' ' + sq(home + '/Downloads') + ' -maxdepth 6 -type f -name ' + sq(fe) + ' 2>/dev/null | head -200', 20000)
    const lines = (r.out || '').split('\n').map((s) => s.trim()).filter(Boolean)
    return matchCandidates(lines, e)
  }

  // ---- 业务 ----
  async function handleRegister(a) {
    if (typeof a.name !== 'string' || !a.name) return { ok: false, error: 'missing file name' }
    const e = {
      id: 'd' + (nextId++),
      name: a.name,
      size: typeof a.size === 'number' ? a.size : Number(a.size) || 0,
      mtime: typeof a.mtime === 'number' ? a.mtime : Number(a.mtime) || 0,
      fhash: typeof a.fhash === 'string' ? a.fhash : '',
      status: 'pending',
      source: null,
      path: null,
      warning: null,
      received: 0,
      chunks: 0,
      addedAt: Date.now(),
      _dir: CACHE_DIR,
    }
    const hit = await resolvePath(e)
    if (hit) {
      e.status = 'ready'
      e.source = 'resolved'
      e.path = hit
      inbox.set(e.id, e)
      save()
      console.log('[dsdragpasteall] resolved', e.name, '->', hit)
      return { ok: true, needContent: false, entry: summary(e) }
    }
    inbox.set(e.id, e)
    save()
    console.log('[dsdragpasteall] cache fallback', e.name)
    return { ok: true, needContent: true, id: e.id, entry: summary(e) }
  }

  async function handleContent(a) {
    const e = inbox.get(a.id)
    if (!e) return { ok: false, error: 'unknown id' }
    if (typeof a.chunk !== 'string') return { ok: false, error: 'chunk must be a string' }
    if (a.chunk.length === 0 && !a.done) return { ok: false, error: 'empty chunk' }
    const tp = targetPath(e)
    if (e.chunks === 0) {
      await run('mkdir -p ' + sq(e._dir), 5000)
      await run(': > ' + sq(tp), 5000)
    }
    const r = await run("printf '%s' " + sq(a.chunk) + ' | base64 -d >> ' + sq(tp), 60000)
    if (r.code !== 0) return { ok: false, error: 'write failed: ' + r.err.slice(0, 200) }
    e.chunks++
    e.received += Math.floor(a.chunk.length * 3 / 4)
    if (a.done) {
      e.status = 'ready'
      e.source = 'cached'
      e.path = tp
      const st = await run("stat -f '%z' " + sq(tp), 5000)
      if (st.code === 0 && (st.out || '').trim() !== String(e.size)) {
        e.warning = 'size mismatch: expected ' + e.size + ', got ' + (st.out || '').trim()
      }
      save()
      console.log('[dsdragpasteall] cached', e.name, '->', tp)
    }
    return { ok: true, entry: summary(e) }
  }

  function handleList() {
    const files = [...inbox.values()].filter((e) => e.status === 'ready').map(summary)
    return { ok: true, files }
  }

  async function handleRemove(a) {
    const e = inbox.get(a.id)
    if (!e) return { ok: false, error: 'unknown id' }
    inbox.delete(e.id)
    if (e.source === 'cached' && e.path) await run('rm -f ' + sq(e.path), 5000)
    save()
    return { ok: true }
  }

  // ---- /dragpasteall/api（Client → Host，同源 fetch + 信任围栏） ----
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dragpasteall/api',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, ctx.webRuntime ? ctx.webRuntime.trustedHosts : [])) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readJsonBody(req, 64 << 20)
      } catch (err) {
        writeJson(res, 400, { ok: false, error: 'bad request body' })
        return
      }
      const op = body && body.op
      try {
        if (op === 'register') writeJson(res, 200, await handleRegister(body))
        else if (op === 'content') writeJson(res, 200, await handleContent(body))
        else if (op === 'list') writeJson(res, 200, handleList())
        else if (op === 'remove') writeJson(res, 200, await handleRemove(body))
        else writeJson(res, 404, { ok: false, error: 'unknown op' })
      } catch (err) {
        console.error('[dsdragpasteall] api error', err)
        writeJson(res, 500, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
      }
    },
  }), 'dsdragpasteall: api')

  // ---- Agent 工具：查看收件箱 ----
  ctx.tools.register({
    name: 'dragpasteall_inbox',
    description:
      '查看拖放收件箱：用户拖拽文件到 DSH 页面或复制文件后粘贴导入的所有本地文件，' +
      '含每个文件的真实绝对路径、来源（resolved=反查到的真实文件 / cached=内容缓存副本）与大小。' +
      '用户刚拖入/粘贴文件后调用本工具取得路径，再用 read 等工具按路径读取。',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const files = (value && value.files) || []
        const lines = files.map((f) => '- [' + (f.source === 'resolved' ? '真实路径' : '缓存副本') + '] ' + f.name + ' (' + f.size + ' B) → ' + f.path)
        return [{ type: 'text', text: lines.length ? lines.join('\n') : '（收件箱为空）' }]
      },
    },
    async execute() {
      const files = [...inbox.values()].filter((e) => e.status === 'ready').map(summary)
      return { files, count: files.length }
    },
  })
}

// ---- webServer 辅助（与 dsh /api 网关同一信任模型） ----
function headerValue(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL('http://' + authority)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL('https://' + entry).port
  return port === '' ? entryUrl.hostname : entryUrl.hostname + ':' + port
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return (Array.isArray(trustedHosts) ? trustedHosts : []).some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (!entryUrl) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = headerValue(request.headers, 'host')
  if (!host) return false
  const hostUrl = parseAuthority(host)
  if (!hostUrl) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (headerValue(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerValue(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

async function readJsonBody(req, maxBytes = 1 << 20) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}
