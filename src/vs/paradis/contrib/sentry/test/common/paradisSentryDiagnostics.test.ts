/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSentryFingerprint } from '../../common/paradisSentryCommon.js';
import {
	configureParadisDiagnosticReporter,
	reportParadisDiagnosticError,
	paradisErrorMessageHash,
	paradisSafeErrorExtra,
	paradisSafeErrorName,
	paradisSafeErrorTags,
	toParadisSentrySafeError,
} from '../../common/paradisSentryDiagnostics.js';

suite('ParadisSentryDiagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('replaces the message and keeps only sanitized frames from our own sources', () => {
		const source = new Error('private response body at file:///Users/alice/private.ts', {
			cause: new Error('private cause'),
		});
		source.stack = [
			'Error: private response body at file:///Users/alice/private.ts',
			'    at parse (/Users/alice/private.ts:1:2)',
			'private multiline continuation',
			'    at request (app:///out/request.js:2:3)',
			'    at fetchStatus (/Users/alice/Applications/Para Code.app/Contents/Resources/app/out/vs/paradis/contrib/serviceStatus/electron-browser/x.js:10:5)',
			'    at handler (C:\\Users\\alice\\AppData\\Local\\Programs\\Para Code\\resources\\app\\out\\vs\\workbench\\y.js:3:4)',
			'    at ext (~/.para-code/extensions/some.ext-1.0.0/out/z.js:7:8)',
			'    at vendored (/Users/alice/app/node_modules/lib/index.js:1:1)',
		].join('\n');

		const safe = toParadisSentrySafeError('service-status', 'fetch-failed', source);

		assert.notStrictEqual(safe, source);
		assert.deepStrictEqual({
			name: safe.name,
			message: safe.message,
			hasCause: Object.hasOwn(safe, 'cause'),
			stack: safe.stack,
		}, {
			name: 'Error',
			message: 'Para Code diagnostic: service-status.fetch-failed',
			hasCause: false,
			stack: [
				'Error: Para Code diagnostic: service-status.fetch-failed',
				'    at fetchStatus (~/Applications/Para Code.app/Contents/Resources/app/out/vs/paradis/contrib/serviceStatus/electron-browser/x.js:10:5)',
				'    at handler (~\\AppData\\Local\\Programs\\Para Code\\resources\\app\\out\\vs\\workbench\\y.js:3:4)',
			].join('\n'),
		});
	});

	test('falls back to a frame-free stack when no frame is ours', () => {
		const source = new Error('private');
		source.stack = 'Error: private\n    at parse (/Users/alice/private.ts:1:2)';
		assert.strictEqual(toParadisSentrySafeError('terminal', 'spawn', source).stack, 'Error: Para Code diagnostic: terminal.spawn');
	});

	test('keeps Node internal frames and shipped dependencies, but never a user path', () => {
		const source = new Error('write EPIPE');
		source.stack = [
			'Error: write EPIPE',
			'    at afterWriteDispatched (node:internal/stream_base_commons:161:15)',
			'    at node:internal/process/task_queues:105:5',
			'    at readCell (/Users/alice/Applications/Para Code.app/Contents/Resources/app/node_modules.asar/exceljs/lib/xlsx/xform/sheet/cell-xform.js:10:20)',
			'    at C:\\Users\\alice\\AppData\\Local\\Programs\\Para Code\\resources\\app\\node_modules\\@xterm\\xterm\\lib\\xterm.js:1:2',
			'    at native (/Applications/Para Code.app/Contents/Resources/app/node_modules.asar.unpacked/node-pty/lib/index.js:5:6)',
			'    at linux (/usr/share/para-code/resources/app/node_modules/ws/lib/websocket.js:7:8)',
			'    at own (/Users/alice/project/node_modules/private-lib/index.js:1:1)',
			'    at ext (/Users/alice/.para-code/extensions/pub.ext-1.0.0/node_modules/dep/index.js:3:4)',
			`    at long (/Applications/Para Code.app/Contents/Resources/app/node_modules/x/${'a'.repeat(2000)}.js:1:1)`,
		].join('\n');

		assert.strictEqual(toParadisSentrySafeError('terminal', 'write', source).stack, [
			'Error: Para Code diagnostic: terminal.write',
			'    at afterWriteDispatched (node:internal/stream_base_commons:161:15)',
			'    at node:internal/process/task_queues:105:5',
			'    at readCell (app:///node_modules/exceljs/lib/xlsx/xform/sheet/cell-xform.js:10:20)',
			'    at app:///node_modules/@xterm/xterm/lib/xterm.js:1:2',
			'    at native (app:///node_modules/node-pty/lib/index.js:5:6)',
			'    at linux (app:///node_modules/ws/lib/websocket.js:7:8)',
		].join('\n'));
	});

	test('caps foreign frames separately, so a deep dependency stack keeps our own frames', () => {
		const source = new Error('x');
		source.stack = [
			'Error: x',
			...Array.from({ length: 30 }, (_, index) => `    at dep${index} (node:internal/dep:${index + 1}:1)`),
			...Array.from({ length: 25 }, (_, index) => `    at own${index} (app:///out/vs/base/x.js:${index + 1}:1)`),
		].join('\n');
		const lines = toParadisSentrySafeError('f', 'o', source).stack?.split('\n').slice(1) ?? [];
		assert.deepStrictEqual({
			foreign: lines.filter(line => line.includes('node:internal')).length,
			own: lines.filter(line => line.includes('/out/vs/')).length,
		}, { foreign: 10, own: 20 });
	});

	test('hashes a very long message in bounded time', () => {
		// Several normalization patterns are quadratic; unbounded, 40k characters took seconds.
		const message = `${'/a.b-c'.repeat(4_000)} ${'x.y '.repeat(4_000)}`;
		const started = Date.now();
		const hash = paradisErrorMessageHash(new Error(message));
		const elapsed = Date.now() - started;
		assert.deepStrictEqual({ hashed: typeof hash, fast: elapsed < 50 }, { hashed: 'string', fast: true });
	});

	test('extracts content-free facts about the error for the report extras', () => {
		const fileError = Object.assign(new Error(`Unable to write file '/Users/alice/EFOO/config.toml' (Error: EACCES: permission denied, open '/Users/alice/EFOO/config.toml')`), { fileOperationResult: 6 });
		const nodeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
		class ParadisResultRecord { constructor(readonly ok: boolean) { } }
		// Stands in for a minified class name, which changes with every release.
		class Xy { }

		assert.deepStrictEqual({
			fileError: paradisSafeErrorExtra(fileError),
			nodeError: paradisSafeErrorExtra(nodeError),
			moduleError: paradisSafeErrorExtra(Object.assign(new Error('Cannot find module /Users/alice/x.js'), { code: 'ERR_MODULE_NOT_FOUND' })),
			pathShapedCode: paradisSafeErrorExtra(Object.assign(new Error('x'), { code: 'ERR_/Users/alice' })),
			plainObject: paradisSafeErrorExtra({ message: 'private', 'has space': 1, reason: 'x', statusCode: 500 }),
			primitive: paradisSafeErrorExtra('private'),
			outOfRangeResult: paradisSafeErrorExtra(Object.assign(new Error('x'), { fileOperationResult: 99 })),
			ownClassName: paradisSafeErrorName(new ParadisResultRecord(false)),
			minifiedClassName: paradisSafeErrorName(new Xy()),
			builtInClassName: paradisSafeErrorName(new Map()),
		}, {
			fileError: { safe_file_result: 'FILE_PERMISSION_DENIED', safe_errno: 'EACCES' },
			nodeError: { safe_errno: 'EPIPE', safe_syscall: 'write' },
			moduleError: { safe_errno: 'ERR_MODULE_NOT_FOUND' },
			pathShapedCode: {},
			plainObject: { safe_error_keys: 'message,reason,statusCode' },
			primitive: {},
			outOfRangeResult: { safe_file_result: 'fileOperationResult:99' },
			ownClassName: 'object',
			minifiedClassName: 'object',
			builtInClassName: 'Map',
		});
	});

	test('separates frame-less errors by a hash of their message, ignoring paths, quotes and numbers', () => {
		const hash = (message: string) => paradisErrorMessageHash(new Error(message));
		const fingerprint = (error: Error) => {
			const safe = toParadisSentrySafeError('unhandled-error', 'on-unexpected-error', error);
			const frames = safe.stack?.includes('\n') ? [{ filename: 'app:///out/vs/x.js', function: 'f' }] : undefined;
			return paradisSentryFingerprint({
				tags: { 'para.scope': 'patched', 'para.feature': 'unhandled-error', 'para.operation': 'on-unexpected-error', ...paradisSafeErrorTags(error) },
				exception: { values: [{ type: 'Error', stacktrace: frames ? { frames } : undefined }] },
			});
		};
		const stackless = (message: string) => Object.assign(new Error(message), { stack: `Error: ${message}` });
		const withFrame = (message: string) => Object.assign(new Error(message), { stack: `Error: ${message}\n    at f (app:///out/vs/base/x.js:1:1)` });

		assert.deepStrictEqual({
			samePathsGroupTogether: hash(`Cannot open '/Users/alice/a.txt' at line 3`) === hash(`Cannot open '/Users/bob/b.txt' at line 12`),
			spacedPathsGroupTogether: hash('ENOENT: no such file, open /Users/alice/My Project/a.txt') === hash('ENOENT: no such file, open /Users/bob/Other Stuff/b.txt'),
			hostsGroupTogether: hash('getaddrinfo ENOTFOUND api.example.com') === hash('getaddrinfo ENOTFOUND relay.paracode.dev'),
			branchesGroupTogether: hash('worktree para-fix-login already exists') === hash('worktree feature-a-b already exists'),
			uuidsGroupTogether: hash('unknown session 123e4567-e89b-12d3-a456-426614174000') === hash('unknown session c0ffee00-dead-beef-cafe-000000000001'),
			apostropheKeepsText: hash(`Can't find the terminal 3`) === hash(`Can't find the editor 3`),
			longMessagesCut: hash(`${'word '.repeat(40)}one`) === hash(`${'word '.repeat(40)}two`),
			differentMessages: hash('Channel has been closed') === hash('Cannot read properties of undefined (reading \'x\')'),
			noMessage: paradisErrorMessageHash({}),
			stacklessSplit: fingerprint(stackless('Channel has been closed')) === fingerprint(stackless('Unknown channel')),
			framedUnchanged: fingerprint(withFrame('Channel has been closed')) === fingerprint(withFrame('Unknown channel')),
		}, {
			samePathsGroupTogether: true,
			spacedPathsGroupTogether: true,
			hostsGroupTogether: true,
			branchesGroupTogether: true,
			uuidsGroupTogether: true,
			apostropheKeepsText: false,
			longMessagesCut: true,
			differentMessages: false,
			noMessage: undefined,
			stacklessSplit: false,
			framedUnchanged: true,
		});
	});

	test('derives a content-free error name for grouping', () => {
		class ParadisTimeoutError extends Error { override name = 'ParadisTimeoutError'; }
		const throwingName = { get name(): string { throw new Error('private'); } };
		const cases: Array<[unknown, string]> = [
			[new TypeError('x'), 'TypeError'],
			[new ParadisTimeoutError('x'), 'ParadisTimeoutError'],
			[Object.assign(new Error('x'), { name: 'has spaces and /Users/alice' }), 'Error'],
			[{ message: 'private', name: 'RangeError' }, 'RangeError'],
			[{ code: 'ENOENT', errno: -2, syscall: 'open', path: '/Users/alice/secret' }, 'ENOENT'],
			[{ message: 'private', name: 'not an identifier: /Users/alice' }, 'object'],
			[{ vslsStack: [] }, 'object'],
			['private-string-value', 'string'],
			[undefined, 'undefined'],
			[null, 'object'],
			[throwingName, 'unknown'],
			[Object.defineProperty(new Error('x'), 'name', { get: () => undefined }), 'Error'],
			[{ code: 'ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND' }, 'ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND'],
			[{ code: 'deadbeef'.repeat(8) }, 'object'],
		];
		assert.deepStrictEqual(cases.map(([error]) => paradisSafeErrorName(error)), cases.map(([, name]) => name));
	});

	test('does not stringify thrown values or read a throwing stack getter', () => {
		let stackReads = 0;
		const thrownObject = {
			secret: 'private-object-value',
			get stack(): string {
				stackReads++;
				throw new Error('private getter value');
			},
		};

		const fromString = toParadisSentrySafeError('terminal', 'spawn', 'private-string-value');
		const fromObject = toParadisSentrySafeError('terminal', 'spawn', thrownObject);

		assert.strictEqual(fromString.message, 'Para Code diagnostic: terminal.spawn');
		assert.strictEqual(fromObject.message, 'Para Code diagnostic: terminal.spawn');
		assert.ok(!fromString.stack?.includes('private-string-value'));
		assert.ok(!fromObject.stack?.includes('private-object-value'));
		assert.ok(!fromObject.stack?.includes('private getter value'));
		assert.strictEqual(stackReads, 0);
	});

	test('keeps the original error identity until the process adapter boundary', () => {
		const original = new Error('domain-visible-error');
		let received: unknown;
		configureParadisDiagnosticReporter((_scope, _feature, _operation, error) => {
			received = error;
		});

		try {
			reportParadisDiagnosticError('owned', 'mobile-relay', 'backend-acquire', original);
			assert.strictEqual(received, original);
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});
});
