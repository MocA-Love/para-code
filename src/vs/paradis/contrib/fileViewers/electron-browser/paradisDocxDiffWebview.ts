/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word 差分ビューアの webview 側。vendored docx-preview で2つの .docx をパースし、
//   (1) renderer に渡す「ブロック概要」を AST から抜き出す
//   (2) renderer が返した注釈を AST に注入してから描画する
// の2役を持つ。
//
// なぜ AST に注入するのか:
// docx-preview の `renderStyleValues` は cssStyle のキーが `$` で始まると `setAttribute` を呼ぶ。
// この隙間を使うと vendored ライブラリに一切手を入れずに、**Word 本来の描画のまま**差分の印を
// 出力 DOM に載せられる。自前レンダラを書くより桁違いに安く、通常ビューアと見た目も揃う。
//
// なぜ本体を `paradisDocxDiffWebviewMain` という1つの関数に閉じ込めているのか:
// この関数は `.toString()` で HTML に埋め込まれて webview の中で実行される。つまり
// **モジュールスコープの識別子を実行時に一切参照できない**（esbuild が名前を潰す/落とすため）。
// 定数は `ctx`、外の世界（docx-preview・DOM・メッセージ送受信・タイマー）は `host` 経由で渡し、
// ヘルパは関数の内側に置くこと。型だけは実行時に消えるので自由に使ってよい。
//
// この方式にすると media/*.js を増やさずに済み、ビルド同梱の glob 追加（build/gulpfile.vscode.ts と
// build/next/index.ts の2箇所）が不要になる。CSS は既存の `media/*.css` の glob に乗るのでそのまま。
//
// 外の世界を `host` で受け取るのは、埋め込みコードを**単体テストできるようにする**ため。
// `window` を直に触ると webview の外からは動かせず、この一番込み入った部分（run の分割・
// ゴーストの差し込み）が一切検証できなくなる。テストは test/electron-browser/paradisDocxDiffWebview.test.ts。

import { FileAccess } from '../../../../base/common/network.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { paradisPreviewOrigins } from './paradisViewerAssets.js';
import { buildParadisOfficeWordCsp, paradisOfficeWebviewResourceOrigin } from '../common/paradisOfficeSanitizer.js';
import {
	IParadisDocxAnnotation,
	IParadisDocxBlock,
	IParadisDocxFiller,
	IParadisDocxOutline,
	IParadisDocxRun,
	IParadisDocxSegment,
	PARADIS_DOCX_BLOCK_FORMAT_KEYS,
	PARADIS_DOCX_CHANGE_ATTR,
	PARADIS_DOCX_CHAR_STYLE_KEY,
	PARADIS_DOCX_DETAIL_ATTR,
	PARADIS_DOCX_DIFF_ATTR,
	PARADIS_DOCX_ERROR_LIBRARY_MISSING,
	PARADIS_DOCX_GHOST_ATTR,
	PARADIS_DOCX_MAX_BLOCKS,
	PARADIS_DOCX_OBJECT_CHAR,
	PARADIS_DOCX_RUN_FORMAT_KEYS,
	PARADIS_DOCX_SEG_ATTR,
	PARADIS_DOCX_VERTICAL_ALIGN_KEY,
	ParadisDocxHostMessage,
	ParadisDocxSide,
} from '../common/paradisDocx.js';

/** vendored docx-preview / jszip 成果物の配置ディレクトリ（AppResourcePath）。 */
const DOCX_MEDIA_ROOT = 'vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview' as const;

// ── docx-preview の AST（使う部分だけを緩く型付けする） ────────────────────
//
// 実際の形は vendored な docx-preview@0.3.7 のパーサが作るプレーンオブジェクト。
// `props` は Document ノードにしか無く、書式は cssStyle に CSS プロパティ名で入る。

export interface IParadisDocxAstNode {
	type: string;
	children?: IParadisDocxAstNode[];
	cssStyle?: Record<string, string>;
	styleName?: string;
	className?: string;
	text?: string;
	numbering?: { id: string; level: number };
	verticalAlign?: string;
	fieldRun?: boolean;
	src?: string;
	char?: string;
	id?: string;
}

export interface IParadisDocxAstDocument {
	documentPart?: {
		body?: IParadisDocxAstNode;
		rels?: { id: string; target: string }[];
	};
}

/** vendored docx-preview のうち、差分ビューアが使う部分。 */
export interface IParadisDocxPreviewApi {
	parseAsync(data: ArrayBuffer, options: Record<string, unknown>): Promise<IParadisDocxAstDocument>;
	renderDocument(document: IParadisDocxAstDocument, body: unknown, styles: unknown, options: Record<string, unknown>): Promise<unknown>;
}

/** 片側のペインを構成する要素。 */
export interface IParadisDocxDiffPane {
	/** スクロールする要素。 */
	readonly scroller: { scrollTop: number; readonly clientHeight: number; readonly scrollHeight: number } & IParadisDocxDiffQueryable;
	/** docx-preview の bodyContainer。 */
	readonly content: unknown;
	/** docx-preview の styleContainer。左右で必ず別の要素にすること。 */
	readonly styles: unknown;
	/** transform をかける要素。 */
	readonly zoom: { readonly style: { transform: string }; readonly scrollHeight: number; readonly scrollWidth: number };
	/** 縮尺後の footprint を確保する枠。 */
	readonly sizer: { readonly style: { height: string; width: string } };
}

/** 差分の印が付いた要素を探すのに使う、最小限の DOM 操作。 */
export interface IParadisDocxDiffQueryable {
	find(selector: string): readonly IParadisDocxDiffElement[];
	/** 自分自身の上端座標（スクロール位置の計算に使う）。 */
	top(): number;
}

export interface IParadisDocxDiffElement {
	top(): number;
	addClass(name: string): void;
	removeClass(name: string): void;
	attribute(name: string): string | null;
}

