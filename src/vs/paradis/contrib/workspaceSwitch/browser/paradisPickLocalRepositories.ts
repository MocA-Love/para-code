/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「リポジトリを追加」→「ローカルフォルダを追加...」で開く、フォルダの複数選択ピッカー。
//
// 以前は OS のフォルダ選択ダイアログをそのまま開いていた。複数選択自体はできたが、
// Finder / エクスプローラーの作法での多重選択が要るうえ、どれが Git リポジトリなのかも
// 見分けられなかった。クローン先（既定 ~/github）の直下を自分で一覧し、チェックボックスで
// まとめて選べるようにする。一覧の外にあるフォルダは「別のフォルダを開く...」から選ぶ。

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, dirname, isEqual, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { paradisResolveExternalPath } from '../../../common/paradisPathUri.js';
import { PARADIS_CLONE_PARENT_DIR_SETTING } from '../common/paradisRepositoryClone.js';
import { paradisHostPathFor } from '../../../common/paradisHostPath.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';

/**
 * `.git` の有無を1件ずつ確かめる上限。接続先を見ているときは1件ごとに往復するため、
 * 数が多いフォルダ（ホーム直下など）を起点にされると一覧が出るまで待たされる。
 * 超えたときは判定をやめて全部を1つの節にまとめ、そのことを画面にも書く。
 */
const MAX_GIT_PROBE_ENTRIES = 400;

/** `.git` の確認を一度に投げる数。区切りごとに中断要求を見る。 */
const GIT_PROBE_BATCH_SIZE = 32;

/** 前回この画面で開いていた起点の保存キー。 */
const SCAN_ROOT_STORAGE_KEY = 'paradis.workspaceSwitch.lastFolderPickRoot';

/**
 * ピッカーが使うサービス一式。呼び出し側は await をまたいだ後に呼ぶことがあり、
 * ServicesAccessor をそのまま持ち回れないため、解決済みのサービスを受け取る。
 */
export interface IParadisLocalRepositoryPickContext {
	readonly switchService: IParadisWorkspaceSwitchService;
	readonly quickInputService: IQuickInputService;
	readonly fileService: IFileService;
	readonly fileDialogService: IFileDialogService;
	readonly pathService: IPathService;
	readonly configurationService: IConfigurationService;
	readonly contextService: IWorkspaceContextService;
	readonly storageService: IStorageService;
	readonly logService: ILogService;
}

/**
 * ピッカーが使うサービスをまとめて取り出す。ServicesAccessor は invokeFunction の同期区間でしか
 * 使えないため、await をまたぐ呼び出し側（統合フロー）は入口でこれを作って持ち回る。
 */
export function paradisLocalRepositoryPickContext(accessor: ServicesAccessor): IParadisLocalRepositoryPickContext {
	return {
		switchService: accessor.get(IParadisWorkspaceSwitchService),
		quickInputService: accessor.get(IQuickInputService),
		fileService: accessor.get(IFileService),
		fileDialogService: accessor.get(IFileDialogService),
		pathService: accessor.get(IPathService),
		configurationService: accessor.get(IConfigurationService),
		contextService: accessor.get(IWorkspaceContextService),
		storageService: accessor.get(IStorageService),
		logService: accessor.get(ILogService),
	};
}

/** 一覧に出す1フォルダ。 */
interface IParadisFolderEntry {
	readonly uri: URI;
	readonly isRepository: boolean;
	/** 既に Workspaces に登録済み（選んでも二重登録にはならないが、選ぶ意味がないことを見せる）。 */
	readonly registered: boolean;
}

interface IParadisFolderScan {
	readonly entries: readonly IParadisFolderEntry[];
	/** `.git` の有無を実際に確かめたか（false なら節を分けない）。 */
	readonly probed: boolean;
	/** 起点そのものが Git リポジトリか（自分自身を選べるようにする）。 */
	readonly rootIsRepository: boolean;
}

interface IParadisFolderPickItem extends IQuickPickItem {
	readonly uri: URI;
}

type ParadisFolderPickResult =
	| { readonly kind: 'picked'; readonly uris: readonly URI[] }
	| { readonly kind: 'browse' }
	| { readonly kind: 'unreadable' }
	| { readonly kind: 'cancelled' };

/**
 * 既存のローカルフォルダを Workspaces へ登録する（従来の Add Repository の本体）。
 * electron-browser 側の統合フロー（URLクローン）の「ローカルフォルダを追加」項目からも呼ばれる。
 *
 * `scheme` は「どちらのマシンのフォルダを選ばせるか」。接続中に省略すると接続先を見る。
 */
