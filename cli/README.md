# edu —— 头歌（educoder）做题 CLI

把"巡检 → 打开题目 → 读题面 → 写代码 → 提交评测 → 判定结果"从 **6~8 步手工操作**压成 **2~3 条命令**。

零依赖：只用 Node 内置模块 + `../dsh-vision/tools/cdp-browser.mjs`（自建 CDP 驱动，控制 Edge）。

## 快速开始（4 步）

```bash
cd ~/Documents/deepseek-harness/default-workspace/educoder
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node

$NODE edu.mjs start                      # ① 启动自动化浏览器（首次需在窗口里登录头歌，cookie 会留存）
$NODE edu.mjs status                     # ② 巡检：哪些题还没做（⬜）
$NODE edu.mjs open --next --exp 1665192  # ③ 打开第一道未完成的题，导出题面与编辑器内容
#    → 在 work/<题目>/ 里照着 题面.md 写 solution.cpp
$NODE edu.mjs write work/<题目>/solution.cpp && $NODE edu.mjs submit   # ④ 写入并评测
```

看到 `✅ 通过  10/10 全部通过` 就完成了。

## 命令一览

| 命令 | 作用 |
|---|---|
| `edu.mjs start` / `stop` | 起停自动化浏览器（带 `--no-proxy-server`，见下） |
| `edu.mjs status [实验id\|--all]` | 逐实验列出每道题状态（✅/⬜），刷新 `plan.json` |
| `edu.mjs list` | 离线看 `plan.json` 里的题目与状态 |
| `edu.mjs open <关键字\|--next> [--exp 实验id]` | 打开题目并导出 `题面.md` / `starter.cpp` / `meta.json`，锁该题 |
| `edu.mjs code` | 打印当前编辑器全文 |
| `edu.mjs write <文件>` | 把文件整段写进编辑器（写后回读校验，副本存 `solution.cpp`） |
| `edu.mjs run` | 自测运行（不占评测次数） |
| `edu.mjs submit` | 提交评测 + 轮询判定，结果存 `result.txt` |
| `edu.mjs next` | 跳实训的下一关 |
| `edu.mjs shot <png>` | 截图 |

## 产物目录

```
educoder/
├─ edu.mjs                    ← CLI 本体
├─ plan.json                  ← status 刷新的题目清单与状态
└─ work/<题目>/
   ├─ 题面.md                 ← 题目说明（含来源实验与 URL）
   ├─ starter.cpp             ← 打开时的编辑器内容（新题即初始模板）
   ├─ solution.cpp            ← 你写入的代码（write 时存副本）
   ├─ result.txt              ← 最近一次评测的完整结果文本
   └─ meta.json               ← 题名/实验/URL/进度
```

## 工作原理（为什么这么写）

- **编辑器是 Monaco**，页面上另有隐藏的 CodeMirror，别搞错对象。
- **读取**：聚焦编辑器 → `Cmd+A` → CDP `commands:['selectAll','copy']` → 系统剪贴板 → `pbpaste`。
  不用 `.view-line`：Monaco 是虚拟滚动，只渲染可视行，读不全。
- **写入**：`pbcopy` → 聚焦 → 全选 → CDP `commands:['paste']`。
  用真实粘贴而不是 `Input.insertText`：后者会触发 Monaco 的级联自动缩进、把代码挤歪。
- **点击必须落在编辑器内部**：顶部被吸顶导航盖住；且编辑器**中部**常被浮层遮挡，所以
  聚焦前会用 `elementFromPoint` 探测候选点，被挡住就依次：①点掉它 ②按 Esc ③清理浮层。
- **浮层处理**：
  - 「评测结果」面板（`.evaluate-result-container`，fixed 定位，会压住编辑器）——用平台**自带的关闭按钮**关掉。
    ⚠️ 绝不能用 `display:none` 隐藏它，否则之后 `document.body.innerText` 读不到评测结果。
  - 「金币/经验」奖励飘字（`.gold-and-experience`，纯装饰、无按钮、不自动消失）——直接移除 + 注入 CSS 防再插入。
- **标签定位**：`pageTarget` 取的是**第一个**匹配项，而标签顺序会随激活变化。多开题目标签时只按
  `/tasks/` 匹配会选错，所以一律**按题目 URL 路径精确匹配**（存在 `state.json` 的 `currentTask`），
  并在打开新题时关掉多余的 `/tasks/` 标签。

## 已知坑（踩过的）

1. **系统代理**：本机 HTTP/HTTPS/SOCKS 代理指向 `127.0.0.1:23292`（DSH 自己的代理端口）。该进程没在跑时，
   浏览器会 `ERR_PROXY_CONNECTION_FAILED`。所以浏览器用 `--no-proxy-server` 直连（头歌直连可达，实测 0.3s）。
2. **平台偶发"当前网络较差，代码下载超时"**：不是代码问题，重试即可；`submit` 的轮询最长等 4 分钟。
3. **老师会改实训关卡**（本次就删了"打印日历"、加了"计算函数值"）：完成度以 `status` 的实时结果为准，
   不要凭印象；卡片计数与详情页关卡表也可能不一致。
4. **只写函数 or 写整程序**：有的关卡模板没有 `main`（只有 `Program…End` 标记），说明判题程序自带主函数，
   这时**只写函数**；有的题目编辑器是空的、要求完整程序（含 `main`）。以 `starter.cpp` 里的模板为准。
5. **提交前先本地验证**：本机 `clang++` 可用（需先修好 CLT 的 SDK 混装问题），
   可以给函数补个临时 `main` 跑平台样例，输出一致再提交，省一次往返。

## 相关文件

- 完成报告（实验 1~4 的题目清单、解法要点、踩坑记录）：`完成报告.md`
- DSH 插件封装：`../dsh-plugins/dsh-educoder/`（工具 `educoder_status` / `educoder_open` / … 内部就是调这个 CLI）
- 早期脚本（仍可用，`edu.mjs` 是统一入口）：`ed.mjs`、`getcode.mjs`、`setcode.mjs`、`open-card.mjs`、`nextlevel.mjs`、`enumerate.mjs`、`fill.py`
