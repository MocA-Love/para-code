/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 中央のパレットの右のプレビューと、コマンドの英語の名前の 1 行化（Q609 の 2 と 5、mock/ui/palette-ideas.html の案 11）。
//
// 器の幅・面の幅・1 行化は platform の paradisQuickInputLayout.ts が決める（quickInputController.ts と quickInputList.ts の
// PARA-PATCH から呼ばれる）。ここは、
//  - 横断ジャンプ（contextKey `paradisInCrossJump`）とコマンドパレット（`inCommandsPicker`）を登録し、設定
//    `paradis.palette.preview` を渡す
//  - 器が広がっているあいだ、一覧の右に面（paradisPalettePreview.ts）を置き、選んだ行が替わるたびに中身を替える
//  - 1 行化をまたいだら、今の行を入れ直して行の高さを測り直させる（一覧は行の高さを覚えている）
//  - Ctrl+P から `>` を打ったとき（picker はそのままで contextKey だけが替わり、本家は器を測り直さない）と、
//    プレビューを切り替えたときは、ワークベンチの layout を 1 回呼んで器を測り直させる
// 横断ジャンプの行は、面に出す中身を `paradisPreview` に持っている（paradisCrossJump.contribution.ts）。

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IQuickInputService, IQuickPick, IQuickPickItem, QuickInputType } from '../../../../platform/quickinput/common/quickInput.js';
import { onDidChangeParadisQuickInputLayout, paradisCurrentQuickInputLayout, paradisRegisterQuickInputLayout, paradisSetQuickInputPreviewEnabled } from '../../../../platform/quickinput/browser/paradisQuickInputLayout.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { paradisFindQuickInputWidget } from '../../quickInputPosition/browser/paradisQuickInputLook.js';
import { PARADIS_PALETTE_PREVIEW_SETTING } from '../browser/paradisPaletteConfiguration.js';
import { ParadisPalettePreviewModel, ParadisPalettePreviewPane } from '../browser/paradisPalettePreview.js';

/** 横断ジャンプのクイックピックの contextKey（paradisCrossJump.contribution.ts と同じ）。 */
export const PARADIS_CROSS_JUMP_CONTEXT_KEY = 'paradisInCrossJump';
/** コマンドパレットの contextKey（本家の quickAccess.contribution.ts）。 */
export const PARADIS_COMMANDS_PICKER_CONTEXT_KEY = 'inCommandsPicker';
/** プレビューの切り替え（Alt+P、macOS は Cmd+Option+P）。 */
export const PARADIS_PALETTE_TOGGLE_PREVIEW_COMMAND_ID = 'paradis.palette.togglePreview';
/**
 * プレビューの切り替えの既定のキー。Windows・Linux は Alt+P、macOS は Option+P が文字（π）を打つので Cmd+Option+P。
 */
const TOGGLE_PREVIEW_KEYBINDING = KeyMod.Alt | KeyCode.KeyP;
const TOGGLE_PREVIEW_KEYBINDING_MAC = KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyP;

/** 器に付ける印（CSS: paradisPalette.css）。 */
const INLINE_DETAIL_CLASS = 'paradis-palette-inline-detail';
const HAS_PREVIEW_CLASS = 'paradis-palette-has-preview';

/** 横断ジャンプの行が持つ、面に出す中身。 */
export interface IParadisPalettePreviewItem {
	readonly paradisPreview?: ParadisPalettePreviewModel;
}

/** コマンドパレットの行（本家の ICommandQuickPick のうち、面に使うものだけ）。 */
interface ICommandPickLike extends IQuickPickItem {
	readonly commandAlias?: string;
}

