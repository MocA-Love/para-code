/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { BrowserViewSharingState, IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { PARADIS_OPENED_TAB_BURST_WINDOW_MS, ParadisOpenedTabGrantResult } from '../../common/paradisAgentBrowserTabs.js';
import { ParadisAgentBrowserOpenedTabsContribution } from '../../electron-browser/paradisAgentBrowserOpenedTabs.contribution.js';
import { IParadisAgentBrowserBindingModel } from '../../electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService } from '../../electron-browser/paradisAgentBrowserTabsService.js';

suite('ParadisAgentBrowserOpenedTabsContribution', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** 開いたタブ 1 枚を、元のタブを使えるペイン pane-a（共有できる）と pane-b（連続の上限で断られる）へ共有させる。 */
	async function setup() {
		const views = store.add(new Emitter<void>());
		const sharing = store.add(new Emitter<BrowserViewSharingState>());
		const bindings = store.add(new Emitter<void>());
		const model = { id: 'opened', sharingState: BrowserViewSharingState.Available, onDidChangeSharingState: sharing.event, setSharedWithAgent: async () => undefined } as unknown as { sharingState: BrowserViewSharingState } & IBrowserViewModel;
		const input = { id: 'opened', model, resolve: async () => model, isDisposed: () => false } as unknown as BrowserEditorInput;
		const known = new Map<string, BrowserEditorInput>();
		const shareCalls: string[] = [];
		const revoked: string[] = [];
		const browserViews = {
			onDidChangeBrowserViews: views.event,
			whenInitialized: Promise.resolve(),
			getKnownBrowserViews: () => known,
		} as unknown as IBrowserViewWorkbenchService;
		const tabs = {
			shareOpenedTab: async (token: string): Promise<ParadisOpenedTabGrantResult> => {
				shareCalls.push(token);
				if (token === 'pane-a') {
					model.sharingState = BrowserViewSharingState.Shared;
					return 'granted';
				}
				return shareCalls.filter(call => call === 'pane-b').length === 1 ? 'burstLimited' : 'granted';
			},
		} as unknown as IParadisAgentBrowserTabsService;
		const bindingModel = {
			onDidChange: bindings.event,
			openerPanesOf: async () => ['pane-a', 'pane-b'],
			getAgentTabOwnersForPage: () => ['pane-a'],
			revokeAgentTab: async (token: string) => { revoked.push(token); },
		} as unknown as IParadisAgentBrowserBindingModel;
		const sharedProcess = {
			getChannel: () => ({
				call: async (method: string) => method === 'listOpenedTabShareMarks' ? [] : true,
			}),
		} as unknown as ISharedProcessService;
		const contribution = store.add(new ParadisAgentBrowserOpenedTabsContribution(browserViews, tabs, bindingModel, sharedProcess, new NullLogService()));
		await timeout(0);
		known.set('opened', input);
		views.fire();
		await timeout(0);
		const unshare = () => {
			model.sharingState = BrowserViewSharingState.Available;
			sharing.fire(BrowserViewSharingState.Available);
		};
		return { contribution, shareCalls, revoked, unshare };
	}

	test('asks again for a pane refused for opening too many tabs at once, after the window has passed', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { shareCalls } = await setup();
		const beforeRetry = [...shareCalls];
		await timeout(PARADIS_OPENED_TAB_BURST_WINDOW_MS + 1);
		assert.deepStrictEqual({ beforeRetry, afterRetry: shareCalls }, { beforeRetry: ['pane-a', 'pane-b'], afterRetry: ['pane-a', 'pane-b', 'pane-b'] });
	}));

	test('does not share the tab again when the user stopped sharing it before the retry', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { shareCalls, revoked, unshare } = await setup();
		unshare();
		await timeout(PARADIS_OPENED_TAB_BURST_WINDOW_MS + 1);
		assert.deepStrictEqual({ shareCalls, revoked }, { shareCalls: ['pane-a', 'pane-b'], revoked: ['pane-a'] });
	}));
});
