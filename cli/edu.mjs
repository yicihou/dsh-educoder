#!/usr/bin/env node
/**
 * 头歌（educoder）做题一体化 CLI —— 把每题的 6~8 步手工操作压成 2~3 条命令。
 *
 * 用法：
 *   node edu.mjs start | stop                起停自动化浏览器（带 --no-proxy-server）
 *   node edu.mjs status [实验id|--all]       巡检：每个实验/作业里每道题的完成状态（并刷新 plan.json）
 *   node edu.mjs list                        离线看 plan.json 里已知题目与状态
 *   node edu.mjs open <关键字|--next> [--exp 实验id]
 *                                            打开题目，导出 work/<键>/题面.md 与 starter.cpp
 *   node edu.mjs code                        打印当前编辑器全文
 *   node edu.mjs write <文件>                把文件写进当前题目编辑器（不提交）
 *   node edu.mjs run                         点「自测运行」，打印运行输出
 *   node edu.mjs submit                      点「评测」，轮询判定结果并打印
 *   node edu.mjs next                        跳到实训的下一关
 *   node edu.mjs shot <png>                  截图
 *
 * 设计要点：
 *   - 复用 ../dsh-vision/tools/cdp-browser.mjs 的 CDP 能力，不引入任何第三方依赖；
 *   - 编辑器读写走「系统剪贴板 + 真实按键」：读取用 全选+Cmd+C 后 pbpaste，
 *     写入用 pbcopy 后 全选+Cmd+V（真实粘贴不会被 Monaco 重排缩进）；
 *   - 每题产物落在 work/<键>/：题面.md / starter.cpp / solution.cpp / result.txt。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'work')
const PLAN = join(HERE, 'plan.json')
const CLASSROOM = '8fiw5xey'
const BASE = 'https://www.educoder.net'
const NODE = process.execPath

/** cdp-browser.mjs 的查找顺序（让本脚本无论在"工作区原位"还是"仓库副本"里都能跑）：
 *   ① $EDU_CDP 显式指定
 *   ② 与本脚本同目录（仓库的 cli/ 会自带一份 vendor 副本）
 *   ③④ 工作区/仓库的常见布局
 *   ⑤ 兜底：默认工作区的绝对路径 */
const CDP_CANDIDATES = [
  process.env.EDU_CDP,
  join(HERE, 'cdp-browser.mjs'),
  join(HERE, '..', 'dsh-vision', 'tools', 'cdp-browser.mjs'),
  join(HERE, '..', '..', 'dsh-vision', 'tools', 'cdp-browser.mjs'),
  join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace', 'dsh-vision', 'tools', 'cdp-browser.mjs'),
].filter(Boolean)
const CDP = CDP_CANDIDATES.find((p) => existsSync(p))
if (!CDP) {
  console.error('✗ 找不到 cdp-browser.mjs。用 EDU_CDP=<路径> 指定，或把它放到本脚本同目录。')
  process.exit(1)
}
const { withPage, evaluate, loadState, saveState, pageTarget, httpJson, sleep } =
  await import(pathToFileURL(CDP).href)

// ---------- 小工具 ----------
const pbpaste = () => execFileSync('pbpaste', { encoding: 'utf8' })
const pbcopy = (t) => execFileSync('pbcopy', { input: t })
const log = (...a) => console.log(...a)
const die = (msg) => { console.error('✗ ' + msg); process.exit(1) }

function requireBrowser() {
  const s = loadState()
  if (!s) die('浏览器未启动。先运行：node edu.mjs start')
  return s
}

/** 把后续命令锁定到某个标签（tabMatch），并把状态写回 state.json */
function pinTab(match) {
  const s = requireBrowser()
  saveState({ ...s, tabMatch: match })
}

