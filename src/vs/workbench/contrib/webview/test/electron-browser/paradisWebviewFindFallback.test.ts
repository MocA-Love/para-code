/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisWebviewFindFallbackCapability, ParadisWebviewFindFallbackState } from '../../electron-browser/webviewElement.js';

suite('ParadisWebviewFindFallbackState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('starts on the Electron path and changes the shared capability after a failed request', () => {
		const capability: IParadisWebviewFindFallbackCapability = { unsupported: false };
		const state = new ParadisWebviewFindFallbackState(capability);

		assert.strictEqual(state.isUnsupported, false);
		assert.strictEqual(state.activate(), true);
		assert.strictEqual(state.isUnsupported, true);
		assert.strictEqual(capability.unsupported, true);
	});

	test('allows only one in-flight answer to rerun a search in the same webview', () => {
		const state = new ParadisWebviewFindFallbackState({ unsupported: false });

		assert.strictEqual(state.activate(), true);
		assert.strictEqual(state.activate(), false);
		assert.strictEqual(state.activate(), false);
	});

	test('shares unsupported capability with another webview without sharing its retry state', () => {
		const capability: IParadisWebviewFindFallbackCapability = { unsupported: false };
		const first = new ParadisWebviewFindFallbackState(capability);
		const second = new ParadisWebviewFindFallbackState(capability);

		assert.strictEqual(first.activate(), true);
		assert.strictEqual(second.isUnsupported, true);
		assert.strictEqual(first.activate(), false);
	});
});
