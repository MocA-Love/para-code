/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { getActiveWindow } from '../../../../base/browser/dom.js';
import { TerminalExitReason, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITerminalEditorService, ITerminalGroup, ITerminalGroupService, ITerminalInstance, ITerminalInstanceService, ITerminalService, TerminalConnectionState } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalGroupService } from '../../../../workbench/contrib/terminal/browser/terminalGroupService.js';
import { paradisRegisterTerminalCreationScopeProvider, paradisTakeTerminalCreationScopeLease } from '../../../../workbench/contrib/terminal/browser/paradisTerminalCreationScope.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IParadisAuxiliaryWindowScopeService, IParadisTerminalScopeService, IParadisTerminalStableScopeChangeEvent, IParadisWorkspaceSwitchService, IParadisWorktreeService, ParadisBindingScope, ParadisTerminalInstanceRetirementTracker, ParadisTerminalStableScopeTracker, paradisResolveTerminalBindingScope, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import { IParadisScopedTerminalInstanceLike, IParadisTerminalScopeRoot, paradisCollectRetiringTerminalInstanceIds, paradisLookupInstanceScope, paradisMergePersistentProcessScopesForStorage, paradisParseTerminalProcessScopeStorage, paradisPartitionPersistentProcessScopesByKnownScope, paradisPrunePersistentProcessScopes, paradisRecordInstanceScopes, paradisRecordPersistentProcessScopes, paradisResolveInitialCwdScope, paradisResolveTerminalScopeCandidate, paradisRestorePersistentProcessScope, paradisRetireInstanceScope, paradisRetireTerminalScope, paradisSerializeTerminalProcessScopeStorage } from '../common/paradisTerminalProcessScope.js';
import { paradisGetParkedTerminalEditorStateKey, paradisListParkedTerminalEditorInstances, paradisParkTerminalEditorInstance, paradisTakeParkedTerminalEditorInstancesForScope } from './paradisTerminalEditorPark.js';

/**
 * ターミナルグループをリポジトリ単位でスコープする (機能1 Phase 2)。
 *
 * - 新しいグループは生成時のアクティブリポジトリでタグ付けする
 * - リポジトリ切り替え時、他リポジトリのグループを park (TerminalGroupService の
 *   PARA-PATCH メソッド。groups から外れタブリスト/パネルから消えるが PTY は生存)、
 *   切り替え先のグループを unpark する
 * - ウィンドウリロードを跨ぐ永続化: park 中のグループも terminalService のレイアウト
 *   永続化に含まれる (terminalService.ts の PARA-PATCH) ため、リロード後は全グループが
 *   一旦復元される。{persistentProcessId → repositoryId} の保存済みマッピングから
 *   再接続完了時に再タグ付け・再 park する
 */
export class ParadisTerminalWorkspaceScope extends Disposable implements IParadisTerminalScopeService {

	declare readonly _serviceBrand: undefined;

	private static readonly MAPPING_STORAGE_KEY = 'paradis.workspaceSwitch.terminalRepositories';

	/** グループ → 所属リポジトリID (park 中も保持)。untagged のグループはスコープ外 (常に表示) */
	private readonly _groupRepositories = new Map<ITerminalGroup, string>();

	/** リポジトリID → park 中のグループ */
	private readonly _parkedGroups = new Map<string, ITerminalGroup[]>();

	/**
	 * instanceId → 所属リポジトリID。このセッション中にタグ付けしたグループの
	 * インスタンスを常に記録する（グループの生存中を通じて更新され続ける）。
	 *
	 * `_groupRepositories` はグループ「オブジェクト」の参照をキーにしているため、同じ
	 * ターミナルプロセスを表す新しいグループオブジェクトが作られる（例: TerminalService の
	 * moveToBackground → showBackgroundTerminal による一時非表示→再表示。最後の1インスタンスが
	 * 抜けた時点で旧グループは dispose され、再表示時に createGroup で新しいグループが作られる）
	 * と、旧オブジェクトへの対応は discardGroup で消え、新オブジェクトは tagUntaggedGroups から見て
	 * 「未タグ (常に表示)」になってしまう。instanceId は同じ ITerminalInstance がグループの
	 * 生成し直しを跨いで持ち回る安定な同期採番のため、ここに記録しておけば tagUntaggedGroups が
	 * 「今アクティブなスコープ」への決め打ちより先にこちらを優先でき、正しい所属へ復元できる。
	 * （persistentProcessId はプロセス起動後に非同期で確定するため、生成直後のタグ付け時点では
	 * まだ undefined で記録できないことがあり、ライブ記録のキーには使えない。）
	 *
	 * エントリはグループ dispose では消さない（moveToBackground による一時的な dispose を
	 * 跨いで引けることがこのマップの存在意義）。スコープ退役時に retireScope でまとめて掃除する。
	 */
	private readonly _instanceScopes = new Map<number, string>();
	private readonly _persistentProcessIdByInstance = new Map<number, number>();
	private readonly _instanceIdByPersistentProcessId = new Map<number, number>();
	private readonly _stableScopeTracker = this._register(new ParadisTerminalStableScopeTracker());
	private readonly _instanceRetirementTracker = this._register(new ParadisTerminalInstanceRetirementTracker());
	private readonly _activeScopeCandidates = new Map<number, string | undefined>();
	private readonly _candidateCapturedInstances = new Set<number>();
	private readonly _initialCwds = new Map<number, string>();
	private readonly _initialCwdResolvedInstances = new Set<number>();
	private readonly _activeFallbackInstances = new Set<number>();
	private readonly _initialCwdResolutions = new WeakMap<ITerminalInstance, Promise<void>>();
	private _terminalRestoreComplete = false;
	private _worktreeSnapshotReady = false;
	readonly onDidChangeStableScope: Event<IParadisTerminalStableScopeChangeEvent> = this._stableScopeTracker.onDidChange;
	get revision(): number { return this._stableScopeTracker.revision; }

