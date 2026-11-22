#!/usr/bin/env node
/**
 * 回收站 / 标签 / 提案 的断言（v0.28）。不联网、不碰数据库。
 *
 * 这一版最要紧的一条是**软删的过滤不能漏**：
 * `deleted_at` 一加，所有列表查询都要补 `IS NULL`，而漏一条在桌面上看不出来 ——
 * 界面上只是「删掉的东西又冒出来一条」，没有任何报错。所以要逐条扫源码。
 *
 * 扫的时候只承认三种写法：
 * 1. 语句里有 `deleted_at IS NULL`（看不见的）或 `deleted_at IS NOT NULL`（回收站里正要看它）；
 * 2. 是 `DELETE FROM ...`（彻底删除，本来就要删掉它）；
 * 3. 语句前面 400 字内有 `trash:ok` 标记 —— 用于「按 id 读一行」这类
 *    必须能读到已删行的内部动作，每一处都要写清理由。
 *
 * 迁移数组（MIGRATIONS）整段跳过：那是按顺序执行的历史脚本，
 * 里面读的行在那一刻还没有 `deleted_at` 这一列。
 *
 * 用法：node scripts/assert_recycle.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLoader, createSuite, plain } = require('./test_loader.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const suite = createSuite('回收站与标签');
const { test } = suite;

const pure = createLoader();
const trash = pure.load('src/util/trash.ts');
const docTags = pure.load('src/util/docTags.ts');
const proposal = pure.load('src/util/proposal.ts');
const batch = pure.load('src/util/docBatch.ts');
const inline = pure.load('src/util/inlineImages.ts');
const md = pure.load('src/util/mdBlocks.ts');

/* ------------------------------------------------------------------ */
/* 一、源码扫描：每条查询都要带软删过滤                                  */
/* ------------------------------------------------------------------ */

/**
 * 把源码里的字符串字面量一个个抠出来（单引号、双引号、模板串）。
 *
 * 为什么要自己扫而不是正则整体匹配：SQL 里到处是 `'%'`、`ESCAPE '\\'`，
 * 用正则在「字符串里的引号」上一定会错位，然后漏掉真正的语句。
 */
function stringLiterals(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      i += 1;
      let value = '';
      while (i < text.length) {
        if (text[i] === '\\') { value += text[i + 1] ?? ''; i += 2; continue; }
        if (text[i] === ch) break;
        value += text[i];
        i += 1;
      }
      out.push({ value, start });
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 迁移数组整段挖掉：历史脚本不该受今天的规则约束 */
function withoutMigrations(text) {
  const head = 'const MIGRATIONS: string[] = [';
  const start = text.indexOf(head);
  if (start < 0) return text;
  const end = text.indexOf('\n];', start);
  if (end < 0) return text;
  return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end);
}

const TABLE_RE = /\b(?:FROM|JOIN)\s+(fragments|documents|ask_sessions|notes)\b/;

test('native 里每条查询都挡住了回收站里的行', () => {
  const text = withoutMigrations(read('src/db/repo.native.ts'));
  const bad = [];
  let scanned = 0;
  for (const { value, start } of stringLiterals(text)) {
    if (!TABLE_RE.test(value)) continue;
    scanned += 1;
    if (/deleted_at\s+IS\s+(NOT\s+)?NULL/i.test(value)) continue;
    if (/^\s*DELETE\s+FROM/i.test(value)) continue;
    // 标记写在语句前面（注释、说明都行），400 字够容纳一段解释
    if (text.slice(Math.max(0, start - 400), start).includes('trash:ok')) continue;
    bad.push(value.replace(/\s+/g, ' ').trim().slice(0, 120));
  }
  assert.ok(scanned >= 20, `只扫到 ${scanned} 条查询，扫描器多半坏了`);
  assert.deepEqual(bad, [], '这些查询没排除回收站里的行（或没有 trash:ok 说明理由）');
});

