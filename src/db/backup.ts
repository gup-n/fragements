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
    if (!(item instanceof File) || !/^pre-(restore|migrate)-/.test(item.name) || !item.name.endsWith('.db')) continue;
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

/* ------------------------------------------------------------------ *
 * 恢复的中间态与启动兜底
 *
 * 恢复不是「删掉主库再写一份」：中途磁盘满、迁移报错或进程被杀，
 * 库里就没有一份可用的主文件；下次启动会 open 出一个空库再迁移，
 * 用户看到的是一份空记录 —— 而 `backups/` 里的恢复点没有任何入口。
 *
 * 现在的顺序是「先写 .new → 旧库改名 .old → .new 换名成主库 → 重新打开并迁移」。
 * 每一步都只做一次改名，窗口很短；启动时 `recoverInterruptedRestore()`
 * 会把「主库不在、.old 还在」这种半截态退回去。
 * ------------------------------------------------------------------ */

const DB_OLD = `${DB_NAME}.old`;
const DB_NEW = `${DB_NAME}.new`;

function dbDir(): Directory {
  const dir = new Directory(Paths.document, DB_DIR);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function sidecar(base: string, suffix: '-wal' | '-shm'): File {
  return new File(Paths.document, DB_DIR, `${base}${suffix}`);
}

function deleteSidecars(base: string): void {
  for (const suffix of ['-wal', '-shm'] as const) {
    const file = sidecar(base, suffix);
    if (file.exists) file.delete();
  }
}

/** 把 `fromBase` 的 WAL/SHM 跟着主库一起改名。SQLite 的副文件名跟着主库名走 */
function moveSidecars(fromBase: string, toBase: string): void {
  for (const suffix of ['-wal', '-shm'] as const) {
    const from = sidecar(fromBase, suffix);
    if (!from.exists) continue;
    const to = sidecar(toBase, suffix);
    if (to.exists) to.delete();
    from.moveSync(to, { overwrite: true });
  }
}

/**
 * 启动时收拾上一次恢复留下的中间文件。**必须在 `db()` 打开之前调用。**
 *
 * 三种半截态：
 * - 主库在：`.new` 是上次没换进去的残留，删掉；`.old` 留到迁移成功后再删。
 * - 主库不在、`.old` 在：改名到一半被杀，退回旧库（保守，宁可用恢复前的）。
 * - 主库不在、只有 `.new`：第一次恢复在换名前被杀，`.new` 已经是完整库，换进来。
 */
export function recoverInterruptedRestore(): void {
  const dir = new Directory(Paths.document, DB_DIR);
  if (!dir.exists) return;
  const live = new File(dir, DB_NAME);
  const old = new File(dir, DB_OLD);
  const next = new File(dir, DB_NEW);
  const liveSize = live.exists ? live.info().size ?? 0 : 0;

  if (liveSize === 0) {
    if (old.exists) {
      if (live.exists) live.delete();
      old.moveSync(live, { overwrite: true });
      moveSidecars(DB_OLD, DB_NAME);
    } else if (next.exists) {
      next.moveSync(live, { overwrite: true });
    }
  } else if (next.exists) {
    next.delete();
  }
}

/** 迁移失败时把旧库换回来。只在启动兜底里用；返回是否真的换回了 */
export function restoreOldDatabase(): boolean {
  const dir = new Directory(Paths.document, DB_DIR);
  if (!dir.exists) return false;
  const live = new File(dir, DB_NAME);
  const old = new File(dir, DB_OLD);
  if (!old.exists) return false;
  try {
    if (live.exists) live.delete();
    old.moveSync(live, { overwrite: true });
    moveSidecars(DB_OLD, DB_NAME);
    return true;
  } catch {
    return false;
  }
}

/** 启动与迁移都成功之后清掉恢复中间件。`.old` 只是恢复窗口里的回退点 */
export function cleanupRestoreLeftovers(): void {
  const dir = new Directory(Paths.document, DB_DIR);
  if (!dir.exists) return;
  for (const name of [DB_NEW, DB_OLD, `${DB_OLD}-wal`, `${DB_OLD}-shm`]) {
    const file = new File(dir, name);
    if (file.exists) file.delete();
  }
}

/** 安全副本名。同一秒里连续恢复两次时不要覆盖上一份 */
function uniqueSafetyName(dir: Directory, now: number): string {
  const base = safetyCopyName(now).replace(/\.db$/, '');
  let name = `${base}.db`;
  for (let i = 1; new File(dir, name).exists; i++) name = `${base}-${i}.db`;
  return name;
}

/** 只留最近 5 份恢复点；刚生成的那份永远保留 */
function pruneSafetyCopies(dir: Directory, keepName: string): void {
  const list = dir.list().filter((item): item is File => item instanceof File && item.name.endsWith('.db'));
  list.sort((a, b) => (b.info().modificationTime ?? 0) - (a.info().modificationTime ?? 0));
  for (const file of list.slice(5)) {
    if (file.name === keepName) continue;
    try { file.delete(); } catch { /* 删不掉只是多占一点空间 */ }
  }
}

async function stageBytes(bytes: Uint8Array): Promise<File> {
  const dir = dbDir();
  const next = new File(dir, DB_NEW);
  if (next.exists) next.delete();
  next.create({ overwrite: true });
  await next.write(bytes);
  return next;
}

function assertStagedSqlite(next: File): void {
  if (!next.exists || (next.info().size ?? 0) <= 0) throw new Error('没能写出新的数据库文件，请重试');
}

/**
 * 把已经写好的 `fragments.db.new` 换进来。
 *
 * **调用前数据库必须是打开的**（这里要 close）。失败时尽力退回旧库并重新打开；
 * 回退也失败时把 `.old` 留在磁盘上，交给下次启动的 `recoverInterruptedRestore()`。
 */
async function swapStagedDatabase(deps: RestoreDeps): Promise<void> {
  const dir = dbDir();
  const live = new File(dir, DB_NAME);
  const old = new File(dir, DB_OLD);
  const next = new File(dir, DB_NEW);
  assertStagedSqlite(next);

  deps.close();
  let oldMoved = false;
  try {
    if (live.exists) {
      // 先清掉上一次可能留下的 .old，避免下面改名失败时把陌生文件当成回退点
      if (old.exists) old.delete();
      live.moveSync(old, { overwrite: true });
      oldMoved = true;
      moveSidecars(DB_NAME, DB_OLD);
    } else {
      deleteSidecars(DB_NAME);
    }
    next.moveSync(live, { overwrite: true });
    await deps.reopen();
  } catch (e) {
    // 迁移失败时连接还开着：先关掉，否则删/换主库文件会踩到已打开的句柄
    deps.close();
    try {
      if (oldMoved && old.exists) {
        // 旧库已经移走：删掉可能半截的新主库，把旧库换回来
        if (live.exists) live.delete();
        deleteSidecars(DB_NAME);
        old.moveSync(live, { overwrite: true });
        moveSidecars(DB_OLD, DB_NAME);
      } else {
        // 旧库还没动过（改名失败）：主库就是当前库，删的只能是暂存文件
        if (next.exists) next.delete();
      }
    } catch {
      /* 回退也失败：.old 留在磁盘上，下次启动 recoverInterruptedRestore 会用它 */
    }
    try { await deps.reopen(); } catch { /* 下面把「重启应用」说清楚 */ }
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`恢复没有完成，当前数据已保留；如果界面仍不可用，请重启应用再试（${reason}）`);
  }

  // 成功：旧库与它的副文件都可以删了（恢复点还在 backups/ 里）
  deleteSidecars(DB_OLD);
  try { if (old.exists) old.delete(); } catch { /* 下次启动的 cleanup 会删 */ }
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
  const safetyName = uniqueSafetyName(safetyDir, Date.now());
  const safetyFile = new File(safetyDir, safetyName);
  deps.snapshot(fsPath(safetyFile.uri));
  const safetyBytes = safetyFile.exists ? safetyFile.info().size ?? 0 : 0;

  /*
   * ---- 图片与文档：先写，再换库 ----
   * 反过来的话，换库成功、写文件失败，库里会指向一批不存在的原件。
   * 先写文件最坏只是「旧库看到几个新文件」——它们本身都是合法文件。
   * 同名覆盖，别的保留。
   */
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

  // ---- 新库先完整写到 .new，再换名 ----
  const next = await stageBytes(dbBytes);
  assertStagedSqlite(next);
  await swapStagedDatabase(deps);
  return { counts: check.manifest.counts, safetyName, safetyBytes, missing: plan.missing };
}

