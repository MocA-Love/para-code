/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IMarker, Terminal } from '@xterm/xterm';
import { deepStrictEqual, ok, strictEqual } from 'assert';
import { importAMDNodeModule } from '../../../../../../amdX.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ITerminalCommand, TerminalCapability } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import { BufferMarkCapability } from '../../../../../../platform/terminal/common/capabilities/bufferMarkCapability.js';
import { TerminalCapabilityStore } from '../../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import { TestXtermLogger } from '../../../../../../platform/terminal/test/common/terminalTestHelpers.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { MarkNavigationAddon } from '../../../browser/xterm/markNavigationAddon.js';

class TestBufferMarkCapability extends BufferMarkCapability {
	markerIteratorCalls = 0;

	override markers(): IterableIterator<IMarker> {
		this.markerIteratorCalls++;
		if (this.markerIteratorCalls > 2) {
			throw new Error('Buffer mark iterator was requested repeatedly');
		}
		return super.markers();
	}
}

suite('MarkNavigationAddon', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('should consume buffer mark iterators when navigating', async () => {
		const TerminalCtor = (await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js')).Terminal;
		const terminal: Terminal = store.add(new TerminalCtor({
			allowProposedApi: true,
			cols: 80,
			rows: 30,
			logger: TestXtermLogger
		}));
		const capabilities = store.add(new TerminalCapabilityStore());
		const markCapability = store.add(new TestBufferMarkCapability(terminal));
		markCapability.addMark();
		capabilities.add(TerminalCapability.BufferMarkDetection, markCapability);
		const instantiationService = workbenchInstantiationService({
			configurationService: () => new TestConfigurationService()
		}, store);
		const addon = store.add(instantiationService.createInstance(MarkNavigationAddon, capabilities));
		terminal.loadAddon(addon);

		addon.scrollToNextMark(undefined, undefined, false);

		strictEqual(markCapability.markerIteratorCalls, 2);
	});

	// PARA-PATCH: the command guide and the navigation highlights created one xterm marker per
	// line and never disposed it, so hovering between commands piled up markers until erasing
	// the screen froze the window (clearMarkers splices each one out of the marker array).
	test('should dispose the markers it creates for decorations', async () => {
		const TerminalCtor = (await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js')).Terminal;
		const terminal: Terminal = store.add(new TerminalCtor({
			allowProposedApi: true,
			cols: 80,
			rows: 30,
			logger: TestXtermLogger
		}));
		const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
		async function createCommand(): Promise<ITerminalCommand> {
			const marker = terminal.registerMarker();
			await write('command\r\n');
			const executedMarker = terminal.registerMarker();
			await write('output\r\n'.repeat(5));
			const endMarker = terminal.registerMarker();
			ok(marker && executedMarker && endMarker);
			return new class extends mock<ITerminalCommand>() {
				override readonly marker = marker;
				override readonly executedMarker = executedMarker;
				override readonly endMarker = endMarker;
				override getPromptRowCount() { return 1; }
			};
		}
		const first = await createCommand();
		const second = await createCommand();
		const instantiationService = workbenchInstantiationService({
			configurationService: () => new TestConfigurationService()
		}, store);
		const addon = store.add(instantiationService.createInstance(MarkNavigationAddon, store.add(new TerminalCapabilityStore())));
		terminal.loadAddon(addon);

		const counts: number[] = [terminal.markers.length];
		for (let i = 0; i < 10; i++) {
			addon.showCommandGuide(first);
			addon.showCommandGuide(second);
		}
		counts.push(terminal.markers.length);
		addon.showCommandGuide(undefined);
		counts.push(terminal.markers.length);
		for (let i = 0; i < 10; i++) {
			addon.registerTemporaryDecoration(first.marker!, first.endMarker, false);
			addon.revealRange({ start: { x: 1, y: 2 }, end: { x: 5, y: 4 } });
		}
		addon.clear();
		counts.push(terminal.markers.length);

		deepStrictEqual({ counts, firstMarkerDisposed: first.marker!.isDisposed }, {
			counts: [6, 6 + 6, 6, 6],
			firstMarkerDisposed: false
		});
	});
});
