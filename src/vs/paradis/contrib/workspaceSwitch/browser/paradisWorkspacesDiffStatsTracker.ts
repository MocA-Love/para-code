/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { combinedDisposable, Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileChangesEvent, IFileService } from '../../../../platform/files/common/files.js';
import { IParadisDiffStat } from '../common/paradisWorktreeCreate.js';

/**
 * 変更を検知できなかったときの保険。最後に取ってからこれより経った対象は、変更の知らせが無くても取り直す。
 */
export const PARADIS_DIFF_STATS_FALLBACK_MS = 300_000;

/**
 * git のメタデータの直下で、差分の数字が変わりうるときに書かれるファイル。
 * stage・commit・checkout・reset は `index` を、commit は `COMMIT_EDITMSG` を、checkout は `HEAD` を、
 * `git reset --soft` は `ORIG_HEAD` を書く（`index` は書かない）。worktree ではどれも `.git/worktrees/<name>/` の直下。
 * `FETCH_HEAD` や `index.lock` などでは取り直さない。
 */
const GIT_METADATA_FILES = new Set(['index', 'HEAD', 'COMMIT_EDITMSG', 'ORIG_HEAD']);

/** 差分を集計する対象 1 か所（リポジトリ本体か worktree）。 */
export interface IParadisDiffStatsTarget {
	readonly uri: URI;
	/** git のメタデータのディレクトリ（本体は `<repo>/.git`、worktree は `<repo>/.git/worktrees/<name>`）。分からなければ監視しない。 */
	readonly gitDir: URI | undefined;
}

type ParadisDiffStatsFileService = Pick<IFileService, 'createWatcher' | 'onDidFilesChange'>;

/**
 * Workspaces ビューの差分（+N/-N）を、変更があった対象だけ取り直すための台帳。
 *
 * 変更は次の既存の仕組みで知る。どれも新しく再帰の監視を張らない。
 * - 各対象の git のメタデータのディレクトリを非再帰で監視する（stage・commit・checkout）。
 * - ウィンドウが開いているフォルダーの既存の監視（`onDidFilesChange`）で、作業ツリーの編集を拾う。
 * - 呼び出し側が `markDirty` で知らせる（エージェントの状態の変化など）。
 * 拾えない変更（開いていないスペースでの、stage していない編集）は {@link PARADIS_DIFF_STATS_FALLBACK_MS} の保険で取り直す。
 *
 * リモート（SSH 先）でも、監視は URI のあるマシンの上で動くので同じように効く。
 */
export class ParadisWorkspacesDiffStatsTracker extends Disposable {
	private readonly targets = new ResourceMap<IParadisDiffStatsTarget>();
	private readonly watchers = this._register(new DisposableMap<string>());
	private readonly dirty = new ResourceMap<true>();
	private readonly lastFetchedAt = new ResourceMap<number>();
	private readonly fingerprints = new ResourceMap<string>();

	constructor(
		private readonly fileService: ParadisDiffStatsFileService,
		/** 対象に変更の印が付いたとき（取り直しの予約に使う）。 */
		private readonly onDidMarkDirty: () => void,
		private readonly now: () => number = Date.now,
	) {
		super();
		this._register(this.fileService.onDidFilesChange(e => this.handleWorkspaceFileChanges(e)));
	}

	/** 対象の一覧を差し替える。新しく出てきた対象には印を付け、消えた対象の監視と記録は捨てる。 */
	setTargets(targets: readonly IParadisDiffStatsTarget[]): void {
		const next = new ResourceMap<IParadisDiffStatsTarget>();
		for (const target of targets) {
			next.set(target.uri, target);
		}
		for (const uri of [...this.targets.keys()]) {
			if (!next.has(uri)) {
				this.targets.delete(uri);
				this.watchers.deleteAndDispose(uri.toString());
				this.dirty.delete(uri);
				this.lastFetchedAt.delete(uri);
				this.fingerprints.delete(uri);
			}
		}
		let added = false;
		for (const target of next.values()) {
			const previous = this.targets.get(target.uri);
			this.targets.set(target.uri, target);
			if (previous === undefined) {
				this.dirty.set(target.uri, true);
				added = true;
			}
			if (previous === undefined || previous.gitDir?.toString() !== target.gitDir?.toString()) {
				this.watchGitDir(target);
			}
		}
		if (added) {
			this.onDidMarkDirty();
		}
	}

