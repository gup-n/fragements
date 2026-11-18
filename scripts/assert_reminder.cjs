#!/usr/bin/env node
/**
 * 小结提醒的**判据**断言。不联网、不碰数据库、不发通知。
 *
 * 这个功能里真正的判断只有「什么时候提醒一次」，其余都是把文案塞进系统通知。
 * 那部分只有装 APK 才知道（通道、权限、点进来落到哪一页），所以这里钉的是：
 * 时刻怎么算、什么时候不该重排、账清了要撤、文案说什么。
 *
 * 另外顺手钉一条仓库卫生：每个断言脚本失败都必须让 CI 红。
 * `assert_ui` 原来的收尾是裸的 `suite.run()` —— 失败照样退出码 0，
 * 那等于这条链上一整组断言从来没拦过东西。
 *
 * 用法：node scripts/assert_reminder.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLoader, createSuite, plain } = require('./test_loader.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const suite = createSuite('小结提醒');
const { test } = suite;

const pure = createLoader();
const plan = pure.load('src/util/digestReminder.ts');
const { REMIND_GAP_MS, nextRemindAt, planDigestReminder, reminderBody, reminderWhenLabel } = plan;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 本地时间构造：断言跑在哪个时区都对，不用硬编码时间戳 */
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

const backlog = (items, total = items.length) => ({
  items: items.map(([period, count]) => ({ period, count, at: 0 })),
  total,
});

test('提醒时刻是「最近的一个晚上 8 点」', () => {
  // 上午 9 点 → 当天 20:00
  assert.equal(nextRemindAt(at(2026, 11, 17, 9)), at(2026, 11, 17, 20));
  // 已经过了 20:00 → 次日 20:00（当天再排就是「立刻响」，那会半夜吓人一跳）
  assert.equal(nextRemindAt(at(2026, 11, 17, 21)), at(2026, 11, 18, 20));
  // 正好 20:00 → 也推到次日。边界算「已经过了」，避免同一秒重复排
  assert.equal(nextRemindAt(at(2026, 11, 17, 20)), at(2026, 11, 18, 20));
  // 跨月
  assert.equal(nextRemindAt(at(2026, 11, 30, 22)), at(2026, 12, 1, 20));
});

test('开关关着：排过的要撤，没排过的什么都不做', () => {
  const now = at(2026, 11, 17, 9);
  assert.deepEqual(
    plain(planDigestReminder({ enabled: false, backlog: backlog([['2026-10', 3]]), storedAt: 0, now })),
    { action: 'keep' },
  );
  assert.deepEqual(
    plain(planDigestReminder({ enabled: false, backlog: backlog([['2026-10', 3]]), storedAt: now + DAY, now })),
    { action: 'cancel' },
  );
});

test('账清了就撤掉排着的那条', () => {
  const now = at(2026, 11, 17, 9);
  assert.deepEqual(
    plain(planDigestReminder({ enabled: true, backlog: { items: [], total: 0 }, storedAt: now + DAY, now })),
    { action: 'cancel' },
  );
  // 没排过 + 没账 = 什么都不用做（别去动系统通知）
  assert.deepEqual(
    plain(planDigestReminder({ enabled: true, backlog: { items: [], total: 0 }, storedAt: 0, now })),
    { action: 'keep' },
  );
});

test('已经排在未来的不重排 —— 否则天天开 App 就永远收不到', () => {
  const now = at(2026, 11, 17, 9);
  assert.deepEqual(
    plain(planDigestReminder({ enabled: true, backlog: backlog([['2026-10', 3]]), storedAt: now + 11 * HOUR, now })),
    { action: 'keep' },
  );
});

test('刚提醒过不到 3 天不再排，3 天之后才重新排', () => {
  const now = at(2026, 11, 17, 9);
  const justFired = now - 6 * HOUR;
  assert.deepEqual(
    plain(planDigestReminder({ enabled: true, backlog: backlog([['2026-10', 3]]), storedAt: justFired, now })),
    { action: 'keep' },
  );
  // 边界：正好 3 天算「可以再提醒」
  assert.equal(
    planDigestReminder({ enabled: true, backlog: backlog([['2026-10', 3]]), storedAt: now - REMIND_GAP_MS, now }).action,
    'schedule',
  );
  const older = now - 4 * DAY;
  const fresh = planDigestReminder({ enabled: true, backlog: backlog([['2026-10', 3]]), storedAt: older, now });
  assert.equal(fresh.action, 'schedule');
  assert.equal(fresh.at, at(2026, 11, 17, 20));
  assert.equal(fresh.period, '2026-10');
  assert.equal(fresh.fragments, 3);
  assert.equal(fresh.months, 1);
});

test('欠好几个月时，正文说最近那个月，再补一句总共几个月', () => {
  const now = at(2026, 11, 17, 9);
  const many = backlog([['2026-10', 14], ['2026-09', 9]], 2);
  const state = planDigestReminder({ enabled: true, backlog: many, storedAt: 0, now });
  assert.equal(state.action, 'schedule');
  assert.equal(state.months, 2);
  assert.equal(reminderBody(state), '2026 年 10 月有 14 条碎片，还没写小结；一共 2 个月欠着');
  assert.equal(
    reminderBody({ period: '2026-10', fragments: 14, months: 1 }),
    '2026 年 10 月有 14 条碎片，还没写小结',
  );
});

test('「下次提醒」的写法：本地时间的月日与时刻', () => {
  assert.equal(reminderWhenLabel(new Date(2026, 10, 18, 20, 0).getTime()), '11 月 18 日 20:00');
  // 补零：8:05 不能写成 8:5
  assert.equal(reminderWhenLabel(new Date(2026, 11, 1, 8, 5).getTime()), '12 月 1 日 08:05');
});

