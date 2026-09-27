/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { CDPEvent, ICDPConnection } from '../../../../../platform/browserView/common/cdp/types.js';
import { paradisParseRequestRules } from '../../common/paradisBrowserPageOps.js';
import { IParadisLoginAuthInfo, IParadisPageOpsTarget, ParadisBrowserPageOpsController, ParadisLoginListener } from '../../electron-main/paradisBrowserPageOpsController.js';

const OWNER = '0123456789abcdef0123456789abcdef';
const OTHER_OWNER = 'fedcba9876543210fedcba9876543210';

class FakeSession implements ICDPConnection {
	readonly sessionId = 'session';
	readonly targetId = 'target';
	readonly commands: { readonly method: string; readonly params: unknown }[] = [];
	private readonly _onEvent = new Emitter<CDPEvent>();
	readonly onEvent = this._onEvent.event;
	private readonly _onClose = new Emitter<void>();
	readonly onClose = this._onClose.event;
	disposed = false;

	async sendCommand(method: string, params?: unknown): Promise<unknown> {
		this.commands.push({ method, params });
		return {};
	}

	fire(event: CDPEvent): void {
		this._onEvent.fire(event);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this._onClose.fire();
		this._onEvent.dispose();
		this._onClose.dispose();
	}
}

class FakeTarget implements IParadisPageOpsTarget {
	readonly sessions: FakeSession[] = [];
	readonly loginListeners = new Set<ParadisLoginListener>();
	readonly destroyedListeners = new Set<() => void>();
	destroyed = false;
	authCacheClears = 0;
	url = 'https://example.com/';

	readonly webContents = {
		isDestroyed: () => this.destroyed,
		getURL: () => this.url,
		getTitle: () => 'Example',
		once: (_event: 'destroyed', listener: () => void) => { this.destroyedListeners.add(listener); },
		on: (_event: 'login', listener: ParadisLoginListener) => { this.loginListeners.add(listener); },
		removeListener: (event: 'destroyed' | 'login', listener: (() => void) | ParadisLoginListener) => {
			if (event === 'login') {
				this.loginListeners.delete(listener as ParadisLoginListener);
			} else {
				this.destroyedListeners.delete(listener as () => void);
			}
		},
		printToPDF: async () => new Uint8Array([1, 2, 3]),
		session: { clearAuthCache: async () => { this.authCacheClears++; } },
	};

	readonly debugger = {
		attach: async (): Promise<ICDPConnection> => {
			const session = new FakeSession();
			this.sessions.push(session);
			return session;
		},
	};

	destroy(): void {
		this.destroyed = true;
		for (const listener of [...this.destroyedListeners]) {
			listener();
		}
	}

	/** Fires the `login` event Chromium emits for an auth challenge and reports whether it was answered. */
	login(url: string, authInfo: IParadisLoginAuthInfo): { answered: boolean; username?: string; password?: string } {
		const outcome: { answered: boolean; username?: string; password?: string } = { answered: false };
		for (const listener of this.loginListeners) {
			listener({ preventDefault: () => { outcome.answered = true; } }, { url }, authInfo, (username, password) => {
				outcome.username = username;
				outcome.password = password;
			});
		}
		return outcome;
	}
}

function rules(value: unknown) {
	const parsed = paradisParseRequestRules(value);
	assert.ok(parsed.ok);
	return parsed.value;
}

