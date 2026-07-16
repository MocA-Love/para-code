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
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';

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

	/** リポジトリID → .git/worktrees 監視の disposable */
	private readonly _watchers = this._register(new DisposableMap<string>());

	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => this.refresh(), 500));

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this._known = this.loadKnown();
		this._order = this.loadOrder();
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

	private async refresh(): Promise<void> {
		const autoImport = this.configurationService.getValue<boolean>('paradis.workspaceSwitch.autoImportWorktrees') !== false;
		const autoRemove = this.configurationService.getValue<boolean>('paradis.workspaceSwitch.autoRemoveMissingWorktrees') !== false;

		const repositories = this.workspaceSwitchService.repositories;
		const result = new Map<string, IParadisWorktree[]>();
		const detectedWorktrees = new Map<string, IParadisWorktree[]>();
		const branches = new Map<string, string>();
		let knownChanged = false;
		const retiredStateKeys = new Set<string>();

		for (const repository of repositories) {
			const branch = await this.readRepositoryBranch(repository);
			if (branch !== undefined) {
				branches.set(repository.id, branch);
			}
			const scanned = await this.scanWorktrees(repository);
			detectedWorktrees.set(repository.id, scanned);
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
					const missingStateKey = paradisWorktreeStateKey(URI.parse(known.path));
					const hasRetirementData = autoRemove ? await this.workspaceSwitchService.hasScopeRetirementData(missingStateKey) : false;
					if (paradisShouldAutoRetireMissingWorktree(autoRemove, hasRetirementData, this.workspaceSwitchService.activeStateKey === missingStateKey)) {
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
			if (await this.workspaceSwitchService.hasScopeRetirementData(stateKey)) {
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
		this.acknowledgeAbsentCommittedRetirements();
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

	private async scanWorktrees(repository: IParadisWorkspaceRepository): Promise<IParadisWorktree[]> {
		const result: IParadisWorktree[] = [];
		try {
			const worktreesDir = joinPath(repository.uri, '.git', 'worktrees');
			const stat = await this.fileService.resolve(worktreesDir);
			for (const child of stat.children ?? []) {
				if (!child.isDirectory) {
					continue;
				}
				try {
					// gitdir の中身は "<worktree>/.git"。upstream (getWorktreesFS) と同じく
					// /.git 以降を除去して作業ツリーパスを復元する
					const gitdirContent = (await this.fileService.readFile(joinPath(child.resource, 'gitdir'))).value.toString().trim();
					const worktreePath = gitdirContent.replace(/\/\.git.*$/, '');
					const uri = URI.file(worktreePath);
					if (!(await this.fileService.exists(uri))) {
						continue; // prune 可能な残骸
					}

					let branch: string | undefined;
					try {
						const head = (await this.fileService.readFile(joinPath(child.resource, 'HEAD'))).value.toString().trim();
						branch = head.startsWith('ref: refs/heads/') ? head.substring('ref: refs/heads/'.length) : head.substring(0, 8);
					} catch {
						// HEAD 未書込みは branch なしで続行
					}

					result.push({ repositoryId: repository.id, name: basename(uri), branch, uri });
				} catch {
					// worktree 作成直後で gitdir 未書込み等はスキップ (upstream 同様)
				}
			}
		} catch {
			// .git/worktrees が存在しない (worktree なし)
		}
		return result;
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
}
