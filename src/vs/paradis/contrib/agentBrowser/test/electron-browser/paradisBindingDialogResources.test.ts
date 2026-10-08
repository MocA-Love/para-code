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
import { IParadisMobileCanvasModel } from '../../../mobileCanvas/electron-browser/paradisMobileCanvasModel.js';
import { IParadisTerminalScopeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { onDidChangeParadisHoveredPane, setParadisHoveredPaneInstanceId } from '../../browser/paradisPaneIndicator.js';
import { IParadisAgentBrowserBindingModel, IParadisPaneDescriptor } from '../../electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService } from '../../electron-browser/paradisAgentBrowserTabsService.js';
import { ParadisBindingDialog } from '../../electron-browser/paradisBindingDialog.js';
import { ParadisBindingDialogDevicePollLease, ParadisBindingDialogPaneListResources, ParadisBindingDialogTabController } from '../../electron-browser/paradisBindingDialogResources.js';
import { IParadisPaneBinding } from '../../common/paradisAgentBrowser.js';

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
				getBindingsForToken: () => [],
				getAgentTabsForToken: () => [],
				getAgentTabOwnersForPage: () => [],
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
			upcastPartial<IParadisAgentBrowserTabsService>({ revokeApprovedProfileTab: () => { } }),
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
			root.remove();
			setParadisHoveredPaneInstanceId(undefined);
		}
	});
});

suite('ParadisBindingDialog several pages shared with one pane', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// ページ B のダイアログで、ページ A を共有中のペインの行は「付け替え」ではなく「追加」として出す。
	// 左の「ページ」一覧の数字は、そのページを共有しているペインの数
	test('a pane sharing another page offers to add this page, and the page list counts every pane sharing each page', () => {
		const root = document.createElement('div');
		document.body.appendChild(root);
		const binding = (token: string, pageId: string, title: string, additional?: true): IParadisPaneBinding => ({
			token, pageId, pageInfo: { url: `https://${pageId}.test`, title }, generation: 1, boundAt: Date.now(), scope: { kind: 'unscoped' }, ...(additional ? { additional } : {}),
		});
		// pane-one は A と C を共有中（A が current）。pane-two は A と B を共有中（B が current）
		const bindings = [
			binding('pane-one', 'page-a', 'Page A'), binding('pane-two', 'page-b', 'Page B'),
			binding('pane-one', 'page-c', 'Page C', true), binding('pane-two', 'page-a', 'Page A', true),
		];
		const pane = (instanceId: number, token: string): IParadisPaneDescriptor => ({
			instanceId, token, title: token, agentKind: 'claude', mcpConnected: true,
			binding: bindings.find(candidate => candidate.token === token && !candidate.additional), bindEligibility: { eligible: true },
		});
		const panes = [pane(1, 'pane-one'), pane(2, 'pane-two')];
		const calls: string[] = [];
		const dialog = new ParadisBindingDialog(
			upcastPartial<IBrowserViewModel>({ id: 'page-b', title: 'Page B', url: 'https://page-b.test', favicon: undefined, onDidChangeTitle: VSCodeEvent.None, onDidChangeSharingState: VSCodeEvent.None }),
			undefined,
			upcastPartial<IParadisAgentBrowserBindingModel>({
				onDidChange: VSCodeEvent.None,
				bindings,
				getPanes: () => panes,
				getPanesForPage: () => panes,
				getBindingsForPage: (pageId: string) => bindings.filter(candidate => candidate.pageId === pageId),
				getBindingsForToken: (token: string) => bindings.filter(candidate => candidate.token === token),
				getAgentTabsForToken: () => [],
				getAgentTabOwnersForPage: () => [],
				refresh: async () => { },
				bindPageToPane: async (_model: IBrowserViewModel, token: string) => { calls.push(`bind:${token}`); return true; },
				unbindPane: async (_model: IBrowserViewModel, token: string) => { calls.push(`unbindPage:${token}`); },
				unbindToken: async (token: string) => { calls.push(`unbindAll:${token}`); },
				getMcpConfigStatus: () => new Promise<never>(() => { }),
			}),
			upcastPartial<ILayoutService>({ activeContainer: root }),
			upcastPartial<IClipboardService>({ writeText: async () => { } }),
			upcastPartial<IParadisMobileCanvasModel>({ onDidChange: VSCodeEvent.None, snapshot: { devices: [], attachments: [] }, loading: false, beginPolling: () => toDisposable(() => { }) }),
			upcastPartial<IParadisTerminalScopeService>({ getStateKeyForInstance: () => undefined }),
			upcastPartial<IParadisAgentBrowserTabsService>({ revokeApprovedProfileTab: () => { } }),
		);
		try {
			const rows = [...root.querySelectorAll<HTMLElement>('.pbd-pane-row')].map(row => ({
				sub: row.querySelector('.pbd-row-sub')?.textContent,
				checked: row.querySelector<HTMLInputElement>('.pbd-switch')!.checked,
				disabled: row.querySelector<HTMLInputElement>('.pbd-switch')!.disabled,
			}));
			const pages = [...root.querySelectorAll<HTMLElement>('.pbd-nav-item')]
				.filter(item => item.querySelector('.pbd-nav-label')?.textContent?.startsWith('Page'))
				.map(item => `${item.querySelector('.pbd-nav-label')?.textContent}:${item.querySelector('.pbd-nav-count')?.textContent ?? '0'}`);
			const firstSwitch = root.querySelector<HTMLInputElement>('.pbd-pane-row .pbd-switch')!;
			firstSwitch.checked = true;
			firstSwitch.dispatchEvent(new Event('change'));
			assert.deepStrictEqual({ rows, pages: pages.sort(), calls }, {
				rows: [
					{ sub: 'ほかに 2 ページを共有中: Page A ほか', checked: false, disabled: false },
					{ sub: rows[1].sub, checked: true, disabled: false },
				],
				pages: ['Page A:2', 'Page B:1', 'Page C:1'],
				// 付け替え（ペインの共有を全部外す）ではなく、このページの共有を足す
				calls: ['bind:pane-one'],
			});
			assert.ok(rows[1].sub?.endsWith('ほかに 1 ページを共有中'), rows[1].sub);
		} finally {
			dialog.dispose();
			root.remove();
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