/**
 * 升级前留一份库快照（v0.36，F-01）。
 *
 * 迁移本身包在事务里，但事务只保证「要么全成、要么全败」；
 * 迁移语句写坏了数据（v7/v11 有 DELETE/UPDATE）提交之后就不可逆。
 * 所以在跑迁移之前 `VACUUM INTO` 一份，失败就**不要迁移** —— 宁可这次不开，
 * 也不带病开。快照与恢复点同一目录，设置页能看到、能恢复。
 *
 * 返回快照文件名；版本为 0（新库）或无需迁移时返回 null。
 */
export function snapshotBeforeMigration(
  fromVersion: number,
  snapshot: (targetFsPath: string) => void,
): string | null {
  if (fromVersion <= 0) return null;
  const dir = new Directory(Paths.document, SAFETY_DIR);
  dir.create({ intermediates: true, idempotent: true });
  const base = safetyCopyName(Date.now())
    .replace('pre-restore-', `pre-migrate-v${fromVersion}-`)
    .replace(/\.db$/, '');
  let name = `${base}.db`;
  for (let i = 1; new File(dir, name).exists; i++) name = `${base}-${i}.db`;
  const file = new File(dir, name);
  snapshot(fsPath(file.uri));
  pruneSafetyCopies(dir, name);
  return name;
}

