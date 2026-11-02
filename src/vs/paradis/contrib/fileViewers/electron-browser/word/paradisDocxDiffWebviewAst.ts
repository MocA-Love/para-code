/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word 差分の webview の中で、docx-preview の AST から概要を取り出し、差分の目印とゴーストを書き込む部分。
// webview の本体（paradisDocxDiffWebviewMain）と同じく `.toString()` で HTML に埋めて webview の中で動く。
// **この関数の中から外側の識別子を参照してはいけない**（型は消えるので使ってよい）。本体へは名前ではなく、
// ブートストラップ（paradisDocxDiffWebviewBoot）が呼んだ結果を引数で渡す。

import type {
	IParadisDocxAnnotation,
	IParadisDocxBlock,
	IParadisDocxFiller,
	IParadisDocxOutline,
	IParadisDocxRun,
	IParadisDocxSegment,
} from '../../common/paradisDocx.js';
import type { IParadisDocxAstDocument, IParadisDocxAstNode, IParadisDocxDiffWebviewContext } from '../paradisDocxDiffWebview.js';

/** 抽出した1ブロックの、AST 側の参照。注釈を戻すときに使う。 */
export interface IParadisDocxDiffBlockRef {
	readonly node: IParadisDocxAstNode;
	/** ゴーストを差し込む位置決めに使う、本文直下の祖先（段落自身、または外側の表）。 */
	readonly topLevel: IParadisDocxAstNode;
	/** ブロック内の run ノードを、概要の runs と同じ並びで持つ。 */
	readonly runs: { readonly node: IParadisDocxAstNode; readonly parent: IParadisDocxAstNode }[];
}

export interface IParadisDocxDiffLoadedDocument {
	readonly wordDocument: IParadisDocxAstDocument;
	readonly refs: IParadisDocxDiffBlockRef[];
	readonly outline: IParadisDocxOutline;
}

type Rels = { id: string; target: string }[] | undefined;

/** {@link paradisDocxDiffAstHelpers} が返す関数（webview の本体が使うもの）。 */
export interface IParadisDocxDiffAstHelpers {
	readonly extractOutline: (wordDocument: IParadisDocxAstDocument) => { outline: IParadisDocxOutline; refs: IParadisDocxDiffBlockRef[] };
	readonly applyAnnotations: (loaded: IParadisDocxDiffLoadedDocument, annotations: readonly IParadisDocxAnnotation[]) => void;
	readonly insertFillers: (loaded: IParadisDocxDiffLoadedDocument, fillers: readonly IParadisDocxFiller[]) => void;
}

/** AST を読み書きする関数をまとめて作る。`ctx` は webview の本体と同じもの。 */
export function paradisDocxDiffAstHelpers(ctx: IParadisDocxDiffWebviewContext): IParadisDocxDiffAstHelpers {

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

	function extractOutline(wordDocument: IParadisDocxAstDocument): { outline: IParadisDocxOutline; refs: IParadisDocxDiffBlockRef[] } {
		const blocks: IParadisDocxBlock[] = [];
		const refs: IParadisDocxDiffBlockRef[] = [];
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

	function applyAnnotations(loaded: IParadisDocxDiffLoadedDocument, annotations: readonly IParadisDocxAnnotation[]): void {
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

	function insertFillers(loaded: IParadisDocxDiffLoadedDocument, fillers: readonly IParadisDocxFiller[]): void {
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

	return { extractOutline, applyAnnotations, insertFillers };
}
