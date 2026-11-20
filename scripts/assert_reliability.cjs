#!/usr/bin/env node
/**
 * 可靠性回归（Node 22+）：真实 TypeScript / 页面函数 + 内存 I/O 桩。
 *
 * 用法：node scripts/assert_reliability.cjs
 * 不执行真实 SQLite/迁移、不读写用户文件、不调用模型、不运行 React Native。
 * 没有 .tmp-*、子进程或新依赖。失败打印原始堆栈，不改源码/断言来伪造通过。
 */
const assert = require('node:assert/strict');
const {
  createLoader, createSuite, deferred, findDeclaration, memoryStorage, parseSource, plain, ts,
} = require('./test_loader.cjs');

const suite = createSuite('数据可靠性回归');
const { test } = suite;
const AT = new Date(2026, 10, 14, 12, 34).getTime();
const WEB_KEY = 'fragments.webdb.v2';
const noop = () => {};

function fragment(id, content, extra = {}) {
  return {
    id, content, createdAt: AT + id * 60000, source: 'app', status: 'inbox', tags: [],
    project: null, mergedInto: null, nature: null, organizedAt: null, images: [], ...extra,
  };
}
function image(id, text = null) {
  return { id, path: `fixture-${id}.jpg`, text, createdAt: AT };
}
function fixtureDb(fragments = [], extra = {}) {
  return {
    seq: 10000, fragments, todos: [], notes: [], runs: [], settings: {}, sessions: [],
    askSessions: [], documents: [], documentChunks: [], ...extra,
  };
}
function webRepo(storage = memoryStorage(), stubs = {}, globals = {}) {
  const loader = createLoader({ globals: { localStorage: storage, ...globals }, stubs });
  return { loader, repo: loader.load('src/db/repo.web.ts').repo, storage };
}
function sampleCommit(extra = {}) {
  return {
    draftId: 'draft-fixture-1',
    documents: [{
      key: 'doc-local-A', title: '恢复检查', excerpt: '先核对原件',
      content: {
        bodyMd: '先核对原件，再验证副本。', pages: null, source: 'markdown',
        chunks: [{ text: '先核对原件，再验证副本。', locator: { kind: 'markdown', lineStart: 1, lineEnd: 1 } }],
      },
    }],
    todos: [{ key: 'todo-local-A', text: '做恢复检查', dueAt: null,
      children: [{ key: 'todo-local-A-child', text: '核对副本', dueAt: null }] }],
    sourceIds: [], sessionId: null, ...extra,
  };
}

/* ----- F01：执行 App 的真实 handleAdd，而不是另写一份保存算法 ----- */
function addHarness(overrides = {}) {
  const calls = { saved: [], removed: [], insert: [], reload: 0, ai: 0, postCommitContentWrites: 0 };
  const loader = createLoader();
  const bindings = {
    isWeb: true,
    useCallback: (fn) => fn,
    reload: async () => { calls.reload++; if (overrides.reloadError) throw overrides.reloadError; },
    saveFragmentImage: async (uri) => {
      if (overrides.saveErrorAt === calls.saved.length + 1) throw new Error('TEST_FILE_COPY_FAILED');
      const saved = `saved-${calls.saved.length + 1}.jpg`;
      calls.saved.push({ uri, path: saved });
      return saved;
    },
    removeFragmentImage: async (file) => { calls.removed.push(file); },
    resolvePendingTokens: loader.load('src/util/inlineImages.ts').resolvePendingTokens,
    // v0.31：新建碎片时会先摘掉「指向别的碎片」的图片标记，桩要跟着给
    stripStoredImageTokens: loader.load('src/util/inlineImages.ts').stripStoredImageTokens,
    loadAiConfig: async () => { calls.ai++; throw new Error('保存不应请求 AI 配置'); },
    describeImage: async () => { calls.ai++; throw new Error('保存不应触发 OCR'); },
    repo: {
      async insertFragment(...args) {
        calls.insert.push(args);
        if (overrides.insertError) throw overrides.insertError;
        return 77;
      },
      async findFragmentsByIds() { return [fragment(77, '正文', { images: [image(101), image(102)] })]; },
      async updateFragmentContent() { calls.postCommitContentWrites++; },
    },
  };
  const { handleAdd } = loader.extract('App.tsx', ['handleAdd'], bindings, { scope: 'Shell' });
  return { handleAdd, calls };
}

test('F01：图已提交、reload失败，只返回已保存提示，不删图或拒绝发布', async () => {
  const h = addHarness({ reloadError: new Error('TEST_RELOAD_FAILED_AFTER_COMMIT') });
  const warning = await h.handleAdd('正文\n![](img:p1)', [{ key: 'p1', uri: 'memory://picked-one' }]);
  assert.equal(h.calls.insert.length, 1);
  assert.equal(h.calls.reload, 1);
  assert.deepEqual(h.calls.removed, [], '数据库已引用的文件不能被刷新错误删掉');
  assert.equal(typeof warning, 'string', '提交后的刷新失败必须显式告知，但不能抛成保存失败');
  assert.match(warning, /已(?:经)?(?:保存|记录)|保存成功/);
  assert.equal(h.calls.ai, 0);
});

test('保存把待发key和图片路径一起交给Repo，不在commit之后补正文', async () => {
  const h = addHarness();
  await h.handleAdd('正文\n![](img:p9)', [{ key: 'p9', uri: 'memory://picked-nine' }]);
  const args = h.calls.insert[0];
  assert.equal(args[0], '正文\n![](img:p9)');
  assert.equal(args[3][0].key, 'p9', 'Repo 必须在原子边界内知道待发 key');
  assert.equal(args[3][0].path, 'saved-1.jpg');
  assert.equal(h.calls.postCommitContentWrites, 0, '不能提交之后再修 ![](img:p...)');
  assert.equal(h.calls.ai, 0);
});

test('图文件已复制但Repo拒绝提交，只清理本次未引用的文件', async () => {
  const failure = new Error('TEST_INSERT_ROLLED_BACK');
  const h = addHarness({ insertError: failure });
  await assert.rejects(
    h.handleAdd('正文', [{ key: 'p1', uri: 'memory://a' }, { key: 'p2', uri: 'memory://b' }]),
    /TEST_INSERT_ROLLED_BACK/,
  );
  assert.deepEqual(h.calls.removed, ['saved-1.jpg', 'saved-2.jpg']);
  assert.equal(h.calls.reload, 0);
});

test('第二张图复制失败时不插库，并回收仅第一张复制成功的临时副本', async () => {
  const h = addHarness({ saveErrorAt: 2 });
  await assert.rejects(h.handleAdd('', [{ key: 'p1', uri: 'memory://a' }, { key: 'p2', uri: 'memory://b' }]), /TEST_FILE_COPY_FAILED/);
  assert.equal(h.calls.insert.length, 0);
  assert.deepEqual(h.calls.removed, ['saved-1.jpg']);
});

test('纯文字提交后刷新失败也不诱导再次发布', async () => {
  const h = addHarness({ reloadError: new Error('TEST_TEXT_RELOAD_FAILED') });
  const warning = await h.handleAdd('只写一句话');
  assert.equal(h.calls.insert.length, 1);
  assert.equal(typeof warning, 'string');
  assert.match(warning, /已(?:经)?(?:保存|记录)|保存成功/);
  assert.equal(h.calls.saved.length, 0);
});

/* ----- F03：Repo 桩只存取原始行，不替产品实现判重 ----- */
function importHarness(initial = []) {
  const rows = initial.map((x) => plain(x));
  const queries = [];
  const attempts = [];
  let failInsertAt = null;
  let failTags = false;
  let failQuery = false;
  const repo = {
    async listFragmentsBetween(from, to) {
      queries.push({ from, to });
      if (failQuery) { failQuery = false; throw new Error('TEST_IMPORT_QUERY_FAILED'); }
      return rows.filter((r) => r.createdAt >= from && r.createdAt < to).map(plain);
    },
    async listAllFragments() { return rows.map(plain); },
    async insertImportedFragment(content, createdAt, tags) {
      const attempt = attempts.push({ content, source: 'import', createdAt, tags: [...tags] });
      await Promise.resolve(); // 暴露两次 applyImport 同时检查再写入的竞态
      if (attempt === failInsertAt) { failInsertAt = null; throw new Error('TEST_IMPORT_PARTIAL_FAILURE'); }
      if (failTags) { failTags = false; throw new Error('TEST_IMPORT_ATOMIC_FAILURE'); }
      const id = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
      rows.push(fragment(id, content, { source: 'import', createdAt, tags: [...tags], status: tags.length ? 'tagged' : 'inbox' }));
      return id;
    },
    async insertFragment() { throw new Error('导入必须走原子 insertImportedFragment，不能先插入再补标签'); },
    async applyTags() { throw new Error('旧标签必须在原子导入接口里一起写'); },
    async markStatus() { throw new Error('导入状态必须在原子导入接口里一起写'); },
  };
  const loader = createLoader({ stubs: { './repo': { repo } } });
  return {
    ...loader.load('src/db/importMd.ts'), rows, queries, attempts,
    failAt(n) { failInsertAt = n; }, failTagsOnce() { failTags = true; }, failQueryOnce() { failQuery = true; },
  };
}
function parsedItem(content, minute, tags = []) {
  return { content, createdAt: AT + minute * 60000, tags, line: minute + 1, hasTime: true, hasDate: true };
}

test('F03：预览末分钟已有59秒记录，按整分钟指纹判重', async () => {
  const lastMinute = new Date(2026, 10, 14, 23, 59).getTime();
  const h = importHarness([fragment(1, '最后一条有秒数', { createdAt: lastMinute + 59999 })]);
  const preview = await h.previewImport({ name: 'fixture.md', text: '### 2026-11-14\n- 23:59 最后一条有秒数\n' });
  assert.equal(preview.total, 1);
  assert.equal(preview.duplicates, 1);
  assert.equal(preview.fresh.length, 0, '查询上界 +1ms 会漏掉同一分钟带秒数的旧记录');
  assert.equal(preview.to, '2026-11-14', '查询上界跨到次日，展示仍应是最后一条记录的日期');
  assert.equal(h.attempts.length, 0, '预览不得写库');
});

test('预览首分钟、末分钟和同文件重复共用同一个判重口径', async () => {
  const h = importHarness([
    fragment(1, '早上已有', { createdAt: new Date(2026, 10, 14, 8, 0, 58).getTime() }),
    fragment(2, '晚上已有', { createdAt: new Date(2026, 10, 14, 21, 40, 32).getTime() }),
  ]);
  const result = await h.previewImport({ name: 'fixture.md', text: '### 2026-11-14\n- 08:00 早上已有\n- 12:00 新的一条\n- 12:00 新的一条\n- 21:40 晚上已有\n' });
  assert.equal(result.duplicates, 3);
  assert.equal(result.fresh.length, 1);
  assert.equal(result.fresh[0].content, '新的一条');
});

test('F03：部分导入失败后再次提交原items，不重复第一条；第三次是零新增', async () => {
  const h = importHarness();
  const items = [parsedItem('第一条', 0), parsedItem('第二条', 1, ['旧标签']), parsedItem('第三条', 2)];
  const before = JSON.stringify(items);
  h.failAt(2);
  await assert.rejects(h.applyImport(items), (error) => {
    assert.match(error.message, /TEST_IMPORT_PARTIAL_FAILURE/);
    assert.equal(error.inserted, 1);
    assert.equal(error.tagged, 0);
    assert.equal(error.line, items[1].line);
    assert.match(error.cause.message, /TEST_IMPORT_PARTIAL_FAILURE/);
    return true;
  });
  assert.equal(h.rows.length, 1, '故障注入确实发生在第一条之后');
  const retried = await h.applyImport(items);
  assert.equal(retried.inserted, 2);
  assert.deepEqual(h.rows.map((x) => x.content), ['第一条', '第二条', '第三条']);
  assert.deepEqual(h.rows.find((x) => x.content === '第二条').tags, ['旧标签']);
  assert.equal((await h.applyImport(items)).inserted, 0);
  assert.equal(h.rows.length, 3);
  assert.equal(JSON.stringify(items), before, '不能靠篡改调用方items来假装幂等');
});

test('两次并发applyImport同一预览不会因检查/写入竞态制造副本', async () => {
  const h = importHarness();
  const items = [parsedItem('并发甲', 0), parsedItem('并发乙', 1)];
  const results = await Promise.all([h.applyImport(items), h.applyImport(items)]);
  assert.equal(h.rows.length, 2);
  assert.equal(new Set(h.rows.map((x) => x.content)).size, 2);
  assert.equal(results.reduce((n, result) => n + result.inserted, 0), 2);
});

test('导入正文/旧标签共用原子接口，失败后的队列可重试', async () => {
  const h = importHarness();
  const items = [parsedItem('带旧标签的内容', 0, ['旧标签'])];
  h.failTagsOnce();
  await assert.rejects(h.applyImport(items), /TEST_IMPORT_ATOMIC_FAILURE/);
  assert.equal(h.rows.length, 0, '桩模拟整条原子接口回滚，不留漏标签的半记录');
  await h.applyImport(items);
  assert.equal(h.rows.length, 1);
  assert.deepEqual(h.rows[0].tags, ['旧标签']);
  assert.equal(h.rows[0].organizedAt, null, '恢复旧标签不冒充新整理');
  assert.deepEqual(h.attempts[0].tags, ['旧标签']);
});

