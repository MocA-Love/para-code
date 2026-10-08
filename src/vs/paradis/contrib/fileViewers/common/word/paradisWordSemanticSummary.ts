/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word の詳しい解析（parseWordSemantic）の結果を、IPC で renderer へ渡せる小さな形にまとめる。
// 解析器の木はそのまま渡さない（大きく、関係 ID や部品の中身まで持っているため）。renderer が使うのは
// リボンの実数、変更点パネルに並べる文書内の変更履歴とコメント、検索の索引、比較の変更一覧だけ。

import type { ParadisOfficePackageError } from '../office/paradisOfficeArchive.js';
import type {
	ParadisOfficeChange,
	ParadisOfficeChangeValue,
	ParadisOfficeCompletenessManifest,
	ParadisOfficeInventory,
	ParadisOfficeOutcome,
} from '../paradisOfficeProtocol.js';
import type { ParadisOfficeSearchField, ParadisOfficeSearchItem } from '../paradisOfficeSearch.js';
import type { ParadisWordDocument, ParadisWordNode, ParadisWordStory, ParadisWordStoryKind } from './paradisWordSemantic.js';

/** shared process の Word 解析チャネル名。 */
export const PARADIS_WORD_SEMANTIC_CHANNEL = 'paradisWordSemantic';

export type ParadisWordSemanticFormat = 'docx' | 'docm' | 'dotx' | 'dotm';

/** 失敗の理由。パッケージの不備はサニタイズ済みのコードだけを返し、中身やパスは返さない。 */
export type ParadisWordSemanticFailureCode = ParadisOfficePackageError['code'] | 'unsupported' | 'tooLarge' | 'failed';

/** 未知の要素を、表示に関係しないもの（ignorable）と、描くべきなのに描けていないもの（unrendered）に分ける。 */
export type ParadisWordUnknownElementDisposition = 'ignorable' | 'unrendered';

export interface IParadisWordUnknownElementSummary {
	/** 要素のローカル名（例: `proofErr`）。文書の中身は含まない。 */
	readonly name: string;
	readonly count: number;
	readonly disposition: ParadisWordUnknownElementDisposition;
}

export interface IParadisWordAnalysisCounts {
	readonly format: ParadisWordSemanticFormat;
	readonly parts: { readonly expected: number; readonly visited: number; readonly parsed: number; readonly inPackage: number };
	readonly nodes: number;
	/** 要素の種類ごとの数（`paragraph`・`table` など）。 */
	readonly nodeKinds: Readonly<Record<string, number>>;
	/** 文書パーツ（本文・ヘッダー・脚注など）の種類ごとの数。 */
	readonly storyKinds: Readonly<Record<string, number>>;
	/** 未知の要素の多いものから最大 PARADIS_WORD_UNKNOWN_ELEMENT_LIMIT 種。残りは unknownElementsOther にまとめる。 */
	readonly unknownElements: readonly IParadisWordUnknownElementSummary[];
	readonly unknownElementsOther: { readonly kinds: number; readonly count: number; readonly unrendered: number };
	readonly unresolvedRelationships: number;
	readonly externalRelationships: number;
}

export interface IParadisWordAnalysisTimings {
	readonly inspectMs: number;
	readonly parseMs: number;
	readonly summarizeMs: number;
}

/** 1 つの文書を解析した結果。 */
export interface IParadisWordAnalysis {
	readonly ok: true;
	readonly counts: IParadisWordAnalysisCounts;
	/** 文書の中にある変更履歴とコメント。変更点パネルに「変更」として並べる。 */
	readonly changes: readonly ParadisOfficeChange[];
	readonly changesTruncated: boolean;
	/** 検索の索引（段落ごと）。本文・テキストボックス・脚注・コメント・ヘッダー・フッターをまたぐ。 */
	readonly searchItems: readonly ParadisOfficeSearchItem[];
	readonly searchTruncated: boolean;
	readonly timings: IParadisWordAnalysisTimings;
}

export interface IParadisWordSemanticFailure {
	readonly ok: false;
	readonly code: ParadisWordSemanticFailureCode;
}

export type IParadisWordAnalysisResult = IParadisWordAnalysis | IParadisWordSemanticFailure;

