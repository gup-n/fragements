#!/usr/bin/env node
/**
 * 文档任务服务的断言。**纯 Node，不跑 RN 运行时、不联网、不碰真实文件。**
 *
 * 为什么不是「另写一份等价逻辑再断言」：那样只能证明脚本自己是对的。
 * 这里把 `src/documents/jobs.ts` 和 `src/db/docFiles.ts` 的真源码用 TypeScript
 * 转成 CommonJS 再执行，只把它们的依赖（repo、MinerU、文件系统）换成桩。
 * 断言打的是真实实现。
 *
 * 覆盖：
 * 1. 同 id 连起两次只跑一次（v0.11.0 的真实缺陷：两个页面各起一个任务）
 * 2. 取消之后旧任务的结果被 runId 丢掉，新任务的结果才写库
 * 3. 版本对不上时结果作废，不覆盖别人的正文
 * 4. 取消后不再写库，且把状态还原成任务前的样子
 * 5. 本地准备全程零 fetch
 * 6. 导入只保存原件：同名加后缀不覆盖、入库大小用副本真实大小、没有网络调用
 * 7. 启动恢复：parsing 但没有任务的记录标成失败，不自动重发
 *
 * 用法：node scripts/assert_document_jobs.cjs   （退出码非 0 表示失败）
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/* ------------------------------------------------------------------ *
 * 极简断言
 * ------------------------------------------------------------------ */

let failures = 0;
let passed = 0;

