/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import 'mocha';
import * as assert from 'assert';
import { PromiseSource } from '../util';

suite('PromiseSource (Para Code)', () => {

	// The gitignore decorations wait on `promise` before a failed check-ignore rejects it, so nobody reads
	// the rejected copy that `reject` stores. It raised one unhandled rejection per file (Sentry J4).
	test('a rejection nobody reads is not reported as unhandled, and a late reader still sees the error', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const error = new Error('check-ignore failed');
			const waiting = new PromiseSource<void>();
			const early = waiting.promise;
			waiting.reject(error);
			const unread = new PromiseSource<void>();
			unread.reject(error);

			const earlyError = await early.then(() => undefined, err => err);
			const lateError = await unread.promise.then(() => undefined, err => err);
			await new Promise(resolve => setTimeout(resolve, 10));

			assert.deepStrictEqual({ earlyError, lateError, unhandled }, { earlyError: error, lateError: error, unhandled: [] });
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});
});
