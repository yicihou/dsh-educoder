#!/usr/bin/env bash
# 把 DSH 工作区里的「活」副本同步进本仓库（工作区 → 仓库），并修正仓库专用的路径引用。
#
#   ./sync.sh                      # 用默认工作区路径
#   WS=/path/to/default-workspace ./sync.sh
#
# 同步完记得提交：  git add -A && git commit -m "sync: <改了什么>"
set -euo pipefail

WS="${WS:-$HOME/Documents/deepseek-harness/default-workspace}"
REPO="$(cd "$(dirname "$0")" && pwd)"

[ -d "$WS/educoder" ] || { echo "✗ 找不到 $WS/educoder（用 WS=<路径> 指定工作区）"; exit 1; }
[ -d "$WS/dsh-plugins/dsh-educoder" ] || { echo "✗ 找不到 $WS/dsh-plugins/dsh-educoder"; exit 1; }

echo "工作区: $WS"
echo "仓库:   $REPO"

mkdir -p "$REPO/cli" "$REPO/plugin"

# ① CLI 层（不含 lab*/work/imgs/build/plan.json/完成报告——那些是本地产物或作业答案）
cp "$WS/educoder/"*.mjs "$WS/educoder/"*.py "$WS/educoder/README.md" "$REPO/cli/"
# ② 自带的 CDP 驱动（vendored 副本，让 cli/ 能独立运行）
cp "$WS/dsh-vision/tools/cdp-browser.mjs" "$REPO/cli/"
# ③ 插件层
cp "$WS/dsh-plugins/dsh-educoder/package.json" \
   "$WS/dsh-plugins/dsh-educoder/cordis.patch.yml" \
   "$WS/dsh-plugins/dsh-educoder/README.md" "$REPO/plugin/"
rm -rf "$REPO/plugin/lib"
cp -R "$WS/dsh-plugins/dsh-educoder/lib" "$REPO/plugin/"

# ④ 仓库专用修正（活副本里的路径是按工作区布局写的）
/usr/bin/sed -i '' 's|\.\./educoder/README\.md|../cli/README.md|g' "$REPO/plugin/README.md"
/usr/bin/sed -i '' "s|^\( *\)home: '.*'|\1home: '$REPO/cli'|" "$REPO/plugin/cordis.patch.yml"

echo
echo "=== 同步结果（git status）==="
git -C "$REPO" status --short || true
echo
echo "下一步： git -C \"$REPO\" add -A && git -C \"$REPO\" commit -m 'sync: ...'"
