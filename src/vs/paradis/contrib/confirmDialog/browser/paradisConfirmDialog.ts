/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 3（Q600）の確認のダイアログ（S 段）。消すなどの確認を、OS のシートではなく Para Code の小さいダイアログで出す。
// 見出し（問い）・補足・取消（副）・実行（主、消すときは危険のボタン）。
//
// 包んでいる本家のファイル（upstream を取り込むときは、ここの差分の「キー・フォーカス・読み上げ」を読む）:
//  - src/vs/base/browser/ui/dialog/dialog.ts（role="dialog"・aria-modal・aria-labelledby、フォーカスの閉じ込め、Esc で取消、
//    Enter で押す、閉じたら元の要素へフォーカスを戻す。本家の確認（dialogService.confirm の HTML 版）と同じ部品）
//  - src/vs/workbench/browser/parts/dialogs/dialog.ts の createWorkbenchDialogOptions（開いている間はショートカットを止める、
//    ウィンドウのボタンを暗くする。本家の確認と同じ設定をそのまま使う）
// 重なりの段は本家のダイアログの 2575 なので、fork のモーダル（2542）の上に出る。見た目は paradisConfirmDialog.css。
// 本家は色を inline の style で書くので、ボタンの色は渡さず、箱の色はキットの色の役目（CSS 変数）を渡す。