	/** 対象に変更の印を付ける。一覧に無い対象は無視する。 */
	markDirty(uri: URI): void {
		if (!this.targets.has(uri)) {
			return;
		}
		this.dirty.set(uri, true);
		this.onDidMarkDirty();
	}

	/**
	 * 対象ごとの値（エージェントの状態など）を渡し、前回から変わった対象にだけ印を付ける。初めて見た値では付けない。
	 */
	markDirtyWhenChanged(uri: URI, fingerprint: string): void {
		if (!this.targets.has(uri)) {
			return;
		}
		const previous = this.fingerprints.get(uri);
		this.fingerprints.set(uri, fingerprint);
		if (previous !== undefined && previous !== fingerprint) {
			this.markDirty(uri);
		}
	}

	/** 今回取り直す対象（印の付いたものと、最後に取ってから保険の時間を過ぎたもの）を返し、印を外す。 */
	takeDueTargets(): URI[] {
		const now = this.now();
		const due: URI[] = [];
		for (const uri of this.targets.keys()) {
			const fetchedAt = this.lastFetchedAt.get(uri);
			if (this.dirty.has(uri) || fetchedAt === undefined || now - fetchedAt >= PARADIS_DIFF_STATS_FALLBACK_MS) {
				due.push(uri);
				this.dirty.delete(uri);
			}
		}
		return due;
	}

	/** 取り直しが終わった対象を記録する。 */
	markFetched(uris: readonly URI[]): void {
		const now = this.now();
		for (const uri of uris) {
			if (this.targets.has(uri)) {
				this.lastFetchedAt.set(uri, now);
			}
		}
	}

	/**
	 * 取り直しの結果を `stats`（`fsPath` → 差分）へ反映する。数えられた対象だけ上書きして取れたと記録し、
	 * 失敗した対象（`failed`）は前の値を残して印を付け直す。値が返らなかった対象は消す。
	 * 一覧から消えた対象の値も捨てる。`result` が無い（コマンド自体が失敗した）ときは全部を失敗として扱う。
	 */
	applyRefreshResult(targets: readonly URI[], result: Record<string, IParadisDiffStat> | undefined, stats: Map<string, IParadisDiffStat>): void {
		const fetched: URI[] = [];
		const failed: URI[] = [];
		for (const target of targets) {
			const stat = result?.[target.fsPath];
			if (result === undefined || stat?.failed) {
				failed.push(target);
				continue;
			}
			fetched.push(target);
			if (stat !== undefined) {
				stats.set(target.fsPath, stat);
			} else {
				stats.delete(target.fsPath);
			}
		}
		this.markFetched(fetched);
		this.restoreDirty(failed);
		const alive = new Set([...this.targets.keys()].map(uri => uri.fsPath));
		for (const path of [...stats.keys()]) {
			if (!alive.has(path)) {
				stats.delete(path);
			}
		}
	}

	/** 取り直しに失敗した対象へ印を付け直す（次の機会に取り直す。予約はしない）。 */
	restoreDirty(uris: readonly URI[]): void {
		for (const uri of uris) {
			if (this.targets.has(uri)) {
				this.dirty.set(uri, true);
			}
		}
	}

	private watchGitDir(target: IParadisDiffStatsTarget): void {
		const key = target.uri.toString();
		const gitDir = target.gitDir;
		if (gitDir === undefined) {
			this.watchers.deleteAndDispose(key);
			return;
		}
		const watcher = this.fileService.createWatcher(gitDir, { recursive: false, excludes: [] });
		const uri = target.uri;
		const metadataFiles = [...GIT_METADATA_FILES].map(name => joinPath(gitDir, name));
		const listener = watcher.onDidChange(e => {
			if (metadataFiles.some(file => e.contains(file))) {
				this.markDirty(uri);
			}
		});
		this.watchers.set(key, combinedDisposable(listener, watcher));
	}

	/** ウィンドウが開いているフォルダーの既存の監視から、どの対象の作業ツリーが変わったかを拾う。 */
	private handleWorkspaceFileChanges(e: FileChangesEvent): void {
		let changed = false;
		for (const uri of this.targets.keys()) {
			if (!this.dirty.has(uri) && e.affects(uri)) {
				this.dirty.set(uri, true);
				changed = true;
			}
		}
		if (changed) {
			this.onDidMarkDirty();
		}
	}
}

