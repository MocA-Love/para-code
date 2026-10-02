/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の片側の操作（「操作」メニュー・右クリック・キー）。開く・反対側へコピー・名前の変更・
// 削除・新しいフォルダー・隠しファイル・すべて選択・権限の変更・閉じる。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { IMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { decodeKeybinding } from '../../../../base/common/keybindings.js';
import { isMacintosh, OS } from '../../../../base/common/platform.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ParadisTransferSide } from '../common/paradisFileTransfer.js';
import { IParadisPaneEntry, paradisCanChangePermissions } from '../common/paradisFileTransferListing.js';
import { paradisClassifyTransferError, paradisIsTransferTempName } from '../common/paradisFileTransferQueue.js';
import { paradisTypeCharOf } from './paradisFileTransferPaneTable.js';
import { paradisShowPermissionsDialog } from './paradisFileTransferPermissionsDialog.js';
import { IParadisFileTransferService } from './paradisFileTransferService.js';

/** 操作が読む片側の状態と、片側にさせること。 */
export interface IParadisPaneOperationsContext {
	readonly side: ParadisTransferSide;
	readonly location: URI | undefined;
	readonly allEntries: readonly IParadisPaneEntry[];
	readonly visibleEntries: readonly IParadisPaneEntry[];
	/** 権限のチャネルを持つ相手か。 */
	readonly modes: boolean;
	readonly showHidden: boolean;
	/** 一覧を読めているか（読めないフォルダーでは新しいフォルダーを作らせない）。 */
	readonly listed: boolean;
	selection(): IParadisPaneEntry[];
	navigate(resource: URI): Promise<void>;
	refresh(): Promise<void>;
	goUp(): Promise<void>;
	goBack(): Promise<void>;
	goForward(): Promise<void>;
	toggleHidden(): void;
	selectAll(): void;
	focusTable(): void;
	focusFilter(): void;
	/** 反対側が受けられるか。 */
	canCopyToOtherSide(): boolean;
	copyToOtherSide(entries: readonly IParadisPaneEntry[]): Promise<void>;
	closeEditor(): void;
}

/** メニューの右に出す近道（このタブの中だけで効く）。 */
const SHORTCUTS: Record<string, number> = {
	'paradis.fileTransfer.open': KeyMod.CtrlCmd | KeyCode.DownArrow,
	'paradis.fileTransfer.copy': KeyCode.F5,
	'paradis.fileTransfer.rename': KeyCode.F2,
	'paradis.fileTransfer.delete': isMacintosh ? KeyMod.CtrlCmd | KeyCode.Backspace : KeyCode.Delete,
	'paradis.fileTransfer.refresh': KeyMod.CtrlCmd | KeyCode.KeyR,
	'paradis.fileTransfer.newFolder': KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyN,
	'paradis.fileTransfer.toggleHidden': KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Period,
	'paradis.fileTransfer.selectAll': KeyMod.CtrlCmd | KeyCode.KeyA,
};

export class ParadisFileTransferPaneOperations {

	constructor(
		private readonly context: IParadisPaneOperationsContext,
		@IParadisFileTransferService private readonly transferService: IParadisFileTransferService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) { }

	// --- メニュー ------------------------------------------------------------------------------------