function ok(cond, message) {
  if (!cond) throw new Error(message);
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e && e.message ? e.message : e}`);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/* ------------------------------------------------------------------ *
 * TypeScript 内存加载器
 * ------------------------------------------------------------------ */

function resolveTs(base) {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* 继续试下一个 */
    }
  }
  return null;
}

/**
 * 编译一个 .ts 文件并执行，`../db/repo` 这类依赖由 stubMap 按**原样写法的
 * 模块名**替换。没在 stubMap 里的相对依赖继续递归加载（formats.ts 就是这样）。
 */
function compileModule(file, stubMap) {
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;

  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  const nodeRequire = mod.require.bind(mod);
  mod.require = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubMap, id)) return stubMap[id];
    if (id.startsWith('./') || id.startsWith('../')) {
      const resolved = resolveTs(path.resolve(path.dirname(file), id));
      if (resolved) return compileModule(resolved, stubMap);
    }
    return nodeRequire(id);
  };
  mod._compile(js, file);
  return mod.exports;
}

/* ------------------------------------------------------------------ *
 * 桩
 * ------------------------------------------------------------------ */

function makeRepo(initialDocs) {
  const docs = new Map();
  for (const d of initialDocs) docs.set(d.id, { ...d });

  const calls = { replace: [], update: [], list: 0, delete: [] };

  return {
    docs,
    calls,
    async findDocument(id) {
      const d = docs.get(id);
      return d ? { ...d } : null;
    },
    async listDocuments() {
      calls.list += 1;
      return [...docs.values()].map((d) => ({ ...d }));
    },
    async updateDocument(id, patch) {
      calls.update.push({ id, patch });
      const d = docs.get(id);
      if (d) Object.assign(d, patch);
    },
    async replaceDocumentContent(id, content, expectedRevision) {
      calls.replace.push({ id, content, expectedRevision });
      const d = docs.get(id);
      if (!d || d.contentRevision !== expectedRevision) return false;
      d.bodyMd = content.bodyMd;
      d.charCount = content.bodyMd.length;
      d.contentRevision = expectedRevision + 1;
      d.indexedRevision = expectedRevision + 1;
      d.chunkCount = content.chunks.length;
      d.contentSource = content.source;
      d.pages = content.pages;
      d.state = 'done';
      d.error = null;
      return true;
    },
    async deleteDocument(id) {
      calls.delete.push(id);
      docs.delete(id);
    },
  };
}

function makeMineruStub() {
  class MineruError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'MineruError';
      this.code = code;
    }
  }
  return {
    MineruError,
    isCancelled: (e) => e instanceof MineruError && e.code === 'cancelled',
    mineruMessage: (e) => (e instanceof Error ? e.message : '解析失败，请稍后重试'),
    getMineruToken: async () => 'token-abc',
    stageText: (s) => `正在${s}`,
  };
}

/**
 * 阅读器桩：jobs 只依赖 `extractLocalDocument` 与 `contentFromText` 两个入口。
 * 切片形状按真实契约给（正文 + 位置），这样写库那条路径走的是真逻辑。
 */
function chunkContent(text, source = 'text') {
  return {
    bodyMd: text,
    chunks: text ? [{ text, locator: { kind: 'text', lineStart: 1, lineEnd: 1 } }] : [],
    source,
    pages: null,
  };
}

const chunkStub = { contentFromText: (text, source) => chunkContent(text, source) };

function makeDocSupportStub(state) {
  return {
    parseDocFile: async (...args) => {
      state.parseCalls.push(args);
      return state.parseImpl ? state.parseImpl(...args) : 'parsed markdown';
    },
  };
}

/**
 * 载入一份干净的 jobs 模块。每个用例一份 —— 任务表是模块级状态，
 * 复用会让上一个用例的 runId 混进来。
 */

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

function makeDoc(over) {
  return {
    id: 1,
    name: '笔记.txt',
    ext: 'txt',
    size: 12,
    fileUri: 'file:///private/notes.txt',
    pages: null,
    charCount: 0,
    state: 'stored',
    error: null,
    contentRevision: 0,
    indexedRevision: 0,
    chunkCount: 0,
    contentSource: null,
    createdAt: 1000,
    updatedAt: 1000,
    bodyMd: '',
    ...over,
  };
}

async function main() {
  console.log('assert_document_jobs');

  /* 1. 单文档互斥 ---------------------------------------------------- */
  await test('同一篇文档连起两次只跑一次', async () => {
    const gate = deferred();
    const repo = makeRepo([makeDoc({ id: 1 })]);
    const jobs = compileModule(path.join(SRC, 'documents', 'jobs.ts'), {
      '../db/repo': { repo },
      './readers': {
        extractLocalDocument: async () => {
          await gate.promise;
          return chunkContent('本地正文');
        },
        contentFromText: chunkStub.contentFromText,
      },
      '../ai/mineru': makeMineruStub(),
      '../util/docSupport': makeDocSupportStub({ parseCalls: [] }),
    });

    const p1 = jobs.prepareDocumentLocal(1);
    const p2 = jobs.prepareDocumentLocal(1);
    eq(p1 === p2, true, '第二次点击必须复用同一个 Promise');

    await tick();
    eq(jobs.getDocumentJob(1).phase, 'local', '任务应当已经在跑');

    gate.resolve();
    await p1;

    eq(repo.calls.replace.length, 1, '只能写一次库');
    eq(jobs.getDocumentJob(1).phase, 'done', '任务应当完成');
    eq(repo.docs.get(1).state, 'done', '文档状态应当变成可问');
  });

  /* 2. 取消后旧任务的结果被丢弃 -------------------------------------- */
  await test('取消后旧任务的结果不写库，新任务的结果才生效', async () => {
    const gates = [];
    const repo = makeRepo([makeDoc({ id: 2 })]);
    const jobs = compileModule(path.join(SRC, 'documents', 'jobs.ts'), {
      '../db/repo': { repo },
      './readers': {
        extractLocalDocument: async () => {
          const g = deferred();
          gates.push(g);
          await g.promise;
          return chunkContent(gates.length === 1 ? '旧结果' : '新结果');
        },
        contentFromText: chunkStub.contentFromText,
      },
      '../ai/mineru': makeMineruStub(),
      '../util/docSupport': makeDocSupportStub({ parseCalls: [] }),
    });

    const p1 = jobs.prepareDocumentLocal(2);
    await tick();
    eq(gates.length, 1, '第一次任务应当开始提取');

    jobs.cancelDocumentJob(2);
    eq(jobs.getDocumentJob(2).phase, 'cancelled', '取消后立刻显示已取消');

    const p2 = jobs.prepareDocumentLocal(2);
    await tick();
    eq(gates.length, 2, '取消之后应当能立刻起新任务');

    // 旧任务这次才回来：runId 已经变了，必须被丢掉
    gates[0].resolve();
    await tick();
    await tick();
    eq(repo.calls.replace.length, 0, '旧任务的结果不能写库');

    gates[1].resolve();
    await p1;
    await p2;

    eq(repo.calls.replace.length, 1, '只有新任务的结果写库');
    eq(repo.calls.replace[0].content.bodyMd, '新结果', '写进去的必须是新任务的结果');
    eq(jobs.getDocumentJob(2).phase, 'done', '新任务应当完成');
  });

  /* 3. 版本对不上 ---------------------------------------------------- */
  await test('版本对不上时结果作废，不覆盖新正文', async () => {
    const repo = makeRepo([makeDoc({ id: 3 })]);
    const jobs = compileModule(path.join(SRC, 'documents', 'jobs.ts'), {
      '../db/repo': { repo },
      './readers': {
        extractLocalDocument: async () => chunkContent('迟到的结果'),
        contentFromText: chunkStub.contentFromText,
      },
      '../ai/mineru': makeMineruStub(),
      '../util/docSupport': makeDocSupportStub({ parseCalls: [] }),
    });

    const p = jobs.prepareDocumentLocal(3);
    // 模拟「另一处先把版本推过去了」：任务开始时读到的是 0，写回时库里已经是 7
    repo.docs.get(3).contentRevision = 7;
    await p;

    eq(repo.calls.replace.length, 1, '仍然会尝试写一次');
    eq(repo.calls.replace[0].expectedRevision, 0, '写回必须带开始时的版本号');
    eq(repo.docs.get(3).bodyMd, '', '版本对不上就不许覆盖正文');
    eq(repo.docs.get(3).contentRevision, 7, '版本不能被这次写回改掉');
    eq(jobs.getDocumentJob(3).phase, 'failed', '任务要如实报告这次白跑了');
  });

  /* 4. 取消后不再写库 + 状态还原 ------------------------------------- */
  await test('取消后不再写库，状态还原成任务前', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const repo = makeRepo([makeDoc({ id: 4 })]);
    const jobs = compileModule(path.join(SRC, 'documents', 'jobs.ts'), {
      '../db/repo': { repo },
      './readers': {
        extractLocalDocument: async () => {
          await gate;
          return chunkContent('取消之后才回来的正文');
        },
        contentFromText: chunkStub.contentFromText,
      },
      '../ai/mineru': makeMineruStub(),
      '../util/docSupport': makeDocSupportStub({ parseCalls: [] }),
    });

    const p = jobs.prepareDocumentLocal(4);
    await tick();
    jobs.cancelDocumentJob(4);
    release();
    await p;
    await tick();

    eq(repo.calls.replace.length, 0, '取消之后一次都不能写正文');
    eq(jobs.getDocumentJob(4).phase, 'cancelled', '任务状态是取消而不是失败');
    const restored = repo.calls.update.filter((c) => c.patch.state === 'stored');
    eq(restored.length > 0, true, '状态要还原成任务开始前的 stored');
    eq(repo.docs.get(4).state, 'stored', '不能留一条「正在准备」的僵尸记录');
  });

  /* 5. 本地任务零网络 ------------------------------------------------ */
  await test('本地准备全程零 fetch', async () => {
    const original = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error('本地任务不应联网');
    };
    try {
      const repo = makeRepo([makeDoc({ id: 5 })]);
      const jobs = compileModule(path.join(SRC, 'documents', 'jobs.ts'), {
        '../db/repo': { repo },
        './readers': {
          extractLocalDocument: async () => chunkContent('只在手机上读'),
          contentFromText: chunkStub.contentFromText,
        },
        '../ai/mineru': makeMineruStub(),
        '../util/docSupport': makeDocSupportStub({ parseCalls: [] }),
      });
      await jobs.prepareDocumentLocal(5);
      eq(fetchCalls, 0, '本地准备不能发任何网络请求');
      eq(repo.calls.replace.length, 1, '正文应当正常写库');
    } finally {
      global.fetch = original;
    }
  });

  /* 6. 启动恢复 ------------------------------------------------------ */
  await test('启动时把没跑完的 parsing 标成失败，且不自动重发', async () => {
    const repo = makeRepo([
      makeDoc({ id: 6, state: 'parsing' }),
      makeDoc({ id: 7, state: 'done', contentRevision: 1, indexedRevision: 1, chunkCount: 1, charCount: 4, bodyMd: '正文' }),
    ]);
    const jobs = compileModule(path.join(SRC, 'documents', 'jobs.ts'), {
      '../db/repo': { repo },
      './readers': {
        extractLocalDocument: async () => chunkContent('x'),
        contentFromText: chunkStub.contentFromText,
      },
      '../ai/mineru': makeMineruStub(),
      '../util/docSupport': makeDocSupportStub({ parseCalls: [] }),
    });

    await jobs.initDocumentJobs();
    eq(repo.docs.get(6).state, 'failed', '没有任务的 parsing 记录要标失败');
    ok(/上次没跑完/.test(repo.docs.get(6).error || ''), '错误文案要说清是上次没跑完');
    eq(repo.docs.get(7).state, 'done', '正常文档不受影响');
    eq(repo.calls.replace.length, 0, '启动恢复不能重发文件');
    eq(repo.calls.list, 1, '只查一次列表');
  });

  /* 7. 导入只保存原件 ------------------------------------------------ */
  await test('导入只保存原件：同名不覆盖、大小取副本真实值、零网络', async () => {
    const originalNow = Date.now;
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    // 固定时间戳才能预测落盘文件名
    Date.now = () => 1000;
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error('导入不应该联网');
    };

    const fsState = {
      exists: true,
      size: 98432,
      deleteThrows: false,
      copies: [],
      created: 0,
      names: ['1000-报告.pdf', '1000-报告-1.pdf'],
    };

    try {
      const join = (parts) =>
        parts
          .map((p) => (typeof p === 'string' ? p : p.uri))
          .filter(Boolean)
          .join('/');

      class Directory {
        constructor(...parts) {
          this.uri = join(parts);
          const last = parts[parts.length - 1];
          this.name = typeof last === 'string' ? last : '';
        }
        create() {
          fsState.created += 1;
        }
        list() {
          return fsState.names.map((n) => ({ name: n }));
        }
      }

      class File {
        constructor(...parts) {
          this.uri = join(parts);
          const last = parts[parts.length - 1];
          this.name = typeof last === 'string' ? last : '';
        }
        get exists() {
          return fsState.exists;
        }
        get size() {
          return fsState.size;
        }
        info() {
          return { size: fsState.size, exists: fsState.exists };
        }
        async copy(dest) {
          fsState.copies.push(dest.uri);
        }
        delete() {
          if (fsState.deleteThrows) throw new Error('EBUSY');
          fsState.exists = false;
        }
        async text() {
          return 'x';
        }
      }

      const docFiles = compileModule(path.join(SRC, 'db', 'docFiles.ts'), {
        'react-native': { Platform: { OS: 'android' } },
        'expo-file-system': { Directory, File, Paths: { document: 'file:///private' } },
        'expo-file-system/legacy': {
          getContentUriAsync: async (u) => u,
          readAsStringAsync: async () => '',
          deleteAsync: async () => {
            if (fsState.deleteThrows) throw new Error('EACCES');
          },
          copyAsync: async () => undefined,
          getInfoAsync: async () => ({ exists: true, size: fsState.size }),
          createUploadTask: () => ({ uploadAsync: async () => null, cancelAsync: async () => undefined }),
          FileSystemUploadType: { BINARY_CONTENT: 'binary' },
        },
        'expo-document-picker': { getDocumentAsync: async () => ({ canceled: true }) },
        'expo-sharing': { isAvailableAsync: async () => false, shareAsync: async () => undefined },
        'expo-intent-launcher': { startActivityAsync: async () => undefined },
      });

      const saved = await docFiles.saveOriginal('content://tmp/1', '报告.pdf');
      eq(saved.fileName, '1000-报告-2.pdf', '同名必须加后缀，不能覆盖已存在的原件');
      eq(saved.renamed, true, '改过名要标出来');
      eq(saved.size, 98432, '入库大小必须是副本真实字节数');
      eq(fsState.copies.length, 1, '只复制一次');
      eq(fetchCalls, 0, '导入不能发任何网络请求');

      // 空文件是合法的 0 字节，不能当成失败
      fsState.size = 0;
      fsState.names = [];
      const empty = await docFiles.saveOriginal('content://tmp/2', '空文件.txt');
      eq(empty.size, 0, '空文件也要能保存');

      // 删除失败必须如实返回 false，不能吞掉
      fsState.deleteThrows = true;
      eq(await docFiles.deleteOriginal('file:///private/x.pdf'), false, '删不掉要返回 false');
      eq(await docFiles.deleteOriginal(null), true, '没有 URI 视为已清干净');
    } finally {
      Date.now = originalNow;
      global.fetch = originalFetch;
    }
  });

  /* 8. 列表页导入路径不接云 ------------------------------------------ */
  await test('DocsScreen 的导入路径不碰解析与网络', async () => {
    const source = fs.readFileSync(path.join(SRC, 'screens', 'DocsScreen.tsx'), 'utf8');
    const start = source.indexOf('async function handlePick()');
    ok(start > 0, '找不到 handlePick：导入流程结构变了，请同步更新断言');
    const end = source.indexOf('\n  }', start);
    const body = source.slice(start, end > start ? end : start + 3000);

    for (const forbidden of ['parseDocFile', 'parseWithMineru', 'prepareDocument', 'readPlainText', 'extractLocalDocument', 'fetch(']) {
      eq(body.includes(forbidden), false, `导入流程里不该出现 ${forbidden}`);
    }
    ok(body.includes("state: 'stored'"), '导入应当写入 stored 状态');
    ok(body.includes('saveOriginal'), '导入必须先落原文件');
    ok(body.includes('saved.size'), '入库大小要用副本真实大小，不能用选择器报的');
  });

  /* 汇总 ------------------------------------------------------------ */
  console.log('');
  if (failures) {
    console.error(`${failures} 项失败，${passed} 项通过`);
    process.exit(1);
  }
  console.log(`${passed} 项全部通过`);
}

main().catch((e) => {
  console.error('断言脚本自己崩了：', e);
  process.exit(1);
});
