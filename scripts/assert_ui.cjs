#!/usr/bin/env node
/** UI contract regression: real component/style code plus in-memory RN/React doubles. No preview. */
const assert = require('node:assert/strict');
const { createLoader, createSuite, parseSource, plain, ts } = require('./test_loader.cjs');
const suite = createSuite('UI排版与布局回归');
const { test } = suite;
const pure = createLoader();
const tokens = pure.load('src/util/uiTokens.ts');
const appearance = pure.load('src/util/appearance.ts');
const { SPACE, TYPE, surfaceStroke } = tokens;
const jsx = (type, props) => ({ type, props: props || {} });
const react = { useState: (value) => [value, () => {}], useEffect: () => {}, useRef: (value) => ({ current: value }) };

function flatten(node) {
  if (!node || typeof node !== 'object') return [];
  const children = node.props?.children;
  return [node, ...[children].flat(Infinity).flatMap(flatten)];
}
function stylesOf(file, c = appearance.LIGHT, metrics = appearance.DEFAULT_METRICS) {
  const loader = createLoader();
  const { makeStyles } = loader.extract(file, ['makeStyles'], {
    StyleSheet: { create: (styles) => styles }, Platform: { OS: 'android' },
    SPACE, TYPE, surfaceStroke, R: { pill: 999 },
    /*
     * Web 输入的 outline 复位常量。原生平台下它是空对象，所以这里给 `{}`：
     * 断言跑的是「安卓样式表」，web 那一支不该有任何属性混进来。
     */
    WEB_INPUT_RESET: {},
    // 与 src/components/GlassBackdrop.tsx 的 glassable 同一条判据
    glassable: (metrics, solid) => (metrics.outline > 0 ? 'transparent' : solid),
    /*
     * 回答区的样式在 v0.24 跟着 TurnAnswer 一起搬走了，由页面 spread 进来。
     * 这里给空对象：下面这些断言查的是开关 / 输入框 / 待办行，不涉及回答区。
     */
    makeTurnStyles: () => ({}),
  });
  return plain(makeStyles(c, metrics));
}
function componentLoader(c, metrics) {
  const theme = {
    ...appearance, ...tokens,
    useThemedStyles: (factory) => ({ c, metrics, styles: factory(c, metrics) }),
  };
  return createLoader({ stubs: {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Pressable: 'Pressable', View: 'View', Text: 'Text', StyleSheet: { create: (styles) => styles } },
    '@expo/vector-icons/Ionicons': 'Icon',
    '../theme': theme,
    './useHeadingFocus': { useHeadingFocus: () => ({ current: null }) },
    // 毛玻璃是真的原生模块，这里只验「底栏有没有给它留位置」，不验模糊本身
    './GlassBackdrop': {
      GlassBackdrop: 'Glass',
      glassable: (metrics, solid) => (metrics.outline > 0 ? 'transparent' : solid),
    },
  } });
}

