/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { AppResourcePath, FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfirmationResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { PARADIS_CONFIRM_DIALOG_CLASS } from '../../browser/paradisConfirmDialog.js';
import { IParadisConfirmation, ParadisDialogService, paradisNotifyConfirmation } from '../../browser/paradisDialogService.js';
import { FocusMode } from '../../../../../platform/native/common/native.js';

/** 本家のダイアログと確認の CSS（長い補足のスクロールを見るため）。 */
const STYLESHEETS: AppResourcePath[] = [
	'vs/base/browser/ui/dialog/dialog.css',
	'vs/paradis/contrib/confirmDialog/browser/media/paradisConfirmDialog.css',
];

function loadStylesheet(path: AppResourcePath): Promise<HTMLLinkElement> {
	const link = mainWindow.document.createElement('link');
	link.rel = 'stylesheet';
	link.href = FileAccess.asBrowserUri(path).toString(true);
	const loaded = new Promise<HTMLLinkElement>((resolve, reject) => {
		link.addEventListener('load', () => resolve(link), { once: true });
		link.addEventListener('error', () => reject(new Error(`could not load ${path}`)), { once: true });
	});
	mainWindow.document.head.appendChild(link);
	return loaded;
}

suite('Paradis dialog service (confirm)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let container: HTMLElement;
	let service: ParadisDialogService;

	setup(() => {
		container = mainWindow.document.createElement('div');
		container.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(container);
		service = new ParadisDialogService(
			{ activeContainer: container } as unknown as ILayoutService,
			{ softDispatch: () => ({ kind: ResultKind.NoMatchingKb }) } as unknown as IKeybindingService,
			{ setWindowDimmed: () => { } } as unknown as IHostService,
		);
	});

	teardown(() => container.remove());

	function box(): HTMLElement {
		return container.querySelector<HTMLElement>(`.monaco-dialog-box.${PARADIS_CONFIRM_DIALOG_CLASS}`)!;
	}

	function button(label: string): HTMLElement {
		return [...box().querySelectorAll<HTMLElement>('.dialog-buttons .monaco-button')].find(element => element.textContent === label)!;
	}

	/** 今フォーカスのある要素に、キーを押して離す（本家の Esc は離したときに取消にする）。 */
	function press(key: 'Enter' | 'Escape'): string | null {
		const focused = mainWindow.document.activeElement as HTMLElement;
		const keyCode = key === 'Enter' ? 13 : 27;
		for (const type of ['keydown', 'keyup']) {
			focused.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode, bubbles: true }));
		}
		return focused.textContent;
	}

	async function answer(confirmation: IParadisConfirmation, act: () => unknown): Promise<{ readonly acted: unknown; readonly result: IConfirmationResult }> {
		const pending = service.confirm(confirmation);
		const acted = act();
		return { acted, result: await pending };
	}

	test('Enter runs the action by default, but a destructive confirmation starts on Cancel (danger action button) so Enter cancels; Esc cancels both', async () => {
		const plain = await answer({ message: 'タスクボードの接続口をオンにしますか？', primaryButton: 'オンにする' }, () => ({ kind: button('オンにする').classList.contains('paradis-button-primary'), focused: press('Enter') }));
		const plainEscape = await answer({ message: 'タスクボードの接続口をオンにしますか？', primaryButton: 'オンにする' }, () => press('Escape'));
		const destructive = await answer({ message: 'ワークツリー「a」を削除しますか？', detail: 'パス: /a', primaryButton: '削除', destructive: true }, () => ({ kind: button('削除').classList.contains('paradis-button-danger'), focused: press('Enter') }));
		const destructiveEscape = await answer({ message: 'ワークツリー「a」を削除しますか？', primaryButton: '削除', destructive: true }, () => press('Escape'));
		const destructiveClick = await answer({ message: 'ワークツリー「a」を削除しますか？', primaryButton: '削除', destructive: true }, () => button('削除').click());
		assert.deepStrictEqual({ plain, plainEscape, destructive, destructiveEscape, destructiveClick, closed: container.querySelector('.monaco-dialog-box') === null }, {
			plain: { acted: { kind: true, focused: 'オンにする' }, result: { confirmed: true, checkboxChecked: undefined } },
			plainEscape: { acted: 'オンにする', result: { confirmed: false, checkboxChecked: undefined } },
			destructive: { acted: { kind: true, focused: 'キャンセル' }, result: { confirmed: false, checkboxChecked: undefined } },
			destructiveEscape: { acted: 'キャンセル', result: { confirmed: false, checkboxChecked: undefined } },
			destructiveClick: { acted: undefined, result: { confirmed: true, checkboxChecked: undefined } },
			closed: true,
		});
	});

	test('an approval asked by someone else (focusCancel) starts on Cancel so Enter does not approve, but keeps the primary color', async () => {
		const approval = { message: 'モバイルデバイス「iPhone」を接続しますか？', detail: '確認コード: 123456', primaryButton: '接続を承認', cancelButton: '拒否', focusCancel: true };
		const enter = await answer(approval, () => ({ primary: button('接続を承認').classList.contains('paradis-button-primary'), danger: button('接続を承認').classList.contains('paradis-button-danger'), focused: press('Enter') }));
		const click = await answer(approval, () => button('接続を承認').click());
		assert.deepStrictEqual({ enter, click }, {
			enter: { acted: { primary: true, danger: false, focused: '拒否' }, result: { confirmed: false, checkboxChecked: undefined } },
			click: { acted: undefined, result: { confirmed: true, checkboxChecked: undefined } },
		});
	});

	test('the window notice before an unrequested confirmation only asks the OS to notify, and never throws', async () => {
		const calls: unknown[] = [];
		paradisNotifyConfirmation({ focus: async (_window: Window, options?: { mode?: FocusMode }) => { calls.push(options?.mode); } } as unknown as IHostService, mainWindow);
		// 無いサービス・失敗する知らせでも、確認は出せる（例外を投げない）
		paradisNotifyConfirmation(undefined, mainWindow);
		paradisNotifyConfirmation({ focus: () => Promise.reject(new Error('unsupported')) } as unknown as IHostService, mainWindow);
		paradisNotifyConfirmation({ focus: () => { throw new Error('unsupported'); } } as unknown as IHostService, mainWindow);
		await Promise.resolve();
		assert.deepStrictEqual(calls, [FocusMode.Notify]);
	});

	test('the checkbox is the kit check below the detail and comes back as checkboxChecked, also on cancel', async () => {
		const checkbox = { label: '削除の前に teardown スクリプトを実行する', checked: true };
		const confirmed = await answer({ message: 'ワークツリー「a」を削除しますか？', detail: 'パス: /a', primaryButton: '削除', destructive: true, checkbox }, () => {
			const row = box().querySelector<HTMLElement>('.dialog-checkbox-row')!;
			const shown = {
				kit: row.classList.contains('paradis-check'),
				focusRing: row.querySelector('.monaco-checkbox')?.classList.contains('paradis-focus-ring'),
				label: row.querySelector('.paradis-check-label')?.textContent,
				// 色は inline で書かない（paradisCheck.css が描く）
				inlineColor: row.querySelector<HTMLElement>('.monaco-checkbox')!.style.backgroundColor,
			};
			// 横の文字を押すと切り替わる（本家と同じ）。初めはオンなので、1 回押して外す
			row.querySelector<HTMLElement>('.dialog-checkbox-message')!.click();
			button('削除').click();
			return shown;
		});
		const cancelled = await answer({ message: 'ワークツリー「a」を削除しますか？', primaryButton: '削除', destructive: true, checkbox: { label: checkbox.label } }, () => {
			box().querySelector<HTMLElement>('.dialog-checkbox-message')!.click();
			return press('Escape');
		});
		assert.deepStrictEqual({ confirmed, cancelled }, {
			confirmed: { acted: { kit: true, focusRing: true, label: checkbox.label, inlineColor: '' }, result: { confirmed: true, checkboxChecked: false } },
			cancelled: { acted: 'キャンセル', result: { confirmed: false, checkboxChecked: true } },
		});
	});

	test('a long detail keeps its line breaks, aligns left and scrolls inside itself after 12 lines; the question stays the heading', async () => {
		const links = await Promise.all(STYLESHEETS.map(loadStylesheet));
		try {
			const lines = Array.from({ length: 30 }, (_, index) => `node_modules ${index + 1}`);
			const { acted } = await answer({ message: '古い依存とビルド出力を 30 件削除しますか？', detail: lines.join('\n'), primaryButton: '削除', destructive: true }, () => {
				const detail = box().querySelector<HTMLElement>('.dialog-message-detail')!;
				const style = mainWindow.getComputedStyle(detail);
				const shown = {
					heading: box().querySelector('.dialog-message-text')?.textContent,
					lineBreaks: detail.querySelectorAll('br').length,
					whiteSpace: style.whiteSpace,
					textAlign: style.textAlign,
					maxHeight: style.maxHeight,
					overflowY: style.overflowY,
					scrolls: detail.scrollHeight > detail.clientHeight,
				};
				press('Escape');
				return shown;
			});
			// 補足が無い確認でも、問いは見出しの行に入る（本家は補足の行に入れて見出しを作らない）
			const { acted: withoutDetail } = await answer({ message: 'レイアウト「a」を削除しますか？', primaryButton: '削除', destructive: true }, () => {
				const heading = box().querySelector('.dialog-message-text')?.textContent;
				press('Escape');
				return heading;
			});
			assert.deepStrictEqual({ acted, withoutDetail }, {
				acted: { heading: '古い依存とビルド出力を 30 件削除しますか？', lineBreaks: 29, whiteSpace: 'pre-wrap', textAlign: 'start', maxHeight: '240px', overflowY: 'auto', scrolls: true },
				withoutDetail: 'レイアウト「a」を削除しますか？',
			});
		} finally {
			links.forEach(link => link.remove());
		}
	});
});
