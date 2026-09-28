/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { IParadisInputModeTerminal, IParadisLiveInputModes, ParadisTerminalArmedInputModes, ParadisTerminalInputModeGuard } from '../../common/paradisTerminalArmedInputModes.js';

const ALL_ON: IParadisLiveInputModes = { mouseTrackingMode: 'any', sendFocusMode: true, applicationKeypadMode: true };

suite('ParadisTerminalArmedInputModes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resets only what the command armed and left on', () => {
		const model = new ParadisTerminalArmedInputModes();
		model.privateModes([1004], true); // シェルが前から有効にしていた
		model.commandStarted();
		model.privateModes([1000, 1006, 2004, 1], true);
		model.commandStarted(); // 実行中の開始の報告し直しでは忘れない
		model.privateModes([1003], true);
		model.privateModes([1003], false);
		model.kittyPush();
		model.kittyPush();
		model.kittyPop(1);
		const left = model.commandFinished();
		assert.deepStrictEqual({ left, sequence: model.takeResetSequence(ALL_ON), again: model.takeResetSequence(ALL_ON) }, {
			left: true,
			sequence: '\x1b[?1000;1006l\x1b[<1u',
			again: '',
		});
	});

	test('does nothing when the agent exited cleanly or the start was missed', () => {
		const clean = new ParadisTerminalArmedInputModes();
		clean.commandStarted();
		clean.privateModes([1000, 1004], true);
		clean.kittyPush();
		clean.privateModes([1000, 1004], false);
		clean.kittyPop(1);

		const missedStart = new ParadisTerminalArmedInputModes();
		missedStart.privateModes([1000], true);

		assert.deepStrictEqual([clean.commandFinished(), missedStart.commandFinished(), missedStart.takeResetSequence(ALL_ON)], [false, false, '']);
	});

	test('leaves modes the shell arms again at its prompt and kitty flags it pushes', () => {
		const model = new ParadisTerminalArmedInputModes();
		model.commandStarted();
		model.privateModes([1004, 1002], true);
		model.kittyPush();
		model.commandFinished();
		// fish などがプロンプトでフォーカス報告と Kitty のフラグを入れ直す
		model.privateModes([1004], true);
		model.kittyPush();
		assert.deepStrictEqual(model.takeResetSequence(ALL_ON), '\x1b[?1002l');
	});

	test('skips modes xterm no longer has on, and tracks kitty flags per screen', () => {
		const model = new ParadisTerminalArmedInputModes();
		model.commandStarted();
		model.kittyPush(); // 主画面
		model.privateModes([1049], true);
		model.kittyPush(); // 代替画面
		model.kittyPush();
		model.privateModes([1000, 1004, 66], true);
		model.commandFinished();
		assert.deepStrictEqual(model.takeResetSequence({ mouseTrackingMode: 'none', sendFocusMode: false, applicationKeypadMode: true }), '\x1b[?66l\x1b[<2u');
	});

	test('forgets everything on a full reset', () => {
		const model = new ParadisTerminalArmedInputModes();
		model.commandStarted();
		model.privateModes([1000], true);
		model.kittyPush();
		model.fullReset();
		assert.deepStrictEqual(model.commandFinished(), false);
	});
});

suite('ParadisTerminalInputModeGuard', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	class FakeTerminal implements IParadisInputModeTerminal {
		modes: IParadisLiveInputModes = ALL_ON;
		readonly written: string[] = [];
		readonly csi = new Map<string, (params: (number | number[])[]) => boolean>();
		esc: (() => boolean) | undefined;
		disposedHooks = 0;
		readonly parser = {
			registerCsiHandler: (id: { prefix?: string; final: string }, callback: (params: (number | number[])[]) => boolean) => {
				this.csi.set(`${id.prefix ?? ''}${id.final}`, callback);
				return { dispose: () => { this.disposedHooks++; } };
			},
			registerEscHandler: (_id: { final: string }, callback: () => boolean) => {
				this.esc = callback;
				return { dispose: () => { this.disposedHooks++; } };
			},
		};
		write(data: string, callback?: () => void): void {
			if (data.length > 0) {
				this.written.push(data);
			}
			callback?.();
		}
		/** パーサーが列を読んだときの呼び出しを再現する。xterm 本来の処理へ流したか（false）を返す。 */
		feed(key: string, params: (number | number[])[]): boolean {
			return this.csi.get(key)!(params);
		}
	}

	test('writes the reset after the shell prompt settles and never consumes the sequences', () => runWithFakedTimers({}, async () => {
		const terminal = new FakeTerminal();
		const resets: string[] = [];
		const guard = new ParadisTerminalInputModeGuard(terminal, sequence => resets.push(sequence), 100);
		guard.commandStarted();
		const consumed = [terminal.feed('?h', [[1000], 1006]), terminal.feed('>u', [1]), terminal.feed('?h', [1004])].some(result => result);
		guard.commandFinished();
		const beforeSettle = [...terminal.written];
		terminal.feed('?h', [1004]); // シェルがプロンプトで入れ直した
		await new Promise(resolve => setTimeout(resolve, 150));
		guard.dispose();
		assert.deepStrictEqual({ consumed, beforeSettle, written: terminal.written, resets, disposedHooks: terminal.disposedHooks }, {
			consumed: false,
			beforeSettle: [],
			written: ['\x1b[?1000;1006l\x1b[<1u'],
			resets: ['\x1b[?1000;1006l\x1b[<1u'],
			disposedHooks: 5,
		});
	}));

	test('drops a pending reset when the next agent command starts or the terminal goes away', () => runWithFakedTimers({}, async () => {
		const terminal = new FakeTerminal();
		const guard = new ParadisTerminalInputModeGuard(terminal, undefined, 100);
		guard.commandStarted();
		terminal.feed('?h', [1000]);
		guard.commandFinished();
		guard.commandStarted();
		await new Promise(resolve => setTimeout(resolve, 150));
		const afterRestart = [...terminal.written];
		terminal.feed('?h', [1002]);
		guard.commandFinished();
		guard.dispose();
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.deepStrictEqual({ afterRestart, written: terminal.written }, { afterRestart: [], written: [] });
	}));
});
