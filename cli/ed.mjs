#!/usr/bin/env node
/**
 * 头歌（educoder.net）答题专用驱动：在 Monaco 编辑器里填代码、跑自测、提交评测。
 *
 * 为什么单独写：头歌真正用的编辑器是 Monaco（不是 CodeMirror），
 * 程序化 setValue 不会被前端框架同步到服务端，必须用**真实鼠标点击 + 真实按键**写入。
 *
 * 用法：
 *   node ed.mjs info                  # 当前标签页 URL/标题 + 编辑器状态
 *   node ed.mjs read                  # 左侧题面文本
 *   node ed.mjs code                  # 当前编辑器内容（从渲染行读取）
 *   node ed.mjs write <代码文件>       # 写入代码（点击→全选→删除→逐字符输入，含校验）
 *   node ed.mjs run                   # 点「自测运行」并等待结果
 *   node ed.mjs submit                # 点「评测」并等待结果
 *   node ed.mjs shot <png>            # 截图
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withPage, evaluate, loadState, saveState, sleep } from '../dsh-vision/tools/cdp-browser.mjs'

const state = () => {
  const s = loadState()
  if (!s) throw new Error('浏览器未启动：先运行 dsh-vision/tools/cdp-browser.mjs start --headful')
  return s
}

const MOD = 4 // Meta（macOS 的 Cmd）

async function key(s, opts) {
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...opts })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...opts })
}

/** 找出面积最大的可见 Monaco 编辑器。 */
const EDITOR_QUERY = `(() => {
  const eds = [...document.querySelectorAll('.monaco-editor')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 200 && r.height > 80 && getComputedStyle(e).display !== 'none';
  });
  if (!eds.length) return null;
  const el = eds.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return rb.width * rb.height - ra.width * ra.height;
  })[0];
  el.scrollIntoView({ block: 'center' });
  const lines = el.querySelector('.view-lines');
  const r = (lines || el).getBoundingClientRect();
  // 点击点必须落在视口内，并避开顶部吸顶导航
  const top = Math.max(r.top, 70);
  const bottom = Math.min(r.bottom, innerHeight - 30);
  return {
    x: Math.round(r.left + Math.min(150, Math.max(30, r.width / 3))),
    y: Math.round((top + bottom) / 2),
    left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
  };
})()`

async function readCode(s) {
  // 必须与写入时用同一个编辑器：取面积最大的可见 Monaco（DOM 里还有一个小编辑器）
  return await evaluate(s, `(() => {
    const eds = [...document.querySelectorAll('.monaco-editor')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 300 && r.height > 120 && getComputedStyle(e).display !== 'none';
    });
    if (!eds.length) return '';
    const el = eds.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
    return [...el.querySelectorAll('.view-line')].map((l) => l.innerText.replace(/\\u00a0/g, ' ')).join('\\n');
  })()`)
}

async function focusEditor(s, verbose = false) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const box = await evaluate(s, EDITOR_QUERY)
    if (!box) throw new Error('找不到可见的 Monaco 编辑器')
    const x = box.x + attempt * 15
    const y = box.y + attempt * 10
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
    await sleep(250)
    const active = await evaluate(s, `document.activeElement ? (document.activeElement.tagName + '.' + (document.activeElement.className || '')) : 'none'`)
    if (verbose) console.log(`  点击(${x},${y}) 后 activeElement = ${active}`)
    if (String(active).includes('inputarea')) return true
  }
  // 兜底：直接 focus Monaco 的输入框
  const ok = await evaluate(s, `(() => {
    const ta = document.querySelector('.monaco-editor textarea.inputarea');
    if (!ta) return false;
    ta.focus();
    return document.activeElement === ta;
  })()`)
  return !!ok
}

async function clearEditor(s) {
  // 键盘可达的确定性全选：Cmd+↑ 到文首，再 Cmd+Shift+↓ 选到文末
  const key = async (opts) => {
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...opts })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...opts })
  }
  await key({ modifiers: 4, key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 })
  await sleep(350)
  await key({ modifiers: 12, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
  await sleep(450)
  const selected = await evaluate(s, `document.querySelectorAll('.monaco-editor .selected-text').length`)
  return selected > 0
}

/** 写入代码：整段替换（insertText 会替换当前选区；缩进可能被 Monaco 自动调整，但不影响编译）。 */
async function typeCode(s, code) {
  await s.send('Input.insertText', { text: code })
  await sleep(900)
  // 回到文首，便于后续读取校验
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 })
  await sleep(500)
}

/** 读取结果面板文本（优先「运行结果/评测结果」之后的内容）。 */
async function resultText(s) {
  return await evaluate(s, `(() => {
    const t = document.body.innerText;
    const i = Math.max(t.lastIndexOf('运行结果'), t.lastIndexOf('评测结果'));
    return i >= 0 ? t.slice(i, i + 1200) : t.slice(-1200);
  })()`)
}