/** webview の外の世界。テストではこれを差し替える。 */
export interface IParadisDocxDiffWebviewHost {
	readonly docx: IParadisDocxPreviewApi | undefined;
	/** JSZip が読み込めているか（docx-preview が zip 展開に使う）。 */
	readonly hasZip: boolean;
	readonly panes: Readonly<Record<ParadisDocxSide, IParadisDocxDiffPane>>;
	post(message: unknown): void;
	onMessage(handler: (message: ParadisDocxHostMessage) => void): void;
	onScroll(side: ParadisDocxSide, handler: () => void): void;
	/** 読み込み中の表示。undefined を渡すと消す。 */
	setStatus(text: string | undefined): void;
	/** 書式変更の表示を切り替える。 */
	setShowFormatChanges(enabled: boolean): void;
	setTimeout(handler: () => void, delay: number): number;
	clearTimeout(handle: number): void;
}

/** webview の中で実行される本体に渡す定数一式。 */
export interface IParadisDocxDiffWebviewContext {
	readonly attrDiff: string;
	readonly attrChange: string;
	readonly attrSeg: string;
	readonly attrDetail: string;
	readonly attrGhost: string;
	readonly runFormatKeys: readonly string[];
	readonly blockFormatKeys: readonly string[];
	readonly verticalAlignKey: string;
	readonly charStyleKey: string;
	readonly objectChar: string;
	readonly maxBlocks: number;
	readonly labelLoading: string;
	/** ライブラリ欠落を知らせるコード。文言は renderer 側で付ける（webview では nls を使えない）。 */
	readonly errorLibraryMissing: string;
}

/**
 * webview の中で実行される本体。
 *
 * **この関数の中から外側の識別子を参照してはいけない**（`.toString()` で埋め込まれるため）。
 * 型注釈は実行時に消えるので使ってよいが、値としての import は使えない。
 */
