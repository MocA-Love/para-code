// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 会話の Markdown（`markdownText.tsx`）の読み取り。描画から切り離した純関数なので、RN を持たずにテストできる。
 *
 * 読む記法:
 *  - コードブロック（```）/ インラインコード（`）
 *  - 太字（**）
 *  - 見出し（# 〜 ###、本文の下の `---` / `===`）
 *  - 箇条書き（- / * / + / 1.）。頭の空白の深さで入れ子にする
 *  - 引用（>）。中身は同じ規則で読み直す（入れ子の引用も）
 *  - 区切り線（---・***・___、間に空白があってもよい）
 *  - 表（GFMテーブル: ヘッダー行＋区切り行＋本体行、列アライメント対応）
 *  - http(s)リンク / ワークスペース内ファイルリンク
 * それ以外はプレーンテキストとして扱う（未対応記法で壊れない）。
 */

import { parseLocalFileTarget, type LocalFileTarget } from '../localFileTarget.js';

export type CellAlign = 'left' | 'center' | 'right';

export type Block =
	| { kind: 'code'; text: string; lang?: string }
	| { kind: 'heading'; level: number; text: string }
	/** `depth` は入れ子の深さ（0 が一番外）。 */
	| { kind: 'bullet'; marker: string; text: string; depth: number }
	| { kind: 'table'; header: string[]; aligns: CellAlign[]; rows: string[][] }
	| { kind: 'quote'; blocks: Block[] }
	| { kind: 'rule' }
	| { kind: 'para'; text: string };

/** 箇条書きの入れ子の上限（これより深い項目はこの深さで並べる。狭い画面で字下げだけで本文が消えないように）。 */
export const MAX_BULLET_DEPTH = 5;
/** 引用の入れ子の上限（これより深い `>` は中身の文字として出す。悪意のある入力で再帰を深くさせない）。 */
const MAX_QUOTE_DEPTH = 4;
/** 入れ子でない箇条書きの印。深さごとに変える（PC のプレビューと同じ見分け方）。 */
const BULLET_MARKERS = ['•', '◦', '▪'] as const;

/** `| a | b |` 形式の行をセル配列へ分解する（前後のパイプは落とす）。 */
function splitTableRow(line: string): string[] {
	let trimmed = line.trim();
	if (trimmed.startsWith('|')) {
		trimmed = trimmed.slice(1);
	}
	if (trimmed.endsWith('|')) {
		trimmed = trimmed.slice(0, -1);
	}
	return trimmed.split('|').map(cell => cell.trim());
}

/** GFMテーブルの区切り行（`| --- | :---: |` 等）かどうか。 */
function isTableSeparator(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.includes('-') || !trimmed.includes('|')) {
		return false;
	}
	return splitTableRow(trimmed).every(cell => /^:?-+:?$/.test(cell));
}

/** 区切り線（`---`・`***`・`___`。同じ記号が 3 つ以上、間の空白は可、字下げは 3 まで）。 */
function isRule(line: string): boolean {
	return /^ {0,3}(?<mark>[-*_])(?:[ \t]*\k<mark>){2,}[ \t]*$/.test(line);
}

/** 頭の空白の幅（タブは 4 として数える）。 */
function indentWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		width += char === '\t' ? 4 : 1;
	}
	return width;
}

export function parseBlocks(source: string): Block[] {
	return parseBlocksAt(source, 0);
}

