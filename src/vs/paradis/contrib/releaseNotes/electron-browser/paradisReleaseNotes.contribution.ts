/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { raceTimeout } from '../../../../base/common/async.js';
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
import { IProductService } from '../../../../platform/product/common/productService.js';
import { getParadisChangelogFeedUrl } from '../../../../platform/update/common/paradisUpdateChannel.js';
import { asText, IRequestService } from '../../../../platform/request/common/request.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IBaseSerializableStorageRequest, ISerializableCompareAndSwapRequest, ISerializableCompareAndSwapResult, ISerializableGetValueRequest } from '../../../../platform/storage/common/storageIpc.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { mergeChangelogs, parseParadisChangelog } from '../common/paradisChangelogModel.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisChangelogLifecycle } from './paradisChangelogLifecycle.js';
import { ParadisChangelogView, toViewReleases } from './paradisChangelogView.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import * as dom from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { IParadisHubAreaContainers, IParadisHubAreaView, IParadisHubAreaViewState, IParadisHubHost, ParadisHubAreaId, paradisRegisterHubArea } from '../../paradisHub/electron-browser/paradisHub.js';
import { paradisOpenHub } from '../../paradisHub/electron-browser/paradisHubOpen.js';

const $ = dom.$;

/**
 * 歯車メニュー(左下)の「更新の確認...」の下に「更新履歴」を追加する。
 * Para Code (fork) が本家に加えた変更を、統合のモーダルの「更新履歴」の領域
 * (paradisChangelogView.ts)でユーザーが確認できるようにする。
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

	/** @param version 開いたときに出すバージョン（`paracode-N` か N）。 */
	run(accessor: ServicesAccessor, version?: unknown): void {
		paradisOpenHub(accessor, ParadisHubAreaId.Changelog, typeof version === 'string' || typeof version === 'number' ? String(version) : undefined);
	}
}

registerAction2(ParadisShowChangelogAction);

/** 統合のモーダルの「更新履歴」の領域。同梱の md を読んでから表示を作り、サーバーから最新の md も取りに行く。 */
class ParadisChangelogArea extends Disposable implements IParadisHubAreaView {

	private view: ParadisChangelogView | undefined;
	private pendingVersion: string | undefined;
	/** 同梱の md を読み終える前に戻すよう頼まれたスクロール位置。 */
	private pendingScrollTop: number | undefined;

	constructor(
		private readonly containers: IParadisHubAreaContainers,
		private readonly host: IParadisHubHost,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@IProductService private readonly productService: IProductService,
		@IRequestService private readonly requestService: IRequestService,
	) {
		super();
		void this.load();
	}

	private async load(): Promise<void> {
		// パッケージ版では out へ .md を同梱している (build/next/paradisResources.ts の
		// paradisDesktopResourcePatterns にグロブを登録済み)
		const changelogUri = FileAccess.asFileUri('vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md');
		let bundledMd: string;
		try {
			bundledMd = (await this.fileService.readFile(changelogUri)).value.toString();
		} catch {
			// 同梱 md を読めない(リリース形態の想定外の変化)場合は、この領域に知らせを出し、従来の表示(Markdown の
			// プレビュー)で開くボタンを置く。器ごと閉じるとほかの領域を見ていた人まで追い出すため閉じない
			if (!this._store.isDisposed) {
				this.renderLoadFailure(changelogUri);
			}
			return;
		}
		if (this._store.isDisposed) {
			return;
		}
		this.view = this._register(openParadisChangelogView(this.containers, bundledMd, {
			storageService: this.storageService,
			productService: this.productService,
			requestService: this.requestService,
			commandService: this.commandService,
		}));
		this.view.reveal(this.pendingVersion);
		if (this.pendingScrollTop !== undefined) {
			this.view.scrollTop = this.pendingScrollTop;
		}
	}

