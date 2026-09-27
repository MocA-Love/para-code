/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentApprovalRequest, ParadisAgentApprovalOutcome } from '../../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisMobileDeviceRequestAnswer } from '../../common/paradisMobileDeviceOps.js';
import { ParadisMobileDeviceRequestChannel } from '../../electron-browser/paradisMobileDeviceRequest.contribution.js';

/** 双方向制御の文字。ソースに生のまま置かない（表示と中身がずれるため）。 */
const RIGHT_TO_LEFT_OVERRIDE = '\u202E';

suite('ParadisMobileDeviceRequestChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(outcome: ParadisAgentApprovalOutcome, onAsk?: () => void) {
		const asked: { token: string; message: string; detail: readonly string[]; alternative: string | undefined; cooldownKey: string | undefined; cancellable: boolean }[] = [];
		const panes = new Map([['pane-a', 7]]);
		const channel = new ParadisMobileDeviceRequestChannel(
			{
				askApproval: async (token: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken) => {
					asked.push({ token, message: request.messageTemplate('PANE'), detail: request.detail, alternative: request.alternativeLabel, cooldownKey: request.cooldownKey, cancellable: cancellation !== CancellationToken.None });
					onAsk?.();
					return outcome;
				},
			},
			{ getInstanceForToken: token => panes.get(token) },
			{ getStateKeyForInstance: instanceId => instanceId === 7 ? 'space-1' : undefined },
		);
		const call = (method: string, token: string, prompt: object) => channel.call<IParadisMobileDeviceRequestAnswer>(undefined, method, [token, prompt]);
		return { asked, call, panes };
	}

	test('asks through the shared approval dialog with sanitised text, counts denials per device, and returns the space on approval', async () => {
		const { asked, call } = setup('approve');
		const answer = await call('requestDevice', 'pane-a', { deviceId: 'ios:iphone', deviceName: `iPhone${RIGHT_TO_LEFT_OVERRIDE} 17`, runtime: 'iOS 26.5', reason: 'check\nthe login', replacingDeviceName: 'Pixel 9' });
		assert.deepStrictEqual({ answer, asked: asked.map(entry => ({ token: entry.token, lines: entry.detail.length, alternative: entry.alternative, cooldownKey: entry.cooldownKey, cancellable: entry.cancellable })) }, {
			answer: { outcome: 'approved', stateKey: 'space-1' },
			asked: [{ token: 'pane-a', lines: 5, alternative: undefined, cooldownKey: 'mobile-device:ios:iphone', cancellable: true }],
		});
		assert.ok(asked[0].detail.every(line => !line.includes(RIGHT_TO_LEFT_OVERRIDE) && !line.includes('\n')));
	});

	test('asks separately before every install, showing the path, with its own cooldown key', async () => {
		const { asked, call } = setup('approve');
		const answer = await call('approveInstall', 'pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17', path: '/Users/example/DerivedData/Build/My.app' });
		assert.deepStrictEqual({ answer, cooldownKey: asked[0].cooldownKey, showsPath: asked[0].detail.some(line => line.includes('/Users/example/DerivedData/Build/My.app')), lines: asked[0].detail.length }, {
			answer: { outcome: 'approved', stateKey: 'space-1' },
			cooldownKey: 'mobile-install:ios:iphone',
			showsPath: true,
			lines: 3,
		});
	});

	test('passes refusals through, never asks for a pane that is not in this window, and drops an approval for a pane closed meanwhile', async () => {
		const denied = setup('denied');
		const unknown = setup('approve');
		const closing = setup('approve', () => closing.panes.delete('pane-a'));
		assert.deepStrictEqual([
			await denied.call('requestDevice', 'pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17' }),
			await unknown.call('requestDevice', 'pane-z', { deviceId: 'ios:iphone', deviceName: 'iPhone 17' }),
			unknown.asked.length,
			await closing.call('requestDevice', 'pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17' }),
		], [{ outcome: 'denied' }, { outcome: 'paneUnresolved' }, 0, { outcome: 'paneUnresolved' }]);
	});
});
