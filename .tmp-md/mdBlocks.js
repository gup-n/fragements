"use strict";
/**
 * 轻量 Markdown 分块解析。
 *
 * 只服务一件事：把模型吐出来的文字拆成「能画的东西」。不追求 CommonMark 兼容，
 * 覆盖模型实际会用的范围：标题 / 列表 / 段落 / 引用 / 表格 / 代码块 / 分隔线，
 * 行内只认 `**加粗**` 和 `` `代码` ``。
 *
 * **为什么单独一个文件：**解析是纯函数，可以拿 node 跑断言；
 * 渲染在 `components/NoteBody.tsx` 里，本地看不见。把能验的部分圈出来，
 * 是「不靠肉眼」的唯一办法。
 *
 * v0.8.7 加表格只因为一件事：用户问「列个表给我」，模型老老实实输出了 GFM 表格，
 * 而老的 NoteBody 只把 `|` 当普通字符 —— 屏幕上就是一串竖线。**没渲染的表格比不生成还糟**，
 * 它占着空间却读不成表。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseInline = parseInline;
exports.splitRow = splitRow;
exports.isTableStart = isTableStart;
exports.parseBlocks = parseBlocks;
exports.flattenForPreview = flattenForPreview;
/** 列数上限。再多一个手机屏也排不下，宁可让每列多换几行 */
const MAX_COLS = 8;
/* ------------------------------------------------------------------ */
/* 行内                                                                */
/* ------------------------------------------------------------------ */
/** 中日韩与全角标点按两个字符宽算，用于估列宽 */
function visualLen(s) {
    let n = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0) ?? 0;
        const wide = (c >= 0x1100 && c <= 0x115f) ||
            (c >= 0x2e80 && c <= 0x303e) ||
            (c >= 0x3041 && c <= 0x33ff) ||
            (c >= 0x3400 && c <= 0x4dbf) ||
            (c >= 0x4e00 && c <= 0x9fff) ||
            (c >= 0xa000 && c <= 0xa4cf) ||
            (c >= 0xac00 && c <= 0xd7a3) ||
            (c >= 0xf900 && c <= 0xfaff) ||
            (c >= 0xfe30 && c <= 0xfe6f) ||
            (c >= 0xff00 && c <= 0xff60) ||
            (c >= 0xffe0 && c <= 0xffe6) ||
            (c >= 0x1f300 && c <= 0x1faff);
        n += wide ? 2 : 1;
    }
    return n;
}
/**
 * 拆行内片段。
 *
 * 加粗和代码在**同一个正则**里扫，不是先剥代码再找加粗 —— 后者会把
 * `` `**a**` `` 里的星号当成加粗。两者互斥，一次过。
 */
function parseInline(raw) {
    const text = raw.replace(/^>\s?/, '');
    const segs = [];
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
        if (m.index > last)
            segs.push({ text: text.slice(last, m.index), bold: false, code: false });
        if (m[1])
            segs.push({ text: m[1].slice(1, -1), bold: false, code: true });
        else
            segs.push({ text: m[2].slice(2, -2), bold: true, code: false });
        last = m.index + m[0].length;
    }
    if (last < text.length)
        segs.push({ text: text.slice(last), bold: false, code: false });
    return segs.length ? segs : [{ text: '', bold: false, code: false }];
}
/* ------------------------------------------------------------------ */
/* 表格                                                                */
/* ------------------------------------------------------------------ */
/**
 * 按未转义、且不在行内代码里的 `|` 切列。
 *
 * 三种情况都会遇到：`` `a | b` `` 里的竖线、`\|` 转义、行尾多余的 `|`。
 * 直接 split('|') 会在第一、二种上切错。
 */
function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|'))
        s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|'))
        s = s.slice(0, -1);
    const out = [];
    let buf = '';
    let inCode = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\\' && s[i + 1] === '|') {
            buf += '|';
            i++;
            continue;
        }
        if (ch === '`') {
            inCode = !inCode;
            buf += ch;
            continue;
        }
        if (ch === '|' && !inCode) {
            out.push(buf.trim());
            buf = '';
            continue;
        }
        buf += ch;
    }
    out.push(buf.trim());
    return out;
}
const SEP_CELL = /^:?-+:?$/;
/** `|---|:--:|---:|` 这种行。必须全部单元格都是短横线 */
function isSeparator(line) {
    if (!line.includes('-'))
        return false;
    const cells = splitRow(line);
    return cells.length > 0 && cells.every((c) => SEP_CELL.test(c));
}
/**
 * 判断 `lines[i]` 是不是表格的第一行（表头）。
 *
 * 依据是「下一行是分隔行」——单看有没有 `|` 会误判，正文里写
 * 「A | B 两个方案」很常见。
 */