test('并发的交叠导入[a,b]/[b,c]最终只写三条', async () => {
  const h = importHarness();
  const a = parsedItem('交叠甲', 0);
  const b = parsedItem('交叠乙', 1);
  const c = parsedItem('交叠丙', 2);
  const results = await Promise.all([h.applyImport([a, b]), h.applyImport([b, c])]);
  assert.equal(h.rows.length, 3);
  assert.equal(results.reduce((n, result) => n + result.inserted, 0), 3);
  assert.equal(new Set(h.rows.map((x) => x.content)).size, 3);
});

test('带OCR原记录导出后重新预览，同时认新投影和旧正文指纹', async () => {
  const original = fragment(1, '手写旧正文\n![](img:2)', {
    createdAt: AT + 59999, images: [image(2, 'OCR新投影')], tags: ['旧标签'],
  });
  const h = importHarness([original]);
  const { buildMarkdown } = markdownModules();
  const exported = await h.previewImport({ name: 'new-format.md', text: buildMarkdown([original]).content });
  assert.equal(exported.duplicates, 1, 'canonical导出投影必须能与仍分开存图文字的原记录判重');
  assert.equal(exported.fresh.length, 0);
  const old = await h.previewImport({ name: 'old-format.md', text: '### 2026-11-14\n- 12:34 手写旧正文 #旧标签\n' });
  assert.equal(old.duplicates, 1, '老导出没有OCR，升级后仍能识别同一条原文');
});

test('待办清单是迁出阅读内容，不被导入成碎片或待办写库', async () => {
  const h = importHarness();
  const preview = await h.previewImport({ name: 'todos.md', text: '## 时间轴\n### 2026-11-14\n- 12:34 真正碎片\n## 待办\n### 未完成\n- [ ] 这不是碎片\n  - [ ] 子步骤也不是\n' });
  assert.equal(preview.fresh.length, 1);
  await h.applyImport(preview.fresh);
  assert.deepEqual(h.rows.map((x) => x.content), ['真正碎片']);
});

test('纯图空旧指纹不误吞合法纯标点，标点真正导入后重试仍幂等', async () => {
  for (const content of ['', '![](img:1)']) for (const ocr of [null, '已有OCR']) {
    const h = importHarness([fragment(1, content, { createdAt: AT, images: [image(1, ocr)] })]);
    const preview = await h.previewImport({ name: 'punctuation.md', text: '### 2026-11-14\n- 12:34 ...\n' });
    assert.equal(preview.duplicates, 0, '纯图没有旧正文，不能登记共享的空normText指纹');
    assert.equal(preview.fresh.length, 1);
    assert.equal((await h.applyImport(preview.fresh)).inserted, 1);
    assert.equal((await h.applyImport(preview.fresh)).inserted, 0, '真实标点正文的空normText仍须参与判重');
    assert.equal(h.rows.filter((row) => row.content === '...').length, 1);
  }
});

test('导入查询失败不毒化队列，过期预览写入前重新判重', async () => {
  const h = importHarness();
  const items = [parsedItem('确认的记录', 0)];
  h.failQueryOnce();
  await assert.rejects(h.applyImport(items), /TEST_IMPORT_QUERY_FAILED/);
  assert.equal((await h.applyImport(items)).inserted, 1);
  const preview = await h.previewImport({ name: 'stale.md', text: '### 2026-11-14\n- 12:35 预览之后已存入\n' });
  h.rows.push(fragment(999, '预览之后已存入', { createdAt: AT + 60000 + 32000 }));
  assert.equal((await h.applyImport(preview.fresh)).inserted, 0);
});

test('导入确认时冻结items及tags，排队后修改输入不改变已确认内容', async () => {
  const h = importHarness();
  const items = [parsedItem('确认当时的文字', 0, ['确认时标签'])];
  const writing = h.applyImport(items);
  items[0].content = '确认之后又编辑的字';
  items[0].tags[0] = '后来的标签';
  await writing;
  assert.equal(h.rows[0].content, '确认当时的文字');
  assert.deepEqual(h.rows[0].tags, ['确认时标签']);
});

/* ----- F04：迁出结果必须经真实 parser 回读 ----- */
function markdownModules() {
  const loader = createLoader();
  return { ...loader.load('src/util/mdBuild.ts'), ...loader.load('src/util/mdParse.ts') };
}

test('F04：纯图有OCR时，导出/导入保留可读文字而不是只剩时间', () => {
  const { buildMarkdown, parseMarkdown } = markdownModules();
  const original = fragment(1, '![](img:11)', { createdAt: AT, images: [image(11, '恢复码 ABC-42\n先断电，再换盘')] });
  const output = buildMarkdown([original]);
  const back = parseMarkdown(output.content, AT).items;
  assert.equal(back.length, 1);
  assert.equal(back[0].createdAt, AT);
  assert.match(back[0].content, /ABC-42/);
  assert.match(back[0].content, /先断电，再换盘/);
  assert.ok(!output.content.includes('img:11'));
  assert.notEqual(back[0].content, '12:34');
});

test('多图文字和手写正文同时迁出，旧标签仍能往返', () => {
  const { buildMarkdown, parseMarkdown } = markdownModules();
  const f = fragment(1, '手写的结论\n![](img:1)\n![](img:2)', {
    createdAt: AT, tags: ['旧标签'], images: [image(1, '第一张OCR-ABC'), image(2, '第二张OCR-XYZ')],
  });
  const back = parseMarkdown(buildMarkdown([f]).content, AT).items;
  assert.equal(back.length, 1);
  for (const text of ['手写的结论', '第一张OCR-ABC', '第二张OCR-XYZ']) assert.ok(back[0].content.includes(text), text);
  assert.deepEqual(plain(back[0].tags), ['旧标签']);
});

test('F04：无文字纯图明确说明缺失，不能再导入成12:34伪记录', () => {
  const { buildMarkdown, parseMarkdown } = markdownModules();
  for (const text of [null, '', '   ']) {
    const f = fragment(1, '![](img:1)', { createdAt: AT, images: [image(1, text)] });
    const output = buildMarkdown([f]);
    assert.match(output.content, /(?:图片|配图|原图).*(?:未|不|缺|另|原件)|(?:未|不|缺).*(?:图片|配图|原图)/, '迁出文件必须明确说原图/可读文字没有被完整迁出');
    const items = parseMarkdown(output.content, AT).items;
    for (const item of items) {
      assert.ok(!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(item.content), '不能把时间误作正文');
      assert.match(item.content, /图片|配图|原图|未导出|缺失/, '若保留占位记录，必须明确是缺失图片而非虚构原文');
    }
  }
});

test('图片编号保留真实位置，导出占位不污染原图null/空串状态', () => {
  const loader = createLoader();
  const { fragmentText } = loader.load('src/util/fragmentText.ts');
  const { exportFragmentText } = loader.load('src/util/mdExport.ts');
  const f = fragment(1, '', { images: [image(11, null), image(12, '只有第二张的文字'), image(13, '')] });
  const before = JSON.stringify(f);
  const readable = fragmentText(f);
  assert.match(readable, /第 2 张/);
  assert.ok(!readable.includes('第 1 张'), '不能把过滤后的数组序号当成原图位置');
  const exported = exportFragmentText(f);
  for (const label of ['第 1 张', '第 2 张', '第 3 张', '尚未读取图片文字', '未读出可导出文字']) assert.ok(exported.includes(label), label);
  assert.equal(JSON.stringify(f), before, '占位属于迁出投影，不能把null改成已OCR的文字');
});

test('旧导出留下的仅时间列表行不再变成正文（含尾随旧标签）', () => {
  const { parseMarkdown } = markdownModules();
  const back = parseMarkdown('### 2026-11-14\n- 12:34\n- 12:35   #旧标签\n- 12:36:42\n', AT);
  assert.equal(back.items.length, 0);
});

/* ----- F02：执行真实设置页入口 -> 真实web Repo -> 真实导出器 ----- */
test('F02：设置页只有1条窗口，导出仍独立读取完整501条并包含最老记录', async () => {
  const all = Array.from({ length: 501 }, (_, i) => fragment(i + 1, `导出唯一记录-${i + 1}`, { createdAt: AT + i * 60000 }));
  const storage = memoryStorage({ [WEB_KEY]: JSON.stringify(fixtureDb(all)) });
  const files = new Map();
  const statuses = [];
  class File {
    constructor(...parts) { this.uri = parts.map((p) => typeof p === 'string' ? p : p.uri).join('/'); }
    get exists() { return files.has(this.uri); }
    create() { files.set(this.uri, ''); }
    write(value) { files.set(this.uri, String(value)); }
    delete() { files.delete(this.uri); }
  }
  const h = webRepo(storage, {
    'react-native': { Platform: { OS: 'android' } },
    'expo-file-system': { File, Paths: { cache: 'memory://exports' } },
    'expo-file-system/legacy': {
      cacheDirectory: 'memory://exports/', writeAsStringAsync: async (uri, value) => { files.set(uri, value); },
    },
    'expo-sharing': { isAvailableAsync: async () => false, shareAsync: async () => { throw new Error('测试不得真实分享'); } },
  });
  const { exportMarkdown } = h.loader.load('src/export/markdown.ts');
  const { handleExport } = h.loader.extract('src/screens/SettingsScreen.tsx', ['handleExport'], {
    repo: h.repo, fragments: [all[500]], exportMarkdown, busy: 'idle',
    setBusy: noop, setIoMsg: (value) => { statuses.push(value); },
  }, { scope: 'SettingsScreen' });
  await handleExport();
  assert.equal(statuses.at(-1)?.kind, 'ok', JSON.stringify(statuses));
  assert.equal(files.size, 1, '导出必须真正执行到文件I/O桩');
  const { parseMarkdown } = h.loader.load('src/util/mdParse.ts');
  const back = parseMarkdown([...files.values()][0], AT).items;
  assert.equal(back.length, 501, '不能通过提高页面窗口上限掩盖导出缺失');
  assert.ok(back.some((x) => x.content === '导出唯一记录-1'));
});

test('web.listAllFragments不受500窗口限制，同时间按id倒序', async () => {
  const rows = Array.from({ length: 503 }, (_, i) => fragment(i + 1, `记录-${i}`, { createdAt: AT }));
  const h = webRepo(memoryStorage({ [WEB_KEY]: JSON.stringify(fixtureDb(rows)) }));
  assert.equal((await h.repo.listFragments()).length, 500);
  const all = await h.repo.listAllFragments();
  assert.equal(all.length, 503);
  assert.deepEqual(plain(all.map((f) => f.id)), rows.map((f) => f.id).reverse());
});

/* ----- F10：共享搜索投影，不把仍保留的数据字段当作隐形命中 ----- */
test('共享搜索投影包含正文/OCR/事项，但不包含旧tags或图片定位key', () => {
  const { fragmentSearchText } = createLoader().load('src/util/fragmentText.ts');
  const output = fragmentSearchText(fragment(1, '手写正文\n![](img:11)', {
    tags: ['retiredsecret'], project: 'issueprojection', images: [image(11, 'opticalneedle')],
  }));
  for (const word of ['手写正文', 'issueprojection', 'opticalneedle']) assert.ok(output.includes(word), word);
  assert.ok(!output.includes('retiredsecret'));
  assert.ok(!output.includes('img:11'));
});

test('真实web搜索能找到OCR/事项，不能只因旧标签命中', async () => {
  const rows = [
    fragment(1, '只在图里', { images: [image(11, 'opticalneedle')] }),
    fragment(2, '普通正文', { tags: ['retiredsecret'] }),
    fragment(3, '另一条', { project: 'issueprojection' }),
  ];
  const h = webRepo(memoryStorage({ [WEB_KEY]: JSON.stringify(fixtureDb(rows)) }));
  assert.deepEqual(plain((await h.repo.searchFragments('opticalneedle')).map((f) => f.id)), [1]);
  assert.deepEqual(plain((await h.repo.searchFragments('issueprojection')).map((f) => f.id)), [3]);
  assert.equal((await h.repo.searchFragments('retiredsecret')).length, 0);
});

/* ----- F05：执行真实web commitDraft，凭据而非数组下标决定是否已写 ----- */
test('web commitDraft重试不复制文档/父子待办，且不重写同key正文', async () => {
  const h = webRepo();
  const input = sampleCommit();
  const first = await h.repo.commitDraft(input);
  assert.equal(first.documents.length, 1);
  assert.equal(first.todos.length, 2);
  assert.equal(first.documents[0].key, 'doc-local-A');
  const changed = plain(input);
  changed.documents[0].title = '模型重排后换的标题';
  changed.documents[0].content.bodyMd = '这段不应覆盖已经写入的正文';
  const second = await h.repo.commitDraft(changed);
  assert.deepEqual(plain(second), plain(first));
  assert.equal((await h.repo.listDocuments()).length, 1);
  const todos = await h.repo.listTodos();
  assert.equal(todos.length, 2);
  const parent = todos.find((t) => t.parentId === null);
  assert.ok(parent);
  assert.equal(todos.find((t) => t.id !== parent.id).parentId, parent.id);
  assert.equal((await h.repo.findDocument(first.documents[0].id)).bodyMd, input.documents[0].content.bodyMd);
});