	showMenu(anchor: HTMLElement | IMouseEvent): void {
		const actions = this.buildActions();
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			getKeyBinding: action => {
				const code = SHORTCUTS[action.id];
				const keybinding = code !== undefined ? decodeKeybinding(code, OS) : null;
				return keybinding ? this.keybindingService.resolveKeybinding(keybinding)[0] : undefined;
			},
			onHide: () => this.context.focusTable(),
		});
	}

	private buildActions(): IAction[] {
		const context = this.context;
		const selection = context.selection();
		const otherLabel = this.transferService.sideLabel(context.side === 'local' ? 'remote' : 'local');
		const has = selection.length > 0;
		return [
			toAction({ id: 'paradis.fileTransfer.open', label: localize('paradis.fileTransfer.menu.open', "開く"), enabled: has, run: () => this.openEntries(selection) }),
			toAction({ id: 'paradis.fileTransfer.copy', label: localize('paradis.fileTransfer.menu.copy', "{0} へコピー（反対側）", otherLabel), enabled: has && context.canCopyToOtherSide(), run: () => context.copyToOtherSide(selection) }),
			new Separator(),
			toAction({ id: 'paradis.fileTransfer.rename', label: localize('paradis.fileTransfer.menu.rename', "名前の変更"), enabled: selection.length === 1, run: () => this.renameEntry(selection[0]) }),
			toAction({ id: 'paradis.fileTransfer.delete', label: localize('paradis.fileTransfer.menu.delete', "削除"), enabled: has, run: () => this.deleteEntries(selection) }),
			// 転送が途中で止まって残った一時ファイル（一覧では「書きかけ」）だけを消す
			...(context.visibleEntries.some(entry => paradisIsTransferTempName(entry.name)) ? [
				toAction({ id: 'paradis.fileTransfer.deletePartial', label: localize('paradis.fileTransfer.menu.deletePartial', "書きかけのファイルを削除"), run: () => this.deleteEntries(context.visibleEntries.filter(entry => paradisIsTransferTempName(entry.name))) }),
			] : []),
			new Separator(),
			toAction({ id: 'paradis.fileTransfer.refresh', label: localize('paradis.fileTransfer.menu.refresh', "再読み込み"), run: () => context.refresh() }),
			toAction({ id: 'paradis.fileTransfer.newFolder', label: localize('paradis.fileTransfer.menu.newFolder', "新しいフォルダー"), enabled: !!context.location && context.listed, run: () => this.newFolder() }),
			toAction({ id: 'paradis.fileTransfer.toggleHidden', label: localize('paradis.fileTransfer.menu.hidden', "隠しファイルを表示"), checked: context.showHidden, run: () => context.toggleHidden() }),
			toAction({ id: 'paradis.fileTransfer.selectAll', label: localize('paradis.fileTransfer.menu.selectAll', "すべて選択"), enabled: context.visibleEntries.length > 0, run: () => context.selectAll() }),
			// 権限は、権限のチャネルを持つ相手（手元・新しい REH）のときだけ出す。リンクの行では選べない
			...(context.modes ? [
				new Separator(),
				toAction({ id: 'paradis.fileTransfer.permissions', label: localize('paradis.fileTransfer.menu.permissions', "権限の変更…"), enabled: paradisCanChangePermissions(selection, context.modes), run: () => this.changePermissions(selection) }),
			] : []),
			new Separator(),
			toAction({ id: 'paradis.fileTransfer.close', label: localize('paradis.fileTransfer.menu.close', "閉じる"), run: () => context.closeEditor() }),
		];
	}

	/** タブの中のキー。処理したら true（呼ぶ側がワークベンチの既定の割り当てへ流さない）。 */
	handleKey(e: KeyboardEvent): boolean {
		const event = new StandardKeyboardEvent(e);
		const context = this.context;
		const selection = context.selection();
		const run = (handler: () => unknown) => {
			event.preventDefault();
			event.stopPropagation();
			void handler();
			return true;
		};
		const deleteKey = isMacintosh ? event.equals(KeyMod.CtrlCmd | KeyCode.Backspace) : event.equals(KeyCode.Delete);
		if (event.equals(KeyCode.F5)) {
			return run(() => context.copyToOtherSide(selection));
		} else if (event.equals(KeyCode.F2) && selection.length === 1) {
			return run(() => this.renameEntry(selection[0]));
		} else if (deleteKey && selection.length) {
			return run(() => this.deleteEntries(selection));
		} else if (event.equals(KeyMod.CtrlCmd | KeyCode.KeyR)) {
			return run(() => context.refresh());
		} else if (event.equals(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyN)) {
			return run(() => this.newFolder());
		} else if (event.equals(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Period)) {
			return run(() => context.toggleHidden());
		} else if (event.equals(KeyMod.CtrlCmd | KeyCode.KeyA)) {
			return run(() => context.selectAll());
		} else if (event.equals(KeyMod.CtrlCmd | KeyCode.DownArrow) && selection.length) {
			return run(() => this.openEntries(selection));
		} else if (event.equals(KeyMod.CtrlCmd | KeyCode.UpArrow) || event.equals(KeyMod.Alt | KeyCode.UpArrow) || (event.equals(KeyCode.Backspace) && !isMacintosh)) {
			return run(() => context.goUp());
		} else if (event.equals(KeyMod.Alt | KeyCode.LeftArrow)) {
			return run(() => context.goBack());
		} else if (event.equals(KeyMod.Alt | KeyCode.RightArrow)) {
			return run(() => context.goForward());
		} else if (event.equals(KeyMod.CtrlCmd | KeyCode.KeyF)) {
			return run(() => context.focusFilter());
		}
		return false;
	}

	// --- 操作 --------------------------------------------------------------------------------------

	async openEntries(entries: readonly IParadisPaneEntry[]): Promise<void> {
		if (entries.length === 1 && entries[0].isDirectory) {
			await this.context.navigate(entries[0].resource);
			return;
		}
		for (const entry of entries.filter(candidate => !candidate.isDirectory)) {
			await this.editorService.openEditor({ resource: entry.resource, options: { pinned: entries.length > 1 } }).catch(error => this.notificationService.error(error));
		}
	}

	private async renameEntry(entry: IParadisPaneEntry): Promise<void> {
		const dot = entry.isDirectory ? -1 : entry.name.indexOf('.', 1);
		const name = await this.quickInputService.input({
			title: localize('paradis.fileTransfer.renameTitle', "名前の変更"),
			value: entry.name,
			valueSelection: [0, dot > 0 ? dot : entry.name.length],
			validateInput: async value => this.validateName(value, entry.name),
		});
		if (!name || name === entry.name) {
			return;
		}
		try {
			await this.fileService.move(entry.resource, joinPath(dirname(entry.resource), name), false);
		} catch (error) {
			this.notificationService.error(error);
		}
		await this.context.refresh();
	}

	private async newFolder(): Promise<void> {
		const location = this.context.location;
		if (!location) {
			return;
		}
		const name = await this.quickInputService.input({
			title: localize('paradis.fileTransfer.newFolderTitle', "新しいフォルダー"),
			placeHolder: localize('paradis.fileTransfer.newFolderPlaceholder', "フォルダーの名前"),
			validateInput: async value => this.validateName(value, undefined),
		});
		if (!name) {
			return;
		}
		try {
			await this.fileService.createFolder(joinPath(location, name));
		} catch (error) {
			this.notificationService.error(error);
		}
		await this.context.refresh();
	}

	private validateName(value: string, current: string | undefined): string | undefined {
		const trimmed = value.trim();
		if (!trimmed) {
			return localize('paradis.fileTransfer.nameEmpty', "名前を入力してください");
		}
		if (/[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
			return localize('paradis.fileTransfer.nameInvalid', "この名前は使えません");
		}
		if (trimmed !== current && this.context.allEntries.some(entry => entry.name === trimmed)) {
			return localize('paradis.fileTransfer.nameExists', "同じ名前の項目があります");
		}
		return undefined;
	}

	private async deleteEntries(entries: readonly IParadisPaneEntry[]): Promise<void> {
		if (!entries.length) {
			return;
		}
		// ゴミ箱は手元だけ。接続先にはゴミ箱が無いので、元に戻せないことをはっきり書いて確かめる
		const useTrash = this.context.side === 'local' && this.fileService.hasCapability(entries[0].resource, FileSystemProviderCapabilities.Trash);
		const names = entries.map(entry => entry.name);
		const message = useTrash
			? (entries.length === 1
				? localize('paradis.fileTransfer.trashOne', "{0} をゴミ箱へ移動しますか?", names[0])
				: localize('paradis.fileTransfer.trashMany', "{0} 項目をゴミ箱へ移動しますか?", entries.length))
			: (entries.length === 1
				? localize('paradis.fileTransfer.deleteOne', "{0} を完全に削除しますか?", names[0])
				: localize('paradis.fileTransfer.deleteMany', "{0} 項目を完全に削除しますか?", entries.length));
		const { confirmed } = await this.dialogService.confirm({
			type: useTrash ? 'question' : 'warning',
			message,
			detail: names.slice(0, 10).join('\n') + (names.length > 10 ? '\n…' : '') + (useTrash ? '' : '\n\n' + localize('paradis.fileTransfer.deleteIrreversible', "{0} にはゴミ箱がありません。この操作は元に戻せません。", this.transferService.sideLabel(this.context.side))),
			primaryButton: useTrash ? localize('paradis.fileTransfer.trashButton', "ゴミ箱へ移動") : localize('paradis.fileTransfer.deleteButton', "削除"),
		});
		if (!confirmed) {
			return;
		}
		const failed: string[] = [];
		let firstError: unknown;
		for (const entry of entries) {
			try {
				await this.fileService.del(entry.resource, { recursive: true, useTrash });
			} catch (error) {
				failed.push(entry.name);
				firstError ??= error;
			}
		}
		if (failed.length === entries.length && firstError !== undefined) {
			this.notificationService.error(firstError instanceof Error ? firstError : String(firstError));
		} else if (failed.length) {
			this.notificationService.warn(localize('paradis.fileTransfer.deleteSomeFailed', "{0} 件を削除できませんでした（{1}）", failed.length, failed.join(', ')));
		}
		await this.context.refresh();
	}

	private async changePermissions(entries: readonly IParadisPaneEntry[]): Promise<void> {
		const first = entries[0];
		if (!first || first.mode === undefined || !paradisCanChangePermissions(entries, this.context.modes)) {
			return;
		}
		const location = this.context.side === 'remote'
			? `${this.transferService.remoteLabel}:${first.resource.path}`
			: first.resource.fsPath;
		const result = await paradisShowPermissionsDialog(this.layoutService.activeContainer, {
			title: entries.length === 1 ? first.name : localize('paradis.fileTransfer.permissionsMany', "{0} 項目", entries.length),
			location: entries.length === 1 ? location : `${location} …`,
			initialMode: first.mode,
			typeChar: paradisTypeCharOf(first),
			hasDirectory: entries.some(entry => entry.kind === 'directory'),
		});
		if (!result) {
			return;
		}
		const failed: string[] = [];
		let firstError: unknown;
		for (const entry of entries) {
			try {
				await this.transferService.chmod(this.context.side, entry.resource, result.mode, result.recursive && entry.kind === 'directory');
			} catch (error) {
				failed.push(entry.name);
				firstError ??= error;
			}
		}
		if (firstError !== undefined) {
			const kind = paradisClassifyTransferError(firstError);
			this.notificationService.error(kind === 'permission'
				? localize('paradis.fileTransfer.chmodPermission', "権限を変更できませんでした（{0}）: 所有者ではないか、権限がありません", failed.join(', '))
				: firstError instanceof Error ? firstError : String(firstError));
		}
		await this.context.refresh();
	}
}

/** 絞り込みの欄の中のキー。Esc で欄を空にし、下矢印で表へ移る。処理したら true。 */
export function paradisHandleFilterKey(e: KeyboardEvent, filter: { value: string; readonly element: HTMLElement }, focusTable: (first: boolean) => void): boolean {
	if (!dom.isAncestor(e.target as Node, filter.element)) {
		return false;
	}
	const event = new StandardKeyboardEvent(e);
	if (event.keyCode === KeyCode.Escape && filter.value) {
		filter.value = '';
		focusTable(false);
		event.preventDefault();
		event.stopPropagation();
	} else if (event.keyCode === KeyCode.DownArrow) {
		focusTable(true);
		event.preventDefault();
	}
	// 欄の中では文字の入力を優先し、表の近道は効かせない
	return true;
}
