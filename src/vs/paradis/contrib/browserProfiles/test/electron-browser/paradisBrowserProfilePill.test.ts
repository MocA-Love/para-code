/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BrowserViewStorageScope } from '../../../../../platform/browserView/common/browserView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor } from '../../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { IParadisAgentBrowserBindingModel } from '../../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService } from '../../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { ParadisBrowserProfilePill } from '../../electron-browser/paradisBrowserProfilePill.js';
import { IParadisBrowserProfilesService } from '../../electron-browser/paradisBrowserProfilesService.js';
import { IParadisBrowserSpaceDefaultsService } from '../../electron-browser/paradisBrowserSpaceDefaultsService.js';

suite('ParadisBrowserProfilePill', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** 名前付きプロファイル（または組み込みスコープ）のページにピルを作り、要素と最後のホバーの文を返す。 */
	function render(options: { readonly named: boolean; readonly agentConnected: boolean }): { readonly text: string; readonly classes: string[]; readonly children: string[]; readonly hover: string; readonly ariaLabel: string } {
		const hovers: string[] = [];
		const disposables = store.add(new DisposableStore());
		const pill = disposables.add(new ParadisBrowserProfilePill(
			{ onDidChangeModel: Event.None, model: { id: 'page-1' } } as unknown as BrowserEditor,
			{
				onDidChangeProfiles: Event.None,
				getViewSession: () => options.named ? { scope: BrowserViewStorageScope.Global, profileId: 'p1' } : { scope: BrowserViewStorageScope.Global },
				list: () => [{ id: 'p1', name: '仕事用', color: '#e2a33d', createdAt: 0, lastUsedAt: 0 }],
			} as unknown as IParadisBrowserProfilesService,
			{
				onDidChange: Event.None,
				getBindingsForPage: () => options.agentConnected ? [{ pageId: 'page-1' }] : [],
				getAgentTabOwnersForPage: () => [],
			} as unknown as IParadisAgentBrowserBindingModel,
			{} as IInstantiationService,
			{} as INotificationService,
			{} as IWorkbenchEnvironmentService,
			{} as IParadisBrowserSpaceDefaultsService,
			{ setupManagedHover: () => ({ update: (content: string) => hovers.push(content), show: () => { }, hide: () => { }, dispose: () => { } }) } as unknown as IHoverService,
			{} as IParadisAgentBrowserTabsService,
			{} as IBrowserViewWorkbenchService,
		));
		const element = pill.widgets[0].element;
		const result = {
			text: element.textContent ?? '',
			classes: [...element.classList].sort(),
			children: [...element.children].map(child => child.className.split(' ')[0]),
			hover: hovers.at(-1) ?? '',
			ariaLabel: element.getAttribute('aria-label') ?? '',
		};
		disposables.dispose();
		return result;
	}

	test('shows no agent badge in the pill and keeps the agent in the hover and the aria label instead', () => {
		assert.deepStrictEqual([
			render({ named: true, agentConnected: true }),
			render({ named: false, agentConnected: true }),
			render({ named: true, agentConnected: false }),
		], [
			{
				text: '仕事用',
				classes: ['is-named', 'paradis-browser-profile-pill'],
				children: ['pbp-pill-dot', 'pbp-pill-icon', 'pbp-pill-name', 'pbp-pill-chevron'],
				hover: 'ブラウザプロファイル「仕事用」。Cookie と LocalStorage はこのプロファイルに保存され、次に開いたときも残ります。\nこのページにはエージェントがつながっていて、このプロファイルのログイン状態を使っています。',
				ariaLabel: 'ブラウザプロファイル「仕事用」。Cookie と LocalStorage はこのプロファイルに保存され、次に開いたときも残ります。\nこのページにはエージェントがつながっていて、このプロファイルのログイン状態を使っています。 変更するには選択してください。',
			},
			{
				text: 'グローバル',
				classes: ['paradis-browser-profile-pill'],
				children: ['pbp-pill-dot', 'pbp-pill-icon', 'pbp-pill-name', 'pbp-pill-chevron'],
				hover: 'ブラウザの保存スコープ: グローバル\nこのページにはエージェントがつながっています。',
				ariaLabel: 'ブラウザの保存スコープ: グローバル\nこのページにはエージェントがつながっています。 変更するには選択してください。',
			},
			{
				text: '仕事用',
				classes: ['is-named', 'paradis-browser-profile-pill'],
				children: ['pbp-pill-dot', 'pbp-pill-icon', 'pbp-pill-name', 'pbp-pill-chevron'],
				hover: 'ブラウザプロファイル「仕事用」。Cookie と LocalStorage はこのプロファイルに保存され、次に開いたときも残ります。',
				ariaLabel: 'ブラウザプロファイル「仕事用」。Cookie と LocalStorage はこのプロファイルに保存され、次に開いたときも残ります。 変更するには選択してください。',
			},
		]);
	});
});
