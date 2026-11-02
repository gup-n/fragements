/**
 * 文档列表 + 上传流水线 + 删除确认。
 *
 * 一期只做「上传 → 解析成 Markdown → 读 → 打开原文件」。
 * 搜索和「问」都还没接进来 —— 那些要等文档正文也能被检索之后再谈。
 *
 * 流水线为什么放在页面里而不是再抽一层：
 * 一次上传只有一条链路，抽出去之后「进度文案」「失败原因」「列表刷新」
 * 三处都得再穿一遍回调；真正的复杂度在 `docFiles` 和 `ai/mineru` 里。
 *
 * 解析期间可以离开这一页：Promise 在内存里继续跑，写库不依赖页面存活；
 * 页面只负责「如果还活着就更新进度」。**没有后台任务持久化**，
 * 进程被杀之后那条记录会停在「解析中」，阅读器里可以手动重新解析。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { DocumentMeta } from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { repo } from '../db/repo';
import {
  deleteOriginal,
  pickDocumentFile,
  readPlainText,
  saveOriginal,
  type PickedDocument,
} from '../db/docFiles';
import {
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  mineruMessage,
  parseWithMineru,
  stageText,
  type MineruStage,
} from '../ai/mineru';
import { dayLabel, formatTime } from '../util/date';
import { ScreenHeader } from '../components/ScreenHeader';
import { DocViewer } from '../components/DocViewer';
import { Toast } from '../components/Toast';

interface Props {
  onClose: () => void;
}

const isWeb = Platform.OS === 'web';

/** `23347200` → `22.3 MB`。**0 不写成 0 B** —— 选择器没给大小时那是个未知数 */
function sizeText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '大小未知';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function isPlainText(ext: string): boolean {
  return ext === 'txt' || ext === 'md' || ext === 'markdown';
}

function statusText(doc: DocumentMeta, stage?: MineruStage): string {
  if (doc.state === 'parsing') return stage ? stageText(stage) : '解析中';
  if (doc.state === 'failed') return '解析失败';
  if (doc.state === 'local') return `本地文本 · ${doc.charCount} 字`;
  return `已解析 · ${doc.charCount} 字`;
}

