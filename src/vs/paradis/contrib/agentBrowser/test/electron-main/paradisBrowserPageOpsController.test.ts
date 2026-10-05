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

/**
 * A CDP session that behaves like the one BrowserViewDebugger hands out: disposing it does NOT undo
 * what was enabled on it, because upstream's `Target.detachFromTarget` fails with an empty session id
 * and the failure is swallowed. Only explicit commands (Fetch.disable, ...) turn things off again.
 */
class FakeSession implements ICDPConnection {
	readonly sessionId = 'session';
	readonly targetId = 'target';
	readonly commands: { readonly method: string; readonly params: unknown }[] = [];
	private readonly _onEvent = new Emitter<CDPEvent>();
	readonly onEvent = this._onEvent.event;
	private readonly _onClose = new Emitter<void>();
	readonly onClose = this._onClose.event;
	disposed = false;
	fetchEnabled = false;
	networkEnabled = false;
	cacheDisabled = false;
	bypassServiceWorker = false;
	highlightShown = false;
	/** Identifiers of scripts added with Page.addScriptToEvaluateOnNewDocument and not removed. */
	readonly initScripts = new Set<string>();
	pageEnabled = false;
	private nextScript = 1;
	/** When set, commands with this method fail (the tab did not accept them). */
	failing: string | undefined;

