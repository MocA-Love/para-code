/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisCollectLivePaneInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import {
	IParadisAgentStatusStore,
	IParadisTerminalScopeService,
	IParadisWorkspaceSwitchService,
	IParadisWorktreeService,
	paradisWorkspaceColorHex,
	paradisWorktreeStateKey,
} from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentLiveEntry, ParadisAgentLiveStatus } from '../common/paradisAgentLiveWindow.js';

interface ISpaceInfo {
	readonly name: string;
	readonly color: string | undefined;
	readonly detail: string;
}

interface IStatusSince {
	readonly status: ParadisAgentLiveStatus;
	readonly since: number;
}

/** 再計算のまとめ間隔。状態ポーリングは2秒周期なので、それより細かく詰める意味はない。 */
const RECOMPUTE_DELAY = 120;

/**
 * ライブウィンドウが表示する「全スペースで動いているエージェント端末」の一覧を組み立てる。
 *
 * 収集そのものは既存の {@link paradisCollectLivePaneInstances} に任せる。あの関数は
 * アクティブスペースの端末に加えて park 中のパネル端末・エディタ端末まで含めて返すため、
 * 「いま表示されていないスペースで動いている子」もそのまま拾える (モバイルリレーが
 * 同じ経路で他スペースの端末を出しているのと同じ)。
 *
 * このモデルはウィンドウを開いていなくても生きている (タイトルバーのバッジが購読するため)。
 * そのため端末の出力そのものには触れず、タイムスタンプの更新に留めている。
 */
export class ParadisAgentLiveModel extends Disposable {

	private readonly _onDidChangeEntries = this._register(new Emitter<void>());
	readonly onDidChangeEntries = this._onDidChangeEntries.event;

	private _entries: readonly IParadisAgentLiveEntry[] = [];
	/** 直前に通知した内容の指紋。ソートに効かない lastOutputAt は含めない */
	private _signature = '';
	/** トークン → 現在の状態とその状態を最初に観測した時刻 */
	private readonly _statusSince = new Map<string, IStatusSince>();
	/** トークン → 最後に出力があった時刻 */
	private readonly _lastOutput = new Map<string, number>();
	/** トークン → 端末インスタンス。ミラーを張るビューが実体を引くために持つ */
	private readonly _instances = new Map<string, ITerminalInstance>();
	private readonly _outputListeners = this._register(new DisposableMap<number>());

