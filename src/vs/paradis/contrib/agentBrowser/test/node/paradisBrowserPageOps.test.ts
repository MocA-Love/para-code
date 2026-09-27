/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCdpInputDispatchResult } from '../../common/paradisAgentBrowser.js';
import { IParadisPageOpsBinding, IParadisPageOpsCall, IParadisPageOpsHost, ParadisBrowserPageOps, paradisBuildMouseCommands, paradisPageOpsOwnerKey } from '../../node/paradisBrowserPageOps.js';
import { IParadisResolvedDropTarget } from '../../node/paradisFileDropUpload.js';
import { PARADIS_MCP_PAGE_OPS_TOOLS, PARADIS_PAGE_OPS_TOOL_NAMES } from '../../node/paradisBrowserPageOpsTools.js';

interface IResult {
	readonly content: readonly { readonly text: string }[];
	readonly isError?: boolean;
}

function textOf(result: unknown): string {
	return (result as IResult).content[0].text;
}

function isError(result: unknown): boolean {
	return (result as IResult).isError === true;
}

class FakeHost implements IParadisPageOpsHost {
	readonly notBoundMessage = 'not bound';
	current: IParadisPageOpsBinding | undefined = {
		exactView: { windowId: 1, viewId: 'view', targetId: 'target', viewLease: 'lease' },
		generation: 7,
		pageInfo: { url: 'https://example.com/', title: 'Example Page' },
	};
	readonly mainCalls: { readonly method: string; readonly args: unknown[] }[] = [];
	readonly inputs: Record<string, unknown>[] = [];
	/** Main calls and dispatched inputs, in the order they happened. */
	readonly log: string[] = [];
	mainResults = new Map<string, unknown>([['describeExactViewStorage', { kind: 'pane' }]]);
	inputResult: IParadisCdpInputDispatchResult = { status: 'success', result: {} };
	/** Refuse the n-th dispatch (1-based), as the main process does while the user focuses the page. */
	refuseDispatch: (n: number) => boolean = () => false;
	private dispatchCount = 0;
	filter: { isUriAllowed(url: string): boolean } | undefined;

	binding(): IParadisPageOpsBinding | undefined {
		return this.current;
	}

	async callMain<T>(method: string, args: unknown[]): Promise<T> {
		this.mainCalls.push({ method, args });
		this.log.push(method);
		return this.mainResults.get(method) as T;
	}

	async dispatchInput(_token: string, _binding: IParadisPageOpsBinding, _method: string, paramsJson: string): Promise<IParadisCdpInputDispatchResult> {
		this.dispatchCount++;
		if (this.refuseDispatch(this.dispatchCount)) {
			return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: the bound BrowserView is focused by the user' };
		}
		const params = JSON.parse(paramsJson);
		this.inputs.push(params);
		this.log.push(params.type);
		return this.inputResult;
	}

	networkFilter() {
		return this.filter;
	}
}

function createCall(element?: IParadisResolvedDropTarget): IParadisPageOpsCall {
	return {
		token: 'pane-token',
		requireCurrent: () => { },
		confirmPaneProfile: async profileId => profileId === 'own-profile',
		resolveElement: async () => element ? { ok: true, target: element } : { ok: false, result: { content: [{ type: 'text', text: 'no element' }], isError: true } },
	};
}

const visibleElement: IParadisResolvedDropTarget = { x: 50, y: 60, width: 20, height: 10, inMainFrame: true, viewportWidth: 800, viewportHeight: 600, occluded: false };

