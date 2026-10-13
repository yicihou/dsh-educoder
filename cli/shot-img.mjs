#!/usr/bin/env node
/**
 * 把页面上第 n 张「正文插图」放大截图保存，方便看清图里的文字。
 * 用法: node shot-img.mjs <第几张(从0计，只数宽>80的图)> <输出png> [放大倍数]
 */
import { writeFileSync } from 'node:fs'
import { withPage, evaluate, loadState, sleep } from '../dsh-vision/tools/cdp-browser.mjs'

const idx = Number(process.argv[2] || 0)
const out = process.argv[3] || `img-${idx}.png`
const scale = Number(process.argv[4] || 3)

const state = loadState()
await withPage(state, async (s) => {
  const box = await evaluate(s, `(() => {
    const imgs = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 80);
    const el = imgs[${idx}];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), src: el.src.slice(0, 80) };
  })()`)
  if (!box) throw new Error('找不到该图片')
  await sleep(600)
  const shot = await s.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale },
  })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`已保存 ${out}  (${box.width}x${box.height} × ${scale})  src=${box.src}`)
})
process.exit(0)
