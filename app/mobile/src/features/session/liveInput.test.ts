// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { LIVE_DEL, LIVE_ENTER, LIVE_INPUT_EMPTY, LIVE_INPUT_RETIRED, liveInputStep, normalizeLiveText, type LiveInputEvent, type LiveInputState } from './liveInput.js';

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

/** 画面と同じく、Enter のあとは新しい入力欄（空の状態）で続ける。 */
function runLines(events: readonly LiveInputEvent[]): { state: LiveInputState; sent: string[] } {
	let state = LIVE_INPUT_EMPTY;
	const sent: string[] = [];
	for (const event of events) {
		const step = liveInputStep(state, event);
		state = step.state.retired === true ? LIVE_INPUT_EMPTY : step.state;
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

	// Enter のあと、画面は新しい入力欄を作る（空の状態から始まる）。送り終えた入力欄は引退する。
	it('retires the field on Enter', () => {
		const { sent, state } = run([change('ls', false), { kind: 'submit' }]);
		expect({ sent, state }).toEqual({ sent: ['ls', LIVE_ENTER], state: LIVE_INPUT_RETIRED });
	});

	it('sends nothing for input that still reaches the retired field', () => {
		// 新しい入力欄へフォーカスが移る前の打鍵は、前の行を持った古い入力欄に届く。写すと前の行ごと送ってしまう
		const retired = run([change('echo hi', false), { kind: 'submit' }]).state;
		expect(run([change('echo hix', false), change('echo hi', false), backspace, { kind: 'flush' }, { kind: 'submit' }, change('', false)], retired))
			.toEqual({ sent: [], state: LIVE_INPUT_RETIRED });
	});

	it('sends a single DEL for ⌫ right after Enter instead of resending the previous line', () => {
		// 以前は clear() が捨てられた後の ⌫ で「ls」を丸ごと送り直していた（前回レビュー (a)）
		expect(runLines([change('ls', false), { kind: 'submit' }, backspace]).sent).toEqual(['ls', LIVE_ENTER, LIVE_DEL]);
	});

	it('sends the whole of a long input that happens to start with the previous line', () => {
		// 以前は「前の行の続き」と見なして後ろだけ送っていた（前回レビュー (b)）
		expect(runLines([change('ls', false), { kind: 'submit' }, change('lsof -i', false)]).sent).toEqual(['ls', LIVE_ENTER, 'lsof -i']);
	});

	it('erases everything typed on the current line when it is deleted at once', () => {
		// H1: echo hi ⏎ → git → 単語削除。以前は Enter の前の部分へ食い込むと、今の行の送信済み分が PC に残った
		expect(runLines([change('echo hi', false), { kind: 'submit' }, change('git', false), change('', false)]).sent)
			.toEqual(['echo hi', LIVE_ENTER, 'git', LIVE_DEL.repeat(3)]);
		expect(runLines([change('echo hi', false), { kind: 'submit' }, change('git st', false), change('git ', false), change('', false)]).sent)
			.toEqual(['echo hi', LIVE_ENTER, 'git st', LIVE_DEL.repeat(2), LIVE_DEL.repeat(4)]);
	});

	it('never resends earlier lines, even if the caret ends up in the middle', () => {
		// H2: 以前は入力欄に前の行（パスワードを含む）を残していたので、キャレットが前へ動くと送り直しえた。
		// いまは入力欄に今の行しか無い。途中を書き換えても、今の行の食い違った末尾だけを直す。
		const { sent } = runLines([change('s3cret', false), { kind: 'submit' }, change('lsx', false), change('lax', false)]);
		expect(sent).toEqual(['s3cret', LIVE_ENTER, 'lsx', LIVE_DEL + LIVE_DEL, 'ax']);
		expect(sent.slice(2).join('')).not.toContain('s3cret');
	});

	it('turns smart punctuation back into what was typed', () => {
		expect(normalizeLiveText('‘a’ “b” c—d…')).toBe('\'a\' "b" c--d...');
		expect(run([change('-', false), change('—', false)]).sent).toEqual(['-', '-']);
		expect(run([change('it', false), change('it’', false)]).sent).toEqual(['it', '\'']);
	});

	it('turns an ideographic space from the Japanese keyboard into a plain space', () => {
		expect(normalizeLiveText('a\u3000b')).toBe('a b');
		expect(run([change('git', false), change('git\u3000', false), change('git\u3000s', false)]).sent).toEqual(['git', ' ', 's']);
	});
});

describe('liveInputStep with the reported marked text (iOS)', () => {
	it('holds romaji preedit and sends the conversion only when it is confirmed', () => {
		const { sent, state } = run([
			change('k', true), change('か', true), change('かn', true), change('かん', true),
			change('かんj', true), change('かんじ', true), change('漢字', true),
			change('漢字', false),
		]);
		expect({ sent, state }).toEqual({ sent: ['漢字'], state: { text: '漢字', sent: '漢字', held: '' } });
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
