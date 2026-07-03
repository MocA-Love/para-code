/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブックマークバー機能の登録エントリ。paradis.electron-browser.contribution.ts からの
// import 1行で、サービス（singleton）・BrowserEditor contribution・設定スキーマ・
// 各アクション（Cmd+D トグル / バー表示切替 / Netscape HTML import・export）が登録される。
// 通常ウィンドウ専用（Agent Sessions ウィンドウには登録しない）。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import {
	BROWSER_EDITOR_ACTIVE,
	BrowserActionCategory,
	BrowserActionGroup,
	BrowserEditor,
	CONTEXT_BROWSER_HAS_URL,
} from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { CONTEXT_PARADIS_URL_IS_BOOKMARKED, ParadisBookmarkBarFeature } from './paradisBookmarkBarFeature.js';
import { exportParadisBookmarksToHtml, importParadisBookmarksFromHtml } from './paradisBookmarkHtml.js';
import {
	IParadisBookmarksService,
	PARADIS_BOOKMARK_BAR_VISIBLE_SETTING,
	PARADIS_EXPORT_BOOKMARKS_COMMAND_ID,
	PARADIS_IMPORT_BOOKMARKS_COMMAND_ID,
	PARADIS_TOGGLE_BOOKMARK_BAR_COMMAND_ID,
	PARADIS_TOGGLE_BOOKMARK_COMMAND_ID,
	ParadisBookmarksService,
} from './paradisBookmarksService.js';

// BrowserEditor.registerContribution は上の paradisBookmarkBarFeature.js の
// import（モジュール評価）時に実行される。

registerSingleton(IParadisBookmarksService, ParadisBookmarksService, InstantiationType.Delayed);

// --- settings ----------------------------------------------------------

// セクションは他のParadis独自設定と同じ 'paradis' に相乗り（集約セクション）。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_BOOKMARK_BAR_VISIBLE_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.browser.bookmarkBar.visible', "Controls whether the bookmarks bar is shown below the address bar in the integrated browser.")
		}
	}
});

// --- actions ------------------------------------------------------------

class ParadisToggleBookmarkAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_TOGGLE_BOOKMARK_COMMAND_ID,
			title: localize2('paradis.bookmarks.toggleAction', 'Bookmark This Page'),
			category: BrowserActionCategory,
			icon: Codicon.star,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL),
			toggled: {
				condition: CONTEXT_PARADIS_URL_IS_BOOKMARKED,
				icon: Codicon.starFull,
				title: localize('paradis.bookmarks.toggleAction.toggled', "Remove Bookmark"),
			},
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Data,
				order: 2,
				isHiddenByDefault: true,
			},
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL),
				primary: KeyMod.CtrlCmd | KeyCode.KeyD,
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const browserEditor = accessor.get(IEditorService).activeEditorPane;
		if (browserEditor instanceof BrowserEditor) {
			browserEditor.getContribution(ParadisBookmarkBarFeature)?.toggleCurrent();
		}
	}
}

class ParadisToggleBookmarkBarAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_TOGGLE_BOOKMARK_BAR_COMMAND_ID,
			title: localize2('paradis.bookmarks.toggleBarAction', 'Toggle Bookmarks Bar'),
			category: BrowserActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const visible = configurationService.getValue<boolean>(PARADIS_BOOKMARK_BAR_VISIBLE_SETTING) !== false;
		await configurationService.updateValue(PARADIS_BOOKMARK_BAR_VISIBLE_SETTING, !visible);
	}
}

class ParadisImportBookmarksAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_IMPORT_BOOKMARKS_COMMAND_ID,
			title: localize2('paradis.bookmarks.importAction', 'Import Bookmarks...'),
			category: BrowserActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const bookmarksService = accessor.get(IParadisBookmarksService);
		const fileDialogService = accessor.get(IFileDialogService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);

		const uris = await fileDialogService.showOpenDialog({
			title: localize('paradis.bookmarks.importDialogTitle', "Import Bookmarks"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: localize('paradis.bookmarks.htmlFilter', "Bookmark HTML"), extensions: ['html', 'htm'] }],
		});
		if (!uris || uris.length === 0) {
			return;
		}
		const content = await fileService.readFile(uris[0]);
		const nodes = importParadisBookmarksFromHtml(content.value.toString());
		const stats = bookmarksService.importNodes(nodes);
		notificationService.info(localize(
			'paradis.bookmarks.importResult',
			"Imported {0} bookmarks and {1} folders ({2} skipped).",
			stats.bookmarksAdded, stats.foldersAdded, stats.skipped
		));
	}
}

class ParadisExportBookmarksAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_EXPORT_BOOKMARKS_COMMAND_ID,
			title: localize2('paradis.bookmarks.exportAction', 'Export Bookmarks...'),
			category: BrowserActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const bookmarksService = accessor.get(IParadisBookmarksService);
		const fileDialogService = accessor.get(IFileDialogService);
		const fileService = accessor.get(IFileService);

		const uri = await fileDialogService.showSaveDialog({
			title: localize('paradis.bookmarks.exportDialogTitle', "Export Bookmarks"),
			defaultUri: joinPath(await fileDialogService.defaultFilePath(), 'bookmarks.html'),
			filters: [{ name: localize('paradis.bookmarks.htmlFilter', "Bookmark HTML"), extensions: ['html'] }],
		});
		if (!uri) {
			return;
		}
		const html = exportParadisBookmarksToHtml(bookmarksService.nodes, hash => bookmarksService.getFavicon(hash));
		await fileService.writeFile(uri, VSBuffer.fromString(html));
	}
}

registerAction2(ParadisToggleBookmarkAction);
registerAction2(ParadisToggleBookmarkBarAction);
registerAction2(ParadisImportBookmarksAction);
registerAction2(ParadisExportBookmarksAction);
