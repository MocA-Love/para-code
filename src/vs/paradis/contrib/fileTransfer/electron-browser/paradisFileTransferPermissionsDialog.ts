/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「権限の変更…」のダイアログ。所有者・グループ・その他 × 読む・書く・実行のチェックと、8 進数の欄が
// 連動する。フォルダーのときだけ「中身にも適用」を選べる。
//
// IDialogService の標準ダイアログには任意の部品を置けないので、fork の自前モーダル（定期実行・設定と
// 同じ ParadisModalFocus）で描く。寸法は Para Code のダイアログ（角丸 8px・ボタン 5px・本文 13px）に揃える。

import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import {
	paradisFormatMode,
	paradisFormatOctalMode,
	paradisModeBit,
	paradisParseOctalMode,
	ParadisFileTypeChar,
	ParadisPermissionWhat,
	ParadisPermissionWho,
} from '../common/paradisFileTransfer.js';

const $ = dom.$;

export interface IParadisPermissionsDialogOptions {
	/** 見出しに出す名前（複数なら「3 項目」など）。 */
	readonly title: string;
	/** 対象の場所（`dev-server:/home/example/deploy.sh`）。 */
	readonly location: string;
	readonly initialMode: number;
	readonly typeChar: ParadisFileTypeChar;
	/** フォルダーを含むか（「中身にも適用」を出す）。 */
	readonly hasDirectory: boolean;
}

export interface IParadisPermissionsDialogResult {
	readonly mode: number;
	readonly recursive: boolean;
}

