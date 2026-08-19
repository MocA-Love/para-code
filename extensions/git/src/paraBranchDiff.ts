/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as path from 'path';
import { Disposable, Event, EventEmitter, l10n, LogOutputChannel, Uri, window, workspace } from 'vscode';
import type { Branch, Change, Ref } from './api/git';
import { RefType } from './api/git.constants';
import type { Model } from './model';
import type { Repository } from './repository';
import { dispose } from './util';

/**
 * Upper bound on the number of files reported for one branch. A branch that diverged by more than
 * this is not something anybody reviews in a tree, and building that many nodes would stall the
 * extension host on every status.
 */
const RESOURCE_LIMIT = 5000;

/**
 * What a branch changed since it forked off its base branch.
 */
export interface IParaBranchDiffState {
	/**
	 * The merge base the comparison runs against, and the human readable name of the branch that
	 * merge base was derived from. `commit` is deliberately not the tip of `label`: diffing against
	 * the tip would show other people's work as if this branch had reverted it once the base moved
	 * on.
	 */
	readonly base: { readonly commit: string; readonly label: string };
	readonly changes: readonly Change[];
	/** Set when the branch diverged by more than {@link RESOURCE_LIMIT} files. */
	readonly truncated: boolean;
}

/** Providers keyed by repository, so that the view and the commands can reach one. */
const providers = new WeakMap<Repository, ParaBranchDiffProvider>();

const _onDidChangeBranchDiff = new EventEmitter<Repository>();

/** Fires whenever the branch diff of a repository changed, was cleared, or failed to compute. */
export const onDidChangeBranchDiff: Event<Repository> = _onDidChangeBranchDiff.event;

/**
 * What `repository` changed since its branch forked off its base branch, or `undefined` when no
 * meaningful comparison exists right now.
 */
export function getBranchDiffState(repository: Repository): IParaBranchDiffState | undefined {
	// A parked repository belongs to another Para Code space. It keeps its last state around so
	// that unparking does not have to recompute from scratch, but nothing may read it meanwhile.
	if (!repository.scopeActive) {
		return undefined;
	}

	return providers.get(repository)?.state;
}

/** Drops every cached decision for `repository` and recomputes. */
export function refreshBranchDiff(repository: Repository): void {
	providers.get(repository)?.reset();
}

/**
 * Computes what the current branch accumulated since it forked off its base branch, i.e.
 * `git diff <merge-base>...HEAD`.
 *
 * The state is deliberately `undefined` — and the view therefore hidden — whenever a meaningful
 * comparison cannot be made:
 * - a merge, rebase or cherry-pick is in progress, where the merge base is in flux
 * - no base branch could be resolved
 * - the base branch is the branch's own upstream, in which case the branch was not forked off
 *   anything and the graph's incoming/outgoing already tells the story
 */
export class ParaBranchDiffProvider {

	private disposables: Disposable[] = [];

	private _state: IParaBranchDiffState | undefined;
	get state(): IParaBranchDiffState | undefined { return this._state; }

	/** Base branch resolved for {@link baseBranchHEAD}. Resolving it costs git calls, so it is cached. */
	private baseBranch: Branch | undefined;
	private baseBranchHEAD: string | undefined;
	private baseBranchRemoteRefs: string | undefined;

	/** Merge base resolved for a given (HEAD tip, base branch tip) pair. */
	private mergeBase: string | undefined;
	private mergeBaseKey: string | undefined;

	/** Identity of the last successfully computed diff, used to skip redundant git calls. */
	private lastKey: string | undefined;

	private running = false;
	private pending = false;
	private disposed = false;

