/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポートパネルの「…」から開く、表のあるダイアログ（設計 6〜8 章のモック）。動いていない転送を外す・番号を揃えて張り直すでは
// 行のチェックで選び、CSV の取り込みでは行ごとの判定を見せる。箱は共通の S 段（paradisModal.ts）で、見出しの帯・本文・
// 下端の帯は「残したブランチを確かめる」のダイアログ（paradisWorktreeBranchCleanup.ts）と同じ作り。

import './media/paradisPortTableDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ParadisModalSize, paradisModalClasses } from '../../../browser/paradisModal.js';

const $ = dom.$;

/** 判定の列の色の種類。 */
export type ParadisPortDialogTone = 'warn' | 'new' | 'error' | 'dim';

export interface IParadisPortDialogRow {
	readonly cells: readonly string[];
	/** 最後のセル（判定・状態）の色。 */
	readonly tone?: ParadisPortDialogTone;
	/** チェックの初期値（チェックの無い表では使わない）。 */
	readonly checked?: boolean;
	/** チェックできない行（手元で使用中など）。 */
	readonly disabled?: boolean;
}

export interface IParadisPortDialogOptions {
	readonly title: string;
	readonly description?: string;
	readonly columns: readonly string[];
	readonly rows: readonly IParadisPortDialogRow[];
	/** 行の先頭にチェックを置くか。 */
	readonly checkable: boolean;
	/** 表の下に出す注意（同じ SSH 先の別の窓など）。 */
	readonly note?: string;
	/** 表の下のチェック 1 つ（「番号が違うものを揃えて張り直す」など）。 */
	readonly option?: { readonly label: string; readonly checked: boolean };
	/** 実行のボタンの文言（選んだ数と、下のチェックの状態から）。 */
	primaryLabel(selected: number, option: boolean): string;
	/** 実行できるか。既定は「選んだものが 1 つ以上」（チェックの無い表では常に押せる）。 */
	primaryEnabled?(selected: number, option: boolean): boolean;
	/** 取り消せない操作なら、実行のボタンを危険の色にする。 */
	readonly danger?: boolean;
}

export interface IParadisPortDialogResult {
	/** 選んだ行の番号（`rows` の添字）。 */
	readonly selected: readonly number[];
	readonly option: boolean;
}

/** 表のダイアログを開き、実行が押されたら選んだ行を返す。閉じたら undefined。 */
export function paradisShowPortTableDialog(layoutService: ILayoutService, options: IParadisPortDialogOptions): Promise<IParadisPortDialogResult | undefined> {
	return new Promise(resolve => {
		const dialog = new ParadisPortTableDialog(layoutService, options, resolve);
		dialog.open();
	});
}

class ParadisPortTableDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _selected = new Set<number>();
	private readonly _checks: HTMLInputElement[] = [];
	private _all: HTMLInputElement | undefined;
	private _count: HTMLElement | undefined;
	private _option: HTMLInputElement | undefined;
	private _primary!: Button;
	private _settled = false;

	constructor(
		private readonly layoutService: ILayoutService,
		private readonly options: IParadisPortDialogOptions,
		private readonly resolve: (result: IParadisPortDialogResult | undefined) => void,
	) {
		super();
		// `paradis-modal-backdrop` は、内蔵ブラウザのページがこのダイアログより前に出ないための共通の印（overlayManager.ts）
		this._backdrop = $('.paradis-port-dialog-backdrop.paradis-modal-backdrop');
		const dialog = dom.append(this._backdrop, $('.paradis-port-dialog'));
		dialog.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this._finish(undefined);
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this._finish(undefined);
			}
		}));
		options.rows.forEach((row, index) => {
			if (options.checkable && row.checked && !row.disabled) {
				this._selected.add(index);
			}
		});
		this._render(dialog);
	}

	open(): void {
		this.layoutService.activeContainer.appendChild(this._backdrop);
		(this._all ?? this._primary.element).focus();
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}

	private _finish(result: IParadisPortDialogResult | undefined): void {
		if (this._settled) {
			return;
		}
		this._settled = true;
		this.resolve(result);
		this.dispose();
	}

	private _render(dialog: HTMLElement): void {
		const { options } = this;
		const header = dom.append(dialog, $('.ppd-header'));
		const title = dom.append(header, $('h3.ppd-title'));
		title.textContent = options.title;
		title.id = 'paradis-port-dialog-title';
		dialog.setAttribute('aria-labelledby', title.id);
		const closeBar = this._register(new ActionBar(dom.append(header, $('.ppd-header-actions'))));
		closeBar.push(toAction({ id: 'paradis.portDialog.close', label: localize('paradis.portDialog.close', "閉じる"), class: ThemeIcon.asClassName(Codicon.close), run: () => this._finish(undefined) }), { icon: true, label: false });

		const body = dom.append(dialog, $('.ppd-body'));
		if (options.description) {
			dom.append(body, $('.ppd-description')).textContent = options.description;
		}
		const box = dom.append(body, $('.ppd-box'));
		if (options.checkable) {
			const head = dom.append(box, $('label.ppd-head'));
			this._all = dom.append(head, $('input.ppd-check')) as HTMLInputElement;
			this._all.type = 'checkbox';
			dom.append(head, $('span')).textContent = localize('paradis.portDialog.selectAll', "すべて選ぶ");
			this._count = dom.append(head, $('span.ppd-count'));
			this._register(dom.addDisposableListener(this._all, 'change', () => {
				this._selected.clear();
				options.rows.forEach((row, index) => {
					if (this._all!.checked && !row.disabled) {
						this._selected.add(index);
					}
				});
				this._checks.forEach((check, index) => check.checked = this._selected.has(index));
				this._update();
			}));
		}
		const scroller = dom.append(box, $('.ppd-scroll'));
		const table = dom.append(scroller, $('table.ppd-table'));
		const headRow = dom.append(dom.append(table, $('thead')), $('tr'));
		if (options.checkable) {
			dom.append(headRow, $('th.ppd-check-cell'));
		}
		for (const column of options.columns) {
			dom.append(headRow, $('th')).textContent = column;
		}
		const tbody = dom.append(table, $('tbody'));
		const rowStore = this._register(new DisposableStore());
		options.rows.forEach((row, index) => {
			const tr = dom.append(tbody, $('tr'));
			if (row.disabled) {
				tr.classList.add('ppd-disabled');
			}
			if (options.checkable) {
				const check = dom.append(dom.append(tr, $('td.ppd-check-cell')), $('input.ppd-check')) as HTMLInputElement;
				check.type = 'checkbox';
				check.checked = this._selected.has(index);
				check.disabled = row.disabled === true;
				check.setAttribute('aria-label', row.cells.join(' '));
				this._checks.push(check);
				rowStore.add(dom.addDisposableListener(check, 'change', () => {
					if (check.checked) {
						this._selected.add(index);
					} else {
						this._selected.delete(index);
					}
					this._update();
				}));
			}
			row.cells.forEach((text, cellIndex) => {
				const td = dom.append(tr, $('td'));
				td.textContent = text;
				if (cellIndex === row.cells.length - 1 && row.tone) {
					td.classList.add(`ppd-tone-${row.tone}`);
				}
			});
		});
		if (options.option) {
			const label = dom.append(body, $('label.ppd-option'));
			this._option = dom.append(label, $('input.ppd-check')) as HTMLInputElement;
			this._option.type = 'checkbox';
			this._option.checked = options.option.checked;
			dom.append(label, $('span')).textContent = options.option.label;
			this._register(dom.addDisposableListener(this._option, 'change', () => this._update()));
		}
		if (options.note) {
			dom.append(body, $('.ppd-note')).textContent = options.note;
		}

		const footer = dom.append(dialog, $('.ppd-footer'));
		const cancel = this._register(new Button(footer, { ...defaultButtonStyles, secondary: true }));
		cancel.label = localize('paradis.portDialog.cancel', "キャンセル");
		this._register(cancel.onDidClick(() => this._finish(undefined)));
		this._primary = this._register(new Button(footer, options.danger ? {
			...defaultButtonStyles,
			buttonBackground: 'var(--vscode-statusBarItem-errorBackground)',
			buttonHoverBackground: 'var(--vscode-statusBarItem-errorHoverBackground, var(--vscode-statusBarItem-errorBackground))',
			buttonForeground: 'var(--vscode-statusBarItem-errorForeground)',
		} : defaultButtonStyles));
		this._register(this._primary.onDidClick(() => {
			if (this._primary.enabled) {
				this._finish({ selected: [...this._selected].sort((a, b) => a - b), option: this._option?.checked ?? false });
			}
		}));
		this._update();
	}

	private _update(): void {
		const { options } = this;
		const count = this._selected.size;
		const option = this._option?.checked ?? false;
		if (this._all && this._count) {
			const selectable = options.rows.filter(row => !row.disabled).length;
			this._all.checked = count > 0 && count === selectable;
			this._all.indeterminate = count > 0 && count < selectable;
			this._count.textContent = localize('paradis.portDialog.selectedCount', "{0} / {1} 件を選択", count, options.rows.length);
		}
		this._primary.label = options.primaryLabel(count, option);
		this._primary.enabled = options.primaryEnabled ? options.primaryEnabled(count, option) : (!options.checkable || count > 0);
	}
}