test('web提交凭据落入现有settings，新加载的Repo仍幂等', async () => {
  const h = webRepo();
  const input = sampleCommit();
  const first = await h.repo.commitDraft(input);
  const raw = await h.repo.getSetting(`draft.commit.${input.draftId}`);
  assert.ok(raw, '不能只在模块内记已写key');
  const fresh = webRepo(h.storage);
  const second = await fresh.repo.commitDraft(input);
  assert.deepEqual(plain(second), plain(first));
  assert.equal((await fresh.repo.listDocuments()).length, 1);
  assert.equal((await fresh.repo.listTodos()).length, 2);
});

test('web commitDraft存储失败不留半份内存结果或凭据，原计划可以重试', async () => {
  const h = webRepo();
  await h.repo.init();
  h.storage.failNext(new Error('TEST_RECEIPT_STORAGE_FAILED'));
  const input = sampleCommit();
  await assert.rejects(h.repo.commitDraft(input), /TEST_RECEIPT_STORAGE_FAILED/);
  assert.equal((await h.repo.listDocuments()).length, 0);
  assert.equal((await h.repo.listTodos()).length, 0);
  assert.equal(await h.repo.getSetting(`draft.commit.${input.draftId}`), null);
  const result = await h.repo.commitDraft(input);
  assert.equal(result.documents.length, 1);
  assert.equal(result.todos.length, 2);
});

test('web凭据损坏时拒绝，不当作空凭据重新插入', async () => {
  const input = sampleCommit();
  for (const bad of ['{broken', '{}', '{"documents":"not-array","todos":[]}']) {
    const h = webRepo(memoryStorage({ [WEB_KEY]: JSON.stringify(fixtureDb([], { settings: { [`draft.commit.${input.draftId}`]: bad } })) }));
    await assert.rejects(h.repo.commitDraft(input));
    assert.equal((await h.repo.listDocuments()).length, 0);
    assert.equal((await h.repo.listTodos()).length, 0);
    assert.equal(await h.repo.getSetting(`draft.commit.${input.draftId}`), bad, '损坏证据必须保留');
  }
});

test('web已写文档后来被用户删除，同key重试不偷偷复活', async () => {
  const h = webRepo();
  const input = sampleCommit();
  const first = await h.repo.commitDraft(input);
  await h.repo.deleteDocument(first.documents[0].id);
  await h.repo.commitDraft(input);
  assert.equal((await h.repo.listDocuments()).length, 0);
  assert.equal((await h.repo.listTodos()).length, 2);
});

test('web拒绝空提交计划，不能伪报成功', async () => {
  const h = webRepo();
  await assert.rejects(h.repo.commitDraft(sampleCommit({ documents: [], todos: [] })));
  assert.equal((await h.repo.listDocuments()).length, 0);
});

test('web图片key在原子插入内解析，9张边界和不存在的父记录不留半批', async () => {
  const h = webRepo();
  const id = await h.repo.insertFragment('正文\n![](img:p8)', 'app', AT, [{ key: 'p8', path: 'one.jpg' }]);
  let row = (await h.repo.findFragmentsByIds([id]))[0];
  assert.ok(row.content.includes(`img:${row.images[0].id}`));
  assert.ok(!row.content.includes('img:p8'));
  await h.repo.insertFragmentImages(id, Array.from({ length: 7 }, (_, i) => ({ path: `extra-${i}.jpg` })));
  await assert.rejects(h.repo.insertFragmentImages(id, [{ path: 'ninth.jpg' }, { path: 'tenth.jpg' }]));
  row = (await h.repo.findFragmentsByIds([id]))[0];
  assert.equal(row.images.length, 8, '超9张整批拒绝，不能留下其中一张');
  await assert.rejects(h.repo.insertFragmentImages(999999, [{ path: 'orphan.jpg' }]));
  assert.equal((await h.repo.findFragmentsByIds([id]))[0].images.length, 8);
});

test('web原子导入同时保留旧标签与状态，不新造organizedAt', async () => {
  const h = webRepo();
  const id = await h.repo.insertImportedFragment('导入原文', AT, ['Legacy', 'Legacy']);
  const row = (await h.repo.findFragmentsByIds([id]))[0];
  assert.equal(row.source, 'import');
  assert.equal(row.status, 'tagged');
  assert.equal(row.createdAt, AT);
  assert.equal(row.organizedAt, null);
  assert.deepEqual(plain(row.tags), ['Legacy']);
});

test('web setSetting写失败不污染当前cache，后续可以成功保存', async () => {
  const h = webRepo(memoryStorage({ [WEB_KEY]: JSON.stringify(fixtureDb([], { settings: { ui_style: 'default' } })) }));
  assert.equal(await h.repo.getSetting('ui_style'), 'default');
  h.storage.failNext(new Error('TEST_SETTING_WRITE_FAILED'));
  await assert.rejects(h.repo.setSetting('ui_style', 'ink'), /TEST_SETTING_WRITE_FAILED/);
  assert.equal(await h.repo.getSetting('ui_style'), 'default');
  await h.repo.setSetting('ui_style', 'ink');
  assert.equal(await h.repo.getSetting('ui_style'), 'ink');
});

function sessionFixture(extra = {}) {
  return {
    id: 71, title: '原会话', turns: [{ question: '问', answer: '答' }], scope: { kind: 'records' },
    archived: false, fragmentId: null, documentId: null, documentIds: [], sourceIds: [],
    createdAt: AT, updatedAt: AT, ...extra,
  };
}

test('web提交失败一并回滚seq/凭据/来源标记/会话关系，重试等同干净提交', async () => {
  const initial = JSON.stringify(fixtureDb([fragment(1, '来源', { createdAt: AT })], { askSessions: [sessionFixture()] }));
  const storage = memoryStorage({ [WEB_KEY]: initial });
  class FixedDate extends Date { static now() { return AT + 10000; } }
  const h = webRepo(storage, {}, { Date: FixedDate });
  const input = sampleCommit({ sourceIds: [1], sessionId: 71 });
  storage.failNext(new Error('TEST_ATOMIC_ALL_FAILED'));
  await assert.rejects(h.repo.commitDraft(input), /TEST_ATOMIC_ALL_FAILED/);
  assert.equal(storage.getItem(WEB_KEY), initial);
  assert.equal((await h.repo.findFragmentsByIds([1]))[0].organizedAt, null);
  assert.deepEqual(plain((await h.repo.findAskSession(71)).documentIds), []);
  assert.equal((await h.repo.listDocuments()).length, 0);
  assert.equal((await h.repo.listTodos()).length, 0);
  const retried = await h.repo.commitDraft(input);
  const clean = webRepo(memoryStorage({ [WEB_KEY]: initial }), {}, { Date: FixedDate });
  assert.deepEqual(plain(retried), plain(await clean.repo.commitDraft(input)), '失败不能消耗seq留下与干净执行不同的身份');
});

test('web相同key重试不刷新文档/来源/会话metadata', async () => {
  let now = AT + 10000;
  class ClockDate extends Date { static now() { return now; } }
  const h = webRepo(memoryStorage({ [WEB_KEY]: JSON.stringify(fixtureDb([fragment(1, '来源')], { askSessions: [sessionFixture()] })) }), {}, { Date: ClockDate });
  const input = sampleCommit({ sourceIds: [1], sessionId: 71 });
  const first = await h.repo.commitDraft(input);
  const before = {
    document: plain(await h.repo.findDocument(first.documents[0].id)),
    source: plain((await h.repo.findFragmentsByIds([1]))[0]),
    session: plain(await h.repo.findAskSession(71)),
  };
  now += 60000;
  await h.repo.commitDraft(input);
  assert.deepEqual(plain(await h.repo.findDocument(first.documents[0].id)), before.document);
  assert.deepEqual(plain((await h.repo.findFragmentsByIds([1]))[0]), before.source);
  assert.deepEqual(plain(await h.repo.findAskSession(71)), before.session);
});

test('web累计receipt复用已写父项，仅添新子项并重开已完成父项', async () => {
  const h = webRepo();
  const input = sampleCommit();
  const first = await h.repo.commitDraft(input);
  const parent = first.todos.find((entry) => entry.key === 'todo-local-A');
  await h.repo.toggleTodo(parent.id, true);
  const extra = sampleCommit({ documents: [], todos: [{ ...input.todos[0], children: [{ key: 'child-later', text: '后来批准的新步骤', dueAt: null }] }] });
  const next = await h.repo.commitDraft(extra);
  assert.equal(next.documents.length, 1, 'receipt仍包含前次已写文档');
  assert.equal(next.todos.length, 3);
  assert.equal(next.todos.find((entry) => entry.key === parent.key).id, parent.id);
  const todos = await h.repo.listTodos();
  assert.equal(todos.find((todo) => todo.id === parent.id).done, false);
  const child = todos.find((todo) => todo.text === '后来批准的新步骤');
  assert.equal(child.parentId, parent.id);
  assert.equal(child.done, false);
});

for (const action of ['delete', 'merge']) {
  test(`web父项被${action === 'delete' ? '删除' : '合并'}后新子项不能借receipt复活旧父项`, async () => {
    const h = webRepo();
    const input = sampleCommit();
    const receipt = await h.repo.commitDraft(input);
    const parent = receipt.todos.find((entry) => entry.key === 'todo-local-A');
    if (action === 'delete') await h.repo.deleteTodo(parent.id);
    else {
      const keep = await h.repo.insertTodo({ text: '保留的另一父项', dueAt: null, sourceFragmentId: null, parentId: null });
      await h.repo.mergeTodos(keep, [parent.id]);
    }
    const before = plain(await h.repo.listTodos());
    await assert.rejects(h.repo.commitDraft(sampleCommit({ documents: [], todos: [{ ...input.todos[0], children: [{ key: 'must-not-appear', text: '不应被写入的新步骤', dueAt: null }] }] })));
    assert.deepEqual(plain(await h.repo.listTodos()), before);
  });
}

test('web输入里指向已不存在的会话，不创建幽灵会话', async () => {
  const h = webRepo();
  await h.repo.commitDraft(sampleCommit({ sessionId: 987654 }));
  assert.equal(await h.repo.findAskSession(987654), null);
  assert.equal((await h.repo.listAskSessions(true)).length, 0);
});

test('web坏读/坏JSON不退成空库写回，读修复后保留原rows和seq', async () => {
  for (const kind of ['throw', 'json']) {
    const original = JSON.stringify(fixtureDb([fragment(7, '必须保留的原记录')]));
    const storage = memoryStorage({ [WEB_KEY]: kind === 'json' ? '{broken' : original });
    const read = storage.getItem.bind(storage);
    if (kind === 'throw') storage.getItem = () => { throw new Error('TEST_STORAGE_READ_FAILED'); };
    const h = webRepo(storage);
    await assert.rejects(h.repo.listAllFragments());
    await assert.rejects(h.repo.setSetting('ui_style', 'ink'));
    assert.equal(storage.writes.length, 0, '不能把读取失败解释为空库再写回');
    storage.getItem = read;
    storage.values.set(WEB_KEY, original); // 仅修复这个用例的内存fixture
    const recovered = await h.repo.listAllFragments();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, 7);
    assert.equal(recovered[0].content, '必须保留的原记录');
    assert.equal(JSON.parse(storage.getItem(WEB_KEY)).seq, 10000);
  }
});