	constructor(
		private readonly repository: Repository,
		private readonly logger: LogOutputChannel
	) {
		providers.set(repository, this);

		this.disposables.push(repository.onDidRunGitStatus(() => this.refresh()));
		this.disposables.push(workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('git.paraBranchDiff.enabled', Uri.file(repository.root))) {
				this.reset();
			}
		}));
	}

	/** Drops every cached decision and recomputes. Used when the user picks a different base branch. */
	reset(): void {
		this.baseBranch = undefined;
		this.baseBranchHEAD = undefined;
		this.baseBranchRemoteRefs = undefined;
		this.mergeBase = undefined;
		this.mergeBaseKey = undefined;
		this.lastKey = undefined;
		this.refresh();
	}

	private async refresh(): Promise<void> {
		if (this.disposed) {
			return;
		}

		if (this.running) {
			// A newer status arrived while we were computing. Run exactly once more afterwards
			// instead of queueing one run per event.
			this.pending = true;
			return;
		}

		this.running = true;
		try {
			do {
				this.pending = false;
				await this.doRefresh();
			} while (this.pending && !this.disposed);
		} finally {
			this.running = false;
		}
	}

	private setState(state: IParaBranchDiffState | undefined): void {
		this._state = state;
		_onDidChangeBranchDiff.fire(this.repository);
	}

	private async doRefresh(): Promise<void> {
		try {
			const state = await this.computeState();

			if (!state) {
				this.lastKey = undefined;
				if (this._state) {
					this.setState(undefined);
				}
				return;
			}

			if (state.key === this.lastKey) {
				return;
			}

			// Diffing against the merge base rather than the tip of the base branch, so that a base
			// branch which moved on since the fork does not show other people's work as if this
			// branch had reverted it. Note that this leaves out type changes, which git omits from
			// --diff-filter=ADMR.
			const all = await this.repository.diffBetween(state.baseCommit, 'HEAD');

			// Resolving the base branch and running the diff both take git processes, and the
			// repository can be parked or disposed while we wait.
			if (this.disposed || !this.repository.scopeActive) {
				this.lastKey = undefined;
				return;
			}

			const filtered = this.withoutSubmodules(all);

			if (filtered.length > RESOURCE_LIMIT) {
				this.logger.warn(`[ParaBranchDiffProvider][doRefresh] ${this.repository.root} differs from ${state.baseLabel} by ${filtered.length} files, showing the first ${RESOURCE_LIMIT}`);
			}

			if (filtered.length === 0) {
				// An empty `all` is ambiguous: the git layer turns a failed `git diff` into an empty
				// change list too, and remembering that would make a transient failure stick until a
				// tip moves — the view would silently stay gone. Rows that were all filtered out are
				// a different story: the diff demonstrably ran, so that answer is worth keeping.
				this.lastKey = all.length > 0 ? state.key : undefined;
				this.logger.trace(`[ParaBranchDiffProvider][doRefresh] ${this.repository.root} has nothing to show since ${state.baseLabel}`);
				if (this._state) {
					this.setState(undefined);
				}
				return;
			}

			this.lastKey = state.key;
			this.setState({
				base: { commit: state.baseCommit, label: state.baseLabel },
				changes: filtered.slice(0, RESOURCE_LIMIT),
				truncated: filtered.length > RESOURCE_LIMIT
			});
		} catch (err) {
			this.logger.warn(`[ParaBranchDiffProvider][doRefresh] Failed to compute branch diff for ${this.repository.root}: ${err}`);
			this.lastKey = undefined;
			if (this._state) {
				this.setState(undefined);
			}
		}
	}

	/**
	 * A gitlink that moved comes through as a plain modification of the submodule directory, which
	 * has no file content to diff against the base branch. The set only covers submodules the
	 * working tree still knows about, so one that the branch removed entirely can still slip
	 * through.
	 */
	private withoutSubmodules(changes: Change[]): Change[] {
		if (this.repository.submodules.length === 0) {
			return changes;
		}

		const paths = new Set(this.repository.submodules.map(submodule => path.join(this.repository.root, submodule.path)));
		return changes.filter(change => !paths.has(change.uri.fsPath) && !paths.has(change.originalUri.fsPath));
	}

	/**
	 * Resolves what the current branch should be compared against, or `undefined` when no
	 * meaningful comparison exists right now.
	 */
	private async computeState(): Promise<{ baseCommit: string; baseLabel: string; key: string } | undefined> {
		const config = workspace.getConfiguration('git', Uri.file(this.repository.root));
		if (!config.get<boolean>('paraBranchDiff.enabled', true)) {
			return undefined;
		}

		// Parked repositories belong to another Para Code space and are not being watched.
		if (!this.repository.scopeActive) {
			return undefined;
		}

		// While a merge, rebase or cherry-pick is unfinished the merge base moves under our feet
		// and HEAD is not the branch the user is building. Pause instead of showing a diff that
		// flips on every resolved conflict.
		if (this.repository.mergeInProgress || this.repository.rebaseCommit || this.repository.cherryPickInProgress) {
			return undefined;
		}

		const HEAD = this.repository.HEAD;
		if (HEAD?.type !== RefType.Head || !HEAD.name || !HEAD.commit) {
			return undefined;
		}

		const base = await this.resolveBaseBranch(HEAD.name);

		// Resolving the base branch runs git, and the repository can be parked while we wait.
		if (this.disposed || !this.repository.scopeActive) {
			return undefined;
		}

		if (!base?.name || !base.remote) {
			return undefined;
		}

		const baseLabel = `${base.remote}/${base.name}`;

		// The branch tracks the very branch we would compare it against, so it was not forked off
		// anything. This is the same call upstream's history provider makes for its base ref.
		if (HEAD.upstream && `${HEAD.upstream.remote}/${HEAD.upstream.name}` === baseLabel) {
			return undefined;
		}

		const baseRefEntry = this.repository.refs
			.find((ref: Ref) => ref.type === RefType.RemoteHead && ref.name === baseLabel);

		if (!baseRefEntry) {
			this.logger.trace(`[ParaBranchDiffProvider][computeState] ${this.repository.root} resolved ${baseLabel} as its base branch, but that ref is not available locally`);
			return undefined;
		}

		// The merge base is a pure function of the two tips, and this runs on every status, so it
		// is worth not spawning git for a pair we already resolved.
		const mergeBaseKey = `${HEAD.commit}\0${baseRefEntry.commit ?? ''}`;
		if (this.mergeBaseKey !== mergeBaseKey) {
			this.mergeBase = await this.repository.getMergeBase(baseLabel, 'HEAD');
			this.mergeBaseKey = mergeBaseKey;

			// Misses are remembered too. A repository that has no merge base at all (unrelated
			// histories, or a shallow clone that does not reach the fork point) would otherwise
			// spawn git on every status forever. The cost is that deepening such a clone is not
			// noticed until a tip moves or the user picks a base by hand.
			if (!this.mergeBase) {
				this.logger.trace(`[ParaBranchDiffProvider][computeState] ${this.repository.root} has no merge base between ${baseLabel} and HEAD`);
			}
		}

		const baseCommit = this.mergeBase;
		if (!baseCommit) {
			return undefined;
		}

		// HEAD is an ancestor of the base branch, so the branch has no commits of its own and the
		// diff is empty by definition. Answering here keeps the most common empty case — a branch
		// just created, or one already merged — from spawning a `git diff` on every status, which
		// it otherwise would because an empty diff is never remembered (see doRefresh).
		if (baseCommit === HEAD.commit) {
			return undefined;
		}

		// Keyed on the merge base rather than the base branch tip, so a fetch that only moves the
		// base branch forward does not make us diff again.
		return { baseCommit, baseLabel, key: `${HEAD.name}\0${HEAD.commit}\0${baseLabel}\0${baseCommit}` };
	}

	private async resolveBaseBranch(headName: string): Promise<Branch | undefined> {
		if (this.baseBranchHEAD === headName && this.baseBranch) {
			return this.baseBranch;
		}

		// Resolution usually fails because the base branch has not been fetched yet, or because
		// the clone has no remote HEAD to fall back on. Both are fixed by a fetch, so retry a
		// failed attempt whenever the remote branches changed — but not on every status.
		const remoteRefs = this.repository.refs
			.filter((ref: Ref) => ref.type === RefType.RemoteHead)
			.map((ref: Ref) => `${ref.name ?? ''}\0${ref.commit ?? ''}`)
			.sort()
			.join('\n');

		if (this.baseBranchHEAD === headName && this.baseBranchRemoteRefs === remoteRefs) {
			return undefined;
		}

		// Record the attempt before awaiting. getBranchBase() writes the resolved base back to the
		// git config, and a write runs a non-readonly operation, which runs another status, which
		// brings us right back here. Without a negative cache a persistently failing write would
		// spawn git processes forever.
		this.baseBranchHEAD = headName;
		this.baseBranchRemoteRefs = remoteRefs;
		this.baseBranch = undefined;
		this.baseBranch = await this.repository.getBranchBase(headName);

		return this.baseBranch;
	}

	dispose(): void {
		this.disposed = true;
		this._state = undefined;
		providers.delete(this.repository);
		this.disposables = dispose(this.disposables);
		_onDidChangeBranchDiff.fire(this.repository);
	}
}