	private renderLoadFailure(changelogUri: URI): void {
		const message = dom.append(this.containers.content, $('.para-cl-empty'));
		// allow-any-unicode-next-line
		dom.append(message, $('p')).textContent = localize('paradis.changelog.loadFailed', "このアプリに同梱された更新履歴を読めませんでした。");
		const button = dom.append(message, $('button.para-cl-btn')) as HTMLButtonElement;
		button.type = 'button';
		// allow-any-unicode-next-line
		button.textContent = localize('paradis.changelog.openMarkdown', "Markdown のプレビューで開く");
		this._register(dom.addDisposableListener(button, dom.EventType.CLICK, async () => {
			this.host.close();
			try {
				await this.commandService.executeCommand('markdown.showPreview', changelogUri);
			} catch {
				await this.editorService.openEditor({ resource: changelogUri, options: { pinned: true } });
			}
		}));
	}

	reveal(version: string | undefined): void {
		if (this.view) {
			this.view.reveal(version);
		} else {
			this.pendingVersion = version;
		}
	}

	saveViewState(): IParadisHubAreaViewState | undefined {
		if (!this.view) {
			return undefined;
		}
		const { version, scrollTop } = this.view.viewState;
		return { section: version, scrollTop };
	}

	restoreViewState(state: IParadisHubAreaViewState): void {
		if (state.scrollTop === undefined) {
			return;
		}
		if (this.view) {
			this.view.scrollTop = state.scrollTop;
		} else {
			this.pendingScrollTop = state.scrollTop;
		}
	}

	setVisible(_visible: boolean): void { }

	layout(_width: number): void { }
}

paradisRegisterHubArea({
	id: ParadisHubAreaId.Changelog,
	// allow-any-unicode-next-line
	label: localize('paradis.changelog.areaLabel', "更新履歴"),
	order: 50,
	create: (instantiationService, containers, host) => instantiationService.createInstance(ParadisChangelogArea, containers, host),
});

/**
 * 統合のモーダルの「更新履歴」の領域に、更新履歴を描く。
 *
 * 基本データは「このビルドに同梱された md」。そこへ update サーバー
 * (cloudflare/update-server の GET /api/changelog/:quality。:quality は更新フィードと同じ
 * チャネルで、ベータのビルドでは beta になる)から最新の md を取得し、
 * 同梱より新しいバージョンを「利用可能な更新」として一覧に足す。これにより、まだ
 * 更新していないユーザーも次回リリースの中身を読める。取得結果は APPLICATION スコープに
 * キャッシュし、オフライン時・取得失敗時は同梱分だけを静かに表示する。
 */
const PARADIS_CHANGELOG_REMOTE_CACHE_KEY = 'paradis.changelog.remoteCache';
const PARADIS_CHANGELOG_FETCHED_AT_KEY = 'paradis.changelog.remoteFetchedAt';
/** ユーザーがここまで読んだ paracode-N。これより新しい項目に未読ドットを出す。 */
const PARADIS_CHANGELOG_LAST_READ_KEY = 'paradis.changelog.lastReadVersion';

const CHANGELOG_SANITY_RE = /^##\s+paracode-\d+/m;

const changelogLifecycle = new ParadisChangelogLifecycle<ParadisChangelogView>();

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

/**
 * サーバー問い合わせの打ち切り時間。呼び出し側の token はモーダルを閉じた／開き直したときに
 * しかキャンセルされないので、キャプティブポータル等でレスポンスが返らないとモーダルが
 * 「サーバーを確認中…」のまま固まる。更新履歴は同梱 md だけでも成立する情報なので、
 * 短めに諦めて既存の失敗経路(undefined)へ寄せる。
 */
const CHANGELOG_FETCH_TIMEOUT_MS = 10_000;

