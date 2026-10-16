/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PromptInputState } from '../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { IParadisHistoryNavigationState, PARADIS_EXTERNAL_PROMPT_CHANGE_MS, PARADIS_INITIAL_NAVIGATION_STATE, ParadisHistoryNavigationTracker, ParadisTerminalInputKind, paradisCanOpenHistoryPanel, paradisClassifyTerminalInput, paradisNextNavigationState, paradisPromptTextWithoutGhost } from '../../common/paradisTerminalHistoryNavigation.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';

/** 入力 1 回と、その後にシェルが出した入力行（ゴースト文字は `[...]` で囲む）。 */
interface Step {
	readonly data?: string;
	readonly reset?: true;
	readonly prompt: string;
}

/** 入力行。ゴースト文字は `[...]` で囲み、カーソルは `|` で示す（無ければ打った文字の末尾）。 */
function toModel(prompt: string): { state: PromptInputState; value: string; ghostTextIndex: number; cursorIndex: number } {
	let cursorIndex = prompt.indexOf('|');
	let text = cursorIndex === -1 ? prompt : prompt.substring(0, cursorIndex) + prompt.substring(cursorIndex + 1);
	const ghostStart = text.indexOf('[');
	if (ghostStart !== -1) {
		text = text.substring(0, ghostStart) + text.substring(ghostStart + 1).replace(/\]$/, '');
	}
	if (cursorIndex === -1) {
		cursorIndex = ghostStart === -1 ? text.length : ghostStart;
	}
	return { state: PromptInputState.Input, value: text, ghostTextIndex: ghostStart, cursorIndex };
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
			state = paradisNextNavigationState(state, { kind: 'input', data: step.data ?? '', promptText: paradisPromptTextWithoutGhost(toModel(prompt)) });
		}
		prompt = step.prompt;
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
			left: LEFT,
			right: RIGHT,
			leftApplicationMode: '\x1bOD',
			leftRepeated: LEFT + LEFT,
			home: '\x1b[H',
			end: '\x1b[F',
			homeVt: '\x1b[1~',
			endVt: '\x1b[4~',
			ctrlA: '\x01',
			ctrlE: '\x05',
			ctrlB: '\x02',
			ctrlF: '\x06',
			altB: '\x1bb',
			altF: '\x1bf',
			ctrlLeft: '\x1b[1;5D',
			altRight: '\x1b[1;3C',
			ctrlR: '\x12',
			ctrlS: '\x13',
			ctrlG: '\x07',
			escape: '\x1b',
			deleteKey: '\x1b[3~',
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
			left: ParadisTerminalInputKind.Cursor,
			right: ParadisTerminalInputKind.Cursor,
			leftApplicationMode: ParadisTerminalInputKind.Cursor,
			leftRepeated: ParadisTerminalInputKind.Cursor,
			home: ParadisTerminalInputKind.Cursor,
			end: ParadisTerminalInputKind.Cursor,
			homeVt: ParadisTerminalInputKind.Cursor,
			endVt: ParadisTerminalInputKind.Cursor,
			ctrlA: ParadisTerminalInputKind.Cursor,
			ctrlE: ParadisTerminalInputKind.Cursor,
			ctrlB: ParadisTerminalInputKind.Cursor,
			ctrlF: ParadisTerminalInputKind.Cursor,
			altB: ParadisTerminalInputKind.Cursor,
			altF: ParadisTerminalInputKind.Cursor,
			ctrlLeft: ParadisTerminalInputKind.Cursor,
			altRight: ParadisTerminalInputKind.Cursor,
			ctrlR: ParadisTerminalInputKind.Search,
			ctrlS: ParadisTerminalInputKind.Search,
			ctrlG: ParadisTerminalInputKind.Submit,
			escape: ParadisTerminalInputKind.Escape,
			deleteKey: ParadisTerminalInputKind.Edit,
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
		const state = paradisNextNavigationState(PARADIS_INITIAL_NAVIGATION_STATE, { kind: 'input', data: 'm', promptText: 'vi' });
		assert.deepStrictEqual([
			paradisCanOpenHistoryPanel(state, { state: PromptInputState.Input, value: 'vim', ghostTextIndex: -1, cursorIndex: 3 }, 'vim', false),
			paradisCanOpenHistoryPanel(state, { state: PromptInputState.Execute, value: 'vim', ghostTextIndex: -1, cursorIndex: 3 }, undefined, false),
			paradisCanOpenHistoryPanel(state, { state: PromptInputState.Input, value: 'vim', ghostTextIndex: -1, cursorIndex: 3 }, undefined, false),
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
	test('keeps passing Down to the shell after moving the cursor on a recalled line (↑ ← → ↓)', () => {
		assert.deepStrictEqual(play('', [
			{ data: UP, prompt: 'git push origin main' },
			{ data: LEFT, prompt: 'git push origin mai|n' },
			{ data: RIGHT, prompt: 'git push origin main' },
			{ data: '\x01', prompt: '|git push origin main' },
			{ data: '\x05', prompt: 'git push origin main' },
			{ data: '\x1b[H', prompt: '|git push origin main' },
			{ data: '\x1b[F', prompt: 'git push origin main' },
			{ data: '\x1bb', prompt: 'git push origin |main' },
			{ data: '\x1bf', prompt: 'git push origin main' },
			{ data: DOWN, prompt: '' },
		]), [false, false, false, false, false, false, false, false, false, false]);
	});

	test('moving the cursor on a typed line keeps the line openable', () => {
		assert.deepStrictEqual(play('', [
			...typed('git'),
			{ data: LEFT, prompt: 'gi|t' },
			{ data: RIGHT, prompt: 'git' },
		]), [true, true, true, true, true]);
	});

	test('does not take the end of a walk from an empty line, and only from the line shown when Down is pressed', () => {
		// 空から遡って戻ったときは、打った文字が無いので開かない（打てば Edit で終わる）。
		// 打った行から遡ったときは、↓ を押した時点の入力行が遡る前の行と同じときだけ開く。途中で届いた
		// 描き直し（共通の頭だけ）で終わったことにはしない。
		let state = paradisNextNavigationState(PARADIS_INITIAL_NAVIGATION_STATE, { kind: 'input', data: UP, promptText: '' });
		state = paradisNextNavigationState(state, { kind: 'input', data: DOWN, promptText: 'ls' });
		const fromEmpty = paradisCanOpenHistoryPanel(state, toModel('l'), undefined, false);
		let typedState = paradisNextNavigationState(PARADIS_INITIAL_NAVIGATION_STATE, { kind: 'input', data: UP, promptText: 'git' });
		typedState = paradisNextNavigationState(typedState, { kind: 'input', data: UP, promptText: 'git status' });
		typedState = paradisNextNavigationState(typedState, { kind: 'input', data: DOWN, promptText: 'git stash pop' });
		assert.deepStrictEqual({
			fromEmpty,
			partialRedraw: paradisCanOpenHistoryPanel(typedState, toModel('git'), undefined, false) && paradisCanOpenHistoryPanel(typedState, toModel('git status'), undefined, false),
			settledOnNewerEntry: paradisCanOpenHistoryPanel(typedState, toModel('git status'), undefined, false),
			settledOnTypedLine: paradisCanOpenHistoryPanel(typedState, toModel('git'), undefined, false),
		}, {
			fromEmpty: false,
			partialRedraw: false,
			settledOnNewerEntry: false,
			settledOnTypedLine: true,
		});
	});

	test('passes Down to the shell when the cursor is not on the last line of a multi-line command', () => {
		assert.deepStrictEqual([
			paradisCanOpenHistoryPanel(PARADIS_INITIAL_NAVIGATION_STATE, toModel('for f in *\ndo echo $f'), undefined, false),
			paradisCanOpenHistoryPanel(PARADIS_INITIAL_NAVIGATION_STATE, toModel('for f in *|\ndo echo $f'), undefined, false),
		], [true, false]);
	});

	test('treats a reverse search as a walk until the user edits the found line', () => {
		assert.deepStrictEqual(play('', [
			...typed('d'),
			{ data: '\x12', prompt: 'docker compose up' },
			{ data: 'o', prompt: 'docker compose up' },
			{ data: 'c', prompt: 'docker compose up' },
			{ data: RIGHT, prompt: 'docker compose up' },
			{ data: DOWN, prompt: 'docker compose up' },
			{ data: ' -d', prompt: 'docker compose up -d' },
		]), [true, false, false, false, false, false, true]);
		assert.deepStrictEqual(play('', [
			...typed('d'),
			{ data: '\x12', prompt: 'docker compose up' },
			{ data: '\x07', prompt: 'd' },
		]), [true, false, true]);
	});

	test('treats k and j after Esc as the vi history keys', () => {
		assert.deepStrictEqual(play('', [
			...typed('ls'),
			{ data: '\x1b', prompt: 'ls' },
			{ data: 'k', prompt: 'make test' },
			{ data: 'j', prompt: 'ls' },
			{ data: 'A', prompt: 'ls' },
			{ data: ' -la', prompt: 'ls -la' },
		]), [true, true, false, false, false, false, true]);
	});
});

