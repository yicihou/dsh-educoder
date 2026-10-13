#!/usr/bin/env node
/**
 * 用「全选 + 粘贴」把剪贴板里的代码整段替换进 Monaco 编辑器。
 * 比逐字符 insertText 更可靠：Monaco 对真实粘贴不会重新缩进，格式与文件完全一致。
 * 用法: pbcopy < 代码文件 && node setcode.mjs
 */
import { withPage, evaluate, loadState, sleep } from '../dsh-vision/tools/cdp-browser.mjs'

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
  const r = (el.querySelector('.view-lines') || el).getBoundingClientRect();
  const top = Math.max(r.top, 70);
  const bottom = Math.min(r.bottom, innerHeight - 30);
  return { x: Math.round(r.left + Math.min(150, Math.max(30, r.width / 3))), y: Math.round((top + bottom) / 2) };
})()`

const state = loadState()
await withPage(state, async (s) => {
  let done = false
  for (let attempt = 0; attempt < 4 && !done; attempt++) {
    const box = await evaluate(s, EDITOR_QUERY)
    if (!box) throw new Error('找不到可见的 Monaco 编辑器')
    const x = box.x + attempt * 15
    const y = box.y + attempt * 10
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
    await sleep(350)
    const active = await evaluate(s, `(document.activeElement && document.activeElement.className) || ''`)
    if (!String(active).includes('inputarea')) continue
    const empty = await evaluate(s, `(() => {
      const eds = [...document.querySelectorAll('.monaco-editor')].filter((e) => e.getBoundingClientRect().width > 200);
      const el = eds.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
      if (!el) return true;
      const vl = el.querySelector('.view-lines');
      return (vl ? vl.innerText : el.innerText).trim().length === 0;
    })()`)
    if (!empty) {
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
      await sleep(350)
      const sel = await evaluate(s, `document.querySelectorAll('.monaco-editor .selected-text').length`)
      if (!sel) continue
    }
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, commands: ['paste'] })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 })
    await sleep(1500)
    console.log('已粘贴代码')
    done = true
  }
  if (!done) { console.log('粘贴失败：无法聚焦/全选编辑器'); process.exitCode = 1 }
})
process.exit(process.exitCode || 0)
