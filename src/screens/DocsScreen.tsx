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
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { DocTag, DocumentMeta } from '../types';
import { MAX_ASK_DOCUMENTS } from '../types';
import { R, SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { WEB_INPUT_RESET } from '../util/platformStyle';
import { BusyIndicator as ActivityIndicator } from '../components/BusyIndicator';
import { useKeyboardHeight } from '../util/keyboard';
import { repo } from '../db/repo';
import { pickDocumentFile } from '../db/docFiles';
import { importLocalFile } from '../documents/importLocal';
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
import { EmptyState } from '../components/EmptyState';
import { DocEditor } from '../components/DocEditor';
import { SwipeRow } from '../components/SwipeRow';
import { BatchSheet } from '../components/DocBatchSheet';
import { filterDocsByTag, sortTags, tagChipText } from '../util/docTags';

interface Props {
  /** 作为底栏 tab 常驻时不画返回箭头（多选态仍然要「取消」，那是页内状态） */
  embedded?: boolean;
  onClose?: () => void;
  /**
   * 进入问答。范围怎么转成 `QaScope` 由上层决定，这一页只交 id。
   * 文档模式会话锁定这几份文档，不会混入笔记和其它文档。
   */
  onAsk: (documentIds: number[]) => void;
}

const isWeb = Platform.OS === 'web';

/**
 * 文档卡里「本地准备 / 云解析」那枚小按钮的触控补偿。
 *
 * 它原来是个 48 高的实心块，单独占掉卡片最底下一行 —— 一页文档列表因此
 * 每条都长得像两行标题。现在看得见的是 34，四周补 7 才是 48。
 */
const PILL_SLOP = { top: 7, bottom: 7, left: 4, right: 4 };

export function DocsScreen({ embedded = false, onClose, onAsk }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [docs, setDocs] = useState<DocumentMeta[] | null>(null);
  /** 检索词。空 = 看全部；非空时列表来自 `searchDocuments`，不是本地筛 */
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<DocumentMeta[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  const keyboardHeight = useKeyboardHeight();
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
  /** 多选底条实测高度：提示条要落在它上面，不能写死一个数（见 selectBar 的 onLayout） */
  const [barHeight, setBarHeight] = useState(0);
  /**
   * 勾选顺序无所谓，只用来算范围。
   *
   * v0.28 起勾选**不再限 5 篇**：上限是「一次能问几份」的约束，
   * 而勾选现在还要服务改标签、批量整理、删除。把上限挪到按下「问」的那一刻判断。
   */
  const [selected, setSelected] = useState<number[]>([]);
  /** 点了「问」但选中里有没准备好的：列出来让人决定，**不静默丢掉** */
  const [blocked, setBlocked] = useState<DocumentMeta[] | null>(null);
  /** 云解析确认卡。**重试同样要过这张卡** */
  const [cloudFor, setCloudFor] = useState<DocumentMeta | null>(null);

  /* ---- v0.28：分类、写作、批量 ---- */
  /** 平铺标签。文档页顶部那一行筛选来自它 */
  const [tags, setTags] = useState<DocTag[]>([]);
  /** 正在按哪个标签筛。null = 全部 */
  const [tagFilter, setTagFilter] = useState<number | null>(null);
  /** 写文档。`docId: null` = 新建 */
  const [editorFor, setEditorFor] = useState<{ docId: number | null } | null>(null);
  /** 批量 AI：一篇篇过 */
  const [batchFor, setBatchFor] = useState<{ docs: { id: number; name: string }[] } | null>(null);
  /** 批量改标签的选标签面板 */
  const [tagPick, setTagPick] = useState(false);
  /** 批量删除的二次确认 */
  const [confirmMany, setConfirmMany] = useState(false);
  /** 正滑开着的那一行。父级统一持有，保证同时只开一行 */
  const [openRow, setOpenRow] = useState<number | null>(null);
  /** 长按菜单（右键菜单）针对的那一篇 */
  const [menuFor, setMenuFor] = useState<DocumentMeta | null>(null);

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
      // 标签一起读：文档卡上要显示它，筛选栏也要它。两次请求也不会更快
      const [list, tagList] = await Promise.all([repo.listDocuments(), repo.listDocTags()]);
      if (alive.current) {
        setDocs(list);
        setTags(sortTags(tagList));
        // 筛着的标签被删光了：退回「全部」，否则列表会一直空着且没有解释
        setTagFilter((prev) => (prev !== null && !tagList.some((t) => t.id === prev) ? null : prev));
      }
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
      setSearchError(null);
      return;
    }
    setSearchError(null);
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = await repo.searchDocuments(q, 60);
        if (!cancelled) setHits(found);
      } catch (e) {
        if (!cancelled) {
          setHits([]);
          setSearchError(e instanceof Error ? `搜索失败：${e.message}` : '搜索暂时失败，请修改关键词或清空后重试');
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, docs, docVersion]);

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
   * 「先落原文件、再写记录、失败删原件」这三步在 `documents/importLocal` 里，
   * 与系统分享进来那条路共用同一份顺序 —— 各写一遍早晚有一处会漏掉清理。
   */
  async function handlePick() {
    if (picking) return;
    setPicking(true);
    setNotice(null);
    try {
      const file = await pickDocumentFile();
      if (!file) return;
      await importLocalFile({ uri: file.uri, name: file.name });
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
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /** 多选里点「问」：先分清哪些没准备好，不能偷偷只问剩下的 */
  function askSelected() {
    Keyboard.dismiss();
    const chosen = (docs ?? []).filter((d) => selected.includes(d.id));
    if (!chosen.length) return;
    // 上限只在「问」这一步判断：勾选还服务改标签/整理/删除，那边没有这个约束
    if (chosen.length > MAX_ASK_DOCUMENTS) {
      showToast(`一次最多问 ${MAX_ASK_DOCUMENTS} 份，先去掉几份`);
      return;
    }
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

  /**
   * 删除 = 移到回收站（v0.28）。
   *
   * **不再在这里删文件**：30 天内恢复要能看到图、能打开原件。
   * 真删发生在设置 → 数据 → 回收站（彻底删除，或 30 天后自动清）。
   *
   * 指向这篇的会话徽标仍然要解掉：文档已经不在列表里了，徽标还指着它，
   * 点进去就是一片空白 —— 用户会以为整理出来的内容丢了。
   * 代价是恢复文档不会把徽标接回来，这一点在恢复的提示里如实说。
   */
  async function deleteDocs(list: DocumentMeta[]) {
    if (!list.length) return;
    let done = 0;
    for (const doc of list) {
      // 先停任务：迟到的结果不能写回一条正在被删的记录
      cancelDocumentJob(doc.id);
      try {
        await repo.deleteDocument(doc.id);
        await repo.clearAskSessionDocuments(doc.id);
        dismissDocumentJob(doc.id);
        done += 1;
      } catch {
        /* 单条失败不影响其余：下面按 done 的数量如实汇报 */
      }
    }
    const ids = new Set(list.map((d) => d.id));
    if (openDocId !== null && ids.has(openDocId)) setOpenDocId(null);
    setSelected((prev) => prev.filter((id) => !ids.has(id)));
    showToast(
      done === list.length
        ? list.length === 1
          ? `已移到回收站：${list[0].name}`
          : `${done} 篇已移到回收站`
        : `${done} / ${list.length} 篇移到了回收站，其余没删成`,
    );
    await refresh();
    setDocVersion((v) => v + 1);
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    await deleteDocs([target]);
  }

  const selectedCount = selected.length;
  const covered =
    openDocId !== null || !!pendingDelete || !!cloudFor || !!blocked ||
    !!editorFor || !!batchFor || tagPick || confirmMany || !!menuFor;

  /*
   * 列表的三种状态：检索结果 / 全部 / 按标签筛。
   * 先按 stage 分两段 —— 归档的文档是「AI 重新整理之后让位的那一篇」，
   * 混在库里会让人以为同一个标题有两份内容。
   */
  const source = hits ?? docs ?? [];
  const picked = filterDocsByTag(source, tagFilter);
  const libraryDocs = picked.filter((d) => d.stage !== 'archived');
  const archivedDocs = picked.filter((d) => d.stage === 'archived');
  const selectedDocs = (docs ?? []).filter((d) => selected.includes(d.id));
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (covered || !selectMode) return false;
      setSelectMode(false);
      setSelected([]);
      return true;
    });
    return () => sub.remove();
  }, [covered, selectMode]);

  return (
    <View style={styles.root}>
      <View style={[styles.main, { paddingBottom: keyboardHeight }]} importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={covered}>
      <ScreenHeader
        title={selectMode ? '选择文档' : '文档'}
        subtitle={docs ? (selectMode ? `已选 ${selectedCount} 篇` : `${libraryDocs.length} 篇`) : undefined}
        onBack={selectMode ? exitSelect : embedded ? undefined : onClose}
        right={
          selectMode ? (
            <IconButton name="close" color={c.text2} onPress={exitSelect} label="取消" accessibilityState={{ selected: true }} accessibilityLabel="退出多选" />
          ) : (
            <View style={styles.headerActions}>
              {!isWeb ? (
                <IconButton
                  name="create-outline"
                  color={c.text2}
                  onPress={() => { Keyboard.dismiss(); setEditorFor({ docId: null }); }}
                  label="新建"
                  accessibilityLabel="新建文档"
                />
              ) : null}
              {docs && docs.length > 0 && !isWeb ? (
                <IconButton
                  name="checkmark-circle-outline"
                  color={c.text2}
                  onPress={enterSelect}
                  label="多选"
                  accessibilityState={{ selected: false }}
                  accessibilityLabel="多选文档"
                />
              ) : null}
            </View>
          )
        }
      />

      {/* 检索框常驻在标题下面：文档一多，翻列表找不到东西 */}
      <View style={[styles.searchBar, searchFocused && styles.searchFocused]}>
        <Ionicons name="search" size={16} color={c.text3} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          accessibilityLabel="搜索文档标题、摘要或正文"
          selectionColor={c.selection}
          placeholder="搜标题、摘要或正文"
          placeholderTextColor={c.text3}
          style={styles.searchInput}
          returnKeyType="search"
          autoCorrect={false}
        />
        {searching ? <ActivityIndicator size="small" color={c.text3} /> : null}
        {query ? (
          <IconButton name="close" size={18} diameter={28} onPress={() => setQuery('')} accessibilityLabel="清空搜索" />
        ) : null}
      </View>

      {/*
        标签栏是**平铺**的（用户 2026-11-18 定）：一行能滑的芯片，没有层级。
        筛选在内存里做而不是再进一次库：文档列表已经带着标签，几百篇也就是一次 filter。
      */}
      {tags.length && !selectMode ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tagBar}
          contentContainerStyle={styles.tagBarContent}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            style={[styles.chip, tagFilter === null && styles.chipOn]}
            onPress={() => setTagFilter(null)}
            accessibilityRole="button"
            accessibilityState={{ selected: tagFilter === null }}
            accessibilityLabel="看全部文档"
          >
            <Text style={[styles.chipText, tagFilter === null && styles.chipTextOn]}>全部</Text>
          </Pressable>
          {tags.map((tag) => (
            <Pressable
              key={tag.id}
              style={[styles.chip, tagFilter === tag.id && styles.chipOn]}
              onPress={() => setTagFilter(tagFilter === tag.id ? null : tag.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: tagFilter === tag.id }}
              accessibilityLabel={`只看 ${tag.name} 的文档`}
            >
              <Text style={[styles.chipText, tagFilter === tag.id && styles.chipTextOn]}>{tagChipText(tag)}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <FlatList
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        data={libraryDocs}
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
              /*
               * 两个入口并排，因为它们是**两件不同的事**：
               * 「添加文件」是手上已经有一个东西，「新建文档」是从零开始。
               *
               * 都不带图标（用户 2026-11-19 要求）：这两个词本身就是动作，
               * 前面再加一个 `+` 和一支笔，只是把按钮挤窄一截。
               */
              <View style={styles.entryRow}>
                <Pressable
                  style={({ pressed }) => [styles.uploadBtn, pressed && { opacity: 0.85 }]}
                  onPress={handlePick}
                  disabled={picking}
                  accessibilityRole="button"
                  accessibilityLabel="添加文件"
                  accessibilityState={{ disabled: picking, busy: picking }}
                >
                  {picking ? (
                    <ActivityIndicator size="small" color={c.onAccent} />
                  ) : (
                    <Text style={styles.uploadText}>添加文件</Text>
                  )}
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.writeBtn, pressed && { opacity: 0.85 }]}
                  onPress={() => { Keyboard.dismiss(); setEditorFor({ docId: null }); }}
                  accessibilityRole="button"
                  accessibilityLabel="新建文档"
                >
                  <Text style={styles.writeText}>新建文档</Text>
                </Pressable>
              </View>
            )}

            {/* 「添加只保存原件，不上传，也不会自动解析。」已删（用户 2026-11-15）：
                按钮下面挂一句解释，等于每次进来都要读一遍已经知道的事 */}
            <Pressable style={styles.supportToggle} onPress={() => setShowSupport((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: showSupport }}>
              <Text style={styles.supportText}>格式与解析说明</Text>
              <Ionicons name={showSupport ? 'chevron-up' : 'chevron-down'} size={16} color={c.text2} />
            </Pressable>
            {showSupport ? <View><Text style={styles.limitText}>{LOCAL_SUPPORT_HINT}</Text><Text style={styles.limitText}>{CLOUD_SUPPORT_HINT}</Text></View> : null}

            {notice ? (
              <Text
                style={[styles.notice, notice.kind === 'err' ? styles.noticeErr : styles.noticeOk]}
                accessibilityLiveRegion="polite"
              >
                {notice.text}
              </Text>
            ) : null}
          </View>
        }
        ListFooterComponent={
          archivedDocs.length ? (
            <View style={styles.archivedBlock}>
              <Text style={styles.archivedTitle}>归档 {archivedDocs.length} 篇</Text>
              <Text style={styles.archivedHint}>AI 重新整理之后旧的让位到这里，内容和标签都还在。</Text>
              {archivedDocs.map((item) => (
                <View key={item.id} style={styles.archivedRow}>
                  <DocRow
                    doc={item}
                    selectMode={selectMode}
                    selected={selected.includes(item.id)}
                    swipeOpen={openRow === item.id}
                    onSwipe={(open) => setOpenRow(open ? item.id : null)}
                    onOpen={() => { Keyboard.dismiss(); setOpenDocId(item.id); }}
                    onToggle={() => toggle(item.id)}
                    onMenu={() => { Keyboard.dismiss(); setMenuFor(item); }}
                    onDelete={() => { Keyboard.dismiss(); setPendingDelete(item); }}
                    onLocal={() => prepareMany([item])}
                    onCloud={() => { Keyboard.dismiss(); setCloudFor(item); }}
                  />
                </View>
              ))}
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          docs === null ? (
            <View style={styles.loading}>
              <ActivityIndicator color={c.text3} />
            </View>
          ) : query.trim() && (searching || searchError) ? (
            <EmptyState
              icon="search-outline"
              title={searching ? '正在搜索…' : '搜索未完成'}
              body={searching ? '标题、摘要和已准备的正文' : searchError ?? '稍后再试一次'}
            />
          ) : query.trim() && !searching ? (
            <EmptyState
              icon="search-outline"
              title={`没有找到「${query.trim()}」`}
              /* 原来这里两行在解释「搜什么、为什么搜不到」，压成一句 */
              body="正文还没准备的文档只有文件名能搜"
            />
          ) : tagFilter !== null ? (
            <EmptyState
              icon="pricetag-outline"
              title="这个标签下还没有文档"
              body="在文档详情里可以给任何一篇加标签"
            />
          ) : (
            <EmptyState
              icon="documents-outline"
              title="先存一份文件，或者新建一篇"
              body="导入的原文件留在本机；自己写的文档直接进库，可以随时改"
            />
          )
        }
        renderItem={({ item }) => (
          <DocRow
            doc={item}
            selectMode={selectMode}
            selected={selected.includes(item.id)}
            swipeOpen={openRow === item.id}
            onSwipe={(open) => setOpenRow(open ? item.id : null)}
            onOpen={() => { Keyboard.dismiss(); setOpenDocId(item.id); }}
            onToggle={() => toggle(item.id)}
            onMenu={() => { Keyboard.dismiss(); setMenuFor(item); }}
            onDelete={() => { Keyboard.dismiss(); setPendingDelete(item); }}
            onLocal={() => prepareMany([item])}
            onCloud={() => { Keyboard.dismiss(); setCloudFor(item); }}
          />
        )}
      />

      {selectMode ? (
        <>
        <View
          style={styles.selectBar}
          /*
            实测底条高度给提示条用。
            这里**不是**底栏那 56：底栏在页面之外（SafeAreaView 里页面和底栏是并列的两块），
            页面底部根本没有东西挡着。原来按底栏高度 + 8 算，提示条会悬在离底 60 的地方；
            进入多选又换成写死的 96 —— 一个估一个猜，底条一改文案就又不准了。
          */
          onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}
        >
          <View style={styles.selectInfo}>
            <Text style={styles.selectCount}>已选 {selectedCount} 份</Text>
            <Text style={styles.selectHint}>可以问、改标签、批量整理或删除</Text>
          </View>          <Pressable
            style={({ pressed }) => [
              styles.askBtn,
              (!selectedCount || selectedCount > MAX_ASK_DOCUMENTS) && styles.askBtnOff,
              pressed && { opacity: 0.85 },
            ]}
            onPress={askSelected}
            disabled={!selectedCount || selectedCount > MAX_ASK_DOCUMENTS}
            accessibilityRole="button"
            accessibilityState={{ disabled: !selectedCount || selectedCount > MAX_ASK_DOCUMENTS }}
            accessibilityLabel={`问这 ${selectedCount} 份文档`}
          >
            <Ionicons
              name="chatbubble-ellipses-outline"
              size={16}
              color={selectedCount && selectedCount <= MAX_ASK_DOCUMENTS ? c.onAccent : c.text3}
            />
            <Text style={[styles.askText, (!selectedCount || selectedCount > MAX_ASK_DOCUMENTS) && styles.askTextOff]}>
              {selectedCount > MAX_ASK_DOCUMENTS ? `最多问 ${MAX_ASK_DOCUMENTS} 份` : `问这 ${selectedCount} 份`}
            </Text>
          </Pressable>
        </View>

        {/*
          第二排是批量动作。不挤进上面那一排：五个按钮平分一行，
          每个只剩 60 宽，中文全要折行。破坏性的「删除」放最右。
        */}
        {selectedCount > 0 ? (
          <View style={styles.batchRow}>
            <Pressable
              style={({ pressed }) => [styles.batchPill, pressed && { opacity: 0.7 }]}
              onPress={() => setTagPick(true)}
              accessibilityRole="button"
              accessibilityLabel={`给这 ${selectedCount} 篇改标签`}
            >
              <Ionicons name="pricetags-outline" size={14} color={c.text} />
              <Text style={styles.batchText}>改标签</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.batchPill, pressed && { opacity: 0.7 }]}
              onPress={() => setBatchFor({ docs: selectedDocs.map((d) => ({ id: d.id, name: d.name })) })}
              accessibilityRole="button"
              accessibilityLabel={`批量整理这 ${selectedCount} 篇`}
            >
              <Ionicons name="sparkles-outline" size={14} color={c.text} />
              <Text style={styles.batchText}>批量整理</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.batchPill, styles.batchDanger, pressed && { opacity: 0.7 }]}
              onPress={() => setConfirmMany(true)}
              accessibilityRole="button"
              accessibilityLabel={`删除这 ${selectedCount} 篇`}
            >
              <Ionicons name="trash-outline" size={14} color={c.danger} />
              <Text style={[styles.batchText, styles.batchDangerText]}>删除</Text>
            </Pressable>
          </View>
        ) : null}
        </>
      ) : null}

      </View>

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

      {editorFor ? (
        <DocEditor
          docId={editorFor.docId}
          onClose={() => setEditorFor(null)}
          onSaved={({ created }) => {
            setEditorFor(null);
            showToast(created ? '已存进文档库' : '已保存');
            setDocVersion((v) => v + 1);
            void refresh();
          }}
        />
      ) : null}

      {batchFor ? (
        <BatchSheet
          docs={batchFor.docs}
          /* 关掉就退出多选：批量走完还停在勾选态，用户会以为没生效 */
          onClose={() => { setBatchFor(null); exitSelect(); void refresh(); }}
          onChanged={() => { void refresh(); setDocVersion((v) => v + 1); }}
        />
      ) : null}

      {tagPick ? (
        <TagPickSheet
          tags={tags}
          count={selectedCount}
          onCancel={() => setTagPick(false)}
          onApply={(ids, op) => {
            const list = selectedDocs;
            setTagPick(false);
            void (async () => {
              let done = 0;
              for (const doc of list) {
                const cur = doc.tags.map((t) => t.id);
                const next = op === 'add'
                  ? Array.from(new Set([...cur, ...ids]))
                  : cur.filter((id) => !ids.includes(id));
                try {
                  await repo.setDocumentTags(doc.id, next);
                  done += 1;
                } catch {
                  /* 一篇失败不影响其余 */
                }
              }
              showToast(
                `${done} 篇${op === 'add' ? '加上' : '去掉'}了标签`,
              );
              await refresh();
              setDocVersion((v) => v + 1);
            })();
          }}
        />
      ) : null}

      {menuFor ? (
        <DocMenuSheet
          doc={menuFor}
          onClose={() => setMenuFor(null)}
          onEdit={() => {
            const target = menuFor;
            setMenuFor(null);
            setEditorFor({ docId: target.id });
          }}
          onDelete={() => {
            const target = menuFor;
            setMenuFor(null);
            setPendingDelete(target);
          }}
        />
      ) : null}

      {confirmMany ? (
        <ManyDeleteConfirm
          count={selectedCount}
          onCancel={() => setConfirmMany(false)}
          onConfirm={() => {
            const list = selectedDocs;
            setConfirmMany(false);
            exitSelect();
            void deleteDocs(list);
          }}
        />
      ) : null}

      {/* 有底栏时要抬到底栏之上，否则「已删除」这种反馈会被底栏盖住 */}
      <Toast text={covered ? null : toast} bottom={(selectMode ? barHeight : 0) + 8} />
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
  swipeOpen,
  onSwipe,
  onOpen,
  onToggle,
  onMenu,
  onDelete,
  onLocal,
  onCloud,
}: {
  doc: DocumentMeta;
  selectMode: boolean;
  selected: boolean;
  /** 这一行是不是正滑开着。父级统一持有，保证同时只开一行 */
  swipeOpen: boolean;
  onSwipe: (open: boolean) => void;
  onOpen: () => void;
  onToggle: () => void;
  /** 长按 = 右键菜单（编辑正文 / 移到回收站） */
  onMenu: () => void;
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
    /*
     * 左滑露出「删除」，长按弹菜单（用户 2026-11-19 提的）。
     *
     * 原来右侧常驻一个垃圾桶：它每一次都占着一条边，而删文档一年也用不了几次；
     * 更重要的是，卡片右边那一列被按钮占住之后，标题和摘要的可用宽度一直少一截。
     * 现在常态下右侧是空的，删和改都收到手势里。
     *
     * 长按菜单是给「不知道能左滑」的人的第二条路，也是读屏用户唯一能走通的那条。
     */
    <SwipeRow
      open={swipeOpen ? 'right' : null}
      onOpen={() => onSwipe(true)}
      onClose={() => onSwipe(false)}
      onPress={selectMode ? onToggle : onOpen}
      onLongPress={selectMode ? undefined : onMenu}
      rightAction={{
        label: '删除',
        icon: 'trash-outline',
        bg: c.danger,
        fg: c.onDanger,
        // 先收起操作区再弹确认：取消之后不该留一条敞开的红条
        onPress: () => { onSwipe(false); onDelete(); },
      }}
      surface={c.card}
      style={[styles.card, selected && styles.cardSelected]}
      pressedStyle={styles.cardPressed}
      role={selectMode ? 'checkbox' : 'button'}
      checked={selected}
      label={
        selectMode
          ? `${selected ? '取消选择' : '选择'} ${doc.name}`
          : `打开 ${doc.name}。长按可删除或编辑`
      }
    >
      <View style={styles.cardTop}>
        <View style={styles.cardMain}>
          <View style={styles.titleRow}>
            <Text style={styles.name} numberOfLines={2}>
              {doc.name}
            </Text>
          </View>

          {/* 标题后先说明内容，再展示格式、时间和处理状态。 */}
          {doc.origin === 'knowledge' && doc.excerpt ? (
            <Text style={styles.excerpt} numberOfLines={2}>
              {doc.excerpt}
            </Text>
          ) : null}

          {doc.tags.length ? (
            <View style={styles.docTags}>
              {doc.tags.slice(0, 3).map((tag) => (
                <View key={tag.id} style={styles.docTag}>
                  <Text style={styles.docTagText}>{tag.name}</Text>
                </View>
              ))}
              {doc.tags.length > 3 ? (
                <Text style={styles.docTagMore}>+{doc.tags.length - 3}</Text>
              ) : null}
            </View>
          ) : null}

          <View style={styles.metaRow}>
            <View style={styles.extBadge}>
              <Text style={styles.extText}>
                {doc.stage === 'archived'
                  ? '归档'
                  : doc.origin === 'authored'
                    ? '手写'
                    : doc.origin === 'knowledge'
                      ? '知识'
                      : (doc.ext || 'file').slice(0, 4).toUpperCase()}
              </Text>
            </View>
            <Text style={styles.meta}>
              {sizeText(doc.size)} · {dayLabel(doc.updatedAt)} {formatTime(doc.updatedAt)}
            </Text>
          </View>

          <View style={styles.statusRow}>
            <Ionicons name={icon.name} size={14} color={icon.color} />
            <Text
              style={[
                styles.status,
                doc.state === 'failed' && !running && styles.statusErr,
                running && styles.statusParsing,
                ready && !running && styles.statusReady,
              ]}
            >
              {status}
            </Text>
          </View>

          {doc.state === 'failed' && !running && doc.error ? (
            <Text style={styles.errorText}>
              {doc.error}
            </Text>
          ) : null}
          {limitNote && !running ? (
            <Text style={styles.warnText}>
              {limitNote}
            </Text>
          ) : null}
        </View>

        {/*
          多选态右边只放一枚**看得见但不吃点击**的勾：整行本来就是开关，
          再套一个可点的勾，在 RN Web 上点一下会同时切换两次。
        */}
        {selectMode ? (
          <View style={styles.side} pointerEvents="none">
            <Ionicons
              name={selected ? 'checkmark-circle' : 'ellipse-outline'}
              size={22}
              color={selected ? c.accent : c.text3}
            />
          </View>
        ) : null}
      </View>

      {action ? (
        <View style={styles.cardActions}>
          <Pressable
            style={({ pressed }) => [styles.pill, pressed && { opacity: 0.7 }]}
            // 这枚按钮嵌在「整行」的可点区域里：不拦住冒泡的话，点它会连文档一起打开
            onPress={(e) => { e?.stopPropagation?.(); action.run(); }}
            hitSlop={PILL_SLOP}
            accessibilityRole="button"
            accessibilityLabel={`${action.label} ${doc.name}`}
          >
            <Ionicons name={action.icon} size={13} color={c.accentText} />
            <Text style={styles.pillText}>{action.label}</Text>
          </Pressable>
        </View>
      ) : null}
    </SwipeRow>
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
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable style={styles.backdrop} onPress={onCancel} accessible={false} />
      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
        <View style={styles.sheetHead}>
          <View style={[styles.sheetIcon, styles.sheetIconWarn]}>
            <Ionicons name="hourglass-outline" size={17} color={c.amberText} />
          </View>
          <Text style={styles.sheetTitle}>还有 {docs.length} 份没准备好</Text>
        </View>

        <Text style={styles.sheetHint}>
          这些不能进这次问答的范围。可以先在本机准备，也可以从选择里移除。
        </Text>

        <View style={styles.blockList}>
          {docs.slice(0, MAX_ASK_DOCUMENTS).map((d) => (
            <View key={d.id} style={styles.blockRow}>
              <Text style={styles.blockName}>
                {d.name}
              </Text>
              <Text style={styles.blockReason}>
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
      </ScrollView>
    </View>
  );
}

/**
 * 批量改标签。
 *
 * 只给「加上」和「去掉」两种动作，**没有「替换成」**：
 * 替换会把每篇文档原有的标签全部抹掉，而用户在选择面板里根本看不见
 * 那些被抹掉的是什么。要「只留某一个」的场景，逐篇改更安全。
 */
function TagPickSheet({
  tags,
  count,
  onCancel,
  onApply,
}: {
  tags: DocTag[];
  count: number;
  onCancel: () => void;
  onApply: (ids: number[], op: 'add' | 'remove') => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [picked, setPicked] = useState<number[]>([]);
  const live = useRef(onCancel);
  live.current = onCancel;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { live.current(); return true; });
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable style={styles.backdrop} onPress={onCancel} accessible={false} />
      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
        <View style={styles.sheetHead}>
          <View style={styles.sheetIcon}>
            <Ionicons name="pricetags-outline" size={17} color={c.text2} />
          </View>
          <Text style={styles.sheetTitle}>给这 {count} 篇改标签</Text>
        </View>

        {tags.length ? (
          <View style={styles.tagPickWrap}>
            {tags.map((tag) => {
              const on = picked.includes(tag.id);
              return (
                <Pressable
                  key={tag.id}
                  style={[styles.chip, on && styles.chipOn]}
                  onPress={() => setPicked((prev) => (on ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]))}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={tag.name}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{tag.name}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text style={styles.sheetHint}>
            还没有任何标签。在文档详情里可以新建，新建完这里就能选。
          </Text>
        )}

        <View style={styles.sheetActions}>
          <Pressable
            style={({ pressed }) => [styles.cancelBtn, pressed && { backgroundColor: c.hairSoft }]}
            onPress={onCancel}
          >
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.cancelBtn, !picked.length && styles.btnOff, pressed && { opacity: 0.8 }]}
            onPress={() => onApply(picked, 'remove')}
            disabled={!picked.length}
            accessibilityState={{ disabled: !picked.length }}
          >
            <Text style={styles.cancelText}>去掉</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.startBtn, !picked.length && styles.btnOff, pressed && { opacity: 0.85 }]}
            onPress={() => onApply(picked, 'add')}
            disabled={!picked.length}
            accessibilityState={{ disabled: !picked.length }}
          >
            <Text style={styles.startText}>都加上</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * 长按文档弹出来的菜单 —— 手机上的「右键菜单」。
 *
 * 为什么要有它：左滑能露出删除，但**没滑过的人不知道有这回事**，
 * 读屏用户更是根本滑不出来（滑动手势被列表占用）。
 * 菜单里只放两件事：改正文、移到回收站。改标签在阅读器里已经有入口，不在这里重复。
 */
function DocMenuSheet({
  doc,
  onClose,
  onEdit,
  onDelete,
}: {
  doc: DocumentMeta;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const live = useRef(onClose);
  live.current = onClose;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { live.current(); return true; });
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable style={styles.backdrop} onPress={onClose} accessible={false} />
      <View style={styles.sheet}>
        <View style={styles.sheetContent}>
          <View style={styles.sheetHead}>
            <View style={styles.sheetIcon}>
              <Ionicons name="ellipsis-horizontal" size={17} color={c.text2} />
            </View>
            <Text style={styles.sheetTitle} numberOfLines={2}>{doc.name}</Text>
          </View>

          <View style={styles.menuList}>
            <Pressable
              style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: c.hairSoft }]}
              onPress={onEdit}
              accessibilityRole="button"
              accessibilityLabel="编辑正文"
            >
              <Ionicons name="create-outline" size={17} color={c.text2} />
              <Text style={styles.menuLabel}>编辑正文</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: c.hairSoft }]}
              onPress={onDelete}
              accessibilityRole="button"
              accessibilityLabel="移到回收站"
            >
              <Ionicons name="trash-outline" size={17} color={c.danger} />
              <Text style={[styles.menuLabel, styles.menuDanger]}>移到回收站</Text>
            </Pressable>
          </View>

          <View style={styles.sheetActions}>
            <Pressable
              style={({ pressed }) => [styles.cancelBtn, pressed && { backgroundColor: c.hairSoft }]}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="取消"
            >
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

