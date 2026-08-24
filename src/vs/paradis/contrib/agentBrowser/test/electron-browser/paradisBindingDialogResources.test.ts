/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter, Event as VSCodeEvent } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IBrowserViewModel } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { IParadisMobileCanvasModel } from '../../../mobileCanvas/electron-browser/paradisMobileCanvasModel.js';
import { IParadisTerminalScopeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { onDidChangeParadisHoveredPane, setParadisHoveredPaneInstanceId } from '../../browser/paradisPaneIndicator.js';
import { IParadisAgentBrowserBindingModel, IParadisPaneDescriptor } from '../../electron-browser/paradisAgentBrowserBindingModel.js';
import { ParadisBindingDialog } from '../../electron-browser/paradisBindingDialog.js';
import { ParadisBindingDialogDevicePollLease, ParadisBindingDialogPaneListResources, ParadisBindingDialogTabController } from '../../electron-browser/paradisBindingDialogResources.js';

suite('ParadisBindingDialogDevicePollLease', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('owns exactly one poll lease only while the devices tab is visible', () => {
		let starts = 0;
		let stops = 0;
		let live = 0;
		const owner = store.add(new ParadisBindingDialogDevicePollLease(() => {
			starts++;
			live++;
			return toDisposable(() => {
				stops++;
				live--;
			});
		}));

		owner.setDevicesVisible(false);
		owner.setDevicesVisible(true);
		owner.setDevicesVisible(true);
		owner.setDevicesVisible(false);
		owner.setDevicesVisible(true);
		owner.dispose();

		assert.deepStrictEqual({ starts, stops, live }, { starts: 2, stops: 2, live: 0 });
	});

	test('acquires the initial poll lease for a devices-first dialog and releases it on disposal', () => {
		let starts = 0;
		let stops = 0;
		const owner = store.add(new ParadisBindingDialogDevicePollLease(() => {
			starts++;
			return toDisposable(() => stops++);
		}));

		owner.setDevicesVisible(true);
		owner.setDevicesVisible(true);
		assert.deepStrictEqual({ starts, stops }, { starts: 1, stops: 0 });

		owner.dispose();
		assert.deepStrictEqual({ starts, stops }, { starts: 1, stops: 1 });
	});
});