/**
 * 从「恢复点」（`backups/pre-restore-*.db`）恢复。
 *
 * 这是给设置页那个「后悔药」列表用的：先再留一份当前库，再用选中的旧库覆盖。
 * 文件与 zip 恢复走同一套换名逻辑，失败退款路径也一致。
 */
export async function restoreSafetyCopy(
  name: string,
  deps: RestoreDeps,
): Promise<{ safetyName: string; safetyBytes: number }> {
  if (name.includes('/') || name.includes('\\') || !/^pre-(restore|migrate)-/.test(name) || !name.endsWith('.db')) {
    throw new Error('恢复点文件名不合法');
  }
  const safetyDir = new Directory(Paths.document, SAFETY_DIR);
  const source = new File(safetyDir, name);
  if (!source.exists) throw new Error('这份恢复点已经不在了');
  /*
   * 不读前 16 字节做 header 校验：`File.slice().bytes()` 在不同平台上的
   * Blob 实现不一致，而恢复点是我们自己用 VACUUM INTO 写的。
   * 大小为零直接拒；真坏了，迁移失败会回退到当前库。
   */
  if ((source.info().size ?? 0) <= 0) throw new Error('这份恢复点是空文件，拒绝覆盖当前数据');

  // 先留一份当前库，恢复点本身也可能是唯一一份
  safetyDir.create({ intermediates: true, idempotent: true });
  const safetyName = uniqueSafetyName(safetyDir, Date.now());
  const safetyFile = new File(safetyDir, safetyName);
  deps.snapshot(fsPath(safetyFile.uri));
  const safetyBytes = safetyFile.exists ? safetyFile.info().size ?? 0 : 0;

  const dir = dbDir();
  const next = new File(dir, DB_NEW);
  if (next.exists) next.delete();
  await source.copy(next, { overwrite: true });
  assertStagedSqlite(next);
  pruneSafetyCopies(safetyDir, safetyName);

  await swapStagedDatabase(deps);
  return { safetyName, safetyBytes };
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
