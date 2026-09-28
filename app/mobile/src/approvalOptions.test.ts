// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { approvalChoicesFromOptions, approvalSuggestionNote, parseApprovalOptionsReply, shouldRequestApprovalOptions } from './approvalOptions.js';

describe('approvalOptions (W2-21)', () => {
	it('asks the PC only for hook approvals that carry the plain allow / deny choices', () => {
		expect({
			hook: shouldRequestApprovalOptions({ kind: 'approval', id: 'approval:e:0', choices: [{ id: 'yes', label: '許可', tone: 'approve' }, { id: 'no', label: '拒否', tone: 'deny' }] }),
			noChoices: shouldRequestApprovalOptions({ kind: 'approval', id: 'toolu_1' }),
			codexDaemon: shouldRequestApprovalOptions({ kind: 'approval', id: 'codex:thread:1', choices: [{ id: 'accept', label: '許可', tone: 'approve' }] }),
			codexStatus: shouldRequestApprovalOptions({ kind: 'approval', id: 'codex-status:thread', choices: [] }),
			question: shouldRequestApprovalOptions({ kind: 'question', id: 'q' }),
			none: shouldRequestApprovalOptions(undefined),
		}).toEqual({ hook: true, noChoices: true, codexDaemon: false, codexStatus: false, question: false, none: false });
	});

	it('accepts only a complete 1..n list from the reply', () => {
		expect({
			ok: parseApprovalOptionsReply({ options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], promptHash: 'cccccccccccccccccccccccccccccccccccccccc' }),
			badHash: parseApprovalOptionsReply({ options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], promptHash: 'x' }),
			error: parseApprovalOptionsReply({ error: 'unreadable' }),
			single: parseApprovalOptionsReply({ options: [{ n: 1, label: 'Yes' }] }),
			gap: parseApprovalOptionsReply({ options: [{ n: 1, label: 'Yes' }, { n: 3, label: 'No' }] }),
			emptyLabel: parseApprovalOptionsReply({ options: [{ n: 1, label: 'Yes' }, { n: 2, label: '' }] }),
		}).toEqual({ ok: { options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], promptHash: 'cccccccccccccccccccccccccccccccccccccccc' }, badHash: { options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] }, error: undefined, single: undefined, gap: undefined, emptyLabel: undefined });
	});

	it('turns the options into buttons: 1 is the primary, (esc) stays the measured deny, others send opt:<n> with the label', () => {
		const result = approvalChoicesFromOptions([
			{ n: 1, label: 'Yes' },
			{ n: 2, label: `Yes, and don't ask again for git push commands in /Users/example/projects/demo` },
			{ n: 3, label: 'No, and tell Claude what to do differently (esc)' },
		]);
		expect({ choices: result.choices, labels: [...result.labels] }).toEqual({
			choices: [
				{ id: 'opt:1', label: 'Yes', tone: 'approve' },
				{ id: 'opt:2', label: `Yes, and don't ask again for git push commands in /Users/example/projects/demo`, tone: 'neutral' },
				{ id: 'no', label: 'No, and tell Claude what to do differently', tone: 'deny' },
			],
			labels: [
				['opt:1', 'Yes'],
				['opt:2', `Yes, and don't ask again for git push commands in /Users/example/projects/demo`],
			],
		});
	});

	it('strips Codex shortcut hints from the button text but keeps the screen label to re-check', () => {
		const result = approvalChoicesFromOptions([
			{ n: 1, label: 'Yes, proceed (y)' },
			{ n: 2, label: 'No, continue without running it (n)' },
		]);
		expect({ choices: result.choices, labels: [...result.labels] }).toEqual({
			choices: [
				{ id: 'opt:1', label: 'Yes, proceed', tone: 'approve' },
				{ id: 'opt:2', label: 'No, continue without running it', tone: 'deny' },
				{ id: 'no', label: '拒否', tone: 'deny' },
			],
			labels: [['opt:1', 'Yes, proceed (y)'], ['opt:2', 'No, continue without running it (n)']],
		});
	});

	it('writes the hook suggestions as one note line', () => {
		expect({
			note: approvalSuggestionNote(['Bash(npm test:*)', 'mode: acceptEdits']),
			none: approvalSuggestionNote(undefined),
			empty: approvalSuggestionNote([]),
		}).toEqual({ note: '今後確認しない候補: Bash(npm test:*)、mode: acceptEdits', none: undefined, empty: undefined });
	});
});