export async function paradisPickAndAddLocalRepositories(context: IParadisLocalRepositoryPickContext, scheme?: string): Promise<void> {
	const uris = await paradisPickLocalRepositoryFolders(context, scheme);
	if (uris.length === 0) {
		return;
	}

	const added: IParadisWorkspaceRepository[] = [];
	for (const uri of uris) {
		added.push(await context.switchService.addRepository(uri));
	}

	// まだ何も開いていない (初期化直後の空ワークスペース) なら、最初の登録先へそのまま切り替える
	if (context.contextService.getWorkspace().folders.length === 0 && added.length > 0) {
		await context.switchService.switchRepository(added[0].id);
	}
}

/** 追加するフォルダを選ばせる。何も選ばなかった場合は空配列。 */
async function paradisPickLocalRepositoryFolders(context: IParadisLocalRepositoryPickContext, scheme: string | undefined): Promise<readonly URI[]> {
	let root = await resolveScanRoot(context, scheme);
	while (root) {
		const result = await showFolderPick(context, root);
		if (result.kind === 'picked') {
			return result.uris;
		}
		if (result.kind === 'cancelled') {
			return [];
		}
		if (result.kind === 'unreadable') {
			// 起点が読めない（設定が指す先が無い・接続が切れた）。黙って何も出さないより、
			// 従来どおりダイアログを開いて選ばせたほうが利用者は先へ進める
			break;
		}
		// 「別のフォルダを開く...」。選び直さなかった場合は同じ起点のまま一覧へ戻す
		const picked = await browseForFolders(context, scheme, false);
		if (picked.length > 0) {
			root = picked[0];
			// 次からはここを最初に開く（置き場所を毎回選び直させない）
			context.storageService.store(SCAN_ROOT_STORAGE_KEY, root.toString(), StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}
	return browseForFolders(context, scheme, true);
}

/**
 * 一覧の起点を決める。リポジトリをどこに置くかは人それぞれなので、設定を決め打ちで使わず、
 * その人が実際に使っている場所から順に当たる:
 *
 *  1. 前回この画面で開いていたフォルダ
 *  2. 登録済みリポジトリの親フォルダで最も多いもの（`~/work` に5個あるならそこ）
 *  3. クローン先設定（既定 `~/github`）
 *
 * どれも無ければ起点を持たない（呼び出し側が従来のダイアログへ落とす）。
 *
 * どの候補も「いま選ばせようとしているマシン」のものだけを採る。手元と接続先で同じパスが
 * ありうるので、scheme と authority まで見ないと相手側のフォルダを並べてしまう。
 */
async function resolveScanRoot(context: IParadisLocalRepositoryPickContext, scheme: string | undefined): Promise<URI | undefined> {
	const userHome = scheme === Schemas.file
		? context.pathService.userHome({ preferLocal: true })
		: await context.pathService.userHome();
	const isSameMachine = (resource: URI) => resource.scheme === userHome.scheme && resource.authority === userHome.authority;

	const remembered = context.storageService.get(SCAN_ROOT_STORAGE_KEY, StorageScope.PROFILE);
	if (remembered) {
		try {
			const uri = URI.parse(remembered);
			if (isSameMachine(uri)) {
				return uri;
			}
		} catch (error) {
			context.logService.warn('[ParadisPickLocalRepositories] discarding a broken saved root', remembered, error);
		}
	}

	return mostCommonRepositoryParent(context, isSameMachine) ?? configuredCloneParent(context, userHome);
}

/** 登録済みリポジトリが最も多く置かれている親フォルダ。1つも無ければ undefined。 */
function mostCommonRepositoryParent(context: IParadisLocalRepositoryPickContext, isSameMachine: (resource: URI) => boolean): URI | undefined {
	const counts = new Map<string, { readonly uri: URI; count: number }>();
	for (const repository of context.switchService.repositories) {
		if (!isSameMachine(repository.uri)) {
			continue;
		}
		const parent = dirname(repository.uri);
		const entry = counts.get(parent.toString());
		if (entry) {
			entry.count++;
		} else {
			counts.set(parent.toString(), { uri: parent, count: 1 });
		}
	}
	let best: { readonly uri: URI; count: number } | undefined;
	for (const entry of counts.values()) {
		if (!best || entry.count > best.count) {
			best = entry;
		}
	}
	return best?.uri;
}

/** クローン先設定。空（毎回確認）に設定されている場合は undefined。 */
function configuredCloneParent(context: IParadisLocalRepositoryPickContext, userHome: URI): URI | undefined {
	const raw = context.configurationService.getValue<unknown>(PARADIS_CLONE_PARENT_DIR_SETTING);
	const trimmed = typeof raw === 'string' ? raw.trim() : '';
	if (!trimmed) {
		return undefined;
	}
	if (trimmed === '~') {
		return userHome;
	}
	if (trimmed.startsWith('~/')) {
		return joinPath(userHome, trimmed.substring(2));
	}
	return paradisResolveExternalPath(userHome, trimmed) ?? URI.file(trimmed);
}

/**
 * 起点の直下にあるフォルダを集める。起点が読めない場合は undefined。
 *
 * 接続先だと `.git` の確認が1件ずつ往復するため、途中で打ち切れるよう小分けにして
 * トークンを見る（一覧を閉じたのに往復を続けない）。
 */
async function scanFolders(context: IParadisLocalRepositoryPickContext, root: URI, token: CancellationToken): Promise<IParadisFolderScan | undefined> {
	let children: readonly IFileStat[];
	let rootIsRepository = false;
	try {
		children = (await context.fileService.resolve(root)).children ?? [];
		rootIsRepository = await context.fileService.exists(joinPath(root, '.git'));
	} catch (error) {
		context.logService.warn('[ParadisPickLocalRepositories] cannot read the scan root', root.toString(), error);
		return undefined;
	}

	// ドットで始まるものは対象外。起点自体がリポジトリだったときの `.git` や、
	// 設定・キャッシュ置き場を混ぜても選ぶ意味がない
	const folders = children
		.filter(child => child.isDirectory && !basename(child.resource).startsWith('.'))
		.sort((a, b) => basename(a.resource).localeCompare(basename(b.resource)));

	const isRegistered = (resource: URI) => context.switchService.repositories.some(repository => isEqual(repository.uri, resource));
	// 数が多いと待たせるだけなので、そのときは Git 判定をやめて全部並べる
	if (folders.length > MAX_GIT_PROBE_ENTRIES) {
		return {
			rootIsRepository,
			probed: false,
			entries: folders.map(folder => ({ uri: folder.resource, isRepository: false, registered: isRegistered(folder.resource) }))
		};
	}

	const entries: IParadisFolderEntry[] = [];
	for (let index = 0; index < folders.length; index += GIT_PROBE_BATCH_SIZE) {
		if (token.isCancellationRequested) {
			return undefined;
		}
		const batch = folders.slice(index, index + GIT_PROBE_BATCH_SIZE);
		entries.push(...await Promise.all(batch.map(async folder => ({
			uri: folder.resource,
			// `.git` はディレクトリとは限らない（worktree では親を指すファイル）ので存在だけを見る
			isRepository: await context.fileService.exists(joinPath(folder.resource, '.git')),
			registered: isRegistered(folder.resource)
		}))));
	}
	return { entries, probed: true, rootIsRepository };
}

/**
 * チェックボックス付きの一覧を出す。走査は一覧を出してから行う（接続先だと時間がかかるので、
 * 何も出ないまま待たせない）。
 */
function showFolderPick(context: IParadisLocalRepositoryPickContext, root: URI): Promise<ParadisFolderPickResult> {
	const browseButton = {
		iconClass: ThemeIcon.asClassName(Codicon.folderOpened),
		// allow-any-unicode-next-line
		tooltip: localize('paradis.pickLocalRepositories.browse', "別のフォルダを開く...")
	};
	const disposables = new DisposableStore();
	return new Promise<ParadisFolderPickResult>(resolve => {
		const quickPick = disposables.add(context.quickInputService.createQuickPick<IParadisFolderPickItem>({ useSeparators: true }));
		quickPick.canSelectMany = true;
		// 打ち込んで絞り込むとスコア順に並び替わり、「Git リポジトリ／それ以外」の節が意味を失う
		quickPick.sortByLabel = false;
		quickPick.buttons = [browseButton];
		// allow-any-unicode-next-line
		quickPick.title = localize('paradis.pickLocalRepositories.title', "追加するフォルダを選択 — {0}", displayPath(root));
		// allow-any-unicode-next-line
		quickPick.placeholder = localize('paradis.pickLocalRepositories.scanning', "フォルダを調べています...");
		quickPick.busy = true;

		const scanTokenSource = disposables.add(new CancellationTokenSource());
		disposables.add(quickPick.onDidTriggerButton(() => {
			resolve({ kind: 'browse' });
			quickPick.hide();
		}));
		disposables.add(quickPick.onDidAccept(() => {
			// VS Code 標準に合わせ、チェックした行だけを採る（canSelectMany では
			// 合わせている行を暗黙に選ばない）
			if (quickPick.selectedItems.length === 0) {
				return;
			}
			resolve({ kind: 'picked', uris: quickPick.selectedItems.map(item => item.uri) });
			quickPick.hide();
		}));
		disposables.add(quickPick.onDidHide(() => {
			// 選択・ボタンで既に resolve 済みなら、この resolve は無視される
			resolve({ kind: 'cancelled' });
			disposables.dispose();
		}));

		quickPick.show();

		void (async () => {
			const scan = await scanFolders(context, root, scanTokenSource.token);
			if (scanTokenSource.token.isCancellationRequested) {
				return;
			}
			if (!scan) {
				resolve({ kind: 'unreadable' });
				quickPick.hide();
				return;
			}
			quickPick.busy = false;
			quickPick.items = toItems(root, scan);
			quickPick.placeholder = quickPick.items.length === 0
				// allow-any-unicode-next-line
				? localize('paradis.pickLocalRepositories.empty', "このフォルダの直下にフォルダがありません。右上のボタンから別のフォルダを開いてください")
				// allow-any-unicode-next-line
				: localize('paradis.pickLocalRepositories.placeholder', "追加するフォルダをチェックしてください（複数可）");
		})();
	});
}

function toItems(root: URI, scan: IParadisFolderScan): (IParadisFolderPickItem | IQuickPickSeparator)[] {
	const toItem = (entry: IParadisFolderEntry): IParadisFolderPickItem => ({
		uri: entry.uri,
		label: basename(entry.uri),
		// allow-any-unicode-next-line
		...(entry.registered ? { description: localize('paradis.pickLocalRepositories.registered', "追加済み") } : {})
	});

	const items: (IParadisFolderPickItem | IQuickPickSeparator)[] = [];
	// 起点そのものがリポジトリのことがある（「別のフォルダを開く...」でリポジトリ本体を
	// 選んだ場合）。中身だけ並べても目当てのものが出てこないので、自分自身も選べるようにする
	if (scan.rootIsRepository) {
		items.push({
			uri: root,
			label: basename(root),
			// allow-any-unicode-next-line
			description: localize('paradis.pickLocalRepositories.rootItself', "このフォルダ自身")
		});
	}

	if (!scan.probed) {
		// 数が多すぎて Git リポジトリかどうかを確かめていない。節を分けると
		// 「リポジトリではない」と判定したように見えてしまうので、まとめて出す
		// allow-any-unicode-next-line
		items.push({ type: 'separator', label: localize('paradis.pickLocalRepositories.allFolders', "フォルダ（数が多いため Git リポジトリかどうかは調べていません）") });
		items.push(...scan.entries.map(toItem));
		return items;
	}

	const repositories = scan.entries.filter(entry => entry.isRepository);
	const others = scan.entries.filter(entry => !entry.isRepository);
	if (repositories.length > 0) {
		// allow-any-unicode-next-line
		items.push({ type: 'separator', label: localize('paradis.pickLocalRepositories.repositories', "Git リポジトリ") });
		items.push(...repositories.map(toItem));
	}
	if (others.length > 0) {
		// allow-any-unicode-next-line
		items.push({ type: 'separator', label: localize('paradis.pickLocalRepositories.others', "Git リポジトリではないフォルダ") });
		items.push(...others.map(toItem));
	}
	return items;
}

/** 従来の OS のフォルダ選択ダイアログ。一覧の起点を選び直すときと、起点を持てないときに使う。 */
async function browseForFolders(context: IParadisLocalRepositoryPickContext, scheme: string | undefined, canSelectMany: boolean): Promise<readonly URI[]> {
	const uris = await context.fileDialogService.showOpenDialog({
		title: canSelectMany
			// allow-any-unicode-next-line
			? localize('paradis.workspaceSwitch.addRepositoryDialog', "リポジトリを追加")
			// allow-any-unicode-next-line
			: localize('paradis.pickLocalRepositories.browseTitle', "一覧するフォルダを選択"),
		openLabel: canSelectMany
			// allow-any-unicode-next-line
			? localize('paradis.workspaceSwitch.addRepositoryLabel', "追加")
			// allow-any-unicode-next-line
			: localize('paradis.pickLocalRepositories.browseLabel', "このフォルダを一覧"),
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany,
		// 接続中はダイアログが既定で接続先を見る。どちらを開くかを呼び出し側が決められるようにして、
		// 「このPCのフォルダ」と「接続先のフォルダ」を別々の項目として出せるようにする
		...(scheme !== undefined ? { availableFileSystems: [scheme] } : {})
	});
	return uris ?? [];
}

/**
 * 画面に出すパス。接続先のパスは fsPath に通すと Windows 側の区切りに化けるので path を使う。
 *
 * 表示専用だが、綴りの規則そのものは `paradisHostPathFor` に一本化してある（規則を手書きで
 * 複製しないため）。`vscode-vfs:` 等どちらのマシンとも確証が持てないものも一覧には出したいので、
 * ここでは `paradisResolveHostPath` ではなく scheme から直接ホストを決める。
 */
function displayPath(uri: URI): string {
	return paradisHostPathFor(uri, uri.scheme === Schemas.file ? 'local' : 'remote');
}
