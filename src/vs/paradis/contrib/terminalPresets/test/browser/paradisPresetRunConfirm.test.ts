/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPresetRunConfirmEntry, paradisShowPresetRunConfirm } from '../../browser/paradisPresetRunConfirm.js';

suite('ParadisPresetRunConfirm', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const entry = (level: IParadisPresetRunConfirmEntry['level'], name = 'prod db'): IParadisPresetRunConfirmEntry => ({
		name, level, host: 'this machine', repository: '/repos/api',
		terminals: [{ name: 'migrate', cwd: '/repos/api/services', commands: ['npm run db:migrate', 'npm run db:verify'] }],
	});

	async function open(entries: readonly IParadisPresetRunConfirmEntry[], act: (root: HTMLElement) => void): Promise<{ readonly result: boolean; readonly seen: Record<string, unknown> }> {
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		try {
			const shown = paradisShowPresetRunConfirm(root, entries);
			const run = root.querySelector<HTMLButtonElement>('.paradis-modal-foot button:last-child')!;
			const seen = {
				focused: mainWindow.document.activeElement?.tagName === 'INPUT' ? 'input' : mainWindow.document.activeElement?.textContent,
				runDisabled: run.disabled,
				commands: [...root.querySelectorAll('.ppc-commands')].map(pre => pre.textContent),
				className: root.querySelector('.paradis-preset-confirm')?.className,
			};
			act(root);
			return { result: await shown, seen: { ...seen, left: root.children.length } };
		} finally {
			root.remove();
		}
	}

	const press = (target: Element, key: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	const typeName = (root: HTMLElement, value: string) => {
		const input = root.querySelector<HTMLInputElement>('.ppc-entry input')!;
		input.value = value;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const runButton = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.paradis-modal-foot button:last-child')!;

	test('Enter cancels unless the focus is on Run; the details list the full commands', async () => {
		const enterOnCancel = await open([entry('details')], root => press(mainWindow.document.activeElement ?? root, 'Enter'));
		const enterOnRun = await open([entry('confirm')], root => {
			runButton(root).focus();
			press(runButton(root), 'Enter');
		});
		assert.deepStrictEqual([enterOnCancel, enterOnRun], [
			{ result: false, seen: { focused: 'やめる', runDisabled: false, commands: ['npm run db:migrate\nnpm run db:verify'], className: 'paradis-preset-confirm paradis-modal paradis-modal-s paradis-focus-none', left: 0 } },
			{ result: true, seen: { focused: 'やめる', runDisabled: false, commands: [], className: 'paradis-preset-confirm paradis-modal paradis-modal-s paradis-focus-none', left: 0 } },
		]);
	});

	test('the name has to be typed before Run can be pressed, and Enter in the field cancels', async () => {
		let disabledWhileWrong: boolean | undefined;
		const typed = await open([entry('type-name')], root => {
			typeName(root, 'prod');
			disabledWhileWrong = runButton(root).disabled;
			typeName(root, ' prod db ');
			runButton(root).click();
		});
		const enterInField = await open([entry('type-name')], root => {
			typeName(root, 'prod db');
			press(root.querySelector('.ppc-entry input')!, 'Enter');
		});
		assert.deepStrictEqual({ typed: typed.result, focused: typed.seen.focused, disabledAtFirst: typed.seen.runDisabled, disabledWhileWrong, enterInField: enterInField.result }, {
			typed: true, focused: 'input', disabledAtFirst: true, disabledWhileWrong: true, enterInField: false,
		});
	});
});
