// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { IParadisMobileBrowserFocus } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileBrowserProtocol.js';
import { BROWSER_KEYBOARD_CLOSED, browserFieldCaption, browserKeyboardMultiline, browserKeyboardNotice, browserKeyboardSubmit, nextBrowserKeyboard, type BrowserKeyboardEvent, type BrowserKeyboardState } from './browserKeyboard.js';

const T = 'target-1';
function focus(seq: number, fields: Partial<IParadisMobileBrowserFocus> = {}): BrowserKeyboardEvent {
	return { kind: 'focus', focus: { t: 'focus', targetId: T, seq, focused: true, fieldId: 1, field: 'text', ...fields } };
}
function blur(seq: number): BrowserKeyboardEvent {
	return { kind: 'focus', focus: { t: 'focus', targetId: T, seq, focused: false } };
}
function run(events: readonly BrowserKeyboardEvent[], from: BrowserKeyboardState = { ...BROWSER_KEYBOARD_CLOSED, targetId: T }): BrowserKeyboardState {
	return events.reduce(nextBrowserKeyboard, from);
}
const view = (state: BrowserKeyboardState) => ({ open: state.open, auto: state.auto, text: state.text, baseline: state.baseline });

describe('browser keyboard', () => {
	test('タップで欄にフォーカスが入ると自動で開き、欄の中身を入れる。タップ以外のフォーカスでは開かない', () => {
		expect({
			pageFocus: view(run([focus(1, { value: 'auto' })])),
			tap: view(run([focus(1, { value: 'worktree', fromTap: true })])),
			stale: view(run([focus(2, { value: 'new', fromTap: true }), focus(1, { value: 'old', fromTap: true })])),
			otherPage: view(run([{ kind: 'focus', focus: { t: 'focus', targetId: 'other', seq: 1, focused: true, field: 'text', fromTap: true } }])),
		}).toEqual({
			pageFocus: { open: false, auto: false, text: '', baseline: undefined },
			tap: { open: true, auto: true, text: 'worktree', baseline: 'worktree' },
			stale: { open: true, auto: true, text: 'new', baseline: 'new' },
			otherPage: { open: false, auto: false, text: '', baseline: undefined },
		});
	});

	test('自動で開いたものはフォーカスが外れたら閉じる。直しかけ・手動で開いたものは閉じない', () => {
		expect({
			auto: view(run([focus(1, { value: 'a', fromTap: true }), blur(2)])),
			editing: view(run([focus(1, { value: 'a', fromTap: true }), { kind: 'text', text: 'ab' }, blur(2)])),
			manual: view(run([{ kind: 'open' }, blur(2)])),
		}).toEqual({
			auto: { open: false, auto: false, text: '', baseline: undefined },
			editing: { open: true, auto: true, text: 'ab', baseline: 'a' },
			manual: { open: true, auto: false, text: '', baseline: undefined },
		});
	});

	test('開いている間に欄の中身が変わったら、直していなければ追従する', () => {
		expect({
			follow: view(run([focus(1, { value: 'a', fromTap: true }), focus(2, { value: 'ab' })])),
			keep: view(run([focus(1, { value: 'a', fromTap: true }), { kind: 'text', text: 'x' }, focus(2, { value: 'ab' })])),
		}).toEqual({
			follow: { open: true, auto: true, text: 'ab', baseline: 'ab' },
			keep: { open: true, auto: true, text: 'x', baseline: 'ab' },
		});
	});

	test('Return は中身が欄と同じなら Enter、違えば置き換え。中身が分からない・古い PC は今までどおり足す', () => {
		const tapped = run([focus(1, { value: 'worktree', fromTap: true })]);
		const edited = run([{ kind: 'text', text: 'worktree 使い方' }], tapped);
		const replaced = run([{ kind: 'sent', input: { kind: 'replace', text: 'worktree 使い方' } }], edited);
		const truncated = run([focus(1, { value: 'long', truncated: true, fromTap: true }), { kind: 'text', text: 'more' }]);
		const manual = run([{ kind: 'open' }, { kind: 'text', text: 'abc' }]);
		expect({
			same: browserKeyboardSubmit(tapped, true, true),
			sameNoKeys: browserKeyboardSubmit(tapped, false, true),
			edited: browserKeyboardSubmit(edited, true, true),
			afterReplace: browserKeyboardSubmit(replaced, true, true),
			oldPc: browserKeyboardSubmit(edited, true, false),
			truncated: browserKeyboardSubmit(truncated, true, true),
			manual: browserKeyboardSubmit(manual, true, true),
			manualAfterSend: run([{ kind: 'sent', input: { kind: 'text', text: 'abc' } }], manual).text,
		}).toEqual({
			same: { kind: 'key', key: 'Enter' },
			sameNoKeys: undefined,
			edited: { kind: 'replace', text: 'worktree 使い方', fieldId: 1 },
			afterReplace: { kind: 'key', key: 'Enter' },
			oldPc: { kind: 'text', text: 'worktree 使い方' },
			truncated: { kind: 'text', text: 'more' },
			manual: { kind: 'text', text: 'abc' },
			manualAfterSend: '',
		});
	});

	test('パスワードの欄は中身を入れず伏せる。見出しの行は欄の種類と文字数', () => {
		const secret = run([focus(1, { inputType: 'password', secret: true, fromTap: true })]);
		const search = run([focus(1, { inputType: 'search', value: 'worktree', fromTap: true })]);
		const area = run([focus(1, { field: 'textarea', value: '一\n二', fromTap: true })]);
		expect({
			secret: { ...view(secret), secret: secret.secret, submit: browserKeyboardSubmit(run([{ kind: 'text', text: 'pw' }], secret), true, true) },
			captions: [browserFieldCaption(secret, 'password'), browserFieldCaption(search, 'search'), browserFieldCaption(area, undefined), browserFieldCaption(BROWSER_KEYBOARD_CLOSED, undefined)],
		}).toEqual({
			secret: { open: true, auto: true, text: '', baseline: '', secret: true, submit: { kind: 'replace', text: 'pw', fieldId: 1 } },
			captions: ['ページの欄: パスワード（type=password） · 中身は受け取りません', 'ページの欄: 検索（type=search） · 入力済み 8 文字', 'ページの欄: 複数行の欄 · 入力済み 3 文字', undefined],
		});
	});

	test('ページを替える・張り直すと閉じ、通知の番号もやり直す', () => {
		const opened = run([focus(5, { value: 'a', fromTap: true })]);
		expect({
			target: view(run([{ kind: 'target', targetId: 'target-2' }], opened)),
			restart: { ...view(run([{ kind: 'restart' }], opened)), reopen: run([{ kind: 'restart' }, focus(1, { value: 'b', fromTap: true })], opened).text },
		}).toEqual({
			target: { open: false, auto: false, text: '', baseline: undefined },
			restart: { open: false, auto: false, text: '', baseline: undefined, reopen: 'b' },
		});
	});

	test('欄 A を直しかけのまま欄 B をタップしても、A の文字で B を置き換えない（B の中身に合わせ直し、B の番号で送る）', () => {
		const editingA = run([focus(1, { fieldId: 1, value: 'aaa', fromTap: true }), { kind: 'text', text: 'aaa 直しかけ' }]);
		const tappedB = run([focus(2, { fieldId: 2, value: 'bbb', fromTap: true })], editingA);
		// ページが自分でフォーカスを動かした（OTP の自動送り・autofocus）ときも同じ
		const movedByPage = run([focus(2, { fieldId: 3, value: '' })], editingA);
		expect({
			tappedB: { ...view(tappedB), fieldId: tappedB.fieldId, submit: browserKeyboardSubmit(run([{ kind: 'text', text: 'bbb2' }], tappedB), true, true) },
			movedByPage: { ...view(movedByPage), fieldId: movedByPage.fieldId },
			// 番号を持たない古い PC の通知は、同じ欄とみなさず置き換えも送らない（足す方式）
			noFieldId: browserKeyboardSubmit(run([{ kind: 'focus', focus: { t: 'focus', targetId: T, seq: 1, focused: true, field: 'text', value: 'x', fromTap: true } }, { kind: 'text', text: 'xy' }]), true, true),
		}).toEqual({
			tappedB: { open: true, auto: true, text: 'bbb', baseline: 'bbb', fieldId: 2, submit: { kind: 'replace', text: 'bbb2', fieldId: 2 } },
			movedByPage: { open: true, auto: true, text: '', baseline: '', fieldId: 3 },
			noFieldId: { kind: 'text', text: 'xy' },
		});
	});

	test('contenteditable は中身を受け取らず、置き換えずに文字を足す（書式を消さない）', () => {
		const rich = run([focus(1, { field: 'contenteditable', value: '<b>太字</b>', fromTap: true }), { kind: 'text', text: '追記' }]);
		expect({
			view: view(rich),
			multiline: browserKeyboardMultiline(rich),
			submit: browserKeyboardSubmit(rich, true, true),
			caption: browserFieldCaption(rich, undefined),
		}).toEqual({
			view: { open: true, auto: true, text: '追記', baseline: undefined },
			multiline: true,
			submit: { kind: 'text', text: '追記' },
			caption: 'ページの欄: 編集できる領域 · 書式を残すため、打った文字を足します',
		});
	});

	test('textarea は複数行で直し、改行はそのまま置き換えに乗る', () => {
		const area = run([focus(1, { field: 'textarea', value: '一行目\n二行目', fromTap: true }), { kind: 'text', text: '一行目\n二行目\n三行目' }]);
		expect({ multiline: browserKeyboardMultiline(area), text: area.text, submit: browserKeyboardSubmit(area, true, true), single: browserKeyboardMultiline(run([focus(1, { fromTap: true })])) }).toEqual({
			multiline: true,
			text: '一行目\n二行目\n三行目',
			submit: { kind: 'replace', text: '一行目\n二行目\n三行目', fieldId: 1 },
			single: false,
		});
	});

	test('PC に置き換えを断られたら基準を戻して理由を出し、次に送るか欄が替わると消す', () => {
		const tapped = run([focus(1, { value: 'abc', fromTap: true }), { kind: 'text', text: 'abcd' }]);
		const sent = run([{ kind: 'sent', input: { kind: 'replace', text: 'abcd', fieldId: 1 } }], tapped);
		const rejected = run([{ kind: 'rejected', input: 'replace', reason: 'field-changed' }], sent);
		const tooLong = run([{ kind: 'rejected', input: 'text', reason: 'too-long' }], tapped);
		expect({
			sentBaseline: sent.baseline,
			rejected: { baseline: rejected.baseline, notice: browserKeyboardNotice(rejected), submit: browserKeyboardSubmit(rejected, true, true) },
			tooLong: browserKeyboardNotice(tooLong),
			clearedBySend: run([{ kind: 'sent', input: { kind: 'replace', text: 'abcd', fieldId: 1 } }], rejected).notice,
			clearedByField: run([focus(2, { fieldId: 9, value: '', fromTap: true })], rejected).notice,
		}).toEqual({
			sentBaseline: 'abcd',
			rejected: { baseline: 'abc', notice: 'ページの欄が替わったため送りませんでした', submit: { kind: 'replace', text: 'abcd', fieldId: 1 } },
			tooLong: '長すぎるため送りませんでした',
			clearedBySend: undefined,
			clearedByField: undefined,
		});
	});

	test('ページが遷移した後に同じ番号の欄が届いても、前の文書の直しかけの文字で置き換えない', () => {
		// 欄（番号 1）を直してフォームを送信 → 遷移。PC は文書が替わったことを focused: false で知らせる
		const editing = run([focus(1, { fieldId: 1, value: 'old', fromTap: true }), { kind: 'text', text: 'old 直しかけ' }]);
		const navigated = run([blur(2)], editing);
		// 新しいページの autofocus の欄が、たまたま同じ番号で届いた
		const autofocus = run([focus(3, { fieldId: 1, value: '' })], navigated);
		const tapped = run([focus(3, { fieldId: 1, value: 'new', fromTap: true })], navigated);
		expect({
			navigated: { field: navigated.field, fieldId: navigated.fieldId, open: navigated.open },
			autofocus: { ...view(autofocus), submit: browserKeyboardSubmit(autofocus, true, true) },
			tapped: { ...view(tapped), submit: browserKeyboardSubmit(tapped, true, true) },
		}).toEqual({
			navigated: { field: undefined, fieldId: undefined, open: true },
			autofocus: { open: true, auto: true, text: '', baseline: '', submit: { kind: 'key', key: 'Enter' } },
			tapped: { open: true, auto: true, text: 'new', baseline: 'new', submit: { kind: 'key', key: 'Enter' } },
		});
	});
});