/* ----- 原生Repo：只记录SQLite API调用，不冒充SQL引擎/真实迁移 ----- */
function nativeTrace(options = {}) {
  const trace = [];
  const settings = new Map(Object.entries(options.settings || {}));
  let rows = (options.fragmentRows || []).map(plain);
  let images = (options.imageRows || []).map(plain);
  let sequence = 1000;
  let active = false;
  let snapshot;
  let fault;
  const paramsOf = (args) => args.length === 1 && Array.isArray(args[0]) ? Array.from(args[0]) : args;
  const compact = (sql) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
  function record(method, sql, params = []) {
    const event = { method, sql: compact(sql), params: plain(params), inTransaction: active };
    trace.push(event);
    if (fault && fault(event)) { fault = null; throw new Error(`TEST_SQL_FAULT: ${event.sql}`); }
    return event.sql;
  }
  function execSync(raw) {
    const sql = record('exec', raw).toUpperCase();
    if (/^BEGIN(?: TRANSACTION| IMMEDIATE(?: TRANSACTION)?)?$/.test(sql)) {
      assert.equal(active, false, '测试桩不允许嵌套BEGIN');
      snapshot = { rows: plain(rows), images: plain(images), settings: new Map(settings), sequence };
      active = true;
    } else if (sql === 'COMMIT' || sql === 'END TRANSACTION') {
      assert.equal(active, true, 'COMMIT必须有BEGIN');
      active = false;
      snapshot = undefined;
    } else if (sql === 'ROLLBACK') {
      assert.equal(active, true, 'ROLLBACK必须有BEGIN');
      rows = snapshot.rows;
      images = snapshot.images;
      sequence = snapshot.sequence;
      settings.clear();
      for (const [key, value] of snapshot.settings) settings.set(key, value);
      active = false;
      snapshot = undefined;
    } else {
      throw new Error(`测试桩未声明的execSync（不会执行迁移）：${raw}`);
    }
  }
  // 这里只把已观察到的INSERT绑定值变成读回fixture，不实现约束、FTS、排序或业务判据。
  function insertedFixture(sql, params) {
    const match = sql.match(/^INSERT(?: OR \w+)? INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (!match) return null;
    const columns = match[2].split(',').map((x) => x.trim());
    const values = match[3].split(',').map((x) => x.trim());
    if (columns.length !== values.length) throw new Error(`未支持的fixture INSERT：${sql}`);
    let at = 0;
    const result = {};
    values.forEach((value, index) => {
      if (value === '?') result[columns[index]] = params[at++];
      else if (/^NULL$/i.test(value)) result[columns[index]] = null;
      else if (/^'.*'$/.test(value)) result[columns[index]] = value.slice(1, -1).replace(/''/g, "'");
      else if (/^-?\d+(?:\.\d+)?$/.test(value)) result[columns[index]] = Number(value);
      else throw new Error(`fixture INSERT含未支持表达式 ${value}；请显式更新测试桩`);
    });
    return { table: match[1], values: result };
  }
  const database = {
    execSync,
    withTransactionSync(fn) {
      execSync('BEGIN');
      try { const value = fn(); execSync('COMMIT'); return value; }
      catch (error) { if (active) execSync('ROLLBACK'); throw error; }
    },
    runSync(raw, ...args) {
      const params = paramsOf(args);
      const sql = record('run', raw, params);
      if (!/^(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) throw new Error(`未声明的runSync：${sql}`);
      const inserted = insertedFixture(sql, params);
      const id = inserted ? ++sequence : sequence;
      if (inserted?.table === 'settings') {
        assert.equal(typeof inserted.values.key, 'string');
        settings.set(inserted.values.key, inserted.values.value);
      } else if (/^UPDATE settings SET value\s*=\s*\? WHERE key\s*=\s*\?/i.test(sql)) {
        settings.set(params[1], params[0]);
      } else if (inserted?.table === 'fragments') {
        rows.push({
          id, content: '', created_at: AT, source: 'app', status: 'inbox', tags: '[]',
          project: null, merged_into: null, nature: null, organized_at: null,
          ...inserted.values,
        });
      } else if (inserted?.table === 'fragment_images') {
        images.push({ id, text: null, created_at: AT, ordinal: 0, ...inserted.values });
      } else if (/^UPDATE fragments SET content\s*=\s*\? WHERE id\s*=\s*\?/i.test(sql)) {
        const row = rows.find((r) => r.id === params[1]);
        if (row) row.content = params[0];
      }
      return { lastInsertRowId: id, changes: 1 };
    },
    getFirstSync(raw, ...args) {
      const params = paramsOf(args);
      const sql = record('first', raw, params);
      if (/\bFROM settings\b/i.test(sql)) return settings.has(params[0]) ? { value: settings.get(params[0]) } : null;
      if (/\bFROM fragment_images\b/i.test(sql) && /COUNT\(\*\)/i.test(sql)) {
        return { n: images.filter((r) => r.fragment_id === params[0]).length };
      }
      if (/\bFROM fragment_images\b/i.test(sql) && /MAX\(ordinal\)/i.test(sql)) {
        const mine = images.filter((r) => r.fragment_id === params[0]);
        return { n: mine.length ? Math.max(...mine.map((r) => r.ordinal)) : null };
      }
      if (/\bFROM fragments\b/i.test(sql)) return plain(rows.find((r) => r.id === params[0]) || null);
      if (/\bFROM documents\b/i.test(sql)) return { id: params[0], content_revision: 0 };
      if (/\bFROM ask_sessions\b/i.test(sql)) return options.session ? plain(options.session) : null;
      throw new Error(`测试桩未声明的getFirstSync：${sql}`);
    },
    getAllSync(raw, ...args) {
      const params = paramsOf(args);
      const sql = record('all', raw, params);
      if (/\bFROM fragment_images\b/i.test(sql)) {
        return plain(/WHERE fragment_id/i.test(sql) ? images.filter((r) => params.includes(r.fragment_id)) : images);
      }
      if (/\bFROM document_chunks\b/i.test(sql)) return [];
      if (/\bFROM fragment_fts\b/i.test(sql)) return [];
      if (/\bFROM fragments\b/i.test(sql)) return plain(rows);
      if (/\bFROM ask_sessions\b/i.test(sql)) return options.session ? [plain(options.session)] : [];
      throw new Error(`测试桩未声明的getAllSync：${sql}`);
    },
  };
  /*
   * repo.native 会 import './backup'，而 backup 用 expo-file-system 与 fflate。
   * 这里的断言不跑备份流程，所以给空桩只为了让模块能加载 —— 真正的备份逻辑
   * 在 assert_backup.cjs（纯函数）和真机上验，不在这里假装验过。
   */
  const loader = createLoader({
    stubs: {
      'expo-sqlite': { openDatabaseSync: () => database },
      'expo-file-system': {
        Directory: class {},
        File: class {},
        Paths: { document: {}, cache: {} },
      },
      fflate: {
        zipSync: () => new Uint8Array(),
        unzipSync: () => ({}),
        strToU8: (s) => new Uint8Array(Array.from(String(s), (c) => c.charCodeAt(0))),
        strFromU8: (b) => String.fromCharCode.apply(null, Array.from(b)),
      },
    },
  });
  return {
    repo: loader.load('src/db/repo.native.ts').repo,
    trace, settings,
    failNext(predicate) { fault = predicate; },
    rows: () => plain(rows), images: () => plain(images),
  };
}
function sqlWrites(h, table) {
  const pattern = new RegExp(`^INSERT(?: OR \\w+)? INTO ${table}(?:\\s|\\()`, 'i');
  return h.trace.filter((event) => event.method === 'run' && pattern.test(event.sql));
}
function assertAtomicTrace(h, expectedEnd) {
  const starts = h.trace.filter((e) => e.method === 'exec' && /^BEGIN\b/i.test(e.sql));
  assert.equal(starts.length, 1, '一次原子操作应只有一个事务');
  const end = h.trace.filter((e) => e.method === 'exec' && /^(COMMIT|ROLLBACK|END TRANSACTION)$/i.test(e.sql));
  assert.equal(end.length, 1);
  assert.match(end[0].sql, expectedEnd === 'commit' ? /^(COMMIT|END TRANSACTION)$/i : /^ROLLBACK$/i);
  const writes = h.trace.filter((e) => e.method === 'run');
  assert.ok(writes.length > 0, '用例必须实际执行到写入路径');
  for (const event of writes) assert.equal(event.inTransaction, true, `事务外写入：${event.sql}`);
}

test('native插碎片：正文、图片key替换、FTS均在COMMIT之前', async () => {
  const h = nativeTrace();
  const id = await h.repo.insertFragment('正文\n![](img:p9)', 'app', AT, [{ path: 'fixture.jpg', key: 'p9', text: 'opticalneedle' }]);
  assertAtomicTrace(h, 'commit');
  assert.equal(sqlWrites(h, 'fragments').length, 1);
  assert.equal(sqlWrites(h, 'fragment_images').length, 1);
  const row = h.rows().find((r) => r.id === id);
  const picture = h.images()[0];
  assert.ok(row.content.includes(`img:${picture.id}`), '真实SQL写回必须把p9换成刚插入的图片id');
  assert.ok(!row.content.includes('img:p9'));
  const index = sqlWrites(h, 'fragment_fts');
  assert.equal(index.length, 1);
  assert.ok(index[0].params.some((x) => typeof x === 'string' && x.includes('opticalneedle')));
});

test('native FTS写入失败走ROLLBACK，而不是图片先COMMIT后才报错', async () => {
  const h = nativeTrace();
  h.failNext((e) => e.method === 'run' && /^INSERT INTO fragment_fts\b/i.test(e.sql));
  await assert.rejects(h.repo.insertFragment('正文', 'app', AT, [{ path: 'fixture.jpg' }]), /TEST_SQL_FAULT/);
  assertAtomicTrace(h, 'rollback');
});

test('native批量加图第二张失败，请求回滚而非留下第一张', async () => {
  const h = nativeTrace({ fragmentRows: [{ id: 1, content: '原文', tags: '[]', project: null }] });
  let inserts = 0;
  h.failNext((e) => e.method === 'run' && /^INSERT INTO fragment_images\b/i.test(e.sql) && ++inserts === 2);
  await assert.rejects(h.repo.insertFragmentImages(1, [{ path: 'one.jpg' }, { path: 'two.jpg' }]), /TEST_SQL_FAULT/);
  assertAtomicTrace(h, 'rollback');
  assert.equal(h.images().length, 0, '记录桩按收到的ROLLBACK恢复fixture');
});

test('native原子导入让正文、旧标签、状态、索引同事务提交', async () => {
  const h = nativeTrace();
  const id = await h.repo.insertImportedFragment('恢复的正文', AT, ['retiredsecret']);
  assertAtomicTrace(h, 'commit');
  const row = h.rows().find((r) => r.id === id);
  assert.equal(row.content, '恢复的正文');
  // 既有 cleanTag/dedupeTags 只保存前12字；导入应沿用该规范，不放宽生产限制。
  const storedTags = JSON.parse(row.tags);
  assert.deepEqual(storedTags, ['retiredsecre']);
  assert.equal(storedTags[0].length, 12);
  assert.equal(row.organized_at, null);
  const index = sqlWrites(h, 'fragment_fts');
  assert.equal(index.length, 1);
  for (const tag of ['retiredsecret', 'retiredsecre']) {
    assert.ok(!index[0].params.some((x) => typeof x === 'string' && x.includes(tag)), '旧标签按规范保存，但原值和规范化值都不能进入搜索索引');
  }
});

test('native commitDraft一次提交文档/切片/FTS/父子待办/凭据', async () => {
  const h = nativeTrace();
  const input = sampleCommit();
  const receipt = await h.repo.commitDraft(input);
  assertAtomicTrace(h, 'commit');
  assert.equal(sqlWrites(h, 'documents').length, 1);
  assert.equal(sqlWrites(h, 'document_chunks').length, 1);
  assert.equal(sqlWrites(h, 'document_chunks_fts').length, 1);
  assert.equal(sqlWrites(h, 'todos').length, 2);
  assert.equal(receipt.documents.length, 1);
  assert.equal(receipt.todos.length, 2);
  assert.ok(h.settings.has(`draft.commit.${input.draftId}`));
});

test('native读取持久化凭据，同draft/key第二次不再INSERT业务条目', async () => {
  const h = nativeTrace();
  const input = sampleCommit();
  const first = await h.repo.commitDraft(input);
  h.trace.length = 0;
  const second = await h.repo.commitDraft(input);
  assert.deepEqual(plain(second), plain(first));
  for (const table of ['documents', 'document_chunks', 'document_chunks_fts', 'todos']) assert.equal(sqlWrites(h, table).length, 0, table);
});

test('native凭据落盘失败请求整笔ROLLBACK，重试才获得唯一业务条目', async () => {
  const h = nativeTrace();
  const input = sampleCommit();
  h.failNext((e) => e.method === 'run' && /\bsettings\b/i.test(e.sql) && e.params.includes(`draft.commit.${input.draftId}`));
  await assert.rejects(h.repo.commitDraft(input), /TEST_SQL_FAULT/);
  assertAtomicTrace(h, 'rollback');
  assert.equal(h.settings.has(`draft.commit.${input.draftId}`), false);
  h.trace.length = 0;
  const result = await h.repo.commitDraft(input);
  assertAtomicTrace(h, 'commit');
  assert.equal(result.documents.length, 1);
  assert.equal(result.todos.length, 2);
});

test('native损坏凭据拒绝重插，保留原始坏值供调查', async () => {
  const input = sampleCommit();
  const key = `draft.commit.${input.draftId}`;
  const h = nativeTrace({ settings: { [key]: '{broken' } });
  await assert.rejects(h.repo.commitDraft(input));
  assert.equal(h.settings.get(key), '{broken');
  assert.equal(sqlWrites(h, 'documents').length, 0);
  assert.equal(sqlWrites(h, 'todos').length, 0);
});

/* ----- F05/F06/F07：页面和重试共用的真实整理执行器/工作区 ----- */
function draftFixture(extra = {}) {
  return {
    mode: 'knowledge', sourceIds: [], note: '',
    docs: [{ title: '文档甲', summary: '摘要甲', bodyMd: '正文甲', keep: true }],
    todos: [{ text: '待办甲', due: null, keep: true, children: [{ text: '子项甲', due: null, keep: true }] }],
    ...extra,
  };
}
function organizeModules(stubs = {}) {
  const loader = createLoader({ stubs });
  return {
    loader,
    ...loader.load('src/organize/workspace.ts'),
    ...loader.load('src/organize/run.ts'),
    ...loader.load('src/organize/storage.ts'),
  };
}
function owner(extra = {}) {
  return { id: 71, title: '原历史会话', turns: [{ question: '怎么恢复？', answer: '核对副本再恢复。' }], scope: { kind: 'records' }, createdAt: AT, ...extra };
}
function sessionWorkspace(api, extra = {}) {
  return api.createWorkspace({
    mode: 'knowledge',
    source: { kind: 'session', title: '原历史会话', turns: [{ question: '怎么恢复？', answer: '核对副本再恢复。' }] },
    instruction: '只保留恢复顺序', owner: owner(), draftId: 'workspace-fixture', ...extra,
  });
}
function outcome(extra = {}) {
  return { draft: draftFixture(extra), reasoning: '', truncated: false, used: 30 };
}
function runDeps(overrides = {}) {
  const events = [];
  const requests = [];
  let latest;
  const deps = {
    loadFragments: async (ids) => ids.map((id) => fragment(id, `来源-${id}`)),
    loadTodos: async () => [],
    persist: async (work) => { events.push({ kind: 'persist', work: plain(work) }); },
    onChange: (work) => { latest = plain(work); events.push({ kind: 'change', work: plain(work) }); },
    extractKnowledge: async (request) => {
      requests.push(plain(request)); events.push({ kind: 'extract' });
      return outcome({ sourceIds: request.source.kind === 'fragments' ? request.source.fragments.map((f) => f.id) : [] });
    },
    ...overrides,
  };
  return { deps, events, requests, latest: () => latest };
}

test('F07：历史session执行器真的调用提炼，且真实AI模块收到原问答', async () => {
  const chatCalls = [];
  class AiError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const api = organizeModules({
    'src/ai/chat.ts': {
      AiError,
      clipRaw: (raw) => String(raw),
      parseJsonLoose: JSON.parse,
      requestChat: async (config, messages, progress, options) => {
        chatCalls.push({ config, messages: plain(messages), options: plain(options) });
        return { content: JSON.stringify({ docs: [{ title: '恢复顺序', summary: '检查副本', body_md: '先核对副本，再恢复。' }], todos: [], note: '测试桩输出' }), finishReason: 'stop', reasoning: '' };
      },
    },
  });
  const knowledge = api.loader.load('src/ai/knowledge.ts');
  const work = sessionWorkspace(api);
  const sentSources = [];
  const h = runDeps({
    loadFragments: async () => { throw new Error('session-source不应查询最近碎片'); },
    extractKnowledge: async (request) => {
      sentSources.push(plain(request.source));
      return knowledge.extractKnowledge({ ...request, config: { apiKey: 'TEST_ONLY_NEVER_SENT', baseUrl: 'https://invalid.test/v1', model: 'test-stub', thinking: false } });
    },
  });
  const result = await api.executeOrganize(work, h.deps);
  assert.equal(sentSources.length, 1, '不能产生0次模型调用却记录“整理完成”');
  assert.equal(sentSources[0].kind, 'session');
  assert.equal(sentSources[0].title, '原历史会话');
  assert.deepEqual(sentSources[0].turns, plain(work.request.source.turns));
  assert.equal(chatCalls.length, 1);
  const material = chatCalls[0].messages.map((message) => message.content).join('\n');
  for (const text of ['怎么恢复？', '核对副本再恢复。', '只保留恢复顺序']) assert.ok(material.includes(text), text);
  assert.equal(result.phase, 'complete');
  assert.equal(result.sessionProcessed, true);
  assert.equal(result.draft.docs.length, 1);
  assert.equal(result.pending, null);
  assert.ok(h.events.some((e) => e.kind === 'persist' && e.work.pending?.kind === 'session'), '发送前必须先保存准确输入');
});

test('session提炼失败后原workspace重试仍是原会话/要求，不改成最近碎片', async () => {
  const api = organizeModules();
  const initial = sessionWorkspace(api);
  const calls = [];
  let latest;
  let fail = true;
  const h = runDeps({
    onChange: (work) => { latest = plain(work); },
    loadFragments: async () => { throw new Error('重试不能换成碎片'); },
    extractKnowledge: async (request) => {
      calls.push(plain(request));
      if (fail) { fail = false; throw new Error('TEST_SESSION_EXTRACT_FAILED'); }
      return outcome();
    },
  });
  await assert.rejects(api.executeOrganize(initial, h.deps), /TEST_SESSION_EXTRACT_FAILED/);
  assert.equal(latest.phase, 'failed');
  assert.equal(latest.pending.kind, 'session');
  assert.equal(latest.sessionProcessed, false);
  const retried = await api.executeOrganize(latest, h.deps);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].source, calls[0].source);
  assert.equal(calls[1].instruction, '只保留恢复顺序');
  assert.equal(retried.request.owner.id, 71);
  assert.equal(retried.phase, 'complete');
});