function parseBlocksAt(source: string, quoteDepth: number): Block[] {
	const blocks: Block[] = [];
	const lines = source.split('\n');
	let codeLines: string[] | undefined;
	let codeLang: string | undefined;
	let paraLines: string[] = [];
	/** いま続いている箇条書きの、深さごとの字下げの幅。箇条書き以外が来たら空にする。 */
	let bulletIndents: number[] = [];

	const flushPara = () => {
		if (paraLines.length > 0) {
			blocks.push({ kind: 'para', text: paraLines.join('\n') });
			paraLines = [];
		}
	};
	const pushBlock = (block: Block) => {
		flushPara();
		bulletIndents = [];
		blocks.push(block);
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (codeLines !== undefined) {
			if (line.trimEnd().startsWith('```')) {
				blocks.push({ kind: 'code', text: codeLines.join('\n'), ...(codeLang !== undefined ? { lang: codeLang } : {}) });
				codeLines = undefined;
			} else {
				codeLines.push(line);
			}
			continue;
		}
		if (line.trimStart().startsWith('```')) {
			flushPara();
			bulletIndents = [];
			codeLines = [];
			// フェンスの言語名（```ts 等）。PCテーマハイライトの言語解決に使う。
			const info = line.trimStart().slice(3).trim().split(/\s+/)[0] ?? '';
			codeLang = info.length > 0 ? info : undefined;
			continue;
		}
		// 表: 「|で始まるヘッダー行」＋「区切り行」の並びで開始し、|で始まる行が続く限り本体行
		if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? '')) {
			const header = splitTableRow(line);
			const aligns = splitTableRow(lines[i + 1] ?? '').map<CellAlign>(cell =>
				cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
			const rows: string[][] = [];
			let next = i + 2;
			while (next < lines.length && (lines[next] ?? '').trim().startsWith('|')) {
				rows.push(splitTableRow(lines[next] ?? ''));
				next++;
			}
			pushBlock({ kind: 'table', header, aligns, rows });
			i = next - 1;
			continue;
		}
		// 本文のすぐ下の `---` / `===` は、CommonMark と同じく見出し（setext）にする（PC のプレビューと揃える）。
		// 本文が無いところの `---` は区切り線。
		if (paraLines.length > 0 && /^ {0,3}(?:-+|=+)[ \t]*$/.test(line)) {
			const text = paraLines.join(' ').trim();
			paraLines = [];
			pushBlock({ kind: 'heading', level: line.trim().startsWith('=') ? 1 : 2, text });
			continue;
		}
		// 区切り線は箇条書きより先に見る（`* * *` を箇条書きと読まない）
		if (isRule(line)) {
			pushBlock({ kind: 'rule' });
			continue;
		}
		if (quoteDepth < MAX_QUOTE_DEPTH && /^ {0,3}>/.test(line)) {
			const quoted: string[] = [];
			let next = i;
			while (next < lines.length && /^ {0,3}>/.test(lines[next] ?? '')) {
				quoted.push((lines[next] ?? '').replace(/^ {0,3}> ?/, ''));
				next++;
			}
			pushBlock({ kind: 'quote', blocks: parseBlocksAt(quoted.join('\n'), quoteDepth + 1) });
			i = next - 1;
			continue;
		}
		const heading = line.match(/^(?<hashes>#{1,3})\s+(?<body>.+)$/);
		if (heading?.groups?.hashes !== undefined && heading.groups.body !== undefined) {
			pushBlock({ kind: 'heading', level: heading.groups.hashes.length, text: heading.groups.body });
			continue;
		}
		const bullet = line.match(/^(?<indent>[ \t]*)(?<marker>[-*+]|\d+[.)])\s+(?<body>.+)$/);
		if (bullet?.groups?.marker !== undefined && bullet.groups.body !== undefined) {
			flushPara();
			const width = indentWidth(bullet.groups.indent ?? '');
			// 自分より深い字下げの段を閉じ、同じ幅の段があればそこ、無ければ 1 段深くする
			while (bulletIndents.length > 0 && (bulletIndents[bulletIndents.length - 1] ?? 0) > width) {
				bulletIndents.pop();
			}
			if (bulletIndents.length === 0 || (bulletIndents[bulletIndents.length - 1] ?? 0) < width) {
				bulletIndents.push(width);
			}
			const depth = Math.min(MAX_BULLET_DEPTH, bulletIndents.length - 1);
			const ordered = /^\d/.test(bullet.groups.marker);
			blocks.push({
				kind: 'bullet',
				marker: ordered ? bullet.groups.marker.replace(')', '.') : BULLET_MARKERS[Math.min(depth, BULLET_MARKERS.length - 1)] ?? '•',
				text: bullet.groups.body,
				depth,
			});
			continue;
		}
		if (line.trim().length === 0) {
			// 空行を挟んだ箇条書きも同じ並びとして続ける（項目の間を空けて書くエージェントが多い）
			flushPara();
			continue;
		}
		bulletIndents = [];
		paraLines.push(line);
	}
	if (codeLines !== undefined) {
		blocks.push({ kind: 'code', text: codeLines.join('\n'), ...(codeLang !== undefined ? { lang: codeLang } : {}) }); // 閉じ忘れフェンスも表示する
	}
	flushPara();
	return blocks;
}

