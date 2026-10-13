#!/usr/bin/env node
/**
 * 打开某张卡片（点击它的「开始学习」），把新开的题目标签页 URL 打印出来。
 * 用法: node open-card.mjs <列表页URL> "<卡片标题关键字>"
 * 说明：先关掉所有已有 /tasks/ 标签，避免 pageTarget() 选错标签。
 */
import { loadState, httpJson, sleep } from '../dsh-vision/tools/cdp-browser.mjs'

const [listUrl, keyword] = process.argv.slice(2)
if (!listUrl || !keyword) throw new Error('用法: node open-card.mjs <列表页URL> "<卡片标题关键字>"')
const state = loadState()

const listPages = async () =>
  (await httpJson(`http://127.0.0.1:${state.port}/json/list`)).filter((t) => t.type === 'page')

// 关掉旧的 /tasks/ 标签
for (const t of await listPages()) {
  if (/\/tasks\//.test(t.url)) await httpJson(`http://127.0.0.1:${state.port}/json/close/${t.id}`).catch(() => {})
}
await sleep(1000)

const main = (await listPages()).slice(-1)[0]
if (!main) throw new Error('没有可用的标签页')
await fetch(`http://127.0.0.1:${state.port}/json/activate/${main.id}`).catch(() => {})

const { connect } = await import('../dsh-vision/tools/cdp-browser.mjs')
const s = await connect(main.webSocketDebuggerUrl)
await s.send('Page.navigate', { url: listUrl })
await sleep(9000)

const box = await (async () => {
  const r = await s.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const kw = ${JSON.stringify(keyword)};
      const leaves = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.innerText || '').includes(kw));
      for (const leaf of leaves) {
        let card = leaf;
        for (let i = 0; i < 8 && card.parentElement; i++) {
          card = card.parentElement;
          if (/开始学习/.test(card.innerText || '') && card.innerText.length < 400) break;
        }
        const btn = [...card.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.innerText || '').trim() === '开始学习');
        if (!btn) continue;
        btn.scrollIntoView({ block: 'center' });
        const b = btn.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), card: card.innerText.replace(/\\n+/g, ' | ').slice(0, 80) };
      }
      return null;
    })()`,
  })
  return r.result?.value
})()

if (!box) { console.log('找不到卡片按钮'); process.exit(1) }
console.log('卡片：', box.card)

const before = new Set((await listPages()).map((t) => t.id))
for (const type of ['mousePressed', 'mouseReleased']) {
  await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
}
await sleep(8000)
let after = await listPages()
if (!after.some((t) => /\/tasks\//.test(t.url))) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  await sleep(8000)
  after = await listPages()
}
const fresh = after.find((t) => !before.has(t.id) && /\/tasks\//.test(t.url)) || after.filter((t) => /\/tasks\//.test(t.url)).pop()
s.close()
if (!fresh) { console.log('没有新开 /tasks/ 标签'); process.exit(1) }
console.log('URL:', fresh.url)
console.log('TITLE:', fresh.title)
