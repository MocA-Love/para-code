// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { decodeUtf8 } from '@para/protocol';
// index を通さずこの 1 ファイルだけを読む（unzip をリレーなど index を使う側へ持ち込まない）。
import { ZipLimitError, readZipEntries } from '../../../../protocol/src/zipEntries.js';
import type { DiffRow } from '../../components/diffParser.js';

/**
 * 差分の画面の Office の「Raw」（書式を外した中身の比較）。React に依存しない純関数で、`officeRawDiff.test.ts` で固定している。
 *
 * - Excel: シートごとにセルの値を比べ、変わったセルを `-B3: 100` / `+B3: 120` の行にする（式は値の後ろに `(=式)`）
 * - Word: 段落の文字を 1 行ずつにして、行の追加・削除として並べる（前後 3 段落を残す）
 *
 * 中身は PC から受けた変更前・変更後のバイト列（`scm.file-at.v1`）を端末の中で展開して読む。PC は表の値や段落を
 * 組み立てない（PC の表計算・Word の解析はどちらも描画の部品の中にあり、文字の比較を返す口が無いため）。
 */

/** 変更前・変更後。その側にファイルが無い（新規・削除）なら undefined。 */
export interface OfficeRawSides {
	readonly before: Uint8Array | undefined;
	readonly after: Uint8Array | undefined;
}

export type OfficeRawResult =
	/** `capped` は上限（{@link MAX_RAW_LINES}）で読むのを打ち切った（先頭だけを比べた）。 */
	| { readonly kind: 'rows'; readonly rows: readonly DiffRow[]; readonly capped: boolean }
	| { readonly kind: 'unreadable' }
	/** 展開すると上限を超える（zip 爆弾など）。 */
	| { readonly kind: 'tooLarge' };

/** 1 枚の表のセルの数・段落の数の上限（大きい文書で端末を止めない）。 */
export const MAX_RAW_LINES = 50_000;
const MAX_LINES = MAX_RAW_LINES;

/** 読んだ途中で上限に当たったかを記録する（読み取りの関数が書き込む）。 */
interface ReadCap {
	capped: boolean;
}
/** LCS の表の大きさの上限。超えたら、前後の一致を除いた残りをまとめて「削除 → 追加」にする。 */
const MAX_LCS_CELLS = 4_000_000;
/** 変わった段落の前後に残す段落の数。 */
const CONTEXT = 3;

const ENTITY_PATTERN = /&(?:#(?<dec>\d+)|#x(?<hex>[\da-fA-F]+)|(?<name>amp|lt|gt|quot|apos));/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

export function decodeXmlText(text: string): string {
	return text.replace(ENTITY_PATTERN, (match, ...args: unknown[]) => {
		const groups = args[args.length - 1] as { dec?: string; hex?: string; name?: string };
		const code = groups.dec !== undefined ? Number(groups.dec) : groups.hex !== undefined ? parseInt(groups.hex, 16) : undefined;
		if (code !== undefined) {
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return groups.name !== undefined ? NAMED_ENTITIES[groups.name] ?? match : match;
	});
}

function attribute(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\s${name}="(?<value>[^"]*)"`).exec(tag);
	return match?.groups?.value !== undefined ? decodeXmlText(match.groups.value) : undefined;
}

/** `<t>` の中身をつなげる（Excel の共有文字列・インライン文字列。ふりがな `<rPh>` は除く）。 */
function runText(xml: string): string {
	const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
	let text = '';
	for (const match of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>(?<body>[\s\S]*?)<\/t>/g)) {
		text += decodeXmlText(match.groups?.body ?? '');
	}
	return text;
}

// ---- Excel ----

/** シート名 → セルの番地 → 値。シートの並びはブックの順。 */
export type WorkbookValues = ReadonlyMap<string, ReadonlyMap<string, string>>;

function normalizeTarget(target: string): string {
	const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
	const parts: string[] = [];
	for (const segment of path.split('/')) {
		if (segment === '..') {
			parts.pop();
		} else if (segment !== '.' && segment.length > 0) {
			parts.push(segment);
		}
	}
	return parts.join('/');
}

