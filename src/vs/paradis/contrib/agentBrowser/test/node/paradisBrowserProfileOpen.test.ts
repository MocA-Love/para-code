/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// open_browser_profile の viewport の引数と、画面に出ていないスペースで開いたときの答え（Q670）。
// ペインのウィンドウへの呼び出しは差し替え、shared process 側の組み立てだけを見る。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisOpenProfileResult, PARADIS_BROWSER_PROFILE_MCP_METHOD } from '../../../browserProfiles/common/paradisBrowserProfileMcp.js';
import { IParadisSetViewportResult, ParadisViewportMcpMethod } from '../../../browserViewport/common/paradisBrowserViewport.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';
import { PARADIS_MCP_LOCAL_TOOLS } from '../../node/paradisBrowserMcpShimCore.js';

interface IWindowCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

interface IProfileOpenInternals {
	_openBrowserProfile(lease: { readonly token: string }, profile: string | undefined, url: string | undefined, signal?: AbortSignal, viewport?: string): Promise<{ readonly content: readonly { readonly text: string }[]; readonly isError?: boolean }>;
}

function createService(opened: IParadisOpenProfileResult, sized: IParadisSetViewportResult) {
	const calls: IWindowCall[] = [];
	const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
		_requireIngressLease: () => { },
		_selectTab: () => true,
		_callOwningWindow: async (_lease: unknown, request: { readonly method: string; readonly args: readonly unknown[] }) => {
			calls.push({ method: request.method, args: request.args });
			return { ok: true, value: request.method === ParadisViewportMcpMethod.Set ? sized : opened };
		},
	}) as unknown as IProfileOpenInternals;
	return { service, calls };
}

suite('open_browser_profile (shared process)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('applies the viewport to the opened tab, like open_browser_tab, and says when the space is not on screen', async () => {
		const { service, calls } = createService(
			{ ok: true, profileName: 'PRD', restored: true, bound: true, tabId: 'tab-1', spaceNotVisible: true },
			{ ok: true, previous: { fit: true, mobile: false }, viewport: { fit: false, width: 1920, height: 1080, mobile: false } },
		);
		const result = await service._openBrowserProfile({ token: 'pane-a' }, 'PRD', 'https://example.com/', undefined, '1920x1080');
		const text = result.content[0].text;
		assert.deepStrictEqual({
			calls,
			sized: text.includes('Tab tab-1 is now 1920x1080'),
			hidden: text.includes('opened in this pane\'s space without showing it'),
		}, {
			calls: [
				{ method: PARADIS_BROWSER_PROFILE_MCP_METHOD, args: ['pane-a', 'PRD', 'https://example.com/'] },
				{ method: ParadisViewportMcpMethod.Set, args: ['pane-a', 'tab-1', '1920x1080'] },
			],
			sized: true,
			hidden: true,
		});
	});

	test('does not touch the page size without the viewport argument, and keeps the page open when the size is refused', async () => {
		const plain = createService({ ok: true, profileName: 'PRD', restored: false, bound: true, tabId: 'tab-1' }, { ok: false, reason: 'unknownViewport' });
		await plain.service._openBrowserProfile({ token: 'pane-a' }, 'PRD', undefined);
		const refused = createService({ ok: true, profileName: 'PRD', restored: false, bound: true, tabId: 'tab-1' }, { ok: false, reason: 'unknownViewport' });
		const result = await refused.service._openBrowserProfile({ token: 'pane-a' }, 'PRD', undefined, undefined, 'huge');
		assert.deepStrictEqual(
			[plain.calls.map(call => call.method), result.isError === true, result.content[0].text.includes('The page size was NOT changed')],
			[[PARADIS_BROWSER_PROFILE_MCP_METHOD], false, true],
		);
	});

	test('the tool schema takes the same viewport argument as open_browser_tab', () => {
		const schemaOf = (name: string) => (PARADIS_MCP_LOCAL_TOOLS.find(tool => tool.name === name)?.inputSchema as { readonly properties: Record<string, { readonly type: string }> }).properties.viewport?.type;
		assert.deepStrictEqual([schemaOf('open_browser_profile'), schemaOf('open_browser_tab'), schemaOf('switch_browser_profile')], ['string', 'string', undefined]);
	});
});
