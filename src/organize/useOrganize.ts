/** Ask 的整理控制器。持久化状态只有 workspace 一份；页面不再自己维护第二套写入计划。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskSession, Fragment, QaScope, QaTurn } from '../types';
import { repo } from '../db/repo';
import { loadAiConfig } from '../ai/config';
import { extractKnowledge, formatFragments, formatTurns, reviseDraft, trimMaterial, type TodoSnapshot } from '../ai/knowledge';
import { readPendingImages } from '../ai/imageReads';
import { contentFromText } from '../documents/readers/chunk';
import { docNameOf, describeForHistory, excerptOf, type DraftMode, type KnowledgeDraft } from '../util/knowledgeDoc';
import { hasReadableText } from '../util/fragmentText';
import { wantsAll } from '../util/askIntent';
import { errorDetailOf } from '../components/AgentError';
import { clampTitle } from '../util/text';
import { createWorkspaceStore, readCommittedWorkspace } from './storage';
import {
  createWorkspace, ensureDraftIdentity, hasUnfinishedWork, ownerOfSession, remainingIds, selectDraftTargets,
  type DraftOwner, type DraftWorkspace, type SourceSnapshot,
} from './workspace';
import { executeOrganize } from './run';

// 跨 Ask 挂载共用写队列；上一页的保存不得迟到覆盖新一页。
const store = createWorkspaceStore(repo);
export interface StartDraftOptions {
  instruction?: string;
  turns?: QaTurn[];
  session?: AskSession;
  fragments?: Fragment[];
  all?: boolean;
  append?: boolean;
}
interface Options {
  context: Fragment | null;
  scope: QaScope;
  getOwner(): DraftOwner;
  getSessionGeneration(): number;
  onSessionUpdated(owner: DraftOwner, previousId: number | null): void;
  onRestoreOwner(owner: DraftOwner): void;
  onSaved(): void | Promise<void>;
  onHistoryChanged(): void | Promise<void>;
  showToast(text: string): void;
}
export function useOrganize(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [workspace, setWorkspace] = useState<DraftWorkspace | null>(null);
  const workRef = useRef<DraftWorkspace | null>(null);
  const [recovery, setRecovery] = useState<DraftWorkspace | null>(null);
  const recoveryRef = useRef<DraftWorkspace | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ReturnType<typeof errorDetailOf> | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [received, setReceived] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const alive = useRef(true);
  const generation = useRef(0);
  const lock = useRef(false);
  const saveSerial = useRef(0);
  const progress = useRef(0);
  const publish = useCallback((work: DraftWorkspace | null) => {
    workRef.current = work;
    if (alive.current) setWorkspace(work);
  }, []);
  const rememberRecovery = useCallback((work: DraftWorkspace | null) => {
    recoveryRef.current = work;
    if (alive.current) setRecovery(work);
  }, []);
  const persist = useCallback(async (work: DraftWorkspace) => {
    const order = ++saveSerial.current;
    try {
      await store.save(work);
      if (alive.current && order === saveSerial.current) setStorageError(null);
    } catch (e) {
      if (alive.current && order === saveSerial.current) setStorageError(e instanceof Error ? e.message : '本地草稿没有保存成功');
      throw e;
    }
  }, []);
  const reloadRecovery = useCallback(async () => {
    try {
      const snapshot = await store.load();
      const found = snapshot ? await readCommittedWorkspace(snapshot, repo) : null;
      if (!alive.current) return;
      rememberRecovery(found);
      setStorageError(null);
      setLoaded(true);
    } catch (e) {
      if (alive.current) { setStorageError(e instanceof Error ? e.message : '草稿无法读取'); setLoaded(false); }
    }
  }, [rememberRecovery]);
  useEffect(() => {
    alive.current = true;
    void reloadRecovery();
    return () => { alive.current = false; generation.current++; };
  }, [reloadRecovery]);
  useEffect(() => {
    if (!workspace || busy || saving) return;
    const timer = setTimeout(() => {
      const latestWork = workRef.current;
      if (!lock.current && latestWork?.draft.draftId === workspace.draft.draftId) void persist(latestWork).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [workspace, busy, saving, persist]);
  useEffect(() => {
    if (!busy) return;
    const at = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - at) / 1000)), 500);
    return () => clearInterval(timer);
  }, [busy]);

  const current = (gen: number) => alive.current && generation.current === gen;
  const change = (patch: Partial<DraftWorkspace>) => {
    const work = workRef.current;
    if (!work || lock.current) return;
    publish({ ...work, ...patch, updatedAt: Date.now() });
  };
  function changeDraft(draft: KnowledgeDraft) {
    const work = workRef.current;
    if (!work || lock.current) return;
    if (work.pendingRevision) setError(null);
    change({
      draft: ensureDraftIdentity(draft, work.draft.draftId),
      pendingRevision: null,
      note: work.pendingRevision ? '手动修改已保留，原改稿重试已取消；需要继续改稿时请重新发送要求。' : work.note,
    });
  }
  async function loadTodos(): Promise<TodoSnapshot[]> {
    const all = await repo.listTodos();
    const roots = all.filter((t) => t.parentId === null && t.mergedInto === null);
    return [...roots.filter((t) => !t.done), ...roots.filter((t) => t.done).slice(0, 12)].map((t) => ({
      text: t.text, done: t.done, due: t.dueAt,
      children: all.filter((c) => c.parentId === t.id && c.mergedInto === null).map((c) => c.text),
    }));
  }

  /** 同一份草稿的历史摘要更新同一轮，不在重试/继续时复制整场聊天。 */
  async function recordHistory(work: DraftWorkspace, gen: number, sessionGen: number): Promise<DraftWorkspace> {
    const old = work.request.owner;
    let owner = old;
    type OrganizeTurn = QaTurn & { organizeDraftId?: string };
    if (old.id !== null) {
      const stored = await repo.findAskSession(old.id);
      if (!stored) throw new Error('这份草稿关联的会话已被删除，未重新创建它');
      owner = ownerOfSession(stored);
    } else {
      // saveAskSession 已成功但工作区 owner 落盘前被杀进程：按草稿身份找回，不造第二场历史。
      const sessions = await repo.listAskSessions(true);
      const stored = sessions.find((session) => session.turns.some((turn) => (turn as OrganizeTurn).organizeDraftId === work.draft.draftId));
      if (stored) owner = ownerOfSession(stored);
    }
    if (!current(gen)) return work;
    const turn: OrganizeTurn = {
      question: work.request.instruction,
      answer: describeForHistory(work.draft, remainingIds(work).length),
      sourceIds: [...work.draft.sourceIds], kind: 'organize', organizeDraftId: work.draft.draftId,
    };
    const turns = [...owner.turns.filter((t) => (t as OrganizeTurn).organizeDraftId !== work.draft.draftId), turn];
    const title = clampTitle(owner.title || work.request.instruction, 32) || '整理';
    const id = await repo.saveAskSession({ id: owner.id ?? undefined, title, turns, scope: owner.scope, createdAt: owner.createdAt });
    if (!current(gen)) return work;
    const updatedOwner = { ...owner, id, title, turns };
    const next = { ...work, request: { ...work.request, owner: updatedOwner } };
    publish(next);
    if (current(gen) && latest.current.getSessionGeneration() === sessionGen) latest.current.onSessionUpdated(updatedOwner, old.id);
    await persist(next);
    if (current(gen)) await latest.current.onHistoryChanged();
    return next;
  }

  async function run(work: DraftWorkspace, gen = ++generation.current) {
    lock.current = true;
    setBusy(true); setError(null); setReceived(0); setElapsed(0); setReasoning('');
    progress.current = 0;
    const sessionGen = latest.current.getSessionGeneration();
    try {
      const config = await loadAiConfig();
      if (!current(gen)) return;
      const result = await executeOrganize(work, {
        loadFragments: (ids) => repo.listFragmentsByIds(ids),
        loadTodos,
        extractKnowledge: (request) => extractKnowledge({ ...request, config }),
        readImages: (fragments, limit) => readPendingImages({ fragments, config, limit, shouldContinue: () => current(gen) }),
        persist,
        onChange: (next) => { if (current(gen)) publish(next); },
        onProgress: (patch) => {
          if (!current(gen) || Date.now() - progress.current < 120) return;
          progress.current = Date.now();
          if (patch.content !== undefined) setReceived(patch.content.length);
          if (patch.reasoning !== undefined) setReasoning(patch.reasoning);
        },
        isCurrent: () => current(gen),
      });
      if (!current(gen)) return;
      if (result.draft.docs.length || result.draft.todos.length || result.sessionProcessed) {
        try { await recordHistory(result, gen, sessionGen); }
        catch (e) { if (current(gen)) latest.current.showToast(`草稿已保留，历史摘要未更新：${e instanceof Error ? e.message : '请稍后重试'}`); }
      }
      if (current(gen)) { try { await latest.current.onSaved(); } catch { /* 草稿/图片字已在库里，刷新失败不重发请求。 */ } }
    } catch (e) {
      if (current(gen)) setError(errorDetailOf(e));
    } finally {
      if (current(gen)) { lock.current = false; setBusy(false); }
    }
  }

  async function start(mode: DraftMode, opts: StartDraftOptions = {}) {
    if (lock.current) return;
    if (opts.append && workRef.current) {
      if (workRef.current.pendingRevision) { latest.current.showToast('先重试或手动处理上次改稿，再继续下一批材料'); return; }
      await run(workRef.current); return;
    }
    if (!loaded || storageError && !workRef.current) { latest.current.showToast('先恢复本地草稿存储，再开始整理'); return; }
    if (workRef.current || recoveryRef.current) { latest.current.showToast('还有一份本地草稿，请先恢复、写入或明确放弃'); return; }
    if (!opts.turns && !opts.fragments && latest.current.scope.kind === 'documents') { latest.current.showToast('这场会话只问选中文档，整理碎片请回时间轴新开会话'); return; }
    const gen = ++generation.current;
    lock.current = true; setBusy(true); setError(null); setElapsed(0);
    try {
      const owner = opts.session ? ownerOfSession(opts.session) : latest.current.getOwner();
      if (opts.session) latest.current.onRestoreOwner(owner);
      const all = opts.all ?? (!opts.fragments && wantsAll(opts.instruction));
      let source: SourceSnapshot;
      if (opts.turns !== undefined) {
        source = { kind: 'session', turns: opts.turns, title: opts.session?.title || owner.title || '当前会话' };
      } else {
        const context = latest.current.context;
        const pool = opts.fragments ?? (context ? [context] : await repo.listAllFragments());
        if (!current(gen)) return;
        let selected = pool.filter((f) => (opts.fragments || context || f.mergedInto === null) && (hasReadableText(f) || f.images.length > 0));
        if (!opts.fragments && !context) selected = selected.slice().sort((a, b) => all ? a.createdAt - b.createdAt || a.id - b.id : b.createdAt - a.createdAt || b.id - a.id);
        if (!all && !opts.fragments && !context) selected = selected.slice(0, 40);
        if (!selected.length) { latest.current.showToast('这次没有可整理的材料，未发送请求'); return; }
        source = { kind: 'fragments', ids: selected.map((f) => f.id), all: !!all || !!opts.fragments };
      }
      const work = createWorkspace({ mode, source, instruction: opts.instruction, owner });
      publish(work);
      await persist(work);
      if (current(gen)) await run(work, gen);
    } catch (e) {
      if (current(gen)) setError(errorDetailOf(e));
    } finally {
      if (current(gen)) { lock.current = false; setBusy(false); }
    }
  }

  async function revise(instruction: string, retry = false) {
    let work = workRef.current;
    if (!work || lock.current || !instruction.trim()) return;
    const gen = ++generation.current;
    lock.current = true; setBusy(true); setError(null); setReceived(0); setElapsed(0);
    try {
      const config = await loadAiConfig();
      let request = retry ? work.pendingRevision : null;
      if (!request) {
        let material = '';
        if (work.request.source.kind === 'session') material = trimMaterial(formatTurns(work.request.source.turns)).text;
        else if (work.draft.sourceIds.length) material = trimMaterial(formatFragments(await repo.listFragmentsByIds(work.draft.sourceIds))).text;
        const existingTodos = work.request.owner.scope.kind === 'documents' ? [] : await loadTodos();
        request = { instruction: instruction.trim(), material, history: [...work.history], base: work.draft, existingTodos };
      }
      if (!current(gen)) return;
      work = { ...work, pendingRevision: request, draftAsk: request.instruction, error: null, steps: [...work.steps, { text: `你说：${request.instruction}`, state: 'done' }, { text: '正在按原材料修改；已取消的选择不会恢复', state: 'running' }] };
      publish(work); await persist(work);
      if (!current(gen)) return;
      const revised = await reviseDraft({
        draft: request.base, receipt: work.receipt, instruction: request.instruction,
        material: request.material, history: request.history, existingTodos: request.existingTodos, config,
        onProgress: (patch) => { if (current(gen) && patch.content !== undefined) setReceived(patch.content.length); },
      });
      if (!current(gen)) return;
      work = {
        ...work, draft: ensureDraftIdentity(revised, work.draft.draftId), pendingRevision: null,
        history: [...request.history, request.instruction].slice(-6),
        phase: hasUnfinishedWork(work) ? 'paused' : 'complete',
        note: revised.note || '已按你的要求修改；逐项选择与已写入身份保持不变',
        steps: [...work.steps.slice(0, -1), { text: '已修改，未擅自重新批准任何条目', state: 'done' }],
      };
      publish(work); await persist(work);
    } catch (e) {
      if (current(gen)) {
        setError(errorDetailOf(e));
        const latestWork = workRef.current;
        if (latestWork) {
          const failed: DraftWorkspace = { ...latestWork, phase: 'failed', error: e instanceof Error ? e.message : '改稿失败，原输入已保留', steps: latestWork.steps.map((s) => s.state === 'running' ? { ...s, state: 'fail' } : s) };
          publish(failed); try { await persist(failed); } catch { /* 保持内存草稿及错误提示。 */ }
        }
      }
    } finally { if (current(gen)) { lock.current = false; setBusy(false); } }
  }

  async function retry() {
    const work = workRef.current;
    if (!work || lock.current) return;
    if (work.pendingRevision) await revise(work.pendingRevision.instruction, true);
    else await run(work);
  }

  async function approve(onlyKey: string | null) {
    let work = workRef.current;
    if (!work || lock.current) return;
    const plan = selectDraftTargets(work.draft, work.receipt, work.allowDoc, work.allowTodos, onlyKey);
    if (!plan.documentCount && !plan.todoCount) { setError({ message: '没有已批准且尚未写入的内容；关闭的权限不会被绕过' }); return; }
    const gen = ++generation.current;
    const sessionGen = latest.current.getSessionGeneration();
    lock.current = true; setSaving(true); setError(null);
    let committed = false;
    try {
      await persist(work);
      if (!current(gen)) return;
      // 首批失败后也可能已有可写产出；先给草稿建确定的历史身份，再原子提交关联。
      if (work.request.owner.id === null) work = await recordHistory(work, gen, sessionGen);
      if (!current(gen)) return;
      const now = Date.now();
      const receipt = await repo.commitDraft({
        draftId: work.draft.draftId,
        documents: plan.documents.map((d) => ({ key: d.key, title: docNameOf(d, now, work!.draft.docs.findIndex((x) => x.key === d.key)), excerpt: d.summary || excerptOf(d.bodyMd), content: contentFromText(d.bodyMd.trim(), 'markdown') })),
        todos: plan.todos.map((t) => ({ key: t.key, text: t.text, dueAt: t.due, children: t.children.map((c) => ({ key: c.key, text: c.text, dueAt: c.due })) })),
        sourceIds: work.draft.sourceIds,
        sessionId: work.request.owner.id,
      });
      committed = true;
      if (!current(gen)) return;
      work = { ...work, receipt, steps: [...work.steps, { text: `已写入 ${plan.documentCount} 篇文档、${plan.todoCount} 条待办`, state: 'done' }] };
      publish(work);
      await persist(work);
      try { await latest.current.onSaved(); await latest.current.onHistoryChanged(); }
      catch { latest.current.showToast('内容已写入，列表暂未刷新；不需要重复写入'); return; }
      latest.current.showToast(`已写入 ${plan.documentCount} 篇文档、${plan.todoCount} 条待办`);
    } catch (e) {
      if (current(gen)) setError(committed
        ? { message: '内容已经写入，但草稿状态未保存。请重试保存本地草稿；同一条目不会重复创建。' }
        : errorDetailOf(e));
    } finally { if (current(gen)) { lock.current = false; setSaving(false); } }
  }

  /** 暂停阻止后续批次与迟到写回；已发出的请求不宣称能撤回。 */
  async function pause() {
    if (saving || !busy) return;
    generation.current++;
    const work = workRef.current;
    if (work) {
      const paused: DraftWorkspace = { ...work, phase: 'paused', steps: work.steps.map((s) => s.state === 'running' ? { ...s, text: `${s.text}（已暂停）`, state: 'fail' } : s), note: '已暂停后续处理。已发出的请求不能撤回；恢复后需手动重试，旧结果不会自动写入。' };
      publish(paused); try { await persist(paused); } catch { /* 页面仍保留内存结果，关闭前必须成功保存。 */ }
    }
    lock.current = false; setBusy(false);
  }
  async function suspend(): Promise<boolean> {
    if (lock.current) { latest.current.showToast('先暂停整理，或等待正在写入的内容完成'); return false; }
    const work = workRef.current;
    if (!work) return true;
    lock.current = true; setSaving(true);
    try {
      await persist(work);
      generation.current++;
      rememberRecovery(work); publish(null); setError(null);
      return true;
    } catch { latest.current.showToast('草稿还没保存成功，已保留当前页面，请先重试保存'); return false; }
    finally { lock.current = false; if (alive.current) setSaving(false); }
  }
  function restore() {
    const work = recoveryRef.current;
    if (!work || lock.current) return;
    generation.current++;
    latest.current.onRestoreOwner(work.request.owner);
    publish(work); rememberRecovery(null); setError(work.error ? { message: work.error } : null);
    setReasoning(''); setReceived(0); setElapsed(0);
    latest.current.showToast('已恢复本地草稿；没有自动发送请求');
  }
  async function discard(): Promise<boolean> {
    if (lock.current) return false;
    lock.current = true; setSaving(true);
    try {
      await store.clear(); generation.current++;
      rememberRecovery(null); publish(null); setError(null); setStorageError(null);
      return true;
    } catch (e) { setStorageError(e instanceof Error ? e.message : '未能移除本地草稿'); return false; }
    finally { lock.current = false; if (alive.current) setSaving(false); }
  }
  async function saveLocal() {
    const work = workRef.current;
    if (!work || lock.current) return;
    lock.current = true; setSaving(true);
    try { await persist(work); setError(null); latest.current.showToast('本地草稿已保存；没有发送模型请求'); }
    catch { /* persist 已留下具体错误。 */ }
    finally { lock.current = false; if (alive.current) setSaving(false); }
  }
  return {
    workspace, recovery, loaded, storageError, busy, saving, error, reasoning, received, elapsed,
    start, retry, revise, approve, pause, suspend, restore, discard, saveLocal, reloadRecovery,
    changeDraft,
    setAllowDoc: (value: boolean) => change({ allowDoc: value }),
    setAllowTodos: (value: boolean) => change({ allowTodos: value }),
    isLocked: () => lock.current,
  };
}
