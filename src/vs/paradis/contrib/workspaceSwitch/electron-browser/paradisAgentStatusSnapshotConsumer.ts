/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusSnapshot, ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisAgentTokenScopeMemory, paradisShouldClearAgentStatusAfterPollFailures } from '../../agentBrowser/common/paradisAgentStatusStale.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { IParadisTerminalScopeRoot, paradisResolveInitialCwdScope } from '../common/paradisTerminalProcessScope.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisScopeRootPath, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';

export interface IParadisAgentStatusSnapshotConsumerOptions {
	readonly snapshotService: IParadisAgentStatusSnapshotService;
	readonly paneTokenService: IParadisPaneTokenService;
	readonly terminalScopeService: IParadisTerminalScopeService;
	readonly workspaceSwitchService: IParadisWorkspaceSwitchService;
	readonly worktreeService: IParadisWorktreeService;
	readonly remoteAgentService: IRemoteAgentService;
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
	private _disposed = false;

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
		if (!this._disposed) {
			this._options.snapshotService.requestRefresh();
		}
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		super.dispose();
	}

	private _handlePollFailure(error: unknown): void {
		this._options.logPollFailure(error);
		this._consecutivePollFailures++;
		if (paradisShouldClearAgentStatusAfterPollFailures(this._consecutivePollFailures)) {
			this._latestSnapshot = undefined;
			this._options.statusStore.setScopeBreakdowns(new Map());
			this._options.statusStore.setInstanceStates(new Map(), new Set());
			this._options.statusStore.setScopeIssueUrls(new Map());
		}
	}

	private _resolveStateKeyByCwd(cwd: string | undefined): string | undefined {
		if (cwd === undefined || cwd.length === 0) {
			return undefined;
		}
		// ターミナル側 (paradisTerminalScope.contribution.ts) と同じ突き合わせに揃える。
		// 素朴な startsWith(root + sep) は sep をこのウィンドウの OS で決め打ちするため、
		// Windows クライアント（sep === '\\'）から Linux 接続先の cwd（'/' 区切り）を
		// 突き合わせると常に不一致になる。normalize を通す paradisResolveInitialCwdScope は
		// 両辺に同じ変換をかけるので、この向き（POSIX クライアント→Windows 接続先を除く）は
		// 一致する（逆方向・Windows クライアント→Windows 以外の接続先はこの関数の対象外の
		// ままで、既存の制約であり今回の変更で悪化はしていない）。
		const roots: IParadisTerminalScopeRoot[] = [];
		const connectedAuthority = this._options.remoteAgentService.getConnection()?.remoteAuthority;
		for (const repository of this._options.workspaceSwitchService.repositories) {
			const repositoryRoot = paradisScopeRootPath(repository.uri, connectedAuthority);
			if (repositoryRoot !== undefined) {
				roots.push({ root: repositoryRoot, stateKey: repository.id });
			}
			for (const worktree of this._options.worktreeService.getWorktrees(repository.id)) {
				const worktreeRoot = worktree.missing ? undefined : paradisScopeRootPath(worktree.uri, connectedAuthority);
				if (worktreeRoot !== undefined) {
					roots.push({ root: worktreeRoot, stateKey: paradisWorktreeStateKey(worktree.uri) });
				}
			}
		}
		return paradisResolveInitialCwdScope(cwd, roots);
	}

	private _projectSnapshot(snapshot: IParadisAgentStatusSnapshot): void {
		const statuses = snapshot.paneStatuses;
		this._tokenScopeMemory.prune(new Set(statuses.map(status => status.token)));
		const activeStateKey = this._options.workspaceSwitchService.activeStateKey;
		const scopeBreakdowns = new Map<string, ParadisAgentStatus[]>();
		const instanceStatuses = new Map<number, ParadisAgentStatus>();
		const agentInstanceIds = new Set<number>();
		/**
		 * スコープ (stateKey) → 検出済み Issue URL。cwd 最長一致・記憶されたスコープ経由の
		 * 曖昧な解決では紐付けない（誤ったスペースにIssueが出ることの実害は、実行状態ドットの
		 * 誤表示より大きい — ユーザーが実際に開くリンクだから）。instance 経由でスコープが
		 * 直接 'managed' に解決できた時だけ採用する。
		 */
		const scopeIssueUrls = new Map<string, Set<string>>();
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
			let resolvedViaManagedInstance = false;
			if (instanceId !== undefined) {
				const scope = this._options.terminalScopeService.resolveScope(instanceId);
				if (scope.kind === 'managed') {
					stateKey = scope.stateKey;
					resolvedViaManagedInstance = true;
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

			// Issueマークは scopeBreakdowns に載る（＝行のドット列に「動作中」として現れる）
			// ペインとだけ連動させる。誤ったスペースへの紐付けを避けるため instance 経由で
			// 'managed' に直接解決できた時だけ採用する (cwd最長一致・記憶されたスコープは対象外)。
			if (resolvedViaManagedInstance && paneStatus.issueUrls !== undefined && paneStatus.issueUrls.length > 0) {
				const urls = scopeIssueUrls.get(stateKey) ?? new Set<string>();
				for (const url of paneStatus.issueUrls) {
					urls.add(url);
				}
				scopeIssueUrls.set(stateKey, urls);
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
		this._options.statusStore.setScopeIssueUrls(scopeIssueUrls);
	}
}
