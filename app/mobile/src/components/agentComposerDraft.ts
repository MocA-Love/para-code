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
