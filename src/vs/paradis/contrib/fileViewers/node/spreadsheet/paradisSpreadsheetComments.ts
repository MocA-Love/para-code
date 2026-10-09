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

/** 1 シートで読むコメントの数と、1 つの本文の長さの上限。 */
export const PARADIS_SPREADSHEET_COMMENT_LIMITS = Object.freeze({ commentsPerSheet: 10_000, textCharacters: 32_768 });

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
	return text.length > PARADIS_SPREADSHEET_COMMENT_LIMITS.textCharacters ? `${text.slice(0, PARADIS_SPREADSHEET_COMMENT_LIMITS.textCharacters - 1)}…` : text;
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
			persons.set(id.toUpperCase(), attribute(person, 'displayName') ?? '');
		}
	}
	return persons;
}

/** 1 シートのメモとスレッドを、セルの順（行、列）に並べて返す。読めない部品は無いものとして扱う。 */
export function readParadisSpreadsheetComments(parts: IParadisSpreadsheetCommentParts): IParadisCellComment[] {
	const persons = readPersons(parts.personsXml);
	const result: IParadisCellComment[] = [];
	const threadRefs = new Set<string>();

	const threaded = parse(parts.threadedCommentsXml);
	if (threaded) {
		const roots = new Map<string, { comment: IParadisCellComment & { entries: IParadisCellCommentEntry[] }; order: number }>();
		const replies: { parentId: string; entry: IParadisCellCommentEntry; order: number }[] = [];
		children(threaded, 'threadedComment').forEach((element, order) => {
			if (roots.size + replies.length >= PARADIS_SPREADSHEET_COMMENT_LIMITS.commentsPerSheet) {
				return;
			}
			const ref = attribute(element, 'ref');
			const id = attribute(element, 'id')?.toUpperCase();
			const position = ref ? cellPosition(ref) : undefined;
			if (!ref || !id || !position) {
				return;
			}
			const text = textOf(children(element, 'text')[0], true);
			const mentions = children(children(element, 'mentions')[0] ?? element, 'mention').map(mention => ({
				start: Number(attribute(mention, 'startIndex')),
				length: Number(attribute(mention, 'length')),
			})).filter(mention => Number.isSafeInteger(mention.start) && Number.isSafeInteger(mention.length) && mention.start >= 0 && mention.length > 0 && mention.start + mention.length <= text.length);
			const date = attribute(element, 'dT');
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
		const authors = children(children(legacy, 'authors')[0] ?? legacy, 'author').map(author => author.children.map(child => child.kind === 'text' ? child.value : '').join(''));
		for (const element of children(children(legacy, 'commentList')[0] ?? legacy, 'comment')) {
			if (result.length >= PARADIS_SPREADSHEET_COMMENT_LIMITS.commentsPerSheet) {
				break;
			}
			const ref = attribute(element, 'ref')?.toUpperCase();
			const position = ref ? cellPosition(ref) : undefined;
			if (!ref || !position || threadRefs.has(ref)) {
				continue;
			}
			const author = authors[Number(attribute(element, 'authorId'))] ?? '';
			result.push({ ref, row: position.row, column: position.column, kind: 'note', entries: [{ author: author.startsWith('tc=') ? '' : author, text: textOf(children(element, 'text')[0]) }] });
		}
	}
	return result.sort((left, right) => left.row - right.row || left.column - right.column);
}
