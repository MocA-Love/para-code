/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { asText, IRequestService } from '../../../../platform/request/common/request.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IBaseSerializableStorageRequest, ISerializableCompareAndSwapRequest, ISerializableCompareAndSwapResult, ISerializableGetValueRequest } from '../../../../platform/storage/common/storageIpc.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { mergeChangelogs, parseParadisChangelog } from '../common/paradisChangelogModel.js';
import { ParadisChangelogModal, toViewReleases } from './paradisChangelogModal.js';

/**
 * 歯車メニュー(左下)の「更新の確認...」の下に「更新履歴」を追加する。
 * Para Code (fork) が本家に加えた変更を、モーダルのバージョンナビゲーター
 * (paradisChangelogModal.ts)でユーザーが確認できるようにする。
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
		// ServicesAccessor は await を挟むと無効になるため、全サービスを先に取り出す
		const commandService = accessor.get(ICommandService);
		const editorService = accessor.get(IEditorService);
		const fileService = accessor.get(IFileService);
		const layoutService = accessor.get(ILayoutService);
		const storageService = accessor.get(IStorageService);
		const productService = accessor.get(IProductService);
		const requestService = accessor.get(IRequestService);

		// パッケージ版では out-build へ .md を同梱している (build/gulpfile.vscode.ts の
		// vscodeResources に PARA-PATCH でグロブを追加済み)
		const changelogUri = FileAccess.asFileUri('vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md');
		let bundledMd: string;
		try {
			bundledMd = (await fileService.readFile(changelogUri)).value.toString();
		} catch {
			// 同梱 md を読めない(リリース形態の想定外の変化)場合は従来の表示へフォールバックする
			try {
				await commandService.executeCommand('markdown.showPreview', changelogUri);
			} catch {
				await editorService.openEditor({ resource: changelogUri, options: { pinned: true } });
			}
			return;
		}
		openParadisChangelogModal(bundledMd, {
			layoutService,
			storageService,
			productService,
			requestService,
			commandService
		});
	}
}

registerAction2(ParadisShowChangelogAction);

/**
 * モーダル(案B: バージョンナビゲーター型)で更新履歴を開く。
 *
 * 基本データは「このビルドに同梱された md」。そこへ update サーバー
 * (cloudflare/update-server の GET /api/changelog/:quality)から最新の md を取得し、
 * 同梱より新しいバージョンを「利用可能な更新」として一覧に足す。これにより、まだ
 * 更新していないユーザーも次回リリースの中身を読める。取得結果は APPLICATION スコープに
 * キャッシュし、オフライン時・取得失敗時は同梱分だけを静かに表示する。
 */
const PARADIS_CHANGELOG_REMOTE_CACHE_KEY = 'paradis.changelog.remoteCache';
const PARADIS_CHANGELOG_FETCHED_AT_KEY = 'paradis.changelog.remoteFetchedAt';
/** ユーザーがここまで読んだ paracode-N。これより新しい項目に未読ドットを出す。 */
const PARADIS_CHANGELOG_LAST_READ_KEY = 'paradis.changelog.lastReadVersion';

const CHANGELOG_SANITY_RE = /^##\s+paracode-\d+/m;

/** 前回のモーダルの取得が未完了のまま再オープンされた場合に、そちらを打ち切るため。 */
let activeFetchCts: CancellationTokenSource | undefined;
/** 現在開いているモーダル。二重オープン時に閉じるために保持する。 */
let activeModal: ParadisChangelogModal | undefined;

function changelogFeedUrl(productService: IProductService): string | undefined {
	if (!productService.updateUrl) {
		return undefined;
	}
	return `${productService.updateUrl}/api/changelog/${productService.quality ?? 'stable'}`;
}

// abstractUpdateService.getUpdateAccessHeaders と同じ契約(CF Access サービストークン)。
// electron-main 層の関数は renderer から import できないため、同じヘッダーをここで組む。
function changelogRequestHeaders(productService: IProductService): Record<string, string> | undefined {
	if (!productService.updateAccessClientId || !productService.updateAccessClientSecret) {
		return undefined;
	}
	return {
		'CF-Access-Client-Id': productService.updateAccessClientId,
		'CF-Access-Client-Secret': productService.updateAccessClientSecret,
	};
}