test('语义字号/行高完整且层级清楚，不关闭系统字体缩放', () => {
  assert.deepEqual(Object.keys(TYPE).sort(), ['display', 'heading', 'title', 'subtitle', 'body', 'reading', 'compact', 'label', 'meta', 'caption'].sort());
  for (const style of Object.values(TYPE)) {
    assert.ok(style.fontSize > 0 && style.lineHeight >= style.fontSize * 1.35);
    assert.ok(['400', '500', '600', '700'].includes(style.fontWeight));
    assert.ok(!Object.hasOwn(style, 'allowFontScaling'));
  }
  assert.ok(TYPE.display.fontSize > TYPE.heading.fontSize && TYPE.heading.fontSize > TYPE.title.fontSize);
  assert.ok(TYPE.reading.fontSize >= TYPE.body.fontSize && TYPE.body.fontSize > TYPE.meta.fontSize);
  /*
   * 新增的两个角色必须真的落在「之间」，否则加它们就没有意义：
   * subtitle 要压在正文之上、卡片标题之下；compact 要在正文与辅助文字之间。
   */
  assert.ok(TYPE.title.fontSize > TYPE.subtitle.fontSize && TYPE.subtitle.fontSize > TYPE.body.fontSize,
    'subtitle 必须夹在 title 与 body 之间');
  assert.ok(TYPE.body.fontSize > TYPE.compact.fontSize && TYPE.compact.fontSize > TYPE.label.fontSize,
    'compact 必须夹在 body 与 label 之间');
});
test('间距只有明确递增档位，普通与墨水表面边线均存在', () => {
  assert.deepEqual(Object.values(SPACE), [4, 8, 12, 16, 20, 24, 32]);
  assert.equal(surfaceStroke(appearance.DEFAULT_METRICS), 0.5);
  assert.equal(surfaceStroke(appearance.INK_METRICS), appearance.INK_METRICS.strokeWidth);
});
for (const width of [320, 360, 412]) {
  for (const scale of [1, 1.5, 2]) {
    test(`${width}dp/字体${scale}：底栏五等分仍然够48dp`, () => {
      // 底栏不再用 navigationLayout 分槽（那份是按内边距算的），改成 flex:1 五等分。
      // 最窄的 320dp 也要能放下 5×48=240，这里把这条下限钉住。
      assert.ok(width / 5 >= 48, `${width}dp 五等分只有 ${width / 5}dp`);
      const bar = stylesOf('src/components/TabBar.tsx');
      assert.equal(bar.slot.flex, 1);
      assert.ok(bar.slot.minWidth >= 48);
      assert.ok(bar.slot.minHeight >= 48);
      // 首页标题列仍然允许被挤压，而不是把按钮推行
      const timeline = stylesOf('src/screens/TimelineScreen.tsx');
      assert.equal(timeline.headerLeft.minWidth, 0);
    });
  }
}
for (const palette of ['LIGHT', 'DARK', 'INK_LIGHT', 'INK_DARK']) {
  test(`${palette}：图标与下方标签同色，48dp槽不缩小`, () => {
    const c = appearance[palette];
    const metrics = palette.startsWith('INK_') ? appearance.INK_METRICS : appearance.DEFAULT_METRICS;
    const loader = componentLoader(c, metrics);
    const { IconButton } = loader.load('src/components/IconButton.tsx');
    const action = () => {};
    /*
     * 这里原来钉的是 `tone: 'primary'`（实心主色底 + 反白图标 + accentText 标签）。
     * 那个 tone 没有任何调用方，而且标签色算错了：实心蓝底上用浅蓝写字，对比度不够。
     * 现在删掉 primary，改成钉新的契约 —— 强调态用 accent（淡蓝底），
     * 而且**图标和标签必须同色**：分开取色正是原来那个 bug 的来源。
     */
    const button = IconButton({ name: 'chatbubble-ellipses-outline', label: '问', tone: 'accent', diameter: 40, onPress: action });
    assert.equal(button.props.onPress, action);
    assert.equal(button.props.accessibilityRole, 'button');
    const styles = plain(button.props.style({ pressed: false })).filter(Boolean);
    assert.ok(styles.some((style) => style.minWidth >= 48 && style.minHeight >= 48));
    const all = flatten(button);
    const icon = all.find((node) => node.type === 'Icon').props.color;
    assert.equal(icon, c.accentText);
    const label = all.find((node) => node.type === 'Text' && node.props.children === '问');
    assert.equal(label.props.style[1].color, icon, '标签必须和图标同色，不能各自取色');
    assert.ok(!Object.hasOwn(button.props, 'hitSlop'));
  });
}
test('选项保持可见勾选、checked语义和原回调', () => {
  const loader = componentLoader(appearance.INK_LIGHT, appearance.INK_METRICS);
  const { ChoiceChip } = loader.load('src/components/ChoiceChip.tsx');
  const action = () => {};
  const option = ChoiceChip({ label: '墨水', selected: true, onPress: action, role: 'radio' });
  assert.equal(option.props.onPress, action);
  assert.equal(option.props.accessibilityState.checked, true);
  assert.equal(flatten(option).find((node) => node.type === 'Icon').props.name, 'checkmark-circle');
});
test('页头直接保留返回和右侧动作，不复制/触发动作', () => {
  const loader = componentLoader(appearance.LIGHT, appearance.DEFAULT_METRICS);
  const { ScreenHeader } = loader.load('src/components/ScreenHeader.tsx');
  const action = () => {};
  const right = jsx('Action', { onPress: action });
  const header = ScreenHeader({ title: '设置', subtitle: '版本', onBack: action, right });
  const all = flatten(header);
  assert.ok(all.includes(right));
  assert.equal(all.find((node) => node.props.title === undefined && node.props.accessibilityLabel === '返回').props.onPress, action);
  assert.equal(all.find((node) => node.props.children === '设置').props.accessibilityRole, 'header');
});
test('菜单把长当前值放在可换行文字列，不藏原功能', () => {
  const style = stylesOf('src/screens/SettingsScreen.tsx');
  const theme = { c: appearance.LIGHT, styles: style };
  const { findDeclaration } = require('./test_loader.cjs');
  const real = findDeclaration('src/screens/SettingsScreen.tsx', 'MenuRow');
  const converted = ts.transpileModule(`module.exports = ${real.node.getText(real.source)};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  const bindings = {
    React: { createElement: (type, props, ...children) => jsx(type, { ...props, children: children.length === 1 ? children[0] : children }) },
    useThemedStyles: () => theme, makeStyles: () => style,
    Pressable: 'Pressable', View: 'View', Text: 'Text', Ionicons: 'Icon', ActivityIndicator: 'Busy',
  };
  new Function(...Object.keys(bindings), 'module', converted)(...Object.values(bindings), module);
  const MenuRow = module.exports;
  const action = () => {};
  const row = MenuRow({ icon: 'options-outline', label: '接口与模型', value: '一段很长的模型名称与接口说明', onPress: action });
  assert.equal(row.props.onPress, action);
  const value = flatten(row).find((node) => node.props.children === '一段很长的模型名称与接口说明');
  assert.equal(value.props.numberOfLines, 2);
  assert.equal(style.menuCopy.flex, 1);
  assert.equal(style.menuCopy.minWidth, 0);
});
test('底栏五项顺序固定、问居中、设置在最后，选中不靠颜色单独表达', () => {
  const loader = componentLoader(appearance.LIGHT, appearance.DEFAULT_METRICS);
  const { TabBar } = loader.load('src/components/TabBar.tsx');
  const seen = [];
  const bar = TabBar({ current: 'docs', onChange: (tab) => seen.push(tab) });
  assert.equal(bar.props.accessibilityRole, 'tablist');
  const tabs = flatten(bar).filter((node) => node.type === 'Pressable');
  assert.equal(tabs.length, 5, '底栏必须正好五项');
  const labels = tabs.map((t) => t.props.accessibilityLabel.split('：')[0]);
  // 用户 2026-11-15 指定：问在中间，设置在最右；2026-11-18 把文档与回顾换了位
  assert.deepEqual(labels, ['碎片', '回顾', '问', '文档', '设置']);
  assert.equal(labels[Math.floor(labels.length / 2)], '问');
  // 选中态：selected 语义 + 实心图标（不是只换个颜色）
  assert.equal(tabs[3].props.accessibilityState.selected, true);
  assert.equal(tabs[0].props.accessibilityState.selected, false);
  // 文档还是那个实心 icons，只是挪到了第四格（换位不影响图标本身）
  assert.equal(flatten(tabs[3]).find((n) => n.type === 'Icon').props.name, 'documents');
  assert.equal(flatten(tabs[0]).find((n) => n.type === 'Icon').props.name, 'layers-outline');
  // 点当前页不重复触发；点别的页把 tab 交回去
  tabs[3].props.onPress();
  tabs[0].props.onPress();
  assert.deepEqual(seen, ['timeline']);
  // 每个 tab 都有 48dp 槽
  for (const tab of tabs) {
    const style = plain(tab.props.style({ pressed: false })).filter(Boolean);
    assert.ok(style.some((s) => s.minHeight >= 48 && s.minWidth >= 48));
  }
});

test('首页不再放任何导航入口，全部下沉到底栏', () => {  const source = parseSource('src/screens/TimelineScreen.tsx');
  const buttons = [];
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'IconButton') {
      buttons.push(new Map(node.attributes.properties.filter(ts.isJsxAttribute).map((p) => [p.name.getText(source), p.initializer?.getText(source)])));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // 带文字标签的导航图标一个都不该有
  assert.deepEqual(buttons.filter((b) => b.has('label')).map((b) => b.get('label')), []);
  // 设置进了底栏（v0.20.9），页头那个齿轮也必须删掉，否则同一个入口出现两次
  assert.equal(buttons.find((b) => b.get('accessibilityLabel') === '"设置"'), undefined, '首页不该再留设置齿轮');
});
test('书写卡有完整输入和 48dp 圆形发送键，不额外挤小点击槽', () => {
  const style = stylesOf('src/screens/TimelineScreen.tsx');
  assert.equal(style.input.fontSize, TYPE.body.fontSize);
  /*
   * 文本区不再要求 48 高（用户 2026-11-15 说太高）。
   * 这里钉的是「还得是个能顺手下笔的框」：至少 38，且字体走 TYPE.body。
   * 触控底线由下面那条圆形发送键来守。
   */
  assert.ok(style.input.minHeight >= 38);
  /*
   * 发送键在 v0.20.8 改成 DeepSeek 那种圆形箭头，原来那条「>= 84 宽的横条」不再成立。
   * 换掉的是形状不是底线：宽高必须相等（否则不是圆），直径不少于 48（触控下限），
   * 而且它自己就是触控槽，不能靠外层 padding 凑出来。
   */
  assert.equal(style.send.width, style.send.height);
  assert.ok(style.send.width >= 48);
  assert.ok(style.send.borderRadius >= style.send.width / 2);
  assert.ok(style.toolBtn.minHeight >= 48);
});

/*
 * ------------------------------------------------------------------
 * 2026-11-15「间距」那一轮的四条底线
 *
 * 用户的原话逐条对应：碎片长了「展开全文和下一个隔得很开」、文档页
 * 「字还是太大，导致一个文件的框较大」、问页要把开关挪到框外并让框自己长高、
 * 回顾里「待办之间隔得非常开 / 子待办没有字号区分 / 一个待办占得太多」。
 *
 * 这些都不是「某个值不好看」，而是**一个不该占位的元素占了整块位置**。
 * 所以断言钉的是结构关系（谁比谁小、谁不再独占一行），不是具体像素：
 * 以后再把某个数调回来，这里会直接响。
 * ------------------------------------------------------------------
 */
test('长碎片的「展开全文」不再撑出一整行空白', () => {
  const timeline = stylesOf('src/screens/TimelineScreen.tsx');
  // 48 高的按钮 + 14 的底距 = 下一条前面空出 60 多；现在看得见的是 26
  assert.ok(timeline.expandBtn.minHeight <= 28, `展开按钮还有 ${timeline.expandBtn.minHeight} 高`);
  assert.ok(!timeline.expandBtn.minWidth || timeline.expandBtn.minWidth < 48, '展开按钮不该再占 48 宽');
  assert.ok(timeline.rowBody.paddingBottom <= 10, `行底距还有 ${timeline.rowBody.paddingBottom}`);
  // 收的是空白，不是可点范围：源码里必须给 hitSlop
  assert.ok(parseSource('src/screens/TimelineScreen.tsx').getText().includes('hitSlop={EXPAND_SLOP}'),
    '展开全文必须有 hitSlop 把触控区补回 48');
});

test('文档卡等级更低：标题不再是正文号，操作按钮不再独占一行', () => {
  const docs = stylesOf('src/screens/DocsScreen.tsx');
  assert.ok(docs.name.fontSize < TYPE.body.fontSize, `文档标题还有 ${docs.name.fontSize} 号`);
  assert.ok(docs.excerpt.fontSize <= TYPE.meta.fontSize, '摘要应走 meta（12/18）');
  assert.equal(docs.excerpt.numberOfLines, undefined);
  assert.ok(docs.pill.minHeight < 48, `「本地准备」还有 ${docs.pill.minHeight} 高`);
  assert.ok(docs.cardMain.paddingVertical <= 10);
  assert.ok(docs.sep.height <= 8, '卡片间距要跟着卡片一起收');
});

test('问页：开关在输入框外面、框自己长高但有上限', () => {
  const ask = stylesOf('src/screens/AskScreen.tsx');
  assert.ok(ask.toggle.minHeight < 40, `开关还有 ${ask.toggle.minHeight} 高`);
  assert.ok(ask.input.minHeight <= 36, `输入框还从 ${ask.input.minHeight} 起`);
  assert.ok(ask.input.maxHeight > ask.input.minHeight && ask.input.maxHeight <= TYPE.body.lineHeight * 6,
    '输入框必须能长高，而且有上限');
  assert.equal(ask.inputRow.flexDirection, 'row', '输入框和发送键同一行');
  assert.equal(ask.inputTools, undefined, '原来「输入框 + 工具行」的竖排结构必须删掉');
  /*
   * 位置关系用源码顺序钉：开关行必须出现在 TextInput 之前。
   * 只看样式断不出来「它到底在框里还是框外」——这正是这次改的东西。
   */
  const source = parseSource('src/screens/AskScreen.tsx').getText();
  const toggles = source.indexOf('styles.toggleRow');
  const input = source.indexOf('style={styles.input}');
  assert.ok(toggles > 0 && input > 0, '找不到开关行或输入框');
  assert.ok(toggles < input, '开关行必须在输入框之前（框上面），不能回到框里');
});

test('待办行是紧凑清单：子项字号更小，勾选框和图标不再各占 48', () => {
  const todo = stylesOf('src/components/TodoPanel.tsx');
  assert.ok(todo.textChild.fontSize < todo.text.fontSize, '子待办必须比父项小一号');
  assert.ok(todo.text.fontSize <= TYPE.compact.fontSize);
  assert.ok(todo.checkHit.height <= 30, `勾选框还有 ${todo.checkHit.height} 高`);
  assert.ok(todo.row.paddingVertical <= 6, `行内上下还有 ${todo.row.paddingVertical}`);
  assert.equal(todo.rowTools.flexDirection, 'row', '图标和正文同一行，不另起一行');
  assert.ok(!todo.main.minHeight || todo.main.minHeight <= 30, '正文区不该再撑 40 高');
});

test('图标按钮的紧凑态：36 的槽 + hitSlop 补到 48', () => {
  const loader = componentLoader(appearance.LIGHT, appearance.DEFAULT_METRICS);
  const { IconButton } = loader.load('src/components/IconButton.tsx');
  const compact = IconButton({ name: 'add', compact: true, onPress: () => {} });
  const style = plain(compact.props.style({ pressed: false })).filter(Boolean);
  const box = style.find((s) => s.minHeight !== undefined);
  assert.equal(box.minWidth, 36);
  assert.equal(box.minHeight, 36);
  const slop = compact.props.hitSlop;
  assert.ok(slop && box.minWidth + slop.left + slop.right >= 48, '紧凑态的可点范围必须仍是 48');
  // 不带 compact 的主入口保持原样，不能被顺手改小
  const normal = IconButton({ name: 'add', onPress: () => {} });
  assert.equal(plain(normal.props.style({ pressed: false })).filter(Boolean)
    .find((s) => s.minHeight !== undefined).minHeight, 48);
  assert.ok(!Object.hasOwn(normal.props, 'hitSlop'));
});

/*
 * 同一件事只许有一份实现。
 *
 * 这四条都是 v0.22.1 清理出来的重复：三处 `endpoint()`、两份 `withAlpha`
 * （其中一份遇到三位十六进制会退化成不透明色）、两份 `visualLen`
 * （emoji 在表格里算 2、在表格阅读器里算 1）、五处 `outlineStyle: 'none' as any`。
 * 钉住它们，是为了下次有人「顺手再写一份」的时候能立刻响。
 */
test('拼接地址 / 透明度 / 显示宽度 / web 输入复位都只有一份实现', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name)) files.push(p);
    }
  };
  walk('src');
  files.push('App.tsx');
  const text = new Map(files.map((f) => [f, require('node:fs').readFileSync(f, 'utf8')]));
  const holders = (needle) => [...text].filter(([, src]) => src.includes(needle)).map(([f]) => f);

  assert.deepEqual(holders("outlineStyle: 'none'"), ['src/util/platformStyle.ts'],
    'web 的 outline 复位只许定义在 platformStyle.ts，别处写 ...WEB_INPUT_RESET');
  assert.deepEqual(holders('function withAlpha'), ['src/util/color.ts'], 'withAlpha 只许一份');
  assert.deepEqual(holders('function visualLen'), ['src/util/text.ts'], 'visualLen 只许一份');
  assert.deepEqual(holders('function apiUrl'), ['src/ai/chat.ts'], '拼接口地址只许一份');
  // 三个调用点各自还在用（对话 / 读网页 / 搜索）
  for (const f of ['src/ai/chat.ts', 'src/ai/fetchPage.ts', 'src/ai/search.ts']) {
    assert.ok(text.get(f).includes('apiUrl('), `${f} 应该走 apiUrl()`);
  }
});

/*
 * 回顾页的两处「别留死路」：
 * - 日历当天记录超过三条时，那一行必须能点（v0.22.0 写的是「去时间轴看」，但去不了）；
 * - 小结入口要说出「几个月还没写」，判据必须来自 `util/digest`，不能另写一套。
 */
test('日历的「展开其余」能点开，小结入口说出待补月份', () => {
  const source = parseSource('src/screens/ReviewScreen.tsx').getText();
  assert.ok(source.includes('setAllFrags((v) => !v)'), '「展开其余 N 条」必须是可点的按钮');
  assert.ok(source.includes('dayFrag.slice(0, DAY_FRAG_LIMIT)'), '展开后要真的多列几条');
  // 旧文案是「还有 N 条，去时间轴看」—— 说完不给入口，等于没有功能
  assert.ok(!/[\u8fd8\u6709]\s*\{dayFrag\.length/.test(source), '不能再写一句话指一个点不到的地方');
  assert.ok(source.includes('missingDigests(months, notes'), '待补月份要用 util/digest 的判据（v0.26 起输入是每月条数，不是全量碎片）');
  assert.ok(source.includes('个月还没写'), '小结入口要说出待补月份数');
});

/*
 * v0.23：小结入口点进去必须落在**缺口月**上。
 *
 * 原来只数了总数就打开面板，而面板默认停在最近一个月 —— 本月通常一条碎片都没有，
 * 于是「3 个月还没写」点进去是一张「这个月里还没有碎片」。说了却做不到，比不说更糟。
 */
test('小结入口把缺口月真的送进面板', () => {
  const source = parseSource('src/screens/ReviewScreen.tsx').getText();
  assert.ok(source.includes('setSheetPeriod(backlog.items[0]?.period'), '入口要选中最近的缺口月');
  assert.ok(source.includes('initialPeriod={sheetPeriod'), '预选月份必须传给面板');
  // 面板得真接住这个 prop 并把它当初始值，否则传了也没用
  const sheet = parseSource('src/components/SummarySheet.tsx').getText();
  assert.ok(sheet.includes('useState(() => initialPeriod ??'), '面板要拿它当初始月份');
});

/*
 * v0.23：整理计划这条老路径整条删了（organizePlan.ts + 5 个 session 方法 + 2 个 run 方法）。
 *
 * 它从 v0.16 改成「一次对话 + 草稿」之后就没有任何调用方了，
 * 但文件还在、类型还在、两张表还在建 —— 下一个读代码的人会以为它还活着。
 * 表留着（旧设备的行是历史证据），代码不许复活。
 */
test('整理计划那条死路径不许复活', () => {
  const fs = require('node:fs');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name)) files.push(p);
    }
  };
  walk('src');
  files.push('App.tsx');
  const text = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));

  assert.ok(!fs.existsSync('src/util/organizePlan.ts'), 'organizePlan.ts 已删，别再建回来');
  assert.ok(!fs.existsSync('src/documents/knowledge.ts'), '旧文档写入工具已删，写入只走 Repo.commitDraft');
  const deadNames = /OrganizePlan|OrganizeScope|saveOrganizeSession|updateOrganizeSession|saveRun\b|markRunApplied|markMerged|markStatus|setFragmentNature|countInbox|countFragments|listFragmentIds|writeKnowledgeDocument/;
  const hits = [...text].filter(([, src]) => deadNames.test(src)).map(([f]) => f);
  assert.deepEqual(hits, [], '整理计划与标签时代的方法不许有人再引用');
  // 两张旧表只许出现在建表语句里，不许有读写
  const writes = [...text].filter(([, src]) => /(INSERT INTO|UPDATE|DELETE FROM|SELECT [^;]*FROM)\s+organize_(sessions|runs)/i.test(src)).map(([f]) => f);
  assert.deepEqual(writes, [], 'organize_sessions / organize_runs 不再有读写');
});

/*
 * v0.23：间距的两种数不许混。
 *
 * 结构间距只有七档（`SPACE` 的 4/8/12/16/20/24/32），**必须走 token**；
 * 2/3/5/6/7/10/14 这几个是「让文字基线对齐」的微调（点阵间距、光学修正），
 * 直接写数字反而是对的 —— 它们本来就不该出现在布局里。
 *
 * 这条断言拦的是「4 写成 4」：数值等于档位却写成裸数字，看起来没差，
 * 实际是下一次「6 还是 8」的起点。本版清掉了 36 处。
 */
test('间距档位必须走 SPACE，微调数字保持裸写', () => {
  const fs = require('node:fs');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name)) files.push(p);
    }
  };
  walk('src');
  files.push('App.tsx');
  const SCALE = new Set([4, 8, 12, 16, 20, 24, 32]);
  const bad = [];
  for (const f of files) {
    if (f.includes('appearance.ts') || f.includes('uiTokens.ts')) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      const matches = line.matchAll(/\b(?:margin|padding)[A-Za-z]*:\s*(-?\d+)\b|\bgap:\s*(-?\d+)\b/g);
      for (const m of matches) {
        const value = Number(m[1] ?? m[2]);
        if (value > 0 && SCALE.has(value)) bad.push(`${f}:${i + 1} (${value})`);
      }
    });
  }
  assert.deepEqual(bad, [], '等于档位的裸数字要换成 SPACE.*，否则下次就多出一个「6」');
});

/*
 * v0.23：系统分享进来的**文件**要真的入库，而且中转副本用完要删。
 *
 * 原来只弹一句「去文档页导入更稳」—— 文件已经在私有目录里了，缺的只是写一条记录，
 * 让用户从头再做一遍是把动作丢了再要回来。另外原生每次分享都往 incoming/ 复制一份，
 * 不删就是「每分享一次多存一份」。
 */
test('分享进来的文件进文档库，中转副本用完就删', () => {
  const app = parseSource('App.tsx').getText();
  const inbox = parseSource('src/shareInbox.ts').getText();
  assert.ok(app.includes('importLocalFile({ uri: doc.uri, name: doc.name })'), '文件分享要直接入库，且用原始文件名');
  assert.ok(!app.includes('这种文件还不支持从分享进来'), '不能再让用户「去文档页导入」做第二遍');
  const importAt = app.indexOf('await importLocalFile(');
  const dropAt = app.indexOf('await dropIncomingFile(doc.disk)', importAt);
  assert.ok(importAt > 0 && dropAt > importAt, '入库成功之后才删中转副本（失败要留着下次再读）');
  assert.ok(inbox.includes('export async function dropIncomingFile'), '删中转副本的入口在 shareInbox');
  // 图片那条路同样要删：内容已经复制进碎片目录
  assert.ok(app.includes('await dropIncomingFile(image.disk)'), '图片分享也要清理中转副本');
});

/*
 * 幂等键在读的时候就推进到最新（否则同一条会被反复弹出），代价是**失败也会被记住**。
 * 一份都没存下去时必须退回来：文件还躺在私有目录里，界面上什么都没有，那是静默丢内容。
 */
test('分享一份都没存下去时，退回幂等键让下次能重来', () => {
  const fs = require('node:fs');
  const app = fs.readFileSync('App.tsx', 'utf8');
  const inbox = fs.readFileSync('src/shareInbox.ts', 'utf8');
  assert.ok(inbox.includes('prevAt: number'), '要记住消费前的键');
  assert.ok(inbox.includes('prevAt: last'), '返回时要带上它');
  assert.ok(inbox.includes('export async function rewindIncomingShare'), '要有一个退回去的入口');
  assert.ok(app.includes('consumed === 0') && app.includes('rewindIncomingShare(inc.prevAt)'), '只在「一份都没成功」时退');
  assert.ok(app.includes('consumed += 1') || app.includes('consumed += images.length'), '每成功一份要计数，否则分不清「全失败」和「部分成功」');
});

/*
 * 多选分享（相册里一次选三张图）走的是 ACTION_SEND_MULTIPLE，和单选是两种 intent。
 * 只接单选时那些图会**全部丢掉**，而且没有任何提示 —— 这类问题只能在源码层面钉。
 */
test('多选分享：声明 SEND_MULTIPLE，原生读列表，JS 按条解析', () => {
  const fs = require('node:fs');
  const plugin = fs.readFileSync('plugins/withShareReceiver.js', 'utf8');
  assert.ok(plugin.includes('android.intent.action.SEND_MULTIPLE'), 'manifest 要声明多选，否则相册多选里没有碎片');
  const open = 'const KOTLIN_BODY = `';
  const start = plugin.indexOf(open) + open.length;
  const end = plugin.indexOf('\n`;', start);
  const body = new Function(`INCOMING_DIR`, `return \`${plugin.slice(start, end)}\`;`)('incoming');
  assert.ok(body.includes('Intent.ACTION_SEND_MULTIPLE'), 'captureShare 要认多选的 action');
  assert.ok(body.includes('getParcelableArrayListExtra'), '多选的文件在 EXTRA_STREAM 的 ArrayList 里');
  assert.ok(body.includes('org.json.JSONArray'), '多个文件要写成数组，不能只剩最后一个');
  assert.ok(body.includes('"$stamp-$index-"'), '同名文件靠 index 前缀区分，否则后一个覆盖前一个');
  assert.ok(body.includes('json.put("files", files)'), 'json 里要带 files 列表');

  const inbox = parseSource('src/shareInbox.ts').getText();
  assert.ok(inbox.includes('Array.isArray(parsed.files)'), 'JS 要能读 files 列表');
  assert.ok(inbox.includes('pick(parsed.file, parsed.name)'), '升级前留下的旧 json 仍然要能读');
  assert.ok(inbox.includes("kind: 'image' | 'other'"), '每个文件各自判类型（同一次分享可能图文混着）');
});

/*
 * 原生注入的那段 Kotlin 只能靠读字符串来验（本地没有 Gradle，CI 才编译）。
 *
 * 两条都是真踩过的坑：
 * - 微信给的是 `content://` Uri，`lastPathSegment` 常常是数字 id，用它当文件名会丢扩展名；
 * - 磁盘名做过 ASCII 安全化，中文文件名会变成一片下划线 —— 显示名必须单独带一份。
 */
test('分享接收的 Kotlin：取真实文件名、单独带一份原名', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync('plugins/withShareReceiver.js', 'utf8');
  const open = 'const KOTLIN_BODY = `';
  const start = src.indexOf(open) + open.length;
  const end = src.indexOf('\n`;', start);
  assert.ok(start > open.length && end > start, '找不到 KOTLIN_BODY');
  const body = new Function(`INCOMING_DIR`, `return \`${src.slice(start, end)}\`;`)('incoming');

  assert.ok(body.includes('displayNameOf(uri)'), '要问系统要原始文件名，不能只用 lastPathSegment');
  assert.ok(body.includes('OpenableColumns.DISPLAY_NAME'), 'DISPLAY_NAME 才是真名');
  assert.ok(body.includes('.put("name", saved.second)'), 'json 里要单独带原名（磁盘名和原名分开）');
  assert.ok(body.includes('isLetterOrDigit'), '中文文件名不能被安全化成下划线');
  assert.ok(!body.includes('\\p{'), 'Kotlin 字符串里写 \\p{…} 是非法转义，别用正则字符类');
  // 微信分享 docx 报的是完整的长 mime，只声明 pdf 的话它压根不会出现在「打开方式」里
  for (const mime of ['application/pdf', 'wordprocessingml.document', 'spreadsheetml.sheet']) {
    assert.ok(src.includes(mime), `manifest 要声明 ${mime}`);
  }
});

