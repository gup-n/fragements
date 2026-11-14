/**
 * 完整本地备份的**文件层**：把库、配图、文档原件打进一个 zip，以及反过来恢复。
 *
 * 为什么单独一层：它要同时碰三处存储（SQLite 文件、`fragment-images/`、
 * `documents/`），而每一处都有自己的坑（WAL 未落盘、`file://` 前缀、
 * 目录不存在）。混进页面里必然只做对一半。
 *
 * 两条纪律：
 * 1. **导出用 `VACUUM INTO` 拿快照**，不直接拷 `fragments.db` —— 应用在跑，
 *    主文件里可能少最近几条。
 * 2. **恢复前先留一份当前库**（`backups/pre-restore-*.db`）。覆盖是不可逆的，
 *    用户点错一次也不该丢掉全部记录。
 */
import { Directory, File, Paths } from 'expo-file-system';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  BACKUP_SIZE_LIMIT,
  ENTRY,
  backupFileName,
  checkManifest,
  humanBytes,
  looksLikeSqlite,
  makeManifest,
  overSizeLimit,
  planRestoreEntries,
  safetyCopyName,
  type BackupCounts,
  type BackupManifest,
} from '../util/backupPlan';

const DB_DIR = 'SQLite';
const DB_NAME = 'fragments.db';
const IMG_DIR = 'fragment-images';
const DOC_DIR = 'documents';
/** 恢复前的安全副本。不进备份包，只在本地留着后悔药 */
const SAFETY_DIR = 'backups';

/** `file:///data/...` → `/data/...`。SQLite 的路径参数不认 URI 前缀 */
const fsPath = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));

interface Collected {
  name: string;
  bytes: Uint8Array;
  size: number;
}

async function collect(dir: Directory): Promise<Collected[]> {
  if (!dir.exists) return [];
  const out: Collected[] = [];
  for (const item of dir.list()) {
    if (!(item instanceof File)) continue;
    try {
      const bytes = await item.bytes();
      out.push({ name: item.name, bytes, size: bytes.byteLength });
    } catch {
      /*
       * 单个文件读不出来不该毁掉整次备份 —— 但要让它「缺」得看得见：
       * 记一条空名字不现实，所以跳过并在 counts 里少算一个。
       * 用户看到的条数来自数据库，差异就是这里丢的。
       */
    }
  }
  return out;
}

export interface BackupDeps {
  appVersion: string;
  counts: BackupCounts;
  /** 由 repo 提供：把当前库写成一致快照 */
  snapshot: (targetFsPath: string) => void;
  /** 库当前迁移版本 */
  schemaVersion: () => number;
}

export interface BackupResult {
  uri: string;
  name: string;
  bytes: number;
  counts: BackupCounts;
}

export async function createBackup(deps: BackupDeps): Promise<BackupResult> {
  const now = Date.now();
  const work = new Directory(Paths.cache, `bk-${now}`);
  work.create({ intermediates: true, idempotent: true });
  try {
    const dbFile = new File(work, DB_NAME);
    if (dbFile.exists) dbFile.delete();
    deps.snapshot(fsPath(dbFile.uri));
    if (!dbFile.exists) throw new Error('没能生成数据库快照，请重试一次');
    const dbBytes = await dbFile.bytes();

    const images = await collect(new Directory(Paths.document, IMG_DIR));
    const documents = await collect(new Directory(Paths.document, DOC_DIR));
    const total =
      dbBytes.byteLength +
      images.reduce((n, f) => n + f.size, 0) +
      documents.reduce((n, f) => n + f.size, 0);
    if (overSizeLimit(total)) {
      throw new Error(
        `这次要打包 ${humanBytes(total)}，超过单次上限 ${humanBytes(
          BACKUP_SIZE_LIMIT,
        )}。可以先删掉一些大文档，或者用「导出 Markdown」只搬文字。`,
      );
    }

    const manifest = makeManifest({
      now,
      appVersion: deps.appVersion,
      schemaVersion: deps.schemaVersion(),
      counts: deps.counts,
      imageNames: images.map((f) => f.name),
      documentNames: documents.map((f) => f.name),
    });

    const entries: Record<string, Uint8Array> = {
      [ENTRY.manifest]: strToU8(JSON.stringify(manifest, null, 2)),
      [ENTRY.database]: dbBytes,
    };
    for (const f of images) entries[`${ENTRY.images}${f.name}`] = f.bytes;
    for (const f of documents) entries[`${ENTRY.documents}${f.name}`] = f.bytes;

    /*
     * level 1：图与 PDF 本来就是压缩过的，再压只在日志和小文本上有效，
     * 而高压缩级别会让几十 MB 的包多等十几秒。这一层求的是「别太久」。
     */
    const zip = zipSync(entries, { level: 1 });

    const name = backupFileName(now, deps.appVersion);
    const out = new File(Paths.cache, name);
    if (out.exists) out.delete();
    out.create();
    await out.write(zip);
    return { uri: out.uri, name, bytes: zip.byteLength, counts: deps.counts };
  } finally {
    try {
      work.delete();
    } catch {
      /* 临时目录清不掉不影响结果，cache 会被系统回收 */
    }
  }
}

/**
 * 只读清单，不动任何数据。
 *
 * 恢复是不可逆的，所以「这份包里到底是什么」必须在**按下去之前**就说清楚：
 * 哪天的包、多少条、来自哪个版本。先看一眼再确认，比事后后悔便宜。
 */