/** 2 つの版を意味モデルで比べた結果。 */
export interface IParadisWordComparison {
	readonly ok: true;
	readonly changes: readonly ParadisOfficeChange[];
	readonly completeness: ParadisOfficeCompletenessManifest;
	readonly outcome: ParadisOfficeOutcome;
	readonly noChanges: boolean;
	/** 変更が多くて途中で切ったか。 */
	readonly truncated: boolean;
	readonly original: IParadisWordAnalysisCounts;
	readonly modified: IParadisWordAnalysisCounts;
	/** 比較のときに作れなかった補助モデル（スタイル・セキュリティなど）。その種類の変更は出ない。 */
	readonly omittedModels: readonly string[];
	/** マクロ・埋め込みなどの部品の形が正しくなく、セキュリティの解析が「安全に読めない」と判断した。 */
	readonly securityUnreadable: boolean;
	readonly timings: { readonly parseMs: number; readonly compareMs: number };
}

export type IParadisWordComparisonResult = IParadisWordComparison | IParadisWordSemanticFailure;

/** renderer → shared process の口。 */
export interface IParadisWordSemanticService {
	analyze(bytes: Uint8Array): Promise<IParadisWordAnalysisResult>;
	compare(original: Uint8Array, modified: Uint8Array): Promise<IParadisWordComparisonResult>;
}

const officeDocumentRelationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const strictOfficeDocumentRelationship = 'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument';
const wordMainContentTypes: Readonly<Record<string, ParadisWordSemanticFormat>> = {
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml': 'docx',
	'application/vnd.ms-word.document.macroEnabled.main+xml': 'docm',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml': 'dotx',
	'application/vnd.ms-word.template.macroEnabledTemplate.main+xml': 'dotm',
};

/**
 * 部品一覧から Word の形式を決め、解析器へ渡す inventory を作る。Word の本文が 1 つに決まらなければ undefined。
 * inventory を調べる関数は形式を知らないので、本文の content type から決める（Web 版の Worker と同じ規則）。
 */
export function resolveParadisWordInventory<T extends ParadisOfficeInventory>(inventory: T): (T & { readonly format: ParadisWordSemanticFormat }) | undefined {
	const mainPart = findParadisOfficeMainDocumentPart(inventory);
	const format = mainPart ? wordMainContentTypes[mainPart.contentType] : undefined;
	return format ? { ...inventory, format } : undefined;
}

/**
 * パッケージの本文の部品（`_rels/.rels` の officeDocument が指す 1 つの部品）。1 つに決まらなければ undefined。
 * Word・Excel の形式の判定（デスクトップの解析と Web 版の Worker）で共通に使う。
 */
export function findParadisOfficeMainDocumentPart(inventory: ParadisOfficeInventory): ParadisOfficeInventory['parts'][number] | undefined {
	const roots = inventory.relationships.filter(relationship => relationship.sourcePartId === undefined
		&& (relationship.type === officeDocumentRelationship || relationship.type === strictOfficeDocumentRelationship)
		&& relationship.targetMode === 'internal'
		&& !relationship.missing);
	return roots.length === 1 ? inventory.parts.find(part => part.canonicalUri === roots[0].target) : undefined;
}

/**
 * 表示に関係しない、または docx-preview が別の手段で扱うので描けなくても困らない要素。
 * それ以外の未知の要素は「描くべきなのに描けていない」側に数える（数え漏れより数えすぎを選ぶ）。
 */
const ignorableUnknownElements: ReadonlySet<string> = new Set([
	'proofErr', 'lastRenderedPageBreak', 'annotationRef', 'separator', 'continuationSeparator', 'continuationNotice',
	'permStart', 'permEnd', 'bookmarkStart', 'bookmarkEnd', 'footnoteRef', 'endnoteRef', 'noBreakHyphen', 'softHyphen',
	'customXmlInsRangeStart', 'customXmlInsRangeEnd', 'customXmlDelRangeStart', 'customXmlDelRangeEnd',
	'customXmlMoveFromRangeStart', 'customXmlMoveFromRangeEnd', 'customXmlMoveToRangeStart', 'customXmlMoveToRangeEnd',
	'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd', 'dayShort', 'dayLong', 'monthShort', 'monthLong', 'yearShort', 'yearLong',
	'pgNum', 'cr', 'rPr', 'pPr', 'sectPr', 'tblPr', 'trPr', 'tcPr', 'sdtPr', 'sdtEndPr', 'bidi',
]);

export function classifyParadisWordUnknownElement(name: string): ParadisWordUnknownElementDisposition {
	return ignorableUnknownElements.has(name) ? 'ignorable' : 'unrendered';
}