test('文档范围历史会话不偷偷读取全库待办或碎片', async () => {
  const api = organizeModules();
  const work = sessionWorkspace(api, { owner: owner({ scope: { kind: 'documents', documentIds: [42] } }) });
  const h = runDeps({
    loadTodos: async () => { throw new Error('不能读取文档范围以外的待办'); },
    loadFragments: async () => { throw new Error('不能读取文档范围以外的碎片'); },
  });
  await api.executeOrganize(work, h.deps);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].existingTodos, []);
});

test('F06：显式id快照处理低id的晚记录，不依赖最大id游标；继续才发下一批', async () => {
  const api = organizeModules();
  const ids = Array.from({ length: 43 }, (_, i) => 1000 - i * 7);
  ids[42] = 1;
  const initial = api.createWorkspace({ mode: 'knowledge', source: { kind: 'fragments', ids, all: true }, owner: owner(), draftId: 'all-ids' });
  const h = runDeps({ maxBatches: 1, loadFragments: async (wanted) => [...wanted].reverse().map((id) => fragment(id, `快照-${id}`)) });
  const paused = await api.executeOrganize(initial, h.deps);
  assert.equal(paused.phase, 'paused');
  assert.deepEqual(plain(paused.processedIds), ids.slice(0, 40));
  assert.deepEqual(plain(api.remainingIds(paused)), ids.slice(40));
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].source.fragments.map((f) => f.id), ids.slice(0, 40));
  const finished = await api.executeOrganize(paused, h.deps);
  assert.equal(finished.phase, 'complete');
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].source.fragments.map((f) => f.id), ids.slice(40));
  assert.ok(finished.processedIds.includes(1));
  assert.equal(initial.processedIds.length, 0, '不能改写传入的旧快照');
});

test('快照中已删除的来源单列missing，不冒充已生成或因空批卡死', async () => {
  const api = organizeModules();
  const initial = api.createWorkspace({ mode: 'knowledge', source: { kind: 'fragments', ids: [10, 2, 30], all: true }, owner: owner(), draftId: 'missing-ids' });
  const h = runDeps({ loadFragments: async () => [fragment(30, '乙'), fragment(10, '甲')] });
  const result = await api.executeOrganize(initial, h.deps);
  assert.deepEqual(plain(result.missingIds), [2]);
  assert.deepEqual(plain(result.processedIds), [10, 30]);
  assert.ok(result.steps.some((step) => step.text.includes('不存在')));
  assert.equal(result.phase, 'complete');
});

test('输入检查点存不下来时不调用模型，保留pending以供用户重试', async () => {
  const api = organizeModules();
  let latest;
  let extracts = 0;
  const h = runDeps({
    onChange: (work) => { latest = plain(work); },
    persist: async () => { throw new Error('TEST_PRE_REQUEST_PERSIST_FAILED'); },
    extractKnowledge: async () => { extracts++; return outcome(); },
  });
  await assert.rejects(api.executeOrganize(sessionWorkspace(api), h.deps), /TEST_PRE_REQUEST_PERSIST_FAILED/);
  assert.equal(extracts, 0);
  assert.equal(latest.phase, 'failed');
  assert.equal(latest.pending.kind, 'session');
});

test('输出已生成但持久化失败，保留内容/进度，重试保存不重复调用模型', async () => {
  const api = organizeModules();
  let latest;
  let saves = 0;
  let extracts = 0;
  const h = runDeps({
    onChange: (work) => { latest = plain(work); },
    persist: async () => { saves++; if (saves === 2) throw new Error('TEST_POST_RESULT_PERSIST_FAILED'); },
    extractKnowledge: async () => { extracts++; return outcome(); },
  });
  await assert.rejects(api.executeOrganize(sessionWorkspace(api), h.deps), /TEST_POST_RESULT_PERSIST_FAILED/);
  assert.equal(latest.phase, 'failed');
  assert.equal(latest.draft.docs.length, 1);
  assert.equal(latest.sessionProcessed, true);
  const recovered = await api.executeOrganize(latest, h.deps);
  assert.equal(extracts, 1);
  assert.equal(recovered.phase, 'complete');
  assert.equal(recovered.draft.docs.length, 1);
});

test('切会话后迟到的模型结果/进度不污染新状态或持久化旧快照', async () => {
  const api = organizeModules();
  const gate = deferred();
  const entered = deferred();
  let current = true;
  let changes = 0;
  let saves = 0;
  let progress = 0;
  let callback;
  const h = runDeps({
    isCurrent: () => current,
    onChange: () => { changes++; }, persist: async () => { saves++; }, onProgress: () => { progress++; },
    extractKnowledge: async (request) => { callback = request.onProgress; entered.resolve(); return gate.promise; },
  });
  const running = api.executeOrganize(sessionWorkspace(api), h.deps);
  await entered.promise;
  const before = { changes, saves };
  current = false;
  callback({ content: '不应写进新会话' });
  gate.resolve(outcome());
  await running;
  assert.equal(changes, before.changes);
  assert.equal(saves, before.saves);
  assert.equal(progress, 0);
});

