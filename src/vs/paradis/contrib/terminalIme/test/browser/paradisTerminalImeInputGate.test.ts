/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IXtermTerminal } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisBlockTerminalInput, paradisResetTerminalInputGateForTest } from '../../../workspaceSwitch/browser/paradisTerminalInputGate.js';
import { ParadisTerminalImeInputGateContribution } from '../../browser/paradisTerminalImeInputGate.contribution.js';

suite('ParadisTerminalImeInputGate', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => paradisResetTerminalInputGateForTest());

	function setup() {
		const element = mainWindow.document.createElement('div');
		const textarea = mainWindow.document.createElement('textarea');
		element.appendChild(textarea);
		mainWindow.document.body.appendChild(element);
		const seen: string[] = [];
		for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) {
			// xterm と同じく、テキストエリア自身に付けたリスナー
			textarea.addEventListener(type, () => seen.push(type), true);
		}
		const contribution = store.add(new ParadisTerminalImeInputGateContribution());
		contribution.xtermOpen({ raw: { element, textarea } as unknown as RawXtermTerminal } as IXtermTerminal & { raw: RawXtermTerminal });
		const fire = (type: string) => textarea.dispatchEvent(type === 'input' ? new InputEvent('input', { bubbles: true, data: 'a' }) : new CompositionEvent(type, { bubbles: true, data: 'a' }));
		return { element, textarea, seen, fire };
	}

	test('hides compositions that start during a space switch and keeps ones already running', () => {
		const { element, textarea, seen, fire } = setup();
		// ゲートが立つ前に始まった変換は、そのまま通す
		fire('compositionstart');
		const gate = paradisBlockTerminalInput();
		fire('compositionupdate');
		fire('compositionend');
		const passed = seen.splice(0);
		// ゲート中に始まった変換と、それ以外の入力は xterm に見せない
		fire('compositionstart');
		fire('compositionupdate');
		textarea.value = 'あ';
		fire('compositionend');
		fire('input');
		const swallowed = seen.splice(0);
		const valueAfter = textarea.value;
		gate.dispose();
		fire('input');
		element.remove();
		assert.deepStrictEqual({ passed, swallowed, valueAfter, afterGate: seen }, {
			passed: ['compositionstart', 'compositionupdate', 'compositionend'],
			swallowed: [],
			valueAfter: '',
			afterGate: ['input'],
		});
	});
});