suite('ParadisBrowserPageOpsController', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('extra headers and rules go on one dedicated CDP session with the cache and service workers bypassed, and clearing detaches it', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = new FakeTarget();
		const onlyRules = await controller.apply(target, OWNER, 1, { rules: rules([{ url_pattern: '*/ads/*', action: 'block' }]) });
		assert.ok(onlyRules.ok);
		assert.deepStrictEqual(target.sessions[0].commands.map(command => [command.method, command.params]), [
			['Network.enable', { maxTotalBufferSize: 1048576, maxResourceBufferSize: 1048576 }],
			['Network.setCacheDisabled', { cacheDisabled: true }],
			['Network.setBypassServiceWorker', { bypass: true }],
			['Fetch.enable', { patterns: [{ urlPattern: '*/ads/*', requestStage: 'Request' }] }],
		]);
		const applied = await controller.apply(target, OWNER, 1, { extraHeaders: { headers: { 'X-Env': 'test' }, origins: [] } });
		assert.ok(applied.ok);
		// Headers are added per request by origin, so every request is paused (never Network.setExtraHTTPHeaders).
		assert.deepStrictEqual(target.sessions[0].commands.slice(4).map(command => [command.method, command.params]), [
			['Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }],
		]);
		assert.deepStrictEqual(applied.summary.extraHeaderOrigins, ['https://example.com']);

		const cleared = await controller.apply(target, OWNER, 1, { extraHeaders: null, rules: null });
		assert.deepStrictEqual([cleared.ok, target.sessions[0].disposed, controller.activeTargetCount, target.destroyedListeners.size], [true, true, 0, 0]);
	});

	test('paused requests are blocked, rewritten, redirected, answered or let through', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = new FakeTarget();
		await controller.apply(target, OWNER, 1, {
			rules: rules([
				{ url_pattern: '*/blocked', action: 'block' },
				{ url_pattern: '*/headers', action: 'set_headers', set_headers: { 'X-A': '1' } },
				{ url_pattern: '*/old', action: 'redirect', redirect_url: 'https://example.com/new' },
				{ url_pattern: '*/mock', action: 'respond', status: 201, body: 'hi' },
			]),
		});
		const session = target.sessions[0];
		const before = session.commands.length;
		for (const [id, url] of [['1', 'https://e.test/blocked'], ['2', 'https://e.test/headers'], ['3', 'https://e.test/old'], ['4', 'https://e.test/mock'], ['5', 'https://e.test/other']]) {
			session.fire({ method: 'Fetch.requestPaused', params: { requestId: id, request: { url, headers: { Accept: '*/*' } } } });
		}
		await Promise.resolve();
		assert.deepStrictEqual(session.commands.slice(before), [
			{ method: 'Fetch.failRequest', params: { requestId: '1', errorReason: 'BlockedByClient' } },
			{ method: 'Fetch.continueRequest', params: { requestId: '2', headers: [{ name: 'Accept', value: '*/*' }, { name: 'X-A', value: '1' }] } },
			{ method: 'Fetch.fulfillRequest', params: { requestId: '3', responseCode: 307, responseHeaders: [{ name: 'Location', value: 'https://example.com/new' }, { name: 'Cache-Control', value: 'no-store' }], body: '' } },
			{ method: 'Fetch.fulfillRequest', params: { requestId: '4', responseCode: 201, responseHeaders: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }], body: 'aGk=' } },
			{ method: 'Fetch.continueRequest', params: { requestId: '5' } },
		]);
		const summary = controller.summary(target, OWNER);
		assert.ok(summary.ok);
		assert.deepStrictEqual(summary.summary.rules.map(rule => rule.matched), [1, 1, 1, 1]);
		controller.releaseTarget(target);
	});

	test('extra headers reach only the page origin (or the named origins), never third-party hosts', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = new FakeTarget();
		target.url = 'https://app.example.com/dashboard';
		await controller.apply(target, OWNER, 1, {
			extraHeaders: { headers: { 'X-Flag': 'on' }, origins: [] },
			rules: rules([{ url_pattern: '*/api/*', action: 'set_headers', set_headers: { 'X-Api': '1' } }]),
		});
		const session = target.sessions[0];
		const before = session.commands.length;
		const paused = (id: string, url: string) => session.fire({ method: 'Fetch.requestPaused', params: { requestId: id, request: { url, headers: { Accept: '*/*' } } } });
		paused('1', 'https://app.example.com/page');
		paused('2', 'https://cdn.thirdparty.test/lib.js');
		paused('3', 'https://app.example.com/api/items');
		paused('4', 'https://analytics.thirdparty.test/api/track');
		await Promise.resolve();
		assert.deepStrictEqual(session.commands.slice(before), [
			{ method: 'Fetch.continueRequest', params: { requestId: '1', headers: [{ name: 'Accept', value: '*/*' }, { name: 'X-Flag', value: 'on' }] } },
			{ method: 'Fetch.continueRequest', params: { requestId: '2' } },
			{ method: 'Fetch.continueRequest', params: { requestId: '3', headers: [{ name: 'Accept', value: '*/*' }, { name: 'X-Flag', value: 'on' }, { name: 'X-Api', value: '1' }] } },
			{ method: 'Fetch.continueRequest', params: { requestId: '4', headers: [{ name: 'Accept', value: '*/*' }, { name: 'X-Api', value: '1' }] } },
		]);
		controller.releaseTarget(target);

		const blank = new FakeTarget();
		blank.url = 'about:blank';
		const refused = await controller.apply(blank, OWNER, 1, { extraHeaders: { headers: { 'X-Flag': 'on' }, origins: [] } });
		const named = await controller.apply(blank, OWNER, 1, { extraHeaders: { headers: { 'X-Flag': 'on' }, origins: ['https://staging.example.com'] } });
		assert.deepStrictEqual([refused.ok ? 'ok' : refused.reason, named.ok && named.summary.extraHeaderOrigins], ['invalid', ['https://staging.example.com']]);
		controller.releaseTarget(blank);
	});

	test('only one pane can change a tab, and its overrides go away when its sharing changes', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = new FakeTarget();
		const headers = (name: string) => ({ headers: { [name]: '1' }, origins: [] });
		await controller.apply(target, OWNER, 3, { extraHeaders: headers('X-A') });
		const other = await controller.apply(target, OTHER_OWNER, 9, { extraHeaders: headers('X-B') });
		const otherSummary = controller.summary(target, OTHER_OWNER);
		controller.releaseOwner(OWNER, 4);
		const stale = await controller.apply(target, OWNER, 3, { extraHeaders: headers('X-A') });
		assert.deepStrictEqual([
			other.ok ? 'ok' : other.reason,
			otherSummary.ok ? 'ok' : otherSummary.reason,
			target.sessions[0].disposed,
			controller.activeTargetCount,
			stale.ok ? 'ok' : stale.reason,
		], ['ownedByAnotherPane', 'ownedByAnotherPane', true, 0, 'stale']);
	});

	test('closing the tab removes everything', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = new FakeTarget();
		await controller.apply(target, OWNER, 1, { extraHeaders: { headers: { 'X-A': '1' }, origins: [] }, credentials: { origin: 'https://intranet.example.com', username: 'u', password: 'p' } });
		target.destroy();
		assert.deepStrictEqual([controller.activeTargetCount, target.loginListeners.size, target.sessions[0].disposed], [0, 0, true]);
	});

	test('credentials answer only the exact origin, never proxies, and stop after two answers per realm', async () => {
		let now = 1_000;
		const controller = new ParadisBrowserPageOpsController(() => now);
		const target = new FakeTarget();
		await controller.apply(target, OWNER, 1, { credentials: { origin: 'https://intranet.example.com', username: 'user', password: 'secret' } });
		assert.strictEqual(target.sessions.length, 0, 'credentials alone do not need a CDP session');
		const auth = { isProxy: false, host: 'intranet.example.com', port: 443, realm: 'r' };
		const answers = [
			target.login('https://intranet.example.com/a', auth),
			target.login('https://other.example.com/a', { ...auth, host: 'other.example.com' }),
			target.login('https://intranet.example.com/a', { ...auth, isProxy: true }),
			target.login('https://intranet.example.com:8443/a', { ...auth, port: 8443 }),
			target.login('https://intranet.example.com/a', auth),
			target.login('https://intranet.example.com/a', auth),
		].map(outcome => outcome.answered);
		assert.deepStrictEqual(answers, [true, false, false, false, true, false]);
		now += 61_000;
		assert.deepStrictEqual(target.login('https://intranet.example.com/a', auth), { answered: true, username: 'user', password: 'secret' });
		const summary = controller.summary(target, OWNER);
		assert.ok(summary.ok);
		assert.deepStrictEqual(JSON.stringify(summary.summary).includes('secret'), false);
		controller.releaseTarget(target);
		await Promise.resolve();
		// The answered login must not stay in the storage's auth cache after the credentials are removed.
		assert.deepStrictEqual([target.loginListeners.size, target.authCacheClears], [0, 1]);
	});

	test('a highlight uses its own session and is removed when replaced or cleared', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = new FakeTarget();
		await controller.highlight(target, { x: 1.4, y: 2, width: 3, height: 4 }, 30_000);
		assert.deepStrictEqual(target.sessions[0].commands.map(command => command.method), ['DOM.enable', 'Overlay.enable', 'Overlay.highlightRect']);
		await controller.highlight(target, undefined, 0);
		assert.strictEqual(target.sessions[0].disposed, true);
	});
});