test('稳定身份不会与后面已有key碰撞，也不修改原草稿', () => {
  const api = organizeModules();
  const draft = draftFixture({ draftId: 'stable', docs: [
    { title: '没key', summary: '', bodyMd: '甲', keep: true },
    { key: 'stable.doc.1', title: '已有key', summary: '', bodyMd: '乙', keep: false },
  ] });
  const before = JSON.stringify(draft);
  const next = api.ensureDraftIdentity(draft);
  const keys = [...next.docs, ...next.todos, ...next.todos.flatMap((t) => t.children)].map((x) => x.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(next.docs[1].key, 'stable.doc.1');
  assert.notEqual(next.docs[0].key, 'stable.doc.1');
  assert.equal(JSON.stringify(draft), before);
});

test('F05：改稿重排不恢复取消选择，已写内容保留，新增内容默认待审', () => {
  const api = organizeModules();
  const original = api.ensureDraftIdentity(draftFixture({ draftId: 'revision', docs: [
    { key: 'doc-A', title: '取消的甲', summary: '', bodyMd: '甲原文', keep: false },
    { key: 'doc-B', title: '已保存乙', summary: '', bodyMd: '乙原文', keep: true },
  ], todos: [{ key: 'todo-A', text: '父项', due: null, keep: true, children: [{ key: 'child-A', text: '取消的子项', due: null, keep: false }] }] }));
  const proposed = draftFixture({ docs: [
    { key: 'doc-B', title: '模型想改已保存乙', summary: '', bodyMd: '乙被改写', keep: true },
    { key: 'doc-A', title: '甲修改', summary: '', bodyMd: '甲修改正文', keep: true },
    { key: 'model-invented', title: '新文档', summary: '', bodyMd: '新正文', keep: true },
  ], todos: [{ key: 'todo-A', text: '父项修改', due: null, keep: true, children: [
    { key: 'child-A', text: '取消的子项修改', due: null, keep: true },
    { key: 'model-child', text: '新增子项', due: null, keep: true },
  ] }] });
  const result = api.reconcileRevision(original, proposed, { documents: [{ key: 'doc-B', id: 9, name: '乙' }], todos: [] });
  assert.equal(result.draft.docs.find((d) => d.key === 'doc-A').keep, false);
  assert.equal(result.draft.docs.find((d) => d.key === 'doc-B').bodyMd, '乙原文');
  assert.equal(result.draft.docs.find((d) => d.title === '新文档').keep, false);
  assert.notEqual(result.draft.docs.find((d) => d.title === '新文档').key, 'model-invented');
  assert.equal(result.draft.todos[0].children.find((c) => c.key === 'child-A').keep, false);
  assert.equal(result.draft.todos[0].children.find((c) => c.text === '新增子项').keep, false);
  assert.equal(result.unreviewed, 2);
});

test('模型不回key且内容无法唯一匹配时，保留原条目并要求审阅新项', () => {
  const api = organizeModules();
  const original = api.ensureDraftIdentity(draftFixture({ docs: [
    { title: '同名', summary: '', bodyMd: '同文', keep: false },
    { title: '同名', summary: '', bodyMd: '同文', keep: true },
  ], todos: [] }));
  const result = api.reconcileRevision(original, draftFixture({ docs: [{ title: '同名', summary: '', bodyMd: '同文', keep: true }], todos: [] }));
  assert.equal(result.unreviewed, 1);
  assert.equal(result.retained, 2);
  assert.equal(result.draft.docs.length, 3);
  assert.equal(result.draft.docs[0].keep, false);
  for (const doc of original.docs) assert.equal(result.draft.docs.find((d) => d.key === doc.key).keep, doc.keep);
});

test('三批12篇全部保留可审阅，同标题不同正文不被全局上限吞掉', () => {
  const api = organizeModules();
  let draft = api.ensureDraftIdentity(draftFixture({ docs: [], todos: [] }));
  for (let batch = 0; batch < 3; batch++) {
    draft = api.appendDraftBatch(draft, draftFixture({ docs: Array.from({ length: 4 }, (_, i) => ({
      title: `主题-${i}`, summary: '', bodyMd: `第${batch}批的不同正文-${i}`, keep: true,
    })), todos: [] }));
  }
  assert.equal(draft.docs.length, 12);
  assert.equal(new Set(draft.docs.map((d) => d.key)).size, 12);
  assert.equal(api.selectDraftTargets(draft, { documents: [], todos: [] }, true, false).documentCount, 12);
});

test('批准计划使用稳定key与逐项选择，权限关闭即排除，已写父项只计新增子项', () => {
  const api = organizeModules();
  const draft = api.ensureDraftIdentity(draftFixture({ docs: [
    { key: 'doc-open', title: '允许', summary: '', bodyMd: '甲', keep: true },
    { key: 'doc-cancel', title: '取消', summary: '', bodyMd: '乙', keep: false },
    { key: 'doc-saved', title: '已写', summary: '', bodyMd: '丙', keep: true },
  ], todos: [{ key: 'parent-saved', text: '父项', due: null, keep: true, children: [
    { key: 'child-saved', text: '已写子项', due: null, keep: true },
    { key: 'child-new', text: '新子项', due: null, keep: true },
    { key: 'child-cancel', text: '取消子项', due: null, keep: false },
  ] }] }));
  const receipt = { documents: [{ key: 'doc-saved', id: 1, name: '已写' }], todos: [{ key: 'parent-saved', id: 2 }, { key: 'child-saved', id: 3 }] };
  for (const allowDoc of [false, true]) for (const allowTodos of [false, true]) {
    const targets = api.selectDraftTargets(draft, receipt, allowDoc, allowTodos);
    assert.equal(targets.documentCount, allowDoc ? 1 : 0);
    assert.equal(targets.todoCount, allowTodos ? 1 : 0);
    if (allowTodos) assert.deepEqual(plain(targets.todos[0].children.map((c) => c.key)), ['child-new']);
  }
  const only = api.selectDraftTargets(draft, receipt, true, true, 'doc-open');
  assert.deepEqual(plain(only.documents.map((d) => d.key)), ['doc-open']);
  assert.equal(only.todoCount, 0, '单篇加入不顺手提交待办');
});

test('恢复running工作区只转paused，不改draftId/来源/授权/原pending', () => {
  const api = organizeModules();
  const work = sessionWorkspace(api);
  work.draft = api.ensureDraftIdentity(draftFixture({ draftId: work.draft.draftId }));
  work.draft.docs[0].keep = false;
  work.allowTodos = false;
  work.phase = 'running';
  work.pending = { kind: 'session', turns: plain(work.request.source.turns) };
  work.steps = [{ text: '正在提炼', state: 'running' }];
  const recovered = api.decodeWorkspace(api.encodeWorkspace(work));
  assert.equal(recovered.phase, 'paused');
  assert.equal(recovered.draft.draftId, work.draft.draftId);
  assert.deepEqual(plain(recovered.request), plain(work.request));
  assert.deepEqual(plain(recovered.pending), plain(work.pending));
  assert.equal(recovered.draft.docs[0].keep, false);
  assert.equal(recovered.allowTodos, false);
  assert.equal(recovered.steps[0].state, 'fail');
});

test('损坏工作区/重复key拒绝恢复，不当作新草稿静默重建', () => {
  const api = organizeModules();
  assert.equal(api.decodeWorkspace(null), null);
  for (const raw of ['{broken', '{}', '{"version":99}']) assert.throws(() => api.decodeWorkspace(raw));
  const work = sessionWorkspace(api);
  work.draft = api.ensureDraftIdentity(draftFixture({ draftId: work.draft.draftId }));
  work.draft.todos[0].key = work.draft.docs[0].key;
  assert.throws(() => api.decodeWorkspace(JSON.stringify(work)));
});

test('工作区存储按调用时冻结快照串行保存，后改对象不能覆盖排队版本', async () => {
  const api = organizeModules();
  const work = sessionWorkspace(api);
  const gate = deferred();
  const writes = [];
  let stored = null;
  const store = api.createWorkspaceStore({
    getSetting: async () => stored,
    setSetting: async (key, value) => {
      assert.equal(key, api.WORKSPACE_KEY);
      writes.push(value);
      if (writes.length === 1) await gate.promise;
      stored = value;
    },
  });
  work.note = '版本甲';
  const first = store.save(work);
  work.note = '版本乙';
  const second = store.save(work);
  work.note = '未提交的版本丙';
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(writes.map((raw) => JSON.parse(raw).note), ['版本甲', '版本乙']);
  assert.equal((await store.load()).note, '版本乙');
});

test('保存失败不毒化工作区队列，load只读且不自动重发请求', async () => {
  const api = organizeModules();
  let stored = null;
  let writes = 0;
  let reads = 0;
  const store = api.createWorkspaceStore({
    getSetting: async () => { reads++; return stored; },
    setSetting: async (key, value) => { writes++; if (writes === 1) throw new Error('TEST_WORKSPACE_SAVE_FAILED'); stored = value; },
  });
  const work = sessionWorkspace(api);
  await assert.rejects(store.save(work), /TEST_WORKSPACE_SAVE_FAILED/);
  work.phase = 'running';
  await store.save(work);
  const before = writes;
  const loaded = await store.load();
  assert.equal(loaded.phase, 'paused');
  assert.equal(writes, before, 'load不得写库或触发执行器');
  assert.equal(reads, 1);
});

test('真实workspace生成的稳定key可通过共享校验并提交，不用手造key掩盖契约冲突', async () => {
  const api = organizeModules();
  const work = sessionWorkspace(api);
  work.draft = api.ensureDraftIdentity(draftFixture(), work.draft.draftId);
  const targets = api.selectDraftTargets(work.draft, work.receipt, true, true);
  const { contentFromText } = api.loader.load('src/documents/readers/chunk.ts');
  const input = {
    draftId: work.draft.draftId,
    documents: targets.documents.map((doc) => ({ key: doc.key, title: doc.title, excerpt: doc.summary, content: contentFromText(doc.bodyMd, 'markdown') })),
    todos: targets.todos.map((todo) => ({ key: todo.key, text: todo.text, dueAt: todo.due,
      children: todo.children.map((child) => ({ key: child.key, text: child.text, dueAt: child.due })) })),
    sourceIds: work.draft.sourceIds, sessionId: null,
  };
  const { validateDraftCommit } = api.loader.load('src/db/draftCommit.ts');
  assert.doesNotThrow(() => validateDraftCommit(input), '生产生成的key和生产校验器必须认可同一契约');
  const h = webRepo();
  const receipt = await h.repo.commitDraft(input);
  assert.deepEqual(plain(receipt.documents.map((entry) => entry.key)), plain(targets.documents.map((entry) => entry.key)));
  assert.equal(receipt.todos.length, targets.todoCount);
});

test('createWorkspace克隆来源/owner，外部数组再变化不改变已确认材料', () => {
  const api = organizeModules();
  const ids = [90, 3, 40];
  const sourceOwner = owner();
  const work = api.createWorkspace({ mode: 'knowledge', source: { kind: 'fragments', ids, all: true }, owner: sourceOwner, draftId: 'cloned-source' });
  ids.push(999);
  sourceOwner.turns[0].answer = '后来换掉的答案';
  assert.deepEqual(plain(work.request.source.ids), [90, 3, 40]);
  assert.equal(work.request.owner.turns[0].answer, '核对副本再恢复。');
});

/* ----- 提交后workspace落盘失败：恢复以事务凭据为准 ----- */
function commitInputOfWorkspace(api, work) {
  const targets = api.selectDraftTargets(work.draft, work.receipt, work.allowDoc, work.allowTodos);
  const { contentFromText } = api.loader.load('src/documents/readers/chunk.ts');
  return {
    draftId: work.draft.draftId,
    documents: targets.documents.map((doc) => ({ key: doc.key, title: doc.title, excerpt: doc.summary, content: contentFromText(doc.bodyMd, 'markdown') })),
    todos: targets.todos.map((todo) => ({ key: todo.key, text: todo.text, dueAt: todo.due,
      children: todo.children.map((child) => ({ key: child.key, text: child.text, dueAt: child.due })) })),
    sourceIds: work.draft.sourceIds, sessionId: work.request.owner.id,
  };
}

test('DB提交成功但workspace保存失败，重开以真实累计receipt认出已写条目', async () => {
  const api = organizeModules();
  const work = sessionWorkspace(api);
  work.draft = api.ensureDraftIdentity(draftFixture(), work.draft.draftId);
  const h = webRepo();
  let storedWorkspace = null;
  let failWorkspaceSave = false;
  let writes = 0;
  const settings = {
    getSetting: async (key) => key === api.WORKSPACE_KEY ? storedWorkspace : h.repo.getSetting(key),
    setSetting: async (key, value) => {
      assert.equal(key, api.WORKSPACE_KEY);
      writes++;
      if (failWorkspaceSave) throw new Error('TEST_WORKSPACE_AFTER_COMMIT_FAILED');
      storedWorkspace = value;
    },
  };
  const store = api.createWorkspaceStore(settings);
  await store.save(work);
  const input = commitInputOfWorkspace(api, work);
  const committed = await h.repo.commitDraft(input);
  failWorkspaceSave = true;
  await assert.rejects(store.save({ ...work, receipt: committed }), /TEST_WORKSPACE_AFTER_COMMIT_FAILED/);
  const reopened = await store.load();
  assert.equal(reopened.receipt.documents.length, 0, 'fixture必须确实是未保存receipt的旧工作区');
  const beforeRead = writes;
  const recovered = await api.readCommittedWorkspace(reopened, settings);
  assert.equal(writes, beforeRead, '读取/核对凭据不能自动清空或改写workspace');
  assert.deepEqual(plain(recovered.receipt), plain(committed));
  assert.equal(recovered.draft.draftId, work.draft.draftId);
  const pending = api.selectDraftTargets(recovered.draft, recovered.receipt, true, true);
  assert.equal(pending.documentCount, 0);
  assert.equal(pending.todoCount, 0, '恢复后不能仍把已提交的父子待办标成待写入');
  let controllerRecovery;
  let controllerLoaded = false;
  let controllerError = null;
  const { reloadRecovery } = api.loader.extract('src/organize/useOrganize.ts', ['reloadRecovery'], {
    useCallback: (fn) => fn, store, repo: settings, readCommittedWorkspace: api.readCommittedWorkspace,
    alive: { current: true }, rememberRecovery: (next) => { controllerRecovery = next; },
    setStorageError: (error) => { controllerError = error; }, setLoaded: (loaded) => { controllerLoaded = loaded; },
  }, { scope: 'useOrganize' });
  await reloadRecovery();
  assert.equal(controllerError, null);
  assert.equal(controllerLoaded, true);
  assert.deepEqual(plain(controllerRecovery.receipt), plain(committed), '真实恢复入口必须接上事务凭据核对');
  await h.repo.commitDraft(input);
  assert.equal((await h.repo.listDocuments()).length, 1);
  assert.equal((await h.repo.listTodos()).length, 2);
});

test('恢复遇坏receipt、缺本地已写key、冲突id或未知key时停止，保留原工作区', async () => {
  const api = organizeModules();
  const work = sessionWorkspace(api);
  work.draft = api.ensureDraftIdentity(draftFixture(), work.draft.draftId);
  const key = work.draft.docs[0].key;
  const localSaved = plain(work);
  localSaved.receipt = { documents: [{ key, id: 9, name: '文档甲' }], todos: [] };
  const rawReceipt = (documents) => JSON.stringify({ version: 1, documents, todos: [] });
  const cases = [
    { local: work, raw: '{broken' },
    { local: localSaved, raw: null },
    { local: localSaved, raw: rawReceipt([{ key, id: 10, name: '不同id' }]) },
    { local: work, raw: rawReceipt([{ key: 'unknown-local-doc', id: 9, name: '其它草稿项' }]) },
    { local: work, raw: rawReceipt([{ key, id: 9, name: '文档甲' }, { key, id: 10, name: '重复key' }]) },
  ];
  for (const entry of cases) {
    const before = JSON.stringify(entry.local);
    let writes = 0;
    const settings = {
      getSetting: async (requested) => { assert.equal(requested, `draft.commit.${work.draft.draftId}`); return entry.raw; },
      setSetting: async () => { writes++; },
    };
    await assert.rejects(api.readCommittedWorkspace(entry.local, settings));
    assert.equal(writes, 0);
    assert.equal(JSON.stringify(entry.local), before, '失败不能篡改或清空本地已知凭据');
  }
});

/* ----- 多图OCR暂停：实际readPendingImages，文件/模型/写库仅注入桩 ----- */
function imageReadHarness(overrides = {}) {
  const calls = { files: [], model: [], writes: [], steps: [] };
  const loader = createLoader({
    stubs: {
      '../db/repo': { repo: { setFragmentImageText: async (id, text) => { calls.writes.push({ id, text }); } } },
      '../db/fragmentImages': { readImageBase64: async (file) => {
        calls.files.push(file);
        return overrides.read ? overrides.read(file) : `fixture-base64:${file}`;
      } },
      './vision': { describeImage: async (input) => {
        calls.model.push(plain(input));
        return overrides.describe ? overrides.describe(input) : 'fixture OCR文字';
      } },
    },
  });
  return { ...loader.load('src/ai/imageReads.ts'), calls };
}

test('OCR首图请求已发后暂停：迟到文本不写库/内存，第二张不读取或发送', async () => {
  const gate = deferred();
  const entered = deferred();
  const h = imageReadHarness({ describe: async () => { entered.resolve(); return gate.promise; } });
  const fragments = [fragment(1, '原记录', { images: [image(11), image(12)] })];
  let current = true;
  const running = h.readPendingImages({ fragments, config: { apiKey: 'TEST_ONLY' }, shouldContinue: () => current,
    onStep: (step) => h.calls.steps.push(step) });
  await entered.promise;
  current = false;
  gate.resolve('暂停之后才返回的OCR');
  const result = await running;
  assert.equal(h.calls.model.length, 1, '第二张不得在暂停后发起');
  assert.equal(h.calls.files.length, 1);
  assert.equal(h.calls.writes.length, 0, '第一张迟到结果不能写入');
  assert.deepEqual(fragments[0].images.map((img) => img.text), [null, null]);
  assert.equal(result.read, 0);
  assert.equal(result.failed, 0, '用户暂停不是图片识别失败');
});

test('OCR读取文件期间暂停：文件读完后也不能再发模型请求', async () => {
  const gate = deferred();
  const entered = deferred();
  const h = imageReadHarness({ read: async () => { entered.resolve(); return gate.promise; } });
  let current = true;
  const fragments = [fragment(1, '', { images: [image(11), image(12)] })];
  const running = h.readPendingImages({ fragments, config: { apiKey: 'TEST_ONLY' }, shouldContinue: () => current });
  await entered.promise;
  current = false;
  gate.resolve('file-finished-after-pause');
  await running;
  assert.equal(h.calls.files.length, 1);
  assert.equal(h.calls.model.length, 0);
  assert.equal(h.calls.writes.length, 0);
  assert.deepEqual(fragments[0].images.map((img) => img.text), [null, null]);
});

test('未传OCR暂停判据的旧QA调用保持兼容，跳过已读图且同时写库/内存', async () => {
  const h = imageReadHarness();
  const fragments = [fragment(1, '原文', { images: [image(11), image(12, ''), image(13, '之前的OCR'), image(14)] })];
  const result = await h.readPendingImages({ fragments, config: { apiKey: 'TEST_ONLY' } });
  assert.equal(result.read, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.rest, 0);
  assert.deepEqual(h.calls.writes.map((entry) => entry.id), [11, 14]);
  assert.equal(h.calls.model.length, 2);
  assert.deepEqual(fragments[0].images.map((img) => img.text), ['fixture OCR文字', '', '之前的OCR', 'fixture OCR文字']);
});

test('真实整理控制器向OCR传递动态代次判据，暂停后立即失效', async () => {
  const api = organizeModules();
  const generation = { current: 0 };
  const decisions = [];
  const errors = [];
  const bindings = {
    generation, lock: { current: false }, progress: { current: 0 },
    current: (gen) => generation.current === gen,
    setBusy: noop, setReceived: noop, setElapsed: noop, setReasoning: noop,
    setError: (error) => { if (error) errors.push(error); },
    latest: { current: { getSessionGeneration: () => 1, onSaved: async () => {}, showToast: noop } },
    repo: { listFragmentsByIds: async () => [] }, loadTodos: async () => [],
    loadAiConfig: async () => ({ apiKey: 'TEST_ONLY' }), persist: async () => {}, publish: noop,
    extractKnowledge: async () => { throw new Error('本接线用例不应发送提炼请求'); },
    readPendingImages: async (input) => {
      assert.equal(typeof input.shouldContinue, 'function', '控制器必须把动态停止判据交给OCR，而非只在整批结束检查');
      decisions.push(input.shouldContinue());
      generation.current++;
      decisions.push(input.shouldContinue());
      return { read: 0, failed: 0, rest: 2, firstError: null };
    },
    executeOrganize: async (work, deps) => {
      await deps.readImages([fragment(1, '', { images: [image(11), image(12)] })], 2);
      return work;
    },
    recordHistory: async (work) => work,
    errorDetailOf: (error) => ({ message: error.message }),
  };
  const { run } = api.loader.extract('src/organize/useOrganize.ts', ['run'], bindings, { scope: 'useOrganize' });
  await run(sessionWorkspace(api));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.deepEqual(decisions, [true, false]);
});

/* ----- 阅读与检索不是同一个能力：真实纯分派/可见命中模块 ----- */
test('stored/failed或旧索引PDF仍可读原件，但不能冒称已可问', () => {
  const loader = createLoader();
  const { documentReadMode } = loader.load('src/documents/readers/readerAvailability.ts');
  const { isDocumentReady } = loader.load('src/documents/formats.ts');
  for (const state of ['stored', 'failed', 'done']) {
    const doc = { fileUri: 'memory://original.pdf', ext: 'pdf', bodyMd: '', state,
      contentRevision: 2, indexedRevision: 1, charCount: 20, chunkCount: 1 };
    assert.equal(documentReadMode(doc, null), 'original');
    assert.equal(isDocumentReady(doc), false);
  }
});

test('原件格式/容量不支持时仅有合法正文才能降级快照，不能把空页当可读', () => {
  const loader = createLoader();
  const { documentReadMode } = loader.load('src/documents/readers/readerAvailability.ts');
  const { LOCAL_READER_LIMITS } = loader.load('src/documents/formats.ts');
  assert.equal(documentReadMode({ fileUri: 'memory://a.docx', ext: 'docx', bodyMd: '' }, null), 'unavailable');
  assert.equal(documentReadMode({ fileUri: 'memory://a.docx', ext: 'docx', bodyMd: '已有正文' }, null), 'snapshot');
  assert.equal(documentReadMode({ fileUri: 'memory://big.pdf', ext: 'pdf', bodyMd: '已有正文' }, '原件超限'), 'snapshot');
  assert.equal(documentReadMode({ fileUri: 'memory://big.pdf', ext: 'pdf', bodyMd: '' }, '原件超限'), 'unavailable');
  assert.equal(documentReadMode({ fileUri: null, ext: 'md', bodyMd: 'a'.repeat(LOCAL_READER_LIMITS.bodyChars + 1) }, null), 'unavailable');
});

test('Markdown命中只数可见文字，不把图片id/引用徽标当正文；字面文档引用保留', () => {
  const api = createLoader().load('src/documents/readers/markdownSearch.ts');
  assert.equal(api.markdownHitBlocks('正文 [F12]', 'F12').length, 0);
  assert.equal(api.markdownHitBlocks('正文 [F12]', 'F12', true).length, 1);
  assert.equal(api.markdownHitBlocks('![](img:123)', '123').length, 0);
  assert.equal(api.markdownHitBlocks('`[F12]`\n\n```txt\n[F12]\n```', 'F12').length, 2, '代码里的字面标记不能被吞');
});

test('Markdown表格/强调/代码命中落到真实块，空查询与limit不伪报', () => {
  const loader = createLoader();
  const api = loader.load('src/documents/readers/markdownSearch.ts');
  const { parseBlocks } = loader.load('src/util/mdBlocks.ts');
  const body = '# 甲\n\n**甲**正文\n\n| 列 | 值 |\n|---|---|\n| 甲 | 甲 |\n\n```txt\n甲\n```';
  const blocks = parseBlocks(body);
  const hits = api.markdownHitBlocks(body, '甲');
  assert.equal(hits.length, 5);
  for (const index of hits) assert.ok(api.blockHitCount(blocks[index], '甲') > 0);
  assert.equal(api.markdownHitBlocks(body, '甲', false, 2).length, 2);
  assert.equal(api.markdownHitBlocks(body, '  ').length, 0);
});

test('碎片详情可见命中按OCR→正文→事项定位，旧标签/图片id不制造命中', () => {
  const { fragmentReaderHits } = createLoader().load('src/documents/readers/fragmentSearch.ts');
  const f = fragment(1, '# 正文命中\n\n正文再次命中 [F12]\n![](img:11)', {
    images: [image(11, 'OCR命中 [F12]'), image(12, null), image(13, '另一张OCR命中')],
    project: '事项命中', tags: ['legacyneedle'],
  });
  /*
   * 正文里的块序号从 v0.27 起把**空行**也算进去（它现在是一个空段落），
   * 所以「正文再次命中」从 1 变成 2、图片块也跟着后移。
   * 序号两边（命中定位 / 渲染测量）都来自同一次 `parseBlocks`，不会错位。
   */
  assert.deepEqual(plain(fragmentReaderHits(f, '命中')), [
    { section: 'image:11', blockKey: 'image:11:0', localIndex: 0 },
    { section: 'image:13', blockKey: 'image:13:0', localIndex: 0 },
    { section: 'body', blockKey: 'body:0', localIndex: 0 },
    { section: 'body', blockKey: 'body:2', localIndex: 1 },
    { section: 'project', blockKey: 'project:0', localIndex: 0 },
  ]);
  assert.deepEqual(plain(fragmentReaderHits(f, 'F12')).map((hit) => hit.section), ['image:11'], 'OCR按字面读取引用标记，正文仍按引用徽标规则');
  assert.equal(fragmentReaderHits(f, 'legacyneedle').length, 0);
  assert.equal(fragmentReaderHits(f, '11').length, 0, '内部图片id不是可见正文');
  assert.equal(fragmentReaderHits(f, '命中', 3).length, 3);
  assert.equal(fragmentReaderHits(f, '   ').length, 0);
});

/* ----- 真实页面/控制器声明接线，仍然不用React Native运行时 ----- */
test('真实Ask.startDraft→控制器start/run→执行器，历史入口确实使用session提炼', async () => {
  const api = organizeModules();
  const generation = { current: 0 };
  const workRef = { current: null };
  const requests = [];
  const errors = [];
  const recorded = [];
  const snapshots = [];
  const restoredOwners = [];
  const bindings = {
    lock: { current: false }, workRef, recoveryRef: { current: null }, generation,
    progress: { current: 0 }, loaded: true, storageError: null,
    current: (gen) => generation.current === gen,
    setBusy: noop, setReceived: noop, setElapsed: noop, setReasoning: noop,
    setError: (error) => { if (error) errors.push(error); },
    publish: (work) => { workRef.current = work; },
    persist: async (work) => { snapshots.push(api.encodeWorkspace(work)); },
    latest: { current: {
      context: null, scope: { kind: 'records' }, getOwner: () => owner(), getSessionGeneration: () => 1,
      onRestoreOwner: (restored) => { restoredOwners.push(plain(restored)); },
      onSaved: async () => {}, onHistoryChanged: async () => {}, showToast: noop,
    } },
    repo: {
      listTodos: async () => [],
      listAllFragments: async () => { throw new Error('历史入口不能换成全库碎片'); },
      listFragmentsByIds: async () => { throw new Error('历史入口不能改读其它来源'); },
    },
    createWorkspace: api.createWorkspace, ownerOfSession: api.ownerOfSession, executeOrganize: api.executeOrganize,
    wantsAll: api.loader.load('src/util/askIntent.ts').wantsAll,
    hasReadableText: api.loader.load('src/util/fragmentText.ts').hasReadableText,
    loadAiConfig: async () => ({ apiKey: 'TEST_ONLY', model: 'stub' }),
    extractKnowledge: async (request) => { requests.push(plain(request)); return outcome(); },
    readPendingImages: async () => { throw new Error('纯历史整理不应触发读图'); },
    recordHistory: async (work) => { recorded.push(plain(work)); return work; },
    errorDetailOf: (error) => ({ message: error.message }),
    revise: async () => { throw new Error('这个用例不是改稿重试'); },
  };
  const control = api.loader.extract('src/organize/useOrganize.ts', ['loadTodos', 'run', 'start', 'retry'], bindings, { scope: 'useOrganize' });
  const { startDraft } = api.loader.extract('src/screens/AskScreen.tsx', ['startDraft'], { busy: false, setInput: noop, setEditing: noop, organize: control }, { scope: 'AskScreen' });
  const session = sessionFixture({ turns: owner().turns });
  await startDraft('knowledge', { session, turns: session.turns, instruction: '只保留恢复顺序' });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(requests.length, 1, '实际页面入口必须触发一次真实控制器提炼调用');
  assert.equal(requests[0].source.kind, 'session');
  assert.deepEqual(requests[0].source.turns, session.turns);
  assert.equal(requests[0].source.title, session.title);
  assert.equal(requests[0].instruction, '只保留恢复顺序');
  assert.equal(workRef.current.request.owner.id, session.id);
  assert.equal(restoredOwners.length, 1);
  assert.equal(restoredOwners[0].id, session.id);
  assert.equal(restoredOwners[0].title, session.title);
  assert.deepEqual(restoredOwners[0].turns, session.turns);
  assert.equal(recorded.length, 1);
  assert.ok(snapshots.length >= 2, '调用前的来源和生成后的草稿均要保存');
});

test('App生命周期唯一的p数字key，不按当前附件长度或页面重挂复用', () => {
  const loader = createLoader();
  const pendingImageSequence = { current: 0 };
  const bindings = { pendingImageSequence, useCallback: (fn) => fn };
  const first = loader.extract('App.tsx', ['nextImageKey'], bindings, { scope: 'Shell' }).nextImageKey;
  const keys = Array.from({ length: 20 }, () => first());
  // 同一App生命周期里的另一次闭包构造，仍持有原ref；清空附件列表也不重置它。
  const later = loader.extract('App.tsx', ['nextImageKey'], bindings, { scope: 'Shell' }).nextImageKey;
  keys.push(later());
  assert.equal(new Set(keys).size, 21);
  assert.ok(keys.every((key) => /^p[1-9]\d*$/.test(key)));
  assert.notEqual(keys.at(-1), keys[0]);
});

test('附件state/key由App外置并接给Timeline，页面不再另建pending数组', () => {
  const app = parseSource('App.tsx');
  const timeline = parseSource('src/screens/TimelineScreen.tsx');
  const pendingStates = (source) => {
    const nodes = [];
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) &&
          node.name.elements.some((entry) => ts.isBindingElement(entry) && entry.name.getText(source) === 'pendingImages') &&
          node.initializer && ts.isCallExpression(node.initializer) && /(?:^|\.)useState$/.test(node.initializer.expression.getText(source))) nodes.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return nodes;
  };
  assert.equal(pendingStates(app).length, 1);
  assert.equal(pendingStates(timeline).length, 0, '跨页附件不能藏回会卸载的Timeline useState');
  const slots = [];
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === 'TimelineScreen') slots.push(node);
    ts.forEachChild(node, visit);
  };
  visit(app);
  assert.equal(slots.length, 1);
  const props = slots[0].attributes.properties.filter(ts.isJsxAttribute).map((attr) => attr.name.getText(app));
  for (const name of ['draft', 'onDraftChange', 'pendingImages', 'onPendingImagesChange', 'nextImageKey']) assert.ok(props.includes(name), `缺少${name}真实接线`);
});