suite('ParadisBindingDialogPaneListResources', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('releases only the previous partial-render listeners exactly once', () => {
		const resources = store.add(new ParadisBindingDialogPaneListResources());
		const disposed = [0, 0, 0, 0, 0, 0, 0, 0, 0];

		for (let index = 0; index < 4; index++) {
			resources.add(toDisposable(() => disposed[index]++));
		}
		resources.beginRender();
		for (let index = 4; index < 8; index++) {
			resources.add(toDisposable(() => disposed[index]++));
		}

		assert.deepStrictEqual(disposed, [1, 1, 1, 1, 0, 0, 0, 0, 0]);

		resources.beginRender();
		resources.beginRender();
		resources.add(toDisposable(() => disposed[8]++));
		assert.deepStrictEqual(disposed, [1, 1, 1, 1, 1, 1, 1, 1, 0]);

		resources.dispose();
		resources.dispose();
		resources.beginRender();
		assert.deepStrictEqual(disposed, [1, 1, 1, 1, 1, 1, 1, 1, 1]);
	});

	test('keeps only the current pane-row wiring across partial, full, and disposed renders', () => {
		setParadisHoveredPaneInstanceId(undefined);
		const root = document.createElement('div');
		document.body.appendChild(root);
		const bindingChanges = new Emitter<void>();
		const storageService = new TestStorageService();
		let bindCalls = 0;
		const pane: IParadisPaneDescriptor = {
			instanceId: 17,
			token: 'pane-one',
			title: 'Pane One',
			agentKind: 'codex',
			mcpConnected: true,
			binding: undefined,
			bindEligibility: { eligible: true },
		};
		const pendingBind = new Promise<boolean>(() => { });
		const dialog = new ParadisBindingDialog(
			upcastPartial<IBrowserViewModel>({
				id: 'page-one',
				title: 'Page One',
				url: 'https://example.test',
				favicon: undefined,
				onDidChangeTitle: VSCodeEvent.None,
				onDidChangeSharingState: VSCodeEvent.None,
			}),
			undefined,
			upcastPartial<IParadisAgentBrowserBindingModel>({
				onDidChange: bindingChanges.event,
				bindings: [],
				getPanes: () => [pane],
				getPanesForPage: () => [pane],
				getBindingsForPage: () => [],
				refresh: async () => { },
				bindPageToPane: () => {
					bindCalls++;
					return pendingBind;
				},
				getMcpConfigStatus: () => new Promise<never>(() => { }),
			}),
			upcastPartial<ILayoutService>({ activeContainer: root }),
			upcastPartial<IClipboardService>({ writeText: async () => { } }),
			upcastPartial<IParadisMobileCanvasModel>({
				onDidChange: VSCodeEvent.None,
				snapshot: { devices: [], attachments: [] },
				loading: false,
				beginPolling: () => toDisposable(() => { }),
			}),
			upcastPartial<IParadisTerminalScopeService>({ getStateKeyForInstance: () => undefined }),
			storageService,
		);
		const hoverEvents: (number | undefined)[] = [];
		const hoverListener = onDidChangeParadisHoveredPane(instanceId => hoverEvents.push(instanceId));

		try {
			const search = root.querySelector<HTMLInputElement>('.pbd-list-search input')!;
			const firstRow = root.querySelector<HTMLElement>('.pbd-pane-row')!;
			const firstSwitch = firstRow.querySelector<HTMLInputElement>('.pbd-switch')!;

			search.value = 'missing';
			search.dispatchEvent(new Event('input'));
			hoverEvents.length = 0;
			fireRowHighlightEvents(firstRow);
			firstSwitch.checked = true;
			firstSwitch.dispatchEvent(new Event('change'));
			assert.deepStrictEqual({ hoverEvents, bindCalls }, { hoverEvents: [], bindCalls: 0 });

			search.value = '';
			search.dispatchEvent(new Event('input'));
			const secondRow = root.querySelector<HTMLElement>('.pbd-pane-row')!;
			const secondSwitch = secondRow.querySelector<HTMLInputElement>('.pbd-switch')!;
			hoverEvents.length = 0;
			fireRowHighlightEvents(secondRow);
			secondSwitch.checked = true;
			secondSwitch.dispatchEvent(new Event('change'));
			assert.deepStrictEqual({ hoverEvents, bindCalls }, {
				hoverEvents: [17, undefined, 17, undefined],
				bindCalls: 1,
			});

			bindingChanges.fire();
			hoverEvents.length = 0;
			fireRowHighlightEvents(secondRow);
			secondSwitch.checked = true;
			secondSwitch.dispatchEvent(new Event('change'));
			assert.deepStrictEqual({ hoverEvents, bindCalls }, { hoverEvents: [], bindCalls: 1 });

			const finalRow = root.querySelector<HTMLElement>('.pbd-pane-row')!;
			const finalSwitch = finalRow.querySelector<HTMLInputElement>('.pbd-switch')!;
			fireRowHighlightEvents(finalRow);
			assert.deepStrictEqual(hoverEvents, [17, undefined, 17, undefined]);

			dialog.dispose();
			finalSwitch.checked = true;
			finalSwitch.dispatchEvent(new Event('change'));
			assert.strictEqual(bindCalls, 1);
		} finally {
			hoverListener.dispose();
			dialog.dispose();
			bindingChanges.dispose();
			storageService.dispose();
			root.remove();
			setParadisHoveredPaneInstanceId(undefined);
		}
	});
});

function fireRowHighlightEvents(row: HTMLElement): void {
	for (const type of ['mouseenter', 'mouseleave', 'focusin', 'focusout']) {
		row.dispatchEvent(new Event(type));
	}
}

suite('ParadisBindingDialogTabController', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createController(events: string[]): ParadisBindingDialogTabController {
		const controller = store.add(new ParadisBindingDialogTabController(
			() => {
				events.push('poll:start');
				return toDisposable(() => events.push('poll:stop'));
			},
			() => events.push(`render:${controller.activeTab}`),
		));
		return controller;
	}

	test('starts a normal dialog on panes and delegates every transition before rendering', () => {
		const events: string[] = [];
		const controller = createController(events);

		controller.initialize(true);
		controller.setActiveTab('devices');
		controller.setActiveTab('devices');
		controller.setActiveTab('mcp');
		controller.setActiveTab('devices');
		controller.dispose();

		assert.deepStrictEqual(events, [
			'render:panes',
			'poll:start', 'render:devices',
			'render:devices',
			'poll:stop', 'render:mcp',
			'poll:start', 'render:devices',
			'poll:stop',
		]);
	});

	test('starts a page-less dialog on devices and releases its lease on owner disposal', () => {
		const events: string[] = [];
		const controller = createController(events);

		controller.initialize(false);
		controller.dispose();

		assert.deepStrictEqual(events, ['poll:start', 'render:devices', 'poll:stop']);
	});
});
