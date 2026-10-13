#!/usr/bin/env node
/**
 * 把各作业/实验里每道题的 /tasks/ URL 抓出来，写进 plan.json。
 * 做法：打开列表页 → 依次点击某题的「开始学习」→ 从 CDP 标签列表里找出新出现的 /tasks/ 标签 → 记录并关闭它。
 * 用法: node map-urls.mjs <itemId>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withPage, evaluate, loadState, httpJson, sleep } from '../dsh-vision/tools/cdp-browser.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLAN = resolve(HERE, 'plan.json')
const itemId = process.argv[2]
if (!itemId) throw new Error('用法: node map-urls.mjs <itemId>')

const plan = JSON.parse(readFileSync(PLAN, 'utf8'))
const entry = plan[itemId]
if (!entry) throw new Error(`plan.json 里没有 ${itemId}`)
const state = loadState()

async function tabs() {
  return (await httpJson(`http://127.0.0.1:${state.port}/json/list`)).filter((t) => t.type === 'page')
}

await withPage(state, async (s) => {
  await s.send('Page.navigate', { url: entry.url })
  await sleep(8000)
  for (const item of entry.items) {
    if (item.url) { console.log(`跳过 ${item.id}（已有 URL）`); continue }
    const box = await evaluate(s, `(() => {
      const title = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.innerText || '').trim().match(new RegExp('^' + ${JSON.stringify(item.id)} + '[:：]')));
      if (!title) return null;
      let card = title;
      for (let i = 0; i < 8 && card.parentElement; i++) { card = card.parentElement; if (/开始学习/.test(card.innerText || '')) break }
      const btn = [...card.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.innerText || '').trim() === '开始学习');
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });     // 关键：滚进视口再取坐标
      const r = btn.getBoundingClientRect();
      if (r.top < 0 || r.top > innerHeight - 10) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
    if (!box) { console.log(`⚠️ ${item.id} 找不到按钮`); continue }
    const before = new Set((await tabs()).map((t) => t.id))
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
    await sleep(6000)
    let after = await tabs()
    if (!after.some((t) => /\/tasks\//.test(t.url))) {
      // 再点一次（有时首次点击被页面动效吞掉）
      for (const type of ['mousePressed', 'mouseReleased']) {
        await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
      }
      await sleep(6000)
      after = await tabs()
    }
    const fresh = after.find((t) => !before.has(t.id) && /\/tasks\//.test(t.url))
      || after.filter((t) => /\/tasks\//.test(t.url)).pop()
    if (fresh) {
      item.url = fresh.url
      console.log(`✓ ${item.id}: ${fresh.url}`)
      // 关掉这个标签，保持环境干净
      await httpJson(`http://127.0.0.1:${state.port}/json/close/${fresh.id}`).catch(() => {})
      await sleep(1200)
    } else {
      console.log(`⚠️ ${item.id} 没抓到 /tasks/ 标签`)
    }
  }
  entry.mapped = true
  writeFileSync(PLAN, JSON.stringify(plan, null, 2))
  console.log('已写入 plan.json')
})
process.exit(0)