class ParadisPalettePreview extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisPalettePreview';

	private readonly inputListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly pane = this._register(new MutableDisposable<ParadisPalettePreviewPane>());
	private paneWidth = 0;
	private listContainer: HTMLElement | undefined;
	private lastContextKey: string | undefined;
	private lastInlineDetail = false;

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IWorkbenchLayoutService private readonly workbenchLayoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(paradisRegisterQuickInputLayout(PARADIS_CROSS_JUMP_CONTEXT_KEY, { preview: true, inlineDetail: false }));
		this._register(paradisRegisterQuickInputLayout(PARADIS_COMMANDS_PICKER_CONTEXT_KEY, { preview: true, inlineDetail: true }));
		paradisSetQuickInputPreviewEnabled(this.configurationService.getValue<boolean>(PARADIS_PALETTE_PREVIEW_SETTING) !== false);
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_PALETTE_PREVIEW_SETTING)) {
				paradisSetQuickInputPreviewEnabled(this.configurationService.getValue<boolean>(PARADIS_PALETTE_PREVIEW_SETTING) !== false);
				this.relayout();
			}
		}));
		// 器の幅か 1 行化が変わった（開いたとき・窓の大きさが段をまたいだとき）
		this._register(onDidChangeParadisQuickInputLayout(() => this.sync()));
		this._register(this.quickInputService.onShow(() => this.onShow()));
		this._register(this.quickInputService.onHide(() => {
			this.inputListeners.clear();
			this.lastContextKey = undefined;
			this.sync();
		}));
	}

	private onShow(): void {
		const input = this.quickInputService.currentQuickInput;
		const store = new DisposableStore();
		this.lastContextKey = input?.contextKey;
		if (input?.type === QuickInputType.QuickPick) {
			const picker = input as IQuickPick<IQuickPickItem>;
			store.add(picker.onDidChangeActive(() => this.updateContent()));
			store.add(picker.onDidChangeValue(() => {
				// Ctrl+P から `>` を打つと、picker はそのままで contextKey だけが替わる
				if (picker.contextKey !== this.lastContextKey) {
					this.lastContextKey = picker.contextKey;
					this.relayout();
				}
			}));
		}
		this.inputListeners.value = store;
		this.sync();
	}

	/** 器を測り直させる（本家の器は show と窓の layout でしか測らない）。 */
	private relayout(): void {
		if (this.quickInputService.currentQuickInput) {
			this.workbenchLayoutService.layout();
		}
	}

	/** 面と印を、今の器の幅と入力に合わせる。 */
	private sync(): void {
		const layout = paradisCurrentQuickInputLayout();
		const input = this.quickInputService.currentQuickInput;
		const widget = paradisFindQuickInputWidget(this.layoutService.activeContainer);
		const visible = !!input && !!widget && widget.style.display !== 'none';
		const listContainer = visible ? [...widget.children].find((child): child is HTMLElement => dom.isHTMLElement(child) && child.classList.contains('quick-input-list')) : undefined;

		widget?.classList.toggle(INLINE_DETAIL_CLASS, visible && layout.inlineDetail);
		if (visible && layout.inlineDetail !== this.lastInlineDetail && input?.type === QuickInputType.QuickPick) {
			// 一覧は行の高さを覚えているので、行を入れ直して測り直させる（選んでいる行は保つ）
			const picker = input as IQuickPick<IQuickPickItem>;
			const active = picker.activeItems;
			picker.items = [...picker.items];
			picker.activeItems = active;
		}
		this.lastInlineDetail = visible && layout.inlineDetail;

		const wanted = visible && layout.previewWidth > 0 && !!listContainer;
		if (!wanted || listContainer !== this.listContainer || layout.previewWidth !== this.paneWidth) {
			this.unmount();
		}
		if (wanted && !this.pane.value && listContainer) {
			this.listContainer = listContainer;
			this.paneWidth = layout.previewWidth;
			listContainer.classList.add(HAS_PREVIEW_CLASS, `paradis-palette-preview-${layout.previewWidth}`);
			this.pane.value = this.instantiationService.createInstance(ParadisPalettePreviewPane, listContainer);
		}
		this.updateContent();
	}

	private unmount(): void {
		this.pane.clear();
		this.listContainer?.classList.remove(HAS_PREVIEW_CLASS, `paradis-palette-preview-${this.paneWidth}`);
		this.listContainer = undefined;
		this.paneWidth = 0;
	}

	private updateContent(): void {
		const pane = this.pane.value;
		const input = this.quickInputService.currentQuickInput;
		if (!pane || input?.type !== QuickInputType.QuickPick) {
			return;
		}
		const item = (input as IQuickPick<IQuickPickItem>).activeItems[0] as (IQuickPickItem & IParadisPalettePreviewItem & ICommandPickLike) | undefined;
		if (!item) {
			pane.show(undefined);
		} else if (item.paradisPreview) {
			pane.show(item.paradisPreview);
		} else if (input.contextKey === PARADIS_COMMANDS_PICKER_CONTEXT_KEY) {
			pane.show({
				kind: 'command',
				title: item.label,
				alias: item.commandAlias && item.commandAlias !== item.label ? item.commandAlias : undefined,
				keybinding: item.keybinding?.getLabel() ?? undefined,
			});
		} else {
			pane.show({ kind: 'other', title: item.label, icon: Codicon.chevronRight, kindName: '', keybinding: item.keybinding?.getLabel() ?? undefined });
		}
	}
}

registerWorkbenchContribution2(ParadisPalettePreview.ID, ParadisPalettePreview, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PARADIS_PALETTE_TOGGLE_PREVIEW_COMMAND_ID,
			title: localize2('paradis.palette.togglePreview', "パレット: プレビューの表示を切り替え"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
			keybinding: {
				primary: TOGGLE_PREVIEW_KEYBINDING,
				mac: { primary: TOGGLE_PREVIEW_KEYBINDING_MAC },
				when: ContextKeyExpr.and(
					ContextKeyExpr.has('inQuickInput'),
					ContextKeyExpr.or(ContextKeyExpr.has(PARADIS_CROSS_JUMP_CONTEXT_KEY), ContextKeyExpr.has(PARADIS_COMMANDS_PICKER_CONTEXT_KEY)),
				),
				weight: KeybindingWeight.WorkbenchContrib + 50,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		await configurationService.updateValue(PARADIS_PALETTE_PREVIEW_SETTING, configurationService.getValue<boolean>(PARADIS_PALETTE_PREVIEW_SETTING) === false, ConfigurationTarget.USER);
	}
});
