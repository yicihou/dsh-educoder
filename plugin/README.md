# dsh-educoder

给 DSH 用的**头歌（educoder）做题助手**插件：把"巡检 → 打开题目 → 读题面 → 写代码 → 提交评测 → 判定结果"这条流程包成 7 个原生工具。

插件本身不做浏览器自动化，只是调用同目录体系里的 `edu` CLI（`<home>/edu.mjs`，零依赖 Node 脚本 + CDP 驱动 Edge）。**脚本层与插件层共用同一套逻辑**：终端里怎么用，模型就怎么用。

## 注册的工具

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `educoder_status` | 巡检每个实验/作业里每道题的状态（✅/⬜），并刷新 `plan.json` | `expId?`、`all?` |
| `educoder_open` | 打开题目并导出 `work/<题目>/题面.md` + `starter.cpp` + `meta.json`，并锁定该题目 | `keyword?`、`next?`、`expId?` |
| `educoder_read_editor` | 读当前编辑器全文 | — |
| `educoder_write` | 把本地文件整段写入编辑器（写后回读校验） | `file` |
| `educoder_run` | 自测运行（不占评测次数） | — |
| `educoder_submit` | 提交评测并返回判定（如 `✅ 通过 10/10 全部通过`） | — |
| `educoder_next` | 跳实训的下一关 | — |

## 配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
|---|---|---|
| `home` | `<workspace>/educoder` | `edu.mjs` 所在目录 |
| `nodeBin` | DSH 运行时里的 node | 用来跑 CLI（DSH 主进程是 Electron，不能当 node 用） |
| `timeoutMs` | 180000 | 一般命令超时 |
| `submitTimeoutMs` | 600000 | 提交评测超时（评测慢时给足时间） |

## 依赖与前置

- **零依赖**（`link:` 挂载不会装本包依赖，所以刻意不 import `@deepseek-ai/*`）。
- 需要先有 `edu` CLI（见 `../cli/README.md`），并且会自动浏览器 `edu start`；
  头歌需要登录一次（浏览器窗口里登录，cookie 存在 `.cdp-browser/profile`）。
- 浏览器已带 `--no-proxy-server`：本机系统代理指向 `127.0.0.1:23292`（DSH 自己的代理端口），
  未运行时会导致 `ERR_PROXY_CONNECTION_FAILED`，而头歌直连可达。

## 注意

- 插件 JS 代码改动后**必须重启 DSH** 才会重新加载（模块被缓存）；改 `config` 只需重跑 `apply()`。
- 首次安装/启用后若工具没出现，重启一次 DSH。