	private readonly _scheduler: RunOnceScheduler;
	/** 端末の出力を覗くか。ウィンドウを開いている間だけ有効にする */
	private _trackOutput = false;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisAgentStatusStore private readonly agentStatusStore: IParadisAgentStatusStore,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
	) {
		super();

		this._scheduler = this._register(new RunOnceScheduler(() => this.recompute(), RECOMPUTE_DELAY));

		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => this.schedule()));
		this._register(this.paneTokenService.onDidChange(() => this.schedule()));
		this._register(this.terminalScopeService.onDidChangeStableScope(() => this.schedule()));
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => this.schedule()));
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.schedule()));
		this._register(this.worktreeService.onDidChangeWorktrees(() => this.schedule()));
		this._register(terminalInstanceService.onDidCreateInstance(() => this.schedule()));
		this._register(this.terminalService.onDidDisposeInstance(() => this.schedule()));

		this.recompute();
	}

	get entries(): readonly IParadisAgentLiveEntry[] {
		return this._entries;
	}

	/**
	 * 出力の監視を開始・停止する。「最後に動いた順」の並び替えと端末タイトルのためだけに
	 * 全エージェント端末の出力へリスナを載せるので、ウィンドウを閉じている間は外しておく
	 * (このモデルはタイトルバーのバッジのために常時生きている)。
	 */
	setOutputTracking(enabled: boolean): void {
		if (this._trackOutput === enabled) {
			return;
		}
		this._trackOutput = enabled;
		if (!enabled) {
			this._outputListeners.clearAndDisposeAll();
			return;
		}
		this.recompute();
	}

	/**
	 * その端末から最後に出力があった時刻。出力そのものは再計算の契機にできない
	 * (毎フレーム飛んでくる) ため、entries に焼かれた値は古い。「最後に動いた順」で
	 * 並べるときだけ、ここから最新値を引き直す。
	 */
	getLastOutputAt(token: string): number {
		return this._lastOutput.get(token) ?? 0;
	}

	/** ミラー生成用。エントリのトークンから端末の実体を引く。 */
	getInstance(token: string): ITerminalInstance | undefined {
		return this._instances.get(token);
	}

	/** タイトルバーのバッジ用。状態ごとの件数。 */
	countByStatus(): ReadonlyMap<ParadisAgentLiveStatus, number> {
		const counts = new Map<ParadisAgentLiveStatus, number>();
		for (const entry of this._entries) {
			counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
		}
		return counts;
	}

	private schedule(): void {
		if (!this._scheduler.isScheduled()) {
			this._scheduler.schedule();
		}
	}

	private recompute(): void {
		const now = Date.now();
		const livePanes = paradisCollectLivePaneInstances(this.terminalService, this.terminalGroupService, this.paneTokenService);
		const spaceCache = new Map<string, ISpaceInfo | undefined>();
		const entries: IParadisAgentLiveEntry[] = [];
		const seenTokens = new Set<string>();
		const seenInstanceIds = new Set<number>();

		for (const { instance, token } of livePanes) {
			const status = this.agentStatusStore.getInstanceStatus(instance.instanceId);
			// エージェントCLIが動いた実績のある端末だけを載せる (ただのシェルを混ぜない)。
			// hook が届かない環境 (WSL のディストロの中で動いているエージェント) では実績が付かない
			// ので、記録ファイルの探索でセッションが確定しているペインも根拠として認める。
			// その場合そのペインの状態は分からないため、下の `?? 'idle'` で待機として並ぶ。
			if (status === undefined
				&& !this.agentStatusStore.isAgentInstance(instance.instanceId)
				&& !this.agentStatusStore.hasDiscoveredAgentSession(token)) {
				continue;
			}
			const resolved: ParadisAgentLiveStatus = status ?? 'idle';
			const stateKey = this.terminalScopeService.getStateKeyForInstance(instance.instanceId);
			const space = this.resolveSpace(stateKey, spaceCache);

			seenTokens.add(token);
			seenInstanceIds.add(instance.instanceId);
			this._instances.set(token, instance);
			this.watchInstance(instance, token);

			const previous = this._statusSince.get(token);
			if (!previous || previous.status !== resolved) {
				this._statusSince.set(token, { status: resolved, since: now });
			}

			entries.push({
				token,
				instanceId: instance.instanceId,
				stateKey,
				spaceName: space?.name ?? '不明なスペース',
				spaceColor: space?.color,
				detail: space?.detail ?? '',
				title: instance.title,
				status: resolved,
				since: this._statusSince.get(token)!.since,
				lastOutputAt: this._lastOutput.get(token) ?? 0,
			});
		}

		// 消えた端末の記録を落とす (トークンは再利用されないので、残すとただの漏れになる)。
		for (const token of [...this._statusSince.keys()]) {
			if (!seenTokens.has(token)) {
				this._statusSince.delete(token);
				this._lastOutput.delete(token);
				this._instances.delete(token);
			}
		}
		for (const instanceId of [...this._outputListeners.keys()]) {
			if (!seenInstanceIds.has(instanceId)) {
				this._outputListeners.deleteAndDispose(instanceId);
			}
		}

		// 表示に効く値が何も変わっていないなら通知しない。ビューは通知のたびに全タイルを
		// 並べ直すため、状態ポーリングのたびに再描画すると入力中の端末に影響が出る。
		const signature = entries.map(entry => `${entry.token}\u0000${entry.instanceId}\u0000${entry.status}\u0000${entry.since}\u0000${entry.title}\u0000${entry.spaceName}\u0000${entry.detail}\u0000${entry.spaceColor ?? ''}\u0000${entry.stateKey ?? ''}`).join('\u0001');
		const changed = signature !== this._signature;
		this._entries = entries;
		this._signature = signature;
		if (changed) {
			this._onDidChangeEntries.fire();
		}
	}

	/**
	 * 出力とタイトルを監視する。出力は「最後に動いた順」ソートのための時刻の記録だけで、
	 * 変更イベントは出さない (出力は毎フレーム飛んでくるため再描画の契機にはできない)。
	 */
	private watchInstance(instance: ITerminalInstance, token: string): void {
		if (!this._trackOutput || this._outputListeners.get(instance.instanceId)) {
			return;
		}
		const listeners = new DisposableStore();
		listeners.add(instance.onData(() => this._lastOutput.set(token, Date.now())));
		listeners.add(instance.onTitleChanged(() => this.schedule()));
		this._outputListeners.set(instance.instanceId, listeners);
	}

	private resolveSpace(stateKey: string | undefined, cache: Map<string, ISpaceInfo | undefined>): ISpaceInfo | undefined {
		if (stateKey === undefined) {
			return undefined;
		}
		if (cache.has(stateKey)) {
			return cache.get(stateKey);
		}

		let resolved: ISpaceInfo | undefined;
		for (const repository of this.workspaceSwitchService.repositories) {
			const color = paradisWorkspaceColorHex(repository.color);
			if (repository.id === stateKey) {
				resolved = { name: repository.name, color, detail: this.worktreeService.getRepositoryBranch(repository.id) ?? '' };
				break;
			}
			// 表示対象外の worktree でも端末は生きているので、検出済みのものを全て見る。
			const worktree = this.worktreeService.getDetectedWorktrees(repository.id).find(candidate => paradisWorktreeStateKey(candidate.uri) === stateKey);
			if (worktree) {
				resolved = { name: repository.name, color, detail: worktree.branch ?? worktree.name };
				break;
			}
		}

		cache.set(stateKey, resolved);
		return resolved;
	}
}
