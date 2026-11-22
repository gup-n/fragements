/**
 * 系统「分享」进来的内容。
 *
 * 原生那半边见 `plugins/withShareReceiver.js`：MainActivity 收到 `ACTION_SEND`
 * （或一次选多张的 `ACTION_SEND_MULTIPLE`）就把文字和文件落到 `files/incoming/`，
 * 再写一份 `incoming-share.json`。这里只负责**读出来并消费一次**。
 *
 * 为什么要记 `share_last_at`：分享进来的内容会一直躺在那份 json 里，
 * 每次启动都读一遍就会重复弹出同一条。用时间戳做幂等键 —— 比删文件稳，
 * 删文件删到一半失败的场景不用再考虑。
 *
 * v0.25 起 json 里是 `files: [{file, name}]`。旧版只写一个 `file`/`name`，
 * 那种 json 可能还在磁盘上（升级前分享、升级后才打开 App），所以读的时候两条路都认。
 */
import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { repo } from './db/repo';

const DIR = 'incoming';
const JSON_NAME = 'incoming-share.json';
const LAST_KEY = 'share_last_at';

export interface IncomingFile {
  /** 磁盘上的安全名（`incoming/` 下）。清理时用这个，不是 `name` */
  disk: string;
  /**
   * 文件的**原始文件名**（中文、空格都在）。`disk` 是 ASCII 安全化过的，
   * 入库和显示都必须用这个 —— 把 `2026-11-15T…-0-____.docx` 当文档名给用户看是错的。
   */
  name: string;
  /** 能直接交给 <Image> / 导入链路的绝对 uri */
  uri: string;
  /** 图片单独走「存成一条碎片」，其余进文档库 */
  kind: 'image' | 'other';
}

export interface IncomingShare {
  at: number;
  /**
   * 消费前那个幂等键的值。
   *
   * 读取时就把键推进到 `at`（否则同一条会被反复弹出），但如果后面**一份文件都没处理成功**，
   * 必须把它退回来，否则这次分享就永远读不到了 —— 文件还在私有目录里，界面上却什么都没有，
   * 那是「静默丢内容」，比重复一条严重得多。见 `rewindIncomingShare`。
   */
  prevAt: number;
  mime: string;
  /** 分享时带的文字（微信分享图片常带一句描述，也可能为空） */
  text: string;
  /** 已复制到私有目录的文件，可能 0 个（纯文字分享）或好几个（多选分享） */
  files: IncomingFile[];
  /** 因为太大/太多/复制失败被跳过的条目。界面要说出来，不能静默少几项 */
  skipped: { name: string; reason: string }[];
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i;

/**
 * 类型判断以 mime 为主、扩展名为辅：微信分享图片时 mime 有时是
 * `application/octet-stream`，只看 mime 会把一张图当成「其它文件」拒掉。
 */
function kindOf(mime: string, ...names: string[]): IncomingFile['kind'] {
  if (mime.startsWith('image/')) return 'image';
  return names.some((name) => IMAGE_EXT.test(name)) ? 'image' : 'other';
}

/**
 * 取出一次分享。没有新的就返回 null。
 *
 * 判定「新」用的是 `at > 上次处理的时间戳`，并且**先落库再返回** ——
 * 反过来的话，读取过程中用户切走，下次启动会把同一条当新的再来一次。
 */
async function readPayload(): Promise<Record<string, unknown> | null> {
  let raw = '';
  try {
    const json = new File(Paths.document, DIR, JSON_NAME);
    if (!json.exists) return null;
    raw = await json.text();
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function takeIncomingShare(): Promise<IncomingShare | null> {
  if (Platform.OS !== 'android') return null;

  let parsed = await readPayload();
  if (!parsed) return null;

  const at = typeof parsed.at === 'number' ? parsed.at : 0;
  if (!at) return null;

  /*
   * 原生把复制放在后台线程，先写一份 copying=true 的占位。这里等它收尾：
   * 最多 12 秒；占位超过 60 秒还停着，说明上次进程被杀在半路，直接放弃。
   * 不等待的话，大文件分享会在「文件列表还是空」的那一刻被消费掉，等于丢了。
   */
  for (let i = 0; i < 40 && parsed?.copying === true; i++) {
    if (Date.now() - at > 60_000) return null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    parsed = await readPayload();
  }
  if (!parsed || parsed.copying === true) return null;

  let last = 0;
  try {
    last = Number(await repo.getSetting(LAST_KEY)) || 0;
  } catch {
    last = 0;
  }
  if (at <= last) return null;

  try {
    await repo.setSetting(LAST_KEY, String(at));
  } catch {
    /* 记不上就会重复消费一次，比丢内容好 */
  }

  const mime = typeof parsed.mime === 'string' ? parsed.mime : '';
  const text = typeof parsed.text === 'string' ? parsed.text : '';

  /**
   * 逐条把磁盘名换成可用的 uri。
   *
   * 文件已经被系统清掉的条目直接跳过：留着一条 `uri` 指向不存在文件的记录，
   * 后面导入时才失败，错误信息会指向「导入」，而不是「文件不在了」。
   */
  const pick = (disk: unknown, name: unknown): IncomingFile | null => {
    if (typeof disk !== 'string' || !disk) return null;
    try {
      const f = new File(Paths.document, DIR, disk);
      if (!f.exists) return null;
      const shown = typeof name === 'string' && name ? name : disk;
      return { disk, name: shown, uri: f.uri, kind: kindOf(mime, shown, disk) };
    } catch {
      return null;
    }
  };

  const files: IncomingFile[] = [];
  if (Array.isArray(parsed.files)) {
    for (const item of parsed.files) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const one = pick(entry.file, entry.name);
      if (one) files.push(one);
    }
  } else {
    // 升级前写下的那份 json：只有一个 file/name
    const legacy = pick(parsed.file, parsed.name);
    if (legacy) files.push(legacy);
  }

  const skipped: { name: string; reason: string }[] = [];
  if (Array.isArray(parsed.skipped)) {
    for (const item of parsed.skipped) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const name = typeof row.name === 'string' && row.name ? row.name : '文件';
      const reason = typeof row.reason === 'string' && row.reason ? row.reason : '没有接住';
      skipped.push({ name, reason });
    }
  }

  return { at, prevAt: last, mime, text, files, skipped };
}

/**
 * 把幂等键退回消费前的位置。
 *
 * **只在「一份都没处理成功」时调**：全都失败说明这次分享等于丢了，下次启动要能重来一次；
 * 已经存进去一部分时退回去会让那部分再进一遍（重复比丢失好，但能不重复就别重复）。
 */
export async function rewindIncomingShare(prevAt: number): Promise<void> {
  try {
    await repo.setSetting(LAST_KEY, String(prevAt));
  } catch {
    /* 退不回去最多丢这一条；不因为记不上键把错误盖成别的 */
  }
}

/**
 * 用完把中转的那份删掉。
 *
 * 原生每次分享都会往 `incoming/` 里复制一份带时间戳的新文件，而这里读完之后
 * 内容已经进了碎片或文档库 —— 不删的话每分享一次就多存一份，用户看不到，
 * 只能在系统设置的存储占用里发现问题。
 *
 * **只在消费成功之后调**：失败时留着那份，下次启动还能再读一次。
 * 传的是 `disk`（磁盘名），不是给人看的 `name`。
 */
export async function dropIncomingFile(disk: string | null): Promise<void> {
  if (!disk) return;
  try {
    const f = new File(Paths.document, DIR, disk);
    if (f.exists) f.delete();
  } catch {
    /* 删不掉不影响内容已经入库 */
  }
}