export function paradisDocxDiffWebviewMain(ctx: IParadisDocxDiffWebviewContext, host: IParadisDocxDiffWebviewHost): void {

	type Side = 'original' | 'modified';
	const SIDES: Side[] = ['original', 'modified'];

	/** 抽出した1ブロックの、AST 側の参照。注釈を戻すときに使う。 */
	interface BlockRef {
		readonly node: IParadisDocxAstNode;
		/** ゴーストを差し込む位置決めに使う、本文直下の祖先（段落自身、または外側の表）。 */
		readonly topLevel: IParadisDocxAstNode;
		/** ブロック内の run ノードを、概要の runs と同じ並びで持つ。 */
		readonly runs: { readonly node: IParadisDocxAstNode; readonly parent: IParadisDocxAstNode }[];
	}

	interface LoadedDocument {
		readonly wordDocument: IParadisDocxAstDocument;
		readonly refs: BlockRef[];
		readonly outline: IParadisDocxOutline;
	}

	type Rels = { id: string; target: string }[] | undefined;

	const state: {
		documents: Partial<Record<Side, LoadedDocument>>;
		scale: number;
		syncing: boolean;
		activeChangeId: number;
		activeReportHandle: number;
		/** 最後に受け取った load の世代。古い読み込みの結果を捨てるために持つ。 */
		loadGeneration: number;
		/** 注入済みか。AST を書き換えるので二度通してはいけない。 */
		annotated: boolean;
	} = { documents: {}, scale: 1, syncing: false, activeChangeId: -1, activeReportHandle: 0, loadGeneration: -1, annotated: false };

	const PARSE_OPTIONS: Record<string, unknown> = { trimXmlDeclaration: true };

	function renderOptions(side: Side): Record<string, unknown> {
		return {
			// 左右で接頭辞を分けないと、生成 CSS クラス名と番号付きリストのカウンタ名が衝突し、
			// 片側の見出し番号が他方の続きから振られる。
			className: side === 'original' ? 'docx-l' : 'docx-r',
			inWrapper: true,
			ignoreWidth: false,
			// 用紙の高さを固定しない。差分では左右の段落を縦に揃えたいので、
			// ページ割りをせず内容の高さのまま連続フローで描く。
			ignoreHeight: true,
			breakPages: false,
			ignoreLastRenderedPageBreak: false,
			experimental: true,
			renderHeaders: false,
			renderFooters: false,
			renderFootnotes: true,
			renderEndnotes: true,
			// 変更履歴入りの文書は「承認後の見た目」で比べる。概要の抽出側も w:del を読み飛ばして揃える。
			renderChanges: false,
			renderComments: false,
			useBase64URL: true,
			// Raw embedded fonts are never handed to the renderer. The Office asset pipeline publishes
			// only separately validated WOFF2 subsets; the legacy docx-preview path uses fallback fonts.
			ignoreFonts: true,
			// altChunk can contain arbitrary HTML and must be represented by the semantic placeholder path.
			renderAltChunks: false,
		};
	}

	// ── 概要の抽出 ────────────────────────────────────────────────────────

	function formatKeyOf(format: Record<string, string>): string {
		const keys = Object.keys(format).sort();
		let key = '';
		for (const name of keys) {
			key += (key ? ';' : '') + name + '=' + format[name];
		}
		return key;
	}

	function pickFormat(cssStyle: Record<string, string> | undefined, allowed: readonly string[]): Record<string, string> {
		const picked: Record<string, string> = {};
		if (!cssStyle) {
			return picked;
		}
		for (const name of allowed) {
			const value = cssStyle[name];
			if (value !== undefined && value !== null && value !== '') {
				picked[name] = String(value);
			}
		}
		return picked;
	}

	function registerFormat(formats: Record<string, Record<string, string>>, format: Record<string, string>): string {
		const key = formatKeyOf(format);
		if (key && !formats[key]) {
			formats[key] = format;
		}
		return key;
	}

	/** 画像の同一性キー。関係 ID(rId) は文書ごとに振り直されるので、可能なら実体のパスを使う。 */
	function imageKey(node: IParadisDocxAstNode, rels: Rels): string {
		let target: string | undefined;
		if (node.src && rels) {
			for (const rel of rels) {
				if (rel.id === node.src) {
					target = rel.target;
					break;
				}
			}
		}
		const width = node.cssStyle ? (node.cssStyle.width ?? '') : '';
		const height = node.cssStyle ? (node.cssStyle.height ?? '') : '';
		return 'img:' + (target ?? node.src ?? '') + ':' + width + 'x' + height;
	}

	function symbolChar(node: IParadisDocxAstNode): string {
		if (!node.char) {
			return ctx.objectChar;
		}
		const code = parseInt(node.char, 16);
		return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : ctx.objectChar;
	}

	interface RunAtom {
		readonly child: IParadisDocxAstNode;
		readonly text: string;
		/** 文字単位で切ってよいか（テキストノードだけ true）。 */
		readonly splittable: boolean;
		readonly object?: string;
	}

	/**
	 * run ノードの子を「文字を持つ最小単位」に分解する。
	 * 概要の抽出と run の分割で**必ず同じ規則**を使うこと。ずれるとオフセットが合わなくなる。
	 */
	function runAtoms(node: IParadisDocxAstNode, rels: Rels): RunAtom[] {
		const atoms: RunAtom[] = [];
		for (const child of node.children ?? []) {
			switch (child.type) {
				case 'text':
					atoms.push({ child, text: child.text ?? '', splittable: true });
					break;
				case 'tab':
					atoms.push({ child, text: '\t', splittable: false });
					break;
				case 'break':
					atoms.push({ child, text: '\n', splittable: false });
					break;
				case 'noBreakHyphen':
					// U+2011 NON-BREAKING HYPHEN。ソースに生の非ASCIIを置かないようコードポイントから作る。
					atoms.push({ child, text: String.fromCharCode(0x2011), splittable: false });
					break;
				case 'symbol':
					atoms.push({ child, text: symbolChar(child), splittable: false });
					break;
				case 'drawing':
				case 'vmlPicture': {
					let image: IParadisDocxAstNode | undefined;
					for (const nested of child.children ?? []) {
						if (nested.type === 'image') {
							image = nested;
							break;
						}
					}
					atoms.push({ child, text: ctx.objectChar, splittable: false, object: imageKey(image ?? child, rels) });
					break;
				}
				case 'footnoteReference':
				case 'endnoteReference':
					atoms.push({ child, text: ctx.objectChar, splittable: false, object: child.type + ':' + (child.id ?? '') });
					break;
				default:
					// deletedText は renderChanges:false では描画されない。
					// instruction / commentReference / fldChar 等ももともと文字を持たない。
					atoms.push({ child, text: '', splittable: false });
					break;
			}
		}
		return atoms;
	}

	function buildRun(node: IParadisDocxAstNode, formats: Record<string, Record<string, string>>, objects: string[], rels: Rels): IParadisDocxRun {
		let text = '';
		let hasText = false;
		for (const atom of runAtoms(node, rels)) {
			text += atom.text;
			if (atom.splittable && atom.text.length > 0) {
				hasText = true;
			}
			if (atom.object) {
				objects.push(atom.object);
			}
		}
		const format = pickFormat(node.cssStyle, ctx.runFormatKeys);
		if (node.verticalAlign) {
			format[ctx.verticalAlignKey] = node.verticalAlign;
		}
		if (node.styleName) {
			format[ctx.charStyleKey] = node.styleName;
		}
		const fmt = registerFormat(formats, format);
		// 文字を1つも持たない run（画像だけの run 等）は、途中で切らず run 全体に印を付ける。
		return !hasText && text.length > 0 ? { text, fmt, special: 'object' } : { text, fmt };
	}

	/** 段落の子を辿って run を集める。描画されないもの（w:del 配下）は読み飛ばす。 */
	function collectRuns(
		children: readonly IParadisDocxAstNode[] | undefined,
		parent: IParadisDocxAstNode,
		runs: IParadisDocxRun[],
		refs: { node: IParadisDocxAstNode; parent: IParadisDocxAstNode }[],
		formats: Record<string, Record<string, string>>,
		objects: string[],
		rels: Rels
	): void {
		for (const child of children ?? []) {
			switch (child.type) {
				case 'run':
					runs.push(buildRun(child, formats, objects, rels));
					refs.push({ node: child, parent });
					break;
				case 'hyperlink':
				case 'smartTag':
				case 'inserted':
					// w:ins は renderChanges:false でも中身がそのまま描画される。
					collectRuns(child.children, child, runs, refs, formats, objects, rels);
					break;
				case 'deleted':
					// w:del は renderChanges:false では丸ごと描画されない。概要にも入れない。
					break;
				case 'mmlMath':
				case 'mmlMathParagraph':
					runs.push({ text: ctx.objectChar, fmt: '', special: 'object' });
					refs.push({ node: child, parent });
					objects.push('math');
					break;
				default:
					break;
			}
		}
	}

	function extractOutline(wordDocument: IParadisDocxAstDocument): { outline: IParadisDocxOutline; refs: BlockRef[] } {
		const blocks: IParadisDocxBlock[] = [];
		const refs: BlockRef[] = [];
		const formats: Record<string, Record<string, string>> = {};
		const rels = wordDocument.documentPart ? wordDocument.documentPart.rels : undefined;
		let truncated = false;

		const visit = (nodes: readonly IParadisDocxAstNode[] | undefined, topLevel: IParadisDocxAstNode | undefined, depth: number): void => {
			for (const node of nodes ?? []) {
				if (truncated) {
					return;
				}
				const ancestor = topLevel ?? node;
				switch (node.type) {
					case 'paragraph': {
						if (blocks.length >= ctx.maxBlocks) {
							truncated = true;
							return;
						}
						const index = blocks.length;
						const runs: IParadisDocxRun[] = [];
						const runRefs: { node: IParadisDocxAstNode; parent: IParadisDocxAstNode }[] = [];
						const objects: string[] = [];
						collectRuns(node.children, node, runs, runRefs, formats, objects, rels);
						let text = '';
						for (const run of runs) {
							text += run.text;
						}
						blocks.push({
							index,
							kind: 'paragraph',
							text,
							depth,
							styleName: node.styleName || undefined,
							listKey: node.numbering ? node.numbering.id + ':' + node.numbering.level : undefined,
							fmt: registerFormat(formats, pickFormat(node.cssStyle, ctx.blockFormatKeys)),
							objects: objects.length ? objects : undefined,
							runs,
						});
						refs.push({ node, topLevel: ancestor, runs: runRefs });
						break;
					}
					case 'table':
						visit(node.children, ancestor, depth + 1);
						break;
					case 'row':
					case 'cell':
						visit(node.children, ancestor, depth);
						break;
					default:
						break;
				}
			}
		};

		const body = wordDocument.documentPart ? wordDocument.documentPart.body : undefined;
		visit(body ? body.children : undefined, undefined, 0);
		return { outline: truncated ? { blocks, formats, truncated: true } : { blocks, formats }, refs };
	}

	// ── 注釈の注入 ────────────────────────────────────────────────────────

	/** pPr が無い段落や hyperlink は cssStyle を持たないので、必ずここで用意する。 */
	function ensureCssStyle(node: IParadisDocxAstNode): Record<string, string> {
		if (!node.cssStyle) {
			node.cssStyle = {};
		}
		return node.cssStyle;
	}

	/** run を印の区間ごとに分割した新しい run 群を返す。分割不要なら undefined。 */
	function splitRun(node: IParadisDocxAstNode, segments: readonly IParadisDocxSegment[], rels: Rels): IParadisDocxAstNode[] | undefined {
		const atoms = runAtoms(node, rels);
		let total = 0;
		for (const atom of atoms) {
			total += atom.text.length;
		}
		if (total === 0) {
			// 文字を持たない run。分割せず run 自体に印を付ける。
			const style = ensureCssStyle(node);
			style['$' + ctx.attrSeg] = segments[0].type;
			if (segments[0].detail) {
				style['$' + ctx.attrDetail] = segments[0].detail;
			}
			return undefined;
		}

		// 1文字ごとにどの印が乗るかを決める。added/removed は format より優先する。
		const marks: (IParadisDocxSegment | null)[] = new Array(total).fill(null);
		for (const segment of segments) {
			const from = Math.max(0, segment.start);
			const to = Math.min(total, segment.end);
			for (let i = from; i < to; i++) {
				const current = marks[i];
				if (!current || (current.type === 'format' && segment.type !== 'format')) {
					marks[i] = segment;
				}
			}
		}

		// 分割できない原子（タブ・画像など）は、その内側で印が変わらないよう先頭の印に揃える。
		// これで「1つの原子が2つの区間にまたがって二重に描かれる」ことがなくなる。
		let offset = 0;
		for (const atom of atoms) {
			if (!atom.splittable && atom.text.length > 1) {
				for (let i = 1; i < atom.text.length; i++) {
					marks[offset + i] = marks[offset];
				}
			}
			offset += atom.text.length;
		}

		// 同じ印が続く区間にまとめる。
		const ranges: { from: number; to: number; mark: IParadisDocxSegment | null }[] = [];
		let start = 0;
		for (let i = 1; i <= total; i++) {
			if (i === total || marks[i] !== marks[start]) {
				ranges.push({ from: start, to: i, mark: marks[start] });
				start = i;
			}
		}
		if (ranges.length === 1 && !ranges[0].mark) {
			return undefined;
		}

		const pieces: IParadisDocxAstNode[] = [];
		for (let r = 0; r < ranges.length; r++) {
			const range = ranges[r];
			const children: IParadisDocxAstNode[] = [];
			let cursor = 0;
			for (const atom of atoms) {
				const atomStart = cursor;
				const atomEnd = cursor + atom.text.length;
				cursor = atomEnd;
				if (atom.text.length === 0) {
					// 文字を持たない子は、その位置を含む区間へ入れる（末尾なら最後の区間）。
					if ((range.from <= atomStart && atomStart < range.to) || (atomStart >= total && r === ranges.length - 1)) {
						children.push(atom.child);
					}
					continue;
				}
				if (atomEnd <= range.from || atomStart >= range.to) {
					continue;
				}
				if (!atom.splittable) {
					// 印を揃えてあるので、この原子は必ず1つの区間だけに属する。
					children.push(atom.child);
					continue;
				}
				const sliceFrom = Math.max(0, range.from - atomStart);
				const sliceTo = Math.min(atom.text.length, range.to - atomStart);
				if (sliceTo > sliceFrom) {
					children.push({ type: 'text', text: atom.text.substring(sliceFrom, sliceTo) });
				}
			}
			if (children.length === 0) {
				continue;
			}
			const piece: IParadisDocxAstNode = { type: 'run', children, cssStyle: { ...(node.cssStyle ?? {}) } };
			if (node.styleName) { piece.styleName = node.styleName; }
			if (node.className) { piece.className = node.className; }
			if (node.verticalAlign) { piece.verticalAlign = node.verticalAlign; }
			if (node.fieldRun) { piece.fieldRun = node.fieldRun; }
			if (range.mark) {
				piece.cssStyle!['$' + ctx.attrSeg] = range.mark.type;
				if (range.mark.detail) {
					piece.cssStyle!['$' + ctx.attrDetail] = range.mark.detail;
				}
			}
			pieces.push(piece);
		}
		return pieces.length ? pieces : undefined;
	}

	function applyAnnotations(loaded: LoadedDocument, annotations: readonly IParadisDocxAnnotation[]): void {
		const rels = loaded.wordDocument.documentPart ? loaded.wordDocument.documentPart.rels : undefined;
		// 同じ親に対する run の置換はまとめて1回で行う（children を何度も作り直さない）。
		const replacements = new Map<IParadisDocxAstNode, Map<IParadisDocxAstNode, IParadisDocxAstNode[]>>();

		for (const annotation of annotations) {
			const ref = loaded.refs[annotation.index];
			if (!ref) {
				continue;
			}
			const style = ensureCssStyle(ref.node);
			style['$' + ctx.attrDiff] = annotation.status;
			style['$' + ctx.attrChange] = String(annotation.changeId);
			if (annotation.detail) {
				style['$' + ctx.attrDetail] = annotation.detail;
			}
			if (!annotation.segments || annotation.segments.length === 0) {
				continue;
			}
			const byRun = new Map<number, IParadisDocxSegment[]>();
			for (const segment of annotation.segments) {
				const list = byRun.get(segment.run);
				if (list) {
					list.push(segment);
				} else {
					byRun.set(segment.run, [segment]);
				}
			}
			for (const [runIndex, segments] of byRun) {
				const runRef = ref.runs[runIndex];
				if (!runRef) {
					continue;
				}
				const pieces = splitRun(runRef.node, segments, rels);
				if (!pieces) {
					continue;
				}
				let map = replacements.get(runRef.parent);
				if (!map) {
					map = new Map<IParadisDocxAstNode, IParadisDocxAstNode[]>();
					replacements.set(runRef.parent, map);
				}
				map.set(runRef.node, pieces);
			}
		}

		for (const [parent, map] of replacements) {
			const next: IParadisDocxAstNode[] = [];
			for (const child of parent.children ?? []) {
				const pieces = map.get(child);
				if (pieces) {
					for (const piece of pieces) {
						next.push(piece);
					}
				} else {
					next.push(child);
				}
			}
			parent.children = next;
		}
	}

	function ghostNode(filler: IParadisDocxFiller): IParadisDocxAstNode {
		// スタイル名も番号も持たない素の段落にする（相手側の書式を持ち込まないため）。
		// 見た目は webview 側の CSS が `[data-paradis-ghost]` で当てる。
		const cssStyle: Record<string, string> = {};
		cssStyle['$' + ctx.attrGhost] = filler.kind;
		cssStyle['$' + ctx.attrChange] = String(filler.changeId);
		return {
			type: 'paragraph',
			cssStyle,
			children: [{ type: 'run', children: [{ type: 'text', text: filler.text }] }],
		};
	}

	function insertFillers(loaded: LoadedDocument, fillers: readonly IParadisDocxFiller[]): void {
		const body = loaded.wordDocument.documentPart ? loaded.wordDocument.documentPart.body : undefined;
		if (!body || !body.children) {
			return;
		}
		// 本文直下の位置は先に引けるようにしておく（ゴースト1件ごとに indexOf を回すと二乗になる）。
		const positionOf = new Map<IParadisDocxAstNode, number>();
		for (let i = 0; i < body.children.length; i++) {
			positionOf.set(body.children[i], i);
		}
		// 本文直下の何番目に差し込むかでまとめる。差し込み先は必ず本文直下（表の中には作らない）。
		const grouped = new Map<number, IParadisDocxAstNode[]>();
		for (const filler of fillers) {
			let position: number;
			if (filler.afterIndex < 0) {
				position = 0;
			} else {
				const ref = loaded.refs[filler.afterIndex];
				if (!ref) {
					continue;
				}
				// 表の中の段落を指していても、その表そのものの直後に置けばよい。
				const at = positionOf.get(ref.topLevel);
				if (at === undefined) {
					continue;
				}
				position = at + 1;
			}
			const node = ghostNode(filler);
			const list = grouped.get(position);
			if (list) {
				list.push(node);
			} else {
				grouped.set(position, [node]);
			}
		}
		// 後ろから差し込めば、前の位置の添字がずれない。
		const positions = [...grouped.keys()].sort((a, b) => b - a);
		for (const position of positions) {
			body.children.splice(position, 0, ...grouped.get(position)!);
		}
	}

	// ── 表示 ──────────────────────────────────────────────────────────────

	function applyZoom(): void {
		for (const side of SIDES) {
			const pane = host.panes[side];
			pane.zoom.style.transform = 'scale(' + state.scale + ')';
			// 縮尺後の footprint を確保してスクロール量を正す。
			// CSS zoom はレイアウトの丸めで罫線が欠けるので使わない（Excel 差分で実証済み）。
			pane.sizer.style.height = Math.ceil(pane.zoom.scrollHeight * state.scale) + 'px';
			pane.sizer.style.width = Math.ceil(pane.zoom.scrollWidth * state.scale) + 'px';
		}
	}

	function changeSelector(changeId: number): string {
		return '[' + ctx.attrChange + '="' + changeId + '"]';
	}

	function reveal(changeId: number): void {
		state.activeChangeId = changeId;
		for (const side of SIDES) {
			for (const element of host.panes[side].scroller.find('.paradis-current')) {
				element.removeClass('paradis-current');
				element.removeClass('paradis-pulse');
			}
		}
		const pulsing: IParadisDocxDiffElement[] = [];
		for (const side of SIDES) {
			const scroller = host.panes[side].scroller;
			const elements = scroller.find(changeSelector(changeId));
			if (elements.length === 0) {
				continue;
			}
			for (const element of elements) {
				element.addClass('paradis-current');
				element.addClass('paradis-pulse');
				pulsing.push(element);
			}
			// offsetTop は使えない。用紙(section)が position:relative なので offsetParent が
			// ペインではなく用紙になり、さらに transform:scale が挟まって値が合わない。
			// 画面座標の差だけを見れば、変形も入れ子も気にしなくてよい。
			const delta = elements[0].top() - scroller.top();
			holdSync();
			// 左右で同じ高さに来るよう、ペイン上端から 30% の位置に合わせる。
			scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - scroller.clientHeight * 0.3);
		}
		if (pulsing.length > 0) {
			host.setTimeout(() => {
				for (const element of pulsing) {
					element.removeClass('paradis-pulse');
				}
			}, 1200);
		}
	}

	/**
	 * scrollTop を書き換えたことで返ってくる scroll イベントを無視するための札を立てる。
	 *
	 * **同期的に下ろしてはいけない**。scroll イベントは代入の後で非同期に飛ぶので、
	 * その場で false に戻すと札が立っていない状態でイベントを受け、
	 * 片側を合わせた直後にもう片側が比例スクロールで上書きしてしまう
	 * （Prev/Next の位置合わせが毎回潰れる）。
	 */
	function holdSync(): void {
		state.syncing = true;
		host.setTimeout(() => { state.syncing = false; }, 0);
	}

	function syncScroll(from: Side, to: Side): void {
		if (state.syncing) {
			return;
		}
		holdSync();
		const source = host.panes[from].scroller;
		const target = host.panes[to].scroller;
		const sourceRange = source.scrollHeight - source.clientHeight;
		const targetRange = target.scrollHeight - target.clientHeight;
		target.scrollTop = sourceRange > 0 ? (source.scrollTop / sourceRange) * targetRange : 0;
	}

	/**
	 * いま見ている変更を renderer に伝える（「3 / 12」の表示を追随させる）。
	 *
	 * 「上端より下にある最初の変更」ではなく **reveal と同じ基準線（上端から30%）に一番近いもの**を選ぶ。
	 * 基準がずれていると、Next で送った直後に手前の変更を「現在位置」として報告してしまい、
	 * 隣り合う2件の間を行き来して先へ進めなくなる。
	 */
	function reportActiveChange(): void {
		if (state.activeReportHandle) {
			host.clearTimeout(state.activeReportHandle);
		}
		state.activeReportHandle = host.setTimeout(() => {
			state.activeReportHandle = 0;
			const scroller = host.panes.modified.scroller;
			const anchor = scroller.top() + scroller.clientHeight * 0.3;
			let bestValue = -1;
			let bestDistance = Number.POSITIVE_INFINITY;
			for (const element of scroller.find('[' + ctx.attrChange + ']')) {
				const value = Number(element.attribute(ctx.attrChange));
				if (!Number.isFinite(value)) {
					continue;
				}
				const distance = Math.abs(element.top() - anchor);
				if (distance < bestDistance) {
					bestDistance = distance;
					bestValue = value;
				}
			}
			if (bestValue >= 0 && bestValue !== state.activeChangeId) {
				state.activeChangeId = bestValue;
				host.post({ type: 'activeChange', changeId: bestValue });
			}
		}, 120);
	}

	// ── メッセージ処理 ────────────────────────────────────────────────────

	/** 例外を文字列にする。`error instanceof Error` で判定すること（真偽値で見ると undefined を表示してしまう）。 */
	function messageOf(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	async function handleLoad(generation: number, original: ArrayBuffer, modified: ArrayBuffer): Promise<void> {
		if (!host.docx || !host.hasZip) {
			host.post({ type: 'error', message: ctx.errorLibraryMissing });
			return;
		}
		// 同じ webview に load が二重に届いても、後から来た方だけを通す。
		state.loadGeneration = generation;
		host.setStatus(ctx.labelLoading);
		state.documents = {};
		const inputs: { side: Side; data: ArrayBuffer }[] = [
			{ side: 'original', data: original },
			{ side: 'modified', data: modified },
		];
		for (const input of inputs) {
			try {
				const wordDocument = await host.docx.parseAsync(input.data, PARSE_OPTIONS);
				if (state.loadGeneration !== generation) {
					return;
				}
				const extracted = extractOutline(wordDocument);
				state.documents[input.side] = { wordDocument, refs: extracted.refs, outline: extracted.outline };
			} catch (error) {
				if (state.loadGeneration !== generation) {
					return;
				}
				host.setStatus(undefined);
				host.post({ type: 'error', side: input.side, message: messageOf(error) });
				return;
			}
		}
		host.post({
			type: 'outline',
			generation,
			original: state.documents.original!.outline,
			modified: state.documents.modified!.outline,
		});
	}

	async function handleAnnotate(annotations: readonly IParadisDocxAnnotation[], fillers: readonly IParadisDocxFiller[]): Promise<void> {
		if (state.annotated) {
			// 注入は AST を書き換えるので冪等ではない（ゴーストが二重に入る）。1回だけ通す。
			return;
		}
		state.annotated = true;
		for (const side of SIDES) {
			const loaded = state.documents[side];
			if (!loaded) {
				continue;
			}
			applyAnnotations(loaded, annotations.filter(annotation => annotation.side === side));
			insertFillers(loaded, fillers.filter(filler => filler.side === side));
		}
		// 注入は必ず描画より前に済ませること。docx-preview は render の先頭で processElement を
		// 1回だけ走らせて parent を張るので、描画後に木を触っても反映されない。
		try {
			for (const side of SIDES) {
				const loaded = state.documents[side];
				if (!loaded || !host.docx) {
					continue;
				}
				const pane = host.panes[side];
				await host.docx.renderDocument(loaded.wordDocument, pane.content, pane.styles, renderOptions(side));
			}
		} catch (error) {
			host.setStatus(undefined);
			host.post({ type: 'error', message: messageOf(error) });
			return;
		}
		host.setStatus(undefined);
		applyZoom();
		host.post({ type: 'rendered' });
	}

	host.onMessage(message => {
		if (!message || typeof message.type !== 'string') {
			return;
		}
		switch (message.type) {
			case 'load':
				void handleLoad(message.generation, message.original, message.modified);
				break;
			case 'annotate':
				void handleAnnotate(message.annotations ?? [], message.fillers ?? []);
				break;
			case 'reveal':
				reveal(message.changeId);
				break;
			case 'zoom':
				state.scale = message.scale;
				applyZoom();
				break;
			case 'showFormatChanges':
				host.setShowFormatChanges(message.enabled);
				break;
			default:
				break;
		}
	});

	host.onScroll('original', () => syncScroll('original', 'modified'));
	host.onScroll('modified', () => {
		syncScroll('modified', 'original');
		reportActiveChange();
	});

	host.post({ type: 'ready' });
}