	/**
	 * {persistentProcessId → repositoryId} の永続台帳。起動時に前回値を読み込み、今セッション中の
	 * process ID確定・所属変更・破棄に合わせて更新する。
	 */
	private readonly _persistentProcessScopes: Map<number, string>;
	/**
	 * 起動時に読み込んだ復元専用snapshot。完全再起動ではPTY IDが振り直されるため、
	 * revived attach targetが保持する前回IDは、今セッションのIDを書き込む可変台帳と分離して引く。
	 * current processの確定では更新せず、起動時worktree検証とscope退役だけを反映する。
	 */
	private readonly _restoredPersistentProcessScopes: Map<number, string>;
	private readonly _quarantinedPersistentProcessScopes: Map<number, string>;

	constructor(
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisAuxiliaryWindowScopeService private readonly auxiliaryWindowScopeService: IParadisAuxiliaryWindowScopeService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IStorageService private readonly storageService: IStorageService,
		@ITerminalInstanceService private readonly terminalInstanceService: ITerminalInstanceService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();
		this._register(paradisRegisterTerminalCreationScopeProvider(() => {
			const scope = this.auxiliaryWindowScopeService.resolveWindow(getActiveWindow().vscodeWindowId);
			return scope.kind === 'managed' ? scope.stateKey : undefined;
		}));

		const loadedMapping = this.loadMapping();
		const initialPartition = paradisPartitionPersistentProcessScopesByKnownScope(loadedMapping, this.knownStateKeys(false));
		this._persistentProcessScopes = new Map(initialPartition.accepted);
		this._restoredPersistentProcessScopes = new Map(initialPartition.accepted);
		this._quarantinedPersistentProcessScopes = initialPartition.quarantined;

		this._register(Event.runAndSubscribe(this.terminalGroupService.onDidChangeGroups, () => this.tagUntaggedGroups()));
		this._register(this.terminalService.onDidChangeInstances(() => this.refreshAllStableScopes()));
		this._register(this.terminalService.onDidChangeConnectionState(() => this.refreshAllStableScopes()));
		this._register(this.worktreeService.onDidChangeWorktrees(() => {
			if (this._worktreeSnapshotReady) {
				this.reevaluateActiveFallbackScopes();
				this.refreshAllStableScopes();
				this.tagUntaggedGroups();
			}
		}));

		// persistMapping は persistentProcessId が確定済みのインスタンスしか書き出せない。
		// タグ付け直後はまだ pid 未確定のことがあり、その後どのトリガーも走らないまま
		// リロードすると復元マッピングから漏れる（非アクティブスコープのターミナルが
		// リロード後にアクティブスコープへ誤って出現する）。pid 確定のたびに書き直して塞ぐ
		this._register(this.terminalService.onAnyInstanceProcessIdReady(instance => {
			this.recordRecoveredScopeIfUnassigned(instance);
			this.recordPersistentProcessScopes([instance]);
			this.parkExplicitlyScopedEditorIfInactive(instance);
			this.persistMapping();
		}));
		this._register(this.workspaceSwitchService.onDidSwitchScope(stateKey => this.applyScope(stateKey)));
		this._register(this.terminalGroupService.onDidDisposeGroup(group => this.discardGroup(group)));

		// リポジトリ/worktree がリストから恒久的に消えたら、そのスコープの park 中グループは
		// 二度と unpark されない (applyScope の復帰は切り替え先キーのみ対象)。放置すると PTY が
		// UI から不可視のまま生き続け、レイアウト永続化でリロードを跨いで復元・再park され続ける。
		// ブラウザスコープの cleanupRemovedRepositories と同じ思想で、退役スコープの実体を破棄する。
		this._register(this.workspaceSwitchService.onDidRetireScope(stateKey => this.retireScope(stateKey)));

		// park 中のグループも terminalService のレイアウト永続化に含まれる (PARA-PATCH) ため、
		// リロード後は全グループが一旦 groups に復元され、出現し次第 tagUntaggedGroups が
		// マッピングに基づいて park し直す。再接続完了後に取りこぼし (persistentProcessId が
		// タグ付け時点で未確定だったグループ) を掃除する
		void terminalService.whenConnected.then(async () => {
			if (this._store.isDisposed) {
				return;
			}
			this._terminalRestoreComplete = true;
			this.sweepRestoredGroups();
			// 非アクティブスコープのエディタターミナルは working set (シリアライズ済みエディタ入力)
			// の中にしか存在せず、リロード後はそのスコープへ切り替えるまで live インスタンスに
			// ならない。この間、PTY は生きているのに端末はどの一覧にも現れず、モバイルからは
			// 存在ごと消える。pty host の孤児プロセスから所属スコープ既知のものを再接続して
			// park 台帳へ戻し、prune がマッピングを失う前に live へ復帰させる。
			// マッピングは await 中に別の起動ハンドラ (worktree 初期化バリア等) の prune で
			// 消され得るため、ここで同期的に確定した写しを渡す。worktree スコープ分は
			// バリア完了まで quarantine 側に居るので、両方を合わせて引けるようにする。
			const scopeSnapshot = new Map([...this._quarantinedPersistentProcessScopes, ...this._restoredPersistentProcessScopes]);
			await this.reviveOrphanedScopedEditorTerminals(scopeSnapshot);
			if (this._store.isDisposed) {
				return;
			}
			const liveInstances = this.refreshAllStableScopes();
			paradisPrunePersistentProcessScopes(this._persistentProcessScopes, liveInstances.map(instance => this.toScopedInstance(instance)));
			this.persistMapping();
		});
		void this.worktreeService.initializationBarrier.then(() => {
			if (this._store.isDisposed) {
				return;
			}
			this._worktreeSnapshotReady = true;
			const resolved = paradisPartitionPersistentProcessScopesByKnownScope(this._quarantinedPersistentProcessScopes, this.knownStateKeys(true));
			for (const [persistentProcessId, stateKey] of resolved.accepted) {
				if (!this._persistentProcessScopes.has(persistentProcessId)) {
					this._persistentProcessScopes.set(persistentProcessId, stateKey);
				}
				this._restoredPersistentProcessScopes.set(persistentProcessId, stateKey);
			}
			this._quarantinedPersistentProcessScopes.clear();
			const liveInstances = this.refreshAllStableScopes();
			if (this._terminalRestoreComplete) {
				paradisPrunePersistentProcessScopes(this._persistentProcessScopes, liveInstances.map(instance => this.toScopedInstance(instance)));
			}
			this.tagUntaggedGroups();
			this.persistMapping();
		}, onUnexpectedError);
		this.refreshAllStableScopes();
	}

