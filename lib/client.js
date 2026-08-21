/**
 * dsDragPasteALL — client half。
 *
 * 形态：client bundle 纯度门约束下的手写 bundle（window.__ModuleLoader__.load），
 * factory 只 require 平台种子词（react / react-dom，见 dsh-client-web 的
 * PLATFORM_MODULES），不跨插件 value import，不引第三方依赖。
 *
 * 职责：
 *  - 在浏览器 document 捕获阶段接管 dragenter/dragover/dragleave/drop/paste，
 *    先于 dsh 内置"仅图片"拖放处理执行（preventDefault + stopPropagation），
 *    因此任意文件类型都可导入；
 *  - 粘贴策略：仅拦截"含非图片文件"的粘贴（如从 Finder 复制的 pdf/docx/zip 等），
 *    纯图片粘贴（截图 / 复制的图片）一律放行给 dsh 原生粘贴流程 → 成为图片附件，
 *    由识图插件（dseyesopen）自动识别——不让本插件抢走截图 Cmd+V 的成图体验；
 *    输入框锁定（AI 运行中）时原生会忽略图片粘贴，本插件改为排队，
 *    解锁后以合成 paste 事件补发给原生成图流程（不降级为路径文本）；
 *  - 计算文件轻量指纹（首 1MiB + 尾 1MiB 拼接 SHA-256），POST /dragpasteall/api
 *    反查真实路径；命中后把路径直接插入对话框输入框（受控 textarea 原生注入）；
 *    未命中则分块 base64 上传走缓存兜底；
 *  - 挂载点：官方 list slot shell.overlay（全屏拖放浮层 + 右下角轻量 toast）。
 */