/** 锁定到"当前题目"那个标签：优先用 currentTask.url 的路径精确匹配
 *  （多个 /tasks/ 标签同时存在时，通用的 '/tasks/' 会选错——pageTarget 取的是第一个匹配，
 *   而标签顺序会随激活变化），匹配不到再退回通用匹配。 */
async function pinCurrentTask() {
  const s = loadState()
  const url = s?.currentTask?.url
  if (url) {
    try {
      const path = new URL(url).pathname
      pinTab(path)
      const t = await pageTarget(loadState())
      if (t && String(t.url || '').includes(path)) return path
    } catch { /* 落到下面的通用匹配 */ }
  }
  pinTab('/tasks/')
  return '/tasks/'
}

/** 在当前锁定标签里执行一段页面脚本 */
async function page(expr, { tab } = {}) {
  requireBrowser()
  if (tab !== undefined) pinTab(tab)
  return await withPage(loadState(), (s) => evaluate(s, expr))
}

/** 点一个按钮（真实鼠标事件，头歌的部分按钮只认真实点击） */
async function clickButton(label) {
  requireBrowser()
  return await withPage(loadState(), async (s) => {
    const box = await evaluate(s, `(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim() === ${JSON.stringify(label)})
             || [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim().includes(${JSON.stringify(label)}));
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
    if (!box) return false
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
    return true
  })
}

/** 找可见的最大 Monaco 编辑器并聚焦；返回 {ok, empty}
 *  注意：头歌提交通过后会弹"金币/经验"(gold-and-experience)奖励弹窗盖住编辑器，
 *  所以点击前先用 elementFromPoint 检查候选点有没有被遮挡，被挡住就关弹窗/按 Esc 重试。 */
async function focusEditor() {
  return await withPage(loadState(), async (s) => {
    const QUERY = `(() => {
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
      const vl = el.querySelector('.view-lines');
      const r = (vl || el).getBoundingClientRect();
      const top = Math.max(r.top, 70), bottom = Math.min(r.bottom, innerHeight - 30);
      const cands = [];
      for (const fy of [0.5, 0.3, 0.72]) for (const fx of [0.25, 0.5, 0.12]) {
        const x = Math.round(r.left + r.width * fx), y = Math.round(top + (bottom - top) * fy);
        const hit = document.elementFromPoint(x, y);
        cands.push({ x, y, ok: !!(hit && hit.closest('.monaco-editor')),
                     hit: hit ? String(hit.className || hit.tagName).slice(0, 48) : '(null)' });
      }
      const good = cands.find((c) => c.ok);
      return { pick: good || cands[0], anyOk: !!good, blocker: cands[0].hit,
               empty: (vl ? vl.innerText : '').trim().length === 0 };
    })()`
    /** 清理挡住编辑器的浮层：
     *   ① 「评测结果」面板用平台自带关闭按钮关掉——**绝不能 display:none 隐藏它**，
     *      否则之后读不到评测结果（innerText 不含隐藏元素）；
     *   ② 「金币/经验」奖励飘字是纯装饰、无按钮也不会自动消失，直接移除并注入 CSS 防再插入。 */
    const CLEAR_OBSTACLES = `(() => {
      const acts = [];
      const panel = document.querySelector('.evaluate-result-container');
      if (panel) {
        const btn = [...panel.querySelectorAll('*')].find((e) => {
          const r = e.getBoundingClientRect();
          return /close/i.test(String(e.className || '')) && r.width > 4 && r.height > 4;
        });
        if (btn) {
          const r = btn.getBoundingClientRect();
          acts.push({ act: '关评测结果面板', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        }
      }
      let n = 0;
      document.querySelectorAll('.gold-and-experience,[class*=gold-and-experience]').forEach((e) => { e.remove(); n++ });
      if (n) acts.push({ act: '移除奖励飘字', n });
      if (!document.getElementById('edu-hide-toast')) {
        const st = document.createElement('style');
        st.id = 'edu-hide-toast';
        st.textContent = '.gold-and-experience,[class*=gold-and-experience]{display:none !important;visibility:hidden !important;pointer-events:none !important}';
        (document.head || document.documentElement).appendChild(st);
      }
      return acts;
    })()`
    const pressEsc = async () => {
      for (const type of ['keyDown', 'keyUp']) {
        await s.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      }
    }
    const clearObstacles = async () => {
      const acts = await evaluate(s, CLEAR_OBSTACLES)
      for (const a of acts) {
        if (a.y !== undefined) {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await s.send('Input.dispatchMouseEvent', { type, x: a.x, y: a.y, button: 'left', clickCount: 1 })
          }
        }
      }
      if (acts.length) console.error(`  （清理浮层：${acts.map((a) => a.act + (a.n ? `×${a.n}` : '')).join('、')}）`)
      await sleep(500)
      return acts
    }
    await clearObstacles()   // 先无条件清一次，多数情况这一下就够
    for (let round = 0; round < 5; round++) {
      const info = await evaluate(s, QUERY)
      if (!info) die('找不到可见的 Monaco 编辑器（页面可能没加载完）')
      if (!info.anyOk) {
        // 还被遮挡，分级处理：①点掉它 ②Esc ③再清一次浮层
        if (round === 0) {
          console.error(`  （编辑器被 ${info.blocker} 遮挡，尝试点掉它…）`)
          for (const type of ['mousePressed', 'mouseReleased']) {
            await s.send('Input.dispatchMouseEvent', { type, x: info.pick.x, y: info.pick.y, button: 'left', clickCount: 1 })
          }
        } else if (round === 1) {
          await pressEsc()
        } else {
          await clearObstacles()
        }
        await sleep(600)
        continue
      }
      for (const type of ['mousePressed', 'mouseReleased']) {
        await s.send('Input.dispatchMouseEvent', { type, x: info.pick.x + round * 9, y: info.pick.y + round * 7, button: 'left', clickCount: 1 })
      }
      await sleep(350)
      const active = await evaluate(s, `(document.activeElement && document.activeElement.className) || ''`)
      if (String(active).includes('inputarea')) return { ok: true, empty: info.empty }
      if (info.anyOk) return { ok: true, empty: info.empty }   // 点确实落在编辑器内即视为聚焦成功
    }
    return { ok: false, empty: false }
  })
}

const key = async (s, opts) => {
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...opts })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...opts })
}

/** 读编辑器全文（全选 + 复制 → 系统剪贴板） */
async function readEditor() {
  const f = await focusEditor()
  if (!f.ok) die('无法聚焦编辑器')
  if (f.empty) return ''
  await withPage(loadState(), async (s) => {
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    await sleep(350)
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, commands: ['copy'] })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 })
    await sleep(600)
  })
  return pbpaste()
}

/** 写编辑器全文（剪贴板 + 全选 + 真实粘贴） */
async function writeEditor(text) {
  const f = await focusEditor()
  if (!f.ok) die('无法聚焦编辑器')
  pbcopy(text)
  await withPage(loadState(), async (s) => {
    if (!f.empty) {
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
      await sleep(350)
    }
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, commands: ['paste'] })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 })
    await sleep(1200)
  })
}

/** 结果面板文本（取最后一次「运行结果 / 测试结果 / 评测结果」之后的内容） */
async function resultText() {
  return await page(`(() => {
    const t = document.body.innerText;
    const i = Math.max(t.lastIndexOf('运行结果'), t.lastIndexOf('测试结果'), t.lastIndexOf('评测结果'));
    return i >= 0 ? t.slice(i, i + 2000) : '';
  })()`)
}

/** 点按钮并轮询结果，直到出现结论或超时 */
async function clickAndWait(label, timeoutMs = 240000) {
  const before = await resultText()
  if (!(await clickButton(label))) die(`页面上找不到按钮「${label}」`)
  const t0 = Date.now()
  let last = before, stable = 0, tick = 0
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2500)
    const now = await resultText()
    if (++tick % 4 === 0) process.stdout.write(`\r  等待${label}结果… ${Math.round((Date.now() - t0) / 1000)}s `)
    const settled = /全部通过|不匹配|超时|错误|未通过|测试结果\n\d+\/\d+/.test(now) && now !== '代码执行中...'
    if (now !== last) { last = now; stable = 0 } else { stable++ }
    if (settled && now !== before && stable >= 1) { process.stdout.write('\r'); return now }
  }
  process.stdout.write('\r')
  return last
}

/** 从结果文本里提取结论 */
function verdict(text) {
  const m = text.match(/(\d+)\s*\/\s*(\d+)\s*\n?\s*(全部通过)?/)
  if (m && m[3]) return { pass: true, score: `${m[1]}/${m[2]}`, summary: '全部通过' }
  const fail = text.match(/共有(\d+)组测试集，其中有(\d+)组测试结果不匹配/)
  if (fail) return { pass: false, score: '', summary: `不匹配 ${fail[2]}/${fail[1]}` }
  if (/超时/.test(text)) return { pass: false, score: '', summary: '评测超时（平台侧，建议重试）' }
  if (/未通过/.test(text)) return { pass: false, score: '', summary: '未通过' }
  return { pass: false, score: '', summary: '未识别到结论，请人工看结果文本' }
}

// ---------- 题面 / 卡片解析 ----------
const STATEMENT_JS = `(() => {
  const t = document.body.innerText.replace(/\\n{2,}/g, '\\n');
  const start = Math.max(t.indexOf('本关任务'), t.indexOf('任务描述'), t.indexOf('第1关'), 0);
  return t.slice(start, start + 6000);
})()`

function parseCards(text) {
  const lines = text.split('\n').map((l) => l.trim())
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '开始学习') continue
    let name = ''
    for (let j = i - 1; j >= 0 && j > i - 4; j--) if (lines[j]) { name = lines[j]; break }
    let progress = ''
    for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
      if (/^\d+\s*\/\s*\d+$/.test(lines[j])) { progress = lines[j].replace(/\s+/g, ''); break }
    }
    if (!name || !progress) continue
    const [done, total] = progress.split('/').map(Number)
    out.push({ name, progress, done: total > 0 && done === total, total })
  }
  return out
}

const safeKey = (name) => name.replace(/[:：]\s*/g, '-').replace(/[\/\\\s]+/g, '').slice(0, 40)

// ---------- 命令 ----------
async function ensureBrowser() {
  const s = loadState()
  try {
    if (s?.port) { await httpJson(`http://127.0.0.1:${s.port}/json/version`); return }
  } catch { /* 已退出 */ }
  log('启动自动化浏览器…')
  execFileSync(NODE, [CDP, 'start', '--headful'], { stdio: 'inherit' })
  await sleep(2000)
}

/** 抓取课堂里的全部「实训作业 / 实验」列表 */
async function homeworkList() {
  pinTab('/shixun_homework')
  return await withPage(loadState(), async (s) => {
    await s.send('Page.navigate', { url: `${BASE}/classrooms/${CLASSROOM}/shixun_homework` })
    await sleep(9000)
    const list = await evaluate(s, `(() => {
      const seen = new Set(), out = [];
      for (const a of document.querySelectorAll('a[href*="/shixun_homework/"]')) {
        const h = a.getAttribute('href') || '';
        const m = h.match(/\\/shixun_homework\\/(\\d+)$/);
        const name = (a.innerText || '').trim();
        if (!m || !name || seen.has(m[1])) continue;
        seen.add(m[1]);
        out.push({ id: m[1], name });
      }
      return out;
    })()`)
    return list || []
  })
}

async function cmdStatus(args) {
  await ensureBrowser()
  const all = args.includes('--all')
  const only = args.find((a) => /^\d{6,}$/.test(a))
  let targets = await homeworkList()
  if (only) targets = targets.filter((t) => t.id === only)
  else if (!all) targets = targets.filter((t) => t.name.startsWith('实验'))
  if (!targets.length) die('没找到要巡检的作业/实验')

  const plan = existsSync(PLAN) ? JSON.parse(readFileSync(PLAN, 'utf8')) : {}
  log(`\n巡检 ${targets.length} 个作业/实验：`)
  for (const t of targets) {
    const cards = await withPage(loadState(), async (s) => {
      await s.send('Page.navigate', { url: `${BASE}/classrooms/${CLASSROOM}/shixun_homework/${t.id}` })
      await sleep(9000)
      const txt = await evaluate(s, `document.body.innerText.replace(/\\n{2,}/g, '\\n')`)
      return parseCards(txt)
    })
    const doneN = cards.filter((c) => c.done).length
    log(`\n【${t.name}】(id=${t.id})  ${doneN}/${cards.length}`)
    for (const c of cards) log(`   ${c.done ? '✅' : '⬜'} ${c.name}  (${c.progress})`)
    if (!cards.length) log('   （平台显示暂无题目）')
    plan[t.id] = { name: t.name, url: `${BASE}/classrooms/${CLASSROOM}/shixun_homework/${t.id}`,
      total: cards.length, completed: doneN,
      items: cards.map((c) => ({ name: c.name, status: c.progress, done: c.done })) }
  }
  writeFileSync(PLAN, JSON.stringify(plan, null, 2))
  log(`\n已刷新 ${PLAN}`)
}

function cmdList() {
  if (!existsSync(PLAN)) die('还没有 plan.json，先跑：node edu.mjs status')
  const plan = JSON.parse(readFileSync(PLAN, 'utf8'))
  for (const [id, v] of Object.entries(plan)) {
    log(`\n【${v.name}】(id=${id})  ${v.completed}/${v.total}`)
    for (const it of v.items || []) {
      // 兼容旧版 enumerate.mjs 写的字段名（title / status）、以及实训关卡
      const name = it.name || it.title || it.id || '(未命名)'
      const status = it.status || it.progress || ''
      const done = it.done ?? (status && status.split('/')[0] === status.split('/')[1])
      log(`   ${done ? '✅' : '⬜'} ${name}${status ? `  (${status})` : ''}`)
    }
  }
}

async function cmdOpen(args) {
  await ensureBrowser()
  const next = args.includes('--next')
  const expIdx = args.indexOf('--exp')
  const expId = expIdx >= 0 ? args[expIdx + 1] : null
  const keyword = args.find((a) => !a.startsWith('--') && a !== expId)

  let targets = await homeworkList()
  targets = targets.filter((t) => t.name.startsWith('实验'))
  if (expId) targets = targets.filter((t) => t.id === expId)
  if (!targets.length) die('没找到实验（可用 --exp 指定 id）')

  pinTab('/shixun_homework')
  let picked = null, cardBox = null
  for (const t of targets) {
    const res = await withPage(loadState(), async (s) => {
      await s.send('Page.navigate', { url: `${BASE}/classrooms/${CLASSROOM}/shixun_homework/${t.id}` })
      await sleep(9000)
      return await evaluate(s, `(() => {
        const want = ${JSON.stringify(keyword || '')};
        const onlyNext = ${next};
        const btns = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.innerText || '').trim() === '开始学习');
        for (const btn of btns) {
          // 往上找到「整张卡片」：同时含『开始学习』和 x/y 进度的最近祖先
          let card = btn, txt = '';
          for (let i = 0; i < 8 && card.parentElement; i++) {
            card = card.parentElement;
            const t = (card.innerText || '').replace(/\\s+/g, ' ');
            if (/开始学习/.test(t) && /\\d+\\s*\\/\\s*\\d+/.test(t) && t.length < 600) { txt = t; break; }
          }
          if (!txt) continue;
          const m = txt.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
          const prog = m ? { d: +m[1], t: +m[2] } : null;
          const hit = want ? txt.includes(want) : (onlyNext ? (prog && prog.t > 0 && prog.d < prog.t) : true);
          if (!hit) continue;
          btn.scrollIntoView({ block: 'center' });
          const r = btn.getBoundingClientRect();
          if (r.width === 0) continue;
          const name = txt.replace(/^(提交中|补交中|已截止|已归档|未开始)\\s*/, '').split(' 开始学习')[0].trim();
          return { name, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), from: ${JSON.stringify(t.id)}, prog: prog ? prog.d + '/' + prog.t : '' };
        }
        return null;
      })()`)
    })
    if (res) { picked = res; cardBox = { ...res, expName: t.name }; break }
  }
  if (!picked) die(next ? '没有未完成的题目了 🎉' : `没找到含「${keyword}」的题目`)

  const before = new Set((await httpJson(`http://127.0.0.1:${loadState().port}/json/list`)).filter((x) => x.type === 'page').map((x) => x.id))
  log(`打开：${picked.name}  (${picked.prog})  来自 ${cardBox.expName}`)
  await withPage(loadState(), async (s) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', { type, x: picked.x, y: picked.y, button: 'left', clickCount: 1 })
    }
  })
  await sleep(8000)
  const after = (await httpJson(`http://127.0.0.1:${loadState().port}/json/list`)).filter((x) => x.type === 'page')
  const fresh = after.find((x) => !before.has(x.id) && /\/tasks\//.test(x.url)) || after.filter((x) => /\/tasks\//.test(x.url)).pop()
  if (!fresh) die('没有新开的题目标签（可能被弹窗拦截）')

  pinTab('/tasks/')
  await sleep(4000)
  const key0 = safeKey(picked.name)
  const dir = join(WORK, key0)
  mkdirSync(dir, { recursive: true })
  const statement = await page(STATEMENT_JS)
  writeFileSync(join(dir, '题面.md'), `# ${picked.name}\n\n- 来源：${cardBox.expName}\n- URL：${fresh.url}\n\n${statement}\n`)
  const starter = await readEditor()
  writeFileSync(join(dir, 'starter.cpp'), starter)
  const meta = { name: picked.name, expId: picked.from, expName: cardBox.expName, url: fresh.url, progress: picked.prog }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  // 精确锁定这道题（用 URL 路径），并关掉其它 /tasks/ 标签，
  // 否则下次命令在"多个题目标签"里可能选错（pageTarget 取第一个匹配）
  pinTab(new URL(fresh.url).pathname)
  saveState({ ...loadState(), currentTask: meta })
  const port = loadState().port
  for (const t of await httpJson(`http://127.0.0.1:${port}/json/list`)) {
    if (t.type === 'page' && /\/tasks\//.test(t.url) && t.id !== fresh.id) {
      try { await httpJson(`http://127.0.0.1:${port}/json/close/${t.id}`); log(`  （已关闭多余题目标签：${(t.title || '').slice(0, 20)}）`) } catch { /* 忽略 */ }
    }
  }
  log(`已导出：${dir}/题面.md 与 starter.cpp（${starter.split('\n').length} 行）`)
  log(`当前题目已锁定：${picked.name}`)
}

function currentDir() {
  const s = loadState()
  if (!s?.currentTask?.name) die('还没有打开过题目，先跑：node edu.mjs open <关键字|--next>')
  return { dir: join(WORK, safeKey(s.currentTask.name)), meta: s.currentTask }
}

async function cmdCode() {
  await pinCurrentTask()   // 定位到「当前题目」那个标签（多标签时不能只按 /tasks/ 匹配）
  log(await readEditor())
}

async function cmdWrite(args) {
  const f = args[0]
  if (!f) die('用法：node edu.mjs write <文件>')
  await pinCurrentTask()
  const text = readFileSync(resolve(f), 'utf8')
  await writeEditor(text)
  const back = await readEditor()
  const same = back.trim() === text.trim()
  const { dir } = currentDir()
  writeFileSync(join(dir, 'solution.cpp'), text)
  log(same ? `✓ 已写入并校验一致（${text.split('\n').length} 行），已存 ${dir}/solution.cpp`
           : `⚠️ 写入后内容与文件不一致（编辑器 ${back.split('\n').length} 行）——请用 edu code 查看`)
}

async function cmdRunOrSubmit(which) {
  await pinCurrentTask()
  const { dir, meta } = currentDir()
  log(`${which === 'submit' ? '提交评测' : '自测运行'}：${meta.name}`)
  const text = await clickAndWait(which === 'submit' ? '评测' : '自测运行')
  writeFileSync(join(dir, 'result.txt'), text)
  const v = verdict(text)
  log('------ 结果 ------')
  log(text.split('\n').slice(0, 14).join('\n'))
  log('------------------')
  log(`${v.pass ? '✅ 通过' : '❌ 未通过'}  ${v.score} ${v.summary}`)
  log(`结果已存 ${dir}/result.txt`)
  process.exitCode = v.pass ? 0 : 1
}

async function cmdNext() {
  await pinCurrentTask()
  const href = await page(`(() => {
    const a = [...document.querySelectorAll('a')].find((e) => (e.innerText || '').trim() === '下一关' && e.getAttribute('href'));
    return a ? a.getAttribute('href') : '';
  })()`)
  if (!href) die('页面上没有「下一关」')
  const url = href.startsWith('http') ? href : BASE + href
  await withPage(loadState(), (s) => s.send('Page.navigate', { url }))
  await sleep(9000)
  const lvl = await page(`(document.body.innerText.match(/第\\d+关[：:][^\\n]*/) || [''])[0]`)
  const st = loadState()
  const taskPath = new URL(url).pathname
  pinTab(taskPath)
  if (st.currentTask) saveState({ ...loadState(), currentTask: { ...st.currentTask, url, name: lvl || st.currentTask.name } })
  log(`下一关：${lvl}\n${url}`)
}

async function cmdShot(args) {
  const out = resolve(args[0] || 'edu-shot.png')
  await withPage(loadState(), async (s) => {
    const r = await s.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(out, Buffer.from(r.data, 'base64'))
  })
  log(`已保存 ${out}`)
}

// ---------- 入口 ----------
const [cmd, ...rest] = process.argv.slice(2)
const commands = {
  start: async () => { execFileSync(NODE, [CDP, 'start', '--headful'], { stdio: 'inherit' }) },
  stop: async () => { execFileSync(NODE, [CDP, 'stop'], { stdio: 'inherit' }) },
  status: cmdStatus,
  list: cmdList,
  open: cmdOpen,
  code: cmdCode,
  write: cmdWrite,
  run: () => cmdRunOrSubmit('run'),
  submit: () => cmdRunOrSubmit('submit'),
  next: cmdNext,
  shot: cmdShot,
}
if (!cmd || !commands[cmd]) {
  console.log(`头歌做题 CLI

  node edu.mjs start                     启动自动化浏览器
  node edu.mjs status [实验id|--all]     巡检完成状态（并刷新 plan.json）
  node edu.mjs list                      看 plan.json 里的题目与状态
  node edu.mjs open <关键字|--next> [--exp 实验id]
                                         打开题目并导出 题面.md / starter.cpp
  node edu.mjs code                      打印编辑器全文
  node edu.mjs write <文件>              把文件写进编辑器（不提交）
  node edu.mjs run                       自测运行
  node edu.mjs submit                    提交评测
  node edu.mjs next                      跳到实训下一关
  node edu.mjs shot <png>                截图`)
  process.exit(cmd ? 1 : 0)
}
try {
  await commands[cmd](rest)
} catch (e) {
  die(e.message)
}
