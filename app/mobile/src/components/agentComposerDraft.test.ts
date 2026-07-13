// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { reconcileSubmittedDraft, reconcileSubmittedDraftTarget, shouldShowSubmissionAlert } from './agentComposerDraft.js';

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
