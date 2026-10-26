/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { transformErrorFromSerialization } from '../../../../../base/common/errors.js';
import { ListenerLeakError, ListenerRefusalError } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSafeErrorExtra } from '../../common/paradisSentryDiagnostics.js';
import { paradisErrorStack, paradisExtensionIdFromStack, paradisIsExtensionHostRelay, paradisUnhandledErrorSafeExtra } from '../../common/paradisUnhandledErrorExtra.js';

suite('paradisUnhandledErrorSafeExtra', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the listener count, leak kind and emitter name of a listener leak, and nothing else', () => {
		assert.deepStrictEqual([
			paradisUnhandledErrorSafeExtra(new ListenerLeakError('dominated', 'details at /Users/example', 'stack', 175, 'contextKeyService')),
			paradisUnhandledErrorSafeExtra(new ListenerRefusalError('popular', 'details', 'stack', 1500)),
			paradisUnhandledErrorSafeExtra(Object.assign(new Error('plain'), { code: 'ERR_MODULE_NOT_FOUND' })),
			paradisUnhandledErrorSafeExtra('text'),
		], [
			{ safe_listener_count: 175, safe_leak_kind: 'dominated', safe_emitter_name: 'contextKeyService' },
			{ safe_listener_count: 1500, safe_leak_kind: 'popular' },
			undefined,
			undefined,
		]);
	});

	test('an extension host error keeps its Node code through serialization, so every report gets safe_errno', () => {
		const fromExtensionHost = transformErrorFromSerialization({ $isError: true, name: 'Error', message: 'Cannot find module /Users/example/x.js', stack: '', noTelemetry: false, code: 'ERR_MODULE_NOT_FOUND' });
		assert.deepStrictEqual(paradisSafeErrorExtra(fromExtensionHost), { safe_errno: 'ERR_MODULE_NOT_FOUND' });
	});

	test('tells an error the extension host relayed from one raised in the workbench by the caller stack', () => {
		const relayed = 'Error\n    at ws.<anonymous> (app:///out/vs/workbench/workbench.desktop.main.js:1:1)\n    at Kx.onUnexpectedError (app:///out/vs/workbench/workbench.desktop.main.js:1:2)\n    at Ob.$onUnexpectedError (app:///out/vs/workbench/workbench.desktop.main.js:1:3)';
		const local = 'Error\n    at ws.<anonymous> (app:///out/vs/workbench/workbench.desktop.main.js:1:1)\n    at Kx.onUnexpectedError (app:///out/vs/workbench/workbench.desktop.main.js:1:2)';
		assert.deepStrictEqual([paradisIsExtensionHostRelay(relayed), paradisIsExtensionHostRelay(local), paradisIsExtensionHostRelay(undefined)], [true, false, false]);
	});

	test('takes only the public identifier of the extension whose file is the top extension frame, never the path', () => {
		const stack = (...frames: string[]) => ['Error: Extension failed at /Users/example/secret/extensions/not.this-1.0.0/x.js', ...frames.map(frame => `\tat ${frame}`)].join('\n');
		assert.deepStrictEqual({
			installed: paradisExtensionIdFromStack(stack(
				'ExtHostCommentController.set (app:///out/vs/workbench/api/node/extensionHostProcess.js:1:2)',
				'activate (/Users/example/.para-code/extensions/GitHub.vscode-pull-request-github-0.172.0/dist/extension.js:2:3)',
				'other (/Users/example/.para-code/extensions/eamodio.gitlens-17.0.0/dist/gitlens.js:4:5)',
			)),
			platformSpecific: paradisExtensionIdFromStack(stack('run (/home/example/.para-code-server/extensions/ms-python.python-2026.18.0-linux-x64/out/client.js:1:1)')),
			fileUrl: paradisExtensionIdFromStack(stack('run (file:///c%3A/Users/example/.para-code/extensions/ms-vscode.cpptools-1.2.3-win32-x64/dist/main.js:1:1)')),
			windows: paradisExtensionIdFromStack(stack('run (C:\\Users\\example\\.para-code\\extensions\\dbaeumer.vscode-eslint-3.0.10\\client\\out\\extension.js:1:1)')),
			builtin: paradisExtensionIdFromStack(stack('run (/Applications/Para Code.app/Contents/Resources/app/extensions/git/dist/main.js:1:1)')),
			builtinWithoutResources: paradisExtensionIdFromStack(stack('run (/Users/example/work/app/extensions/my-private-project/main.js:1:1)')),
			developmentFolder: paradisExtensionIdFromStack(stack('run (/Users/example/projects/extensions/my-private-project/out/extension.js:1:1)')),
			nodeOnly: paradisExtensionIdFromStack(stack('ChildProcess.emit (node:events:514:28)', 'maybeClose (node:internal/child_process:1141:16)')),
			missing: paradisExtensionIdFromStack(undefined),
		}, {
			installed: 'github.vscode-pull-request-github',
			platformSpecific: 'ms-python.python',
			fileUrl: 'ms-vscode.cpptools',
			windows: 'dbaeumer.vscode-eslint',
			builtin: 'builtin:git',
			builtinWithoutResources: undefined,
			developmentFolder: undefined,
			nodeOnly: undefined,
			missing: undefined,
		});
	});

	test('takes extensions only as a whole folder name and reads at most 1,000 characters of a frame line', () => {
		assert.deepStrictEqual({
			suffixFolder: paradisExtensionIdFromStack('Error: x\n\tat run (/Users/example/my-extensions/acme.secret-1.0.0/main.js:1:1)'),
			pastLineLimit: paradisExtensionIdFromStack(`Error: x\n\tat run (/${'a'.repeat(1_000)}/.para-code/extensions/pub.name-1.0.0/main.js:1:1)`),
			longWord: paradisExtensionIdFromStack(`Error: x\n\tat ${'a'.repeat(20_000)}`),
		}, {
			suffixFolder: undefined,
			pastLineLimit: undefined,
			longWord: undefined,
		});
	});

	test('reads the stack of a relayed error and survives a throwing getter', () => {
		const relayed = transformErrorFromSerialization({ $isError: true, name: 'Error', message: 'x', stack: 'Error: x\n\tat a (/Users/example/.para-code/extensions/pub.name-1.0.0/a.js:1:1)', noTelemetry: false });
		const throwing = Object.defineProperty({}, 'stack', { get() { throw new Error('no'); } });
		assert.deepStrictEqual([paradisExtensionIdFromStack(paradisErrorStack(relayed)), paradisErrorStack(throwing), paradisErrorStack('text')], ['pub.name', undefined, undefined]);
	});
});