test('删除是软删：deleteFragment / deleteDocument / deleteAskSession / deleteNote 不删行', () => {
  // 迁移里 v11 那句「删掉日/周小结」是历史脚本，不受今天的软删规则约束
  const text = withoutMigrations(read('src/db/repo.native.ts'));
  const body = (name) => {
    const at = text.indexOf(`async ${name}(`);
    assert.ok(at > 0, `找不到 ${name}`);
    const next = text.indexOf('\n  async ', at + 10);
    return text.slice(at, next > 0 ? next : undefined);
  };
  for (const name of ['deleteFragment', 'deleteDocument', 'deleteAskSession', 'deleteNote']) {
    const src = body(name);
    assert.ok(/deleted_at/.test(src), `${name} 要写 deleted_at`);
    assert.ok(
      !/DELETE FROM (fragments|documents|ask_sessions|notes)\b/i.test(src),
      `${name} 不许真的删行 —— 那是回收站「彻底删除」的事`,
    );
  }
  // 整个文件里只有 purgeRefs 能 DELETE 这三张表
  const purgeAt = text.indexOf('function purgeRefs(');
  assert.ok(purgeAt > 0, '彻底删除只有一份实现（purgeRefs）');
  const purge = text.slice(purgeAt, text.indexOf('export const repo', purgeAt));
  assert.ok(/DELETE FROM fragments/.test(purge), 'purgeRefs 要删碎片行');
  assert.ok(/DELETE FROM documents/.test(purge), 'purgeRefs 要删文档行');
  assert.ok(/DELETE FROM notes/.test(purge), 'purgeRefs 要删小结行');
  const others = text.replace(purge, '');
  for (const table of ['fragments', 'documents', 'ask_sessions', 'notes']) {
    assert.ok(
      !new RegExp(`DELETE FROM ${table}\\b`).test(others),
      `除了 purgeRefs，别处不许 DELETE FROM ${table}`,
    );
  }
});

test('web 侧列表都必须走 live* 过滤，不能直接读全量数组', () => {
  const text = read('src/db/repo.web.ts');
  for (const helper of ['liveFragments', 'liveDocuments', 'liveSessions', 'liveNotes']) {
    assert.ok(text.includes(`function ${helper}(d: WebDb)`), `缺少 ${helper}`);
  }
  assert.ok(/function isTrashed\(d: WebDb, kind: TrashKind, id: number\)/.test(text), '回收站判定只有一处');
  const body = (name) => {
    const at = text.indexOf(`async ${name}(`);
    assert.ok(at > 0, `web 侧找不到 ${name}`);
    const next = text.indexOf('\n  async ', at + 10);
    return text.slice(at, next > 0 ? next : undefined);
  };
  const expect = {
    listAllFragments: 'liveFragments(',
    listFragmentsPage: 'liveFragments(',
    listFragments: 'liveFragments(',
    totalFragments: 'liveFragments(',
    dayCounts: 'liveFragments(',
    monthCounts: 'liveFragments(',
    listDocuments: 'liveDocuments(',
    searchDocuments: 'liveDocuments(',
    findDocument: 'liveDocuments(',
    listAskSessions: 'liveSessions(',
    findAskSession: 'liveSessions(',
    listNotes: 'liveNotes(',
    findNote: 'liveNotes(',
  };
  for (const [name, needle] of Object.entries(expect)) {
    assert.ok(body(name).includes(needle), `web 的 ${name} 要用 ${needle}`);
  }
});

/* ------------------------------------------------------------------ */
/* 二、30 天的时间口径                                                  */
/* ------------------------------------------------------------------ */

test('到期是 30 天，剩几天向上取整，过期夹到 0', () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 10, 18, 12);
  assert.equal(trash.TRASH_KEEP_DAYS, 30);
  assert.equal(trash.trashDaysLeft(now, now), 30, '刚删那一刻显示 30 天');
  assert.equal(trash.trashDaysLeft(now - 29 * day, now), 1, '第 29 天还剩 1 天');
  assert.equal(trash.trashDaysLeft(now - 30 * day, now), 0, '到点就是 0');
  assert.equal(trash.trashDaysLeft(now - 40 * day, now), 0, '过期不能是负数');
  assert.equal(trash.trashLeftText(now - 40 * day, now), '今天到期');
  assert.equal(trash.trashLeftText(now - 10 * day, now), '还有 20 天');
});

test('启动清理的截止时间正好是 30 天前，且边界保守', () => {
  const now = Date.UTC(2026, 10, 18);
  const cutoff = trash.purgeCutoff(now);
  assert.equal(now - cutoff, 30 * 86_400_000);
  assert.equal(trash.isTrashExpired(cutoff - 1, now), true, '早一毫秒就该清');
  assert.equal(trash.isTrashExpired(cutoff, now), false, '正好 30 天的不清 —— 差一毫秒不该决定删不删');
});

