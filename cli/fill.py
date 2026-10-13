#!/usr/bin/env python3
"""把「Begin/End」之间的内容换成本地写的实现，其余部分（含 main 与注释）一字不动。
用法: fill.py <原文件> <实现片段文件> <输出文件> [--marker BEGIN]
片段文件里按原缩进写即可；若原文件没有 Begin/End 标记，则用 --marker 指定要替换的函数体锚点。
"""
import sys, re

def main():
    orig_path, snippet_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    orig = open(orig_path).read()
    snippet = open(snippet_path).read().rstrip("\n")

    m = re.search(r"(?P<pre>[ \t]*/\*+\s*Begin\s*\*+/[ \t]*\n)(?P<body>.*?)(?P<post>[ \t]*/\*+\s*End\s*\*+/)",
                  orig, re.S)
    if not m:
        print("原文件里没有 Begin/End 标记，直接输出片段（请人工核对）")
        open(out_path, "w").write(snippet + "\n")
        return
    body = m.group("body")
    # 保留原 body 的缩进风格：取原 body 中第一处非空行的前导空白
    indents = [len(l) - len(l.lstrip()) for l in body.splitlines() if l.strip()]
    indent = " " * (indents[0] if indents else 4)
    lines = []
    for line in snippet.splitlines():
        lines.append((indent + line).rstrip() if line.strip() else "")
    new_body = "\n".join(lines) + "\n"
    out = orig[:m.start("body")] + new_body + orig[m.end("body"):]
    open(out_path, "w").write(out)
    print(f"已生成 {out_path}（替换 {len(body.splitlines())} 行 → {len(snippet.splitlines())} 行）")

main()
