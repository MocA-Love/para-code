/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase, joinPath } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { TokenizationRegistry } from '../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { generateTokensCSSForColorMap } from '../../../../editor/common/languages/supports/tokenization.js';
import { tokenizeToString } from '../../../../editor/common/languages/textToHtmlTokenizer.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { editorBackground, editorForeground } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TerminalExitReason, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { XtermAddonImporter } from '../../../../workbench/contrib/terminal/browser/xterm/xtermAddonImporter.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisCollectAllTerminalInstances, paradisCollectLivePaneInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { IParadisTerminalIdentityService } from '../browser/paradisTerminalIdentityService.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisPrStatus } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { renderSpreadsheetDiffMobileHtml, renderSpreadsheetMobileSheet } from './paradisMobileSpreadsheetHtml.js';
import { Channels, encodeNotify, NotifyKind, NotifyPayload } from '../common/paradisMobileProtocol.js';
import { IParadisGitResult, IParadisMobileInboundFrame, IParadisMobileInboundFrame as InboundFrame, IParadisMobileWindowStateV2, IParadisMobileWindowWorkspaceV2, PARADIS_MOBILE_PROTOCOL_VERSION, ParadisMobileTerminalOperationStatus, paradisResolveMobileTerminalStateKey } from '../common/paradisMobileRelay.js';
import { IParadisCcusageDashboardData } from '../../ccusage/electron-browser/paradisCcusageClient.js';
import { IParadisLimitsSnapshot } from '../../limitsMonitor/common/paradisLimitsMonitor.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisAgentModelSwitchGuard } from './paradisAgentModelSwitchGuard.js';
import { paradisCreateTerminalOutputConsumer, paradisQueueTerminalRelayOutput } from '../common/paradisTerminalOutputHotPath.js';
import { type ParadisBinaryFsResponseType, paradisEncodeNegotiatedBinaryFsResponse } from '../common/paradisMobileFileResponse.js';
import { paradisDecodeBinaryFsUpload } from '../common/paradisMobileFileUpload.js';
import { PARADIS_TERMINAL_BINARY_DATA_ENCODING, paradisEncodeNegotiatedBinaryTerminalData } from '../common/paradisMobileTerminalData.js';
import { paradisSendAgentMessageToTui } from '../common/paradisAgentMessageSender.js';
import type { IParadisHeadlessWorktreeRequest, IParadisHeadlessWorktreeResult, IParadisWorktreeCreateFormData } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type StateSnapshot = IParadisMobileWindowStateV2;

/**
 * Resolves the best local cwd available for agent command discovery. CwdDetection
 * is authoritative when present; local terminals then fall back to the terminal's
 * speculative resolver, which also includes NaiveCwdDetection and the initial cwd.
 */
export async function paradisResolveLocalAgentPaneCwd(instance: Pick<ITerminalInstance, 'remoteAuthority' | 'getCwdResource' | 'getSpeculativeCwd'>): Promise<string | undefined> {
	try {
		const detected = await instance.getCwdResource();
		if (detected !== undefined) {
			return detected.scheme === 'file' ? detected.fsPath : undefined;
		}
	} catch {
		// A local speculative cwd can still be available without shell integration.
	}
	if (instance.remoteAuthority !== undefined) {
		return undefined;
	}
	try {
		const speculative = await instance.getSpeculativeCwd();
		return speculative.length > 0 ? speculative : undefined;
	} catch {
		return undefined;
	}
}

/** ターミナルのサブプロトコル（termチャネルのペイロード、JSON）。 */
type TermInboundBase = { protocolVersion: 3; desktopEpoch: string; operationId: string };
type TermInbound = TermInboundBase & (
	// epoch はモバイルが attach ごとに採番する世代番号。指定があると同期プロトコル
	// （seq 付与・ACKフロー制御・リサイズ時スナップショット再同期）が有効になる。
	| { t: 'attach'; terminalKey: string; epoch: number; dataEncoding?: string }
	| { t: 'detach'; terminalKey: string }
	// 受信済み最終 seq の確認応答（epoch 対応クライアントのみ）。フロー制御の材料。
	| { t: 'ack'; terminalKey: string; epoch: number; seq: number }
	// input は3形態:
	// - key: 矢印キー等のセマンティック指定。PC側が端末モード（application cursor keys）に
	//   合わせて CSI / SS3 へエンコードする
	// - text: コンポーザーからのテキスト入力。sendText の bracketed paste 対応を通し、
	//   複数行貼り付けがTUIで1行目から実行されてしまう問題を防ぐ。execute=true で実行（Enter）
	// - data: Esc/Tab/^C 等の生のエスケープシーケンス
	| { t: 'input'; terminalKey: string; data?: string; key?: TermSemanticKey; text?: string; execute?: boolean }
	| { t: 'create'; windowId: number; ws: string }
	// モバイルからのターミナル名変更。PC側の実インスタンスへ反映し、stateの再送で
	// 他モバイル端末（およびPC自身のタブ表示）にも波及させる。
	| { t: 'rename'; terminalKey: string; title: string }
	// モバイルからのターミナル削除（ホーム長押しメニュー）。モバイル側で確認済みの前提で
	// PC側の実インスタンスを閉じる。onDidChangeInstances経由でstateが自動再送され、
	// 他モバイル端末・PC自身のタブ表示からも消える。
	| { t: 'close'; terminalKey: string }
	// モバイルからのエージェント状態の既読（ホームのステータスバッジタップ→「確認済みにする」）。
	// PCのフォーカス中自動既読と同じ acknowledgePaneStatus 経路を通すため、'review' 状態のみ
	// クリアされ、通知履歴のdismiss等の後続処理も自動で走る。
	| { t: 'ackStatus'; terminalKey: string }
);
type TermSemanticKey = 'up' | 'down' | 'right' | 'left';
type TermOutbound =
	// snapshot=true は画面復元用フレーム（VTシーケンス込み）。モバイルは追記せず
	// バッファ全体を置き換える（attach 時・リサイズ時・フロー制御の追いつき時）。
	// epoch/seq は同期プロトコル有効時のみ付与（seq は送信順に1ずつ増える。モバイルは
	// ギャップ検出で再attachする）。snapshot には適用すべき cols/rows と unicode 幅版も同梱する。
	| { t: 'data'; data: string; snapshot?: boolean; epoch: number; seq: number; cols?: number; rows?: number; unicode?: string }
	| { t: 'exit'; epoch?: number };

/** scm チャネルのサブプロトコル（JSON、リクエスト/レスポンス）。 */
type ScmInbound =
	| { t: 'status'; id: string; ws: string }
	| { t: 'diff'; id: string; ws: string; path?: string; staged?: boolean }
	| { t: 'xlsxDiff'; id: string; ws: string; path: string }
	| { t: 'commit'; id: string; ws: string; message: string; all?: boolean }
	| { t: 'log'; id: string; ws: string; limit?: number; skip?: number }
	| { t: 'commitFiles'; id: string; ws: string; hash: string }
	// worktree（スペース）作成のフォーム材料と作成本体。他のscmメッセージと違い特定の
	// ワークスペースに紐づかないため ws を持たない（repo はリポジトリid）。
	| { t: 'worktreeForm'; id: string; ws?: undefined }
	| { t: 'createWorktree'; id: string; ws?: undefined; repo: string; name?: string; branch?: string; base?: string; prompt?: string; agent?: string };

/** fs チャネルのサブプロトコル（JSON、リクエスト/レスポンス）。 */
type FsInbound =
	| { t: 'list'; id: string; ws: string; path: string }
	| { t: 'resolveLink'; id: string; ws: string; path: string }
	| { t: 'read'; id: string; ws: string; path: string; highlight?: boolean }
	| { t: 'xlsx'; id: string; ws: string; path: string; sheet?: number }
	| { t: 'pdf'; id: string; ws: string; path: string; responseEncoding?: string }
	| { t: 'docx'; id: string; ws: string; path: string; responseEncoding?: string }
	| { t: 'media'; id: string; ws: string; path: string; responseEncoding?: string }
	| { t: 'find'; id: string; ws: string; query: string }
	| { t: 'grep'; id: string; ws: string; query: string }
	| { t: 'upload'; id: string; name: string; data: string | Uint8Array; base64Length?: number }
	| { t: 'usage'; id: string; bypassCache?: boolean }
	// Rate Limit(AIリミット)スナップショット（PC版タイトルバーのリミットモニターと同じデータ）
	| { t: 'limits'; id: string; bypassCache?: boolean }
	// テキスト断片のシンタックスハイライト（エージェントチャットのコードブロック用）。
	// lang はMarkdownフェンスの言語名（ts / typescript / python 等）。
	| { t: 'hl'; id: string; text: string; lang?: string };

const FS_READ_LIMIT = 1024 * 1024; // ファイル読み取り上限（バイト。FrameMuxのチャンク分割転送で1MiB超の応答も送れる）
// バイナリ（PDF・Word・画像・動画・音声）の読み取り上限。base64 で約1.37倍に膨らむため、
// FrameMux の再結合上限（FRAME_REASSEMBLY_LIMIT = 32MiB）に収まるようここで抑える（20MiB → base64 約27MiB）。
const BINARY_READ_LIMIT = 20 * 1024 * 1024;
const UPLOAD_LIMIT = 10 * 1024 * 1024; // モバイルからの添付アップロード上限（バイト）
const UPLOAD_BASE64_LIMIT = Math.ceil(UPLOAD_LIMIT * 4 / 3) + 4; // 同、base64文字列長での事前判定用
const UPLOAD_DECODED_LIMIT = Math.floor(UPLOAD_BASE64_LIMIT * 3 / 4); // unpadded Base64を含む従来許容範囲のraw上限
const HIGHLIGHT_SOURCE_LIMIT = 128 * 1024; // ハイライト対象の上限（HTML化で数倍に膨らむため読み取り上限より絞る）
const TERM_SCROLLBACK_LIMIT = 16 * 1024; // attach時に送る直近バッファ上限（文字。serialize不可時のフォールバック用）
const TERM_SNAPSHOT_SCROLLBACK_ROWS = 1000; // attach時のVTスナップショットで通常バッファから含めるスクロールバック行数（代替バッファ=TUIは常に全体）
// --- ターミナル同期プロトコル（epoch対応クライアント向け）の定数 ---
const TERM_COALESCE_MS = 16; // onData のまとめ送り間隔（1フレーム=1暗号化+relay往復のため細切れ送信を避ける）
// フロー制御: 未ACK文字数が HIGH を超えたら生ストリーム転送を止め（ptyは止めない）、
// ACK が LOW まで追いついたらスナップショット1発で最新画面へ追いつく（mosh の
// 「中間状態スキップ」方式）。値は本家 FlowControlConstants（renderer↔ptyHost間）に合わせる。
const TERM_HIGH_WATERMARK_CHARS = 100_000;
const TERM_LOW_WATERMARK_CHARS = 5_000;
const TERM_RESIZE_SNAPSHOT_DELAY_MS = 200; // リサイズ確定からスナップショット再同期までのデバウンス

