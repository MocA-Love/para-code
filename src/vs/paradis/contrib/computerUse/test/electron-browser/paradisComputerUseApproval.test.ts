/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentApprovalRequest, ParadisAgentApprovalOutcome } from '../../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { ParadisComputerUseApprovalOutcome } from '../../common/paradisComputerUse.js';
import { ParadisComputerUseApprovalChannel } from '../../electron-browser/paradisComputerUseApproval.contribution.js';

/** 双方向制御の文字。ソースに生のまま置かない（表示と中身がずれるため）。 */
const RIGHT_TO_LEFT_OVERRIDE = '‮';

suite('ParadisComputerUseApprovalChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(outcome: ParadisAgentApprovalOutcome, onAsk?: (panes: Map<string, number>) => void) {
		const asked: { token: string; message: string; detail: readonly string[]; alternative: string | undefined; approve: string; cooldownKey: string | undefined }[] = [];
		const panes = new Map([['pane-a', 7]]);
		const channel = new ParadisComputerUseApprovalChannel(
			{
				askApproval: async (token: string, request: IParadisAgentApprovalRequest, _cancellation: CancellationToken) => {
					asked.push({ token, message: request.messageTemplate('PANE'), detail: request.detail, alternative: request.alternativeLabel, approve: request.approveLabel, cooldownKey: request.cooldownKey });
					onAsk?.(panes);
					return outcome;
				},
			},
			{ getInstanceForToken: token => panes.get(token) },
		);
		const call = async (token: unknown, prompt: object) => (await channel.call<{ outcome: ParadisComputerUseApprovalOutcome }>(undefined, 'requestAccess', [token, prompt])).outcome;
		return { asked, call };
	}

	test('asks to read an app with sanitised text, a per-app cooldown and no operate choice while there are no operate tools', async () => {
		const { asked, call } = setup('approve');
		const outcome = await call('pane-a', { appName: `Fin${RIGHT_TO_LEFT_OVERRIDE}der\nevil`, bundleId: 'com.apple.finder', requested: 'read', offerOperate: false });
		assert.deepStrictEqual({ outcome, alternative: asked[0].alternative, cooldownKey: asked[0].cooldownKey, lines: asked[0].detail.length }, {
			outcome: 'read',
			alternative: undefined,
			cooldownKey: 'computer:com.apple.finder',
			lines: 4,
		});
		assert.ok([asked[0].message, ...asked[0].detail].every(line => !line.includes(RIGHT_TO_LEFT_OVERRIDE) && !line.includes('\n')));
	});

	test('offers read-only as the second button when operating is available and maps the answers', async () => {
		const readOnly = setup('alternative');
		const operate = setup('approve');
		const prompt = { appName: 'Notes', bundleId: 'com.apple.Notes', requested: 'read', offerOperate: true };
		assert.deepStrictEqual({
			readOnly: await readOnly.call('pane-a', prompt),
			operate: await operate.call('pane-a', prompt),
			hasAlternative: operate.asked[0].alternative !== undefined,
			lines: operate.asked[0].detail.length,
		}, { readOnly: 'read', operate: 'operate', hasAlternative: true, lines: 5 });
	});

	test('an upgrade offers only deny and operate, a first request to operate also offers read-only', async () => {
		const upgrade = setup('approve');
		const outcome = await upgrade.call('pane-a', { appName: 'Notes', bundleId: 'com.apple.Notes', requested: 'operate', upgrade: true, offerOperate: true });
		const first = setup('alternative');
		const firstOutcome = await first.call('pane-a', { appName: 'Notes', bundleId: 'com.apple.Notes', requested: 'operate', upgrade: false, offerOperate: true });
		assert.deepStrictEqual({
			outcome,
			alternative: upgrade.asked[0].alternative,
			upgradeMessage: upgrade.asked[0].message,
			firstOutcome,
			firstHasAlternative: first.asked[0].alternative !== undefined,
		}, {
			outcome: 'operate',
			alternative: undefined,
			upgradeMessage: 'PANE のエージェントが、「Notes」を操作したいと求めています',
			firstOutcome: 'read',
			firstHasAlternative: true,
		});
	});

	test('warns that operating a terminal can run commands, and always says Computer Use runs outside the agent\'s limits', async () => {
		const terminal = setup('approve');
		await terminal.call('pane-a', { appName: 'Terminal', bundleId: 'com.apple.Terminal', requested: 'operate', upgrade: false, offerOperate: true });
		const notes = setup('approve');
		await notes.call('pane-a', { appName: 'Notes', bundleId: 'com.apple.Notes', requested: 'operate', upgrade: false, offerOperate: true });
		const commands = 'このアプリを操作すると、コマンドをあなたの権限で実行できます。';
		const outside = 'Computer Use は、エージェントの作業フォルダやサンドボックス、許可設定の制限の外で、あなたの権限で動きます。';
		assert.deepStrictEqual({
			terminal: [terminal.asked[0].detail.includes(commands), terminal.asked[0].detail.includes(outside)],
			notes: [notes.asked[0].detail.includes(commands), notes.asked[0].detail.includes(outside)],
		}, { terminal: [true, true], notes: [false, true] });
	});

	test('passes refusals through and does not ask for unknown panes or malformed bundle ids', async () => {
		const denied = setup('denied');
		const busy = setup('busy');
		const unknown = setup('approve');
		const closedDuringDialog = setup('approve', panes => panes.delete('pane-a'));
		assert.deepStrictEqual({
			denied: await denied.call('pane-a', { appName: 'Finder', bundleId: 'com.apple.finder', requested: 'read' }),
			busy: await busy.call('pane-a', { appName: 'Finder', bundleId: 'com.apple.finder', requested: 'read' }),
			unknownPane: await unknown.call('pane-z', { appName: 'Finder', bundleId: 'com.apple.finder', requested: 'read' }),
			badBundle: await unknown.call('pane-a', { appName: 'Finder', bundleId: 'com.apple.finder\nx', requested: 'read' }),
			closedDuringDialog: await closedDuringDialog.call('pane-a', { appName: 'Finder', bundleId: 'com.apple.finder', requested: 'read' }),
			askedUnknown: unknown.asked.length,
		}, { denied: 'denied', busy: 'busy', unknownPane: 'paneUnresolved', badBundle: 'cancelled', closedDuringDialog: 'paneUnresolved', askedUnknown: 0 });
	});

	test('says the user did not answer when the deadline closes the dialog, but still says cancelled when the caller gave up', async () => {
		const waitForClose = async (cancellation: CancellationToken): Promise<ParadisAgentApprovalOutcome> => {
			if (!cancellation.isCancellationRequested) {
				await Event.toPromise(cancellation.onCancellationRequested);
			}
			return 'cancelled';
		};
		const approvals = { askApproval: (_token: string, _request: IParadisAgentApprovalRequest, cancellation: CancellationToken) => waitForClose(cancellation) };
		const panes = { getInstanceForToken: (token: string) => token === 'pane-a' ? 7 : undefined };
		const prompt = { appName: 'Finder', bundleId: 'com.apple.finder', requested: 'read' };
		const expiring = new ParadisComputerUseApprovalChannel(approvals, panes, 1);
		const lasting = new ParadisComputerUseApprovalChannel(approvals, panes, 60_000);
		const caller = new CancellationTokenSource();
		const withdrawn = lasting.call<{ outcome: ParadisComputerUseApprovalOutcome }>(undefined, 'requestAccess', ['pane-a', prompt], caller.token);
		caller.cancel();
		caller.dispose();
		assert.deepStrictEqual([
			await expiring.call<{ outcome: ParadisComputerUseApprovalOutcome }>(undefined, 'requestAccess', ['pane-a', prompt]),
			await withdrawn,
		], [{ outcome: 'timedOut' }, { outcome: 'cancelled' }]);
	});
});