suite('paradisBrowserPageOps (shared process)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every tool name has exactly one definition', () => {
		assert.deepStrictEqual(PARADIS_MCP_PAGE_OPS_TOOLS.map(tool => tool.name), [...PARADIS_PAGE_OPS_TOOL_NAMES]);
	});

	test('mouse commands: context click, drag with a held button, wheel', () => {
		const idle = { x: 0, y: 0, buttons: 0 };
		assert.deepStrictEqual(paradisBuildMouseCommands('context_click', { x: 10, y: 20 }, { modifiers: 8 }, idle).commands.map(command => command.params), [
			{ type: 'mouseMoved', x: 10, y: 20, button: 'none', buttons: 0, modifiers: 8 },
			{ type: 'mousePressed', x: 10, y: 20, button: 'right', buttons: 2, clickCount: 1, modifiers: 8 },
			{ type: 'mouseReleased', x: 10, y: 20, button: 'right', buttons: 0, clickCount: 1, modifiers: 8 },
		]);
		const drag = paradisBuildMouseCommands('drag', { x: 0, y: 0 }, { to: { x: 10, y: 0 }, steps: 2 }, idle);
		assert.deepStrictEqual(drag.commands.map(command => [command.params.type, command.params.x, command.params.buttons]), [
			['mouseMoved', 0, 0],
			['mousePressed', 0, 1],
			['mouseMoved', 5, 1],
			['mouseMoved', 10, 1],
			['mouseReleased', 10, 0],
		]);
		assert.deepStrictEqual(drag.next, { x: 10, y: 0, buttons: 0 });
		const down = paradisBuildMouseCommands('down', { x: 1, y: 1 }, {}, idle);
		assert.deepStrictEqual(down.next.buttons, 1);
		assert.deepStrictEqual(paradisBuildMouseCommands('move', { x: 3, y: 1 }, { steps: 1 }, down.next).commands[0].params, { type: 'mouseMoved', x: 3, y: 1, button: 'left', buttons: 1 });
		assert.deepStrictEqual(paradisBuildMouseCommands('wheel', { x: 1, y: 2 }, { deltaY: 300 }, idle).commands[1].params, { type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: 300 });
	});

	test('nothing is done without a shared page', async () => {
		const host = new FakeHost();
		host.current = undefined;
		const ops = new ParadisBrowserPageOps(host);
		const result = await ops.call(createCall(), 'set_extra_http_headers', { headers: { 'X-A': '1' } });
		assert.deepStrictEqual([isError(result), textOf(result), host.mainCalls.length], [true, 'not bound', 0]);
	});

	test('mouse_action refuses to press on a covered element and remembers a held button', async () => {
		const host = new FakeHost();
		const ops = new ParadisBrowserPageOps(host);
		const covered = await ops.call(createCall({ ...visibleElement, occluded: true }), 'mouse_action', { action: 'context_click', uid: 'e1' });
		assert.strictEqual(isError(covered), true);
		assert.strictEqual(host.inputs.length, 0);

		await ops.call(createCall(), 'mouse_action', { action: 'down', x: 5, y: 5 });
		await ops.call(createCall(), 'mouse_action', { action: 'move', x: 15, y: 5, steps: 1 });
		const up = await ops.call(createCall(), 'mouse_action', { action: 'up', x: 15, y: 5 });
		assert.strictEqual(isError(up), false);
		assert.deepStrictEqual(host.inputs.map(input => [input.type, input.buttons]), [
			['mouseMoved', 0], ['mousePressed', 1], ['mouseMoved', 1], ['mouseMoved', 1], ['mouseReleased', 0],
		]);
	});

	test('mouse_action reports refused input (the user is using the page)', async () => {
		const host = new FakeHost();
		host.inputResult = { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: the bound BrowserView is focused by the user' };
		const ops = new ParadisBrowserPageOps(host);
		const result = await ops.call(createCall(), 'mouse_action', { action: 'wheel', x: 1, y: 1, delta_y: 100 });
		assert.deepStrictEqual([isError(result), textOf(result).includes('focused by the user')], [true, true]);
	});

	test('headers, credentials and rules go to electron-main with the owner key and binding generation', async () => {
		const host = new FakeHost();
		host.mainResults.set('applyExactViewPageOverrides', { ok: true, summary: { extraHeaderNames: [], rules: [] } });
		const ops = new ParadisBrowserPageOps(host);
		await ops.call(createCall(), 'set_extra_http_headers', { headers: { 'X-Env': 'test' } });
		await ops.call(createCall(), 'set_http_credentials', { origin: 'https://intranet.example.com', username: 'u', password: 'p' });
		await ops.call(createCall(), 'set_request_rules', { rules: [] });
		await ops.call(createCall(), 'set_extra_http_headers', { headers: {} });
		assert.deepStrictEqual(host.mainCalls.filter(call => call.method === 'applyExactViewPageOverrides').map(call => [call.method, call.args[1], call.args[2], JSON.parse(call.args[3] as string)]), [
			['applyExactViewPageOverrides', paradisPageOpsOwnerKey('pane-token'), 7, { extraHeaders: { headers: { 'X-Env': 'test' }, origins: [] } }],
			['applyExactViewPageOverrides', paradisPageOpsOwnerKey('pane-token'), 7, { credentials: { origin: 'https://intranet.example.com', username: 'u', password: 'p' } }],
			['applyExactViewPageOverrides', paradisPageOpsOwnerKey('pane-token'), 7, { rules: null }],
			['applyExactViewPageOverrides', paradisPageOpsOwnerKey('pane-token'), 7, { extraHeaders: null }],
		]);
		assert.notStrictEqual(paradisPageOpsOwnerKey('pane-token'), 'pane-token');
	});

	test('a user tab is refused with a reason that points to the agent\'s own tabs', async () => {
		const host = new FakeHost();
		host.mainResults.set('applyExactViewPageOverrides', { ok: false, reason: 'userStorage' });
		const ops = new ParadisBrowserPageOps(host);
		const result = await ops.call(createCall(), 'set_http_credentials', { origin: 'https://intranet.example.com', username: 'u', password: 'p' });
		assert.deepStrictEqual([isError(result), textOf(result).includes('open_browser_tab'), textOf(result).includes('p\'')], [true, true, false]);
	});

	test('overrides are refused before reaching electron-main unless the tab uses storage of this pane alone', async () => {
		const results: string[] = [];
		for (const storage of [{ kind: 'user' }, { kind: 'profile', profileId: 'someone-elses' }, { kind: 'profile', profileId: 'own-profile' }, { kind: 'pane' }]) {
			const host = new FakeHost();
			host.mainResults.set('describeExactViewStorage', storage);
			host.mainResults.set('applyExactViewPageOverrides', { ok: true, summary: { extraHeaderNames: [], rules: [] } });
			const ops = new ParadisBrowserPageOps(host);
			const result = await ops.call(createCall(), 'set_request_rules', { rules: [{ url_pattern: '*', action: 'block' }] });
			const apply = host.mainCalls.find(call => call.method === 'applyExactViewPageOverrides');
			results.push(`${isError(result) ? (textOf(result).includes('"private": true') ? 'refused' : 'error') : 'ok'}:${apply ? String(apply.args[4]) : '-'}`);
		}
		assert.deepStrictEqual(results, ['refused:-', 'refused:-', 'ok:own-profile', 'ok:null']);
	});

	test('extra headers can name their origins, and the result says where they go', async () => {
		const host = new FakeHost();
		host.mainResults.set('applyExactViewPageOverrides', { ok: true, summary: { extraHeaderNames: ['X-Flag'], extraHeaderOrigins: ['https://staging.example.com'], rules: [] } });
		const ops = new ParadisBrowserPageOps(host);
		const result = await ops.call(createCall(), 'set_extra_http_headers', { headers: { 'X-Flag': 'on' }, origins: ['https://staging.example.com/any/path'] });
		assert.deepStrictEqual(JSON.parse(host.mainCalls[1].args[3] as string), { extraHeaders: { headers: { 'X-Flag': 'on' }, origins: ['https://staging.example.com'] } });
		assert.strictEqual(textOf(result).includes('https://staging.example.com'), true);
		const invalid = await ops.call(createCall(), 'set_extra_http_headers', { headers: { 'X-Flag': 'on' }, origins: ['file:///etc'] });
		assert.strictEqual(isError(invalid), true);
	});

	test('a button left pressed by a refused action is released before the next mouse input', async () => {
		const host = new FakeHost();
		const ops = new ParadisBrowserPageOps(host);
		// The press goes through, then the user focuses the page: the rest (and the first release attempt) is refused.
		host.refuseDispatch = n => n >= 3 && n <= 4;
		const failed = await ops.call(createCall(), 'mouse_action', { action: 'drag', x: 1, y: 1, to_x: 20, to_y: 1, steps: 2 });
		assert.strictEqual(isError(failed), true);
		await ops.call(createCall(), 'mouse_action', { action: 'move', x: 5, y: 5, steps: 1 });
		assert.deepStrictEqual(host.inputs.map(input => [input.type, input.button]), [
			['mouseMoved', 'none'], ['mousePressed', 'left'],
			['mouseReleased', 'left'],
			['mouseMoved', 'none'],
		]);
	});

	test('cookie headers and redirects into the agent network restrictions are refused before reaching electron-main', async () => {
		const host = new FakeHost();
		host.filter = { isUriAllowed: url => !url.includes('blocked.example') };
		const ops = new ParadisBrowserPageOps(host);
		const cookie = await ops.call(createCall(), 'set_extra_http_headers', { headers: { Cookie: 'session=1' } });
		const redirect = await ops.call(createCall(), 'set_request_rules', { rules: [{ url_pattern: '*', action: 'redirect', redirect_url: 'https://blocked.example/' }] });
		assert.deepStrictEqual([isError(cookie), isError(redirect), host.mainCalls.length], [true, true, 0]);
	});

	test('a result that arrives after the shared page changed is not reported as success', async () => {
		const host = new FakeHost();
		const ops = new ParadisBrowserPageOps(host);
		host.callMain = async <T>(method: string, args: unknown[]): Promise<T> => {
			host.mainCalls.push({ method, args });
			host.current = { ...host.current!, generation: 8 };
			return { ok: true, summary: { extraHeaderNames: [], rules: [] } } as T;
		};
		const result = await ops.call(createCall(), 'set_extra_http_headers', { headers: { 'X-A': '1' } });
		assert.deepStrictEqual([isError(result), textOf(result).startsWith('PARA_BROWSER_RETRYABLE')], [true, true]);
	});

	test('download_by_click registers the wait before clicking and reports the saved path', async () => {
		const host = new FakeHost();
		host.mainResults.set('expectExactViewDownload', 'expectation-1');
		host.mainResults.set('awaitExactViewDownload', { ok: true, started: true, state: 'completed', fileName: 'a.csv', path: '/downloads/a.csv', receivedBytes: 3, totalBytes: 3 });
		const ops = new ParadisBrowserPageOps(host);
		const result = await ops.call(createCall(visibleElement), 'download_by_click', { uid: 'link' });
		assert.deepStrictEqual(host.log, ['expectExactViewDownload', 'mouseMoved', 'mousePressed', 'mouseReleased', 'awaitExactViewDownload']);
		assert.deepStrictEqual([isError(result), textOf(result).includes('/downloads/a.csv'), textOf(result).includes('Show in Folder')], [false, true, true]);
	});

	test('download_by_click stops waiting when the click could not be sent', async () => {
		const host = new FakeHost();
		host.mainResults.set('expectExactViewDownload', 'expectation-1');
		host.inputResult = { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: focused' };
		const ops = new ParadisBrowserPageOps(host);
		const result = await ops.call(createCall(), 'download_by_click', { x: 1, y: 1 });
		assert.strictEqual(isError(result), true);
		assert.deepStrictEqual(host.mainCalls.map(call => call.method), ['expectExactViewDownload', 'cancelExactViewDownload']);
	});

	test('highlight_element turns an element into a viewport rectangle', async () => {
		const host = new FakeHost();
		host.mainResults.set('highlightExactView', true);
		const ops = new ParadisBrowserPageOps(host);
		const result = await ops.call(createCall(visibleElement), 'highlight_element', { uid: 'e1', duration_seconds: 2 });
		assert.strictEqual(isError(result), false);
		assert.deepStrictEqual(host.mainCalls[0].args.slice(1), [{ x: 40, y: 55, width: 20, height: 10 }, 2000]);
	});

	test('save_page_as_pdf leaves the default name to electron-main (the current page title) and keeps a given one', async () => {
		const host = new FakeHost();
		host.mainResults.set('printExactViewToPdf', { ok: true, path: '/downloads/Example Page.pdf', fileName: 'Example Page.pdf', bytes: 10 });
		const ops = new ParadisBrowserPageOps(host);
		const result = await ops.call(createCall(), 'save_page_as_pdf', {});
		await ops.call(createCall(), 'save_page_as_pdf', { file_name: 'report' });
		assert.strictEqual(isError(result), false);
		assert.deepStrictEqual(host.mainCalls.map(call => JSON.parse(call.args[1] as string).fileName), [undefined, 'report.pdf']);
	});
});
