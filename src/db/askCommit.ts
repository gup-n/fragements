/**
 * 执行问答里的操作提案。
 *
 * 每一条都是**独立事务**：用户勾了三条，第一条成功、第二条失败，
 * 不应该把第一条回滚 —— 那样用户勾了半天的东西一条也没生效，还看不出是哪条坏了。
 * 失败的那条把原因带回给界面，成功的照常报成功。
 */
import type { AskAction } from '../types';
import { repo } from './repo';

type CardPatch = Parameters<typeof repo.updateKnowledgeCard>[1];

export async function applyAskAction(
  a: AskAction,
  /** 卡片标题。只用于回执文案 —— 「卡片 #12 已更新」对用户没有意义 */
  cardTitle?: (id: number) => string | null,
): Promise<string> {
  switch (a.kind) {
    case 'merge_topics': {
      const { moved } = await repo.retopicCards(a.from, a.to);
      if (!moved) return `「${a.from.join('、')}」没有可合并的卡片（可能刚被别处改过）`;
      return `${a.from.length} 个主题已并入「${a.to}」，共 ${moved} 张卡`;
    }

    case 'rename_topic': {
      const { moved } = await repo.retopicCards([a.from], a.to);
      if (!moved) return `「${a.from}」下没有卡片，改名没有生效`;
      return `「${a.from}」已改名为「${a.to}」，共 ${moved} 张卡`;
    }

    case 'archive_cards': {
      // 逐张改而不是拼一条 SQL：归档可恢复，中途失败也只会停在某人身上，好排查
      let n = 0;
      for (const id of a.ids) {
        await repo.updateKnowledgeCard(id, { archived: true });
        n++;
      }
      return `已归档 ${n} 张卡（在知识库的「已归档」里可以恢复）`;
    }

    case 'update_card': {
      const patch: CardPatch = {};
      if (a.topic !== undefined) patch.topic = a.topic;
      if (a.subtopic !== undefined) patch.subtopic = a.subtopic;
      if (a.title !== undefined) patch.title = a.title;
      if (a.gist !== undefined) patch.gist = a.gist;
      if (a.body !== undefined) patch.body = a.body;
      if (!Object.keys(patch).length) return '这条提案没有要改的字段';
      await repo.updateKnowledgeCard(a.id, patch);
      const title = cardTitle?.(a.id);
      return title ? `「${title}」已更新` : `卡片 #${a.id} 已更新`;
    }
  }
}
