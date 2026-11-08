// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { questionRepliesOf } from '../../asyncQuestions.js';
import { parseAttachmentMessage } from '../../attachments/attachmentText.js';
import type { ChatRow } from './chatRows.js';
import type { InplaceSelectSegment } from './inplaceSelectHtml.js';
import { CONTENT_MAX_WIDTH } from '../../ipad/ipadLayout.js';
import { space } from '../../theme.js';

/**
 * 前後の発言をまとめて選ぶ（`crossSelect.tsx`）ときに並べる発言を、会話の行から選ぶ。RN を持たない純関数。
 *
 * - 並べるのは文字の発言だけ（エージェント・チームメイト・自分）。ツールの実行・質問・お知らせ・カードの行は飛ばす
 * - 押した発言を中心に、前と後を交互に足していき、{@link CROSS_SELECT_MAX_SEGMENTS} 件か {@link CROSS_SELECT_MAX_CHARS} 字で止める
 *   （WebView の HTML を大きくしすぎない）。押した発言だけは長くても必ず入れる
 */

/** まとめて並べる発言の上限（件）。 */
export const CROSS_SELECT_MAX_SEGMENTS = 30;
/** まとめて並べる発言の字数の上限（押した発言を除く）。 */
export const CROSS_SELECT_MAX_CHARS = 60_000;

/** 行を、並べる発言にする。文字の発言でなければ `undefined`。 */
export function crossSelectSegmentOf(row: ChatRow): InplaceSelectSegment | undefined {
	if (row.type !== 'msg' || row.m.notice === true) {
		return undefined;
	}
	const message = row.m;
	if (message.kind === 'peer_message') {
		return message.text.trim().length > 0 ? { text: message.text, markdown: true, label: 'チームメイト' } : undefined;
	}
	if (message.role === 'user') {
		if (questionRepliesOf(message) !== undefined) {
			return undefined;
		}
		const body = parseAttachmentMessage(message.text).body;
		return body.trim().length > 0 ? { text: body, markdown: false, label: 'あなた' } : undefined;
	}
	return message.text.trim().length > 0 ? { text: message.text, markdown: true, label: 'エージェント' } : undefined;
}

/** 並べる発言と、その中の押した発言の番号。押した行が文字の発言でなければ `undefined`。 */
export function crossSelectSegments(rows: readonly ChatRow[], anchorRow: number, maxSegments = CROSS_SELECT_MAX_SEGMENTS, maxChars = CROSS_SELECT_MAX_CHARS): { readonly segments: readonly InplaceSelectSegment[]; readonly anchor: number } | undefined {
	const anchorRowValue = rows[anchorRow];
	const pressed = anchorRowValue !== undefined ? crossSelectSegmentOf(anchorRowValue) : undefined;
	if (pressed === undefined) {
		return undefined;
	}
	const before: InplaceSelectSegment[] = [];
	const after: InplaceSelectSegment[] = [];
	let chars = 0;
	let back = anchorRow - 1;
	let ahead = anchorRow + 1;
	let takeBefore = true;
	while ((back >= 0 || ahead < rows.length) && 1 + before.length + after.length < maxSegments) {
		const fromBefore = takeBefore ? back >= 0 : ahead >= rows.length;
		takeBefore = !takeBefore;
		const row = fromBefore ? rows[back--] : rows[ahead++];
		const segment = row !== undefined ? crossSelectSegmentOf(row) : undefined;
		if (segment === undefined) {
			continue;
		}
		if (chars + segment.text.length > maxChars) {
			break;
		}
		chars += segment.text.length;
		(fromBefore ? before : after).push(segment);
	}
	before.reverse();
	return { segments: [...before, pressed, ...after], anchor: before.length };
}

/** 押した発言の画面の上の四角（`measure` の pageX・pageY・幅・高さ）。 */
export interface CrossSelectFrame {
	readonly pageX: number;
	readonly pageY: number;
	readonly width: number;
	readonly height: number;
}

/**
 * 発言の列の左端と幅。押した発言がエージェントの発言なら測った四角をそのまま使い、自分の発言（右寄せの吹き出し）なら
 * 会話の行の列（iPad の広い幅では中央の {@link CONTENT_MAX_WIDTH}、左右に行の余白）にする。
 */
export function crossSelectColumn(anchorMarkdown: boolean, frame: CrossSelectFrame, list: { readonly pageX: number; readonly width: number }, regular: boolean): { readonly left: number; readonly width: number } {
	if (anchorMarkdown) {
		return { left: Math.max(0, frame.pageX - list.pageX), width: Math.max(1, frame.width) };
	}
	const column = regular ? Math.min(list.width, CONTENT_MAX_WIDTH) : list.width;
	return { left: (list.width - column) / 2 + space.lg, width: Math.max(1, column - space.lg * 2) };
}
