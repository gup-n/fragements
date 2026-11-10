/**
 * 两层子待办的纯逻辑。
 *
 * 单独成文件而不是写进 repo，是因为「一条待办被勾掉之后还有谁要跟着变」
 * 必须只有一份实现：两份 repo（SQLite / localStorage）都要执行它，
 * 界面上的即时反馈也要用它。分开写迟早对不上 —— 而这类不一致的表现是
 * 「父项打勾了但子项还有没做的」，用户没有任何办法修回来。
 */
import type { Todo } from '../types';

export interface TodoNode {
  todo: Todo;
  /** 按创建时间升序：拆步骤通常就是按顺序做的 */
  children: Todo[];
}

/** 一次勾选牵动的条目。`done` 是目标状态，不是「切换」 */
export interface ToggleStep {
  id: number;
  done: boolean;
}

/**
 * 顶层待办 + 各自的子项。
 *
 * 只返回 parentId 为 null 的条目：子项不会独立出现在列表里，它只跟着父项。
 * 指向不存在父项的孤儿（父项被物理删掉的历史数据）在这里**不会**被丢出来 ——
 * 见 `orphanTodos`，界面得给它们一个位置，否则就是数据黑洞。
 */
export function buildTodoTree(todos: Todo[]): TodoNode[] {
  const byParent = new Map<number, Todo[]>();
  for (const t of todos) {
    if (t.parentId === null) continue;
    const list = byParent.get(t.parentId);
    if (list) list.push(t);
    else byParent.set(t.parentId, [t]);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }

  return todos
    .filter((t) => t.parentId === null)
    .map((todo) => ({ todo, children: byParent.get(todo.id) ?? [] }));
}

/** 父项已经不在了的子项。界面要把它们当顶层显示，不能藏起来 */
export function orphanTodos(todos: Todo[]): Todo[] {
  const ids = new Set(todos.map((t) => t.id));
  return todos.filter((t) => t.parentId !== null && !ids.has(t.parentId));
}

/**
 * 拍平成「一行一条 + 缩进层级」，给导出和问答用。
 *
 * 为什么不复用 `buildTodoTree` 再自己遍历：那两份输出（Markdown 的嵌套列表、
 * 给模型的待办清单）都要按「父项后面紧跟它的子项」排，各写一遍很容易一边
 * 忘了加缩进、一边把子项漏掉。孤儿追加在末尾，depth 算 0 —— 宁可位置不对，
 * 也不能从导出里消失。
 */
export function flattenTodos(todos: Todo[]): { todo: Todo; depth: number }[] {
  const out: { todo: Todo; depth: number }[] = [];
  for (const node of buildTodoTree(todos)) {
    out.push({ todo: node.todo, depth: 0 });
    for (const child of node.children) out.push({ todo: child, depth: 1 });
  }
  for (const orphan of orphanTodos(todos)) out.push({ todo: orphan, depth: 0 });
  return out;
}

/**
 * 一条待办被勾成 `done` 之后，哪些条目应该跟着变成什么状态（含它自己）。
 *
 * 四条规则，写死在这里，两个 repo 都照着执行：
 *
 * 1. **勾父项 = 父项和全部子项一起完成**。「这件事做完了」不是「这个标题做完了」；
 *    而且父项打了勾、子项还空着，用户在列表里看到的是一个自相矛盾的条目。
 * 2. **取消父项 = 父项和全部子项一起取消**。否则会留下「父项未完成、
 *    子项全完成」的中间态 —— 它只要存在，下一次勾任何子项都会把父项顶成完成，
 *    用户会以为自己点错了。
 * 3. **勾/取消子项 = 父项跟随「是不是所有子项都完成了」**。这是用户要的核心：
 *    子项一个个做完，父项自己变完成。
 * 4. 没有子项、也不是子项：只改自己。
 *
 * 找不到 id 时返回空数组，由调用方当作无操作 —— 不抛错。
 */
export function planToggle(todos: Todo[], id: number, done: boolean): ToggleStep[] {
  const target = todos.find((t) => t.id === id);
  if (!target) return [];

  const next = new Map<number, boolean>();
  next.set(id, done);

  for (const t of todos) {
    if (t.parentId === id) next.set(t.id, done);
  }

  if (target.parentId !== null) {
    /*
     * 父项必须**在这份列表里**才回写。
     *
     * 调用方传进来的是「还在用的待办」（`merged_into IS NULL`），被合并掉的
     * 父项不在其中 —— 但它仍然是库里的一行，照着一个不存在的目标去 UPDATE
     * 会把那条隐藏的父项标成完成。数据上看不出，等哪天撤回合并就露馅了。
     */
    const parent = todos.find((t) => t.id === target.parentId);
    if (parent) {
      const siblings = todos.filter((t) => t.parentId === target.parentId);
      if (siblings.length) {
        const allDone = siblings.every((t) => next.get(t.id) ?? t.done);
        next.set(parent.id, allDone);
      }
    }
  }

  return Array.from(next, ([todoId, value]) => ({ id: todoId, done: value }));
}

/** 一条待办的子项里还有几条没做完。列表上用它显示「2 / 5」 */
export function openChildCount(node: TodoNode): { open: number; total: number } {
  return {
    open: node.children.filter((c) => !c.done).length,
    total: node.children.length,
  };
}