/** xlsx のセルの値を読む。zip・ブックとして読めなければ undefined。 */
export function readWorkbookValues(data: Uint8Array, cap: ReadCap = { capped: false }): WorkbookValues | undefined {
	const entries = readZipEntries(data, name => name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' || name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(name));
	const workbook = entries?.get('xl/workbook.xml');
	if (entries === undefined || workbook === undefined) {
		return undefined;
	}
	const text = (name: string) => {
		const bytes = entries.get(name);
		return bytes !== undefined ? decodeUtf8(bytes) : undefined;
	};
	const relations = new Map<string, string>();
	for (const match of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
		const id = attribute(match[0], 'Id');
		const target = attribute(match[0], 'Target');
		if (id !== undefined && target !== undefined) {
			relations.set(id, normalizeTarget(target));
		}
	}
	const shared: string[] = [];
	for (const match of (text('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>(?<body>[\s\S]*?)<\/si>/g)) {
		shared.push(runText(match.groups?.body ?? ''));
	}
	const sheets = new Map<string, ReadonlyMap<string, string>>();
	for (const match of decodeUtf8(workbook).matchAll(/<sheet\b[^>]*\/?>/g)) {
		const name = attribute(match[0], 'name');
		const relation = attribute(match[0], 'r:id');
		const sheetXml = relation !== undefined ? text(relations.get(relation) ?? '') : undefined;
		if (name === undefined || sheetXml === undefined) {
			continue;
		}
		sheets.set(name, readSheetCells(sheetXml, shared, cap));
	}
	return sheets;
}

function readSheetCells(xml: string, shared: readonly string[], cap: ReadCap): ReadonlyMap<string, string> {
	const cells = new Map<string, string>();
	for (const match of xml.matchAll(/<c\b(?<attrs>[^>]*?)(?:\/>|>(?<body>[\s\S]*?)<\/c>)/g)) {
		if (cells.size >= MAX_LINES) {
			cap.capped = true;
			break;
		}
		const tag = `<c${match.groups?.attrs ?? ''}>`;
		const ref = attribute(tag, 'r');
		const body = match.groups?.body ?? '';
		if (ref === undefined || body.length === 0) {
			continue;
		}
		const type = attribute(tag, 't');
		const raw = /<v>(?<value>[\s\S]*?)<\/v>/.exec(body)?.groups?.value;
		const formula = /<f\b[^>]*>(?<formula>[\s\S]*?)<\/f>/.exec(body)?.groups?.formula;
		let value: string;
		if (type === 's') {
			value = shared[Number(raw)] ?? '';
		} else if (type === 'inlineStr') {
			value = runText(body);
		} else if (type === 'b') {
			value = raw === '1' ? 'TRUE' : 'FALSE';
		} else {
			value = decodeXmlText(raw ?? '');
		}
		const shown = formula !== undefined ? `${value} (=${decodeXmlText(formula)})` : value;
		if (shown.length > 0) {
			cells.set(ref, shown);
		}
	}
	return cells;
}

/** `B3` → [行 3, 列 2]（並べ替え用）。 */
function cellOrder(ref: string): readonly [number, number] {
	const match = /^(?<col>[A-Z]+)(?<row>\d+)$/.exec(ref);
	if (match?.groups === undefined) {
		return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
	}
	let col = 0;
	for (const char of match.groups.col ?? '') {
		col = col * 26 + (char.charCodeAt(0) - 64);
	}
	return [Number(match.groups.row), col];
}

function oneLine(value: string): string {
	return value.replace(/\r?\n/g, ' ⏎ ');
}

/** 2 つのブックのセルの値の違い。シートごとに見出しの行を 1 つ置く（変わったシートだけ）。 */
export function workbookRawRows(before: WorkbookValues | undefined, after: WorkbookValues | undefined): DiffRow[] {
	const rows: DiffRow[] = [];
	const names = [...new Set([...(after?.keys() ?? []), ...(before?.keys() ?? [])])];
	for (const name of names) {
		const oldCells = before?.get(name);
		const newCells = after?.get(name);
		const refs = [...new Set([...(oldCells?.keys() ?? []), ...(newCells?.keys() ?? [])])].sort((a, b) => {
			const [rowA, colA] = cellOrder(a);
			const [rowB, colB] = cellOrder(b);
			return rowA - rowB || colA - colB;
		});
		const sheetRows: DiffRow[] = [];
		for (const ref of refs) {
			const oldValue = oldCells?.get(ref);
			const newValue = newCells?.get(ref);
			if (oldValue === newValue) {
				continue;
			}
			if (oldValue !== undefined) {
				sheetRows.push({ kind: 'del', text: `${ref}: ${oneLine(oldValue)}` });
			}
			if (newValue !== undefined) {
				sheetRows.push({ kind: 'add', text: `${ref}: ${oneLine(newValue)}` });
			}
		}
		if (sheetRows.length > 0 || oldCells === undefined || newCells === undefined) {
			const note = oldCells === undefined ? '（追加したシート）' : newCells === undefined ? '（削除したシート）' : '';
			rows.push({ kind: 'hunk', text: `${name}${note}` }, ...sheetRows);
		}
	}
	return rows;
}

// ---- Word ----

/** docx の段落の文字（空の段落は除く）。zip・文書として読めなければ undefined。 */
export function readDocumentParagraphs(data: Uint8Array, cap: ReadCap = { capped: false }): string[] | undefined {
	const document = readZipEntries(data, name => name === 'word/document.xml')?.get('word/document.xml');
	if (document === undefined) {
		return undefined;
	}
	const paragraphs: string[] = [];
	for (const match of decodeUtf8(document).matchAll(/<w:p\b[^>]*?(?:\/>|>(?<body>[\s\S]*?)<\/w:p>)/g)) {
		if (paragraphs.length >= MAX_LINES) {
			cap.capped = true;
			break;
		}
		const body = (match.groups?.body ?? '')
			.replace(/<w:tab\/>/g, '<w:t>\t</w:t>')
			.replace(/<w:(?:br|cr)\b[^>]*\/>/g, '<w:t> </w:t>');
		let text = '';
		for (const run of body.matchAll(/<w:t(?:\s[^>]*)?>(?<text>[\s\S]*?)<\/w:t>/g)) {
			text += decodeXmlText(run.groups?.text ?? '');
		}
		if (text.trim().length > 0) {
			paragraphs.push(text);
		}
	}
	return paragraphs;
}

type LineOp = { readonly kind: 'ctx'; readonly oldNo: number; readonly newNo: number; readonly text: string }
	| { readonly kind: 'del'; readonly oldNo: number; readonly text: string }
	| { readonly kind: 'add'; readonly newNo: number; readonly text: string };

/** 行の並びの違い（前後の一致を除き、残りは LCS。大きすぎれば残りをまとめて削除 → 追加）。 */
export function diffLines(before: readonly string[], after: readonly string[]): LineOp[] {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) {
		start++;
	}
	let endOld = before.length;
	let endNew = after.length;
	while (endOld > start && endNew > start && before[endOld - 1] === after[endNew - 1]) {
		endOld--;
		endNew--;
	}
	const ops: LineOp[] = [];
	for (let index = 0; index < start; index++) {
		ops.push({ kind: 'ctx', oldNo: index + 1, newNo: index + 1, text: before[index] ?? '' });
	}
	const oldMiddle = before.slice(start, endOld);
	const newMiddle = after.slice(start, endNew);
	const n = oldMiddle.length;
	const m = newMiddle.length;
	if (n * m > MAX_LCS_CELLS) {
		oldMiddle.forEach((text, index) => ops.push({ kind: 'del', oldNo: start + index + 1, text }));
		newMiddle.forEach((text, index) => ops.push({ kind: 'add', newNo: start + index + 1, text }));
	} else {
		// lengths[i][j] = oldMiddle[i..] と newMiddle[j..] の LCS の長さ
		const width = m + 1;
		const lengths = new Uint32Array((n + 1) * width);
		const at = (row: number, col: number) => lengths[row * width + col] ?? 0;
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				lengths[i * width + j] = oldMiddle[i] === newMiddle[j]
					? at(i + 1, j + 1) + 1
					: Math.max(at(i + 1, j), at(i, j + 1));
			}
		}
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && oldMiddle[i] === newMiddle[j]) {
				ops.push({ kind: 'ctx', oldNo: start + i + 1, newNo: start + j + 1, text: oldMiddle[i] ?? '' });
				i++;
				j++;
			} else if (i < n && (j >= m || at(i + 1, j) >= at(i, j + 1))) {
				// 同じ長さなら削除を先に（unified diff と同じ並び）
				ops.push({ kind: 'del', oldNo: start + i + 1, text: oldMiddle[i] ?? '' });
				i++;
			} else {
				ops.push({ kind: 'add', newNo: start + j + 1, text: newMiddle[j] ?? '' });
				j++;
			}
		}
	}
	for (let index = 0; index < before.length - endOld; index++) {
		ops.push({ kind: 'ctx', oldNo: endOld + index + 1, newNo: endNew + index + 1, text: before[endOld + index] ?? '' });
	}
	return ops;
}