/*
 * 空屏只有一个实现。
 *
 * 这一条原来有五个各写一遍的版本：说明句的 maxWidth 一处有一处没有（窄屏换行、
 * 平板上拉成一整行），图标底有的主色有的灰，标题有的带 header 角色有的不带。
 * 查的是「还有人自己写 emptyIcon / emptyTitle 吗」—— 写了就说明又在抄第六份。
 */
test('空屏只有 EmptyState 一份实现', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.tsx?$/.test(e.name)) acc.push(p.replace(/\\/g, '/'));
    }
    return acc;
  };
  const files = walk('src');

  assert.ok(fs.existsSync('src/components/EmptyState.tsx'), 'EmptyState 组件不能删');
  const copies = [];
  for (const f of files) {
    if (f === 'src/components/EmptyState.tsx') continue;
    const src = fs.readFileSync(f, 'utf8');
    if (/emptyIcon:|emptyTitle:/.test(src)) copies.push(f);
  }
  assert.deepEqual(copies, [], `这些文件又自己写了一套空屏：${copies.join('、')}`);

  // 五个有列表的页面都要真的用它 —— 只是把样式删了不算统一
  for (const f of [
    'src/screens/TimelineScreen.tsx',
    'src/screens/AskScreen.tsx',
    'src/screens/DocsScreen.tsx',
    'src/screens/ReviewScreen.tsx',
    'src/components/TodoPanel.tsx',
  ]) {
    assert.ok(fs.readFileSync(f, 'utf8').includes('<EmptyState'), `${f} 的空屏要走 EmptyState`);
  }

  // 唯一的「邀请型」空屏只该有一处：首页还没有碎片时
  const accentUsers = files.filter((f) => /<EmptyState[^>]*tone="accent"/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(accentUsers, ['src/screens/TimelineScreen.tsx'], '主色底的空屏只留给首页那一处');
});

