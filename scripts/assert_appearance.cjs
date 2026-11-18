#!/usr/bin/env node
/**
 * 两轴外观回归：真实 appearance / ThemeProvider + React hook 桩。
 *
 * 用法：node scripts/assert_appearance.cjs（Node 22+，无依赖安装/编译目录/网络）。
 * 对比度由测试独立按 sRGB 相对亮度计算，不调用产品里的等价检查器。
 * 这些断言不证明 Android 实际字号、48dp 点击区域、TalkBack 或媒体渲染。
 */
const assert = require('node:assert/strict');
const { createLoader, createSuite, deferred, parseSource, plain, readSource, ts } = require('./test_loader.cjs');

const suite = createSuite('两轴外观回归');
const { test } = suite;
const loader = createLoader();
const appearance = () => loader.load('src/util/appearance.ts');
const PALETTE_NAMES = ['LIGHT', 'DARK', 'INK_LIGHT', 'INK_DARK'];
const PALETTE_KEYS = [
  'page', 'card', 'text', 'text2', 'text3', 'hair', 'hairSoft',
  'accent', 'accentBg', 'accentText', 'purpleBg', 'purpleText', 'tealBg', 'tealText',
  'amberBg', 'amberText', 'coralBg', 'coralText', 'danger', 'dangerBg',
  'accentHair', 'scrim', 'shell', 'shellBorder', 'onAccent', 'onDanger',
  'mediaBackground', 'mediaForeground', 'mediaScrim', 'controlThumb', 'selection', 'focus',
];

