// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { AgentMessageSendResult } from '../store.js';

/**
 * 承認・質問カードの「送ったあと」の状態。
 *
 * 以前は送信から15秒たつと黙って押せる状態に戻していたため、PCが受け取ったのか、
 * 落ちたのか、押し直してよいのかが画面から分からなかった。いまは
 *  - 送信中（sending）→ PCが受け付けたら「送信済み・PC の応答を待っています」（sent）
 *  - 送信中のまま規定時間を過ぎた（PCが受け付けたかも分からない）→「PC から応答がありません」（noResponse）
 *    と再送の導線を出す
 *  - PCが受け付けたあとに規定時間を過ぎた（受け付けたのにカードが消えない）→「PC は受け付けました」
 *    （acceptedNoResponse）。**再送は出さない。** PCは本文を受け取っているので、再送すると
 *    同じ回答が二重に入力される（次の質問やプロンプトへ流れ込む）
 *  - 送信が拒否されたら理由を添えて押せる状態へ戻す（idle + error）
 * のように、利用者が次にすべきことが必ず見える形にする。
 *
 * カードが消える（PCが回答を反映する）ことが唯一の「完了」。ここは完了を知らない。
 */
export type AnswerSubmissionState =
	| { readonly phase: 'idle'; readonly error?: string }
	| { readonly phase: 'sending' }
	| { readonly phase: 'sent' }
	| { readonly phase: 'noResponse' }
	| { readonly phase: 'acceptedNoResponse' };

export type AnswerSubmissionEvent =
	| { readonly type: 'submit' }
	| { readonly type: 'result'; readonly result: AgentMessageSendResult }
	| { readonly type: 'timeout' }
	| { readonly type: 'reset' };

/** PC の反映を待つ時間。これを過ぎたら「応答がありません」に替える。 */
export const ANSWER_RESPONSE_TIMEOUT_MS = 15_000;

export const IDLE_SUBMISSION: AnswerSubmissionState = { phase: 'idle' };

const DEFAULT_REJECTION = '回答を送信できませんでした';

export function reduceAnswerSubmission(state: AnswerSubmissionState, event: AnswerSubmissionEvent): AnswerSubmissionState {
	switch (event.type) {
		case 'submit':
			return { phase: 'sending' };
		case 'result':
			if (state.phase === 'idle') {
				return state;
			}
			// 待ち時間を過ぎてから拒否が届いた場合も、理由を出して押せる状態へ戻す
			// （「応答がありません」より具体的な情報なので、こちらを優先する）。
			if (event.result.status === 'rejected') {
				return { phase: 'idle', error: event.result.message ?? DEFAULT_REJECTION };
			}
			// accepted / consumed（TUIへ貼り付け済み）はどちらも失敗ではない。
			// 時間切れのあとで受け付けが届いたら、再送の導線を引っ込める（受け付け済みを再送すると二重になる）。
			return state.phase === 'sending' ? { phase: 'sent' }
				: state.phase === 'noResponse' ? { phase: 'acceptedNoResponse' }
					: state;
		case 'timeout':
			return state.phase === 'sending' ? { phase: 'noResponse' }
				: state.phase === 'sent' ? { phase: 'acceptedNoResponse' }
					: state;
		case 'reset':
			return state.phase === 'idle' && state.error === undefined ? state : IDLE_SUBMISSION;
	}
}

/** 選択肢・送信ボタンを押せないようにすべき状態か（送信中〜応答なしのあいだは状態表示と、送信中の時間切れに限り再送の導線だけを出す）。 */
export function isSubmissionLocked(state: AnswerSubmissionState): boolean {
	return state.phase !== 'idle';
}

/** 再送・選び直しを出してよい状態か。PCが受け付けたかどうか分からないまま時間切れになったときだけ。 */
export function canRetrySubmission(state: AnswerSubmissionState): boolean {
	return state.phase === 'noResponse';
}
