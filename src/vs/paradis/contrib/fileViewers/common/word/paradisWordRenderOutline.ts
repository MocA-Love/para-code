/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 詳しい解析の結果（意味モデル）と、docx-preview が描いた表示（DOM）を結び付けるための材料。
//
// 解析器は表示の DOM を知らず、docx-preview は意味モデルを知らない。そこで、両側から「文書パーツごとの
// 段落の並びと、その文字」を取り出し、文字の並びで対応を取る（paragraph alignment）。表示側は
// docx-preview の解析結果（AST）の段落に `${文書パーツの鍵}#${番号}` の目印を付けて描かせ、その段落の
// 文字を報告する（paradisWordAnchorRuntime.ts）。こちらは意味モデルから同じ鍵の段落の並びを作る。
//
// 段落の中の要素（フィールド・コンテンツコントロール・変更履歴・コメント・リンク・画像・脚注の参照）は、
// 段落の文字のうち空白を除いた文字の位置（compact offset）で表す。表示側も同じ数え方で位置を探す。

import { LcsDiff, type IDiffChange, type ISequence } from '../../../../../base/common/diff/diff.js';
import type { ParadisWordDocument, ParadisWordNode, ParadisWordStory } from './paradisWordSemantic.js';

/** 段落の中の 1 つの要素。吹き出しに出す行（[項目名, 値]）を持つ。値は文字列だけ。 */
export interface IParadisWordInlineMark {
	readonly kind: 'field' | 'contentControl' | 'revision' | 'comment' | 'hyperlink' | 'image' | 'noteReference' | 'textbox';
	/** 段落の文字（空白を除く）での開始位置と終了位置。文字を持たない要素は start === end。 */
	readonly start: number;
	readonly end: number;
	/** 文字を持たない要素（画像・脚注の参照・削除）を、段落の中で同じ種類の何番目かで探すための番号。 */
	readonly ordinal?: number;
	readonly rows: readonly (readonly [string, string])[];
}

export interface IParadisWordParagraphOutline {
	/** 意味モデルの段落の位置（`story:…/node:…`）。 */
	readonly locator: string;
	/** 「変更後」の表示で見える文字（削除された文字を含まない）。 */
	readonly text: string;
	readonly marks: readonly IParadisWordInlineMark[];
}

export interface IParadisWordStoryOutline {
	/** 表示側と共通の文書パーツの鍵（`b`・`p:word/header1.xml`・`fn:1`・`t:word/document.xml:0` など）。 */
	readonly key: string;
	readonly locator: string;
	readonly paragraphs: readonly IParadisWordParagraphOutline[];
}

export interface IParadisWordRenderOutline {
	readonly stories: readonly IParadisWordStoryOutline[];
	readonly truncated: boolean;
}

export interface ParadisWordOutlineLimits {
	readonly paragraphs: number;
	readonly characters: number;
	readonly marks: number;
	readonly rowCharacters: number;
}

export const PARADIS_WORD_OUTLINE_LIMITS: ParadisWordOutlineLimits = Object.freeze({
	paragraphs: 50_000,
	characters: 8 * 1024 * 1024,
	marks: 20_000,
	rowCharacters: 300,
});

const whitespace = /\s/;

/** 空白を除いた文字の数（UTF-16 の単位）。表示側の数え方と同じ。 */
export function compactParadisWordLength(text: string): number {
	let length = 0;
	for (let index = 0; index < text.length; index++) {
		if (!whitespace.test(text[index])) {
			length++;
		}
	}
	return length;
}

/** 空白を除いた文字列。段落どうしを比べるときの鍵。 */
export function compactParadisWordText(text: string): string {
	return text.replace(/\s+/g, '');
}

function partPath(partUri: string): string {
	return partUri.startsWith('/') ? partUri.slice(1) : partUri;
}

/**
 * 表示側と共通の文書パーツの鍵。表示されない文書パーツ（コメント・定型句、DrawingML だけのテキストボックス）は undefined。
 * docx-preview は `mc:AlternateContent` の Fallback（VML）を描くので、テキストボックスは VML のものだけに鍵を付ける。
 */
function storyKeys(stories: readonly ParadisWordStory[]): ReadonlyMap<ParadisWordStory, string> {
	const result = new Map<ParadisWordStory, string>();
	const textboxCounts = new Map<string, number>();
	for (const story of stories) {
		const address = story.address;
		switch (address.kind) {
			case 'body':
				if (address.ordinal === 0) {
					result.set(story, 'b');
				}
				break;
			case 'header':
			case 'footer':
				result.set(story, `p:${partPath(address.partUri)}`);
				break;
			case 'footnote':
			case 'endnote':
				if (address.noteId !== undefined) {
					result.set(story, `${address.kind === 'footnote' ? 'fn' : 'en'}:${address.noteId}`);
				}
				break;
			case 'textbox': {
				if (address.textboxGeometry?.container !== 'vmlShape') {
					break;
				}
				const path = partPath(address.partUri);
				const index = textboxCounts.get(path) ?? 0;
				textboxCounts.set(path, index + 1);
				result.set(story, `t:${path}:${index}`);
				break;
			}
		}
	}
	return result;
}