	getStateKeyForInstance(instanceId: number): string | undefined {
		const recordedStateKey = this._instanceScopes.get(instanceId);
		if (recordedStateKey !== undefined) {
			return recordedStateKey;
		}
		const groupStateKey = this.getGroupStateKey(instanceId);
		if (groupStateKey !== undefined) {
			return groupStateKey;
		}
		// エディタエリアのターミナルはパネルのグループ台帳に乗らない。ここで解決できないと
		// エージェント状態・通知・モバイル同期がすべて「スコープ外」として捨ててしまう
		// （エディタターミナルで動くエージェントが常にアイドル表示になる実バグの原因）。
		// park中なら park 台帳の stateKey を返す。
		const parkedStateKey = this.getParkedEditorStateKey(instanceId);
		if (parkedStateKey !== undefined) {
			return parkedStateKey;
		}
		return undefined;
	}

	resolveScope(instanceId: number): ParadisBindingScope {
		const groupStateKey = this.getGroupStateKey(instanceId);
		const parkedEditorStateKey = this.getParkedEditorStateKey(instanceId);
		const isLiveInstance = groupStateKey !== undefined
			|| parkedEditorStateKey !== undefined
			|| this.terminalService.instances.some(instance => instance.instanceId === instanceId && !instance.isDisposed);
		return paradisResolveTerminalBindingScope({
			isSwitching: this.workspaceSwitchService.isSwitching,
			isTerminalConnected: this._terminalRestoreComplete && this.terminalService.connectionState === TerminalConnectionState.Connected,
			isIdentityReady: this.isScopeIdentityReady(instanceId),
			isManagedWorkspace: this.workspaceSwitchService.isManagedWorkspaceWindow,
			recordedStateKey: this._instanceScopes.get(instanceId),
			groupStateKey,
			parkedEditorStateKey,
			isLiveInstance,
			activeStateKey: this._activeScopeCandidates.get(instanceId),
		});
	}

	private isScopeIdentityReady(instanceId: number): boolean {
		if (this._instanceScopes.has(instanceId)) {
			return true;
		}
		return this._initialCwdResolvedInstances.has(instanceId) && this._worktreeSnapshotReady;
	}

	private getGroupStateKey(instanceId: number): string | undefined {
		for (const [group, stateKey] of this._groupRepositories) {
			if (group.terminalInstances.some(instance => instance.instanceId === instanceId && !instance.isDisposed)) {
				return stateKey;
			}
		}
		return undefined;
	}

	private getParkedEditorStateKey(instanceId: number): string | undefined {
		if (!paradisListParkedTerminalEditorInstances().some(instance => instance.instanceId === instanceId && !instance.isDisposed)) {
			return undefined;
		}
		return paradisGetParkedTerminalEditorStateKey(instanceId);
	}

