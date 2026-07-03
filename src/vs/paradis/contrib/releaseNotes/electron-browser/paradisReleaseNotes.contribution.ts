/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { FileAccess } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';

/**
 * 歯車メニュー(左下)の「更新の確認...」の下に「更新履歴」を追加する。
 * Para Code (fork) が本家に加えた変更を、同梱の paradisChangelog.md の
 * Markdown プレビューでユーザーが確認できるようにする。
 * 履歴の追記ルールは CLAUDE.md の「更新履歴（アプリ内 changelog）の運用」を参照。
 */
const PARADIS_SHOW_CHANGELOG_COMMAND_ID = 'paradis.showChangelog';

class ParadisShowChangelogAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_SHOW_CHANGELOG_COMMAND_ID,
			title: localize2('paradis.showChangelog', "更新履歴"),
			category: localize2('paradis.releaseNotes.category', "Para Code"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const editorService = accessor.get(IEditorService);

		// パッケージ版では out-build へ .md を同梱している (build/gulpfile.vscode.ts の
		// vscodeResources に PARA-PATCH でグロブを追加済み)
		const changelogUri = FileAccess.asFileUri('vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md');
		try {
			// 内蔵 Markdown 拡張のプレビューでレンダリング表示する
			await commandService.executeCommand('markdown.showPreview', changelogUri);
		} catch {
			// Markdown 拡張が使えない場合はプレーンテキストとして開く
			await editorService.openEditor({ resource: changelogUri, options: { pinned: true } });
		}
	}
}

registerAction2(ParadisShowChangelogAction);

// 歯車メニューの「更新の確認...」(update.ts の appendUpdateMenuItems が使う group '7_update') の
// 直下に並べる。update 系の項目は order 未指定 (=0) なので order: 1 で最後に来る
MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
	group: '7_update',
	order: 1,
	command: {
		id: PARADIS_SHOW_CHANGELOG_COMMAND_ID,
		title: localize('paradis.showChangelog.menu', "更新履歴")
	}
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		'paradis.releaseNotes.showOnUpdate': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.releaseNotes.showOnUpdate', "自動更新の適用後に Para Code が再起動したとき、更新履歴を自動的に開きます。")
		}
	}
});

/**
 * 自動更新の適用後、最初の起動で更新履歴を自動的に開く (upstream の ProductContribution =
 * 「アップデート後にリリースノートを開く」と同じパターン)。
 *
 * Para Code のリリースは package.json の version を変えない (タグ v1.x.y-paracode-N だけで
 * 識別する運用。vsce が '+' 付き version を拒否するため) ので、product.version の比較では
 * fork のリリース間の更新を検知できない。代わりにリリースビルドごとに必ず変わる
 * product.commit を APPLICATION スコープの storage に覚えておき、変化していたら
 * 「更新後の初回起動」と判定する。
 */
class ParadisShowChangelogOnUpdate implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisShowChangelogOnUpdate';

	private static readonly LAST_COMMIT_KEY = 'paradis.releaseNotes.lastKnownCommit';

	constructor(
		@IStorageService storageService: IStorageService,
		@IProductService productService: IProductService,
		@IConfigurationService configurationService: IConfigurationService,
		@IHostService hostService: IHostService,
		@ICommandService commandService: ICommandService,
	) {
		const commit = productService.commit;
		if (!commit) {
			// 開発ビルドには commit が無いため何もしない
			return;
		}

		// 複数ウィンドウが同時に復元されても、最後にフォーカスのあったウィンドウ 1 つでだけ開く
		// (upstream の ProductContribution と同じガード)
		hostService.hadLastFocus().then(hadLastFocus => {
			if (!hadLastFocus) {
				return;
			}

			const lastCommit = storageService.get(ParadisShowChangelogOnUpdate.LAST_COMMIT_KEY, StorageScope.APPLICATION);
			storageService.store(ParadisShowChangelogOnUpdate.LAST_COMMIT_KEY, commit, StorageScope.APPLICATION, StorageTarget.MACHINE);

			// 記録が無い = 新規インストール直後は開かない。commit が同じ = 更新されていない
			if (lastCommit === undefined || lastCommit === commit) {
				return;
			}

			if (configurationService.getValue<boolean>('paradis.releaseNotes.showOnUpdate') === false) {
				return;
			}

			commandService.executeCommand(PARADIS_SHOW_CHANGELOG_COMMAND_ID);
		});
	}
}

registerWorkbenchContribution2(ParadisShowChangelogOnUpdate.ID, ParadisShowChangelogOnUpdate, WorkbenchPhase.Eventually);
