/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { importAMDNodeModule } from '../../../../../amdX.js';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import type { ITerminalCommand } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { PromptInputModel, PromptInputState } from '../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { TestXtermLogger } from '../../../../../platform/terminal/test/common/terminalTestHelpers.js';
import { PARADIS_EXTERNAL_PROMPT_CHANGE_MS, paradisPromptTextWithoutGhost } from '../../common/paradisTerminalHistoryNavigation.js';
import { ParadisTypedPrefixTracker, paradisApplyTypedInput, paradisPromptTextAfterCursor, paradisPromptTextBeforeCursor } from '../../common/paradisTerminalTypedPrefix.js';

/** 架空の p10k 風のプロンプト（シェル統合の入力行に混ざったときの見え方）。 */
const PROMPT = '~/proj/demo !3 ?1 > ';
const TAB = '\t';
const LEFT = '\x1b[D';
const UP = '\x1b[A';

/** 入力行。カーソルは `|`、ゴースト文字は `[...]`（無ければ末尾にカーソル）。 */
function model(text: string): { state: PromptInputState; value: string; ghostTextIndex: number; cursorIndex: number } {
	let cursorIndex = text.indexOf('|');
	let value = cursorIndex === -1 ? text : text.substring(0, cursorIndex) + text.substring(cursorIndex + 1);
	const ghostStart = value.indexOf('[');
	if (ghostStart !== -1) {
		value = value.substring(0, ghostStart) + value.substring(ghostStart + 1).replace(/\]$/, '');
	}
	if (cursorIndex === -1) {
		cursorIndex = ghostStart === -1 ? value.length : ghostStart;
	}
	return { state: PromptInputState.Input, value, ghostTextIndex: ghostStart, cursorIndex };
}

type Event =
	| { readonly kind: 'input'; readonly data: string; readonly at?: number }
	| { readonly kind: 'line'; readonly line: string; readonly at?: number }
	| { readonly kind: 'started' }
	| { readonly kind: 'executed' }
	| { readonly kind: 'finished' }
	| { readonly kind: 'check'; readonly at?: number }
	| { readonly kind: 'cursorAtEnd' };

const input = (data: string, at?: number): Event => ({ kind: 'input', data, at });
const line = (text: string, at?: number): Event => ({ kind: 'line', line: text, at });
const check = (at?: number): Event => ({ kind: 'check', at });
const cursorAtEnd = (): Event => ({ kind: 'cursorAtEnd' });
const STARTED: Event = { kind: 'started' };
const EXECUTED: Event = { kind: 'executed' };
const FINISHED: Event = { kind: 'finished' };

/**
 * 入力と入力行の変化を届いた順に流し、`check` の時点の前方一致の文字と、`cursorAtEnd` の時点の
 * 「カーソルの後ろは入力ではない」を並べる。
 */
function play(events: readonly Event[]): (string | boolean | undefined)[] {
	const tracker = new ParadisTypedPrefixTracker();
	let current = model('');
	const result: (string | boolean | undefined)[] = [];
	for (const event of events) {
		switch (event.kind) {
			case 'input':
				tracker.input(event.data, event.at ?? 0);
				break;
			case 'line':
				current = model(event.line);
				tracker.prompt(current, event.at ?? 0);
				break;
			case 'started':
				tracker.promptStarted();
				break;
			case 'executed':
				tracker.commandExecuted();
				break;
			case 'finished':
				tracker.commandFinished();
				break;
			case 'check':
				result.push(tracker.resolve(current, event.at ?? 0));
				break;
			case 'cursorAtEnd':
				result.push(tracker.cursorAtEndOfTyped(current));
				break;
		}
	}
	return result;
}

/** 1 文字ずつ打ち、シェルが `head` の後ろに打った文字と `ghost`（薄い文字）を返す流れ。 */
function typeOn(head: string, text: string, ghost = '', from = ''): Event[] {
	const events: Event[] = [];
	let typed = from;
	for (const char of text) {
		typed += char;
		events.push(input(char), line(`${head}${typed}${ghost ? `[${ghost}]` : ''}`));
	}
	return events;
}

