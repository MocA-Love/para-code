/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAuxiliaryEditorPart, IEditorPart } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { ParadisBindingScope } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisDeviceOpenDeferrals } from '../../electron-browser/paradisSimulatorPaneOpener.js';

suite('ParadisDeviceOpenDeferrals', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** ペイン a は「space-a」、ペイン b は「space-b」、bot はどのスペースにも属さない（今のスペースと答える）。 */
	function setup(options?: { readonly pinned?: Record<string, readonly IEditorPart[]>; readonly whileOpening?: () => void }) {
		const onDidSwitchScope = store.add(new Emitter<string>());
		const onDidRetireScope = store.add(new Emitter<string>());
		const state = { active: 'space-a' as string | undefined, switching: false };
		const panes = new Map([['pane-a', 1], ['pane-b', 2], ['bot', 3]]);
		const spaces = new Map<number, string>([[1, 'space-a'], [2, 'space-b']]);
		const opened: { token: string; deviceId: string; parts: readonly IEditorPart[] | undefined }[] = [];
		const booted: string[] = [];
		const deferrals: ParadisDeviceOpenDeferrals = store.add(new ParadisDeviceOpenDeferrals({
			paneTokenService: { getInstanceForToken: token => panes.get(token) },
			terminalScopeService: {
				// Bot のペイン（#1267）は所属を持たず、切り替えていなければ今のスペースと答える
				getStateKeyForInstance: instanceId => instanceId === 3 ? (state.switching ? undefined : state.active) : spaces.get(instanceId),
				resolveScope: (): ParadisBindingScope => ({ kind: 'pending' }),
			},
			workspaceSwitchService: {
				get activeStateKey() { return state.active; },
				get isSwitching() { return state.switching; },
				repositories: ['space-a', 'space-b'].map(id => ({ id, name: id, uri: URI.file(`/repos/${id}`) })),
				onDidSwitchScope: onDidSwitchScope.event,
				onDidRetireScope: onDidRetireScope.event,
			},
			worktreeService: { getWorktrees: () => [] },
			auxiliaryWindowScopeService: { getPinnedParts: (stateKey?: string) => (options?.pinned?.[stateKey ?? ''] ?? []) as readonly IAuxiliaryEditorPart[] },
			open: async (token, deviceId, parts, unchanged): Promise<void> => {
				// 端末の名前を待つ間（ここで利用者がスペースを切り替えうる）
				options?.whileOpening?.();
				if (!unchanged()) {
					return deferrals.openForPane(token, deviceId);
				}
				opened.push({ token, deviceId, parts });
			},
			bootWhileHidden: async deviceId => { booted.push(deviceId); },
		}));
		// 開く側には切り替えの API（switchToStateKey）を渡していないので、今のスペースを切り替えることはできない。
		// 切り替えるのは利用者（ここで呼ぶ分）だけ
		const switchTo = async (stateKey: string) => {
			state.active = stateKey;
			state.switching = false;
			onDidSwitchScope.fire(stateKey);
			await timeout(1);
		};
		return { deferrals, opened, booted, switchTo, state, panes, spaces, onDidRetireScope };
	}

	test('a request from the current space opens right away, as before', async () => {
		const { deferrals, opened, booted } = setup();
		await deferrals.openForPane('pane-a', 'ios:sim-1');
		assert.deepStrictEqual({ opened, booted, waiting: deferrals.waiting() }, {
			opened: [{ token: 'pane-a', deviceId: 'ios:sim-1', parts: undefined }],
			booted: [],
			waiting: { hidden: {}, later: {} },
		});
	});

	test('a request from another space does not open in the current space; it boots the device and opens when the user switches to that space', async () => {
		const { deferrals, opened, booted, state, switchTo } = setup();
		await deferrals.openForPane('pane-b', 'ios:sim-1');
		const before = { opened: [...opened], booted: [...booted], active: state.active, waiting: deferrals.waiting() };
		// 別のスペースへ行っても開かない。元のスペースへ切り替えたときに開く
		await switchTo('space-c');
		const elsewhere = opened.length;
		await switchTo('space-b');
		assert.deepStrictEqual({ before, elsewhere, opened, waiting: deferrals.waiting() }, {
			before: { opened: [], booted: ['ios:sim-1'], active: 'space-a', waiting: { hidden: { 'space-b': { 'ios:sim-1': 'pane-b' } }, later: {} } },
			elsewhere: 0,
			opened: [{ token: 'pane-b', deviceId: 'ios:sim-1', parts: undefined }],
			waiting: { hidden: {}, later: {} },
		});
	});

	test('opens into a window pinned to the space of the pane when there is one', async () => {
		const part = { windowId: 9 } as unknown as IEditorPart;
		const { deferrals, opened } = setup({ pinned: { 'space-b': [part] } });
		await deferrals.openForPane('pane-b', 'android:serial:emulator-5554');
		assert.deepStrictEqual(opened, [{ token: 'pane-b', deviceId: 'android:serial:emulator-5554', parts: [part] }]);
	});

	test('a bot pane belongs to no space, so it opens in the current space', async () => {
		const { deferrals, opened, state } = setup();
		state.active = 'space-b';
		await deferrals.openForPane('bot', 'ios:sim-1');
		assert.deepStrictEqual(opened, [{ token: 'bot', deviceId: 'ios:sim-1', parts: undefined }]);
	});

	test('an approval during a switch is decided again after the switch', async () => {
		const { deferrals, opened, state, switchTo } = setup();
		state.switching = true;
		await deferrals.openForPane('pane-a', 'ios:sim-1');
		await deferrals.openForPane('pane-b', 'ios:sim-2');
		const during = { opened: opened.length, waiting: deferrals.waiting() };
		// 切り替え先が space-a なら、pane-a の分は開き、pane-b の分は space-b に控え直す
		await switchTo('space-a');
		assert.deepStrictEqual({ during, opened, waiting: deferrals.waiting() }, {
			during: { opened: 0, waiting: { hidden: {}, later: { 'ios:sim-1': 'pane-a', 'ios:sim-2': 'pane-b' } } },
			opened: [{ token: 'pane-a', deviceId: 'ios:sim-1', parts: undefined }],
			waiting: { hidden: { 'space-b': { 'ios:sim-2': 'pane-b' } }, later: {} },
		});
	});

	test('drops what waits for a removed space or a closed pane; a pane in a space the user cannot reach gets the device booted but no tab', async () => {
		const { deferrals, opened, booted, panes, spaces, switchTo, onDidRetireScope } = setup();
		await deferrals.openForPane('pane-b', 'ios:sim-1');
		onDidRetireScope.fire('space-b');
		const retired = deferrals.waiting();
		await deferrals.openForPane('pane-b', 'ios:sim-2');
		panes.delete('pane-b');
		await switchTo('space-b');
		// 一覧に無いスペース（実体を失った worktree・所属の分からないターミナルの置き場）のペインは控えないが、起動はする
		panes.set('pane-z', 4);
		spaces.set(4, 'paradis:unattributed-terminals');
		await deferrals.openForPane('pane-z', 'ios:sim-3');
		assert.deepStrictEqual({ retired, opened, booted, waiting: deferrals.waiting() }, {
			retired: { hidden: {}, later: {} },
			opened: [],
			booted: ['ios:sim-1', 'ios:sim-2', 'ios:sim-3'],
			waiting: { hidden: {}, later: {} },
		});
	});

	test('when the user switches away while the device name is being read, it does not open in the new space', async () => {
		const holder: { state?: { active: string | undefined; switching: boolean } } = {};
		let once = true;
		const fixture = setup({
			whileOpening: () => {
				if (once && holder.state) {
					once = false;
					holder.state.active = 'space-b';
				}
			},
		});
		holder.state = fixture.state;
		await fixture.deferrals.openForPane('pane-a', 'ios:sim-1');
		assert.deepStrictEqual({ opened: fixture.opened, waiting: fixture.deferrals.waiting() }, { opened: [], waiting: { hidden: { 'space-a': { 'ios:sim-1': 'pane-a' } }, later: {} } });
	});

	test('the same device requested twice from a hidden space waits once, for the last pane', async () => {
		const { deferrals } = setup();
		await deferrals.openForPane('pane-b', 'ios:sim-1');
		await deferrals.openForPane('pane-b', 'ios:sim-1');
		assert.deepStrictEqual(deferrals.waiting(), { hidden: { 'space-b': { 'ios:sim-1': 'pane-b' } }, later: {} });
	});
});