/*
 * 提示条的高度从哪儿算，曾经算错过两次。
 *
 * `SafeAreaView` 里是「页面 + 底栏」竖排，所以页面底部**就是**底栏顶边 ——
 * 页面里的提示条再加 56 就悬在半空。只有 App 根节点那个 `writeNotice`
 * 和底栏是同一个父容器的兄弟，才需要加。
 */
test('底栏高度只在铺满整屏的壳层里用，页面内不许加', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.tsx?$/.test(e.name)) acc.push(p.replace(/\\/g, '/'));
    }
    return acc;
  };
  const users = [...walk('src'), 'App.tsx'].filter((f) => {
    if (f === 'src/components/Toast.tsx') return false; // 定义处
    return /TAB_BAR_HEIGHT/.test(fs.readFileSync(f, 'utf8'));
  });
  assert.deepEqual(users, ['App.tsx'], `底栏高度只该在 App 壳层用，现在还有：${users.join('、')}`);

  const docs = fs.readFileSync('src/screens/DocsScreen.tsx', 'utf8');
  assert.ok(docs.includes('onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}'), '多选底条要实测高度');
  assert.ok(docs.includes('(selectMode ? barHeight : 0) + 8'), '提示条要落在实测底条之上');
  assert.ok(!/bottom=\{selectMode \? \d+/.test(docs), '不能再写死一个「大概是这么高」的数');
});

