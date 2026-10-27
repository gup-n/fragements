import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Fragment, ReasoningEffort } from '../types';
import {
  R,
  THEME_MODE_LABEL,
  useTheme,
  useThemedStyles,
  type Palette,
  type ThemeMode,
} from '../theme';
import { repo } from '../db/repo';
import { loadAiConfig, saveAiConfig } from '../ai/config';
import { AiError, testConnection } from '../ai/chat';
import { exportMarkdown } from '../export/markdown';
import { applyImport, pickMarkdown, previewImport, type ImportPreview } from '../db/importMd';
import { looksBinary } from '../util/mdParse';
import { ImportSheet } from '../components/ImportSheet';
import { APP_VERSION } from '../version';
import { ScreenHeader } from '../components/ScreenHeader';
import type { IoniconName } from '../components/IconButton';

interface Props {
  fragments: Fragment[];
  onClose: () => void;
  /** 导入会新增碎片，得让 App 重新拉一遍时间轴 */
  onChanged: () => void;
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  low: '轻',
  high: '标准',
  max: '深',
};

const EFFORT_HINT: Record<ReasoningEffort, string> = {
  low: '想得快，适合碎片少、结构简单的时候',
  high: '默认。绝大多数情况下够用',
  max: '想得最细，慢一些、贵一些',
};