	assignInstanceScope(instanceId: number, stateKey: string): void {
		const instance = this.findLiveInstance(instanceId);
		if (instance === undefined) {
			return;
		}
		this._instanceScopes.set(instanceId, stateKey);
		this._activeFallbackInstances.delete(instanceId);
		this.recordPersistentProcessScopes([instance]);
		this.trackInstanceRetirement(instance);
		this._stableScopeTracker.observe(instanceId, { kind: 'managed', stateKey });

		const groupService = this.terminalGroupService;
		if (!(groupService instanceof TerminalGroupService)) {
			this.persistMapping();
			return;
		}
		const group = groupService.groups.find(g => g.terminalInstances.some(instance => instance.instanceId === instanceId));
		if (group !== undefined && this._groupRepositories.get(group) !== stateKey) {
			this._groupRepositories.set(group, stateKey);
			this.recordInstanceScopes(group, stateKey, true);
			if (stateKey !== this.workspaceSwitchService.activeStateKey) {
				this.parkGroup(groupService, group, stateKey);
			}
		} else if (group === undefined) {
			this.parkExplicitlyScopedEditorIfInactive(instance);
		}
		this.persistMapping();
	}

	private parkExplicitlyScopedEditorIfInactive(instance: ITerminalInstance): void {
		const stateKey = this._instanceScopes.get(instance.instanceId);
		// エディタターミナル以外 (パネル端末等) で getInputFromResource を呼ぶと例外になり、
		// 呼び出し元リスナーの後続処理 (persistMapping 等) まで巻き添えで中断してしまう。
		if (!this.terminalEditorService.instances.includes(instance)) {
			return;
		}
		const input = this.terminalEditorService.getInputFromResource(instance.resource);
		// スペース切替の captureScope が retain 済みの入力は、エディタから detach されたまま
		// terminalEditorService の一覧に残る (terminalEditorService.ts の PARA-PATCH)。ここで
		// park + detachInstance すると retain 中の入力を dispose してしまい restoreScope の
		// 復元経路が壊れるため、retain が解除されるまで park 対象にしない。
		if (this.editorGroupsService.isEditorInputRetained?.(input)) {
			return;
		}
		const visibleScope = input.group ? this.auxiliaryWindowScopeService.resolveGroup(input.group) : undefined;
		if (stateKey === undefined
			|| stateKey === this.workspaceSwitchService.activeStateKey
			|| (visibleScope?.kind === 'managed' && visibleScope.stateKey === stateKey)
			// スコープが未確定 (pending) のウィンドウに見えているターミナルは park しない。
			// ウィンドウ移動直後などにスコープ解決が一瞬 pending になるだけで、実際には
			// 表示中のターミナルを detach してしまうと復元経路が無い（誤 park の防止）。
			|| visibleScope?.kind === 'pending') {
			return;
		}
		if (paradisParkTerminalEditorInstance(instance, stateKey)) {
			this.terminalEditorService.detachInstance(instance);
		}
	}

	private findLiveInstance(instanceId: number): ITerminalInstance | undefined {
		return this.collectLiveInstances().get(instanceId);
	}

	/** グループの構成インスタンスの instanceId に、このタグ付けを記録する */
	private recordInstanceScopes(group: ITerminalGroup, stateKey: string, clearActiveFallback = false): void {
		const liveInstances = group.terminalInstances.filter(instance => !instance.isDisposed);
		paradisRecordInstanceScopes(this._instanceScopes, liveInstances, stateKey);
		this.recordPersistentProcessScopes(liveInstances);
		for (const instance of liveInstances) {
			if (clearActiveFallback) {
				this._activeFallbackInstances.delete(instance.instanceId);
			}
			this.trackInstanceRetirement(instance);
			this._stableScopeTracker.observe(instance.instanceId, this.resolveScope(instance.instanceId));
		}
	}

	private collectLiveInstances(): Map<number, ITerminalInstance> {
		const instances = new Map<number, ITerminalInstance>();
		const add = (instance: ITerminalInstance): void => {
			if (!instance.isDisposed) {
				instances.set(instance.instanceId, instance);
			}
		};
		for (const instance of this.terminalService.instances) {
			add(instance);
		}
		for (const instance of this.terminalEditorService.instances) {
			add(instance);
		}
		for (const group of this._groupRepositories.keys()) {
			for (const instance of group.terminalInstances) {
				add(instance);
			}
		}
		for (const group of this.terminalGroupService.paradisParkedGroups ?? []) {
			for (const instance of group.terminalInstances) {
				add(instance);
			}
		}
		for (const instance of paradisListParkedTerminalEditorInstances()) {
			add(instance);
		}
		return instances;
	}

