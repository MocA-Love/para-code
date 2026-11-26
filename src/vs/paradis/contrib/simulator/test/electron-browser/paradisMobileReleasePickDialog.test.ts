/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { PARADIS_AGENT_APPROVAL_DIALOG_CLASS } from '../../../agentBrowser/common/paradisAgentApprovalDialog.js';
import { IParadisConfirmServices } from '../../../confirmDialog/browser/paradisConfirmDialog.js';
import { IParadisMobileReleasePick, PARADIS_MOBILE_RELEASE_PICK_CLASS, paradisShowMobileReleasePick } from '../../electron-browser/paradisMobileReleasePickDialog.js';

suite('Paradis mobile: the confirmation that asks which device to detach', () => {

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

	function pick(): IParadisMobileReleasePick {
		return {
			lines: ['使いたい端末: iPhone 17', 'このターミナルには、上限の 10 台を渡しています。'],
			listLabel: '外す端末（渡した順）',
			devices: Array.from({ length: 10 }, (_, index) => ({ id: `ios:sim-${index}`, name: `Sim ${index}` })),
			approveLabel: '選んだ端末を外して渡す',
			selectedId: 'ios:sim-0',
		};
	}

	test('lists the devices as radios with the first one chosen, the deny button has the focus, and a click or Enter on a row chooses it', async () => {
		const model = pick();
		const pending = paradisShowMobileReleasePick(services, model, { message: '「dev」のエージェントが、モバイル端末を使いたいと求めています', paneLabel: '「dev」', markerClass: 'marker', token: CancellationToken.None });
		const box = container.querySelector<HTMLElement>('.monaco-dialog-box')!;
		const rows = [...box.querySelectorAll<HTMLElement>('.pmrp-option')];
		const checked = () => rows.map((row, index) => row.getAttribute('aria-checked') === 'true' ? index : -1).filter(index => index >= 0);
		const shown = {
			classes: [PARADIS_AGENT_APPROVAL_DIALOG_CLASS, PARADIS_MOBILE_RELEASE_PICK_CLASS, 'marker', 'paradis-confirm-dialog'].map(name => box.classList.contains(name)),
			focused: mainWindow.document.activeElement?.textContent,
			buttons: [...box.querySelectorAll<HTMLElement>('.dialog-buttons .monaco-button')].map(button => `${button.textContent}:${button.classList.contains('paradis-button-primary') ? 'primary' : 'secondary'}`).sort(),
			lines: [...box.querySelectorAll('.pmrp-body > p')].map(line => line.textContent),
			rows: rows.map(row => `${row.getAttribute('role')}:${row.textContent}`).slice(0, 2),
			// 行は Tab で回れる（本家の Dialog は本文の a だけを巡回に入れる）
			reachable: rows.every(row => row.tagName === 'A' && row.tabIndex === 0),
			group: box.querySelector('.pmrp-list')?.getAttribute('role'),
			checked: checked(),
		};
		rows[3].click();
		const afterClick = [checked(), model.selectedId];
		// Enter は行を選ぶだけで、ダイアログのボタン（拒否）を押さない
		rows[7].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
		const afterEnter = [checked(), model.selectedId, container.querySelector('.monaco-dialog-box') !== null];
		for (const type of ['keydown', 'keyup']) {
			box.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
		}
		assert.deepStrictEqual({ shown, afterClick, afterEnter, result: await pending, closed: container.querySelector('.monaco-dialog-box') === null }, {
			shown: {
				classes: [true, true, true, true],
				focused: '拒否',
				buttons: ['拒否:secondary', '選んだ端末を外して渡す:primary'],
				lines: ['使いたい端末: iPhone 17', 'このターミナルには、上限の 10 台を渡しています。', '外す端末（渡した順）'],
				rows: ['radio:Sim 0', 'radio:Sim 1'],
				reachable: true,
				group: 'radiogroup',
				checked: [0],
			},
			afterClick: [[3], 'ios:sim-3'],
			afterEnter: [[7], 'ios:sim-7', true],
			result: undefined,
			closed: true,
		});
	});
});