suite('ParadisHistoryNavigationTracker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 入力・遅れて届く入力行・↓ を押した時点の判定を、届いた順に並べる。 */
	type Event =
		| { readonly kind: 'input'; readonly data: string; readonly at: number }
		| { readonly kind: 'prompt'; readonly text: string; readonly at: number }
		| { readonly kind: 'reset' }
		| { readonly kind: 'check' };

	function run(events: readonly Event[]): boolean[] {
		const tracker = new ParadisHistoryNavigationTracker();
		let prompt = '';
		const result: boolean[] = [];
		for (const event of events) {
			if (event.kind === 'input') {
				tracker.input(event.data, paradisPromptTextWithoutGhost(toModel(prompt)), event.at);
			} else if (event.kind === 'prompt') {
				prompt = event.text;
				tracker.prompt(paradisPromptTextWithoutGhost(toModel(prompt)), event.at);
			} else if (event.kind === 'reset') {
				prompt = '';
				tracker.reset();
			} else {
				result.push(tracker.canOpen(toModel(prompt), undefined, false));
			}
		}
		return result;
	}

	test('decides from the line on screen when Down is pressed, not from a piece of a redraw', () => {
		assert.deepStrictEqual(run([
			{ kind: 'input', data: 'g', at: 0 }, { kind: 'prompt', text: 'g', at: 10 },
			{ kind: 'input', data: 'i', at: 20 }, { kind: 'prompt', text: 'gi', at: 30 },
			{ kind: 'input', data: 't', at: 40 }, { kind: 'prompt', text: 'git', at: 50 },
			{ kind: 'check' },
			{ kind: 'input', data: UP, at: 100 }, { kind: 'prompt', text: 'git status', at: 300 },
			{ kind: 'check' },
			{ kind: 'input', data: UP, at: 400 }, { kind: 'prompt', text: 'git log', at: 600 },
			{ kind: 'input', data: DOWN, at: 700 }, { kind: 'prompt', text: 'git', at: 750 },
			{ kind: 'check' },
			{ kind: 'prompt', text: 'git status', at: 800 },
			{ kind: 'check' },
		]), [true, false, true, false]);
	});

	test('treats a line changed without user input as a possible walk until the user types', () => {
		assert.deepStrictEqual(run([
			{ kind: 'reset' },
			{ kind: 'prompt', text: 'npm run build', at: 10_000 },
			{ kind: 'check' },
			{ kind: 'input', data: DOWN, at: 11_000 },
			{ kind: 'check' },
			{ kind: 'input', data: ' ', at: 12_000 }, { kind: 'prompt', text: 'npm run build ', at: 12_100 },
			{ kind: 'check' },
			{ kind: 'prompt', text: 'npm run build -- --watch', at: 12_100 + PARADIS_EXTERNAL_PROMPT_CHANGE_MS + 1 },
			{ kind: 'check' },
		]), [false, false, true, false]);
	});

	test('keeps a slow echo of typed text as typing', () => {
		assert.deepStrictEqual(run([
			{ kind: 'input', data: 'l', at: 0 }, { kind: 'prompt', text: 'l', at: PARADIS_EXTERNAL_PROMPT_CHANGE_MS },
			{ kind: 'input', data: 's', at: PARADIS_EXTERNAL_PROMPT_CHANGE_MS + 10 }, { kind: 'prompt', text: 'ls', at: PARADIS_EXTERNAL_PROMPT_CHANGE_MS * 2 },
			{ kind: 'check' },
		]), [true]);
	});
});