	/**
	 * 所属スコープが分かっている pty host の孤児プロセス (どのウィンドウにも接続されていない
	 * 永続プロセス) を再接続し、park 台帳へ登録する。
	 *
	 * 対象は実質「非アクティブスコープの working set に閉じ込められたエディタターミナル」。
	 * パネルターミナルは park 中グループもレイアウト永続化で復元される (PARA-PATCH) が、
	 * エディタターミナルの復元は working set の適用 (= そのスコープへの切り替え) まで起きない。
	 * ここで park 台帳へ戻しておけば、切り替え時は reviveInput の台帳ルックアップがそのまま
	 * 再利用し、モバイルからもスペースを問わず一覧・操作できる。
	 */
	private async reviveOrphanedScopedEditorTerminals(persistentProcessScopes: ReadonlyMap<number, string>): Promise<void> {
		let details;
		try {
			const backend = await this.terminalInstanceService.getBackend(this.environmentService.remoteAuthority);
			details = await backend?.listProcesses();
		} catch (error) {
			onUnexpectedError(error);
			return;
		}
		if (details === undefined || this._store.isDisposed) {
			return;
		}
		const workspaceId = this.workspaceContextService.getWorkspace().id;
		const livePersistentProcessIds = new Set<number>();
		for (const instance of this.collectLiveInstances().values()) {
			if (typeof instance.persistentProcessId === 'number') {
				livePersistentProcessIds.add(instance.persistentProcessId);
			}
		}
		for (const detail of details) {
			const stateKey = persistentProcessScopes.get(detail.id);
			if (!detail.isOrphan
				|| detail.workspaceId !== workspaceId
				|| detail.isFeatureTerminal === true
				|| detail.hideFromUser === true
				|| livePersistentProcessIds.has(detail.id)
				|| stateKey === undefined
				|| stateKey === this.workspaceSwitchService.activeStateKey) {
				continue;
			}
			try {
				const instance = this.terminalInstanceService.createInstance({ attachPersistentProcess: { ...detail, findRevivedId: true } }, TerminalLocation.Editor);
				await instance.processReady;
				if (this._store.isDisposed || !paradisParkTerminalEditorInstance(instance, stateKey)) {
					// 再接続に失敗した (persistentProcessId が確定しなかった) インスタンスは
					// どの一覧にも属さないため、放置すると不可視のままリークする。
					instance.dispose(TerminalExitReason.Shutdown);
					continue;
				}
				livePersistentProcessIds.add(detail.id);
				// park台帳への登録はterminalServiceのイベントに乗らないため、スコープ確定の
				// 変更イベントで購読側（モバイルリレー等）へ「新しいliveペインが増えた」ことを伝える。
				this._instanceScopes.set(instance.instanceId, stateKey);
				this._stableScopeTracker.observe(instance.instanceId, { kind: 'managed', stateKey });
			} catch (error) {
				onUnexpectedError(error);
			}
		}
	}

	private refreshAllStableScopes(): readonly ITerminalInstance[] {
		const instances = [...this.collectLiveInstances().values()];
		for (const instance of instances) {
			this.ensureScopeCandidate(instance);
			this.recordRecoveredScopeIfUnassigned(instance);
			this.trackInstanceRetirement(instance);
			this._stableScopeTracker.observe(instance.instanceId, this.resolveScope(instance.instanceId));
		}
		this.recordPersistentProcessScopes(instances);
		return instances;
	}

	private trackInstanceRetirement(instance: ITerminalInstance): void {
		this._instanceRetirementTracker.track(instance, instanceId => {
			const persistentProcessId = this.getPersistentProcessId(instance);
			paradisRetireInstanceScope(
				this._instanceScopes,
				this._persistentProcessScopes,
				this.toScopedInstance(instance),
				this._instanceIdByPersistentProcessId,
				instance.exitReason === TerminalExitReason.Shutdown,
			);
			if (persistentProcessId !== undefined && this._instanceIdByPersistentProcessId.get(persistentProcessId) === instanceId) {
				this._instanceIdByPersistentProcessId.delete(persistentProcessId);
			}
			this._persistentProcessIdByInstance.delete(instanceId);
			this._activeScopeCandidates.delete(instanceId);
			this._candidateCapturedInstances.delete(instanceId);
			this._initialCwds.delete(instanceId);
			this._initialCwdResolvedInstances.delete(instanceId);
			this._activeFallbackInstances.delete(instanceId);
			this._stableScopeTracker.retire(instanceId);
			this.persistMapping();
		});
	}

	private ensureScopeCandidate(instance: ITerminalInstance): void {
		if (!this._candidateCapturedInstances.has(instance.instanceId)) {
			this._candidateCapturedInstances.add(instance.instanceId);
			this._activeScopeCandidates.set(
				instance.instanceId,
				paradisTakeTerminalCreationScopeLease(instance.shellLaunchConfig) ?? this.workspaceSwitchService.activeStateKey,
			);
		}
		if (this._initialCwdResolutions.has(instance)) {
			return;
		}
		const resolution = instance.processReady
			.then(() => instance.getInitialCwd())
			.then(initialCwd => {
				if (instance.isDisposed) {
					return;
				}
				if (initialCwd.length > 0) {
					this._initialCwds.set(instance.instanceId, initialCwd);
				}
				this._initialCwdResolvedInstances.add(instance.instanceId);
				this.recordRecoveredScopeIfUnassigned(instance);
				this.tagUntaggedGroups();
				this._stableScopeTracker.observe(instance.instanceId, this.resolveScope(instance.instanceId));
				this.recordPersistentProcessScopes([instance]);
				this.persistMapping();
			}, () => {
				if (!instance.isDisposed) {
					this._initialCwdResolvedInstances.add(instance.instanceId);
					this.recordRecoveredScopeIfUnassigned(instance);
					this.tagUntaggedGroups();
					this._stableScopeTracker.observe(instance.instanceId, this.resolveScope(instance.instanceId));
					this.recordPersistentProcessScopes([instance]);
					this.persistMapping();
				}
			});
		this._initialCwdResolutions.set(instance, resolution);
	}

