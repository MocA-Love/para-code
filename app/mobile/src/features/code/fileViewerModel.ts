// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { marked } from 'marked';
import { classifyMobileFileKind } from '../../components/officeCapability.js';
import { breadcrumbItems, type BreadcrumbItem } from '../../filesBreadcrumb.js';
import type { FsReadResult } from '../../store.js';
import { colors, radius, type } from '../../theme.js';
import type { ThemeColors } from '../../ui/themeColors.js';
import { viewerScriptCspMeta } from './fileFind.js';
import { parentPath } from './fileTree.js';

/**
 * ファイルビューア（Orca の MobileFilePreviewScreen）の判定と、WebView に流す HTML の組み立て。
 * React に依存しない純関数で、`fileViewerModel.test.ts` で固定している。
 * 表示の種類と取得の仕方は旧ビューア（`src/components/fileViewer.tsx`）と同じ。
 */

/** 画像として表示する拡張子（PC 版の media-preview 拡張と同じ範囲）。 */
export const IMAGE_FILE_PATTERN = /\.(?:jpe?g|jpe|png|bmp|gif|ico|webp|avif|svg)$/i;
/** 動画・音声として表示する拡張子。 */
export const AV_FILE_PATTERN = /\.(?:mp4|m4v|mov|webm|mp3|wav|m4a|aac|ogg|oga)$/i;
const MARKDOWN_PATTERN = /\.(?:md|markdown)$/i;
const HTML_PATTERN = /\.(?:html?|xhtml)$/i;
/**
 * まだ開けない形式（表示の分岐が無く、テキストとして読むと文字化けする）。PC へ読みに行かず「まだ開けません」を出す
 * （設計書 3b.5。Quick Look で開くのは後の段階）。HEIC・TIFF は WebView で描けるか確かめるまでここに置く。
 */
const UNSUPPORTED_FILE_PATTERN = /\.(?:pptx?|pptm|ppsx?|potx|key|numbers|pages|xlsb|xls|docm?|dot|rtf|odt|ods|odp|heic|heif|tiff?|psd|ai|sketch|zip|tar|gz|tgz|bz2|xz|7z|rar|dmg|iso|pkg|exe|dll|so|dylib|o|a|class|jar|wasm|ttf|otf|woff2?|eot|sqlite3?|mkv|avi|wmv|flac|wma)$/i;

export type ViewerKind = 'spreadsheet' | 'docx' | 'pdf' | 'image' | 'av' | 'markdown' | 'html' | 'unsupported' | 'other';

export function viewerKindOf(path: string): ViewerKind {
	const name = path.split('/').pop() ?? path;
	const office = classifyMobileFileKind(name);
	if (office !== undefined) {
		return office;
	}
	if (/\.pdf$/i.test(name)) {
		return 'pdf';
	}
	if (IMAGE_FILE_PATTERN.test(name)) {
		return 'image';
	}
	if (AV_FILE_PATTERN.test(name)) {
		return 'av';
	}
	if (MARKDOWN_PATTERN.test(name)) {
		return 'markdown';
	}
	if (HTML_PATTERN.test(name)) {
		return 'html';
	}
	return UNSUPPORTED_FILE_PATTERN.test(name) ? 'unsupported' : 'other';
}

/** PC からどの形で受け取るか（`fsXlsx` / `fsPdf` / `fsDocx` / `fsMedia` / `fsRead`）。`none` は読みに行かない。 */
export type ViewerFetch = 'xlsx' | 'pdf' | 'docx' | 'media' | 'text' | 'none';

export function viewerFetchOf(kind: ViewerKind): ViewerFetch {
	switch (kind) {
		case 'spreadsheet': return 'xlsx';
		case 'pdf': return 'pdf';
		case 'docx': return 'docx';
		case 'image':
		case 'av': return 'media';
		case 'unsupported': return 'none';
		default: return 'text';
	}
}