import './media/paradisConfirmDialog.css';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { IButton, IButtonStyles } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { asCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { createWorkbenchDialogOptions } from '../../../../workbench/browser/parts/dialogs/dialog.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { paradisButtonClasses, ParadisButtonKind } from '../../../browser/paradisButton.js';
import { PARADIS_CHECKBOX_STYLES } from '../../../browser/paradisCheck.js';

/** 確認のダイアログの箱に付くクラス。 */
export const PARADIS_CONFIRM_DIALOG_CLASS = 'paradis-confirm-dialog';

export interface IParadisConfirmButton<T> {
	readonly label: string;
	/** 1 つ目は主（消すときは `danger`）、2 つ目からは副。 */
	readonly kind?: 'primary' | 'danger' | 'secondary';
	readonly run: () => T;
}

export interface IParadisConfirmOptions<T> {
	/** 問い（見出し）。 */
	readonly message: string;
	readonly detail?: string;
	/** 押すボタン。先頭が既定（Enter）。 */
	readonly buttons: readonly IParadisConfirmButton<T>[];
	/** 取消のボタンの文字（Esc でも同じ）。省くと「キャンセル」。 */
	readonly cancelLabel?: string;
	/**
	 * 取消のボタンを足さず、`buttons` のこの番号を取消（Esc・閉じる）として扱う。押すと undefined を返す。
	 * 既定（Enter）のボタンを取消にしたいとき（エージェントの求めの確認の「拒否」など）に 0 を渡す。
	 */
	readonly cancelIndex?: number;
	/** 補足の下に描く本文。 */
	readonly renderBody?: (container: HTMLElement) => void;
	/** 箱に足すクラス。 */
	readonly extraClasses?: readonly string[];
	/** 取り消されたら閉じ、取消と同じく undefined を返す。 */
	readonly token?: CancellationToken;
	/** 補足の下に出すチェック（キットのチェックの見た目）。状態は {@link openParadisConfirmDialog} が返す。 */
	readonly checkbox?: { readonly label: string; readonly checked?: boolean };
	/**
	 * 初めのフォーカスを取消のボタンに置く（Enter では取消になり、実行は Tab で移るかマウスで押す）。
	 * 消すなど取り消せない操作の確認で使う。ボタンの並びと番号は変えない（macOS の Cmd+D が実行を押さないように）。
	 */
	readonly focusCancel?: boolean;
}

/** {@link openParadisConfirmDialog} の答え。 */
export interface IParadisConfirmDialogResult {
	/** 押した `buttons` の番号。取消・Esc・閉じる・token の取消では undefined。 */
	readonly index: number | undefined;
	/** チェックを出したときの、閉じた時点の状態（取消でも返す）。 */
	readonly checkboxChecked: boolean | undefined;
}

/** 確認のダイアログに要るサービス。 */
export interface IParadisConfirmServices {
	readonly layoutService: ILayoutService;
	readonly keybindingService: IKeybindingService;
	readonly hostService: IHostService;
}

/** ボタンの色は渡さない（inline の色が CSS に勝つため。paradisButton.css が描く）。 */
const PARADIS_CONFIRM_BUTTON_STYLES: IButtonStyles = {
	buttonBackground: undefined,
	buttonHoverBackground: undefined,
	buttonForeground: undefined,
	buttonSeparator: undefined,
	buttonSecondaryBackground: undefined,
	buttonSecondaryHoverBackground: undefined,
	buttonSecondaryForeground: undefined,
	buttonSecondaryBorder: undefined,
	buttonBorder: undefined,
};

/**
 * 確認のダイアログを出し、押したボタンの番号とチェックの状態を返す。`run` は呼ばない（呼ぶのは {@link paradisConfirm}）。
 */
export async function openParadisConfirmDialog<T>(services: IParadisConfirmServices, options: IParadisConfirmOptions<T>): Promise<IParadisConfirmDialogResult> {
	const ownCancel = options.cancelIndex === undefined;
	// allow-any-unicode-next-line
	const labels = [...options.buttons.map(button => button.label), ...(ownCancel ? [options.cancelLabel ?? localize('paradis.confirm.cancel', "キャンセル")] : [])];
	const cancelId = options.cancelIndex ?? labels.length - 1;
	const kinds: ParadisButtonKind[] = [...options.buttons.map((button, index) => button.kind ?? (index === 0 ? 'primary' : 'secondary')), ...(ownCancel ? ['secondary' as const] : [])];
	let cancelButton: IButton | undefined;
	const dialog = new Dialog(services.layoutService.activeContainer, options.message, labels, {
		...createWorkbenchDialogOptions({
			detail: options.detail,
			cancelId,
			type: 'none',
			extraClasses: [PARADIS_CONFIRM_DIALOG_CLASS, ...(options.extraClasses ?? [])],
			// 補足も本文も無いと、本家は問いを補足の行（小さい薄い字）に入れ、見出しを作らない。問いを見出しにするため空の本文を渡す
			renderBody: options.renderBody ?? (options.detail ? undefined : () => { }),
			checkboxLabel: options.checkbox?.label,
			checkboxChecked: options.checkbox?.checked,
			buttonOptions: kinds.map((kind, index) => ({
				styleButton: button => {
					button.element.classList.add(...paradisButtonClasses(kind));
					if (index === cancelId) {
						cancelButton = button;
					}
				}
			})),
		}, services.keybindingService, services.layoutService, services.hostService),
		buttonStyles: PARADIS_CONFIRM_BUTTON_STYLES,
		// 本家のチェックは色を inline で書くので、色は渡さない（paradisCheck.css が描く）
		checkboxStyles: PARADIS_CHECKBOX_STYLES,
		dialogStyles: {
			dialogForeground: asCssVariable('paradis.text'),
			dialogBackground: asCssVariable('paradis.overlay'),
			dialogShadow: undefined,
			dialogBorder: asCssVariable('paradis.lineSubtle'),
			errorIconForeground: asCssVariable('paradis.danger'),
			warningIconForeground: asCssVariable('paradis.warning'),
			infoIconForeground: asCssVariable('paradis.accent'),
			textLinkForeground: asCssVariable('textLink.foreground'),
		},
	});
	// 閉じると本家の Dialog は取消（cancelId）で答える
	const cancellation = options.token?.onCancellationRequested(() => dialog.dispose());
	try {
		// show() はボタンを作って 0 番にフォーカスを置くところまでを同期で済ませる
		const shown = dialog.show();
		const box = cancelButton?.element.closest<HTMLElement>('.monaco-dialog-box');
		if (box && options.checkbox) {
			paradisDecorateConfirmCheckbox(box);
		}
		if (options.focusCancel) {
			cancelButton?.focus();
		}
		const result = await shown;
		const cancelled = result.button === cancelId || !!options.token?.isCancellationRequested;
		return { index: cancelled ? undefined : result.button, checkboxChecked: result.checkboxChecked };
	} finally {
		cancellation?.dispose();
		dialog.dispose();
	}
}

/**
 * 本家の Dialog のチェックの行に、キットのチェック（paradisCheck.css）とフォーカスの枠のクラスを付ける。
 * 本家の Dialog は行を外に出さないので、行だけを探す。行の中は「箱（Checkbox の domNode）、文字」の順（dialog.ts の Checkbox）。
 */
function paradisDecorateConfirmCheckbox(box: HTMLElement): void {
	// eslint-disable-next-line no-restricted-syntax
	const row = box.querySelector('.dialog-checkbox-row');
	row?.classList.add('paradis-check');
	row?.firstElementChild?.classList.add('paradis-focus-ring');
	row?.lastElementChild?.classList.add('paradis-check-label');
}

/**
 * 確認のダイアログを出し、押したボタンの `run` の結果を返す。取消・Esc・閉じるでは undefined。
 */
export async function paradisConfirm<T>(services: IParadisConfirmServices, options: IParadisConfirmOptions<T>): Promise<T | undefined> {
	const { index } = await openParadisConfirmDialog(services, options);
	return index === undefined ? undefined : options.buttons[index]?.run();
}

/** はい/いいえの確認。押したら true。 */
export async function paradisConfirmYesNo(services: IParadisConfirmServices, options: { readonly message: string; readonly detail?: string; readonly primaryButton: string; readonly cancelLabel?: string; readonly danger?: boolean }): Promise<boolean> {
	const result = await paradisConfirm(services, {
		message: options.message,
		detail: options.detail,
		buttons: [{ label: options.primaryButton, kind: options.danger ? 'danger' : 'primary', run: () => true }],
		cancelLabel: options.cancelLabel,
	});
	return result === true;
}
