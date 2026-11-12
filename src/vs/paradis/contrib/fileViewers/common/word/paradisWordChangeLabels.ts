/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word の比較の変更（ParadisOfficeChange）の表示名と、変更に含まれる文字。デスクトップの変更点パネル
// （paradisWordChangeInspector.ts）とスマホの Word 差分（paradisMobileWordDiffHtml.ts）が同じ表を使う。

import { localize } from '../../../../../nls.js';
import type { ParadisOfficeChange, ParadisOfficeChangeCategory, ParadisOfficeChangeValue } from '../paradisOfficeProtocol.js';
import type { ParadisWordStoryKind } from './paradisWordSemantic.js';

/** 文書パーツの種類（locator の `story:<kind>:` の部分）。 */
export const PARADIS_WORD_STORY_KINDS: ReadonlySet<ParadisWordStoryKind> = new Set<ParadisWordStoryKind>(['body', 'header', 'footer', 'footnote', 'endnote', 'comment', 'textbox', 'glossary']);

/** 変更の分類の表示名。 */
export function paradisWordChangeCategoryLabel(category: ParadisOfficeChangeCategory): string {
	switch (category) {
		case 'content': return localize('paradis.word.change.content', "内容");
		case 'formatting': return localize('paradis.word.change.formatting', "書式");
		case 'structure': return localize('paradis.word.change.structure', "構造");
		case 'annotation': return localize('paradis.word.change.annotation', "コメント");
		case 'revision': return localize('paradis.word.change.revision', "変更履歴");
		case 'object': return localize('paradis.word.change.object', "オブジェクト");
		case 'security': return localize('paradis.word.change.security', "セキュリティ");
	}
}

/** 文書パーツの種類の表示名。検索結果の場所の札にも使う。 */
export function paradisWordStoryLabel(kind: ParadisWordStoryKind | 'package'): string {
	switch (kind) {
		case 'body': return localize('paradis.word.story.body', "本文");
		case 'header': return localize('paradis.word.story.header', "ヘッダー");
		case 'footer': return localize('paradis.word.story.footer', "フッター");
		case 'footnote': return localize('paradis.word.story.footnote', "脚注");
		case 'endnote': return localize('paradis.word.story.endnote', "文末脚注");
		case 'comment': return localize('paradis.word.story.comment', "コメント");
		case 'textbox': return localize('paradis.word.story.textbox', "テキストボックス");
		case 'glossary': return localize('paradis.word.story.glossary', "定型句");
		case 'package': return localize('paradis.word.story.package', "文書全体");
	}
}

/** Keeps visually similar Word table diagonals and Drawing lines distinct. */
export function wordChangeLabel(change: ParadisOfficeChange): string {
	switch (change.subject.kind) {
		case 'table.diagonalBorder': return localize('paradis.word.change.tableDiagonal', "表の斜線");
		case 'object.lineGeometry': return localize('paradis.word.change.drawingLine', "図形の線");
		case 'object.omml': return localize('paradis.word.change.math', "数式");
		case 'object.imageReference': return localize('paradis.word.change.image', "画像");
		case 'package.style': return localize('paradis.word.change.style', "スタイル");
		case 'paragraph.text': return localize('paradis.word.change.content', "内容");
		case 'revision.inserted': return localize('paradis.word.change.revisionInserted', "挿入");
		case 'revision.deleted': return localize('paradis.word.change.revisionDeleted', "削除");
		case 'revision.moveFrom': return localize('paradis.word.change.revisionMoveFrom', "移動元");
		case 'revision.moveTo': return localize('paradis.word.change.revisionMoveTo', "移動先");
		case 'revision.propertyChange': return localize('paradis.word.change.revisionProperty', "書式の変更履歴");
		default: return paradisWordChangeCategoryLabel(change.category);
	}
}

