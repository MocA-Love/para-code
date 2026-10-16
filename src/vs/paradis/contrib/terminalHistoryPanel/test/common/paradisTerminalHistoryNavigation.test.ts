/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PromptInputState } from '../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { IParadisHistoryNavigationState, PARADIS_INITIAL_NAVIGATION_STATE, ParadisTerminalInputKind, paradisCanOpenHistoryPanel, paradisClassifyTerminalInput, paradisNextNavigationState, paradisPromptTextWithoutGhost } from '../../common/paradisTerminalHistoryNavigation.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';

/** 入力 1 回と、その後にシェルが出した入力行（ゴースト文字は `[...]` で囲む）。 */
interface Step {
	readonly data?: string;
	readonly reset?: true;
	readonly prompt: string;
}

function toModel(prompt: string): { state: PromptInputState; value: string; ghostTextIndex: number } {
	const ghostStart = prompt.indexOf('[');
	if (ghostStart === -1) {
		return { state: PromptInputState.Input, value: prompt, ghostTextIndex: -1 };
	}
	const value = prompt.substring(0, ghostStart) + prompt.substring(ghostStart + 1).replace(/\]$/, '');
	return { state: PromptInputState.Input, value, ghostTextIndex: ghostStart };
}

/**
 * 入力の流れを再生し、各入力の後に ↓ で一覧を開けるか（true/false）を並べる。シェルの動きは
 * `prompt` で与える（シェルが今どの履歴を出しているかは Para Code からは見えないのと同じ）。
 */
function play(initialPrompt: string, steps: readonly Step[], composing = false): boolean[] {
	let state: IParadisHistoryNavigationState = PARADIS_INITIAL_NAVIGATION_STATE;
	let prompt = initialPrompt;
	const result: boolean[] = [];
	for (const step of steps) {
		if (step.reset) {
			state = paradisNextNavigationState(state, { kind: 'reset' });
		} else {
			state = paradisNextNavigationState(state, { kind: 'input', input: paradisClassifyTerminalInput(step.data ?? ''), promptText: paradisPromptTextWithoutGhost(toModel(prompt)) });
		}
		prompt = step.prompt;
		state = paradisNextNavigationState(state, { kind: 'prompt', promptText: paradisPromptTextWithoutGhost(toModel(prompt)) });
		result.push(paradisCanOpenHistoryPanel(state, toModel(prompt), undefined, composing));
	}
	return result;
}

function typed(text: string, from = ''): Step[] {
	const steps: Step[] = [];
	let prompt = from;
	for (const char of text) {
		prompt += char;
		steps.push({ data: char, prompt });
	}
	return steps;
}