export type InlineToken =
	| { kind: 'text'; text: string }
	| { kind: 'code'; text: string }
	| { kind: 'bold'; text: string }
	| { kind: 'external'; label: string; url: string }
	| { kind: 'local'; label: string; target: LocalFileTarget };

/** `[` 位置からMarkdownリンク1個を読み取る。山括弧内では空白・括弧を許可する。 */
function markdownLinkAt(text: string, start: number): { end: number; label: string; destination: string } | undefined {
	if (start > 0 && text[start - 1] === '!') {
		return undefined; // 画像記法はファイルを開くカードへ変換しない
	}
	const labelEnd = text.indexOf('](', start + 1);
	if (labelEnd < 0 || text.slice(start + 1, labelEnd).includes('\n')) {
		return undefined;
	}
	const label = text.slice(start + 1, labelEnd);
	if (label.length === 0) {
		return undefined;
	}
	const destinationStart = labelEnd + 2;
	if (text[destinationStart] === '<') {
		const angleEnd = text.indexOf('>', destinationStart + 1);
		if (angleEnd < 0) {
			return undefined;
		}
		let cursor = angleEnd + 1;
		while (text[cursor] === ' ' || text[cursor] === '\t') { cursor++; }
		if (text[cursor] === '"' || text[cursor] === "'") {
			const quote = text.charAt(cursor);
			const titleEnd = text.indexOf(quote, cursor + 1);
			if (titleEnd < 0) { return undefined; }
			cursor = titleEnd + 1;
			while (text[cursor] === ' ' || text[cursor] === '\t') { cursor++; }
		}
		if (text[cursor] !== ')') {
			return undefined;
		}
		return { end: cursor + 1, label, destination: text.slice(destinationStart + 1, angleEnd) };
	}

	let depth = 0;
	for (let cursor = destinationStart; cursor < text.length && text[cursor] !== '\n'; cursor++) {
		const char = text[cursor];
		if (char === '(') {
			depth++;
		} else if (char === ')') {
			if (depth > 0) {
				depth--;
				continue;
			}
			const body = text.slice(destinationStart, cursor).trim();
			const match = /^(?<destination>\S+?)(?:\s+(?:"[^"]*"|'[^']*'))?$/.exec(body);
			if (match?.groups?.destination === undefined) {
				return undefined;
			}
			return { end: cursor + 1, label, destination: match.groups.destination };
		}
	}
	return undefined;
}

/** インライン記法を安全な描画トークンへ分解する。 */
/** 素の URL に使える字（ASCII だけ。`https://example.com/docsを見て` は日本語の手前で切る）。 */
const BARE_URL = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/iy;
/** 素の URL の末尾から外す記号（文の区切り・閉じ引用符・強調の記号）。 */
const BARE_URL_TRAILING = /[.,;:!?'"*_]$/;

/**
 * `start` から始まる素の URL（http・https）を読む。前の字が英数字のとき（`xhttps://` など）は URL にしない。
 * 末尾の句読点と、対になっていない `)` `]` は URL に含めない（`（https://a.example/x）` の閉じ括弧など）。
 */
function bareUrlAt(text: string, start: number): { end: number; url: string } | undefined {
	if (start > 0 && /[A-Za-z0-9]/.test(text.charAt(start - 1))) {
		return undefined;
	}
	BARE_URL.lastIndex = start;
	const match = BARE_URL.exec(text);
	if (match === null) {
		return undefined;
	}
	let url = match[0];
	for (;;) {
		if (BARE_URL_TRAILING.test(url)) {
			url = url.slice(0, -1);
			continue;
		}
		const last = url.charAt(url.length - 1);
		const open = last === ')' ? '(' : last === ']' ? '[' : undefined;
		if (open !== undefined && url.split(open).length <= url.split(last).length - 1) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}
	// 「https://」の後に行き先が無いものは URL にしない
	if (!/^https?:\/\/[A-Za-z0-9]/i.test(url)) {
		return undefined;
	}
	return { end: start + url.length, url };
}

export function parseInline(text: string): InlineToken[] {
	const tokens: InlineToken[] = [];
	let plain = '';
	const flush = () => {
		if (plain.length > 0) { tokens.push({ kind: 'text', text: plain }); plain = ''; }
	};
	for (let i = 0; i < text.length;) {
		if (text[i] === '`') {
			const end = text.indexOf('`', i + 1);
			if (end > i + 1 && !text.slice(i + 1, end).includes('\n')) {
				flush(); tokens.push({ kind: 'code', text: text.slice(i + 1, end) }); i = end + 1; continue;
			}
		}
		if (text.startsWith('**', i)) {
			const end = text.indexOf('**', i + 2);
			if (end > i + 2 && !text.slice(i + 2, end).includes('\n')) {
				flush(); tokens.push({ kind: 'bold', text: text.slice(i + 2, end) }); i = end + 2; continue;
			}
		}
		if (text[i] === '[') {
			const link = markdownLinkAt(text, i);
			if (link !== undefined) {
				if (/^https?:\/\//i.test(link.destination)) {
					flush(); tokens.push({ kind: 'external', label: link.label, url: link.destination }); i = link.end; continue;
				}
				const target = parseLocalFileTarget(link.destination);
				if (target !== undefined) {
					flush(); tokens.push({ kind: 'local', label: link.label, target }); i = link.end; continue;
				}
			}
		}
		// 素の URL も `[文字](URL)` と同じ外のリンクにする（押すと開く・長押しでコピー・メニューの「URL をコピー」）。
		// コードの中（`…` とコードの塊）はここに来ないのでリンクにならない
		if (text[i] === 'h' || text[i] === 'H') {
			const bare = bareUrlAt(text, i);
			if (bare !== undefined) {
				// `<https://…>` の山括弧は外す
				const angled = plain.endsWith('<') && text[bare.end] === '>';
				if (angled) {
					plain = plain.slice(0, -1);
				}
				flush(); tokens.push({ kind: 'external', label: bare.url, url: bare.url }); i = bare.end + (angled ? 1 : 0); continue;
			}
		}
		plain += text.charAt(i);
		i++;
	}
	flush();
	return tokens;
}

// ---- 写すための文字（メニューの「テキストをコピー」「段落を選んでコピー」「コードを選んでコピー」） ----------------

/** インラインの記号を外した文字。外のリンクは名前と行き先を両方残す（行き先が消えると写した意味が無い）。 */
function inlinePlainText(text: string): string {
	return parseInline(text).map(token => {
		switch (token.kind) {
			case 'external':
				return token.label === token.url ? token.url : `${token.label} (${token.url})`;
			case 'local':
				return token.label;
			default:
				return token.text;
		}
	}).join('');
}

/** ブロック 1 つを書式なしの文字にする。箇条書きは字下げと印を残す（並びが読めるように）。 */
export function blockPlainText(block: Block): string {
	switch (block.kind) {
		case 'code':
			return block.text;
		case 'heading':
		case 'para':
			return inlinePlainText(block.text);
		case 'bullet':
			return `${'  '.repeat(block.depth)}${block.marker} ${inlinePlainText(block.text)}`;
		case 'table':
			return [block.header, ...block.rows].map(row => row.map(inlinePlainText).join('\t')).join('\n');
		case 'quote':
			return joinPlainBlocks(block.blocks);
		case 'rule':
			return '';
	}
}

function joinPlainBlocks(blocks: readonly Block[]): string {
	let out = '';
	let previous: Block | undefined;
	for (const block of blocks) {
		const text = blockPlainText(block);
		if (text.length === 0) {
			continue;
		}
		// 続いた箇条書きは 1 行ずつ、ほかは空行で区切る
		out += previous === undefined ? '' : previous.kind === 'bullet' && block.kind === 'bullet' ? '\n' : '\n\n';
		out += text;
		previous = block;
	}
	return out;
}

/** Markdown の記号（`**`、`` ` ``、`#`、`>`、`|` など）を外した文字。 */
export function markdownPlainText(source: string): string {
	return joinPlainBlocks(parseBlocks(source));
}

/** 本文の外のリンク（http・https）の行き先。同じものは 1 回だけ、{@link MAX_COPY_PARTS} まで。 */
export function markdownExternalLinks(source: string): readonly { readonly label: string; readonly url: string }[] {
	const links: { label: string; url: string }[] = [];
	const visit = (blocks: readonly Block[]) => {
		for (const block of blocks) {
			const texts = block.kind === 'para' || block.kind === 'heading' || block.kind === 'bullet' ? [block.text]
				: block.kind === 'table' ? [...block.header, ...block.rows.flat()] : [];
			if (block.kind === 'quote') {
				visit(block.blocks);
			}
			for (const text of texts) {
				for (const token of parseInline(text)) {
					if (token.kind === 'external' && links.length < MAX_COPY_PARTS && !links.some(link => link.url === token.url)) {
						links.push({ label: token.label, url: token.url });
					}
				}
			}
		}
	};
	visit(parseBlocks(source));
	return links;
}

/** メニューに並べる 1 つ（見出しは本文の頭の 1 行）。 */
export interface MarkdownCopyPart {
	readonly label: string;
	readonly text: string;
}

/** 入れ子のメニューに並べる上限（長い返事でメニューが画面を埋めないように）。 */
export const MAX_COPY_PARTS = 30;
const PART_LABEL_LENGTH = 40;

function partLabel(text: string): string {
	const line = text.split('\n').find(candidate => candidate.trim().length > 0)?.trim() ?? '';
	return line.length > PART_LABEL_LENGTH ? `${line.slice(0, PART_LABEL_LENGTH)}…` : line;
}

/** 段落（コード以外の上の段のブロック）とコードブロックを、メニューで 1 つずつ選べる形にする。 */
export function markdownCopyParts(source: string): { readonly paragraphs: readonly MarkdownCopyPart[]; readonly codes: readonly MarkdownCopyPart[] } {
	const paragraphs: MarkdownCopyPart[] = [];
	const codes: MarkdownCopyPart[] = [];
	for (const block of parseBlocks(source)) {
		if (block.kind === 'code') {
			if (codes.length < MAX_COPY_PARTS && block.text.trim().length > 0) {
				const head = partLabel(block.text);
				codes.push({ label: block.lang !== undefined ? `${block.lang} · ${head}` : head, text: block.text });
			}
			continue;
		}
		const text = blockPlainText(block).trim();
		if (paragraphs.length < MAX_COPY_PARTS && text.length > 0) {
			paragraphs.push({ label: partLabel(text), text });
		}
	}
	return { paragraphs, codes };
}
