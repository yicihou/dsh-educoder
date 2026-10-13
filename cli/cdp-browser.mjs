#!/usr/bin/env node
/**
 * 零依赖 CDP 浏览器驱动（macOS + Microsoft Edge / 任意 Chromium）。
 *
 * 用 Chrome DevTools Protocol 直接驱动浏览器，不需要 playwright/puppeteer：
 * 运行时的 Node（v22+）自带全局 WebSocket，这里只用内置模块。
 *
 * 用法（浏览器进程常驻，各子命令独立连接）：
 *   node cdp-browser.mjs start [--headful] [--port 9333] [--url <url>]
 *                                 [--load-ext <已解压扩展目录>]  # 启动时加载（未打包）扩展
 *   node cdp-browser.mjs goto <url>
 *   node cdp-browser.mjs text  [--max 4000] [--selector body]
 *   node cdp-browser.mjs eval  "<javascript>"        # 返回表达式结果
 *   node cdp-browser.mjs click "<CSS 选择器 | 可见文字>"
 *   node cdp-browser.mjs type  "<CSS 选择器>" "<文本>"
 *   node cdp-browser.mjs shot  <输出.png> [--full]
 *   node cdp-browser.mjs tabs
 *   node cdp-browser.mjs stop
 *
 * 状态文件：<workspace>/.cdp-browser/state.json（含端口、profile 目录、日志路径）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const STATE_DIR = join(ROOT, '.cdp-browser')
const STATE_FILE = join(STATE_DIR, 'state.json')
const PROFILE_DIR = join(STATE_DIR, 'profile')
const LOG_FILE = join(STATE_DIR, 'browser.log')

const CANDIDATES = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadState() {
  if (!existsSync(STATE_FILE)) return null
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function findBrowser() {
  const found = CANDIDATES.find((p) => existsSync(p))
  if (!found) throw new Error(`找不到 Chromium 内核浏览器，候选：\n  ${CANDIDATES.join('\n  ')}`)
  return found
}

async function httpJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
  return await res.json()
}

/** 连接一个 target 的 CDP 会话；返回 send(method, params) 与 close()。 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  const events = []
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('WebSocket 建连超时（浏览器可能已卡死或无响应）')), 8000)
    ws.addEventListener('open', () => { clearTimeout(timer); ok() }, { once: true })
    ws.addEventListener('error', (e) => { clearTimeout(timer); fail(new Error(`WebSocket 连接失败: ${e?.message ?? 'error'}`)) }, { once: true })
  })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? fail(new Error(`${msg.error.message} (${msg.error.code})`)) : ok(msg.result)
    } else if (msg.method) {
      events.push(msg)
    }
  })
  const send = (method, params = {}, timeoutMs = 90000) => new Promise((ok, fail) => {
    const id = nextId++
    pending.set(id, { ok, fail })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); fail(new Error(`CDP 超时: ${method}`)) }
    }, timeoutMs)
  })
  return { send, close: () => ws.close(), events }
}

async function pageTarget(state) {
  const list = await httpJson(`http://127.0.0.1:${state.port}/json/list`)
  const pages = list.filter((t) => t.type === 'page')
  if (!pages.length) throw new Error('没有可用的 page target（浏览器可能已退出）')
  // 指定了匹配串就按 URL/标题匹配，否则默认用最新的标签页（新开的题目标签通常在最后）
  if (state.tabMatch) {
    const hit = pages.find((p) => (p.url || '').includes(state.tabMatch) || (p.title || '').includes(state.tabMatch))
    if (hit) return hit
  }
  return pages[pages.length - 1]
}

async function withPage(state, fn) {
  const page = await pageTarget(state)
  const session = await connect(page.webSocketDebuggerUrl)
  try {
    await session.send('Page.enable').catch(() => {})
    await session.send('Runtime.enable').catch(() => {})
    // 后台标签页拿不到键盘焦点：先把它切到前台，否则 Monaco 无法聚焦/全选
    await session.send('Page.bringToFront').catch(() => {})
    return await fn(session)
  } finally {
    session.close()
  }
}

async function evaluate(session, expression) {
  const r = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) throw new Error(`页面内报错: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  return r.result?.value
}

async function waitForLoad(session, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ready = await evaluate(session, 'document.readyState').catch(() => null)
    if (ready === 'complete' || ready === 'interactive') return true
    await sleep(250)
  }
  return false
}

// ---------------------------------------------------------------- 子命令

async function cmdStart(args) {
  const headful = args.includes('--headful')
  const portIdx = args.indexOf('--port')
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 9333
  const urlIdx = args.indexOf('--url')
  const url = urlIdx >= 0 ? args[urlIdx + 1] : 'about:blank'
  const extIdx = args.indexOf('--load-ext')
  const loadExt = extIdx >= 0 ? args[extIdx + 1] : undefined

  const existing = loadState()
  if (existing?.port) {
    try {
      await httpJson(`http://127.0.0.1:${existing.port}/json/version`)
      console.log(`浏览器已在运行：端口 ${existing.port}（${existing.headful ? '有窗口' : '无窗口'}）`)
      return
    } catch { /* 已退出，重新启动 */ }
  }

  const bin = findBrowser()
  mkdirSync(PROFILE_DIR, { recursive: true })
  const flags = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    // DSH 的 seatbelt 沙箱禁止 Chromium 初始化自己的沙箱（"sandbox initialization failed: Operation not permitted"），
    // 因此必须关掉浏览器自带沙箱；外层仍有 DSH 的文件沙箱兜底（写入限制在工作区内）。
    '--no-sandbox',
    '--disable-gpu',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-dev-shm-usage',
    // Chromium 111+ 要求显式放行非 DevTools 客户端的 WebSocket 来源
    '--remote-allow-origins=*',
    '--disable-popup-blocking',
    // 系统代理可能指向未运行的本地端口（DSH 的 23292），会导致 ERR_PROXY_CONNECTION_FAILED；
    // 这个自动化浏览器只访问直连可达的站点，直接绕过系统代理
    '--no-proxy-server',
    // 隐私：Edge 会因系统已登录微软账号而在新 profile 里自动登录并同步浏览数据，这里全部关掉
    '--disable-sync',
    '--no-service-autorun',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1440,900',
  ]
  if (!headful) flags.push('--headless=new')
  if (loadExt) flags.push(`--load-extension=${loadExt}`)
  flags.push(url)

  const fd = openSync(LOG_FILE, 'a')
  const child = spawn(bin, flags, { detached: true, stdio: ['ignore', fd, fd] })
  child.unref()
  saveState({ port, headful, bin, pid: child.pid, startedAt: new Date().toISOString() })

  for (let i = 0; i < 60; i++) {
    await sleep(400)
    try {
      const v = await httpJson(`http://127.0.0.1:${port}/json/version`)
      console.log(`已启动：${v.Browser}，端口 ${port}，${headful ? '有窗口（你可以登录/观看）' : '无窗口（headless）'}`)
      return
    } catch { /* 还没起来 */ }
  }
  throw new Error(`浏览器启动超时，日志：${LOG_FILE}`)
}

