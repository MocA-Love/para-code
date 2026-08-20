/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisResolveExternalPath, paradisWorktreePathFromGitdir } from '../../../common/paradisPathUri.js';
import { paradisIsOrphanTerminalRevivalComplete } from './paradisTerminalEditorPark.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import { PARADIS_PINNED_WORKTREES_STORAGE_KEY, paradisParsePinnedWorktreeKeys, paradisRemoveStaleIds, paradisSerializePinnedWorktreeKeys } from '../common/paradisWorkspaceTreeState.js';

/**
 * 1リポジトリ分のスキャン結果。
 *
 * `complete` が false のときは「worktree が無かった」ではなく「読めなかった」。接続先の
 * ファイルシステムは接続断・再接続中・サーバー再起動で普通に失敗するので、この2つを
 * 混同すると、つないでいないあいだに既知の worktree を「消えた」と判定して台帳から削ってしまう。
 */
interface IParadisWorktreeScan {
	readonly worktrees: IParadisWorktree[];
	readonly complete: boolean;
}

interface ISerializedKnownWorktree {
	readonly repositoryId: string;
	/** worktree ディレクトリの URI 文字列 */
	readonly path: string;
	readonly name: string;
}

/** Auto-removal is safe only for an inactive missing worktree with no retained scope data. */
export function paradisShouldAutoRetireMissingWorktree(autoRemove: boolean, hasRetirementData: boolean, isActive: boolean): boolean {
	return autoRemove && !hasRetirementData && !isActive;
}

/** Keeps the durable known-worktree entry reachable until all scoped state was retired. */
export async function paradisDiscardScopeBeforeRemovingKnownWorktree(discardScope: () => Promise<boolean>, removeKnown: () => void): Promise<boolean> {
	if (!await discardScope()) {
		return false;
	}
	removeKnown();
	return true;
}

/**
 * IParadisWorktreeService の実装。
 *
 * `git worktree list` は呼ばず、upstream の git 拡張 (extensions/git/src/git.ts の
 * getWorktreesFS) と同じアルゴリズムで `<repo>/.git/worktrees/<name>/gitdir` を直接読む。
 * `.git/worktrees` を correlated watcher で監視し、worktree の作成/削除に自動追従する。
 *
 * 自動反映は Para Code 設定で制御できる:
 * - `paradis.workspaceSwitch.autoImportWorktrees`: 新しく検出した worktree をリストへ自動追加
 * - `paradis.workspaceSwitch.autoRemoveMissingWorktrees`: 消えた worktree をリストから自動削除
 *   (OFF の場合は missing フラグ付きで残り、手動で removeKnownWorktree できる)
 * 既知リストは WORKSPACE スコープ storage に永続化する。
 */
export class ParadisWorktreeService extends Disposable implements IParadisWorktreeService {

	declare readonly _serviceBrand: undefined;
	readonly initializationBarrier: Promise<void>;

	private static readonly KNOWN_WORKTREES_STORAGE_KEY = 'paradis.workspaceSwitch.knownWorktrees';
	private static readonly WORKTREE_ORDER_STORAGE_KEY = 'paradis.workspaceSwitch.worktreeOrder';

	private readonly _onDidChangeWorktrees = this._register(new Emitter<void>());
	readonly onDidChangeWorktrees = this._onDidChangeWorktrees.event;

	private _worktrees = new Map<string, IParadisWorktree[]>();
	private _detectedWorktrees = new Map<string, IParadisWorktree[]>();
	/** リポジトリID → main checkout のブランチ名 (.git/HEAD 由来) */
	private _branches = new Map<string, string>();
	private _known: ISerializedKnownWorktree[];
	/** リポジトリID → 表示順 (worktree の uri.toString() の配列)。手動並び替え (Move Up/Down) で更新される */
	private _order: Map<string, string[]>;
	/** ピン留めされた状態キー (リポジトリ本体は repositoryId、worktree は worktree:<uri>)。 */
	private _pinned: Set<string>;

