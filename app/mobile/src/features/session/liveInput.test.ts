// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { LIVE_DEL, LIVE_ENTER, LIVE_INPUT_EMPTY, liveInputStep, normalizeLiveText, type LiveInputEvent, type LiveInputState } from './liveInput.js';

/** 出来事を順に流して、送ったものを並べる。 */
function run(events: readonly LiveInputEvent[], initial: LiveInputState = LIVE_INPUT_EMPTY): { state: LiveInputState; sent: string[] } {
	let state = initial;
	const sent: string[] = [];
	for (const event of events) {
		const step = liveInputStep(state, event);
		state = step.state;
		sent.push(...step.send);
	}
	return { state, sent };
}

const change = (text: string): LiveInputEvent => ({ kind: 'change', text });
const backspace: LiveInputEvent = { kind: 'key', key: 'Backspace' };

describe('liveInputStep', () => {
	it('sends only what was added, once per keystroke', () => {
		expect(run([change('l'), change('ls')]).sent).toEqual(['l', 's']);
	});

	it('sends a single DEL for ⌫ and nothing for the shrink itself', () => {
		expect(run([change('l'), change('ls'), backspace, change('l')]).sent).toEqual(['l', 's', LIVE_DEL]);
	});

	it('sends DEL for ⌫ on an empty field', () => {
		expect(run([backspace]).sent).toEqual([LIVE_DEL]);
	});

	it('does not send a replacement in the middle', () => {
		const { sent } = run([change('teh'), change('the')]);
		expect(sent).toEqual(['teh']);
	});

	it('keeps sending appended text after a replacement', () => {
		expect(run([change('ab'), change('ac'), change('acd')]).sent).toEqual(['ab', 'd']);
	});

	it('sends Enter on submit', () => {
		expect(run([change('ls'), { kind: 'submit' }]).sent).toEqual(['ls', LIVE_ENTER]);
	});

	it('starts over after the field was emptied', () => {
		expect(run([change('ls'), { kind: 'submit' }, { kind: 'cleared' }, change('p'), change('pw')]).sent).toEqual(['ls', LIVE_ENTER, 'p', 'w']);
	});

	it('does not resend the old text when the native side ignored the clear', () => {
		expect(run([change('ls'), { kind: 'cleared' }, change('lsx')]).sent).toEqual(['ls', 'x']);
	});

	it('turns smart punctuation back into what was typed', () => {
		expect(normalizeLiveText('‘a’ “b” c—d…')).toBe('\'a\' "b" c--d...');
		expect(run([change('-'), change('—')]).sent).toEqual(['-', '-']);
		expect(run([change('it'), change('it’')]).sent).toEqual(['it', '\'']);
	});

	it('does not send Japanese input while it is being converted, and takes back the romaji that leaked', () => {
		const { sent, state } = run([change('k'), change('か'), change('かn'), change('かん'), change('漢')]);
		// k は送られてしまうが、かなに置き換わったところで DEL で取り消す。n も同じ。
		expect(sent).toEqual(['k', LIVE_DEL, 'n', LIVE_DEL]);
		// 変換途中のかなを ⌫ で消しても PC へは送らない。
		expect(liveInputStep(state, backspace).send).toEqual([]);
	});
});
