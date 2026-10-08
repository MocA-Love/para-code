/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FocusMode } from '../../../../../platform/native/common/native.js';
import { ITerminalInstance } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisNotificationRevealServices, paradisRevealNotifiedPane } from '../../electron-browser/paradisNotificationReveal.js';

/**
 * `landOn` を渡すと、切り替えはそのスペースに着いて終わる (待っている間に別の切り替えが割り込んだ)。
 * 渡さなければ頼まれたスペースに着く。
 */
function createServices(activeStateKey: string | undefined, instances: Map<number, ITerminalInstance>, calls: string[], pendingSwitchTargetKey?: string, landOn?: string): IParadisNotificationRevealServices {
	const workspaceSwitchService = {
		activeStateKey,
		pendingSwitchTargetKey,
		switchToStateKey: async (stateKey: string) => {
			calls.push(`switch:${stateKey}`);
			workspaceSwitchService.activeStateKey = landOn ?? stateKey;
			workspaceSwitchService.pendingSwitchTargetKey = undefined;
		},
	};
	return {
		hostService: {
			focus: async (targetWindow: Window, options?: { mode?: FocusMode }) => {
				calls.push(`focus:${targetWindow === mainWindow ? 'main' : 'other'}:${options?.mode === FocusMode.Force ? 'force' : 'default'}`);
			},
		},
		terminalService: {
			getInstanceFromId: (id: number) => instances.get(id),
			focusInstance: async (instance: ITerminalInstance) => {
				calls.push(`focusInstance:${instance.instanceId}`);
			},
		},
		workspaceSwitchService,
	};
}

function fakeInstance(instanceId: number, isDisposed = false): ITerminalInstance {
	return { instanceId, isDisposed, domElement: undefined } as unknown as ITerminalInstance;
}

suite('ParadisNotificationReveal', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('brings the window forward, switches to the pane space and focuses the pane', async () => {
		const calls: string[] = [];
		const instances = new Map([[7, fakeInstance(7)]]);

		await paradisRevealNotifiedPane(createServices('repo-a', instances, calls), 'worktree:file:///repo-b', 7);
		await paradisRevealNotifiedPane(createServices('repo-a', instances, calls), 'repo-a', 7);
		await paradisRevealNotifiedPane(createServices('repo-a', instances, calls), undefined, 7);
		await paradisRevealNotifiedPane(createServices('repo-a', new Map([[8, fakeInstance(8, true)]]), calls), 'repo-b', 8);

		assert.deepStrictEqual(calls, [
			'focus:main:force', 'switch:worktree:file:///repo-b', 'focusInstance:7',
			'focus:main:force', 'focusInstance:7',
			'focus:main:force', 'focusInstance:7',
			'focus:main:force', 'switch:repo-b',
		]);
	});

	test('switches back to the pane space when a switch away from it is in progress', async () => {
		const calls: string[] = [];
		const instances = new Map([[7, fakeInstance(7)]]);

		// repo-a から repo-b へ切り替えている最中に、repo-a のペインの通知を押した
		await paradisRevealNotifiedPane(createServices('repo-a', instances, calls, 'repo-b'), 'repo-a', 7);
		// 行き先のスペースのペインなら、進行中の切り替えに任せる
		await paradisRevealNotifiedPane(createServices('repo-a', instances, calls, 'repo-b'), 'repo-b', 7);

		assert.deepStrictEqual(calls, [
			'focus:main:force', 'switch:repo-a', 'focusInstance:7',
			'focus:main:force', 'switch:repo-b', 'focusInstance:7',
		]);
	});

	test('does not open the pane when another switch took over while waiting', async () => {
		const calls: string[] = [];
		const instances = new Map([[7, fakeInstance(7)]]);

		// repo-b のペインへ向かう間に、利用者が repo-c へ切り替えた。開くと repo-c のタブに紛れ込む。
		await paradisRevealNotifiedPane(createServices('repo-a', instances, calls, undefined, 'repo-c'), 'repo-b', 7);

		assert.deepStrictEqual(calls, ['focus:main:force', 'switch:repo-b']);
	});
});
