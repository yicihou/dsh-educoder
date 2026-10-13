# dsh-educoder

给 **DeepSeek Harness（DSH）** 用的**头歌（educoder.net）做题工具**：把"巡检完成状态 → 打开题目 → 读题面 → 写代码 → 提交评测 → 判定结果"这条流程固化下来。

同一套逻辑分两层，**CLI 是唯一的实现，插件只是把 CLI 包成 DSH 原生工具**：

```
dsh-educoder/
├─ cli/        ← 命令行层：edu.mjs（10 条子命令）+ 辅助脚本 + 自带的 CDP 浏览器驱动
└─ plugin/     ← DSH 插件层：7 个原生工具（内部 spawn 调用 cli/edu.mjs）
```

## 快速开始（命令行）

```bash
cd cli
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node   # 或任意 node ≥ 18

$NODE edu.mjs start                          # 启动自动化浏览器（首次需在窗口里登录头歌）
$NODE edu.mjs status                         # 巡检：哪些题还没做（⬜）
$NODE edu.mjs open --next --exp 1665192      # 打开下一道未完成的题，导出题面与初始代码
#   → 照 work/<题目>/题面.md 写好 solution.cpp
$NODE edu.mjs write work/<题目>/solution.cpp && $NODE edu.mjs submit
#   → ✅ 通过  10/10 全部通过
```

命令一览：`start` / `stop` / `status` / `list` / `open` / `code` / `write` / `run` / `submit` / `next` / `shot`，
详见 [cli/README.md](cli/README.md)（含工作原理与踩坑记录）。

## 在 DSH 里安装插件

插件是**零依赖**的 npm 包（`link:` 挂载不会安装被链接包自己的依赖，所以刻意不 import `@deepseek-ai/*`）。

方式一：用 DSH 的插件管理（需要 danger-full-access 权限）

```
plugin_manager: action=install_bundle, target=link:<本仓库绝对路径>/plugin
```

方式二：手工在 profile 的补丁层里加一行（`~/.dsh/profiles/desktop/cordis.patch.yml`）

```yaml
- insert:
    - id: tool-educoder
      name: 'dsh-educoder'
      config:
        home: '<本仓库绝对路径>/cli'      # edu.mjs 所在目录
        nodeBin: '<node 可执行文件绝对路径>'
```

装好后 DSH 里会出现 7 个工具：

| 工具 | 作用 |
|---|---|
| `educoder_status` | 巡检每个实验/作业里每道题的状态 |
| `educoder_open` | 打开题目（关键字或"下一道未完成"）并导出题面/代码 |
| `educoder_read_editor` | 读当前编辑器全文 |
| `educoder_write` | 把本地文件写进编辑器（写后回读校验） |
| `educoder_run` | 自测运行（不占评测次数） |
| `educoder_submit` | 提交评测并返回判定 |
| `educoder_next` | 跳实训的下一关 |

> 改插件 **config** 立即生效；改插件 **JS 代码**需要重启 DSH（模块被缓存）。

## 运行前提

- **macOS + Microsoft Edge**：`cli/cdp-browser.mjs` 用 CDP 驱动 Edge（本机没有 Chrome/Chromium 时的选择）。启动参数已带 `--no-sandbox --disable-gpu --disable-popup-blocking --no-proxy-server`：
  - `--no-sandbox`：DSH 的 seatbelt 会让 Chromium 自带沙箱初始化失败；
  - `--no-proxy-server`：本机系统代理可能指向未运行的本地端口（DSH 自己的代理），会导致 `ERR_PROXY_CONNECTION_FAILED`，而头歌直连可达。
- **登录**：头歌需要登录。首次 `start` 用有窗口模式（`--headful`），在窗口里登录一次，cookie 存在 `<repo>/.cdp-browser/profile`。
- 只有 Chrome 系浏览器能用这套；Safari 不行。

## 关于本仓库与工作区副本

开发时脚本"活"在 DSH 工作区（`<workspace>/educoder/` 与 `<workspace>/dsh-plugins/dsh-educoder/`），
本仓库是它的**版本化归档**。改完活副本后跑一次：

```bash
./sync.sh          # 工作区 → 本仓库（并修正仓库专用的路径引用）
git add -A && git commit -m "sync: ..."
```

`sync.sh` 会同步：`cli/*.mjs`、`cli/*.py`、`cli/README.md`、`cli/cdp-browser.mjs`（vendored 自
`dsh-vision/tools/cdp-browser.mjs`）、`plugin/**`；并把 `plugin/cordis.patch.yml` 的 `home` 指向本仓库的 `cli/`。

**不进版本库的东西**（`.gitignore`）：`work/`（题目原文与解答记录）、`plan.json`（巡检产物）、
`.cdp-browser/`（浏览器 profile 与状态）、`node_modules/`、截图与日志。

## 说明

- 本工具只操作**使用者自己已登录的头歌账号**，不破解平台接口：所有动作都是"真人操作级别的 UI 自动化"
  （真实鼠标事件、真实剪贴板粘贴），因此不存在绕过签名/风控的问题。
- 题面、代码、评测结果都只写在本地。

## License

MIT（如需正式开源，补一个 `LICENSE` 文件即可）。
