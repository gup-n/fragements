/**
 * 文档列表：导入原件、本地准备、云解析确认、多选去问。
 *
 * v0.12 起这里**不再是上传流水线**：
 * - 导入只做「复制进私有目录 + 核验真实大小 + 写一条 stored 记录」，
 *   不读正文、不建索引、不联网。飞行模式、没 Token、超大文件都必须能保存成功。
 * - 准备正文是另外两件事：本地提取（不出手机）和云解析（必须先过确认卡）。
 *   两者都由 `documents/jobs` 跑，任务不依附这一页的生命周期。
 * - 这一页只订阅任务状态，不管任务本身。离开页面再回来还能看到进度。
 *
 * 为什么不再自己跑流水线：v0.11.0 把任务放在页面里，结果列表和阅读器
 * 各起一个任务、同一个文件传到服务端两遍；页面卸载后进度回调指向死组件，
 * 列表永远停在「解析中」。这些都不是靠加防抖能修的，得换结构。
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
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { DocumentMeta } from '../types';
import { MAX_ASK_DOCUMENTS } from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { repo } from '../db/repo';
import { deleteOriginal, pickDocumentFile, saveOriginal } from '../db/docFiles';
import { dropViewCache } from '../documents/readers/viewCache';
import { getMineruToken } from '../ai/mineru';
import {
  CLOUD_SUPPORT_HINT,
  LOCAL_SUPPORT_HINT,
  localReaderLimitNote,
  planForDoc,
  sizeText,
} from '../util/docSupport';
import { isDocumentReady, notReadyReason, supportsLocalDocument } from '../documents/formats';
import {
  cancelDocumentJob,
  dismissDocumentJob,
  initDocumentJobs,
  isJobRunning,
  jobPhaseText,
  prepareDocumentCloud,
  prepareDocumentLocal,
  subscribeDocumentJobs,
  useDocumentJob,
} from '../documents/jobs';
import { dayLabel, formatTime } from '../util/date';
import { ScreenHeader } from '../components/ScreenHeader';
import { CloudConfirmSheet, DocViewer } from '../components/DocViewer';
import { IconButton } from '../components/IconButton';
import { Toast } from '../components/Toast';

interface Props {
  onClose: () => void;
  /**
   * 进入问答。范围怎么转成 `QaScope` 由上层决定，这一页只交 id。
   * 文档模式会话锁定这几份文档，不会混入笔记和其它文档。
   */
  onAsk: (documentIds: number[]) => void;
}

const isWeb = Platform.OS === 'web';

