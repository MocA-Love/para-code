/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisPrivilegedSchemeRecorder } from '../../common/paradisPrivilegedSchemes.js';

interface ITestScheme {
	readonly scheme: string;
	readonly privileges?: { readonly secure?: boolean };
}

suite('ParadisPrivilegedSchemeRecorder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createRecorder(): { recorder: ParadisPrivilegedSchemeRecorder<ITestScheme>; calls: ITestScheme[][] } {
		const calls: ITestScheme[][] = [];
		const recorder = new ParadisPrivilegedSchemeRecorder<ITestScheme>(schemes => calls.push(schemes));
		return { recorder, calls };
	}

	test('re-registers the accumulated set so a later caller cannot drop earlier schemes', () => {
		const { recorder, calls } = createRecorder();

		recorder.add([{ scheme: 'vscode-webview' }, { scheme: 'vscode-file' }]);
		recorder.add([{ scheme: 'sentry-ipc' }]);

		assert.deepStrictEqual(calls, [
			[{ scheme: 'vscode-webview' }, { scheme: 'vscode-file' }],
			[{ scheme: 'vscode-webview' }, { scheme: 'vscode-file' }, { scheme: 'sentry-ipc' }],
		]);
	});

	test('replaces a scheme registered twice and keeps its original position', () => {
		const { recorder, calls } = createRecorder();

		recorder.add([{ scheme: 'vscode-file', privileges: { secure: false } }, { scheme: 'sentry-ipc' }]);
		recorder.add([{ scheme: 'vscode-file', privileges: { secure: true } }]);

		assert.deepStrictEqual(calls[calls.length - 1], [
			{ scheme: 'vscode-file', privileges: { secure: true } },
			{ scheme: 'sentry-ipc' },
		]);
	});

	test('snapshots each registration so later mutation of the caller object cannot change it', () => {
		const { recorder, calls } = createRecorder();
		const scheme: { scheme: string; privileges?: { secure?: boolean } } = { scheme: 'vscode-file' };

		recorder.add([scheme]);
		scheme.privileges = { secure: false };
		recorder.add([{ scheme: 'sentry-ipc' }]);

		assert.deepStrictEqual(calls[calls.length - 1], [{ scheme: 'vscode-file' }, { scheme: 'sentry-ipc' }]);
		assert.deepStrictEqual(recorder.registered.map(entry => entry.scheme), ['vscode-file', 'sentry-ipc']);
	});
});
