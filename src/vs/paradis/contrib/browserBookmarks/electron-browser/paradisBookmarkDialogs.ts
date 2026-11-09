/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブックマーク編集／フォルダ作成・編集のフォーム型DOMモーダル（Superset の
// EditBookmarkDialog / BookmarkFolderDialog 相当）。paradisBindingDialog.ts と同じく
// workbenchコンテナへ自前 backdrop+モーダルを重ねる方式。backdrop クラスは
// overlayManager の OVERLAY_DEFINITIONS に登録済みで、ネイティブ WebContentsView は
// ダイアログ表示中自動的に pause される。色は --vscode-* テーマトークンのみ使用。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { paradisModalClasses, ParadisModalSize } from '../../../browser/paradisModal.js';
import { ParadisSelect } from '../../../browser/paradisSelect.js';
import {
	IParadisFolderOption,
	PARADIS_FOLDER_COLOR_PRESETS,
	PARADIS_FOLDER_ICON_KEYS,
	paradisFolderIcon,
	ParadisFolderIconKey,
} from '../common/paradisBookmarkModel.js';

const $ = dom.$;

/** Values captured by the edit-bookmark dialog. */
export interface IParadisBookmarkDialogResult {
	readonly title: string;
	readonly url: string;
	/** `undefined` means the bar root. */
	readonly folderId: string | undefined;
}

export interface IParadisBookmarkDialogOptions {
	readonly dialogTitle: string;
	readonly initial: IParadisBookmarkDialogResult;
	readonly folderOptions: readonly IParadisFolderOption[];
	/** Return an error message to keep the dialog open, or `undefined` on success. */
	readonly onSubmit: (result: IParadisBookmarkDialogResult) => string | undefined;
}

/** Values captured by the folder dialog. */
export interface IParadisFolderDialogResult {
	readonly title: string;
	readonly icon: ParadisFolderIconKey;
	readonly color: string | undefined;
}

export interface IParadisFolderDialogOptions {
	readonly dialogTitle: string;
	readonly initial?: IParadisFolderDialogResult;
	readonly onSubmit: (result: IParadisFolderDialogResult) => void;
}

/**
 * Shared modal shell: backdrop + dialog chrome (header with close button,
 * body, footer with Cancel / primary buttons). One instance per open; the
 * dialog disposes itself on close.
 */
abstract class ParadisBookmarkModal extends Disposable {

	private readonly _backdrop: HTMLElement;
	protected readonly body: HTMLElement;

	constructor(
		dialogTitle: string,
		submitLabel: string,
		layoutService: ILayoutService,
	) {
		super();

		this._backdrop = $('.paradis-bookmark-dialog-backdrop');
		const modal = $('.paradis-bookmark-dialog');
		// 箱は共通の S 段（Q537 の 7 章「ブックマーク」、案 A）
		modal.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		this._backdrop.appendChild(modal);

		const header = dom.append(modal, $('.pbm-header'));
		dom.append(header, $('h2')).textContent = dialogTitle;
		const closeButton = dom.append(header, $('.pbm-close'));
		closeButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		closeButton.setAttribute('role', 'button');
		closeButton.setAttribute('aria-label', localize('paradis.bookmarks.dialog.close', "閉じる"));
		this._register(dom.addDisposableListener(closeButton, 'click', () => this.close()));

		this.body = dom.append(modal, $('.pbm-body'));

		const footer = dom.append(modal, $('.pbm-footer'));
		const cancelButton = this._register(new Button(footer, { ...defaultButtonStyles, secondary: true }));
		cancelButton.label = localize('paradis.bookmarks.dialog.cancel', "キャンセル");
		this._register(cancelButton.onDidClick(() => this.close()));
		const submitButton = this._register(new Button(footer, { ...defaultButtonStyles }));
		submitButton.label = submitLabel;
		this._register(submitButton.onDidClick(() => this.submit()));

		modal.tabIndex = -1;
		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.close();
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape) {
				event.preventDefault();
				this.close();
			} else if (event.keyCode === KeyCode.Enter && !dom.isHTMLButtonElement(e.target) && !(dom.isHTMLElement(e.target) && e.target.classList.contains('monaco-button'))) {
				// ボタン（本家の Button を含む）の上の Enter はそのボタンに任せる
				event.preventDefault();
				this.submit();
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
	}