	async sendCommand(method: string, params?: unknown): Promise<unknown> {
		this.commands.push({ method, params });
		if (method === this.failing) {
			throw new Error(`${method} failed`);
		}
		const value = params as Record<string, unknown> | undefined;
		switch (method) {
			case 'Fetch.enable': this.fetchEnabled = true; break;
			case 'Fetch.disable': this.fetchEnabled = false; break;
			case 'Network.enable': this.networkEnabled = true; break;
			case 'Network.disable': this.networkEnabled = false; break;
			case 'Network.setCacheDisabled': this.cacheDisabled = value?.cacheDisabled === true; break;
			case 'Network.setBypassServiceWorker': this.bypassServiceWorker = value?.bypass === true; break;
			case 'Overlay.highlightRect': this.highlightShown = true; break;
			case 'Overlay.hideHighlight': this.highlightShown = false; break;
			case 'Page.enable': this.pageEnabled = true; break;
			case 'Page.disable': this.pageEnabled = false; break;
			case 'Page.removeScriptToEvaluateOnNewDocument': this.initScripts.delete(String(value?.identifier)); break;
			case 'Page.addScriptToEvaluateOnNewDocument': {
				const identifier = String(this.nextScript++);
				this.initScripts.add(identifier);
				return { identifier };
			}
		}
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

class FakeStorage {
	authCacheClears = 0;
	cacheClears = 0;
	async clearAuthCache(): Promise<void> { this.authCacheClears++; }
	async clearCache(): Promise<void> { this.cacheClears++; }
}

class FakeTarget implements IParadisPageOpsTarget {
	readonly sessions: FakeSession[] = [];
	readonly loginListeners = new Set<ParadisLoginListener>();
	readonly destroyedListeners = new Set<() => void>();
	destroyed = false;
	url = 'https://example.com/';
	zoom = 1;

	constructor(readonly storage: FakeStorage = new FakeStorage()) { }

	readonly webContents = {
		isDestroyed: () => this.destroyed,
		getURL: () => this.url,
		getTitle: () => 'Example',
		getZoomFactor: () => this.zoom,
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
		get session() { return storageOf(this); },
	};

	readonly debugger = {
		attach: async (): Promise<ICDPConnection> => {
			const session = new FakeSession();
			this.sessions.push(session);
			return session;
		},
	};

	/** Whether a request of the tab reaches the server (no session left holding Fetch interception). */
	requestReachesServer(): boolean {
		return !this.sessions.some(session => session.fetchEnabled);
	}

	/** Whether any session still has something enabled that the overrides turned on. */
	hasLeftovers(): boolean {
		return this.sessions.some(session => session.fetchEnabled || session.networkEnabled || session.cacheDisabled || session.bypassServiceWorker || session.highlightShown || session.pageEnabled || session.initScripts.size > 0);
	}

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

const targetStorage = new WeakMap<object, FakeStorage>();
function storageOf(webContents: object): FakeStorage {
	return targetStorage.get(webContents)!;
}
/** Every tab a test created, closed after the test (the controller keeps one session per tab until it closes). */
const createdTargets: FakeTarget[] = [];
function createTarget(storage?: FakeStorage): FakeTarget {
	const target = new FakeTarget(storage);
	targetStorage.set(target.webContents, target.storage);
	createdTargets.push(target);
	return target;
}

/** Lets fire-and-forget teardown chains run. */
function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

function rules(value: unknown) {
	const parsed = paradisParseRequestRules(value);
	assert.ok(parsed.ok);
	return parsed.value;
}

suite('ParadisBrowserPageOpsController', () => {
	// Registered before the leak check so the tabs are closed (and their sessions released) first.
	teardown(async () => {
		for (const target of createdTargets.splice(0)) {
			if (!target.destroyed) {
				target.destroy();
			}
		}
		await flush();
	});
	ensureNoDisposablesAreLeakedInTestSuite();

	test('extra headers and rules go on one dedicated CDP session with the cache and service workers bypassed, and clearing detaches it', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = createTarget();
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
		await flush();
		assert.deepStrictEqual([cleared.ok, controller.activeTargetCount, target.hasLeftovers(), target.requestReachesServer()], [true, 0, false, true]);
		controller.releaseTarget(target);
		await flush();
	});

	test('every way of removing overrides undoes what was enabled, even though disposing the session does not detach it', async () => {
		const results: Record<string, unknown> = {};
		const ruleSet = rules([{ url_pattern: '*', action: 'block' }]);

		// set_request_rules []
		{
			const controller = new ParadisBrowserPageOpsController();
			const target = createTarget();
			await controller.apply(target, OWNER, 1, { rules: ruleSet });
			const blockedWhileSet = !target.requestReachesServer();
			await controller.apply(target, OWNER, 1, { rules: null });
			await flush();
			results.emptyRules = [blockedWhileSet, target.requestReachesServer(), target.hasLeftovers(), target.storage.cacheClears];
			controller.releaseTarget(target);
			await flush();
		}
		// The sharing switched to another tab (a new binding generation for the pane).
		{
			const controller = new ParadisBrowserPageOpsController();
			const target = createTarget();
			await controller.apply(target, OWNER, 1, { extraHeaders: { headers: { 'X-A': '1' }, origins: [] } });
			controller.releaseOwner(OWNER, 2);
			await flush();
			results.shareSwitched = [target.requestReachesServer(), target.hasLeftovers(), target.storage.cacheClears];
			controller.releaseTarget(target);
			await flush();
		}
		// The agent let go of the tab: everything is undone, and the session is kept for the next share.
		{
			const controller = new ParadisBrowserPageOpsController();
			const target = createTarget();
			await controller.apply(target, OWNER, 1, { rules: ruleSet });
			await controller.highlight(target, { x: 1, y: 1, width: 5, height: 5 }, 30_000);
			controller.releaseTarget(target);
			await flush();
			results.released = [target.requestReachesServer(), target.hasLeftovers(), target.sessions.map(session => session.disposed)];
		}
		// Closing the tab: the storage caches are cleared through the storage captured when the overrides were set.
		{
			const controller = new ParadisBrowserPageOpsController();
			const target = createTarget();
			await controller.apply(target, OWNER, 1, { rules: ruleSet, credentials: { origin: 'https://intranet.example.com', username: 'u', password: 'p' } });
			target.destroy();
			await flush();
			results.closed = [controller.activeTargetCount, target.storage.authCacheClears, target.storage.cacheClears];
		}
		assert.deepStrictEqual(results, {
			emptyRules: [true, true, false, 1],
			shareSwitched: [true, false, 1],
			released: [true, false, [false]],
			closed: [0, 1, 1],
		});
	});

	test('a step that cannot be undone is reported', async () => {
		const failures: string[] = [];
		const controller = new ParadisBrowserPageOpsController(Date.now, step => failures.push(step));
		const target = createTarget();
		await controller.apply(target, OWNER, 1, { rules: rules([{ url_pattern: '*', action: 'block' }]) });
		target.sessions[0].failing = 'Fetch.disable';
		await controller.apply(target, OWNER, 1, { rules: null });
		await flush();
		assert.deepStrictEqual(failures, ['Fetch.disable']);
		target.sessions[0].failing = undefined;
		controller.releaseTarget(target);
		await flush();
	});

	test('paused requests are blocked, rewritten, redirected, answered or let through', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = createTarget();
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
		const target = createTarget();
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

		const blank = createTarget();
		blank.url = 'about:blank';
		const refused = await controller.apply(blank, OWNER, 1, { extraHeaders: { headers: { 'X-Flag': 'on' }, origins: [] } });
		const named = await controller.apply(blank, OWNER, 1, { extraHeaders: { headers: { 'X-Flag': 'on' }, origins: ['https://staging.example.com'] } });
		assert.deepStrictEqual([refused.ok ? 'ok' : refused.reason, named.ok && named.summary.extraHeaderOrigins], ['invalid', ['https://staging.example.com']]);
		controller.releaseTarget(blank);
	});

	test('only one pane can change a tab, and its overrides go away when its sharing changes', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = createTarget();
		const headers = (name: string) => ({ headers: { [name]: '1' }, origins: [] });
		await controller.apply(target, OWNER, 3, { extraHeaders: headers('X-A') });
		const other = await controller.apply(target, OTHER_OWNER, 9, { extraHeaders: headers('X-B') });
		const otherSummary = controller.summary(target, OTHER_OWNER);
		controller.releaseOwner(OWNER, 4);
		const stale = await controller.apply(target, OWNER, 3, { extraHeaders: headers('X-A') });
		await flush();
		assert.deepStrictEqual([
			other.ok ? 'ok' : other.reason,
			otherSummary.ok ? 'ok' : otherSummary.reason,
			target.hasLeftovers(),
			controller.activeTargetCount,
			stale.ok ? 'ok' : stale.reason,
		], ['ownedByAnotherPane', 'ownedByAnotherPane', false, 0, 'stale']);
		controller.releaseTarget(target);
		await flush();
	});

	test('overrides on a profile tab go away when another tab opens in the same profile', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const profile = new FakeStorage();
		const target = createTarget(profile);
		const other = createTarget(new FakeStorage());
		await controller.apply(target, OWNER, 1, { rules: rules([{ url_pattern: '*', action: 'block' }]) }, true);
		controller.onTabOpenedInStorage(other.storage, other);
		const keptForOtherStorage = controller.activeTargetCount;
		controller.onTabOpenedInStorage(profile, createTarget(profile));
		await flush();
		assert.deepStrictEqual([keptForOtherStorage, controller.activeTargetCount, target.requestReachesServer(), profile.cacheClears], [1, 0, true, 1]);
		controller.releaseTarget(target);
		await flush();
	});

