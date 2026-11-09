/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ParadisMobilePairingDialog, ParadisPairingCloseGuard, paradisPairingRemainingText } from '../../electron-browser/paradisMobilePairingDialog.js';
import { paradisOpenAnotherModal } from '../../../paradisSettings/test/browser/paradisModalTestUtils.js';
import { paradisCancelsCurrentPairing } from '../../common/paradisMobileRelay.js';

suite('ParadisMobilePairingDialog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts down the pairing lifetime as m:ss and reports expiry', () => {
		const expiresAt = 300_000;
		assert.deepStrictEqual(
			[0, 8_001, 299_001, 300_000, 310_000].map(now => paradisPairingRemainingText(expiresAt, now)),
			['5:00', '4:52', '0:01', undefined, undefined],
		);
	});

	test('shows the QR, three steps and a copy button in a small modal, and removes itself when disposed', async () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const copied: string[] = [];
		const layoutService = { activeContainer: container } as Pick<ILayoutService, 'activeContainer'> as ILayoutService;
		const clipboardService = { writeText: async (text: string) => { copied.push(text); } } as Pick<IClipboardService, 'writeText'> as IClipboardService;
		const dialog = new ParadisMobilePairingDialog('<svg xmlns="http://www.w3.org/2000/svg"/>', 'paracode-mobile://pair?x=1', Date.now() + 60_000, layoutService, clipboardService);
		const text = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map(element => element.textContent);
		const before = {
			classes: [...container.querySelector('.paradis-mobile-pairing-dialog')!.classList],
			title: text('.pmp-title'),
			steps: text('.pmp-steps > li'),
			remainingStartsWith: text('.pmp-remaining')[0]?.startsWith('あと '),
			copy: text('.pmp-footer .monaco-button'),
		};
		container.querySelector<HTMLElement>('.pmp-footer .monaco-button')!.click();
		await Promise.resolve();
		dialog.dispose();
		const after = container.querySelector('.paradis-mobile-pairing-backdrop');
		container.remove();
		assert.deepStrictEqual({ before, copied, after }, {
			before: {
				classes: ['paradis-mobile-pairing-dialog', 'paradis-modal', 'paradis-modal-s', 'paradis-focus-none'],
				title: ['モバイルデバイスを接続'],
				steps: ['Para Code Mobile で「QR を読み取る」を開く', 'この QR を読み取る', '両方に出る 6 桁のコードが同じか確かめて承認する'],
				remainingStartsWith: true,
				copy: ['リンクをコピー'],
			},
			copied: ['paracode-mobile://pair?x=1'],
			after: null,
		});
	});

	test('closes when another Para Code modal opens, and on Esc, instead of staying hidden behind it', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const layoutService = { activeContainer: container } as Pick<ILayoutService, 'activeContainer'> as ILayoutService;
		const clipboardService = { writeText: async () => { } } as Pick<IClipboardService, 'writeText'> as IClipboardService;
		const open = () => new ParadisMobilePairingDialog('<svg xmlns="http://www.w3.org/2000/svg"/>', 'paracode-mobile://pair?x=1', Date.now() + 60_000, layoutService, clipboardService);
		const shown = () => !!container.querySelector('.paradis-mobile-pairing-backdrop');
		const first = open();
		const openedFirst = shown();
		const other = paradisOpenAnotherModal();
		const afterOtherModal = shown();
		other.dispose();
		first.dispose();
		const second = open();
		container.querySelector<HTMLElement>('.paradis-mobile-pairing-dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
		const afterEscape = shown();
		second.dispose();
		container.remove();
		assert.deepStrictEqual({ openedFirst, afterOtherModal, afterEscape }, { openedFirst: true, afterOtherModal: false, afterEscape: false });
	});

	test('tells once that it closed, and the close guard cancels only a pairing that is neither settled nor being confirmed', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const layoutService = { activeContainer: container } as Pick<ILayoutService, 'activeContainer'> as ILayoutService;
		const clipboardService = { writeText: async () => { } } as Pick<IClipboardService, 'writeText'> as IClipboardService;
		const dialog = new ParadisMobilePairingDialog('<svg xmlns="http://www.w3.org/2000/svg"/>', 'paracode-mobile://pair?x=1', Date.now() + 60_000, layoutService, clipboardService);
		let closes = 0;
		const listener = dialog.onDidClose(() => closes++);
		container.querySelector<HTMLElement>('.paradis-mobile-pairing-dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
		dialog.dispose();
		listener.dispose();
		container.remove();

		const closedWhileWaiting = new ParadisPairingCloseGuard();
		const waiting = [closedWhileWaiting.shouldCancelOnClose(), closedWhileWaiting.shouldCancelOnClose()];
		const settled = new ParadisPairingCloseGuard();
		settled.settle();
		const confirming = new ParadisPairingCloseGuard();
		confirming.beginConfirm();
		const duringConfirm = confirming.shouldCancelOnClose();
		confirming.endConfirm();
		assert.deepStrictEqual({ closes, waiting, afterSettled: settled.shouldCancelOnClose(), duringConfirm, afterConfirm: confirming.shouldCancelOnClose() }, {
			closes: 1, waiting: [true, false], afterSettled: false, duringConfirm: false, afterConfirm: true,
		});
	});

	test('does not cancel a pairing approved before it settles, and a modal of an earlier pairing does not cancel the next one', () => {
		// 確認コードのダイアログで承認した（呼び出し側は承認の時点で settle する）後、成立の知らせより先に小窓を閉じる
		const approved = new ParadisPairingCloseGuard();
		approved.beginConfirm();
		approved.settle();
		const closedAfterApprove = approved.shouldCancelOnClose();
		// 拒否したときは確認を終えるだけ（拒否で断る）。その後に閉じても二重には断らない
		const rejected = new ParadisPairingCloseGuard();
		rejected.beginConfirm();
		rejected.endConfirm();
		const closedAfterReject = rejected.shouldCancelOnClose();
		assert.deepStrictEqual({
			closedAfterApprove,
			closedAfterReject,
			// 1 回目の小窓を開いたまま接続をやり直し（今のペアリングは 2 回目）、1 回目の小窓が閉じられた
			firstModalClosesSecondPairing: paradisCancelsCurrentPairing('pair-2', 'pair-1'),
			secondModalClosesSecondPairing: paradisCancelsCurrentPairing('pair-2', 'pair-2'),
			callerWithoutId: paradisCancelsCurrentPairing('pair-2'),
			nothingPending: paradisCancelsCurrentPairing(undefined, 'pair-1'),
		}, {
			closedAfterApprove: false,
			closedAfterReject: true,
			firstModalClosesSecondPairing: false,
			secondModalClosesSecondPairing: true,
			callerWithoutId: true,
			nothingPending: false,
		});
	});
});