export function DocsScreen({ onClose }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [docs, setDocs] = useState<DocumentMeta[] | null>(null);
  /** 选完文件先确认，确认了才保存和上传 */
  const [confirm, setConfirm] = useState<PickedDocument | null>(null);
  /** 待删除的文档。非空时弹二次确认 */
  const [pendingDelete, setPendingDelete] = useState<DocumentMeta | null>(null);
  /** 正在读的文档。**只存 id**，内容由阅读器自己查 */
  const [openDocId, setOpenDocId] = useState<number | null>(null);
  /** id → 当前阶段。只在本页内存里，离开页面就没了，但解析本身继续 */
  const [progress, setProgress] = useState<Record<number, MineruStage>>({});
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** 浮在底部的一句话提示。删除之后列表可能已经滚到别处，顶部提示会看不见 */
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [picking, setPicking] = useState(false);
  /** 写完库就 +1，让打开着的阅读器重新取一次 */
  const [docVersion, setDocVersion] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  /** Toast 自己不做定时器，谁触发谁清 —— 连续两次时后一次不能被前一次提前清掉 */
  const showToast = useCallback((text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await repo.listDocuments();
      if (alive.current) setDocs(list);
    } catch (e) {
      if (alive.current) {
        setNotice({ kind: 'err', text: e instanceof Error ? e.message : '读取文档列表失败' });
        setDocs([]);
      }
    }
  }, []);

  /** 阅读器重试时把阶段同步过来，关掉阅读器之后列表还能继续显示进度 */
  const applyStage = useCallback((id: number, stage: MineruStage | null) => {
    setProgress((prev) => {
      const next = { ...prev };
      if (stage) next[id] = stage;
      else delete next[id];
      return next;
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * 有文档在解析时轮询列表。
   *
   * 解析任务活在**发起它的那次页面实例**里：用户离开再回来，进度回调已经指向
   * 卸载掉的组件，新页面收不到「写完了」。不轮询的话列表会永远停在「解析中」。
   * 只查本地库，3 秒一次，且最多跟 10 分钟（和解析超时同一档），
   * 留下一条永远 parsing 的坏记录也不会一直耗电。
   */
  const hasParsing = docs?.some((d) => d.state === 'parsing') ?? false;
  useEffect(() => {
    if (!hasParsing) return;
    const deadline = Date.now() + 10 * 60 * 1000;
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        return;
      }
      refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [hasParsing, refresh]);

  async function handlePick() {
    if (picking) return;
    setPicking(true);
    setNotice(null);
    try {
      const file = await pickDocumentFile();
      if (!file) return;
      // 纯文本不走上传，10 MB 的限制只针对要发给 MinerU 的格式
      if (!isPlainText(file.ext) && file.size > MAX_FILE_BYTES) {
        setNotice({
          kind: 'err',
          text: `「${file.name}」超过 ${MAX_FILE_LABEL}，轻量解析接口不支持`,
        });
        return;
      }
      setConfirm(file);
    } catch (e) {
      setNotice({ kind: 'err', text: e instanceof Error ? e.message : '打不开文件选择器' });
    } finally {
      if (alive.current) setPicking(false);
    }
  }

  /**
   * 确认之后的完整流水线。
   *
   * 顺序不能换：**先落原文件，再写记录**。反过来的话，写库成功但复制失败，
   * 列表里就多一条永远「打开原文件失败」的记录，用户只能删掉重来。
   */
  async function startImport(file: PickedDocument) {
    setConfirm(null);
    setNotice({ kind: 'ok', text: `正在保存「${file.name}」…` });

    let fileUri: string;
    try {
      fileUri = await saveOriginal(file.uri, file.name);
    } catch (e) {
      if (alive.current) {
        setNotice({ kind: 'err', text: e instanceof Error ? e.message : '保存原文件失败' });
      }
      return;
    }

    let id: number;
    try {
      id = await repo.insertDocument({
        name: file.name,
        ext: file.ext,
        size: file.size,
        fileUri,
        state: 'parsing',
      });
    } catch (e) {
      // 记录没写成，刚复制的那份就是孤儿，顺手清掉
      await deleteOriginal(fileUri);
      if (alive.current) {
        setNotice({ kind: 'err', text: e instanceof Error ? e.message : '写入文档记录失败' });
      }
      return;
    }

    await refresh();
    setDocVersion((v) => v + 1);
    // 记录已经在列表里了，进度交给条目自己显示；这句「正在保存」再多留一会儿就是误导
    if (alive.current) setNotice(null);

    const plain = isPlainText(file.ext);
    try {
      if (plain) {
        const text = await readPlainText(fileUri);
        if (!text.trim()) throw new Error('文件里没有可读的文字');
        await repo.updateDocument(id, { bodyMd: text, state: 'local', pages: null, error: null });
        if (alive.current) setNotice({ kind: 'ok', text: `「${file.name}」已保存` });
      } else {
        const md = await parseWithMineru({ ...file, uri: fileUri }, (stage) => {
          if (alive.current) setProgress((prev) => ({ ...prev, [id]: stage }));
        });
        await repo.updateDocument(id, { bodyMd: md, state: 'done', pages: null, error: null });
        if (alive.current) setNotice({ kind: 'ok', text: `「${file.name}」解析完成` });
      }
    } catch (e) {
      const text = plain ? (e instanceof Error ? e.message : '读取失败') : mineruMessage(e);
      // 失败保留记录和原文件：用户可以重试，也可以自己删；不要偷偷把文件删了
      await repo.updateDocument(id, { state: 'failed', error: text }).catch(() => undefined);
      if (alive.current) {
        setNotice({ kind: 'err', text: `「${file.name}」解析失败：${text}` });
      }
    } finally {
      if (alive.current) {
        setProgress((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      await refresh();
      if (alive.current) setDocVersion((v) => v + 1);
    }
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    try {
      await repo.deleteDocument(target.id);
      // repo 不碰文件系统，副本在这里删
      await deleteOriginal(target.fileUri);
      if (openDocId === target.id) setOpenDocId(null);
      showToast(`已删除「${target.name}」`);
      await refresh();
      setDocVersion((v) => v + 1);
    } catch (e) {
      setNotice({ kind: 'err', text: e instanceof Error ? e.message : '删除失败' });
    }
  }

  const statusIcon = (doc: DocumentMeta) => {
    if (doc.state === 'parsing') return { name: 'sync-outline' as const, color: c.accent };
    if (doc.state === 'failed') return { name: 'alert-circle-outline' as const, color: c.danger };
    if (doc.state === 'local') return { name: 'document-text-outline' as const, color: c.text3 };
    return { name: 'checkmark-circle-outline' as const, color: c.tealText };
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="文档"
        subtitle={docs ? `${docs.length} 篇` : undefined}
        onBack={onClose}
      />

      <FlatList
        data={docs ?? []}
        keyExtractor={(d) => String(d.id)}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListHeaderComponent={
          <View style={styles.uploadBlock}>
            {isWeb ? (
              <View style={styles.webNote}>
                <Ionicons name="information-circle-outline" size={16} color={c.text3} />
                <Text style={styles.webText}>网页版不支持上传文档，请在手机上使用。</Text>
              </View>
            ) : (
              <Pressable
                style={({ pressed }) => [styles.uploadBtn, pressed && { opacity: 0.85 }]}
                onPress={handlePick}
                disabled={picking}
                accessibilityRole="button"
                accessibilityLabel="上传文档"
              >
                {picking ? (
                  <ActivityIndicator size="small" color={c.onAccent} />
                ) : (
                  <>
                    <Ionicons name="cloud-upload-outline" size={18} color={c.onAccent} />
                    <Text style={styles.uploadText}>上传文档</Text>
                  </>
                )}
              </Pressable>
            )}

            <Text style={styles.limitText}>
              PDF / Word / PPT / 图片会解析成 Markdown；txt、md 直接读文本。
              要上云的单个文件 ≤ {MAX_FILE_LABEL}、≤ 20 页，txt / md 不受此限。
            </Text>

            {notice ? (
              <Text
                style={[styles.notice, notice.kind === 'err' ? styles.noticeErr : styles.noticeOk]}
                numberOfLines={3}
              >
                {notice.text}
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          docs === null ? (
            <View style={styles.loading}>
              <ActivityIndicator color={c.text3} />
            </View>
          ) : (
            <View style={styles.empty}>
              <Ionicons name="documents-outline" size={32} color={c.text3} />
              <Text style={styles.emptyTitle}>
                把 PDF、Word、PPT 拖进来，解析成可读的 Markdown
              </Text>
              <Text style={styles.emptyHint}>
                解析会把文件上传到 mineru.net；原文件同时保留在手机上。
                扫描件的文字识别可能不准，表格会尽量还原。
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const icon = statusIcon(item);
          /*
           * 卡片本体和垃圾桶是**并排的两个 Pressable**，不是嵌套的。
           * 嵌套在 RN Web 上点击会冒泡，点垃圾桶会顺带打开阅读器；
           * 安卓虽然靠 responder 只触发一个，但没必要留这种平台差异。
           */
          return (
            <View style={styles.card}>
              <Pressable
                style={({ pressed }) => [styles.cardMain, pressed && styles.cardPressed]}
                onPress={() => setOpenDocId(item.id)}
                accessibilityRole="button"
                accessibilityLabel={`打开 ${item.name}`}
              >
                <View style={styles.titleRow}>
                  <View style={styles.extBadge}>
                    <Text style={styles.extText} numberOfLines={1}>
                      {(item.ext || 'file').slice(0, 4).toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                </View>

                <Text style={styles.meta}>
                  {sizeText(item.size)} · {dayLabel(item.updatedAt)} {formatTime(item.updatedAt)}
                </Text>

                <View style={styles.statusRow}>
                  <Ionicons name={icon.name} size={13} color={icon.color} />
                  <Text
                    style={[
                      styles.status,
                      item.state === 'failed' && styles.statusErr,
                      item.state === 'parsing' && styles.statusParsing,
                    ]}
                    numberOfLines={1}
                  >
                    {statusText(item, progress[item.id])}
                  </Text>
                </View>

                {item.state === 'failed' && item.error ? (
                  <Text style={styles.errorText} numberOfLines={1}>
                    {item.error}
                  </Text>
                ) : null}
              </Pressable>

              <Pressable
                onPress={() => setPendingDelete(item)}
                hitSlop={10}
                style={({ pressed }) => [styles.trash, pressed && { opacity: 0.5 }]}
                accessibilityRole="button"
                accessibilityLabel={`删除 ${item.name}`}
              >
                <Ionicons name="trash-outline" size={17} color={c.text3} />
              </Pressable>
            </View>
          );
        }}
      />

      {confirm ? (
        <UploadConfirm
          file={confirm}
          uploads={!isPlainText(confirm.ext)}
          onCancel={() => setConfirm(null)}
          onStart={() => startImport(confirm)}
        />
      ) : null}

      {pendingDelete ? (
        <DeleteConfirm
          doc={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      ) : null}

      {openDocId !== null ? (
        <DocViewer
          docId={openDocId}
          parsingStage={progress[openDocId]}
          reloadKey={docVersion}
          onClose={() => setOpenDocId(null)}
          onChanged={() => {
            refresh();
            setDocVersion((v) => v + 1);
          }}
          onStage={(stage) => applyStage(openDocId, stage)}
        />
      ) : null}

      <Toast text={toast} />
    </View>
  );
}

/**
 * 上传前的确认卡。
 *
 * 这一层不是形式主义：点下去文件就会离开手机。用户有权在**发出去之前**
 * 看清楚「发给谁、原文件还在不在」，而不是事后从隐私政策里找答案。
 */
function UploadConfirm({
  file,
  uploads,
  onCancel,
  onStart,
}: {
  file: PickedDocument;
  /** 是否会真的发给 MinerU。txt / md 只在本机读，不能也写「会上传」 */
  uploads: boolean;
  onCancel: () => void;
  onStart: () => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const live = useRef(onCancel);
  live.current = onCancel;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      live.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <View style={styles.sheetIcon}>
            <Ionicons name="cloud-upload-outline" size={17} color={c.accentText} />
          </View>
          <Text style={styles.sheetTitle}>{uploads ? '解析这个文件？' : '读取这个文件？'}</Text>
        </View>

        <Text style={styles.fileName} numberOfLines={2}>
          {file.name}
        </Text>
        <Text style={styles.fileMeta}>
          {sizeText(file.size)} · {file.ext ? file.ext.toUpperCase() : '未知格式'}
        </Text>

        <View style={[styles.privacy, uploads ? styles.privacyWarn : styles.privacyLocal]}>
          <Ionicons
            name={uploads ? 'cloud-outline' : 'phone-portrait-outline'}
            size={14}
            color={uploads ? c.amberText : c.text2}
          />
          <Text style={[styles.privacyText, !uploads && styles.privacyTextLocal]}>
            {uploads
              ? '解析会把文件上传到 mineru.net，原文件同时保留在手机上。'
              : 'txt / md 只在手机上读取，不会上传到任何服务器。'}
          </Text>
        </View>

        <Text style={styles.sheetHint}>
          {uploads
            ? `轻量接口限制单文件 ${MAX_FILE_LABEL}、20 页。解析通常要几十秒到几分钟，这段时间可以离开这一页。`
            : '原文件会复制进 App 私有目录，之后可以随时打开。'}
        </Text>

        <View style={styles.sheetActions}>
          <Pressable
            style={({ pressed }) => [styles.cancelBtn, pressed && { backgroundColor: c.hairSoft }]}
            onPress={onCancel}
          >
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.startBtn, pressed && { opacity: 0.85 }]}
            onPress={onStart}
          >
            <Text style={styles.startText}>{uploads ? '开始解析' : '开始读取'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** 删除确认。删掉的是 App 内的副本和解析结果，不影响手机里原来那个文件 */
function DeleteConfirm({
  doc,
  onCancel,
  onConfirm,
}: {
  doc: DocumentMeta;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const live = useRef(onCancel);
  live.current = onCancel;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      live.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <View style={[styles.sheetIcon, styles.sheetIconDanger]}>
            <Ionicons name="trash-outline" size={17} color={c.danger} />
          </View>
          <Text style={styles.sheetTitle}>删除这篇文档？</Text>
        </View>

        <Text style={styles.fileName} numberOfLines={2}>
          {doc.name}
        </Text>
        <Text style={styles.sheetHint}>
          会删掉 App 里的原文件副本和已解析的正文。手机里原来那个文件不受影响。
        </Text>

        <View style={styles.sheetActions}>
          <Pressable
            style={({ pressed }) => [styles.cancelBtn, pressed && { backgroundColor: c.hairSoft }]}
            onPress={onCancel}
          >
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.85 }]}
            onPress={onConfirm}
          >
            <Text style={styles.deleteText}>删除</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },

  listContent: { paddingHorizontal: 16, paddingBottom: 32 },
  sep: { height: 10 },
  loading: { paddingTop: 50, alignItems: 'center' },

  uploadBlock: { paddingTop: 14, paddingBottom: 16 },
  uploadBtn: {
    height: 46,
    borderRadius: R.btn,
    backgroundColor: c.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  uploadText: { fontSize: 14.5, color: c.onAccent, fontWeight: '600' },
  limitText: { marginTop: 9, fontSize: 11, lineHeight: 17, color: c.text3, paddingHorizontal: 2 },
  notice: { marginTop: 10, fontSize: 12, lineHeight: 18, paddingHorizontal: 2 },
  noticeOk: { color: c.tealText },
  noticeErr: { color: c.danger },

  webNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: c.hairSoft,
    borderRadius: R.btn,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  webText: { flex: 1, fontSize: 12.5, lineHeight: 18, color: c.text2 },

  empty: { alignItems: 'center', paddingTop: 34, paddingHorizontal: 12, gap: 8 },
  emptyTitle: {
    fontSize: 14.5,
    lineHeight: 22,
    color: c.text,
    textAlign: 'center',
    fontWeight: '500',
    maxWidth: 300,
  },
  emptyHint: { fontSize: 12, lineHeight: 19, color: c.text3, textAlign: 'center', maxWidth: 300 },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
    overflow: 'hidden',
  },
  cardPressed: { backgroundColor: c.hairSoft },
  cardMain: { flex: 1, minWidth: 0, paddingLeft: 13, paddingRight: 6, paddingVertical: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  extBadge: {
    backgroundColor: c.accentBg,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    maxWidth: 48,
  },
  extText: { fontSize: 9.5, lineHeight: 13, color: c.accentText, fontWeight: '600' },
  name: { flex: 1, fontSize: 14.5, color: c.text, fontWeight: '500' },
  meta: {
    marginTop: 5,
    fontSize: 11,
    color: c.text3,
    fontVariant: ['tabular-nums'],
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  status: { flex: 1, fontSize: 11.5, color: c.text2 },
  statusParsing: { color: c.accentText },
  statusErr: { color: c.danger },
  errorText: { marginTop: 3, fontSize: 11, lineHeight: 16, color: c.danger },
  trash: { paddingHorizontal: 12, paddingVertical: 16 },

  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: c.scrim,
  },
  sheet: { backgroundColor: c.card, borderRadius: R.card + 4, padding: 18 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sheetIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: c.accentBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetIconDanger: { backgroundColor: c.dangerBg },
  sheetTitle: { fontSize: 16, fontWeight: '600', color: c.text },
  fileName: { marginTop: 12, fontSize: 13, lineHeight: 19, color: c.text, fontWeight: '500' },
  fileMeta: { marginTop: 3, fontSize: 11.5, color: c.text3 },

  privacy: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 14,
    borderRadius: R.btn,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  privacyWarn: { backgroundColor: c.amberBg },
  privacyLocal: { backgroundColor: c.hairSoft },
  privacyText: { flex: 1, fontSize: 12, lineHeight: 18, color: c.amberText },
  privacyTextLocal: { color: c.text2 },
  sheetHint: { marginTop: 12, fontSize: 12, lineHeight: 18, color: c.text3 },

  sheetActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  cancelBtn: {
    flex: 1,
    height: 42,
    borderRadius: R.btn,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { fontSize: 14, color: c.text2 },
  startBtn: {
    flex: 1.4,
    height: 42,
    borderRadius: R.btn,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startText: { fontSize: 14, fontWeight: '600', color: c.onAccent },
  deleteBtn: {
    flex: 1.4,
    height: 42,
    borderRadius: R.btn,
    backgroundColor: c.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: { fontSize: 14, fontWeight: '600', color: c.onAccent },
});