function preferenceHarness(setSetting) {
  const preferenceQueue = { current: Promise.resolve() };
  const preferenceVersions = { current: {} };
  let errors = {};
  let mode = 'system';
  let style = 'default';
  const bindings = {
    // v0.26 起字号也是一条外观偏好（它有自己的保存失败提示）
    K_THEME: 'ui_theme', K_TYPE_SCALE: 'ui_type_scale',
    useCallback: (fn) => fn, preferenceQueue, preferenceVersions,
    repo: { setSetting },
    setPreferenceErrors: (value) => { errors = typeof value === 'function' ? value(errors) : value; },
    setMode: (value) => { mode = value; }, setStyle: (value) => { style = value; },
  };
  const loader = createLoader();
  return {
    ...loader.extract('App.tsx', ['persistPreference', 'changeMode', 'changeStyle'], bindings, { scope: 'App' }),
    queue: preferenceQueue, errors: () => plain(errors), state: () => ({ mode, style }),
  };
}

test('App连续切换两轴即时生效，持久化串行且最终选择获胜', async () => {
  const gate = deferred();
  const started = deferred();
  const writes = [];
  const stored = new Map();
  const h = preferenceHarness(async (key, value) => {
    writes.push([key, value]);
    if (writes.length === 1) { started.resolve(); await gate.promise; }
    stored.set(key, value);
  });
  h.changeStyle('ink'); h.changeMode('dark'); h.changeStyle('default'); h.changeMode('light');
  assert.deepEqual(h.state(), { mode: 'light', style: 'default' });
  await started.promise;
  assert.equal(writes.length, 1, '不能并发落盘让早请求覆盖晚选择');
  gate.resolve();
  await h.queue.current;
  assert.equal(stored.get('ui_theme'), 'light');
  assert.equal(stored.get('ui_style'), 'default');
  assert.deepEqual(h.errors(), {});
});