	private recordPersistentProcessScopes(instances: readonly ITerminalInstance[]): void {
		for (const instance of instances) {
			const persistentProcessId = this.getPersistentProcessId(instance);
			if (persistentProcessId === undefined) {
				continue;
			}
			const previousPersistentProcessId = this._persistentProcessIdByInstance.get(instance.instanceId);
			if (previousPersistentProcessId !== undefined && previousPersistentProcessId !== persistentProcessId) {
				if (this._instanceIdByPersistentProcessId.get(previousPersistentProcessId) === instance.instanceId) {
					this._instanceIdByPersistentProcessId.delete(previousPersistentProcessId);
					this._persistentProcessScopes.delete(previousPersistentProcessId);
				}
			}
			this._persistentProcessIdByInstance.set(instance.instanceId, persistentProcessId);
			this._instanceIdByPersistentProcessId.set(persistentProcessId, instance.instanceId);
		}
		paradisRecordPersistentProcessScopes(this._instanceScopes, this._persistentProcessScopes, instances.map(instance => this.toScopedInstance(instance)));
	}

	private getPersistentProcessId(instance: ITerminalInstance): number | undefined {
		return instance.persistentProcessId
			?? this._persistentProcessIdByInstance.get(instance.instanceId)
			?? instance.shellLaunchConfig.attachPersistentProcess?.id;
	}

	private toScopedInstance(instance: ITerminalInstance): { readonly instanceId: number; readonly persistentProcessId?: number } {
		const persistentProcessId = this.getPersistentProcessId(instance);
		return persistentProcessId === undefined
			? { instanceId: instance.instanceId }
			: { instanceId: instance.instanceId, persistentProcessId };
	}

	private toRestoredScopedInstance(instance: ITerminalInstance): IParadisScopedTerminalInstanceLike {
		const attachTarget = instance.shellLaunchConfig.attachPersistentProcess;
		return attachTarget === undefined
			? { instanceId: instance.instanceId }
			: {
				instanceId: instance.instanceId,
				persistentProcessId: attachTarget.id,
				restoredPersistentProcessId: attachTarget.paradisRevivedFromPersistentProcessId,
			};
	}

	/**
	 * このグループの所属リポジトリを、構成インスタンスから引く。
	 * 今セッション中に一度でもタグ付けしたことがあれば `_instanceScopes` が最新の対応を持つ
	 * (グループオブジェクトが作り直されても instanceId は安定するため)。
	 * 今セッションでまだ一度もタグ付けしていない (リロード直後の復元グループ) 場合のみ、
	 * persistent process台帳にフォールバックする。
	 */
	private resolveGroupScope(group: ITerminalGroup): string | undefined {
		return paradisLookupInstanceScope(this._instanceScopes, this._restoredPersistentProcessScopes, group.terminalInstances.map(instance => this.toRestoredScopedInstance(instance)));
	}

	private resolveGroupInitialCwdScope(group: ITerminalGroup): string | undefined {
		for (const instance of group.terminalInstances) {
			const stateKey = this.resolveInstanceInitialCwdScope(instance);
			if (stateKey !== undefined) {
				return stateKey;
			}
		}
		return undefined;
	}

