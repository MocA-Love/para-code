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
// 同じ ParadisModalFocus）で描く。箱は UI キットの S（見出しの帯・本文・下の帯、paradisPresetRunConfirm.ts と同じ並び）で、
// チェック・8 進数の欄・ボタンもキットの部品を使う。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { paradisButtonClasses } from '../../../browser/paradisButton.js';
import { ParadisCheck } from '../../../browser/paradisCheck.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { PARADIS_MODAL_DRAFT_RESTORED, paradisModalDraftSnapshot, ParadisModalDrafts } from '../../paradisSettings/browser/paradisModalDrafts.js';
import { PARADIS_MODAL_BACKDROP_CLASS, PARADIS_MODAL_BODY_CLASS, PARADIS_MODAL_FOOT_CLASS, paradisModalClasses, ParadisModalSize, renderParadisModalHead } from '../../../browser/paradisModal.js';
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
	/**
	 * 変更せずに閉じられたときの下書きのキー（対象の側と項目の一覧）。別のモーダルに閉じられたときなどに選んだ権限を覚え、
	 * 同じ項目を同じ権限のまま開き直したときに戻す。省くと覚えない。
	 */
	readonly draftKey?: string;
}

export interface IParadisPermissionsDialogResult {
	readonly mode: number;
	readonly recursive: boolean;
}

/**
 * 「変更」も「キャンセル」も押さずに閉じた権限の選択（キー → 選んだ権限）。キーには開いたときの権限を含め、
 * 項目の権限がその後に変わっていたら戻さない。「中身にも適用」は覚えない（戻すと、開いて Enter を押すだけで
 * 確かめずに中身まで変えてしまうため。いつも外した状態で開く）。
 */
const permissionsDrafts = new ParadisModalDrafts<{ readonly mode: number }>();