function bounded(value: string, limit: number): string {
	const normalized = value.replace(/\s+/g, ' ').trim();
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

interface ParagraphState {
	readonly pieces: string[];
	compact: number;
	readonly marks: IParadisWordInlineMark[];
	readonly ordinals: Map<string, number>;
	readonly openComments: Map<string, number>;
}

class OutlineBuilder {
	readonly stories: IParadisWordStoryOutline[] = [];
	truncated = false;
	private paragraphs = 0;
	private characters = 0;
	private marks = 0;
	private readonly comments = new Map<string, ParadisWordStory>();
	private readonly notes = new Map<string, ParadisWordStory>();

	constructor(document: ParadisWordDocument, private readonly limits: ParadisWordOutlineLimits, private readonly checkpoint: () => void) {
		for (const story of document.stories) {
			if (story.address.kind === 'comment' && story.address.commentId !== undefined) {
				this.comments.set(story.address.commentId, story);
			} else if ((story.address.kind === 'footnote' || story.address.kind === 'endnote') && story.address.noteId !== undefined) {
				this.notes.set(`${story.address.kind}:${story.address.noteId}`, story);
			}
		}
	}

	private row(name: string, value: string | boolean | undefined): readonly [string, string] | undefined {
		return value === undefined || value === '' ? undefined : [name, bounded(String(value), this.limits.rowCharacters)];
	}

	private rows(...rows: (readonly [string, string] | undefined)[]): readonly (readonly [string, string])[] {
		return rows.filter((row): row is readonly [string, string] => !!row);
	}

	visitStory(story: ParadisWordStory, key: string): void {
		const locator = `story:${story.address.kind}:${story.address.partUri}:${story.address.noteId ?? story.address.commentId ?? story.address.ordinal}`;
		const paragraphs: IParadisWordParagraphOutline[] = [];
		const storyMark = story.address.kind === 'textbox' ? this.rows(
			['kind', 'story'], ['storyKind', 'textbox'],
			this.row('textboxGeometry.container', story.address.textboxGeometry?.container),
			this.row('shapeId', story.address.textboxGeometry?.shapeId),
		) : undefined;
		const visitBlock = (node: ParadisWordNode, blockRows: readonly (readonly [string, string])[] | undefined): void => {
			this.checkpoint();
			if (this.truncated) {
				return;
			}
			if (node.kind === 'paragraph') {
				const outline = this.paragraph(node, `${locator}/node:${node.id}`, blockRows ?? storyMark);
				if (outline) {
					paragraphs.push(outline);
				}
				return;
			}
			const rows = node.kind === 'contentControl' ? this.contentControlRows(node) : blockRows;
			for (const child of node.children ?? []) {
				visitBlock(child, rows);
			}
		};
		for (const node of story.nodes) {
			visitBlock(node, undefined);
		}
		this.stories.push({ key, locator, paragraphs });
	}

	private contentControlRows(node: Extract<ParadisWordNode, { readonly kind: 'contentControl' }>): readonly (readonly [string, string])[] {
		return this.rows(['kind', 'contentControl'], this.row('alias', node.alias), this.row('tag', node.tag), this.row('lock', node.lock));
	}

	private paragraph(node: Extract<ParadisWordNode, { readonly kind: 'paragraph' }>, locator: string, blockRows: readonly (readonly [string, string])[] | undefined): IParadisWordParagraphOutline | undefined {
		if (this.paragraphs >= this.limits.paragraphs) {
			this.truncated = true;
			return undefined;
		}
		const state: ParagraphState = { pieces: [], compact: 0, marks: [], ordinals: new Map(), openComments: new Map() };
		for (const child of node.children) {
			this.inline(child, state);
		}
		for (const [commentId, start] of state.openComments) {
			this.addCommentMark(state, commentId, start, state.compact);
		}
		const text = state.pieces.join('');
		this.characters += text.length;
		if (this.characters > this.limits.characters) {
			this.truncated = true;
			return undefined;
		}
		this.paragraphs++;
		// ブロックのコンテンツコントロールとテキストボックスは、段落全体を 1 つの要素として示す。
		const blockKind = blockRows?.[0]?.[1] === 'contentControl' ? 'contentControl' as const : 'textbox' as const;
		const marks = blockRows ? [{ kind: blockKind, start: 0, end: state.compact, rows: blockRows }, ...state.marks] : state.marks;
		this.marks += marks.length;
		if (this.marks > this.limits.marks) {
			this.truncated = true;
			return { locator, text, marks: [] };
		}
		return { locator, text, marks };
	}

	private append(state: ParagraphState, value: string): void {
		state.pieces.push(value);
		state.compact += compactParadisWordLength(value);
	}

	private nextOrdinal(state: ParagraphState, kind: string): number {
		const ordinal = state.ordinals.get(kind) ?? 0;
		state.ordinals.set(kind, ordinal + 1);
		return ordinal;
	}

	private addCommentMark(state: ParagraphState, commentId: string, start: number, end: number): void {
		const comment = this.comments.get(commentId);
		state.marks.push({
			kind: 'comment', start, end,
			rows: this.rows(['kind', 'comment'], ['commentId', commentId], this.row('author', comment?.author), this.row('date', comment?.date), this.row('text', comment?.text)),
		});
	}

	private inline(node: ParadisWordNode, state: ParagraphState): void {
		this.checkpoint();
		switch (node.kind) {
			case 'text':
				if (!node.deleted) {
					this.append(state, node.text);
				}
				return;
			case 'tab':
				this.append(state, '\t');
				return;
			case 'break':
				this.append(state, '\n');
				return;
			case 'symbol':
				this.append(state, node.character ?? '');
				return;
			case 'omml':
				this.append(state, node.text);
				return;
			case 'field': {
				const start = state.compact;
				this.append(state, node.savedResult);
				state.marks.push({
					kind: 'field', start, end: state.compact,
					rows: this.rows(['kind', 'field'], ['fieldKind', node.fieldKind], this.row('instruction', node.instruction.trim()), this.row('savedResult', node.savedResult), this.row('dirty', node.dirty), this.row('locked', node.locked)),
				});
				return;
			}
			case 'revision': {
				const rows = this.rows(['kind', 'revision'], ['revisionKind', node.revisionKind], this.row('revisionId', node.revisionId), this.row('author', node.author), this.row('date', node.date));
				if (node.revisionKind === 'deleted' || node.revisionKind === 'moveFrom') {
					// 「変更後」の表示には出ない。変更履歴付きの表示で、段落の中の何番目の削除かで探す。
					state.marks.push({ kind: 'revision', start: state.compact, end: state.compact, ordinal: this.nextOrdinal(state, 'deleted'), rows });
					return;
				}
				const start = state.compact;
				const ordinal = node.revisionKind === 'propertyChange' ? undefined : this.nextOrdinal(state, 'inserted');
				for (const child of node.children) {
					this.inline(child, state);
				}
				state.marks.push({ kind: 'revision', start, end: state.compact, ...(ordinal !== undefined ? { ordinal } : {}), rows });
				return;
			}
			case 'contentControl': {
				const start = state.compact;
				for (const child of node.children) {
					this.inline(child, state);
				}
				state.marks.push({ kind: 'contentControl', start, end: state.compact, rows: this.contentControlRows(node) });
				return;
			}
			case 'hyperlink': {
				const start = state.compact;
				for (const child of node.children) {
					this.inline(child, state);
				}
				state.marks.push({
					kind: 'hyperlink', start, end: state.compact,
					rows: this.rows(['kind', 'hyperlink'], ['external', String(node.external)], this.row('anchorName', node.anchorName)),
				});
				return;
			}
			case 'image':
				state.marks.push({
					kind: 'image', start: state.compact, end: state.compact, ordinal: this.nextOrdinal(state, 'image'),
					rows: this.rows(['kind', 'image'], this.row('targetPartUri', node.targetPartUri), ['external', String(node.external)]),
				});
				return;
			case 'noteReference': {
				const note = this.notes.get(`${node.noteKind}:${node.noteId}`);
				state.marks.push({
					kind: 'noteReference', start: state.compact, end: state.compact, ordinal: this.nextOrdinal(state, 'note'),
					rows: this.rows(['kind', 'noteReference'], ['noteKind', node.noteKind], ['noteId', node.noteId], this.row('text', note?.text)),
				});
				return;
			}
			case 'commentReference':
				if (node.boundary === 'start') {
					state.openComments.set(node.commentId, state.compact);
				} else if (node.boundary === 'end') {
					const start = state.openComments.get(node.commentId);
					state.openComments.delete(node.commentId);
					this.addCommentMark(state, node.commentId, start ?? 0, state.compact);
				}
				return;
			default:
				for (const child of node.children ?? []) {
					this.inline(child, state);
				}
		}
	}
}

/**
 * 意味モデルから、表示に出る文書パーツごとの段落の並び（と段落の中の要素）を作る。
 * コメントは本文に描かれないので段落の並びには入れず、コメントが付いた範囲の吹き出しに本文を入れる。
 */
export function buildParadisWordRenderOutline(
	document: ParadisWordDocument,
	options: { readonly limits?: ParadisWordOutlineLimits; readonly checkpoint?: () => void } = {},
): IParadisWordRenderOutline {
	const builder = new OutlineBuilder(document, options.limits ?? PARADIS_WORD_OUTLINE_LIMITS, options.checkpoint ?? (() => { }));
	const keys = storyKeys(document.stories);
	for (const story of document.stories) {
		const key = keys.get(story);
		if (key) {
			builder.visitStory(story, key);
		}
	}
	return { stories: builder.stories, truncated: builder.truncated };
}

class StringSequence implements ISequence {
	constructor(private readonly values: readonly string[]) { }
	getElements(): string[] {
		return [...this.values];
	}
}

/**
 * 意味モデルの段落と、表示の段落（目印 `${鍵}#${番号}` と、その文字）を対応づける。戻り値は段落の位置 → 目印。
 *
 * 文書パーツごとに、空白を除いた文字の並びで最長共通部分列を取る（同じ文字の段落が何度も出ても順に対応する）。
 * 文字で対応しなかった区間は、両側の段落の数が同じときだけ順に対応させる（フィールドの結果や記号の
 * 描き方の違いで文字がずれる段落を拾うため）。数が違う区間は対応させない（取り違えより、移動できないほうを選ぶ）。
 */
export function alignParadisWordParagraphs(outline: IParadisWordRenderOutline, rendered: Readonly<Record<string, readonly string[]>>): Map<string, string> {
	const result = new Map<string, string>();
	for (const story of outline.stories) {
		const domTexts = rendered[story.key];
		if (!Array.isArray(domTexts) || domTexts.length === 0 || story.paragraphs.length === 0) {
			continue;
		}
		const semanticTexts = story.paragraphs.map(paragraph => compactParadisWordText(paragraph.text));
		const domKeys = domTexts.map(text => compactParadisWordText(String(text)));
		const changes: readonly IDiffChange[] = new LcsDiff(new StringSequence(semanticTexts), new StringSequence(domKeys)).ComputeDiff(false).changes;
		const pair = (semanticIndex: number, domIndex: number) => result.set(story.paragraphs[semanticIndex].locator, `${story.key}#${domIndex}`);
		let semanticIndex = 0;
		let domIndex = 0;
		const fillGap = (semanticEnd: number, domEnd: number) => {
			if (semanticEnd - semanticIndex === domEnd - domIndex) {
				for (; semanticIndex < semanticEnd; semanticIndex++, domIndex++) {
					pair(semanticIndex, domIndex);
				}
			}
			semanticIndex = semanticEnd;
			domIndex = domEnd;
		};
		for (const change of changes) {
			for (; semanticIndex < change.originalStart && domIndex < change.modifiedStart; semanticIndex++, domIndex++) {
				pair(semanticIndex, domIndex);
			}
			fillGap(change.originalStart + change.originalLength, change.modifiedStart + change.modifiedLength);
		}
		for (; semanticIndex < semanticTexts.length && domIndex < domKeys.length; semanticIndex++, domIndex++) {
			pair(semanticIndex, domIndex);
		}
	}
	return result;
}

/**
 * 節点 → その節点を含む段落の位置。表や文書パーツのように段落を含む側の節点は、中の最初の段落を指す。
 * 比較の変更（節点の ID しか持たない）を、表示の中の段落へ移すために使う。
 */
export function indexParadisWordParagraphs(document: ParadisWordDocument): Map<string, string> {
	const result = new Map<string, string>();
	for (const story of document.stories) {
		const locator = `story:${story.address.kind}:${story.address.partUri}:${story.address.noteId ?? story.address.commentId ?? story.address.ordinal}`;
		const ancestors: string[] = [story.id];
		const visit = (node: ParadisWordNode, paragraph: string | undefined): void => {
			let current = paragraph;
			if (node.kind === 'paragraph' && !paragraph) {
				current = `${locator}/node:${node.id}`;
				for (const ancestor of ancestors) {
					if (!result.has(ancestor)) {
						result.set(ancestor, current);
					}
				}
			}
			if (current) {
				result.set(node.id, current);
			} else {
				ancestors.push(node.id);
			}
			for (const child of node.children ?? []) {
				visit(child, current);
			}
			if (!current) {
				ancestors.pop();
			}
		};
		for (const node of story.nodes) {
			visit(node, undefined);
		}
	}
	return result;
}