test('通知用固定 id + 定时触发，重复调用只换内容不叠条', () => {
  const src = read('src/digestReminder.ts');
  assert.ok(/export const DIGEST_ID = '.+'/.test(src), '必须有一个固定的通知 id');
  assert.ok(src.includes('identifier: DIGEST_ID'), '排通知时要带上这个 id');
  assert.ok(src.includes('SchedulableTriggerInputTypes.DATE'), '要用定时触发，不是 immediate');
  assert.ok(
    src.includes('cancelScheduledNotificationAsync(DIGEST_ID)'),
    '账清了要撤掉那条，否则用户写完了还会被提醒',
  );
});

test('权限与通道：先要权限再落库，失败把开关弹回去', () => {
  const src = read('src/digestReminder.ts');
  const permAt = src.indexOf('ensureNotifyPermission()');
  const saveAt = src.indexOf("repo.setSetting(SETTING_KEY");
  assert.ok(permAt > 0 && saveAt > permAt, '先要权限再保存开关（开着却发不出来是最糟的状态）');
  assert.ok(src.includes('AndroidImportance.DEFAULT'), '用 DEFAULT：MIN 不出声也不弹，等于没提醒');

  const settings = read('src/screens/SettingsScreen.tsx');
  assert.ok(settings.includes('setDigestReminderEnabled'), '设置页要接到这个开关');
  assert.ok(
    /if \(!res\.ok\) \{\s*setRemindOn\(!next\)/.test(settings),
    '失败要把开关弹回去，不能显示「开着」但其实没开',
  );
  assert.ok(settings.includes('onReminderChange?.()'), '拨完开关要立刻对齐那条通知');
});

test('数据一变就对一次，点通知落到回顾页', () => {
  const app = read('App.tsx');
  assert.ok(app.includes('void syncDigestReminder(list, noteList)'), 'reload 之后要对齐（写到 reload 里）');
  assert.ok(app.includes('onReminderChange={() => syncDigestReminder(fragments, notes)}'), '开关切换也要对齐（并且要把 Promise 交出去，让设置页能等它排完）');
  assert.ok(app.includes('watchDigestReminder(') && app.includes("setRoute('review')"), '点通知要落到回顾页');
  // 落到回顾页还不够：那条通知说的是「该写月总结了」，停在待办等于指错了地方
  assert.ok(
    app.includes("setReviewFocus({ tab: 'note', signal: reviewFocusSeq.current })"),
    '点通知要落到「小结」tab，而不是停在待办',
  );
  const review = read('src/screens/ReviewScreen.tsx');
  assert.ok(review.includes('focusTab?: ReviewTab'), '回顾页要接得住这个 tab');
  assert.ok(
    /if \(!focusTab\) return;\s*setTab\(focusTab\);/.test(review),
    '接住了要真的切过去（只声明 props 不切 tab 等于没接）',
  );
  const watcher = read('src/digestReminder.ts');
  assert.ok(watcher.includes('getLastNotificationResponseAsync'), '冷启动那一次点击要单独捞');
});

test('系统里没了权限要说出原因，不能让开关看着还开着', () => {
  const settings = read('src/screens/SettingsScreen.tsx');
  assert.ok(settings.includes('isQuickRecordBlocked'), '常驻入口也要查（两个开关是同一类问题）');
  assert.ok(settings.includes('digestReminderState'), '提醒要同时拿到 on 与 blocked 两个事实');
  assert.ok(settings.includes('系统里没有通知权限'), '要有一句人话解释去哪儿开');
  assert.ok(
    /\{remindMsg[\s\S]{0,1200}系统里没有通知权限/.test(settings),
    '这句话要落在「通知」那张卡里，而不是飘到别的分区',
  );

  const quick = read('src/quickRecord.ts');
  assert.ok(quick.includes('export async function isQuickRecordBlocked'), '状态判断放模块里，不放界面里');

  const perm = read('src/util/notifyPerm.ts');
  assert.ok(perm.includes('export async function hasNotifyPermission'), '「到底有没有权限」只查一次，只有一份');
  assert.ok(perm.includes('return null'), '查不出来时返回 null，别让界面报假警');
});

test('通知权限的判断只有一份实现', () => {
  const files = ['src/quickRecord.ts', 'src/digestReminder.ts'];
  for (const file of files) {
    const src = read(file);
    assert.ok(src.includes('ensureNotifyPermission'), `${file} 要用共用的权限判断`);
    assert.ok(!src.includes('requestPermissionsAsync'), `${file} 不许再自己问一遍权限`);
  }
});

test('用 createSuite 的断言脚本失败必须让 CI 红', () => {
  /*
   * `createSuite` 的 `run()` 会把用例异常收进返回值里（为了打一份完整报告），
   * 所以裸写 `suite.run();` 的脚本**失败也退出 0** —— 那等于整组断言从来没拦过东西。
   * `assert_ui` 原来就是这样，这一轮补上的。
   *
   * 手写 `ok()` 的脚本（`assert_md`）不用查：它们不接异常，抛出来 node 自然非零退出。
   */
  const dir = path.join(ROOT, 'scripts');
  const scripts = fs.readdirSync(dir).filter((name) => /^assert_.*\.cjs$/.test(name));
  assert.ok(scripts.length >= 8, '找不到断言脚本？目录结构变了');
  for (const name of scripts) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!src.includes('createSuite')) continue;
    assert.ok(
      src.includes('process.exitCode') || src.includes('process.exit(1)'),
      `${name} 用了 createSuite 却没有设置退出码，失败时 CI 会是绿的`,
    );
  }
});

suite.run().then(({ failed }) => { process.exitCode = failed ? 1 : 0; }).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