export async function peekBackup(
  zipUri: string,
  currentSchema: number,
): Promise<{ manifest: BackupManifest; bytes: number; blockedReason: string | null }> {
  const bytes = await new File(zipUri).bytes();
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('这个文件解不开，可能不是备份包，或者传输时损坏了');
  }
  let raw: unknown = null;
  try {
    raw = entries[ENTRY.manifest] ? JSON.parse(strFromU8(entries[ENTRY.manifest])) : null;
  } catch {
    throw new Error('备份包里的清单读不出来，这个包可能被改过');
  }
  const check = checkManifest(raw, currentSchema);
  if (!check.ok) throw new Error(check.reason);
  const missing = planRestoreEntries(check.manifest, Object.keys(entries)).missing;
  return {
    manifest: check.manifest,
    bytes: bytes.byteLength,
    // 清单里列了但包里没有：允许恢复，但必须提前说「这次恢复不完整」
    blockedReason: missing.length ? `备份里缺 ${missing.length} 个文件，恢复后会缺这些内容` : null,
  };
}

export interface RestoreDeps {
  snapshot: (targetFsPath: string) => void;
  close: () => void;
  schemaVersion: () => number;
  /** 替换完文件后重新打开并跑迁移 */
  reopen: () => Promise<void>;
}

export interface RestoreResult {
  counts: BackupCounts;
  /** 覆盖前那份当前库的文件名，界面要如实告诉用户它在哪 */
  safetyName: string;
  safetyBytes: number;
  missing: string[];
}

export async function restoreBackup(zipUri: string, deps: RestoreDeps): Promise<RestoreResult> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(await new File(zipUri).bytes());
  } catch {
    throw new Error('这个文件解不开，可能不是备份包，或者传输时损坏了');
  }

  let raw: unknown = null;
  try {
    raw = entries[ENTRY.manifest] ? JSON.parse(strFromU8(entries[ENTRY.manifest])) : null;
  } catch {
    throw new Error('备份包里的清单读不出来，这个包可能被改过');
  }
  const check = checkManifest(raw, deps.schemaVersion());
  if (!check.ok) throw new Error(check.reason);

  const plan = planRestoreEntries(check.manifest, Object.keys(entries));
  if (!plan.database) throw new Error('备份里没有数据库文件');
  const dbBytes = entries[plan.database];
  if (!looksLikeSqlite(dbBytes)) throw new Error('备份里的数据库文件已损坏，拒绝覆盖当前数据');

  // ---- 先留恢复点，再动任何东西 ----
  const safetyDir = new Directory(Paths.document, SAFETY_DIR);
  safetyDir.create({ intermediates: true, idempotent: true });
  const safetyName = safetyCopyName(Date.now());
  const safetyFile = new File(safetyDir, safetyName);
  if (safetyFile.exists) safetyFile.delete();
  deps.snapshot(fsPath(safetyFile.uri));
  const safetyBytes = safetyFile.exists ? safetyFile.info().size ?? 0 : 0;

  // ---- 替换数据库 ----
  deps.close();
  const dbDir = new Directory(Paths.document, DB_DIR);
  dbDir.create({ intermediates: true, idempotent: true });
  /*
   * WAL / SHM 必须一起删。留着它们再放进一个新主库，SQLite 会把旧日志
   * 往新库上重放 —— 那是能把库写坏的组合。
   */
  for (const suffix of ['-wal', '-shm']) {
    const side = new File(dbDir, `${DB_NAME}${suffix}`);
    if (side.exists) side.delete();
  }
  const target = new File(dbDir, DB_NAME);
  if (target.exists) target.delete();
  target.create();
  await target.write(dbBytes);

  // ---- 图片与文档：按清单写回，同名的覆盖，别的保留 ----
  const imgDir = new Directory(Paths.document, IMG_DIR);
  imgDir.create({ intermediates: true, idempotent: true });
  for (const name of plan.images) {
    const data = entries[`${ENTRY.images}${name}`];
    if (!data) continue;
    const f = new File(imgDir, name);
    if (f.exists) f.delete();
    f.create();
    await f.write(data);
  }
  const docDir = new Directory(Paths.document, DOC_DIR);
  docDir.create({ intermediates: true, idempotent: true });
  for (const name of plan.documents) {
    const data = entries[`${ENTRY.documents}${name}`];
    if (!data) continue;
    const f = new File(docDir, name);
    if (f.exists) f.delete();
    f.create();
    await f.write(data);
  }

  await deps.reopen();
  return { counts: check.manifest.counts, safetyName, safetyBytes, missing: plan.missing };
}

/** 恢复点列表：设置页要能看到「上一份库还在哪」 */
export function listSafetyCopies(): { name: string; bytes: number; at: number }[] {
  const dir = new Directory(Paths.document, SAFETY_DIR);
  if (!dir.exists) return [];
  const out: { name: string; bytes: number; at: number }[] = [];
  for (const item of dir.list()) {
    if (!(item instanceof File)) continue;
    try {
      const info = item.info();
      out.push({ name: item.name, bytes: info.size ?? 0, at: info.modificationTime ?? 0 });
    } catch {
      /* 读不到就跳过 —— 列不出来比列错更安全 */
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
