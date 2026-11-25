// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { IDLE_SUBMISSION, canRetrySubmission, isSubmissionLocked, reduceAnswerSubmission, type AnswerSubmissionState } from './answerSubmission.js';

const sending: AnswerSubmissionState = { phase: 'sending' };

describe('reduceAnswerSubmission', () => {
	it('moves to "sent" once the PC accepts or consumes the answer', () => {
		expect(reduceAnswerSubmission(sending, { type: 'result', result: { status: 'accepted' } })).toEqual({ phase: 'sent' });
		expect(reduceAnswerSubmission(sending, { type: 'result', result: { status: 'consumed' } })).toEqual({ phase: 'sent' });
	});

	it('returns to idle with the reason when the answer is rejected', () => {
		expect(reduceAnswerSubmission(sending, { type: 'result', result: { status: 'rejected', message: '接続がありません' } }))
			.toEqual({ phase: 'idle', error: '接続がありません' });
		expect(reduceAnswerSubmission(sending, { type: 'result', result: { status: 'rejected' } }))
			.toEqual({ phase: 'idle', error: '回答を送信できませんでした' });
	});

	it('offers a resend only when the timeout hits while still sending', () => {
		const timedOut = reduceAnswerSubmission(sending, { type: 'timeout' });
		expect(timedOut).toEqual({ phase: 'noResponse' });
		expect(isSubmissionLocked(timedOut)).toBe(true);
		expect(canRetrySubmission(timedOut)).toBe(true);
	});

	it('does not offer a resend once the PC accepted the answer, even after the timeout', () => {
		const sent = reduceAnswerSubmission(sending, { type: 'result', result: { status: 'accepted' } });
		expect(canRetrySubmission(sent)).toBe(false);
		const timedOut = reduceAnswerSubmission(sent, { type: 'timeout' });
		expect(timedOut).toEqual({ phase: 'acceptedNoResponse' });
		expect(isSubmissionLocked(timedOut)).toBe(true);
		expect(canRetrySubmission(timedOut)).toBe(false);
		// 以後の時間切れ・受け付けでも再送の導線へ戻らない。
		expect(reduceAnswerSubmission(timedOut, { type: 'timeout' })).toBe(timedOut);
		expect(reduceAnswerSubmission(timedOut, { type: 'result', result: { status: 'accepted' } })).toBe(timedOut);
	});

	it('withdraws the resend when a late acceptance arrives, but surfaces a late rejection', () => {
		const noResponse: AnswerSubmissionState = { phase: 'noResponse' };
		const lateAccepted = reduceAnswerSubmission(noResponse, { type: 'result', result: { status: 'accepted' } });
		expect(lateAccepted).toEqual({ phase: 'acceptedNoResponse' });
		expect(canRetrySubmission(lateAccepted)).toBe(false);
		expect(reduceAnswerSubmission(noResponse, { type: 'result', result: { status: 'consumed' } })).toEqual({ phase: 'acceptedNoResponse' });
		expect(reduceAnswerSubmission(noResponse, { type: 'result', result: { status: 'rejected', message: '対象が変わりました' } }))
			.toEqual({ phase: 'idle', error: '対象が変わりました' });
	});

	it('ignores timers and results while idle', () => {
		expect(reduceAnswerSubmission(IDLE_SUBMISSION, { type: 'timeout' })).toBe(IDLE_SUBMISSION);
		expect(reduceAnswerSubmission(IDLE_SUBMISSION, { type: 'result', result: { status: 'accepted' } })).toBe(IDLE_SUBMISSION);
	});

	it('resubmits from "no response" and resets back to idle', () => {
		expect(reduceAnswerSubmission({ phase: 'noResponse' }, { type: 'submit' })).toEqual({ phase: 'sending' });
		expect(reduceAnswerSubmission({ phase: 'idle', error: 'x' }, { type: 'reset' })).toBe(IDLE_SUBMISSION);
		expect(isSubmissionLocked(IDLE_SUBMISSION)).toBe(false);
		expect(canRetrySubmission(IDLE_SUBMISSION)).toBe(false);
		expect(canRetrySubmission(sending)).toBe(false);
	});
});
