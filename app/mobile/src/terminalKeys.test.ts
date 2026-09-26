// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	controlCharFor,
	ctrlLatchedTextInput,
	TERMINAL_ACCESSORY_KEYS,
	terminalKeyAction,
	terminalSubmitIcon,
	terminalSubmitPlan,
} from './terminalKeys.js';

describe('terminalKeyAction', () => {
	test('sends the fixed control sequences for the plain keys', () => {
		expect([
			terminalKeyAction('esc', false),
			terminalKeyAction('tab', false),
			terminalKeyAction('shiftTab', false),
			terminalKeyAction('ctrlC', false),
			terminalKeyAction('ctrlD', false),
			terminalKeyAction('ctrlR', false),
			terminalKeyAction('ctrlL', false),
			terminalKeyAction('backspace', false),
			terminalKeyAction('home', false),
			terminalKeyAction('end', false),
		]).toEqual([
			{ kind: 'bytes', data: '\x1b' },
			{ kind: 'bytes', data: '\t' },
			{ kind: 'bytes', data: '\x1b[Z' },
			{ kind: 'bytes', data: '\x03' },
			{ kind: 'bytes', data: '\x04' },
			{ kind: 'bytes', data: '\x12' },
			{ kind: 'bytes', data: '\x0c' },
			{ kind: 'bytes', data: '\x7f' },
			{ kind: 'bytes', data: '\x1b[H' },
			{ kind: 'bytes', data: '\x1b[F' },
		]);
	});

	test('leaves plain arrows to the mode-aware arrow sender', () => {
		expect(['up', 'down', 'left', 'right'].map(id => terminalKeyAction(id as 'up', false))).toEqual([
			{ kind: 'arrow', key: 'up' },
			{ kind: 'arrow', key: 'down' },
			{ kind: 'arrow', key: 'left' },
			{ kind: 'arrow', key: 'right' },
		]);
	});

	test('applies Ctrl as the xterm modifier to arrows and Home/End', () => {
		expect(['up', 'down', 'right', 'left', 'home', 'end'].map(id => terminalKeyAction(id as 'up', true))).toEqual([
			{ kind: 'bytes', data: '\x1b[1;5A' },
			{ kind: 'bytes', data: '\x1b[1;5B' },
			{ kind: 'bytes', data: '\x1b[1;5C' },
			{ kind: 'bytes', data: '\x1b[1;5D' },
			{ kind: 'bytes', data: '\x1b[1;5H' },
			{ kind: 'bytes', data: '\x1b[1;5F' },
		]);
	});

	test('turns symbol keys into control characters only while Ctrl is latched', () => {
		expect([
			terminalKeyAction('pipe', false),
			terminalKeyAction('slash', false),
			terminalKeyAction('tilde', false),
			terminalKeyAction('pipe', true),
			terminalKeyAction('slash', true),
			terminalKeyAction('tilde', true),
		]).toEqual([
			{ kind: 'bytes', data: '|' },
			{ kind: 'bytes', data: '/' },
			{ kind: 'bytes', data: '~' },
			{ kind: 'bytes', data: '\x1c' },
			{ kind: 'bytes', data: '\x1f' },
			{ kind: 'bytes', data: '\x1e' },
		]);
	});

	test('keeps self-contained keys unchanged when Ctrl is latched', () => {
		expect([terminalKeyAction('esc', true), terminalKeyAction('tab', true), terminalKeyAction('ctrlC', true)]).toEqual([
			{ kind: 'bytes', data: '\x1b' },
			{ kind: 'bytes', data: '\t' },
			{ kind: 'bytes', data: '\x03' },
		]);
	});

	test('toggles the latch instead of sending for the Ctrl key', () => {
		expect([terminalKeyAction('ctrl', false), terminalKeyAction('ctrl', true)]).toEqual([
			{ kind: 'toggleCtrl' },
			{ kind: 'toggleCtrl' },
		]);
	});

	test('repeats only the arrows and backspace', () => {
		expect(TERMINAL_ACCESSORY_KEYS.filter(def => def.repeat).map(def => def.id)).toEqual(['up', 'down', 'left', 'right', 'backspace']);
	});
});

describe('controlCharFor', () => {
	test('maps letters of either case to 0x01-0x1a', () => {
		expect([controlCharFor('a'), controlCharFor('A'), controlCharFor('c'), controlCharFor('z'), controlCharFor('Z')]).toEqual([
			'\x01', '\x01', '\x03', '\x1a', '\x1a',
		]);
	});

	test('maps the conventional symbols and rejects everything else', () => {
		expect([
			controlCharFor('@'), controlCharFor('['), controlCharFor('\\'), controlCharFor(']'),
			controlCharFor('^'), controlCharFor('_'), controlCharFor('?'),
			controlCharFor('1'), controlCharFor('あ'), controlCharFor(''), controlCharFor('ab'),
		]).toEqual([
			'\x00', '\x1b', '\x1c', '\x1d', '\x1e', '\x1f', '\x7f',
			undefined, undefined, undefined, undefined,
		]);
	});
});

describe('ctrlLatchedTextInput', () => {
	test('sends a single typed letter as a control character wherever the caret is', () => {
		expect([
			ctrlLatchedTextInput('git', 'gitc'),
			ctrlLatchedTextInput('git', 'gcit'),
			ctrlLatchedTextInput('', 'd'),
		]).toEqual([
			{ kind: 'control', data: '\x03' },
			{ kind: 'control', data: '\x03' },
			{ kind: 'control', data: '\x04' },
		]);
	});

	test('releases the latch after one character that has no control form', () => {
		expect(ctrlLatchedTextInput('ls', 'ls1')).toEqual({ kind: 'text', release: true });
	});

	test('keeps the latch for deletions, pastes, and replacements', () => {
		expect([
			ctrlLatchedTextInput('ls', 'l'),
			ctrlLatchedTextInput('ls', 'ls -la'),
			ctrlLatchedTextInput('ab', 'xyz'),
		]).toEqual([
			{ kind: 'text', release: false },
			{ kind: 'text', release: false },
			{ kind: 'text', release: false },
		]);
	});
});

describe('terminal submit', () => {
	test('sends a bare Enter when the input is empty, regardless of the Enter-less switch', () => {
		expect([terminalSubmitPlan('', false), terminalSubmitPlan('', true)]).toEqual([{ kind: 'enter' }, { kind: 'enter' }]);
	});

	test('omits the trailing Enter only when the Enter-less switch is on', () => {
		expect([terminalSubmitPlan('ls', false), terminalSubmitPlan('ls', true)]).toEqual([
			{ kind: 'text', text: 'ls', execute: true },
			{ kind: 'text', text: 'ls', execute: false },
		]);
	});

	test('shows the return mark whenever the send presses Enter', () => {
		expect([
			terminalSubmitIcon('', false),
			terminalSubmitIcon('', true),
			terminalSubmitIcon('ls', false),
			terminalSubmitIcon('ls', true),
		]).toEqual(['return-down-back', 'return-down-back', 'return-down-back', 'arrow-up']);
	});
});
