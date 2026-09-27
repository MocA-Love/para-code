/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
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

	test('an upgrade offers only deny and operate', async () => {
		const upgrade = setup('approve');
		const outcome = await upgrade.call('pane-a', { appName: 'Notes', bundleId: 'com.apple.Notes', requested: 'operate', offerOperate: true });
		assert.deepStrictEqual({ outcome, alternative: upgrade.asked[0].alternative }, { outcome: 'operate', alternative: undefined });
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
});
