/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// テーマの色エディタの EditorInput。タブは 1 つだけ（Singleton）。下書きはウィンドウに 1 つの
// IParadisThemeColorDraftService が持ち、この input は「未保存か」「保存」「破棄」「閉じる確認」を橋渡しする。

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfirmResult, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput, IEditorCloseHandler } from '../../../../workbench/common/editor/editorInput.js';
import { IWorkbenchThemeService } from '../../../../workbench/services/themes/common/workbenchThemeService.js';
import { IParadisThemeColorDraftService } from './paradisThemeColorDraftService.js';

export const PARADIS_THEME_COLOR_EDITOR_ID = 'paradis.editor.themeColorEditor';
export const PARADIS_THEME_COLOR_INPUT_TYPE_ID = 'paradis.input.themeColorEditor';

/** エディタを開いたときに見せるもの。 */
export type ParadisThemeColorRevealTarget =
	| { readonly tab: 'ui'; readonly colorId?: string; readonly query?: string }
	| { readonly tab: 'syntax' };

export class ParadisThemeColorEditorInput extends EditorInput implements IEditorCloseHandler {

	static readonly ID = PARADIS_THEME_COLOR_INPUT_TYPE_ID;

	private static current: ParadisThemeColorEditorInput | undefined;

	/** 開いているタブの input があればそれを、無ければ新しく作る（同じタブに見せる場所を伝えるため）。 */
	static getOrCreate(instantiationService: IInstantiationService): ParadisThemeColorEditorInput {
		const current = ParadisThemeColorEditorInput.current;
		return current && !current.isDisposed() ? current : instantiationService.createInstance(ParadisThemeColorEditorInput);
	}

	readonly resource = URI.from({ scheme: 'paradis-theme-colors', path: '/editor' });

	override readonly closeHandler: IEditorCloseHandler = this;

	private readonly _onDidRequestReveal = this._register(new Emitter<void>());
	/** 見せる場所が届いたとき（EditorPane が {@link takePendingReveal} で受け取る）。 */
	readonly onDidRequestReveal: Event<void> = this._onDidRequestReveal.event;
	private pendingReveal: ParadisThemeColorRevealTarget | undefined;

	constructor(
		@IParadisThemeColorDraftService private readonly draftService: IParadisThemeColorDraftService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		ParadisThemeColorEditorInput.current = this;
		this._register(this.draftService.onDidChange(() => this._onDidChangeDirty.fire()));
		this._register(this.themeService.onDidColorThemeChange(() => this._onDidChangeLabel.fire()));
	}

	override dispose(): void {
		if (ParadisThemeColorEditorInput.current === this) {
			ParadisThemeColorEditorInput.current = undefined;
		}
		super.dispose();
	}

	override get typeId(): string {
		return ParadisThemeColorEditorInput.ID;
	}

	override get editorId(): string {
		return PARADIS_THEME_COLOR_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('paradis.themeColors.inputName', "テーマの色: {0}", this.themeService.getColorTheme().label);
	}

	override getIcon(): ThemeIcon {
		return Codicon.symbolColor;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof ParadisThemeColorEditorInput;
	}

	reveal(target: ParadisThemeColorRevealTarget): void {
		this.pendingReveal = target;
		this._onDidRequestReveal.fire();
	}

	takePendingReveal(): ParadisThemeColorRevealTarget | undefined {
		const target = this.pendingReveal;
		this.pendingReveal = undefined;
		return target;
	}

	override isDirty(): boolean {
		return this.draftService.dirtyCount > 0;
	}

	override async save(): Promise<EditorInput | undefined> {
		try {
			return await this.draftService.save() ? this : undefined;
		} catch (error) {
			this.notificationService.error(localize('paradis.themeColors.saveFailed', "テーマの色を保存できませんでした: {0}", error instanceof Error ? error.message : String(error)));
			return undefined;
		}
	}

	override async revert(): Promise<void> {
		this.draftService.discard();
	}

	// --- IEditorCloseHandler ---------------------------------------------------------------------

	showConfirm(): boolean {
		return this.isDirty();
	}

	async confirm(): Promise<ConfirmResult> {
		const { result } = await this.dialogService.prompt<ConfirmResult>({
			message: localize('paradis.themeColors.confirmClose', "テーマの色の変更（{0} 件）を保存しますか？", this.draftService.dirtyCount),
			detail: localize('paradis.themeColors.confirmCloseDetail', "保存しないと、画面に出ている変更は元に戻ります。"),
			buttons: [
				{ label: localize('paradis.themeColors.confirmSave', "保存"), run: () => ConfirmResult.SAVE },
				{ label: localize('paradis.themeColors.confirmDontSave', "保存しない"), run: () => ConfirmResult.DONT_SAVE },
			],
			cancelButton: { run: () => ConfirmResult.CANCEL },
		});
		return result ?? ConfirmResult.CANCEL;
	}
}

/** タブの復元。下書きは復元しない（メモリ層はウィンドウを閉じると消えるので、復元すると画面と食い違う）。 */
export class ParadisThemeColorEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof ParadisThemeColorEditorInput;
	}

	serialize(): string {
		return '{}';
	}

	deserialize(instantiationService: IInstantiationService): EditorInput {
		return ParadisThemeColorEditorInput.getOrCreate(instantiationService);
	}
}