/*
 * 「先去设置页填一个」原来是一句点不到的话：月总结面板是覆盖层，自己换不了 tab，
 * 用户得先关面板、再找底栏、再进设置 —— 项目规则里点名的「文案指一个点不到的地方」。
 * 现在给一个真按钮，而且必须能从 App 一路接到 `setRoute('settings')`，
 * 否则按钮点了没反应，比没有更坏。
 */
test('缺 API Key 时有「去设置」按钮，并且真的能切到设置页', () => {
  const fs = require('node:fs');
  const sheet = fs.readFileSync('src/components/SummarySheet.tsx', 'utf8');
  assert.ok(sheet.includes('onOpenSettings'), '面板要接一个「打开设置」的回调');
  assert.ok(sheet.includes('去设置填 Key'), '按钮文案要说清去哪做什么');
  const closeAt = sheet.indexOf('onClose();');
  const openAt = sheet.indexOf('onOpenSettings();');
  assert.ok(closeAt > 0 && openAt > closeAt, '先关面板再切 tab（App 按 route 条件渲染）');
  assert.ok(sheet.includes('setNeedKey(true)'), '只有「没配 Key」才给这个按钮');

  const review = fs.readFileSync('src/screens/ReviewScreen.tsx', 'utf8');
  assert.ok(review.includes('onOpenSettings={onOpenSettings}'), '回顾页要把回调透传下去');

  const app = fs.readFileSync('App.tsx', 'utf8');
  assert.ok(app.includes("onOpenSettings={() => setRoute('settings')}"), 'App 必须真的切到设置页');
});

