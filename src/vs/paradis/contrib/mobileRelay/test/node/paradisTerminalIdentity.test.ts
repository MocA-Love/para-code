/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paneTokenFromShellIntegrationNonce, ParadisTerminalIdentityIndex, restoredPaneToken, terminalKeyFromShellIntegrationNonce } from '../../common/paradisTerminalPersistence.js';

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

	test('PTY再採番や別ウィンドウへのdetach後もnonceから同じpane tokenを得る', () => {
		const before = { persistentProcessId: 41, shellIntegrationNonce: 'stable-nonce' };
		const after = { persistentProcessId: 7, shellIntegrationNonce: 'stable-nonce' };

		assert.deepStrictEqual({
			processChanged: before.persistentProcessId !== after.persistentProcessId,
			before: paneTokenFromShellIntegrationNonce(before.shellIntegrationNonce),
			after: paneTokenFromShellIntegrationNonce(after.shellIntegrationNonce),
		}, { processChanged: true, before: 'stable-nonce', after: 'stable-nonce' });
	});

	test('更新前から生存するPTYの実tokenを復元情報から推測なしで引き継ぐ', () => {
		assert.deepStrictEqual({
			revived: restoredPaneToken('nonce', 'existing-process-token'),
			fresh: restoredPaneToken('nonce', undefined),
		}, { revived: 'existing-process-token', fresh: 'nonce' });
	});

	test('不正な復元tokenは採用せずnonceへフォールバックする', () => {
		assert.strictEqual(restoredPaneToken('stable-nonce', ''), 'stable-nonce');
		assert.strictEqual(restoredPaneToken('stable-nonce', 'x'.repeat(201)), 'stable-nonce');
	});

	test('detachとreattachが同じ永続キーを一時共有しても新しいinstanceだけを所有者にする', () => {
		const index = new ParadisTerminalIdentityIndex();
		index.bind(10, 'terminal:stable-nonce');
		index.bind(20, 'terminal:stable-nonce');

		assert.deepStrictEqual({
			oldKey: index.getTerminalKey(10),
			newKey: index.getTerminalKey(20),
			owner: index.getInstanceId('terminal:stable-nonce'),
		}, {
			oldKey: undefined,
			newKey: 'terminal:stable-nonce',
			owner: 20,
		});

		index.unbind(10);
		assert.strictEqual(index.getInstanceId('terminal:stable-nonce'), 20);
		index.unbind(20);
		assert.strictEqual(index.getInstanceId('terminal:stable-nonce'), undefined);
	});
});
