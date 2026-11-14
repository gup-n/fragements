/** 碎片详情的可见命中：图文字、正文与事项；块定位与NoteBody同口径。 */
import type { Fragment } from '../../types';
import { findHits } from '../../util/highlight';
import { markdownHitBlocks } from './markdownSearch';

export interface FragmentReaderHit {
  section: string;
  blockKey: string;
  localIndex: number;
}

export function fragmentReaderHits(fragment: Pick<Fragment, 'content' | 'images' | 'project'>, query: string, limit = 999): FragmentReaderHit[] {
  if (!query.trim()) return [];
  const out: FragmentReaderHit[] = [];
  const add = (section: string, text: string, literal: boolean) => {
    markdownHitBlocks(text, query, literal, Math.max(0, limit - out.length)).forEach((block, localIndex) => {
      out.push({ section, blockKey: `${section}:${block}`, localIndex });
    });
  };
  // 顺序与详情实际排版一致：图文字在正文前，事项在正文后。
  for (const image of fragment.images ?? []) {
    const text = (image.text ?? '').trim();
    if (text) add(`image:${image.id}`, text, true);
  }
  add('body', fragment.content ?? '', false);
  if (fragment.project) {
    findHits(fragment.project, query, Math.min(99, Math.max(0, limit - out.length))).forEach((_, localIndex) => {
      out.push({ section: 'project', blockKey: 'project:0', localIndex });
    });
  }
  return out;
}