/*
 * v0.27：空行要留下。
 *
 * 作者写「第一段\n\n第二段」就是在分段；原来的解析器直接 `continue` 掉空行，
 * 于是时间轴、文档、日历里所有多段文字都挤成一坨。
 */
test('空行变成一个空段落，预览里不占行', () => {
  const md = pure.load('src/util/mdBlocks.ts');
  const blocks = md.parseBlocks('第一段\n\n第二段');
  assert.equal(blocks.length, 3, '中间那个空行要留下');
  assert.equal(blocks[1].kind, 'p');
  assert.equal(blocks[1].segs.length, 0, '空段落没有文字，它只贡献一个换行');
  // 连续空行只留一个：手机上多出来的空白只会让滚动变长
  assert.equal(md.parseBlocks('a\n\n\n\nb').length, 3);
  // 末尾空行不影响渲染，也不该留下一个空段落
  assert.equal(md.parseBlocks('a\n\n').length, 1);
  // 预览只有几行高，空行不该占掉其中一行
  assert.equal(md.flattenForPreview(blocks).length, 2);

  const body = parseSource('src/components/NoteBody.tsx').getText();
  assert.ok(body.includes('b.segs.length === 0) return null'), '空段落自己不画东西');
});

/*
 * v0.27 的日历与页头。
 *
 * 这三条都能在桌面验：格子按字数分档、碎片行能就地展开、页头把字数放在条数左边。
 * 真机上好不好看另说，但「有没有这个功能」不该靠肉眼找。
 */
