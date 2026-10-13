#!/usr/bin/env node
/**
 * 一题一条命令：打开题目 → 写入代码 → 评测 → 等结果 → 报告是否通过。
 * 用法: node solve.mjs <taskUrl> <代码文件> [题目名]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { withPage, evaluate, loadState, sleep } from '../dsh-vision/tools/cdp-browser.mjs'
import { focusEditor, clearEditor, typeCode, clickButton } from './ed.mjs'

const [url, codeFile, label] = process.argv.slice(2)
if (!url || !codeFile) throw new Error('用法: node solve.mjs <taskUrl> <代码文件> [题目名]')
const code = readFileSync(resolve(codeFile), 'utf8')
const state = loadState()

const verdictOf = (t) => {
  const keys = ['恭喜', '通过', '不通过', '失败', '编译错误', '答案错误', '格式错误', '运行超时']
  const hits = keys.filter((k) => t.includes(k))
  const score = (t.match(/[01]\/1/g) || [])[0] || ''
  return { hits, score }
}

await withPage(state, async (s) => {
  console.log(`▶ ${label || url}`)
  await s.send('Page.navigate', { url })
  // 等页面真正可交互：能查到 Monaco 且 evaluate 能及时返回（首次进入题目时容器/IDE 启动较慢）
  for (let i = 0; i < 20; i++) {
    await sleep(5000)
    try {
      const ok = await Promise.race([
        evaluate(s, "(() => ({eds: document.querySelectorAll('.monaco-editor').length, busy: /服务启动中|正在启动/.test(document.body.innerText)}))()"),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 15000)),
      ])
      if (ok && ok.eds > 0) { console.log(`  页面就绪（${(i + 1) * 5}s，编辑器 ${ok.eds} 个${ok.busy ? '，容器仍启动中' : ''}）`); break }
    } catch { /* 页面还忙，继续等 */ }
  }

  // 写入代码
  const focused = await focusEditor(s, false)
  if (!focused) throw new Error('无法聚焦编辑器')
  await clearEditor(s)
  await typeCode(s, code)
  await sleep(1200)
  console.log(`  代码已写入（源码 ${code.length} 字符）`)

  // 直接评测
  let before = await evaluate(s, 'document.body.innerText')
  await clickButton(s, '评测')
  let verdict = ''
  const started = Date.now()
  while (Date.now() - started < 240000) {
    await sleep(6000)
    const t = await evaluate(s, 'document.body.innerText')
    const busy = ['服务启动中', '编译中', '运行中', '排队', '正在评测'].some((k) => t.includes(k))
    const { hits, score } = verdictOf(t)
    const tail = t.slice(-400).replace(/\s+/g, ' ')
    if (!busy && (hits.length > 0 || score)) {
      verdict = `${hits.join('/')}${score ? ' 得分=' + score : ''}`
      console.log(`  ✔ 结果：${verdict}`)
      console.log(`  尾部：${tail.slice(0, 180)}`)
      break
    }
    if (!busy && t !== before) {
      // 结果区变化但没识别到关键词，记录一次尾部继续等
      console.log(`  … ${((Date.now() - started) / 1000).toFixed(0)}s 尾部：${tail.slice(0, 120)}`)
      before = t
    }
  }
  if (!verdict) console.log('  ⚠️ 240 秒内未识别到明确结论，请人工检查')
  else if (/恭喜|通过/.test(verdict) && !/不通过/.test(verdict)) console.log('  ✅ 判定为通过')
  else console.log('  ❌ 判定为未通过')
})
process.exit(0)
