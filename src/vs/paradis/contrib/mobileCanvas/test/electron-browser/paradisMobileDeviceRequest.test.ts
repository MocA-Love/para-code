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
import { IParadisMobileDeviceRequestAnswer } from '../../common/paradisMobileDeviceOps.js';
import { ParadisMobileDeviceRequestChannel } from '../../electron-browser/paradisMobileDeviceRequest.contribution.js';

/** 双方向制御の文字。ソースに生のまま置かない（表示と中身がずれるため）。 */
const RIGHT_TO_LEFT_OVERRIDE = '\u202E';

suite('ParadisMobileDeviceRequestChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(outcome: ParadisAgentApprovalOutcome, onAsk?: () => void, clock = { now: 1_000_000 }) {
		const asked: { token: string; message: string; detail: readonly string[]; alternative: string | undefined; cooldownKey: string | undefined; cancellable: boolean }[] = [];
		const panes = new Map([['pane-a', 7]]);
		const blocked = new Map<string, 'recentlyDenied' | 'busy'>();
		const channel = new ParadisMobileDeviceRequestChannel(
			{
				approvalBlock: (token: string, cooldownKey?: string) => blocked.get(`${token}|${cooldownKey}`),
				askApproval: async (token: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken) => {
					asked.push({ token, message: request.messageTemplate('PANE'), detail: request.detail, alternative: request.alternativeLabel, cooldownKey: request.cooldownKey, cancellable: cancellation !== CancellationToken.None });
					onAsk?.();
					return outcome;
				},
			},
			{ getInstanceForToken: token => panes.get(token) },
			{ getStateKeyForInstance: instanceId => instanceId === 7 ? 'space-1' : undefined },
			() => clock.now,
		);
		const call = (method: string, token: string, prompt: object) => channel.call<IParadisMobileDeviceRequestAnswer>(undefined, method, [token, prompt]);
		return { asked, call, panes, clock, blocked };
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

	test('asks separately before every install, showing the copied app id and the end of a long path, with its own cooldown key', async () => {
		const { asked, call } = setup('approve');
		const deepPath = `/Users/example/${'Library/Developer/Xcode/DerivedData/'.repeat(8)}Build/Products/Debug-iphonesimulator/My.app`;
		const answer = await call('approveInstall', 'pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17', path: deepPath, appId: 'com.example.myapp', appName: 'My App' });
		const unknown = setup('approve');
		await unknown.call('approveInstall', 'pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17', path: '/b/app.apk' });
		assert.deepStrictEqual({
			answer,
			cooldownKey: asked[0].cooldownKey,
			showsApp: asked[0].detail.some(line => line.includes('com.example.myapp') && line.includes('My App')),
			keepsFileName: asked[0].detail.some(line => line.includes('\u2026') && line.endsWith('Debug-iphonesimulator/My.app')),
			lines: asked[0].detail.length,
			unknownSaysSo: unknown.asked[0].detail[0] !== asked[0].detail[0] && !unknown.asked[0].detail[0].includes('com.'),
		}, {
			answer: { outcome: 'approved', stateKey: 'space-1' },
			cooldownKey: 'mobile-install:ios:iphone',
			showsApp: true,
			keepsFileName: true,
			lines: 5,
			unknownSaysSo: true,
		});
	});

	test('the install pre-check reports the same refusal the approval would give, without showing anything', async () => {
		const { asked, call, blocked } = setup('approve');
		blocked.set('pane-a|mobile-install:ios:iphone', 'recentlyDenied');
		assert.deepStrictEqual([
			await call('precheckInstall', 'pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17' }),
			await call('precheckInstall', 'pane-a', { deviceId: 'android:pixel', deviceName: 'Pixel 9' }),
			await call('precheckInstall', 'pane-z', { deviceId: 'ios:iphone', deviceName: 'iPhone 17' }),
			asked.length,
		], [{ outcome: 'recentlyDenied' }, { outcome: 'clear' }, { outcome: 'paneUnresolved' }, 0]);
	});

	test('right after a denied device request, requests for other devices from that pane are refused without a dialog for 10 seconds', async () => {
		const { asked, call, clock } = setup('denied');
		const first = await call('requestDevice', 'pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17' });
		clock.now += 9_000;
		const otherDeviceSoon = await call('requestDevice', 'pane-a', { deviceId: 'android:pixel', deviceName: 'Pixel 9' });
		const installSoon = await call('approveInstall', 'pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17', path: '/b/My.app' });
		clock.now += 2_000;
		const otherDeviceLater = await call('requestDevice', 'pane-a', { deviceId: 'android:pixel', deviceName: 'Pixel 9' });
		assert.deepStrictEqual([first, otherDeviceSoon, installSoon, otherDeviceLater, asked.map(entry => entry.cooldownKey)], [
			{ outcome: 'denied' },
			{ outcome: 'recentlyDenied' },
			{ outcome: 'denied' },
			{ outcome: 'denied' },
			['mobile-device:ios:iphone', 'mobile-install:ios:iphone', 'mobile-device:android:pixel'],
		]);
	});

	test('says the user did not answer when the deadline closes the dialog, but still says cancelled when the caller gave up', async () => {
		const waitForClose = async (cancellation: CancellationToken): Promise<ParadisAgentApprovalOutcome> => {
			if (!cancellation.isCancellationRequested) {
				await Event.toPromise(cancellation.onCancellationRequested);
			}
			return 'cancelled';
		};
		const approvals = { approvalBlock: () => undefined, askApproval: (_token: string, _request: IParadisAgentApprovalRequest, cancellation: CancellationToken) => waitForClose(cancellation) };
		const panes = { getInstanceForToken: (token: string) => token === 'pane-a' ? 7 : undefined };
		const scopes = { getStateKeyForInstance: () => undefined };
		const expiring = new ParadisMobileDeviceRequestChannel(approvals, panes, scopes, Date.now, 1);
		const lasting = new ParadisMobileDeviceRequestChannel(approvals, panes, scopes, Date.now, 60_000);
		const caller = new CancellationTokenSource();
		const withdrawn = lasting.call<IParadisMobileDeviceRequestAnswer>(undefined, 'requestDevice', ['pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17' }], caller.token);
		caller.cancel();
		caller.dispose();
		assert.deepStrictEqual([
			await expiring.call<IParadisMobileDeviceRequestAnswer>(undefined, 'requestDevice', ['pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17' }]),
			await expiring.call<IParadisMobileDeviceRequestAnswer>(undefined, 'approveInstall', ['pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17', path: '/b/My.app' }]),
			await withdrawn,
		], [{ outcome: 'timedOut' }, { outcome: 'timedOut' }, { outcome: 'cancelled' }]);
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