	test('closing the tab removes everything', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = createTarget();
		await controller.apply(target, OWNER, 1, { extraHeaders: { headers: { 'X-A': '1' }, origins: [] }, credentials: { origin: 'https://intranet.example.com', username: 'u', password: 'p' } });
		target.destroy();
		await flush();
		assert.deepStrictEqual([controller.activeTargetCount, target.loginListeners.size, target.sessions[0].disposed, target.storage.authCacheClears], [0, 0, true, 1]);
	});

	test('credentials answer only the exact origin, never proxies, and stop after two answers per realm', async () => {
		let now = 1_000;
		const controller = new ParadisBrowserPageOpsController(() => now);
		const target = createTarget();
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
		await flush();
		// The answered login must not stay in the storage's auth cache after the credentials are removed.
		assert.deepStrictEqual([target.loginListeners.size, target.storage.authCacheClears], [0, 1]);
	});

	test('a highlight is hidden explicitly when cleared or when it times out, and follows the page zoom', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = createTarget();
		target.zoom = 1.25;
		await controller.highlight(target, { x: 208, y: 261, width: 180, height: 60 }, 30_000);
		const session = target.sessions[0];
		assert.deepStrictEqual(session.commands.map(command => command.method), ['DOM.enable', 'Overlay.enable', 'Overlay.highlightRect']);
		const rect = session.commands[2].params as Record<string, unknown>;
		assert.deepStrictEqual([rect.x, rect.y, rect.width, rect.height], [260, 326, 225, 75]);
		await controller.highlight(target, undefined, 0);
		await flush();
		const hiddenByClear = !session.highlightShown;
		await controller.highlight(target, { x: 1, y: 1, width: 5, height: 5 }, 1);
		await new Promise(resolve => setTimeout(resolve, 10));
		await flush();
		// One reused session, hidden by the timeout too.
		assert.deepStrictEqual([hiddenByClear, session.highlightShown, target.sessions.length], [true, false, 1]);
		controller.releaseTarget(target);
		await flush();
		const afterRelease = [target.hasLeftovers(), session.disposed];
		target.destroy();
		await flush();
		assert.deepStrictEqual([afterRelease, session.disposed], [[false, false], true]);
	});

	test('a tab keeps at most one session however often overrides and highlights are set, removed and the tab is re-shared', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = createTarget();
		for (let round = 0; round < 5; round++) {
			await controller.apply(target, OWNER, round + 1, { rules: rules([{ url_pattern: '*', action: 'block' }]) });
			await controller.highlight(target, { x: 1, y: 1, width: 5, height: 5 }, 30_000);
			await controller.apply(target, OWNER, round + 1, { rules: null });
			await controller.highlight(target, undefined, 0);
			// The agent lets go of the tab (for example select_browser_tab to another tab and back).
			controller.releaseTarget(target);
			await flush();
		}
		const beforeClose = [target.sessions.length, target.requestReachesServer(), target.hasLeftovers()];
		target.destroy();
		await flush();
		assert.deepStrictEqual([beforeClose, target.sessions.map(session => session.disposed)], [[1, true, false], [true]]);
	});
	test('init scripts stay until removed, are listed per pane, and go away when the sharing changes or the tab is released', async () => {
		const controller = new ParadisBrowserPageOpsController(() => 1000);
		const target = createTarget();
		const added = await controller.addInitScript(target, OWNER, 2, { source: 'window.__a = 1', label: 'hook', runNow: true });
		const fromOther = await controller.addInitScript(target, OTHER_OWNER, 5, { source: 'window.__b = 1', label: 'other', runNow: false });
		const session = target.sessions[0];
		const listed = controller.listInitScripts(target, OWNER);
		const unknown = await controller.removeInitScripts(target, OWNER, 's99');
		controller.releaseOwner(OWNER, 3);
		await flush();
		const afterRelease = [controller.listInitScripts(target, OWNER), session.initScripts.size, session.pageEnabled];
		const stale = await controller.addInitScript(target, OWNER, 2, { source: 'window.__c = 1', label: 'late', runNow: false });
		controller.releaseTarget(target);
		await flush();
		assert.deepStrictEqual({
			added,
			addCommand: session.commands.slice(0, 2),
			listed,
			unknown: unknown.ok ? 'ok' : unknown.reason,
			afterRelease,
			stale: stale.ok ? 'ok' : stale.reason,
			fromOther: fromOther.ok,
			leftovers: target.hasLeftovers(),
		}, {
			added: { ok: true, scripts: [{ id: 's1', label: 'hook', chars: 14, addedAt: 1000 }], otherPanes: 0, added: { id: 's1', label: 'hook', chars: 14, addedAt: 1000 } },
			addCommand: [{ method: 'Page.enable', params: undefined }, { method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: 'window.__a = 1', runImmediately: true } }],
			listed: { ok: true, scripts: [{ id: 's1', label: 'hook', chars: 14, addedAt: 1000 }], otherPanes: 1 },
			unknown: 'invalid',
			afterRelease: [{ ok: true, scripts: [], otherPanes: 1 }, 1, true],
			stale: 'stale',
			fromOther: true,
			leftovers: false,
		});
	});

	test('removing the last init script disables Page again, and a full tab is refused', async () => {
		const controller = new ParadisBrowserPageOpsController();
		const target = createTarget();
		for (let i = 0; i < 10; i++) {
			await controller.addInitScript(target, OWNER, 1, { source: `window.__n = ${i}`, label: `n${i}`, runNow: false });
		}
		const full = await controller.addInitScript(target, OWNER, 1, { source: 'x', label: 'x', runNow: false });
		const one = await controller.removeInitScripts(target, OWNER, 's1');
		const all = await controller.removeInitScripts(target, OWNER, undefined);
		assert.deepStrictEqual([full.ok, one.ok && one.removed, all.ok && all.removed, target.sessions[0].initScripts.size, target.sessions[0].pageEnabled], [false, 1, 9, 0, false]);
		controller.releaseTarget(target);
		await flush();
	});
});