/** ダイアログを開き、「変更」なら選んだ値を、閉じたら undefined を返す。 */
export function paradisShowPermissionsDialog(container: HTMLElement, options: IParadisPermissionsDialogOptions): Promise<IParadisPermissionsDialogResult | undefined> {
	return new Promise(resolve => {
		const store = new DisposableStore();
		const initial = { mode: options.initialMode & 0o7777 };
		const draftKey = options.draftKey === undefined ? undefined : `${options.draftKey}|${initial.mode}`;
		const draft = draftKey === undefined ? undefined : permissionsDrafts.take(draftKey);
		let mode = draft?.mode ?? initial.mode;
		let settled = false;
		/** 「変更」と「キャンセル」なら下書きを捨て、それ以外（Esc・外側の押下・別のモーダル）で閉じたら変えた値を残す。 */
		const finish = (result: IParadisPermissionsDialogResult | undefined, discard: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			if (draftKey !== undefined) {
				if (discard) {
					permissionsDrafts.discard(draftKey);
				} else {
					permissionsDrafts.keepIfChanged(draftKey, { mode }, paradisModalDraftSnapshot(initial));
				}
			}
			backdrop.remove();
			store.dispose();
			resolve(result);
		};

		const backdrop = $(`.para-ft-modal-backdrop.${PARADIS_MODAL_BACKDROP_CLASS}`);
		const modal = dom.append(backdrop, $('.para-ft-modal'));
		modal.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.tabIndex = -1;

		const head = renderParadisModalHead(modal, localize('paradis.fileTransfer.permissions.title', "{0} の権限を変更", options.title));
		head.title.id = 'para-ft-permissions-title';
		modal.setAttribute('aria-labelledby', head.title.id);
		const closeLabel = localize('paradis.fileTransfer.permissions.close', "閉じる");
		const close = dom.append(head.actions, $<HTMLButtonElement>('button'));
		close.type = 'button';
		close.classList.add(...paradisButtonClasses('icon'));
		close.title = closeLabel;
		close.setAttribute('aria-label', closeLabel);
		dom.append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
		// 閉じるボタンは Esc と同じ（変えた権限は下書きに残す）
		store.add(dom.addDisposableListener(close, 'click', () => finish(undefined, false)));

		const body = dom.append(modal, $(`.${PARADIS_MODAL_BODY_CLASS}`));
		dom.append(body, $('.para-ft-modal-detail')).textContent = options.location;
		if (draft) {
			dom.append(body, $('.para-ft-modal-detail')).textContent = PARADIS_MODAL_DRAFT_RESTORED;
		}

		const grid = dom.append(body, $('.para-ft-pgrid'));
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
		const checkboxes: Array<{ check: ParadisCheck; bit: number }> = [];
		for (const [who, whoLabel] of whos) {
			dom.append(grid, $('span.para-ft-pgrid-label')).textContent = whoLabel;
			for (const [what, whatLabel] of whats) {
				const cell = dom.append(grid, $('span.para-ft-pgrid-cell'));
				// 文字は見せず（行と列の見出しが代わり）、読み上げの名前にだけ使う
				const check = store.add(new ParadisCheck(cell, { label: `${whoLabel} ${whatLabel}`, checked: false }));
				const bit = paradisModeBit(who, what);
				checkboxes.push({ check, bit });
				store.add(check.onDidChange(checked => {
					mode = checked ? mode | bit : mode & ~bit;
					render('checkbox');
				}));
			}
		}

		const octalRow = dom.append(body, $('.para-ft-octal'));
		const octalLabel = dom.append(octalRow, $<HTMLLabelElement>('label'));
		const octalLabelText = localize('paradis.fileTransfer.permissions.octal', "8 進数");
		octalLabel.textContent = octalLabelText;
		const octalField = store.add(new ParadisInputField(octalRow, { ariaLabel: octalLabelText, small: true }));
		const octal = octalField.inputElement;
		octal.id = 'para-ft-permissions-octal';
		octalLabel.htmlFor = octal.id;
		octal.maxLength = 4;
		octal.autocomplete = 'off';
		const preview = dom.append(octalRow, $('span.para-ft-octal-preview'));
		// 欄の値は render() が `<input>` へ直接書く（InputBox の value の代入は onDidChange を出し、チェックからの描き直しが
		// 8 進数の欄の処理へ戻ってくるため）。打った文字は DOM の input で受ける
		store.add(dom.addDisposableListener(octal, 'input', () => {
			const parsed = paradisParseOctalMode(octal.value);
			octalField.element.classList.toggle('invalid', parsed === undefined);
			if (parsed !== undefined) {
				mode = parsed;
				render('octal');
			}
			setChangeEnabled(parsed !== undefined);
		}));

		let recursiveCheck: ParadisCheck | undefined;
		if (options.hasDirectory) {
			recursiveCheck = store.add(new ParadisCheck(body, { label: localize('paradis.fileTransfer.permissions.recursive', "中身にも適用（ファイルの実行権は元の有無を保ちます。リンクの先は変えません）"), checked: false }));
			recursiveCheck.element.classList.add('para-ft-recursive');
		}

		const foot = dom.append(modal, $(`.${PARADIS_MODAL_FOOT_CLASS}`));
		const cancel = dom.append(foot, $<HTMLButtonElement>('button'));
		cancel.type = 'button';
		cancel.classList.add(...paradisButtonClasses('secondary'));
		cancel.textContent = localize('paradis.fileTransfer.permissions.cancel', "キャンセル");
		const change = dom.append(foot, $<HTMLButtonElement>('button'));
		change.type = 'button';
		change.classList.add(...paradisButtonClasses('primary'));
		change.textContent = localize('paradis.fileTransfer.permissions.apply', "変更");
		/** キットのボタンは `.disabled` で押せない見た目になる（paradisButton.css）。 */
		function setChangeEnabled(enabled: boolean): void {
			change.disabled = !enabled;
			change.classList.toggle('disabled', !enabled);
		}
		store.add(dom.addDisposableListener(cancel, 'click', () => finish(undefined, true)));
		store.add(dom.addDisposableListener(change, 'click', () => finish({ mode, recursive: !!recursiveCheck?.checked }, true)));
		store.add(dom.addDisposableListener(octal, 'keydown', e => {
			// 日本語入力の確定の Enter では変更しない（keyCode 229 は変換中の打鍵）
			if (e.isComposing || e.keyCode === 229) {
				return;
			}
			if (e.key === 'Enter' && !change.disabled) {
				e.preventDefault();
				finish({ mode, recursive: !!recursiveCheck?.checked }, true);
			}
		}));
		store.add(dom.addDisposableListener(backdrop, 'mousedown', e => {
			if (e.target === backdrop) {
				finish(undefined, false);
			}
		}));

		const before = paradisFormatMode(options.initialMode, options.typeChar);
		function render(from: 'checkbox' | 'octal' | 'init'): void {
			for (const { check, bit } of checkboxes) {
				check.checked = (mode & bit) !== 0;
			}
			if (from !== 'octal') {
				octal.value = paradisFormatOctalMode(mode);
				octalField.element.classList.remove('invalid');
				setChangeEnabled(true);
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
			onEscape: () => finish(undefined, false),
			close: () => finish(undefined, false),
		}));
		octal.focus();
		octal.select();
	});
}