/** epoch対応クライアントがattach中のターミナル1つ分の同期プロトコル状態。 */
interface TermSyncState {
	/** モバイルが attach 時に採番した世代番号（送信フレームへ毎回付与する）。 */
	epoch: number;
	/** 現在のattachが明示交渉したdata encoding。別epochへ持ち越さない。 */
	dataEncoding?: string;
	/** 直近に送信したseq（送信直前にインクリメント。snapshotも消費する）。 */
	seq: number;
	/** 送信済み・未ACKのフレーム（フロー制御の残量計算用）。 */
	inflight: { seq: number; chars: number }[];
	unackedChars: number;
	/** フロー制御で生ストリーム転送を停止中（ptyは止めない。ACKが追いつくとsnapshotで再同期）。 */
	suspended: boolean;
	/** suspend中に出力を破棄した（=再開時にsnapshot再同期が必要）。 */
	droppedWhileSuspended: boolean;
	/** onData のまとめ送りバッファ。 */
	pending: string[];
	pendingChars: number;
	coalesceTimer: ReturnType<typeof setTimeout> | undefined;
	resizeTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * shared process のリレーサービスと、このウィンドウのワークスペース/ターミナルを橋渡しする。
 * - state: ワークスペース・ターミナル・エージェント状態のスナップショットを push
 * - term: モバイルからの attach/input を処理し、ターミナル出力を stream 送信
 *
 * SCM / fs / browser チャネルは本スライスでは未実装（設計書 M2/M3。ここに追加していく）。
 */
export class ParadisMobileWorkspaceProvider extends Disposable {
	readonly initialAgentPanesReady: Promise<void>;
	private readonly markInitialAgentPanesReady: () => void;
	private agentPanesRevision = 0;
	private confirmedAgentPaneTokens = new Set<string>();
	private readonly provisionalAgentPaneTokens = new Set<string>();
	// ターミナルID → PC側出力listener（全モバイル購読者へ分配するため1端末1本）。
	private readonly attachedTerminals = this._register(new DisposableMap<number>());
	// ターミナルID → 出力を購読中のモバイルID。
	private readonly terminalSubscribers = new Map<number, Set<string>>();
	// エージェント状態の遷移検知用（stateKey → 直近の状態）。
	private readonly previousScopeStatus = new Map<string, string>();
	// attach時のVTスナップショット生成に使う serialize addon（PC側xtermの現画面を
	// エスケープシーケンス込みでシリアライズし、モバイルのxtermで完全再現するため）。
	private readonly xtermAddonImporter = new XtermAddonImporter();
	// raw xterm → その端末に一度だけ load した serialize addon（端末ごとに1つ）。
	private readonly serializeAddons = new WeakMap<object, { serialize(options?: { scrollback?: number }): string }>();
	// mobileId + ターミナルID → 独立したepoch/seq/ACK状態。
	private readonly termSyncStates = new Map<string, TermSyncState>();
	// モバイル発の /model・/effort 切替でClaude TUIが出す確認ダイアログを自動確定するガード。
	private readonly modelSwitchGuard = this._register(new ParadisAgentModelSwitchGuard(this.logService));