/**
 * Lets the user override the branch the current branch is compared against. The choice is stored
 * in the same `branch.<name>.vscode-merge-base` git config that `Repository.getBranchBase()`
 * reads, so it also steers the source control graph's base ref.
 */
export async function selectBranchDiffBase(model: Model, logger: LogOutputChannel, repository: Repository | undefined): Promise<void> {
	repository = repository
		?? (model.repositories.length === 1 ? model.repositories[0] : await model.pickRepository());

	if (!repository) {
		return;
	}

	const HEAD = repository.HEAD;
	if (HEAD?.type !== RefType.Head || !HEAD.name) {
		// allow-any-unicode-next-line
		window.showInformationMessage(l10n.t('現在のブランチはベースブランチと比較できません。'));
		return;
	}

	const headName = HEAD.name;
	const picks = repository.refs
		// `refs/remotes/<remote>/HEAD` parses as a remote branch but is only a symref to the
		// default branch, and comparing against it reads as nonsense in the view title.
		.filter((ref: Ref): ref is Ref & { name: string } => ref.type === RefType.RemoteHead && !!ref.name && !ref.name.endsWith('/HEAD'))
		.map(ref => ({ label: ref.name }))
		.sort((one, other) => one.label.localeCompare(other.label));

	if (picks.length === 0) {
		// allow-any-unicode-next-line
		window.showInformationMessage(l10n.t('「{0}」と比較できるリモートブランチがありません。', headName));
		return;
	}

	const pick = await window.showQuickPick(picks, {
		// allow-any-unicode-next-line
		placeHolder: l10n.t('「{0}」と比較するブランチを選択', headName)
	});

	if (!pick) {
		return;
	}

	const configKey = `branch.${headName}.vscode-merge-base`;

	try {
		// Deliberately not setConfig(): that appends, and a key with several values is one that
		// deleting the branch can no longer clean up.
		await repository.replaceConfig(configKey, pick.label);

		// git config failures are swallowed down in the git layer, so the only way to notice a
		// read-only or locked config is to read the value back.
		if (await repository.getConfig(configKey) !== pick.label) {
			throw new Error(`git config did not keep ${configKey}`);
		}
	} catch (err) {
		// Repository.run() rejects while the repository is being closed, which is the only way a
		// config write reaches us as an exception.
		logger.warn(`[selectBranchDiffBase] Failed to set ${configKey} to ${pick.label}: ${err}`);
		// allow-any-unicode-next-line
		window.showErrorMessage(l10n.t('「{0}」のベースブランチを設定できませんでした。', headName));
		return;
	}

	refreshBranchDiff(repository);

	// Comparing a branch with the very branch it tracks has nothing to show, and the view would
	// just disappear without explanation.
	if (HEAD.upstream && `${HEAD.upstream.remote}/${HEAD.upstream.name}` === pick.label) {
		// allow-any-unicode-next-line
		window.showInformationMessage(l10n.t('「{0}」は「{1}」を追跡しているため、比較して表示するブランチの変更はありません。', headName, pick.label));
	}
}