	/** リポジトリID → .git/worktrees 監視の disposable */
	private readonly _watchers = this._register(new DisposableMap<string>());

	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => this.refresh(), 500));

	/** 初回 refresh を終えたか。起動直後は端末の復元前なので missing の自動退役を見送る。 */
	private _initialRefreshDone = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._known = this.loadKnown();
		this._order = this.loadOrder();
		this._pinned = paradisParsePinnedWorktreeKeys(this.storageService.get(PARADIS_PINNED_WORKTREES_STORAGE_KEY, StorageScope.WORKSPACE));
		const recoveredStateKeys = new Set(this.workspaceSwitchService.pendingCommittedRetirementStateKeys);
		if (recoveredStateKeys.size > 0) {
			const previousLength = this._known.length;
			this._known = this._known.filter(known => !recoveredStateKeys.has(paradisWorktreeStateKey(URI.parse(known.path))));
			if (this._known.length !== previousLength) {
				this.saveKnown();
			}
			for (const stateKey of recoveredStateKeys) {
				this.workspaceSwitchService.acknowledgeScopeRetirement(stateKey);
			}
		}

		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => {
			this.installWatchers();
			this.pruneOrderForRemovedRepositories();
			this._refreshScheduler.schedule();
		}));
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this._refreshScheduler.schedule()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('paradis.workspaceSwitch')) {
				this._refreshScheduler.schedule();
			}
		}));

		this.installWatchers();
		this.initializationBarrier = this.refresh();
	}

	getWorktrees(repositoryId: string): readonly IParadisWorktree[] {
		return this._worktrees.get(repositoryId) ?? [];
	}

	getDetectedWorktrees(repositoryId: string): readonly IParadisWorktree[] {
		return this._detectedWorktrees.get(repositoryId) ?? [];
	}

	getKnownWorktreeStateKeys(repositoryId: string): readonly string[] {
		return this._known
			.filter(known => known.repositoryId === repositoryId)
			.map(known => paradisWorktreeStateKey(URI.parse(known.path)));
	}

	getRepositoryBranch(repositoryId: string): string | undefined {
		return this._branches.get(repositoryId);
	}

	addKnownWorktree(worktree: IParadisWorktree): void {
		const path = worktree.uri.toString();
		const index = this._known.findIndex(known => known.repositoryId === worktree.repositoryId && known.path === path);
		if (index >= 0) {
			this._known[index] = { repositoryId: worktree.repositoryId, path, name: worktree.name };
		} else {
			this._known.push({ repositoryId: worktree.repositoryId, path, name: worktree.name });
		}
		this.saveKnown();
		this._refreshScheduler.schedule();
	}

	async removeKnownWorktree(worktree: IParadisWorktree): Promise<boolean> {
		const before = this._known.length;
		if (!this._known.some(known => known.repositoryId === worktree.repositoryId && known.path === worktree.uri.toString())) {
			return false;
		}

		const stateKey = paradisWorktreeStateKey(worktree.uri);
		if (this.workspaceSwitchService.activeStateKey === stateKey) {
			await this.workspaceSwitchService.switchRepository(worktree.repositoryId);
		}
		if (!await this.workspaceSwitchService.discardScopeState(stateKey)) {
			return false;
		}

		this._known = this._known.filter(known => !(known.repositoryId === worktree.repositoryId && known.path === worktree.uri.toString()));
		if (this._known.length !== before) {
			// この worktree の切り替えスコープ状態 (working set / パネル / SCM入力 / park 中ターミナル)
			// を破棄する。二度と開かれないキーの状態が WORKSPACE ストレージに残り続けるのを防ぐ。
			this.saveKnown();
			this.workspaceSwitchService.acknowledgeScopeRetirement(stateKey);
			this._refreshScheduler.schedule();
		}
		// 手動並び順からも消しておく (残っても末尾フォールバックで無害だが、蓄積を防ぐ)
		const order = this._order.get(worktree.repositoryId);
		if (order?.includes(worktree.uri.toString())) {
			this._order.set(worktree.repositoryId, order.filter(uri => uri !== worktree.uri.toString()));
			this.saveOrder();
		}
		return true;
	}

	setWorktreeOrder(repositoryId: string, orderedUris: readonly string[]): void {
		this._order.set(repositoryId, [...orderedUris]);
		this.saveOrder();
		this._refreshScheduler.schedule();
	}

	isPinned(stateKey: string): boolean {
		return this._pinned.has(stateKey);
	}

	setPinned(stateKey: string, pinned: boolean): void {
		if (pinned) {
			if (this._pinned.has(stateKey)) {
				return;
			}
			this._pinned.add(stateKey);
		} else if (!this._pinned.delete(stateKey)) {
			return;
		}
		this.savePinned();
		// 一覧の見え方だけが変わるので、ディスク再スキャン (refresh) は挟まず即座に通知する
		this._onDidChangeWorktrees.fire();
	}

	/** リポジトリ一覧から消えた repositoryId の手動並び順を掃除する (ストレージ肥大化防止) */
	private pruneOrderForRemovedRepositories(): void {
		const alive = new Set(this.workspaceSwitchService.repositories.map(repository => repository.id));
		let changed = false;
		for (const repositoryId of [...this._order.keys()]) {
			if (!alive.has(repositoryId)) {
				this._order.delete(repositoryId);
				changed = true;
			}
		}
		if (changed) {
			this.saveOrder();
		}
	}

	private installWatchers(): void {
		const seen = new Set<string>();
		for (const repository of this.workspaceSwitchService.repositories) {
			seen.add(repository.id);
			if (this._watchers.has(repository.id)) {
				continue;
			}

			const gitDir = joinPath(repository.uri, '.git');
			const worktreesDir = joinPath(gitDir, 'worktrees');
			const store = new DisposableStore();
			// worktree の追加/削除 (= worktrees/ 直下のディレクトリ増減) を監視。
			// correlated watcher は非再帰限定なので、worktrees/ 自体の作成/削除は
			// 親の .git/ の監視で拾う
			const worktreesWatcher = this.fileService.createWatcher(worktreesDir, { recursive: false, excludes: [] });
			store.add(worktreesWatcher);
			store.add(worktreesWatcher.onDidChange(() => this._refreshScheduler.schedule()));
			const headFile = joinPath(gitDir, 'HEAD');
			const gitDirWatcher = this.fileService.createWatcher(gitDir, { recursive: false, excludes: [] });
			store.add(gitDirWatcher);
			store.add(gitDirWatcher.onDidChange(e => {
				// worktrees/ の増減に加え、main checkout のブランチ切り替え (.git/HEAD) にも追従する
				if (e.affects(worktreesDir) || e.affects(headFile)) {
					this._refreshScheduler.schedule();
				}
			}));
			this._watchers.set(repository.id, store);
		}

		// 登録解除されたリポジトリの監視を破棄
		for (const key of [...this._watchers.keys()]) {
			if (!seen.has(key)) {
				this._watchers.deleteAndDispose(key);
			}
		}
	}

	/**
	 * 初期化バリアとスケジューラの両方がこれを await する。ここで例外を漏らすと
	 * `initializationBarrier` が reject し、購読側の成功ハンドラが丸ごと飛ぶ
	 * (端末スコープの隔離マッピングが採用されないまま残り、その端末はスコープ無しになる)。
	 * 購読側は失敗をログに出すだけで回復しないので、ここで必ず正常終了させる。
	 */
	private async refresh(): Promise<void> {
		try {
			await this.doRefresh();
		} catch (error) {
			this.logService.error('[ParadisWorktreeService] refresh failed', error);
		}
	}

	private async doRefresh(): Promise<void> {
		const autoImport = this.configurationService.getValue<boolean>('paradis.workspaceSwitch.autoImportWorktrees') !== false;
		const autoRemove = this.configurationService.getValue<boolean>('paradis.workspaceSwitch.autoRemoveMissingWorktrees') !== false;
		// 起動直後は端末の復元がまだ走っておらず、park 台帳も working set も空なので
		// 「退避データ無し」と誤判定する。ここで自動退役させると、直後に復元される端末が
		// 到達不能な stateKey に取り残される。復元が一巡するまで missing の退役は見送り、
		// 見送った分は次の refresh で判定する
		const canAutoRetire = this._initialRefreshDone && paradisIsOrphanTerminalRevivalComplete();

		const repositories = this.workspaceSwitchService.repositories;
		const result = new Map<string, IParadisWorktree[]>();
		const detectedWorktrees = new Map<string, IParadisWorktree[]>();
		const branches = new Map<string, string>();
		let knownChanged = false;
		const retiredStateKeys = new Set<string>();

		for (const repository of repositories) {
			const scan = await this.scanWorktrees(repository);
			const scanned = scan.worktrees;
			// .git を読めなかった回は、ブランチ名も「無い」ではなく「分からない」。前回の値を
			// 引き継がないと、接続が不安定なあいだブランチ表示だけが点滅する
			const branch = await this.readRepositoryBranch(repository) ?? (scan.complete ? undefined : this._branches.get(repository.id));
			if (branch !== undefined) {
				branches.set(repository.id, branch);
			}
			// 読めなかった回の欠けた一覧で上書きすると、名前解決 (paradisWorktreeStateKey の逆引き)
			// まで一時的に外れる。前回の見え方を残す
			detectedWorktrees.set(repository.id, scan.complete ? scanned : (this._detectedWorktrees.get(repository.id) ?? scanned));
			const scannedPaths = new Set(scanned.map(worktree => worktree.uri.toString()));
			const knownForRepository = this._known.filter(known => known.repositoryId === repository.id);
			const list: IParadisWorktree[] = [];

			// ディスク上に存在するもの: 既知なら常に表示、新規は autoImport 時のみ追加
			for (const worktree of scanned) {
				const known = knownForRepository.find(known => known.path === worktree.uri.toString());
				if (known || autoImport) {
					list.push(known ? { ...worktree, name: known.name } : worktree);
					if (!known) {
						this._known.push({ repositoryId: repository.id, path: worktree.uri.toString(), name: worktree.name });
						knownChanged = true;
					}
				}
			}

			// 既知だがディスクから消えたもの: autoRemove ならリストから外し、
			// OFF なら missing として残す (手動 removeKnownWorktree 可能)
			for (const known of knownForRepository) {
				if (!scannedPaths.has(known.path)) {
					if (!scan.complete) {
						// ディスクを読めていないので「消えた」とは言えない。missing にすると
						// switchToWorktree も弾かれるため、前回どおり使える扱いで残す。
						// ブランチ名も前回の値を引き継ぐ (読めない間だけ表示が消えるのを防ぐ)
						const previous = this._worktrees.get(repository.id)?.find(worktree => worktree.uri.toString() === known.path);
						list.push({ repositoryId: repository.id, name: known.name, uri: URI.parse(known.path), branch: previous?.branch });
						continue;
					}
					const missingStateKey = paradisWorktreeStateKey(URI.parse(known.path));
					const hasRetirementData = autoRemove ? await this.workspaceSwitchService.hasScopeRetirementData(missingStateKey) : false;
					if (canAutoRetire && paradisShouldAutoRetireMissingWorktree(autoRemove, hasRetirementData, this.workspaceSwitchService.activeStateKey === missingStateKey)) {
						const removed = await paradisDiscardScopeBeforeRemovingKnownWorktree(
							() => this.workspaceSwitchService.discardScopeState(missingStateKey),
							() => { this._known = this._known.filter(candidate => candidate !== known); }
						);
						if (removed) {
							knownChanged = true;
							retiredStateKeys.add(missingStateKey);
						} else {
							list.push({ repositoryId: repository.id, name: known.name, uri: URI.parse(known.path), missing: true });
						}
					} else {
						list.push({ repositoryId: repository.id, name: known.name, uri: URI.parse(known.path), missing: true });
					}
				}
			}

			const order = this._order.get(repository.id);
			const orderIndex = new Map((order ?? []).map((uri, index) => [uri, index]));
			list.sort((a, b) => {
				const indexA = orderIndex.get(a.uri.toString()) ?? Number.MAX_SAFE_INTEGER;
				const indexB = orderIndex.get(b.uri.toString()) ?? Number.MAX_SAFE_INTEGER;
				return indexA !== indexB ? indexA - indexB : a.name.localeCompare(b.name);
			});
			result.set(repository.id, list);
		}

		// 登録解除されたリポジトリの既知エントリを掃除 (親リポジトリごと消えた worktree も
		// スコープ状態を破棄する。リポジトリ削除で連鎖的に到達不能になるため)
		const repositoryIds = new Set(repositories.map(repository => repository.id));
		const orphanedKnown = this._known.filter(known => !repositoryIds.has(known.repositoryId));
		for (const known of orphanedKnown) {
			const stateKey = paradisWorktreeStateKey(URI.parse(known.path));
			if (!canAutoRetire || await this.workspaceSwitchService.hasScopeRetirementData(stateKey)) {
				continue;
			}
			if (await paradisDiscardScopeBeforeRemovingKnownWorktree(
				() => this.workspaceSwitchService.discardScopeState(stateKey),
				() => { this._known = this._known.filter(candidate => candidate !== known); }
			)) {
				knownChanged = true;
				retiredStateKeys.add(stateKey);
			}
		}

		if (knownChanged) {
			this.saveKnown();
			for (const stateKey of retiredStateKeys) {
				this.workspaceSwitchService.acknowledgeScopeRetirement(stateKey);
			}
		}
		this._worktrees = result;
		this._detectedWorktrees = detectedWorktrees;
		this._branches = branches;
		this.pruneStalePinned();
		this.acknowledgeAbsentCommittedRetirements();
		// 冒頭ではなくここで立てる。初回が await 中に2本目が走っても、初回の完了までは
		// 「起動直後」として扱いたいため
		this._initialRefreshDone = true;
		this._onDidChangeWorktrees.fire();
	}

	private acknowledgeAbsentCommittedRetirements(): void {
		const knownStateKeys = new Set(this._known.map(known => paradisWorktreeStateKey(URI.parse(known.path))));
		for (const stateKey of this.workspaceSwitchService.pendingCommittedRetirementStateKeys) {
			if (!knownStateKeys.has(stateKey)) {
				this.workspaceSwitchService.acknowledgeScopeRetirement(stateKey);
			}
		}
	}

	/**
	 * リポジトリ本体 (main checkout) の `.git/HEAD` からブランチ名を読む。
	 * worktree の HEAD (.git/worktrees/<name>/HEAD) と同じパース。
	 * git 管理外や `.git` がファイル (このリポジトリ自体が worktree 等) の場合は undefined
	 */
	private async readRepositoryBranch(repository: IParadisWorkspaceRepository): Promise<string | undefined> {
		try {
			const head = (await this.fileService.readFile(joinPath(repository.uri, '.git', 'HEAD'))).value.toString().trim();
			return head.startsWith('ref: refs/heads/') ? head.substring('ref: refs/heads/'.length) : head.substring(0, 8);
		} catch {
			return undefined;
		}
	}

	/**
	 * 「無い」と言い切れる失敗か。それ以外 (接続断・サーバー再起動など) は結果を信用しない。
	 *
	 * FILE_NOT_DIRECTORY も「無い」側に入れる。リポジトリとして登録したものが worktree だと
	 * `.git` はディレクトリではなくファイルなので、`.git/worktrees` の解決はこちらで返る。
	 * ここを取りこぼすと恒久的に「読めなかった」扱いになり、自動 prune が二度と効かなくなる。
	 */
	private static isMissingError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false;
		}
		const result = toFileOperationResult(error);
		return result === FileOperationResult.FILE_NOT_FOUND || result === FileOperationResult.FILE_NOT_DIRECTORY;
	}

	/**
	 * 存在確認。判断できなかった場合は undefined を返す。
	 * `fileService.exists` は理由を問わず false になるため、接続断が「消えた」に化ける。
	 */
	private async probeExists(uri: URI): Promise<boolean | undefined> {
		try {
			await this.fileService.stat(uri);
			return true;
		} catch (error) {
			return ParadisWorktreeService.isMissingError(error) ? false : undefined;
		}
	}

	private async scanWorktrees(repository: IParadisWorkspaceRepository): Promise<IParadisWorktreeScan> {
		const result: IParadisWorktree[] = [];
		let complete = true;
		try {
			const worktreesDir = joinPath(repository.uri, '.git', 'worktrees');
			const stat = await this.fileService.resolve(worktreesDir);
			for (const child of stat.children ?? []) {
				if (!child.isDirectory) {
					continue;
				}
				try {
					// gitdir の中身は "<worktree>/.git"。末尾の /.git を落として作業ツリーパスを復元し、
					// リポジトリと同じ名前空間 (WSL を UNC で開いている場合やリモート) へ写す。
					// git 2.48 以降の worktree.useRelativePaths では相対パスが書かれ、その基準は
					// gitdir ファイルのあるディレクトリなので、リポジトリではなく child.resource を渡す
					const gitdirContent = (await this.fileService.readFile(joinPath(child.resource, 'gitdir'))).value.toString();
					const worktreePath = paradisWorktreePathFromGitdir(gitdirContent);
					const uri = worktreePath ? paradisResolveExternalPath(child.resource, worktreePath) : undefined;
					if (!uri) {
						// 破損した gitdir はそのまま埋めるとログ1行が肥大するので切り詰める
						this.logService.warn(`[ParadisWorktreeService] Could not resolve a worktree path against ${child.resource.toString()}: ${gitdirContent.trim().slice(0, 200)}`);
						continue;
					}
					const exists = await this.probeExists(uri);
					if (exists === undefined) {
						// 作業ツリーの在処を確かめられなかった。無いことにはできない
						complete = false;
						continue;
					}
					if (!exists) {
						// prune 可能な残骸。git worktree prune 前は毎 refresh で通る正常な状態なので
						// warn では騒がしすぎる。名前空間の取り違えを追うときだけ見られればよい
						this.logService.trace(`[ParadisWorktreeService] Resolved worktree does not exist: ${uri.toString()}`);
						continue;
					}

					let branch: string | undefined;
					try {
						const head = (await this.fileService.readFile(joinPath(child.resource, 'HEAD'))).value.toString().trim();
						branch = head.startsWith('ref: refs/heads/') ? head.substring('ref: refs/heads/'.length) : head.substring(0, 8);
					} catch {
						// HEAD 未書込みは branch なしで続行
					}

					result.push({ repositoryId: repository.id, name: basename(uri), branch, uri });
				} catch (error) {
					// worktree 作成直後で gitdir 未書込み等はスキップ (upstream 同様)。
					// 「無い」以外の理由で読めなかったなら、この回の結果は当てにしない
					if (!ParadisWorktreeService.isMissingError(error)) {
						complete = false;
					}
				}
			}
		} catch (error) {
			// .git/worktrees が存在しない (worktree なし)。それ以外は読めなかっただけ
			if (!ParadisWorktreeService.isMissingError(error)) {
				complete = false;
			}
		}
		return { worktrees: result, complete };
	}

	private loadKnown(): ISerializedKnownWorktree[] {
		const raw = this.storageService.get(ParadisWorktreeService.KNOWN_WORKTREES_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return [];
		}
		try {
			return JSON.parse(raw);
		} catch {
			return [];
		}
	}

	private saveKnown(): void {
		this.storageService.store(ParadisWorktreeService.KNOWN_WORKTREES_STORAGE_KEY, JSON.stringify(this._known), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private loadOrder(): Map<string, string[]> {
		const raw = this.storageService.get(ParadisWorktreeService.WORKTREE_ORDER_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return new Map();
		}
		try {
			const parsed: Record<string, string[]> = JSON.parse(raw);
			return new Map(Object.entries(parsed));
		} catch {
			return new Map();
		}
	}

	private saveOrder(): void {
		this.storageService.store(ParadisWorktreeService.WORKTREE_ORDER_STORAGE_KEY, JSON.stringify(Object.fromEntries(this._order)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private savePinned(): void {
		const serialized = paradisSerializePinnedWorktreeKeys(this._pinned);
		if (serialized === undefined) {
			// 上限超過。既存の保存内容をそのまま残す (collapsed 状態の永続化と同じ方針)
			return;
		}
		this.storageService.store(PARADIS_PINNED_WORKTREES_STORAGE_KEY, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/** 一覧から消えたリポジトリ/worktree のピン留めを落とす (到達不能なキーの蓄積を防ぐ)。 */
	private pruneStalePinned(): void {
		const live = new Set<string>();
		for (const [repositoryId, worktrees] of this._worktrees) {
			live.add(repositoryId);
			for (const worktree of worktrees) {
				live.add(paradisWorktreeStateKey(worktree.uri));
			}
		}
		if (paradisRemoveStaleIds(this._pinned, live)) {
			this.savePinned();
		}
	}
}
