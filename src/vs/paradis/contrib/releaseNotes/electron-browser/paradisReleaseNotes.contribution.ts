/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { FileAccess } from '../../../../base/common/network.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IBaseSerializableStorageRequest, ISerializableCompareAndSwapRequest, ISerializableCompareAndSwapResult, ISerializableGetValueRequest } from '../../../../platform/storage/common/storageIpc.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';

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

	/**
	 * APPLICATION スコープの storage を、ウィンドウのキャッシュ越しではなくメインプロセスへ
	 * 直接読み書きするための宛先。profile / workspace を渡さないと
	 * `storageMainService.applicationStorage`（= StorageScope.APPLICATION の実体）に当たる。
	 */
	private static readonly APPLICATION_STORAGE_REQUEST: IBaseSerializableStorageRequest = {
		profile: undefined,
		workspace: undefined,
	};

	constructor(
		@IStorageService storageService: IStorageService,
		@IProductService productService: IProductService,
		@IConfigurationService configurationService: IConfigurationService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ICommandService commandService: ICommandService,
	) {
		const commit = productService.commit;
		if (!commit) {
			// 開発ビルドには commit が無いため何もしない
			return;
		}

		const storageChannel = mainProcessService.getChannel('storage');

		// 複数ウィンドウが同時に復元されても、更新履歴は 1 回だけ開きたい。
		//
		// 以前は「最後にフォーカスのあったウィンドウか」(hadLastFocus) で 1 つに絞っていたが、
		// これは「更新後の最初のウィンドウか」ではなく「いま最後にアクティブか」を見る判定なので、
		// 復元の途中で生まれたウィンドウ（SSH ウィンドウなど）が最後のアクティブを奪う。
		// すると本来のウィンドウは記録を残さずに終わり、後から来たウィンドウが古い commit を
		// 読んで開いてしまう。
		//
		// 記録はガードの外へ出し、メインプロセス側の compare-and-swap で「記録できた
		// ウィンドウだけが開く」形にして、どのウィンドウが先に来ても必ず 1 回になるようにする。
		this.claimAndShow(storageChannel, commit, storageService, configurationService, commandService)
			.catch(() => { /* storage への問い合わせが失敗したら、更新履歴は出さないだけにする */ });
	}

	private async claimAndShow(
		storageChannel: IChannel,
		commit: string,
		storageService: IStorageService,
		configurationService: IConfigurationService,
		commandService: ICommandService,
	): Promise<void> {
		const getValueRequest: ISerializableGetValueRequest = {
			...ParadisShowChangelogOnUpdate.APPLICATION_STORAGE_REQUEST,
			key: ParadisShowChangelogOnUpdate.LAST_COMMIT_KEY,
		};
		// ウィンドウの storage は起動時のスナップショットなので、他のウィンドウが書いた値が
		// 見えない。メインプロセスの現在値を読む。
		const lastCommit = await storageChannel.call<string | undefined>('getValue', getValueRequest);

		const compareAndSwapRequest: ISerializableCompareAndSwapRequest = {
			...ParadisShowChangelogOnUpdate.APPLICATION_STORAGE_REQUEST,
			key: ParadisShowChangelogOnUpdate.LAST_COMMIT_KEY,
			expectedValue: lastCommit,
			newValue: commit,
		};
		const result = await storageChannel.call<ISerializableCompareAndSwapResult>('compareAndSwap', compareAndSwapRequest);
		if (!result.swapped) {
			// 別のウィンドウが先に記録した = そちらが開く（or 開かないと判断した）
			return;
		}

		// 同期対象から外すための key target を登録し直す（値は上で確定済みなので実質再書き込み）
		storageService.store(ParadisShowChangelogOnUpdate.LAST_COMMIT_KEY, commit, StorageScope.APPLICATION, StorageTarget.MACHINE);

		// 記録が無い = 新規インストール直後は開かない。commit が同じ = 更新されていない
		if (lastCommit === undefined || lastCommit === commit) {
			return;
		}

		if (configurationService.getValue<boolean>('paradis.releaseNotes.showOnUpdate') === false) {
			return;
		}

		commandService.executeCommand(PARADIS_SHOW_CHANGELOG_COMMAND_ID);
	}
}

registerWorkbenchContribution2(ParadisShowChangelogOnUpdate.ID, ParadisShowChangelogOnUpdate, WorkbenchPhase.Eventually);
