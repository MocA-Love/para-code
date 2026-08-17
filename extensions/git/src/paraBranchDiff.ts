/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { commands, Disposable, l10n, LogOutputChannel, SourceControlResourceGroup, Uri, window, workspace } from 'vscode';
import type { Branch, Ref } from './api/git';
import { RefType } from './api/git.constants';
import type { Model } from './model';
import type { Repository } from './repository';
import { dispose } from './util';

export const BRANCH_DIFF_GROUP_ID = 'paraBranchDiff';

/**
 * Upper bound on the number of files listed in the branch diff group. A branch that diverged by
 * more than this is not something anybody reviews in a tree, and building that many resources
 * would stall the extension host on every status.
 */
const RESOURCE_LIMIT = 5000;

/**
 * Providers keyed by repository so that commands can reach the provider of a given repository
 * without widening the public surface of {@link Repository}.
 */
const providers = new WeakMap<Repository, ParaBranchDiffProvider>();

/**
 * Owner of each branch diff group. `Model.getRepository()` only recognises the four upstream
 * groups, so a command invoked from this group's menu has to resolve the repository itself.
 */
const groupOwners = new WeakMap<SourceControlResourceGroup, Repository>();

/**
 * Fills the "Changes Since &lt;base branch&gt;" resource group: everything the current branch
 * accumulated since it forked off its base branch, i.e. `git diff <base>...HEAD`.
 *
 * The group is deliberately empty (and therefore hidden, since it is created with
 * `hideWhenEmpty`) whenever a meaningful comparison cannot be made:
 * - a merge, rebase or cherry-pick is in progress, where the merge base is in flux
 * - no base branch could be resolved
 * - the base branch is the branch's own upstream, in which case the branch was not forked off
 *   anything and the graph's incoming/outgoing already tells the story
 */
export class ParaBranchDiffProvider {

	private disposables: Disposable[] = [];

	/** Base branch resolved for {@link baseBranchHEAD}. Resolving it costs git calls, so it is cached. */
	private baseBranch: Branch | undefined;
	private baseBranchHEAD: string | undefined;
	private baseBranchRemoteRefs: string | undefined;

	/** Merge base resolved for a given (HEAD tip, base branch tip) pair. */
	private mergeBase: string | undefined;
	private mergeBaseKey: string | undefined;

	/**
	 * Identity and size of the last successfully rendered diff, used to skip redundant work. The
	 * size is part of it because the group is also cleared behind our back when the repository is
	 * parked, and the key alone would then make us skip refilling it on the way back.
	 */
	private lastKey: string | undefined;
	private lastCount = 0;

	private running = false;
	private pending = false;
	private disposed = false;

