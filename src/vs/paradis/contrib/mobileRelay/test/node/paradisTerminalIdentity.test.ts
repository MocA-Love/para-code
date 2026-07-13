/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalExitReason } from '../../../../../platform/terminal/common/terminal.js';
import { shouldRemovePersistedTerminalIdentity, terminalKeyFromShellIntegrationNonce } from '../../common/paradisTerminalPersistence.js';

suite('ParadisTerminalIdentity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('PTYの数値IDが再起動で変わってもshell integration nonceから同じterminalKeyを得る', () => {
		const beforeRestart = { persistentProcessId: 41, shellIntegrationNonce: 'stable-nonce' };
		const afterRestart = { persistentProcessId: 7, shellIntegrationNonce: 'stable-nonce' };

		assert.notStrictEqual(beforeRestart.persistentProcessId, afterRestart.persistentProcessId);
		assert.strictEqual(
			terminalKeyFromShellIntegrationNonce(beforeRestart.shellIntegrationNonce),
			terminalKeyFromShellIntegrationNonce(afterRestart.shellIntegrationNonce),
		);
	});

	test('異なるshell integration nonceは異なるterminalKeyになる', () => {
		assert.notStrictEqual(
			terminalKeyFromShellIntegrationNonce('nonce-a'),
			terminalKeyFromShellIntegrationNonce('nonce-b'),
		);
	});

	test('Rendererまたはアプリ再起動では永続ペイントークンを残す', () => {
		assert.strictEqual(shouldRemovePersistedTerminalIdentity(TerminalExitReason.Shutdown), false);
	});

	test('終了理由が不明な場合も復元に備えて永続ペイントークンを残す', () => {
		assert.strictEqual(shouldRemovePersistedTerminalIdentity(TerminalExitReason.Unknown), false);
	});

	test('明示終了と実プロセス終了では永続ペイントークンを削除する', () => {
		assert.strictEqual(shouldRemovePersistedTerminalIdentity(TerminalExitReason.User), true);
		assert.strictEqual(shouldRemovePersistedTerminalIdentity(TerminalExitReason.Process), true);
		assert.strictEqual(shouldRemovePersistedTerminalIdentity(TerminalExitReason.Extension), true);
	});
});
