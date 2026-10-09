/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisToolCallLanes } from '../../common/paradisToolCallLanes.js';
import { paradisAgentTabScopeKey } from '../../common/paradisAgentTabScope.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';

const TOKEN = 'pane-token';
const TAB_KEY = paradisAgentTabScopeKey(TOKEN, 'tab-1');

interface IObserveServiceInternals {
	_callTool(ingressLease: object, params: { name?: unknown; arguments?: unknown }, signal?: AbortSignal): Promise<unknown>;
	_callToolObserved(ingressLease: object, name: string, params: { name?: unknown; arguments?: unknown }, options: { settle: boolean; state: boolean }): Promise<unknown>;
	_observeHost(ingressLease: object, tabLease: object, signal?: AbortSignal): { network(): unknown; isCurrent(): boolean; sleep(ms: number): Promise<void> };
	_runInLane(key: string, heldLane: string | undefined, operation: () => Promise<unknown>): Promise<unknown>;
	_toolCallLanes: ParadisToolCallLanes;
}

/** _callToolObserved が使う所だけを持つサービス（タブの解決・列・観測・操作は差し替える）。 */
function service(log: string[], overrides: Record<string, unknown> = {}): IObserveServiceInternals {
	const lanes = new ParadisToolCallLanes();
	const binding = { pageId: 'page-1' };
	let defaultTab = 'tab-1';
	return Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
		_toolCallLanes: lanes,
		_requireIngressLease: () => { },
		isIngressLeaseCurrent: () => true,
		// tab_id が無ければ今の既定のタブを使う（本物の _scopeToolCall と同じ）
		_scopeToolCall: (_lease: object, args: unknown) => {
			const tabId = (args as { tab_id?: string } | undefined)?.tab_id ?? defaultTab;
			return { ok: true, lease: { token: TOKEN, pageKey: paradisAgentTabScopeKey(TOKEN, tabId) }, args, tabId };
		},
		_bindingForKey: () => binding,
		_browserObserver: {
			before: async () => {
				log.push(`before busy=${lanes.isBusy(TAB_KEY)}`);
				// 観測の間に、利用者が別のタブへ切り替えた
				defaultTab = 'tab-2';
				return { name: 'n', installed: true };
			},
			after: async (_host: object, stateKey: string) => {
				log.push(`after ${stateKey} busy=${lanes.isBusy(TAB_KEY)}`);
				return 'observed';
			},
		},
		_callToolInner: async (_lease: object, params: { name: string; arguments?: unknown }, _signal: unknown, _socket: unknown, heldLane?: string) => {
			log.push(`inner ${params.name} ${JSON.stringify(params.arguments)} held=${heldLane === TAB_KEY}`);
			return { content: [{ type: 'text', text: 'done' }] };
		},
		_cdpGateway: { getNetworkActivity: (key: string) => { log.push(`network ${key}`); return { inflight: 0, quietMs: 1000 }; } },
		_devtoolsProxy: { evaluateObserves: true },
		...overrides,
	}) as unknown as IObserveServiceInternals;
}

suite('Paradis browser observe in the service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the action goes to the tab chosen before observing, inside one turn of that tab\'s lane', async () => {
		const log: string[] = [];
		const result = await service(log)._callToolObserved({ token: TOKEN }, 'click_by', { name: 'click_by', arguments: { role: 'button', settle_ms: 500 } }, { settle: true, state: false });
		assert.deepStrictEqual({ log, result }, {
			log: [
				'before busy=true',
				'inner click_by {"role":"button","tab_id":"tab-1"} held=true',
				`after ${TAB_KEY} busy=true`,
			],
			result: { content: [{ type: 'text', text: 'done' }, { type: 'text', text: 'observed' }] },
		});
	});

	test('run_steps gives the lane back while its steps run, and the agent\'s own tab_id is kept', async () => {
		const log: string[] = [];
		await service(log)._callToolObserved({ token: TOKEN }, 'run_steps', { name: 'run_steps', arguments: { steps: [], tab_id: 'tab-1' } }, { settle: true, state: false });
		assert.deepStrictEqual(log, [
			'before busy=true',
			'inner run_steps {"steps":[],"tab_id":"tab-1"} held=false',
			`after ${TAB_KEY} busy=true`,
		]);
	});

	test('the page is not observed after the action when the tab\'s share changed during it', async () => {
		const log: string[] = [];
		let calls = 0;
		const result = await service(log, { _bindingForKey: () => ({ pageId: `page-${++calls < 2 ? 1 : 2}` }) })._callToolObserved({ token: TOKEN }, 'click', { name: 'click', arguments: { uid: '1_2' } }, { settle: true, state: false });
		assert.deepStrictEqual({ after: log.some(line => line.startsWith('after')), result }, { after: false, result: { content: [{ type: 'text', text: 'done' }] } });
	});

	test('the network wait looks at the tab, not the whole pane', () => {
		const log: string[] = [];
		service(log)._observeHost({ token: TOKEN }, { token: TOKEN, pageKey: TAB_KEY }).network();
		assert.deepStrictEqual(log, [`network ${TAB_KEY}`]);
	});
	test('a caller that cannot be verified is refused before it queues on the tab\'s lane', async () => {
		const log: string[] = [];
		const svc = service(log, {
			_cursorPacing: { begin: () => ({ dispose: () => { } }) },
			_classifyCaller: async () => {
				log.push(`classify busy=${svc._toolCallLanes.isBusy(TAB_KEY)}`);
				return 'unverified';
			},
		});
		const result = await svc._callTool({ token: TOKEN }, { name: 'click_by', arguments: { role: 'button' } }) as { isError?: boolean };
		assert.deepStrictEqual({ log, isError: result.isError }, { log: ['classify busy=false'], isError: true });
	});

	test('a cancelled call stops waiting for the page to settle', async () => {
		const log: string[] = [];
		const controller = new AbortController();
		controller.abort();
		const host = service(log)._observeHost({ token: TOKEN }, { token: TOKEN, pageKey: TAB_KEY }, controller.signal);
		const started = Date.now();
		await host.sleep(10_000);
		assert.deepStrictEqual({ current: host.isCurrent(), quick: Date.now() - started < 1000 }, { current: false, quick: true });
	});

	test('when the tab changed while the call waited in the lane, it is not observed and gives the lane back first', async () => {
		const log: string[] = [];
		let scopes = 0;
		const svc = service(log, {
			_scopeToolCall: (_lease: object, args: unknown) => {
				const tabId = ++scopes < 2 ? 'tab-1' : 'tab-9';
				return { ok: true, lease: { token: TOKEN, pageKey: paradisAgentTabScopeKey(TOKEN, tabId) }, args, tabId };
			},
		});
		await svc._callToolObserved({ token: TOKEN }, 'click', { name: 'click', arguments: { uid: '1_2' } }, { settle: true, state: false });
		assert.deepStrictEqual(log, ['inner click {"uid":"1_2"} held=false']);
	});

	test('a call that holds one tab\'s lane is refused instead of queuing on another tab\'s lane', async () => {
		const svc = service([]);
		const result = await svc._runInLane(paradisAgentTabScopeKey(TOKEN, 'tab-2'), TAB_KEY, async () => 'ran') as { isError?: boolean; content?: { text: string }[] };
		assert.deepStrictEqual({ isError: result.isError, retryable: result.content?.[0].text.startsWith('PARA_BROWSER_RETRYABLE') }, { isError: true, retryable: true });
	});

});