/** 文書の要素（段落・表・セルなど）の表示名。知らない種類はそのまま返す。 */
export function paradisWordNodeKindLabel(kind: string): string {
	switch (kind) {
		case 'section': return localize('paradis.word.node.section', "セクション");
		case 'paragraph': return localize('paradis.word.node.paragraph', "段落");
		case 'table': return localize('paradis.word.node.table', "表");
		case 'row': return localize('paradis.word.node.row', "行");
		case 'cell': return localize('paradis.word.node.cell', "セル");
		case 'contentControl': return localize('paradis.word.node.contentControl', "コンテンツコントロール");
		case 'drawing': return localize('paradis.word.node.drawing', "図形");
		case 'altChunk': return localize('paradis.word.node.altChunk', "埋め込み文書");
		case 'unknownBlock': return localize('paradis.word.node.unknownBlock', "未知の要素");
		case 'text': return localize('paradis.word.node.text', "テキスト");
		case 'tab': return localize('paradis.word.node.tab', "タブ");
		case 'break': return localize('paradis.word.node.break', "改行・改ページ");
		case 'symbol': return localize('paradis.word.node.symbol', "記号");
		case 'hyperlink': return localize('paradis.word.node.hyperlink', "ハイパーリンク");
		case 'bookmark': return localize('paradis.word.node.bookmark', "ブックマーク");
		case 'field': return localize('paradis.word.node.field', "フィールド");
		case 'omml': return localize('paradis.word.node.omml', "数式");
		case 'revision': return localize('paradis.word.node.revision', "変更履歴");
		case 'image': return localize('paradis.word.node.image', "画像");
		case 'noteReference': return localize('paradis.word.node.noteReference', "脚注の参照");
		case 'commentReference': return localize('paradis.word.node.commentReference', "コメントの参照");
		default: return kind;
	}
}

/** 変更が属する文書パーツ（locator の `story:<kind>:<part>:<identity>` まで）。story でなければ文書全体。 */
export function paradisWordChangeStory(change: ParadisOfficeChange): { readonly kind: ParadisWordStoryKind | 'package'; readonly root: string } {
	if (!change.subject.locator.startsWith('story:')) {
		return { kind: 'package', root: 'package' };
	}
	const nodeSeparator = change.subject.locator.lastIndexOf('/node:');
	const root = nodeSeparator >= 0 ? change.subject.locator.slice(0, nodeSeparator) : change.subject.locator;
	const value = root.slice('story:'.length);
	const separator = value.indexOf(':');
	const kind = separator > 0 ? value.slice(0, separator) : '';
	return PARADIS_WORD_STORY_KINDS.has(kind as ParadisWordStoryKind) ? { kind: kind as ParadisWordStoryKind, root } : { kind: 'package', root: 'package' };
}

function scalarText(value: ParadisOfficeChangeValue | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	if (value.kind === 'scalar') {
		return typeof value.value === 'string' && value.value.trim() ? value.value : undefined;
	}
	if (value.kind === 'record') {
		return scalarText(value.fields.find(field => field.name === 'text')?.value);
	}
	return undefined;
}

/** record の値の、名前の付いた欄の文字（無ければ undefined）。 */
export function paradisWordChangeRecordText(value: ParadisOfficeChangeValue, name: string): string | undefined {
	return value.kind === 'record' ? scalarText(value.fields.find(field => field.name === name)?.value) : undefined;
}

/** 片側の値に含まれる読める文字（文字の値か、record の `text` の欄）。指紋や文字を持たない値は undefined。 */
export function paradisWordChangeValueText(change: ParadisOfficeChange, value: ParadisOfficeChangeValue): string | undefined {
	return readableText(change, scalarText(value));
}

/** 変更に含まれる文字（変更後、無ければ変更前）。文字を持たない変更は undefined。 */
export function wordChangeText(change: ParadisOfficeChange): string | undefined {
	return readableText(change, scalarText(change.after) ?? scalarText(change.before));
}

function readableText(change: ParadisOfficeChange, text: string | undefined): string | undefined {
	// 書式などの変更は、値が中身の指紋（fnv1a32:…）の文字列になっている。読める文字ではないので出さない。
	return text !== undefined && change.category !== 'content' && WORD_FINGERPRINT_TEXT.test(text) ? undefined : text;
}

const WORD_FINGERPRINT_TEXT = /^fnv1a32:[0-9a-f]{8}$/;
