/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Severity } from '../../../../../platform/notification/common/notification.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisResumeAgentInWorkspaceRequest } from '../../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { ParadisDocWakeAnswer } from '../../common/paradisDocCommentDelivery.js';
import { IParadisDocHandOffPane, IParadisDocWakeDependencies, paradisHandOffDoc, paradisWakeDocOwner } from '../../electron-browser/paradisDocCommentWake.js';

suite('ParadisDocCommentWake', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function fake(answer: ParadisDocWakeAnswer, options: { resumed?: string[]; activeStateKey?: string; fail?: boolean } = {}) {
		const calls: unknown[][] = [];
		let ended: (() => void) | undefined;
		const dependencies: IParadisDocWakeDependencies = {
			windowIsRemote: false,
			wake: async (hostId, path, remote) => { calls.push(['wake', hostId, path, remote]); return answer; },
			woke: async (session, token) => { calls.push(['woke', session, token]); },
			wakeFailed: async session => { calls.push(['wakeFailed', session]); },
			resumedSessions: () => new Set(options.resumed ?? []),
			spaces: () => [{ stateKey: 'repo', path: '/repo' }, { stateKey: 'wt', path: '/repo/.worktrees/a' }],
			activeStateKey: options.activeStateKey,
			resume: async (request: IParadisResumeAgentInWorkspaceRequest) => {
				calls.push(['resume', { ...request, rootUri: request.rootUri.fsPath }]);
				if (options.fail) {
					throw new Error('no terminal');
				}
				return { instanceId: 7, paneToken: 'p9' };
			},
			watchLaunched: (instanceId, onEnd) => { calls.push(['watch', instanceId]); ended = onEnd; },
			notify: (severity, message) => { calls.push(['notify', severity, message.length > 0]); },
		};
		return { dependencies, calls, end: () => ended?.() };
	}

	const TICKET: ParadisDocWakeAnswer = { kind: 'wake', agent: 'claude', session: 's1', cwd: '/repo/.worktrees/a/src' };

	test('resumes the session in a background terminal of the space that holds its folder, without skipping permissions, reports the pane, and gives the ticket back when the CLI ends', async () => {
		const { dependencies, calls, end } = fake(TICKET, { activeStateKey: 'repo' });
		await paradisWakeDocOwner(dependencies, '', '/repo/a.md');
		// CLI が終わったら、起こす途中の印を外すよう頼む
		end();
		assert.deepStrictEqual(calls, [
			['wake', '', '/repo/a.md', false],
			['resume', { rootUri: '/repo/.worktrees/a/src', stateKey: 'wt', agent: 'claude', sessionId: 's1', dangerouslyBypassPermissions: false, preserveFocus: true }],
			['woke', 's1', 'p9'],
			['watch', 7],
			['wakeFailed', 's1'],
		]);
	});

	test('does not resume when refused, when a terminal of this window already resumes the session, without a space, or gives the ticket back when the terminal fails', async () => {
		const refused = fake({ kind: 'refused', reason: 'unknown' });
		await paradisWakeDocOwner(refused.dependencies, '', '/repo/a.md');
		const running = fake(TICKET, { resumed: ['s1'] });
		await paradisWakeDocOwner(running.dependencies, '', '/repo/a.md');
		const noSpace = fake({ ...TICKET, cwd: '/elsewhere' });
		await paradisWakeDocOwner(noSpace.dependencies, '', '/elsewhere/a.md');
		const failing = fake(TICKET, { fail: true });
		await assert.rejects(paradisWakeDocOwner(failing.dependencies, '', '/repo/a.md'));
		assert.deepStrictEqual({
			refused: refused.calls.slice(1),
			running: running.calls.slice(1),
			noSpace: noSpace.calls.slice(1),
			failing: failing.calls.slice(2),
		}, {
			refused: [['notify', Severity.Warning, true]],
			running: [['wakeFailed', 's1'], ['notify', Severity.Info, true]],
			noSpace: [['wakeFailed', 's1'], ['notify', Severity.Warning, true]],
			failing: [['wakeFailed', 's1'], ['notify', Severity.Error, true]],
		});
	});

	test('hands the document to the picked pane, and says so when there is no pane to pick', async () => {
		const calls: unknown[][] = [];
		const pane: IParadisDocHandOffPane = { token: 'p2', label: 'claude', description: 'Claude Code' };
		const run = (panes: IParadisDocHandOffPane[]) => paradisHandOffDoc({
			panes: async () => panes,
			pick: async (items, fileName) => { calls.push(['pick', items.length, fileName]); return items[0]; },
			handOff: async (hostId, path, token) => { calls.push(['handOff', hostId, path, token]); return 'handedOff'; },
			notify: severity => { calls.push(['notify', severity]); },
		}, '', '/repo/a.md');
		await run([pane]);
		await run([]);
		assert.deepStrictEqual(calls, [['pick', 1, 'a.md'], ['handOff', '', '/repo/a.md', 'p2'], ['notify', Severity.Info]]);
	});
});