window.__ModuleLoader__.load({
  id: 'dsdragpasteall',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')
    const { useState, useEffect, useCallback, useRef } = React

    // ---- 样式（一次性注入；.dp- 前缀防污染 shell） ----
    const STYLE_TEXT = [
      '.dp-veil{position:fixed;inset:0;z-index:9999;pointer-events:none;display:flex;align-items:center;justify-content:center;background:rgba(15,25,45,.5);backdrop-filter:blur(2px)}',
      '.dp-veil-inner{padding:28px 48px;border:3px dashed rgba(120,180,255,.9);border-radius:16px;background:rgba(15,25,45,.9);color:#dbe7ff;font-size:18px;font-weight:600;box-shadow:0 12px 40px rgba(0,0,0,.35)}',
      '.dp-toast{position:fixed;right:16px;bottom:16px;z-index:9998;max-width:420px;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;box-shadow:0 8px 30px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.12);background:rgba(24,28,40,.94);color:#e8ecf4;word-break:break-all}',
      '.dp-toast-ok{border-color:rgba(90,220,140,.35)}',
      '.dp-toast-busy{border-color:rgba(255,200,90,.35);color:#ffd98a}',
      '.dp-toast-err{border-color:rgba(255,120,120,.4);color:#ffb0b0}',
    ]
    let styleInjected = false
    function ensureStyles() {
      if (styleInjected) return
      const tag = document.createElement('style')
      tag.textContent = STYLE_TEXT.join('')
      document.head.appendChild(tag)
      styleInjected = true
    }

    // ---- Client → Host API（同源 fetch） ----
    async function api(op, args) {
      const res = await fetch('/dragpasteall/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(Object.assign({ op }, args || {})),
      })
      if (!res.ok) throw new Error('dragpasteall api ' + res.status)
      return res.json()
    }

    const readSlice = async (file, start, end) => {
      const blob = file.slice(start, end)
      return new Uint8Array(await blob.arrayBuffer())
    }

    // 轻量指纹：首 1MiB + 尾 1MiB 拼接 SHA-256（与 Host 端无条件 head+tail 的 shasum
    // 口径一致；小文件重叠拼接，两侧相同）
    const fhashOf = async (file) => {
      try {
        if (!window.crypto || !window.crypto.subtle) return ''
        const HEAD = 1048576
        const a = await readSlice(file, 0, Math.min(HEAD, file.size))
        const b = await readSlice(file, Math.max(0, file.size - HEAD), file.size)
        const combined = new Uint8Array(a.length + b.length)
        combined.set(a, 0)
        combined.set(b, a.length)
        const digest = await window.crypto.subtle.digest('SHA-256', combined)
        return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, '0')).join('')
      } catch (err) {
        return ''
      }
    }

    const bytesToB64 = (bytes) => {
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      }
      return window.btoa(bin)
    }

    // 把文本插入输入框（受控 textarea：原生 setter + input 事件触发 React onChange）
    const insertIntoComposer = (text) => {
      const ta = window.document.querySelector('[data-composer-card] textarea')
      if (!ta) return false
      ta.focus()
      try {
        if (window.document.execCommand && window.document.execCommand('insertText', false, text)) return true
      } catch (err) { /* fallthrough */ }
      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, ta.value + text)
        ta.dispatchEvent(new window.Event('input', { bubbles: true }))
        return true
      } catch (err) {
        return false
      }
    }

    // 用合成 paste 事件把排队的图片补交给 dsh 原生成图流程（ClipboardEvent + DataTransfer，
    // 复用 composer 的 intakeImages → 真图片附件；React 根部委托监听，bubbles 可达）
    const dispatchImagePaste = (files) => {
      try {
        const ta = window.document.querySelector('[data-composer-card] textarea')
        if (!ta) return false
        const dt = new window.DataTransfer()
        for (const f of files) dt.items.add(f)
        const ev = new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
        ta.focus()
        ta.dispatchEvent(ev)
        return true
      } catch (err) {
        console.error('[dsdragpasteall] synthetic paste failed', err)
        return false
      }
    }

    const copyText = (text) => new Promise((resolve) => {
      const done = () => resolve(true)
      const fallback = () => {
        try {
          const ta = window.document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          window.document.body.appendChild(ta)
          ta.select()
          window.document.execCommand('copy')
          ta.remove()
          done()
        } catch (err) {
          resolve(false)
        }
      }
      try {
        if (window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText) {
          window.navigator.clipboard.writeText(text).then(done).catch(fallback)
        } else {
          fallback()
        }
      } catch (err) {
        fallback()
      }
    })

    // ---- 主组件 ----
    let appCtx = null

    function DropIn() {
      const [dragging, setDragging] = useState(false)
      const [toast, setToast] = useState(null)
      const depthRef = useRef(0)
      const toastTimer = useRef(null)
      const pendingRef = useRef([]) // AI 运行中（输入框锁定）时排队的路径
      const pendingImagesRef = useRef([]) // AI 运行中（输入框锁定）时排队的图片文件（解锁后原生成图补发）

      const flash = (text, kind) => {
        if (toastTimer.current) {
          toastTimer.current()
          toastTimer.current = null
        }
        setToast({ text, kind: kind || 'ok' })
        toastTimer.current = appCtx.timeout(() => {
          setToast(null)
          toastTimer.current = null
        }, 4000)
      }

      const ingest = async (fileList) => {
        const files = Array.from(fileList)
        for (const f of files) {
          try {
            flash('正在定位：' + f.name, 'busy')
            const fhash = await fhashOf(f)
            const reg = await api('register', {
              name: f.name,
              size: f.size,
              mtime: Math.floor(f.lastModified / 1000),
              fhash,
            })
            if (!reg || !reg.ok) {
              flash('导入失败：' + f.name + (reg && reg.error ? ' — ' + reg.error : ''), 'err')
              continue
            }
            if (reg.needContent) {
              flash('未找到原文件，正在缓存：' + f.name, 'busy')
              const CHUNK = 3 * 1024 * 1024
              const total = Math.max(1, Math.ceil(f.size / CHUNK))
              for (let i = 0; i < total; i++) {
                const bytes = await readSlice(f, i * CHUNK, Math.min((i + 1) * CHUNK, f.size))
                await api('content', { id: reg.id, chunk: bytesToB64(bytes), done: i === total - 1 })
              }
            }
            const path = reg.entry && reg.entry.path
            if (!path) {
              flash('导入失败：' + f.name, 'err')
              continue
            }
            // 输入框解锁（AI 空闲）时直接插入；锁定（AI 运作中）则排队等解锁后自动插入
            const inserted = insertIntoComposer(path + '\n')
            if (inserted) {
              flash('已插入路径：' + f.name, 'ok')
            } else {
              pendingRef.current.push(path)
              flash('AI 运行中，路径已排队（' + pendingRef.current.length + ' 个），结束后自动插入', 'busy')
            }
          } catch (err) {
            console.error('[dsdragpasteall] ingest failed', f.name, err)
            flash('导入失败：' + f.name, 'err')
          }
        }
      }

      useEffect(() => {
        const doc = window.document
        const hasFiles = (dt) => {
          try {
            return dt && dt.types && Array.prototype.indexOf.call(dt.types, 'Files') >= 0
          } catch (err) {
            return false
          }
        }
        // 捕获阶段接管：dsh 内置 UI 在 document 冒泡阶段监听拖放且仅接受图片，
        // 捕获阶段 preventDefault + stopPropagation 可在其执行前拦截任意文件
        const onDragEnter = (ev) => {
          if (!hasFiles(ev.dataTransfer)) return
          ev.preventDefault()
          ev.stopPropagation()
          depthRef.current++
          setDragging(true)
        }
        const onDragOver = (ev) => {
          if (!hasFiles(ev.dataTransfer)) return
          ev.preventDefault()
          ev.stopPropagation()
        }
        const onDragLeave = () => {
          depthRef.current = Math.max(0, depthRef.current - 1)
          if (depthRef.current === 0) setDragging(false)
        }
        const onDrop = (ev) => {
          depthRef.current = 0
          setDragging(false)
          if (!ev.dataTransfer || !ev.dataTransfer.files || ev.dataTransfer.files.length === 0) return
          ev.preventDefault()
          ev.stopPropagation()
          const fileList = Array.from(ev.dataTransfer.files)
          ingest(fileList)
        }
        const onPaste = (ev) => {
          const files = ev.clipboardData && ev.clipboardData.files
          if (!files || files.length === 0) return
          const list = Array.from(files)
          // 纯图片粘贴（macOS/Windows 截图、复制的图片）→ 交还 dsh 原生粘贴流程，
          // 成为真图片附件（dseyesopen 识图依赖此链路）；本插件只接管含非图片文件的粘贴。
          if (list.every((f) => f.type && f.type.startsWith('image/'))) {
            // 输入框锁定（AI 运行中）时原生流程会忽略粘贴 → 本插件接管并排队，
            // 解锁后以合成 paste 事件补发，仍走原生成图（不降级为路径文本）。
            const ta = window.document.querySelector('[data-composer-card] textarea')
            if (ta && (ta.readOnly || ta.disabled)) {
              ev.preventDefault()
              ev.stopPropagation()
              pendingImagesRef.current.push(list)
              flash('AI 运行中，截图已排队（' + pendingImagesRef.current.length + ' 张），结束后自动插入', 'busy')
            }
            return
          }
          ev.preventDefault()
          ev.stopPropagation()
          ingest(list)
        }
        doc.addEventListener('dragenter', onDragEnter, true)
        doc.addEventListener('dragover', onDragOver, true)
        doc.addEventListener('dragleave', onDragLeave, true)
        doc.addEventListener('drop', onDrop, true)
        doc.addEventListener('paste', onPaste, true)
        // 排队内容自动补发：输入框解锁（AI 空闲）后逐个插入——路径直接注入草稿，
        // 图片用合成 paste 事件补交给原生成图流程
        const flushIv = appCtx.interval(() => {
          const q = pendingRef.current
          const iq = pendingImagesRef.current
          if (q.length === 0 && iq.length === 0) return
          const ta = window.document.querySelector('[data-composer-card] textarea')
          if (!ta || ta.readOnly || ta.disabled) return
          let flushed = 0
          while (q.length > 0) {
            const p = q[0]
            if (!insertIntoComposer(p + '\n')) break
            q.shift()
            flushed++
          }
          if (flushed > 0 && q.length === 0) {
            flash('已自动插入排队的 ' + flushed + ' 个路径', 'ok')
          }
          let flushedImages = 0
          while (iq.length > 0) {
            const files = iq[0]
            if (!dispatchImagePaste(files)) break
            iq.shift()
            flushedImages++
          }
          if (flushedImages > 0) {
            flash('已自动插入排队的 ' + flushedImages + ' 张截图', 'ok')
          }
        }, 800)
        return () => {
          doc.removeEventListener('dragenter', onDragEnter, true)
          doc.removeEventListener('dragover', onDragOver, true)
          doc.removeEventListener('dragleave', onDragLeave, true)
          doc.removeEventListener('drop', onDrop, true)
          doc.removeEventListener('paste', onPaste, true)
          flushIv()
          if (toastTimer.current) {
            toastTimer.current()
            toastTimer.current = null
          }
        }
      }, [])

      return React.createElement(React.Fragment, null,
        dragging ? React.createElement('div', { className: 'dp-veil' },
          React.createElement('div', { className: 'dp-veil-inner' }, '松开鼠标，导入文件到 DSH'),
        ) : null,
        toast ? React.createElement('div', { className: 'dp-toast dp-toast-' + (toast.kind || 'ok') }, toast.text) : null,
      )
    }

    // ---- client 插件入口 ----
    /** 需要 client runtime 提供的服务：slots（挂 shell.overlay 浮层）+ timer（toast 定时）。 */
    const inject = ['slots', 'timer']

    function apply(ctx) {
      ensureStyles()
      appCtx = ctx
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsdragpasteall-overlay',
      }, () => React.createElement(DropIn, null))), 'dsdragpasteall: overlay')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