/**
 * PC にハイライトを頼むか（設計書 4 章の着手順 9）。ハイライトはコードの表示でだけ使う。Markdown・HTML の
 * プレビューは本文だけで描くので、頼むと PC が使わない HTML を作って送るだけになる。
 */
export function wantsHighlight(kind: ViewerKind, mode: ViewerMode): boolean {
	return viewerFetchOf(kind) === 'text' && (mode === 'code' || !canToggleSource(kind));
}

/** プレビューとソースを切り替えられる種類。 */
export function canToggleSource(kind: ViewerKind): boolean {
	return kind === 'markdown' || kind === 'html';
}

export type ViewerMode = 'render' | 'code';

/** 開いたときの表示。文書は読める形、検索の一致行から開いたときは行が分かるソース。 */
export function defaultViewerMode(kind: ViewerKind, focusLine: number | undefined): ViewerMode {
	return kind === 'other' || focusLine !== undefined ? 'code' : 'render';
}

/**
 * ファイルの画面（`/pc/[pcId]/files/[spaceId]?path=…`）が何を出すか。
 * `view` はツリーや差分から開くときに付ける印（ファイルだと分かっている）。印が無い `path` は、
 * 親のフォルダを読むまでフォルダかファイルか分からない（`unknown`）。
 */
export type FilesTarget =
	| { readonly kind: 'tree'; readonly reveal: string | undefined }
	| { readonly kind: 'file'; readonly path: string }
	| { readonly kind: 'unknown'; readonly path: string };

/** ファイルとして開くときにクエリへ足す値（`view=file`）。 */
export const FILE_VIEW = 'file';
/** フォルダとして開くときにクエリへ足す値（`view=dir`）。 */
export const DIR_VIEW = 'dir';

export function filesTarget(path: string | undefined, view: string | undefined): FilesTarget {
	const clean = path?.replace(/^\/+|\/+$/g, '');
	if (clean === undefined || clean.length === 0) {
		return { kind: 'tree', reveal: undefined };
	}
	if (view === FILE_VIEW) {
		return { kind: 'file', path: clean };
	}
	if (view === DIR_VIEW) {
		return { kind: 'tree', reveal: clean };
	}
	return { kind: 'unknown', path: clean };
}

/** クエリの `line`（内容の検索の一致行。1始まり）を読む。数でなければ undefined。 */
export function parseFocusLine(raw: string | undefined): number | undefined {
	const value = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
	return value !== undefined && value > 0 ? value : undefined;
}

/** `unknown` を親のフォルダの一覧で確かめた結果（見つからなければファイルとして開いてみる）。 */
export function resolveUnknownTarget(path: string, parentEntries: readonly { readonly name: string; readonly dir: boolean }[]): FilesTarget {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const entry = parentEntries.find(candidate => candidate.name === name);
	return entry?.dir === true ? { kind: 'tree', reveal: path } : { kind: 'file', path };
}

/** ビューアのタイトルの下に出すパンくず（スペース名 → 含むフォルダ）。どれも押せばツリーのそのフォルダへ移る。 */
export function viewerBreadcrumb(spaceName: string | undefined, filePath: string): BreadcrumbItem[] {
	return breadcrumbItems(spaceName, parentPath(filePath)).map(item => ({ ...item, current: false }));
}

export function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TOKENIZED_WRAPPER = /^\s*<div class="monaco-tokenized-source"[^>]*>([\s\S]*)<\/div>\s*$/;

/**
 * コードを行の配列（HTML 片）にする。PC のハイライト（`.monaco-tokenized-source` の中を `<br>` で
 * 区切った HTML。トークンは行をまたがない）があればそれを、無ければ本文をエスケープして使う。
 * 末尾の改行が作る空の最終行は落とす（エディタの行番号と合わせる）。
 */
