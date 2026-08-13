/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_LIMIT,
	BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_TTL_MS,
	BrowserViewAutomationKeyExpectationQueue,
	browserViewAutomationIsTrustedFocusEvent,
	browserViewAutomationKeySignatureFromCdp,
	browserViewAutomationKeySignatureFromElectron,
	browserViewAutomationKeySignatureFromPreload,
} from '../../common/browserViewAutomationInput.js';

type TestAutomationListener = (_event: unknown, payload: unknown) => void;

class TestAutomationIpcRenderer {
	readonly sent: [string, unknown][] = [];
	private readonly listeners = new Map<string, TestAutomationListener>();

	on(channel: string, listener: TestAutomationListener): void {
		this.listeners.set(channel, listener);
	}

	send(channel: string, payload: unknown): void {
		this.sent.push([channel, payload]);
	}

	emit(channel: string, payload: unknown): void {
		this.listeners.get(channel)?.({}, payload);
	}
}

class TestFocusTarget {
	private listener: ((event: unknown) => void) | undefined;

	addEventListener(type: string, listener: (event: unknown) => void): void {
		if (type === 'focus') {
			this.listener = listener;
		}
	}

	emit(event: unknown): void {
		this.listener?.(event);
	}
}

suite('BrowserView automation input', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('normalizes CDP rawKeyDown and Electron/DOM keydown into one exact signature', () => {
		const cdp = browserViewAutomationKeySignatureFromCdp({
			type: 'rawKeyDown', key: 'K', code: 'KeyK', location: 1, modifiers: 2 | 8, autoRepeat: true,
		});
		const electron = browserViewAutomationKeySignatureFromElectron({
			type: 'keyDown', key: 'K', code: 'KeyK', location: 1,
			control: true, shift: true, alt: false, meta: false, isAutoRepeat: true,
		});
		const preload = browserViewAutomationKeySignatureFromPreload({
			type: 'keydown', key: 'K', code: 'KeyK', location: 1,
			ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: true,
		});

		assert.deepStrictEqual(cdp, {
			type: 'keyDown', key: 'K', code: 'KeyK', location: 1, modifiers: 10, repeat: true,
		});
		assert.deepStrictEqual(electron, cdp);
		assert.deepStrictEqual(preload, cdp);
	});

	test('rejects incomplete, overlong and non-canonical key signatures', () => {
		for (const params of [
			null,
			{},
			{ type: 'keyDown', key: 'K' },
			{ type: 'keyDown', key: 'K', code: 'KeyK', location: 4 },
			{ type: 'keyDown', key: 'K', code: 'KeyK', modifiers: 16 },
			{ type: 'keyDown', key: 'x'.repeat(129), code: 'KeyX' },
			{ type: 'unknown', key: 'K', code: 'KeyK' },
		]) {
			assert.strictEqual(browserViewAutomationKeySignatureFromCdp(params), undefined);
		}
	});

	test('accepts only trusted preload focus events and rejects synthetic focus', () => {
		assert.strictEqual(browserViewAutomationIsTrustedFocusEvent({ isTrusted: true }), true);
		assert.strictEqual(browserViewAutomationIsTrustedFocusEvent({ isTrusted: false }), false);
		assert.strictEqual(browserViewAutomationIsTrustedFocusEvent({}), false);
		assert.strictEqual(browserViewAutomationIsTrustedFocusEvent(null), false);
	});

	test('preload consumes and acknowledges only the first active exact key until completion expires', async function () {
		if (process.versions.electron) {
			this.skip();
		}
		const { createBrowserViewAutomationKeyPreload } = await import('../../electron-browser/preload-browserView.js');
		const clock = sinon.useFakeTimers();
		const ipcRenderer = new TestAutomationIpcRenderer();
		const focusTarget = new TestFocusTarget();
		let documentFocused = true;
		const preload = createBrowserViewAutomationKeyPreload(ipcRenderer, focusTarget, { hasFocus: () => documentFocused });
		const signature = { type: 'keyDown' as const, key: 'Escape', code: 'Escape', location: 0, modifiers: 0, repeat: false };

		ipcRenderer.emit('vscode:browserView:expectAutomationKey', { sequence: 1, signature, nativeFocused: false });
		assert.deepStrictEqual(ipcRenderer.sent, [['vscode:browserView:automationKeyExpected', { sequence: 1, accepted: true }]]);

		documentFocused = false;
		ipcRenderer.emit('vscode:browserView:activateAutomationKey', { sequence: 1, nativeFocused: true });
		assert.deepStrictEqual(ipcRenderer.sent.at(-1), ['vscode:browserView:automationKeyActivated', { sequence: 1, accepted: true }]);
		const otherSignature = { ...signature, key: 'F1', code: 'F1' };
		ipcRenderer.emit('vscode:browserView:expectAutomationKey', { sequence: 2, signature: otherSignature, nativeFocused: false });
		assert.strictEqual(preload.consumeAutomationKey(otherSignature), false);
		assert.strictEqual(preload.consumeAutomationKey({ ...signature, key: 'F2', code: 'F2' }), false);
		assert.strictEqual(preload.consumeAutomationKey(signature), true);
		assert.strictEqual(preload.consumeAutomationKey(signature), true);
		assert.deepStrictEqual(ipcRenderer.sent.filter(([channel]) => channel === 'vscode:browserView:automationKeyConsumed'), [
			['vscode:browserView:automationKeyConsumed', { sequence: 1, signature }],
		]);

		ipcRenderer.emit('vscode:browserView:completeAutomationKey', { sequence: 1 });
		clock.tick(BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_TTL_MS - 1);
		assert.strictEqual(preload.consumeAutomationKey(signature), true);
		clock.tick(1);
		assert.strictEqual(preload.consumeAutomationKey(signature), false);
	});

	test('preload protects real-user focus only when native and document focus agree', async function () {
		if (process.versions.electron) {
			this.skip();
		}
		const { createBrowserViewAutomationKeyPreload } = await import('../../electron-browser/preload-browserView.js');
		const ipcRenderer = new TestAutomationIpcRenderer();
		const focusTarget = new TestFocusTarget();
		const documentFocused = true;
		const preload = createBrowserViewAutomationKeyPreload(ipcRenderer, focusTarget, { hasFocus: () => documentFocused });
		const signature = { type: 'keyDown' as const, key: 'Escape', code: 'Escape', location: 0, modifiers: 0, repeat: false };

		ipcRenderer.emit('vscode:browserView:expectAutomationKey', { sequence: 1, signature, nativeFocused: true });
		assert.deepStrictEqual(ipcRenderer.sent.at(-1), ['vscode:browserView:automationKeyExpected', { sequence: 1, accepted: false }]);
		ipcRenderer.emit('vscode:browserView:expectAutomationKey', { sequence: 2, signature, nativeFocused: false });
		ipcRenderer.emit('vscode:browserView:activateAutomationKey', { sequence: 2, nativeFocused: false });
		assert.strictEqual(preload.consumeAutomationKey(signature), true);
		focusTarget.emit({ isTrusted: false });
		assert.strictEqual(preload.consumeAutomationKey(signature), true);
		focusTarget.emit({ isTrusted: true });
		assert.strictEqual(preload.consumeAutomationKey(signature), false);
	});

	test('suppresses only the first matching committed event in each route', () => {
		const queue = new BrowserViewAutomationKeyExpectationQueue();
		const signature = browserViewAutomationKeySignatureFromCdp({ type: 'keyDown', key: 'Escape', code: 'Escape' })!;
		const realUser = browserViewAutomationKeySignatureFromCdp({ type: 'keyDown', key: 'F1', code: 'F1' })!;

		assert.strictEqual(queue.register({ sequence: 1, signature }), true);
		assert.strictEqual(queue.consume(signature, 'preload-keydown'), undefined);
		assert.strictEqual(queue.consume(signature, 'before-input-event'), undefined);
		assert.strictEqual(queue.commit(1), false);
		assert.strictEqual(queue.activate(1), true);
		assert.strictEqual(queue.activate(1), false);
		assert.strictEqual(queue.consume(signature, 'preload-keydown'), undefined);
		assert.strictEqual(queue.consume(signature, 'before-input-event'), undefined);
		assert.strictEqual(queue.commit(1), true);
		assert.strictEqual(queue.consume(realUser, 'preload-keydown'), undefined);
		assert.strictEqual(queue.consume(signature, 'preload-keydown'), 1);
		assert.strictEqual(queue.consume(signature, 'preload-keydown'), undefined);
		assert.strictEqual(queue.consume(signature, 'before-input-event'), 1);
		assert.strictEqual(queue.consume(signature, 'before-input-event'), undefined);
		assert.strictEqual(queue.consume(realUser, 'before-input-event'), undefined);
		queue.dispose();
	});

	test('expires only after command completion and clears every timer on disposal', () => {
		const clock = sinon.useFakeTimers();
		const queue = new BrowserViewAutomationKeyExpectationQueue();
		const signature = browserViewAutomationKeySignatureFromCdp({ type: 'keyDown', key: 'K', code: 'KeyK' })!;

		assert.strictEqual(queue.register({ sequence: 1, signature }), true);
		clock.tick(BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_TTL_MS * 4);
		assert.strictEqual(queue.size, 1);
		assert.strictEqual(queue.complete(1), false);
		assert.strictEqual(queue.commit(1), false);
		assert.strictEqual(queue.activate(1), true);
		assert.strictEqual(queue.commit(1), true);
		assert.strictEqual(queue.complete(1), true);
		clock.tick(BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_TTL_MS - 1);
		assert.strictEqual(queue.size, 1);
		clock.tick(1);
		assert.strictEqual(queue.size, 0);
		assert.strictEqual(queue.consume(signature, 'preload-keydown'), undefined);
		assert.strictEqual(queue.consume(signature, 'before-input-event'), undefined);

		assert.strictEqual(queue.register({ sequence: 2, signature }), true);
		queue.dispose();
		clock.tick(BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_TTL_MS);
		assert.strictEqual(queue.size, 0);
	});

	test('retains associated Main routing state until the post-completion TTL expires', () => {
		const clock = sinon.useFakeTimers();
		const removed: number[] = [];
		const queue = new BrowserViewAutomationKeyExpectationQueue(sequence => removed.push(sequence));
		const signature = browserViewAutomationKeySignatureFromCdp({ type: 'keyDown', key: 'K', code: 'KeyK' })!;

		assert.strictEqual(queue.register({ sequence: 7, signature }), true);
		assert.strictEqual(queue.has(7), true);
		assert.strictEqual(queue.activate(7), true);
		assert.strictEqual(queue.commit(7), true);
		assert.strictEqual(queue.complete(7), true);
		clock.tick(BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_TTL_MS - 1);
		assert.deepStrictEqual(removed, []);
		clock.tick(1);
		assert.deepStrictEqual(removed, [7]);
		assert.strictEqual(queue.has(7), false);
		assert.strictEqual(queue.register({ sequence: 8, signature }), true);
		assert.strictEqual(queue.cancel(8), true);
		assert.strictEqual(queue.commit(8), false);
		assert.strictEqual(queue.register({ sequence: 9, signature }), true);
		queue.clear();
		assert.deepStrictEqual(removed, [7, 8, 9]);
		queue.dispose();
	});

	test('invalidates even a committed signature when the user focuses the BrowserView', () => {
		const queue = new BrowserViewAutomationKeyExpectationQueue();
		const signature = browserViewAutomationKeySignatureFromCdp({ type: 'keyDown', key: 'Escape', code: 'Escape' })!;

		assert.strictEqual(queue.register({ sequence: 1, signature }), true);
		assert.strictEqual(queue.activate(1), true);
		assert.strictEqual(queue.commit(1), true);
		assert.strictEqual(queue.consume(signature, 'preload-keydown'), 1);
		assert.strictEqual(queue.invalidateForUserFocus(1), true);
		assert.strictEqual(queue.consume(signature, 'preload-keydown'), undefined);
		queue.dispose();
	});

	test('passes an identical user key after the automation event was consumed on that route', () => {
		const queue = new BrowserViewAutomationKeyExpectationQueue();
		const signature = browserViewAutomationKeySignatureFromCdp({ type: 'keyDown', key: 'Escape', code: 'Escape' })!;

		assert.strictEqual(queue.register({ sequence: 1, signature }), true);
		assert.strictEqual(queue.activate(1), true);
		assert.strictEqual(queue.commit(1), true);
		assert.strictEqual(queue.consume(signature, 'preload-keydown'), 1);
		assert.strictEqual(queue.consume(signature, 'preload-keydown'), undefined);
		assert.strictEqual(queue.consume(signature, 'before-input-event'), 1);
		assert.strictEqual(queue.consume(signature, 'before-input-event'), undefined);
		queue.dispose();
	});

	test('caps pending expectations, rejects duplicate sequences and releases capacity on clear', () => {
		const queue = new BrowserViewAutomationKeyExpectationQueue();
		const signature = browserViewAutomationKeySignatureFromCdp({ type: 'keyDown', key: 'K', code: 'KeyK' })!;
		for (let sequence = 1; sequence <= BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_LIMIT; sequence++) {
			assert.strictEqual(queue.register({ sequence, signature }), true);
		}
		assert.strictEqual(queue.register({ sequence: 1, signature }), false);
		assert.strictEqual(queue.register({ sequence: BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_LIMIT + 1, signature }), false);
		queue.clear();
		assert.strictEqual(queue.size, 0);
		assert.strictEqual(queue.register({ sequence: 100, signature }), true);
		queue.dispose();
	});
});
