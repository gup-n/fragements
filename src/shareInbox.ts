/**
 * 系统「分享」进来的内容。
 *
 * 原生那半边见 `plugins/withShareReceiver.js`：MainActivity 收到 `ACTION_SEND`
 * 就把文字和文件落到 `files/incoming/`，再写一份 `incoming-share.json`。
 * 这里只负责**读出来并消费一次**。
 *
 * 为什么要记 `share_last_at`：分享进来的内容会一直躺在那份 json 里，
 * 每次启动都读一遍就会重复弹出同一条。用时间戳做幂等键 —— 比删文件稳，
 * 删文件删到一半失败的场景不用再考虑。
 */
import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { repo } from './db/repo';

const DIR = 'incoming';
const JSON_NAME = 'incoming-share.json';
const LAST_KEY = 'share_last_at';

export interface IncomingShare {
  at: number;
  mime: string;
  /** 分享时带的文字（微信分享图片常带一句描述，也可能为空） */
  text: string;
  /** 已复制到私有目录的文件名；null = 只有文字 */
  file: string | null;
  /**
   * 文件的**原始文件名**（中文、空格都在）。`file` 是磁盘上的安全名，
   * 入库和显示都必须用这个 —— 把 `2026-11-15T…-____.docx` 当文档名给用户看是错的。
   * 原生没带上时退回 `file`。
   */
  name: string | null;
  /** 能给 <Image> / 导入链路直接用的绝对 uri */
  fileUri: string | null;
  kind: 'text' | 'image' | 'other';
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i;

/**
 * 取出一次分享。没有新的就返回 null。
 *
 * 判定「新」用的是 `at > 上次处理的时间戳`，并且**先落库再返回** ——
 * 反过来的话，读取过程中用户切走，下次启动会把同一条当新的再来一次。
 */
export async function takeIncomingShare(): Promise<IncomingShare | null> {
  if (Platform.OS !== 'android') return null;

  let raw = '';
  try {
    const json = new File(Paths.document, DIR, JSON_NAME);
    if (!json.exists) return null;
    raw = await json.text();
  } catch {
    return null;
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const at = typeof parsed?.at === 'number' ? parsed.at : 0;
  if (!at) return null;

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
  const file = typeof parsed.file === 'string' && parsed.file ? parsed.file : null;
  const name = typeof parsed.name === 'string' && parsed.name ? parsed.name : null;
  let fileUri: string | null = null;
  if (file) {
    try {
      const f = new File(Paths.document, DIR, file);
      fileUri = f.exists ? f.uri : null;
    } catch {
      fileUri = null;
    }
  }

  /*
   * 类型判断以 mime 为主、扩展名为辅：微信分享图片时 mime 有时是
   * application/octet-stream，只看 mime 会把一张图当成「其它文件」拒掉。
   */
  const kind: IncomingShare['kind'] = !file
    ? 'text'
    : mime.startsWith('image/') || IMAGE_EXT.test(file)
      ? 'image'
      : 'other';

  return { at, mime, text, file, name, fileUri, kind };
}

/**
 * 用完把中转的那份删掉。
 *
 * 原生每次分享都会往 `incoming/` 里复制一份带时间戳的新文件，而这里读完之后
 * 内容已经进了碎片或文档库 —— 不删的话每分享一次就多存一份，用户看不到，
 * 只能在系统设置的存储占用里发现问题。
 *
 * **只在消费成功之后调**：失败时留着那份，下次启动还能再读一次。
 */
export async function dropIncomingFile(name: string | null): Promise<void> {
  if (!name) return;
  try {
    const f = new File(Paths.document, DIR, name);
    if (f.exists) f.delete();
  } catch {
    /* 删不掉不影响内容已经入库 */
  }
}