	constructor(
		private readonly repository: Repository,
		private readonly logger: LogOutputChannel
	) {
		providers.set(repository, this);
		groupOwners.set(repository.branchDiffGroup, repository);

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

	private async doRefresh(): Promise<void> {
		try {
			const state = await this.computeState();

			if (!state) {
				this.lastKey = undefined;
				this.lastCount = 0;
				this.repository.branchDiffBase = undefined;
				if (this.repository.branchDiffGroup.resourceStates.length > 0) {
					this.repository.branchDiffGroup.resourceStates = [];
				}
				return;
			}

			if (state.key === this.lastKey && this.repository.branchDiffGroup.resourceStates.length === this.lastCount) {
				return;
			}

			// Diffing against the merge base rather than the tip of the base branch, so that a base
			// branch which moved on since the fork does not show other people's work as if this
			// branch had reverted it. Note that this leaves out type changes, which git omits from
			// --diff-filter=ADMR.
			const diff = await this.repository.diffBetween(state.baseCommit, 'HEAD');
			const changes = Array.isArray(diff) ? diff : [];

			if (changes.length > RESOURCE_LIMIT) {
				this.logger.warn(`[ParaBranchDiffProvider][doRefresh] ${this.repository.root} differs from ${state.baseLabel} by ${changes.length} files, showing the first ${RESOURCE_LIMIT}`);
			} else if (changes.length === 0) {
				// git exits non-zero into an empty change list, so "no diff" and "the diff failed"
				// look identical from here.
				this.logger.trace(`[ParaBranchDiffProvider][doRefresh] ${this.repository.root} has no changes since ${state.baseLabel}`);
			}

			// Resolving the base branch and running the diff both take git processes, and the
			// repository can be parked or disposed while we wait. Parking clears every group on
			// purpose so that nothing reads another space's changes, so writing our result now
			// would undo that.
			if (this.disposed || !this.repository.scopeActive) {
				this.lastKey = undefined;
				this.lastCount = 0;
				return;
			}

			const resources = this.repository.createBranchDiffResources(changes.slice(0, RESOURCE_LIMIT));

			this.repository.branchDiffBase = { commit: state.baseCommit, label: state.baseLabel };
			this.repository.branchDiffGroup.label = l10n.t('Changes Since {0}', state.baseLabel);
			this.repository.branchDiffGroup.resourceStates = resources;
			this.lastKey = state.key;
			this.lastCount = resources.length;
		} catch (err) {
			this.logger.warn(`[ParaBranchDiffProvider][doRefresh] Failed to compute branch diff for ${this.repository.root}: ${err}`);
			this.lastKey = undefined;
			this.lastCount = 0;
		}
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
		providers.delete(this.repository);
		groupOwners.delete(this.repository.branchDiffGroup);
		this.disposables = dispose(this.disposables);
	}
}

/**
 * Lets the user override the branch the current branch is compared against. The choice is stored
 * in the same `branch.<name>.vscode-merge-base` git config that `Repository.getBranchBase()`
 * reads, so it also steers the source control graph's base ref.
 */
export function registerParaBranchDiffCommands(model: Model, logger: LogOutputChannel): Disposable {
	return commands.registerCommand('git.paraSelectBranchDiffBase', async (group?: SourceControlResourceGroup) => {
		// The command also sits on the resource group, where the group identifies the repository
		// the user actually clicked. Only fall back to asking when invoked without one.
		const repository = (group && groupOwners.get(group))
			?? (model.repositories.length === 1 ? model.repositories[0] : await model.pickRepository());

		if (!repository) {
			return;
		}

		const HEAD = repository.HEAD;
		if (HEAD?.type !== RefType.Head || !HEAD.name) {
			window.showInformationMessage(l10n.t('The current branch cannot be compared with a base branch.'));
			return;
		}

		const headName = HEAD.name;
		const picks = repository.refs
			// `refs/remotes/<remote>/HEAD` parses as a remote branch but is only a symref to the
			// default branch, and comparing against it reads as nonsense in the group label.
			.filter((ref: Ref): ref is Ref & { name: string } => ref.type === RefType.RemoteHead && !!ref.name && !ref.name.endsWith('/HEAD'))
			.map(ref => ({ label: ref.name }))
			.sort((one, other) => one.label.localeCompare(other.label));

		if (picks.length === 0) {
			window.showInformationMessage(l10n.t('There are no remote branches to compare "{0}" with.', headName));
			return;
		}

		const pick = await window.showQuickPick(picks, {
			placeHolder: l10n.t('Select the branch to compare "{0}" with', headName)
		});

		if (!pick) {
			return;
		}

		const configKey = `branch.${headName}.vscode-merge-base`;

		try {
			// Deliberately not setConfig(): that appends, and a key with several values is one
			// that deleting the branch can no longer clean up.
			await repository.replaceConfig(configKey, pick.label);

			// git config failures are swallowed down in the git layer, so the only way to notice a
			// read-only or locked config is to read the value back.
			if (await repository.getConfig(configKey) !== pick.label) {
				throw new Error(`git config did not keep ${configKey}`);
			}
		} catch (err) {
			// Repository.run() rejects while the repository is being closed, which is the only way
			// a config write reaches us as an exception.
			logger.warn(`[registerParaBranchDiffCommands] Failed to set ${configKey} to ${pick.label}: ${err}`);
			window.showErrorMessage(l10n.t('Failed to set the base branch of "{0}".', headName));
			return;
		}

		providers.get(repository)?.reset();

		// Comparing a branch with the very branch it tracks has nothing to show, and the group
		// would just disappear without explanation.
		if (HEAD.upstream && `${HEAD.upstream.remote}/${HEAD.upstream.name}` === pick.label) {
			window.showInformationMessage(l10n.t('"{0}" tracks "{1}", so there are no branch changes to show against it.', headName, pick.label));
		}
	});
}
