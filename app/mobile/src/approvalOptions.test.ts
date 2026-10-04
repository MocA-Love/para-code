// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { approvalChoicesFromOptions, parseApprovalOptionsReply, shouldRequestApprovalOptions, shouldRequestApprovalWarningOnly } from './approvalOptions.js';

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
				{ id: 'opt:1', label: '許可', tone: 'approve' },
				{ id: 'opt:2', label: `Yes, and don't ask again for git push commands in /Users/example/projects/demo`, tone: 'neutral' },
				{ id: 'no', label: '拒否', tone: 'deny' },
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

	it('merges the screen\'s plain "No" into the one 拒否 button and names the plain "Yes" 許可 (decision 2)', () => {
		const result = approvalChoicesFromOptions([{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], 'cccccccccccccccccccccccccccccccccccccccc', 'This shell -c script runs rm and could not be checked');
		expect({ choices: result.choices, labels: [...result.labels], warning: result.warning }).toEqual({
			choices: [{ id: 'opt:1', label: '許可', tone: 'approve' }, { id: 'no', label: '拒否', tone: 'deny' }],
			labels: [['opt:1', 'Yes']],
			warning: 'This shell -c script runs rm and could not be checked',
		});
	});

	it('asks only for the warning on a mod approval that can add rules, and keeps its own choices', () => {
		const modChoices = [{ id: 'yes', label: '許可', tone: 'approve' as const }, { id: 'always', label: '許可（以後確認しない）', tone: 'approve' as const }, { id: 'no', label: '拒否', tone: 'deny' as const }];
		const plain = [{ id: 'yes', label: '許可', tone: 'approve' as const }, { id: 'no', label: '拒否', tone: 'deny' as const }];
		expect({
			mod: [shouldRequestApprovalOptions({ kind: 'approval', id: 'toolu_1', choices: modChoices }), shouldRequestApprovalWarningOnly({ kind: 'approval', id: 'toolu_1', choices: modChoices })],
			hook: [shouldRequestApprovalOptions({ kind: 'approval', id: 'toolu_2', choices: plain }), shouldRequestApprovalWarningOnly({ kind: 'approval', id: 'toolu_2', choices: plain })],
			codex: shouldRequestApprovalWarningOnly({ kind: 'approval', id: 'codex:t:1', choices: modChoices }),
		}).toEqual({ mod: [false, true], hook: [true, false], codex: false });
	});

	it('reads the warning line from the reply only when it is a short string', () => {
		const options = [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }];
		expect({
			warning: parseApprovalOptionsReply({ options, warning: 'This shell -c script runs rm and could not be checked' })?.warning,
			empty: parseApprovalOptionsReply({ options, warning: ' ' })?.warning,
			long: parseApprovalOptionsReply({ options, warning: 'x'.repeat(301) })?.warning,
			notString: parseApprovalOptionsReply({ options, warning: 1 })?.warning,
		}).toEqual({ warning: 'This shell -c script runs rm and could not be checked', empty: undefined, long: undefined, notString: undefined });
	});
});
