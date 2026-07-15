/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentCommandTimer, ParadisAgentCommandAuthority, ParadisAgentCommandDeliveryCoordinator, paradisShouldRetireAgentToken } from '../../common/paradisAgentCommandLifecycle.js';

class FakeTimer implements IParadisAgentCommandTimer {
	private nextId = 1;
	private readonly callbacks = new Map<number, () => void>();

	set(callback: () => void): number {
		const id = this.nextId++;
		this.callbacks.set(id, callback);
		return id;
	}

	clear(handle: unknown): void {
		if (typeof handle === 'number') {
			this.callbacks.delete(handle);
		}
	}

	runAll(): void {
		const pending = [...this.callbacks.values()];
		this.callbacks.clear();
		for (const callback of pending) {
			callback();
		}
	}

	get size(): number { return this.callbacks.size; }
}

suite('ParadisAgentCommandDeliveryCoordinator', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('syncs the authoritative pane registry before every notify and dedupes only after accepted', async () => {
		const timer = new FakeTimer();
		const events: string[] = [];
		const results = ['ambiguous', 'accepted'] as const;
		let attempt = 0;
		const coordinator = new ParadisAgentCommandDeliveryCoordinator({
			timer,
			syncRegistry: async token => { events.push(`sync:${token}`); },
			onProvisionalChange: (token, active) => events.push(`provisional:${token}:${active}`),
			onGenerationEnded: () => { },
		});

		coordinator.start('pane', 'codex', async generation => {
			events.push(`start:${generation}`);
			return results[attempt++];
		});
		coordinator.start('pane', 'codex', async () => { throw new Error('in-flight duplicate'); });
		await coordinator.whenIdle('pane');

		assert.deepStrictEqual(events, ['provisional:pane:true', 'sync:pane', 'start:1']);
		assert.strictEqual(timer.size, 1, 'ambiguous is retryable and must not finalize dedupe');

		timer.runAll();
		await coordinator.whenIdle('pane');
		assert.deepStrictEqual(events.slice(-2), ['sync:pane', 'start:1']);
		coordinator.start('pane', 'codex', async () => { throw new Error('accepted duplicate'); });
		await coordinator.whenIdle('pane');
		assert.strictEqual(attempt, 2);
		coordinator.dispose();
	});

	test('an old rejection timer cannot retry or finish a replacement command generation', async () => {
		const timer = new FakeTimer();
		const events: string[] = [];
		const coordinator = new ParadisAgentCommandDeliveryCoordinator({
			timer,
			syncRegistry: async () => { events.push('sync'); },
			onProvisionalChange: (_token, active, generation) => events.push(`provisional:${generation}:${active}`),
			onGenerationEnded: (_token, generation) => events.push(`ended:${generation}`),
		});

		coordinator.start('pane', 'claude', async generation => {
			events.push(`start:${generation}:reject`);
			throw new Error('temporary');
		});
		await coordinator.whenIdle('pane');
		assert.strictEqual(timer.size, 1);

		coordinator.start('pane', 'codex', async generation => {
			events.push(`start:${generation}:accepted`);
			return 'accepted';
		});
		await coordinator.whenIdle('pane');
		assert.strictEqual(timer.size, 0, 'the replacement generation cancels only the old retry');
		timer.runAll();
		await coordinator.whenIdle('pane');
		assert.deepStrictEqual(events.filter(event => event.includes('start:1')), ['start:1:reject']);

		coordinator.finish('pane', 'claude', async () => { throw new Error('stale finish must not run'); });
		coordinator.finish('pane', 'codex', async generation => {
			events.push(`finish:${generation}`);
			return 'stale';
		});
		await coordinator.whenIdle('pane');
		assert.strictEqual(timer.size, 1, 'finish is retried while the same generation remains ended');
		coordinator.start('pane', 'claude --resume', async generation => {
			events.push(`start:${generation}:accepted`);
			return 'accepted';
		});
		await coordinator.whenIdle('pane');
		assert.strictEqual(timer.size, 0);
		timer.runAll();
		await coordinator.whenIdle('pane');
		assert.deepStrictEqual(events.filter(event => event.startsWith('finish:')), ['finish:2']);
		coordinator.dispose();
	});

	test('the same command restarted while its old finish is pending becomes a new generation immediately', async () => {
		const timer = new FakeTimer();
		const events: string[] = [];
		let resolveOldFinish!: (result: 'accepted') => void;
		const oldFinish = new Promise<'accepted'>(resolve => resolveOldFinish = resolve);
		let markOldFinishStarted!: () => void;
		const oldFinishStarted = new Promise<void>(resolve => markOldFinishStarted = resolve);
		const coordinator = new ParadisAgentCommandDeliveryCoordinator({
			timer,
			syncRegistry: async () => { events.push('sync'); },
			onProvisionalChange: (_token, active, generation) => events.push(`provisional:${generation}:${active}`),
			onGenerationEnded: (_token, generation) => events.push(`ended:${generation}`),
		});

		coordinator.start('pane', 'codex', async generation => {
			events.push(`start:${generation}`);
			return 'accepted';
		});
		await coordinator.whenIdle('pane');
		coordinator.finish('pane', 'codex', async generation => {
			events.push(`finish:${generation}`);
			markOldFinishStarted();
			return oldFinish;
		});
		await oldFinishStarted;
		assert.ok(events.includes('finish:1'));

		coordinator.start('pane', 'codex', async generation => {
			events.push(`start:${generation}`);
			return 'accepted';
		});
		await coordinator.whenIdle('pane');
		assert.ok(events.includes('start:2'), 'superseding the pending old finish must unblock the new start without waiting for its response');
		assert.strictEqual(timer.size, 0);

		resolveOldFinish('accepted');
		await oldFinish;
		assert.strictEqual(events.filter(event => event === 'ended:2').length, 0, 'the delayed old finish completion must not end the replacement generation');
		assert.strictEqual(coordinator.queuedTokenCount, 0);
		coordinator.dispose();
	});

	test('bounds retired token generation history', () => {
		const coordinator = new ParadisAgentCommandDeliveryCoordinator({
			syncRegistry: async () => { },
			onProvisionalChange: () => { },
			onGenerationEnded: () => { },
		});
		for (let index = 0; index < 5_000; index++) {
			const token = `pane-${index}`;
			coordinator.start(token, 'codex', async () => 'accepted');
			coordinator.disposeToken(token);
		}
		assert.ok(coordinator.generationEntryCount <= 4_096);
		coordinator.dispose();
	});

	test('times out an unfinished delivery and releases its queue on token disposal', async () => {
		const timer = new FakeTimer();
		const coordinator = new ParadisAgentCommandDeliveryCoordinator({
			timer,
			operationTimeoutMs: 15_000,
			syncRegistry: async () => { },
			onProvisionalChange: () => { },
			onGenerationEnded: () => { },
		});
		let markNotifyStarted!: () => void;
		const notifyStarted = new Promise<void>(resolve => markNotifyStarted = resolve);
		coordinator.start('pane', 'codex', async () => {
			markNotifyStarted();
			return new Promise<'accepted'>(() => { });
		});
		await notifyStarted;
		assert.strictEqual(timer.size, 1, 'the unfinished notify has an operation timeout');
		timer.runAll();
		await coordinator.whenIdle('pane');
		assert.strictEqual(timer.size, 1, 'a timed out current generation becomes retryable');
		coordinator.disposeToken('pane');
		await coordinator.whenIdle('pane');
		assert.strictEqual(timer.size, 0);
		assert.strictEqual(coordinator.queuedTokenCount, 0);
		coordinator.dispose();
	});

	test('retiring an old detach instance preserves the token state owned by its reattached replacement', () => {
		assert.strictEqual(paradisShouldRetireAgentToken(10, 11), false);
		assert.strictEqual(paradisShouldRetireAgentToken(11, 11), true);
		assert.strictEqual(paradisShouldRetireAgentToken(11, undefined), true);
	});
});

suite('ParadisAgentCommandAuthority', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts idempotent delivery but rejects an old finish after a newer command starts', () => {
		const authority = new ParadisAgentCommandAuthority();
		assert.deepStrictEqual(authority.start('renderer-a', 'pane', 1, 'claude'), { result: 'accepted', apply: true });
		assert.deepStrictEqual(authority.start('renderer-a', 'pane', 1, 'claude'), { result: 'accepted', apply: false });
		assert.deepStrictEqual(authority.start('renderer-a', 'pane', 2, 'codex'), { result: 'accepted', apply: true });
		assert.deepStrictEqual(authority.finish('renderer-a', 'pane', 1), { result: 'stale', apply: false });
		assert.deepStrictEqual(authority.finish('renderer-a', 'pane', 2), { result: 'accepted', apply: true });
		assert.deepStrictEqual(authority.finish('renderer-a', 'pane', 2), { result: 'accepted', apply: false });
	});

	test('a new renderer owner may restart its command generation from one', () => {
		const authority = new ParadisAgentCommandAuthority();
		authority.start('renderer-a', 'pane', 8, 'codex');
		assert.deepStrictEqual(authority.start('renderer-b', 'pane', 1, 'codex'), { result: 'accepted', apply: true });
	});
});
