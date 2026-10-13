#!/usr/bin/env node
/** 抓取头歌页面的 XHR/fetch 接口（URL + 响应片段），用于判断能否走接口批量处理。 */
import { withPage, evaluate, loadState, sleep } from '../dsh-vision/tools/cdp-browser.mjs'

const url = process.argv[2]
if (!url) throw new Error('用法: sniff.mjs <要加载的页面 URL>')
const state = loadState()

await withPage(state, async (s) => {
  const seen = []
  const ws = s // withPage 返回的对象没有事件订阅，这里改用 CDP 的 Network 事件
  // 需要自己接事件：直接在底层 WebSocket 上监听
  // withPage 内部已封装，这里用轮询 Network 方式：通过 Runtime 拿 performance entries
  await s.send('Network.enable')
  await s.send('Page.enable')
  await s.send('Page.navigate', { url })
  await sleep(9000)
  const entries = await evaluate(s, `JSON.stringify(performance.getEntriesByType('resource').filter(e => /api|ajax|json/i.test(e.name)).map(e => ({ n: e.name, t: e.initiatorType, sz: e.transferSize })).slice(0, 40))`)
  console.log(entries)
})

process.exit(0)
