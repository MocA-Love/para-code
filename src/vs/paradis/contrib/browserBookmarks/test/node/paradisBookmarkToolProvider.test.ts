/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMcpOwningWindowRequest, IParadisMcpPaneTab, IParadisMcpToolCallContext, ParadisMcpCallerKind, ParadisMcpOwningWindowResult } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { ParadisBookmarkToolResult } from '../../common/paradisBookmarkTools.js';
import { ParadisBookmarkToolProvider } from '../../node/paradisBookmarkToolProvider.js';

function createContext(caller: ParadisMcpCallerKind, tabs: readonly (IParadisMcpPaneTab & { readonly current?: boolean })[] = []) {
	const sent: unknown[] = [];
	const context: IParadisMcpToolCallContext = {
		async callOwningWindow<T>(request: IParadisMcpOwningWindowRequest): Promise<ParadisMcpOwningWindowResult<T>> {
			sent.push(request.timeoutMs !== undefined ? [...request.args, request.timeoutMs] : request.args);
			const result: ParadisBookmarkToolResult = { ok: true, data: { received: request.args[1] } };
			return { ok: true, value: result as T };
		},
		getPaneAgentStatus: () => undefined,
		getUnconfirmedRelease: () => undefined,
		hasAgentHookHistory: () => false,
		classifyCaller: async () => caller,
		getPaneTab: async tabId => {
			const tab = tabs.find(candidate => tabId !== undefined ? candidate.tabId === tabId : candidate.current);
			return tab ? { tabId: tab.tabId, url: tab.url, title: tab.title } : undefined;
		},
	};
	return { context, sent };
}

function text(result: unknown): string {
	const content = (result as { content: { text: string }[]; isError?: boolean });
	return `${content.isError ? 'error: ' : ''}${content.content[0].text}`;
}

suite('ParadisBookmarkToolProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lets SSH panes read but not change bookmarks, and refuses unverified callers', async () => {
		const provider = new ParadisBookmarkToolProvider();
		const ssh = createContext('tunnel');
		const unverified = createContext('unverified');
		const results = [
			await provider.callTool('pane', 'list_bookmarks', {}, undefined, ssh.context),
			await provider.callTool('pane', 'edit_bookmarks', { action: 'create_folder', title: 'Docs' }, undefined, ssh.context),
			await provider.callTool('pane', 'list_bookmarks', {}, undefined, unverified.context),
			await provider.callTool('pane', 'edit_bookmarks', { action: 'create_folder', title: 'Docs' }, undefined, unverified.context),
			await provider.callTool('pane', 'list_bookmarks', {}),
		].map(text);
		assert.deepStrictEqual({
			results: results.map(result => result.split('.')[0]),
			sent: [...ssh.sent, ...unverified.sent],
			other: await provider.callTool('pane', 'list_browser_tabs', {}, undefined, ssh.context),
		}, {
			results: [
				'{\n  "received": {\n    "op": "list"\n  }\n}',
				'error: Agents on an SSH host can read the bookmarks with list_bookmarks but cannot change them',
				'error: Para Code could not confirm that this request comes from a process inside a Para Code terminal pane, so it refuses the request',
				'error: Para Code could not confirm that this request comes from a process inside your own terminal pane, so it does not change bookmarks',
				'error: Para Code could not confirm that this request comes from a process inside a Para Code terminal pane, so it refuses the request',
			],
			sent: [['pane', { op: 'list' }]],
			other: undefined,
		});
	});

	test('bookmarks the current tab or the given tab when the url is omitted, and only http or https pages', async () => {
		const provider = new ParadisBookmarkToolProvider();
		const { context, sent } = createContext('pane', [
			{ tabId: 'tab-1', url: 'https://current.example/page', title: 'Current\npage', current: true },
			{ tabId: 'tab-2', url: 'https://other.example/', title: 'Other' },
			{ tabId: 'tab-3', url: 'about:blank', title: '' },
		]);
		const results = [
			await provider.callTool('pane', 'edit_bookmarks', { action: 'add' }, undefined, context),
			await provider.callTool('pane', 'edit_bookmarks', { action: 'add', tab_id: 'tab-2', title: 'Mine', folder_id: 'f1' }, undefined, context),
			await provider.callTool('pane', 'edit_bookmarks', { action: 'add', tab_id: 'tab-3' }, undefined, context),
			await provider.callTool('pane', 'edit_bookmarks', { action: 'add', tab_id: 'tab-9' }, undefined, context),
			await provider.callTool('pane', 'edit_bookmarks', { action: 'move', id: 'b1' }, undefined, context),
			await provider.callTool('pane', 'edit_bookmarks', { action: 'delete', id: 'b1' }, undefined, context),
		].map(text);
		assert.deepStrictEqual({ errors: results.filter(result => result.startsWith('error: ')).map(result => result.split('.')[0]), sent }, {
			errors: [
				'error: That tab does not show an http or https page, so Para Code does not bookmark it',
				'error: This terminal pane has no browser tab to bookmark (or tab_id is not one of its tabs)',
			],
			sent: [
				['pane', { op: 'add', url: 'https://current.example/page', title: 'Current page', folderId: null }],
				['pane', { op: 'add', url: 'https://other.example/', title: 'Mine', folderId: 'f1' }],
				['pane', { op: 'move', id: 'b1', folderId: null }],
				// 削除は利用者の確認を待つので、ウィンドウへの呼び出しを長く待つ
				['pane', { op: 'delete', id: 'b1', recursive: false }, 60_000],
			],
		});
	});
});
