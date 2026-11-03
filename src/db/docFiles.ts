/**
 * 文档模块的文件系统层。**只碰文件，不碰数据库、不碰界面。**
 *
 * 分成一层的理由：
 * - 选文件、复制进私有目录、读文本、交给别的应用打开，四件事各自都有
 *   「新 API 不行就退回旧 API」的分支，散在页面里会把上传流水线淹掉；
 * - 原文件一旦从 `content://` 拷贝进 App 私有目录，`fileUri` 才能长期使用 ——
 *   选择器给的 URI 是临时的，重启后经常失效。
 *
 * v0.12 起导入只做「复制 + 核验大小」，**不读正文、不联网、不解析**：
 * 飞行模式下也必须能保存成功，格式能不能读是之后用户主动决定的事。
 */
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { getContentUriAsync, readAsStringAsync, deleteAsync, copyAsync, getInfoAsync } from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as IntentLauncher from 'expo-intent-launcher';

/** 原文件存放目录名（App 私有目录下） */
const DOC_DIR = 'documents';

/** 打开原文件 / 读写文件失败时的可读错误。message 直接上屏 */
export class DocFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocFileError';
  }
}

export interface PickedDocument {
  /** 原文件名，含扩展名 */
  name: string;
  /** 小写扩展名，不含点；没有扩展名时为空串 */
  ext: string;
  /**
   * 选择器报的字节数。**只是提示**：部分 ROM 给 0 或者给错。
   * 入库的大小一律用 `saveOriginal` 返回的副本真实字节数。
   */
  size: number;
  /** 选择器给的临时 URI */
  uri: string;
}

/** 复制完成后的原件信息。大小来自副本 stat，不来自选择器 */
export interface SavedOriginal {
  uri: string;
  /** 副本真实字节数 */
  size: number;
  /** 落盘文件名（重名时会带 -1 / -2 后缀） */
  fileName: string;
  /** 是否因为重名改过名 */
  renamed: boolean;
}

/** `报告.PDF` → `pdf`。查不到就返回空串，由调用方决定怎么兜 */
export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase();
}

/**
 * 文件名安全化。
 *
 * 保留中文和常规字符，其余压成下划线；再截断长度（安卓文件系统对单段文件名
 * 有 255 字节限制，中文一个字符占 3 字节）。时间戳前缀由调用方加，
 * 所以这里不用担心重名，也不用担心 `..` —— 斜杠已经被吃掉了。
 */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'document';
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_');
  return cleaned.slice(0, 80) || 'document';
}

function documentsDir(): Directory {
  return new Directory(Paths.document, DOC_DIR);
}

/**
 * 打开系统文件选择器。
 *
 * **故意不按 MIME 过滤。** 安卓上 PDF / Office 的注册类型并不统一，
 * `.md` 更乱（text/markdown、text/x-markdown、application/octet-stream 都有）。
 * 按类型过滤会让一部分机型**根本看不到自己的文件** —— 那才是真的没法救。
 * 选错格式的代价只是「这篇读不了」，原件还在，能打开也能删掉重来。
 */
export async function pickDocumentFile(): Promise<PickedDocument | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.length) return null;

  const asset = res.assets[0];
  const name = asset.name || '未命名文件';
  let size = asset.size ?? 0;
  if (!size) {
    try {
      size = new File(asset.uri).info().size ?? 0;
    } catch {
      try {
        const info = await getInfoAsync(asset.uri);
        size = info.exists && 'size' in info ? info.size ?? 0 : 0;
      } catch {
        /* 读不到大小就当 0：这只是确认卡上的提示，入库用的是副本真实大小 */
      }
    }
  }
  return { name, ext: extOf(name), size, uri: asset.uri };
}

/** 在扩展名前插后缀：`报告.pdf` → `报告-1.pdf`。后缀跑到 `.pdf` 后面系统就认不出格式 */
function withSuffix(name: string, n: number): string {
  const i = name.lastIndexOf('.');
  if (i <= 0) return `${name}-${n}`;
  return `${name.slice(0, i)}-${n}${name.slice(i)}`;
}

/** 目录里有没有这个名字。列不出来时返回 false，让复制自己报错，不在这里编造结论 */
function nameInUse(dir: Directory, candidate: string): boolean {
  try {
    return dir.list().some((entry) => entry.name === candidate);
  } catch {
    return false;
  }
}

/** 副本真实字节数。读不到返回 null（不能返回 0 —— 空文件也是合法的 0 字节） */
async function sizeOf(file: File): Promise<number | null> {
  try {
    if (!file.exists) return null;
    return file.size;
  } catch {
    /* 新 API 在个别 ROM 上读不到，退回 legacy */
  }
  try {
    const info = await getInfoAsync(file.uri);
    return info.exists && 'size' in info ? info.size ?? null : null;
  } catch {
    return null;
  }
}