/** 点按钮并等到结果区文本真正变化（用变化检测替代关键词猜测）。 */
async function clickButton(s, label) {
  const before = await resultText(s)
  let box = await evaluate(s, `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === ${JSON.stringify(label)})
      || [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim().includes(${JSON.stringify(label)}));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  if (!box) {
    // 按钮可能因运行状态短暂消失，重试几次
    for (let i = 0; i < 6 && !box; i++) {
      await sleep(3000)
      box = await evaluate(s, `(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim().includes(${JSON.stringify(label)}));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return (r.width > 0 && r.height > 0) ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
      })()`)
    }
  }
  if (!box) throw new Error(`找不到按钮「${label}」`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  const started = Date.now()
  let now = before
  while (Date.now() - started < 180000) {
    await sleep(3000)
    now = await resultText(s)
    if (now !== before && !/运行中|编译中|排队/.test(now)) return now
  }
  return now + '\n(⚠️ 结果区在 180 秒内未发生变化)'
}


/** 在实验/作业列表页按题号前缀打开某题（会新开标签页，随后自动切到该标签）。 */
async function cmdOpen(s, idPrefix) {
  if (!idPrefix) throw new Error('用法: open <题号，如 2136>')
  let box = await evaluate(s, `(() => {
    const title = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.innerText || '').trim().match(new RegExp('^' + ${JSON.stringify(idPrefix)} + '[:：]?')));
    if (!title) return null;
    let card = title;
    for (let i = 0; i < 8 && card.parentElement; i++) {
      card = card.parentElement;
      if (/开始学习/.test(card.innerText || '')) break;
    }
    const btn = [...card.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.innerText || '').trim() === '开始学习');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), card: (card.innerText || '').replace(/\s+/g, ' ').slice(0, 50) };
  })()`)
  if (!box) throw new Error(`列表页找不到题目 ${idPrefix} 的「开始学习」按钮`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  console.log(`已点击 ${idPrefix} 的「开始学习」：${box.card}`)
  await sleep(7000)
  // 切到刚打开的题目标签
  const list = await (await fetch(`http://127.0.0.1:${s0.port}/json/list`)).json()
  const task = list.filter((t) => t.type === 'page' && /\/tasks\//.test(t.url)).pop()
  if (task) {
    s0.tabMatch = '/tasks/'
    saveState(s0)
    console.log(`已切到题目页：${task.title}\n  ${task.url}`)
  } else {
    console.log('⚠️ 没找到题目标签，请用 tabs 查看')
  }
}

export { readCode, focusEditor, clearEditor, typeCode, clickButton, resultText, EDITOR_QUERY, MOD }

// ------------------------------------------------------------------ 子命令
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
const [cmd, ...rest] = invokedDirectly ? process.argv.slice(2) : []
const s0 = invokedDirectly ? state() : null
if (invokedDirectly) {

if (cmd === 'info') {
  await withPage(s0, async (s) => {
    const info = await evaluate(s, `JSON.stringify({url: location.href, title: document.title, monaco: document.querySelectorAll('.monaco-editor').length, btns: [...document.querySelectorAll('button')].map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,10)})`)
    console.log(info)
  })
} else if (cmd === 'open') {
  await withPage(s0, async (s) => cmdOpen(s, rest[0]))
} else if (cmd === 'task') {
  // 只打印题面要点：本关任务 → 测试说明 结束
  await withPage(s0, async (s) => {
    const t = await evaluate(s, `(() => {
      const x = document.body.innerText;
      const a = x.indexOf('本关任务');
      const b = x.indexOf('开始你的任务吧');
      return (a >= 0 ? x.slice(a, b > a ? b : a + 1800) : x.slice(0, 1200));
    })()`)
    console.log(t.replace(/\n{2,}/g, '\n'))
  })
} else if (cmd === 'read') {
  await withPage(s0, async (s) => {
    const t = await evaluate(s, `document.body.innerText.slice(0, Number(${JSON.stringify(rest[0] || '2500')}))`)
    console.log(t)
  })
} else if (cmd === 'code') {
  await withPage(s0, async (s) => console.log(await readCode(s)))
} else if (cmd === 'write') {
  const file = rest[0]
  if (!file) throw new Error('用法: write <代码文件>')
  const code = readFileSync(resolve(file), 'utf8')
  await withPage(s0, async (s) => {
    const focused = await focusEditor(s, true)
    console.log(`焦点：${focused ? '已进入编辑器 ✓' : '未拿到焦点 ✗'}`)
    if (!focused) throw new Error('无法让编辑器获得焦点，放弃写入')
    const cleared = await clearEditor(s)
    console.log(`清空：${cleared ? '已清空 ✓' : '仍有内容 ⚠️'}`)
    await typeCode(s, code)
    await sleep(1000)
    const got = await readCode(s)
    const norm = (x) => x.replace(/\s+/g, ' ').trim()
    console.log(`写入完成：编辑器 ${got.length} 字符 / 源码 ${code.length} 字符`)
    console.log(`内容比对：${norm(got) === norm(code) ? '一致 ✓' : '不一致 ⚠️'}`)
    if (norm(got) !== norm(code)) {
      console.log('--- 期望 ---'); console.log(code.slice(0, 200))
      console.log('--- 实际 ---'); console.log(got.slice(0, 200))
    }
  })
} else if (cmd === 'run' || cmd === 'submit') {
  const label = cmd === 'run' ? '自测运行' : '评测'
  await withPage(s0, async (s) => {
    console.log(`点击「${label}」，等待结果区变化…`)
    const result = await clickButton(s, label)
    console.log('--- 结果 ---')
    console.log(result)
  })
} else if (cmd === 'shot') {
  const out = resolve(rest[0] || '/tmp/edu.png')
  await withPage(s0, async (s) => {
    const r = await s.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, Buffer.from(r.data, 'base64'))
    console.log(out)
  })
} else {
  console.log('用法: node ed.mjs {info|task|read|code|write <file>|run|submit|shot <png>}')
}
if (invokedDirectly) process.exit(0)
}