export function DocsScreen({ onClose, onAsk }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [docs, setDocs] = useState<DocumentMeta[] | null>(null);
  /** 检索词。空 = 看全部；非空时列表来自 `searchDocuments`，不是本地筛 */
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<DocumentMeta[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** 浮在底部的一句话提示。删除之后列表可能已经滚到别处，顶部提示会看不见 */
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [picking, setPicking] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentMeta | null>(null);
  /** 正在读的文档。**只存 id**，内容由阅读器自己查 */
  const [openDocId, setOpenDocId] = useState<number | null>(null);
  /** 写完库就 +1，让打开着的阅读器重新取一次 */
  const [docVersion, setDocVersion] = useState(0);

  const [selectMode, setSelectMode] = useState(false);
  /** 勾选顺序无所谓，只用来算范围与上限 */
  const [selected, setSelected] = useState<number[]>([]);
  /** 点了「问」但选中里有没准备好的：列出来让人决定，**不静默丢掉** */
  const [blocked, setBlocked] = useState<DocumentMeta[] | null>(null);
  /** 云解析确认卡。**重试同样要过这张卡** */
  const [cloudFor, setCloudFor] = useState<DocumentMeta | null>(null);

  /** 当前 MinerU Token。空串 = 只能走轻量通道；确认卡里要用它决定精准能不能选 */
  const [token, setToken] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // 启动时收拾上次被杀进程留下的 parsing 记录。幂等，多调几次也没事
  useEffect(() => {
    void initDocumentJobs();
  }, []);

  useEffect(() => {
    getMineruToken()
      .then((t) => {
        if (alive.current) setToken(t);
      })
      .catch(() => undefined);
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

  useEffect(() => {
    refresh();
  }, [refresh]);

  /*
   * 文档检索。
   *
   * 走到库里的 `searchDocuments` 而不是在 `docs` 上过滤：列表接口**不带正文**，
   * 在内存里筛等于只能搜标题 —— 而用户想找的几乎总是「哪篇里写过群晖」。
   *
   * 250ms 防抖是给输入法用的：中文候选词每次变化都会触发 onChangeText，
   * 不防抖的话打五个字就是五次全表 LIKE。
   */
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = await repo.searchDocuments(q, 60);
        if (!cancelled) setHits(found);
      } catch {
        // 检索失败退回「没有命中」，不要端一整屏错误：用户还能清空搜索继续用
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  /*
   * 任务状态变了就重新读一次列表（节流 400ms）。
   * 任务服务只写库，不会把新状态推给列表；没有这一层，准备完了列表还显示「正在准备」。
   * 以前这里是 3 秒轮询 + 10 分钟上限，既费电又只能覆盖「页面还活着」的情况。
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = subscribeDocumentJobs(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 400);
    });
    return () => {
      sub();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  /**
   * 导入 = 只保存原件。
   *
   * 顺序不能换：**先落原文件、核验大小，再写记录**。反过来的话，写库成功但复制失败，
   * 列表里就多一条永远「打开原文件失败」的记录，用户只能删掉重来。
   * 记录没写成时要把刚复制的那份删掉，否则私有目录里会攒下孤儿文件。
   */
  async function handlePick() {
    if (picking) return;
    setPicking(true);
    setNotice(null);
    try {
      const file = await pickDocumentFile();
      if (!file) return;
      const saved = await saveOriginal(file.uri, file.name);
      try {
        await repo.insertDocument({
          name: file.name,
          ext: file.ext,
          size: saved.size,
          fileUri: saved.uri,
          state: 'stored',
        });
      } catch (e) {
        // 记录没写成，刚复制的那份就是孤儿，顺手清掉
        await deleteOriginal(saved.uri);
        throw e;
      }
      await refresh();
      setDocVersion((v) => v + 1);
      showToast(`已保存「${file.name}」`);
    } catch (e) {
      if (alive.current) {
        setNotice({
          kind: 'err',
          text: e instanceof Error ? e.message : '保存文件失败，请检查存储空间后重试',
        });
      }
    } finally {
      if (alive.current) setPicking(false);
    }
  }

  function enterSelect() {
    setSelectMode(true);
    setSelected([]);
  }

  function exitSelect() {
    setSelectMode(false);
    setSelected([]);
    setBlocked(null);
  }

  function toggle(id: number) {
    // 上限提示得在 updater 外面发：setState 的 updater 可能在严格模式下跑两次，
    // 放在里面会连弹两个 Toast
    if (selected.includes(id)) {
      setSelected(selected.filter((x) => x !== id));
      return;
    }
    if (selected.length >= MAX_ASK_DOCUMENTS) {
      showToast(`最多同时问 ${MAX_ASK_DOCUMENTS} 份文档`);
      return;
    }
    setSelected([...selected, id]);
  }

  /** 多选里点「问」：先分清哪些没准备好，不能偷偷只问剩下的 */
  function askSelected() {
    const chosen = (docs ?? []).filter((d) => selected.includes(d.id));
    if (!chosen.length) return;
    const notReady = chosen.filter((d) => !isDocumentReady(d));
    if (notReady.length) {
      setBlocked(notReady);
      return;
    }
    onAsk(chosen.map((d) => d.id));
  }

  /** 在本地准备一批。只对「本机能读且没超上限」的动手，其余如实说明 */
  function prepareMany(list: DocumentMeta[]) {
    let started = 0;
    const skipped: string[] = [];
    for (const doc of list) {
      if (!supportsLocalDocument(doc.ext) || localReaderLimitNote(doc)) {
        skipped.push(doc.name);
        continue;
      }
      void prepareDocumentLocal(doc.id);
      started += 1;
    }
    if (started) showToast(`已开始本地准备 ${started} 份`);
    if (skipped.length) {
      setNotice({
        kind: 'err',
        text: `${skipped.length} 份本机读不了（${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' 等' : ''}），需要云解析`,
      });
    }
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    // 先停任务：迟到的结果不能写回一条正在被删的记录
    cancelDocumentJob(target.id);

    // 先删原件再删记录：反过来文件删不掉时记录已经没了，URI 也丢了
    const cleaned = await deleteOriginal(target.fileUri);
    if (!cleaned) {
      // 用浮层提示而不是顶部 notice：删除失败时列表通常已经滚到这条上，
      // 顶部那句话用户根本看不到
      showToast('原文件没删掉（可能被别的应用占用），记录先留着，可以再删一次');
      return;
    }

    // 原件没了，派生出来的解析缓存也没有意义了 —— 几 MB 的 JSON 不能留下
    await dropViewCache(target.fileUri);

    try {
      await repo.deleteDocument(target.id);
      // 指向这篇的会话徽标要一起解掉，否则历史里点进去是一片空白
      await repo.clearAskSessionDocuments(target.id);
      // 记录没了，任务快照也就没意义了，别让「已取消」留在列表上
      dismissDocumentJob(target.id);
      if (openDocId === target.id) setOpenDocId(null);
      setSelected((prev) => prev.filter((id) => id !== target.id));
      showToast(`已删除「${target.name}」`);
      await refresh();
      setDocVersion((v) => v + 1);
    } catch (e) {
      showToast(
        `记录没删掉：${e instanceof Error ? e.message : '未知原因'}。原文件已经删了`,
      );
    }
  }

  const selectedCount = selected.length;

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={selectMode ? '选择要问的文档' : '文档'}
        subtitle={docs ? (selectMode ? `已选 ${selectedCount} / ${MAX_ASK_DOCUMENTS}` : `${docs.length} 篇`) : undefined}
        onBack={onClose}
        right={
          docs && docs.length > 0 && !isWeb ? (
            <IconButton
              name={selectMode ? 'close' : 'checkmark-circle-outline'}
              color={c.text2}
              onPress={selectMode ? exitSelect : enterSelect}
              accessibilityLabel={selectMode ? '退出多选' : '多选去问'}
            />
          ) : undefined
        }
      />

      {/* 检索框常驻在标题下面：文档一多，翻列表找不到东西 */}
      <View style={styles.searchBar}>
        <Ionicons name="search" size={15} color={c.text3} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜标题、摘要或正文"
          placeholderTextColor={c.text3}
          style={styles.searchInput}
          returnKeyType="search"
          autoCorrect={false}
        />
        {searching ? <ActivityIndicator size="small" color={c.text3} /> : null}
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="清空搜索">
            <Ionicons name="close-circle" size={15} color={c.text3} />
          </Pressable>
        ) : null}
      </View>

      <FlatList
        data={hits ?? docs ?? []}
        keyExtractor={(d) => String(d.id)}
        contentContainerStyle={[styles.listContent, selectMode && styles.listContentWithBar]}
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
                accessibilityLabel="添加文档"
              >
                {picking ? (
                  <ActivityIndicator size="small" color={c.onAccent} />
                ) : (
                  <>
                    <Ionicons name="add" size={19} color={c.onAccent} />
                    <Text style={styles.uploadText}>添加文件</Text>
                  </>
                )}
              </Pressable>
            )}

            <Text style={styles.limitText}>{LOCAL_SUPPORT_HINT}</Text>
            <Text style={styles.limitText}>{CLOUD_SUPPORT_HINT}</Text>
            <Text style={styles.limitText}>添加只保存原件，不上传，也不会自动解析。</Text>

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
          ) : query.trim() && !searching ? (
            <View style={styles.empty}>
              <Ionicons name="search-outline" size={30} color={c.text3} />
              <Text style={styles.emptyTitle}>没有找到「{query.trim()}」</Text>
              <Text style={styles.emptyHint}>
                搜的是标题、摘要和正文。正文还没准备的文档只有一个文件名，
                准备过之后就能搜到里面的内容。
              </Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Ionicons name="documents-outline" size={32} color={c.text3} />
              <Text style={styles.emptyTitle}>先把文件存进来</Text>
              <Text style={styles.emptyHint}>
                原文件会复制进 App 私有目录，随时能打开。需要读或问的时候再决定：
                本机提取，还是确认后上传到 mineru.net。
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <DocRow
            doc={item}
            selectMode={selectMode}
            selected={selected.includes(item.id)}
            onOpen={() => setOpenDocId(item.id)}
            onToggle={() => toggle(item.id)}
            onDelete={() => setPendingDelete(item)}
            onLocal={() => prepareMany([item])}
            onCloud={() => setCloudFor(item)}
          />
        )}
      />

      {selectMode ? (
        <View style={styles.selectBar}>
          <View style={styles.selectInfo}>
            <Text style={styles.selectCount}>已选 {selectedCount} 份</Text>
            <Text style={styles.selectHint}>只问这几份，不混入笔记和其它文档</Text>
          </View>
          <Pressable
            style={({ pressed }) => [
              styles.askBtn,
              !selectedCount && styles.askBtnOff,
              pressed && { opacity: 0.85 },
            ]}
            onPress={askSelected}
            disabled={!selectedCount}
            accessibilityRole="button"
            accessibilityLabel={`问这 ${selectedCount} 份文档`}
          >
            <Ionicons
              name="chatbubble-ellipses-outline"
              size={16}
              color={selectedCount ? c.onAccent : c.text3}
            />
            <Text style={[styles.askText, !selectedCount && styles.askTextOff]}>
              问这 {selectedCount} 份
            </Text>
          </Pressable>
        </View>
      ) : null}

      {pendingDelete ? (
        <DeleteConfirm
          doc={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      ) : null}

      {cloudFor ? (
        <CloudConfirmSheet
          doc={cloudFor}
          defaultChannel={planForDoc(cloudFor.ext, cloudFor.size, !!token.trim()).channel === 'pro' ? 'pro' : 'lite'}
          hasToken={!!token.trim()}
          onCancel={() => setCloudFor(null)}
          onConfirm={(channel) => {
            const target = cloudFor;
            setCloudFor(null);
            if (!target) return;
            void prepareDocumentCloud(target.id, { channel });
          }}
        />
      ) : null}

      {blocked ? (
        <AskBlockedSheet
          docs={blocked}
          onCancel={() => setBlocked(null)}
          onRemove={() => {
            const ids = new Set(blocked.map((d) => d.id));
            setSelected((prev) => prev.filter((id) => !ids.has(id)));
            setBlocked(null);
            showToast(`已移除 ${ids.size} 份，剩下的可直接问`);
          }}
          onPrepare={() => {
            const list = blocked;
            setBlocked(null);
            prepareMany(list);
          }}
        />
      ) : null}

      {openDocId !== null ? (
        <DocViewer
          docId={openDocId}
          reloadKey={docVersion}
          onClose={() => setOpenDocId(null)}
          onChanged={() => {
            refresh();
            setDocVersion((v) => v + 1);
          }}
          onAsk={onAsk}
        />
      ) : null}

      <Toast text={toast} bottom={selectMode ? 96 : 24} />
    </View>
  );
}

