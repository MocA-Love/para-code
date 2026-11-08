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
		const buttons = () => [...bar.element.querySelectorAll<HTMLElement>('.monaco-button')];
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
});
