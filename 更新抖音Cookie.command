#!/bin/bash
# 抖音 Cookie 更新助手
# 用法：双击运行，按提示操作即可。抖音 Cookie 过期后（导入提示"Cookie 已过期"）跑一次这个。

VAULT="/Users/missv/Documents/自媒体知识库"
DATA="$VAULT/.obsidian/plugins/xiaohongshu-importer/data.json"
PY="/Users/missv/Doubao/tools/dyfetch/.venv/bin/python"
CHROME_DB="/Users/missv/Library/Application Support/Google/Chrome/Profile 4/Cookies"

echo ""
echo "======================================"
echo "  抖音 Cookie 更新助手"
echo "======================================"
echo ""

if [ ! -f "$DATA" ]; then
  echo "❌ 没找到插件配置文件：$DATA"
  echo "   确认 Obsidian 库路径没变。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

if pgrep -x "Google Chrome" >/dev/null; then
  echo "Chrome 正在运行，需要先退出它才能读到 Cookie。"
  echo "（重新打开 Chrome 会自动恢复你的标签页，放心）"
  echo ""
  osascript -e 'quit app "Google Chrome"' 2>/dev/null
  sleep 4
  if pgrep -x "Google Chrome" >/dev/null; then
    echo "⚠️  Chrome 没能自动退出，请手动退出后重新运行本脚本。"
    read -n 1 -s -r -p "按任意键关闭…"
    exit 1
  fi
  echo "✓ Chrome 已退出"
fi

echo ""
echo "正在读取 Chrome 里的抖音登录 Cookie…"

"$PY" - "$DATA" "$CHROME_DB" <<'PYEOF'
import sys, json, re
data_path, chrome_db = sys.argv[1], sys.argv[2]
try:
    import browser_cookie3
except ImportError:
    print("❌ 缺少依赖 browser_cookie3，请在终端运行：")
    print("   /Users/missv/Doubao/tools/dyfetch/.venv/bin/python -m pip install browser_cookie3")
    sys.exit(2)

try:
    cj = browser_cookie3.chrome(cookie_file=chrome_db)
except Exception as e:
    print("❌ 读取 Chrome Cookie 失败：%s" % e)
    print("   如果 Chrome 还在后台运行，请彻底退出后再试。")
    sys.exit(3)

cks = [c for c in cj if c.domain and "douyin" in c.domain and c.value]
if not cks:
    print("❌ 没找到抖音 Cookie。")
    print("   请先在 Chrome 打开 douyin.com 并登录（扫码），然后再跑一次。")
    sys.exit(4)

if not any(c.name == "sessionid" for c in cks):
    print("⚠️  找到 %d 条抖音 Cookie，但没有 sessionid（登录凭证）。" % len(cks))
    print("   说明浏览器里没登录：请打开 douyin.com 扫码登录后再跑一次。")
    sys.exit(5)

cookie = "; ".join("%s=%s" % (c.name, c.value) for c in cks)
d = json.load(open(data_path, encoding="utf-8"))
d["douyinCookie"] = cookie
json.dump(d, open(data_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("✓ 已写入 %d 条 Cookie（长度 %d）" % (len(cks), len(cookie)))
PYEOF

RC=$?
echo ""
if [ $RC -eq 0 ]; then
  echo "✅ 完成。回到 Obsidian 直接粘抖音链接导入就行（不用重启，插件每次导入会重读配置）。"
else
  echo "❌ 没成功，看上面对应的提示。"
fi
echo ""
read -n 1 -s -r -p "按任意键关闭…"
