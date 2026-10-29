/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';

interface IListInternals {
	_dispatch(ingressLease: object, rpc: { jsonrpc: string; id: number; method: string }): Promise<unknown>;
}

suite('paradisMcpReadOnlyTools in tools/list', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the tools/list answer carries readOnlyHint for the reading tools, including the built-in devtools ones', async () => {
		const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
			_listDevtoolsTools: async () => [
				{ name: 'take_snapshot', description: 'snapshot', inputSchema: { type: 'object' }, annotations: { category: 'debugging', readOnlyHint: false } },
				{ name: 'click', description: 'click', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
			],
			_requireIngressLease: () => { },
			_allToolProviders: () => [],
			_observeSettings: () => ({ settle: false, state: false }),
			_runStepsFlowEnabled: () => false,
			_siteNotesEnabled: () => false,
			_paneRemoteAuthorityOf: () => undefined,
		}) as unknown as IListInternals;
		const result = await service._dispatch({ token: 'pane-token' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { tools: { name: string; annotations?: Record<string, unknown> }[] };
		const annotations = (name: string) => result.tools.find(tool => tool.name === name)?.annotations;
		assert.deepStrictEqual({
			getText: annotations('get_text'),
			clickBy: annotations('click_by'),
			takeSnapshot: annotations('take_snapshot'),
			click: annotations('click'),
		}, {
			getText: { readOnlyHint: true },
			clickBy: undefined,
			takeSnapshot: { category: 'debugging', readOnlyHint: true },
			click: { readOnlyHint: false },
		});
	});
});