export function codeLines(result: Pick<FsReadResult, 'content' | 'html'>): string[] {
	const tokenized = result.html !== undefined ? TOKENIZED_WRAPPER.exec(result.html)?.[1] : undefined;
	const lines = tokenized !== undefined
		? tokenized.split(/<br\s*\/?>/i)
		: result.content.split('\n').map(line => escapeHtml(line.replace(/\r$/, '')));
	if (lines.length > 1 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/** コードの表示で一度に出す行数。超えるファイルは 1 万行ずつのページにして、下の帯で前後へ移る（設計書 3b.5）。 */
export const CODE_LINE_WINDOW = 10_000;

/**
 * 表示する行（HTML 片。`start` 行目（0 始まり）から最大 `count` 行）と、ファイル全体の行数。PC のハイライトは
 * ファイルの先頭（128K 文字）だけなので、ハイライトが途中で切れていれば（`highlightTruncated`）、切れた最後の行から
 * 先は本文をエスケープした素の行で続ける。以前はハイライトの行だけを出していたので、128K 文字を超えるファイルは
 * 本文を全部受けても先頭しか見えなかった。
 */
export function codeLinesWindow(result: Pick<FsReadResult, 'content' | 'html' | 'highlightTruncated'>, start: number, count: number): { readonly lines: string[]; readonly total: number } {
	const tokenized = result.html !== undefined ? TOKENIZED_WRAPPER.exec(result.html)?.[1] : undefined;
	const highlighted = tokenized !== undefined ? dropTrailingEmpty(tokenized.split(/<br\s*\/?>/i)) : [];
	const end = start + count;
	if (tokenized !== undefined && result.highlightTruncated !== true) {
		return { lines: highlighted.slice(start, end), total: highlighted.length };
	}
	const plain = dropTrailingEmpty(result.content.split('\n'));
	// ハイライトが途中で切れていれば、切れた最後の行から素の本文に切り替える。ハイライトが無ければ全部素の本文
	const kept = Math.min(Math.max(highlighted.length - 1, 0), plain.length);
	const lines = highlighted.slice(start, Math.min(kept, end));
	for (let index = Math.max(start, kept); index < plain.length && index < end; index++) {
		lines.push(escapeHtml((plain[index] ?? '').replace(/\r$/, '')));
	}
	return { lines, total: Math.max(plain.length, kept) };
}

/** 本文の行数（末尾の改行が作る空の最終行は数えない。{@link codeLinesWindow} の `total` と同じ）。 */
export function codeLineTotal(content: string): number {
	let lines = 1;
	for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1)) {
		lines++;
	}
	return lines > 1 && content.endsWith('\n') ? lines - 1 : lines;
}

/** その行（1 始まり）を含むページの先頭（0 始まり）。 */
export function codePageStartOf(line: number | undefined): number {
	return line !== undefined && line > 0 ? Math.floor((line - 1) / CODE_LINE_WINDOW) * CODE_LINE_WINDOW : 0;
}

