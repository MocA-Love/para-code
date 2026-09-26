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

function createServices(activeStateKey: string | undefined, instances: Map<number, ITerminalInstance>, calls: string[]): IParadisNotificationRevealServices {
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
		workspaceSwitchService: {
			activeStateKey,
			switchToStateKey: async (stateKey: string) => {
				calls.push(`switch:${stateKey}`);
			},
		},
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
});
