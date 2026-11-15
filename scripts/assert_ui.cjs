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

test('首页不再放任何导航入口，全部下沉到底栏', () => {
  const source = parseSource('src/screens/TimelineScreen.tsx');
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

suite.run();