	protected abstract submit(): void;

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}

	protected appendField(labelText: string): HTMLElement {
		const field = dom.append(this.body, $('.pbm-field'));
		dom.append(field, $('label.pbm-label')).textContent = labelText;
		return field;
	}

	protected appendTextInput(labelText: string, value: string, placeholder?: string): HTMLInputElement {
		const field = this.appendField(labelText);
		const input = dom.append(field, $('input.pbm-input')) as HTMLInputElement;
		input.type = 'text';
		input.value = value;
		if (placeholder) {
			input.placeholder = placeholder;
		}
		input.setAttribute('aria-label', labelText);
		return input;
	}
}

/**
 * Edit dialog for a single bookmark: name, URL, and containing folder
 * (Superset `EditBookmarkDialog` equivalent).
 */
export class ParadisEditBookmarkDialog extends ParadisBookmarkModal {

	private readonly _nameInput: HTMLInputElement;
	private readonly _urlInput: HTMLInputElement;
	private readonly _folderSelect: ParadisSelect;
	private readonly _errorElement: HTMLElement;

	constructor(
		private readonly options: IParadisBookmarkDialogOptions,
		@ILayoutService layoutService: ILayoutService,
		@IContextViewService contextViewService: IContextViewService,
	) {
		super(options.dialogTitle, localize('paradis.bookmarks.dialog.save', "保存"), layoutService);

		this._nameInput = this.appendTextInput(localize('paradis.bookmarks.dialog.name', "名前"), options.initial.title);
		this._urlInput = this.appendTextInput(localize('paradis.bookmarks.dialog.url', "URL"), options.initial.url, 'https://example.com');

		const folderLabel = localize('paradis.bookmarks.dialog.folder', "フォルダ");
		const folderField = this.appendField(folderLabel);
		this._folderSelect = this._register(new ParadisSelect(folderField, contextViewService, [
			{ value: '', label: localize('paradis.bookmarks.dialog.rootFolder', "ブックマークバー") },
			...options.folderOptions.map(folder => ({ value: folder.id, label: folder.label })),
		], options.initial.folderId ?? '', { ariaLabel: folderLabel, className: 'pbm-select' }));

		this._errorElement = dom.append(this.body, $('.pbm-error'));
		this._errorElement.style.display = 'none';

		this._nameInput.focus();
		this._nameInput.select();
	}

	protected override submit(): void {
		const error = this.options.onSubmit({
			title: this._nameInput.value,
			url: this._urlInput.value,
			folderId: this._folderSelect.value || undefined,
		});
		if (error) {
			this._errorElement.textContent = error;
			this._errorElement.style.display = '';
			return;
		}
		this.close();
	}
}

/** フォルダの色の読み上げ名（既定の 8 色。それ以外は値のまま）。 */
function folderColorLabel(color: string): string {
	switch (color) {
		case '#64748b': return localize('paradis.bookmarks.color.slate', "灰青");
		case '#2563eb': return localize('paradis.bookmarks.color.blue', "青");
		case '#0891b2': return localize('paradis.bookmarks.color.cyan', "水色");
		case '#16a34a': return localize('paradis.bookmarks.color.green', "緑");
		case '#d97706': return localize('paradis.bookmarks.color.amber', "橙");
		case '#e11d48': return localize('paradis.bookmarks.color.rose', "赤");
		case '#7c3aed': return localize('paradis.bookmarks.color.violet', "紫");
		case '#6b7280': return localize('paradis.bookmarks.color.gray', "灰色");
		default: return color;
	}
}

function folderIconLabel(key: ParadisFolderIconKey): string {
	switch (key) {
		case 'folder': return localize('paradis.bookmarks.icon.folder', "フォルダ");
		case 'star': return localize('paradis.bookmarks.icon.star', "星");
		case 'globe': return localize('paradis.bookmarks.icon.globe', "地球");
		case 'code': return localize('paradis.bookmarks.icon.code', "コード");
		case 'briefcase': return localize('paradis.bookmarks.icon.briefcase', "ブリーフケース");
		case 'image': return localize('paradis.bookmarks.icon.image', "画像");
		case 'heart': return localize('paradis.bookmarks.icon.heart', "ハート");
		case 'book': return localize('paradis.bookmarks.icon.book', "本");
		case 'file': return localize('paradis.bookmarks.icon.file', "ファイル");
	}
}

/**
 * Create/edit dialog for a folder: name, one of nine icons, and an optional
 * color (eight presets plus a custom color picker; Superset
 * `BookmarkFolderDialog` equivalent).
 */
export class ParadisFolderDialog extends ParadisBookmarkModal {

