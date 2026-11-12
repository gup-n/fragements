/**
 * 限定文档问答（qa-audit）的回归断言。跑法：`node scripts/assert_document_qa.cjs`
 *
 * 为什么要有这个脚本：这个功能最危险的错误都不是「报错」，而是**安静地多查了东西**——
 * 选了 2 份却查了 3 份、选了 8 份只答了第 1 份、读了几段却说读完了全文、
 * 模型编一个 [D999] 也成了「来源」。这些在界面上看不出来，只能靠断言钉住。
 *
 * 它不碰数据库、不联网、不调模型：桩 Repo 记账，纯函数给结果。
 * 为了能在 node 里 require，脚本会先用 TypeScript 的 transpileModule 把
 * 用到的几个纯模块编译到 `.tmp-assert-qa/`（跑完删掉），不走项目的 tsconfig ——
 * 并行开发时项目级 tsc 会互相抢临时目录，这里只编自己依赖的那一小撮文件。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-assert-qa');

/** 依赖链上全是纯函数（不 import react-native / repo / chat） */
const MODULES = [
  'src/types.ts',
  'src/util/date.ts',
  'src/util/mdBlocks.ts',
  'src/util/inlineImages.ts',
  'src/util/tokenize.ts',
  'src/util/qaScope.ts',
  'src/util/qaNote.ts',
  'src/documents/formats.ts',
  'src/ai/documentRetrieval.ts',
];

function build() {
  const ts = require('typescript');
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const rel of MODULES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const js = ts.transpileModule(src, {
      fileName: rel,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        isolatedModules: true,
      },
    }).outputText;
    const dest = path.join(OUT, rel.replace(/^src\//, '').replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, js);
  }
}

build();

const { normalizeQaScope } = require(path.join(OUT, 'util/qaScope.js'));
const { citedKeys, collectSources } = require(path.join(OUT, 'util/qaNote.js'));
const {
  DOC_LIMITS,
  buildDocumentCitations,
  buildDocumentMaterials,
  isOverviewQuestion,
  nextSampleIndex,
  planDocumentMaterials,
  resolveScopeDocuments,
} = require(path.join(OUT, 'ai/documentRetrieval.js'));

let n = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      n++;
      console.log('  ok  ' + name);
    })
    .catch((e) => {
      console.error('  FAIL  ' + name);
      throw e;
    });
}

/* ---------------- 桩数据 ---------------- */

