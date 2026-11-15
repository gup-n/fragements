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
  // 用户 2026-11-15 指定：问在中间，设置在最右
  assert.deepEqual(labels, ['碎片', '文档', '问', '回顾', '设置']);
  assert.equal(labels[Math.floor(labels.length / 2)], '问');
  // 选中态：selected 语义 + 实心图标（不是只换个颜色）
  assert.equal(tabs[1].props.accessibilityState.selected, true);
  assert.equal(tabs[0].props.accessibilityState.selected, false);
  assert.equal(flatten(tabs[1]).find((n) => n.type === 'Icon').props.name, 'documents');
  assert.equal(flatten(tabs[0]).find((n) => n.type === 'Icon').props.name, 'layers-outline');
  // 点当前页不重复触发；点别的页把 tab 交回去
  tabs[1].props.onPress();
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
  assert.ok(source.includes('missingDigests(fragments, notes'), '待补月份要用 util/digest 的判据');
  assert.ok(source.includes('个月还没写'), '小结入口要说出待补月份数');
});

suite.run();
