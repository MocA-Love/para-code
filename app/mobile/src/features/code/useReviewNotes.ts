// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useState } from 'react';
import {
	PARADIS_MOBILE_REVIEW_NOTES_CAPABILITY,
	PARADIS_MOBILE_REVIEW_STAGE_CAPABILITY,
} from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileDiffReview.js';
import { sendPcRequest } from '../../appState.js';
import { usePcCapability } from '../../hooks/usePcCapability.js';
import { useParaToast } from '../../paraToast.js';
import { codeCacheKey, useReviewNotes } from './codeCache.js';
import { sendFailureMessage, type ReviewNote } from './reviewNotes.js';
import type { ScmEntry } from './scmModel.js';
import type { CodeSpace } from './useCodeSpace.js';
import type { ReviewMarksController } from './useReviewMarks.js';

/**
 * 差分の行へのメモと「確認済みをステージ」（Orca W2-28）。メモは PC に保存し（`review.notes.v1`）、
 * どの操作も PC の応答（そのスペースの印とメモの全体）で手元を置き換える。
 */
export interface ReviewNotesController {
	/** PC がメモを扱えるか（扱えなければメモのボタンを出さない）。 */
	readonly enabled: boolean;
	/** PC が確認済みのステージを扱えるか。 */
	readonly canStage: boolean;
	readonly notes: readonly ReviewNote[];
	/** PC の応答を待っている間。 */
	readonly busy: boolean;
	add(path: string, line: number, lineText: string, body: string): Promise<boolean>;
	edit(id: string, body: string): Promise<boolean>;
	remove(ids: readonly string[]): Promise<boolean>;
	/** 送信済みと、行が見つからなくなったメモを消す。消した件数（失敗なら undefined）。 */
	clear(): Promise<number | undefined>;
	/** 選んだメモを送る。送れたら true（メモは「送信済み」になって残る）。 */
	send(ids: readonly string[], target: { readonly terminalKey: string } | { readonly agent: string }): Promise<boolean>;
	/** 確認済みで、確認した後に変わっていないファイルだけをステージする。 */
	stage(entries: readonly ScmEntry[]): Promise<{ readonly staged: number; readonly skipped: number } | undefined>;
}

const NO_NOTES: readonly ReviewNote[] = [];

interface ReviewReply {
	readonly marks?: unknown;
	readonly notes?: unknown;
	readonly removed?: unknown;
	readonly staged?: unknown;
	readonly skipped?: unknown;
}

function showFailure(text: string, error: unknown): void {
	useParaToast.getState().show({ key: 'review-note-failed', text, sub: sendFailureMessage(error), icon: 'alert-circle', tone: 'warn' }, 4_000);
}

export function useReviewNotesController(space: CodeSpace, review: ReviewMarksController): ReviewNotesController {
	const enabled = usePcCapability(PARADIS_MOBILE_REVIEW_NOTES_CAPABILITY);
	const canStage = usePcCapability(PARADIS_MOBILE_REVIEW_STAGE_CAPABILITY);
	const notes = useReviewNotes(codeCacheKey(space.pcId, space.spaceId));
	/** 応答を待っている要求の数（重なっても最後の応答が返るまで busy）。 */
	const [pending, setPending] = useState(0);
	const busy = pending > 0;
	const { pcId, wsId } = space;
	const { applyReply } = review;

	/** 要求を送り、応答で手元を置き換える。失敗したら理由をトーストで出して undefined。 */
	const run = useCallback(async (body: { readonly t: string; readonly [key: string]: unknown }, failure: string, timeoutMs?: number): Promise<ReviewReply | undefined> => {
		if (wsId === undefined) {
			return undefined;
		}
		setPending(count => count + 1);
		try {
			const reply = await sendPcRequest<ReviewReply>(pcId, 'scm', { ...body, ws: wsId }, timeoutMs !== undefined ? { timeoutMs } : undefined);
			// 古い版の応答は applyReply が捨てる（PC がスペースの記録の版を返す）
			applyReply(reply);
			return reply;
		} catch (error) {
			showFailure(failure, error);
			return undefined;
		} finally {
			setPending(count => count - 1);
		}
	}, [pcId, wsId, applyReply]);

	const add = useCallback(async (path: string, line: number, lineText: string, body: string) =>
		(await run({ t: 'reviewNoteAdd', path, line, lineText, body }, 'メモを保存できませんでした')) !== undefined, [run]);

	const edit = useCallback(async (id: string, body: string) =>
		(await run({ t: 'reviewNoteEdit', noteId: id, body }, 'メモを保存できませんでした')) !== undefined, [run]);

	const remove = useCallback(async (ids: readonly string[]) =>
		(await run({ t: 'reviewNoteDelete', ids }, 'メモを消せませんでした')) !== undefined, [run]);

	const clear = useCallback(async () => {
		const reply = await run({ t: 'reviewNotesClear' }, 'メモを片付けられませんでした');
		return reply !== undefined && typeof reply.removed === 'number' ? reply.removed : undefined;
	}, [run]);

	const send = useCallback(async (ids: readonly string[], target: { readonly terminalKey: string } | { readonly agent: string }) => {
		// 新しいエージェントを起動するときは、ターミナルの起動を待つので長めに待つ
		const reply = await run({ t: 'reviewNotesSend', ids, target }, 'メモを送れませんでした', 'agent' in target ? 60_000 : undefined);
		if (reply === undefined) {
			return false;
		}
		useParaToast.getState().show({ key: 'review-note-sent', text: `メモを ${ids.length} 件送りました`, icon: 'checkmark-circle-outline', tone: 'done' }, 2_000);
		return true;
	}, [run]);

	const stage = useCallback(async (entries: readonly ScmEntry[]) => {
		const reply = await run({ t: 'reviewStage', entries: entries.map(entry => ({ path: entry.path, identity: entry.identity })) }, 'ステージできませんでした');
		if (reply === undefined) {
			return undefined;
		}
		return { staged: Array.isArray(reply.staged) ? reply.staged.length : 0, skipped: Array.isArray(reply.skipped) ? reply.skipped.length : 0 };
	}, [run]);

	return { enabled, canStage, notes: enabled ? notes : NO_NOTES, busy, add, edit, remove, clear, send, stage };
}
