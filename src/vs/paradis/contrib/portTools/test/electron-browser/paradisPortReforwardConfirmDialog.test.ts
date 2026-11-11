/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { IParadisConfirmServices } from '../../../confirmDialog/browser/paradisConfirmDialog.js';
import { paradisReforwardConfirm } from '../../common/paradisPortReforwardConfirm.js';
import { PARADIS_PORT_REFORWARD_CONFIRM_CLASS, paradisShowReforwardConfirm } from '../../electron-browser/paradisPortReforwardConfirmDialog.js';

suite('Paradis port reforward confirmation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let container: HTMLElement;
	let services: IParadisConfirmServices;

	setup(() => {
		container = mainWindow.document.createElement('div');
		container.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(container);
		services = {
			layoutService: { activeContainer: container } as unknown as ILayoutService,
			keybindingService: { softDispatch: () => ({ kind: ResultKind.NoMatchingKb }) } as unknown as IKeybindingService,
			hostService: { setWindowDimmed: () => { } } as unknown as IHostService,
		};
	});

	teardown(() => container.remove());

	const confirm = paradisReforwardConfirm({
		rows: Array.from({ length: 21 }, (_, index) => ({ remotePort: 21000 + index, localPort: index === 1 ? 65401 : 21000 + index, changesLocal: index === 1 })),
		inUse: [{ remotePort: 21100, localPort: 65460 }],
		reason: 'The page does not load',
		asksReason: true,
		otherWindows: { kind: 'some', count: 2 },
	});

	test('the deny button has the focus and is secondary, the action is the primary button; the folded list opens; Escape denies', async () => {
		const pending = paradisShowReforwardConfirm(services, confirm, { message: confirm.title, paneLabel: '「dev」（ターミナル 3）', markerClass: 'marker', token: CancellationToken.None });
		const box = container.querySelector<HTMLElement>('.monaco-dialog-box')!;
		const buttons = [...box.querySelectorAll<HTMLElement>('.dialog-buttons .monaco-button')];
		const list = box.querySelector<HTMLElement>('.pprc-all')!;
		const toggle = box.querySelector<HTMLElement>('.pprc-toggle')!;
		const before = { hidden: list.hidden, toggle: toggle.textContent, expanded: toggle.getAttribute('aria-expanded') };
		toggle.click();
		const after = { hidden: list.hidden, toggle: toggle.textContent, expanded: toggle.getAttribute('aria-expanded'), rows: list.children.length };
		const shown = {
			classes: [PARADIS_PORT_REFORWARD_CONFIRM_CLASS, 'marker', 'paradis-confirm-dialog'].map(name => box.classList.contains(name)),
			title: box.querySelector('.dialog-message-text')?.textContent,
			focused: mainWindow.document.activeElement?.textContent,
			// 並びは OS ごとに本家が決めるので、並びは見ない
			buttons: buttons.map(button => `${button.textContent}:${button.classList.contains('paradis-button-primary') ? 'primary' : button.classList.contains('paradis-button-secondary') ? 'secondary' : 'other'}`).sort(),
			chips: box.querySelectorAll('.pprc-port').length,
			who: box.querySelector('.pprc-who-text')?.textContent,
			inUse: box.querySelectorAll('.pprc-note').length,
			effects: [...box.querySelectorAll('.pprc-effect-heading')].map(heading => `${heading.textContent}:${heading.classList[1]}`),
			deny: box.querySelector('.pprc-deny')?.textContent,
		};
		for (const type of ['keydown', 'keyup']) {
			box.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
		}
		const result = await pending;
		assert.deepStrictEqual({ shown, before, after, result, closed: container.querySelector('.monaco-dialog-box') === null }, {
			shown: {
				classes: [true, true, true],
				title: 'エージェントが転送 21 件のつなぎ直しを求めています',
				focused: '拒否',
				buttons: ['21 件をつなぎ直す:primary', '拒否:secondary'],
				chips: 12,
				who: '頼んだターミナル: 「dev」（ターミナル 3）エージェントが書いた理由: The page does not load',
				inUse: 1,
				effects: ['この窓:warning', 'ほかの窓:warning'],
				deny: '拒否すると何も変わりません。このターミナルからのポートの変更は 3 分間、自動で断ります。',
			},
			before: { hidden: true, toggle: 'ほか 9 件と一覧を見る', expanded: 'false' },
			after: { hidden: false, toggle: '一覧を閉じる', expanded: 'true', rows: 21 },
			result: undefined,
			closed: true,
		});
	});

	test('closes without an answer when the request is cancelled', async () => {
		const source = new CancellationTokenSource();
		const pending = paradisShowReforwardConfirm(services, confirm, { message: confirm.title, paneLabel: 'pane', markerClass: 'marker', token: source.token });
		source.cancel();
		const result = await pending;
		source.dispose();
		assert.deepStrictEqual({ result, closed: container.querySelector('.monaco-dialog-box') === null }, { result: undefined, closed: true });
	});
});
