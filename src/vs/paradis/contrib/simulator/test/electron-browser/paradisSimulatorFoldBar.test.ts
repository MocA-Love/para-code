/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// iPhone Duo の開閉のバー。Device Hub が起動していないときの案内と、外と内が切り替わらないとき（iOS 27.2）の知らせ。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisSimulatorFoldBar, ParadisSimulatorFoldRequest, paradisSimulatorPanelMismatch } from '../../electron-browser/paradisSimulatorFoldBar.js';

suite('Paradis simulator: fold bar', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const container = document.createElement('div');
		const bar = store.add(new ParadisSimulatorFoldBar(container));
		const requests: ParadisSimulatorFoldRequest[] = [];
		let deviceHub = 0;
		store.add(bar.onDidRequestFold(request => requests.push(request)));
		store.add(bar.onDidRequestDeviceHub(() => deviceHub++));
		const notes = () => [...bar.element.querySelectorAll<HTMLElement>('.paradis-simulator-fold-note')].filter(note => note.style.display !== 'none').map(note => note.textContent ?? '');
		const buttons = () => [...bar.element.querySelectorAll<HTMLElement>('.paradis-seg > button, .monaco-button')];
		return { bar, requests, notes, buttons, deviceHubClicks: () => deviceHub };
	}

	test('hides itself for devices that do not fold', () => {
		const { bar } = setup();
		bar.update(undefined);
		assert.strictEqual(bar.element.style.display, 'none');
	});

	test('sends the pose of the pressed button', () => {
		const { bar, requests, buttons } = setup();
		bar.update({ hingeDegrees: 180, activeDisplay: 'inner', deviceHubRunning: true, busy: false });
		buttons()[0].click();
		buttons()[1].click();
		assert.deepStrictEqual({ requests, shown: bar.element.style.display }, { requests: [{ kind: 'pose', pose: 'closed' }, { kind: 'pose', pose: 'book' }], shown: '' });
	});

	// 今の姿勢は塗りだけでなく aria-pressed で読み上げる。開閉している間は押せないが、押したボタンのフォーカスは残す
	// （native の disabled にするとフォーカスが body へ落ち、キーボードで続けて選べなくなる）
	test('marks the current pose as pressed', () => {
		const { bar, buttons, requests } = setup();
		const poses = () => buttons().slice(0, 3).map(button => ({ label: button.textContent, pressed: button.getAttribute('aria-pressed'), disabled: button.getAttribute('aria-disabled') === 'true' }));
		document.body.appendChild(bar.element);
		try {
			bar.update({ hingeDegrees: 130, activeDisplay: 'inner', deviceHubRunning: true, busy: false });
			const book = poses();
			buttons()[1].focus();
			bar.update({ hingeDegrees: 95, activeDisplay: 'inner', deviceHubRunning: true, busy: true });
			buttons()[2].click();
			assert.deepStrictEqual({ book, between: poses(), keptFocus: document.activeElement === buttons()[1], requests }, {
				book: [{ label: '閉じた 0°', pressed: 'false', disabled: false }, { label: '本 130°', pressed: 'true', disabled: false }, { label: '開いた 180°', pressed: 'false', disabled: false }],
				between: [{ label: '閉じた 0°', pressed: 'false', disabled: true }, { label: '本 130°', pressed: 'false', disabled: true }, { label: '開いた 180°', pressed: 'false', disabled: true }],
				keptFocus: true,
				requests: [],
			});
		} finally {
			bar.element.remove();
		}
	});

	// 開閉は Device Hub が起動していないと効かない（Mac で実測）。起動の案内とボタンを出す
	test('asks to start Device Hub when it is not running', () => {
		const { bar, notes, buttons, deviceHubClicks } = setup();
		bar.update({ hingeDegrees: 180, activeDisplay: 'inner', deviceHubRunning: false, busy: false });
		const shown = notes();
		buttons().find(button => button.textContent === 'Device Hub を起動')?.click();
		assert.deepStrictEqual({ shown, clicks: deviceHubClicks() }, { shown: ['開閉には Xcode の Device Hub が起動している必要があります。Device Hub を起動'], clicks: 1 });
	});

	// iOS 27.2 では閉じても内の画面のまま映る（Mac で実測）。その旨を出す
	test('says when the screen did not switch to the cover display', () => {
		const { bar, notes } = setup();
		bar.update({ hingeDegrees: 0, activeDisplay: 'inner', deviceHubRunning: true, busy: false });
		assert.deepStrictEqual({
			mismatch: [paradisSimulatorPanelMismatch({ hingeDegrees: 0, activeDisplay: 'inner' }), paradisSimulatorPanelMismatch({ hingeDegrees: 0, activeDisplay: 'cover' }), paradisSimulatorPanelMismatch({ hingeDegrees: 130, activeDisplay: 'inner' })],
			noted: notes().length === 1 && notes()[0].includes('iOS 27.2'),
		}, { mismatch: [true, false, false], noted: true });
	});

	// Xcode 27.2 では、1 度開閉するまで開き具合が読めない。その間は「開き具合は不明」と出し、姿勢の組だけを出す
	// （どれも選ばない・角度のスライダーは出さない）。姿勢を押すと最初の開閉を送り、値が返ればいつもの表示に戻る
	test('offers the poses while the hinge angle is unknown', () => {
		const { bar, requests, notes, buttons } = setup();
		const look = () => ({
			status: bar.element.querySelector('.paradis-simulator-fold-status')?.textContent,
			poses: buttons().slice(0, 3).map(button => `${button.textContent}:${button.getAttribute('aria-pressed')}:${button.getAttribute('aria-disabled') === 'true' ? 'off' : 'on'}`),
			angleButton: buttons().find(button => button.textContent === '角度')?.style.display,
			slider: bar.element.querySelector<HTMLElement>('.paradis-simulator-fold-slider')?.style.display,
			notes: notes(),
		});
		bar.update({ hingeDegrees: undefined, activeDisplay: 'inner', deviceHubRunning: true, busy: false });
		const unknown = look();
		buttons()[2].click();
		bar.update({ hingeDegrees: undefined, activeDisplay: undefined, deviceHubRunning: false, busy: false, error: '開閉できませんでした。' });
		const refused = look();
		bar.update({ hingeDegrees: 180, activeDisplay: 'inner', deviceHubRunning: true, busy: false });
		assert.deepStrictEqual({ unknown, refused, known: look(), requests, mismatch: paradisSimulatorPanelMismatch({ hingeDegrees: undefined, activeDisplay: 'inner' }) }, {
			unknown: {
				status: '開き具合は不明 · 内の画面',
				poses: ['閉じた 0°:false:on', '本 130°:false:on', '開いた 180°:false:on'],
				angleButton: 'none',
				slider: 'none',
				notes: ['この Xcode では今の開き具合を読み取れません。姿勢を選ぶと、その姿勢に動かして表示を合わせます。'],
			},
			refused: {
				status: '開き具合は不明',
				poses: ['閉じた 0°:false:on', '本 130°:false:on', '開いた 180°:false:on'],
				angleButton: 'none',
				slider: 'none',
				notes: ['開閉できませんでした。', '開閉には Xcode の Device Hub が起動している必要があります。Device Hub を起動'],
			},
			known: {
				status: '180° · 内の画面',
				poses: ['閉じた 0°:false:on', '本 130°:false:on', '開いた 180°:true:on'],
				angleButton: '',
				slider: 'none',
				notes: [],
			},
			requests: [{ kind: 'pose', pose: 'open' }],
			mismatch: false,
		});
	});
});
