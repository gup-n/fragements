#!/usr/bin/env node
/** UI contract regression: real component/style code plus in-memory RN/React doubles. No preview. */
const assert = require('node:assert/strict');
const { createLoader, createSuite, parseSource, plain, ts } = require('./test_loader.cjs');
const suite = createSuite('UI排版与布局回归');
const { test } = suite;
const pure = createLoader();
const tokens = pure.load('src/util/uiTokens.ts');
const appearance = pure.load('src/util/appearance.ts');
const { SPACE, TYPE, surfaceStroke, navigationLayout } = tokens;
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
    SPACE, TYPE, surfaceStroke, navigationLayout, R: { card: 14, btn: 10, pill: 999 },
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
  } });
}

test('语义字号/行高完整且层级清楚，不关闭系统字体缩放', () => {
  assert.deepEqual(Object.keys(TYPE).sort(), ['display', 'heading', 'title', 'body', 'reading', 'label', 'meta', 'caption'].sort());
  for (const style of Object.values(TYPE)) {
    assert.ok(style.fontSize > 0 && style.lineHeight >= style.fontSize * 1.35);
    assert.ok(['400', '500', '600', '700'].includes(style.fontWeight));
    assert.ok(!Object.hasOwn(style, 'allowFontScaling'));
  }
  assert.ok(TYPE.display.fontSize > TYPE.heading.fontSize && TYPE.heading.fontSize > TYPE.title.fontSize);
  assert.ok(TYPE.reading.fontSize >= TYPE.body.fontSize && TYPE.body.fontSize > TYPE.meta.fontSize);
});
test('间距只有明确递增档位，普通与墨水表面边线均存在', () => {
  assert.deepEqual(Object.values(SPACE), [4, 8, 12, 16, 20, 24, 32]);
  assert.equal(surfaceStroke(appearance.DEFAULT_METRICS), 0.5);
  assert.equal(surfaceStroke(appearance.INK_METRICS), appearance.INK_METRICS.strokeWidth);
});
for (const width of [320, 360, 412]) {
  for (const scale of [1, 1.5, 2]) {
    test(`${width}dp/字体${scale}：四个导航槽至少48dp且不与标题争宽`, () => {
      const layout = navigationLayout(width, scale);
      const slot = (width - layout.horizontalPadding * 2 - layout.gap * 3) / 4;
      assert.ok(slot >= 48, `槽宽仅${slot}`);
      assert.equal(layout.minimumSlot, 48);
      assert.equal(layout.compact, width < 360 || scale > 1.3);
      const styles = stylesOf('src/screens/TimelineScreen.tsx');
      assert.equal(styles.navSlot.flex, 1);
      assert.ok(styles.navSlot.minWidth >= 48);
      assert.equal(styles.headerLeft.minWidth, 0);
    });
  }
}
for (const palette of ['LIGHT', 'DARK', 'INK_LIGHT', 'INK_DARK']) {
  test(`${palette}：主图标反色和下方标签分离，48dp槽不缩小`, () => {
    const c = appearance[palette];
    const metrics = palette.startsWith('INK_') ? appearance.INK_METRICS : appearance.DEFAULT_METRICS;
    const loader = componentLoader(c, metrics);
    const { IconButton } = loader.load('src/components/IconButton.tsx');
    const action = () => {};
    const button = IconButton({ name: 'chatbubble-ellipses-outline', label: '问', tone: 'primary', diameter: 40, onPress: action });
    assert.equal(button.props.onPress, action);
    assert.equal(button.props.accessibilityRole, 'button');
    const styles = plain(button.props.style({ pressed: false })).filter(Boolean);
    assert.ok(styles.some((style) => style.minWidth >= 48 && style.minHeight >= 48));
    const all = flatten(button);
    assert.equal(all.find((node) => node.type === 'Icon').props.color, c.onAccent);
    const label = all.find((node) => node.type === 'Text' && node.props.children === '问');
    assert.equal(label.props.style[1].color, c.accentText);
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
test('首页分行导航保留原顺序、锁和所有回调', () => {
  const source = parseSource('src/screens/TimelineScreen.tsx');
  const nav = [];
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'IconButton') {
      const attrs = new Map(node.attributes.properties.filter(ts.isJsxAttribute).map((p) => [p.name.getText(source), p.initializer?.getText(source)]));
      const label = attrs.get('label');
      if (['"文档"', '"回顾"', '"设置"', '"问"'].includes(label)) nav.push(attrs);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(nav.map((n) => n.get('label')), ['"文档"', '"回顾"', '"设置"', '"问"']);
  for (const entry of nav) assert.equal(entry.get('disabled'), '{composerBusy}');
  assert.ok(nav[0].get('onPress').includes('onOpenDocs'));
  assert.ok(nav[1].get('onPress').includes('onOpenReview'));
  assert.ok(nav[2].get('onPress').includes('onOpenSettings'));
  assert.ok(nav[3].get('onPress').includes('onOpenAsk'));
});
test('书写卡有完整输入和可见发布文字，不额外挤小点击槽', () => {
  const style = stylesOf('src/screens/TimelineScreen.tsx');
  assert.equal(style.input.fontSize, TYPE.body.fontSize);
  assert.ok(style.input.minHeight >= 48);
  assert.ok(style.send.minWidth >= 84 && style.send.minHeight >= 48);
  assert.equal(style.sendLabel.fontSize, TYPE.label.fontSize);
  assert.ok(style.toolBtn.minHeight >= 48);
});

suite.run();