/**
 * 列表一行。
 *
 * 单独一个组件是为了能调 `useDocumentJob` —— `renderItem` 不是组件，里面不能挂 hook。
 * 卡片本体和右侧按钮是**并排的两个 Pressable**，不是嵌套的：嵌套在 RN Web 上点击会冒泡，
 * 点垃圾桶会顺带打开阅读器。
 */
function DocRow({
  doc,
  selectMode,
  selected,
  onOpen,
  onToggle,
  onDelete,
  onLocal,
  onCloud,
}: {
  doc: DocumentMeta;
  selectMode: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onLocal: () => void;
  onCloud: () => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const job = useDocumentJob(doc.id);
  const running = isJobRunning(job);
  const ready = isDocumentReady(doc);
  const canLocal = supportsLocalDocument(doc.ext);
  const limitNote = localReaderLimitNote(doc);

  const status = running ? jobPhaseText(job) : ready ? `可问 · ${doc.charCount} 字` : notReadyReason(doc);

  const icon = running
    ? { name: 'sync-outline' as const, color: c.accent }
    : doc.state === 'failed'
      ? { name: 'alert-circle-outline' as const, color: c.danger }
      : ready
        ? { name: 'checkmark-circle-outline' as const, color: c.tealText }
        : { name: 'document-text-outline' as const, color: c.text3 };

  /*
   * 一行的主动作，按状态给且只给一个：
   * 正在跑 → 取消；已就绪 → 不显示（点卡片就是打开读）；失败 → 重试（本地）；
   * 其余 → 本地准备。本机读不了的格式只能去云解析，按钮也就换成它。
   */
  let action: { label: string; icon: 'download-outline' | 'refresh-outline' | 'close-outline' | 'cloud-outline'; run: () => void } | null = null;
  if (!selectMode) {
    if (running) {
      action = { label: '取消', icon: 'close-outline', run: () => cancelDocumentJob(doc.id) };
    } else if (ready) {
      action = null;
    } else if (canLocal && !limitNote) {
      action = { label: doc.state === 'failed' ? '重试' : '本地准备', icon: 'download-outline', run: onLocal };
    } else {
      action = { label: '云解析', icon: 'cloud-outline', run: onCloud };
    }
  }

  return (
    <View style={[styles.card, selected && styles.cardSelected]}>
      <View style={styles.cardTop}>
        <Pressable
          style={({ pressed }) => [styles.cardMain, pressed && styles.cardPressed]}
          onPress={selectMode ? onToggle : onOpen}
          accessibilityRole="button"
          accessibilityLabel={selectMode ? `${selected ? '取消选择' : '选择'} ${doc.name}` : `打开 ${doc.name}`}
        >
          <View style={styles.titleRow}>
            <View style={styles.extBadge}>
              <Text style={styles.extText} numberOfLines={1}>
                {doc.origin === 'knowledge' ? '知识' : (doc.ext || 'file').slice(0, 4).toUpperCase()}
              </Text>
            </View>
            <Text style={styles.name} numberOfLines={1}>
              {doc.name}
            </Text>
          </View>

          <Text style={styles.meta}>
            {sizeText(doc.size)} · {dayLabel(doc.updatedAt)} {formatTime(doc.updatedAt)}
          </Text>

          {/*
            知识文档把摘要直接铺在卡片上：这类文档的价值是「里面写了什么」，
            而不是「有这么一个文件」。要读全文还是点一下，但不必靠点开才知道是什么。
          */}
          {doc.origin === 'knowledge' && doc.excerpt ? (
            <Text style={styles.excerpt} numberOfLines={3}>
              {doc.excerpt}
            </Text>
          ) : null}

          <View style={styles.statusRow}>
            <Ionicons name={icon.name} size={13} color={icon.color} />
            <Text
              style={[
                styles.status,
                doc.state === 'failed' && !running && styles.statusErr,
                running && styles.statusParsing,
                ready && !running && styles.statusReady,
              ]}
              numberOfLines={1}
            >
              {status}
            </Text>
          </View>

          {doc.state === 'failed' && !running && doc.error ? (
            <Text style={styles.errorText} numberOfLines={2}>
              {doc.error}
            </Text>
          ) : null}
          {limitNote && !running ? (
            <Text style={styles.warnText} numberOfLines={2}>
              {limitNote}
            </Text>
          ) : null}
        </Pressable>

        {selectMode ? (
          <View style={styles.side}>
            <IconButton
              name={selected ? 'checkmark-circle' : 'ellipse-outline'}
              color={selected ? c.accent : c.text3}
              onPress={onToggle}
              accessibilityLabel={selected ? `取消选择 ${doc.name}` : `选择 ${doc.name}`}
            />
          </View>
        ) : (
          <View style={styles.side}>
            <IconButton
              name="trash-outline"
              size={17}
              color={c.text3}
              onPress={onDelete}
              accessibilityLabel={`删除 ${doc.name}`}
            />
          </View>
        )}
      </View>

      {action ? (
        <View style={styles.cardActions}>
          <Pressable
            style={({ pressed }) => [styles.pill, pressed && { opacity: 0.7 }]}
            onPress={action.run}
            accessibilityRole="button"
            accessibilityLabel={`${action.label} ${doc.name}`}
          >
            <Ionicons name={action.icon} size={13} color={c.accentText} />
            <Text style={styles.pillText}>{action.label}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/**
 * 选中里有没准备好的文档。
 *
 * 这里最容易犯的错是「静默只问能问的那几份」—— 用户勾了 5 份，实际只问了 3 份，
 * 而答案里不会提这件事。必须把待准备的列出来，让人自己选「先准备」还是「移除」。
 */
function AskBlockedSheet({
  docs,
  onCancel,
  onRemove,
  onPrepare,
}: {
  docs: DocumentMeta[];
  onCancel: () => void;
  onRemove: () => void;
  onPrepare: () => void;
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
          <View style={[styles.sheetIcon, styles.sheetIconWarn]}>
            <Ionicons name="hourglass-outline" size={17} color={c.amberText} />
          </View>
          <Text style={styles.sheetTitle}>还有 {docs.length} 份没准备好</Text>
        </View>

        <Text style={styles.sheetHint}>
          这些不能放进这次问答的范围。可以先在本机准备（不上传），也可以从选择里移除。
        </Text>

        <View style={styles.blockList}>
          {docs.slice(0, MAX_ASK_DOCUMENTS).map((d) => (
            <View key={d.id} style={styles.blockRow}>
              <Text style={styles.blockName} numberOfLines={1}>
                {d.name}
              </Text>
              <Text style={styles.blockReason} numberOfLines={1}>
                {supportsLocalDocument(d.ext) && !localReaderLimitNote(d) ? '待本地准备' : '需要云解析'}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.sheetActions}>
          <Pressable
            style={({ pressed }) => [styles.cancelBtn, pressed && { backgroundColor: c.hairSoft }]}
            onPress={onCancel}
          >
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.cancelBtn, pressed && { backgroundColor: c.hairSoft }]}
            onPress={onRemove}
          >
            <Text style={styles.cancelText}>移除这些</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.startBtn, pressed && { opacity: 0.85 }]}
            onPress={onPrepare}
          >
            <Text style={styles.startText}>在本地准备</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** 删除确认。删掉的是 App 内的副本和已准备的正文，不影响手机里原来那个文件 */
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
          会删掉 App 里的原文件副本和已准备的正文。手机里原来那个文件不受影响。
          正在跑的任务会先停掉。
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
  listContentWithBar: { paddingBottom: 96 },
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
    gap: 6,
  },
  uploadText: { fontSize: 14.5, color: c.onAccent, fontWeight: '600' },
  limitText: { marginTop: 6, fontSize: 11, lineHeight: 17, color: c.text3, paddingHorizontal: 2 },
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
  emptyHint: { fontSize: 12, lineHeight: 19, color: c.text3, textAlign: 'center', maxWidth: 320 },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: R.btn,
    backgroundColor: c.hairSoft,
  },
  searchInput: { flex: 1, fontSize: 13, color: c.text, padding: 0 },
  card: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
    overflow: 'hidden',
  },
  cardSelected: { borderColor: c.accent },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start' },
  cardPressed: { backgroundColor: c.hairSoft },
  cardMain: { flex: 1, minWidth: 0, paddingLeft: 13, paddingRight: 4, paddingVertical: 12 },
  side: { paddingHorizontal: 6, paddingTop: 8 },

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
  meta: { fontSize: 11, color: c.text3, fontVariant: ['tabular-nums'], marginTop: 3 },
  /** 知识文档的摘要：三行封顶，多了会把一行卡片撑得过高 */
  excerpt: { fontSize: 12.5, lineHeight: 19, color: c.text2, marginTop: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  status: { flex: 1, fontSize: 11.5, color: c.text2 },
  statusParsing: { color: c.accentText },
  statusReady: { color: c.tealText },
  statusErr: { color: c.danger },
  errorText: { marginTop: 3, fontSize: 11, lineHeight: 16, color: c.danger },
  warnText: { marginTop: 3, fontSize: 11, lineHeight: 16, color: c.amberText },

  cardActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 13,
    paddingBottom: 10,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: c.accentBg,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  pillText: { fontSize: 12, color: c.accentText, fontWeight: '500' },

  selectBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: c.page,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
  },
  selectInfo: { flex: 1, minWidth: 0 },
  selectCount: { fontSize: 13, color: c.text, fontWeight: '600' },
  selectHint: { marginTop: 2, fontSize: 11, color: c.text3 },
  askBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 44,
    paddingHorizontal: 16,
    borderRadius: R.btn,
    backgroundColor: c.accent,
  },
  askBtnOff: { backgroundColor: c.hairSoft },
  askText: { fontSize: 13.5, color: c.onAccent, fontWeight: '600' },
  askTextOff: { color: c.text3 },

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
  sheetIconWarn: { backgroundColor: c.amberBg },
  sheetTitle: { fontSize: 16, fontWeight: '600', color: c.text, flex: 1 },
  fileName: { marginTop: 12, fontSize: 13, lineHeight: 19, color: c.text, fontWeight: '500' },
  sheetHint: { marginTop: 10, fontSize: 12, lineHeight: 18, color: c.text3 },

  blockList: { marginTop: 12, gap: 6 },
  blockRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  blockName: { flex: 1, fontSize: 12.5, color: c.text },
  blockReason: { fontSize: 11, color: c.text3 },

  sheetActions: { flexDirection: 'row', gap: 8, marginTop: 18 },
  cancelBtn: {
    flex: 1,
    height: 42,
    borderRadius: R.btn,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { fontSize: 13.5, color: c.text2 },
  startBtn: {
    flex: 1.4,
    height: 42,
    borderRadius: R.btn,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startText: { fontSize: 13.5, fontWeight: '600', color: c.onAccent },
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