suite('ParadisTerminalHistoryNavigation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies the data the terminal sends to the shell', () => {
		const inputs = {
			up: UP,
			upApplicationMode: '\x1bOA',
			upRepeated: UP + UP + UP,
			ctrlP: '\x10',
			down: DOWN,
			downApplicationMode: '\x1bOB',
			ctrlN: '\x0e',
			enter: '\r',
			ctrlC: '\x03',
			letter: 'g',
			japanese: 'あいう',
			backspace: '\x7f',
			ctrlU: '\x15',
			ctrlW: '\x17',
			left: '\x1b[D',
			right: '\x1b[C',
			tab: '\t',
			bracketedPaste: '\x1b[200~git log --oneline\x1b[201~',
			plainPaste: 'git log --oneline',
			upThenLetter: UP + 'a',
			focusIn: '\x1b[I',
			focusOut: '\x1b[O',
			sgrMouse: '\x1b[<0;10;5M',
			x10Mouse: '\x1b[M !!',
			deviceAttributes: '\x1b[?1;2c',
			cursorPositionReport: '\x1b[12;5R',
			oscReply: '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\',
			empty: '',
		};
		const kinds = Object.fromEntries(Object.entries(inputs).map(([name, data]) => [name, paradisClassifyTerminalInput(data)]));
		assert.deepStrictEqual(kinds, {
			up: ParadisTerminalInputKind.HistoryPrevious,
			upApplicationMode: ParadisTerminalInputKind.HistoryPrevious,
			upRepeated: ParadisTerminalInputKind.HistoryPrevious,
			ctrlP: ParadisTerminalInputKind.HistoryPrevious,
			down: ParadisTerminalInputKind.HistoryNext,
			downApplicationMode: ParadisTerminalInputKind.HistoryNext,
			ctrlN: ParadisTerminalInputKind.HistoryNext,
			enter: ParadisTerminalInputKind.Submit,
			ctrlC: ParadisTerminalInputKind.Submit,
			letter: ParadisTerminalInputKind.Edit,
			japanese: ParadisTerminalInputKind.Edit,
			backspace: ParadisTerminalInputKind.Edit,
			ctrlU: ParadisTerminalInputKind.Edit,
			ctrlW: ParadisTerminalInputKind.Edit,
			left: ParadisTerminalInputKind.Edit,
			right: ParadisTerminalInputKind.Edit,
			tab: ParadisTerminalInputKind.Edit,
			bracketedPaste: ParadisTerminalInputKind.Edit,
			plainPaste: ParadisTerminalInputKind.Edit,
			upThenLetter: ParadisTerminalInputKind.Edit,
			focusIn: ParadisTerminalInputKind.Ignore,
			focusOut: ParadisTerminalInputKind.Ignore,
			sgrMouse: ParadisTerminalInputKind.Ignore,
			x10Mouse: ParadisTerminalInputKind.Ignore,
			deviceAttributes: ParadisTerminalInputKind.Ignore,
			cursorPositionReport: ParadisTerminalInputKind.Ignore,
			oscReply: ParadisTerminalInputKind.Ignore,
			empty: ParadisTerminalInputKind.Ignore,
		});
	});

	test('never opens while walking the shell history from an empty prompt (↑↑↓↓)', () => {
		assert.deepStrictEqual(play('', [
			{ data: UP, prompt: 'bun run dev' },
			{ data: UP, prompt: 'git pull --rebase' },
			{ data: DOWN, prompt: 'bun run dev' },
			{ data: DOWN, prompt: '' },
		]), [false, false, false, false]);
	});

	test('keeps passing Down to the shell while a recalled command is on the line', () => {
		// 遡った後の ↓ はシェルの「次の履歴」。以前はここで一覧が開いた（Q372 の元の不具合）。
		assert.deepStrictEqual(play('', [
			{ data: UP, prompt: 'npm run build' },
			{ data: DOWN, prompt: '' },
			{ data: DOWN, prompt: '' },
		]), [false, false, false]);
	});

	test('opens after the user types, and after the user edits a recalled command', () => {
		assert.deepStrictEqual(play('', [
			...typed('git'),
			{ reset: true, prompt: '' },
			{ data: UP, prompt: 'npm test' },
			...typed(' -- --watch', 'npm test'),
		]), [true, true, true, false, false, true, true, true, true, true, true, true, true, true, true, true]);
	});

	test('passes Up after typing to the shell, and opens again once Down returns to the typed text', () => {
		assert.deepStrictEqual(play('', [
			...typed('git'),
			{ data: UP, prompt: 'git status' },
			{ data: UP, prompt: 'git log --oneline -10' },
			{ data: DOWN, prompt: 'git status' },
			{ data: DOWN, prompt: 'git' },
		]), [true, true, true, false, false, false, true]);
	});

	test('does not open after Ctrl+U or Backspace empties the line, and opens again on the next letter', () => {
		assert.deepStrictEqual(play('', [
			...typed('ls'),
			{ data: '\x15', prompt: '' },
			{ data: 'c', prompt: 'c' },
			{ data: '\x7f', prompt: '' },
			{ data: '\x7f', prompt: '' },
			{ data: 'd', prompt: 'd' },
		]), [true, true, false, true, false, false, true]);
	});

	test('counts only typed text, not ghost text', () => {
		assert.deepStrictEqual(play('', [
			{ data: 'g', prompt: 'g[it status]' },
			{ data: '\x7f', prompt: '[git status]' },
		]), [true, false]);
		assert.strictEqual(paradisPromptTextWithoutGhost({ value: 'git status', ghostTextIndex: 3 }), 'git');
	});

	test('treats a paste on a recalled line as typing', () => {
		assert.deepStrictEqual(play('', [
			{ data: UP, prompt: 'git log' },
			{ data: '\x1b[200~ --stat\x1b[201~', prompt: 'git log --stat' },
		]), [false, true]);
	});

	test('does not open during IME composition, and opens after the composed text is committed', () => {
		assert.deepStrictEqual(play('', [{ data: 'あ', prompt: 'あ' }], true), [false]);
		assert.deepStrictEqual(play('', [{ data: 'あいう', prompt: 'あいう' }], false), [true]);
	});

	test('ignores terminal replies while walking the history', () => {
		assert.deepStrictEqual(play('', [
			{ data: UP, prompt: 'make test' },
			{ data: '\x1b[I', prompt: 'make test' },
			{ data: '\x1b[12;5R', prompt: 'make test' },
		]), [false, false, false]);
	});

	test('handles Ctrl+P / Ctrl+N and application cursor keys like the arrows', () => {
		assert.deepStrictEqual(play('', [
			...typed('do'),
			{ data: '\x10', prompt: 'docker ps' },
			{ data: '\x0e', prompt: 'do' },
			{ data: '\x1bOA', prompt: 'docker ps' },
			{ data: '\x1bOB', prompt: 'do' },
		]), [true, true, false, true, false, true]);
	});

	test('starts over after Enter, Ctrl+C or a finished command', () => {
		assert.deepStrictEqual(play('', [
			{ data: UP, prompt: 'make' },
			{ data: '\r', prompt: '' },
			...typed('m'),
			{ data: UP, prompt: 'make' },
			{ data: '\x03', prompt: '' },
			...typed('m'),
			{ data: UP, prompt: 'make' },
			{ reset: true, prompt: '' },
			...typed('m'),
		]), [false, false, true, false, false, true, false, false, true]);
	});

	test('stays closed while a foreground command owns the input', () => {
		const state = paradisNextNavigationState(PARADIS_INITIAL_NAVIGATION_STATE, { kind: 'input', input: ParadisTerminalInputKind.Edit, promptText: '' });
		assert.deepStrictEqual([
			paradisCanOpenHistoryPanel(state, { state: PromptInputState.Input, value: 'vim', ghostTextIndex: -1 }, 'vim', false),
			paradisCanOpenHistoryPanel(state, { state: PromptInputState.Execute, value: 'vim', ghostTextIndex: -1 }, undefined, false),
			paradisCanOpenHistoryPanel(state, { state: PromptInputState.Input, value: 'vim', ghostTextIndex: -1 }, undefined, false),
		], [false, false, true]);
	});

	test('treats a recalled line equal to the line before walking as the end of the walk', () => {
		// 遡る前と同じ文字の行がシェルの履歴にあると、↓ でその行に来たときに「遡る前の行に戻った」と
		// 区別できず、次の ↓ で一覧が開く（打った文字と同じ行なので、開いても困らない）。
		assert.deepStrictEqual(play('', [
			...typed('ls'),
			{ data: UP, prompt: 'pwd' },
			{ data: UP, prompt: 'ls' },
			{ data: UP, prompt: 'make' },
			{ data: DOWN, prompt: 'ls' },
		]), [true, true, false, false, false, true]);
	});
});
