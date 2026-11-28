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
import { IParadisDeviceOpenVisible, ParadisDeviceOpenDeferrals, paradisDescribeDeviceOpenSpace } from '../../electron-browser/paradisSimulatorPaneOpener.js';

suite('ParadisDeviceOpenDeferrals', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IState { active: string | undefined; switching: boolean; pending: string | undefined }

	/**
	 * ペイン a は「space-a」、ペイン b は「space-b」、bot はどのスペースにも属さない（今のスペースと答える）。
	 * ペイン u は、再起動の復元で所属を引けず待避されたターミナル。実物の台帳（paradisTerminalScope.contribution.ts）と同じく、
	 * 待避の印は所属として答えず（undefined）、resolveScope は pending を返す。
	 */
	function setup(options?: { readonly pinned?: Record<string, readonly IEditorPart[]>; readonly whileOpening?: (state: IState) => void }) {
		const onDidSwitchScope = store.add(new Emitter<string>());
		const onDidRetireScope = store.add(new Emitter<string>());
		const state: IState = { active: 'space-a', switching: false, pending: undefined };
		const panes = new Map([['pane-a', 1], ['pane-b', 2], ['bot', 3], ['pane-u', 5]]);
		const spaces = new Map<number, string>([[1, 'space-a'], [2, 'space-b']]);
		const attached = new Set(['pane-a|ios:sim-1', 'pane-b|ios:sim-1', 'pane-b|ios:sim-2', 'pane-b|android:serial:emulator-5554', 'bot|ios:sim-1', 'pane-u|ios:sim-1']);
		const opened: { token: string; deviceId: string; where: Omit<IParadisDeviceOpenVisible, 'kind'> }[] = [];
		const booted: string[] = [];
		const pinned = options?.pinned ?? {};
		const services = {
			paneTokenService: { getInstanceForToken: (token: string) => panes.get(token) },
			terminalScopeService: {
				// Bot のペイン（#1267）は所属を持たず、切り替えていなければ今のスペースと答える
				getStateKeyForInstance: (instanceId: number) => instanceId === 3 ? (state.switching ? undefined : state.active) : spaces.get(instanceId),
				resolveScope: (instanceId: number): ParadisBindingScope => instanceId === 5 ? { kind: 'pending' } : spaces.has(instanceId) ? { kind: 'managed', stateKey: spaces.get(instanceId)! } : { kind: 'pending' },
			},
			workspaceSwitchService: {
				get activeStateKey() { return state.active; },
				get isSwitching() { return state.switching; },
				get pendingSwitchTargetKey() { return state.pending; },
				repositories: ['space-a', 'space-b', 'space-c'].map(id => ({ id, name: `name-${id}`, uri: URI.file(`/repos/${id}`) })),
				onDidSwitchScope: onDidSwitchScope.event,
				onDidRetireScope: onDidRetireScope.event,
			},
			worktreeService: { getWorktrees: () => [] },
			auxiliaryWindowScopeService: {
				getPinnedParts: (stateKey?: string) => (stateKey === undefined ? Object.values(pinned).flat() : pinned[stateKey] ?? []) as readonly IAuxiliaryEditorPart[],
			},
		};
		const deferrals: ParadisDeviceOpenDeferrals = store.add(new ParadisDeviceOpenDeferrals({
			...services,
			open: async (token, deviceId, where, unchanged): Promise<void> => {
				// 端末の名前を待つ間（ここで利用者がスペースを切り替えうる）
				options?.whileOpening?.(state);
				if (!unchanged()) {
					return deferrals.openForPane(token, deviceId);
				}
				const { kind: _kind, ...rest } = where;
				opened.push({ token, deviceId, where: rest });
			},
			bootWhileHidden: async deviceId => { booted.push(deviceId); },
			isStillAttached: async (token, deviceId) => attached.has(`${token}|${deviceId}`),
		}));
		// 開く側には切り替えの API（switchToStateKey）を渡していないので、今のスペースを切り替えることはできない。
		// 切り替えるのは利用者（ここで呼ぶ分）だけ
		const switchTo = async (stateKey: string) => {
			state.active = stateKey;
			state.switching = false;
			onDidSwitchScope.fire(stateKey);
			await timeout(1);
		};
		return { deferrals, services, opened, booted, switchTo, state, panes, spaces, attached, onDidRetireScope };
	}

	test('a request from the current space opens right away, as before, but not into a window pinned to another space', async () => {
		const elsewhere = { windowId: 8 } as unknown as IEditorPart;
		const { deferrals, opened, booted } = setup({ pinned: { 'space-b': [elsewhere] } });
		await deferrals.openForPane('pane-a', 'ios:sim-1');
		assert.deepStrictEqual({ opened, booted, waiting: deferrals.waiting() }, {
			opened: [{ token: 'pane-a', deviceId: 'ios:sim-1', where: { exclude: [elsewhere] } }],
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
			opened: [{ token: 'pane-b', deviceId: 'ios:sim-1', where: { exclude: [] } }],
			waiting: { hidden: {}, later: {} },
		});
	});

	test('opens into a window pinned to the space of the pane when there is one', async () => {
		const part = { windowId: 9 } as unknown as IEditorPart;
		const { deferrals, opened } = setup({ pinned: { 'space-b': [part] } });
		await deferrals.openForPane('pane-b', 'android:serial:emulator-5554');
		assert.deepStrictEqual(opened, [{ token: 'pane-b', deviceId: 'android:serial:emulator-5554', where: { parts: [part], stateKey: 'space-b' } }]);
	});

	test('a bot pane belongs to no space, so it opens in the current space', async () => {
		const { deferrals, opened, state } = setup();
		state.active = 'space-b';
		await deferrals.openForPane('bot', 'ios:sim-1');
		assert.deepStrictEqual(opened, [{ token: 'bot', deviceId: 'ios:sim-1', where: { exclude: [] } }]);
	});

	// 待避された所属不明のターミナルは、台帳が所属を答えない（undefined・pending）。勝手に別のスペースへ置かず、今のスペースに裏で開く
	test('a pane whose space is unknown opens in the current space as a background tab, and the dialog says the space is unknown', async () => {
		const { deferrals, services, opened, spaces, panes } = setup();
		await deferrals.openForPane('pane-u', 'ios:sim-1');
		// 一覧に無いスペース（実体を失った worktree）も同じ
		panes.set('pane-z', 4);
		spaces.set(4, 'space-gone');
		await deferrals.openForPane('pane-z', 'ios:sim-3');
		assert.deepStrictEqual({ opened, notes: ['pane-u', 'pane-z', 'pane-a', 'pane-b'].map(token => paradisDescribeDeviceOpenSpace(services, token)) }, {
			opened: [
				{ token: 'pane-u', deviceId: 'ios:sim-1', where: { exclude: [], unknownSpace: true } },
				{ token: 'pane-z', deviceId: 'ios:sim-3', where: { exclude: [], unknownSpace: true } },
			],
			notes: [{ kind: 'unknownSpace' }, { kind: 'unknownSpace' }, undefined, { kind: 'otherSpace', name: 'name-space-b' }],
		});
	});

	test('an approval during a switch, or while the next switch is starting, is decided again after the switch', async () => {
		const { deferrals, opened, state, switchTo } = setup();
		state.switching = true;
		await deferrals.openForPane('pane-a', 'ios:sim-1');
		await deferrals.openForPane('pane-b', 'ios:sim-2');
		state.switching = false;
		state.pending = 'space-c';
		await deferrals.openForPane('bot', 'ios:sim-1');
		const during = { opened: opened.length, waiting: deferrals.waiting() };
		// 切り替え先が space-a なら、pane-a の分は開き、pane-b の分は space-b に控え直す
		state.pending = 'space-a';
		await switchTo('space-a');
		assert.deepStrictEqual({ during, opened, waiting: deferrals.waiting() }, {
			during: { opened: 0, waiting: { hidden: {}, later: { 'ios:sim-1': 'bot', 'ios:sim-2': 'pane-b' } } },
			opened: [{ token: 'bot', deviceId: 'ios:sim-1', where: { exclude: [] } }],
			waiting: { hidden: { 'space-b': { 'ios:sim-2': 'pane-b' } }, later: {} },
		});
	});

	test('drops what waits for a removed space, a closed pane, or a device detached while waiting', async () => {
		const { deferrals, opened, panes, attached, switchTo, onDidRetireScope } = setup();
		await deferrals.openForPane('pane-b', 'ios:sim-1');
		onDidRetireScope.fire('space-b');
		const retired = deferrals.waiting();
		await deferrals.openForPane('pane-b', 'ios:sim-2');
		await deferrals.openForPane('pane-b', 'android:serial:emulator-5554');
		// 控えている間に、利用者かエージェントが端末を外した
		attached.delete('pane-b|android:serial:emulator-5554');
		await switchTo('space-b');
		const detached = [...opened];
		await deferrals.openForPane('pane-b', 'ios:sim-1');
		await switchTo('space-a');
		await deferrals.openForPane('pane-b', 'ios:sim-1');
		panes.delete('pane-b');
		await switchTo('space-b');
		assert.deepStrictEqual({ retired, detached, opened: opened.length, waiting: deferrals.waiting() }, {
			retired: { hidden: {}, later: {} },
			detached: [{ token: 'pane-b', deviceId: 'ios:sim-2', where: { exclude: [] } }],
			opened: 2,
			waiting: { hidden: {}, later: {} },
		});
	});

	test('when the user switches away while the device name is being read, it does not open in the new space', async () => {
		let once = true;
		const fixture = setup({
			whileOpening: state => {
				if (once) {
					once = false;
					state.active = 'space-b';
				}
			},
		});
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