/**
 * webview の中で `host` を組み立てるブートストラップ。
 * これも `.toString()` で埋め込まれるので、外側の識別子を参照してはいけない。
 */
export function paradisDocxDiffWebviewBoot(ctx: IParadisDocxDiffWebviewContext, main: typeof paradisDocxDiffWebviewMain): void {

	/* eslint-disable no-restricted-globals, no-restricted-syntax */

	// この関数は webview の iframe の中で動くので `window` は1つしか無く、
	// dom.ts のヘルパ（h() や DOM.getWindow）も持ち込めない。
	// upstream の webviewPreloads.ts と同じ理由・同じ抑制。

	const globals = window as unknown as {
		docx?: IParadisDocxPreviewApi;
		JSZip?: unknown;
		acquireVsCodeApi(): { postMessage(message: unknown): void };
	};
	const api = globals.acquireVsCodeApi();
	const byId = (id: string) => window.document.getElementById(id)!;

	const wrapElement = (element: Element): IParadisDocxDiffElement => ({
		top: () => element.getBoundingClientRect().top,
		addClass: (name: string) => element.classList.add(name),
		removeClass: (name: string) => element.classList.remove(name),
		attribute: (name: string) => element.getAttribute(name),
	});

	const buildPane = (suffix: string): IParadisDocxDiffPane => {
		const scroller = byId('pane-' + suffix);
		return {
			scroller: {
				get scrollTop() { return scroller.scrollTop; },
				set scrollTop(value: number) { scroller.scrollTop = value; },
				get clientHeight() { return scroller.clientHeight; },
				get scrollHeight() { return scroller.scrollHeight; },
				top: () => scroller.getBoundingClientRect().top,
				find: (selector: string) => Array.from(scroller.querySelectorAll(selector), wrapElement),
			},
			content: byId('doc-' + suffix),
			styles: byId('style-' + suffix),
			zoom: byId('zoom-' + suffix),
			sizer: byId('sizer-' + suffix),
		};
	};

	const status = byId('status');
	const host: IParadisDocxDiffWebviewHost = {
		docx: globals.docx,
		hasZip: !!globals.JSZip,
		panes: { original: buildPane('original'), modified: buildPane('modified') },
		post: (message: unknown) => api.postMessage(message),
		onMessage: (handler: (message: ParadisDocxHostMessage) => void) =>
			window.addEventListener('message', event => handler(event.data)),
		onScroll: (side: ParadisDocxSide, handler: () => void) =>
			byId('pane-' + side).addEventListener('scroll', handler),
		setStatus: (text: string | undefined) => {
			if (text) {
				status.textContent = text;
				status.style.display = '';
			} else {
				status.style.display = 'none';
			}
		},
		setShowFormatChanges: (enabled: boolean) => window.document.body.classList.toggle('paradis-hide-format', !enabled),
		setTimeout: (handler: () => void, delay: number) => window.setTimeout(handler, delay),
		clearTimeout: (handle: number) => window.clearTimeout(handle),
	};
	main(ctx, host);

	/* eslint-enable no-restricted-globals, no-restricted-syntax */
}