/**
 * 把选中的文件复制进 App 私有目录，返回可长期使用的 `file://` URI 与**副本真实大小**。
 *
 * 必须复制：选择器给的 URI 在缓存区（或 `content://`），系统随时会清，
 * 下次打开「原文件」就变成「文件不存在」。复制之后即使 App 重装前也能读。
 *
 * 大小必须重新 stat：选择器报的 size 在部分 ROM 上是 0 或错的，拿它入库会让
 * 「10 MB 限制」之类的判断全部失真。同名也绝不覆盖 —— 覆盖别人的原件是丢数据。
 */
export async function saveOriginal(uri: string, name: string): Promise<SavedOriginal> {
  const dir = documentsDir();
  // idempotent：连点两次上传时两个调用会同时走到这里，不能一个成功一个抛
  dir.create({ intermediates: true, idempotent: true });

  const base = safeFileName(name);
  const stamp = Date.now();
  let candidate = `${stamp}-${base}`;
  let renamed = false;
  // 时间戳只降低撞名概率，不构成保证（同一毫秒连点两次就会撞上）
  for (let n = 1; nameInUse(dir, candidate); n += 1) {
    candidate = `${stamp}-${withSuffix(base, n)}`;
    renamed = true;
  }

  const dest = new File(dir, candidate);
  try {
    await new File(uri).copy(dest);
  } catch {
    // 旧 API 兜底：部分 ROM 上 `content://` 在新 File API 里读不到
    try {
      await copyAsync({ from: uri, to: dest.uri });
    } catch (e) {
      // 失败可能留下半截文件，先清掉再报错
      await deleteOriginal(dest.uri);
      const msg = e instanceof Error ? e.message : String(e);
      throw new DocFileError(`保存原文件失败：${msg}。可能是存储空间不足`);
    }
  }

  const size = await sizeOf(dest);
  if (size === null) {
    await deleteOriginal(dest.uri);
    throw new DocFileError('文件复制后读不到了，可能是存储空间不足，清理后再试一次');
  }
  return { uri: dest.uri, size, fileName: candidate, renamed };
}

/**
 * 删除原文件。返回**是否真的删掉了**。
 *
 * 以前这里吞掉异常返回 void，界面就只能说「已删除」，用户以为空间释放了，
 * 其实文件还躺着。删除失败必须让上层如实告诉用户并给重试。
 */
export async function deleteOriginal(uri: string | null): Promise<boolean> {
  if (!uri) return true;
  try {
    const file = new File(uri);
    if (!file.exists) return true;
    file.delete();
    if (!new File(uri).exists) return true;
  } catch {
    /* 换旧 API 再试一次 */
  }
  try {
    await deleteAsync(uri, { idempotent: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 读 txt / md 这类纯文本。
 *
 * 新 API 在 `content://` 上偶尔会抛，所以保留 legacy 兜底；
 * 顺带剥掉 BOM —— 记事本另存为 UTF-8 会带一个，渲染时它是个看不见的方块。
 */
export async function readPlainText(uri: string): Promise<string> {
  let text: string;
  try {
    text = await new File(uri).text();
  } catch {
    try {
      text = await readAsStringAsync(uri);
    } catch {
      throw new DocFileError('读不了这个文本文件，原文件可能已经被系统清理了');
    }
  }
  return String(text ?? '').replace(/^\uFEFF/, '');
}

/** 扩展名 → MIME。安卓的 ACTION_VIEW 靠它挑应用，给错就是「无法打开」 */function mimeOf(ext: string): string {
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'ppt':
      return 'application/vnd.ms-powerpoint';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'txt':
      return 'text/plain';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'csv':
      return 'text/csv';
    case 'json':
      return 'application/json';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'html':
    case 'htm':
      return 'text/html';
    default:
      return 'application/octet-stream';
  }
}

/** FLAG_GRANT_READ_URI_PERMISSION：不给这个 flag，别的应用读不到 content URI */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

/**
 * 交给系统打开原文件。
 *
 * Android 7+ 禁止把 `file://` 交给别的进程（FileUriExposedException），
 * 所以先转 `content://`。`expo-file-system` 已注册 FileProvider，paths 覆盖 files 目录。
 * 没装能打开这类文件的应用时，退回系统分享面板 —— 至少还能「发送到…」。
 */
export async function openOriginal(uri: string, ext?: string): Promise<void> {
  if (Platform.OS === 'web') {
    throw new DocFileError('网页版不能打开原文件，请在手机上查看');
  }

  let exists = false;
  try {
    exists = new File(uri).exists;
  } catch {
    exists = false;
  }
  if (!exists) {
    throw new DocFileError('原文件已不在手机上（可能被系统清理），只能看已解析的正文');
  }

  const type = mimeOf((ext ?? extOf(uri)).toLowerCase());

  if (Platform.OS === 'android') {
    try {
      const contentUri = await getContentUriAsync(uri);
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        type,
        flags: FLAG_GRANT_READ_URI_PERMISSION,
      });
      return;
    } catch {
      /* 没有能处理这个类型的 Activity，下面走分享面板 */
    }
  }

  try {
    if (!(await Sharing.isAvailableAsync())) throw new Error('unavailable');
    await Sharing.shareAsync(uri, { mimeType: type, dialogTitle: '打开原文件' });
  } catch {
    throw new DocFileError('这台手机上没有能打开这种文件的应用，可以先读已解析的正文');
  }
}
