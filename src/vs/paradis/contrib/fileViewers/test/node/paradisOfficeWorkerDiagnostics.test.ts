/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Office の worker の失敗を Sentry へ送る見張り。偽の worker で error・exit・返事を起こし、送る中身を確かめる。

import assert from 'assert';
import { EventEmitter } from 'events';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { paradisOfficeWorkerFailureKind, resetParadisOfficeWorkerFailureReportsForTest, watchParadisOfficeWorker, type IParadisWatchedOfficeWorker, type ParadisOfficeWorkerName } from '../../node/office/paradisOfficeWorkerDiagnostics.js';

class FakeWorker extends EventEmitter implements IParadisWatchedOfficeWorker {
	terminateRequested = false;
}

function errorWithCode(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

suite('Paradis Office worker diagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let sent: unknown[];
	const reporter: ParadisDiagnosticReporter = (scope, feature, operation, error, safeExtra, severity) => {
		sent.push({ scope, feature, operation, message: error instanceof Error ? error.message : undefined, safeExtra, severity });
	};

	function watched(name: ParadisOfficeWorkerName): FakeWorker {
		const worker = new FakeWorker();
		watchParadisOfficeWorker(name, worker, reporter);
		return worker;
	}

	setup(() => {
		sent = [];
		resetParadisOfficeWorkerFailureReportsForTest();
	});

	test('reports a worker that cannot load once per run, without the path in the message', () => {
		for (let i = 0; i < 2; i++) {
			const worker = watched('word-semantic');
			worker.emit('error', errorWithCode(`Cannot find package 'yauzl' imported from /Users/example/app/out/x.js`, 'ERR_MODULE_NOT_FOUND'));
			worker.emit('exit', 1);
		}
		assert.deepStrictEqual(sent, [{
			scope: 'owned', feature: 'office-workers', operation: 'word-semantic.load', message: 'word-semantic load missing-package',
			safeExtra: { safe_worker: 'word-semantic', safe_stage: 'load', safe_kind: 'missing-package' }, severity: 'error',
		}]);
	});

	test('tells the stages apart and ignores exits we asked for', () => {
		const stopped = watched('office-v1');
		stopped.emit('message', { kind: 'ready' });
		stopped.terminateRequested = true;
		stopped.emit('exit', 1);

		const exited = watched('office-v1');
		exited.emit('exit', 3);

		const analysis = watched('spreadsheet-semantic');
		analysis.emit('message', { kind: 'result', id: 1, result: {}, cause: 'TypeError' });

		const outOfMemory = watched('word-semantic');
		outOfMemory.emit('message', { kind: 'result', id: 1, result: {} });
		outOfMemory.emit('error', errorWithCode('Worker terminated due to reaching memory limit', 'ERR_WORKER_OUT_OF_MEMORY'));
		outOfMemory.emit('exit', 1);

		assert.deepStrictEqual(sent.map(event => (event as { safeExtra: unknown; severity: unknown })).map(({ safeExtra, severity }) => ({ safeExtra, severity })), [
			{ safeExtra: { safe_worker: 'office-v1', safe_stage: 'exit', safe_kind: 'exit-code', safe_exit_code: 3 }, severity: 'error' },
			{ safeExtra: { safe_worker: 'spreadsheet-semantic', safe_stage: 'analysis', safe_kind: 'TypeError' }, severity: 'error' },
			{ safeExtra: { safe_worker: 'word-semantic', safe_stage: 'run', safe_kind: 'out-of-memory' }, severity: 'warning' },
		]);
	});

	test('names failures without their messages', () => {
		assert.deepStrictEqual([
			paradisOfficeWorkerFailureKind(errorWithCode(`Cannot find module '/Users/example/x.js'`, 'ERR_MODULE_NOT_FOUND')),
			paradisOfficeWorkerFailureKind(errorWithCode(`Cannot find module 'pend'`, 'MODULE_NOT_FOUND')),
			paradisOfficeWorkerFailureKind(errorWithCode('open /Users/example/a.docx', 'ENOENT')),
			paradisOfficeWorkerFailureKind(new RangeError('secret text')),
			paradisOfficeWorkerFailureKind(errorWithCode('x', 'not a code /Users/example')),
		], ['missing-module', 'missing-module', 'ENOENT', 'RangeError', 'Error']);
	});
});
