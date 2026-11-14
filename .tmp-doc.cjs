const fs = require('fs');
const path = require('path');
const n = (f) => fs.readFileSync(f, 'utf8').split('\n').length - 1;

/** 幂等替换：已经改过的不再报错 */
const fix = (f, pairs) => {
  let s = fs.readFileSync(f, 'utf8');
  for (const [a, b] of pairs) {
    if (s.includes(b)) continue;
    if (!s.includes(a)) throw new Error(f + ' miss: ' + a);
    s = s.split(a).join(b);
  }
  fs.writeFileSync(f, s);
};

fix('README.md', [['v0.20.4（versionCode 55）', 'v0.20.5（versionCode 56）']]);
fix('ROADMAP.md', [['**v0.20.4**（versionCode 55）', '**v0.20.5**（versionCode 56）']]);
fix('HANDOFF.md', [
  ['对应版本 **v0.20.4（versionCode 55）**', '对应版本 **v0.20.5（versionCode 56）**'],
  ['| 版本 | v0.20.4 / versionCode 55 |', '| 版本 | v0.20.5 / versionCode 56 |'],
]);
fix('TEXTS.md', [['对应版本 v0.20.4。', '对应版本 v0.20.5。']]);

let h = fs.readFileSync('HANDOFF.md', 'utf8');
for (const f of ['App.tsx', 'src/screens/TimelineScreen.tsx', 'src/screens/SettingsScreen.tsx']) {
  const re = new RegExp('\\| `' + f.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '`([^|]*)\\| \\d+ \\|');
  if (!re.test(h)) throw new Error('miss row ' + f);
  h = h.replace(re, (m, mid) => `| \`${f}\`${mid}| ${n(f)} |`);
}
let total = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/[.]tsx?$/.test(p)) total += n(p);
  }
};
walk('src');
total += n('App.tsx');
h = h.replace(/共 \*\*[\d,]+ 行\*\*/, '共 **' + total.toLocaleString('en-US') + ' 行**');
fs.writeFileSync('HANDOFF.md', h);
console.log('total', total);
