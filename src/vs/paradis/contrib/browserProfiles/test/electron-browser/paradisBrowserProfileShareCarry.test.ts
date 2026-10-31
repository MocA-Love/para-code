/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { BrowserViewSharingState } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisPaneBinding } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisSwitchKeepingShares } from '../../electron-browser/paradisBrowserProfileShareCarry.js';

suite('paradisSwitchKeepingShares', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * `sharedWith` のペインと共有しているタブ old を切り替え、new に作り直す。切り替えた時点で台帳は古いタブの
	 * 共有を外す（後から読むと空になる）ので、控えが切り替えの前に取られていないと引き継げない。
	 */
	async function run(options: { readonly sharedWith: readonly string[]; readonly switched?: boolean; readonly directlyShareable?: boolean; readonly blocked?: boolean; readonly failFor?: string; readonly currentIsOther?: readonly string[]; readonly otherClosed?: boolean }) {
		// currentIsOther のペインは、ほかのタブ other も共有していて、そちらが current（old は 2 枚目以降）。
		let bindings: IParadisPaneBinding[] = [
			...(options.currentIsOther ?? []).map(token => ({ token, pageId: 'other' } as IParadisPaneBinding)),
			...options.sharedWith.map(token => ({ token, pageId: 'old', ...(options.currentIsOther?.includes(token) ? { additional: true } : {}) } as IParadisPaneBinding)),
		];
		const other = { id: 'other', isDisposed: () => false } as unknown as BrowserEditorInput;
		const bound: string[] = [];
		const replacement = {
			id: 'new',
			resolve: async () => ({
				isDirectlyShareable: options.directlyShareable ?? true,
				sharingState: options.blocked ? BrowserViewSharingState.BlockedByNetworkPolicy : BrowserViewSharingState.Available,
			}),
		} as unknown as BrowserEditorInput;
		const result = await paradisSwitchKeepingShares(
			{ id: 'old' } as BrowserEditorInput,
			async () => {
				bindings = bindings.filter(binding => binding.pageId !== 'old');
				return options.switched === false ? undefined : replacement;
			},
			{
				getBindingsForPage: pageId => bindings.filter(binding => binding.pageId === pageId),
				getBindingForToken: token => bindings.find(binding => binding.token === token && !binding.additional),
			},
			{
				bindTab: async (token, input) => {
					bound.push(`${token}:${input.id}`);
					return token !== options.failFor;
				},
			},
			viewId => viewId === 'other' && !options.otherClosed ? other : undefined,
		);
		return { replaced: result.replacement?.id, sharedPanes: result.sharedPanes, carriedPanes: result.carriedPanes, bound };
	}

	test('re-shares the new tab with every pane the old tab was shared with, keeps each pane\'s current tab, and shares with nobody else', async () => {
		assert.deepStrictEqual([
			await run({ sharedWith: [] }),
			await run({ sharedWith: ['pane-a', 'pane-b'] }),
			await run({ sharedWith: ['pane-a', 'pane-b'], failFor: 'pane-a' }),
			await run({ sharedWith: ['pane-a'], directlyShareable: false }),
			await run({ sharedWith: ['pane-a'], blocked: true }),
			await run({ sharedWith: ['pane-a'], switched: false }),
			await run({ sharedWith: ['pane-a', 'pane-b'], currentIsOther: ['pane-a'] }),
			await run({ sharedWith: ['pane-a'], currentIsOther: ['pane-a'], otherClosed: true }),
		], [
			{ replaced: 'new', sharedPanes: 0, carriedPanes: 0, bound: [] },
			{ replaced: 'new', sharedPanes: 2, carriedPanes: 2, bound: ['pane-a:new', 'pane-b:new'] },
			{ replaced: 'new', sharedPanes: 2, carriedPanes: 1, bound: ['pane-a:new', 'pane-b:new'] },
			{ replaced: 'new', sharedPanes: 1, carriedPanes: 0, bound: [] },
			{ replaced: 'new', sharedPanes: 1, carriedPanes: 0, bound: [] },
			{ replaced: undefined, sharedPanes: 1, carriedPanes: 0, bound: [] },
			// old が current でなかったペインは、current を other へ戻す
			{ replaced: 'new', sharedPanes: 2, carriedPanes: 2, bound: ['pane-a:new', 'pane-a:other', 'pane-b:new'] },
			// 戻す先が閉じられていたら戻さない
			{ replaced: 'new', sharedPanes: 1, carriedPanes: 1, bound: ['pane-a:new'] },
		]);
	});
});
