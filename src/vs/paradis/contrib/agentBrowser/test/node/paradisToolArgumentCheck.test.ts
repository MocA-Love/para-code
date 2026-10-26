/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';
import { PARADIS_MCP_BROWSER_QUERY_TOOLS } from '../../node/paradisBrowserQueryTools.js';
import { paradisToolArgumentProblem } from '../../node/paradisToolArgumentCheck.js';

suite('paradisToolArgumentCheck', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const waitUntil = PARADIS_MCP_BROWSER_QUERY_TOOLS.find(tool => tool.name === 'wait_until')!.inputSchema;
	const withTab = { ...waitUntil, properties: { ...waitUntil.properties, tab_id: { type: 'string', description: 'tabId.' } } };
	const hover = { type: 'object', properties: { uid: { type: 'string', description: 'uid of an element.' }, includeSnapshot: { type: 'boolean' } }, additionalProperties: false };
	const loose = { type: 'object', properties: { uid: { type: 'string' } } };

	test('refuses unknown arguments and wrong types with the right name and unit, and lets matching calls through', () => {
		const problem = (schema: unknown, args: unknown) => paradisToolArgumentProblem('wait_until', schema, args)?.replace(/ Arguments wait_until takes: .*$/, '');
		assert.deepStrictEqual({
			ok: problem(withTab, { tab_id: 't1', predicate: '() => true', timeout_seconds: 30 }),
			nullIsOmitted: problem(withTab, { tab_id: null, selector: '#a' }),
			timeoutMs: problem(withTab, { predicate: '() => true', timeout: '30000' }),
			timeoutSmall: problem(withTab, { selector: '#a', timeout: 30 }),
			millis: problem(withTab, { selector: '#a', timeout_ms: 5000 }),
			tabId: problem(withTab, { tabId: 't1', selector: '#a' }),
			stringNumber: problem(withTab, { selector: '#a', timeout_seconds: '30' }),
			stringBoolean: problem(withTab, { text: 'Save', exact: 'true' }),
			hoverText: paradisToolArgumentProblem('hover', hover, { text: 'Save' })?.replace(/ Call it again.*$/, ''),
			tabIdTolerated: paradisToolArgumentProblem('write_site_note', { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false }, { text: 'x', tab_id: 't1' }),
			tabIdForTabId: paradisToolArgumentProblem('close_browser_tab', { type: 'object', properties: { tabId: { type: 'string', description: 'The tabId of a tab you opened.' } }, additionalProperties: false }, { tab_id: 't1' })?.replace(/ Arguments .*$/, ''),
			tabIdWithTabId: paradisToolArgumentProblem('close_browser_tab', { type: 'object', properties: { tabId: { type: 'string' } }, additionalProperties: false }, { tabId: 't1', tab_id: 't1' }),
			tabIdAlias: paradisToolArgumentProblem('switch_browser_profile', { type: 'object', properties: { profile: { type: 'string' }, tabId: { type: 'string' } }, additionalProperties: false }, { profile: 'work', tab_id: 't1' }),
			looseSchema: paradisToolArgumentProblem('custom', loose, { other: 1 }),
			noSchema: paradisToolArgumentProblem('custom', undefined, { other: 1 }),
			notAnObject: problem(withTab, 'x'),
		}, {
			ok: undefined,
			nullIsOmitted: undefined,
			timeoutMs: 'wait_until was not run: wait_until has no argument "timeout"; use "timeout_seconds" instead: How long to wait (0.5-100, default 10). It is in seconds: 30000 ms is 30.',
			timeoutSmall: 'wait_until was not run: wait_until has no argument "timeout"; use "timeout_seconds" instead: How long to wait (0.5-100, default 10). It is in seconds.',
			millis: 'wait_until was not run: wait_until has no argument "timeout_ms"; use "timeout_seconds" instead: How long to wait (0.5-100, default 10). It is in seconds: 5000 ms is 5.',
			tabId: 'wait_until was not run: wait_until has no argument "tabId"; use "tab_id" instead: tabId.',
			stringNumber: 'wait_until was not run: "timeout_seconds" of wait_until must be a number, not a string ("30"). Pass 30 without quotes.',
			stringBoolean: 'wait_until was not run: "exact" of wait_until must be a boolean, not a string ("true"). Pass true without quotes.',
			hoverText: 'hover was not run: hover has no argument "text". Arguments hover takes: uid, includeSnapshot.',
			tabIdTolerated: undefined,
			tabIdForTabId: 'close_browser_tab was not run: close_browser_tab has no argument "tab_id"; use "tabId" instead: The tabId of a tab you opened.',
			tabIdWithTabId: undefined,
			tabIdAlias: undefined,
			looseSchema: undefined,
			noSchema: undefined,
			notAnObject: undefined,
		});
	});

	test('the service checks tools/call arguments against the schemas it listed, also before any tools/list', async () => {
		interface IInternals {
			_toolArgumentRefusal(ingressLease: object, name: string, args: unknown, signal: AbortSignal | undefined): Promise<unknown>;
			_listedToolSchemas: Map<string, unknown>;
		}
		let devtoolsListed = 0;
		const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
			_listDevtoolsTools: async () => { devtoolsListed++; return [{ name: 'hover', inputSchema: hover }]; },
			_requireIngressLease: () => { },
			_allToolProviders: () => [],
			_observeSettings: () => ({ settle: false, state: false }),
			_runStepsFlowEnabled: () => false,
			_siteNotesEnabled: () => false,
			_siteRecipesEnabled: () => false,
			_snapshotDiffEnabled: () => false,
			_paneRemoteAuthorityOf: () => undefined,
			_listedToolSchemas: new Map(),
		}) as unknown as IInternals;
		const refusal = async (name: string, args: unknown) => {
			const result = await service._toolArgumentRefusal({ token: 'pane' }, name, args, undefined) as { content: { text: string }[]; isError: boolean } | undefined;
			return result === undefined ? undefined : [result.isError, result.content[0].text.split(' Arguments ')[0]];
		};
		assert.deepStrictEqual({
			timeout: await refusal('wait_until', { tab_id: 't1', predicate: '() => true', timeout: '30000' }),
			ok: await refusal('wait_until', { tab_id: 't1', predicate: '() => true', timeout_seconds: 30 }),
			hover: await refusal('hover', { tab_id: 't1', text: 'Save' }),
			unknownTool: await refusal('not_a_tool', { anything: 1 }),
			devtoolsListed,
			remembered: service._listedToolSchemas.has('pane'),
		}, {
			timeout: [true, 'wait_until was not run: wait_until has no argument "timeout"; use "timeout_seconds" instead: How long to wait (0.5-100, default 10). It is in seconds: 30000 ms is 30.'],
			ok: undefined,
			hover: [true, 'hover was not run: hover has no argument "text".'],
			unknownTool: undefined,
			devtoolsListed: 1,
			remembered: true,
		});
	});
});
