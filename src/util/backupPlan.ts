/**
 * 完整备份的**纯函数层**：清单、命名、校验、体积文案。
 *
 * 为什么要拆出来：备份的价值全在「恢复时能不能认出这个包」和
 * 「换了大版本还能不能拒绝」这两件事上，而它们全是判断，不碰文件系统。
 * 放在这里就能用断言证明 —— 真机上没法反复制造「拿错包」的场景。
 *
 * 一条纪律：**恢复只认清单里列过的文件**。zip 里多出来的条目一律不写出去，
 * 否则一个构造过的包可以往私有目录里塞任意路径。
 */

/** 清单格式版本。加字段不算破坏（读方忽略未知字段），改语义才 +1 */
export const MANIFEST_VERSION = 1;
export const APP_ID = 'com.local.fragments';

/** zip 内的固定路径。集中在这里，免得恢复和导出两边各写一份字符串 */
export const ENTRY = {
  manifest: 'manifest.json',
  database: 'database/fragments.db',
  images: 'images/',
  documents: 'documents/',
} as const;

export interface BackupCounts {
  fragments: number;
  images: number;
  documents: number;
}

export interface BackupManifest {
  app: string;
  manifestVersion: number;
  /** 备份时刻（毫秒） */
  createdAt: number;
  /** 生成它的 App 版本，只用来提示，不参与校验 */
  appVersion: string;
  /** 数据库 PRAGMA user_version。恢复时不能高于当前 App 支持的版本 */
  schemaVersion: number;
  counts: BackupCounts;
  /** zip 内的相对路径，恢复只认这些 */
  files: string[];
}

const stamp = (now: number) => {
  const d = new Date(now);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}`;
};

/**
 * 备份文件名。**不用中文**：部分分享器/文件管理器对中文附件名的处理不一致，
 * 名字在分享出去之后还要被人认出来，英文 + 日期最稳。
 */
export function backupFileName(now: number, appVersion: string): string {
  const v = appVersion.replace(/[^\d.]/g, '') || '0';
  return `fragments-backup-v${v}-${stamp(now)}.zip`;
}

/** 恢复前那份「当前库」的安全副本名。它只是本地文件，可以带路径语义 */
export function safetyCopyName(now: number): string {
  return `pre-restore-${stamp(now)}.db`;
}

export function makeManifest(input: {
  now: number;
  appVersion: string;
  schemaVersion: number;
  counts: BackupCounts;
  imageNames: string[];
  documentNames: string[];
}): BackupManifest {
  return {
    app: APP_ID,
    manifestVersion: MANIFEST_VERSION,
    createdAt: input.now,
    appVersion: input.appVersion,
    schemaVersion: input.schemaVersion,
    counts: input.counts,
    files: [
      ENTRY.database,
      ...input.imageNames.map((n) => `${ENTRY.images}${n}`),
      ...input.documentNames.map((n) => `${ENTRY.documents}${n}`),
    ],
  };
}

export type ManifestCheck =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; reason: string };

/**
 * 恢复前校验。四种拒绝，都给出人话，不让人猜：
 * - 不是这个 App 的备份（只认包名）；
 * - 清单格式比本机新（本机读不懂它的字段）；
 * - 数据库版本比本机 App 新（迁移只能往前，不能往回）；
 * - 清单里没有数据库（空包/被删改过）。
 */
export function checkManifest(raw: unknown, currentSchema: number): ManifestCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '备份包里没有清单，可能不是备份文件' };
  const m = raw as Partial<BackupManifest>;
  if (m.app !== APP_ID) return { ok: false, reason: '这不是「碎片」的备份' };
  if (typeof m.manifestVersion !== 'number' || m.manifestVersion > MANIFEST_VERSION) {
    return { ok: false, reason: '备份格式比当前版本新，请先把 App 升级到最新' };
  }
  if (typeof m.schemaVersion !== 'number') return { ok: false, reason: '备份里缺数据库版本，无法确认能否恢复' };
  if (m.schemaVersion > currentSchema) {
    return {
      ok: false,
      reason: `这份备份来自更新的版本（库 v${m.schemaVersion}，本机只到 v${currentSchema}），升级 App 后再恢复`,
    };
  }
  const files = Array.isArray(m.files) ? m.files.filter((x): x is string => typeof x === 'string') : [];
  if (!files.includes(ENTRY.database)) return { ok: false, reason: '备份里没有数据库文件' };
  const counts = m.counts && typeof m.counts === 'object' ? m.counts : ({} as BackupCounts);
  return {
    ok: true,
    manifest: {
      app: APP_ID,
      manifestVersion: m.manifestVersion ?? MANIFEST_VERSION,
      createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
      appVersion: typeof m.appVersion === 'string' ? m.appVersion : '',
      schemaVersion: m.schemaVersion,
      counts: {
        fragments: num(counts.fragments),
        images: num(counts.images),
        documents: num(counts.documents),
      },
      files,
    },
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * 解压清单里允许写出去的文件。
 *
 * 两道过滤都是为了「不在恢复时被 zip 里的名字牵着走」：
 * 只认清单列过的条目；路径里的 `..` 和绝对路径一律拒绝。
 */
export function planRestoreEntries(
  manifest: BackupManifest,
  available: string[],
): { database: string | null; images: string[]; documents: string[]; missing: string[] } {
  const set = new Set(available);
  const images: string[] = [];
  const documents: string[] = [];
  const missing: string[] = [];
  let database: string | null = null;

  for (const raw of manifest.files) {
    const path = raw.replace(/\\/g, '/').trim();
    if (!path || path.includes('..') || path.startsWith('/') || path.includes(':')) {
      missing.push(raw);
      continue;
    }
    if (!set.has(path)) {
      missing.push(path);
      continue;
    }
    if (path === ENTRY.database) {
      database = path;
      continue;
    }
    /*
     * 剥掉目录前缀之后剩下的必须是**一个文件名**。
     * `images//etc/x.jpg` 剥完是 `/etc/x.jpg` —— 它既不是 `..` 也不以斜杠开头，
     * 只看前缀就会把它当成图片名写出去。所以这里再查一次斜杠和点开头。
     */
    const bucket = path.startsWith(ENTRY.images)
      ? ENTRY.images
      : path.startsWith(ENTRY.documents)
        ? ENTRY.documents
        : null;
    if (!bucket) {
      missing.push(path);
      continue;
    }
    const name = path.slice(bucket.length);
    if (!name || name.includes('/') || name.startsWith('.')) {
      missing.push(path);
      continue;
    }
    if (bucket === ENTRY.images) images.push(name);
    else documents.push(name);
  }
  return { database, images: images.filter(Boolean), documents: documents.filter(Boolean), missing };
}

/** SQLite 文件头。恢复前要看一眼，别把一张图片当成数据库写进去 */
export function looksLikeSqlite(head: Uint8Array): boolean {
  const magic = 'SQLite format 3\u0000';
  if (head.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (head[i] !== magic.charCodeAt(i)) return false;
  return true;
}

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/**
 * 一次性把多大的内容读进内存。
 *
 * 打包走的是 `zipSync`（全内存），所以必须在开始之前就知道会不会炸：
 * 安卓上 200 MB 的图片库读进来再加一份 zip 输出，很容易被系统杀掉。
 * 超过阈值就拒绝，并告诉用户改用 Markdown 文字迁出。
 */
export const BACKUP_SIZE_LIMIT = 300 * 1024 * 1024;

export function overSizeLimit(totalBytes: number): boolean {
  return totalBytes > BACKUP_SIZE_LIMIT;
}