test('顶部那句话要说清「有什么、最早什么时候没」', () => {
  const now = Date.UTC(2026, 10, 18);
  const entries = [
    { kind: 'fragment', id: 1, title: 'a', detail: '1 字', deletedAt: now, files: [] },
    { kind: 'fragment', id: 2, title: 'b', detail: '2 字', deletedAt: now - 20 * 86_400_000, files: [] },
    { kind: 'document', id: 3, title: 'c', detail: '3 字', deletedAt: now, files: [] },
  ];
  const text = trash.trashSummary(entries, now);
  assert.ok(text.includes('碎片 2 条'), '碎片要给条数');
  assert.ok(text.includes('文档 1 篇'), '文档要给篇数');
  assert.ok(text.includes('还有 10 天'), '要说最早的一条还剩几天');
  assert.ok(trash.trashSummary([], now).includes('先到这里'), '空的时候要说明东西会来这儿');
});

test('勾选是「点一下加、再点一下减」，不分顺序', () => {
  const list = [];
  const a = { kind: 'fragment', id: 1 };
  const b = { kind: 'document', id: 1 };
  let picked = trash.toggleRef(list, a);
  picked = trash.toggleRef(picked, b);
  assert.equal(picked.length, 2, '同 id 不同类型是两条');
  assert.ok(trash.hasRef(picked, a));
  picked = trash.toggleRef(picked, a);
  assert.deepEqual(plain(picked), [{ kind: 'document', id: 1 }], '再点一次就摘掉');
});

test('分组后每类内部按删除时间倒序', () => {
  const now = Date.UTC(2026, 10, 18);
  const grouped = trash.groupTrash([
    { kind: 'fragment', id: 1, title: 'old', detail: '', deletedAt: now - 1000, files: [] },
    { kind: 'fragment', id: 2, title: 'new', detail: '', deletedAt: now, files: [] },
  ]);
  assert.deepEqual(plain(grouped.fragment.map((e) => e.id)), [2, 1]);
  assert.deepEqual(plain(grouped.document), []);
});

/* ------------------------------------------------------------------ */
/* 三、标签：平铺、去重、默认草稿                                        */
/* ------------------------------------------------------------------ */

test('默认标签是「草稿」，而且它只是一个标签', () => {
  assert.equal(docTags.DEFAULT_DOC_TAG, '草稿');
  const authored = read('src/documents/authored.ts');
  assert.ok(authored.includes('DEFAULT_DOC_TAG'), '新建文档要挂上默认标签');
  assert.ok(
    authored.includes('createDocumentWithContent('),
    '新建要走单事务入口：记录、正文、标签分成三个事务会留下「有标题没正文」的空壳',
  );
  const native = read('src/db/repo.native.ts');
  const at = native.indexOf('async createDocumentWithContent');
  const body = native.slice(at, native.indexOf('async updateDocument', at));
  assert.ok(
    body.includes("'library'"),
    '用户定的是自动入库：新建文档直接进库，不要 draft 段',
  );
  const types = read('src/types.ts');
  assert.ok(!/DocStage = '[^']*draft/.test(types), 'DocStage 里不许留 draft —— 没有写入路径的枚举值迟早被人接回来');
});

test('标签名去空白、去 #、压空格，最长 12 字', () => {
  assert.equal(docTags.normalizeTagName('  #工作  '), '工作');
  assert.equal(docTags.normalizeTagName('  报销   单据 '), '报销 单据');
  assert.equal(docTags.normalizeTagName('   '), '');
  assert.equal(docTags.normalizeTagName('#'.repeat(3) + '工作'), '工作');
  assert.equal(docTags.normalizeTagName('一二三四五六七八九十甲乙丙').length, 12);
});

test('同名不同大小写算一个标签，保留第一次的写法', () => {
  assert.deepEqual(plain(docTags.cleanTagNames(['Work', 'work', 'WORK', '生活'])), ['Work', '生活']);
  assert.deepEqual(plain(docTags.cleanTagNames(['', '  ', '#'])), []);
});

/*
 * 全角输入是输入法随手打出来的，不是用户想建第二个标签。
 * 「ＡＩ」和「AI」在列表里长得一模一样，分不出点哪个 —— 所以判重必须折叠全半角。
 * 但**存库仍保留用户的写法**（NAS 不该变成 nas），折叠只用于比较。
 */
