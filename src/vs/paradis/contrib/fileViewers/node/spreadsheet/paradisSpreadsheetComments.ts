/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel のメモ（古い形式のコメント、comments）と新しいコメント（スレッド、threadedComments）を、表示用に読む。
// 新しいコメントのあるセルには、読めない版のために Excel が同じ内容の古い形式のメモも書く。そのメモは
// スレッドの写しなので、スレッドのあるセルでは出さない。

import type { ParadisOfficeXmlNode } from '../../common/office/paradisOfficeArchive.js';
import { parseParadisOfficeXml, type ParadisOfficeXmlLimits } from '../../common/office/paradisOfficeCanonicalXml.js';
import type { IParadisCellComment, IParadisCellCommentEntry } from '../../common/paradisSpreadsheet.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

/**
 * コメントの上限。1 シートの数、1 つの本文・作成者の名前・日時の長さ、ブック全体の数と文字数（本文と作成者の
 * 名前の合計）。名前と日時はコメントの数だけ renderer へ写されるので、短く切る。
 */
export const PARADIS_SPREADSHEET_COMMENT_LIMITS = Object.freeze({
	commentsPerSheet: 10_000,
	textCharacters: 32_768,
	authorCharacters: 256,
	dateCharacters: 64,
	commentsPerWorkbook: 20_000,
	workbookCharacters: 4_000_000,
	/** 1 つの投稿の @メンションの数。 */
	mentionsPerEntry: 32,
	/** ブックの文字数の予算に数える、@メンション 1 つ分の重さ（renderer へ送る `{ start, length }` の大きさの目安）。 */
	mentionCharacters: 16,
});

/** 1 シートのコメントと、上限を越えて出さなかったコメントの数。 */
export interface IParadisSpreadsheetSheetComments {
	readonly comments: IParadisCellComment[];
	readonly omitted: number;
}

/** @メンションを始まりの順に並べ、前と重なるもの（`start < 前の終わり`）を捨て、上限の数で切る。 */
function boundedMentions(mentions: readonly { readonly start: number; readonly length: number }[]): { readonly start: number; readonly length: number }[] {
	const kept: { readonly start: number; readonly length: number }[] = [];
	let end = 0;
	for (const mention of [...mentions].sort((left, right) => left.start - right.start)) {
		if (kept.length >= PARADIS_SPREADSHEET_COMMENT_LIMITS.mentionsPerEntry) {
			break;
		}
		if (mention.start < end) {
			continue;
		}
		kept.push(mention);
		end = mention.start + mention.length;
	}
	return kept;
}

/** ブック全体で、まだ読めるコメントの数と文字数。シートをまたいで同じものを渡す。 */
export interface IParadisSpreadsheetCommentBudget {
	comments: number;
	characters: number;
}

export function createParadisSpreadsheetCommentBudget(): IParadisSpreadsheetCommentBudget {
	return { comments: PARADIS_SPREADSHEET_COMMENT_LIMITS.commentsPerWorkbook, characters: PARADIS_SPREADSHEET_COMMENT_LIMITS.workbookCharacters };
}