/** ダイアログを開き、「変更」なら選んだ値を、閉じたら undefined を返す。 */
export function paradisShowPermissionsDialog(container: HTMLElement, options: IParadisPermissionsDialogOptions): Promise<IParadisPermissionsDialogResult | undefined> {
	return new Promise(resolve => {
		const store = new DisposableStore();
		let mode = options.initialMode & 0o7777;
		let settled = false;
		const finish = (result: IParadisPermissionsDialogResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			backdrop.remove();
			store.dispose();
			resolve(result);
		};

		const backdrop = $('.para-ft-modal-backdrop.paradis-modal-backdrop');
		const modal = dom.append(backdrop, $('.para-ft-modal'));
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.tabIndex = -1;

		const title = dom.append(modal, $('h4'));
		title.id = 'para-ft-permissions-title';
		title.textContent = localize('paradis.fileTransfer.permissions.title', "{0} の権限を変更", options.title);
		modal.setAttribute('aria-labelledby', title.id);
		dom.append(modal, $('.para-ft-modal-detail')).textContent = options.location;

		const grid = dom.append(modal, $('.para-ft-pgrid'));
		grid.setAttribute('role', 'group');
		dom.append(grid, $('span'));
		const whats: Array<[ParadisPermissionWhat, string]> = [
			['read', localize('paradis.fileTransfer.permissions.read', "読む")],
			['write', localize('paradis.fileTransfer.permissions.write', "書く")],
			['execute', localize('paradis.fileTransfer.permissions.execute', "実行")],
		];
		for (const [, label] of whats) {
			dom.append(grid, $('span.para-ft-pgrid-head')).textContent = label;
		}
		const whos: Array<[ParadisPermissionWho, string]> = [
			['owner', localize('paradis.fileTransfer.permissions.owner', "所有者")],
			['group', localize('paradis.fileTransfer.permissions.group', "グループ")],
			['other', localize('paradis.fileTransfer.permissions.other', "その他")],
		];
		const checkboxes: Array<{ input: HTMLInputElement; bit: number }> = [];
		for (const [who, whoLabel] of whos) {
			dom.append(grid, $('span.para-ft-pgrid-label')).textContent = whoLabel;
			for (const [what, whatLabel] of whats) {
				const cell = dom.append(grid, $('span.para-ft-pgrid-cell'));
				const input = dom.append(cell, $<HTMLInputElement>('input'));
				input.type = 'checkbox';
				input.setAttribute('aria-label', `${whoLabel} ${whatLabel}`);
				const bit = paradisModeBit(who, what);
				checkboxes.push({ input, bit });
				store.add(dom.addDisposableListener(input, 'change', () => {
					mode = input.checked ? mode | bit : mode & ~bit;
					render('checkbox');
				}));
			}
		}

		const octalRow = dom.append(modal, $('.para-ft-octal'));
		const octalLabel = dom.append(octalRow, $<HTMLLabelElement>('label'));
		octalLabel.textContent = localize('paradis.fileTransfer.permissions.octal', "8 進数");
		const octal = dom.append(octalRow, $<HTMLInputElement>('input.para-ft-octal-input'));
		octal.id = 'para-ft-permissions-octal';
		octalLabel.htmlFor = octal.id;
		octal.spellcheck = false;
		octal.maxLength = 4;
		const preview = dom.append(octalRow, $('span.para-ft-octal-preview'));
		store.add(dom.addDisposableListener(octal, 'input', () => {
			const parsed = paradisParseOctalMode(octal.value);
			octal.classList.toggle('invalid', parsed === undefined);
			if (parsed !== undefined) {
				mode = parsed;
				render('octal');
			}
			change.disabled = parsed === undefined;
		}));

		let recursiveInput: HTMLInputElement | undefined;
		if (options.hasDirectory) {
			const recursiveRow = dom.append(modal, $('label.para-ft-recursive'));
			recursiveInput = dom.append(recursiveRow, $<HTMLInputElement>('input'));
			recursiveInput.type = 'checkbox';
			dom.append(recursiveRow, $('span')).textContent = localize('paradis.fileTransfer.permissions.recursive', "中身にも適用（ファイルの実行権は元の有無を保ちます。リンクの先は変えません）");
		}

		const buttons = dom.append(modal, $('.para-ft-modal-buttons'));
		const cancel = dom.append(buttons, $<HTMLButtonElement>('button.para-ft-button.secondary'));
		cancel.type = 'button';
		cancel.textContent = localize('paradis.fileTransfer.permissions.cancel', "キャンセル");
		const change = dom.append(buttons, $<HTMLButtonElement>('button.para-ft-button.primary'));
		change.type = 'button';
		change.textContent = localize('paradis.fileTransfer.permissions.apply', "変更");
		store.add(dom.addDisposableListener(cancel, 'click', () => finish(undefined)));
		store.add(dom.addDisposableListener(change, 'click', () => finish({ mode, recursive: !!recursiveInput?.checked })));
		store.add(dom.addDisposableListener(octal, 'keydown', e => {
			if (e.key === 'Enter' && !change.disabled) {
				e.preventDefault();
				finish({ mode, recursive: !!recursiveInput?.checked });
			}
		}));
		store.add(dom.addDisposableListener(backdrop, 'mousedown', e => {
			if (e.target === backdrop) {
				finish(undefined);
			}
		}));

		const before = paradisFormatMode(options.initialMode, options.typeChar);
		function render(from: 'checkbox' | 'octal' | 'init'): void {
			for (const { input, bit } of checkboxes) {
				input.checked = (mode & bit) !== 0;
			}
			if (from !== 'octal') {
				octal.value = paradisFormatOctalMode(mode);
				octal.classList.remove('invalid');
				change.disabled = false;
			}
			const after = paradisFormatMode(mode, options.typeChar);
			preview.textContent = '';
			dom.append(preview, $('span')).textContent = `${before} → `;
			const next = dom.append(preview, $('span'));
			next.textContent = after;
			next.classList.toggle('changed', after !== before);
		}
		render('init');

		container.appendChild(backdrop);
		store.add(new ParadisModalFocus({
			backdrop,
			modal,
			onEscape: () => finish(undefined),
			close: () => finish(undefined),
		}));
		octal.focus();
		octal.select();
	});
}