function rgba(raw) {
  assert.equal(typeof raw, 'string', `色值必须是字符串：${String(raw)}`);
  if (/^#[\da-f]{3}$/i.test(raw)) {
    return [...raw.slice(1)].map((x) => parseInt(x + x, 16)).concat(1);
  }
  if (/^#[\da-f]{6}$/i.test(raw)) {
    return [1, 3, 5].map((i) => parseInt(raw.slice(i, i + 2), 16)).concat(1);
  }
  const match = raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  assert.ok(match, `无法校验的色值格式：${raw}`);
  const channels = [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
  assert.ok(channels.slice(0, 3).every((x) => Number.isFinite(x) && x >= 0 && x <= 255), `RGB 越界：${raw}`);
  assert.ok(Number.isFinite(channels[3]) && channels[3] >= 0 && channels[3] <= 1, `Alpha 越界：${raw}`);
  return channels;
}

function over(foreground, background) {
  const alpha = foreground[3];
  return foreground.slice(0, 3).map((c, i) => c * alpha + background[i] * (1 - alpha)).concat(1);
}

function luminance(channels) {
  const linear = channels.slice(0, 3).map((n) => {
    const c = n / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(foreground, background, canvas = '#FFFFFF') {
  const bg = over(rgba(background), rgba(canvas));
  const fg = over(rgba(foreground), bg);
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function atLeast(palette, foreground, background, min, name) {
  const ratio = contrast(palette[foreground], palette[background], palette.page);
  assert.ok(ratio + 1e-9 >= min,
    `${name} ${foreground}/${background} = ${ratio.toFixed(3)}:1，低于 ${min}:1（${palette[foreground]} / ${palette[background]}）`);
}

test('对比度检查器识别黑白、临界灰色和透明叠加', () => {
  assert.equal(contrast('#000000', '#FFFFFF'), 21);
  assert.ok(contrast('#777777', '#FFFFFF') < 4.5);
  assert.ok(contrast('#767676', '#FFFFFF') >= 4.5);
  assert.equal(contrast('rgba(0,0,0,0)', '#FFFFFF'), 1);
  assert.ok(contrast('rgba(0,0,0,0.5)', '#FFFFFF') > 3);
});

test('旧明暗设置完整保留，非法值不强制转成字符串', () => {
  const a = appearance();
  for (const mode of ['light', 'dark', 'system']) assert.equal(a.normalizeThemeMode(mode), mode);
  const noCoercion = { toString() { throw new Error('不应调用 toString'); } };
  for (const value of [null, undefined, '', 'LIGHT', 'ink', 'default', 0, 1, false, true, [], {}, noCoercion]) {
    assert.equal(a.normalizeThemeMode(value), 'system', '缺失/非法明暗偏好必须回到 system');
  }
});

test('风格缺失回默认，ink 不冒充明暗偏好', () => {
  const a = appearance();
  assert.equal(a.normalizeThemeStyle('ink'), 'ink');
  assert.equal(a.normalizeThemeStyle('default'), 'default');
  for (const value of [null, undefined, '', 'INK', 'dark', 'light', 'system', false, 0, [], {}]) {
    assert.equal(a.normalizeThemeStyle(value), 'default');
  }
});

for (const mode of ['light', 'dark', 'system']) {
  for (const style of ['default', 'ink']) {
    for (const systemDark of [false, true]) {
      test(`${mode} × ${style} × 系统${systemDark ? '深' : '浅'}使用正确色表和几何`, () => {
        const a = appearance();
        const resolved = a.resolveAppearance(mode, style, systemDark);
        const expectedDark = mode === 'dark' || (mode === 'system' && systemDark);
        const table = style === 'ink'
          ? (expectedDark ? a.INK_DARK : a.INK_LIGHT)
          : (expectedDark ? a.DARK : a.LIGHT);
        assert.equal(resolved.dark, expectedDark);
        assert.strictEqual(resolved.c, table, '解析必须返回已注册色表，不能绕出不完整的临时色表');
        assert.strictEqual(resolved.metrics, style === 'ink' ? a.INK_METRICS : a.DEFAULT_METRICS);
      });
    }
  }
}

test('连续切换风格不会修改原明暗偏好或色表', () => {
  const a = appearance();
  const before = JSON.stringify(PALETTE_NAMES.map((key) => a[key]));
  for (let i = 0; i < 20; i++) {
    assert.equal(a.resolveAppearance('dark', i % 2 ? 'default' : 'ink', false).dark, true);
    assert.equal(a.resolveAppearance('light', i % 2 ? 'ink' : 'default', true).dark, false);
  }
  assert.equal(JSON.stringify(PALETTE_NAMES.map((key) => a[key])), before, '解析不得改写共享色表');
});

for (const name of PALETTE_NAMES) {
  test(`${name} 所有新旧语义色完整且可解析`, () => {
    const palette = appearance()[name];
    assert.ok(palette, `缺少 ${name}`);
    assert.deepEqual(Object.keys(palette).sort(), [...PALETTE_KEYS].sort(), '色表契约有变化时必须同步测试，而不是漏验新增色');
    for (const key of PALETTE_KEYS) rgba(palette[key]);
  });

  test(`${name} 普通文字、状态和实心按钮文字至少 4.5:1`, () => {
    const c = appearance()[name];
    for (const foreground of ['text', 'text2', 'text3']) {
      for (const background of ['page', 'card']) atLeast(c, foreground, background, 4.5, name);
    }
    for (const [fg, bg] of [
      ['accentText', 'accentBg'], ['purpleText', 'purpleBg'], ['tealText', 'tealBg'],
      ['amberText', 'amberBg'], ['coralText', 'coralBg'], ['danger', 'dangerBg'],
      ['onAccent', 'accent'], ['onDanger', 'danger'], ['text', 'selection'],
      ['mediaForeground', 'mediaBackground'],
    ]) atLeast(c, fg, bg, 4.5, name);
  });

  test(`${name} 正文至少 7:1、必要控件与焦点至少 3:1`, () => {
    const c = appearance()[name];
    for (const bg of ['page', 'card']) {
      atLeast(c, 'text', bg, 7, name);
      for (const fg of ['focus', 'accent', 'danger']) atLeast(c, fg, bg, 3, name);
    }
    /*
     * 边线只是交界处的一道影子，结构交给 **card / page 的底色差**（v0.20.9 起）。
     *
     * 原来这里要求 hair 对 page/card 至少 3:1，理由是「边线是控件边界的唯一表达」。
     * 代价是整页布满 1px 中灰框，读起来像表格 —— 用户 2026-11-15 的原话是
     * 「边线太清晰，清晰后显得有点难看」。
     *
     * 于是改成两条更弱但更准确的约束：
     *   1) 边线仍然「看得见」（≥1.1:1），不是完全消失；
     *   2) 既然线淡了，底色就必须真的分得开，否则结构两头落空。
     *
     * 第 2 条原来只对墨水生效，**漏掉了默认浅色 —— 而那里 page 与 card 都是
     * `#FFFFFF`**，于是所有白底卡片（设置子页、文档卡、待办组、整理产出卡）
     * 白叠白，只剩一圈看不见的 0.5px。2026-11-15 复核时发现并补上：
     * 这条现在对四套色表都成立，任何一套再退回「同色」都会当场失败。
     */
    for (const bg of ['page', 'card']) atLeast(c, 'hair', bg, 1.1, name);
    assert.notEqual(c.card, c.page, `${name} 的 card 与 page 同色，而边线又已淡化 —— 结构会消失`);
  });
}

for (const name of ['INK_LIGHT', 'INK_DARK']) {
  test(`${name} 包括半透明遮罩在内的全部 UI 色为中性灰`, () => {
    const palette = appearance()[name];
    for (const key of PALETTE_KEYS) {
      const [r, g, b] = rgba(palette[key]);
      assert.equal(r, g, `${name}.${key} 仍含色相：${palette[key]}`);
      assert.equal(g, b, `${name}.${key} 仍含色相：${palette[key]}`);
    }
  });
}

test('四套媒体前景/背景相同，不因浅深/墨水反相原件', () => {
  const a = appearance();
  for (const name of PALETTE_NAMES) {
    assert.equal(a[name].mediaBackground, a.LIGHT.mediaBackground);
    assert.equal(a[name].mediaForeground, a.LIGHT.mediaForeground);
    assert.ok(rgba(a[name].mediaScrim)[3] > 0 && rgba(a[name].mediaScrim)[3] < 1);
  }
});

test('几何契约有真实48dp控件槽，墨水边线更明确而非缩小触控区', () => {
  const a = appearance();
  for (const name of ['DEFAULT_METRICS', 'INK_METRICS']) {
    const metrics = a[name];
    // typeScale 是 v0.26 加的**缓存键**：它让样式工厂的 memo 在档位变化时失效，
    // 不是几何参数。这里钉住它默认是 1（标准档），免得有人拿它当圆角用
    assert.deepEqual(Object.keys(metrics).sort(), ['cardRadius', 'buttonRadius', 'strokeWidth', 'controlHeight', 'pagePadding', 'outline', 'typeScale'].sort());
    assert.equal(metrics.typeScale, 1);
    for (const value of Object.values(metrics)) assert.ok(Number.isFinite(value) && value >= 0);
    assert.ok(metrics.controlHeight >= 48);
    assert.ok(metrics.strokeWidth >= 1);
    assert.ok([4, 8, 12, 16, 24].includes(metrics.pagePadding));
  }
  assert.equal(a.DEFAULT_METRICS.controlHeight, a.INK_METRICS.controlHeight);
  assert.ok(a.INK_METRICS.cardRadius <= a.DEFAULT_METRICS.cardRadius);
  assert.ok(a.INK_METRICS.buttonRadius <= a.DEFAULT_METRICS.buttonRadius);
  assert.ok(a.INK_METRICS.strokeWidth >= a.DEFAULT_METRICS.strokeWidth);
});

/*
 * 字号档位（v0.26）。
 *
 * 这件事的可验部分只有三样：倍数递增而不过分、行高跟着字号一起放大、
 * 标准档与原值完全一致（不能因为「加了个功能」让默认界面悄悄变样）。
 * 真机上的换行、卡片高度、被截断的标题，只有装包才看得见。
 */
test('字号档位：递增、行高同步、标准档等于原值', () => {
  const ui = loader.load('src/util/uiTokens.ts');
  const order = ['small', 'normal', 'large', 'xlarge'];
  const factors = order.map((k) => ui.TYPE_SCALE_FACTOR[k]);
  assert.ok(factors.every((f) => f > 0), '倍数必须为正');
  for (let i = 1; i < factors.length; i++) assert.ok(factors[i] > factors[i - 1], '档位必须一档比一档大');
  assert.equal(factors[order.indexOf('normal')], 1, '标准档就是 1 —— 默认界面不能因为加档位而变样');
  assert.ok(factors[factors.length - 1] <= 1.3, '最大档再大就会把两列布局挤断');

  const base = { ...ui.TYPE };
  ui.setTypeScale('normal');
  assert.deepEqual({ ...ui.TYPE }, base, '标准档必须与原值逐项相同');

  ui.setTypeScale('xlarge');
  for (const role of Object.keys(base)) {
    assert.equal(ui.TYPE[role].fontSize, Math.round(base[role].fontSize * ui.TYPE_SCALE_FACTOR.xlarge), `${role} 字号要按倍数放大`);
    assert.equal(ui.TYPE[role].lineHeight, Math.round(base[role].lineHeight * ui.TYPE_SCALE_FACTOR.xlarge), `${role} 行高也要放大（只放大字会挤成一块）`);
    assert.equal(ui.TYPE[role].fontWeight, base[role].fontWeight, '字重不随档位变');
  }
  // 收尾：断言之间不能互相污染，后面的用例还在标准档上
  ui.setTypeScale('normal');
  assert.deepEqual({ ...ui.TYPE }, base);
  assert.equal(ui.normalizeTypeScale('huge'), 'normal', '不认识的档位回落到标准');

  // 接线：设置页给四档，App 读设置、先改 TYPE 再改 state
  const settings = readSource('src/screens/SettingsScreen.tsx');
  assert.ok(settings.includes('setTypeScale(choice)'), '设置页要能拨档位');
  const app = readSource('App.tsx');
  assert.ok(app.includes('normalizeTypeScale(await repo.getSetting(K_TYPE_SCALE))'), '启动要读回来');
  const applyAt = app.indexOf('setTypeScale(scale);');
  const stateAt = app.indexOf('setTypeScaleState(scale);');
  assert.ok(applyAt > 0 && stateAt > applyAt, '先改 TYPE 再改 state，否则第一帧还是旧字号');
});

test('模式与风格各有完整、非空的中文标签', () => {
  const a = appearance();
  assert.deepEqual(Object.keys(a.THEME_MODE_LABEL).sort(), ['dark', 'light', 'system']);
  assert.deepEqual(Object.keys(a.THEME_STYLE_LABEL).sort(), ['default', 'ink']);
  for (const value of [...Object.values(a.THEME_MODE_LABEL), ...Object.values(a.THEME_STYLE_LABEL)]) {
    assert.ok(typeof value === 'string' && value.trim().length > 0);
  }
});

/** 只替换 hooks 与 JSX 构造，不重写 ThemeProvider / useThemedStyles。 */
function themeHarness(initialReduced = false, initialQuery) {
  let reduced = initialReduced;
  let themeContext;
  let listener;
  let removed = 0;
  const effects = [];
  const memoDeps = [];
  const react = {
    createContext(value) { themeContext = { current: value, Provider: 'test-theme-provider' }; return themeContext; },
    useContext(value) { return value.current; },
    useCallback(fn) { return fn; },
    useMemo(fn, deps) { memoDeps.push(deps); return fn(); },
    useState() { return [reduced, (value) => { reduced = typeof value === 'function' ? value(reduced) : value; }]; },
    useEffect(fn) { effects.push(fn); },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const isolated = createLoader({
    stubs: {
      react,
      'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'test-fragment' },
      'react-native': {
        AccessibilityInfo: {
          isReduceMotionEnabled: () => initialQuery || Promise.resolve(initialReduced),
          addEventListener(event, fn) {
            assert.equal(event, 'reduceMotionChanged');
            listener = fn;
            return { remove() { removed++; } };
          },
        },
      },
    },
  });
  const theme = isolated.load('src/theme.tsx');
  return {
    theme,
    effects,
    memoDeps,
    render(props = {}) {
      const child = { marker: '同一个子树，不因风格改变而换 key' };
      const element = theme.ThemeProvider({ mode: 'system', systemDark: false, onChangeMode() {}, children: child, ...props });
      assert.equal(element.type, themeContext.Provider);
      assert.equal(element.key, undefined, '风格不是 Provider 的 remount key');
      assert.strictEqual(element.props.children, props.children || child);
      themeContext.current = element.props.value;
      return element.props.value;
    },
    emitReduced(value) { assert.equal(typeof listener, 'function'); listener(value); },
    removed: () => removed,
  };
}

test('ThemeProvider 保持旧调用兼容并分别转发两个 setter', () => {
  const h = themeHarness();
  const calls = [];
  const old = h.render({ mode: 'dark', onChangeMode: (v) => calls.push(['mode', v]) });
  assert.equal(old.style, 'default');
  assert.equal(old.dark, true);
  old.setMode('light');
  old.setStyle('ink'); // 旧调用没有 onChangeStyle，必须安全无操作
  assert.deepEqual(calls, [['mode', 'light']]);
  const value = h.render({ onChangeMode: (v) => calls.push(['mode', v]), onChangeStyle: (v) => calls.push(['style', v]) });
  value.setStyle('ink');
  value.setMode('system');
  assert.deepEqual(calls, [['mode', 'light'], ['style', 'ink'], ['mode', 'system']]);
});

test('墨水与系统减少动效取并集，取消系统偏好不取消墨水策略', async () => {
  const h = themeHarness(false);
  assert.equal(h.render().reduceMotion, false);
  const cleanup = h.effects[0]();
  await Promise.resolve();
  h.emitReduced(true);
  assert.equal(h.render({ style: 'default' }).reduceMotion, true);
  h.emitReduced(false);
  assert.equal(h.render({ style: 'ink' }).reduceMotion, true);
  assert.equal(h.render({ style: 'default' }).reduceMotion, false);
  cleanup();
  assert.equal(h.removed(), 1);
});

test('卸载后到达的减少动效查询不更新已卸载 Provider 状态', async () => {
  const query = deferred();
  const h = themeHarness(false, query.promise);
  h.render();
  const cleanup = h.effects[0]();
  cleanup();
  query.resolve(true);
  await Promise.resolve();
  assert.equal(h.render().reduceMotion, false);
  assert.equal(h.removed(), 1);
});

test('useThemedStyles 同时接入色表/几何并兼容旧单参数工厂', () => {
  const h = themeHarness();
  const first = h.render({ mode: 'light', style: 'default' });
  const legacy = h.theme.useThemedStyles((c) => ({ color: c.text }));
  assert.equal(legacy.styles.color, first.c.text);
  const updated = h.render({ mode: 'light', style: 'ink' });
  h.memoDeps.length = 0;
  const styles = h.theme.useThemedStyles((c, metrics) => ({ color: c.text, radius: metrics.cardRadius }));
  assert.deepEqual(plain(styles.styles), { color: updated.c.text, radius: updated.metrics.cardRadius });
  assert.strictEqual(styles.metrics, updated.metrics);
  assert.ok(h.memoDeps[0].includes(updated.c), '样式 useMemo 必须依赖当前色表');
  assert.ok(h.memoDeps[0].includes(updated.metrics), '几何改变也必须重建样式，不能只有 c 依赖');
});

test('外观落盘失败信息可见，下一次成功可清除', () => {
  const h = themeHarness();
  const message = '本次已应用，未能保存';
  assert.equal(h.render({ saveError: message }).saveError, message);
  assert.equal(h.render({ saveError: null }).saveError, null);
});

for (const name of PALETTE_NAMES) {
  test(`${name} 的PDF保持白纸原稿，用半透明灰墨而非白accent遮字`, () => {
    const a = appearance();
    const { pdfThemeOf } = loader.load('src/documents/readers/pdfTheme.ts');
    const ink = name.startsWith('INK_');
    const metrics = ink ? a.INK_METRICS : a.DEFAULT_METRICS;
    const pdf = pdfThemeOf(a[name], metrics, ink);
    assert.equal(pdf.paper.toUpperCase(), '#FFFFFF');
    assert.equal(pdf.page, a[name].page);
    for (const [field, alpha] of [['hitBg', 0.12], ['hitCurrent', 0.18], ['selection', 0.24]]) {
      const channels = rgba(pdf[field]);
      assert.deepEqual(channels.slice(0, 3), rgba(a[name].mediaBackground).slice(0, 3));
      assert.equal(channels[3], alpha);
      assert.ok(contrast('#111111', pdf[field], pdf.paper) >= 7, `${field}遮住了纸面正文`);
    }
    assert.ok(contrast(pdf.hitOutline, pdf.paper) >= 3, '当前命中还须有可见轮廓，不只改变底色');
    assert.equal(pdf.strokeWidth, metrics.strokeWidth);
    assert.equal(pdf.radius, metrics.cardRadius);
    assert.equal(pdf.reduceMotion, ink);
  });
}

test('PDF主题返回字段与真实PdfTheme协议完整对齐', () => {
  const source = parseSource('src/documents/readers/pdfProtocol.ts');
  const protocol = source.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === 'PdfTheme');
  assert.ok(protocol, '缺少真实PdfTheme接口');
  const keys = protocol.members.filter(ts.isPropertySignature).map((node) => node.name.getText(source)).sort();
  const pdf = loader.load('src/documents/readers/pdfTheme.ts').pdfThemeOf(appearance().INK_DARK, appearance().INK_METRICS, true);
  assert.deepEqual(Object.keys(pdf).sort(), keys, '新增/删掉协议字段必须与转换函数一起改');
});

test('真实PDF模板applyTheme传递纸色/选区/轮廓/几何与减少动效，不重开文档', () => {
  const properties = new Map();
  const attributes = new Map();
  const templateLoader = createLoader();
  const document = {
    documentElement: {
      style: { setProperty: (key, value) => properties.set(key, value) },
      setAttribute: (key, value) => attributes.set(key, value),
    },
  };
  const { applyTheme } = templateLoader.extract(
    'src/documents/readers/pdfjs/reader.template.html', ['applyTheme'], { document }, { inlineScripts: true },
  );
  const { pdfThemeOf } = loader.load('src/documents/readers/pdfTheme.ts');
  for (const reduced of [true, false]) {
    const value = pdfThemeOf(appearance().INK_DARK, appearance().INK_METRICS, reduced);
    applyTheme(value);
    for (const [css, field] of [
      ['--page', 'page'], ['--paper', 'paper'], ['--surface', 'surface'],
      ['--hit', 'hitBg'], ['--hit-current', 'hitCurrent'], ['--hit-outline', 'hitOutline'], ['--selection', 'selection'],
    ]) assert.equal(properties.get(css), value[field], css);
    assert.equal(properties.get('--stroke'), `${value.strokeWidth}px`);
    assert.equal(properties.get('--radius'), `${value.radius}px`);
    assert.equal(attributes.get('data-reduce-motion'), String(reduced));
  }
});

test('PDF产品模板选区走主题变量，不加固定彩色选区、阴影或原稿反相', () => {
  const html = readSource('src/documents/readers/pdfjs/reader.template.html');
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
  assert.ok(css.trim(), '必须实际读到模板样式');
  assert.match(css, /::selection\s*\{[^}]*background\s*:\s*var\(--selection\)/);
  assert.doesNotMatch(css, /(?:box|text)-shadow\s*:/i);
  assert.doesNotMatch(css, /filter\s*:[^;}]*\b(?:invert|grayscale)\s*\(/i);
  assert.match(css, /background\s*:\s*var\(--paper\)/, '原件纸色和页面深色必须分开');
});

if (require.main === module) {
  suite.run().then(({ failed }) => { process.exitCode = failed ? 1 : 0; }).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
module.exports = { run: suite.run };
