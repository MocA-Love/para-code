/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentApprovalRequest, ParadisAgentApprovalOutcome } from '../../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisMobileDeviceRequestAnswer } from '../../common/paradisMobileDeviceOps.js';
import { ParadisMobileDeviceRequestChannel } from '../../electron-browser/paradisMobileDeviceRequest.contribution.js';
import { IParadisMobileReleasePick } from '../../electron-browser/paradisMobileReleasePickDialog.js';
import { ParadisDeviceOpenSpaceNote } from '../../electron-browser/paradisSimulatorPaneOpener.js';

/** 双方向制御の文字。ソースに生のまま置かない（表示と中身がずれるため）。 */
const RIGHT_TO_LEFT_OVERRIDE = '\u202E';

suite('ParadisMobileDeviceRequestChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(outcome: ParadisAgentApprovalOutcome, onAsk?: () => void, clock = { now: 1_000_000 }, pickRelease?: (pick: IParadisMobileReleasePick) => 'approve' | 'deny') {
		const asked: { token: string; message: string; detail: readonly string[]; alternative: string | undefined; cooldownKey: string | undefined; cancellable: boolean; custom: boolean }[] = [];
		const picks: IParadisMobileReleasePick[] = [];
		const panes = new Map([['pane-a', 7]]);
		const blocked = new Map<string, 'recentlyDenied' | 'busy'>();
		const channel = new ParadisMobileDeviceRequestChannel(
			{
				approvalBlock: (token: string, cooldownKey?: string) => blocked.get(`${token}|${cooldownKey}`),
				askApproval: async (token: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken) => {
					asked.push({ token, message: request.messageTemplate('PANE'), detail: request.detail, alternative: request.alternativeLabel, cooldownKey: request.cooldownKey, cancellable: cancellation !== CancellationToken.None, custom: request.present !== undefined });
					onAsk?.();
					// 独自の確認（外す端末を選ぶ）は、承認のサービスが呼ぶ
					if (request.present) {
						const result = await request.present({ message: request.messageTemplate('PANE'), paneLabel: 'PANE', markerClass: 'marker', token: cancellation });
						return result === 'approve' ? 'approve' : 'denied';
					}
					return outcome;
				},
			},
			{ getInstanceForToken: token => panes.get(token) },
			{ getStateKeyForInstance: instanceId => instanceId === 7 ? 'space-1' : undefined },
			() => clock.now,
			undefined,
			undefined,
			pickRelease ? async pick => {
				picks.push(pick);
				return pickRelease(pick);
			} : undefined,
		);
		const call = (method: string, token: string, prompt: object) => channel.call<IParadisMobileDeviceRequestAnswer>(undefined, method, [token, prompt]);
		return { asked, call, panes, clock, blocked, picks };
	}

	test('asks through the shared approval dialog with sanitised text, counts denials per device, and returns the space on approval', async () => {
		const { asked, call } = setup('approve');
		const answer = await call('requestDevice', 'pane-a', { deviceId: 'ios:iphone', deviceName: `iPhone${RIGHT_TO_LEFT_OVERRIDE} 17`, runtime: 'iOS 26.5', reason: 'check\nthe login', attachedDevices: [{ id: 'android:pixel', name: `Pixel${RIGHT_TO_LEFT_OVERRIDE} 9` }] });
		assert.deepStrictEqual({ answer, asked: asked.map(entry => ({ token: entry.token, lines: entry.detail.length, alternative: entry.alternative, cooldownKey: entry.cooldownKey, cancellable: entry.cancellable })) }, {
			answer: { outcome: 'approved', stateKey: 'space-1' },
			asked: [{ token: 'pane-a', lines: 5, alternative: undefined, cooldownKey: 'mobile-device:ios:iphone', cancellable: true }],
		});
		assert.ok(asked[0].detail.every(line => !line.includes(RIGHT_TO_LEFT_OVERRIDE) && !line.includes('\n')));
	});

	// 要求は「足す」: 今持っている端末と、何台目になるかを見せる（「外れます」とは言わない）
	test('tells the user which devices the pane already has and that the new one is added to them', async () => {
		const { asked, call } = setup('approve');
		const longName = 'とても長い名前のシミュレータ'.repeat(10);
		await call('requestDevice', 'pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17', attachedDevices: [{ id: 'android:pixel', name: 'Pixel 9' }, { id: 'ios:ipad', name: longName }, { name: 'no id' }, 7] });
		const first = setup('approve');
		await first.call('requestDevice', 'pane-a', { deviceId: 'ios:iphone', deviceName: 'iPhone 17', attachedDevices: [] });
		const adding = asked[0].detail.find(line => line.includes('Pixel 9'));
		assert.deepStrictEqual({
			adding: [adding?.includes('2 台'), adding?.includes('3 台目'), adding?.includes('10 台まで'), adding?.includes(longName), asked[0].custom],
			lines: [asked[0].detail.length, first.asked[0].detail.length],
		}, {
			// 長い名前は文の中では切る
			adding: [true, true, true, false, false],
			lines: [4, 3],
		});
	});

	// 別のスペースのペインからの要求は、どのスペースのものか・画面はそのスペースに開くことを書く。スペースが分からなければそう書く
	test('says which space the pane belongs to when it is not the current space, or that the space is unknown', async () => {
		const asked: string[][] = [];
		const make = (note: ParadisDeviceOpenSpaceNote | undefined) => new ParadisMobileDeviceRequestChannel(
			{
				approvalBlock: () => undefined,
				askApproval: async (_token: string, request: IParadisAgentApprovalRequest) => {
					asked.push([...request.detail]);
					return 'approve';
				},
			},
			{ getInstanceForToken: () => 7 },
			{ getStateKeyForInstance: () => 'space-2' },
			Date.now, 60_000, undefined, undefined,
			() => note,
		);
		const prompt = { deviceId: 'ios:iphone', deviceName: 'iPhone 17' };
		await make({ kind: 'otherSpace', name: `repo${RIGHT_TO_LEFT_OVERRIDE}-b` }).call(undefined, 'requestDevice', ['pane-a', prompt]);
		await make({ kind: 'unknownSpace' }).call(undefined, 'requestDevice', ['pane-a', prompt]);
		await make(undefined).call(undefined, 'requestDevice', ['pane-a', prompt]);
		const note = asked[0].find(line => line.includes('repo'));
		assert.deepStrictEqual({
			lines: asked.map(lines => lines.length),
			names: note?.split('「repo -b」').length,
			sanitised: !note?.includes(RIGHT_TO_LEFT_OVERRIDE),
			unknown: asked[1].some(line => line.includes('どのスペースのものか分かりません')),
		}, { lines: [4, 4, 3], names: 3, sanitised: true, unknown: true });
	});

	// 上限まで持っているペインでは、外す 1 台を利用者が選ぶ。選んだ id を返す（台帳がそのペインの端末かを確かめる）
	test('a pane that holds the maximum asks which device to detach and returns the choice', async () => {
		const devices = Array.from({ length: 12 }, (_, index) => ({ id: `ios:sim-${index}`, name: `Sim${RIGHT_TO_LEFT_OVERRIDE} ${index}` }));
		const chosen = setup('approve', undefined, undefined, pick => {
			pick.selectedId = 'ios:sim-4';
			return 'approve';
		});
		const kept = setup('approve', undefined, undefined, () => 'approve');
		const denied = setup('approve', undefined, undefined, () => 'deny');
		// 選ぶ口が無い（古い組み合わせ）ときは、ふつうの確認を出す（台帳が上限で断る）
		const plain = setup('approve');
		const prompt = { deviceId: 'ios:iphone', deviceName: 'iPhone 17', attachedDevices: devices, mustRelease: true };
		assert.deepStrictEqual({
			chosen: await chosen.call('requestDevice', 'pane-a', prompt),
			kept: await kept.call('requestDevice', 'pane-a', prompt),
			denied: await denied.call('requestDevice', 'pane-a', prompt),
			plain: [await plain.call('requestDevice', 'pane-a', prompt), plain.asked[0].custom],
			// 見せるのは上限の 10 台まで。名前は無害化する。初めの選択は、いちばん前に渡したもの
			offered: [chosen.picks[0].devices.length, chosen.picks[0].devices.every(device => !device.name.includes(RIGHT_TO_LEFT_OVERRIDE)), kept.picks[0].devices[0].id],
			custom: chosen.asked[0].custom,
		}, {
			chosen: { outcome: 'approved', stateKey: 'space-1', releaseDeviceId: 'ios:sim-4' },
			kept: { outcome: 'approved', stateKey: 'space-1', releaseDeviceId: 'ios:sim-0' },
			denied: { outcome: 'denied' },
			plain: [{ outcome: 'approved', stateKey: 'space-1' }, false],
			offered: [10, true, 'ios:sim-0'],
			custom: true,
		});
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
				// 閉じたら取り消しの購読を外す（外さないと購読がテストの後まで残り、漏れとして検出される）
				await new Promise<void>(resolve => {
					const listener = cancellation.onCancellationRequested(() => {
						listener.dispose();
						resolve();
					});
				});
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