/** webview に渡す定数を組み立てる。 */
export function buildParadisDocxDiffContext(labelLoading: string): IParadisDocxDiffWebviewContext {
	return {
		attrDiff: PARADIS_DOCX_DIFF_ATTR,
		attrChange: PARADIS_DOCX_CHANGE_ATTR,
		attrSeg: PARADIS_DOCX_SEG_ATTR,
		attrDetail: PARADIS_DOCX_DETAIL_ATTR,
		attrGhost: PARADIS_DOCX_GHOST_ATTR,
		runFormatKeys: PARADIS_DOCX_RUN_FORMAT_KEYS,
		blockFormatKeys: PARADIS_DOCX_BLOCK_FORMAT_KEYS,
		verticalAlignKey: PARADIS_DOCX_VERTICAL_ALIGN_KEY,
		charStyleKey: PARADIS_DOCX_CHAR_STYLE_KEY,
		objectChar: PARADIS_DOCX_OBJECT_CHAR,
		maxBlocks: PARADIS_DOCX_MAX_BLOCKS,
		labelLoading,
		errorLibraryMissing: PARADIS_DOCX_ERROR_LIBRARY_MISSING,
	};
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 差分ビューアの webview HTML を組み立てる。 */
export function buildParadisDocxDiffHtml(labels: { original: string; modified: string; loading: string }, libBaseOverride?: string): string {
	const nonce = generateUuid();
	// 同梱ライブラリの置き場。ローカルサーバから配れる場合はそちらを使う（service worker を
	// 使わずに済み、60秒待ちの経路に入らない）。渡されなければ従来どおり webview リソース。
	const libBase = libBaseOverride ?? asWebviewUri(FileAccess.asFileUri(DOCX_MEDIA_ROOT)).toString(true);
	// CSP は実際に使うポートまで絞る（`http://127.0.0.1:*` だと他プロセスのサーバまで許してしまう）。
	const serverOrigin = paradisPreviewOrigins(libBase);
	const csp = serverOrigin
		? buildParadisOfficeWordCsp(nonce, { kind: 'mountedLoopback', origins: serverOrigin.split(' ') })
		: buildParadisOfficeWordCsp(nonce, { kind: 'webviewResource', cspSources: [paradisOfficeWebviewResourceOrigin(libBase)] });
	const context = JSON.stringify(buildParadisDocxDiffContext(labels.loading));

	// CSP の style-src について: docx-preview は文書ごとの CSS を nonce 無しの動的 <style> として
	// 注入する。style-src に nonce を1つでも書くと 'unsafe-inline' が無視される（CSP の後方互換
	// ルール）ため、書式が丸ごと効かなくなる。ここでは nonce を使わず 'unsafe-inline' のみにする
	// （通常ビューア paradisDocxFileEditor.ts と同じ理由・同じ対処）。
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<style>
		*, *::before, *::after { box-sizing: border-box; }
		html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
		body {
			background-color: var(--vscode-editor-background);
			color: var(--vscode-foreground);
			font-family: var(--vscode-font-family);
			font-size: 13px;
		}
		#panes { display: flex; height: 100%; }
		.pane-wrap { position: relative; flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
		.pane-label {
			flex: 0 0 auto;
			padding: 3px 12px;
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			background-color: var(--vscode-sideBarSectionHeader-background, rgba(128, 128, 128, .12));
			border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.pane { flex: 1 1 auto; overflow: auto; }
		.pane-sizer { overflow: hidden; }
		.pane-zoom { transform-origin: top left; width: fit-content; min-width: 100%; }
		#separator { width: 1px; flex: 0 0 auto; background-color: var(--vscode-editorWidget-border, #454545); }
		#status { position: absolute; top: 45%; width: 100%; text-align: center; opacity: .75; pointer-events: none; }

		/* docx-preview が作る用紙。差分では連続フローで描くので、影と余白だけ整える。 */
		.docx-l-wrapper, .docx-r-wrapper { background: transparent; padding: 16px 8px 48px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
		.docx-l-wrapper > section, .docx-r-wrapper > section {
			background: #fff;
			color: #000;
			box-shadow: 0 1px 4px rgba(0, 0, 0, .35);
			margin: 0;
			position: relative;
		}
		.pane table td, .pane table th { overflow-wrap: break-word; }

		/*
		 * 差分の印。Word 由来のインライン style（背景色など）に負けないよう !important を使う。
		 * 色の語彙は Excel 差分（paradisSpreadsheet.css）と揃えてある。
		 */
		[${PARADIS_DOCX_DIFF_ATTR}] { border-radius: 3px; }
		[${PARADIS_DOCX_DIFF_ATTR}="added"] { background-color: rgba(34, 197, 94, .14) !important; box-shadow: inset 0 0 0 1.5px #22c55e; }
		[${PARADIS_DOCX_DIFF_ATTR}="removed"] { background-color: rgba(239, 68, 68, .14) !important; box-shadow: inset 0 0 0 1.5px #ef4444; }
		[${PARADIS_DOCX_DIFF_ATTR}="modified"] { background-color: rgba(59, 130, 246, .12) !important; box-shadow: inset 0 0 0 1.5px #3b82f6; }
		[${PARADIS_DOCX_DIFF_ATTR}="moved"] { background-color: rgba(168, 85, 247, .12) !important; box-shadow: inset 0 0 0 1.5px #a855f7; }
		[${PARADIS_DOCX_DIFF_ATTR}="formatChanged"] { background-color: rgba(59, 130, 246, .07) !important; box-shadow: inset 0 0 0 1px #3b82f6; }

		/*
		 * text-decoration にも !important が要る。docx-preview は w:u / w:strike を
		 * インライン style の text-decoration に書くので、付いていないと
		 * 「下線・取り消し線の変更」という最も多いケースでこそ波線が出ない。
		 */
		[${PARADIS_DOCX_SEG_ATTR}="added"] { background-color: rgba(34, 197, 94, .35) !important; border-radius: 2px; }
		[${PARADIS_DOCX_SEG_ATTR}="removed"] { background-color: rgba(239, 68, 68, .30) !important; border-radius: 2px; text-decoration: line-through !important; }
		[${PARADIS_DOCX_SEG_ATTR}="format"] { text-decoration: underline wavy #3b82f6 !important; text-underline-offset: 3px; cursor: help; }
		body.paradis-hide-format [${PARADIS_DOCX_SEG_ATTR}="format"] { text-decoration: none !important; cursor: auto; }
		body.paradis-hide-format [${PARADIS_DOCX_DIFF_ATTR}="formatChanged"] { background-color: transparent !important; box-shadow: none; }

		/* ゴースト（相手側にしかない段落の写し）。中身を読ませるためではなく、縦位置を保つのが目的。 */
		[${PARADIS_DOCX_GHOST_ATTR}] {
			border: 1.5px dashed #6b7280;
			border-radius: 3px;
			color: #8a8f98 !important;
			font-style: italic;
			padding: 2px 6px;
			background: repeating-linear-gradient(-45deg, rgba(107, 114, 128, .06), rgba(107, 114, 128, .06) 6px, transparent 6px, transparent 12px);
		}
		[${PARADIS_DOCX_GHOST_ATTR}="added"] { border-color: rgba(34, 197, 94, .55); }
		[${PARADIS_DOCX_GHOST_ATTR}="removed"] { border-color: rgba(239, 68, 68, .55); }
		[${PARADIS_DOCX_GHOST_ATTR}="moved"] { border-color: rgba(168, 85, 247, .55); }

		.paradis-current { outline: 2px solid #f59e0b !important; outline-offset: 1px; }
		.paradis-pulse { animation: paradis-docx-pulse 1.1s ease-out 1; }
		@keyframes paradis-docx-pulse {
			0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, .6); }
			70% { box-shadow: 0 0 0 10px rgba(245, 158, 11, 0); }
			100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
		}
	</style>
</head>
<body>
	<div id="panes">
		<div class="pane-wrap">
			<div class="pane-label">${escapeHtml(labels.original)}</div>
			<div class="pane" id="pane-original"><div class="pane-sizer" id="sizer-original"><div class="pane-zoom" id="zoom-original"><div id="doc-original"></div></div></div></div>
		</div>
		<div id="separator"></div>
		<div class="pane-wrap">
			<div class="pane-label">${escapeHtml(labels.modified)}</div>
			<div class="pane" id="pane-modified"><div class="pane-sizer" id="sizer-modified"><div class="pane-zoom" id="zoom-modified"><div id="doc-modified"></div></div></div></div>
		</div>
	</div>
	<div id="status">${escapeHtml(labels.loading)}</div>
	<div id="style-original" style="display:none"></div>
	<div id="style-modified" style="display:none"></div>
	<script nonce="${nonce}" src="${libBase}/jszip.min.js"></script>
	<script nonce="${nonce}" src="${libBase}/docx-preview.min.js"></script>
	<script nonce="${nonce}">(${paradisDocxDiffWebviewBoot.toString()})(${context}, ${paradisDocxDiffWebviewMain.toString()});</script>
</body>
</html>`;
}