function requireState() {
  const state = loadState()
  if (!state) throw new Error('浏览器未启动，先执行: node cdp-browser.mjs start [--headful]')
  return state
}

async function cmdGoto(args) {
  const url = args[0]
  if (!url) throw new Error('用法: goto <url>')
  const state = requireState()
  const out = await withPage(state, async (s) => {
    await s.send('Page.navigate', { url })
    await waitForLoad(s)
    await sleep(500)
    return await evaluate(s, '({url: location.href, title: document.title})')
  })
  console.log(JSON.stringify(out, null, 2))
}

async function cmdText(args) {
  const maxIdx = args.indexOf('--max')
  const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 4000
  const selIdx = args.indexOf('--selector')
  const selector = selIdx >= 0 ? args[selIdx + 1] : 'body'
  const state = requireState()
  const text = await withPage(state, (s) => evaluate(s, `(document.querySelector(${JSON.stringify(selector)})?.innerText || '').slice(0, ${max})`))
  console.log(text)
}

async function cmdEval(args) {
  const expr = args.join(' ')
  if (!expr) throw new Error('用法: eval "<javascript>"')
  const state = requireState()
  const value = await withPage(state, (s) => evaluate(s, expr))
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

const CLICK_HELPER = `(target) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height };
  const norm = (el) => ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').trim().toLowerCase();
  let el = null;
  try { const q = document.querySelector(target); if (q && visible(q)) el = q } catch {}
  if (!el) {
    const wanted = target.trim().toLowerCase();
    const viewport = innerWidth * innerHeight;
    const all = [...document.querySelectorAll('button,a,[role=button],[role=tab],[role=menuitem],input[type=submit],input[type=button],span,div,label,li')].filter(visible);
    const exact = all.filter((n) => norm(n) === wanted);
    // 含目标文字的候选里，排除"包住整个页面"的大容器，再取面积最小的（通常正是那个控件本身）
    const partial = all.filter((n) => norm(n).includes(wanted) && area(n) < viewport * 0.4);
    const pool = exact.length ? exact : partial;
    el = pool.sort((a, b) => area(a) - area(b))[0] || null;
    if (el && !/^(BUTTON|A|INPUT|LABEL)$/.test(el.tagName) && el.closest) {
      el = el.closest('button,a,[role=button],[role=tab],input[type=submit],label') || el;
    }
  }
  if (!el) return { ok: false, reason: 'not-found' };
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, text: norm(el).slice(0, 60), area: Math.round(area(el)) };
}`

async function cmdClick(args) {
  const target = args.join(' ')
  if (!target) throw new Error('用法: click "<CSS 选择器 | 可见文字>"')
  const state = requireState()
  const info = await withPage(state, (s) => evaluate(s, `(${CLICK_HELPER})(${JSON.stringify(target)})`))
  if (!info?.ok) throw new Error(`点不到 "${target}"（页面里没找到可见元素）`)
  // 用真实鼠标事件点击（对 React 等前端更可靠），随后补一次 JS click
  await withPage(state, async (s) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', { type, x: info.x, y: info.y, button: 'left', clickCount: 1 })
    }
    await sleep(300)
  })
  console.log(`已点击 <${info.tag}> "${info.text}" @ (${Math.round(info.x)},${Math.round(info.y)})`)
}