export function SettingsScreen({ fragments, onClose, onChanged }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const { mode, setMode } = useTheme();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [thinking, setThinking] = useState(true);
  const [effort, setEffort] = useState<ReasoningEffort>('high');
  const [showKey, setShowKey] = useState(false);
  const [stats, setStats] = useState({ total: 0, inbox: 0, todoOpen: 0, tags: 0 });
  const [busy, setBusy] = useState<
    'idle' | 'saving' | 'testing' | 'exporting' | 'indexing' | 'picking' | 'importing'
  >('idle');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /**
   * 数据区自己的反馈位。
   *
   * 原来所有操作共用上面那个 `msg`，而 `msg` 渲染在「AI 接口」卡片里 ——
   * 人在页面最下面点「重建搜索索引」，提示出现在屏幕上方几十甚至几百像素外，
   * 看起来就是「点了没反应」。分开之后，谁触发的就显示在谁旁边。
   */
  const [indexMsg, setIndexMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** 导出/导入的反馈，渲染在它们自己的按钮下方 */
  const [ioMsg, setIoMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** 索引健康度。null = 还没查出来 */
  const [indexState, setIndexState] = useState<{ indexed: number; total: number } | null>(null);
  /** 搜索自检结果。checked = 抽了几条，hit = 有几条能搜回来 */
  const [probe, setProbe] = useState<{ checked: number; hit: number } | null>(null);
  /** 非空时弹导入确认页。选完文件先看预览，确认了才写库 */
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);

  useEffect(() => {
    (async () => {
      const cfg = await loadAiConfig();
      setBaseUrl(cfg.baseUrl);
      setModel(cfg.model);
      setApiKey(cfg.apiKey);
      setThinking(cfg.thinking);
      setEffort(cfg.effort);
      setStats(await repo.stats());
      // 先出条数（一次 COUNT，很快），自检要真跑几次搜索，后到不影响阅读
      setIndexState(await repo.searchIndexStats());
      setProbe(await repo.selfTestSearch(5));
    })();
  }, []);

  async function handleSave() {
    setBusy('saving');
    setMsg(null);
    try {
      await saveAiConfig({ baseUrl, model, apiKey, thinking, effort });
      setMsg({ kind: 'ok', text: '已保存' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy('idle');
    }
  }

  async function handleTest() {
    setBusy('testing');
    setMsg(null);
    try {
      const text = await testConnection({ baseUrl, model, apiKey, thinking, effort });
      setMsg({ kind: 'ok', text });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as AiError).message || '连接失败' });
    } finally {
      setBusy('idle');
    }
  }

  /**
   * 重建全文索引。「问」和搜索都靠它；迁移回填失败、或者从别处导入了
   * 一批碎片之后，这里的兜底入口能让搜索重新可用，不用重装 App。
   */
  async function handleRebuildIndex() {
    setBusy('indexing');
    setIndexMsg(null);
    try {
      const before = indexState?.indexed ?? null;
      const { indexed } = await repo.rebuildSearchIndex();
      const [nextIndex, nextProbe] = await Promise.all([
        repo.searchIndexStats(),
        repo.selfTestSearch(5),
      ]);
      setIndexState(nextIndex);
      setProbe(nextProbe);

      // 报「修了什么」，不只报「成功了」：条数没变就说没变，别让人误以为修好了什么
      const parts = [`已重建 ${indexed} 条`];
      if (nextProbe.checked > 0) parts.push(`自检 ${nextProbe.hit}/${nextProbe.checked} 通过`);
      if (before !== null && before !== indexed) parts.push(`原来 ${before} 条`);
      setIndexMsg({ kind: 'ok', text: parts.join(' · ') });
    } catch (e) {
      setIndexMsg({ kind: 'err', text: (e as Error).message || '重建失败' });
    } finally {
      setBusy('idle');
    }
  }

  async function handlePickImport() {
    setBusy('picking');
    setIoMsg(null);
    try {
      const file = await pickMarkdown();
      if (!file) return;
      if (looksBinary(file.text)) {
        setIoMsg({
          kind: 'err',
          text: '这个文件读不出文本。可能是选错了文件，或者它是 GBK 编码——用记事本另存为 UTF-8 再试。',
        });
        return;
      }
      const preview = await previewImport(file);
      if (!preview.total) {
        setIoMsg({
          kind: 'err',
          text: '文件里没找到能导入的条目。需要 `- 内容` 这样的列表行，上面最好有 `### 2026-10-25` 这样的日期标题。',
        });
        return;
      }
      setImportPreview(preview);
    } catch (e) {
      setIoMsg({ kind: 'err', text: (e as Error).message || '读取文件失败' });
    } finally {
      setBusy('idle');
    }
  }

  async function handleConfirmImport() {
    if (!importPreview) return;
    setBusy('importing');
    setIoMsg(null);
    try {
      const { inserted, tagged } = await applyImport(importPreview.fresh);
      setImportPreview(null);
      setStats(await repo.stats());
      onChanged();
      setIoMsg({
        kind: 'ok',
        text: tagged
          ? `已导入 ${inserted} 条，其中 ${tagged} 条带标签（直接算已整理）`
          : `已导入 ${inserted} 条`,
      });
    } catch (e) {
      // 不回滚：已经写进去的靠判重挡着，重试不会产生重复
      setIoMsg({ kind: 'err', text: (e as Error).message || '写入失败，可以再点一次导入' });
    } finally {
      setBusy('idle');
    }
  }

  async function handleExport() {
    setBusy('exporting');
    setIoMsg(null);
    try {
      const todos = await repo.listTodos();
      const { message } = await exportMarkdown(fragments, todos);
      setIoMsg({ kind: 'ok', text: message });
    } catch (e) {
      setIoMsg({ kind: 'err', text: (e as Error).message || '导出失败' });
    } finally {
      setBusy('idle');
    }
  }

  // 索引状态分两层说：条数对不对是「完整性」，自检命中率是「可用性」。
  // 只报完整可能是「全建了但搜不出来」，只报自检又看不出漏了哪几条。
  const indexOk = !!indexState && indexState.indexed === indexState.total;
  const probeOk = !probe || probe.checked === 0 || probe.hit === probe.checked;
  const indexHealthy = indexOk && probeOk;
  // 空库谈不上健康，别给它打绿勾
  const indexEmpty = !!indexState && indexState.total === 0;
  const indexColor =
    !indexState || indexEmpty ? c.text2 : indexHealthy ? c.tealText : c.danger;
  const indexIcon: IoniconName = !indexState
    ? 'ellipsis-horizontal-circle-outline'
    : indexEmpty
      ? 'information-circle-outline'
      : indexHealthy
        ? 'checkmark-circle-outline'
        : 'alert-circle-outline';
  const indexLine = !indexState
    ? '正在检查索引…'
    : indexState.total === 0
      ? '库里还没有碎片'
      : indexOk
        ? `索引完整 · ${indexState.total} 条全部可搜`
        : `索引不全 · ${indexState.total} 条里缺 ${indexState.total - indexState.indexed} 条`;
  const probeLine = !probe
    ? '正在自检…'
    : probe.checked === 0
      ? indexEmpty
        ? '空库没有可自检的碎片'
        : '能自检的碎片还不够（太短），先记几条长一点的'
      : probe.hit === probe.checked
        ? `抽样自检：拿正文中的一段往回搜，${probe.checked} 条全部搜回`
        : `抽样自检：${probe.checked} 条里只有 ${probe.hit} 条能搜回，搜索可能不准`;

  return (
    <View style={styles.root}>
      <ScreenHeader title="设置" subtitle={'v' + APP_VERSION} onBack={onClose} />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.groupTitle}>外观</Text>
        <View style={styles.card}>
          <View style={styles.chipRow}>
            {(['light', 'dark', 'system'] as const).map((m) => (
              <Pressable
                key={m}
                style={[styles.chip, mode === m && styles.chipOn]}
                onPress={() => setMode(m)}
                accessibilityRole="button"
                accessibilityState={{ selected: mode === m }}
              >
                <Text style={[styles.chipText, mode === m && styles.chipTextOn]}>
                  {THEME_MODE_LABEL[m]}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.note}>
            {mode === 'system'
              ? '跟着手机的深色模式走 —— 系统几点切深色，这里就几点换。'
              : `固定用${THEME_MODE_LABEL[mode]}，手机怎么切都不变。`}
          </Text>
        </View>

        <Text style={styles.groupTitle}>AI 接口</Text>
        <View style={styles.card}>
          <Field label="Base URL">
            <TextInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="https://api.deepseek.com/v1"
              placeholderTextColor={c.text3}
              style={styles.input}
            />
          </Field>
          <Field label="模型">
            <TextInput
              value={model}
              onChangeText={setModel}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="deepseek-flash"
              placeholderTextColor={c.text3}
              style={styles.input}
            />
          </Field>
          <Field label="API Key" last>
            <View style={styles.keyRow}>
              <TextInput
                value={apiKey}
                onChangeText={setApiKey}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={!showKey}
                placeholder="sk-…"
                placeholderTextColor={c.text3}
                style={[styles.input, styles.keyInput]}
              />
              <Pressable onPress={() => setShowKey((v) => !v)} hitSlop={8}>
                <Ionicons
                  name={showKey ? 'eye-off-outline' : 'eye-outline'}
                  size={17}
                  color={c.text3}
                />
              </Pressable>
            </View>
          </Field>

          <View style={styles.btnRow}>
            <Pressable style={styles.ghostBtn} onPress={handleSave} disabled={busy !== 'idle'}>
              <Text style={styles.ghostBtnText}>
                {busy === 'saving' ? '保存中…' : '保存'}
              </Text>
            </Pressable>
            <Pressable style={styles.solidBtn} onPress={handleTest} disabled={busy !== 'idle'}>
              {busy === 'testing' ? (
                <ActivityIndicator size="small" color={c.onAccent} />
              ) : (
                <Text style={styles.solidBtnText}>测试连接</Text>
              )}
            </Pressable>
          </View>

          {msg && (
            <Text style={[styles.msg, msg.kind === 'err' ? styles.msgErr : styles.msgOk]}>
              {msg.text}
            </Text>
          )}

          <Text style={styles.note}>
            Key 存在手机的安全存储里（Android Keystore），不会上传到任何服务器。换服务商只要改 Base
            URL 和模型名，接口是 OpenAI 兼容格式。
          </Text>
        </View>

        <Text style={styles.groupTitle}>整理行为</Text>
        <View style={styles.card}>
          <Field label="思考过程" last={!thinking}>
            <View style={styles.toggleRow}>
              <Pressable
                style={[styles.toggle, thinking && styles.toggleOn]}
                onPress={() => setThinking((v) => !v)}
                hitSlop={6}
              >
                <View style={styles.toggleKnob} />
              </Pressable>
              <Text style={styles.toggleHint}>
                {thinking
                  ? '模型先推理再给结果，整理时能看到它在想什么'
                  : '直接出结果，更快更省，但看不到过程'}
              </Text>
            </View>
          </Field>

          {thinking && (
            <Field label="思考强度" last>
              <View style={styles.chipRow}>
                {(['low', 'high', 'max'] as const).map((e) => (
                  <Pressable
                    key={e}
                    style={[styles.chip, effort === e && styles.chipOn]}
                    onPress={() => setEffort(e)}
                  >
                    <Text style={[styles.chipText, effort === e && styles.chipTextOn]}>
                      {EFFORT_LABEL[e]}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.fieldHint}>{EFFORT_HINT[effort]}</Text>
            </Field>
          )}

          <Text style={styles.note}>
            只有 DeepSeek 的 V4 系列（deepseek-flash / deepseek-v4-pro）认这两个设置。
            换成别的兼容服务时不会发这些参数，免得对方直接报错。
          </Text>
        </View>

        <Text style={styles.groupTitle}>数据</Text>
        <View style={styles.card}>
          <View style={styles.statRow}>
            <Stat num={stats.total} label="总条数" />
            <Stat num={stats.inbox} label="待整理" />
            <Stat num={stats.todoOpen} label="未完成待办" />
            <Stat num={stats.tags} label="标签" />
          </View>

          <View style={styles.indexBox}>
            <View style={styles.indexHead}>
              <Ionicons name={indexIcon} size={14} color={indexColor} />
              <Text style={[styles.indexTitle, { color: indexColor }]}>{indexLine}</Text>
            </View>
            <Text style={styles.indexHint}>{probeLine}</Text>
            {indexMsg && (
              <Text
                style={[styles.indexHint, indexMsg.kind === 'err' ? styles.msgErr : styles.msgOk]}
              >
                {indexMsg.text}
              </Text>
            )}
          </View>

          <Pressable
            style={styles.ghostBtnWide}
            onPress={handleRebuildIndex}
            disabled={busy !== 'idle'}
          >
            <Ionicons name="refresh-outline" size={15} color={c.text} />
            <Text style={styles.ghostBtnText}>
              {busy === 'indexing' ? '正在重建…' : '重建搜索索引'}
            </Text>
          </Pressable>
          <Text style={styles.note}>
            搜索和「问」的检索都走这张索引。平时不用点 —— 只有明明记过、却搜不出来的时候才需要重来一遍。
          </Text>

          <Pressable style={styles.ghostBtnWide} onPress={handleExport} disabled={busy !== 'idle'}>
            <Ionicons name="download-outline" size={15} color={c.text} />
            <Text style={styles.ghostBtnText}>
              {busy === 'exporting' ? '正在导出…' : '导出 Markdown'}
            </Text>
          </Pressable>
          <Pressable
            style={styles.ghostBtnWide}
            onPress={handlePickImport}
            disabled={busy !== 'idle'}
          >
            <Ionicons name="cloud-upload-outline" size={15} color={c.text} />
            <Text style={styles.ghostBtnText}>
              {busy === 'picking' ? '正在读取…' : '从 Markdown 导入'}
            </Text>
          </Pressable>
          {ioMsg && (
            <Text style={[styles.msg, ioMsg.kind === 'err' ? styles.msgErr : styles.msgOk]}>
              {ioMsg.text}
            </Text>
          )}
          <Text style={styles.note}>
            导出成一个 .md 文件，按天分节，标签写成 #tag。放到 NAS 或者 Obsidian
            里都能直接读，也是一份逃生舱。
          </Text>
          <Text style={styles.note}>
            导入认的就是这个格式：日期标题下面的 `- 21:40 正文 #标签`。库里已经有的
            内容会按「同一天、同一分钟、同样正文」自动跳过，重复导同一个文件不会翻倍。
          </Text>
        </View>

        <Text style={styles.groupTitle}>关于</Text>
        <View style={styles.card}>
          <View style={styles.aboutRow}>
            <Text style={styles.aboutKey}>版本</Text>
            <Text style={styles.aboutVal}>{APP_VERSION}</Text>
          </View>
          <View style={styles.aboutRow}>
            <Text style={styles.aboutKey}>包名</Text>
            <Text style={styles.aboutVal}>com.local.fragments</Text>
          </View>
          <View style={[styles.aboutRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.aboutKey}>运行环境</Text>
            <Text style={styles.aboutVal}>{Platform.OS}</Text>
          </View>
        </View>
      </ScrollView>

      {importPreview && (
        <ImportSheet
          preview={importPreview}
          busy={busy === 'importing'}
          onCancel={() => setImportPreview(null)}
          onConfirm={handleConfirmImport}
        />
      )}
    </View>
  );
}

function Field({
  label,
  children,
  last,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  return (
    <View style={[styles.field, last && { borderBottomWidth: 0 }]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Stat({ num, label }: { num: number; label: string }) {
  const { c, styles } = useThemedStyles(makeStyles);
  return (
    <View style={styles.stat}>
      <Text style={styles.statNum}>{num}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },

  content: { paddingHorizontal: 16, paddingBottom: 40 },
  groupTitle: {
    fontSize: 11.5,
    color: c.text2,
    fontWeight: '600',
    letterSpacing: 0.6,
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    padding: 14,
  },
  field: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  fieldLabel: { fontSize: 11, color: c.text3, marginBottom: 5 },
  input: {
    fontSize: 14.5,
    color: c.text,
    paddingVertical: 2,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  keyInput: { flex: 1 },

  btnRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  ghostBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: c.hair,
  },
  ghostBtnWide: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: c.hair,
    marginTop: 14,
  },
  ghostBtnText: { fontSize: 13, color: c.text },
  solidBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: R.btn,
    backgroundColor: c.accent,
  },
  solidBtnText: { fontSize: 13, color: c.onAccent, fontWeight: '500' },

  msg: { fontSize: 12, lineHeight: 19, marginTop: 12 },
  msgOk: { color: c.tealText },
  msgErr: { color: c.danger },
  note: { fontSize: 11, color: c.text3, lineHeight: 18, marginTop: 12 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toggle: {
    width: 38,
    height: 22,
    borderRadius: 11,
    backgroundColor: c.hair,
    padding: 2,
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  toggleOn: { backgroundColor: c.accent, justifyContent: 'flex-end' },
  toggleKnob: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF' },
  toggleHint: { flex: 1, fontSize: 11, color: c.text3, lineHeight: 16 },

  chipRow: { flexDirection: 'row', gap: 7 },
  chip: {
    borderRadius: R.pill,
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderWidth: 0.5,
    borderColor: c.hair,
  },
  chipOn: { backgroundColor: c.accentBg, borderColor: c.accentBg },
  chipText: { fontSize: 12, color: c.text2, lineHeight: 17 },
  chipTextOn: { color: c.accentText },
  fieldHint: { fontSize: 11, color: c.text3, marginTop: 7, lineHeight: 16 },

  statRow: { flexDirection: 'row', gap: 10, marginBottom: 4 },
  stat: {
    flex: 1,
    backgroundColor: c.hairSoft,
    borderRadius: R.btn,
    paddingVertical: 12,
    alignItems: 'center',
  },
  statNum: { fontSize: 20, color: c.text, fontWeight: '600' },
  statLabel: { fontSize: 11, color: c.text3, marginTop: 3 },

  indexBox: {
    marginTop: 14,
    backgroundColor: c.hairSoft,
    borderRadius: R.btn,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  indexHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  indexTitle: { flex: 1, fontSize: 12.5, fontWeight: '500', lineHeight: 18 },
  indexHint: { fontSize: 11, color: c.text3, lineHeight: 17, marginTop: 4 },

  aboutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  aboutKey: { fontSize: 13.5, color: c.text2 },
  aboutVal: { fontSize: 13.5, color: c.text3, fontVariant: ['tabular-nums'] },
});