test('日历按字数加深、碎片能展开、页头有字数', () => {
  const review = parseSource('src/screens/ReviewScreen.tsx').getText();
  assert.ok(review.includes('function depthOf(chars: number)'), '深浅按字数分档，不按条数');
  assert.ok(review.includes('withAlpha(c.accent, 0.06 * depthOf(marks.chars))'), '格子用 accent 的透明度表达深浅');
  assert.ok(review.includes('const [openFrags, setOpenFrags]'), '日历里的碎片要能就地展开');
  assert.ok(review.includes('numberOfLines={open ? undefined : 2}'), '展开时不再裁两行');
  assert.ok(review.includes("m.chars ? `${m.chars} 字`"), '那天写了多少要写出来');

  const timeline = parseSource('src/screens/TimelineScreen.tsx').getText();
  assert.ok(timeline.includes('todayChars'), '页头要接字数');
  const charsAt = timeline.indexOf('<Text style={styles.todayChars}>');
  const countAt = timeline.indexOf('<Text style={styles.todayNumber}>');
  assert.ok(charsAt > 0 && countAt > charsAt, '字数在条数左边');

  const todo = parseSource('src/components/TodoEditor.tsx').getText();
  assert.ok(todo.includes('截止日期（可不填）'), '「哪天做」改成「截止日期」');
  assert.ok(!todo.includes('哪天做'), '旧说法要清干净');
});

