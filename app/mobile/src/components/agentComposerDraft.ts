// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { AgentMessageSendResult } from '../store.js';

/** 送信待ち中に追加入力された下書きを保ち、送信済みprefixだけを重複なく除去・復元する。 */
export function reconcileSubmittedDraft(current: string, submitted: string, status: AgentMessageSendResult['status']): string {
	return status === 'rejected' ? submitted + current : current;
}

export type SubmittedDraftReconciliation =
	| { readonly kind: 'active'; readonly value: string }
	| { readonly kind: 'stored'; readonly key: string; readonly value: string }
	| { readonly kind: 'none' };

/** 送信結果が届く前に画面を切り替えても、rejectされた本文を送信元へ戻す。 */
export function reconcileSubmittedDraftTarget(
	activeKey: string | undefined,
	submittedKey: string | undefined,
	activeDraft: string,
	storedSubmittedDraft: string,
	submitted: string,
	status: AgentMessageSendResult['status'],
): SubmittedDraftReconciliation {
	if (activeKey === submittedKey) {
		return { kind: 'active', value: reconcileSubmittedDraft(activeDraft, submitted, status) };
	}
	if (status === 'rejected' && submittedKey !== undefined) {
		return { kind: 'stored', key: submittedKey, value: reconcileSubmittedDraft(storedSubmittedDraft, submitted, status) };
	}
	return { kind: 'none' };
}

/** consumedは画面切替後でもTUIに未実行本文が残るため、必ず利用者へ知らせる。 */
export function shouldShowSubmissionAlert(status: AgentMessageSendResult['status'], currentGeneration: number, submittedGeneration: number): boolean {
	return status === 'consumed' || (status === 'rejected' && currentGeneration === submittedGeneration);
}

/**
 * 質問への回答入力で、改行を空白に置き換える。回答はPCでキー列に直すときに1行へ平坦化される
 * （agentQuestionKeys.ts の flattenText）ので、入力欄でも送られる形のまま見せる。
 * 入力途中なので前後の空白は落とさない。改行を含まなければ同じ文字列を返す。
 */
export function flattenAnswerInput(text: string): string {
	return /[\r\n]/.test(text) ? text.replace(/\r\n|[\r\n]/g, ' ') : text;
}

/** 添付画像の保存先パスを入力の末尾へ足す（前後を空白で区切る）。 */
export function appendUploadedPath(current: string, path: string): string {
	return current.length > 0 ? current + ' ' + path + ' ' : path + ' ';
}
