/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { runParadisWorkerLoop, type IParadisWorkerLoopPort } from '../../node/paradisWorkerLoop.js';

class FakePort implements IParadisWorkerLoopPort {
	readonly posted: unknown[] = [];
	private listener: ((message: unknown) => void) | undefined;
	postMessage(message: unknown): void { this.posted.push(message); }
	on(_event: 'message', listener: (message: unknown) => void): unknown { this.listener = listener; return this; }
	send(message: unknown): void { this.listener?.(message); }
}

interface Run { readonly value: string }

suite('Paradis worker loop', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('answers runs, refuses malformed ones, reports thrown errors as their kind, and cancels only running requests', async () => {
		const port = new FakePort();
		let release: (() => void) | undefined;
		let token: CancellationToken | undefined;
		runParadisWorkerLoop<Run, string>(port, {
			accepts: (request): request is Run => !!request && typeof (request as { readonly value?: unknown }).value === 'string',
			invalid: 'invalid',
			failed: 'failed',
			failureKind: error => error instanceof TypeError ? 'TypeError' : 'Error',
			run: async (request, runToken) => {
				if (request.value === 'throw') {
					throw new TypeError('boom /secret/path');
				}
				if (request.value === 'wait') {
					token = runToken;
					await new Promise<void>(resolve => release = resolve);
					return { result: runToken.isCancellationRequested ? 'cancelled' : 'done' };
				}
				return { result: request.value.toUpperCase(), ...(request.value === 'cause' ? { cause: 'RangeError' } : {}) };
			},
		});

		port.send({ id: 1, op: 'run', request: { value: 'ok' } });
		port.send({ id: 2, op: 'run', request: { nope: true } });
		port.send({ id: 3, op: 'run', request: { value: 'throw' } });
		port.send({ id: 4, op: 'run', request: { value: 'cause' } });
		port.send({ id: 9, op: 'cancel' });
		port.send({ op: 'run', request: { value: 'no id' } });
		port.send({ id: 5, op: 'run', request: { value: 'wait' } });
		port.send({ id: 5, op: 'cancel' });
		release!();
		await new Promise(resolve => setImmediate(resolve));

		assert.deepStrictEqual({ posted: port.posted, cancelled: token?.isCancellationRequested }, {
			posted: [
				{ kind: 'result', id: 2, result: 'invalid' },
				{ kind: 'result', id: 1, result: 'OK' },
				{ kind: 'result', id: 3, result: 'failed', cause: 'TypeError' },
				{ kind: 'result', id: 4, result: 'CAUSE', cause: 'RangeError' },
				{ kind: 'result', id: 5, result: 'cancelled' },
			],
			cancelled: true,
		});
	});
});
