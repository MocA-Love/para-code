// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { haptic } from '../haptics.js';
import type { AgentMessageSendResult } from '../store.js';
import {
	ANSWER_RESPONSE_TIMEOUT_MS, IDLE_SUBMISSION, reduceAnswerSubmission, type AnswerSubmissionState,
} from '../components/answerSubmission.js';

export interface AnswerSubmission {
	readonly state: AnswerSubmissionState;
	/** 回答を送る。結果はそのまま返す（コンポーザーから送ったときに本文を戻すかの判断に使う）。 */
	run(action: () => Promise<AgentMessageSendResult>): Promise<AgentMessageSendResult>;
	/** 直前に送ったものをもう一度送る（「PC から応答がありません」からの再送）。 */
	retry(): void;
	/** 送信前の状態へ戻す（「選び直す」）。送信中の結果は以後無視する。 */
	reset(): void;
}

/**
 * 承認・質問カードの送信状態（{@link ../components/answerSubmission.ts}）を持つ。
 *
 * `resetKey` が変わったら（対象の質問・承認が入れ替わった、PCで回答された）状態を捨てる。
 * 送った結果・タイマーは世代で照合し、捨てたあとに届いたものは反映しない。
 */
export function useAnswerSubmission(resetKey: unknown): AnswerSubmission {
	const [state, dispatch] = useReducer(reduceAnswerSubmission, IDLE_SUBMISSION);
	const generationRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const lastActionRef = useRef<(() => Promise<AgentMessageSendResult>) | undefined>(undefined);
	// 実行中ガード。送信を始めたら、拒否されるか「送信中のまま時間切れ」になるまで新たに送らない
	// （PCが受け付けたあとも、カードが消えるまで送り直さない）。状態（phase）は再レンダリングまで
	// 古いので、二度押し・再送の二度押しは ref で止める。止めた呼び出しには、走っている送信の結果を返す。
	const inFlightRef = useRef<Promise<AgentMessageSendResult> | undefined>(undefined);

	const clearTimer = useCallback(() => {
		if (timerRef.current !== undefined) {
			clearTimeout(timerRef.current);
			timerRef.current = undefined;
		}
	}, []);

	const reset = useCallback(() => {
		generationRef.current++;
		inFlightRef.current = undefined;
		clearTimer();
		dispatch({ type: 'reset' });
	}, [clearTimer]);

	useEffect(() => {
		reset();
	}, [resetKey, reset]);

	useEffect(() => clearTimer, [clearTimer]);

	const run = useCallback((action: () => Promise<AgentMessageSendResult>) => {
		if (inFlightRef.current !== undefined) {
			return inFlightRef.current;
		}
		const generation = ++generationRef.current;
		lastActionRef.current = action;
		clearTimer();
		dispatch({ type: 'submit' });
		let settled = false;
		timerRef.current = setTimeout(() => {
			timerRef.current = undefined;
			if (generationRef.current === generation) {
				// 送信中のまま時間切れなら再送を許す（「PC から応答がありません」から再送する）。
				if (!settled) {
					inFlightRef.current = undefined;
					// 届いたか分からない（失敗とは限らない）ので warning
					haptic('warning');
				}
				dispatch({ type: 'timeout' });
			}
		}, ANSWER_RESPONSE_TIMEOUT_MS);
		const pending: Promise<AgentMessageSendResult> = action()
			.catch((): AgentMessageSendResult => ({ status: 'rejected', message: '回答を送信できませんでした' }))
			.then(result => {
				settled = true;
				if (generationRef.current === generation) {
					// 拒否なら押し直せる。受け付けられたら（時間切れのあとでも）以後は送らない。
					inFlightRef.current = result.status === 'rejected' ? undefined : pending;
					if (result.status === 'rejected') {
						clearTimer();
						// 押した時点で commit を鳴らしている。受理では鳴らさず、失敗だけ知らせる
						haptic('error');
					}
					dispatch({ type: 'result', result });
				}
				return result;
			});
		inFlightRef.current = pending;
		return pending;
	}, [clearTimer]);

	// 再送は「送信中のまま時間切れ」のときだけ画面に出る（answerSubmission.ts の canRetrySubmission）。
	// 二度押しは run の実行中ガードが止める。
	const retry = useCallback(() => {
		const action = lastActionRef.current;
		if (action !== undefined) {
			void run(action);
		}
	}, [run]);

	return { state, run, retry, reset };
}