/** 長すぎる文字を切る（最後の 1 文字を `…` にする）。 */
function clip(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

const XML_LIMITS: ParadisOfficeXmlLimits = { depth: 64, nodes: 2_000_000, attributeLength: 65_536, characters: 32 * 1024 * 1024 };

export interface IParadisSpreadsheetCommentParts {
	/** comments の XML（古い形式のメモ）。 */
	readonly commentsXml?: string;
	/** threadedComments の XML。 */
	readonly threadedCommentsXml?: string;
	/** persons の XML（ブックに 1 つ）。 */
	readonly personsXml?: string;
}

function children(element: XmlElement, local?: string): XmlElement[] {
	const result: XmlElement[] = [];
	for (const child of element.children) {
		if (child.kind === 'element' && (local === undefined || child.local === local)) {
			result.push(child);
		}
	}
	return result;
}

function attribute(element: XmlElement, local: string): string | undefined {
	return element.attributes.find(candidate => candidate.uri === '' && candidate.local === local)?.value;
}

/**
 * 要素の中の `t` の文字をつなぐ（リッチテキストの `r` と、ふりがな `rPh` は除く）。スレッドの `text` は `t` を
 * 使わずに文字を直接持つので、`direct` のときは要素そのものの文字も読む。
 */
function textOf(element: XmlElement | undefined, direct = false): string {
	if (!element) {
		return '';
	}
	let text = '';
	const visit = (node: XmlElement) => {
		for (const child of node.children) {
			if (child.kind === 'text') {
				if (node.local === 't' || (direct && node === element)) {
					text += child.value;
				}
			} else if (child.local !== 'rPh' && child.local !== 'phoneticPr') {
				visit(child);
			}
		}
	};
	visit(element);
	return clip(text, PARADIS_SPREADSHEET_COMMENT_LIMITS.textCharacters);
}

/** `B12` → 0 始まりの行と列。読めなければ undefined。 */
function cellPosition(ref: string): { readonly row: number; readonly column: number } | undefined {
	const match = /^\$?(?<column>[A-Z]{1,3})\$?(?<row>[1-9]\d{0,6})$/.exec(ref.trim().toUpperCase());
	if (!match?.groups) {
		return undefined;
	}
	let column = 0;
	for (const character of match.groups.column) {
		column = column * 26 + character.charCodeAt(0) - 64;
	}
	return { row: Number(match.groups.row) - 1, column: column - 1 };
}

function parse(xml: string | undefined): XmlElement | undefined {
	if (!xml) {
		return undefined;
	}
	try {
		return parseParadisOfficeXml(xml, XML_LIMITS).root;
	} catch {
		return undefined;
	}
}

/** persons の id → 表示名。 */
function readPersons(xml: string | undefined): Map<string, string> {
	const persons = new Map<string, string>();
	const root = parse(xml);
	for (const person of root ? children(root, 'person') : []) {
		const id = attribute(person, 'id');
		if (id) {
			persons.set(id.toUpperCase(), clip(attribute(person, 'displayName') ?? '', PARADIS_SPREADSHEET_COMMENT_LIMITS.authorCharacters));
		}
	}
	return persons;
}

/**
 * 1 シートのメモとスレッドを、セルの順（行、列）に並べて返す。読めない部品は無いものとして扱う。`budget` は
 * ブック全体の残りで、使った分を減らす。使い切ったら、残りのコメントは返さない。
 */
export function readParadisSpreadsheetComments(parts: IParadisSpreadsheetCommentParts, budget: IParadisSpreadsheetCommentBudget = createParadisSpreadsheetCommentBudget()): IParadisCellComment[] {
	return readParadisSpreadsheetSheetComments(parts, budget).comments;
}

/** `readParadisSpreadsheetComments` と同じく読み、上限（シートとブック）を越えて出さなかった数も返す。 */
export function readParadisSpreadsheetSheetComments(parts: IParadisSpreadsheetCommentParts, budget: IParadisSpreadsheetCommentBudget = createParadisSpreadsheetCommentBudget()): IParadisSpreadsheetSheetComments {
	const persons = readPersons(parts.personsXml);
	const result: IParadisCellComment[] = [];
	const threadRefs = new Set<string>();
	let omitted = 0;

	const threaded = parse(parts.threadedCommentsXml);
	if (threaded) {
		const roots = new Map<string, { comment: IParadisCellComment & { entries: IParadisCellCommentEntry[] }; order: number }>();
		const replies: { parentId: string; entry: IParadisCellCommentEntry; order: number }[] = [];
		children(threaded, 'threadedComment').forEach((element, order) => {
			if (roots.size + replies.length >= PARADIS_SPREADSHEET_COMMENT_LIMITS.commentsPerSheet) {
				// 返信は 1 件に数えない（親のコメントに付くだけ）。
				if (!attribute(element, 'parentId')) {
					omitted++;
				}
				return;
			}
			const ref = attribute(element, 'ref');
			const id = attribute(element, 'id')?.toUpperCase();
			const position = ref ? cellPosition(ref) : undefined;
			if (!ref || !id || !position) {
				return;
			}
			const text = textOf(children(element, 'text')[0], true);
			const mentions = boundedMentions(children(children(element, 'mentions')[0] ?? element, 'mention').map(mention => ({
				start: Number(attribute(mention, 'startIndex')),
				length: Number(attribute(mention, 'length')),
			})).filter(mention => Number.isSafeInteger(mention.start) && Number.isSafeInteger(mention.length) && mention.start >= 0 && mention.length > 0 && mention.start + mention.length <= text.length));
			const dT = attribute(element, 'dT');
			const date = dT === undefined ? undefined : clip(dT, PARADIS_SPREADSHEET_COMMENT_LIMITS.dateCharacters);
			const entry: IParadisCellCommentEntry = {
				author: persons.get(attribute(element, 'personId')?.toUpperCase() ?? '') ?? '',
				...(date ? { date } : {}),
				text,
				...(mentions.length > 0 ? { mentions } : {}),
			};
			const parentId = attribute(element, 'parentId')?.toUpperCase();
			if (parentId) {
				replies.push({ parentId, entry, order });
				return;
			}
			const done = attribute(element, 'done');
			roots.set(id, {
				comment: { ref: ref.toUpperCase(), row: position.row, column: position.column, kind: 'thread', ...(done === '1' || done === 'true' ? { resolved: true } : {}), entries: [entry] },
				order,
			});
		});
		for (const reply of replies) {
			roots.get(reply.parentId)?.comment.entries.push(reply.entry);
		}
		for (const { comment } of [...roots.values()].sort((left, right) => left.order - right.order)) {
			threadRefs.add(comment.ref);
			result.push(comment);
		}
	}

	const legacy = parse(parts.commentsXml);
	if (legacy) {
		const authors = children(children(legacy, 'authors')[0] ?? legacy, 'author').map(author => clip(author.children.map(child => child.kind === 'text' ? child.value : '').join(''), PARADIS_SPREADSHEET_COMMENT_LIMITS.authorCharacters));
		for (const element of children(children(legacy, 'commentList')[0] ?? legacy, 'comment')) {
			const ref = attribute(element, 'ref')?.toUpperCase();
			const position = ref ? cellPosition(ref) : undefined;
			if (!ref || !position || threadRefs.has(ref)) {
				continue;
			}
			if (result.length >= PARADIS_SPREADSHEET_COMMENT_LIMITS.commentsPerSheet) {
				omitted++;
				continue;
			}
			const author = authors[Number(attribute(element, 'authorId'))] ?? '';
			result.push({ ref, row: position.row, column: position.column, kind: 'note', entries: [{ author: author.startsWith('tc=') ? '' : author, text: textOf(children(element, 'text')[0]) }] });
		}
	}
	result.sort((left, right) => left.row - right.row || left.column - right.column);
	const kept: IParadisCellComment[] = [];
	for (const comment of result) {
		const characters = comment.entries.reduce((sum, entry) => sum + entry.text.length + entry.author.length + (entry.mentions?.length ?? 0) * PARADIS_SPREADSHEET_COMMENT_LIMITS.mentionCharacters, 0);
		if (budget.comments <= 0 || characters > budget.characters) {
			// ブックの予算を使い切った。残りは出さずに数だけ返す。
			omitted += result.length - kept.length;
			budget.comments = 0;
			break;
		}
		budget.comments--;
		budget.characters -= characters;
		kept.push(comment);
	}
	return { comments: kept, omitted };
}