/** 段落の違いを、変わった所の前後 {@link CONTEXT} 段落だけ残した行にする（離れた変更の間に見出しの行）。 */
export function paragraphRawRows(before: readonly string[], after: readonly string[]): DiffRow[] {
	const ops = diffLines(before, after);
	const keep = new Array<boolean>(ops.length).fill(false);
	ops.forEach((op, index) => {
		if (op.kind !== 'ctx') {
			for (let near = Math.max(0, index - CONTEXT); near <= Math.min(ops.length - 1, index + CONTEXT); near++) {
				keep[near] = true;
			}
		}
	});
	const rows: DiffRow[] = [];
	let previousKept = false;
	ops.forEach((op, index) => {
		if (!keep[index]) {
			previousKept = false;
			return;
		}
		if (!previousKept) {
			const oldNo = op.kind === 'add' ? undefined : op.oldNo;
			const newNo = op.kind === 'del' ? undefined : op.newNo;
			rows.push({ kind: 'hunk', text: `段落 ${newNo ?? oldNo ?? ''}` });
		}
		previousKept = true;
		rows.push(op.kind === 'ctx' ? { kind: 'ctx', oldNo: op.oldNo, newNo: op.newNo, text: op.text }
			: op.kind === 'del' ? { kind: 'del', oldNo: op.oldNo, text: op.text }
				: { kind: 'add', newNo: op.newNo, text: op.text });
	});
	return rows;
}