async function cmdType(args) {
  const selector = args[0]
  const text = args.slice(1).join(' ')
  if (!selector || text === undefined) throw new Error('用法: type "<CSS 选择器>" "<文本>"')
  const state = requireState()
  const info = await withPage(state, async (s) => {
    const r = await evaluate(s, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false };
      el.scrollIntoView({ block: 'center' }); el.focus();
      return { ok: true, tag: el.tagName };
    })()`)
    if (!r?.ok) return r
    for (const ch of text) {
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch })
    }
    return r
  })
  if (!info?.ok) throw new Error(`找不到输入框：${selector}`)
  console.log(`已在 ${selector} 输入 ${text.length} 个字符`)
}

async function cmdShot(args) {
  const out = args[0]
  if (!out) throw new Error('用法: shot <输出.png> [--full]')
  const full = args.includes('--full')
  const state = requireState()
  const data = await withPage(state, async (s) => {
    const opts = { format: 'png' }
    if (full) opts.captureBeyondViewport = true
    const r = await s.send('Page.captureScreenshot', opts)
    return r.data
  })
  const path = resolve(out)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.from(data, 'base64'))
  console.log(path)
}

async function cmdTabs() {
  const state = requireState()
  const list = await httpJson(`http://127.0.0.1:${state.port}/json/list`)
  for (const t of list.filter((x) => x.type === 'page')) console.log(`- ${t.title}\n  ${t.url}`)
}

async function cmdStop() {
  const state = loadState()
  if (!state) { console.log('本就没有运行'); return }
  try {
    await withPage(state, (s) => s.send('Browser.close').catch(() => {}))
    await sleep(500)
  } catch { /* 忽略 */ }
  try { process.kill(state.pid, 'SIGTERM') } catch { /* 忽略 */ }
  console.log('已请求关闭')
}

async function cmdSetCode(args) {
  const file = args[0]
  if (!file) throw new Error('用法: setcode <代码文件>')
  const code = readFileSync(resolve(file), 'utf8')
  const state = requireState()
  const res = await withPage(state, async (s) => {
    // ① CodeMirror 5：全局实例直接 setValue
    const viaCM = await evaluate(s, `(() => {
      const el = document.querySelector('.CodeMirror');
      if (el && el.CodeMirror && typeof el.CodeMirror.setValue === 'function') {
        el.CodeMirror.setValue(${JSON.stringify(code)});
        return el.CodeMirror.getValue().length;
      }
      return 0;
    })()`)
    if (viaCM) return { how: 'CodeMirror.setValue', len: viaCM }
    // ② CodeMirror 6 / 普通 textarea：聚焦后全选，用 CDP insertText 触发真实输入事件
    const focused = await evaluate(s, `(() => {
      const ta = document.querySelector('.CodeMirror textarea') || document.querySelector('textarea');
      if (!ta) return false;
      ta.focus();
      return true;
    })()`)
    if (!focused) throw new Error('找不到可写入的编辑器（无 CodeMirror 实例，也无 textarea）')
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    await s.send('Input.insertText', { text: code })
    await sleep(300)
    const len = await evaluate(s, `(() => {
      const el = document.querySelector('.CodeMirror');
      if (el && el.CodeMirror) return el.CodeMirror.getValue().length;
      const ta = document.querySelector('.CodeMirror textarea') || document.querySelector('textarea');
      return ta ? ta.value.length : -1;
    })()`)
    return { how: 'insertText', len }
  })
  console.log(`已写入代码（${res.how}）：编辑器 ${res.len} 字符 / 源码 ${code.length} 字符`)
}

