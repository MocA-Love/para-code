/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタのタブ列の「＋ ⌄」を差し替える（Q570）。
//
// upstream の「＋」（TerminalCommandId.CreateTerminalEditorSameGroup、terminalMenus.ts）は、ターミナルの
// エディタがアクティブなときだけ TerminalEditor.getActionViewItem が ⌄ を付け、⌄ は IContextMenuService の
// メニュー（macOS では OS のメニュー）を出す。ここでは同じコマンドに IActionViewItemService で見た目を登録する。
// タブ列（editorTabsControl.ts）とタイトルバー（titlebarPart.ts）は、既存の PARA-PATCH でこの登録を
// アクティブなエディタより先に見るので、upstream のファイルを新たに変えずに、どのタブでも ⌄ を出せる。
//
// 「＋」の部分は upstream と同じ MenuEntryActionViewItem をそのまま使う。Alt を押している間は upstream の
// alt（「ターミナルの分割」）に替わる動きも、そのまま残る。⌄ は自前のランチャー（paradisTabLauncherPopup.ts）を開く。

import './media/paradisTabLauncher.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IActionRunner } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuEntryActionViewItem } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { MenuId, MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { isEditorCommandsContext } from '../../../../workbench/common/editor.js';
import { TerminalCommandId } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ParadisTabLauncherPopup } from './paradisTabLauncherPopup.js';

const STR_OPEN_LAUNCHER = localize('paradis.tabLauncher.open', "新しく開く（ターミナル・ブラウザ・エージェント）");

/** 「＋」（upstream のまま）と、ランチャーを開く ⌄ を並べたツールバーの項目。 */
class ParadisTabLauncherViewItem extends BaseActionViewItem {

	private readonly primary: MenuEntryActionViewItem;
	private readonly popup = this._register(new MutableDisposable<ParadisTabLauncherPopup>());
	private chevron: HTMLElement | undefined;

	constructor(
		action: MenuItemAction,
		private readonly itemOptions: IBaseActionViewItemOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super(null, action, { hoverDelegate: itemOptions.hoverDelegate });
		this.primary = this._register(instantiationService.createInstance(MenuEntryActionViewItem, action, { hoverDelegate: itemOptions.hoverDelegate }));
	}

	override set actionRunner(actionRunner: IActionRunner) {
		super.actionRunner = actionRunner;
		this.primary.actionRunner = actionRunner;
	}

	override get actionRunner(): IActionRunner {
		return super.actionRunner;
	}

	override setActionContext(context: unknown): void {
		super.setActionContext(context);
		this.primary.setActionContext(context);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		// upstream の DropdownWithPrimaryActionViewItem と同じクラスにして、見た目（角丸・ホバー）を揃える
		container.classList.add('monaco-dropdown-with-primary', 'paradis-tab-launcher-item');
		const primaryContainer = dom.append(container, dom.$('.action-container'));
		primaryContainer.role = 'button';
		this.primary.render(primaryContainer);

		const dropdownContainer = dom.append(container, dom.$('.dropdown-action-container'));
		const dropdown = dom.append(dropdownContainer, dom.$('.monaco-dropdown'));
		const label = dom.append(dropdown, dom.$('.dropdown-label'));
		const chevron = this.chevron = dom.append(label, dom.$('a.action-label'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));
		chevron.setAttribute('role', 'button');
		chevron.setAttribute('aria-haspopup', 'menu');
		chevron.setAttribute('aria-expanded', 'false');
		chevron.setAttribute('aria-label', STR_OPEN_LAUNCHER);
		chevron.tabIndex = -1;
		this._register(this.hoverService.setupManagedHover(this.itemOptions.hoverDelegate ?? getDefaultHoverDelegate('mouse'), chevron, STR_OPEN_LAUNCHER));

		// 項目全体の click は BaseActionViewItem が「＋」の実行に使うので、⌄ の上では止める
		this._register(dom.addDisposableListener(chevron, dom.EventType.MOUSE_DOWN, e => dom.EventHelper.stop(e, true)));
		this._register(dom.addDisposableListener(chevron, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			this.toggle();
		}));
		this._register(dom.addDisposableListener(chevron, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space) || event.equals(KeyCode.DownArrow)) {
				dom.EventHelper.stop(e, true);
				this.toggle();
			} else if (event.equals(KeyCode.LeftArrow)) {
				dom.EventHelper.stop(e, true);
				chevron.tabIndex = -1;
				this.primary.focus();
			}
		}));
		this._register(dom.addDisposableListener(primaryContainer, dom.EventType.KEY_DOWN, e => {
			if (new StandardKeyboardEvent(e).equals(KeyCode.RightArrow)) {
				dom.EventHelper.stop(e, true);
				chevron.tabIndex = 0;
				chevron.focus();
			}
		}));
		this.updateEnabled();
	}

	override focus(fromRight?: boolean): void {
		if (fromRight && this.chevron) {
			this.chevron.tabIndex = 0;
			this.chevron.focus();
		} else {
			this.primary.focus();
		}
	}

	override blur(): void {
		this.primary.blur();
		if (this.chevron) {
			this.chevron.tabIndex = -1;
		}
	}

	override setFocusable(focusable: boolean): void {
		this.primary.setFocusable(focusable);
	}

	private toggle(): void {
		if (this.popup.value) {
			this.popup.value.hide(true);
			return;
		}
		const chevron = this.chevron;
		if (!chevron) {
			return;
		}
		chevron.setAttribute('aria-expanded', 'true');
		chevron.classList.add('checked');
		this.popup.value = this.instantiationService.createInstance(ParadisTabLauncherPopup, {
			anchor: chevron,
			runPrimary: () => { void this.primary.actionRunner.run(this.action, this._context); },
			prepareRun: () => this.activateGroup(),
			onDidHide: () => {
				chevron.setAttribute('aria-expanded', 'false');
				chevron.classList.remove('checked');
				this.popup.clearAndLeak();
			},
		});
	}

	/** ⌄ を押したタブ列のグループを、項目を実行する前にアクティブにする（新しいタブがそのグループに開くように）。 */
	private activateGroup(): void {
		const groupId = isEditorCommandsContext(this._context) ? this._context.groupId : undefined;
		const group = groupId !== undefined ? this.editorGroupsService.getGroup(groupId) : undefined;
		if (group && group !== this.editorGroupsService.activeGroup) {
			this.editorGroupsService.activateGroup(group);
		}
	}
}

class ParadisTabLauncherContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTabLauncher';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		for (const menuId of [MenuId.EditorTitle, MenuId.CompactWindowEditorTitle]) {
			this._register(actionViewItemService.register(menuId, TerminalCommandId.CreateTerminalEditorSameGroup, (action, options) =>
				action instanceof MenuItemAction ? instantiationService.createInstance(ParadisTabLauncherViewItem, action, options) : undefined));
		}
	}
}

// BlockStartup で登録する（AfterRestored では遅い）。見た目の登録だけではメニューの変化が起きないため、
// 先に描かれたタブ列は、アクティブなエディタが変わるまで upstream の「＋ ⌄」のまま残ってしまう。
// 中身は登録 2 つだけで、サービスも軽い（IActionViewItemService）。
registerWorkbenchContribution2(ParadisTabLauncherContribution.ID, ParadisTabLauncherContribution, WorkbenchPhase.BlockStartup);
