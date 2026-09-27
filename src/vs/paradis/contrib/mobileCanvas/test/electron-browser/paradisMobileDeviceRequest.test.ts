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

suite('ParadisMobileDeviceRequestChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(outcome: ParadisAgentApprovalOutcome) {
		const asked: { token: string; message: string; detail: readonly string[]; approveLabel: string; alternative: string | undefined; cancellable: boolean }[] = [];
		const channel = new ParadisMobileDeviceRequestChannel(
			{
				askApproval: async (token: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken) => {
					asked.push({ token, message: request.messageTemplate('PANE'), detail: request.detail, approveLabel: request.approveLabel, alternative: request.alternativeLabel, cancellable: cancellation !== CancellationToken.None });
					return outcome;
				},
			},
			{ getInstanceForToken: token => token === 'pane-a' ? 7 : undefined },
			{ getStateKeyForInstance: instanceId => instanceId === 7 ? 'space-1' : undefined },
		);
		const request = (token: string, prompt: object) => channel.call<IParadisMobileDeviceRequestAnswer>(undefined, 'requestDevice', [token, prompt]);
		return { asked, request };
	}

	test('asks through the shared approval dialog with sanitised text and returns the space on approval', async () => {
		const { asked, request } = setup('approve');
		const answer = await request('pane-a', { deviceName: 'iPhone‮ 17', runtime: 'iOS 26.5', reason: 'check\nthe login', replacingDeviceName: 'Pixel 9' });
		assert.deepStrictEqual({ answer, asked: asked.map(entry => ({ ...entry, detailLines: entry.detail.length, detail: undefined })) }, {
			answer: { outcome: 'approved', stateKey: 'space-1' },
			asked: [{
				token: 'pane-a',
				message: asked[0].message,
				detail: undefined,
				detailLines: 4,
				approveLabel: asked[0].approveLabel,
				alternative: undefined,
				cancellable: true,
			}],
		});
		// 双方向制御と改行は落ちている
		assert.ok(asked[0].detail.every(line => !/[‮\n]/.test(line)));
	});

	test('passes refusals through and never asks for a pane that is not in this window', async () => {
		const denied = setup('denied');
		const unknown = setup('approve');
		assert.deepStrictEqual([
			await denied.request('pane-a', { deviceName: 'iPhone 17' }),
			await unknown.request('pane-z', { deviceName: 'iPhone 17' }),
			unknown.asked.length,
		], [{ outcome: 'denied' }, { outcome: 'paneUnresolved' }, 0]);
	});
});
