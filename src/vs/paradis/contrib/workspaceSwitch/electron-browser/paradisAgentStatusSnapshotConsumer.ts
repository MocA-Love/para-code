/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { sep } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusSnapshot, ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisAgentTokenScopeMemory, paradisShouldClearAgentStatusAfterPollFailures } from '../../agentBrowser/common/paradisAgentStatusStale.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';

export interface IParadisAgentStatusSnapshotConsumerOptions {
	readonly snapshotService: IParadisAgentStatusSnapshotService;
	readonly paneTokenService: IParadisPaneTokenService;
	readonly terminalScopeService: IParadisTerminalScopeService;
	readonly workspaceSwitchService: IParadisWorkspaceSwitchService;
	readonly worktreeService: IParadisWorktreeService;
	readonly statusStore: IParadisAgentStatusStore;
	readonly acknowledgePaneStatus: (token: string) => void;
	readonly logPollFailure: (error: unknown) => void;
	readonly isWindowFocused: () => boolean;
}

/**
 * Applies the renderer singleton's atomic snapshots to the Workspaces status stores. Transport
 * scheduling belongs to the producer; this class retains only projection and stale-view state.
 */
export class ParadisAgentStatusSnapshotConsumer extends Disposable {
	private readonly _tokenScopeMemory = new ParadisAgentTokenScopeMemory();
	private _latestSnapshot: IParadisAgentStatusSnapshot | undefined;
	private _consecutivePollFailures = 0;

	constructor(private readonly _options: IParadisAgentStatusSnapshotConsumerOptions) {
		super();
		this._register(this._options.workspaceSwitchService.onDidSwitchScope(() => {
			if (this._latestSnapshot !== undefined) {
				this._projectSnapshot(this._latestSnapshot);
			}
			this._options.snapshotService.requestRefresh();
		}));
		this._register(this._options.snapshotService.subscribe(outcome => {
			if (outcome.snapshot !== undefined) {
				this._latestSnapshot = outcome.snapshot;
				this._consecutivePollFailures = 0;
				this._projectSnapshot(outcome.snapshot);
			} else {
				this._handlePollFailure(outcome.error);
			}
		}));
	}

	requestRefresh(): void {
		this._options.snapshotService.requestRefresh();
	}

	private _handlePollFailure(error: unknown): void {
		this._options.logPollFailure(error);
		this._consecutivePollFailures++;
		if (paradisShouldClearAgentStatusAfterPollFailures(this._consecutivePollFailures)) {
			this._latestSnapshot = undefined;
			this._options.statusStore.setScopeBreakdowns(new Map());
			this._options.statusStore.setInstanceStates(new Map(), new Set());
		}
	}

	private _resolveStateKeyByCwd(cwd: string | undefined): string | undefined {
		if (cwd === undefined || cwd.length === 0) {
			return undefined;
		}
		let best: { root: string; stateKey: string } | undefined;
		const consider = (uri: URI, stateKey: string) => {
			if (uri.scheme !== 'file') {
				return;
			}
			const root = uri.fsPath;
			if ((cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep)) && (best === undefined || root.length > best.root.length)) {
				best = { root, stateKey };
			}
		};
		for (const repository of this._options.workspaceSwitchService.repositories) {
			consider(repository.uri, repository.id);
			for (const worktree of this._options.worktreeService.getWorktrees(repository.id)) {
				consider(worktree.uri, paradisWorktreeStateKey(worktree.uri));
			}
		}
		return best?.stateKey;
	}

	private _projectSnapshot(snapshot: IParadisAgentStatusSnapshot): void {
		const statuses = snapshot.paneStatuses;
		this._tokenScopeMemory.prune(new Set(statuses.map(status => status.token)));
		const activeStateKey = this._options.workspaceSwitchService.activeStateKey;
		const scopeBreakdowns = new Map<string, ParadisAgentStatus[]>();
		const instanceStatuses = new Map<number, ParadisAgentStatus>();
		const agentInstanceIds = new Set<number>();
		for (const token of snapshot.agentHookTokens) {
			const instanceId = this._options.paneTokenService.getInstanceForToken(token);
			if (instanceId !== undefined) {
				agentInstanceIds.add(instanceId);
			}
		}

		for (const paneStatus of statuses) {
			const instanceId = this._options.paneTokenService.getInstanceForToken(paneStatus.token);
			const resolvedViaInstance = instanceId !== undefined;
			if (instanceId !== undefined) {
				instanceStatuses.set(instanceId, paneStatus.status);
			}
			let stateKey: string | undefined;
			let allowRememberedScope = instanceId === undefined;
			if (instanceId !== undefined) {
				const scope = this._options.terminalScopeService.resolveScope(instanceId);
				if (scope.kind === 'managed') {
					stateKey = scope.stateKey;
				} else if (scope.kind === 'pending') {
					allowRememberedScope = true;
				}
			}
			if (stateKey === undefined) {
				stateKey = this._resolveStateKeyByCwd(paneStatus.cwd);
			}
			stateKey = this._tokenScopeMemory.resolve(paneStatus.token, stateKey, allowRememberedScope);
			if (stateKey === undefined) {
				continue;
			}

			if (paneStatus.status === 'review' && stateKey === activeStateKey && resolvedViaInstance && this._options.isWindowFocused()) {
				this._options.acknowledgePaneStatus(paneStatus.token);
				if (instanceId !== undefined) {
					instanceStatuses.delete(instanceId);
				}
				continue;
			}

			const breakdown = scopeBreakdowns.get(stateKey);
			if (breakdown) {
				breakdown.push(paneStatus.status);
			} else {
				scopeBreakdowns.set(stateKey, [paneStatus.status]);
			}
		}

		this._options.statusStore.setScopeBreakdowns(scopeBreakdowns);
		this._options.statusStore.setInstanceStates(instanceStatuses, agentInstanceIds);
	}
}
