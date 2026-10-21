/**
 * 视觉常量。全部取浅色、无渐变、无阴影，靠留白和细分隔线建立层次。
 */

export const C = {
  page: '#FBFBF9',
  card: '#FFFFFF',
  text: '#1B1B19',
  text2: '#6E6E68',
  text3: '#A6A69F',
  hair: '#ECECE7',
  hairSoft: '#F3F3EF',

  accent: '#185FA5',
  accentBg: '#E6F1FB',
  accentText: '#0C447C',

  purpleBg: '#EEEDFE',
  purpleText: '#3C3489',
  tealBg: '#E1F5EE',
  tealText: '#085041',
  amberBg: '#FAEEDA',
  amberText: '#633806',
  coralBg: '#FAECE7',
  coralText: '#712B13',

  danger: '#A32D2D',
  dangerBg: '#FCEBEB',
} as const;

const TAG_PALETTE = [
  { bg: C.accentBg, fg: C.accentText },
  { bg: C.purpleBg, fg: C.purpleText },
  { bg: C.tealBg, fg: C.tealText },
  { bg: C.amberBg, fg: C.amberText },
  { bg: C.coralBg, fg: C.coralText },
];

/** 同一个标签在全局永远拿到同一个颜色，便于用颜色记忆分类。 */
export function tagColor(label: string) {
  let h = 7;
  for (let i = 0; i < label.length; i++) {
    h = (h * 31 + label.charCodeAt(i)) % 100003;
  }
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

export const R = {
  card: 12,
  btn: 8,
  pill: 999,
} as const;