	private resolveInstanceInitialCwdScope(instance: ITerminalInstance): string | undefined {
		if (!this._initialCwdResolvedInstances.has(instance.instanceId) || !this._worktreeSnapshotReady) {
			return undefined;
		}
		const roots: IParadisTerminalScopeRoot[] = [];
		for (const repository of this.workspaceSwitchService.repositories) {
			if (repository.uri.scheme === 'file') {
				roots.push({ root: repository.uri.fsPath, stateKey: repository.id });
			}
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (!worktree.missing && worktree.uri.scheme === 'file') {
					roots.push({ root: worktree.uri.fsPath, stateKey: paradisWorktreeStateKey(worktree.uri) });
				}
			}
		}
		return paradisResolveInitialCwdScope(this._initialCwds.get(instance.instanceId), roots);
	}

	private recordRecoveredScopeIfUnassigned(instance: ITerminalInstance): void {
		this.ensureScopeCandidate(instance);
		if (this._instanceScopes.has(instance.instanceId)) {
			return;
		}
		const containingStateKey = this.getGroupStateKey(instance.instanceId) ?? this.getParkedEditorStateKey(instance.instanceId);
		if (containingStateKey !== undefined) {
			this._instanceScopes.set(instance.instanceId, containingStateKey);
			this._activeFallbackInstances.delete(instance.instanceId);
			return;
		}
		if (paradisRestorePersistentProcessScope(this._instanceScopes, this._restoredPersistentProcessScopes, this.toRestoredScopedInstance(instance)) !== undefined) {
			this._activeFallbackInstances.delete(instance.instanceId);
			return;
		}
		const initialCwdStateKey = this.resolveInstanceInitialCwdScope(instance);
		const candidate = paradisResolveTerminalScopeCandidate({
			initialCwdResolved: this._initialCwdResolvedInstances.has(instance.instanceId),
			worktreeSnapshotReady: this._worktreeSnapshotReady,
			initialCwdStateKey,
			activeStateKeyCandidate: this._activeScopeCandidates.get(instance.instanceId),
		});
		if (candidate.status === 'resolved' && candidate.stateKey !== undefined) {
			this._instanceScopes.set(instance.instanceId, candidate.stateKey);
			if (initialCwdStateKey === undefined && candidate.stateKey === this._activeScopeCandidates.get(instance.instanceId)) {
				this._activeFallbackInstances.add(instance.instanceId);
			} else {
				this._activeFallbackInstances.delete(instance.instanceId);
			}
		}
	}

	private reevaluateActiveFallbackScopes(): void {
		for (const instanceId of [...this._activeFallbackInstances]) {
			const instance = this.findLiveInstance(instanceId);
			if (instance === undefined) {
				this._activeFallbackInstances.delete(instanceId);
				continue;
			}
			const initialCwdStateKey = this.resolveInstanceInitialCwdScope(instance);
			if (initialCwdStateKey !== undefined && initialCwdStateKey !== this._instanceScopes.get(instanceId)) {
				this.assignInstanceScope(instanceId, initialCwdStateKey);
			}
		}
	}

	private tagUntaggedGroups(): void {
		const groupService = this.terminalGroupService;
		if (!(groupService instanceof TerminalGroupService)) {
			return;
		}

		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		let changed = false;
		for (const group of [...groupService.groups]) {
			if (this._groupRepositories.has(group)) {
				continue;
			}
			for (const instance of group.terminalInstances) {
				this.ensureScopeCandidate(instance);
				this.recordRecoveredScopeIfUnassigned(instance);
			}

			// 既知の対応 (今セッション中のタグ付け実績、またはリロード前の保存済みマッピング) を
			// 優先する。initial cwd/worktree snapshotが未確定ならタグ付け自体を保留する。
			const stateKey = this.resolveGroupScope(group) ?? this.resolveGroupInitialCwdScope(group);
			if (!stateKey) {
				continue;
			}

			this._groupRepositories.set(group, stateKey);
			this.recordInstanceScopes(group, stateKey);
			changed = true;

			if (stateKey !== activeStateKey) {
				this.parkGroup(groupService, group, stateKey);
			}
		}
		if (changed) {
			this.persistMapping();
		}
	}

	private parkGroup(groupService: TerminalGroupService, group: ITerminalGroup, repositoryId: string): void {
		groupService.paradisParkGroup(group);
		let parked = this._parkedGroups.get(repositoryId);
		if (!parked) {
			parked = [];
			this._parkedGroups.set(repositoryId, parked);
		}
		parked.push(group);
	}

	private applyScope(targetStateKey: string): void {
		const groupService = this.terminalGroupService;
		if (!(groupService instanceof TerminalGroupService)) {
			return;
		}

		// 他エントリのグループを退避
		for (const group of [...groupService.groups]) {
			const stateKey = this._groupRepositories.get(group);
			if (stateKey !== undefined && stateKey !== targetStateKey) {
				this.parkGroup(groupService, group, stateKey);
			}
		}

		// 切り替え先のグループを復帰
		const parked = this._parkedGroups.get(targetStateKey);
		if (parked) {
			this._parkedGroups.delete(targetStateKey);
			for (const group of parked) {
				groupService.paradisUnparkGroup(group);
			}
		}

		// エディタターミナルの復元は working set の deserialize → reviveInput が担うが、
		// 復路の working set が park 世代と一致しない等でルックアップに到達しないと、
		// インスタンスが台帳に残り PTY だけが不可視のまま生き続ける（タブは復元されない）。
		// 切り替え完了時点で台帳に残っている切り替え先スコープの分を明示的に開き直す。
		// 正常に revive された分は台帳から取り出し済みのため二重復元にはならない
		this.unparkEditorTerminals(targetStateKey);

		this.persistMapping();
		this.refreshAllStableScopes();
	}

	/** 切り替え先スコープの park 台帳に残留したエディタターミナルをエディタとして開き直す */
	private unparkEditorTerminals(targetStateKey: string): void {
		const instances = paradisTakeParkedTerminalEditorInstancesForScope(targetStateKey);
		if (instances.length === 0) {
			return;
		}
		// openEditor は非同期で、この間にユーザーがさらに別スコープへ切り替えている可能性がある。
		// 取り出したまま開けない・開き損ねたインスタンスは台帳へ戻し、次の切り替えか
		// スコープ退役で必ず回収されるようにする（戻さないと PTY がどこからも参照されず漏れる）。
		// 取り出し後に dispose されたインスタンスは開かず・戻さず捨てる（take で台帳の
		// onDisposed 掃除が外れているため、戻すと死んだエントリが残り続ける）
		(async () => {
			for (const instance of instances) {
				if (instance.isDisposed) {
					continue;
				}
				if (this.workspaceSwitchService.activeStateKey !== targetStateKey) {
					paradisParkTerminalEditorInstance(instance, targetStateKey);
					continue;
				}
				try {
					await this.terminalEditorService.openEditor(instance);
				} catch (error) {
					if (!instance.isDisposed) {
						paradisParkTerminalEditorInstance(instance, targetStateKey);
					}
					onUnexpectedError(error);
				}
			}
		})();
	}

	/**
	 * 退役したスコープ (リポジトリ削除 / worktree 削除) の park 中グループを実体ごと破棄する。
	 * 各インスタンスを User 破棄すると PTY が停止し、最後のインスタンス破棄でグループが onDisposed
	 * を発火する。それを受けて terminalGroupService 側が paradisParkedGroups から外し (レイアウト
	 * 永続化から除外)、こちらの discardGroup が _groupRepositories / _parkedGroups を掃除する。
	 */
	private retireScope(stateKey: string): void {
		const liveInstances = [...this.collectLiveInstances().values()];
		const retiringInstanceIds = paradisCollectRetiringTerminalInstanceIds(
			this._instanceScopes,
			this._persistentProcessScopes,
			stateKey,
			liveInstances.map(instance => this.toScopedInstance(instance)),
		);
		const retiringInstanceIdSet = new Set(retiringInstanceIds);
		const retiringInstances = new Map(liveInstances
			.filter(instance => retiringInstanceIdSet.has(instance.instanceId))
			.map(instance => [instance.instanceId, instance] as const));
		paradisRetireTerminalScope(this._instanceScopes, this._persistentProcessScopes, stateKey);
		for (const [persistentProcessId, assignedStateKey] of this._restoredPersistentProcessScopes) {
			if (assignedStateKey === stateKey) {
				this._restoredPersistentProcessScopes.delete(persistentProcessId);
			}
		}
		for (const [persistentProcessId, assignedStateKey] of this._quarantinedPersistentProcessScopes) {
			if (assignedStateKey === stateKey) {
				this._quarantinedPersistentProcessScopes.delete(persistentProcessId);
			}
		}
		for (const instanceId of retiringInstanceIds) {
			const persistentProcessId = this._persistentProcessIdByInstance.get(instanceId);
			if (persistentProcessId !== undefined && this._instanceIdByPersistentProcessId.get(persistentProcessId) === instanceId) {
				this._instanceIdByPersistentProcessId.delete(persistentProcessId);
			}
			this._persistentProcessIdByInstance.delete(instanceId);
			this._activeScopeCandidates.delete(instanceId);
			this._candidateCapturedInstances.delete(instanceId);
			this._initialCwds.delete(instanceId);
			this._initialCwdResolvedInstances.delete(instanceId);
			this._activeFallbackInstances.delete(instanceId);
			this._stableScopeTracker.retire(instanceId);
		}

		// 台帳削除前にexact ownerとして捕捉したvisible/background/parked instanceだけを破棄する。
		for (const instance of retiringInstances.values()) {
			if (!instance.isDisposed) {
				instance.dispose(TerminalExitReason.User);
			}
		}
		this._parkedGroups.delete(stateKey);
		this.persistMapping();
	}

	private discardGroup(group: ITerminalGroup): void {
		this._groupRepositories.delete(group);
		for (const [repositoryId, groups] of this._parkedGroups) {
			const index = groups.indexOf(group);
			if (index !== -1) {
				groups.splice(index, 1);
				if (groups.length === 0) {
					this._parkedGroups.delete(repositoryId);
				}
			}
		}
	}

	/**
	 * 再接続完了後の掃除。タグ付け時点で persistentProcessId が未確定でマッピングを
	 * 引けず、誤ってアクティブリポジトリ扱いになった復元グループを正しい対応に直す。
	 */
	private sweepRestoredGroups(): void {
		const groupService = this.terminalGroupService;
		if (!(groupService instanceof TerminalGroupService)) {
			return;
		}

		if (this._persistentProcessScopes.size === 0) {
			return;
		}

		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		let changed = false;
		for (const group of [...groupService.groups]) {
			const restoredStateKey = this.resolveGroupScope(group);
			if (!restoredStateKey || this._groupRepositories.get(group) === restoredStateKey) {
				continue;
			}

			this._groupRepositories.set(group, restoredStateKey);
			this.recordInstanceScopes(group, restoredStateKey, true);
			changed = true;

			if (restoredStateKey !== activeStateKey) {
				this.parkGroup(groupService, group, restoredStateKey);
			}
		}
		if (changed) {
			this.persistMapping();
		}
	}

	private persistMapping(): void {
		// 初回worktree snapshot前の未知scopeは採用しないが、barrier確定前の別イベントで
		// storageから失われないよう隔離状態のまま保存対象には残す。今セッション確定値を優先する。
		const persistedScopes = paradisMergePersistentProcessScopesForStorage(this._quarantinedPersistentProcessScopes, this._persistentProcessScopes);
		const raw = paradisSerializeTerminalProcessScopeStorage(persistedScopes);
		if (raw !== undefined) {
			this.storageService.store(ParadisTerminalWorkspaceScope.MAPPING_STORAGE_KEY, raw, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}

	private loadMapping(): Map<number, string> {
		const raw = this.storageService.get(ParadisTerminalWorkspaceScope.MAPPING_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return new Map();
		}
		return paradisParseTerminalProcessScopeStorage(raw) ?? new Map();
	}

	private knownStateKeys(includeWorktrees: boolean): Set<string> {
		const result = new Set<string>();
		for (const repository of this.workspaceSwitchService.repositories) {
			result.add(repository.id);
			if (!includeWorktrees) {
				continue;
			}
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (!worktree.missing) {
					result.add(paradisWorktreeStateKey(worktree.uri));
				}
			}
		}
		return result;
	}
}

registerSingleton(IParadisTerminalScopeService, ParadisTerminalWorkspaceScope, InstantiationType.Delayed);

/** シングルトンを AfterRestored で確実に起動させるためのスターター */
class ParadisTerminalScopeStarter implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalScopeStarter';
	constructor(@IParadisTerminalScopeService _service: IParadisTerminalScopeService) { }
}

registerWorkbenchContribution2(ParadisTerminalScopeStarter.ID, ParadisTerminalScopeStarter, WorkbenchPhase.AfterRestored);
