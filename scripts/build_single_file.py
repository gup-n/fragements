"""把 expo export 的 web 产物打包成一个自包含 HTML 文件。

做三件事：
1. 把 JS bundle 内联进 <script>，去掉对外部文件的依赖
2. 把 Ionicons 字体转成 base64 data URI 内联进去（其余图标字体用不到，保持原样即可）
3. 注入启动自诊断：白屏时把错误打到页面上，而不是让用户对着空白发呆

用法：
    python scripts/build_single_file.py [源目录] [输出文件]
源目录默认 preview/，输出默认根目录的「碎片-界面预览.html」。
"""

import base64
import re
import pathlib
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else r"F:/coding/python/project/Test/fragments/preview")
OUT = pathlib.Path(
    sys.argv[2]
    if len(sys.argv) > 2
    else r"F:/coding/python/project/Test/fragments/碎片-界面预览.html"
)

if not (ROOT / "index.html").exists():
    raise SystemExit(f"{ROOT}/index.html 不存在，先跑 expo export")

html = (ROOT / "index.html").read_text(encoding="utf-8")

m = re.search(r'<script src="([^"]+)" defer></script>', html)
if not m:
    raise SystemExit("找不到 bundle script 标签")
bundle_rel = m.group(1).lstrip("/")
bundle = (ROOT / bundle_rel).read_text(encoding="utf-8")

fonts = sorted((ROOT / "assets").rglob("Ionicons.*.ttf"))
if not fonts:
    raise SystemExit("找不到 Ionicons 字体")
font_b64 = base64.b64encode(fonts[0].read_bytes()).decode("ascii")
pattern = re.compile(r"/assets/node_modules/@expo/vector-icons[^\"]*?/Fonts/Ionicons\.[0-9a-f]+\.ttf")
bundle, n = pattern.subn(lambda _: f"data:font/ttf;base64,{font_b64}", bundle)
print(f"内联字体替换 {n} 处，字体 {fonts[0].name}")

bundle = bundle.replace("</script>", "<\\/script>")

boot_script = """
<script>
(function () {
  function show(msg) {
    var el = document.getElementById('boot-err');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'boot-err';
      el.style.cssText = 'position:fixed;inset:0;margin:0;padding:20px;background:#fff;color:#A32D2D;' +
        'font:12px/1.6 monospace;white-space:pre-wrap;overflow:auto;z-index:999999';
      document.body.appendChild(el);
    }
    el.textContent += msg + '\\n\\n';
  }
  window.addEventListener('error', function (e) {
    show('[error] ' + (e.message || e.error) + '\\n  at ' + (e.filename || '?') + ':' + (e.lineno || '?'));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    show('[promise] ' + ((r && (r.stack || r.message)) || r));
  });
  window.addEventListener('load', function () {
    setTimeout(function () {
      var root = document.getElementById('root');
      var note = document.getElementById('boot-note');
      if (root && root.children.length > 0) {
        if (note) note.remove();
      } else if (note) {
        note.textContent = '页面加载完成，但应用没有挂载成功。上方若有红色报错，请把它发给我。';
        note.style.color = '#A32D2D';
      }
    }, 4000);
  });
})();
</script>
"""

inlined = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
<title>碎片 · 界面预览</title>
<style>
  html, body {{ height: 100%; margin: 0; }}
  body {{ overflow: hidden; background: #EDEDE7; }}
  #root {{ display: flex; height: 100%; flex: 1; }}
  #boot-note {{
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    font: 13px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: #6E6E68; background: #fff; padding: 14px 20px; border-radius: 10px;
    border: 1px solid #DEDED6; z-index: 99999;
  }}
</style>
</head>
<body>
<div id="boot-note">正在加载界面…</div>
<div id="root"></div>
{boot_script}
<script>{bundle}</script>
</body>
</html>
"""

OUT.write_text(inlined, encoding="utf-8")
size_mb = OUT.stat().st_size / 1024 / 1024
print(f"已生成 {OUT.name}，{size_mb:.2f} MB")