	private readonly _nameInput: HTMLInputElement;
	private readonly _iconButtons = new Map<ParadisFolderIconKey, HTMLButtonElement>();
	private readonly _swatches = new Map<string, HTMLButtonElement>();
	private readonly _customColorInput: HTMLInputElement;
	private readonly _resetButton: HTMLButtonElement;

	private _selectedIcon: ParadisFolderIconKey;
	private _selectedColor: string | undefined;

	constructor(
		private readonly options: IParadisFolderDialogOptions,
		@ILayoutService layoutService: ILayoutService,
	) {
		super(options.dialogTitle, localize('paradis.bookmarks.dialog.save', "保存"), layoutService);

		this._selectedIcon = options.initial?.icon ?? 'folder';
		this._selectedColor = options.initial?.color;

		this._nameInput = this.appendTextInput(
			localize('paradis.bookmarks.dialog.folderName', "フォルダ名"),
			options.initial?.title ?? '',
			localize('paradis.bookmarks.dialog.folderNamePlaceholder', "無題のフォルダ")
		);

		// --- icon grid ---
		const iconField = this.appendField(localize('paradis.bookmarks.dialog.icon', "アイコン"));
		const iconGrid = dom.append(iconField, $('.pbm-icon-grid'));
		for (const key of PARADIS_FOLDER_ICON_KEYS) {
			// 本物のボタン（Tab で止まり Enter・Space で選べる）。選んだかは aria-pressed で伝える
			const button = dom.append(iconGrid, $<HTMLButtonElement>('button.pbm-icon-option'));
			button.type = 'button';
			button.appendChild($(`span${ThemeIcon.asCSSSelector(paradisFolderIcon(key))}`));
			button.setAttribute('aria-label', folderIconLabel(key));
			button.title = folderIconLabel(key);
			this._register(dom.addDisposableListener(button, 'click', () => {
				this._selectedIcon = key;
				this._refresh();
			}));
			this._iconButtons.set(key, button);
		}

		// --- color presets + custom picker ---
		const colorField = this.appendField(localize('paradis.bookmarks.dialog.color', "色"));
		const colorRow = dom.append(colorField, $('.pbm-color-row'));
		for (const color of PARADIS_FOLDER_COLOR_PRESETS) {
			const swatch = dom.append(colorRow, $<HTMLButtonElement>('button.pbm-color-swatch'));
			swatch.type = 'button';
			// 色は 22px の押しボタンの中の 12px の丸で見せる
			dom.append(swatch, $('span.pbm-color-dot')).style.backgroundColor = color;
			swatch.setAttribute('aria-label', folderColorLabel(color));
			this._register(dom.addDisposableListener(swatch, 'click', () => {
				this._selectedColor = color;
				this._refresh();
			}));
			this._swatches.set(color, swatch);
		}
		this._customColorInput = dom.append(colorRow, $('input.pbm-color-custom')) as HTMLInputElement;
		this._customColorInput.type = 'color';
		this._customColorInput.title = localize('paradis.bookmarks.dialog.customColor', "カスタムカラー");
		this._register(dom.addDisposableListener(this._customColorInput, 'input', () => {
			this._selectedColor = this._customColorInput.value;
			this._refresh();
		}));
		this._resetButton = dom.append(colorRow, $('button.pbm-color-reset')) as HTMLButtonElement;
		this._resetButton.type = 'button';
		this._resetButton.textContent = localize('paradis.bookmarks.dialog.resetColor', "リセット");
		this._register(dom.addDisposableListener(this._resetButton, 'click', () => {
			this._selectedColor = undefined;
			this._refresh();
		}));

		this._refresh();
		this._nameInput.focus();
		this._nameInput.select();
	}

	private _refresh(): void {
		for (const [key, button] of this._iconButtons) {
			const selected = key === this._selectedIcon;
			button.classList.toggle('selected', selected);
			button.setAttribute('aria-pressed', String(selected));
			button.style.color = selected && this._selectedColor ? this._selectedColor : '';
		}
		for (const [color, swatch] of this._swatches) {
			swatch.classList.toggle('selected', color === this._selectedColor);
			swatch.setAttribute('aria-pressed', String(color === this._selectedColor));
		}
		if (this._selectedColor) {
			this._customColorInput.value = this._selectedColor;
		}
		this._resetButton.style.visibility = this._selectedColor ? '' : 'hidden';
	}

	protected override submit(): void {
		this.options.onSubmit({
			title: this._nameInput.value,
			icon: this._selectedIcon,
			color: this._selectedColor,
		});
		this.close();
	}
}