suite('ParadisTerminalTypedPrefix', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('builds the text before the cursor from the keys sent to the shell', () => {
		const inputs = {
			letter: ['git', 'c'],
			japanese: ['ls ', 'あいう'],
			paste: ['git ', '\x1b[200~log --oneline\x1b[201~'],
			pasteWithNewline: ['', '\x1b[200~ls\nll\x1b[201~'],
			backspace: ['git', '\x7f'],
			backspaces: ['git', '\x7f\x7f\x7f\x7f'],
			backspaceEmoji: ['echo 🙂', '\x7f'],
			deleteKey: ['git', '\x1b[3~'],
			enter: ['git', '\r'],
			enterAfterUnknown: [undefined, '\r'],
			ctrlC: ['git', '\x03'],
			ctrlCAfterUnknown: [undefined, '\x03'],
			ctrlU: ['git', '\x15'],
			ctrlUAfterUnknown: [undefined, '\x15'],
			ctrlG: ['git', '\x07'],
			ctrlW: ['git status', '\x17'],
			tab: ['git ch', TAB],
			left: ['git', LEFT],
			up: ['', UP],
			escape: ['ls', '\x1b'],
			focusReply: ['git', '\x1b[I'],
			letterAfterUnknown: [undefined, 'x'],
		} satisfies Record<string, [string | undefined, string]>;
		const results = Object.fromEntries(Object.entries(inputs).map(([name, [before, data]]) => [name, paradisApplyTypedInput(before, data)]));
		assert.deepStrictEqual(results, {
			letter: 'gitc',
			japanese: 'ls あいう',
			paste: 'git log --oneline',
			pasteWithNewline: undefined,
			backspace: 'gi',
			backspaces: '',
			backspaceEmoji: 'echo ',
			deleteKey: 'git',
			enter: '',
			enterAfterUnknown: undefined,
			ctrlC: '',
			ctrlCAfterUnknown: undefined,
			ctrlU: '',
			ctrlUAfterUnknown: undefined,
			ctrlG: undefined,
			ctrlW: undefined,
			tab: undefined,
			left: undefined,
			up: undefined,
			escape: undefined,
			focusReply: 'git',
			letterAfterUnknown: undefined,
		});
	});

	test('reads only the text before the cursor, without ghost text', () => {
		assert.deepStrictEqual({
			before: paradisPromptTextBeforeCursor(model('git ch|eckout[ main]')),
			after: paradisPromptTextAfterCursor(model('git ch|eckout[ main]')),
			noCursor: paradisPromptTextBeforeCursor({ ...model('git'), cursorIndex: -1 }),
			executing: paradisPromptTextBeforeCursor({ ...model('git'), state: PromptInputState.Execute }),
		}, { before: 'git ch', after: 'eckout', noCursor: undefined, executing: undefined });
	});

	test('uses only the typed text when the line includes the prompt, a right prompt and undetected ghost text', () => {
		// 入力行（value）にプロンプトの表示・薄い文字（判定に漏れた）・右プロンプトが入ったまま。
		const screen = `${PROMPT}docke|r compose up -d         main 12:00`;
		const events: Event[] = [
			STARTED,
			line(PROMPT),
			...typeOn(PROMPT, 'docke'),
			line(screen),
			check(),
		];
		assert.deepStrictEqual({
			before: paradisPromptTextWithoutGhost(model(screen)),
			after: play(events),
		}, {
			before: `${PROMPT}docker compose up -d         main 12:00`,
			after: ['docke'],
		});
	});

	test('keeps the typed text after Tab completion or cursor moves by removing the prompt it learned', () => {
		assert.deepStrictEqual(play([
			STARTED,
			line(PROMPT),
			...typeOn(PROMPT, 'git ch', 'eckout main'),
			check(),
			input(TAB), line(`${PROMPT}git checkout `),
			check(),
			input('m'), line(`${PROMPT}git checkout m[ain]`),
			check(),
			input(LEFT), line(`${PROMPT}git checkout |m`),
			check(),
		]), ['git ch', 'git checkout ', 'git checkout m', 'git checkout ']);
	});

	test('does not take a line confirmed in a completion menu as the prompt', () => {
		// oh-my-zsh の menu select・fzf-tab では、補完の候補を選ぶ Enter はコマンドを実行しない
		// （実行の印も次のプロンプトも来ない）。続けて打った文字に、選んだ候補を付けたまま一致させる。
		assert.deepStrictEqual(play([
			STARTED,
			line(PROMPT),
			...typeOn(PROMPT, 'cd s'),
			input(TAB), line(`${PROMPT}cd src/`),
			input('\r'), line(`${PROMPT}cd src/`),
			input('b'), line(`${PROMPT}cd src/b`),
			check(),
			cursorAtEnd(),
			// 候補を選ばずに Ctrl+C で抜けても（fzf-tab は打っていた行に戻す）同じ。
			input('\x7f'), line(`${PROMPT}cd src/`),
			input('\x03'), line(`${PROMPT}cd src/`),
			input('b'), line(`${PROMPT}cd src/b`),
			check(),
		]), ['cd src/b', false, 'cd src/b']);
	});

	test('learns the prompt even when the shell integration marks are missing (no prompt start)', () => {
		// コマンドの開始の印が届かないまま入力行が読まれている（打ち始める前の行がプロンプトだけ）。
		assert.deepStrictEqual(play([
			STARTED,
			...typeOn('', 'pwd'),
			input('\r'), line(PROMPT),
			...typeOn(PROMPT, 'ls'),
			check(),
			input(TAB), line(`${PROMPT}ls -la`),
			check(),
		]), ['ls', 'ls -la']);
	});

	test('gives up when it cannot tell where the typed text starts', () => {
		assert.deepStrictEqual(play([
			// 途中から始まった（ウィンドウを開き直した）ターミナルでは、打った文字が分からない。
			line(`${PROMPT}git st`),
			check(),
			input(TAB), line(`${PROMPT}git status`),
			check(),
			// 次のプロンプトからは分かる。
			input('\r'), EXECUTED, STARTED, line(PROMPT),
			...typeOn(PROMPT, 'git'),
			check(),
			// 右プロンプトの非同期の更新でプロンプトが描き直され、頭の長さが変わった。
			input(TAB), line(`~/proj/demo !4 ?1 > git`),
			check(),
		]), [undefined, undefined, 'git', undefined]);
	});

	test('waits for the shell to echo the typed text, then reads the line once it changed without typing', () => {
		// 末尾の空白はシェル統合が詰めることがあるので、空白の echo を待たずに打った文字を使う。
		assert.deepStrictEqual(play([
			STARTED,
			line(PROMPT),
			...typeOn(PROMPT, 'git'),
			input(' ', 100),
			check(110),
			line(`${PROMPT}git `, 120),
			check(130),
			// 補完の候補が入力を通らずに入った。
			line(`${PROMPT}git checkout `, 200),
			check(210),
			check(100 + PARADIS_EXTERNAL_PROMPT_CHANGE_MS + 1),
		]), ['git ', 'git ', undefined, 'git checkout ']);
	});

	test('starts from the line of a terminal restored at an empty prompt', () => {
		// 再読み込み・常駐のシェルへのつなぎ直しでは、次のプロンプトの印を待たずに入力行から始める。
		assert.deepStrictEqual({
			empty: play([line(''), ...typeOn('', 'git'), check(), cursorAtEnd()]),
			withPrompt: play([line(PROMPT), ...typeOn(PROMPT, 'git'), check()]),
			leftover: play([line('git st'), ...typeOn('', 'a', '', 'git st'), check()]),
		}, {
			empty: ['git', false],
			withPrompt: [undefined],
			leftover: [undefined],
		});
	});

	test('follows what was typed before the next prompt when the shell shows it', () => {
		const make = [STARTED, line(''), ...typeOn('', 'make'), input('\r'), EXECUTED];
		assert.deepStrictEqual({
			// SSH で、前のコマンドが終わってから次のプロンプトが届くまでに打った。
			afterFinish: play([...make, FINISHED, input('l'), input('s'), STARTED, line(''), line('ls'), check(), ...typeOn('', ' -la', '', 'ls'), check()]),
			// 実行中に打った文字を、次のプロンプトでシェルが出した。
			echoed: play([...make, input('ls'), FINISHED, STARTED, line(''), line('ls'), check()]),
			// 実行中のプログラムが読んだ（次のプロンプトは空のまま）。
			consumed: play([...make, input('q'), FINISHED, STARTED, line(''), ...typeOn('', 'git'), check()]),
			// 一部だけ読まれた。どちらとも合わないので開かない。
			partlyConsumed: play([...make, input('abc'), FINISHED, STARTED, line(''), line('bc'), ...typeOn('', 'd', '', 'bc'), check()]),
		}, {
			afterFinish: ['ls', 'ls -la'],
			echoed: ['ls'],
			consumed: ['git'],
			partlyConsumed: [undefined],
		});
	});

	test('tells whether the text after the cursor is input only when the typed text came from the keys', () => {
		assert.deepStrictEqual(play([
			STARTED,
			line(PROMPT),
			...typeOn(PROMPT, 'git', 'checkout'),
			cursorAtEnd(),
			// 入力を通らずに入力行が変わり（カーソルの後ろに文字がある）、入力行から読んだ。
			line(`${PROMPT}git ch|eckout`, 100),
			check(100 + PARADIS_EXTERNAL_PROMPT_CHANGE_MS + 1),
			cursorAtEnd(),
		]), [true, 'git ch', false]);
	});

	test('does not count what was typed while a command was running', () => {
		assert.deepStrictEqual(play([
			STARTED,
			...typeOn(PROMPT, 'make'),
			input('\r'), EXECUTED,
			input('ls'),
			STARTED, line(`${PROMPT}ls`),
			check(),
			input('\r'), EXECUTED,
			STARTED, line(PROMPT),
			...typeOn(PROMPT, 'pwd'),
			check(),
		]), [undefined, 'pwd']);
	});

	test('reads the typed text from a real prompt input model whose command start was taken before the prompt was drawn', async () => {
		const TerminalCtor = (await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js')).Terminal;
		const xterm = store.add(new TerminalCtor({ allowProposedApi: true, logger: TestXtermLogger, cols: 80 }));
		const onCommandStart = store.add(new Emitter<ITerminalCommand>());
		const promptInputModel = store.add(new PromptInputModel(xterm, onCommandStart.event, store.add(new Emitter<void>()).event, store.add(new Emitter<ITerminalCommand>()).event, store.add(new Emitter<ITerminalCommand>()).event, new NullLogService()));
		const write = (data: string) => new Promise<void>(resolve => xterm.write(data, resolve));
		const tracker = new ParadisTypedPrefixTracker();
		const sync = async () => {
			await timeout(0);
			tracker.prompt(promptInputModel, 0);
		};

		// プロンプトの終わりの印が、プロンプトを描く前（行の頭）で届いた。
		onCommandStart.fire({ marker: xterm.registerMarker() } as ITerminalCommand);
		tracker.promptStarted();
		await write(`\x1b[34m~/proj/demo\x1b[0m \x1b[33m!3 ?1\x1b[0m \x1b[32m>\x1b[0m `);
		await sync();
		for (const char of 'docke') {
			tracker.input(char, 0);
			await write(char);
			await sync();
		}
		// zsh-autosuggestions の薄い文字（256 色の灰色、斜体・暗色ではない）と右プロンプトを描き、
		// カーソルを打った文字の末尾（プロンプト 20 文字＋5 文字の後ろ）へ戻す。
		const ghost = 'r compose up -d';
		await write(`\x1b[38;5;244m${ghost}\x1b[0m\x1b[71G\x1b[35mmain\x1b[0m\x1b[26G`);
		await sync();

		assert.deepStrictEqual({
			value: promptInputModel.value.startsWith('~/proj/demo'),
			before: paradisPromptTextWithoutGhost(promptInputModel).includes(ghost),
			typed: tracker.resolve(promptInputModel, 0),
		}, { value: true, before: true, typed: 'docke' });
	});
});