async function fetchRemoteChangelogMd(
	requestService: IRequestService,
	productService: IProductService,
	token: CancellationToken
): Promise<string | undefined> {
	const url = changelogFeedUrl(productService);
	if (!url) {
		return undefined;
	}
	try {
		const context = await requestService.request(
			{ url, type: 'GET', headers: changelogRequestHeaders(productService), callSite: 'paradisChangelog.fetchRemote' },
			token
		);
		// 200 以外(204=サーバー側にまだ無い、401、404 など)は同梱分のみで静かに表示する
		if (context.res.statusCode !== 200) {
			return undefined;
		}
		const text = await asText(context);
		// キャプティブポータル等が返した HTML を弾くため、我々の見出し形式を含むかだけ確認する
		return text && CHANGELOG_SANITY_RE.test(text) ? text : undefined;
	} catch {
		return undefined;
	}
}

interface IParadisChangelogServices {
	readonly layoutService: ILayoutService;
	readonly storageService: IStorageService;
	readonly productService: IProductService;
	readonly requestService: IRequestService;
	readonly commandService: ICommandService;
}

function openParadisChangelogModal(
	bundledMd: string,
	services: IParadisChangelogServices,
): void {
	const { layoutService, storageService, productService, requestService, commandService } = services;

	const bundledReleases = parseParadisChangelog(bundledMd);
	// 同梱 md の先頭が「このビルドが出荷された時点の最新リリース」= インストール済みバージョン
	const installedVersion = bundledReleases[0]?.version ?? 0;

	const cachedRemoteMd = storageService.get(PARADIS_CHANGELOG_REMOTE_CACHE_KEY, StorageScope.APPLICATION);
	const cachedRemoteReleases = cachedRemoteMd ? parseParadisChangelog(cachedRemoteMd) : [];
	const initialLastReadVersion = storageService.getNumber(PARADIS_CHANGELOG_LAST_READ_KEY, StorageScope.APPLICATION, 0);
	const cachedFetchedAt = storageService.getNumber(PARADIS_CHANGELOG_FETCHED_AT_KEY, StorageScope.APPLICATION, 0);

	// 二重オープンでは既存のモーダルを閉じて作り直す(重なって表示されないように)
	activeModal?.dispose();
	const modal = new ParadisChangelogModal(
		layoutService.activeContainer,
		{
			releases: toViewReleases(mergeChangelogs(cachedRemoteReleases, bundledReleases), installedVersion),
			installedVersion
		},
		{
			initialLastReadVersion,
			onSelectRelease: version => storageService.store(PARADIS_CHANGELOG_LAST_READ_KEY, version, StorageScope.APPLICATION, StorageTarget.MACHINE),
			onCheckForUpdate: () => commandService.executeCommand('update.checkForUpdate')
		}
	);
	activeModal = modal;

	// 前回取得のキャッシュがある場合は、その時刻を出しておく(直後の再取得で更新される)
	if (cachedFetchedAt > 0 && cachedRemoteReleases.length > 0) {
		modal.setRemoteState({ kind: 'ok', fetchedAt: cachedFetchedAt });
	}

	// updateUrl 未設定(開発ビルド等)ではサーバー問い合わせをしない
	if (!changelogFeedUrl(productService)) {
		return;
	}
	activeFetchCts?.dispose();
	activeFetchCts = new CancellationTokenSource();
	const token = activeFetchCts.token;

	modal.setRemoteState({ kind: 'fetching' });
	fetchRemoteChangelogMd(requestService, productService, token).then(remoteMd => {
		if (token.isCancellationRequested || modal.isDisposed) {
			return;
		}
		if (!remoteMd) {
			modal.setRemoteState({ kind: 'error' });
			return;
		}
		storageService.store(PARADIS_CHANGELOG_REMOTE_CACHE_KEY, remoteMd, StorageScope.APPLICATION, StorageTarget.MACHINE);
		const fetchedAt = Date.now();
		storageService.store(PARADIS_CHANGELOG_FETCHED_AT_KEY, fetchedAt, StorageScope.APPLICATION, StorageTarget.MACHINE);
		modal.setRemoteState({ kind: 'ok', fetchedAt });

		const remoteReleases = parseParadisChangelog(remoteMd);
		if (remoteReleases.length > 0) {
			modal.applyReleases({
				releases: toViewReleases(mergeChangelogs(remoteReleases, bundledReleases), installedVersion),
				installedVersion
			});
		}
	}).catch(() => {
		if (!token.isCancellationRequested && !modal.isDisposed) {
			modal.setRemoteState({ kind: 'error' });
		}
	});
}

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
