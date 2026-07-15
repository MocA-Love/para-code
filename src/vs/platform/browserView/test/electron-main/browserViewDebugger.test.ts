/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { BrowserView } from '../../electron-main/browserView.js';
import { BrowserViewDebugger } from '../../electron-main/browserViewDebugger.js';

suite('BrowserViewDebugger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports an external Electron debugger detach exactly once and removes transport listeners', async () => {
		const transport = new EventEmitter() as EventEmitter & {
			isAttached(): boolean;
			attach(): void;
			detach(): void;
			sendCommand(method: string): Promise<unknown>;
		};
		let attached = false;
		transport.isAttached = () => attached;
		transport.attach = () => { attached = true; };
		transport.detach = () => { attached = false; };
		transport.sendCommand = async method => method === 'Target.getTargetInfo'
			? { targetInfo: { targetId: 'target-1', type: 'page', title: '', url: '', attached: true, canAccessOpener: false } }
			: {};
		const view = {
			webContents: {
				debugger: transport,
				getOrCreateDevToolsTargetId: () => 'target-1',
				isDestroyed: () => false,
			},
		} as unknown as BrowserView;
		const browserDebugger = new BrowserViewDebugger(view, {} as never);
		let detachEvents = 0;
		const listener = browserDebugger.onDidDetach(() => detachEvents++);

		await browserDebugger.getTargetInfo();
		assert.strictEqual(transport.listenerCount('message'), 1);
		assert.strictEqual(transport.listenerCount('detach'), 1);
		attached = false;
		transport.emit('detach', {}, 'target closed');

		assert.strictEqual(detachEvents, 1);
		assert.strictEqual(transport.listenerCount('message'), 0);
		assert.strictEqual(transport.listenerCount('detach'), 0);
		listener.dispose();
		browserDebugger.dispose();
	});
});
