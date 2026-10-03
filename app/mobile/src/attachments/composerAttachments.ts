// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { ATTACHMENT_LIMIT } from './attachmentText.js';

/**
 * 送る前の入力欄の添付（案 P2）。入力欄の文字にはパスを入れず、添付を一覧で持ち、送るときに本文へ埋める。
 *
 * - 下書きと同じく入力欄ごと（`draftKey`。質問への回答の入力は別の鍵）に持つので、別の画面へ移っても残る
 * - 選んだ順に 1 枚ずつ上げる。上げ終わるまで送信できない（理由は入力欄に出す）
 * - 失敗した画像は、送るときに利用者に確かめてから外す
 */

export type ComposerAttachmentStatus = 'uploading' | 'ready' | 'failed';

export interface ComposerAttachment {
	/** この一覧の中の識別子。 */
	readonly id: string;
	/** 札のサムネイル（ピッカーが返した端末のファイル。上げ終わったら端末の控え）。 */
	readonly previewUri: string;
	/** ピッカーが返した名前（PC が拡張子を決めるのに使う）。 */
	readonly fileName: string;
	readonly status: ComposerAttachmentStatus;
	/** 上げ終わるまで（と失敗して再試行を待つ間）だけ持つ中身。 */
	readonly base64?: string;
	/** 上げ終わったら PC の置き場のパスと名前。 */
	readonly path?: string;
	readonly name?: string;
}

/** 送れるか、送れないならその理由。 */
export type ComposerAttachmentSendState =
	| { readonly kind: 'ok'; readonly paths: readonly string[] }
	| { readonly kind: 'uploading'; readonly uploading: number; readonly total: number }
	| { readonly kind: 'failed'; readonly failed: number; readonly paths: readonly string[] };

export function composerAttachmentSendState(list: readonly ComposerAttachment[]): ComposerAttachmentSendState {
	const uploading = list.filter(item => item.status === 'uploading').length;
	if (uploading > 0) {
		return { kind: 'uploading', uploading, total: list.length };
	}
	const paths = list.flatMap(item => item.status === 'ready' && item.path !== undefined ? [item.path] : []);
	const failed = list.filter(item => item.status === 'failed').length;
	return failed > 0 ? { kind: 'failed', failed, paths } : { kind: 'ok', paths };
}

/** まだ足せる枚数。 */
export function remainingAttachmentSlots(list: readonly ComposerAttachment[]): number {
	return Math.max(0, ATTACHMENT_LIMIT - list.length);
}

/** 上限を超えた分は捨てて足す。足した分を返す。 */
export function appendComposerAttachments(list: readonly ComposerAttachment[], added: readonly ComposerAttachment[]): { readonly next: readonly ComposerAttachment[]; readonly accepted: readonly ComposerAttachment[] } {
	const accepted = added.slice(0, remainingAttachmentSlots(list));
	return { next: [...list, ...accepted], accepted };
}

/** 送るときに外した添付を、送れなかったときに戻す（送った後に足した分の前へ。重複は戻さない）。 */
export function restoreComposerAttachments(current: readonly ComposerAttachment[], restored: readonly ComposerAttachment[]): readonly ComposerAttachment[] {
	const back = restored.filter(item => !current.some(existing => existing.id === item.id));
	return [...back, ...current].slice(0, ATTACHMENT_LIMIT);
}

interface ComposerAttachmentStore {
	readonly byKey: Readonly<Record<string, readonly ComposerAttachment[]>>;
}

export const useComposerAttachmentStore = create<ComposerAttachmentStore>()(() => ({ byKey: {} }));

const EMPTY: readonly ComposerAttachment[] = [];

export function composerAttachmentsOf(key: string): readonly ComposerAttachment[] {
	return useComposerAttachmentStore.getState().byKey[key] ?? EMPTY;
}

export function useComposerAttachments(key: string): readonly ComposerAttachment[] {
	return useComposerAttachmentStore(state => state.byKey[key] ?? EMPTY);
}

export function setComposerAttachments(key: string, update: (list: readonly ComposerAttachment[]) => readonly ComposerAttachment[]): void {
	useComposerAttachmentStore.setState(state => {
		const next = update(state.byKey[key] ?? EMPTY);
		const { [key]: _previous, ...rest } = state.byKey;
		return { byKey: next.length > 0 ? { ...rest, [key]: next } : rest };
	});
}

export function patchComposerAttachment(key: string, id: string, patch: Partial<Omit<ComposerAttachment, 'id'>>): void {
	setComposerAttachments(key, list => list.map(item => item.id === id ? { ...item, ...patch } : item));
}