test('全角与半角算同一个标签，但保留用户第一次的写法', () => {
  assert.equal(docTags.docTagKey('ＡＩ'), docTags.docTagKey('AI'));
  assert.equal(docTags.docTagKey('Ｗｏｒｋ'), docTags.docTagKey('work'));
  assert.deepEqual(
    plain(docTags.cleanTagNames(['ＡＩ', 'AI', 'ai'])),
    ['ＡＩ'],
    '只留一条，写法取第一次出现的那个',
  );
  // 标点不折叠：「读/写」和「读写」可能是用户有意分开的两件事，合并等于替他做决定
  assert.notEqual(docTags.docTagKey('读/写'), docTags.docTagKey('读写'));
  // 两端的查重必须是同一把尺子，否则「这里认为已存在、那里认为新标签」会生出两条
  for (const file of ['src/db/repo.native.ts', 'src/db/repo.web.ts', 'src/documents/authored.ts']) {
    assert.ok(read(file).includes('docTagKey'), `${file} 的标签查重要走 docTagKey`);
  }
});

test('芯片颜色由名字稳定算出，换设备也一样', () => {
  assert.equal(docTags.tagTone('工作'), docTags.tagTone('工作'));
  assert.ok(docTags.tagTone('工作') >= 0 && docTags.tagTone('工作') < docTags.TAG_TONE_COUNT);
});

test('待确认的标签不参与筛选，也不进文档卡', () => {
  const tags = [
    { id: 1, name: '工作', state: 'approved', createdAt: 0, count: 3 },
    { id: 2, name: 'AI 提的', state: 'pending', createdAt: 0, count: 0 },
  ];
  assert.deepEqual(plain(docTags.visibleTags(tags).map((t) => t.name)), ['工作']);
  const docs = [
    { id: 1, tags },
    { id: 2, tags: [tags[0]] },
  ];
  assert.deepEqual(plain(docTags.filterDocsByTag(docs, 1).map((d) => d.id)), [1, 2]);
  assert.deepEqual(plain(docTags.filterDocsByTag(docs, null).map((d) => d.id)), [1, 2]);
  assert.deepEqual(plain(docTags.filterDocsByTag(docs, 2).map((d) => d.id)), [1], 'pending 标签筛不到东西');
});

test('标签栏按「挂了几篇」倒序，零篇的排后面', () => {
  const sorted = docTags.sortTags([
    { id: 1, name: '少', state: 'approved', createdAt: 0, count: 1 },
    { id: 2, name: '多', state: 'approved', createdAt: 0, count: 9 },
    { id: 3, name: '空', state: 'approved', createdAt: 0, count: 0 },
  ]);
  assert.deepEqual(plain(sorted.map((t) => t.name)), ['多', '少', '空']);
  assert.equal(docTags.tagChipText({ id: 1, name: '工作', state: 'approved', createdAt: 0, count: 3 }), '工作 3');
  assert.equal(docTags.tagChipText({ id: 1, name: '工作', state: 'approved', createdAt: 0, count: 0 }), '工作');
});

/* ------------------------------------------------------------------ */
/* 四、提案：AI 只出建议                                                */
/* ------------------------------------------------------------------ */

test('提案的 payload 宽容读取，多给的字段不会让整条作废', () => {
  const parsed = proposal.parseProposalPayload(JSON.stringify({
    title: '  新标题 ', bodyMd: '正文', tags: ['工作', '工作', ' 生活 '], note: '理顺了顺序', diff: 'xxx',
  }));
  assert.equal(parsed.title, '新标题');
  assert.equal(parsed.bodyMd, '正文');
  assert.deepEqual(plain(parsed.tags), ['工作', '生活']);
  assert.equal(parsed.note, '理顺了顺序');
  assert.deepEqual(plain(proposal.parseProposalPayload('不是 JSON')), {});
  assert.deepEqual(plain(proposal.parseProposalPayload(null)), {});
  // 标签写成字符串也要认（模型经常这么干）
  assert.deepEqual(plain(proposal.parseProposalPayload('{"tags":"工作、生活"}').tags), ['工作', '生活']);
});

test('空 payload 的提案不该出现在审批列表里', () => {
  assert.equal(proposal.isActionable({ kind: 'optimize', payload: {} }), false);
  assert.equal(proposal.isActionable({ kind: 'optimize', payload: { bodyMd: 'x' } }), true);
  assert.equal(proposal.isActionable({ kind: 'tag', payload: { tags: ['a'] } }), true);
  assert.equal(proposal.isActionable({ kind: 'tag', payload: {} }), false);
});

