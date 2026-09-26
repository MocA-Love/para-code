// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { appendUploadedPath, flattenAnswerInput, reconcileSubmittedDraft, reconcileSubmittedDraftTarget, shouldShowSubmissionAlert } from './agentComposerDraft.js';

describe('reconcileSubmittedDraft', () => {
	it('keeps text typed after a successful send without resending the submitted prefix', () => {
		expect(reconcileSubmittedDraft('二回目', '一回目', 'accepted')).toBe('二回目');
		// 同じ本文をもう一度入力した場合も、2回目の下書きとして保持する。
		expect(reconcileSubmittedDraft('一回目', '一回目', 'accepted')).toBe('一回目');
	});

	it('restores a rejected submission before text typed while waiting', () => {
		expect(reconcileSubmittedDraft('二回目', '一回目', 'rejected')).toBe('一回目二回目');
	});

	it('treats pasted-but-not-executed as consumed and removes the mobile copy', () => {
		expect(reconcileSubmittedDraft('二回目', '一回目', 'consumed')).toBe('二回目');
	});

	it('restores a rejection to the originating agent after navigation', () => {
		expect(reconcileSubmittedDraftTarget('agent-b', 'agent-a', '', '追記', '一回目', 'rejected')).toEqual({
			kind: 'stored', key: 'agent-a', value: '一回目追記',
		});
		expect(reconcileSubmittedDraftTarget('agent-b', 'agent-a', '', '', '一回目', 'accepted')).toEqual({ kind: 'none' });
	});

	it('still reports a consumed-but-unexecuted paste after navigation', () => {
		expect(shouldShowSubmissionAlert('consumed', 2, 1)).toBe(true);
		expect(shouldShowSubmissionAlert('rejected', 2, 1)).toBe(false);
	});
});

describe('flattenAnswerInput', () => {
	it('turns line breaks into spaces so the answer looks the way the PC will send it', () => {
		expect(flattenAnswerInput('一行目\n二行目')).toBe('一行目 二行目');
		expect(flattenAnswerInput('a\r\nb\rc')).toBe('a b c');
	});

	it('returns the same string when there is no line break (keeps trailing spaces while typing)', () => {
		const text = '入力中 ';
		expect(flattenAnswerInput(text)).toBe(text);
	});
});

describe('appendUploadedPath', () => {
	it('separates the path from existing text with spaces', () => {
		expect(appendUploadedPath('', '/tmp/a.jpg')).toBe('/tmp/a.jpg ');
		expect(appendUploadedPath('見て', '/tmp/a.jpg')).toBe('見て /tmp/a.jpg ');
	});
});