export interface ParadisWordSummaryLimits {
	readonly changes: number;
	readonly changeTextCharacters: number;
	readonly searchItems: number;
	readonly searchCharacters: number;
}

export const PARADIS_WORD_SUMMARY_LIMITS: ParadisWordSummaryLimits = Object.freeze({
	changes: 2_000,
	changeTextCharacters: 400,
	searchItems: 50_000,
	searchCharacters: 8 * 1024 * 1024,
});

/** 文書パーツの位置。比較（compareWordSemantics）の locator と同じ形にそろえる。 */
export function paradisWordStoryLocator(story: ParadisWordStory): string {
	return `story:${story.address.kind}:${story.address.partUri}:${story.address.noteId ?? story.address.commentId ?? story.address.ordinal}`;
}

interface MutableCounts {
	readonly nodeKinds: Map<string, number>;
	readonly unknown: Map<string, number>;
}

interface StoryContext {
	readonly story: ParadisWordStory;
	readonly locator: string;
	paragraphOrdinal: number;
}

interface ParagraphText {
	readonly visible: string[];
	readonly deleted: string[];
	readonly links: string[];
}

function increment(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

/** 長い文字を limit 文字（UTF-16 の単位）以内に切り、省略記号を付ける。サロゲートペアの途中では切らない。 */
export function truncateParadisWordText(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	let end = Math.max(0, limit - 1);
	const last = text.charCodeAt(end - 1);
	if (end > 0 && last >= 0xd800 && last <= 0xdbff) {
		end--;
	}
	return `${text.slice(0, end)}…`;
}

function excerpt(text: string, limit: number): string {
	return truncateParadisWordText(text.replace(/\s+/g, ' ').trim(), limit);
}

function textValue(text: string, limit: number): ParadisOfficeChangeValue {
	return { kind: 'scalar', valueType: 'text', value: excerpt(text, limit) };
}

/** 段落 1 つの文字。フィールドは保存された結果だけを読む（比較の nodeText と同じ規則）。 */
function collectParagraphText(node: ParadisWordNode, target: ParagraphText, deleted: boolean, inLink: boolean): void {
	switch (node.kind) {
		case 'text': {
			const value = node.text;
			(deleted || node.deleted ? target.deleted : target.visible).push(value);
			if (inLink && !deleted && !node.deleted) {
				target.links.push(value);
			}
			return;
		}
		case 'tab': (deleted ? target.deleted : target.visible).push('\t'); return;
		case 'break': (deleted ? target.deleted : target.visible).push(node.breakType === 'page' || node.breakType === 'column' ? ' ' : '\n'); return;
		case 'symbol': (deleted ? target.deleted : target.visible).push(node.character ?? ''); return;
		case 'field': (deleted ? target.deleted : target.visible).push(node.savedResult); return;
		case 'omml': (deleted ? target.deleted : target.visible).push(node.text); return;
		case 'revision': {
			const isDeleted = deleted || node.revisionKind === 'deleted' || node.revisionKind === 'moveFrom';
			for (const child of node.children) {
				collectParagraphText(child, target, isDeleted, inLink);
			}
			return;
		}
		case 'hyperlink':
			for (const child of node.children) {
				collectParagraphText(child, target, deleted, true);
			}
			return;
		default:
			for (const child of node.children ?? []) {
				collectParagraphText(child, target, deleted, inLink);
			}
	}
}

function revisionText(node: ParadisWordNode): string {
	const parts: ParagraphText = { visible: [], deleted: [], links: [] };
	collectParagraphText(node, parts, false, false);
	return parts.visible.join('') || parts.deleted.join('');
}

class WordSummaryBuilder {
	readonly counts: MutableCounts = { nodeKinds: new Map(), unknown: new Map() };
	readonly changes: ParadisOfficeChange[] = [];
	changesTruncated = false;
	readonly searchItems: ParadisOfficeSearchItem[] = [];
	searchTruncated = false;
	private searchCharacters = 0;
	private readonly commentAnchors = new Map<string, string>();

	constructor(private readonly limits: ParadisWordSummaryLimits, private readonly checkpoint: () => void) { }

	visitStory(story: ParadisWordStory): void {
		const context: StoryContext = { story, locator: paradisWordStoryLocator(story), paragraphOrdinal: 0 };
		for (const node of story.nodes) {
			this.visit(context, node, undefined);
		}
	}

	/** 木の深さは XML の深さの上限（128）で抑えられているので、再帰で辿る。 */
	private visit(context: StoryContext, node: ParadisWordNode, paragraphLocator: string | undefined): void {
		this.checkpoint();
		increment(this.counts.nodeKinds, node.kind);
		let currentParagraph = paragraphLocator;
		if (node.kind === 'paragraph' && !paragraphLocator) {
			// 変更履歴やフィールドの中にも段落の形の節点が入るが、文字は外側の段落がまとめて持つ。
			currentParagraph = `${context.locator}/node:${node.id}`;
			this.addParagraph(context, currentParagraph, node);
		} else if (node.kind === 'unknownBlock') {
			increment(this.counts.unknown, node.name.local);
		} else if (node.kind === 'revision' && context.story.address.kind !== 'comment') {
			this.addRevision(context, node, currentParagraph);
		} else if (node.kind === 'commentReference' && node.boundary !== 'end' && currentParagraph && !this.commentAnchors.has(node.commentId)) {
			this.commentAnchors.set(node.commentId, currentParagraph);
		}
		for (const child of node.children ?? []) {
			this.visit(context, child, currentParagraph);
		}
	}

	addComments(stories: readonly ParadisWordStory[]): void {
		for (const story of stories) {
			this.checkpoint();
			if (story.address.kind !== 'comment') {
				continue;
			}
			const commentId = story.address.commentId ?? String(story.address.ordinal);
			const fields: { readonly name: string; readonly value: ParadisOfficeChangeValue }[] = [
				{ name: 'text', value: textValue(story.text, this.limits.changeTextCharacters) },
				...(story.author ? [{ name: 'author', value: textValue(story.author, 256) }] : []),
				...(story.date ? [{ name: 'date', value: textValue(story.date, 64) }] : []),
			];
			const anchor = this.commentAnchors.get(commentId);
			this.pushChange({
				id: `word-comment:${commentId}`,
				category: 'annotation',
				subject: { kind: 'comment.text', locator: paradisWordStoryLocator(story) },
				before: { kind: 'none' },
				after: { kind: 'record', fields },
				certainty: 'exact',
				sourceParts: [story.source.partUri],
				...(anchor ? { navigableAnchor: anchor } : {}),
			});
		}
	}

	private addRevision(context: StoryContext, node: Extract<ParadisWordNode, { readonly kind: 'revision' }>, paragraphLocator: string | undefined): void {
		const text = revisionText(node);
		const fields: { readonly name: string; readonly value: ParadisOfficeChangeValue }[] = [
			{ name: 'revisionKind', value: { kind: 'scalar', valueType: 'text', value: node.revisionKind } },
			...(node.author ? [{ name: 'author', value: textValue(node.author, 256) }] : []),
			...(node.date ? [{ name: 'date', value: textValue(node.date, 64) }] : []),
		];
		const removed = node.revisionKind === 'deleted' || node.revisionKind === 'moveFrom';
		const locator = `${context.locator}/node:${node.id}`;
		this.pushChange({
			id: `word-revision:${node.id}`,
			category: 'revision',
			subject: { kind: `revision.${node.revisionKind}`, locator },
			before: removed ? textValue(text, this.limits.changeTextCharacters) : { kind: 'none' },
			after: removed ? { kind: 'record', fields } : { kind: 'record', fields: [{ name: 'text', value: textValue(text, this.limits.changeTextCharacters) }, ...fields] },
			certainty: 'exact',
			sourceParts: [context.story.source.partUri],
			// 移動先は段落にする。renderer は段落の文字を手がかりに表示の中の位置を探す。
			navigableAnchor: paragraphLocator ?? locator,
		});
	}

	private pushChange(change: ParadisOfficeChange): void {
		if (this.changes.length >= this.limits.changes) {
			this.changesTruncated = true;
			return;
		}
		this.changes.push(change);
	}

	private addParagraph(context: StoryContext, locator: string, node: Extract<ParadisWordNode, { readonly kind: 'paragraph' }>): void {
		const ordinal = context.paragraphOrdinal++;
		if (this.searchTruncated) {
			return;
		}
		const story = context.story;
		const parts: ParagraphText = { visible: [], deleted: [], links: [] };
		for (const child of node.children) {
			collectParagraphText(child, parts, false, false);
		}
		const fields: ParadisOfficeSearchField[] = [];
		const visible = parts.visible.join('');
		const isComment = story.address.kind === 'comment';
		if (visible.trim()) {
			fields.push({ kind: isComment ? 'comment' : 'formatted', text: visible });
		}
		const deleted = parts.deleted.join('');
		if (deleted.trim()) {
			fields.push({ kind: 'hidden', text: deleted });
		}
		if (fields.length === 0) {
			return;
		}
		const characters = visible.length + deleted.length;
		if (this.searchItems.length >= this.limits.searchItems || this.searchCharacters + characters > this.limits.searchCharacters) {
			this.searchTruncated = true;
			return;
		}
		this.searchCharacters += characters;
		this.searchItems.push({
			id: `word-paragraph:${story.id}:${ordinal}`,
			locator,
			locationBadge: { kind: 'story', label: story.address.kind },
			navigableAnchor: locator,
			fields,
		});
	}
}

/**
 * 解析結果を IPC で渡せる要約にする。文書の文字は検索の索引と変更点の抜粋にだけ入る（renderer は
 * その文書を表示しているので、渡しても見えるものは増えない）。
 */
export function summarizeParadisWordDocument(
	document: ParadisWordDocument,
	inventory: ParadisOfficeInventory & { readonly format: ParadisWordSemanticFormat },
	options: { readonly limits?: ParadisWordSummaryLimits; readonly checkpoint?: () => void } = {},
): Omit<IParadisWordAnalysis, 'timings'> {
	const limits = options.limits ?? PARADIS_WORD_SUMMARY_LIMITS;
	const builder = new WordSummaryBuilder(limits, options.checkpoint ?? (() => { }));
	const storyKinds = new Map<string, number>();
	for (const story of document.stories) {
		increment(storyKinds, story.address.kind);
		builder.visitStory(story);
	}
	builder.addComments(document.stories);
	return {
		ok: true,
		counts: {
			format: inventory.format,
			parts: {
				expected: document.completeness.expectedParts,
				visited: document.completeness.visitedParts,
				parsed: document.completeness.parsedParts,
				inPackage: inventory.parts.length,
			},
			nodes: document.completeness.nodes,
			nodeKinds: Object.fromEntries([...builder.counts.nodeKinds].sort((left, right) => left[0].localeCompare(right[0]))),
			storyKinds: Object.fromEntries([...storyKinds].sort((left, right) => storyOrder(left[0]) - storyOrder(right[0]))),
			...unknownElementSummary(builder.counts.unknown),
			unresolvedRelationships: document.completeness.unresolvedRelationships,
			externalRelationships: inventory.relationships.filter(relationship => relationship.targetMode === 'external').length,
		},
		changes: builder.changes,
		changesTruncated: builder.changesTruncated,
		searchItems: builder.searchItems,
		searchTruncated: builder.searchTruncated,
	};
}

/** 吹き出し・一覧に並べる未知の要素の種類の上限。 */
export const PARADIS_WORD_UNKNOWN_ELEMENT_LIMIT = 20;

function unknownElementSummary(unknown: ReadonlyMap<string, number>): Pick<IParadisWordAnalysisCounts, 'unknownElements' | 'unknownElementsOther'> {
	const all = [...unknown]
		.map(([name, count]) => ({ name: truncateParadisWordText(name, 128), count, disposition: classifyParadisWordUnknownElement(name) }))
		.sort((left, right) => (left.disposition === right.disposition ? 0 : left.disposition === 'unrendered' ? -1 : 1) || right.count - left.count || left.name.localeCompare(right.name));
	const rest = all.slice(PARADIS_WORD_UNKNOWN_ELEMENT_LIMIT);
	return {
		unknownElements: all.slice(0, PARADIS_WORD_UNKNOWN_ELEMENT_LIMIT),
		unknownElementsOther: {
			kinds: rest.length,
			count: rest.reduce((total, element) => total + element.count, 0),
			unrendered: rest.reduce((total, element) => element.disposition === 'unrendered' ? total + element.count : total, 0),
		},
	};
}

const storyKindOrder: readonly ParadisWordStoryKind[] = ['body', 'header', 'footer', 'footnote', 'endnote', 'comment', 'textbox', 'glossary'];

function storyOrder(kind: string): number {
	const index = storyKindOrder.indexOf(kind as ParadisWordStoryKind);
	return index < 0 ? storyKindOrder.length : index;
}