/**
 * 種類ごとの Raw。片側が読めない（Office の形でない・壊れている）ときは `unreadable`、展開すると上限を超えるときは
 * `tooLarge`。セル・段落の数が上限に当たったら先頭だけを比べて `capped: true`。
 */
export function officeRawDiff(kind: 'spreadsheet' | 'docx', sides: OfficeRawSides): OfficeRawResult {
	try {
		return officeRawDiffUnchecked(kind, sides);
	} catch (error) {
		if (error instanceof ZipLimitError) {
			return { kind: 'tooLarge' };
		}
		throw error;
	}
}

function officeRawDiffUnchecked(kind: 'spreadsheet' | 'docx', sides: OfficeRawSides): OfficeRawResult {
	const cap: ReadCap = { capped: false };
	if (kind === 'spreadsheet') {
		const before = sides.before !== undefined ? readWorkbookValues(sides.before, cap) : undefined;
		const after = sides.after !== undefined ? readWorkbookValues(sides.after, cap) : undefined;
		if ((sides.before !== undefined && before === undefined) || (sides.after !== undefined && after === undefined)) {
			return { kind: 'unreadable' };
		}
		return { kind: 'rows', rows: workbookRawRows(before, after), capped: cap.capped };
	}
	const before = sides.before !== undefined ? readDocumentParagraphs(sides.before, cap) : [];
	const after = sides.after !== undefined ? readDocumentParagraphs(sides.after, cap) : [];
	if (before === undefined || after === undefined) {
		return { kind: 'unreadable' };
	}
	return { kind: 'rows', rows: paragraphRawRows(before, after), capped: cap.capped };
}
