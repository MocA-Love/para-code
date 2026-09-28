// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { PARADIS_MOBILE_REVIEW_STORE_CAPABILITY } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileDiffReview.js';
import { sendPcRequest } from '../../appState.js';
import { usePcCapability } from '../../hooks/usePcCapability.js';
import { useParaToast } from '../../paraToast.js';
import { codeCacheKey, useCodeCache, useReviewMarks, type ReviewMarks } from './codeCache.js';
import { parseReviewMarks } from './diffReview.js';
import { parseReviewNotes } from './reviewNotes.js';
import type { ScmEntry } from './scmModel.js';
import { currentRendererTarget, type CodeSpace } from './useCodeSpace.js';

/**
 * 差分レビューの「確認済み」の印（Orca W2-14）。
 *
 * 印は確認したときの中身の識別（`ScmEntry.identity`）と一緒に持つので、確認した後にエージェントが
 * 書き換えたファイルは「確認後に変更あり」になり、確認済みに数えない。
 *
 * PC が `review.store.v1` を広告していれば印は PC に保存する（iPhone と iPad で揃い、アプリを閉じても残る）。
 * 画面が前面に来るたびに PC から読み直し、付ける・外すは楽観更新して PC の応答で置き換える
 * （失敗したら戻す）。広告の無い PC では今までどおり端末の中だけで持つ。
 */
export interface ReviewMarksController {
	readonly marks: ReviewMarks;
	/** PC に保存しているか（false ならこの端末の中だけ）。 */
	readonly stored: boolean;
	/** いまの中身で確認済みにする / 外す。 */
	setReviewed(entry: ScmEntry, reviewed: boolean): void;
	/** PC の保存を読み直す（PC 側の操作で印が変わった後など）。 */
	reload(): Promise<void>;
	/** PC から届いた応答（`{ t: 'review', marks, notes }` を含むもの）を反映する。 */
	applyReply(reply: { readonly marks?: unknown }): void;
}

interface ReviewReply {
	readonly marks?: unknown;
	readonly notes?: unknown;
}

export function useReviewMarksController(space: CodeSpace): ReviewMarksController {
	const key = codeCacheKey(space.pcId, space.spaceId);
	const marks = useReviewMarks(key);
	const setReviewMark = useCodeCache(s => s.setReviewMark);
	const replaceReviewMarks = useCodeCache(s => s.replaceReviewMarks);
	const replaceReviewNotes = useCodeCache(s => s.replaceReviewNotes);
	const stored = usePcCapability(PARADIS_MOBILE_REVIEW_STORE_CAPABILITY);
	const { pcId, wsId, rendererTarget } = space;
	/** 要求の順番。後から出した要求（読み直し・付け外し）の応答だけを反映する。 */
	const sequenceRef = useRef(0);

	const applyReply = useCallback((reply: ReviewReply) => {
		if (reply.marks !== undefined) {
			replaceReviewMarks(key, parseReviewMarks(reply.marks));
		}
		// メモは review.notes.v1 の PC だけが返す（古い PC の応答には無いので、手元のものを消さない）
		if (reply.notes !== undefined) {
			replaceReviewNotes(key, parseReviewNotes(reply.notes));
		}
	}, [key, replaceReviewMarks, replaceReviewNotes]);

	const reload = useCallback(async () => {
		if (!stored || wsId === undefined || rendererTarget === undefined) {
			return;
		}
		const sequence = ++sequenceRef.current;
		try {
			const reply = await sendPcRequest<ReviewReply>(pcId, 'scm', { t: 'reviewGet', ws: wsId });
			if (sequence === sequenceRef.current && currentRendererTarget(wsId) === rendererTarget) {
				applyReply(reply);
			}
		} catch {
			// 読めなければ手元の印のまま（次に前面へ来たときに読み直す）
		}
	}, [stored, pcId, wsId, rendererTarget, applyReply]);

	useFocusEffect(useCallback(() => {
		void reload();
	}, [reload]));

	const setReviewed = useCallback((entry: ScmEntry, reviewed: boolean) => {
		const previous = useCodeCache.getState().reviewed[key]?.[entry.path];
		setReviewMark(key, entry.path, reviewed ? { identity: entry.identity, reviewedAt: Date.now() } : undefined);
		if (!stored || wsId === undefined) {
			return;
		}
		const sequence = ++sequenceRef.current;
		sendPcRequest<ReviewReply>(pcId, 'scm', { t: 'reviewSet', ws: wsId, marks: [{ path: entry.path, identity: reviewed ? entry.identity : null }] })
			.then(reply => {
				if (sequence === sequenceRef.current) {
					applyReply(reply);
				}
			})
			.catch(() => {
				setReviewMark(key, entry.path, previous);
				useParaToast.getState().show({ key: 'review-mark-failed', text: '確認の印を PC に保存できませんでした', sub: '接続を確かめて、もう一度押してください。', icon: 'alert-circle', tone: 'warn' }, 3_000);
			});
	}, [key, setReviewMark, stored, pcId, wsId, applyReply]);

	return { marks, stored, setReviewed, reload, applyReply };
}