test('App外观某轴保存失败不被另一轴成功掩盖，重试不会毒化队列', async () => {
  let failure = true;
  const h = preferenceHarness(async (key) => {
    if (key === 'ui_style' && failure) { failure = false; throw new Error('TEST_STYLE_SAVE_FAILED'); }
  });
  h.changeStyle('ink'); h.changeMode('dark');
  await h.queue.current;
  assert.ok(h.errors().ui_style, '风格失败不能被明暗成功清除');
  assert.equal(h.errors().ui_theme, undefined);
  assert.deepEqual(h.state(), { mode: 'dark', style: 'ink' }, '存储失败不撤销本次已应用外观');
  h.changeStyle('default');
  await h.queue.current;
  assert.deepEqual(h.errors(), {});
});

/* ----- 取消写入授权不是授权丢弃：新任务必须保护整个工作区 ----- */
function finishedDraftWork(api, draft = draftFixture()) {
  const work = sessionWorkspace(api);
  work.draft = api.ensureDraftIdentity(draft, work.draft.draftId);
  work.sessionProcessed = true;
  work.phase = 'complete';
  return work;
}

function pendingOnlyWork(api, kind) {
  if (kind === 'remaining') {
    return api.createWorkspace({ mode: 'knowledge', source: { kind: 'fragments', ids: [17, 2], all: true }, owner: owner(), draftId: 'remaining-without-output' });
  }
  const work = finishedDraftWork(api, draftFixture({ docs: [], todos: [] }));
  if (kind === 'pending') {
    work.sessionProcessed = false;
    work.pending = { kind: 'session', turns: plain(work.request.source.turns) };
    work.phase = 'paused';
  } else {
    work.pendingRevision = { instruction: '继续处理原改稿', material: '原始材料', history: [], base: plain(work.draft), existingTodos: [] };
    work.phase = 'failed';
  }
  return work;
}

test('新任务保护：权限全关仍有未保存内容，只有真实全部提交且无余料才可替换', async () => {
  const api = organizeModules();
  const work = finishedDraftWork(api);
  const previouslyApproved = commitInputOfWorkspace(api, work); // 模拟关闭权限之前已明确批准的同一批内容
  work.allowDoc = false;
  work.allowTodos = false;
  assert.equal(api.hasUnfinishedWork(work), false, '隔离余料因素，不能靠未处理来源偶然挡住');
  const targets = api.selectDraftTargets(work.draft, work.receipt, work.allowDoc, work.allowTodos);
  assert.equal(targets.documentCount + targets.todoCount, 0);
  assert.equal(api.hasUnsavedWorkspace(work), true, '不可写不等于无内容可丢失');
  const receipt = await webRepo().repo.commitDraft(previouslyApproved);
  assert.equal(api.hasUnsavedWorkspace({ ...work, receipt }), false, '真实receipt覆盖全部条目且无余料后才可无损替换');
});

test('新任务保护：取消勾选的文档/父待办/未写子项都不是自动丢弃许可', () => {
  const api = organizeModules();
  const variants = [
    draftFixture({ docs: [{ title: '取消的文档', summary: '', bodyMd: '未保存正文', keep: false }], todos: [] }),
    draftFixture({ docs: [{ title: '只有标题也要保护', summary: '', bodyMd: '', keep: false }], todos: [] }),
    draftFixture({ docs: [{ title: '', summary: '只写了摘要', bodyMd: '', keep: false }], todos: [] }),
    draftFixture({ docs: [], todos: [{ text: '取消的父待办', due: null, keep: false, children: [] }] }),
    draftFixture({ docs: [], todos: [{ text: '已经写入的父项', due: null, keep: false,
      children: [{ text: '未写入但取消勾选的子项', due: null, keep: false }] }] }),
  ];
  for (const [index, draft] of variants.entries()) {
    const work = finishedDraftWork(api, draft);
    if (index === variants.length - 1) work.receipt.todos.push({ key: work.draft.todos[0].key, id: 100 });
    assert.equal(api.hasUnfinishedWork(work), false);
    const targets = api.selectDraftTargets(work.draft, work.receipt, true, true);
    assert.equal(targets.documentCount + targets.todoCount, 0);
    assert.equal(api.hasUnsavedWorkspace(work), true, `取消选择场景${index + 1}仍须保护原内容`);
  }
});

test('新任务保护：暂无产出但有余料/pending/待改稿，不能无确认覆盖', () => {
  const api = organizeModules();
  for (const kind of ['remaining', 'pending', 'revision']) {
    const work = pendingOnlyWork(api, kind);
    assert.equal(work.draft.docs.length + work.draft.todos.length, 0);
    const targets = api.selectDraftTargets(work.draft, work.receipt, true, true);
    assert.equal(targets.documentCount + targets.todoCount, 0);
    assert.equal(api.hasUnsavedWorkspace(work), true, `${kind}仍有待处理工作`);
  }
  assert.equal(api.hasUnsavedWorkspace(finishedDraftWork(api, draftFixture({ docs: [], todos: [] }))), false);
});

test('真实Ask.send用工作区保护判据：保留输入、禁止discard/start/revise；全写完才新建', async () => {
  const api = organizeModules();
  const intent = api.loader.load('src/util/askIntent.ts');
  const question = '再整理一下待办';
  async function execute(work) {
    let input = question;
    const calls = { discarded: 0, started: [], revised: [], toasts: [], inputChanges: [], errors: [] };
    const discard = async () => { calls.discarded++; return true; };
    const start = async (mode, options) => { calls.started.push({ mode, options: plain(options) }); };
    const bindings = {
      input, busy: false, scopeProblem: null, draft: work.draft,
      organize: { workspace: work, isLocked: () => false, discard, start },
      allowDoc: work.allowDoc, allowTodos: work.allowTodos,
      // v0.33：send 多了「正在改某一轮」和「去问模型」两条出口。
      // 这个用例只关心草稿保护判据，所以两条都走不到（editing 为空、意图也不是问答）。
      editing: null,
      runQuestion: async () => { throw new Error('这个用例不该走到问答'); },
      hasUnsavedWorkspace: api.hasUnsavedWorkspace,
      // 即使误退回旧的可写计划逻辑，也应以“发生了discard”失败，而不是因缺桩失败。
      selectDraftTargets: api.selectDraftTargets,
      planDraftInput: intent.planDraftInput, routeAsk: intent.routeAsk,
      showToast: (text) => calls.toasts.push(text),
      discardDraft: discard, startDraft: start,
      reviseCurrent: async (text) => { calls.revised.push(text); },
      setInput: (value) => { calls.inputChanges.push(value); input = value; },
      setError: (error) => { calls.errors.push(error); },
    };
    const { send } = api.loader.extract('src/screens/AskScreen.tsx', ['send'], bindings, { scope: 'AskScreen' });
    await send();
    return { calls, input };
  }
  const permissionsOff = finishedDraftWork(api);
  permissionsOff.allowDoc = false; permissionsOff.allowTodos = false;
  const unchecked = finishedDraftWork(api);
  for (const doc of unchecked.draft.docs) doc.keep = false;
  for (const todo of unchecked.draft.todos) { todo.keep = false; for (const child of todo.children) child.keep = false; }
  const protectedWorks = [permissionsOff, unchecked, ...['remaining', 'pending', 'revision'].map((kind) => pendingOnlyWork(api, kind))];
  for (const work of protectedWorks) {
    const before = JSON.stringify(work);
    const { calls, input } = await execute(work);
    assert.equal(calls.discarded, 0, '不能无确认丢弃未保存工作区');
    assert.equal(calls.started.length, 0);
    assert.equal(calls.revised.length, 0);
    assert.equal(calls.errors.length, 0);
    assert.equal(calls.inputChanges.length, 0, '阻止新任务时保留用户刚输入的要求');
    assert.equal(input, question);
    assert.ok(calls.toasts.some((text) => /放弃|丢弃/.test(text)), '必须告诉用户需明确处理/放弃，而非静默吞输入');
    assert.equal(JSON.stringify(work), before);
  }
  const saved = finishedDraftWork(api);
  saved.receipt = await webRepo().repo.commitDraft(commitInputOfWorkspace(api, saved));
  const safe = await execute(saved);
  assert.equal(safe.calls.discarded, 1);
  assert.deepEqual(safe.calls.started, [{ mode: 'todos', options: { instruction: question } }]);
  assert.equal(safe.calls.revised.length, 0);
});

if (require.main === module) {
  suite.run().then(({ failed }) => { process.exitCode = failed ? 1 : 0; }).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
module.exports = { run: suite.run };
