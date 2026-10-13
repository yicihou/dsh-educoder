#!/usr/bin/env node
/**
 * 把当前 Monaco 编辑器的全文复制到系统剪贴板（配合 `pbpaste` 读取，
 * 绕开「虚拟滚动只渲染可视行」导致读不全的问题）。
 * 用法: node getcode.mjs   → 之后在 shell 里执行 pbpaste
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
  const lines = el.querySelector('.view-lines');
  const r = (lines || el).getBoundingClientRect();
  const top = Math.max(r.top, 70);
  const bottom = Math.min(r.bottom, innerHeight - 30);
  return { x: Math.round(r.left + Math.min(150, Math.max(30, r.width / 3))), y: Math.round((top + bottom) / 2) };
})()`

const state = loadState()
await withPage(state, async (s) => {
  let ok = false
  for (let attempt = 0; attempt < 4 && !ok; attempt++) {
    const box = await evaluate(s, EDITOR_QUERY)
    if (!box) throw new Error('找不到可见的 Monaco 编辑器')
    const x = box.x + attempt * 15
    const y = box.y + attempt * 10
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
    await sleep(350)
    const active = await evaluate(s, `(document.activeElement && document.activeElement.className) || ''`)
    console.log(`  尝试${attempt + 1}: 点击(${x},${y}) active=${active}`)
    if (!String(active).includes('inputarea')) continue
    const empty = await evaluate(s, `(() => {
      const eds = [...document.querySelectorAll('.monaco-editor')].filter((e) => e.getBoundingClientRect().width > 200);
      const el = eds.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
      if (!el) return true;
      const vl = el.querySelector('.view-lines');
      return (vl ? vl.innerText : el.innerText).trim().length === 0;
    })()`)
    if (empty) { console.log('编辑器为空（无需复制）'); ok = true; break }
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    await sleep(400)
    const sel = await evaluate(s, `document.querySelectorAll('.monaco-editor .selected-text').length`)
    if (sel > 0) {
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, commands: ['copy'] })
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 })
      await sleep(700)
      console.log(`已复制到剪贴板（选中 ${sel} 块）`)
      ok = true
    }
  }
  if (!ok) { console.log('复制失败：无法聚焦/全选编辑器'); process.exitCode = 1 }
})
process.exit(process.exitCode || 0)