function makeDoc(id, name, over = {}) {
  const chunkCount = over.chunkCount ?? 3;
  return {
    id,
    name,
    ext: over.ext ?? 'pdf',
    size: 1024,
    fileUri: `file:///docs/${id}`,
    pages: 10,
    charCount: over.charCount ?? chunkCount * 500,
    state: 'done',
    error: null,
    contentRevision: 2,
    indexedRevision: 2,
    chunkCount,
    contentSource: over.contentSource ?? 'pdf',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function makeChunk(docId, ordinal, text, locator) {
  return {
    id: docId * 1000 + ordinal,
    documentId: docId,
    contentRevision: 2,
    ordinal,
    text,
    locator: locator ?? { kind: 'pdf', page: ordinal + 1 },
  };
}

function hits(text, word) {
  return text.split(word).length - 1;
}

/**
 * 桩 Repo。`mode` 模拟 Repo 的两条检索路径：
 * - `fts`：按命中次数排序（真实 FTS5 + bm25 的行为）
 * - `like`：按 document_id/ordinal 顺序返回（FTS 不可用时的降级）
 * `leak` 用来模拟「下层没有守白名单」的坏实现。
 */
function makeRepo({ docs, chunks, mode = 'fts', leak = [] }) {
  const calls = { search: [], list: [] };
  return {
    calls,
    async listDocuments() {
      return docs;
    },
    async searchDocumentChunks(query, documentIds, limit = 40) {
      calls.search.push(documentIds.slice());
      // 空集合是「不查」，绝不能当成「没限制」
      if (!documentIds.length) return [];
      const out = [];
      for (const id of documentIds) {
        let list = (chunks[id] ?? []).filter((c) => mode === 'like' || c.text.includes(query));
        list = list
          .slice()
          .sort((a, b) =>
            mode === 'fts'
              ? hits(b.text, query) - hits(a.text, query) || a.ordinal - b.ordinal
              : a.ordinal - b.ordinal,
          );
        out.push(...list.slice(0, limit));
      }
      out.push(...leak);
      return out;
    },
    async listDocumentChunks(documentId) {
      calls.list.push(documentId);
      return (chunks[documentId] ?? []).slice().sort((a, b) => a.ordinal - b.ordinal);
    },
  };
}

/* ---------------- 断言 ---------------- */

async function main() {
  /* ---- 1. 范围：只查选中的那几份 ---- */

  const docs3 = [makeDoc(1, 'A.pdf'), makeDoc(2, 'B.pdf'), makeDoc(3, 'C.pdf')];
  const chunks3 = {
    1: [makeChunk(1, 0, '报销 流程：A 文档第一节'), makeChunk(1, 1, '报销 需要发票：A 第二节')],
    2: [makeChunk(2, 0, '报销 上限：B 文档')],
    // C 命中最多，相关度最高 —— 没选它，它就一段都不能出现
    3: [
      makeChunk(3, 0, '报销 报销 报销 C-1'),
      makeChunk(3, 1, '报销 报销 C-2'),
      makeChunk(3, 2, '报销 报销 报销 报销 C-3'),
    ],
  };

  for (const mode of ['fts', 'like']) {
    await ok(`只有选中的文档能进结果（${mode} 检索路径）`, async () => {
      const repo = makeRepo({ docs: docs3, chunks: chunks3, mode });
      const { documents } = await resolveScopeDocuments(
        { kind: 'documents', documentIds: [1, 2] },
        repo,
      );
      assert.deepStrictEqual(
        documents.map((d) => d.id),
        [1, 2],
      );
      const plan = await planDocumentMaterials(documents, '报销', repo, 20_000);

      // 每一片都必须来自 1 或 2；C 的相关度再高也不能出现
      assert.deepStrictEqual(
        Array.from(new Set(plan.picks.map((p) => p.documentId))).sort(),
        [1, 2],
      );
      // Repo 只被问过 1 和 2
      for (const ids of repo.calls.search) assert.ok(!ids.includes(3), '不该向 Repo 要 C');
      // coverage 也只覆盖这两份
      assert.deepStrictEqual(
        plan.coverage.map((c) => c.documentId),
        [1, 2],
      );
    });
  }

  await ok('下层越界返回别的文档也会被丢掉（白名单不能只靠下层）', async () => {
    const repo = makeRepo({
      docs: docs3,
      chunks: chunks3,
      mode: 'fts',
      // 模拟 Repo 的 bug：问 A 却把 C 的片段一起返回
      leak: [makeChunk(3, 9, '报销 报销 报销 泄漏的 C')],
    });
    const { documents } = await resolveScopeDocuments(
      { kind: 'documents', documentIds: [1] },
      repo,
    );
    const plan = await planDocumentMaterials(documents, '报销', repo, 20_000);
    assert.deepStrictEqual(
      plan.picks.map((p) => p.documentId),
      [1, 1],
    );
    assert.strictEqual(plan.picks.length, 2);
  });

  await ok('文档列表回带：listDocuments 给了全部，范围仍只留选中的', async () => {
    const repo = makeRepo({ docs: docs3, chunks: chunks3 });
    const { documents, problems } = await resolveScopeDocuments(
      { kind: 'documents', documentIds: [2] },
      repo,
    );
    assert.deepStrictEqual(documents.map((d) => d.id), [2]);
    assert.deepStrictEqual(problems, []);
  });

  /* ---- 2. 非法范围必须报错，不能退化 ---- */

  await ok('空 documentIds / 非法 scope 一律抛错，不降级成全库', () => {
    const bad = [
      { kind: 'documents', documentIds: [] },
      { kind: 'documents', documentIds: [0] },
      { kind: 'documents', documentIds: [-3] },
      { kind: 'documents', documentIds: [1.5] },
      { kind: 'documents' },
      { kind: 'docs', documentIds: [1] },
      {},
      undefined,
      'documents',
    ];
    for (const value of bad) {
      assert.throws(() => normalizeQaScope(value), `应拒绝 ${JSON.stringify(value)}`);
    }
    // 合法的才放行，并且去重
    assert.deepStrictEqual(normalizeQaScope({ kind: 'documents', documentIds: [2, 2, 1] }), {
      kind: 'documents',
      documentIds: [2, 1],
    });
    assert.deepStrictEqual(normalizeQaScope({ kind: 'records' }), { kind: 'records' });
  });

  await ok('未就绪 / 已删除的文档要被列明，而不是悄悄跳过', async () => {
    const docs = [
      makeDoc(1, '好.pdf'),
      makeDoc(2, '还没准备.pdf', { state: 'stored', charCount: 0, chunkCount: 0, contentRevision: 0, indexedRevision: 0 }),
    ];
    const repo = makeRepo({ docs, chunks: { 1: [makeChunk(1, 0, '报销')] } });
    const r = await resolveScopeDocuments({ kind: 'documents', documentIds: [1, 2, 9] }, repo);
    assert.deepStrictEqual(r.documents.map((d) => d.id), [1]);
    assert.strictEqual(r.problems.length, 2);
    assert.ok(r.problems.some((p) => p.includes('还没准备.pdf')));
    assert.ok(r.problems.some((p) => p.includes('9')));
  });

  await ok('没有可用文档时不装填任何东西', async () => {
    const repo = makeRepo({ docs: [], chunks: {} });
    const plan = await planDocumentMaterials([], '报销', repo, 10_000);
    assert.strictEqual(plan.picks.length, 0);
    assert.strictEqual(plan.coverage.length, 0);
    assert.strictEqual(repo.calls.search.length, 0);
  });

  /* ---- 3. 八份文档都得分到预算 ---- */

  await ok('8 份文档每份都进过检索，且都分到片段', async () => {
    const docs = Array.from({ length: 8 }, (_, i) => makeDoc(i + 1, `D${i + 1}.pdf`, { chunkCount: 10 }));
    const chunks = {};
    for (let i = 1; i <= 8; i++) {
      chunks[i] = Array.from({ length: 10 }, (_, k) =>
        makeChunk(i, k, `报销 第 ${i} 份第 ${k} 段 ${'x'.repeat(460)}`),
      );
    }
    const repo = makeRepo({ docs, chunks });
    const budget = 40_000;
    const plan = await planDocumentMaterials(docs, '报销', repo, budget);

    // 每份都被问过一次
    assert.strictEqual(repo.calls.search.length, 8);
    for (let i = 1; i <= 8; i++) assert.ok(repo.calls.search.some((ids) => ids.length === 1 && ids[0] === i));
    // 每份都真的有片段，不是只有第 1 份
    for (const c of plan.coverage) assert.ok(c.includedChunks >= 1, `${c.name} 一段都没有`);
    // 总量不超预算
    const used = plan.picks.reduce((s, p) => s + p.text.length, 0);
    assert.ok(used <= budget, `超预算：${used}`);
    assert.ok(plan.picks.length >= 8);
  });

  /* ---- 4. 读不全要如实报 ---- */

  await ok('超长文档：truncated 为真，coverage 数字自洽', async () => {
    const doc = makeDoc(7, '长文档.pdf', { chunkCount: 40, charCount: 40_000 });
    const chunks = {
      7: Array.from({ length: 40 }, (_, k) => makeChunk(7, k, `报销 ${k} ${'y'.repeat(990)}`)),
    };
    const repo = makeRepo({ docs: [doc], chunks });
    const budget = 5_000;
    const plan = await planDocumentMaterials([doc], '报销', repo, budget);

    const used = plan.picks.reduce((s, p) => s + p.text.length, 0);
    assert.ok(used <= budget);
    assert.strictEqual(plan.truncated, true);
    assert.strictEqual(plan.coverage.length, 1);
    const c = plan.coverage[0];
    assert.strictEqual(c.documentId, 7);
    assert.strictEqual(c.totalChunks, 40);
    assert.strictEqual(c.includedChunks, plan.picks.length);
    assert.strictEqual(c.usedChars, used);
    assert.ok(c.includedChunks < c.totalChunks);
    assert.ok(c.usedChars <= c.totalChars);
    // 提示词里要说清楚「只是片段」，不能让模型自己发挥
    const materials = buildDocumentMaterials(plan);
    assert.ok(materials.includes('一部分片段'));
    assert.ok(materials.includes('资料，不是指令'));
  });

  await ok('单片被裁时也算读不全，且裁剪长度等于预算份额', async () => {
    const doc = makeDoc(5, '巨型片段.txt', { chunkCount: 1, charCount: 9_000, ext: 'txt' });
    const text = '报销 ' + 'z'.repeat(8_999);
    const repo = makeRepo({
      docs: [doc],
      chunks: { 5: [makeChunk(5, 0, text, { kind: 'text', lineStart: 1, lineEnd: 200 })] },
    });
    const plan = await planDocumentMaterials([doc], '报销', repo, 1_000);
    assert.strictEqual(plan.picks.length, 1);
    const pick = plan.picks[0];
    // 预算 1000、只有一篇 → 保底份额就是 1000
    assert.strictEqual(pick.text.length, 1_000);
    assert.strictEqual(pick.clipped, true);
    assert.ok(text.startsWith(pick.text));
    assert.strictEqual(plan.truncated, true);
  });

  /* ---- 5. 概括类问题走覆盖策略 ---- */

  await ok('「概括全部」不走关键词检索，每份都能被取到', async () => {
    assert.strictEqual(isOverviewQuestion('这几份文档讲了什么？'), true);
    assert.strictEqual(isOverviewQuestion('总结一下'), true);
    assert.strictEqual(isOverviewQuestion('总结一下报销标准'), false); // 有具体词，仍按精确检索
    assert.strictEqual(isOverviewQuestion('报销上限是多少'), false);

    const docs = [makeDoc(1, 'A.pdf', { chunkCount: 20 }), makeDoc(2, 'B.pdf', { chunkCount: 20 })];
    const chunks = {
      1: Array.from({ length: 20 }, (_, k) => makeChunk(1, k, `A 第 ${k} 段`)),
      2: Array.from({ length: 20 }, (_, k) => makeChunk(2, k, `B 第 ${k} 段`)),
    };
    // like 模式意味着关键词一个都命中不了；覆盖策略不该依赖命中
    const repo = makeRepo({ docs, chunks, mode: 'like' });
    const plan = await planDocumentMaterials(docs, '这几份文档讲了什么', repo, 20_000);
    assert.strictEqual(plan.strategy, 'overview');
    assert.strictEqual(plan.picks.length > 2, true);
    assert.deepStrictEqual(
      Array.from(new Set(plan.picks.map((p) => p.documentId))).sort(),
      [1, 2],
    );
    // 用的是 listDocumentChunks，不是把「没命中」当成没有内容
    assert.strictEqual(repo.calls.list.length, 2);
  });

  await ok('均匀取样：取 3 片和取 7 片都铺开，不会挤在开头', () => {
    const three = [];
    for (let i = 0; i < 3; i++) three.push(nextSampleIndex(three, 30));
    // 0 → 尾部空档的中点 15 → 0..15 的中点 8
    assert.deepStrictEqual(three, [0, 15, 8]);
    const seven = [];
    for (let i = 0; i < 7; i++) seven.push(nextSampleIndex(seven, 30));
    assert.strictEqual(new Set(seven).size, 7);
    const sorted = [...seven].sort((a, b) => a - b);
    assert.strictEqual(sorted[0], 0);
    assert.ok(sorted[sorted.length - 1] >= 20, '末尾也要取到');
    // 相邻样本间隔不大于 6：30 段取 7 片平均隔 4 段，均匀就够不上「挤在开头」
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] <= 6);
  });

  /* ---- 6. 引用编号与快照 ---- */

  const citeDoc = makeDoc(11, '报销制度.pdf', { chunkCount: 2 });
  const citeChunks = {
    11: [
      makeChunk(11, 0, '报销 必须在 30 天内提交。', { kind: 'pdf', page: 3 }),
      makeChunk(11, 1, '报销 需要发票原件。', { kind: 'pdf', page: 4 }),
    ],
  };

  await ok('伪造的 D999 不算引用；快照正文等于发送内容', async () => {
    const repo = makeRepo({ docs: [citeDoc], chunks: citeChunks });
    const plan = await planDocumentMaterials([citeDoc], '报销', repo, 20_000);
    assert.ok(plan.picks.length >= 2);

    const sent = new Set(plan.picks.map((p) => p.text));
    const materials = buildDocumentMaterials(plan);
    for (const p of plan.picks) {
      // 提示词里确实是这段字
      assert.ok(materials.includes(p.text));
    }

    const answer = '按 [D1] 是 30 天内，[D999] 这条是编的。';
    const cites = buildDocumentCitations(plan.picks, citedKeys(answer));
    assert.strictEqual(cites.length, 1);
    assert.strictEqual(cites[0].kind, 'D');
    assert.strictEqual(cites[0].id, 1);
    // 快照正文必须就是本轮发出去的那段，不是重新检索的结果
    assert.strictEqual(cites[0].body, plan.picks[0].text);
    assert.ok(sent.has(cites[0].body));
    // 稳定身份齐全，历史会话靠它认文档
    assert.strictEqual(cites[0].documentId, 11);
    assert.strictEqual(cites[0].chunkId, plan.picks[0].chunkId);
    assert.strictEqual(cites[0].contentRevision, 2);
    assert.ok(cites[0].label.includes('报销制度.pdf'));
    assert.ok(cites[0].label.includes('第 3 页'));
  });

  await ok('代码块和行内代码里的编号不算引用', () => {
    assert.strictEqual(citedKeys('```\n[D1] [F2]\n```').size, 0);
    assert.strictEqual(citedKeys('行内 `[D1]` 只是举例').size, 0);
    assert.deepStrictEqual(Array.from(citedKeys('正文 [D2] 与 [F7]')), ['D2', 'F7']);
  });

  await ok('没有位置的片段只写「正文第 N 段」，不编页码', async () => {
    const doc = makeDoc(12, '旧笔记.md', { chunkCount: 1, ext: 'md' });
    const repo = makeRepo({
      docs: [doc],
      chunks: { 12: [makeChunk(12, 0, '报销 走纸质流程', { kind: 'markdown' })] },
    });
    const plan = await planDocumentMaterials([doc], '报销', repo, 5_000);
    const cites = buildDocumentCitations(plan.picks, new Set(['D1']));
    assert.strictEqual(cites[0].label, '《旧笔记.md》· 正文第 1 段');
  });

  /*
   * v0.16 删掉了「会话整理为碎片」，`collectSources` 随之删除 ——
   * 跨轮聚合来源只服务于那条链路的「参考来源」清单。现在来源是按轮显示的，
   * 所以这条断言守的行为已经不存在，不能留着当装饰。
   */

  /* ---- 7. 预算 ---------------- */

  await ok('装填不会超出预算，且 D 编号连续', async () => {
    const docs = [makeDoc(1, 'A.pdf', { chunkCount: 6 }), makeDoc(2, 'B.pdf', { chunkCount: 6 })];
    const chunks = {
      1: Array.from({ length: 6 }, (_, k) => makeChunk(1, k, `报销 ${'a'.repeat(3990)}`)),
      2: Array.from({ length: 6 }, (_, k) => makeChunk(2, k, `报销 ${'b'.repeat(3990)}`)),
    };
    const repo = makeRepo({ docs, chunks });
    const budget = 12_000;
    const plan = await planDocumentMaterials(docs, '报销', repo, budget);
    const used = plan.picks.reduce((s, p) => s + p.text.length, 0);
    assert.ok(used <= budget, `used=${used}`);
    plan.picks.forEach((p, i) => assert.strictEqual(p.alias, i + 1));
    // 单篇不能超过上限（否则「第一篇吃完」）
    for (const c of plan.coverage) assert.ok(c.usedChars <= Math.ceil(budget * 0.6) + DOC_LIMITS.maxChunkChars);
  });

  console.log(`\n${n} 项全部通过`);
}

main()
  .then(() => {
    fs.rmSync(OUT, { recursive: true, force: true });
  })
  .catch((e) => {
    // 失败时保留 .tmp-assert-qa，方便直接看编译出来的代码
    console.error(e);
    process.exit(1);
  });
