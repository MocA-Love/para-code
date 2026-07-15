/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCdpInputDispatchResult } from '../../common/paradisAgentBrowser.js';
import { ParadisCdpInputQueue } from '../../node/paradisCdpInputQueue.js';

function success(value: unknown = {}): IParadisCdpInputDispatchResult {
	return { status: 'success', result: value };
}

suite('ParadisCdpInputQueue', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('serializes different routes for one exact descriptor and permits independent descriptors', async () => {
		const queue = new ParadisCdpInputQueue();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(resolve => releaseFirst = resolve);
		const first = queue.enqueue({
			queueKey: 'exact-1', connection: {}, isAuthorityCurrent: () => true,
			dispatch: async () => { order.push('page-start'); await firstGate; order.push('page-end'); return success(); },
		});
		const second = queue.enqueue({
			queueKey: 'exact-1', connection: {}, isAuthorityCurrent: () => true,
			dispatch: async () => { order.push('browser'); return success(); },
		});
		const independent = queue.enqueue({
			queueKey: 'exact-2', connection: {}, isAuthorityCurrent: () => true,
			dispatch: async () => { order.push('independent'); return success(); },
		});

		await independent.response;
		assert.deepStrictEqual(order, ['page-start', 'independent']);
		releaseFirst();
		assert.strictEqual((await first.response).status, 'success');
		assert.strictEqual((await second.response).status, 'success');
		await Promise.all([first.drained, second.drained, independent.drained]);
		assert.deepStrictEqual(order, ['page-start', 'independent', 'page-end', 'browser']);
		queue.dispose();
	});

	test('rejects stale authority before the commit point without dispatching', async () => {
		const queue = new ParadisCdpInputQueue();
		let dispatches = 0;
		const operation = queue.enqueue({
			queueKey: 'exact', connection: {}, isAuthorityCurrent: () => false,
			dispatch: async () => { dispatches++; return success(); },
		});

		assert.deepStrictEqual(await operation.response, {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: browser input authority changed before dispatch',
		});
		await operation.drained;
		assert.strictEqual(dispatches, 0);
		queue.dispose();
	});

	test('reports post-commit authority change as outcome unknown', async () => {
		const queue = new ParadisCdpInputQueue();
		let current = true;
		const operation = queue.enqueue({
			queueKey: 'exact', connection: {}, isAuthorityCurrent: () => current,
			dispatch: async () => { current = false; return success({ applied: true }); },
		});

		assert.deepStrictEqual(await operation.response, {
			status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: browser input authority changed after dispatch',
		});
		await operation.drained;
		queue.dispose();
	});

	test('drains a timed-out command, poisons only its exact descriptor, and only a new lease recovers', async () => {
		const clock = sinon.useFakeTimers();
		const queue = new ParadisCdpInputQueue({ dispatchTimeoutMs: 5_000 });
		let release!: (value: IParadisCdpInputDispatchResult) => void;
		const dispatch = new Promise<IParadisCdpInputDispatchResult>(resolve => release = resolve);
		let sameDescriptorDispatches = 0;
		const first = queue.enqueue({ queueKey: 'exact', connection: {}, isAuthorityCurrent: () => true, dispatch: () => dispatch });
		const second = queue.enqueue({
			queueKey: 'exact', connection: {}, isAuthorityCurrent: () => true,
			dispatch: async () => { sameDescriptorDispatches++; return success(); },
		});

		await clock.tickAsync(5_000);
		assert.deepStrictEqual(await first.response, {
			status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: browser input dispatch timed out after 5000ms',
		});
		await clock.tickAsync(0);
		await first.drained;
		assert.deepStrictEqual(await second.response, {
			status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: exact BrowserView input queue is poisoned by an unresolved dispatch',
		});
		await second.drained;
		assert.strictEqual(sameDescriptorDispatches, 0);

		const replacement = queue.enqueue({ queueKey: 'exact-new-lease', connection: {}, isAuthorityCurrent: () => true, dispatch: async () => success() });
		assert.strictEqual((await replacement.response).status, 'success');
		await replacement.drained;
		release(success());
		await clock.tickAsync(0);
		const stillPoisoned = queue.enqueue({ queueKey: 'exact', connection: {}, isAuthorityCurrent: () => true, dispatch: async () => success() });
		assert.strictEqual((await stillPoisoned.response).status, 'outcome-unknown');
		await stillPoisoned.drained;
		queue.dispose();
	});

	test('connection close rejects uncommitted entries but preserves other connections', async () => {
		const queue = new ParadisCdpInputQueue();
		const connectionA = {};
		const connectionB = {};
		let release!: () => void;
		const gate = new Promise<void>(resolve => release = resolve);
		const active = queue.enqueue({
			queueKey: 'exact', connection: connectionA, isAuthorityCurrent: () => true,
			dispatch: async () => { await gate; return success(); },
		});
		const queued = queue.enqueue({ queueKey: 'exact', connection: connectionA, isAuthorityCurrent: () => true, dispatch: async () => success() });
		let independentStarted = false;
		const independent = queue.enqueue({
			queueKey: 'exact-other', connection: connectionB, isAuthorityCurrent: () => true,
			dispatch: async () => { independentStarted = true; return success(); },
		});

		queue.closeConnection(connectionA);
		assert.strictEqual((await active.response).status, 'outcome-unknown');
		await active.drained;
		assert.deepStrictEqual(await queued.response, {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: browser input connection closed before dispatch',
		});
		assert.strictEqual(independentStarted, true);
		assert.strictEqual((await independent.response).status, 'success');
		const poisoned = queue.enqueue({ queueKey: 'exact', connection: connectionB, isAuthorityCurrent: () => true, dispatch: async () => success() });
		assert.strictEqual((await poisoned.response).status, 'outcome-unknown');
		await poisoned.drained;
		release();
		await Promise.all([queued.drained, independent.drained]);
		queue.dispose();
	});

	test('dispose drains a committed never-settling command without an unhandled late rejection', async () => {
		const queue = new ParadisCdpInputQueue();
		let rejectDispatch!: (error: Error) => void;
		const dispatch = new Promise<IParadisCdpInputDispatchResult>((_resolve, reject) => rejectDispatch = reject);
		const operation = queue.enqueue({ queueKey: 'exact', connection: {}, isAuthorityCurrent: () => true, dispatch: () => dispatch });
		queue.dispose();
		assert.strictEqual((await operation.response).status, 'outcome-unknown');
		await operation.drained;
		rejectDispatch(new Error('late debugger rejection'));
		await Promise.resolve();
	});

	test('bounds poisoned descriptor state and fails closed after saturation', async () => {
		const clock = sinon.useFakeTimers();
		const queue = new ParadisCdpInputQueue({ dispatchTimeoutMs: 1, poisonedKeyLimit: 2 });
		for (const queueKey of ['exact-1', 'exact-2', 'exact-3']) {
			const operation = queue.enqueue({ queueKey, connection: {}, isAuthorityCurrent: () => true, dispatch: () => new Promise(() => { }) });
			await clock.tickAsync(1);
			assert.strictEqual((await operation.response).status, 'outcome-unknown');
			await operation.drained;
		}
		const rejected = queue.enqueue({ queueKey: 'new-lease', connection: {}, isAuthorityCurrent: () => true, dispatch: async () => success() });
		assert.strictEqual((await rejected.response).status, 'outcome-unknown');
		await rejected.drained;
		queue.dispose();
	});

	test('caps concurrently active exact descriptor queues', async () => {
		const queue = new ParadisCdpInputQueue({ activeKeyLimit: 2 });
		const first = queue.enqueue({ queueKey: 'exact-1', connection: {}, isAuthorityCurrent: () => true, dispatch: () => new Promise(() => { }) });
		const second = queue.enqueue({ queueKey: 'exact-2', connection: {}, isAuthorityCurrent: () => true, dispatch: () => new Promise(() => { }) });
		const overflow = queue.enqueue({ queueKey: 'exact-3', connection: {}, isAuthorityCurrent: () => true, dispatch: async () => success() });
		assert.deepStrictEqual(await overflow.response, {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: browser input active descriptor capacity reached',
		});
		await overflow.drained;
		queue.dispose();
		await Promise.all([first.drained, second.drained]);
	});

	test('caps one exact queue at 256 entries including the running command', async () => {
		const queue = new ParadisCdpInputQueue();
		let release!: () => void;
		const gate = new Promise<void>(resolve => release = resolve);
		const operations = [queue.enqueue({
			queueKey: 'exact', connection: {}, isAuthorityCurrent: () => true,
			dispatch: async () => { await gate; return success(); },
		})];
		for (let index = 1; index < 256; index++) {
			operations.push(queue.enqueue({ queueKey: 'exact', connection: {}, isAuthorityCurrent: () => true, dispatch: async () => success() }));
		}
		const overflow = queue.enqueue({ queueKey: 'exact', connection: {}, isAuthorityCurrent: () => true, dispatch: async () => success() });
		assert.deepStrictEqual(await overflow.response, {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: browser input queue capacity reached',
		});
		release();
		await Promise.all(operations.map(operation => operation.drained));
		await overflow.drained;
		queue.dispose();
	});

	test('preserves a definite Main retryable rejection after the IPC call', async () => {
		const queue = new ParadisCdpInputQueue();
		const operation = queue.enqueue({
			queueKey: 'exact', connection: {}, isAuthorityCurrent: () => true,
			dispatch: async () => ({ status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: BrowserView is focused' }),
		});
		assert.deepStrictEqual(await operation.response, {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: BrowserView is focused',
		});
		await operation.drained;
		queue.dispose();
	});
});
