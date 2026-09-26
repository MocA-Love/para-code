// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { QUICK_REPLIES } from '../../agentConversationUx.js';

/**
 * 会話画面のクイック返信（入力欄の上のチップ）の一覧を編集するための純粋な関数。
 * 保存は `quickRepliesStore.ts`、画面は `app/settings/quick-replies.tsx`。
 */

/** 登録できる件数の上限。これより多いとチップの行が横に長くなりすぎ、探すのに時間がかかる。 */
export const QUICK_REPLY_MAX_COUNT = 8;
/** 1件の文字数の上限。チップは1行で出すので、長い文は定型にしない。 */
export const QUICK_REPLY_MAX_LENGTH = 40;
/** 何も保存していないとき・「既定に戻す」で使う一覧。 */
export const DEFAULT_QUICK_REPLIES: readonly string[] = QUICK_REPLIES;

/** 追加・編集できない理由。 */
export type QuickReplyProblem = 'empty' | 'tooLong' | 'duplicate' | 'full';

/** 追加できる件数が残っているか。 */
export function canAddQuickReply(list: readonly string[]): boolean {
	return list.length < QUICK_REPLY_MAX_COUNT;
}

/**
 * 入れようとしている文の問題（無ければ undefined）。前後の空白は落として判定する。
 * `editingIndex` を渡すと、その行を書き換える前提で判定する（件数の上限と、自分自身との重複を見ない）。
 */
export function quickReplyProblem(list: readonly string[], text: string, editingIndex?: number): QuickReplyProblem | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return 'empty';
	}
	if (trimmed.length > QUICK_REPLY_MAX_LENGTH) {
		return 'tooLong';
	}
	// 同じ文を2つ並べても意味が無い（チップの見分けも付かない）。
	if (list.some((item, index) => index !== editingIndex && item === trimmed)) {
		return 'duplicate';
	}
	if (editingIndex === undefined && !canAddQuickReply(list)) {
		return 'full';
	}
	return undefined;
}

/** 問題を利用者に見せる文。 */
export function quickReplyProblemMessage(problem: QuickReplyProblem): string {
	switch (problem) {
		case 'empty':
			return '文字を入れてください';
		case 'tooLong':
			return `${QUICK_REPLY_MAX_LENGTH} 文字までです`;
		case 'duplicate':
			return '同じ返信がすでにあります';
		case 'full':
			return `${QUICK_REPLY_MAX_COUNT} 件まで登録できます。どれかを削除すると追加できます`;
	}
}

/** 末尾に足した一覧。足せないときは元の一覧をそのまま返す。 */
export function addQuickReply(list: readonly string[], text: string): readonly string[] {
	if (quickReplyProblem(list, text) !== undefined) {
		return list;
	}
	return [...list, text.trim()];
}

/** `index` の行を書き換えた一覧。書き換えられないときは元の一覧をそのまま返す。 */
export function updateQuickReply(list: readonly string[], index: number, text: string): readonly string[] {
	if (index < 0 || index >= list.length || quickReplyProblem(list, text, index) !== undefined) {
		return list;
	}
	return list.map((item, i) => (i === index ? text.trim() : item));
}

/** `index` の行を消した一覧。 */
export function removeQuickReply(list: readonly string[], index: number): readonly string[] {
	if (index < 0 || index >= list.length) {
		return list;
	}
	return list.filter((_item, i) => i !== index);
}

/** `index` の行を1つ上（-1）か下（1）へ動かした一覧。端を越えるときは元の一覧をそのまま返す。 */
export function moveQuickReply(list: readonly string[], index: number, direction: -1 | 1): readonly string[] {
	const target = index + direction;
	if (index < 0 || index >= list.length || target < 0 || target >= list.length) {
		return list;
	}
	return list.map((item, i) => {
		if (i === index) {
			return list[target] ?? item;
		}
		if (i === target) {
			return list[index] ?? item;
		}
		return item;
	});
}

/** 保存する形（文字列の配列の JSON）。 */
export function serializeQuickReplies(list: readonly string[]): string {
	return JSON.stringify(list);
}

/**
 * 保存されていたものを一覧に戻す。保存が無い・壊れているときは undefined（使う側で既定に倒す）。
 * 上限を超えるもの・空・重複は落とす（別の版で保存したものや手で壊れたものでも画面を壊さない）。
 */
export function parseQuickReplies(raw: string | null): readonly string[] | undefined {
	if (raw === null) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	let list: readonly string[] = [];
	for (const item of value) {
		if (typeof item === 'string') {
			list = addQuickReply(list, item);
		}
	}
	return list;
}