test('派生文档的标题不会叠成「优化 优化」', () => {
  assert.equal(proposal.derivedName('周报（优化）', 'optimize'), '周报（优化）');
  assert.equal(proposal.derivedName('周报', 'optimize'), '周报（优化）');
  assert.equal(proposal.derivedName('周报', 'retag'), '周报（整理）');
  assert.equal(proposal.derivedName('周报', 'optimize', '这周做了什么'), '这周做了什么');
  assert.ok(!proposal.derivedName('周报', 'optimize').includes('优化 优化'));
});

test('审批那句对比要给出字数变化', () => {
  assert.ok(proposal.diffSummary('一二三四', '一二').includes('少 50%'));
  assert.ok(proposal.diffSummary('一二', '一二三四').includes('多 100%'));
  assert.ok(proposal.diffSummary('一二', '一二').includes('字数不变'));
  assert.ok(proposal.diffSummary('', '一二三').includes('3'));
});

test('审批的三个出口都在，且「存为新文档」不写原稿', () => {
  const src = read('src/documents/proposals.ts');
  assert.ok(src.includes("choice === 'tagsOnly' || proposal.kind === 'tag'"), '只有标签的提案不该建文档');
  assert.ok(src.includes("origin: 'knowledge'"), '新文档是知识文档');
  assert.ok(src.includes('originId: original.id'), '新文档要指回原稿');
  assert.ok(src.includes("await repo.setDocumentStage(original.id, 'archived')"), '重新整理把旧的归档');
  assert.ok(src.includes("await repo.decideProposal(proposal.id, 'approved')"), '通过之后要留审计');
  assert.ok(!/deleteDocument\(/.test(src), '审批这条路永远不删东西');
  assert.ok(src.includes('await repo.decideProposal(id, \'rejected\')'), '放弃要留审计');
  // AI 那层不许写库
  const ai = read('src/ai/docEdit.ts');
  assert.ok(!/from '\.\.\/db\//.test(ai), 'AI 层不许 import 数据库 —— 「只出建议」靠这条保住');
});

test('批量是一篇篇过：一次只有一个 running', () => {
  const plan = batch.planBatch('optimize', [
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 3, name: 'c' },
  ]);
  assert.equal(plan.items.length, 3);
  assert.equal(batch.nextBatchItem(plan).documentId, 1);
  let next = batch.patchBatchItem(plan, 1, { state: 'running' });
  assert.equal(batch.nextBatchItem(next).documentId, 1, '跑着的那篇还是它');
  next = batch.patchBatchItem(next, 1, { state: 'review' });
  assert.equal(batch.nextBatchItem(next).documentId, 2, '一篇决定完才轮到下一篇');
  assert.equal(batch.batchRemaining(next), 3, '待审的也算没完');
  assert.equal(batch.batchProgress(next).open, true);
  next = batch.patchBatchItem(next, 1, { state: 'done' });
  assert.equal(batch.batchProgress(next).done, 1);
  next = batch.patchBatchItem(next, 2, { state: 'skipped', note: '还没有正文' });
  next = batch.patchBatchItem(next, 3, { state: 'failed', note: '网络' });
  assert.equal(batch.batchProgress(next).open, false);
  const summary = batch.batchSummary(next);
  assert.ok(summary.includes('存了 1 篇'), '要说存了几篇');
  assert.ok(summary.includes('跳过 1 篇'), '跳过的不能吞掉');
  assert.ok(summary.includes('失败 1 篇'), '失败的更不能吞掉');
});

test('没有正文的文档在批量里安静跳过，不是失败', () => {
  assert.equal(proposal.batchAction('optimize', false), 'skip');
  assert.equal(proposal.batchAction('optimize', true), 'generate');
  // 打标签只看标题也能做
  assert.equal(proposal.batchAction('tag', false), 'generate');
});

/* ------------------------------------------------------------------ */
/* 五、界面：入口与文案                                                 */
/* ------------------------------------------------------------------ */

test('重新整理：正文与标签一起重做，旧的那篇归档', () => {
  const src = read('src/documents/proposals.ts');
  const at = src.indexOf('export async function proposeRetag');
  assert.ok(at > 0, '缺少 proposeRetag —— 「重新整理重打标签」就没有入口');
  const body = src.slice(at, src.indexOf('export type ApproveChoice', at));
  assert.ok(body.includes('withTags: true'), '重新整理要让模型一次给出正文和标签');
  assert.ok(src.includes("insertProposal({ kind: 'retag'"), '提案的 kind 必须是 retag，否则审批时不会归档旧篇');
  const approve = src.slice(src.indexOf('export async function approveProposal'));
  assert.ok(
    approve.includes("if (proposal.kind === 'retag') await repo.setDocumentStage(original.id, 'archived')"),
    'retag 通过后要把旧的那篇归档',
  );
  const viewer = read('src/components/DocViewer.tsx');
  assert.ok(viewer.includes("runAi('retag')"), '阅读器里要有「重新整理」的入口');
  assert.ok(viewer.includes('原稿内容仍然不变'), '归档不等于改原稿，这句话必须说出来');
});

test('批量先问做什么：整理正文 / 打标签', () => {
  const sheet = read('src/components/DocBatchSheet.tsx');
  assert.ok(sheet.includes("planBatch('optimize'"), '要有「整理正文」这条路');
  assert.ok(sheet.includes("planBatch('tag'"), '要有「打标签」这条路');
  assert.ok(sheet.includes('const [kind, setKind] = useState<ProposalKind | null>(null)'), '没选之前不许自己猜一个动作');
  assert.ok(!/useState<BatchPlan>\(\(\) => planBatch/.test(sheet), '计划要等用户选了动作才建');
});

test('新建的碎片不带走别人的图，编辑器里也看不到 img 标记', () => {
  // 从别处粘过来的正文可能带着 `![](img:12)`，它指向**原来那条**碎片的配图；
  // 新碎片里没有那一行，留着就是坏引用（用户 2026-11-19 的「复制过来没有图」）
  assert.equal(inline.stripStoredImageTokens('前文\n\n![](img:12)\n\n后文'), '前文\n\n后文');
  assert.equal(
    inline.stripStoredImageTokens('正文\n![](img:p3)'),
    '正文\n![](img:p3)',
    '这一次要写进去的待发图不能被摘掉',
  );

  const app = read('App.tsx');
  assert.ok(app.includes('stripStoredImageTokens(text)'), '新建碎片的入口要先摘掉外来标记');

  // 编辑器里只留正文，图片交给上面那条配图带
  const detail = read('src/components/FragmentDetail.tsx');
  assert.ok(detail.includes('stripImageTokens(fragment.content)'), '进编辑器时先把图片标记剥掉');
  assert.ok(detail.includes('composeContent(text, fragment.images)'), '保存时按当前图片重新拼回去');
  // 注释里提到 `![](img:12)` 是在解释它是什么，不算「界面上出现」；
  // 真正要钉住的是那套「在光标处插标记」的实现已经删掉
  assert.ok(!detail.includes('insertTokens('), '「加图插在光标处」那套标记插入要删干净');
  assert.ok(!detail.includes('onSelectionChange'), '连光标位置也不用再记了');
});

test('复制一条碎片时图片跟着走', () => {
  const src = read('src/db/duplicate.ts');
  assert.ok(src.includes('saveFragmentImage('), '配图文件要复制一份，不能和原来共用');
  assert.ok(src.includes('removeFragmentImage('), '写库失败要把刚复制出来的图删掉');
  assert.ok(src.includes('insertFragment('), '最后一条记录由 repo 建');
  // 先落文件再写库：反过来会留下「图片行指着不存在的文件」
  assert.ok(
    src.indexOf('saveFragmentImage(') < src.indexOf('repo.insertFragment('),
    '先复制文件，再写记录',
  );
  const detail = read('src/components/FragmentDetail.tsx');
  assert.ok(detail.includes('onDuplicate'), '详情页要有入口');
});

test('文档内嵌图与碎片配图分开认，谁也不吞谁', () => {
  // 碎片的 `img:12` 指向一张配图行；文档的 `doc-img:名` 只是一个文件。
  // 认错一边的后果是「图消失」或「模板串显示成正文」
  assert.equal(inline.docImageNameOfLine('![](img:12)'), null);
  assert.equal(inline.imageIdOfLine('![](doc-img:abc.jpg)'), null);
  assert.equal(inline.docImageNameOfLine('![](doc-img:abc.jpg)'), 'abc.jpg');
  assert.equal(inline.imageIdOfLine('![](img:12)'), 12);
  assert.equal(inline.docImageToken('abc.jpg'), '![](doc-img:abc.jpg)');
  assert.equal(inline.docImageNameOfLine('前面有字 ![](doc-img:abc.jpg)'), null, '行内混排不认，图是块级的');
});

test('文档内嵌图能被解析成图片块，而不是一段乱码', () => {
  const blocks = md.parseBlocks('第一段\n\n![](doc-img:a.jpg)\n\n第二段');
  const kinds = blocks.map((b) => b.kind);
  assert.ok(kinds.includes('image'), '图片行要变成 image 块');
  const pic = blocks.find((b) => b.kind === 'image');
  assert.equal(pic.file, 'a.jpg', '文件名要原样带出来，交给渲染层拼 uri');
  assert.ok(!blocks.some((b) => b.kind === 'p' && b.segs.some((seg) => seg.text.includes('doc-img'))), '不许把标记当正文显示');
});

test('彻底删除文档时要连内嵌图一起删', () => {
  for (const file of ['src/db/repo.native.ts', 'src/db/repo.web.ts']) {
    const text = read(file);
    assert.ok(text.includes('docImageNames('), `${file} 的彻底删除没扫正文里的内嵌图 —— 那些文件会永远留在手机上`);
  }
  // 删行之前必须先读到正文，反过来就什么都读不到了
  const native = read('src/db/repo.native.ts');
  const scanAt = native.indexOf('docImageNames(row.body_md)');
  const dropAt = native.indexOf('DELETE FROM documents WHERE id = ?', scanAt);
  assert.ok(scanAt > 0 && dropAt > scanAt, '先扫正文再删行');
});

test('摘要里不许出现图片标记', () => {
  const util = read('src/util/knowledgeDoc.ts');
  assert.ok(util.includes('doc-img:'), 'excerptOf 要连同文档内嵌图一起去掉');
});

test('回收站入口在设置根页里，不是新开一个底栏项', () => {
  const settings = read('src/screens/SettingsScreen.tsx');
  assert.ok(settings.includes("trash: '回收站'"), '回收站是设置里的一页');
  assert.ok(settings.includes('label="回收站"'), '根页要能点进去');
  assert.ok(settings.includes('<TrashPane'), '回收站面板挂上了');
  /*
   * 用户 2026-11-19：从「数据与备份」里独立到根页。
   * 判据是那一行落在 `pane === 'root'` 的那一段里 —— 只查字符串在不在文件里，
   * 挪回去照样能过。
   */
  const rootAt = settings.indexOf("{pane === 'root' ? (");
  const dataAt = settings.indexOf("{pane === 'data' ? (");
  const rowAt = settings.indexOf('label="回收站"');
  assert.ok(rootAt > 0 && dataAt > rootAt, '根页与数据页两段都要找得到');
  assert.ok(rowAt > rootAt && rowAt < dataAt, '回收站那一行要在根页那一段里（不能又塞回数据页）');
  const tab = read('src/components/TabBar.tsx');
  assert.ok(!tab.includes('回收站'), '底栏只有五项，回收站不该占一格');
});

test('回收站能多选恢复 —— 用户 2026-11-18 明确要求', () => {
  const pane = read('src/components/TrashPane.tsx');
  assert.ok(pane.includes('toggleRef'), '每一行都要能勾');
  assert.ok(pane.includes('全选'), '要能一次全选');
  assert.ok(pane.includes('restoreTrash(picked.map'), '恢复要按一批传，不是逐条');
  assert.ok(pane.includes('purgeTrash(picked.map'), '彻底删除同样是批量的');
  assert.ok(pane.includes('if (!armed) { setArmed(true); return; }'), '彻底删除必须两步确认');
});

test('文档页能把「新建文档」和「添加文件」分开', () => {
  const docs = read('src/screens/DocsScreen.tsx');
  assert.ok(docs.includes('新建文档'), '自己写的入口要写在按钮上');
  // 用户 2026-11-19：两个入口都不带图标 —— 文字本身就是动作
  const at = docs.indexOf('<View style={styles.entryRow}>');
  assert.ok(at > 0, '两个入口还是一行并排');
  const block = docs.slice(at, docs.indexOf('</View>', at));
  assert.ok(!block.includes('Ionicons'), '「添加文件」和「新建文档」前面不许再挂图标');
  assert.ok(block.includes('添加文件') && block.includes('新建文档'), '两个按钮的文字都在');
  assert.ok(docs.includes('<DocEditor'), '编辑器挂上了');
  assert.ok(docs.includes('filterDocsByTag'), '标签筛选用的是共享的纯函数');
  assert.ok(docs.includes('archivedDocs'), '归档要单独一段');
  assert.ok(docs.includes('setBatchFor'), '批量整理入口');
  assert.ok(docs.includes('setTagPick'), '批量改标签入口');
});

test('阅读器里能改正文、改标签、让 AI 出一版', () => {
  const viewer = read('src/components/DocViewer.tsx');
  for (const needle of ['编辑正文', '改标签', '优化', '精简', '打标签', '<ProposalSheet', '<DocEditor']) {
    assert.ok(viewer.includes(needle), `阅读器缺少「${needle}」`);
  }
  assert.ok(viewer.includes("已存为新文档，原稿没有改动"), '存完之后要说清原稿没动');
});

test('删除的文案不许说「无法恢复」', () => {
  for (const file of ['src/screens/DocsScreen.tsx', 'src/screens/AskScreen.tsx', 'src/components/FragmentDetail.tsx']) {
    const text = read(file);
    assert.ok(!/无法恢复|不能撤回/.test(text), `${file} 里还有「无法恢复」的说法，可现在 30 天内都能恢复`);
  }
});

test('写回收站里的行也要被挡住，不只是读', () => {
  /*
   * 上面那条扫描只看 SELECT，而「软删之后又被写进去」全是 UPDATE：
   * 云解析迟到的结果、AI 提案、迟到的会话保存。它们不报错、界面也不显示，
   * 等用户恢复时才看到一份删除那一刻并不存在的内容。
   *
   * v0.36 补上碎片侧漏掉的五条：迟到的读图（setFragmentImageText）、
   * 详情页改正文（updateFragmentContent）、加图（insertFragmentImages）、
   * 整理标记（markFragmentsOrganized / commitDraft）。
   */
  const text = read('src/db/repo.native.ts');
  const check = (fn, needle) => {
    const at = text.indexOf(fn);
    assert.ok(at > 0, `找不到 ${fn}`);
    const end = text.indexOf('\n  async ', at + 10);
    const body = text.slice(at, end > 0 ? end : undefined);
    assert.ok(body.includes(needle), `${fn} 没排除回收站（缺 ${needle}）`);
  };
  check('async updateDocument(', 'deleted_at IS NULL');
  check('async applyTags(', 'deleted_at IS NULL');
  check('async saveAskSession(', 'deleted_at IS NULL');
  // 正文写入的真正落点（repo 方法只是包了一层事务）
  check('function replaceDocumentContentIn(', 'deleted_at IS NULL');

  check('async updateFragmentContent(', 'deleted_at IS NULL');
  check('async insertFragmentImages(', 'deleted_at IS NULL');
  check('async setFragmentImageText(', 'deleted_at IS NULL');
  check('async markFragmentsOrganized(', 'deleted_at IS NULL');

  /*
   * commitDraft 里有两处 deleted_at（会话读取和 organized_at），
   * 所以不能用 body.includes 一刀切 —— 必须钉到那句 UPDATE 上。
   */
  assert.ok(
    /UPDATE fragments SET organized_at = \? WHERE id IN \([^)]*\) AND deleted_at IS NULL/.test(text),
    'commitDraft 的 organized_at 也要挡回收站',
  );
});

test('每一条迁移与它的版本号在同一个事务里', () => {
  /*
   * 迁移里有 `ALTER TABLE ADD COLUMN`，不可重入。两句分开执行时，
   * 进程若在中间被杀，下次启动重跑就报 duplicate column —— 而启动流程
   * 把 init 的错误只 warn 掉，应用会带着半截的库一直跑下去。
   */
  const text = read('src/db/repo.native.ts');
  const at = text.indexOf('function migrate(');
  assert.ok(at > 0, '找不到 migrate');
  const body = text.slice(at, text.indexOf('\n}', at));
  const tx = body.indexOf('withTransactionSync(');
  assert.ok(tx > 0, '迁移要包事务');
  assert.ok(tx < body.indexOf('execSync(MIGRATIONS[i])'), '事务要开在第一条语句之前');
  assert.ok(body.lastIndexOf('PRAGMA user_version') > tx, '版本号要在同一个事务里推进');
});

test('恢复只能给真正恢复成功的那几条重建索引', () => {
  const text = read('src/db/repo.native.ts');
  const at = text.indexOf('async restoreTrash(');
  const body = text.slice(at, text.indexOf('\n  async ', at + 10));
  assert.ok(/SELECT id FROM fragments WHERE id IN \(\$\{ph\}\) AND deleted_at IS NULL/.test(body),
    '按「恢复成功的 id」重查一遍再建索引，否则会给还在回收站的行插索引');
});

if (require.main === module) {
  suite.run().then(({ failed }) => {
    process.exitCode = failed ? 1 : 0;
  }).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
module.exports = { run: suite.run };
