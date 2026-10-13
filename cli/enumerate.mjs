#!/usr/bin/env node
/**
 * 枚举某个 shixun_homework（作业/实验）下的全部题目：标题、完成状态、是否补交。
 * 用法: node enumerate.mjs <itemId> [itemName]
 * 输出: educoder/plan.json 里累积记录
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withPage, loadState, sleep } from '../dsh-vision/tools/cdp-browser.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLAN = resolve(HERE, 'plan.json')
const itemId = process.argv[2]
const itemName = process.argv[3] || itemId
if (!itemId) throw new Error('用法: node enumerate.mjs <itemId> [itemName]')

const state = loadState()
const url = `https://www.educoder.net/classrooms/8fiw5xey/shixun_homework/${itemId}`

await withPage(state, async (s) => {
  await s.send('Page.navigate', { url })
  await sleep(8000)
  const text = await s.evaluate ? null : null
  const body = await (await import('../dsh-vision/tools/cdp-browser.mjs')).evaluate(s, 'document.body.innerText')

  // 解析形如「2xxx:题目名 ... 开始学习 ... 0/1 或 1/1」的条目
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean)
  const items = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\d{3,5})\s*[:：]\s*(.+)$/.exec(lines[i])
    if (!m) continue
    let status = ''
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      if (/^[01]\/1$/.test(lines[j])) { status = lines[j]; break }
      if (/^\d{3,5}\s*[:：]/.test(lines[j])) break
    }
    items.push({ id: m[1], title: m[2].slice(0, 60), done: status === '1/1', status })
  }
  const plan = existsSync(PLAN) ? JSON.parse(readFileSync(PLAN, 'utf8')) : {}
  plan[itemId] = { name: itemName, url, total: items.length, completed: items.filter((x) => x.done).length, items }
  writeFileSync(PLAN, JSON.stringify(plan, null, 2))
  console.log(`${itemName}(${itemId}): 共 ${items.length} 题，已完成 ${items.filter((x) => x.done).length} 题`)
  for (const it of items) console.log(`   ${it.done ? '✓' : '·'} ${it.id}: ${it.title}`)
})
process.exit(0)
