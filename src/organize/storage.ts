/** 整理草稿只存现有 settings 单键。队列串行写快照，旧回调不能覆盖后来的选择。 */
import { decodeWorkspace, encodeWorkspace, type DraftWorkspace } from './workspace';
import { draftCommitKey, readDraftReceipt } from '../db/draftCommit';

export const WORKSPACE_KEY = 'organize.workspace.v1';
export interface WorkspaceSettings {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}
export async function readCommittedWorkspace(
  work: DraftWorkspace,
  settings: Pick<WorkspaceSettings, 'getSetting'>,
): Promise<DraftWorkspace> {
  const receipt = readDraftReceipt(await settings.getSetting(draftCommitKey(work.draft.draftId)));
  const documents = new Map(receipt.documents.map((entry) => [entry.key, entry.id]));
  const todos = new Map(receipt.todos.map((entry) => [entry.key, entry.id]));
  if (work.receipt.documents.some((entry) => documents.get(entry.key) !== entry.id) ||
      work.receipt.todos.some((entry) => todos.get(entry.key) !== entry.id)) {
    throw new Error('本地草稿与已写入凭据不一致，已停止恢复以避免重复写入；原记录未被修改。');
  }
  const next = { ...work, receipt };
  // 事务里有、页面快照没有的条目可以补回；不属于本草稿的 key/种类一律报错。
  encodeWorkspace(next);
  return next;
}

export function createWorkspaceStore(settings: WorkspaceSettings) {
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (value: string) => {
    const write = tail.catch(() => undefined).then(() => settings.setSetting(WORKSPACE_KEY, value));
    // 保留调用者可观察的失败，但失败不能把之后的补救写永久堵住。
    tail = write;
    return write;
  };
  return {
    async load(): Promise<DraftWorkspace | null> {
      await tail.catch(() => undefined);
      return decodeWorkspace(await settings.getSetting(WORKSPACE_KEY));
    },
    save(work: DraftWorkspace): Promise<void> {
      // 调用瞬间冻结，排队期间表单又改了一次也不会写错哪一版。
      return enqueue(encodeWorkspace(work));
    },
    clear(): Promise<void> { return enqueue(''); },
    flush(): Promise<void> { return tail; },
  };
}