test('首页冷启动不抢键盘，只有通知点进来才聚焦', () => {
  const timeline = parseSource('src/screens/TimelineScreen.tsx').getText();
  // 冷启动那次 focus 已经删了（用户 2026-11-19）。加回来会让「打开看一眼」变成「先收键盘」
  assert.ok(!timeline.includes('autoFocusedOnce'), '冷启动自动聚焦的开关要一起删干净');
  assert.ok(!/inputRef\.current\?\.focus\(\), 380\)/.test(timeline), '那个 380ms 后的聚焦不许回来');
  /*
   * 判断「信号变没变」，不是「有没有值」：focusSignal 是只增的计数器，
   * 用 `if (!focusSignal) return` 会让切回时间轴时每挂载一次弹一次键盘。
   */
  assert.ok(timeline.includes('seenSignal'), '要记住上一次处理过的信号');
  assert.ok(timeline.includes('focusSignal === seenSignal.current) return;'), '信号没变就不聚焦');
  assert.ok(timeline.includes('const seenSignal = useRef(0)'), 'ref 初值必须是 0，冷启动那一次才不会被吞掉');
});

test('自己写的文档不说「原文件已不在」，也不摆灰掉的云解析', () => {
  /*
   * v0.30 之前 `fileDocument = doc.origin !== 'knowledge'` —— 等于把「自己写的」
   * 也算成「有原文件」，于是它头上挂着「原文件已不在手机上」，
   * 菜单里还摆着灰掉的「打开原件 / 云解析 / 重新准备」（用户 2026-11-19 提的）。
   */
  const viewer = parseSource('src/components/DocViewer.tsx').getText();
  assert.ok(viewer.includes("const fileDocument = doc.origin === 'file'"), '「有原文件」只认 file');
  assert.ok(viewer.includes("const authored = doc.origin === 'authored'"), '自己写的是第三种身份');
  assert.ok(
    !viewer.includes("doc.origin !== 'knowledge'"),
    '把 authored 也算成有原文件的那个判据不许回来',
  );
  // 「打开原件」和「准备」两组动作都只挂在有原文件的分支上
  const openAt = viewer.indexOf('label="打开原件"');
  assert.ok(openAt > 0, '打开原件要留着（给导入的原件）');
  assert.ok(
    viewer.lastIndexOf('{fileDocument ?', openAt) > viewer.lastIndexOf('{authored ?', openAt),
    '打开原件必须挂在 fileDocument 分支里',
  );
  const groupAt = viewer.indexOf('{fileDocument ? (');
  const groupEnd = viewer.indexOf(') : null}', groupAt);
  assert.ok(groupAt > 0 && groupEnd > groupAt, '找不到「准备」那一组');
  const group = viewer.slice(groupAt, groupEnd);
  assert.ok(group.includes('本地准备') && group.includes('云解析'), '本地准备 / 云解析只在有原文件时出现');
  assert.ok(
    viewer.includes('{fileDocument ? <Action label="打开原件"'),
    '打开原件同样只给有原文件的那种',
  );

  // 正文快照的提示同理：只有导入的原件才谈得上「原文件不在」
  const reader = parseSource('src/documents/readers/DocumentReader.tsx').getText();
  assert.ok(reader.includes("doc.origin !== 'file'"), '快照提示的判据要按来源分');
  assert.ok(
    !reader.includes("doc.origin === 'knowledge' ? undefined"),
    '只把 knowledge 排除在外的那版判据不许回来',
  );
});

test('文档行不再常驻删除按钮：左滑露出删除，长按弹菜单', () => {
  const docs = parseSource('src/screens/DocsScreen.tsx').getText();
  const rowAt = docs.indexOf('function DocRow(');
  const rowEnd = docs.indexOf('function DocMenuSheet', rowAt);
  assert.ok(rowAt > 0 && rowEnd > rowAt, 'DocRow 与菜单都要在');
  const row = docs.slice(rowAt, rowEnd);
  assert.ok(!row.includes('name="trash-outline"'), '卡片上不许再常驻垃圾桶（用户 2026-11-19）');
  assert.ok(row.includes('<SwipeRow'), '改成一行的滑动手势');
  assert.ok(row.includes("label: '删除'"), '左滑露出的就是删除');
  assert.ok(row.includes('onLongPress={selectMode ? undefined : onMenu}'), '长按要能弹菜单');
  assert.ok(docs.includes('function DocMenuSheet'), '菜单本身要有');
  for (const needle of ['编辑正文', '移到回收站']) {
    assert.ok(docs.includes(needle), `菜单里缺少「${needle}」`);
  }
});

if (require.main === module) {
  suite.run().then(({ failed }) => { process.exitCode = failed ? 1 : 0; }).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
module.exports = { run: suite.run };
