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

const change = (text: string, composing?: boolean): LiveInputEvent => (composing === undefined ? { kind: 'change', text } : { kind: 'change', text, composing });
const backspace: LiveInputEvent = { kind: 'key', key: 'Backspace' };

describe('liveInputStep', () => {
	it('sends only what was added, once per keystroke', () => {
		expect(run([change('l', false), change('ls', false)]).sent).toEqual(['l', 's']);
	});

	it('mirrors ⌫ from the shrinking field as a single DEL', () => {
		expect(run([change('l', false), change('ls', false), backspace, change('l', false)]).sent).toEqual(['l', 's', LIVE_DEL]);
	});

	it('sends DEL for ⌫ on an empty field', () => {
		expect(run([backspace]).sent).toEqual([LIVE_DEL]);
	});

	it('rewrites a replacement in the middle so the prompt matches the field', () => {
		expect(run([change('teh', false), change('the', false)]).sent).toEqual(['teh', LIVE_DEL + LIVE_DEL, 'he']);
	});

	it('keeps sending appended text after a replacement', () => {
		expect(run([change('ab', false), change('ac', false), change('acd', false)]).sent).toEqual(['ab', LIVE_DEL, 'c', 'd']);
	});

	it('sends Enter on submit', () => {
		expect(run([change('ls', false), { kind: 'submit' }]).sent).toEqual(['ls', LIVE_ENTER]);
	});

	it('starts over after the field was emptied', () => {
		expect(run([change('ls', false), { kind: 'submit' }, { kind: 'cleared' }, change('p', false), change('pw', false)]).sent).toEqual(['ls', LIVE_ENTER, 'p', 'w']);
	});

	it('does not resend the old text when the native side ignored the clear', () => {
		expect(run([change('ls', false), { kind: 'cleared' }, change('lsx', false)]).sent).toEqual(['ls', 'x']);
	});

	it('turns smart punctuation back into what was typed', () => {
		expect(normalizeLiveText('‘a’ “b” c—d…')).toBe('\'a\' "b" c--d...');
		expect(run([change('-', false), change('—', false)]).sent).toEqual(['-', '-']);
		expect(run([change('it', false), change('it’', false)]).sent).toEqual(['it', '\'']);
	});
});

describe('liveInputStep with the reported marked text (iOS)', () => {
	it('holds romaji preedit and sends the conversion only when it is confirmed', () => {
		const { sent, state } = run([
			change('k', true), change('か', true), change('かn', true), change('かん', true),
			change('かんj', true), change('かんじ', true), change('漢字', true),
			change('漢字', false),
		]);
		expect({ sent, state }).toEqual({ sent: ['漢字'], state: { text: '漢字', sent: '漢字', held: '', clearing: false } });
	});

	it('sends kana typed on the kana keyboard once confirmed', () => {
		expect(run([change('か', true), change('かき', true), change('かき', false)]).sent).toEqual(['かき']);
	});

	it('sends nothing when the conversion is cancelled', () => {
		const { sent, state } = run([change('k', true), change('か', true), change('かn', true), backspace, change('か', true), backspace, change('', false)]);
		expect({ sent, state }).toEqual({ sent: [], state: LIVE_INPUT_EMPTY });
		// 取り消したあとの空の入力欄の ⌫ は PC へ届く
		expect(liveInputStep(state, backspace).send).toEqual([LIVE_DEL]);
	});

	it('keeps what was already sent and holds only the new preedit', () => {
		const { sent, state } = run([change('echo ', false), change('echo へ', true), change('echo へん', true), change('echo 変', true)]);
		expect({ sent, held: state.held }).toEqual({ sent: ['echo '], held: '変' });
		// 変換中の文字を ⌫ で消しても、送り済みの部分は消さない
		expect(run([change('echo ', false), change('echo へ', true), backspace, change('echo ', false)]).sent).toEqual(['echo ']);
		expect(run([change('echo ', false), change('echo 変', true), change('echo 変', false)]).sent).toEqual(['echo ', '変']);
	});

	it('holds ASCII preedit too (pinyin, or letters on the romaji keyboard) until it is confirmed', () => {
		expect(run([change('n', true), change('ni', true), change('你', true), change('你', false)]).sent).toEqual(['你']);
		expect(run([change('l', true), change('ls', true), change('ls', false)]).sent).toEqual(['ls']);
	});

	it('sends emoji right away and erases them one code point at a time', () => {
		const { sent, state } = run([change('ok ', false), change('ok 👍', false), change('ok 👍🏽', false)]);
		expect(sent).toEqual(['ok ', '👍', '🏽']);
		expect(run([backspace, change('ok ', false)], state).sent).toEqual([LIVE_DEL + LIVE_DEL]);
	});

	it('flushes nothing extra on submit when nothing is held', () => {
		expect(run([change('漢字', false), { kind: 'submit' }]).sent).toEqual(['漢字', LIVE_ENTER]);
	});
});

describe('liveInputStep without a reported marked text (fallback)', () => {
	it('holds the trailing non-ASCII run, takes back leaked romaji, and sends it on flush', () => {
		const { sent, state } = run([change('k'), change('か'), change('かn'), change('かん'), change('漢')]);
		expect({ sent, held: state.held }).toEqual({ sent: ['k', LIVE_DEL, 'かn', LIVE_DEL, LIVE_DEL], held: '漢' });
		expect(liveInputStep(state, { kind: 'flush' }).send).toEqual(['漢']);
	});

	it('commits the held text before Enter', () => {
		expect(run([change('ls '), change('ls 漢'), { kind: 'submit' }]).sent).toEqual(['ls ', '漢', LIVE_ENTER]);
	});
});
