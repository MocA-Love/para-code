/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Design Mode（B1）と Markup（B2）の登録。
//
// ボタンは upstream のブラウザのツールバー（MenuId.BrowserActionsToolbar の Tools グループ）に
// メニュー項目として足すだけで、ツールバーの DOM には触らない。キーは Q62 の提案どおり ⌘⌥D
// （upstream の「Add Element to Chat」⇧⌘C / 「Comment on Elements」⌥⌘C と重ならない）。
// 注意: macOS の既定では ⌥⌘D は「Dock を自動的に表示/非表示」に割り当てられていて、OS が先に
// 受け取る。その場合はツールバーのボタンかコマンドパレットから使う。

import './media/paradisDesignMode.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { BROWSER_EDITOR_ACTIVE, BrowserActionCategory, BrowserActionGroup, BrowserEditor, CONTEXT_BROWSER_HAS_ERROR, CONTEXT_BROWSER_HAS_URL } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { CONTEXT_PARADIS_DESIGN_MODE_ACTIVE, CONTEXT_PARADIS_MARKUP_ACTIVE, ParadisDesignModeFeature } from './paradisDesignModeFeature.js';
import './paradisDesignModeService.js';

BrowserEditor.registerContribution(ParadisDesignModeFeature);

const PAGE_READY = ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL, CONTEXT_BROWSER_HAS_ERROR.negate());

function activeFeature(accessor: ServicesAccessor): ParadisDesignModeFeature | undefined {
	const pane = accessor.get(IEditorService).activeEditorPane;
	return pane instanceof BrowserEditor ? pane.getContribution(ParadisDesignModeFeature) : undefined;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.browser.toggleDesignMode',
			title: localize2('paradis.designMode.toggle', "Design Mode（要素にコメント）"),
			category: BrowserActionCategory,
			icon: Codicon.commentDiscussion,
			f1: true,
			precondition: PAGE_READY,
			toggled: CONTEXT_PARADIS_DESIGN_MODE_ACTIVE,
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Tools,
				order: 3,
			},
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				when: BROWSER_EDITOR_ACTIVE,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyD,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		activeFeature(accessor)?.toggleDesignMode();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.browser.stopDesignMode',
			title: localize2('paradis.designMode.stopAction', "Design Mode をやめる"),
			category: BrowserActionCategory,
			f1: false,
			precondition: CONTEXT_PARADIS_DESIGN_MODE_ACTIVE,
			keybinding: {
				// upstream の要素選択の Esc（WorkbenchContrib）より先に受ける
				weight: KeybindingWeight.WorkbenchContrib + 1,
				when: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_PARADIS_DESIGN_MODE_ACTIVE),
				primary: KeyCode.Escape,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		activeFeature(accessor)?.stopDesignMode();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.browser.markupScreenshot',
			title: localize2('paradis.markup.open', "スクリーンショットに書き込む"),
			category: BrowserActionCategory,
			icon: Codicon.edit,
			f1: true,
			precondition: ContextKeyExpr.and(PAGE_READY, CONTEXT_PARADIS_MARKUP_ACTIVE.negate()),
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Tools,
				order: 4,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await activeFeature(accessor)?.openMarkup();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.browser.sendDesignAnnotations',
			title: localize2('paradis.designMode.sendAction', "注釈をエージェントへ送る"),
			category: BrowserActionCategory,
			icon: Codicon.send,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await activeFeature(accessor)?.sendAnnotations();
	}
});