function isTableStart(lines, i) {
    const head = lines[i];
    const sep = lines[i + 1];
    if (head === undefined || sep === undefined)
        return false;
    if (!head.includes('|') || !isSeparator(sep))
        return false;
    // 分隔行至少要有两列，否则更像一条 `---` 分隔线被误读
    return splitRow(sep).length >= 2;
}
function alignOf(cell) {
    const l = cell.startsWith(':');
    const r = cell.endsWith(':');
    if (l && r)
        return 'center';
    if (r)
        return 'right';
    return 'left';
}
function buildTable(lines, start) {
    const headRaw = splitRow(lines[start]);
    const sepRaw = splitRow(lines[start + 1]);
    const cols = Math.min(Math.max(headRaw.length, sepRaw.length), MAX_COLS);
    const pad = (cells) => {
        const out = cells.slice(0, cols);
        while (out.length < cols)
            out.push('');
        return out;
    };
    const head = pad(headRaw).map(parseInline);
    const align = pad(sepRaw).map(alignOf);
    const rows = [];
    let i = start + 2;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim() || !line.includes('|'))
            break;
        // 表格后面紧跟一个代码块/标题时，别把它当行
        if (/^```/.test(line.trim()) || /^#{1,4}\s/.test(line.trim()))
            break;
        if (isSeparator(line))
            break;
        rows.push(pad(splitRow(line)).map(parseInline));
        i++;
    }
    // 列宽：取每列最长的那一段。夹在 3~18 之间，避免一列吃掉大半屏
    const weights = Array.from({ length: cols }, (_, c) => {
        let w = 0;
        for (const row of [head, ...rows]) {
            const cell = row[c] ?? [];
            w = Math.max(w, visualLen(cell.map((s) => s.text).join('')));
        }
        return Math.max(3, Math.min(18, Math.ceil(w)));
    });
    return { block: { kind: 'table', head, rows, align, weights }, next: i };
}
/* ------------------------------------------------------------------ */
/* 分块                                                                */
/* ------------------------------------------------------------------ */
/**
 * 切成块。
 *
 * 顺序很重要：先认代码围栏 —— 围栏里的 `|` 和 `#` 都只是字符，
 * 不能被后面的规则抢走。
 */
function parseBlocks(text) {
    const lines = text.split('\n');
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line)
            continue;
        const fence = line.match(/^```(\w*)/);
        if (fence) {
            const body = [];
            let j = i + 1;
            while (j < lines.length && !/^```/.test(lines[j].trim())) {
                body.push(lines[j]);
                j++;
            }
            blocks.push({ kind: 'code', text: body.join('\n'), lang: fence[1] ?? '' });
            i = j;
            continue;
        }
        if (isTableStart(lines, i)) {
            const { block, next } = buildTable(lines, i);
            blocks.push(block);
            i = next - 1;
            continue;
        }
        if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
            blocks.push({ kind: 'hr' });
            continue;
        }
        const heading = line.match(/^#{1,4}\s+(.*)$/);
        if (heading) {
            blocks.push({ kind: 'h', segs: parseInline(heading[1]) });
            continue;
        }
        const bullet = line.match(/^[-*+]\s+(.*)$/);
        if (bullet) {
            blocks.push({ kind: 'b', segs: [{ text: '· ', bold: false, code: false }, ...parseInline(bullet[1])] });
            continue;
        }
        const num = line.match(/^(\d+)[.)]\s+(.*)$/);
        if (num) {
            blocks.push({
                kind: 'b',
                segs: [{ text: `${num[1]}. `, bold: false, code: false }, ...parseInline(num[2])],
            });
            continue;
        }
        blocks.push({ kind: 'p', segs: parseInline(line) });
    }
    return blocks;
}
/**
 * 把块压回纯文字行，给「卡片预览」那种只能显示 N 行的场景用。
 *
 * 表格在这里降级成「华为 · F2 · F12」这样的一行 —— 预览本来就只有 4~5 行，
 * 摆一张表反而什么都看不清。真正读表去详情页。
 */
function flattenForPreview(blocks) {
    const out = [];
    let prevWasHeading = false;
    for (const b of blocks) {
        if (b.kind === 'table') {
            const toLine = (cells) => cells.reduce((acc, cell, i) => {
                if (i > 0)
                    acc.push({ text: ' · ', bold: false, code: false });
                acc.push(...cell);
                return acc;
            }, []);
            out.push({ segs: toLine(b.head), newlineBefore: prevWasHeading });
            for (const row of b.rows)
                out.push({ segs: toLine(row), newlineBefore: false });
            prevWasHeading = false;
            continue;
        }
        if (b.kind === 'code') {
            for (const line of b.text.split('\n')) {
                out.push({ segs: [{ text: line || ' ', bold: false, code: true }], newlineBefore: false });
            }
            prevWasHeading = false;
            continue;
        }
        if (b.kind === 'hr') {
            out.push({ segs: [{ text: '———', bold: false, code: false }], newlineBefore: false });
            prevWasHeading = false;
            continue;
        }
        out.push({ segs: b.segs, newlineBefore: b.kind === 'h' && out.length > 0 });
        prevWasHeading = b.kind === 'h';
    }
    return out;
}