	constructor(
		private readonly sendFrame: (frame: IParadisMobileInboundFrame) => void,
		private readonly windowId: number,
		private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		private readonly terminalService: ITerminalService,
		private readonly terminalGroupService: ITerminalGroupService,
		private readonly terminalScopeService: IParadisTerminalScopeService,
		private readonly worktreeService: IParadisWorktreeService,
		private readonly agentStatusStore: IParadisAgentStatusStore,
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
		private readonly environmentService: IEnvironmentService,
		private readonly languageService: ILanguageService,
		private readonly extensionService: IExtensionService,
		private readonly themeService: IThemeService,
		private readonly sharedProcessService: ISharedProcessService,
		private readonly runGit: (repoPath: string, args: readonly string[]) => Promise<IParadisGitResult>,
		private readonly paneTokenService: IParadisPaneTokenService,
		private readonly terminalIdentityService: IParadisTerminalIdentityService,
		private readonly syncTerminalState: (state: IParadisMobileWindowStateV2) => void,
		private readonly syncAgentPanes: (revision: number, entries: readonly { terminalId: number; token: string; cwd?: string; ws?: string }[]) => Promise<void>,
		private readonly completeTerminalOperation: (mobileId: string, operationId: string, status: ParadisMobileTerminalOperationStatus) => Promise<void>,
		private readonly claimAgentAction: (mobileId: string, requestId: string, token: string, epoch: string) => Promise<'claimed' | 'stale' | 'expired'>,
		private readonly continueAgentInteraction: (mobileId: string, requestId: string, token: string, epoch: string, terminalId: number, windowId: number) => Promise<'valid' | 'completed' | 'stale'>,
		private readonly finalizeAgentInteraction: (mobileId: string, requestId: string, token: string, outcome: 'accepted' | 'failed') => Promise<void>,
		private readonly validateAgentAction: (mobileId: string, requestId: string, token: string, epoch: string, terminalId: number, windowId: number) => Promise<boolean>,
		private readonly searchFiles: (rootPath: string, query: string, maxResults: number) => Promise<{ files: string[]; truncated: boolean }>,
		private readonly searchText: (rootPath: string, query: string, maxResults: number) => Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>,
		private readonly fetchUsageDashboard: (bypassCache: boolean) => Promise<IParadisCcusageDashboardData>,
		// AIリミット(Rate Limit)スナップショット。実体は limitsMonitor の shared process バックエンド
		private readonly fetchLimitsSnapshot: (bypassCache: boolean) => Promise<IParadisLimitsSnapshot>,
		// worktree（スペース）作成。実体は paradisWorktreeHeadlessCreate.ts（contribution側で
		// instantiationService.invokeFunction に束ねて渡される。runGit等と同じコールバック方式）
		private readonly getWorktreeCreateForm: () => Promise<IParadisWorktreeCreateFormData>,
		private readonly createWorktree: (request: IParadisHeadlessWorktreeRequest) => Promise<IParadisHeadlessWorktreeResult>,
		// 各パスの現在ブランチに紐づく PR 状態。実体は PC 版 Workspaces ビューと同じ
		// paradis.workspaceSwitch.getPrStatuses コマンド（contribution側で束ねて渡される）
		private readonly getPrStatuses: (paths: readonly string[]) => Promise<Record<string, IParadisPrStatus> | undefined>,
	) {
		super();
		let markInitialAgentPanesReady!: () => void;
		this.initialAgentPanesReady = new Promise<void>(resolve => { markInitialAgentPanesReady = resolve; });
		this.markInitialAgentPanesReady = markInitialAgentPanesReady;

		// 状態が変わったらスナップショットを再送。エージェント状態の変化は通知判定も行う。
		// 再送はイベント起点では100msに集約する（特にウィンドウリサイズ中の
		// onDidChangeInstanceDimensions はインスタンス数×フレーム数で連射されるため、
		// そのまま送るとリレー帯域を浪費する）。
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => { this.refreshBranches(); this.kickPrStatusRefresh(); this.pushStateSoon(); }));
		// 切替はエディタターミナルのpark/unpark（allInstances の増減）を伴うため、agentペイン対応表も同期し直す
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => { this.pushStateSoon(); void this.pushAgentPanes(); }));
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => { this.detectAndNotify(); this.pushStateSoon(); }));
		this._register(this.terminalService.onDidChangeInstances(() => this.pushStateSoon()));
		this._register(this.terminalIdentityService.onDidChange(() => this.pushStateSoon()));
		// タイトル変更（F2手動リネーム、モバイルからのrename、プロセス由来の自動タイトルなど）を
		// 他のペアリング端末・他ウィンドウへも伝播する。
		this._register(this.terminalService.onAnyInstanceTitleChange(() => this.pushStateSoon()));
		// park/unpark（ワークスペース切り替えでの退避/復帰）は instances イベントに乗らないため groups 変化でも再送する
		this._register(this.terminalGroupService.onDidChangeGroups(() => this.pushStateSoon()));
		// PC側のリサイズで cols/rows が変わったら再送（モバイルのxtermが同寸法に追従する）
		this._register(this.terminalService.onDidChangeInstanceDimensions(() => this.pushStateSoon()));
		// attach中ターミナルのリサイズは、寸法確定後にVTスナップショットで再同期する。
		// 生ストリームだけだと「新寸法向けの再描画がモバイルの旧寸法xtermへ書かれる」レースが
		// 構造的に残り、特に代替バッファ（TUI）はリサイズでリフローされないため崩れたままになる。
		this._register(this.terminalService.onDidChangeInstanceDimensions(instance => this.scheduleResizeResync(instance)));
		// worktree（スペース）の増減もワークスペース一覧に反映する（PR 状態も前倒しで取り直す）
		this._register(this.worktreeService.onDidChangeWorktrees(() => { this.kickPrStatusRefresh(); this.pushStateSoon(); }));
		// agentチャネル用: terminalId ⇔ ペイントークンの対応を shared process へ同期する
		// （チャットミラーが attach(id) を transcript へ解決するのに使う）。
		this._register(this.paneTokenService.onDidChange(() => { this.pushStateSoon(); void this.pushAgentPanes(); }));
		// 起動時の孤児エディタターミナル復活（reviveOrphanedScopedEditorTerminals）等、
		// park台帳への登録はterminalServiceのイベントに乗らない。スコープ確定の変化を
		// 再送のトリガーにして、復活したペインが state / agentペイン対応表へ確実に載るようにする。
		this._register(this.terminalScopeService.onDidChangeStableScope(() => { this.pushStateSoon(); void this.pushAgentPanes(); }));
		this._register(this.terminalService.onDidChangeInstances(() => { void this.pushAgentPanes(); }));
		this._register(this.terminalService.onAnyInstanceProcessIdReady(() => { void this.pushAgentPanes(); }));
		this._register(this.terminalService.onDidChangeInstanceCapability(() => { void this.pushAgentPanes(); }));
		void this.pushAgentPanes();
		this.refreshBranches();
	}

	/**
	 * terminalId ⇔ ペイントークン対応表を shared process のチャットミラーへ同期する。
	 * cwd はhook未発火時のセッション探索フォールバック（~/.claude/projects の逆引き）に使う。
	 */
	syncAgentPaneRegistry(): Promise<void> {
		this.refreshAgentPaneCwdListeners();
		const revision = ++this.agentPanesRevision;
		const livePanes = paradisCollectLivePaneInstances(this.terminalService, this.terminalGroupService, this.paneTokenService);
		const result = Promise.all(livePanes.map(async ({ instance: inst, token }) => {
			const cwd = await paradisResolveLocalAgentPaneCwd(inst);
			const ws = this.resolveTerminalStateKey(inst.instanceId);
			return { terminalId: inst.instanceId, token, ...(cwd !== undefined ? { cwd } : {}), ...(ws !== undefined ? { ws } : {}) };
		})).then(entries => this.syncAgentPanes(revision, entries.filter(entry =>
			this.paneTokenService.getInstanceForToken(entry.token) === entry.terminalId
			&& this.paneTokenService.getTokenForInstance(entry.terminalId) === entry.token,
		))).then(() => this.markInitialAgentPanesReady());
		void result.catch(err => this.logService.warn('[paradisMobileRelay] pushAgentPanes failed', err));
		return result;
	}

	private pushAgentPanes(): Promise<void> {
		return this.syncAgentPaneRegistry();
	}

	private readonly agentPaneCwdListeners = this._register(new DisposableMap<number>());

	private refreshAgentPaneCwdListeners(): void {
		const instances = paradisCollectAllTerminalInstances(this.terminalService, this.terminalGroupService);
		const liveInstanceIds = new Set(instances.map(instance => instance.instanceId));
		for (const instanceId of [...this.agentPaneCwdListeners.keys()]) {
			if (!liveInstanceIds.has(instanceId)) {
				this.agentPaneCwdListeners.deleteAndDispose(instanceId);
			}
		}

		for (const instance of instances) {
			if (this.agentPaneCwdListeners.has(instance.instanceId)) {
				continue;
			}
			const listeners = new DisposableStore();
			const cwdListener = listeners.add(new MutableDisposable());
			const bindCwdListener = () => {
				const capability = instance.capabilities.get(TerminalCapability.CwdDetection)
					?? instance.capabilities.get(TerminalCapability.NaiveCwdDetection);
				cwdListener.value = capability?.onDidChangeCwd(() => { void this.pushAgentPanes(); });
			};
			bindCwdListener();
			listeners.add(instance.capabilities.onDidAddCapability(() => {
				bindCwdListener();
				void this.pushAgentPanes();
			}));
			listeners.add(instance.capabilities.onDidRemoveCapability(() => bindCwdListener()));
			listeners.add(instance.onDisposed(() => this.agentPaneCwdListeners.deleteAndDispose(instance.instanceId)));
			this.agentPaneCwdListeners.set(instance.instanceId, listeners);
		}
	}

	private readonly pushStateScheduler = this._register(new RunOnceScheduler(() => this.pushState(), 100));

	/** イベント起点のスナップショット再送（100msに集約）。 */
	private pushStateSoon(): void {
		if (!this.pushStateScheduler.isScheduled()) {
			this.pushStateScheduler.schedule();
		}
	}

	// リポジトリID → 現在のブランチ名（state スナップショット用の非同期キャッシュ）。
	private readonly branchCache = new Map<string, string>();

	// ---- PR 状態（ワークスペースid → 現在ブランチの GitHub PR）のポーリング ----
	// PC版 Workspaces ビューと同じ間隔。gh の GitHub API 呼び出しを伴うため、
	// モバイルが1台もオンラインでない間はポーリングを止める。
	private static readonly PR_STATUS_POLL_INTERVAL_MS = 300_000;
	private readonly prStatusCache = new Map<string, IParadisPrStatus>();
	private mobileOnline = false;
	private prStatusesInFlight = false;
	private readonly prStatusScheduler = this._register(new RunOnceScheduler(() => { this.refreshPrStatuses().catch(() => { /* refreshPrStatuses内で処理済み */ }); }, ParadisMobileWorkspaceProvider.PR_STATUS_POLL_INTERVAL_MS));

	/** リポジトリ/worktree 構成が変わった直後の前倒し取得（オンライン時のみ）。 */
	private kickPrStatusRefresh(): void {
		if (this.mobileOnline) {
			this.prStatusScheduler.schedule(0);
		}
	}

	/** contribution が relay の接続状態（オンラインのモバイル台数 > 0）を反映する。 */
	setMobileOnline(online: boolean): void {
		if (this.mobileOnline === online) {
			return;
		}
		this.mobileOnline = online;
		if (online) {
			// オンラインへ転じた瞬間に1回即時取得し、以後は間隔ポーリング
			this.prStatusScheduler.schedule(0);
		} else {
			this.prStatusScheduler.cancel();
		}
	}

	/** 各ワークスペース（リポジトリ本体 + worktree）の PR 状態を取得し、変化があれば state を再送する。 */
	private async refreshPrStatuses(): Promise<void> {
		if (!this.mobileOnline) {
			return;
		}
		if (this.prStatusesInFlight) {
			this.prStatusScheduler.schedule();
			return;
		}
		// fsPath → ワークスペースid（stateスナップショットの workspaces[].id と同じキー体系）
		const pathToWsId = new Map<string, string>();
		for (const repo of this.workspaceSwitchService.repositories) {
			if (repo.uri.scheme !== 'file') {
				continue;
			}
			pathToWsId.set(repo.uri.fsPath, repo.id);
			for (const worktree of this.worktreeService.getWorktrees(repo.id)) {
				if (!worktree.missing) {
					pathToWsId.set(worktree.uri.fsPath, paradisWorktreeStateKey(worktree.uri));
				}
			}
		}
		if (pathToWsId.size === 0) {
			this.prStatusScheduler.schedule();
			return;
		}
		this.prStatusesInFlight = true;
		try {
			const result = await this.getPrStatuses([...pathToWsId.keys()]);
			if (result) {
				const next = new Map<string, IParadisPrStatus>();
				for (const [path, status] of Object.entries(result)) {
					const wsId = pathToWsId.get(path);
					if (wsId !== undefined) {
						next.set(wsId, status);
					}
				}
				const changed = next.size !== this.prStatusCache.size
					|| [...next].some(([wsId, status]) => {
						const prev = this.prStatusCache.get(wsId);
						return !prev || prev.number !== status.number || prev.state !== status.state || prev.url !== status.url;
					});
				if (changed) {
					this.prStatusCache.clear();
					for (const [wsId, status] of next) {
						this.prStatusCache.set(wsId, status);
					}
					this.pushStateSoon();
				}
			}
		} catch (err) {
			// gh 未認証・コマンド未登録等は PR ピルを出さないだけで安全に縮退する
			this.logService.trace('[paradisMobileRelay] refreshPrStatuses failed', String(err));
		} finally {
			this.prStatusesInFlight = false;
			// 取得中にモバイルが全切断された場合はここで止める（setMobileOnlineのcancelは
			// スケジューラにしか効かないため、実行中だった1回分の再スケジュールを防ぐ）
			if (this.mobileOnline) {
				this.prStatusScheduler.schedule();
			}
		}
	}

	/** stateスナップショットの workspaces[].pr 用に必要最小限のフィールドへ絞る。 */
	private prForWs(wsId: string): { pr: { number: number; state: IParadisPrStatus['state']; url: string } } | Record<string, never> {
		const status = this.prStatusCache.get(wsId);
		return status ? { pr: { number: status.number, state: status.state, url: status.url } } : {};
	}

	/** 各リポジトリのブランチ名を非同期に更新し、変化があれば state を再送する。 */
	private refreshBranches(): void {
		for (const repo of this.workspaceSwitchService.repositories) {
			if (repo.uri.scheme !== 'file') {
				continue;
			}
			this.runGit(repo.uri.fsPath, ['rev-parse', '--abbrev-ref', 'HEAD']).then(result => {
				const branch = result.stdout.trim();
				if (branch && this.branchCache.get(repo.id) !== branch) {
					this.branchCache.set(repo.id, branch);
					this.pushState();
				}
			}).catch(() => { /* gitが無い等は無視 */ });
		}
	}

	/**
	 * エージェント状態の遷移を検知して notify フレームを送る。
	 * - permission（質問/許可要求）への遷移 → agent-question
	 * - review（作業完了）への遷移 → agent-done
	 * これがモバイルの「エージェントの質問通知」の供給源。全オンラインモバイルへ届ける。
	 */
	/**
	 * park 中（他ワークスペースへ退避中）のグループも含めた全ターミナルインスタンス。
	 * terminalService.instances はアクティブワークスペースの表示中グループしか含まないため、
	 * これを使わないとモバイル側は「PCで選択中のワークスペースのターミナル」しか見えない。
	 */
	private allInstances(): ITerminalInstance[] {
		return paradisCollectAllTerminalInstances(this.terminalService, this.terminalGroupService);
	}

	private resolveTerminalStateKey(instanceId: number): string | undefined {
		const recordedStateKey = this.terminalScopeService.getStateKeyForInstance(instanceId);
		return paradisResolveMobileTerminalStateKey(
			recordedStateKey,
			this.terminalScopeService.resolveScope(instanceId),
			this.workspaceSwitchService.activeStateKey,
		);
	}

	/** Agent復元・Hint購読向けに、表示中/背景/park済みを含む全live terminalを返す。 */
	getAllTerminalInstancesForAgentRecovery(): readonly ITerminalInstance[] {
		return paradisCollectLivePaneInstances(this.terminalService, this.terminalGroupService, this.paneTokenService).map(({ instance }) => instance);
	}

	private findAuthoritativePaneInstance(instanceId: number, token: string): ITerminalInstance | undefined {
		if (this.paneTokenService.getInstanceForToken(token) !== instanceId) {
			return undefined;
		}
		return this.allInstances().find(candidate => candidate.instanceId === instanceId
			&& !candidate.isDisposed
			&& this.paneTokenService.getTokenForInstance(instanceId) === token);
	}

	private detectAndNotify(): void {
		for (const inst of this.allInstances()) {
			const stateKey = this.terminalScopeService.getStateKeyForInstance(inst.instanceId);
			if (!stateKey) {
				continue;
			}
			const status = this.agentStatusStore.getScopeStatus(stateKey);
			const prev = this.previousScopeStatus.get(stateKey);
			if (status && status !== prev) {
				// 'question' (AskUserQuestion) はここでは通知しない: shared process の
				// transcript ミラーが質問本文・選択肢つきの通知を別経路で全モバイルへ
				// 送るため、状態遷移ベースの汎用通知と二重になるのを防ぐ。
				if (status === 'permission' || status === 'review') {
					this.emitNotify(status === 'permission' ? 'agent-question' : 'agent-done', inst.instanceId, stateKey, inst.title);
				}
			}
			if (status) {
				this.previousScopeStatus.set(stateKey, status);
			} else {
				this.previousScopeStatus.delete(stateKey);
			}
		}
	}

	private emitNotify(kind: NotifyKind, terminalId: number, ws: string, terminalTitle: string): void {
		const wsName = this.wsDisplayName(ws);
		const title = kind === 'agent-question'
			? `${terminalTitle} — ${wsName}`
			: `${terminalTitle} — ${wsName}`;
		const body = kind === 'agent-question'
			? 'エージェントが確認を求めています'
			: 'エージェントが作業を完了しました';
		// agentToken: PC側でこのペインが確認済みになった際に、対応するモバイル通知を
		// 一括で既読化する識別子として使う（dispatchAgentDismiss、notifyPrefsとは別用途）。
		const agentToken = this.paneTokenService.getTokenForInstance(terminalId);
		const terminalKey = this.terminalIdentityService.getTerminalKey(terminalId);
		const payload: NotifyPayload = {
			kind, id: `n${generateUuid()}`, title, body,
			ws: `${this.windowId}:${ws}`,
			terminalId,
			...(terminalKey !== undefined ? { terminalKey } : {}),
			windowId: this.windowId,
			...(agentToken !== undefined ? { agentToken } : {}),
			at: Date.now(),
		};
		this.sendFrame({ ch: Channels.Notify, ws: undefined, seq: 0, payload: VSBuffer.wrap(encodeNotify(payload)) });
	}

	/** 接続確立直後などに全状態を送る。 */
	pushState(): void {
		this.syncTerminalState(this.buildSnapshot());
	}

	private buildSnapshot(): StateSnapshot {
		// リポジトリの直後にそのworktree（スペース）を並べる。idはターミナルスコープ等と
		// 同じ状態キー（worktree:<uri>）なので、モバイル側のフィルタがそのまま効く。
		const workspaces: IParadisMobileWindowWorkspaceV2[] = [];
		for (const r of this.workspaceSwitchService.repositories) {
			workspaces.push({
				id: r.id,
				name: r.name,
				...(r.color ? { color: r.color } : {}),
				...(this.branchCache.has(r.id) ? { branch: this.branchCache.get(r.id) } : {}),
				...this.prForWs(r.id),
			});
			for (const worktree of this.worktreeService.getWorktrees(r.id)) {
				if (worktree.missing) {
					continue;
				}
				workspaces.push({
					id: paradisWorktreeStateKey(worktree.uri),
					// 「✦ 」接頭辞は旧アプリ（フラット表示）互換のため残す。新アプリはparentで
					// グルーピングし、表示時に接頭辞を取り除く
					name: `✦ ${worktree.name}`,
					...(r.color ? { color: r.color } : {}),
					...(worktree.branch ? { branch: worktree.branch } : {}),
					parent: r.id,
					...this.prForWs(paradisWorktreeStateKey(worktree.uri)),
				});
			}
		}
		const terminals = this.allInstances().flatMap(inst => {
			const terminalKey = this.terminalIdentityService.getTerminalKey(inst.instanceId);
			if (terminalKey === undefined) {
				return [];
			}
			// 確定した未スコープ端末だけをactiveへフォールバックする。切替・再attach中の
			// pending端末をactiveへ誤配送せず、次の確定スナップショットまで所属を保留する。
			const stateKey = this.resolveTerminalStateKey(inst.instanceId);
			// 状態はペイン単位の値を使う。スコープ集約値（getScopeStatus）を付けると、
			// 同スコープで別のエージェントが動いているだけで無関係なプレーンターミナルまで
			// 「実行中」に見えてしまう（ホーム一覧・Live Activity の誤表示の原因）。
			const agentStatus = this.agentStatusStore.getInstanceStatus(inst.instanceId);
			// agent: そのターミナルでエージェントCLIの実在セッションが確認できたか。
			// 通常はhook発火、共有daemon利用時は鮮度検証済みtranscript探索で確定する。
			// モバイル側はホーム一覧・Live Activity をこのフラグで絞る。
			const paneToken = this.getPaneTokenForTerminalHint(inst.instanceId);
			const agent = this.agentStatusStore.isAgentInstance(inst.instanceId)
				|| (paneToken !== undefined && (this.confirmedAgentPaneTokens.has(paneToken) || this.provisionalAgentPaneTokens.has(paneToken)));
			return {
				terminalKey,
				id: inst.instanceId,
				title: inst.title,
				...(stateKey ? { ws: stateKey } : {}),
				...(agent ? { agent } : {}),
				...(agent && paneToken !== undefined ? { agentToken: paneToken } : {}),
				...(agentStatus ? { agentStatus } : {}),
				...(inst.cols > 0 && inst.rows > 0 ? { cols: inst.cols, rows: inst.rows } : {}),
			};
		});
		return { activeWs: this.workspaceSwitchService.activeStateKey, workspaces, terminals };
	}

	/** shared processがhookまたは検証済みtranscriptから確定したエージェント端末を反映する。 */
	setConfirmedAgentPaneTokens(tokens: readonly string[]): void {
		const next = new Set(tokens);
		if (next.size === this.confirmedAgentPaneTokens.size
			&& [...next].every(token => this.confirmedAgentPaneTokens.has(token))) {
			return;
		}
		this.confirmedAgentPaneTokens = next;
		this.pushStateSoon();
	}

	/** shell integrationが検知した対話型Agent CLIを、session確定前からホームへ反映する。 */
	setProvisionalAgentPaneToken(token: string, active: boolean): void {
		const changed = active ? !this.provisionalAgentPaneTokens.has(token) : this.provisionalAgentPaneTokens.has(token);
		if (!changed) { return; }
		if (active) { this.provisionalAgentPaneTokens.add(token); } else { this.provisionalAgentPaneTokens.delete(token); }
		this.pushStateSoon();
	}

	/** Terminal Hintの高頻度出力経路を、実行中世代またはworking状態のexact ownerへ限定する。 */
	isTerminalHintActive(token: string): boolean {
		if (this.provisionalAgentPaneTokens.has(token)) {
			return true;
		}
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		return instanceId !== undefined
			&& this.paneTokenService.getTokenForInstance(instanceId) === token
			&& this.agentStatusStore.getInstanceStatus(instanceId) === 'working';
	}

	/** Terminal Hint対象判定用に、instanceへ現在割り当てられたpane tokenを返す。 */
	getPaneTokenForTerminalHint(instanceId: number): string | undefined {
		const token = this.paneTokenService.getTokenForInstance(instanceId);
		return token !== undefined && this.paneTokenService.getInstanceForToken(token) === instanceId ? token : undefined;
	}

	/** オンラインのモバイルが居なくなったら、全ターミナル購読を解放する（M-2: 購読リーク防止）。 */
	detachAll(): void {
		for (const key of this.termSyncStates.keys()) {
			this.clearTermSync(key);
		}
		this.termSyncStates.clear();
		this.attachedTerminals.clearAndDisposeAll();
		this.terminalSubscribers.clear();
	}

	override dispose(): void {
		// setTimeout ベースのタイマー（coalesce/resize）を確実に止める。
		for (const key of this.termSyncStates.keys()) {
			this.clearTermSync(key);
		}
		this.termSyncStates.clear();
		super.dispose();
	}

	/** shared process から届いたモバイル→PCフレームを処理する。 */
	handleInbound(frame: InboundFrame): void {
		if (frame.ch === Channels.State) {
			// モバイルからの state 要求（空ペイロード）には現在のスナップショットで応答。
			this.pushState();
			return;
		}
		if (frame.ch === Channels.Terminal) {
			this.handleTerminalInbound(frame.payload, frame.mobileId).catch(err => this.logService.warn('[paradisMobileRelay] terminal operation failed', err));
			return;
		}
		if (frame.ch === Channels.Agent) {
			this.handleAgentAction(frame.payload, frame.mobileId).catch(err => this.logService.warn('[paradisMobileRelay] agent action failed', err));
			return;
		}
		if (frame.ch === Channels.Scm) {
			this.handleScmInbound(frame.payload, frame.mobileId).catch(err => this.logService.warn('[paradisMobileRelay] scm request failed', err));
			return;
		}
		if (frame.ch === Channels.Fs) {
			this.handleFsInbound(frame.payload, frame.mobileId).catch(err => this.logService.warn('[paradisMobileRelay] fs request failed', err));
		}
	}

	private async handleAgentAction(payload: VSBuffer, mobileId: string | undefined): Promise<void> {
		if (mobileId === undefined) {
			return;
		}
		let msg: { t?: unknown; id?: unknown; token?: unknown; requestId?: unknown; epoch?: unknown; text?: unknown; setting?: unknown; value?: unknown; parts?: unknown; delayMs?: unknown; windowId?: unknown };
		let interactionAccepted = false;
		try {
			msg = JSON.parse(payload.toString());
		} catch {
			return;
		}
		const sendMessage = msg.t === 'action/sendMessage' && typeof msg.text === 'string'
			&& typeof msg.windowId === 'number' && Number.isInteger(msg.windowId);
		const claudeSetting = msg.t === 'action/claudeSetting' && (msg.setting === 'model' || msg.setting === 'effort')
			&& typeof msg.value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(msg.value)
			&& typeof msg.windowId === 'number' && Number.isInteger(msg.windowId);
		const interaction = msg.t === 'action/interaction' && Array.isArray(msg.parts) && msg.parts.length > 0 && msg.parts.length <= 500
			&& msg.parts.every(part => typeof part === 'string' && part.length <= 10_000)
			&& typeof msg.delayMs === 'number' && Number.isInteger(msg.delayMs) && msg.delayMs >= 0 && msg.delayMs <= 1_000
			&& typeof msg.windowId === 'number' && Number.isInteger(msg.windowId);
		if ((!sendMessage && !interaction && !claudeSetting) || typeof msg.id !== 'number' || typeof msg.token !== 'string'
			|| typeof msg.requestId !== 'string' || typeof msg.epoch !== 'string') {
			return;
		}
		const instance = this.findAuthoritativePaneInstance(msg.id, msg.token);
		if (instance === undefined) {
			// shared processのイベントは全windowへ届く。対象ペインを所有しないwindowは
			// 拒否を返さず、tokenが一致する所有windowだけに処理を任せる。
			return;
		}
		const claim = await this.claimAgentAction(mobileId, msg.requestId, msg.token, msg.epoch);
		if (claim === 'expired') {
			return; // shared process側のtimeout応答がすでに要求元へ送られている
		}
		if (claim === 'stale') {
			this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'stale-session', '操作対象のエージェントセッションが変わりました');
			return;
		}
		try {
			if (sendMessage) {
				const outcome = await paradisSendAgentMessageToTui(
					msg.text as string,
					(text, execute, bracketedPasteMode) => instance.sendText(text, execute ?? false, bracketedPasteMode),
					async () => {
						const currentInstance = this.findAuthoritativePaneInstance(msg.id as number, msg.token as string);
						return currentInstance === instance && this.validateAgentAction(mobileId, msg.requestId as string, msg.token as string, msg.epoch as string, msg.id as number, msg.windowId as number);
					},
				);
				if (!outcome.executed) {
					this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'stale-session', outcome.consumed ? 'メッセージの貼り付け後にエージェントセッションが変わりました' : '送信前にエージェントセッションが変わりました', outcome.consumed);
					return;
				}
			} else if (claudeSetting) {
				await this.modelSwitchGuard.execute(instance, `/${msg.setting as 'model' | 'effort'} ${msg.value as string}`,
					// クロージャ内では typeof ガードによる絞り込みが効かないため as で明示する（ガード済み）
					() => this.validateAgentAction(mobileId, msg.requestId as string, msg.token as string, msg.epoch as string, msg.id as number, msg.windowId as number));
				if (!(await this.validateAgentAction(mobileId, msg.requestId, msg.token, msg.epoch, msg.id, msg.windowId as number))) {
					this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'stale-session', '設定変更中にClaude Codeセッションが変わりました');
					return;
				}
			} else {
				const parts = msg.parts as string[];
				for (let index = 0; index < parts.length; index++) {
					if (index > 0) {
						await new Promise<void>(resolve => setTimeout(resolve, msg.delayMs as number));
						const currentInstance = this.findAuthoritativePaneInstance(msg.id, msg.token);
						if (currentInstance !== instance) {
							this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'stale-session', '操作対象のターミナルが変わりました');
							return;
						}
						const continuation = await this.continueAgentInteraction(mobileId, msg.requestId, msg.token, msg.epoch, msg.id, msg.windowId as number);
						if (continuation === 'completed') {
							this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'interaction-completed', '回答対象は別の操作で完了しました');
							return;
						}
						if (continuation === 'stale') {
							this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', 'stale-interaction', '回答対象の質問または承認要求が変わりました');
							return;
						}
					}
					await instance.sendText(parts[index], false);
				}
				interactionAccepted = true;
			}
			this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'accepted');
		} catch {
			this.sendAgentActionResult(mobileId, msg.id, msg.token, msg.requestId, 'rejected', claudeSetting ? 'confirmation-failed' : 'send-failed', claudeSetting ? 'Claude Codeの設定変更を確認できませんでした' : 'メッセージを送信できませんでした');
		} finally {
			if (interaction) {
				await this.finalizeAgentInteraction(mobileId, msg.requestId, msg.token, interactionAccepted ? 'accepted' : 'failed').catch(err => this.logService.warn('[paradisMobileRelay] finalize agent interaction failed', err));
			}
		}
	}

	private sendAgentActionResult(mobileId: string, id: number, token: string, requestId: string, status: 'accepted' | 'rejected', code?: string, message?: string, consumed?: boolean): void {
		this.sendFrame({
			ch: Channels.Agent, ws: undefined, seq: 0, mobileId,
			payload: VSBuffer.fromString(JSON.stringify({ t: 'action-result', id, token, requestId, status, ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}), ...(consumed === true ? { consumed: true } : {}) })),
		});
	}

	// --- ws（状態キー）の解決 ------------------------------------------------------

	/**
	 * ワークスペースID（リポジトリID or worktree状態キー）をルートURIへ解決する。
	 * scm / fs / ターミナル作成の全チャネルで共通に使う。
	 */
	private resolveWsRoot(ws: string): URI | undefined {
		const repo = this.workspaceSwitchService.repositories.find(r => r.id === ws);
		if (repo) {
			return repo.uri;
		}
		if (ws.startsWith('worktree:')) {
			for (const r of this.workspaceSwitchService.repositories) {
				for (const worktree of this.worktreeService.getWorktrees(r.id)) {
					if (paradisWorktreeStateKey(worktree.uri) === ws) {
						return worktree.uri;
					}
				}
			}
		}
		return undefined;
	}

	/** ワークスペースID → 表示名（通知タイトル用）。 */
	private wsDisplayName(ws: string): string {
		const repo = this.workspaceSwitchService.repositories.find(r => r.id === ws);
		if (repo) {
			return repo.name;
		}
		for (const r of this.workspaceSwitchService.repositories) {
			for (const worktree of this.worktreeService.getWorktrees(r.id)) {
				if (paradisWorktreeStateKey(worktree.uri) === ws) {
					return `${r.name} ✦ ${worktree.name}`;
				}
			}
		}
		return ws;
	}

	// --- scm チャネル -----------------------------------------------------------

	private repoPathForWs(ws: string): string | undefined {
		const root = this.resolveWsRoot(ws);
		return root?.scheme === 'file' ? root.fsPath : undefined;
	}

	private async handleScmInbound(payload: VSBuffer, mobileId: string | undefined): Promise<void> {
		let msg: ScmInbound;
		try {
			msg = JSON.parse(decoder.decode(payload.buffer)) as ScmInbound;
		} catch {
			return;
		}
		const reply = (body: object) => {
			this.sendFrame({ ch: Channels.Scm, ws: undefined, seq: 0, payload: VSBuffer.wrap(encoder.encode(JSON.stringify({ id: msg.id, ...body }))), mobileId: mobileId || undefined });
		};
		// worktree作成系は特定ワークスペースに紐づかない（wsを持たない）ため、repoPath解決より先に処理する
		if (msg.t === 'worktreeForm' || msg.t === 'createWorktree') {
			try {
				if (msg.t === 'worktreeForm') {
					reply({ t: 'worktreeForm', ...(await this.getWorktreeCreateForm()) });
				} else {
					if (typeof msg.repo !== 'string' || msg.repo.length === 0) {
						reply({ error: 'repo is required' });
						return;
					}
					const result = await this.createWorktree({
						repositoryId: msg.repo,
						...(typeof msg.name === 'string' ? { name: msg.name } : {}),
						...(typeof msg.branch === 'string' ? { branch: msg.branch } : {}),
						...(typeof msg.base === 'string' ? { baseRef: msg.base } : {}),
						...(typeof msg.prompt === 'string' ? { prompt: msg.prompt } : {}),
						...(typeof msg.agent === 'string' ? { agentId: msg.agent } : {}),
					});
					reply({ t: 'createWorktree', ...result });
				}
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		const repoPath = this.repoPathForWs(msg.ws);
		if (!repoPath) {
			reply({ error: `unknown workspace: ${msg.ws}` });
			return;
		}
		try {
			if (msg.t === 'status') {
				const [status, branch] = await Promise.all([
					this.runGit(repoPath, ['status', '--porcelain=v1']),
					this.runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
				]);
				const files = status.stdout.split('\n').filter(l => l.length > 3).map(line => ({
					// porcelain v1: XY <path> （リネームは "old -> new"）
					x: line[0],
					y: line[1],
					path: line.slice(3).includes(' -> ') ? line.slice(3).split(' -> ')[1] : line.slice(3),
				}));
				reply({ t: 'status', branch: branch.stdout.trim(), files });
			} else if (msg.t === 'diff') {
				const args = msg.staged ? ['diff', '--cached'] : ['diff'];
				if (msg.path) {
					args.push('--', msg.path);
				}
				const result = await this.runGit(repoPath, args);
				// 未追跡ファイルは diff に出ないため、空なら内容そのものを差分風に返す
				let diff = result.stdout;
				if (!diff && msg.path) {
					const read = await this.readWorkspaceFile(msg.ws, msg.path);
					if (read !== undefined) {
						diff = read.split('\n').map(l => `+${l}`).join('\n');
					}
				}
				reply({ t: 'diff', diff });
			} else if (msg.t === 'commit') {
				if (!msg.message.trim()) {
					reply({ error: 'empty commit message' });
					return;
				}
				if (msg.all) {
					const addResult = await this.runGit(repoPath, ['add', '-A']);
					if (addResult.code !== 0) {
						reply({ error: addResult.stderr || 'git add failed' });
						return;
					}
				}
				const result = await this.runGit(repoPath, ['commit', '-m', msg.message]);
				if (result.code !== 0) {
					reply({ error: result.stderr || result.stdout || 'git commit failed' });
				} else {
					reply({ t: 'commit', output: result.stdout.trim() });
					this.refreshBranches();
				}
			} else if (msg.t === 'xlsxDiff') {
				// Excel差分: HEAD(git:スキーマ、git拡張のFSプロバイダ経由) vs 作業ツリーを
				// PC版差分ビューアと同じ計算・描画でHTML化して返す。
				const modified = await this.resolveWorkspacePathReal(msg.ws, msg.path);
				if (!modified) {
					reply({ error: `invalid path: ${msg.path}` });
					return;
				}
				const original = modified.with({ scheme: 'git', query: JSON.stringify({ path: modified.fsPath, ref: 'HEAD' }) });
				const html = await renderSpreadsheetDiffMobileHtml(this.fileService, this.sharedProcessService, original, modified, 'HEAD', '作業ツリー');
				reply({ t: 'xlsxDiff', html });
			} else if (msg.t === 'log') {
				const limit = Math.min(Math.max(Math.trunc(msg.limit ?? 10), 1), 100);
				const skip = Math.max(Math.trunc(msg.skip ?? 0), 0);
				// limit+1件取得して切り詰めることで、追加ページの有無(hasMore)を1回のgit logで判定する
				// %ct(committer dateのepoch秒)が相対時刻表示の主データ。モバイル側が表示のたびに
				// 再計算するので取得時点のスナップショットが古くならない（%arだと整形済み文字列が
				// 固定される上、author date基準のためrebaseしたコミットが実際より古く見える）。
				// %arは旧バージョンのモバイルアプリ向けフォールバックとして当面残す。
				const result = await this.runGit(repoPath, ['log', '--skip', String(skip), '-n', String(limit + 1), '--pretty=format:%H%x09%ct%x09%ar%x09%s']);
				// コミット0件のリポジトリも exit 128 になるため、実エラーは「非ゼロ かつ stderr あり」で判定する
				if (result.code !== 0 && result.stderr.trim() && !/does not have any commits yet/.test(result.stderr)) {
					reply({ error: result.stderr.trim() });
					return;
				}
				const all = result.stdout.split('\n').filter(l => l.includes('\t')).map(line => {
					const [hash, ct, when, ...subject] = line.split('\t');
					const at = Number(ct) * 1000;
					return { hash, when, subject: subject.join('\t'), ...(Number.isFinite(at) && at > 0 ? { at } : {}) };
				});
				const hasMore = all.length > limit;
				const commits = hasMore ? all.slice(0, limit) : all;
				// リモートのWeb URLが分かればモバイル側でコミットページへ飛べるようにする。
				// remoteが無い/失敗してもログ本体の応答は返す（履歴表示を巻き添えにしない）。
				const remote = await this.runGit(repoPath, ['remote', 'get-url', 'origin']).catch(() => undefined);
				const webUrl = remote && remote.code === 0 ? remoteToWebUrl(remote.stdout.trim()) : undefined;
				reply({ t: 'log', commits, hasMore, ...(webUrl ? { webUrl } : {}) });
			} else if (msg.t === 'commitFiles') {
				// ハッシュ以外（オプションやrev式）を渡させない。`git show` は引数次第で
				// ファイル内容も出せるサブコマンドなので、40桁以内の16進に厳格に絞る
				if (!/^[0-9a-f]{4,40}$/i.test(msg.hash)) {
					reply({ error: 'invalid commit hash' });
					return;
				}
				const result = await this.runGit(repoPath, ['show', '--name-status', '--pretty=format:', msg.hash]);
				if (result.code !== 0) {
					reply({ error: result.stderr.trim() || 'git show failed' });
					return;
				}
				const files = result.stdout.split('\n').filter(l => l.includes('\t')).map(line => {
					const parts = line.split('\t');
					// リネーム(R100等)は "R100<TAB>old<TAB>new" なので新パスを採用する
					return { status: parts[0][0] ?? '?', path: parts[parts.length - 1] };
				});
				reply({ t: 'commitFiles', files });
			}
		} catch (err) {
			reply({ error: String(err) });
		}
	}

	// --- fs チャネル ------------------------------------------------------------

	/** ワークスペースルート配下に正規化したURIを返す（../ 等の脱出は拒否）。 */
	private resolveWorkspacePath(ws: string, relPath: string): URI | undefined {
		const root = this.resolveWsRoot(ws);
		if (!root) {
			return undefined;
		}
		// モバイル側は常に'/'区切りの相対パスを送る想定。Windows上ではjoinPath内部で
		// path.win32.joinが使われ'\'もセパレータとして解釈・畳み込まれるため、
		// '/'区切りのセグメント検査だけでは`..\..\secrets`のような脱出を検出できない。
		// '\'を含む入力はこの経路では常に不正とみなして拒否する。
		if (relPath.includes('\\')) {
			return undefined;
		}
		const segments = relPath.split('/').filter(s => s.length > 0);
		if (segments.some(s => s === '..' || s === '.')) {
			return undefined;
		}
		return segments.length === 0 ? root : joinPath(root, ...segments);
	}

	/**
	 * resolveWorkspacePathに加え、シンボリックリンク経由でのワークスペース外脱出も検査する
	 * （設計書 §8）。'list'の子要素フィルタだけでは対象自体やパス途中のシンボリックリンクを
	 * 防げないため、実パスを解決してリポジトリルート配下に収まっているかを確認する。
	 */
	private async resolveWorkspacePathReal(ws: string, relPath: string): Promise<URI | undefined> {
		const uri = this.resolveWorkspacePath(ws, relPath);
		if (!uri) {
			return undefined;
		}
		const root = this.resolveWsRoot(ws);
		if (!root) {
			return undefined;
		}
		const [real, realRoot] = await Promise.all([
			this.fileService.realpath(uri),
			this.fileService.realpath(root),
		]);
		if (!real || !realRoot) {
			return undefined;
		}
		// fileService.realpath は fs.realpath の戻り値文字列をそのまま URI.path に入れて返すため、
		// Windows ではネイティブパス（`C:\Users\...`、バックスラッシュ区切り・先頭スラッシュ無し）が
		// 入り、URI 形式の root.path（`/c:/Users/...`）と文字列比較しても絶対に一致しない。
		// URI.file で正規化し直してから、大文字小文字差（ドライブレター等）も吸収する
		// extUriBiasedIgnorePathCase で包含判定する。
		const normalizeRealUri = (candidate: URI): URI => candidate.scheme === 'file' && (candidate.path.includes('\\') || !candidate.path.startsWith('/'))
			? URI.file(candidate.path)
			: candidate;
		const realUri = normalizeRealUri(real);
		const realRootUri = normalizeRealUri(realRoot);
		if (!extUriBiasedIgnorePathCase.isEqualOrParent(realUri, realRootUri)) {
			return undefined;
		}
		return uri;
	}

	private async readWorkspaceFile(ws: string, relPath: string): Promise<string | undefined> {
		const uri = await this.resolveWorkspacePathReal(ws, relPath);
		if (!uri) {
			return undefined;
		}
		try {
			const content = await this.fileService.readFile(uri, { length: FS_READ_LIMIT });
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	/**
	 * PCの現行カラーテーマそのままのシンタックスハイライトHTMLを生成する。
	 * トークン色は tokenizeToString が付ける mtk クラス + カラーマップCSSで再現し、
	 * 背景/前景はテーマのエディタ色を添える。失敗時は undefined（モバイル側はプレーン表示）。
	 */
	private async highlightFile(uri: URI, text: string): Promise<{ html: string; css: string; bg?: string; fg?: string; highlightTruncated?: boolean } | undefined> {
		try {
			// TextMate文法は拡張機構経由で登録されるため、登録完了を待ってから言語解決する
			await this.extensionService.whenInstalledExtensionsRegistered();
			const truncated = text.length > HIGHLIGHT_SOURCE_LIMIT;
			const source = truncated ? text.slice(0, HIGHLIGHT_SOURCE_LIMIT) : text;
			const newlineIndex = source.indexOf('\n');
			const firstLine = newlineIndex === -1 ? source : source.slice(0, newlineIndex);
			const languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(uri, firstLine);
			const html = await tokenizeToString(this.languageService, source, languageId);
			const colorMap = TokenizationRegistry.getColorMap();
			const css = colorMap ? generateTokensCSSForColorMap(colorMap) : '';
			const theme = this.themeService.getColorTheme();
			return {
				html,
				css,
				bg: theme.getColor(editorBackground)?.toString(),
				fg: theme.getColor(editorForeground)?.toString(),
				...(truncated ? { highlightTruncated: true } : {}),
			};
		} catch (err) {
			this.logService.warn('[paradisMobileRelay] highlight failed', err);
			return undefined;
		}
	}

	/**
	 * Markdownフェンスのコード断片をPCの現行テーマでハイライトする（highlightFile の断片版）。
	 * 言語はフェンスの言語名（`ts` / `typescript` 等）から解決する。名前で引けない場合は
	 * 拡張子として解釈し、それでも不明ならプレーンテキスト扱い（着色なしのHTMLが返る）。
	 */
	private async highlightSnippet(text: string, lang: string | undefined): Promise<{ html: string; css: string; bg?: string; fg?: string } | undefined> {
		if (typeof text !== 'string' || text.length === 0 || text.length > HIGHLIGHT_SOURCE_LIMIT) {
			return undefined;
		}
		await this.extensionService.whenInstalledExtensionsRegistered();
		let languageId: string | null = null;
		if (typeof lang === 'string' && lang.length > 0 && lang.length < 32) {
			const cleaned = lang.trim().toLowerCase();
			languageId = this.languageService.getLanguageIdByLanguageName(cleaned);
			if (!languageId) {
				// フェンス名が言語名でない場合は拡張子として解決する（`ts` → typescript 等）
				languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(`/snippet.${cleaned.replace(/[^a-z0-9+#-]/g, '')}`), undefined);
			}
		}
		const html = await tokenizeToString(this.languageService, text, languageId);
		const colorMap = TokenizationRegistry.getColorMap();
		const css = colorMap ? generateTokensCSSForColorMap(colorMap) : '';
		const theme = this.themeService.getColorTheme();
		return {
			html,
			css,
			bg: theme.getColor(editorBackground)?.toString(),
			fg: theme.getColor(editorForeground)?.toString(),
		};
	}

	private async handleFsInbound(payload: VSBuffer, mobileId: string | undefined): Promise<void> {
		let msg: FsInbound;
		const binaryUpload = paradisDecodeBinaryFsUpload(payload.buffer);
		if (binaryUpload !== undefined) {
			msg = binaryUpload;
		} else {
			try {
				msg = JSON.parse(decoder.decode(payload.buffer)) as FsInbound;
			} catch {
				return;
			}
		}
		const reply = (body: object) => {
			this.sendFrame({ ch: Channels.Fs, ws: undefined, seq: 0, payload: VSBuffer.wrap(encoder.encode(JSON.stringify({ id: msg.id, ...body }))), mobileId: mobileId || undefined });
		};
		const replyBinary = (type: ParadisBinaryFsResponseType, size: number, data: Uint8Array): boolean => {
			const responseEncoding = msg.t === 'pdf' || msg.t === 'docx' || msg.t === 'media' ? msg.responseEncoding : undefined;
			const encoded = paradisEncodeNegotiatedBinaryFsResponse(responseEncoding, type, msg.id, size, data);
			if (encoded === undefined) {
				return false;
			}
			this.sendFrame({ ch: Channels.Fs, ws: undefined, seq: 0, payload: VSBuffer.wrap(encoded), mobileId: mobileId || undefined });
			return true;
		};
		// 画像アップロード（エージェントへの添付用）。ワークスペースを汚さないよう
		// userData 配下の専用ディレクトリへ保存し、フルパスを返す（モバイル側がPTYへ
		// パスを貼り付け、エージェントCLIがそのパスの画像を読む）。パスは取らないため
		// パス解決の前に処理する。ファイル名はサニタイズし、脱出の余地を残さない。
		if (msg.t === 'upload') {
			try {
				const encodedLength = typeof msg.data === 'string' ? msg.data.length : msg.base64Length;
				if (encodedLength === undefined || encodedLength > UPLOAD_BASE64_LIMIT || (msg.data instanceof Uint8Array && msg.data.byteLength > UPLOAD_DECODED_LIMIT)) {
					// allow-any-unicode-next-line
					reply({ error: `ファイルが大きすぎます。添付は ${Math.round(UPLOAD_LIMIT / 1024 / 1024)}MB までです。` });
					return;
				}
				const content = typeof msg.data === 'string' ? decodeBase64(msg.data) : VSBuffer.wrap(msg.data);
				const dot = msg.name.lastIndexOf('.');
				const ext = dot >= 0 ? msg.name.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) : '';
				const dir = joinPath(this.environmentService.userRoamingDataHome, 'paraMobileUploads');
				// 同ミリ秒の連続アップロードで上書きしないよう乱数サフィックスを付ける
				const target = joinPath(dir, `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext ? `.${ext}` : ''}`);
				await this.fileService.writeFile(target, content);
				reply({ t: 'upload', path: target.fsPath });
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// ccusage 使用量ダッシュボード。ワークスペースに紐付かないため、パス解決の前に処理する。
		if (msg.t === 'usage') {
			try {
				const data = await this.fetchUsageDashboard(!!msg.bypassCache);
				reply({ t: 'usage', data });
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// AIリミット(Rate Limit)。usage と同じくワークスペース非依存(閲覧専用。追加・再ログインはPC側のみ)。
		if (msg.t === 'limits') {
			try {
				const data = await this.fetchLimitsSnapshot(!!msg.bypassCache);
				reply({ t: 'limits', data });
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// テキスト断片のハイライト（エージェントチャットのコードブロック用）。ファイルの
		// highlight と同じく Monaco トークナイザ + 現行テーマのカラーマップで生成する。
		// 失敗はエラーでなく空応答（モバイル側はプレーン表示にフォールバック）。
		if (msg.t === 'hl') {
			try {
				const result = await this.highlightSnippet(msg.text, msg.lang);
				reply({ t: 'hl', ...(result ?? {}) });
			} catch (err) {
				this.logService.warn('[paradisMobileRelay] snippet highlight failed', err);
				reply({ t: 'hl' });
			}
			return;
		}
		// 検索（find/grep）はパスでなくクエリを取るため、パス解決の前に処理する。
		// 実行はshared process（ripgrep）。ワークスペースルート起点なので脱出の余地はない。
		if (msg.t === 'find' || msg.t === 'grep') {
			const root = this.resolveWsRoot(msg.ws);
			if (!root || root.scheme !== 'file') {
				reply({ error: `unknown workspace: ${msg.ws}` });
				return;
			}
			try {
				if (msg.t === 'find') {
					const result = await this.searchFiles(root.fsPath, msg.query, 100);
					reply({ t: 'find', files: result.files, truncated: result.truncated });
				} else {
					const result = await this.searchText(root.fsPath, msg.query, 200);
					reply({ t: 'grep', matches: result.matches, truncated: result.truncated });
				}
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		if (msg.t === 'resolveLink') {
			const root = this.resolveWsRoot(msg.ws);
			if (!root || root.scheme !== 'file' || typeof msg.path !== 'string' || msg.path.length === 0 || msg.path.length > 4_096 || msg.path.includes('\0')) {
				reply({ error: 'invalid file link' });
				return;
			}
			try {
				const normalizeRelative = (input: string): string | undefined => {
					const segments: string[] = [];
					for (const segment of input.replace(/\\/g, '/').split('/')) {
						if (segment.length === 0 || segment === '.') { continue; }
						if (segment === '..') {
							if (segments.length === 0) { return undefined; }
							segments.pop();
						} else {
							segments.push(segment);
						}
					}
					return segments.join('/');
				};
				const rawPath = msg.path.trim();
				const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(rawPath) || /^\\\\/.test(rawPath);
				const posixAbsolute = rawPath.startsWith('/');
				let relativePath: string | undefined;
				if (windowsAbsolute || posixAbsolute) {
					const absoluteUri = URI.file(rawPath);
					if (extUriBiasedIgnorePathCase.isEqualOrParent(absoluteUri, root)) {
						relativePath = extUriBiasedIgnorePathCase.relativePath(root, absoluteUri);
					}
					// `/src/file.ts` はワークスペースルート基準で生成されることもある。
					// 実絶対パスがroot外の場合だけ、先頭/を外した相対候補として扱う。
					if (relativePath === undefined && posixAbsolute) {
						relativePath = normalizeRelative(rawPath.slice(1));
					}
				} else {
					relativePath = normalizeRelative(rawPath);
				}
				if (relativePath === undefined || relativePath.length === 0) {
					reply({ error: 'file link is outside the workspace' });
					return;
				}
				const uri = await this.resolveWorkspacePathReal(msg.ws, relativePath);
				if (uri === undefined || (await this.fileService.stat(uri)).isDirectory) {
					reply({ error: 'file link does not point to a file' });
					return;
				}
				reply({ t: 'resolveLink', path: relativePath });
			} catch {
				reply({ error: 'file link could not be resolved' });
			}
			return;
		}
		const uri = await this.resolveWorkspacePathReal(msg.ws, msg.path);
		if (!uri) {
			reply({ error: `invalid path: ${msg.path}` });
			return;
		}
		try {
			if (msg.t === 'xlsx') {
				// シート単位の遅延読み込み(sheet省略時は先頭)。シート一覧はモバイルの
				// ネイティブタブに使われ、切替時に該当sheetだけ再要求される。
				const result = await renderSpreadsheetMobileSheet(this.fileService, this.sharedProcessService, uri, typeof msg.sheet === 'number' ? msg.sheet : 0);
				reply({ t: 'xlsx', html: result.html, sheets: result.sheets, sheet: result.sheet });
			} else if (msg.t === 'pdf') {
				// PDF はバイナリのまま base64 で返す（'read' の UTF-8 デコード経路はバイナリを壊すため使えない）。
				const stat = await this.fileService.stat(uri);
				if ((stat.size ?? 0) > BINARY_READ_LIMIT) {
					// allow-any-unicode-next-line
					reply({ error: `PDF が大きすぎます（${Math.round((stat.size ?? 0) / 1024 / 1024)}MB）。モバイル表示は ${BINARY_READ_LIMIT / 1024 / 1024}MB までです。` });
					return;
				}
				const content = await this.fileService.readFile(uri, { length: BINARY_READ_LIMIT });
				// 標準base64（パディング付き）。モバイル側は expo-file-system の Base64 エンコーディング指定で
				// ネイティブデコードしながらファイルへ書くため、JSでのデコードは発生しない。
				const size = stat.size ?? 0;
				if (!replyBinary('pdf', size, content.value.buffer)) {
					reply({ t: 'pdf', data: encodeBase64(content.value), size });
				}
			} else if (msg.t === 'docx') {
				// Word文書もバイナリのまま base64 で返す（レンダリングはモバイル側の WebView が
				// PC版ビューアと同じ vendored docx-preview で行う。PC側でHTML化しないのは、
				// docx-preview がDOM前提でタブストップ計算等が表示環境のフォント計測に依存するため）。
				const stat = await this.fileService.stat(uri);
				if ((stat.size ?? 0) > BINARY_READ_LIMIT) {
					// allow-any-unicode-next-line
					reply({ error: `Word 文書が大きすぎます（${Math.round((stat.size ?? 0) / 1024 / 1024)}MB）。モバイル表示は ${BINARY_READ_LIMIT / 1024 / 1024}MB までです。` });
					return;
				}
				const content = await this.fileService.readFile(uri, { length: BINARY_READ_LIMIT });
				const size = stat.size ?? 0;
				if (!replyBinary('docx', size, content.value.buffer)) {
					reply({ t: 'docx', data: encodeBase64(content.value), size });
				}
			} else if (msg.t === 'media') {
				// 画像・動画・音声もバイナリのまま base64 で返す（表示はモバイル側。画像は data URI、
				// 動画/音声はキャッシュファイル経由で WKWebView のネイティブ再生を使う）。
				const stat = await this.fileService.stat(uri);
				if ((stat.size ?? 0) > BINARY_READ_LIMIT) {
					// allow-any-unicode-next-line
					reply({ error: `ファイルが大きすぎます（${Math.round((stat.size ?? 0) / 1024 / 1024)}MB）。モバイル表示は ${BINARY_READ_LIMIT / 1024 / 1024}MB までです。` });
					return;
				}
				const content = await this.fileService.readFile(uri, { length: BINARY_READ_LIMIT });
				const size = stat.size ?? 0;
				if (!replyBinary('media', size, content.value.buffer)) {
					reply({ t: 'media', data: encodeBase64(content.value), size });
				}
			} else if (msg.t === 'list') {
				const stat = await this.fileService.resolve(uri);
				const entries = (stat.children ?? [])
					.filter(c => !c.isSymbolicLink) // シンボリックリンク越えの読み取りを防止（設計書 §8）
					.map(c => ({ name: c.name, dir: c.isDirectory, size: c.size }))
					.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
				reply({ t: 'list', entries });
			} else if (msg.t === 'read') {
				const stat = await this.fileService.stat(uri);
				const content = await this.fileService.readFile(uri, { length: FS_READ_LIMIT });
				const text = content.value.toString();
				const body: Record<string, unknown> = { t: 'read', content: text, truncated: (stat.size ?? 0) > FS_READ_LIMIT, size: stat.size ?? 0 };
				if (msg.highlight) {
					const highlighted = await this.highlightFile(uri, text);
					if (highlighted) {
						Object.assign(body, highlighted);
					}
				}
				reply(body);
			}
		} catch (err) {
			reply({ error: String(err) });
		}
	}

	private async handleTerminalInbound(payload: VSBuffer, mobileId: string | undefined): Promise<void> {
		let msg: TermInbound;
		try {
			msg = JSON.parse(decoder.decode(payload.buffer)) as TermInbound;
		} catch {
			return;
		}
		if (msg.protocolVersion !== PARADIS_MOBILE_PROTOCOL_VERSION || typeof msg.desktopEpoch !== 'string' || typeof msg.operationId !== 'string' || mobileId === undefined) {
			return;
		}
		const complete = (status: ParadisMobileTerminalOperationStatus) => this.completeTerminalOperation(mobileId, msg.operationId, status);
		if (msg.t === 'create') {
			// モバイルからの新規ターミナル作成。ws指定時はそのリポジトリ/worktreeをcwdにする。
			const ws = msg.ws;
			if (typeof ws !== 'string' || ws.length === 0) {
				await complete('terminal-not-found');
				return;
			}
			const root = this.resolveWsRoot(ws);
			if (root === undefined) {
				await complete('terminal-not-found');
				return;
			}
			// 作成時点でのPC側アクティブスコープ。指定wsがこれと一致（または未指定）なら
			// PCの現在の作業ワークスペース宛なので、通常の「新規ターミナル」と同じくパネルに表示する。
			const activeStateKey = this.workspaceSwitchService.activeStateKey;
			try {
				const instance = await this.terminalService.createTerminal({ cwd: root });
				if (ws !== activeStateKey) {
					// PC側で非表示のワークスペース向け: 既定のタグ付け（アクティブスコープ所属）を
					// 指定wsへ付け替える。アクティブ外なので assignInstanceScope が即 park し、
					// そのワークスペースへ切り替えたときにだけ表示される。
					this.terminalScopeService.assignInstanceScope(instance.instanceId, ws);
				} else {
					// PCのアクティブws向け: 既定タグ付けのままアクティブに残る。
					// createTerminal はパネルを開かないため、通常の「新規ターミナル」コマンドと同様に
					// アクティブ化してターミナルパネルを表示し、PC側にちゃんと出るようにする。
					this.terminalService.setActiveInstance(instance);
					if (instance.target !== TerminalLocation.Editor) {
						try {
							await this.terminalGroupService.showPanel(false);
						} catch (err) {
							// PTY作成は完了済み。パネル表示失敗を操作失敗にすると再試行で二重作成になる。
							this.logService.warn('[paradisMobileRelay] showPanel failed', err);
						}
					}
				}
				this.pushState();
				await complete('accepted');
			} catch (err) {
				this.logService.warn('[paradisMobileRelay] createTerminal failed', err);
				await complete('failed');
			}
			return;
		}
		if (typeof msg.terminalKey !== 'string'
			|| (msg.t === 'attach' && (typeof msg.epoch !== 'number' || !Number.isInteger(msg.epoch)))
			|| (msg.t === 'ack' && (typeof msg.epoch !== 'number' || !Number.isInteger(msg.epoch) || typeof msg.seq !== 'number' || !Number.isInteger(msg.seq)))
			|| (msg.t === 'input'
				&& typeof msg.data !== 'string'
				&& typeof msg.text !== 'string'
				&& !(typeof msg.key === 'string' && ['up', 'down', 'right', 'left'].includes(msg.key)))) {
			await complete('failed');
			return;
		}
		// park 中（他ワークスペースのターミナル）にもモバイルからattach/入力できるようにする
		const instanceId = this.terminalIdentityService.getInstanceId(msg.terminalKey);
		const instance = instanceId === undefined ? undefined : this.allInstances().find(i => i.instanceId === instanceId);
		if (!instance) {
			await complete('terminal-not-found');
			return;
		}
		const id = instance.instanceId;
		const subscriptionKey = this.termSubscriptionKey(id, mobileId);
		try {
			if (msg.t === 'attach') {
				// モバイルごとに独立した同期状態を持ち、同じ端末の購読を奪い合わない。
				let subscribers = this.terminalSubscribers.get(id);
				if (subscribers === undefined) {
					subscribers = new Set();
					this.terminalSubscribers.set(id, subscribers);
				}
				subscribers.add(mobileId);
				// epoch付きattach（同期プロトコル対応クライアント）は世代状態を作り直す。
				this.clearTermSync(subscriptionKey);
				this.termSyncStates.delete(subscriptionKey);
				this.termSyncStates.set(subscriptionKey, {
					epoch: msg.epoch, seq: 0, inflight: [], unackedChars: 0,
					...(msg.dataEncoding === PARADIS_TERMINAL_BINARY_DATA_ENCODING ? { dataEncoding: PARADIS_TERMINAL_BINARY_DATA_ENCODING } : {}),
					suspended: false, droppedWhileSuspended: false,
					pending: [], pendingChars: 0, coalesceTimer: undefined, resizeTimer: undefined,
				});
				this.sendTerminalSnapshot(instance, id, mobileId);
				if (this.attachedTerminals.has(id)) {
					await complete('accepted');
					return;
				}
				const store = new DisposableStore();
				const relayConsumer = (data: string) => this.sendTermData(id, data);
				store.add(instance.onData(paradisCreateTerminalOutputConsumer(relayConsumer, undefined)!));
				store.add(instance.onExit(() => {
					for (const subscriber of this.terminalSubscribers.get(id) ?? []) {
						const key = this.termSubscriptionKey(id, subscriber);
						const epoch = this.termSyncStates.get(key)?.epoch;
						this.clearTermSync(key);
						this.termSyncStates.delete(key);
						this.sendTerm(id, subscriber, { t: 'exit', ...(epoch !== undefined ? { epoch } : {}) });
					}
					this.attachedTerminals.deleteAndDispose(id);
					this.terminalSubscribers.delete(id);
				}));
				this.attachedTerminals.set(id, store);
			} else if (msg.t === 'detach') {
				this.clearTermSync(subscriptionKey);
				this.termSyncStates.delete(subscriptionKey);
				const subscribers = this.terminalSubscribers.get(id);
				subscribers?.delete(mobileId);
				if (subscribers?.size === 0) {
					this.attachedTerminals.deleteAndDispose(id);
					this.terminalSubscribers.delete(id);
				}
			} else if (msg.t === 'ack') {
				this.handleTerminalAck(instance, id, mobileId, msg);
			} else if (msg.t === 'input') {
				await this.handleTerminalInput(instance, msg);
			} else if (msg.t === 'rename') {
				if (typeof msg.title !== 'string') {
					await complete('failed');
					return;
				}
				// 制御文字（改行・Bidi override等）はタブ表示のなりすまし・崩れの元になるため除去する。
				const title = msg.title.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e]/g, '').trim().slice(0, 200);
				if (title.length > 0) {
					await instance.rename(title);
				} else {
					await complete('failed');
					return;
				}
			} else if (msg.t === 'close') {
				// モバイル側で既に破壊的操作の確認ダイアログを経ているため、PC側の
				// confirmOnKill確認（safeDisposeTerminal）は挟まず直接閉じる。挟むと、
				// PCが無人の間はモバイルから応答できない確認ダイアログで永久にハングする。
				instance.dispose(TerminalExitReason.User);
			} else if (msg.t === 'ackStatus') {
				// PCのフォーカス中自動既読（paradisAgentStatus.contribution.ts）と同じ経路。
				// shared processの_paneStatusesがクリアされ、ポーラー経由でホーム一覧の表示も
				// アイドルへ戻り、通知履歴のdismiss（dispatchAgentDismiss）も自動で走る。
				const token = this.getPaneTokenForTerminalHint(instance.instanceId);
				if (token !== undefined) {
					await this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call('acknowledgePaneStatus', [token]);
				} else {
					await complete('failed');
					return;
				}
			} else {
				await complete('failed');
				return;
			}
			await complete('accepted');
		} catch (err) {
			this.logService.warn('[paradisMobileRelay] terminal execution failed', err);
			await complete('failed');
		}
	}

	/**
	 * モバイルからのターミナル入力を端末モードに合わせて送る。
	 * - key: application cursor keys モード中は SS3（ESC O A 等）、通常は CSI（ESC [ A 等）。
	 *   モバイル側は端末モードを知らないため、モード判定はPC側で行う（vim / less 等で矢印が
	 *   効かなくなる問題の対策）
	 * - text: bracketed paste モード中は ESC[200~...ESC[201~ で包む（sendText が判定）。
	 *   複数行テキストが1行目で実行されるのを防ぐ
	 * - data: 生のまま送る（従来動作）
	 */
	private async handleTerminalInput(instance: ITerminalInstance, msg: { data?: string; key?: TermSemanticKey; text?: string; execute?: boolean }): Promise<void> {
		if (msg.key !== undefined) {
			const finalChar = { up: 'A', down: 'B', right: 'C', left: 'D' }[msg.key];
			if (finalChar !== undefined) {
				const applicationMode = instance.xterm?.raw.modes.applicationCursorKeysMode === true;
				await instance.sendText(applicationMode ? `\x1bO${finalChar}` : `\x1b[${finalChar}`, false);
				return;
			}
			// 未知のキー名（将来の拡張）は data フォールバックへ落とす（モバイルは key と
			// 等価な生シーケンスを data に常時併載する契約）。
		}
		if (msg.text !== undefined) {
			await instance.sendText(msg.text, msg.execute === true, true);
		} else if (msg.data !== undefined) {
			// 生入力を送る（改行はモバイル側が明示的に送る）。
			// /model・/effort 切替の注入時は確認ダイアログ自動確定ウォッチを張る。
			this.modelSwitchGuard.maybeArm(instance, msg.data);
			await instance.sendText(msg.data, false);
		}
	}

	/** まとめ送りタイマーと保留バッファのみ破棄する（snapshot送信時用。resizeTimerは別ライフサイクル）。 */
	private clearTermCoalesce(sync: TermSyncState): void {
		if (sync.coalesceTimer !== undefined) {
			clearTimeout(sync.coalesceTimer);
			sync.coalesceTimer = undefined;
		}
		sync.pending = [];
		sync.pendingChars = 0;
	}

	/**
	 * 同期プロトコル状態のタイマー・保留バッファを全て破棄する（map のエントリ自体は
	 * 消さない。detach/exit 側で必要に応じて delete する）。
	 */
	private termSubscriptionKey(id: number, mobileId: string): string {
		return `${mobileId}\0${id}`;
	}

	private clearTermSync(key: string): void {
		const sync = this.termSyncStates.get(key);
		if (!sync) {
			return;
		}
		this.clearTermCoalesce(sync);
		if (sync.resizeTimer !== undefined) {
			clearTimeout(sync.resizeTimer);
			sync.resizeTimer = undefined;
		}
	}

	/**
	 * pty出力1チャンクの転送。同期プロトコル有効時はまとめ送り＋フロー制御を通す。
	 * suspend中は破棄し（ptyは止めない）、ACKが追いついた時点のスナップショットで追いつく。
	 */
	private sendTermData(id: number, data: string): void {
		for (const mobileId of this.terminalSubscribers.get(id) ?? []) {
			this.queueTermData(id, mobileId, data);
		}
	}

	private queueTermData(id: number, mobileId: string, data: string): void {
		const sync = this.termSyncStates.get(this.termSubscriptionKey(id, mobileId));
		if (!sync) {
			return;
		}
		paradisQueueTerminalRelayOutput(
			sync,
			data,
			() => this.flushTermData(id, mobileId),
			() => { sync.coalesceTimer = setTimeout(() => this.flushTermData(id, mobileId), TERM_COALESCE_MS); },
		);
	}

	/** まとめ送りバッファを1フレームとして送信し、未ACK残量が閾値を超えたらsuspendする。 */
	private flushTermData(id: number, mobileId: string): void {
		const sync = this.termSyncStates.get(this.termSubscriptionKey(id, mobileId));
		if (!sync) {
			return;
		}
		if (sync.coalesceTimer !== undefined) {
			clearTimeout(sync.coalesceTimer);
			sync.coalesceTimer = undefined;
		}
		if (sync.pendingChars === 0 || !this.terminalSubscribers.get(id)?.has(mobileId)) {
			sync.pending = [];
			sync.pendingChars = 0;
			return;
		}
		const data = sync.pending.join('');
		sync.pending = [];
		sync.pendingChars = 0;
		const seq = ++sync.seq;
		sync.inflight.push({ seq, chars: data.length });
		sync.unackedChars += data.length;
		this.sendTerm(id, mobileId, { t: 'data', data, epoch: sync.epoch, seq });
		if (sync.unackedChars > TERM_HIGH_WATERMARK_CHARS) {
			sync.suspended = true;
		}
	}

	/** モバイルからのACK。未ACK残量を減らし、suspend中でLOWまで追いついたらsnapshotで再同期する。 */
	private handleTerminalAck(instance: ITerminalInstance, id: number, mobileId: string, msg: { epoch: number; seq: number }): void {
		const sync = this.termSyncStates.get(this.termSubscriptionKey(id, mobileId));
		if (!sync || sync.epoch !== msg.epoch) {
			return; // 旧世代のACKは無視（再attach直後の混在で正常に起きる）
		}
		while (sync.inflight.length > 0 && sync.inflight[0].seq <= msg.seq) {
			sync.unackedChars -= sync.inflight[0].chars;
			sync.inflight.shift();
		}
		if (sync.suspended && sync.unackedChars <= TERM_LOW_WATERMARK_CHARS) {
			sync.suspended = false;
			if (sync.droppedWhileSuspended) {
				sync.droppedWhileSuspended = false;
				// 破棄していた間の出力はもう送れないので、最新画面のスナップショットで追いつく
				// （moshの「中間状態スキップ」に相当。スクロールバックの完全性より最新画面を優先）。
				this.sendTerminalSnapshot(instance, id, mobileId);
			}
		}
	}

	/**
	 * attach中ターミナルのリサイズ後の再同期をスケジュールする（ドラッグ中の連射を
	 * デバウンスし、寸法確定後にスナップショット1回へ収斂させる）。
	 */
	private scheduleResizeResync(instance: ITerminalInstance): void {
		const id = instance.instanceId;
		for (const mobileId of this.terminalSubscribers.get(id) ?? []) {
			const sync = this.termSyncStates.get(this.termSubscriptionKey(id, mobileId));
			if (!sync) {
				continue;
			}
			if (sync.resizeTimer !== undefined) {
				clearTimeout(sync.resizeTimer);
			}
			sync.resizeTimer = setTimeout(() => {
				sync.resizeTimer = undefined;
				if (this.terminalSubscribers.get(id)?.has(mobileId)) {
					this.sendTerminalSnapshot(instance, id, mobileId);
				}
			}, TERM_RESIZE_SNAPSHOT_DELAY_MS);
		}
	}

	/**
	 * attach したモバイルへ、現在の端末画面をVTスナップショットとして送る。
	 * serialize addon が使えない場合はプレーンテキスト末尾へフォールバックする（従来動作）。
	 * 同期プロトコル有効時は epoch/seq と適用すべき cols/rows・unicode幅版を同梱し、
	 * モバイルが「reset→resize→write」を原子的に適用できるようにする。
	 */
	private sendTerminalSnapshot(instance: ITerminalInstance, id: number, mobileId: string): void {
		const subscriptionKey = this.termSubscriptionKey(id, mobileId);
		const expectedSync = this.termSyncStates.get(subscriptionKey);
		if (expectedSync === undefined) {
			return;
		}
		this.serializeTerminalSnapshot(instance).then(snapshot => {
			// serialize解決を待つ間に detach された場合は送らない。
			if (!this.terminalSubscribers.get(id)?.has(mobileId)) {
				return;
			}
			let data = snapshot;
			if (data === undefined) {
				const contents = instance.xterm?.getContentsAsText();
				if (!contents) {
					return;
				}
				const tail = contents.length > TERM_SCROLLBACK_LIMIT ? contents.slice(-TERM_SCROLLBACK_LIMIT) : contents;
				data = tail.endsWith('\n') ? tail : tail + '\r\n';
			}
			const sync = this.termSyncStates.get(subscriptionKey);
			if (sync !== expectedSync) {
				return;
			}
			// snapshotはバッファ全体を置き換えるため、まとめ送り待ちの生データは破棄してよい
			// （serialize前の書き込みバリアでPC側xtermに反映済み＝snapshotに含まれている。
			// 送るだけ帯域の無駄になる）。resizeTimer はここでは触らない（serialize待ちの間に
			// 発生した新しいリサイズの再同期予約を消してしまうため）。
			this.clearTermCoalesce(sync);
			const seq = ++sync.seq;
			sync.inflight.push({ seq, chars: data.length });
			sync.unackedChars += data.length;
			if (sync.unackedChars > TERM_HIGH_WATERMARK_CHARS) {
				// 巨大snapshot直後も水位ルールを一貫させる（モバイルはsnapshotを即ACKするため
				// 詰まらない。ACKが来るまでの生ストリームはdrop→追いつき時に再snapshot）。
				sync.suspended = true;
			}
			const dims = instance.cols > 0 && instance.rows > 0 ? { cols: instance.cols, rows: instance.rows } : {};
			const unicode = instance.xterm?.raw.unicode.activeVersion;
			this.sendTerm(id, mobileId, { t: 'data', data, snapshot: true, epoch: sync.epoch, seq, ...dims, ...(unicode ? { unicode } : {}) });
		}).catch(err => this.logService.warn('[paradisMobileRelay] scrollback sync failed', err));
	}

	/**
	 * PC側xtermの現画面をVTシーケンスへシリアライズする。代替バッファ（TUIの全画面）・
	 * カーソル位置・色・モードを復元できる。serialize addon は端末ごとに一度だけ load する。
	 */
	private async serializeTerminalSnapshot(instance: ITerminalInstance): Promise<string | undefined> {
		const xterm = instance.xterm;
		if (!xterm) {
			return undefined;
		}
		const raw = xterm.raw;
		let addon = this.serializeAddons.get(raw);
		if (!addon) {
			const Ctor = await this.xtermAddonImporter.importAddon('serialize');
			const loaded = new Ctor();
			raw.loadAddon(loaded);
			addon = loaded;
			this.serializeAddons.set(raw, loaded);
		}
		// 書き込みキューのバリア: onData で届いたがPC側xtermがまだパースしていない出力を
		// 反映しきってからシリアライズする。これが無いと「直前の1チャンクがsnapshotにも
		// 後続ストリームにも含まれない」欠落窓ができる（snapshot送信時にまとめ送り待ちの
		// 生データを破棄する前提条件でもある）。
		// 端末dispose等でコールバックが発火しない場合に備え、上限付きで待つ
		// （タイムアウト時は現時点のバッファでシリアライズする＝従来動作相当）。
		await Promise.race([
			new Promise<void>(resolve => raw.write('', () => resolve())),
			timeout(1000),
		]);
		// 通常バッファのスクロールバックは行数で抑える（代替バッファ=TUIは常に全体が含まれる）。
		return addon.serialize({ scrollback: TERM_SNAPSHOT_SCROLLBACK_ROWS });
	}

	private sendTerm(id: number, mobileId: string, msg: TermOutbound): void {
		const terminalKey = this.terminalIdentityService.getTerminalKey(id);
		if (terminalKey === undefined) {
			return;
		}
		const binaryPayload = msg.t === 'data'
			? paradisEncodeNegotiatedBinaryTerminalData(
				this.termSyncStates.get(this.termSubscriptionKey(id, mobileId))?.dataEncoding,
				{
					terminalKey, epoch: msg.epoch, seq: msg.seq,
					...(msg.snapshot === true ? { snapshot: true } : {}),
					...(msg.cols !== undefined ? { cols: msg.cols } : {}),
					...(msg.rows !== undefined ? { rows: msg.rows } : {}),
					...(msg.unicode !== undefined ? { unicode: msg.unicode } : {}),
				},
				msg.data,
			)
			: undefined;
		const payload = binaryPayload ?? encoder.encode(JSON.stringify({ ...msg, terminalKey }));
		this.sendFrame({ ch: Channels.Terminal, ws: undefined, seq: 0, payload: VSBuffer.wrap(payload), mobileId });
	}
}

/**
 * git remote のURLをブラウザで開けるWeb URLへ変換する。
 * 例: git@github.com:owner/repo.git → https://github.com/owner/repo
 */
function remoteToWebUrl(remote: string): string | undefined {
	if (!remote) {
		return undefined;
	}
	let url = remote;
	const scpMatch = url.match(/^(?:ssh:\/\/)?git@(?<host>[^:/]+)[:/](?<repoPath>.+)$/);
	if (scpMatch?.groups) {
		url = `https://${scpMatch.groups.host}/${scpMatch.groups.repoPath}`;
	}
	if (!/^https?:\/\//.test(url)) {
		return undefined;
	}
	// リモートURLに認証情報が埋まっていることがある（x-access-token:<token>@github.com 等）。
	// トークンをモバイルへ送らない・ブラウザURLに露出させないため必ず除去する。
	try {
		const parsed = new URL(url);
		parsed.username = '';
		parsed.password = '';
		url = parsed.toString();
	} catch {
		return undefined;
	}
	return url.replace(/\/$/, '').replace(/\.git$/, '');
}
