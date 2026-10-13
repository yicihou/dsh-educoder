import { withPage, evaluate, loadState, sleep } from '../dsh-vision/tools/cdp-browser.mjs'
const Q = `(() => {
  const eds = [...document.querySelectorAll('.monaco-editor')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 80 && getComputedStyle(e).display !== 'none' })
  if (!eds.length) return null
  const el = eds.sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return rb.width*rb.height-ra.width*ra.height})[0]
  el.scrollIntoView({ block:'center' })
  const r = (el.querySelector('.view-lines')||el).getBoundingClientRect()
  return { x: Math.round(r.left + 120), y: Math.round((Math.max(r.top,70)+Math.min(r.bottom,innerHeight-30))/2) }
})()`
const state = loadState()
await withPage(state, async (s) => {
  const box = await evaluate(s, Q)
  for (const type of ['mousePressed','mouseReleased']) await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(400)
  await s.send('Input.dispatchKeyEvent', { type:'keyDown', modifiers:4, key:'a', code:'KeyA', windowsVirtualKeyCode:65, commands:['selectAll'] })
  await s.send('Input.dispatchKeyEvent', { type:'keyUp', modifiers:4, key:'a', code:'KeyA', windowsVirtualKeyCode:65 })
  await sleep(300)
  await s.send('Input.dispatchKeyEvent', { type:'keyDown', modifiers:4, key:'v', code:'KeyV', windowsVirtualKeyCode:86, commands:['paste'] })
  await s.send('Input.dispatchKeyEvent', { type:'keyUp', modifiers:4, key:'v', code:'KeyV', windowsVirtualKeyCode:86 })
  await sleep(1200)
  console.log('粘贴命令已发送')
})
process.exit(0)