async function fetchRemoteChangelogMd(
	requestService: IRequestService,
	productService: IProductService,
	token: CancellationToken
): Promise<string | undefined> {
	const url = getParadisChangelogFeedUrl(productService);
	if (!url) {
		return undefined;
	}
	// 呼び出し側の token を親にした CTS を挟み、タイムアウト時はこちらから cancel して
	// 実際の通信も止める(ヘッダー受信後に本文が止まる場合も raceTimeout 側で拾える)。
	const cts = new CancellationTokenSource(token);
	try {
		return await raceTimeout(
			(async () => {
				try {
					const context = await requestService.request(
						{ url, type: 'GET', headers: changelogRequestHeaders(productService), callSite: 'paradisChangelog.fetchRemote' },
						cts.token
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
			})(),
			CHANGELOG_FETCH_TIMEOUT_MS,
			() => cts.cancel()
		);
	} finally {
		cts.dispose();
	}
}

interface IParadisChangelogServices {
	readonly storageService: IStorageService;
	readonly productService: IProductService;
	readonly requestService: IRequestService;
	readonly commandService: ICommandService;
}

function openParadisChangelogView(
	containers: IParadisHubAreaContainers,
	bundledMd: string,
	services: IParadisChangelogServices,
): ParadisChangelogView {
	const { storageService, productService, requestService, commandService } = services;

	const bundledReleases = parseParadisChangelog(bundledMd);
	// 同梱 md の先頭が「このビルドが出荷された時点の最新リリース」= インストール済みバージョン
	const installedVersion = bundledReleases[0]?.version ?? 0;

	const cachedRemoteMd = storageService.get(PARADIS_CHANGELOG_REMOTE_CACHE_KEY, StorageScope.APPLICATION);
	const cachedRemoteReleases = cachedRemoteMd ? parseParadisChangelog(cachedRemoteMd) : [];
	const initialLastReadVersion = storageService.getNumber(PARADIS_CHANGELOG_LAST_READ_KEY, StorageScope.APPLICATION, 0);
	const cachedFetchedAt = storageService.getNumber(PARADIS_CHANGELOG_FETCHED_AT_KEY, StorageScope.APPLICATION, 0);

	const generation = changelogLifecycle.open(() => new ParadisChangelogView(
		containers,
		{
			releases: toViewReleases(mergeChangelogs(cachedRemoteReleases, bundledReleases), installedVersion),
			installedVersion
		},
		{
			initialLastReadVersion,
			onSelectRelease: version => storageService.store(PARADIS_CHANGELOG_LAST_READ_KEY, version, StorageScope.APPLICATION, StorageTarget.MACHINE),
			onCheckForUpdate: () => commandService.executeCommand('update.checkForUpdate')
		}
	));
	const modal = generation.modal;
	const token = generation.token;

	// 前回取得のキャッシュがある場合は、その時刻を出しておく(直後の再取得で更新される)
	if (cachedFetchedAt > 0 && cachedRemoteReleases.length > 0) {
		modal.setRemoteState({ kind: 'ok', fetchedAt: cachedFetchedAt });
	}

	// updateUrl 未設定(開発ビルド等)ではサーバー問い合わせをしない
	if (!getParadisChangelogFeedUrl(productService)) {
		generation.finishFetch();
		return modal;
	}

	modal.setRemoteState({ kind: 'fetching' });
	fetchRemoteChangelogMd(requestService, productService, token).then(remoteMd => {
		if (!generation.isCurrent() || token.isCancellationRequested) {
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
		if (generation.isCurrent() && !token.isCancellationRequested) {
			modal.setRemoteState({ kind: 'error' });
		}
	}).finally(() => generation.finishFetch());
	return modal;
}

// 歯車メニューの「更新の確認...」(update.ts の appendUpdateMenuItems が使う group '7_update') の
// 直下に並べる。同グループ内は order → タイトルの順でソートされ(MenuInfo._compareMenuItems)、
// update.check 等の常時表示項目は order 未指定 (=0) のため order: 1 ならその後ろに来る
// (update.restart は order: 2 でさらに後ろ、stable限定・条件付き表示の update.showUpdateReleaseNotes も
// order: 1 のためその場合はタイトルの辞書順で並ぶ)
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
			.catch(error => {
				// storage への問い合わせが失敗したら、更新履歴は出さないだけにする
				reportParadisDiagnosticError('owned', 'release-notes', 'auto-open-failed', error, undefined, 'info');
			});
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