/** 末尾の改行が作る空の最終行を落とす（エディタの行番号と合わせる）。 */
function dropTrailingEmpty(lines: string[]): string[] {
	if (lines.length > 1 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * コードの表示（モックの `.src`）。行番号の列（幅 40）と本文を1行ずつ並べ、PC のテーマの
 * トークン色（`css`）と地の色を当てる。`focusLine`（検索の一致行）があればその行に色を敷いて
 * 中央までスクロールする（このときだけ WebView のスクリプトを有効にする。`webViewScriptPolicy`）。
 */
/** 選択の印・リンクの色（設定 → 色）。渡さなければ既定。 */
type AccentColors = Pick<ThemeColors, 'accent' | 'accentWash'>;
const DEFAULT_ACCENT: AccentColors = { accent: colors.accent, accentWash: colors.accentWash };

/**
 * `nonce` を渡すと、`<head>` の先頭に自分のスクリプトだけを動かす CSP を置き、一致行へ送るスクリプトに nonce を付ける
 * （ビューアの中の検索のために WebView のスクリプトを有効にするため。`fileFind.ts`）。
 */
export function buildCodeHtml(result: FsReadResult, focusLine?: number, accent: AccentColors = DEFAULT_ACCENT, nonce?: string, pageStart = 0): string {
	const bg = result.bg ?? colors.codeBg;
	const fg = result.fg ?? colors.terminalFg;
	const rows = codeLinesWindow(result, pageStart, CODE_LINE_WINDOW).lines
		.map((line, index) => {
			const number = pageStart + index + 1;
			return `<div class="l${number === focusLine ? ' f' : ''}"><i>${number}</i><span>${line.length > 0 ? line : ' '}</span></div>`;
		})
		.join('');
	const focusScript = focusLine !== undefined && focusLine > 0
		? `<script${nonce !== undefined ? ` nonce="${nonce}"` : ''}>(function(){var f=document.querySelector(".f");if(f){setTimeout(function(){f.scrollIntoView({block:"center"});},50);}})();</script>`
		: '';
	return `<!DOCTYPE html><html><head>${nonce !== undefined ? viewerScriptCspMeta(nonce) : ''}
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${result.css ?? ''}</style>
<style>
	html, body { margin: 0; background: ${bg}; color: ${fg}; }
	.src { display: inline-block; min-width: 100%; padding: 12px 0; font-family: Menlo, ui-monospace, monospace; font-size: ${type.meta}px; line-height: 18px; }
	.l { display: flex; }
	.l i { font-style: normal; width: 40px; flex: none; text-align: right; padding-right: 12px; color: ${colors.idle}; user-select: none; -webkit-user-select: none; }
	.l span { white-space: pre; padding-right: 12px; }
	.l.f { background: ${accent.accentWash}; }
</style>
</head><body><div class="src monaco-tokenized-source">${rows}</div>${focusScript}</body></html>`;
}

/**
 * Markdown のプレビュー（モックの `.mdv`）。地と文字は PC のテーマに合わせる。
 * `nonce` を渡すと、本文に混ざった生の HTML のスクリプトを止める CSP を `<head>` の先頭に置く（`buildCodeHtml` と同じ）。
 */
export function buildMarkdownHtml(result: Pick<FsReadResult, 'content' | 'bg' | 'fg'>, accent: AccentColors = DEFAULT_ACCENT, nonce?: string): string {
	const bg = result.bg ?? colors.codeBg;
	const fg = result.fg ?? colors.text;
	const rendered = marked.parse(result.content, { async: false });
	return `<!DOCTYPE html><html><head>${nonce !== undefined ? viewerScriptCspMeta(nonce) : ''}
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
	body { margin: 0; padding: 16px; background: ${bg}; color: ${fg}; font-family: -apple-system, sans-serif; font-size: ${type.input}px; line-height: 24px; word-wrap: break-word; }
	h1 { font-size: ${type.hero}px; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 0.5px solid ${colors.border}; }
	h2 { font-size: ${type.title}px; margin: 18px 0 8px; }
	h3 { font-size: ${type.heading}px; margin: 16px 0 8px; }
	p { margin: 0 0 10px; }
	ul, ol { margin: 0 0 10px; padding-left: 22px; }
	a { color: ${accent.accent}; }
	img { max-width: 100%; }
	code { font-family: Menlo, ui-monospace, monospace; font-size: ${type.label}px; background: ${colors.raised}; border-radius: ${radius.key}px; padding: 1px 4px; }
	pre { background: ${colors.bg}; border: 0.5px solid ${colors.border}; border-radius: ${radius.row}px; padding: 10px 12px; font-size: ${type.meta}px; line-height: 18px; overflow-x: auto; margin: 0 0 10px; }
	pre code { background: none; padding: 0; font-size: ${type.meta}px; }
	blockquote { margin: 0 0 10px; padding-left: 12px; border-left: 3px solid ${colors.borderStrong}; color: ${colors.textDim}; }
	table { border-collapse: collapse; margin: 0 0 10px; }
	th, td { border: 0.5px solid ${colors.border}; padding: 5px 10px; }
</style>
</head><body>${rendered}</body></html>`;
}
