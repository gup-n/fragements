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
import { C, R } from '../theme';
import { repo } from '../db/repo';
import { loadAiConfig, saveAiConfig } from '../ai/config';
import { AiError, testConnection } from '../ai/chat';
import { exportMarkdown } from '../export/markdown';
import { APP_VERSION } from '../version';
import { ScreenHeader } from '../components/ScreenHeader';

interface Props {
  fragments: Fragment[];
  onClose: () => void;
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

export function SettingsScreen({ fragments, onClose }: Props) {
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [thinking, setThinking] = useState(true);
  const [effort, setEffort] = useState<ReasoningEffort>('high');
  const [showKey, setShowKey] = useState(false);
  const [stats, setStats] = useState({ total: 0, inbox: 0, todoOpen: 0, tags: 0 });
  const [busy, setBusy] = useState<'idle' | 'saving' | 'testing' | 'exporting' | 'indexing'>('idle');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      const cfg = await loadAiConfig();
      setBaseUrl(cfg.baseUrl);
      setModel(cfg.model);
      setApiKey(cfg.apiKey);
      setThinking(cfg.thinking);
      setEffort(cfg.effort);
      setStats(await repo.stats());
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
    setMsg(null);
    try {
      const { indexed } = await repo.rebuildSearchIndex();
      setMsg({ kind: 'ok', text: `已重建索引，共 ${indexed} 条` });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || '重建失败' });
    } finally {
      setBusy('idle');
    }
  }

  async function handleExport() {
    setBusy('exporting');
    setMsg(null);
    try {
      const todos = await repo.listTodos();
      const { message } = await exportMarkdown(fragments, todos);
      setMsg({ kind: 'ok', text: message });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || '导出失败' });
    } finally {
      setBusy('idle');
    }
  }

  return (
    <View style={styles.root}>
      <ScreenHeader title="设置" subtitle={'v' + APP_VERSION} onBack={onClose} />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.groupTitle}>AI 接口</Text>
        <View style={styles.card}>
          <Field label="Base URL">
            <TextInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="https://api.deepseek.com/v1"
              placeholderTextColor={C.text3}
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
              placeholderTextColor={C.text3}
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
                placeholderTextColor={C.text3}
                style={[styles.input, styles.keyInput]}
              />
              <Pressable onPress={() => setShowKey((v) => !v)} hitSlop={8}>
                <Ionicons
                  name={showKey ? 'eye-off-outline' : 'eye-outline'}
                  size={17}
                  color={C.text3}
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
                <ActivityIndicator size="small" color="#FFFFFF" />
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

          <Pressable
            style={styles.ghostBtnWide}
            onPress={handleRebuildIndex}
            disabled={busy !== 'idle'}
          >
            <Ionicons name="refresh-outline" size={15} color={C.text} />
            <Text style={styles.ghostBtnText}>
              {busy === 'indexing' ? '正在重建…' : '重建搜索索引'}
            </Text>
          </Pressable>

          <Pressable style={styles.ghostBtnWide} onPress={handleExport} disabled={busy !== 'idle'}>
            <Ionicons name="download-outline" size={15} color={C.text} />
            <Text style={styles.ghostBtnText}>
              {busy === 'exporting' ? '正在导出…' : '导出 Markdown'}
            </Text>
          </Pressable>
          <Text style={styles.note}>
            导出成一个 .md 文件，按天分节，标签写成 #tag。放到 NAS 或者 Obsidian
            里都能直接读，也算是一份逃生舱。
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
  return (
    <View style={[styles.field, last && { borderBottomWidth: 0 }]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Stat({ num, label }: { num: number; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statNum}>{num}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.page },

  content: { paddingHorizontal: 16, paddingBottom: 40 },
  groupTitle: {
    fontSize: 11.5,
    color: C.text2,
    fontWeight: '600',
    letterSpacing: 0.6,
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 14,
  },
  field: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  fieldLabel: { fontSize: 11, color: C.text3, marginBottom: 5 },
  input: {
    fontSize: 14.5,
    color: C.text,
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
    borderColor: C.hair,
  },
  ghostBtnWide: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: C.hair,
    marginTop: 14,
  },
  ghostBtnText: { fontSize: 13, color: C.text },
  solidBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: R.btn,
    backgroundColor: C.accent,
  },
  solidBtnText: { fontSize: 13, color: '#FFFFFF', fontWeight: '500' },

  msg: { fontSize: 12, lineHeight: 19, marginTop: 12 },
  msgOk: { color: C.tealText },
  msgErr: { color: C.danger },
  note: { fontSize: 11, color: C.text3, lineHeight: 18, marginTop: 12 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toggle: {
    width: 38,
    height: 22,
    borderRadius: 11,
    backgroundColor: C.hair,
    padding: 2,
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  toggleOn: { backgroundColor: C.accent, justifyContent: 'flex-end' },
  toggleKnob: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF' },
  toggleHint: { flex: 1, fontSize: 11, color: C.text3, lineHeight: 16 },

  chipRow: { flexDirection: 'row', gap: 7 },
  chip: {
    borderRadius: R.pill,
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  chipOn: { backgroundColor: C.accentBg, borderColor: C.accentBg },
  chipText: { fontSize: 12, color: C.text2, lineHeight: 17 },
  chipTextOn: { color: C.accentText },
  fieldHint: { fontSize: 11, color: C.text3, marginTop: 7, lineHeight: 16 },

  statRow: { flexDirection: 'row', gap: 10, marginBottom: 4 },
  stat: {
    flex: 1,
    backgroundColor: C.hairSoft,
    borderRadius: R.btn,
    paddingVertical: 12,
    alignItems: 'center',
  },
  statNum: { fontSize: 20, color: C.text, fontWeight: '600' },
  statLabel: { fontSize: 11, color: C.text3, marginTop: 3 },

  aboutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  aboutKey: { fontSize: 13.5, color: C.text2 },
  aboutVal: { fontSize: 13.5, color: C.text3, fontVariant: ['tabular-nums'] },
});
