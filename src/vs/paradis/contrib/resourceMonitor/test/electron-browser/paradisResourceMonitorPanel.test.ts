/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IParadisResourceMonitorSnapshot } from '../../common/paradisResourceMonitor.js';
import { ParadisResourceMonitorPanel } from '../../electron-browser/paradisResourceMonitorPanel.js';

suite('ParadisResourceMonitorPanel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createPanel(switchToScope: (stateKey: string) => void = () => { }): { panel: ParadisResourceMonitorPanel; container: HTMLElement } {
		const container = mainWindow.document.createElement('div');
		const anchor = mainWindow.document.createElement('div');
		const panel = store.add(new ParadisResourceMonitorPanel(anchor, {
			initialSnapshot: undefined,
			onManualRefresh: () => { },
			onClose: () => { },
			switchToScope,
			machines: [{ id: 'local', label: 'This Computer' }],
			selectedMachineId: 'local',
			initialSystemUsage: undefined,
			onSelectMachine: () => { },
			onOpenDetails: () => { },
		}, { activeContainer: container } as unknown as ILayoutService, NullHoverService));
		return { panel, container };
	}

	function snapshot(): IParadisResourceMonitorSnapshot {
		const usage = { cpu: 1, memory: 100 };
		return { app: { ...usage, main: usage, renderer: usage, other: usage }, scopes: [], totalCpu: 1, totalMemory: 100, hostTotalMemory: 1000, collectedAt: 5 };
	}

	test('keeps the app breakdown when there is no terminal, and does not rebuild rows for the same snapshot', () => {
		const { panel, container } = createPanel();
		panel.updateSnapshot(snapshot());
		const firstAppRow = container.querySelector('.app-row');
		panel.updateSnapshot(snapshot());
		assert.deepStrictEqual({
			appRows: container.querySelectorAll('.app-row').length,
			empty: container.querySelectorAll('.prm-empty').length,
			sameRow: firstAppRow !== null && container.querySelector('.app-row') === firstAppRow,
		}, { appRows: 1, empty: 1, sameRow: true });
	});

	test('lets the keyboard switch to a space and open or close its terminals, keeping focus across redraws', () => {
		const switched: string[] = [];
		const { panel, container } = createPanel(stateKey => switched.push(stateKey));
		mainWindow.document.body.appendChild(container);
		try {
			const session = { name: 'zsh', pid: 7, cpu: 1, memory: 10 };
			panel.updateSnapshot({ ...snapshot(), scopes: [{ stateKey: 'space-a', scopeName: 'web-app', cpu: 1, memory: 10, sessions: [session] }] });
			const row = container.querySelector<HTMLElement>('.scope-row .prm-row-name')!;
			row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			const chevron = container.querySelector<HTMLButtonElement>('.prm-chevron-btn')!;
			const before = { tabIndex: row.tabIndex, role: row.getAttribute('role'), expanded: chevron.getAttribute('aria-expanded'), sessions: container.querySelectorAll('.session-row').length };
			chevron.focus();
			chevron.click();
			const after = container.querySelector<HTMLButtonElement>('.prm-chevron-btn')!;
			assert.deepStrictEqual({
				before,
				switched,
				expanded: after.getAttribute('aria-expanded'),
				sessions: container.querySelectorAll('.session-row').length,
				focused: mainWindow.document.activeElement === after,
			}, {
				before: { tabIndex: 0, role: 'button', expanded: 'true', sessions: 1 },
				switched: ['space-a'],
				expanded: 'false',
				sessions: 0,
				focused: true,
			});
		} finally {
			container.remove();
		}
	});
});
