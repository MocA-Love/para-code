/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { XtermTerminal } from '../../../../../workbench/contrib/terminal/browser/xterm/xtermTerminal.js';
import { ParadisTerminalResizeDebouncer } from '../../browser/paradisTerminalResizeDebouncer.js';

suite('ParadisTerminalResizeDebouncer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** 本家が即座に xterm と pty へ渡す、短いバッファ (200 行未満) の端末を作る。 */
	function create(): { debouncer: ParadisTerminalResizeDebouncer; sent: string[] } {
		const sent: string[] = [];
		const xterm = { raw: { buffer: { normal: { length: 10 } }, element: mainWindow.document.body } } as unknown as XtermTerminal;
		const debouncer = store.add(new ParadisTerminalResizeDebouncer(
			() => true,
			() => xterm,
			(cols, rows) => sent.push(`${cols}x${rows}`),
			cols => sent.push(`${cols}x-`),
			rows => sent.push(`-x${rows}`),
		));
		return { debouncer, sent };
	}

	const nextMicrotask = () => new Promise<void>(resolve => queueMicrotask(resolve));

	test('sends only the final size when splitting the right column relayouts the left pane full width and back', async () => {
		const { debouncer, sent } = create();
		// GridView.addView が右の列を外して入れ直す間に、左のペインが同期で 2 回 layout される。
		debouncer.resize(58, 41, false);
		debouncer.resize(27, 41, false);
		const beforeMicrotask = [...sent];
		await nextMicrotask();
		assert.deepStrictEqual({ beforeMicrotask, sent }, { beforeMicrotask: [], sent: ['27x41'] });
	});

	test('sends each size that arrives in a separate task, like dragging the sash', async () => {
		const { debouncer, sent } = create();
		debouncer.resize(30, 41, false);
		await nextMicrotask();
		debouncer.resize(31, 41, false);
		await nextMicrotask();
		assert.deepStrictEqual(sent, ['30x41', '31x41']);
	});

	test('sends an explicit immediate resize synchronously and drops the pending one', async () => {
		const { debouncer, sent } = create();
		debouncer.resize(58, 41, false);
		debouncer.resize(27, 41, true);
		const synchronously = [...sent];
		await nextMicrotask();
		assert.deepStrictEqual({ synchronously, sent }, { synchronously: ['27x41'], sent: ['27x41'] });
	});

	test('flush sends the pending size synchronously', async () => {
		const { debouncer, sent } = create();
		debouncer.resize(27, 41, false);
		debouncer.flush();
		const synchronously = [...sent];
		await nextMicrotask();
		assert.deepStrictEqual({ synchronously, sent }, { synchronously: ['27x41'], sent: ['27x41'] });
	});
});
