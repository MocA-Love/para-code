// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { paradisIsMobileBrowserKey, paradisMobileBrowserKeyEvents } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileBrowserKeys.js';
import { BROWSER_ACCESSORY_KEYS, browserEmptyBackspaceInput, browserKeyInput, browserSubmitInput } from './browserKeys.js';

describe('browser keys', () => {
	test('キー行のキーはすべて PC の許可リストにあり、PC が押す・離すの 2 つに組み立てられる', () => {
		expect(BROWSER_ACCESSORY_KEYS.map(def => ({
			id: def.id,
			allowed: paradisIsMobileBrowserKey(def.key),
			events: paradisMobileBrowserKeyEvents(browserKeyInput(def).key, browserKeyInput(def).shift, true)?.map(event => event.type),
		}))).toEqual(BROWSER_ACCESSORY_KEYS.map(def => ({
			id: def.id,
			allowed: true,
			events: [def.key === 'Enter' ? 'keyDown' : 'rawKeyDown', 'keyUp'],
		})));
	});

	test('Return は文字があれば文字だけ、空なら Enter。⌫ は空のときだけページへ。古い PC には特殊キーを送らない', () => {
		expect({
			text: browserSubmitInput('検索語', true),
			empty: browserSubmitInput('', true),
			emptyOldPc: browserSubmitInput('', false),
			textOldPc: browserSubmitInput('abc', false),
			backspace: browserEmptyBackspaceInput(true),
			backspaceOldPc: browserEmptyBackspaceInput(false),
			shiftTab: browserKeyInput({ key: 'Tab', shift: true }),
		}).toEqual({
			text: { kind: 'text', text: '検索語' },
			empty: { kind: 'key', key: 'Enter' },
			emptyOldPc: undefined,
			textOldPc: { kind: 'text', text: 'abc' },
			backspace: { kind: 'key', key: 'Backspace' },
			backspaceOldPc: undefined,
			shiftTab: { kind: 'key', key: 'Tab', shift: true },
		});
	});
});
