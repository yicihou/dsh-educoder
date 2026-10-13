/**
 * dsh-educoder —— 头歌（educoder）做题助手插件。
 *
 * 本插件不自己实现浏览器自动化，而是**调用现成的 `edu` CLI**
 * （<home>/edu.mjs，零依赖 Node 脚本，内部用 CDP 驱动 Edge）。
 * 这样"脚本层"和"插件层"共用同一套逻辑：你在终端里怎么用，模型就怎么用。
 *
 * 注册的工具：
 *   educoder_status      巡检：每个实验/作业里每道题的完成状态
 *   educoder_open        打开题目（关键字或"下一道未完成"）并导出题面/代码
 *   educoder_read_editor 读当前编辑器全文
 *   educoder_write       把本地文件写进编辑器（不提交）
 *   educoder_run         自测运行
 *   educoder_submit      提交评测并返回判定结果
 *   educoder_next        跳到实训的下一关
 *
 * 刻意保持**零依赖**：DSH 以 `link:` 方式挂载本目录，不会安装本包自己的依赖，
 * 所以这里不 import 任何 @deepseek-ai/* 包，直接构造工具定义对象。
 *
 * @module dsh-educoder
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const name = 'dsh-educoder'
const inject = ['tools']

/** 默认的 node 可执行文件：DSH 自带运行时里的那个（Electron 主进程不能直接当 node 用）。 */
const DEFAULT_NODE = '/Users/Lenovo/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node'
/** 默认的 edu CLI 所在目录。 */
const DEFAULT_HOME = '/Users/Lenovo/Documents/deepseek-harness/default-workspace/educoder'

function resolveConfig(config) {
  const home = (config?.home || DEFAULT_HOME).replace(/\/+$/, '')
  return {
    home,
    cli: config?.cli || join(home, 'edu.mjs'),
    nodeBin: config?.nodeBin || DEFAULT_NODE,
    timeoutMs: Number(config?.timeoutMs ?? 180000),
    submitTimeoutMs: Number(config?.submitTimeoutMs ?? 600000),
  }
}

/** 跑一条 edu 子命令，收集输出。 */
function runCli(cfg, args, timeoutMs) {
  return new Promise((resolve) => {
    if (!existsSync(cfg.cli)) {
      resolve({ code: 127, out: '', err: `找不到 CLI：${cfg.cli}（请检查插件 config.home）` })
      return
    }
    const child = spawn(cfg.nodeBin, [cfg.cli, ...args], { cwd: cfg.home, env: process.env })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 忽略 */ }
      resolve({ code: 124, out, err: err + `\n[执行超时 ${timeoutMs}ms，已终止]` })
    }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, out, err: err + String(e?.message ?? e) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, out, err }) })
  })
}

const asText = (r) => {
  const parts = []
  if (r.out.trim()) parts.push(r.out.trim())
  if (r.err.trim()) parts.push('--- stderr ---\n' + r.err.trim())
  parts.push(`（退出码 ${r.code}${r.code === 0 ? '，成功' : '，未通过/失败'}）`)
  return parts.join('\n\n')
}

function tools(cfg) {
  return [
    {
      name: 'educoder_status',
      description: '巡检头歌课堂的作业/实验完成情况：逐个实验列出每道题的状态（✅已完成 / ⬜未完成），并刷新本地 plan.json。参数 expId 指定某个实验 id；all=true 时连章节作业一起扫（较慢）。',
      parameters: {
        type: 'object',
        properties: {
          expId: { type: 'string', description: '实验/作业 id（如 1665192）；省略则扫全部"实验*"' },
          all: { type: 'boolean', description: '为 true 时连"第X章作业"一起巡检（页面较多，耗时约 2 分钟）' },
        },
      },
      timeoutMs: 600000,
      async execute(args) {
        const a = []
        if (args?.expId) a.push(String(args.expId))
        else if (args?.all === true) a.push('--all')
        return asText(await runCli(cfg, ['status', ...a], 600000))
      },
    },
    {
      name: 'educoder_open',
      description: '打开一道头歌题目并导出到本地：题面写入 work/<题目>/题面.md、编辑器当前内容写入 starter.cpp、元信息写入 meta.json。可传 keyword（题目名或题号片段，如 "2022"）或 next=true（打开第一道未完成的题）。打开后该题目会被锁定，后续 read_editor/write/run/submit 都作用于它。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '题目名或题号片段；与 next 二选一' },
          next: { type: 'boolean', description: '为 true 时打开"第一道未完成的题"' },
          expId: { type: 'string', description: '限定在某个实验里找（如 1665192），可加快速度' },
        },
      },
      timeoutMs: 240000,
      async execute(args) {
        const a = ['open']
        if (args?.keyword) a.push(String(args.keyword))
        else if (args?.next === true) a.push('--next')
        else throw new Error('请提供 keyword（题目名片段）或 next=true')
        if (args?.expId) a.push('--exp', String(args.expId))
        return asText(await runCli(cfg, a, 240000))
      },
    },
    {
      name: 'educoder_read_editor',
      description: '读取当前头歌题目编辑器里的全部代码（返回纯文本）。',
      parameters: { type: 'object', properties: {} },
      timeoutMs: cfg.timeoutMs,
      async execute() { return asText(await runCli(cfg, ['code'], cfg.timeoutMs)) },
    },
    {
      name: 'educoder_write',
      description: '把本地代码文件写入当前头歌题目编辑器（整段替换，保留缩进），写入后会自动回读校验，并把副本存到 work/<题目>/solution.cpp。不会提交评测。',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string', description: '要写入的本地文件路径（.cpp）' } },
        required: ['file'],
      },
      timeoutMs: cfg.timeoutMs,
      async execute(args) {
        if (!args?.file) throw new Error('缺少参数 file')
        return asText(await runCli(cfg, ['write', String(args.file)], cfg.timeoutMs))
      },
    },
    {
      name: 'educoder_run',
      description: '在当前题目上点「自测运行」并返回运行输出（不占用评测次数，适合提交前先验证样例）。',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 600000,
      async execute() { return asText(await runCli(cfg, ['run'], 600000)) },
    },
    {
      name: 'educoder_submit',
      description: '提交当前题目并等待平台评测，返回判定结果（如「✅ 通过 10/10 全部通过」或失败差异）。结果同时存到 work/<题目>/result.txt。评测较慢，通常 20 秒~3 分钟。',
      parameters: { type: 'object', properties: {} },
      timeoutMs: cfg.submitTimeoutMs + 30000,
      async execute() { return asText(await runCli(cfg, ['submit'], cfg.submitTimeoutMs)) },
    },
    {
      name: 'educoder_next',
      description: '在当前实训（多关卡）里跳到「下一关」。',
      parameters: { type: 'object', properties: {} },
      timeoutMs: cfg.timeoutMs,
      async execute() { return asText(await runCli(cfg, ['next'], cfg.timeoutMs)) },
    },
  ]
}

function apply(ctx, config) {
  const cfg = resolveConfig(config)
  for (const t of tools(cfg)) {
    ctx.tools.register({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: t.timeoutMs,
      async execute(args) { return await t.execute(args) },
    })
  }
}

export { apply, inject, name }