async function cmdTypeCode(args) {
  const file = args[0]
  if (!file) throw new Error('用法: typecode <代码文件>')
  const code = readFileSync(resolve(file), 'utf8')
  const state = requireState()
  await withPage(state, async (s) => {
    // ① 找到真正的代码编辑器（Monaco）：取面积最大且可见的那个
    const box = await evaluate(s, `(() => {
      const editors = [...document.querySelectorAll('.monaco-editor')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 200 && r.height > 100 && getComputedStyle(e).display !== 'none';
      });
      if (!editors.length) return null;
      const el = editors.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      })[0];
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 60), y: Math.round(r.top + 22), w: Math.round(r.width), h: Math.round(r.height) };
    })()`)
    if (!box) throw new Error('页面上找不到可见的 Monaco 编辑器（.monaco-editor）')

    // ② 用真实鼠标点击让编辑器获得焦点
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
    await sleep(300)

    // ③ 全选并删除旧内容（真实按键）
    const mods = 4 // Meta（macOS 的 Cmd）
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mods, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    await sleep(200)
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await sleep(300)

    // ④ 逐字符输入全文
    for (const ch of code) {
      if (ch === '\n') {
        await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      } else {
        await s.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch })
      }
    }
    await sleep(800)

    // ⑤ 用 Monaco 渲染出来的行文本核对（不依赖 window.monaco）
    const lines = await evaluate(s, `(() => {
      const editors = [...document.querySelectorAll('.monaco-editor')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 200 && r.height > 100;
      });
      const el = editors[0];
      if (!el) return null;
      return [...el.querySelectorAll('.view-line')].map((l) => l.innerText).join('\\n');
    })()`)
    const got = lines ? lines.replace(/\u00a0/g, ' ').trimEnd() : ''
    console.log(`已输入代码。编辑器可见行文本长度 ${got.length} / 源码 ${code.length}`)
    console.log('--- 编辑器前两行 ---')
    console.log(got.split('\n').slice(0, 2).join('\n'))
  })
}

async function cmdWaitText(args) {
  const needle = args[0]
  const seconds = Number(args[1] || 120)
  if (!needle) throw new Error('用法: waittext "<文本>" [超时秒数]')
  const state = requireState()
  const started = Date.now()
  let last = ''
  while (Date.now() - started < seconds * 1000) {
    const text = await withPage(state, (s) => evaluate(s, 'document.body.innerText'))
    last = text || ''
    if (last.includes(needle)) {
      console.log(`命中「${needle}」（等了 ${((Date.now() - started) / 1000).toFixed(1)}s）`)
      return
    }
    await sleep(2000)
  }
  console.log(`超时未出现「${needle}」，当前页面文本尾部：\n${last.slice(-300)}`)
  process.exit(3)
}

async function cmdUse(args) {
  const state = requireState()
  state.tabMatch = args[0] || ''
  saveState(state)
  const t = await pageTarget(state)
  console.log(`后续命令作用于：${t.title}\n  ${t.url}`)
}

export { connect, withPage, evaluate, loadState, saveState, pageTarget, httpJson, sleep, STATE_FILE }

// 仅当被直接执行时才跑 CLI（被 import 时不执行）
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
const [cmd, ...rest] = invokedDirectly ? process.argv.slice(2) : []
const commands = { start: cmdStart, goto: cmdGoto, text: cmdText, eval: cmdEval, click: cmdClick, type: cmdType, shot: cmdShot, tabs: cmdTabs, stop: cmdStop, use: cmdUse, setcode: cmdSetCode, typecode: cmdTypeCode, waittext: cmdWaitText }
if (!invokedDirectly) {
  // 作为模块被 import：到此为止
} else if (!commands[cmd]) {
  console.log('用法: node cdp-browser.mjs {start|goto|text|eval|click|type|shot|tabs|stop|use|setcode|typecode|waittext} ...')
  process.exit(2)
}
if (invokedDirectly) {
  try {
    await commands[cmd](rest)
    // WebSocket 关闭后底层 socket 可能仍让事件循环存活，显式退出避免命令挂住
    process.exit(0)
  } catch (err) {
    console.error(`错误: ${err.message}`)
    process.exit(1)
  }
}