/** 批量删除确认。**真的只是移到回收站**，文案不能吓人，也不能含糊 */
function ManyDeleteConfirm({
  count,
  onCancel,
  onConfirm,
}: {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const live = useRef(onCancel);
  live.current = onCancel;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { live.current(); return true; });
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable style={styles.backdrop} onPress={onCancel} accessible={false} />
      <View style={styles.sheet}>
        <View style={styles.sheetContent}>
          <View style={styles.sheetHead}>
            <View style={[styles.sheetIcon, styles.sheetIconDanger]}>
              <Ionicons name="trash-outline" size={17} color={c.danger} />
            </View>
            <Text style={styles.sheetTitle}>把 {count} 篇移到回收站？</Text>
          </View>
          <Text style={styles.sheetHint}>
            30 天内都能在「设置 → 数据 → 回收站」里恢复。彻底删除之前，原件和已准备的正文都还在。
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
              <Text style={styles.deleteText}>移到回收站</Text>
            </Pressable>
          </View>
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
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable style={styles.backdrop} onPress={onCancel} accessible={false} />
      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
        <View style={styles.sheetHead}>
          <View style={[styles.sheetIcon, styles.sheetIconDanger]}>
            <Ionicons name="trash-outline" size={17} color={c.danger} />
          </View>
          <Text style={styles.sheetTitle}>移到回收站？</Text>
        </View>

        <Text style={styles.fileName}>
          {doc.name}
        </Text>
        <Text style={styles.sheetHint}>
          会移到回收站，30 天内都能在「设置 → 数据 → 回收站」里恢复。
          彻底删除之前，App 里的原件副本和已准备的正文都还在；手机里原来那个文件始终不受影响。
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
            <Text style={styles.deleteText}>移到回收站</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },
  main: { flex: 1 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: metrics.pagePadding, paddingBottom: SPACE.lg },
  listContentWithBar: { paddingBottom: SPACE.lg },
  /** 卡片间距 12 → 8：卡片本身已经变矮，间距再给 12 就又是一片空白 */
  sep: { height: SPACE.xs },
  loading: { paddingTop: SPACE.xl, alignItems: 'center' },
  uploadBlock: { paddingTop: SPACE.xxs, paddingBottom: SPACE.xs },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
  /** 两个入口并排：主按钮占大头，「新建文档」是次级（宽度够放四个字，不折行） */
  entryRow: { flexDirection: 'row', alignItems: 'stretch', gap: SPACE.xs },
  writeBtn: {
    flexGrow: 0, flexBasis: 112, minHeight: metrics.controlHeight,
    alignItems: 'center', justifyContent: 'center', borderRadius: metrics.buttonRadius,
    backgroundColor: c.card,
  },
  writeText: { ...TYPE.body, color: c.text, fontWeight: '600' },
  /* ---- 标签栏（平铺） ---- */
  tagBar: { flexGrow: 0, marginTop: SPACE.xxs },
  tagBarContent: { paddingHorizontal: metrics.pagePadding, gap: SPACE.xs, alignItems: 'center' },
  chip: {
    minHeight: 32, paddingHorizontal: SPACE.sm, borderRadius: R.pill, backgroundColor: c.hairSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  /** 选中换底色，不描边 —— 与全项目一致 */
  chipOn: { backgroundColor: c.accentBg },
  chipText: { ...TYPE.label, color: c.text2 },
  chipTextOn: { color: c.accentText, fontWeight: '600' },
  tagPickWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, marginTop: SPACE.md },
  /* ---- 卡片上的标签 ---- */
  docTags: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs, marginTop: 3 },
  docTag: { backgroundColor: c.accentBg, borderRadius: R.pill, paddingHorizontal: 6 },
  docTagText: { ...TYPE.caption, color: c.accentText },
  docTagMore: { ...TYPE.caption, color: c.text3 },
  /* ---- 归档段 ---- */
  archivedBlock: { marginTop: SPACE.lg, gap: SPACE.xs },
  archivedTitle: { ...TYPE.label, color: c.text2, fontWeight: '600' },
  archivedHint: { ...TYPE.meta, color: c.text3 },
  archivedRow: { opacity: 0.92 },
  /* ---- 批量动作 ---- */
  batchRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs,
    paddingHorizontal: metrics.pagePadding, paddingBottom: SPACE.sm, backgroundColor: c.page,
  },
  batchPill: {
    flexGrow: 1, flexBasis: 90, minHeight: 40, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 5, borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft,
  },
  batchText: { ...TYPE.label, color: c.text },
  batchDanger: { backgroundColor: c.dangerBg },
  batchDangerText: { color: c.danger },
  btnOff: { backgroundColor: c.hairSoft },
  /** 主操作按钮：48 是触控下限。原来写 44，比同一页所有按钮都矮一截 */
  uploadBtn: {
    flex: 1, minHeight: metrics.controlHeight, borderRadius: metrics.buttonRadius,
    backgroundColor: c.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },
  uploadText: { ...TYPE.body, color: c.onAccent, fontWeight: '600' },
  limitText: { marginTop: SPACE.sm, ...TYPE.compact, color: c.text2 },
  supportToggle: { minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.xs },
  supportText: { ...TYPE.label, color: c.text2, flexShrink: 1 },
  notice: { marginTop: SPACE.sm, ...TYPE.compact },
  noticeOk: { color: c.tealText },
  noticeErr: { color: c.danger },
  webNote: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.xs, backgroundColor: c.hairSoft, borderRadius: metrics.buttonRadius, padding: SPACE.md },
  webText: { flex: 1, ...TYPE.compact, color: c.text2 },
  /** 空态：48 圆 + 浅灰底，全项目同一套规格 */
  /**
   * 检索框和首页用同一套：浅灰胶囊、无边框。
   *
   * 原来这里是「白底 + hair 描边 + 8 圆角」，同一份「搜索」在两个页面
   * 长得完全不一样 —— 首页是胶囊，文档页是表单格。
   */
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 44,
    marginHorizontal: metrics.pagePadding, marginTop: SPACE.xs, marginBottom: SPACE.xs,
    paddingLeft: SPACE.md, paddingRight: SPACE.xxs,
    borderRadius: R.pill, backgroundColor: c.hairSoft,
    // 边框常驻占位（透明），聚焦时只换色 —— 否则聚焦那一刻高度会跳 2px
    borderWidth: metrics.strokeWidth, borderColor: 'transparent',
  },
  /** 聚焦是「持续可见」的状态，用淡主色描边；不用墨水主题的 focus（纯黑） */
  searchFocused: { borderColor: c.accentHair },
  searchInput: { flex: 1, minWidth: 0, minHeight: 44, ...TYPE.body, color: c.text, paddingVertical: SPACE.xxs, ...WEB_INPUT_RESET },
  /** 卡片：白底浮在浅灰页上就够分层了，不描边 */
  card: { backgroundColor: c.card, borderRadius: metrics.cardRadius, overflow: 'hidden' },
  /** 选中：淡蓝底 + 一圈极浅的主色边。原来 2px 纯黑（墨水 focus），是「黑框」的第三个来源 */
  cardSelected: { borderWidth: metrics.strokeWidth, borderColor: c.accentHair, backgroundColor: c.accentBg },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start' },
  cardPressed: { backgroundColor: c.hairSoft },
  /** 卡片正文的内边距 14/12 → 10/10：卡片一共五行，上下各 12 就是白送 24 的高度 */
  /** 右边不再常驻按钮（v0.31），左右内边距对齐了，标题能多放两个字 */
  cardMain: { flex: 1, minWidth: 0, minHeight: metrics.controlHeight, paddingLeft: SPACE.md, paddingRight: SPACE.md, paddingVertical: 10 },
  side: { paddingRight: SPACE.xxs, paddingTop: SPACE.xxs },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start' },
  /**
   * 文档标题 16 → 14。
   *
   * 用户 2026-11-15：「文档页面，字还是太大，导致一个文件的框较大」。
   * 标题是这行里唯一被读的字，但它比正文还大就变成了「每条都像一张卡」。
   * 14/21 + 600 已经能和下面的小字拉开层级，不需要再加字号。
   */
  name: { flex: 1, minWidth: 0, ...TYPE.compact, fontWeight: '600', color: c.text },
  /** 摘要降到 meta（12/18）、只留两行：它是「这篇讲什么」的提示，不是正文 */
  excerpt: { ...TYPE.meta, color: c.text2, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: SPACE.xxs },
  extBadge: { backgroundColor: c.hairSoft, borderRadius: metrics.buttonRadius, paddingHorizontal: 5, paddingVertical: 0 },
  extText: { ...TYPE.caption, color: c.text2, fontWeight: '600' },
  meta: { ...TYPE.meta, color: c.text2, fontVariant: ['tabular-nums'], flexShrink: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  status: { flex: 1, ...TYPE.meta, color: c.text2 },
  statusParsing: { color: c.accentText },
  statusReady: { color: c.tealText },
  statusErr: { color: c.danger },
  errorText: { marginTop: SPACE.xxs, ...TYPE.meta, color: c.danger },
  warnText: { marginTop: SPACE.xxs, ...TYPE.meta, color: c.amberText },
  /** 操作行的左边界要和标题对齐（cardMain 的 paddingLeft 是 pagePadding 系） */
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start', paddingHorizontal: SPACE.md, paddingBottom: SPACE.xs },
  pill: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    minHeight: 34, minWidth: 34, paddingHorizontal: 10, paddingVertical: SPACE.xxs,
    backgroundColor: c.hairSoft, borderRadius: metrics.buttonRadius,
  },
  pillText: { ...TYPE.label, color: c.text },
  selectBar: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE.sm,
    paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.xs, backgroundColor: c.page,
  },
  selectInfo: { flex: 1, minWidth: 140 },
  selectCount: { ...TYPE.body, color: c.text, fontWeight: '600' },
  selectHint: { marginTop: 1, ...TYPE.meta, color: c.text2 },
  askBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: metrics.controlHeight, paddingHorizontal: SPACE.md, borderRadius: metrics.buttonRadius, backgroundColor: c.accent },
  askBtnOff: { backgroundColor: c.hairSoft },
  askText: { ...TYPE.body, color: c.onAccent, fontWeight: '600' },
  askTextOff: { color: c.text3 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', padding: metrics.pagePadding },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.scrim },
  sheet: { flexGrow: 0, maxHeight: '100%', backgroundColor: c.card, borderRadius: metrics.cardRadius },
  /* 长按菜单：一行一个动作，左图标右文字，行高够手指点 */
  menuList: { marginTop: SPACE.xs, borderRadius: metrics.buttonRadius, overflow: 'hidden' },
  menuRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    minHeight: metrics.controlHeight, paddingHorizontal: SPACE.sm,
  },
  menuLabel: { ...TYPE.body, color: c.text },
  menuDanger: { color: c.danger },
  sheetContent: { padding: SPACE.lg },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm },
  sheetIcon: { width: 32, height: 32, borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft, alignItems: 'center', justifyContent: 'center' },
  sheetIconDanger: { backgroundColor: c.dangerBg },
  sheetIconWarn: { backgroundColor: c.amberBg },
  sheetTitle: { ...TYPE.heading, color: c.text, flex: 1 },
  fileName: { marginTop: SPACE.md, ...TYPE.title, color: c.text },
  sheetHint: { marginTop: SPACE.sm, ...TYPE.compact, color: c.text2 },
  blockList: { marginTop: SPACE.sm, gap: SPACE.xs },
  blockRow: { gap: SPACE.xxs, paddingBottom: SPACE.xs, borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
  blockName: { ...TYPE.body, color: c.text, fontWeight: '600' },
  blockReason: { ...TYPE.label, color: c.text2 },
  sheetActions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.lg },
  cancelBtn: { flexGrow: 1, flexBasis: 80, minWidth: 80, minHeight: metrics.controlHeight, padding: SPACE.sm, borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft, alignItems: 'center', justifyContent: 'center' },
  cancelText: { ...TYPE.body, color: c.text2, textAlign: 'center' },
  startBtn: { flexGrow: 1.4, flexBasis: 100, minWidth: 100, minHeight: metrics.controlHeight, padding: SPACE.sm, borderRadius: metrics.buttonRadius, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
  startText: { ...TYPE.body, fontWeight: '600', color: c.onAccent, textAlign: 'center' },
  deleteBtn: { flexGrow: 1.4, flexBasis: 100, minWidth: 100, minHeight: metrics.controlHeight, padding: SPACE.sm, borderRadius: metrics.buttonRadius, backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center' },
  deleteText: { ...TYPE.body, fontWeight: '600', color: c.onDanger, textAlign: 'center' },
});
