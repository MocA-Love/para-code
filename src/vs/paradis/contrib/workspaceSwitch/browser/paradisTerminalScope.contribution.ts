/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { disposableTimeout } from '../../../../base/common/async.js';
import { BugIndicatingError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { getActiveWindow } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { TerminalExitReason, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IProcessDetails } from '../../../../platform/terminal/common/terminalProcess.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITerminalEditorService, ITerminalGroup, ITerminalGroupService, ITerminalInstance, ITerminalInstanceService, ITerminalService, TerminalConnectionState } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalGroupService } from '../../../../workbench/contrib/terminal/browser/terminalGroupService.js';
import { paradisRegisterTerminalCreationScopeProvider, paradisTakeTerminalCreationScopeLease } from '../../../../workbench/contrib/terminal/browser/paradisTerminalCreationScope.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IParadisAuxiliaryWindowScopeService, IParadisTerminalScopeService, IParadisTerminalStableScopeChangeEvent, IParadisWorkspaceSwitchService, IParadisWorktreeService, ParadisBindingScope, ParadisTerminalInstanceRetirementTracker, ParadisTerminalStableScopeTracker, paradisResolveTerminalBindingScope, paradisWorktreeStateKey, PARADIS_UNATTRIBUTED_TERMINAL_SCOPE } from '../common/paradisWorkspaceSwitch.js';
import { IParadisScopedTerminalInstanceLike, IParadisTerminalScopeRoot, paradisCollectRetiringTerminalInstanceIds, paradisLookupInstanceScope, paradisMergePersistentProcessScopesForStorage, paradisParseTerminalProcessScopeStorage, paradisPartitionPersistentProcessScopesByKnownScope, paradisPrunePersistentProcessScopes, paradisRecordInstanceScopes, paradisRecordPersistentProcessScopes, paradisResolveInitialCwdScope, paradisResolveTerminalScopeCandidate, paradisShouldParkUnattributedGroup, paradisRestorePersistentProcessScope, paradisRetireInstanceScope, paradisRetireTerminalScope, paradisSerializeTerminalProcessScopeStorage } from '../common/paradisTerminalProcessScope.js';
import { IParadisTerminalNonceScopeDisagreement, paradisMigrateProcessScopesToNonceScopes, paradisParseTerminalNonceScopeStorage, paradisPruneNonceScopes, paradisResolveNonceScope, paradisSerializeTerminalNonceScopeStorage } from '../common/paradisTerminalNonceScope.js';
import { paradisGetParkedTerminalEditorStateKey, paradisIsOrphanTerminalRevivalComplete, paradisListParkedTerminalEditorInstances, paradisMarkOrphanTerminalRevivalComplete, paradisParkTerminalEditorInstance, paradisRegisterParkedTerminalGroupProbe, paradisTakeParkedTerminalEditorInstancesForScope } from './paradisTerminalEditorPark.js';
import { paradisCurrentRestoreStateKey, paradisRegisterTerminalReviveIndexSource } from './paradisTerminalEditorRevive.js';
import { paradisTerminalIdentityNonce } from '../../mobileRelay/common/paradisTerminalPersistence.js';
import { setParadisSpanAttributes } from '../../sentry/common/paradisSentryDiagnostics.js';

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
/** 読み取り専用の突き合わせで「live 台帳は見ない」ことを表すための空台帳。 */
const EMPTY_INSTANCE_SCOPES: ReadonlyMap<number, string> = new Map<number, string>();

export class ParadisTerminalWorkspaceScope extends Disposable implements IParadisTerminalScopeService {

	declare readonly _serviceBrand: undefined;

	private static readonly MAPPING_STORAGE_KEY = 'paradis.workspaceSwitch.terminalRepositories';
	/** nonce をキーにした所属台帳。旧 MAPPING_STORAGE_KEY とは別に持ち、当面は併存させる。 */
	private static readonly NONCE_MAPPING_STORAGE_KEY = 'paradis.workspaceSwitch.terminalScopesByNonce';

	/**
	 * park の保留を打ち切るまでの上限 (詳細は `_parkDeferralReleased`)。
	 *
	 * 「復元が遅いだけ」の間に打ち切ると、まさに保留が防いでいる split の失敗を自分で起こすため、
	 * 現実の復元時間 (数秒) から大きく離して取る。逆に打ち切りが遅いことの実害は「他スペースの
	 * ターミナルが一覧に見えたまま」だけで、台帳は正しいまま (解除時に引き直す)。
	 */
	private static readonly PARK_DEFERRAL_TIMEOUT_MS = 300_000;

	/** グループ → 所属リポジトリID (park 中も保持)。untagged のグループはスコープ外 (常に表示) */
	private readonly _groupRepositories = new Map<ITerminalGroup, string>();

	/**
	 * スコープの stateKey → park 中のグループ。リポジトリ本体は stateKey が repositoryId と
	 * 一致するので取り違えても表に出なかったが、worktree では別物になる。退役してよいかの
	 * 判定 (paradisRegisterParkedTerminalGroupProbe) がこのキーを stateKey として引くため、
	 * 入れる側も必ず stateKey を渡すこと。
	 */
	private readonly _parkedGroups = new Map<string, ITerminalGroup[]>();

	/** 孤児復活のやり直しが走っている最中か（切り替えのたびに多重起動しないため）。 */
	private _orphanRevivalRetrying = false;

	/**
	 * 前回セッションのレイアウト復元が終わるまで park を保留しているグループ → 所属リポジトリID。
	 *
	 * upstream のレイアウト復元は、1つのタブ (グループ) の2枚目以降のペインを
	 * `{ parentTerminal: 直前のインスタンス }` として作り、split 先のグループを
	 * `TerminalGroupService.getGroupForInstance` で引く。これは **`groups` しか見ない**ため、
	 * 1枚目のペインが現れた瞬間に park (= groups から外す) すると、2枚目の復元が
	 * `Cannot split a terminal without a group` で落ちる。結果として非アクティブスペースの
	 * グループはペインが1枚しか復元されず、残りの PTY は孤児のまま取り残され、さらに
	 * `_recreateTerminalGroups` の Promise が reject して `terminalService.whenConnected` が
	 * 永久に完了しなくなる (= 下の復元後処理も upstream の backend.setReady も走らない)。
	 *
	 * そのため復元中はタグ付けだけ行い、park はここへ溜めて復元完了後にまとめて実行する。
	 *
	 * 保留は park の全経路 (applyScope によるユーザーのスペース切り替えを含む) に効くため、解除まで
	 * の間は切り替えても他スペースのグループがタブ一覧に残る。台帳は正しいまま (解除時に実行時点の
	 * 所属とアクティブスコープで引き直す) なので、見え方だけが遅れて追いつく。
	 */
	private readonly _deferredParkGroups = new Map<ITerminalGroup, string>();

	/**
	 * park の保留を解除したか。`whenConnected` の完了で立てるが、復元経路が例外で落ちると
	 * それは二度と来ない (まさに上のコメントが説明している壊れ方)。保留したままだと他スペースの
	 * ターミナルがアクティブスペースに見え続けるため、上限時間でも必ず解除する。
	 */
	private _parkDeferralReleased = false;

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
	/**
	 * 端末を初めて見た時点で working set の復元中だったスペース。
	 *
	 * エディタ領域の端末はスペースごとの working set の中にしか居ないので、「どの working set から
	 * 出てきたか」がそのまま所属の根拠になる（パネルのグループは全スペース分がまとめて復元される
	 * ため、同じことが言えない）。切り替え以外の経路では未設定で、その場合は起動時のアクティブ
	 * スペース（= 復元される working set の持ち主）を根拠にする。
	 */
	private readonly _restoreScopeCandidates = new Map<number, string>();
	/**
	 * 初めて見た時点で「前セッションから復元された端末」だったもの。
	 *
	 * `shellLaunchConfig.attachPersistentProcess` を毎回読んではいけない。attach に失敗すると
	 * terminalProcessManager がその場で undefined に書き換えるので、復元端末が新規端末に化け、
	 * しかも書き換えが非同期なため判定を引く時刻次第で答えが変わる。
	 */
	private readonly _restoredInstances = new Set<number>();
	private readonly _candidateCapturedInstances = new Set<number>();
	private readonly _initialCwds = new Map<number, string>();
	private readonly _initialCwdResolvedInstances = new Set<number>();
	/**
	 * 作られた時のスペースを根拠にしただけの端末。cwd が判明したら訂正する前提で、nonce 台帳
	 * （revive をまたいで不変＝訂正の機会が二度と来ない）には書かない。
	 *
	 * pid 台帳には書く。書かないと、cwd を引けない構成（リモート、worktree 列挙が遅い起動）で
	 * ユーザー自身が作った端末がリロードのたびに所属不明へ戻って隠れてしまう。その代わり、
	 * 同じ pty host 世代のリロードでは pid 台帳から印の無い確定値として読み戻される
	 * （`recordRecoveredScopeIfUnassigned`）＝**推測は1度のリロードで確定に昇格する**。
	 * 昇格するのは「ユーザーがそのスペースで作った端末」に限られるので許容している。
	 */
	private readonly _activeFallbackInstances = new Set<number>();
	/**
	 * 同居しているグループから所属を借りているだけで、自分の根拠は無い端末。
	 *
	 * `_activeFallbackInstances`（作られた時のスペースという自前の根拠がある推測）とは分けて持つ。
	 * あちらは pid 台帳へ書いてよい——書かないと、リロードのたびに「どこのものか分からない端末」に
	 * 戻って隠れてしまう。こちらは自前の根拠がゼロなので、**どの台帳にも書かない**。書くと1度の
	 * リロードで pid 台帳から確定値として読み戻され、cwd による訂正の機会が永久に来なくなる。
	 */
	private readonly _inheritedGroupScopes = new Set<number>();
	/** nonce 台帳と ID 台帳が食い違った回数。0 のままなら nonce を信頼してよい。 */
	private _nonceScopeDisagreements = 0;
	/** グループの所属と構成員の自前の根拠が食い違った回数。 */
	private _groupScopeDisagreements = 0;
	/**
	 * 所属が分からないまま待避しているグループ。`_groupRepositories` とは別に持つ
	 * （あちらへ入れると目印が所属として台帳へ焼き付き、cwd による自己修復を殺す）。
	 */
	private readonly _unattributedGroups = new Set<ITerminalGroup>();
	/**
	 * 直前の引き取りで今のスペースへ入れたグループ。取り消しの対象はこの1回分だけ持つ
	 * （何回でも遡れる履歴にすると、間にユーザーが並べ替えた結果を巻き戻すことになる）。
	 */
	private _lastAdoption: { readonly groups: ITerminalGroup[]; readonly stateKey: string; readonly instanceIds: ReadonlySet<number> } | undefined;
	/**
	 * 表示中の「待避しました」通知。閉じられたら捨てて、次に待避が起きたらまた知らせる。
	 * 出しっぱなしを1つに抑えるだけで、1ウィンドウにつき1回きりにはしない
	 * （2回目以降に隠れた端末は、ユーザーからは黙って消えたようにしか見えない）。
	 */
	private _unattributedNotice: INotificationHandle | undefined;
	/** 出しっぱなしの案内があるか。ハンドルを受け取る前に閉じられても取りこぼさないための印。 */
	private _unattributedNoticeOpen = false;
	private readonly _unattributedNoticeListener = this._register(new MutableDisposable());
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

	// 所属スペースを nonce で引く台帳。PTY ID の台帳と違い、キーは端末の構築時に同期で決まり
	// revive をまたいでも変わらないので、「ID 未確定のまま落ちて漏れる」「revive で対応が切れる」
	// が起きない。ID 台帳より先に引くが、食い違ったら ID 台帳を採る（nonce の不変性はコードで
	// 追った内容で実機未検証のため、先に引く方を信じて誤ったスペースへ寄せることを避ける）。
	//
	// ID 台帳と同じく読み側と書き側を分ける。非アクティブスペースの端末は、そのスペースへ
	// 切り替えるまで live にならない＝起動時の prune では消せない。1枚で兼ねると、まさに
	// この台帳が拾うはずの端末を起動のたびに自分で捨てることになる。

	/** 書き側。今セッションで確定した分だけを持ち、live でなくなった分は prune される。 */
	private readonly _nonceScopes: Map<string, string>;
	/** 読み側。前セッションから復元した対応で、prune しない。 */
	private readonly _restoredNonceScopes: Map<string, string>;

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
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		// 復元は数秒で終わる。ここまで待っても完了しないなら復元経路が落ちていると見なし、
		// 他スペースのターミナルが見え続けないよう park の保留を打ち切る。
		this._register(disposableTimeout(() => this.releaseParkDeferral(), ParadisTerminalWorkspaceScope.PARK_DEFERRAL_TIMEOUT_MS));
		this._register(paradisRegisterTerminalCreationScopeProvider(() => {
			const scope = this.auxiliaryWindowScopeService.resolveWindow(getActiveWindow().vscodeWindowId);
			return scope.kind === 'managed' ? scope.stateKey : undefined;
		}));

		// working set の復元が「正体の確認できない PTY ID へ attach する」のを防ぐための索引。
		// 供給できるのはこのサービスだけ（backend と live インスタンス台帳の両方を持っている）。
		this._register(paradisRegisterTerminalReviveIndexSource({
			listOrphanPtyIdsByNonce: () => this.listOrphanPtyIdsByNonce(),
			listHeldPtyIds: () => this.listHeldPtyIds(),
		}));

		const loadedMapping = this.loadMapping();
		const initialPartition = paradisPartitionPersistentProcessScopesByKnownScope(loadedMapping, this.knownStateKeys());
		this._persistentProcessScopes = new Map(initialPartition.accepted);
		this._restoredPersistentProcessScopes = new Map(initialPartition.accepted);
		this._quarantinedPersistentProcessScopes = initialPartition.quarantined;
		const loadedNonceMapping = this.loadNonceMapping();
		this._nonceScopes = new Map(loadedNonceMapping);
		this._restoredNonceScopes = new Map(loadedNonceMapping);

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
		// スコープを捨ててよいかの判定は park 中の端末を見る必要があるが、DI では循環するので
		// パネル側の台帳を引く口だけ渡しておく
		this._register(paradisRegisterParkedTerminalGroupProbe(stateKey => this._parkedGroups.has(stateKey)));

		this._register(this.workspaceSwitchService.registerSwitchCompletionParticipant(async stateKey => {
			await this.applyScope(stateKey);
			// 起動時の孤児復活は切り替えが始まると途中で降りる。降りた分は誰も拾わないので、
			// 切り替えが終わったここでやり直す。完走済みなら何もしない。この再探索は従来どおり
			// バックグラウンドで行い、PTY バックエンドの応答を次のスペース切り替えの待機条件にしない
			void this.retryOrphanRevivalIfInterrupted();
		}));
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
			// 復元中に保留した park はここで実行する。sweep でタグ付けを直した後に流すこと。
			this.releaseParkDeferral();
			// 非アクティブスコープのエディタターミナルは working set (シリアライズ済みエディタ入力)
			// の中にしか存在せず、リロード後はそのスコープへ切り替えるまで live インスタンスに
			// ならない。この間、PTY は生きているのに端末はどの一覧にも現れず、モバイルからは
			// 存在ごと消える。pty host の孤児プロセスから所属スコープ既知のものを再接続して
			// park 台帳へ戻し、prune がマッピングを失う前に live へ復帰させる。
			// マッピングは await 中に別の起動ハンドラ (worktree 初期化バリア等) の prune で
			// 消され得るため、ここで同期的に確定した写しを渡す。worktree スコープ分は
			// バリア完了まで quarantine 側に居るので、両方を合わせて引けるようにする。
			const scopeSnapshot = new Map([...this._quarantinedPersistentProcessScopes, ...this._restoredPersistentProcessScopes]);
			// 一巡し切ったときだけ記録する。中断した場合は「台帳が空 = 端末が無い」とは言えず、
			// worktree 側の missing 自動退役がそれを根拠にすると生きた PTY を巻き添えにする
			const revivalComplete = await this.reviveOrphanedScopedEditorTerminals(scopeSnapshot);
			if (revivalComplete) {
				paradisMarkOrphanTerminalRevivalComplete();
			}
			if (this._store.isDisposed) {
				return;
			}
			const liveInstances = this.refreshAllStableScopes();
			paradisPrunePersistentProcessScopes(this._persistentProcessScopes, liveInstances.map(instance => this.toScopedInstance(instance)));
			// 復活が中断していたら prune しない。非アクティブスペースの端末はまだ live になって
			// おらず、ここで落とすと「この台帳が拾うべきエントリ」を保存から消してしまう
			// （読み側は残るのでこの世代は無事だが、次回起動で失う）。
			if (revivalComplete) {
				this.pruneNonceScopes(liveInstances);
			}
			this.persistMapping();
		});
		void this.worktreeService.initializationBarrier.then(() => {
			if (this._store.isDisposed) {
				return;
			}
			this._worktreeSnapshotReady = true;
			// バリア後は、この時点でまだ登録一覧に現れない stateKey も含めて隔離分を全件採用する。
			// 未知のまま捨てると、その端末はスコープ無しになり initial cwd も登録ルートに一致しない
			// ため「起動時のアクティブスペース」へ恒久的に吸収され、別スペース (別ディレクトリ) の
			// 端末が現スペースに紛れ込む。worktree の列挙が遅れた・一時的に失敗した起動で顕在化し、
			// 一度吸収されると台帳が上書きされて元に戻らない。通常のスコープ退役 (ユーザーによる
			// worktree/リポジトリの削除) は onDidRetireScope → retireScope が両台帳から実体ごと消す。
			//
			// トレードオフ: アプリ終了中に外部から worktree を消された等でこのキーが二度と現れない
			// 場合、その端末は park されたままどのスペースからも見えなくなる (PTY は生存し、レイアウト
			// 永続化で復元され続ける)。「知らない端末が現スペースに混ざる」より「見えない」方を選んだ。
			// 見えない側は台帳を消せば回復できるが、混ざった側は所属が上書きされて回復手段が無い。
			for (const [persistentProcessId, stateKey] of this._quarantinedPersistentProcessScopes) {
				if (!this._persistentProcessScopes.has(persistentProcessId)) {
					this._persistentProcessScopes.set(persistentProcessId, stateKey);
				}
				this._restoredPersistentProcessScopes.set(persistentProcessId, stateKey);
			}
			this._quarantinedPersistentProcessScopes.clear();
			const liveInstances = this.refreshAllStableScopes();
			if (this._terminalRestoreComplete) {
				paradisPrunePersistentProcessScopes(this._persistentProcessScopes, liveInstances.map(instance => this.toScopedInstance(instance)));
				// 孤児復活が一巡していなければ、まだ live になっていない端末が居る。上と同じ理由で
				// その状態の live 一覧を根拠に nonce 台帳を削ってはいけない。
				if (paradisIsOrphanTerminalRevivalComplete()) {
					this.pruneNonceScopes(liveInstances);
				}
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
		// 待避中の端末は「どのスペースの持ち物でもない」ので、所属を尋ねられても
		// アクティブスペースを答えない（下の解決は所属不明なら最後にそこへ落ちる）。
		// ここで答えてしまうと、モバイル・通知・binding authority が一度その所属で観測し、
		// 実在しないスペースの持ち物として扱われる。
		if (this.isUnattributedInstance(instanceId)) {
			return { kind: 'pending' };
		}
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
		this._inheritedGroupScopes.delete(instanceId);
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
			// ここだけは構成員の根拠と突き合わせない。ユーザー（またはモバイル）が明示的に指定した
			// 移動で、表示単位はグループなので、同居している端末も一緒に動くのが期待どおり。
			// 突き合わせを挟むと「指定したのに動かない端末がある」ことになる。
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
		// 切り替えの最中は「所属＝復元先」「アクティブ＝切り替え元」がずれている区間があり、
		// そのまま比べると復元したばかりの端末を detach してしまう。切り替え側の復元経路に任せる。
		if (this.workspaceSwitchService.isSwitching) {
			return;
		}
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

	/**
	 * グループの構成インスタンスの instanceId に、このタグ付けを記録する。
	 * @param derivedFromGroup 所属を「同居している誰か」から引いた場合は true。構成員ごとに
	 * 自前の根拠と突き合わせ、食い違いを黙って上書きしない（`reconcileGroupScope`）。
	 * ユーザーやモバイルの明示指定は false のまま全員へ確定させる。
	 */
	private recordInstanceScopes(group: ITerminalGroup, stateKey: string, clearGuessMarks = false, derivedFromGroup = false): void {
		// 同時には立たない。突き合わせて付けた印をその場で消すと、書き出しの1回ぶんしか
		// 守れず、直後の `refreshAllStableScopes` などで借り物が台帳へ入る。
		//
		// 投げない。この関数は復元完了後の一連の処理 (`whenConnected` の then) から呼ばれ、
		// そこには catch が無い。投げると park の保留解除も孤児復活も台帳の掃除も丸ごと飛び、
		// 「印を1回消す」より遥かに悪い状態（他スペースの端末が見え続ける）になる。
		// 報告だけして、安全な側 (`derivedFromGroup`) の意味で続行する。
		if (clearGuessMarks && derivedFromGroup) {
			onUnexpectedError(new BugIndicatingError('paradisTerminalScope: a derived group scope must not clear the guess marks it just made'));
			clearGuessMarks = false;
		}
		// 所属が決まったグループは、もう「所属不明」ではない。印を残すと台帳には所属があるのに
		// `resolveScope` は pending を返し続ける、という食い違いになる。
		this._unattributedGroups.delete(group);
		const liveInstances = group.terminalInstances.filter(instance => !instance.isDisposed);
		if (derivedFromGroup) {
			for (const instance of liveInstances) {
				this.reconcileGroupScope(instance, stateKey);
			}
		} else {
			paradisRecordInstanceScopes(this._instanceScopes, liveInstances, stateKey);
		}
		this.recordPersistentProcessScopes(liveInstances);
		for (const instance of liveInstances) {
			if (clearGuessMarks) {
				this._activeFallbackInstances.delete(instance.instanceId);
				this._inheritedGroupScopes.delete(instance.instanceId);
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
	/**
	 * 中断された孤児復活をやり直す。切り替えの最中に呼ばれても意味が無いので、
	 * 次の切り替え完了時に改めて試す（多重実行は _orphanRevivalRetrying で防ぐ）。
	 */
	private async retryOrphanRevivalIfInterrupted(): Promise<void> {
		if (paradisIsOrphanTerminalRevivalComplete() || this._orphanRevivalRetrying || this._store.isDisposed) {
			return;
		}
		if (this.workspaceSwitchService.isSwitching) {
			return;
		}
		this._orphanRevivalRetrying = true;
		try {
			const scopeSnapshot = new Map([...this._quarantinedPersistentProcessScopes, ...this._restoredPersistentProcessScopes]);
			if (await this.reviveOrphanedScopedEditorTerminals(scopeSnapshot)) {
				paradisMarkOrphanTerminalRevivalComplete();
			}
		} catch (error) {
			onUnexpectedError(error);
		} finally {
			this._orphanRevivalRetrying = false;
		}
	}

	/**
	 * @returns 孤児を一巡し切ったか。中断した場合は台帳が不完全なので、これを
	 * 「このスコープに端末は無い」の根拠に使ってはいけない。
	 */
	private async reviveOrphanedScopedEditorTerminals(persistentProcessScopes: ReadonlyMap<number, string>): Promise<boolean> {
		let details;
		try {
			const backend = await this.terminalInstanceService.getBackend(this.environmentService.remoteAuthority);
			details = await backend?.listProcesses();
		} catch (error) {
			onUnexpectedError(error);
			return false;
		}
		if (details === undefined) {
			// バックエンドが無い = 復活してくる端末そのものが存在しない
			return true;
		}
		if (this._store.isDisposed) {
			return false;
		}
		const workspaceId = this.workspaceContextService.getWorkspace().id;
		// 旧 ID 台帳から nonce 台帳への翻訳は、ここで既に取れている一覧を使い回す。
		// `listProcesses()` は pty host が孤児判定のためレンダラーへ問い合わせて返事を待つので
		// 安くない。別途もう1往復すると、その分だけ孤児復活の開始が遅れ、ユーザーのスペース
		// 切り替えと競合して完走フラグに届かなくなる確率が上がる。
		this.migrateProcessScopesToNonceScopes(details, workspaceId, persistentProcessScopes);
		// 1件でも取りこぼしたら完走扱いにしない。フラグが保証したいのは「台帳がもう増えない」
		// ではなく「台帳が空ならそのスコープに端末は無い」の方で、復活に失敗した PTY は
		// pty host に生きたまま台帳へ入らないため、両者がずれる
		let complete = true;
		for (const detail of details) {
			// ループは1件ごとに `await instance.processReady` を挟むので、その間にユーザーの
			// スペース切替が走り、同じ PTY を working set 側の revive が先に掴むことがある。
			// 起点で1度だけ作ったスナップショットを使い回すと、その窓で二重アタッチを自分で作る。
			// 毎回引き直し、切替中はそもそも手を出さない（切替側の復元経路に任せる）。
			if (this.workspaceSwitchService.isSwitching) {
				return false;
			}
			const livePersistentProcessIds = this.listHeldPtyIds();
			// 台帳 (`_restoredPersistentProcessScopes`) のキーは「前セッションの PTY ID」だが
			// `detail.id` は今セッションの ID。旧表を新 ID で引くと別スコープのタグを拾い、
			// 誤った stateKey で park されて `…ForScope` / `retireScope` の全経路へ伝播する。
			// **引く ID を先に選んでから1回だけ引く**こと。ルックアップ結果に `??` を掛けると、
			// revive 元 ID が分かっているのに引けなかった時に生 ID へ落ちてしまい、
			// 塞いだはずの「旧表を新 ID で引く」誤りがそのまま復活する
			// (同じ意図の純粋関数 common/paradisTerminalProcessScope.ts の paradisLookupInstanceScope と同型)。
			const scopeLookupId = detail.paradisRevivedFromPersistentProcessId ?? detail.id;
			const stateKey = persistentProcessScopes.get(scopeLookupId);
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
				// `detail.id` は listProcesses 由来＝**今世代の ID**。ここで findRevivedId を立てると
				// `getRevivedPtyNewId` が旧 ID をキーにした `_revivedPtyIdMap` を引き、旧 ID 空間と
				// 新 ID 空間の衝突で別の PTY へリダイレクトされ得る（この修正が塞いだ穴と同じもの）。
				const instance = this.terminalInstanceService.createInstance({ attachPersistentProcess: { ...detail, findRevivedId: false } }, TerminalLocation.Editor);
				await instance.processReady;
				if (this._store.isDisposed || !paradisParkTerminalEditorInstance(instance, stateKey)) {
					// 再接続に失敗した (persistentProcessId が確定しなかった) インスタンスは
					// どの一覧にも属さないため、放置すると不可視のままリークする。
					instance.dispose(TerminalExitReason.Shutdown);
					complete = false;
					continue;
				}
				// 次の周回で listHeldPtyIds() を引き直すので、手元の集合へ足す必要は無い
				// （park 台帳に入った時点で collectLiveInstances から見えるようになる）。
				// park台帳への登録はterminalServiceのイベントに乗らないため、スコープ確定の
				// 変更イベントで購読側（モバイルリレー等）へ「新しいliveペインが増えた」ことを伝える。
				this._instanceScopes.set(instance.instanceId, stateKey);
				this._stableScopeTracker.observe(instance.instanceId, { kind: 'managed', stateKey });
			} catch (error) {
				onUnexpectedError(error);
				complete = false;
			}
		}
		return complete;
	}

	/**
	 * 孤児 PTY を nonce で引けるようにする。`listProcesses()` は最後に `isOrphan` で絞っているので、
	 * 返ってくるのは「今どの renderer も掴んでいない = 安全に attach してよい」ものだけになる。
	 */
	private async listOrphanPtyIdsByNonce(): Promise<ReadonlyMap<string, number>> {
		const result = new Map<string, number>();
		try {
			const backend = await this.terminalInstanceService.getBackend(this.environmentService.remoteAuthority);
			const details = await backend?.listProcesses();
			if (details === undefined || this._store.isDisposed) {
				return result;
			}
			// pty host 側の orphan 判定は「まだ分からない」PTY についてレンダラーへ問い合わせて
			// 返事を待つ (ptyService の _isOrphaned)。所要時間がこの件数に比例するなら、孤児候補
			// だけを判定する方向で往復を減らせる。手元の計測では件数が動かず確かめられなかった。
			setParadisSpanAttributes({ safe_pty_processes: details.length });
			const workspaceId = this.workspaceContextService.getWorkspace().id;
			// 同じ nonce が2件返ることは無い想定だが、万一あれば同一性を証明できないので両方捨てる。
			const duplicated = new Set<string>();
			for (const detail of details) {
				const nonce = paradisTerminalIdentityNonce(detail.shellIntegrationNonce);
				if (nonce === undefined || detail.workspaceId !== workspaceId) {
					continue;
				}
				if (result.has(nonce)) {
					duplicated.add(nonce);
					continue;
				}
				result.set(nonce, detail.id);
			}
			for (const nonce of duplicated) {
				result.delete(nonce);
			}
		} catch (error) {
			onUnexpectedError(error);
		}
		return result;
	}

	/**
	 * 旧 ID 台帳を nonce 台帳へ翻訳する。
	 *
	 * この版で初めて nonce 台帳を持つので、翻訳しないと前セッションから引き継いだ端末が
	 * 「nonce では引けない」状態から始まる。ID 台帳がまだ prune される前に橋を架けておく。
	 *
	 * 対応表にできるのは、渡された一覧に居る PTY だけ。`listProcesses()` は孤児だけを返すので、
	 * 既に attach 済みの端末はここには来ない。そちらは live なので `recordNonceScopes` が
	 * 通常経路で書く。この関数が埋めるのは「まだ誰も掴んでいない前セッションの端末」の分。
	 */
	private migrateProcessScopesToNonceScopes(
		details: readonly IProcessDetails[],
		workspaceId: string,
		persistentProcessScopes: ReadonlyMap<number, string>,
	): void {
		const nonceByPtyId = new Map<number, string>();
		// `scopeLookupId` には「旧 ID 空間の revive 元」と「新 ID 空間の生 ID」が混ざる。どちらも
		// 同じ小さな整数空間なので衝突しうる。Map のキーにする以上、衝突を放置すると片方の nonce が
		// 黙って捨てられ、残った nonce に別端末の stateKey が結びつく。nonce は不変なので、その
		// 誤対応は永久に固定される。同一性を証明できない以上、両方見送る
		// （`listOrphanPtyIdsByNonce` が同じ nonce の重複に対して取っている防御と同じ形）。
		const duplicated = new Set<number>();
		for (const detail of details) {
			const nonce = paradisTerminalIdentityNonce(detail.shellIntegrationNonce);
			// 母集団は孤児ループと揃える。機能端末やユーザーに見せない端末は所属を持たない。
			if (nonce === undefined || detail.workspaceId !== workspaceId
				|| detail.isFeatureTerminal === true || detail.hideFromUser === true) {
				continue;
			}
			// 台帳のキーは「前セッションの PTY ID」で、`detail.id` は今世代の ID。revive 元が
			// 分かっているならそちらで引く（引く ID を先に1つ選ぶ形。ルックアップ結果へ `??` を
			// 掛けるのは別の誤りで、孤児ループのコメントが禁じているのはそちら）。
			const scopeLookupId = detail.paradisRevivedFromPersistentProcessId ?? detail.id;
			if (nonceByPtyId.has(scopeLookupId)) {
				duplicated.add(scopeLookupId);
				continue;
			}
			nonceByPtyId.set(scopeLookupId, nonce);
		}
		for (const scopeLookupId of duplicated) {
			nonceByPtyId.delete(scopeLookupId);
		}
		if (nonceByPtyId.size === 0) {
			return;
		}
		// 読み側にだけ入れる。前セッションの対応であって、今セッションで live になったわけではない。
		const migrated = paradisMigrateProcessScopesToNonceScopes(this._restoredNonceScopes, persistentProcessScopes, nonceByPtyId);
		if (migrated.size === 0) {
			return;
		}
		// 保存するのは書き側なので、**今回足した分だけ**をそちらへ写す。読み側の全件を写すと
		// prune で落とした死んだ記録まで復活してしまう。
		for (const [nonce, stateKey] of migrated) {
			this._nonceScopes.set(nonce, stateKey);
		}
		this.persistNonceMapping();
	}

	/** このウィンドウのインスタンスが掴んでいる PTY ID（park 中・background 含む）。 */
	private listHeldPtyIds(): ReadonlySet<number> {
		const ids = new Set<number>();
		for (const instance of this.collectLiveInstances().values()) {
			const persistentProcessId = this.getPersistentProcessId(instance);
			if (persistentProcessId !== undefined) {
				ids.add(persistentProcessId);
			}
		}
		return ids;
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
			this._restoreScopeCandidates.delete(instanceId);
			this._candidateCapturedInstances.delete(instanceId);
			this._initialCwds.delete(instanceId);
			this._initialCwdResolvedInstances.delete(instanceId);
			this._activeFallbackInstances.delete(instanceId);
			this._inheritedGroupScopes.delete(instanceId);
			this._restoredInstances.delete(instanceId);
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
			// 端末が現れた瞬間にしか読めない。スペース切り替えの復元区間を抜けると消えるため、
			// 後から「この端末はどの working set から出てきたのか」を引き直すことはできない。
			const restoreStateKey = paradisCurrentRestoreStateKey();
			if (restoreStateKey !== undefined) {
				this._restoreScopeCandidates.set(instance.instanceId, restoreStateKey);
			}
			if (instance.shellLaunchConfig.attachPersistentProcess !== undefined) {
				this._restoredInstances.add(instance.instanceId);
			}
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
		// nonce 台帳は pid の確定を待たない。ID 台帳が「pid 未確定のうちは書けない」せいで
		// 漏らしていた端末を、同じ呼び出し地点から取りこぼさずに拾うため先に書く。
		this.recordNonceScopes(instances);
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
		// 借り物の所属は pid 台帳にも書かない。書くと1度のリロードで確定値として読み戻され
		// （pid は同じ pty host 世代なら変わらない）、cwd による訂正の機会が永久に来なくなる。
		paradisRecordPersistentProcessScopes(
			this._instanceScopes,
			this._persistentProcessScopes,
			instances.filter(instance => !this._inheritedGroupScopes.has(instance.instanceId)).map(instance => this.toScopedInstance(instance)),
		);
	}

	private getPersistentProcessId(instance: ITerminalInstance): number | undefined {
		const persistentProcessId = instance.persistentProcessId
			?? this._persistentProcessIdByInstance.get(instance.instanceId)
			?? instance.shellLaunchConfig.attachPersistentProcess?.id;
		// 正体を証明できない入力は、attach させないために存在しない負の ID へ潰されている
		// (paradisTerminalEditorRevive.ts)。attach 失敗が確定するまでの窓でこれを拾うと、
		// 負の ID が scope 台帳に入り persistMapping で永続化されてしまう。
		return persistentProcessId !== undefined && persistentProcessId >= 0 ? persistentProcessId : undefined;
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
		// タグ付け済みのグループへ後から加わった端末（split、background からの復帰、park 台帳から
		// 開き直された端末）はここを通る。`tagUntaggedGroups` はタグ付け済みのグループを丸ごと
		// 飛ばすので、ここで突き合わせないと、グループの所属が印も突き合わせも無しに確定して
		// 台帳へ焼き付く（cwd 解決前に通ると訂正の機会も無くなる）。
		const groupStateKey = this.getGroupStateKey(instance.instanceId);
		if (groupStateKey !== undefined) {
			this.reconcileGroupScope(instance, groupStateKey);
			return;
		}
		// park 台帳の stateKey は「そのスペースの持ち物として明示的に待避した」履歴なので、
		// 同居しているだけのグループとは違い、そのまま確定として扱ってよい。
		const parkedEditorStateKey = this.getParkedEditorStateKey(instance.instanceId);
		if (parkedEditorStateKey !== undefined) {
			this._instanceScopes.set(instance.instanceId, parkedEditorStateKey);
			this._activeFallbackInstances.delete(instance.instanceId);
			return;
		}
		// nonce 台帳を ID 台帳より先に引く。ID 台帳が漏らした端末（pid 未確定のまま落ちた、
		// revive で ID が振り直された）をここで拾えるのが狙い。食い違いは ID 台帳を採るので、
		// 従来引けていた端末の結果は変わらない。
		const processStateKey = paradisRestorePersistentProcessScope(this._instanceScopes, this._restoredPersistentProcessScopes, this.toRestoredScopedInstance(instance));
		const restoredStateKey = paradisResolveNonceScope(
			this._restoredNonceScopes,
			this.instanceNonce(instance),
			processStateKey,
			disagreement => this.reportNonceScopeDisagreement(instance, disagreement),
		);
		if (restoredStateKey !== undefined) {
			this._instanceScopes.set(instance.instanceId, restoredStateKey);
			this._activeFallbackInstances.delete(instance.instanceId);
			return;
		}
		const initialCwdStateKey = this.resolveInstanceInitialCwdScope(instance);
		const candidate = paradisResolveTerminalScopeCandidate({
			initialCwdResolved: this._initialCwdResolvedInstances.has(instance.instanceId),
			worktreeSnapshotReady: this._worktreeSnapshotReady,
			initialCwdStateKey,
			activeStateKeyCandidate: this._activeScopeCandidates.get(instance.instanceId),
			// 復元された端末かどうか。新しく開かれた端末は今までどおり作成時のスペースへ寄せる。
			// 初出時に控えた値を見る（生の `attachPersistentProcess` は attach 失敗で消える）。
			// ここだけ生読みすると、attach に失敗した復元端末が新規端末として扱われて
			// アクティブスペースの推測が入り、待避の判定材料 (`hasScope`) まで崩れる。
			restoredFromPersistentProcess: this._restoredInstances.has(instance.instanceId),
		});
		if (candidate.status === 'resolved' && candidate.stateKey !== undefined) {
			this._instanceScopes.set(instance.instanceId, candidate.stateKey);
			if (initialCwdStateKey === undefined && candidate.stateKey === this._activeScopeCandidates.get(instance.instanceId)) {
				this._activeFallbackInstances.add(instance.instanceId);
			} else {
				this._activeFallbackInstances.delete(instance.instanceId);
			}
			return;
		}
		// ここまでで所属が出なかった端末でも、エディタ領域のものは容れ物が根拠になる（下記参照）。
		// 判定材料が揃う前 (pending) に確定させないよう、resolved まで待ってから引く。
		const containerStateKey = candidate.status === 'resolved' ? this.editorContainerStateKey(instance) : undefined;
		if (containerStateKey !== undefined) {
			this._instanceScopes.set(instance.instanceId, containerStateKey);
			this._activeFallbackInstances.delete(instance.instanceId);
		}
	}

	/**
	 * エディタ領域の端末が「どのスペースの持ち物か」を、それが入っている容れ物から引く。
	 *
	 * パネルのグループは全スペース分がまとめて復元されるので、「今そこに在る」ことは所属の根拠に
	 * ならない（だから根拠の無い復元グループは待避させる）。エディタ領域は事情が逆で、端末は
	 * スペースごとの working set の中にしか存在せず、別スペースのものは切り替えるまで復元すら
	 * されない。つまり「今この working set から出てきた」こと自体が根拠になる。
	 *
	 * **根拠にできるのは復元先スペースが分かっている経路だけ**。分からない経路（起動時のエディタ
	 * 復元、補助ウィンドウの復元など）で「今アクティブなスペース」に落とすのは根拠ではなく推測で、
	 * それを確定として記録すると台帳へ焼き付いて park と退役時の破棄の対象になる。別スペースに
	 * 固定した補助ウィンドウの端末が、起動時にメインウィンドウのスペースへ吸い込まれ、そのスペース
	 * を離れた瞬間に見えていたタブごと detach される、という壊れ方をする。記録しなければ従来どおり
	 * `paradisResolveTerminalBindingScope` が最後にアクティブスペースへ落とすだけで済む
	 * （見え方は同じで、台帳に残らないぶん後から直せる）。
	 */
	private editorContainerStateKey(instance: ITerminalInstance): string | undefined {
		if (!this.terminalEditorService.instances.includes(instance)) {
			return undefined;
		}
		return this._restoreScopeCandidates.get(instance.instanceId);
	}

	/**
	 * 確定していない所属（作られた時のスペースという推測、同居グループからの借り物）を、
	 * cwd が判明した時点で引き直す。どちらの印もここで訂正されることを前提に、台帳への
	 * 書き出しを控えている。
	 */
	private reevaluateActiveFallbackScopes(): void {
		let promoted = false;
		for (const instanceId of new Set([...this._activeFallbackInstances, ...this._inheritedGroupScopes])) {
			const instance = this.findLiveInstance(instanceId);
			if (instance === undefined) {
				this._activeFallbackInstances.delete(instanceId);
				this._inheritedGroupScopes.delete(instanceId);
				continue;
			}
			// cwd が主だが、worktree 一覧の確定で台帳が引けるようになることもある。
			// どちらでも「自前の根拠が出た」ことに変わりはないので、両方見る。
			const resolved = this.resolveInstanceInitialCwdScope(instance) ?? this.ownScopeEvidence(instance);
			if (resolved === undefined) {
				continue;
			}
			// 値が同じでも印は外す（自前の根拠へ昇格させる）。外し忘れると借り物のままどの台帳にも
			// 書かれず、次のセッションで根拠ゼロから始まってしまう。
			//
			// ここで `assignInstanceScope` を使ってはいけない。あれは「ユーザーの明示指定なので
			// グループごと動かす」経路で、同居している端末の所属まで突き合わせ無しに上書きする。
			// これは自動訂正なので、直したい1本だけを動かし、グループの扱いはタグ付けに任せる。
			this._instanceScopes.set(instanceId, resolved);
			this._activeFallbackInstances.delete(instanceId);
			this._inheritedGroupScopes.delete(instanceId);
			this.recordPersistentProcessScopes([instance]);
			this._stableScopeTracker.observe(instanceId, this.resolveScope(instanceId));
			promoted = true;
		}
		if (promoted) {
			this.rehomeGroupsWithoutAClaimingMember();
			// 昇格をここで保存する。呼び出し元はタグ付けが動いたときしか保存しないので、
			// 任せると「次のセッションで根拠ゼロから始まらないようにする」という目的に届かない。
			this.persistMapping();
		}
	}

	/**
	 * 所属を主張する構成員が1人も居なくなったグループを、置き場所ごと計算し直す。
	 *
	 * 訂正は端末1本だけを動かす（グループごと動かすのはユーザーの明示指定のときだけ）。ところが
	 * `tagUntaggedGroups` はタグ付け済みのグループを丸ごと飛ばすので、放っておくとグループの
	 * 置き場所を直す契機がセッション中2度と来ない。1本しか入っていないグループでこれが起きると、
	 * 台帳は正しいのに**別のスペースの端末が今のスペースに出続ける**——避けたかった状態そのもの。
	 *
	 * まだその所属を主張する構成員が残っているグループは触らない（`chooseGroupStateKey` と同じ、
	 * 見えているものを勝手に隠さない側の判断）。
	 */
	private rehomeGroupsWithoutAClaimingMember(): void {
		const groupService = this.terminalGroupService;
		if (!(groupService instanceof TerminalGroupService)) {
			return;
		}
		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		for (const [group, stateKey] of [...this._groupRepositories]) {
			const liveInstances = group.terminalInstances.filter(instance => !instance.isDisposed);
			if (liveInstances.length === 0
				|| liveInstances.some(instance => this.ownScopeEvidence(instance) === stateKey)) {
				continue;
			}
			const resolved = this.resolveGroupScope(group) ?? this.resolveGroupInitialCwdScope(group);
			const next = this.chooseGroupStateKey(group, resolved, activeStateKey);
			if (next === undefined || next === stateKey) {
				continue;
			}
			this.rehomeGroup(groupService, group, next, activeStateKey);
		}
	}

	/** グループを別のスペースへ移す（台帳と、実際に見えているかの両方を合わせる）。 */
	private rehomeGroup(groupService: TerminalGroupService, group: ITerminalGroup, stateKey: string, activeStateKey: string | undefined): void {
		const wasVisible = groupService.groups.includes(group);
		this.removeFromParkLedger(group);
		this._deferredParkGroups.delete(group);
		this._groupRepositories.set(group, stateKey);
		if (stateKey === activeStateKey) {
			if (!wasVisible) {
				groupService.paradisUnparkGroup(group);
			}
			return;
		}
		if (wasVisible) {
			this.parkGroup(groupService, group, stateKey);
			return;
		}
		// 既に隠れている。実体はそのままでよいので、待避先の台帳だけ付け替える。
		this.addToParkLedger(stateKey, group);
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
			const resolvedStateKey = this.resolveGroupScope(group) ?? this.resolveGroupInitialCwdScope(group);
			const stateKey = this.chooseGroupStateKey(group, resolvedStateKey, activeStateKey);
			if (!stateKey) {
				// 所属が分からない復元グループは、アクティブスペースに置いたままにしない。
				// 台帳にも cwd にも根拠が無いのに表示すると、それは「今開いているスペースの
				// 持ち物」に見えてしまう＝混ざる。判定がまだ途中のもの（cwd や worktree 一覧の
				// 確定待ち）は対象外で、次の呼び出しでやり直す。
				if (this.isSettledUnattributedRestoredGroup(group)) {
					this.parkUnattributedGroup(groupService, group);
					changed = true;
				}
				continue;
			}

			this._groupRepositories.set(group, stateKey);
			this.recordInstanceScopes(group, stateKey, false, true);
			changed = true;

			if (stateKey !== activeStateKey) {
				this.parkGroup(groupService, group, stateKey);
			}
		}
		if (changed) {
			this.persistMapping();
		}
	}

	/**
	 * その端末単体で言える所属（同居している他の端末からの伝播を除いた、自前の根拠）。
	 *
	 * どれも読むだけ。`paradisRestorePersistentProcessScope` は引くついでに `_instanceScopes` へ
	 * 書いてしまうので、ここでは使わない。
	 */
	private ownScopeEvidence(instance: ITerminalInstance): string | undefined {
		const recorded = this._instanceScopes.get(instance.instanceId);
		// 借り物・推測として入った値は自前の根拠ではないので、その場合だけ引き直す。
		if (recorded !== undefined
			&& !this._inheritedGroupScopes.has(instance.instanceId)
			&& !this._activeFallbackInstances.has(instance.instanceId)) {
			return recorded;
		}
		// 新しく開かれた端末は「作られた時のスペース」が自分の根拠。復元された端末にはそれが無い。
		if (!this._restoredInstances.has(instance.instanceId)) {
			return this._activeScopeCandidates.get(instance.instanceId);
		}
		// 優先順位は `recordRecoveredScopeIfUnassigned` と揃える。台帳と cwd が食い違う端末
		// （worktree を移した、入れ子のリポジトリで cwd が別スコープの root に最長一致した等）で
		// 答えが経路によって変わると、グループの突き合わせのたびに所属が書き換わる。
		// live 台帳は渡さない。渡すと上で除いたはずの借り物をここで拾い直してしまう。
		const processStateKey = paradisLookupInstanceScope(EMPTY_INSTANCE_SCOPES, this._restoredPersistentProcessScopes, [this.toRestoredScopedInstance(instance)]);
		return paradisResolveNonceScope(this._restoredNonceScopes, this.instanceNonce(instance), processStateKey)
			?? this.resolveInstanceInitialCwdScope(instance)
			?? this.editorContainerStateKey(instance);
	}

	/**
	 * グループを「どのスペースに置くか」を決める。
	 *
	 * `resolveGroupScope` は構成員の**配列順で最初に引けた1本**を採る。構成員の根拠が割れている
	 * グループでは、これはユーザーにもコードを読む人にも予測できない基準になる。表示単位が
	 * グループである以上どちらか一方は間違った場所に出るので、せめて基準を決めておく:
	 * **今見えているスペースを主張する構成員が居るなら、そちらに置く。**
	 *
	 * 隠す方に倒すと、ユーザーがたった今この分割ペインに開いた端末が、スペースを切り替えても
	 * いないのに画面から消える（隠れた先のスペースへ切り替えれば戻るが、消えた側からは
	 * どこへ行ったか分からない）。一方こちらに倒しても、各端末の所属は `reconcileGroupScope` が
	 * 自分の根拠のまま保つので、台帳が混ざることはない。混ざるのは見た目だけで、しかも既に
	 * そう見えていた状態が続くだけになる。
	 *
	 * この選択はタグ付けした瞬間の状況（どのスペースがアクティブか、どの構成員が先に根拠を
	 * 得たか）で決まるので、**同じ混在グループでもセッションごとに置き場所が変わりうる**。
	 * どちらへ倒したかは warn に残してある。
	 */
	private chooseGroupStateKey(group: ITerminalGroup, resolvedStateKey: string | undefined, activeStateKey: string | undefined): string | undefined {
		if (resolvedStateKey === undefined || activeStateKey === undefined || resolvedStateKey === activeStateKey) {
			return resolvedStateKey;
		}
		const claimsActive = group.terminalInstances.some(instance => !instance.isDisposed
			&& this.ownScopeEvidence(instance) === activeStateKey);
		if (!claimsActive) {
			return resolvedStateKey;
		}
		this.logService.warn(`[paradisTerminalScope] a group holds terminals from more than one space; showing it in the active space (${activeStateKey}) instead of ${resolvedStateKey} so nothing disappears from under the user`);
		return activeStateKey;
	}

	/**
	 * グループから所属を引き継ぐときに、構成員それぞれの自前の根拠と突き合わせる。
	 *
	 * グループの所属は「最初に根拠の引けた1本」から決まり、表示も待避もグループ単位でしかできない
	 * ので、同居している端末へ所属が伝わること自体は避けられない。避けられるのは、それを**確定**
	 * として台帳へ焼き付けることの方。
	 * - 自前の根拠が無い構成員: 借り物の印を付ける（どの台帳にも書かず、cwd が判明したら訂正する）
	 * - 自前の根拠がグループと食い違う構成員: 上書きしない。自分の根拠の方を残す
	 *   （グループの見た目は1つでも、どのスペースの持ち物かという答えまで混ぜる理由は無い）
	 */
	private reconcileGroupScope(instance: ITerminalInstance, stateKey: string): void {
		const own = this.ownScopeEvidence(instance);
		if (own === undefined) {
			this._inheritedGroupScopes.add(instance.instanceId);
			this._instanceScopes.set(instance.instanceId, stateKey);
			return;
		}
		this._inheritedGroupScopes.delete(instance.instanceId);
		if (own !== stateKey) {
			this.reportGroupScopeDisagreement(instance, own, stateKey);
		}
		this._instanceScopes.set(instance.instanceId, own);
		// 新しく開かれた端末の「作られた時のスペース」は根拠ではあるが確定ではない。
		// 通常の解決経路 (`recordRecoveredScopeIfUnassigned`) と同じ印を付けておかないと、
		// グループ経由で入った分だけが台帳へ焼き付き、cwd による訂正も効かなくなる。
		if (!this._restoredInstances.has(instance.instanceId)
			&& this.resolveInstanceInitialCwdScope(instance) === undefined
			&& own === this._activeScopeCandidates.get(instance.instanceId)) {
			this._activeFallbackInstances.add(instance.instanceId);
		}
	}

	/**
	 * グループの所属と、構成員が自前で言える所属が食い違ったことを記録する。
	 * これが鳴るのは「別スペースの端末が1つのグループに同居している」ときだけなので、
	 * 頻度が読めれば表示単位そのものを分ける必要があるかの判断材料になる。
	 */
	private reportGroupScopeDisagreement(instance: ITerminalInstance, ownStateKey: string, groupStateKey: string): void {
		this._groupScopeDisagreements++;
		// 台帳はこの端末自身の答えを残すが、表示と待避はグループ側に従う（グループ単位でしか
		// 出し入れできないため）。つまりこの端末は「所属は Y、見えるのは X のとき」になる。
		this.logService.warn(`[paradisTerminalScope] a terminal disagrees with the space of the group it sits in (instance ${instance.instanceId}, total ${this._groupScopeDisagreements}); keeping the terminal's own space in the ledger while the group keeps deciding where it is shown`, {
			ownStateKey,
			groupStateKey,
		});
	}

	/** 所属不明として待避しているターミナルの本数。コマンドの表示に使う。 */
	countUnattributedTerminals(): number {
		// park 保留中のグループも `_unattributedGroups` に入っているので、ここだけ数えれば足りる
		// （`_deferredParkGroups` も見ると同じ端末を二重に数えることになる）。
		let count = 0;
		for (const group of this._unattributedGroups) {
			count += group.terminalInstances.filter(instance => !instance.isDisposed).length;
		}
		return count;
	}

	/**
	 * 所属不明として待避しているターミナルを、今のスペースの持ち物として引き取る。
	 *
	 * 引き取った時点で所属が決まるので、以後は通常の端末と同じ扱いになる（台帳にも載る）。
	 * @returns 引き取ったターミナルの本数。
	 */
	adoptUnattributedTerminals(): number {
		const groupService = this.terminalGroupService;
		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		if (!(groupService instanceof TerminalGroupService) || activeStateKey === undefined || this._unattributedGroups.size === 0) {
			return 0;
		}
		let adopted = 0;
		const adoptedGroups: ITerminalGroup[] = [];
		const adoptedInstanceIds = new Set<number>();
		const countAdopted = (group: ITerminalGroup): number => {
			const live = group.terminalInstances.filter(instance => !instance.isDisposed);
			for (const instance of live) {
				adoptedInstanceIds.add(instance.instanceId);
			}
			return live.length;
		};
		// park 保留中の分は、保留を解いた先で今のスペースへ入るように差し替えるだけでよい。
		for (const [group, stateKey] of this._deferredParkGroups) {
			if (stateKey === PARADIS_UNATTRIBUTED_TERMINAL_SCOPE) {
				this._deferredParkGroups.set(group, activeStateKey);
				// 印を外すのを忘れると `resolveScope` が永久に pending を返し続け、
				// 台帳には所属があるのにモバイル・通知・binding authority から見えなくなる。
				this._unattributedGroups.delete(group);
				this._groupRepositories.set(group, activeStateKey);
				// ユーザーが選んだ引き取り先なので確定させる（取り消しは undo が受け持つ）。
				this.recordInstanceScopes(group, activeStateKey, true);
				adoptedGroups.push(group);
				adopted += countAdopted(group);
			}
		}
		const parked = this._parkedGroups.get(PARADIS_UNATTRIBUTED_TERMINAL_SCOPE) ?? [];
		const stillParked: ITerminalGroup[] = [];
		for (const group of parked) {
			// グループ単位で確定させる。まとめて台帳から外してから失敗すると、park は解けて
			// いないのに待避先の台帳からも消え、どの経路からも辿れないグループが残る。
			try {
				groupService.paradisUnparkGroup(group);
			} catch (error) {
				stillParked.push(group);
				onUnexpectedError(error);
				continue;
			}
			this._unattributedGroups.delete(group);
			this._groupRepositories.set(group, activeStateKey);
			this.recordInstanceScopes(group, activeStateKey, true);
			adoptedGroups.push(group);
			adopted += countAdopted(group);
		}
		if (stillParked.length > 0) {
			this._parkedGroups.set(PARADIS_UNATTRIBUTED_TERMINAL_SCOPE, stillParked);
		} else {
			this._parkedGroups.delete(PARADIS_UNATTRIBUTED_TERMINAL_SCOPE);
		}
		// 引き取りは所属を確定させる操作で、確定した所属は nonce 台帳に残って次のセッションへ
		// 伝わる。間違ったスペースで引き取ったことに後から気付いても戻せない、を避けるために
		// 直前の1回分だけ覚えておく。
		this._lastAdoption = adoptedGroups.length > 0 ? { groups: adoptedGroups, stateKey: activeStateKey, instanceIds: adoptedInstanceIds } : undefined;
		// 待つものが無くなったら、出しっぱなしの案内は閉じる（コマンドから引き取った場合も）。
		if (this._unattributedGroups.size === 0) {
			this._unattributedNotice?.close();
			this._unattributedNotice = undefined;
			this._unattributedNoticeOpen = false;
		}
		this.persistMapping();
		this.refreshAllStableScopes();
		return adopted;
	}

	/**
	 * 直前の引き取りを取り消し、待避していた状態へ戻す。
	 *
	 * 台帳から所属を消してから待避し直す。消さずに待避だけすると、次の起動で台帳から
	 * 「引き取り先のスペースの持ち物」として復活し、取り消したはずの誤りが戻ってくる。
	 *
	 * 引き取った後に起きたことは巻き戻さない。所属を付け替えられたグループと、引き取った後に
	 * 端末が足されたグループは対象外にする（待避は丸ごとしかできないので、戻すとユーザーが
	 * 今作った端末まで一緒に隠れてしまう）。
	 * @returns 戻したターミナルの本数。
	 */
	undoLastTerminalAdoption(): number {
		const groupService = this.terminalGroupService;
		const adoption = this._lastAdoption;
		this._lastAdoption = undefined;
		if (!(groupService instanceof TerminalGroupService) || adoption === undefined) {
			return 0;
		}
		let released = 0;
		for (const group of adoption.groups) {
			// 引き取り以降に所属が変わったグループ（モバイルからの付け替え等）は触らない。
			if (this._groupRepositories.get(group) !== adoption.stateKey) {
				continue;
			}
			const instances = group.terminalInstances.filter(instance => !instance.isDisposed);
			// 引き取った後にこのグループへ足された端末が1本でもあれば、そのグループは触らない。
			// 待避は丸ごとしかできないので、戻すとユーザーが今作った端末まで一緒に隠れる。
			if (instances.length === 0 || instances.some(instance => !adoption.instanceIds.has(instance.instanceId))) {
				continue;
			}
			for (const instance of instances) {
				this.forgetInstanceScope(instance);
			}
			this._groupRepositories.delete(group);
			this.reparkAsUnattributed(groupService, group);
			released += instances.length;
		}
		this.persistMapping();
		this.refreshAllStableScopes();
		return released;
	}

	/**
	 * 所属を取り消したグループを、待避中の状態へ戻す。
	 *
	 * 先に全ての park 台帳から外す。外さずに待避先へ足すと、切り替えで park 済みだったグループが
	 * 元のスペースと待避先の両方に載り、そのスペースへ戻ると画面には出るのに `resolveScope` は
	 * 待避中として pending を返し続ける（モバイル・通知から消える）。本数の二重計上も起きる。
	 */
	private reparkAsUnattributed(groupService: TerminalGroupService, group: ITerminalGroup): void {
		this._deferredParkGroups.delete(group);
		this.removeFromParkLedger(group);
		if (groupService.groups.includes(group)) {
			this.parkUnattributedGroup(groupService, group, false);
			return;
		}
		// 既に park 済み。実体はそのままでよいので、待避先の台帳へ付け替えるだけにする
		// （`paradisParkGroup` は groups に居ないグループを黙って無視するため、呼んでも台帳が
		// ずれるだけになる）。
		this._unattributedGroups.add(group);
		this.addToParkLedger(PARADIS_UNATTRIBUTED_TERMINAL_SCOPE, group);
	}

	/** 端末の所属を全台帳から消し、「所属不明」の状態へ戻す。 */
	private forgetInstanceScope(instance: ITerminalInstance): void {
		this._instanceScopes.delete(instance.instanceId);
		this._activeFallbackInstances.delete(instance.instanceId);
		this._inheritedGroupScopes.delete(instance.instanceId);
		// 容れ物からの根拠も捨てる。残すと直後の引き直しでその場から所属が付き、取り消せない。
		this._restoreScopeCandidates.delete(instance.instanceId);
		this._stableScopeTracker.retire(instance.instanceId);
		// 現世代の ID が確定しているときだけ消す。`getPersistentProcessId` は前世代の attach 先へ
		// フォールバックするので、それで消すと別の端末の現世代エントリを巻き添えにしうる。
		const persistentProcessId = instance.persistentProcessId;
		if (persistentProcessId !== undefined && persistentProcessId >= 0) {
			this._persistentProcessScopes.delete(persistentProcessId);
			this._restoredPersistentProcessScopes.delete(persistentProcessId);
			// worktree バリア前の隔離分も消す。残すとバリア完了時に両方の pid 台帳へ復活し、
			// 待避中なのに所属だけある（どのスペースへ切り替えても戻らない）状態になる。
			this._quarantinedPersistentProcessScopes.delete(persistentProcessId);
		}
		const nonce = this.instanceNonce(instance);
		if (nonce === undefined) {
			return;
		}
		// 読み側も必ず消す。書き側だけ消すと、この端末は次に所属を引かれたときに読み側から
		// 元の所属で復活し、取り消したはずの引き取りがそのまま戻る。
		this._restoredNonceScopes.delete(nonce);
		if (this._nonceScopes.delete(nonce)) {
			this.persistNonceMapping();
		}
	}

	/**
	 * 所属が「まだ分からない」ではなく「分からないまま確定した」復元グループか。
	 *
	 * 判定材料が揃う前（initial cwd の解決待ち、worktree 一覧の確定待ち）に待避させると、
	 * 後から cwd で正しいスペースが分かる端末まで隠してしまう。全インスタンスについて
	 * 材料が揃い、それでも所属が出なかったものだけを対象にする。
	 * 新しく開かれた端末は作成時のスペースへ寄せられるので、ここには来ない。
	 */
	private isSettledUnattributedRestoredGroup(group: ITerminalGroup): boolean {
		return paradisShouldParkUnattributedGroup({
			isManagedWorkspaceWindow: this.workspaceSwitchService.isManagedWorkspaceWindow,
			activeStateKey: this.workspaceSwitchService.activeStateKey,
			worktreeSnapshotReady: this._worktreeSnapshotReady,
			hasResolvableScopeRoots: this.hasResolvableScopeRoots(),
			instances: group.terminalInstances.map(instance => ({
				// 初出時に控えた値を見る。`attachPersistentProcess` は attach 失敗で消されるため、
				// 都度読むと復元端末が新規端末に化けて、グループごと待避の対象から外れてしまう。
				restoredFromPersistentProcess: this._restoredInstances.has(instance.instanceId),
				// 取得に失敗した端末も含める。根拠が無いまま表示すると結局混ざるうえ、
				// タグ付けも待避もされない端末はどのスペースでも出続けてしまう。
				initialCwdSettled: this._initialCwdResolvedInstances.has(instance.instanceId),
				hasScope: this._instanceScopes.get(instance.instanceId) !== undefined,
			})),
		});
	}

	/** 待避中のグループに属する端末か。 */
	private isUnattributedInstance(instanceId: number): boolean {
		for (const group of this._unattributedGroups) {
			if (group.terminalInstances.some(instance => instance.instanceId === instanceId)) {
				return true;
			}
		}
		return false;
	}

	/** cwd から所属を引ける土台があるか（照合先の root が1つでもあるか）。 */
	private hasResolvableScopeRoots(): boolean {
		for (const repository of this.workspaceSwitchService.repositories) {
			if (repository.uri.scheme === 'file') {
				return true;
			}
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (!worktree.missing && worktree.uri.scheme === 'file') {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * 所属の分からない復元グループの待避先。
	 *
	 * どのスペースにも属さないので、スペースを切り替えても戻ってこない。戻す手段は
	 * 待避時に出す通知のボタンか、コマンド "Recover Terminals Without a Space" から引き取る。
	 * 表示したまま混ぜるより隠す方を選んでいるのは、混ざった側は所属が上書きされて
	 * 元がどこだったか分からなくなるのに対し、隠れた側は引き取れば戻せるため。
	 */
	private parkUnattributedGroup(groupService: TerminalGroupService, group: ITerminalGroup, notify = true): void {
		// `_groupRepositories` には入れない。あそこへ入れると `getGroupStateKey` がこの目印を
		// 所属として返し、そこから `_instanceScopes` → pid 台帳 → nonce 台帳と自動で伝播して
		// 永続化される。所属スコープとして焼き付いた目印は cwd より優先して引かれるので、
		// 一時的な理由で1度隠れた端末が cwd で自己修復する道を永久に塞いでしまう。
		// 実在しない stateKey がモバイルや通知など外部の消費者にも漏れる。
		this._unattributedGroups.add(group);
		this.parkGroup(groupService, group, PARADIS_UNATTRIBUTED_TERMINAL_SCOPE);
		this.logService.warn(`[paradisTerminalScope] parked a restored terminal group with no resolvable space (${group.terminalInstances.length} terminals); use the unattributed terminals command to bring it back`);
		if (notify) {
			this.notifyUnattributedTerminals();
		}
	}

	/**
	 * 隠したことを知らせる。ログだけだと、ユーザーからは端末が黙って消えたようにしか
	 * 見えず、戻せることも分からない（エージェントを走らせていた端末なら事故と区別できない）。
	 *
	 * 出しっぱなしの通知が1つある間は重ねない。閉じられた後にまた待避が起きたら、改めて知らせる。
	 */
	private notifyUnattributedTerminals(): void {
		if (this._unattributedNoticeOpen) {
			return;
		}
		// 「出しっぱなしが1つある」印はハンドルとは別に持つ。`onDidClose` が `prompt` から戻る前に
		// 発火しないことに依存している（実装はモデルへ足してハンドルを返すだけで、通知フィルタも
		// 見せ方を変えるだけで閉じない）。もしそこが変わると、印が立ったままになって以後この
		// ウィンドウでは知らせられなくなる——ハンドルを問い合わせる口が無いので、そこは防いでいない。
		this._unattributedNoticeOpen = true;
		const forget = () => {
			this._unattributedNoticeOpen = false;
			this._unattributedNotice = undefined;
		};
		const handle = this.notificationService.prompt(
			Severity.Info,
			localize('paradis.unattributedTerminals.parked', "Some restored terminals could not be matched to a space, so they are being kept aside instead of being shown here."),
			[{
				label: localize('paradis.unattributedTerminals.recover', "Move Them Into This Space"),
				run: () => {
					const adopted = this.adoptUnattributedTerminals();
					if (adopted === 0) {
						this.notificationService.warn(localize('paradis.unattributedTerminals.recoverFailed', "The terminals could not be moved into this space. Open a space first, then run \"Recover Terminals Without a Space\"."));
						return;
					}
					// 引き取り先が正しいかはユーザーにしか分からない。戻し口をその場で出す。
					// 自動で消してはいけない（取り消せる間だけが価値なので、消えると戻し口も消える）。
					this.notificationService.prompt(
						Severity.Info,
						localize('paradis.unattributedTerminals.adopted', "Moved {0} terminal(s) into this space.", adopted),
						[{
							label: localize('paradis.unattributedTerminals.undo', "Undo"),
							run: () => this.undoLastTerminalAdoption(),
						}],
						{ sticky: true },
					);
				},
			}],
			// 復元直後、ユーザーが画面を見ていない時間帯に出る。自動で消えると、端末が黙って
			// 消えたようにしか見えないという、この通知が防ぎたかった状態に戻ってしまう。
			{ sticky: true },
		);
		if (this._unattributedNoticeOpen) {
			this._unattributedNotice = handle;
			// 購読を溜めないよう毎回1つに置き換える。
			this._unattributedNoticeListener.value = Event.once(handle.onDidClose)(forget);
		}
	}

	/** @param stateKey park 先スコープの stateKey (リポジトリ本体では repositoryId と同値)。 */
	private parkGroup(groupService: TerminalGroupService, group: ITerminalGroup, stateKey: string): void {
		// 復元中の park は split を壊す (詳細は _deferredParkGroups のコメント)。保留して復元完了後に行う。
		if (!this._parkDeferralReleased) {
			this._deferredParkGroups.set(group, stateKey);
			return;
		}
		groupService.paradisParkGroup(group);
		this.addToParkLedger(stateKey, group);
	}

	private addToParkLedger(stateKey: string, group: ITerminalGroup): void {
		let parked = this._parkedGroups.get(stateKey);
		if (!parked) {
			parked = [];
			this._parkedGroups.set(stateKey, parked);
		}
		if (!parked.includes(group)) {
			parked.push(group);
		}
	}

	/** park 台帳の全スコープから、このグループを外す（実体の park 状態は変えない）。 */
	private removeFromParkLedger(group: ITerminalGroup): void {
		for (const [stateKey, groups] of this._parkedGroups) {
			const index = groups.indexOf(group);
			if (index !== -1) {
				groups.splice(index, 1);
				if (groups.length === 0) {
					// 空配列でキーを残すと「park 中の端末がある」と誤判定される (probe は has() で引く)
					this._parkedGroups.delete(stateKey);
				}
			}
		}
	}

	/**
	 * park の保留を解除し、溜まっている分をまとめて実行する。復元の完了 (`whenConnected`) か、
	 * それが来ない場合の上限時間のどちらか早い方で一度だけ呼ばれる。
	 * 保留中にタグ付けが変わったり (sweepRestoredGroups)、グループごと破棄されたりするため、
	 * 溜めた時点の値ではなく実行時点の台帳とアクティブスコープで引き直す。
	 */
	private releaseParkDeferral(): void {
		if (this._parkDeferralReleased || this._store.isDisposed) {
			return;
		}
		this._parkDeferralReleased = true;
		const deferred = [...this._deferredParkGroups];
		this._deferredParkGroups.clear();
		const groupService = this.terminalGroupService;
		if (!(groupService instanceof TerminalGroupService)) {
			return;
		}
		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		for (const [group, deferredStateKey] of deferred) {
			// 印を付けてから park するまでの間、グループは画面に見えたままなので、その窓で
			// split されることがある。ユーザーが今作った端末を巻き添えに隠さないよう、
			// 実際に隠す直前にもう一度判定し直す。条件から外れていれば待避を取り消す。
			if (deferredStateKey === PARADIS_UNATTRIBUTED_TERMINAL_SCOPE && !this.isSettledUnattributedRestoredGroup(group)) {
				this._unattributedGroups.delete(group);
				continue;
			}
			const stateKey = this._groupRepositories.get(group) ?? deferredStateKey;
			if (!groupService.groups.includes(group) || stateKey === activeStateKey) {
				continue;
			}
			this.parkGroup(groupService, group, stateKey);
		}
	}

	private async applyScope(targetStateKey: string): Promise<void> {
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
		await this.unparkEditorTerminals(targetStateKey);

		this.persistMapping();
		this.refreshAllStableScopes();
	}

	/** 切り替え先スコープの park 台帳に残留したエディタターミナルをエディタとして開き直す */
	private async unparkEditorTerminals(targetStateKey: string): Promise<void> {
		const instances = paradisTakeParkedTerminalEditorInstancesForScope(targetStateKey);
		if (instances.length === 0) {
			return;
		}
		// この処理は workspace switch の completion participant として await されるため、通常の
		// スペース切り替えは openEditor の完了まで次へ進まない。activeStateKey の確認は、終了処理や
		// 同一URI補正など切り替えシーケンサー外から状態が変わる場合にも誤表示しないための防御。
		// 取り出したまま開けない・開き損ねたインスタンスは台帳へ戻し、次の切り替えか
		// スコープ退役で必ず回収されるようにする（戻さないと PTY がどこからも参照されず漏れる）。
		// 取り出し後に dispose されたインスタンスは開かず・戻さず捨てる（take で台帳の
		// onDisposed 掃除が外れているため、戻すと死んだエントリが残り続ける）
		// park は「同じ nonce の別インスタンスが既に居る」場合に false を返す。戻り値を捨てると
		// そのインスタンスは park 台帳にも terminalEditorService.instances にも属さなくなり、
		// 上のコメントが避けようとしている不可視の漏れがこの経路から再発する。断られたら
		// スコープの正確さより「一覧に出ていること」を優先し、エディタとして開いてしまう。
		const parkOrReopen = async (instance: ITerminalInstance): Promise<void> => {
			if (paradisParkTerminalEditorInstance(instance, targetStateKey)) {
				return;
			}
			onUnexpectedError(new Error('Para Code could not park a terminal editor; reopening it so it stays visible'));
			await this.terminalEditorService.openEditor(instance);
		};
		for (const instance of instances) {
			if (instance.isDisposed) {
				continue;
			}
			try {
				if (this.workspaceSwitchService.activeStateKey !== targetStateKey) {
					await parkOrReopen(instance);
					continue;
				}
				await this.terminalEditorService.openEditor(instance);
			} catch (error) {
				if (!instance.isDisposed) {
					paradisParkTerminalEditorInstance(instance, targetStateKey);
				}
				onUnexpectedError(error);
			}
		}
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
		// nonce 台帳も一緒に掃除する。ここを残すと、ID 台帳から消えた端末が退役済みのスペースへ
		// nonce で寄せられ、二度と unpark されない場所へ park されて PTY ごと不可視になる。
		let retiredNonces = false;
		for (const ledger of [this._nonceScopes, this._restoredNonceScopes]) {
			for (const [nonce, assignedStateKey] of ledger) {
				if (assignedStateKey === stateKey) {
					ledger.delete(nonce);
					retiredNonces = true;
				}
			}
		}
		if (retiredNonces) {
			this.persistNonceMapping();
		}
		for (const instanceId of retiringInstanceIds) {
			const persistentProcessId = this._persistentProcessIdByInstance.get(instanceId);
			if (persistentProcessId !== undefined && this._instanceIdByPersistentProcessId.get(persistentProcessId) === instanceId) {
				this._instanceIdByPersistentProcessId.delete(persistentProcessId);
			}
			this._persistentProcessIdByInstance.delete(instanceId);
			this._activeScopeCandidates.delete(instanceId);
			this._restoreScopeCandidates.delete(instanceId);
			this._candidateCapturedInstances.delete(instanceId);
			this._initialCwds.delete(instanceId);
			this._initialCwdResolvedInstances.delete(instanceId);
			this._activeFallbackInstances.delete(instanceId);
			this._inheritedGroupScopes.delete(instanceId);
			this._restoredInstances.delete(instanceId);
			this._stableScopeTracker.retire(instanceId);
		}

		// 台帳削除前にexact ownerとして捕捉したvisible/background/parked instanceだけを破棄する。
		for (const instance of retiringInstances.values()) {
			if (!instance.isDisposed) {
				instance.dispose(TerminalExitReason.User);
			}
		}
		this.releaseSurvivorsOfRetiredScope(stateKey);
		this.persistMapping();
	}

	/**
	 * 退役したスコープに park していたグループを片付ける。
	 *
	 * 全滅したグループは `onDidDisposeGroup` → `discardGroup` が台帳から外すので、ここで見るのは
	 * **生き残った端末が居るグループ**の方。グループの所属と構成員の所属は食い違うことがあり
	 * （`reconcileGroupScope`）、その場合ここには「退役したスコープに park されているが、中の端末は
	 * 別のスペースの持ち物」というグループが残る。バケツごと捨てると `applyScope` の復帰は
	 * `_parkedGroups.get(切り替え先)` しか見ないため二度と引っかからず、PTY は生きているのに
	 * どのスペースにも出てこない端末になる。park を解いてタグ付けからやり直させる。
	 */
	private releaseSurvivorsOfRetiredScope(stateKey: string): void {
		const groupService = this.terminalGroupService;
		// 起点は park 台帳ではなく「所属が退役キーのグループ」全部。park 台帳だけを見ると、
		// 表示中のグループと park 保留中のグループの所属が退役キーのまま残り、次の切り替えで
		// そのキーへ park される。そのキーへ切り替わることは二度と無いので、台帳には載って
		// いるのにどこからも辿り着けないグループになる。
		const candidates = new Set<ITerminalGroup>(this._parkedGroups.get(stateKey) ?? []);
		this._parkedGroups.delete(stateKey);
		for (const [group, assignedStateKey] of this._groupRepositories) {
			if (assignedStateKey === stateKey) {
				candidates.add(group);
			}
		}
		for (const [group, assignedStateKey] of this._deferredParkGroups) {
			if (assignedStateKey === stateKey) {
				candidates.add(group);
			}
		}
		let released = false;
		for (const group of candidates) {
			this._groupRepositories.delete(group);
			this._deferredParkGroups.delete(group);
			if (!group.terminalInstances.some(instance => !instance.isDisposed)
				|| !(groupService instanceof TerminalGroupService)) {
				continue;
			}
			this.removeFromParkLedger(group);
			// 表示中（park 保留中を含む）のグループは、所属を外すだけでよい。
			if (groupService.groups.includes(group)) {
				released = true;
				continue;
			}
			try {
				groupService.paradisUnparkGroup(group);
				released = true;
			} catch (error) {
				// 退役したキーのバケツへは戻さない（上と同じ理由）。待避扱いにすれば、通知と
				// コマンドから引き取れる回路に乗る。
				this._unattributedGroups.add(group);
				this.addToParkLedger(PARADIS_UNATTRIBUTED_TERMINAL_SCOPE, group);
				onUnexpectedError(error);
			}
		}
		if (released) {
			// 根拠があれば正しいスペースへ、無ければ待避へ落ちる。
			this.tagUntaggedGroups();
		}
	}

	private discardGroup(group: ITerminalGroup): void {
		this._groupRepositories.delete(group);
		this._deferredParkGroups.delete(group);
		// 消し忘れるとグループ（とその配下の端末）の参照がウィンドウの寿命ぶん残り、
		// 所属判定のたびにその死骸を走査することになる。
		this._unattributedGroups.delete(group);
		if (this._lastAdoption !== undefined) {
			const remaining = this._lastAdoption.groups.filter(adopted => adopted !== group);
			this._lastAdoption = remaining.length > 0 ? { ...this._lastAdoption, groups: remaining } : undefined;
		}
		this.removeFromParkLedger(group);
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
			// `chooseGroupStateKey`（今見えているスペースを主張する構成員が居ればそちらへ置く）は
			// 通さない。ここは接続完了直後で全員が復元端末＝今のスペースを主張する構成員が居ない
			// 場面であり、台帳が言う場所へ素直に置くのが正しい。
			//
			// 印は消さない。ここは「pid 未確定で誤タグされた復元グループを直す」経路＝借り物が
			// 最も出やすい場所なので、消すと直後の書き出しで両台帳へ焼き付く。
			this.recordInstanceScopes(group, restoredStateKey, false, true);
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

	private persistNonceMapping(): void {
		const raw = paradisSerializeTerminalNonceScopeStorage(this._nonceScopes);
		if (raw === undefined) {
			// 上限を超えると保存できない。黙って止まると「台帳が効かない」だけの状態が続くので残す。
			this.logService.warn(`[paradisTerminalScope] the nonce scope ledger is too large to persist (${this._nonceScopes.size} entries); keeping the previous one`);
			return;
		}
		this.storageService.store(ParadisTerminalWorkspaceScope.NONCE_MAPPING_STORAGE_KEY, raw, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/**
	 * live でなくなった端末の記録を書き側から落とし、結果を保存する。
	 *
	 * 読み側（`_restoredNonceScopes`）は落とさない。非アクティブスペースの端末はそのスペースへ
	 * 切り替えるまで live にならないので、ここで消すとこの台帳が拾うはずの端末を毎起動で
	 * 自分から捨てることになる。ID 台帳が読み書きを分けているのと同じ理由。
	 */
	private pruneNonceScopes(liveInstances: readonly ITerminalInstance[]): void {
		const before = this._nonceScopes.size;
		paradisPruneNonceScopes(this._nonceScopes, liveInstances.map(instance => this.instanceNonce(instance)));
		if (this._nonceScopes.size !== before) {
			this.persistNonceMapping();
		}
	}

	private loadNonceMapping(): Map<string, string> {
		const raw = this.storageService.get(ParadisTerminalWorkspaceScope.NONCE_MAPPING_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return new Map();
		}
		return paradisParseTerminalNonceScopeStorage(raw) ?? new Map();
	}

	/**
	 * nonce 台帳と ID 台帳の食い違いを記録する。
	 *
	 * nonce が revive をまたいで不変であることはコードを追って確認したが実機では未検証で、
	 * ここが鳴るならその前提が崩れている。第2段階（所属不明を推測で埋めるのをやめる）は
	 * nonce 台帳を信頼できることが前提なので、進める前にこのログを見て判断する。
	 */
	private reportNonceScopeDisagreement(instance: ITerminalInstance, disagreement: IParadisTerminalNonceScopeDisagreement): void {
		this._nonceScopeDisagreements++;
		this.logService.warn(`[paradisTerminalScope] nonce scope disagreed with the process ledger (instance ${instance.instanceId}, total ${this._nonceScopeDisagreements}); keeping the process ledger value`, {
			nonceStateKey: disagreement.nonceStateKey,
			processStateKey: disagreement.processStateKey,
		});
	}

	/** 端末の nonce。台帳のキーに使えない形（切り離された端末の空文字など）は undefined。 */
	private instanceNonce(instance: ITerminalInstance): string | undefined {
		return paradisTerminalIdentityNonce(instance.shellIntegrationNonce);
	}

	/**
	 * 今わかっている所属を nonce 台帳へ書き足す。ID 台帳と違い pid の確定を待たない。
	 *
	 * 推測（active fallback）由来の値は書かない。そういう端末は cwd が判明したら
	 * `reevaluateActiveFallbackScopes` が訂正する前提で `_activeFallbackInstances` に居るが、
	 * nonce は revive をまたいでも変わらないので、一度書くと次セッションでは復元経路が
	 * cwd 解決より先に確定させてしまい、訂正の機会が永久に来なくなる。
	 * ID 台帳は pid が振り直されれば対応が切れて再評価できるが、こちらは切れない。
	 */
	private recordNonceScopes(instances: readonly ITerminalInstance[]): void {
		let changed = false;
		for (const instance of instances) {
			const nonce = this.instanceNonce(instance);
			const stateKey = this._instanceScopes.get(instance.instanceId);
			if (nonce === undefined || stateKey === undefined
				|| this._activeFallbackInstances.has(instance.instanceId)
				|| this._inheritedGroupScopes.has(instance.instanceId)
				|| this._nonceScopes.get(nonce) === stateKey) {
				continue;
			}
			// 書き側にだけ入れる。読み側は「前セッションから引き継いだ対応」に閉じておく
			// （生きた端末が同一セッション中に復元経路へ戻る経路は無く、`recordRecoveredScopeIfUnassigned`
			// は `_instanceScopes` があれば早期 return する）。prune できない側を太らせない。
			this._nonceScopes.set(nonce, stateKey);
			changed = true;
		}
		if (changed) {
			this.persistNonceMapping();
		}
	}

	/**
	 * 起動時点で確実に既知と言える stateKey (登録済みリポジトリ)。worktree は初期化バリアが
	 * 終わるまで列挙されないため、ここには含めず隔離して扱う (バリア完了時に全件採用する)。
	 */
	private knownStateKeys(): Set<string> {
		const result = new Set<string>();
		for (const repository of this.workspaceSwitchService.repositories) {
			result.add(repository.id);
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
