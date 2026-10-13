#!/usr/bin/env node
/** 跳到实训的「下一关」（页面上「下一关」是个 <a href="/tasks/xxx">）。用法: node nextlevel.mjs */
import { withPage, evaluate, loadState, sleep } from '../dsh-vision/tools/cdp-browser.mjs'

const state = loadState()
await withPage(state, async (s) => {
  const href = await evaluate(s, `(() => {
    const a = [...document.querySelectorAll('a')].find((e) => (e.innerText || '').trim() === '下一关' && e.getAttribute('href'));
    return a ? a.getAttribute('href') : '';
  })()`)
  if (!href) { console.log('页面上没有「下一关」链接'); process.exitCode = 1; return }
  const url = href.startsWith('http') ? href : 'https://www.educoder.net' + href
  console.log('下一关:', url)
  await s.send('Page.navigate', { url })
  await sleep(9000)
  const info = await evaluate(s, `({ url: location.href, lvl: (document.body.innerText.match(/第\\d+关[：:][^\\n]*/) || [''])[0] })`)
  console.log(JSON.stringify(info))
})
process.exit(process.exitCode || 0)
