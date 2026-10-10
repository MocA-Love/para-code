/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process内で動く、ペイントークン⇔共有ブラウザページのバインディングレジストリ + MCPサーバー本体。
// MCPプロトコルは自前の最小JSON-RPC over Streamable HTTP実装（stateless、POSTのみ、SSEなし）。
// @modelcontextprotocol/sdk はnode_modulesにtransitiveとして存在するが、直接依存に昇格させると
// 製品ビルド（esbuildバンドル・同梱node_modules）への影響範囲が読みにくいこと、必要なのは
// initialize / tools/list / tools/call のごく小さなサブセットだけであることから採用しなかった。
//
// ペイン分離はこのレジストリ層で保証する（トークン→バインド済みページ以外へはアクセス不可）。
// upstreamの playwrightService.ts（_trackedPages等）は一切改造しない。

import type * as http from 'http';
import type { Socket } from 'net';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { constants as fsConstants, promises as fsPromises, writeFileSync } from 'fs';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BROWSER_VIEW_SCREENSHOT_ENCODED_SIZE_ERROR_PREFIX } from '../../../../platform/browserView/common/browserViewScreenshot.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { reportParadisDiagnosticError, reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisAgentNoteResult, PARADIS_AGENT_NOTES_CHANNEL, PARADIS_AGENT_NOTES_METHOD, PARADIS_AGENT_NOTE_TOOL_OPERATIONS, paradisParseAgentNoteToolArgs } from '../common/paradisAgentNotes.js';
// PARA-CODE: named browser profiles MCP tool (vs/paradis/contrib/browserProfiles)
import { IParadisListProfilesResult, IParadisManageProfileResult, IParadisOpenProfileResult, IParadisSwitchProfileResult, PARADIS_AGENT_CREATED_PROFILE_LIMIT, PARADIS_AGENT_CREATED_PROFILE_TOTAL_LIMIT, PARADIS_BROWSER_PROFILE_MCP_CHANNEL, PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD, PARADIS_BROWSER_PROFILE_MCP_PANE_OWNED_METHOD, PARADIS_BROWSER_PROFILE_MCP_METHOD, PARADIS_BROWSER_PROFILE_MCP_SWITCH_METHOD, ParadisOpenProfileFailure, ParadisProfileManageFailure } from '../../browserProfiles/common/paradisBrowserProfileMcp.js';
import { IParadisAgentPageRequestResult, IParadisCloseAgentTabResult, IParadisListAgentTabsResult, IParadisOpenAgentTabResult, IParadisSelectAgentTabResult, PARADIS_AGENT_BROWSER_TABS_CHANNEL, PARADIS_AGENT_PAGE_REQUEST_TIMEOUT_MS, PARADIS_AGENT_TAB_LIMIT, PARADIS_USER_SHARED_PAGE_LIMIT, PARADIS_USER_SHARED_PAGE_LIMIT_ERROR_MARK, ParadisAgentPageRequestFailure, ParadisAgentTabFailure, ParadisAgentTabMethod } from '../common/paradisAgentBrowserTabs.js';
import { IParadisAbortBindResult, IParadisAgentPaneSession, IParadisAgentPaneStatus, IParadisAgentStatusSnapshot, IParadisBindingTicketRequest, IParadisCdpInputDispatchResult, IParadisCdpScreenshotOptions, IParadisCommitBindResult, IParadisExactBrowserViewDescriptor, IParadisGatewayEndpoint, IParadisAgentTabGrant, IParadisGrantAgentTabRequest, IParadisMcpConfigStatus, IParadisMcpFixRequest, IParadisMcpSetupRequest, IParadisMcpSetupResult, IParadisPaneBinding, IParadisPrepareBindRequest, IParadisPrepareBindResult, IParadisPreviewFileResult, IParadisSharedPageInfo, ParadisPreviewFileFailure, PARADIS_AGENT_BROWSER_CHANNEL, PARADIS_AGENT_PANE_ROOTS_METHOD, PARADIS_AGENT_PREVIEW_CHANNEL, PARADIS_CDP_TARGET_CHANNEL, PARADIS_MCP_DEFAULT_PORT, PARADIS_MCP_PORT_FILE_NAME, ParadisAgentStatus, paradisAgentHookEntersWait, paradisIsAgentHookReleaseEvent, paradisNormalizeAgentHookEvent, paradisParseCdpInputDispatchResult, paradisParseExactBrowserViewDescriptor, PARADIS_BROWSER_REPORT_STATE_SETTING, PARADIS_BROWSER_RUN_STEPS_FLOW_SETTING, PARADIS_BROWSER_SETTLE_AFTER_ACTION_SETTING, PARADIS_BROWSER_SITE_NOTES_SETTING, PARADIS_BROWSER_SITE_RECIPES_SETTING } from '../common/paradisAgentBrowser.js';
import { PARADIS_AGENT_HOOK_MAX_BODY_BYTES, PARADIS_AGENT_HOOK_REMOTE_HOST_PARAM, PARADIS_AGENT_HOOKS_ENABLED_SETTING, PARADIS_CODEX_HOOK_EVENTS, paradisAgentHookRemoteHostId, paradisAgentHooksEnabled, paradisIsAgentHookRemoteHostId } from '../common/paradisAgentHooks.js';
import { IParadisBindingAuthorityManifest, IParadisBindingCommitPreparation, IParadisBindingManifestAcceptance, IParadisBindingOwnedTokenLease, IParadisBindingOwnerRelease, IParadisBindingPrepareSnapshot, ParadisBindingAuthority, ParadisBindingAuthorityStableScope, paradisParseBindingAuthorityManifest } from '../common/paradisBindingAuthority.js';
import { paradisBindingMatchesGeneration } from '../common/paradisBrowserBindingLifecycle.js';
import { IParadisAnnouncedReview, paradisIsHarnessNotificationPrompt, paradisIsRepeatedReview, paradisShouldSweepStaleWorkingStatus } from '../common/paradisAgentStatusStale.js';
import { IParadisExactViewBackgroundThrottlingEffect, PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS, ParadisExactViewBackgroundThrottlingCoordinator, ParadisExactViewBackgroundThrottlingDispatcher } from '../common/paradisExactViewBackgroundThrottling.js';
import { IParadisMobileRendererManifest, PARADIS_MOBILE_WINDOW_LEASE_CHANNEL } from '../../mobileRelay/common/paradisMobileWindowLease.js';
import { clearParadisAgentPaneActivity, clearParadisAgentPaneIssueUrls, fireParadisAgentHookEvent, fireParadisAgentNestedHookEvent, getParadisAgentPaneActivity, getParadisAgentPaneIssueUrls, onParadisAgentAwaitingUser, onParadisAgentPaneActivity, onParadisAgentTurnEnded, onParadisAgentTurnStarted, ParadisAgentTurnEndCause, paradisCountLiveBackgroundTasks, paradisSanitizeAgentHookPayload, registerParadisAgentPaneActivityGuard } from './paradisAgentHookBus.js';
import { ParadisAgentHookOwnership, paradisHookAgentKindForTranscript } from './paradisAgentHookOwnership.js';
import { IParadisAgentHookDropRecord, ParadisAgentHookDropCounter, ParadisHookIngressCause, paradisFormatHookDropLog, paradisHookDropPaneKey } from '../common/paradisAgentHookDropLog.js';
import { IParadisReplayedAgentPrompt, IParadisSpooledAgentHook, PARADIS_AGENT_HOOK_ID_PARAM, PARADIS_AGENT_HOOK_ID_PATTERN, PARADIS_AGENT_HOOK_REPLAY_PROMPT_WINDOW_MS, PARADIS_AGENT_HOOK_SPOOL_ALIVE_FILE, PARADIS_AGENT_HOOK_SPOOL_ALIVE_INTERVAL_MS, PARADIS_AGENT_HOOK_SPOOL_DIR_NAME, PARADIS_AGENT_HOOK_SYNC_GRACE_MS, paradisPlanAgentHookReplay } from '../common/paradisAgentHookSpool.js';
import { paradisPruneAgentHookSpool, paradisStampAgentHookSpoolAlive, paradisTakeAgentHookSpool } from './paradisAgentHookSpoolStore.js';
import { onDidChangeParadisCodexHomes, paradisClaudeConfigDir, paradisCodexHome, paradisCodexHomes } from './paradisAgentHome.js';
import { ParadisAgentHooksReconciler, paradisClaudeManagedHookEvents, paradisGetNotifyScriptContent, paradisMergeAgentHooksJson, paradisRemoveAgentHooks, paradisRemoveAgentHooksJson } from './paradisAgentHooksSetup.js';
import { ParadisAgentHooksAutoInstall } from './paradisAgentHooksAutoInstall.js';
import { paradisClaudeModBridge } from '../../claudeMod/node/paradisClaudeModBridge.js';
import { PARADIS_CLAUDE_MOD_APPROVAL_WAIT_SETTING, PARADIS_CLAUDE_MOD_HTTP_PREFIX, paradisClaudeModApprovalWaitMs } from '../../claudeMod/common/paradisClaudeMod.js';
import { ParadisRemoteAgentTunnels } from './paradisRemoteAgentTunnel.js';
import { ParadisLocalVoicePlayer } from './paradisLocalVoicePlayer.js';
import { paradisReceiveRemoteVoice, paradisSendVoiceIngressUnavailable, paradisSendVoiceTicketRejected } from './paradisRemoteVoiceIngress.js';
import { paradisArmRequestBodyTimeout, paradisConfigureMcpHttpServer } from './paradisHttpRequestTimeouts.js';
import { IParadisLocalVoiceOutput } from '../../notifications/common/paradisVoiceIngest.js';
import { PARADIS_MOBILE_VOICE_TICKET_RELEASE_PATH, PARADIS_REMOTE_VOICE_LOCAL_PLAYBACK_SETTING, PARADIS_REMOTE_VOICE_STREAM_INGRESS, paradisRemoteVoiceLocalPlaybackEnabled } from '../common/paradisRemoteVoice.js';
import { createParadisMcpSetupController, ParadisMcpSetupController } from './paradisMcpSetup.js';
import { IParadisMcpPortFileRecord, PARADIS_MCP_HEALTH_PATH, PARADIS_MCP_LOCAL_TOOLS, PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION, ParadisMcpPortFileReconciler, writeParadisMcpPortFileAtomic } from './paradisBrowserMcpShimCore.js';
import { IParadisBrowserDiagnosticNote } from '../common/paradisBrowserDiagnosticNote.js';
import { ParadisCdpGateway, paradisGatewayPaneQuery } from './paradisCdpGateway.js';
import { PARADIS_TAB_ID_ARGUMENT, paradisAgentTabScopeKey, paradisIsValidAgentTabId, paradisPaneTokenOfScopeKey, paradisParseAgentTabScopeKey, paradisTakeTabIdArgument, paradisWithTabIdArgument } from '../common/paradisAgentTabScope.js';
import { paradisClassifyPeer, paradisPeerIsOneOf } from './paradisCdpPeerResolver.js';
import { IParadisCdpInputQueueDiagnostic, IParadisCdpInputQueueOperation, ParadisCdpInputQueue } from './paradisCdpInputQueue.js';
import { PARADIS_PROGRAM_STATUS_MAX_CHANGES_PER_SECOND, paradisCopyProgramStatus, paradisProgramStatusApplies, paradisProgramStatusToAgentStatus } from '../common/paradisProgramStatus.js';
import { ParadisToolCallLanes } from '../common/paradisToolCallLanes.js';
import { ParadisCursorPacingLedger, paradisToolCursorRunKey, paradisWithToolCursorStatus } from './paradisCursorPacing.js';
import { ParadisCursorOwners } from './paradisCursorOwners.js';
import type { IParadisCursorOwner, IParadisCursorStatusNote } from '../common/paradisCursorOverlay.js';
import { ParadisCdpUpstream } from './paradisCdpUpstream.js';
import { IParadisDevtoolsRootsResolution, IParadisProxiedTool, ParadisDevtoolsMcpProxy } from './paradisDevtoolsMcpProxy.js';
import { ParadisInputRejectionLog } from './paradisInputRejectionLog.js';
import { IParadisDevtoolsPathCaller, paradisDevtoolsPathArguments, paradisDevtoolsPathDecision, paradisDevtoolsUserTemporaryFolders, paradisDevtoolsVersionControlRealpathRefusal } from './paradisDevtoolsPathPolicy.js';
// PARA-PATCH: 他のparadis contribがこのMCPサーバーへ自前のツールを足すための拡張点（モバイル端末操作など）
import { IParadisMcpCursorIdentity, IParadisMcpOwningWindowRequest, IParadisMcpPaneAgentStatus, IParadisMcpToolCallContext, IParadisMcpToolProvider, ParadisMcpCallerKind, ParadisMcpOwningWindowResult, paradisRegisteredMcpToolProviders } from '../common/paradisMcpToolProvider.js';
import { PARADIS_SCREENSHOT_FETCH_PATH, ParadisScreenshotHandoff, paradisAppendScreenshotFetchHint, paradisReadScreenshotFile, paradisScreenshotContentType, paradisScreenshotIdFromUrl, paradisScreenshotPathsFromToolResult } from './paradisScreenshotHandoff.js';
import { PARADIS_PAGE_OPS_TOOL_NAME_SET, ParadisBrowserPageOps, paradisPageOpsOwnerKey } from './paradisBrowserPageOps.js';
import { paradisAdjustDevtoolsToolResult, paradisStripInternalDevtoolsArguments, paradisWithScriptClickHint } from './paradisDevtoolsToolAdjustments.js';
import { PARADIS_BROWSER_QUERY_TOOL_NAME_SET, ParadisBrowserQuery } from './paradisBrowserQuery.js';
import { PARADIS_BROWSER_ACT_TOOL_NAME_SET, ParadisBrowserActBy } from './paradisBrowserActBy.js';
import { IParadisObserveHost, IParadisObserveOptions, ParadisBrowserObserver, paradisObserveOptionsFor, paradisTakeObserveArguments, paradisWithObserveArguments } from './paradisBrowserObserve.js';
import { paradisFillFallbackArgs, paradisFillNeedsInsertTextFallback, paradisMergeFillFallbackResult } from './paradisBrowserFillFallback.js';
import { paradisRunSteps } from './paradisBrowserRunSteps.js';
import { IParadisSiteNote, PARADIS_SITE_NOTE_TOOL_NAMES, PARADIS_SITE_NOTE_TOOLS, ParadisSiteNotesStore, paradisFormatSiteNotesHint, paradisSiteNoteCommit, paradisSiteNoteLooksSecret, paradisSiteNoteOrigin, paradisSiteNotesDefaultPath } from './paradisBrowserSiteNotes.js';
import { paradisRunStepsFlow, paradisRunStepsFlowDescriptor } from './paradisBrowserRunStepsFlow.js';
import { ParadisBrowserSiteStoreFullError } from './paradisBrowserSiteStore.js';
import { PARADIS_SITE_RECIPE_TOOL_NAMES, PARADIS_SITE_RECIPE_TOOLS, ParadisSiteRecipesStore, paradisCheckSiteRecipe, paradisFormatSiteRecipesHint, paradisFormatSiteRecipesList, paradisSiteRecipeSteps, paradisSiteRecipesDefaultPath } from './paradisBrowserSiteRecipes.js';
import { ParadisBrowserCapture, paradisCaptureLocalPathRefusal } from './paradisBrowserCapture.js';
import { ParadisBrowserDownloadReader } from './paradisBrowserDownloadReader.js';
import { PARADIS_REMOTE_PANE_FILE_INSTRUCTIONS, ParadisRemoteFileTransfer, paradisDescribeToolsForRemotePane, paradisRemoteFileToolDirection } from './paradisRemoteFileTransfer.js';
import { paradisPaneStorageAffinity } from '../common/paradisBrowserPageOps.js';
import { URI } from '../../../../base/common/uri.js';
import { AgentNetworkFilterService } from '../../../../platform/networkFilter/common/networkFilterService.js';
import { IParadisResolvedDropTarget, PARADIS_FILE_DROP_MAX_BYTES_LABEL, PARADIS_RESOLVE_ELEMENT_CENTER_FUNCTION, ParadisFileDropStaging, paradisBuildFileDropDragCancelCommand, paradisBuildFileDropDragCommands, paradisDecodeFileDropContent, paradisParseResolvedDropTarget, paradisSanitizeFileDropName } from './paradisFileDropUpload.js';

/**
 * PlaywrightChannel（vs/platform/browserView/node/playwrightChannel.ts）の `call` と構造的に一致する
 * 最小インターフェース。ウィンドウ毎の PlaywrightService インスタンスへ ctx キーでアクセスするために使う。
 * PlaywrightChannel 自体には手を入れず、公開メソッド `call` 経由でのみ利用する。
 */
export interface IParadisPlaywrightInvoker {
	call<T>(ctx: string, command: string, arg?: unknown): Promise<T>;
}

interface IBindingEntry {
	readonly windowCtx: string;
	readonly pageId: string;
	readonly pageInfo: IParadisSharedPageInfo;
	readonly generation: number;
	/** バインドされた時刻（epoch ms）。 */
	readonly boundAt: number;
	/** Electron Mainが発行した、window/view/target/concrete-instanceを固定するauthority。 */
	readonly exactView: IParadisExactBrowserViewDescriptor;
	readonly scope: ParadisBindingAuthorityStableScope;
	/**
	 * `_agentTabGrants` の entry のうち、ユーザーがそのペインへ共有したページ（current ではない 2 枚目以降）。
	 * 新しいページを共有すると前の current がこの印付きで許可へ移り、current を外すと最後に共有したものが
	 * current（`_bindings`）へ戻る。エージェントのタブの上限・再読み込みでの取り消しの対象外。
	 */
	readonly userShared?: true;
	/**
	 * `userShared` の entry が、エージェントが自分で開いたタブの許可でもある（open_browser_tab で開いたタブを
	 * ユーザーが共有した後で別のページが current になった）。ユーザーの共有を外したら、許可へ戻す。
	 */
	readonly agentTab?: true;
}

interface IPreparedBindingDescriptor {
	readonly exactView: IParadisExactBrowserViewDescriptor;
	readonly pageInfo: IParadisSharedPageInfo;
}

interface IPaneShellEntry {
	readonly windowCtx: string;
	readonly token: string;
	readonly shellPid: number;
	/**
	 * SSH など接続先で動くペインの接続先。このときの `shellPid` は接続先のプロセス番号なので、
	 * 手元のプロセス表との照合（接続元の確認・CDP の PID 解決・PID の重複検査）には使わない。
	 */
	readonly remoteAuthority?: string;
}

interface IJsonRpcRequest {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
}

export interface IParadisAgentBrowserIngressLease {
	readonly token: string;
	/**
	 * ブラウザのツールが使うタブのスコープキー（paradisAgentTabScope.ts）。tab_id を解決した lease だけが持つ。
	 * 無ければペインのトークンそのもの（共有中のページ）。ペイン単位のこと（接続元・ファイル・状態）は常に `token` で見る。
	 */
	readonly pageKey?: string;
}

const MAX_BODY_BYTES = PARADIS_AGENT_HOOK_MAX_BODY_BYTES;
const MAX_EXTERNAL_BINDINGS = PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS;
const MAX_RENDERER_WINDOWS = 4096;
const MAX_PANE_TOKEN_LENGTH = 200;
const MAX_HOOK_EVENT_LENGTH = 200;
const MAX_PENDING_BIND_PREPARATIONS = 256;
const MAX_ACTIVE_INGRESS_REQUESTS = 128;
/** 1 ペインへの共有が上限（{@link PARADIS_USER_SHARED_PAGE_LIMIT}）に達したときのエラー。renderer は先頭の印（`paradisIsSharedPageLimitError`）で見分ける。 */
const PARADIS_USER_SHARED_PAGE_LIMIT_ERROR = `${PARADIS_USER_SHARED_PAGE_LIMIT_ERROR_MARK}: this terminal pane already has the maximum number of shared pages`;
/** `initialize` の `instructions` の先頭に置く、このサーバー自身（ブラウザ共有）の説明。 */
const PARADIS_BROWSER_MCP_INSTRUCTIONS = 'Para Code MCP server (runs inside the Para Code editor that hosts this terminal). Browser tools act on this terminal pane\'s current tab (by default the page the user shared most recently), or on the tab you pass as tab_id. A pane can use every page the user shared with it (the user may share several) plus up to 5 tabs it opens itself with open_browser_tab; list_browser_tabs shows all of their tabIds and which ones the user shared. When you split browser work across subagents, open (or pick) one tab per subagent and tell each subagent its tabId; the subagent must pass that tab_id on every browser tool call (take_snapshot, click, navigate_page, wait_until, click_by, ...). Calls on different tabs run in parallel; calls on the same tab run one at a time. Without tab_id, tools act on the pane\'s current tab, which open_browser_tab and select_browser_tab change for everyone in this pane. To wait for the page, use wait_until (with network_idle_ms to wait for requests to settle) instead of setTimeout loops in evaluate_script or sleep in the shell; get_text, inspect_element and scroll_to read, measure and scroll without mouse or key input. To click or fill an element you can describe (role + name, text, CSS), use click_by and fill_by instead of take_snapshot + click or DOM changes in evaluate_script; they work with React/MUI inputs and explain why an element cannot be clicked. run_steps runs a known sequence of these tools in one call. capture_screenshot crops elements or a rectangle and can save straight to a file; read_download returns the sheets and cells of a downloaded xlsx, the rows of a csv, or the text of each page of a PDF (you may also read the saved file with your own tools). Before your first click, key or scroll on a page, call set_cursor_label with a short name for your current task (2-12 characters, e.g. "Checkout", "注文入力"). Name the task, not a person or the page title. Subagents that open their own tab can pass label to open_browser_tab instead.';
const MAX_ACTIVE_INGRESS_REQUESTS_PER_TOKEN = 8;
/** Claude Code の mod の受付のペインあたりの上限（長いポーリングの上限 16 本 + 観測の送信）。 */
const MAX_ACTIVE_MOD_REQUESTS_PER_TOKEN = 24;
/**
 * 音声取込の同時本数。SSH 先の声は合成の間ずっと 1 本を握るので、2 本だと 3 本目の声が接続先へ回ってしまう。
 * 枠が空くのを {@link MOBILE_VOICE_SLOT_WAIT_MS} まで待ってから断る。
 */
const MAX_ACTIVE_MOBILE_VOICE_REQUESTS = 8;
const MOBILE_VOICE_SLOT_WAIT_MS = 3_000;
const MOBILE_VOICE_SLOT_POLL_MS = 100;
const MAX_ACTIVE_MOBILE_VOICE_BYTES = 16 * 1024 * 1024;
const MOBILE_VOICE_TICKET_TTL_MS = 10 * 60_000;
const MAX_MOBILE_VOICE_TICKETS = 256;
/**
 * 1 ペインで同時に持てる枚数。`aivis` コマンド（サブエージェントが使う）は積む時に 1 枚取り、PC の再生待ちの間ずっと
 * 持つので、サブエージェントが一斉に話すと 32 枚では足りなかった。aivis-mcp 2.6 からは使わなかった ticket を返す
 * （`/paradis-mcp/mobile-voice-ticket/release`）。サブエージェントは親と同じペインのトークンを使うので、余裕を持たせる。
 */
const MAX_MOBILE_VOICE_TICKETS_PER_PANE = 64;
/** 接続先の aivis-mcp が答えを待つ 15 秒より短く。本文を読み終えてから数える。 */
const LOCAL_VOICE_ENQUEUE_DEADLINE_MS = 10_000;

interface IParadisPaneStatusEntry {
	readonly status: ParadisAgentStatus;
	readonly changedAt: number;
	readonly cwd?: string;
	/** Stop後のバックグラウンドタスク補正によるworkingだけがstale降格の対象。 */
	readonly backgroundCompletionFallback?: boolean;
	/**
	 * Para Code が止まっている間の hook を控えから流し直して付けた「確認待ち」（W2-20）。印は出すが
	 * 鳴らさない。次に本物の hook で状態が書き換わると消える（書き換える側はこの項目を持ち越さない）。
	 */
	readonly quiet?: true;
	/**
	 * 許可待ち・質問中へ入れた hook の送り主を確かめられなかった（tmux のサーバー配下・WSL など）。
	 * このときだけ、確かめられない解除の hook を受け付ける。書き換える側はこの項目を持ち越さない。
	 */
	readonly waitEntryUnverified?: true;
}

/** 観測しながら呼んだ道具が、呼ぶ直前にタブが替わって別の列へ並ぼうとしたときの文。 */
const PARADIS_TAB_CHANGED_DURING_CALL_MESSAGE = 'PARA_BROWSER_RETRYABLE: the tab this call was using changed while it started; call it again (pass tab_id to keep using one tab).';

/** `ms` 待つ。`signal` が止まったらすぐ返る。 */
function paradisSleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) {
		return Promise.resolve();
	}
	return new Promise<void>(resolve => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
	});
}

/** 照合の結果を待つ。`signal` が止まったら待つのをやめて `unverified`（照合そのものは止めない）。 */
function paradisCallerKindUnlessAborted(flight: Promise<ParadisMcpCallerKind>, signal: AbortSignal | undefined): Promise<ParadisMcpCallerKind> {
	if (!signal) {
		return flight;
	}
	if (signal.aborted) {
		return Promise.resolve('unverified');
	}
	return new Promise<ParadisMcpCallerKind>(resolve => {
		const onAbort = () => resolve('unverified');
		signal.addEventListener('abort', onAbort, { once: true });
		flight.then(kind => {
			signal.removeEventListener('abort', onAbort);
			resolve(kind);
		});
	});
}

function isExactRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactOwnKeys(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
	const keys = Reflect.ownKeys(value);
	return required.every(key => Object.hasOwn(value, key))
		&& keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)));
}

function copySharedPageInfo(value: unknown): IParadisSharedPageInfo | undefined {
	try {
		if (!isExactRecord(value) || !hasExactOwnKeys(value, ['url', 'title'])) {
			return undefined;
		}
		const urlDescriptor = Object.getOwnPropertyDescriptor(value, 'url');
		const titleDescriptor = Object.getOwnPropertyDescriptor(value, 'title');
		if (urlDescriptor === undefined || titleDescriptor === undefined
			|| urlDescriptor.enumerable !== true || titleDescriptor.enumerable !== true
			|| !Object.hasOwn(urlDescriptor, 'value') || !Object.hasOwn(titleDescriptor, 'value')) {
			return undefined;
		}
		const url = urlDescriptor.value;
		const title = titleDescriptor.value;
		if (typeof url !== 'string' || url.length > 16 * 1024
			|| typeof title !== 'string' || title.length > 4 * 1024) {
			return undefined;
		}
		return Object.freeze({ url, title });
	} catch {
		return undefined;
	}
}

/** 確定したスペースが、共有・許可したときのスペースから変わったか（切替の途中＝pending は変わっていない扱い）。 */
function paradisScopeMovedFrom(current: IParadisBindingAuthorityManifest['panes'][number]['scope'], granted: ParadisBindingAuthorityStableScope): boolean {
	return current.kind !== 'pending'
		&& (current.kind !== granted.kind || (current.kind === 'managed' && granted.kind === 'managed' && current.stateKey !== granted.stateKey));
}

function parseRendererWindowContext(value: unknown): { readonly ctx: string; readonly windowId: number } | undefined {
	if (typeof value !== 'string' || value.length > 32) {
		return undefined;
	}
	const match = /^window:([1-9]\d*)$/.exec(value);
	if (match === null) {
		return undefined;
	}
	const windowId = Number(match[1]);
	return Number.isSafeInteger(windowId) && `window:${windowId}` === value
		? { ctx: value, windowId }
		: undefined;
}

function parseMainRendererManifest(value: unknown): IParadisMobileRendererManifest | undefined {
	try {
		if (!isExactRecord(value)
			|| !hasExactOwnKeys(value, ['revision', 'entries'])) {
			return undefined;
		}
		const revision = value.revision;
		const rawEntries = value.entries;
		if (typeof revision !== 'number'
			|| !Number.isSafeInteger(revision)
			|| revision < 0
			|| !Array.isArray(rawEntries)
			|| rawEntries.length > MAX_RENDERER_WINDOWS) {
			return undefined;
		}
		const entries: IParadisMobileRendererManifest['entries'][number][] = [];
		const windowIds = new Set<number>();
		for (const rawEntry of rawEntries) {
			if (!isExactRecord(rawEntry)
				|| !hasExactOwnKeys(rawEntry, ['windowId', 'rendererGeneration', 'windowRevision', 'claimed'], ['windowSession'])) {
				return undefined;
			}
			const windowId = rawEntry.windowId;
			const rendererGeneration = rawEntry.rendererGeneration;
			const windowRevision = rawEntry.windowRevision;
			const claimed = rawEntry.claimed;
			const hasWindowSession = Object.hasOwn(rawEntry, 'windowSession');
			const windowSession = hasWindowSession ? rawEntry.windowSession : undefined;
			if (typeof windowId !== 'number'
				|| !Number.isSafeInteger(windowId)
				|| windowId <= 0
				|| windowIds.has(windowId)
				|| typeof rendererGeneration !== 'number'
				|| !Number.isSafeInteger(rendererGeneration)
				|| rendererGeneration <= 0
				|| typeof windowRevision !== 'number'
				|| !Number.isSafeInteger(windowRevision)
				|| windowRevision < 0
				|| typeof claimed !== 'boolean') {
				return undefined;
			}
			if (hasWindowSession !== claimed
				|| (hasWindowSession && (typeof windowSession !== 'string' || windowSession.length === 0 || windowSession.length > 200))) {
				return undefined;
			}
			windowIds.add(windowId);
			entries.push(Object.freeze({
				windowId,
				rendererGeneration,
				windowRevision,
				claimed,
				...(hasWindowSession ? { windowSession: windowSession as string } : {}),
			}));
		}
		return Object.freeze({ revision, entries: Object.freeze(entries) });
	} catch {
		return undefined;
	}
}

// allow-any-unicode-next-line
/** ブラウザのページが無いペインの `set_cursor_label` を覚える持ち主の鍵の後半（Computer Use のカーソル用）。 */
const PARADIS_DESKTOP_CURSOR_VIEW = 'desktop';
/** `set_cursor_label` を最後に呼んだ持ち主を覚えるペインの数の上限（溢れたら古いものから捨てる）。 */
const MAX_PANE_CURSOR_LABEL_KEYS = 256;
const NOT_BOUND_MESSAGE = 'このターミナルペインに共有されたブラウザページはありません。自分用のタブが要るなら open_browser_tab で開けます（承認不要）。ユーザーのタブ（ログイン済みのページなど）を使いたいなら request_browser_page でユーザーに共有を頼めます。ユーザー側から共有する場合は、Para Code側でブラウザページを開き、コマンドパレットから「Para Code: Share Browser Page with Terminal Pane」を実行してこのペインに共有してください。Para Code を再起動（自動アップデートの適用を含む）すると、起動後に Para Code が同じペインと同じページの共有を戻すかユーザーに尋ね、承認されれば張り直します（ユーザーがそのスペースを開いたときに尋ねます）。戻らない場合（ページやペインを閉じた、ユーザーが共有を外した、戻さないと答えた）は、ユーザーにもう一度共有してもらってください。それでも届かない場合は、このCLIをペインで起動し直してから再共有してください。';

/**
 * para固有の静的ツール定義。以前はこのファイルと `paradisBrowserMcpShim.ts`
 * （Para Code未起動時／ペイン外起動時にオフライン応答するstdioシム）の両方に手で複製しており、
 * 更新漏れが繰り返し起きたため、vs/* に依存しない `paradisBrowserMcpShimCore.ts` 側の
 * `PARADIS_MCP_LOCAL_TOOLS` へ一本化した。ここへツールを足す/消す/変えるときは、あちらの配列を
 * 直接編集すること（このファイルからも同じ配列を参照しているだけなので、複製先を追いかける
 * 必要はない）。`test/node/paradisMcpToolsSync.test.ts` が単一ソースであることを検査する。
 */
export const TOOLS = PARADIS_MCP_LOCAL_TOOLS;

/** エージェントのタブ操作と共有の要求のツール名（paradisAgentBrowserTabs.ts の契約で renderer へ委ねる）。 */
const PARADIS_AGENT_TAB_TOOL_NAMES: ReadonlySet<string> = new Set(['open_browser_tab', 'list_browser_tabs', 'select_browser_tab', 'close_browser_tab', 'request_browser_page']);

/**
 * ページを操作する Para のツール（`tab_id` で対象のタブを選べるもの）。内蔵 chrome-devtools-mcp のツールは、
 * これとは別にすべて `tab_id` を受ける。
 */
const PARADIS_TAB_SCOPED_TOOL_NAMES: ReadonlySet<string> = new Set([
	...PARADIS_PAGE_OPS_TOOL_NAME_SET,
	...PARADIS_BROWSER_QUERY_TOOL_NAME_SET,
	...PARADIS_BROWSER_ACT_TOOL_NAME_SET,
	'capture_screenshot',
	'run_steps',
	'get_shared_page',
	'upload_file_to_drop_zone',
	'get_cdp_endpoint',
	'set_cursor_label',
]);

/**
 * タブを選べる Para のツールのうち、同じタブの列（paradisToolCallLanes.ts）に並べないもの。ページに触れず
 * すぐ返るもの（名札・接続先・共有中のページの情報）と、手順ごとに列へ並ぶ run_steps。
 */
const PARADIS_TOOL_CALL_LANE_EXEMPT_NAMES: ReadonlySet<string> = new Set(['run_steps', 'set_cursor_label', 'get_cdp_endpoint', 'get_shared_page']);

/** ヒントを添えるときに控えるペインのスペースの期限（ミリ秒）。 */
const PARADIS_SITE_NOTE_SPACE_CACHE_MS = 60_000;
/** ヒントを添えるために窓のタブの一覧を待つ上限（ミリ秒）。 */
const PARADIS_SITE_HINT_TABS_TIMEOUT_MS = 1000;

/** run_recipe が止まったときに添える、ページのスナップショットの頭の長さ。 */
const PARADIS_SITE_RECIPE_SNAPSHOT_CHARS = 6000;

/** サイトメモ（E4）と手順の名前（E3）を、そのサイトを初めて使った結果に添える道具。ページを開く・読む・操作する入口のもの。 */
const PARADIS_SITE_NOTE_HINT_TOOLS: ReadonlySet<string> = new Set([
	'open_browser_tab', 'select_browser_tab', 'navigate_page', 'take_snapshot', 'take_screenshot', 'get_text', 'click_by', 'fill_by', 'click', 'fill', 'wait_until', 'evaluate_script', 'run_steps',
]);

/** エージェントによるプロファイルの一覧・作成・切替・削除のツール名（paradisBrowserProfileMcp.ts の契約）。 */
const PARADIS_AGENT_PROFILE_TOOL_NAMES: ReadonlySet<string> = new Set(['list_browser_profiles', 'create_browser_profile', 'switch_browser_profile', 'delete_browser_profile']);

/**
 * 呼び出し元のプロセスを確かめてから動かすツール（利用者に承認を求めるもの、ページやプロファイルを開く・
 * 切り替える・消すもの）。一覧だけのツールは含めない。
 */
const PARADIS_CALLER_VERIFIED_TOOL_NAMES: ReadonlySet<string> = new Set([
	'open_browser_profile', 'create_browser_profile', 'switch_browser_profile', 'delete_browser_profile',
	'open_browser_tab', 'select_browser_tab', 'close_browser_tab', 'request_browser_page',
]);

/** 追加のブラウザ操作（B7）で接続元を確かめられなかったときの文。 */
const CALLER_UNVERIFIED_PAGE_OPS_MESSAGE = 'Para Code could not confirm that this request comes from a process inside a Para Code terminal pane (or from Para Code\'s SSH port forwarding), so it does not send mouse input, change headers, credentials or request rules, save files or draw on the shared page for it. Start this agent CLI from a terminal inside Para Code.';

const CALLER_UNVERIFIED_BROWSER_MESSAGE = 'Para Code could not confirm that this request comes from a process inside a Para Code terminal pane (or from Para Code\'s SSH port forwarding), so it does not open, switch or delete browser pages or profiles for it. Start this agent CLI from a terminal inside Para Code.';

/** para-browser側の静的ツール名（chrome-devtools-mcp側で同名ツールが現れた場合に隠すための予約集合）。 */
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map(tool => tool.name));

/**
 * CDPゲートウェイのブラウザレベルWSエンドポイントのパスセグメント。ゲートウェイはこのIDを
 * 検証しない（トークンは `?pane=` クエリで解決される）ため、内蔵プロキシ用の固定値でよい。
 */
const EMBEDDED_DEVTOOLS_WS_ID = 'paradis-embedded';

/**
 * get_cdp_endpoint 応答に添える、CDPゲートウェイの制約ガイダンス（LLM向け・英語）。
 * chrome-devtools-mcp のツールが「なぜ失敗するか」を接続前に伝えるためのもの。
 */
const CDP_LIMITATIONS_NOTE = 'One gateway connection exposes exactly one page: httpBase shows the page shared with this terminal pane, and tabWebSocketDebuggerUrl (present when a tab is resolved) shows only that tab. new_page (Target.createTarget) and close_page (Target.closeTarget) are not supported - use the open_browser_tab / close_browser_tab tools of this server and the tab_id argument of the browser tools instead (you can only close tabs you opened). list_pages / select_page only ever see one page; list_browser_tabs shows the tabs you can use. resize_page is not supported because the embedded browser is laid out by the workbench - use the emulate tool (viewport emulation) instead. Clearing cookies/storage/cache over CDP is blocked because the browser partition is shared across Para Code.';

/** DevTools proxyのtoken別generationと、最終retireを待つactive operationを調停する。 */
export class ParadisDevtoolsGenerationCoordinator {

	private readonly _generations = new Map<string, number>();
	private readonly _activeLeases = new Map<string, number>();
	private readonly _pendingForgetGenerations = new Map<string, number>();
	private _disposed = false;

	constructor(private readonly forgetToken: (token: string) => void) { }

	setGeneration(token: string, generation: number, cancelPendingForget: boolean = false): void {
		if (this._disposed) {
			return;
		}
		this._generations.set(token, generation);
		if (cancelPendingForget) {
			this._pendingForgetGenerations.delete(token);
		} else if (this._pendingForgetGenerations.has(token)) {
			this._pendingForgetGenerations.set(token, generation);
		}
	}

	getGeneration(token: string): number | undefined {
		return this._disposed ? undefined : this._generations.get(token);
	}

	isCurrentGeneration(token: string, generation: number): boolean {
		return !this._disposed && (this._generations.get(token) ?? 0) === generation;
	}

	async runWithLease<T>(token: string, operation: () => Promise<T>): Promise<T> {
		if (this._disposed) {
			throw new Error('DevTools generation coordinator is disposed');
		}
		this._activeLeases.set(token, (this._activeLeases.get(token) ?? 0) + 1);
		try {
			return await operation();
		} finally {
			if (!this._disposed) {
				const remaining = (this._activeLeases.get(token) ?? 1) - 1;
				if (remaining > 0) {
					this._activeLeases.set(token, remaining);
				} else {
					this._activeLeases.delete(token);
					const pendingGeneration = this._pendingForgetGenerations.get(token);
					if (pendingGeneration !== undefined) {
						this._pendingForgetGenerations.delete(token);
						this._finalizeForget(token, pendingGeneration);
					}
				}
			}
		}
	}

	forgetWhenIdle(token: string, generation: number): void {
		if (this._disposed || !this.isCurrentGeneration(token, generation)) {
			return;
		}
		if ((this._activeLeases.get(token) ?? 0) > 0) {
			this._pendingForgetGenerations.set(token, generation);
		} else {
			this._finalizeForget(token, generation);
		}
	}

	private _finalizeForget(token: string, generation: number): void {
		if (this._disposed || !this.isCurrentGeneration(token, generation)) {
			return;
		}
		this._pendingForgetGenerations.delete(token);
		this._activeLeases.delete(token);
		this._generations.delete(token);
		this.forgetToken(token);
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._generations.clear();
		this._activeLeases.clear();
		this._pendingForgetGenerations.clear();
	}
}

/**
	 * バインディングレジストリ + MCP HTTPサーバー + CDPゲートウェイ。
	 * `127.0.0.1` の固定既定ポート（{@link PARADIS_MCP_DEFAULT_PORT}、専有時のみ動的フォールバック）で
	 * listenし、`<userDataDir>/paradis-browser-mcp.json` にprotocolVersion、port、pid、
	 * instanceId、serviceStartedAtを持つowner recordを原子的に書き出す。
	 * recordはdispose時に削除せず、shimがPID生存確認でstale recordを無効化する。
 */
export class ParadisAgentBrowserService extends Disposable {

	private readonly _bindings = new Map<string, IBindingEntry>();
	/**
	 * エージェントが自分で開いたタブへの許可（token → viewId → entry）。共有（{@link _bindings}）を付け替えずに、
	 * そのペインから tab_id で使えるようにする。1 ペイン最大 {@link PARADIS_AGENT_TAB_LIMIT} 件。
	 */
	private readonly _agentTabGrants = new Map<string, Map<string, IBindingEntry>>();
	/** tab_id を省いたときに使うタブ（open_browser_tab・select_browser_tab が動かす）。無ければ共有のページ。 */
	private readonly _selectedTabs = new Map<string, string>();
	/**
	 * ツールやゲートウェイが使ったタブのスコープ（token → viewId → そのとき裏にあった entry の世代）。共有の付け替えや
	 * 許可の増減のたびに今の解決と比べ、変わったスコープの子プロセスと接続だけを切る（{@link _reconcileTabScopes}）。
	 */
	private readonly _tabScopes = new Map<string, Map<string, number>>();
	/** ゲートウェイ向けにスコープキーで発行した lease → ペインの lease。 */
	private readonly _gatewayScopedLeases = new WeakMap<IParadisAgentBrowserIngressLease, IParadisAgentBrowserIngressLease>();
	// 入力が詰まったときの一時停止と再開をログと Sentry に残す（停止が解けないとそのページのマウスとキーが全部断られるため）
	/** 同じタブへのツール呼び出しを 1 本ずつ流す列（鍵はタブのスコープキー）。 */
	private readonly _toolCallLanes = new ParadisToolCallLanes();
	private readonly _cdpInputQueue = this._register(new ParadisCdpInputQueue({ onDiagnostic: (event, queueKey) => this._onCdpInputQueueDiagnostic(event, queueKey) }));
	/** ゲートウェイが断った入力の理由（ペインごとに直近 1 件）。click などの「not interactive」に書き足す。 */
	private readonly _inputRejections = new ParadisInputRejectionLog();
	/** 捨てた hook のペイン・理由ごとの累計（診断ログの間引き用。判定には使わない）。 */
	private readonly _hookDrops = new ParadisAgentHookDropCounter();
	private readonly _quarantinedBindings = new Set<IBindingEntry>();
	/**
	 * リタイア不整合で隔離した個別ペイントークン。authority全体を殺す({@link _authorityFaulted})代わりに、
	 * 該当tokenだけを以後バインド不可・ingress不可にして他ペインの共有は生かす。ウィンドウのクローズ/リロード/
	 * スペース切替1回で全ペインが恒久停止するのを避けるための token 単位の隔離。解除は2経路のみで、無条件解除はしない:
	 * (1) {@link notifyTerminalExit}（そのペインのシェルが死んだ＝隔離を続ける理由が消える）、
	 * (2) {@link syncBindingAuthority} で同tokenが**別のシェルPID**を持つ新しいペインとして正当に入り直した時
	 * （＝新しい binding lifecycle。ウィンドウclose後の再オープンで隔離tokenを救う唯一の経路）。
	 */
	private readonly _faultedTokens = new Set<string>();
	/**
	 * 隔離した各tokenの回収メタデータ。{@link _quarantinedBindings} に退避したbinding実体（あれば）と、
	 * 隔離時点のシェルPID（新しいlifecycle判定に使う）を保持する。隔離解除時にこの記録を辿って
	 * {@link _quarantinedBindings} の容量占有を回収する（同一シェルの再syncでは解除しないための世代印でもある）。
	 */
	private readonly _quarantinedTokenState = new Map<string, { readonly binding: IBindingEntry | undefined; readonly shellPid: number | undefined }>();
	private readonly _backgroundThrottlingCoordinator = new ParadisExactViewBackgroundThrottlingCoordinator();
	private _backgroundThrottlingDispatcher: ParadisExactViewBackgroundThrottlingDispatcher | undefined;
	private readonly _bindingAuthority = new ParadisBindingAuthority<string, object, IPreparedBindingDescriptor, IBindingEntry>({
		now: Date.now,
		createTicketId: randomUUID,
		copyDescriptor: descriptor => {
			const exactView = paradisParseExactBrowserViewDescriptor(descriptor.exactView);
			const pageInfo = copySharedPageInfo(descriptor.pageInfo);
			if (exactView === undefined || pageInfo === undefined) {
				throw new Error('Invalid prepared BrowserView binding');
			}
			return Object.freeze({ exactView, pageInfo });
		},
	});
	private _pendingBindPreparations = 0;
	private _authorityFaulted = false;
	/**
	 * PARA-PATCH: このMCPサーバーへツールを足した他のcontrib（モバイル端末操作など）。
	 * サーバーを機能ごとに増やさずに済ませるための相乗り口で、認証とペイン解決は
	 * ここまでで完了しているためプロバイダは解決済みトークンだけを受け取る。
	 */
	private readonly _toolProviders: IParadisMcpToolProvider[] = [];
	private readonly _ingressLeaseStates = new WeakMap<IParadisAgentBrowserIngressLease, IParadisBindingOwnedTokenLease>();
	private _nextBindingGeneration = 0;
	/** workbenchから同期される「ペイントークン ⇔ シェルPID」表（CDPゲートウェイの呼び出し元識別用）。 */
	private readonly _paneShells = new Map<string, IPaneShellEntry>();
	/**
	 * 接続先（SSH・WSL・コンテナ）のペインのトークン → 接続先。`_paneShells` はシェルの PID が分かるペインしか
	 * 持たない（SSH のウィンドウの再読み込みでターミナルが付き直す前など、PID の無い manifest が来る）ので、
	 * 接続先であることだけは PID と関係なく覚えておく。一度接続先と分かったトークンは、トークンが片付くまで
	 * 手元へは戻さない（手元のファイルに触れる操作を断る側へ倒すため）。
	 */
	private readonly _paneRemoteAuthorities = new Map<string, string>();
	/**
	 * 接続先のペインのトークン → そのペインを持つウィンドウ（ctx）。シェルの PID の無い manifest のペインは
	 * `_paneShells` に載らないため、preview_file やファイルの受け渡しでウィンドウを引けるよう別に覚える。
	 */
	private readonly _remotePaneWindows = new Map<string, string>();
	/** 接続先のペインのエージェントとのファイルの受け渡し（スクリーンショットの保存先・upload_file など）。 */
	private readonly _remoteFileTransfer = new ParadisRemoteFileTransfer(() => this._devtoolsProxy.ensureTemporaryDirectory());
	/**
	 * MCPリクエスト（またはCDPゲートウェイのPID識別）で実際に接続実績のあったペイントークンの集合。
	 * バインディングダイアログの「MCP未接続」表示に使う（shared processの生存期間のみ保持）。
	 */
	private readonly _seenTokens = new Set<string>();
	/**
	 * エージェントCLIのhook通知 (GET /agent-hook) で更新される、ペインごとの実行状態。
	 * renderer-local producerがlistAgentStatusSnapshotでatomic取得し、Workspaces表示と通知へ配る。
	 */
	private readonly _paneStatuses = new Map<string, IParadisPaneStatusEntry>();
	/**
	 * ペインごとの、利用者が始めた最後のターンの開始時刻（UserPromptSubmit のうちバックグラウンドの完了の知らせ
	 * `<task-notification>` で起きたものを除く。Codex は transcript のターン開始）。完了の通知を 1 ターン 1 回にする鍵。
	 */
	private readonly _userTurnStarts = new Map<string, number>();
	/** ペインごとに、完了の通知を出したターンと、そのときバックグラウンドタスクが残っていなかった（確かな完了）か。 */
	private readonly _announcedReviews = new Map<string, IParadisAnnouncedReview>();
	/** transcript/app-server由来の承認待ちを一度観測したtoken。解除時だけpermissionをworkingへ戻す。 */
	private readonly _activityApprovalTokens = new Set<string>();
	/**
	 * 完了ではなく、止まって利用者の次の指示を待っているために状態を消した（idle にした）token
	 * （許可の拒否。`_settlePaneAwaitingUser`）。次に状態が付くまでスナップショットで知らせ、画面側が
	 * 状態の消滅を完了（タブの緑の点）と数えないようにする。
	 */
	private readonly _awaitingUserTokens = new Set<string>();
	/** hook の控え（W2-20）の置き場。ポートファイルと同じフォルダの下。 */
	private readonly _hookSpoolDir: string;
	/** 起動時の控えの掃除。流し直しはこれが済んでから読む（読みかけのファイルを消させない）。 */
	private _hookSpoolPruned: Promise<unknown> = Promise.resolve();
	/** 控えを読みに行ったペイン（1 つのペインにつき 1 度だけ読む）。 */
	private readonly _hookSpoolCheckedTokens = new Set<string>();
	/** これより前（前の Para Code が最後に生きていた時刻）の控えは流さない（W2-20 レビュー M5）。 */
	private _hookSpoolReplayAfter = 0;
	/** この起動で届いた hook の ID（控えとの重複を除く。新しいものから一定数だけ持つ）。 */
	private readonly _recentHookIds = new Set<string>();
	/**
	 * 知らないトークンの hook に「まだ同期していない」（503）と答える期間の起点。起動した時刻と、
	 * ウィンドウがつながった時刻（W2-20 レビュー M3）。
	 */
	private _hookSyncGraceSince = Date.now();
	/**
	 * 控えから流し直した許可要求・質問のうち、ウィンドウ側で画面を確かめてもらう前のもの（W2-20）。
	 * 確かめられるまで状態にも承認カードにもしない。本物の hook が来たら捨てる。
	 */
	private readonly _replayedPrompts = new Map<string, { readonly status: 'permission' | 'question'; readonly record: IParadisSpooledAgentHook }>();
	/**
	 * 一度でもエージェントhook (POST /agent-hook) を発火したペイントークンの集合。
	 * 「そのターミナルでエージェントCLIが動いた実績」の判定に使う（プレーンなターミナルと
	 * エージェントペインの区別。モバイルのホーム一覧・Live Activity のフィルタ用）。
	 * idle（Stop確認済み・SessionEnd後）でも消さない: エージェントは次のターンで再開し得る。
	 * ペイン消滅（TerminalExit）でのみ削除する。
	 */
	private readonly _agentHookTokens = new Set<string>();
	/**
	 * 本物の hook が届いたペイン（transcript から推した開始は含めない）。IDE 操作ツールが「状態を
	 * hook で確かめられる相手か」を見るのに使う。`_agentHookTokens` は transcript 由来の開始でも立つので、
	 * hook を信頼していない Codex でも真になってしまう。
	 */
	private readonly _hookReportedTokens = new Set<string>();
	/**
	 * hook の届いていないペインのうち、Claude Code が OSC 7501 で状態を知らせてきているもの（notePaneProgramStatus）。
	 * ここに載っている間は、OSC が状態の出どころ。transcript から読んだターンの始まり・終わりは、届くのが遅れて
	 * 状態を巻き戻し、完了を二度数えるので反映しない。clear（CLI の終了）・hook の到着・ペインの終了で外れる。
	 */
	private readonly _programStatusTokens = new Set<string>();
	/** OSC 7501 の状態を受けた時刻（ペインごとの直近 1 秒分）。速すぎる書き換えを断る。 */
	private readonly _programStatusTimes = new Map<string, number[]>();
	/**
	 * 許可待ち・質問中が hook ではなく transcript から解かれ、その後に確かめた hook がまだ来ていないペイン。
	 * transcript は同じユーザーの別プロセスが追記できるので、これで解かれた状態を IDE 操作ツールは
	 * 信用しない（Enter を送らない）。確かめた hook が来たら外す。
	 */
	private readonly _unconfirmedReleaseTokens = new Set<string>();
	/** 印が付いたまま、hook の接続元を確かめられなかったペイン（tmux・WSL など）。IDE 操作ツールの Enter は利用者に任せる。 */
	private readonly _unconfirmableTokens = new Set<string>();
	/** 接続（keep-alive）ごとの、接続元プロセスの分類の結果。接続が消えれば一緒に消える。 */
	private readonly _callerClassifications = new WeakMap<Socket, Map<string, { readonly kind: ParadisMcpCallerKind; readonly key: string }>>();
	/** 同じ接続・トークン・照合の鍵で走っている照合（同時に来た道具の呼び出しが lsof / ps を重ねて起こさないように）。 */
	private readonly _callerClassificationsInFlight = new WeakMap<Socket, Map<string, Promise<ParadisMcpCallerKind>>>();
	/**
	 * ペインで動いている会話（hook の session_id）。再起動後に復元したタブから前の会話を続ける
	 * ために renderer へ渡す。SessionEnd（会話を終えた）と TerminalExit（ペインが消えた）で消す。
	 */
	private readonly _paneSessions = new Map<string, Omit<IParadisAgentPaneSession, 'token'>>();
	/**
	 * hook発信元プロセスの所有権レジストリ（ネストした子エージェントのhookによるペイン
	 * セッション乗っ取り・状態汚染の防止）。詳細は paradisAgentHookOwnership.ts 参照。
	 */
	private readonly _hookOwnership = new ParadisAgentHookOwnership();
	/** TerminalExit後、owner retirementまでHTTP/hook ingressを抑止するowner-bounded tombstone。 */
	private readonly _terminalExitedTokens = new Set<string>();
	/** {@link IParadisSharedPageBindings.onDidAcknowledgePane} の実体。モバイルリレーが購読する。 */
	private readonly _onDidAcknowledgePane = this._register(new Emitter<string>());
	readonly onDidAcknowledgePane = this._onDidAcknowledgePane.event;
	private readonly _portFilePath: string;
	private readonly _mcpInstanceId = randomUUID();
	private readonly _mcpServiceStartedAt = Date.now();
	private readonly _cdpGateway: ParadisCdpGateway;
	/** vendored chrome-devtools-mcp をペイン毎の子プロセスとして管理するプロキシ。 */
	private readonly _devtoolsProxy: ParadisDevtoolsMcpProxy;
	/** ファイルに落としたスクリーンショットを、別の機械から取りに来るための台帳。 */
	private readonly _screenshotHandoff = new ParadisScreenshotHandoff(() => randomUUID());
	/** upload_file_to_drop_zone がbase64本文を一時ファイルへ書き出すためのステージング領域。 */
	private readonly _fileDropStaging = new ParadisFileDropStaging();
	/** 追加のブラウザ操作（マウス・PDF・ヘッダ・HTTP 認証・リクエストのルール・ダウンロード・ハイライト）。 */
	private readonly _pageOps: ParadisBrowserPageOps;
	/** カーソルの演出のために入力の配送を待ってよいか（ツールの呼び出しごと。paradisCursorPacing.ts）。 */
	private readonly _cursorPacing = new ParadisCursorPacingLedger();
	/** 名札に長く続く状態（スクリプト実行中・待機中）を出している道具の数（タブのスコープキーごと）。 */
	private readonly _cursorStatusRuns = new Map<string, number>();
	/** カーソルの持ち主ごとの名前と色（paradisCursorOwners.ts）。 */
	private readonly _cursorOwners = new ParadisCursorOwners();
	/** ペインごとに、`set_cursor_label` で最後に名前を決めた持ち主の鍵（Computer Use のカーソルが同じ名前を使う）。 */
	private readonly _paneCursorLabelKeys = new Map<string, string>();
	/** 素通しの WebP の撮影でカーソルを隠したビュー（ゲートウェイのキーごと、撮り始めた順）。 */
	private readonly _rawCaptureViews = new Map<string, IParadisExactBrowserViewDescriptor[]>();
	/** 読む・待つツール（wait_until・get_text・inspect_element・scroll_to）。evaluate_script を短く何度も呼ぶ。 */
	private readonly _browserQuery = new ParadisBrowserQuery();
	/** 探して操作するツール（click_by・fill_by）。探すのは evaluate_script、押す・入れるのは入力の通り道。 */
	private readonly _browserActBy = new ParadisBrowserActBy();
	/** 切り抜き・複数の撮影とエージェント側への保存（capture_screenshot）。 */
	private readonly _browserCapture = new ParadisBrowserCapture();
	/** ダウンロードしたファイルの中身（read_download）。読めるのはダウンロードの保存先の中だけ。 */
	private readonly _downloadReader = new ParadisBrowserDownloadReader({
		downloadsDirectory: async () => {
			const directory = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL).call<string | null>('getAgentDownloadsDirectory').catch(() => null);
			return typeof directory === 'string' && directory.length > 0 ? directory : undefined;
		},
	});
	/** エージェントのネットワークの制限（redirect のルールの行き先を確かめる）。設定が無いテストでは undefined。 */
	private readonly _agentNetworkFilter: AgentNetworkFilterService | undefined;
	private readonly _devtoolsGenerationCoordinator: ParadisDevtoolsGenerationCoordinator;
	private readonly _mcpSetupController: ParadisMcpSetupController;
	/** 現renderer IPC connection。ctxだけではreload前後を区別できないためobject identityをauthorityにする。 */
	private readonly _rendererConnections = new Map<string, object>();
	private readonly _rendererConnectionContexts = new Map<object, string>();
	private readonly _knownRendererContexts = new Set<string>();
	private _mainLiveWindowIds = new Set<number>();
	private _hasMainRendererManifest = false;
	private _rendererManifestRevision = -1;
	private _httpServer: http.Server | undefined;
	private _port: number | undefined;
	/** SSH 接続先から手元のゲートウェイへ戻る経路（接続先ごとに1本）。コンストラクタで作る。 */
	private readonly _remoteTunnels: ParadisRemoteAgentTunnels;
	private _portFileReconciler: ParadisMcpPortFileReconciler | undefined;
	private readonly _serverStartPromise: Promise<void>;
	private _serverDisposed = false;
	private readonly _activeRequestControllers = new Set<AbortController>();
	private readonly _activeIngressRequestsByToken = new Map<string, number>();
	private _activeIngressRequestCount = 0;
	/**
	 * hook の受付は MCP と別枠で数える。MCP の待機ツール（最大 240 秒）が枠を占めても、
	 * 許可待ち・完了の hook が拒否されないようにするため。
	 */
	private readonly _activeHookRequestsByToken = new Map<string, number>();
	private _activeHookRequestCount = 0;
	/**
	 * Claude Code の mod（`/claude-mod/v1/`）の受付も別枠で数える。mod は会話ごとにコマンドの長いポーリングを
	 * 1 本張り、質問・承認の待ちでも長いポーリングを持つので、MCP や hook の枠を食わないようにする。
	 */
	private readonly _activeModRequestsByToken = new Map<string, number>();
	private _activeModRequestCount = 0;
	private _activeMobileVoiceRequestCount = 0;
	private _activeMobileVoiceBytes = 0;
	// lease未設定のticketは拡張機能ホスト由来（ペインを持たない）。音声取込だけに使える。
	private readonly _mobileVoiceTickets = new Map<string, { readonly lease: IParadisAgentBrowserIngressLease | undefined; readonly expiresAt: number; readonly localPlayback: boolean }>();
	/** SSH の接続先から届いた読み上げを手元で鳴らす口（Q190〜Q193）。 */
	private readonly _localVoicePlayer: ParadisLocalVoicePlayer;
	private readonly _remoteVoiceLocalPlaybackEnabled: () => boolean;
	/** 操作の後に待って変化を添えるか（E1）・ブラウザの状態を添えるか（I1）。設定（既定は無効）を毎回読む。設定の無いテストでは undefined。 */
	private readonly _observeSettings: (() => IParadisObserveOptions) | undefined;
	/** サイトメモ（E4）を使うか。設定（既定は無効）を毎回読む。設定の無いテストでは undefined。 */
	private readonly _siteNotesEnabled: (() => boolean) | undefined;
	/** サイトメモの置き場（paradisBrowserSiteNotes.ts）。 */
	private readonly _siteNotes = new ParadisSiteNotesStore(paradisSiteNotesDefaultPath());
	/** ペインごとに、メモを添え終えた「スペース\nオリジン」（同じペインへは 1 回だけ添える）。 */
	private readonly _siteNotesShown = new Map<string, Set<string>>();
	/** サイトの手順（E3）を使うか。設定（既定は無効）を毎回読む。設定の無いテストでは undefined。 */
	private readonly _siteRecipesEnabled: (() => boolean) | undefined;
	/** サイトの手順の置き場（paradisBrowserSiteRecipes.ts）。 */
	private readonly _siteRecipes = new ParadisSiteRecipesStore(paradisSiteRecipesDefaultPath());
	/**
	 * ペインごとのスペース（サイトメモの鍵）。窓に聞くと最大 4 秒かかるので、ヒントを添える側だけで
	 * {@link PARADIS_SITE_NOTE_SPACE_CACHE_MS} の間控える。initialize とペインの片付けで消す。書く・消す道具は毎回窓に聞く
	 * （ペインの所属の選び直しやフォルダの開き直しの後に、古いスペースへ書かないように）。
	 */
	private readonly _siteNoteSpaces = new Map<string, { readonly space: Promise<{ readonly key: string; readonly folder?: string } | undefined>; readonly at: number }>();
	/** run_steps を手順書にするか（E6）。設定（既定は無効）を毎回読む。設定の無いテストでは undefined。 */
	private readonly _runStepsFlowEnabled: (() => boolean) | undefined;
	/** 操作の結果に添える、操作の後のページとブラウザの状態（paradisBrowserObserve.ts）。 */
	private readonly _browserObserver = new ParadisBrowserObserver();
	/**
	 * ターミナルのペインを持たない拡張機能ホスト（およびそこから起動されるCodex等）が、
	 * 音声取込の宛先を認証するためのインスタンススコープのトークン。
	 * ペインの所有権もバインディング操作も一切与えず、音声ticketの発行にだけ使える。
	 */
	private readonly _voiceIngressToken = `${randomUUID()}-${randomUUID()}`;

	constructor(
		private readonly _userDataPath: string,
		// ウィンドウ毎のPlaywrightServiceへの橋渡し。read_page廃止（chrome-devtools側の
		// take_snapshot に一本化）以降は未使用だが、sharedProcessMain側の配線を安定させるため維持。
		_playwrightInvoker: IParadisPlaywrightInvoker,
		private readonly ipcServer: IPCServer<string>,
		private readonly mainProcessService: IMainProcessService,
		private readonly logService: ILogService,
		configurationService?: IConfigurationService,
		args?: NativeParsedArgs,
		private readonly publishMobileVoiceClip?: (audio: Uint8Array) => void,
		/** 手元の aivis-mcp の `--ingest` と afplay で鳴らす口（通知の読み上げと同じ列）。 */
		private readonly localVoiceOutput?: IParadisLocalVoiceOutput & { readonly shellEnv?: ParadisCachedShellEnv },
	) {
		super();
		this._portFilePath = join(this._userDataPath, PARADIS_MCP_PORT_FILE_NAME);
		this._hookSpoolDir = join(this._userDataPath, PARADIS_AGENT_HOOK_SPOOL_DIR_NAME);
		this._hookSpoolPruned = paradisPruneAgentHookSpool(this._hookSpoolDir)
			.then(() => paradisStampAgentHookSpoolAlive(this._hookSpoolDir))
			.then(previous => { this._hookSpoolReplayAfter = previous ?? 0; })
			.catch(() => undefined);
		// 「生きている」を 15 秒ごとに書き足す。次の起動は、これより後の控えだけを流す。閉じるときにも
		// 書こうとするが、shared process の終了では dispose が呼ばれないことがあるので当てにしない。
		const hookSpoolDir = this._hookSpoolDir;
		const aliveTimer = setInterval(() => void paradisStampAgentHookSpoolAlive(hookSpoolDir), PARADIS_AGENT_HOOK_SPOOL_ALIVE_INTERVAL_MS);
		this._register(toDisposable(() => {
			clearInterval(aliveTimer);
			try {
				writeFileSync(join(hookSpoolDir, PARADIS_AGENT_HOOK_SPOOL_ALIVE_FILE), String(Date.now()), { mode: 0o600 });
			} catch {
				// フォルダが無い・書けない。次の起動は 1 時間以内の分だけを流す。
			}
		}));
		this._cdpGateway = this._register(new ParadisCdpGateway(
			{
				// `token` はゲートウェイの台帳のキー（ペインのトークン、または `&tab=` 付きの接続ならスコープキー）
				captureIngressLease: key => this._captureGatewayLease(key),
				isIngressLeaseCurrent: lease => this._isGatewayLeaseCurrent(lease),
				getBoundTargetId: key => this.captureIngressLease(paradisPaneTokenOfScopeKey(key)) === undefined ? undefined : this._bindingForKey(key)?.exactView.targetId,
				ensureBoundTargetId: token => this._ensureBoundTargetId(token),
				getTokenForShellPid: pid => this._getTokenForShellPid(pid),
				captureBoundPageScreenshot: (token, options) => this._captureBoundPageScreenshot(token, options),
				isBoundPageVisible: token => this._isBoundPageVisible(token),
				beginRawCapture: token => this._beginRawCapture(token),
				endRawCapture: (token, captured) => this._endRawCapture(token, captured),
				dispatchBoundPageInput: (token, connection, expectedTargetId, method, paramsJson, isConnectionCurrent) =>
					this._dispatchBoundPageInput(token, connection, expectedTargetId, method, paramsJson, isConnectionCurrent),
				closeInputConnection: connection => this._cdpInputQueue.closeConnection(connection),
				noteInputRejection: (token, message) => this._inputRejections.record(token, message),
				noteAgentCdpConnections: (token, connections) => this._noteBrowserDiagnostic(token, { kind: 'agent-state', connections }),
				noteFocusEmulation: (token, enabled) => this._noteBrowserDiagnostic(token, { kind: 'agent-state', focusEmulation: enabled }),
				isRemotePane: key => this._isRemotePaneForGateway(paradisPaneTokenOfScopeKey(key)),
				isTunnelPeer: (remotePort, localPort) => this._isTunnelPeer(remotePort, localPort),
			},
			// 冷スタート（起動時点で `DevToolsActivePort` が他インスタンスに上書きされていた）でも
			// 上流へ辿り着けるよう、electron-main が確定させたポートを候補に加える。
			new ParadisCdpUpstream(this._userDataPath, logService, {
				resolveMainPort: async () => await mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
					.call<number | null>('resolveUpstreamPort') ?? undefined,
			}),
			logService,
		));
		this._devtoolsProxy = this._register(new ParadisDevtoolsMcpProxy(RESERVED_TOOL_NAMES, logService, {
			resolveRoots: key => this._resolveDevtoolsRoots(paradisPaneTokenOfScopeKey(key)),
			recentInputRejection: (token, since) => this._inputRejections.recent(token, since),
			onToolFailure: (token, failure) => this._noteBrowserDiagnostic(token, { kind: 'tool-failure', ...failure }),
		}));
		this._agentNetworkFilter = configurationService ? this._register(new AgentNetworkFilterService(configurationService)) : undefined;
		this._pageOps = new ParadisBrowserPageOps({
			// ingress が止まっているペイン（終了済み・隔離中）には共有が無いものとして扱う
			binding: key => this.captureIngressLease(paradisPaneTokenOfScopeKey(key)) === undefined ? undefined : this._bindingForKey(key),
			notBoundMessage: NOT_BOUND_MESSAGE,
			callMain: <T>(method: string, args: unknown[]) => this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL).call<T>(method, args),
			dispatchInput: (token, binding, method, paramsJson) => this._dispatchBoundPageInput(token, {}, binding.exactView.targetId, method, paramsJson, () => true).response,
			networkFilter: () => {
				const filter = this._agentNetworkFilter;
				return filter?.isEnabled() ? {
					isUriAllowed: (url: string) => {
						try {
							return filter.isUriAllowed(URI.parse(url));
						} catch {
							return false;
						}
					},
				} : undefined;
			},
		});
		// エージェントCLI (Claude Code / Codex) の通知hookを冪等に自動設置する
		// (Superset の setupAgentHooks 相当。失敗しても起動は妨げない)。
		// ログインシェルの解決は通知（aivis-mcp --ingest）と 1 本を共有する
		const cachedShellEnv = localVoiceOutput?.shellEnv ?? new ParadisCachedShellEnv(
			logService,
			'ParadisAgentHooks',
			createParadisShellEnvResolver(logService, configurationService, args),
			Date.now,
			reportParadisShellEnvDiagnosticError,
		);
		// ssh はログインシェル由来の環境で起こす: `SSH_AUTH_SOCK` を rc で設定する鍵エージェント
		// 構成（1Password / gpg-agent 等）だと、shared process が継いだ環境のままでは公開鍵認証が
		// 黙って失敗し、拡張機能側の接続だけ成功して戻り経路が張れない状態になる
		this._remoteTunnels = this._register(new ParadisRemoteAgentTunnels(logService, undefined, () => cachedShellEnv.getEnv()));
		// 手元の aivis-mcp もログインシェルの PATH（npm・bun のグローバル）で探す
		this._localVoicePlayer = new ParadisLocalVoicePlayer(() => cachedShellEnv.getEnv());
		this._remoteVoiceLocalPlaybackEnabled = () => paradisRemoteVoiceLocalPlaybackEnabled(configurationService?.getValue(PARADIS_REMOTE_VOICE_LOCAL_PLAYBACK_SETTING));
		this._observeSettings = () => ({
			settle: configurationService?.getValue(PARADIS_BROWSER_SETTLE_AFTER_ACTION_SETTING) === true,
			state: configurationService?.getValue(PARADIS_BROWSER_REPORT_STATE_SETTING) === true,
		});
		this._siteNotesEnabled = () => configurationService?.getValue(PARADIS_BROWSER_SITE_NOTES_SETTING) === true;
		this._siteRecipesEnabled = () => configurationService?.getValue(PARADIS_BROWSER_SITE_RECIPES_SETTING) === true;
		this._runStepsFlowEnabled = () => configurationService?.getValue(PARADIS_BROWSER_RUN_STEPS_FLOW_SETTING) === true;
		this._devtoolsGenerationCoordinator = new ParadisDevtoolsGenerationCoordinator(token => this._devtoolsProxy.forget(token));
		// Renderer IPC切断はreloadでも発生するため、退役根拠にはしない。実windowの生存権威は
		// Electron Mainのmanifestであり、reload gap中はpending entryが残り、destroy時だけ消える。
		const windowLeaseChannel = mainProcessService.getChannel(PARADIS_MOBILE_WINDOW_LEASE_CHANNEL);
		this._register(windowLeaseChannel.listen<IParadisMobileRendererManifest>('onDidChangeManifest')(manifest => this.observeRendererManifest(manifest)));
		void windowLeaseChannel.call<IParadisMobileRendererManifest>('manifest').then(
			manifest => this.observeRendererManifest(manifest),
			error => {
				reportParadisDiagnosticError('owned', 'agent-browser', 'read-window-manifest', error, { phase: 'startup' });
				this._runNonThrowingDiagnostic(() => this.logService.warn('[ParadisAgentBrowser] Failed to read authoritative window manifest', error));
			},
		);
		this._serverStartPromise = this._startServer().catch(error => {
			this._httpServer = undefined;
			reportParadisDiagnosticError('owned', 'agent-browser', 'start-mcp-server', error, { phase: 'startup' });
			this._runNonThrowingDiagnostic(() => this.logService.error('[ParadisAgentBrowser] Failed to start MCP server', error));
		});
		this._mcpSetupController = createParadisMcpSetupController(
			() => cachedShellEnv.getEnv(),
			paradisCodexHome(),
			(message, error) => {
				reportParadisDiagnosticError('owned', 'agent-browser', 'configure-mcp', error ?? new Error(message), { phase: 'setup' });
				this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] ${message}`, error));
			},
			// アカウントを切り替えた先の Codex（~/.codex-2 等）にも同じ設定を入れる。
			() => paradisCodexHomes(),
			// ツール呼び出しの上限を足す入れ直しを、どの設定ファイルとポートで試したか（試したものは次の起動から試さない）。
			join(this._userDataPath, 'paradis-mcp-tool-timeout-upgrade.json'),
		);
		// ホームが増えたら（アカウントの追加・ログイン、設定で足した）、既定のホームでセットアップ済みの
		// 設定をそこへも入れる。セットアップや修正のときだけでは、後から増えたホームに入らない。
		this._register(onDidChangeParadisCodexHomes(() => {
			void this._currentGatewayPort().then(port => this._mcpSetupController.propagateToCodexHomes(port)).catch(error => {
				this._runNonThrowingDiagnostic(() => this.logService.warn('[ParadisAgentBrowser] Failed to add the MCP settings to new Codex homes', error));
			});
		}));
		// ツール呼び出しの上限（timeout / tool_timeout_sec）と Codex の並行の呼び出し（supports_parallel_tool_calls）を
		// 足す前に登録した para-browser を、起動時に 1 回だけ入れ直す。
		void this._serverStartPromise.then(() => this._currentGatewayPort()).then(port => this._mcpSetupController.upgradeToolTimeouts(port)).catch(error => {
			this._runNonThrowingDiagnostic(() => this.logService.warn('[ParadisAgentBrowser] Failed to add the tool timeout to the MCP settings', error));
		});
		// 設定でオフにできる。オフに切り替わったその時だけ取り外し、起動時には取り外さない
		// （paradisAgentHooksAutoInstall.ts）。
		this._register(new ParadisAgentHooksAutoInstall({
			isEnabled: () => paradisAgentHooksEnabled(configurationService?.getValue(PARADIS_AGENT_HOOKS_ENABLED_SETTING)),
			onDidChangeEnabled: configurationService
				? Event.map(Event.filter(configurationService.onDidChangeConfiguration, e => e.affectsConfiguration(PARADIS_AGENT_HOOKS_ENABLED_SETTING)), () => undefined)
				: Event.None,
			createInstaller: () => new ParadisAgentHooksReconciler(logService, {}, () => cachedShellEnv.getEnv()),
			removeHooks: () => paradisRemoveAgentHooks(logService),
			logService,
			onInstallError: error => {
				reportParadisDiagnosticError('owned', 'agent-browser', 'configure-agent-hooks', error, { phase: 'setup' });
				this._runNonThrowingDiagnostic(() => logService.warn('[ParadisAgentBrowser] Agent hooks setup failed', error));
			},
		}));
		// Claude Code の mod（Claude Mods）がモバイルの承認を待つ上限（paradisClaudeModBridge.ts）。
		paradisClaudeModBridge.setApprovalWait(() => paradisClaudeModApprovalWaitMs(configurationService?.getValue(PARADIS_CLAUDE_MOD_APPROVAL_WAIT_SETTING)));
		this._register(registerParadisAgentPaneActivityGuard(token => this.captureIngressLease(token) !== undefined));
		this._register(onParadisAgentTurnStarted(({ token, cwd, at }) => {
			const ingressLease = this.captureIngressLease(token);
			if (ingressLease === undefined || this._programStatusTokens.has(token)) {
				return;
			}
			if (this.isIngressLeaseCurrent(ingressLease)) {
				this._agentHookTokens.add(token);
				const previous = this._paneStatuses.get(token)?.status;
				if (previous === 'permission' || previous === 'question') {
					this._unconfirmedReleaseTokens.add(token);
				}
				this._userTurnStarts.set(token, at);
				this._paneStatuses.set(token, { status: 'working', changedAt: at, ...(cwd !== undefined ? { cwd } : {}) });
			}
		}));
		// transcript由来のターン終了（Codex の usage limit エラー・中断等、Stop hook が
		// 発火しないケース）を working 状態の解除に反映する。Stop hook と同じく、
		// バックグラウンドタスクが残っていれば working を維持する（stale掃除の対象になる）。
		this._register(onParadisAgentTurnEnded(({ token, at, cause }) => this._settlePaneTurnEnded(token, at, cause)));
		// エージェントが完了ではなく、止まって利用者の次の指示を待っている（許可を拒否された等。どの hook も
		// 来ない）。許可待ち・作業中のまま残ると、スリープ防止・タブの鈴・一覧の件数が次のプロンプトまで残るので、
		// 状態なし（idle）へ移す。確認待ち（review）にはしない（review は完了の通知の対象）。モバイルの接続とは
		// 関係なく届く（transcript を読む側から直接発火する）。
		this._register(onParadisAgentAwaitingUser(({ token }) => this._settlePaneAwaitingUser(token)));

		// transcript由来のペインアクティビティ (ParadisMobileAgentChat の tailer が学習) を
		// 実行状態へ反映する。hookイベントが来ない場面の状態変化はここが拾う:
		//  - 質問(AskUserQuestion)の出現/回答は hook を発火しない (transcript にしか現れない)
		//  - バックグラウンドタスクの起動を Stop hook より後から検知した場合の
		//    「完了 → 実行中」への補正 (tail はポーリング分だけ hook より遅れることがある)
		this._register(onParadisAgentPaneActivity(({ token, activity }) => {
			const ingressLease = this.captureIngressLease(token);
			if (ingressLease === undefined || this._programStatusTokens.has(token)) {
				return;
			}
			const entry = this._paneStatuses.get(token);
			const current = entry?.status;
			const hadPendingApproval = this._activityApprovalTokens.has(token);
			if (!this.isIngressLeaseCurrent(ingressLease)) {
				return;
			}
			if (activity.pendingApproval) {
				this._activityApprovalTokens.add(token);
			} else {
				this._activityApprovalTokens.delete(token);
			}
			// hookが報告済みのcwd (スコープ解決フォールバック用) は補正更新でも維持する
			const cwd = entry?.cwd;
			if (activity.pendingQuestion) {
				// permission からも question へ昇格させる。質問検知(pendingQuestion)より先に
				// permission を書き込む経路があり、以前はそこから復帰できずモバイルの
				// 許可/拒否カードが質問中ずっと表示され続けていた。
				if (current !== 'question') {
					this._paneStatuses.set(token, { status: 'question', changedAt: Date.now(), ...(cwd !== undefined ? { cwd } : {}) });
				}
				return; // 質問への回答待ちが最優先。バックグラウンドタスク補正で上書きさせない
			}
			if (activity.pendingApproval) {
				if (current !== 'permission') {
					this._paneStatuses.set(token, { status: 'permission', changedAt: Date.now(), ...(cwd !== undefined ? { cwd } : {}) });
				}
				return;
			}
			if (current === 'question' || (current === 'permission' && hadPendingApproval)) {
				// 回答された → エージェントは続行する (直後のツール実行hookが上書きしてくれるが、
				// 来ない場合でも赤表示が残らないよう working へ戻す)
				this._unconfirmedReleaseTokens.add(token);
				this._paneStatuses.set(token, { status: 'working', changedAt: Date.now(), ...(cwd !== undefined ? { cwd } : {}) });
				return;
			}
			if (paradisCountLiveBackgroundTasks(token, Date.now()) > 0 && (current === undefined || current === 'review')) {
				this._paneStatuses.set(token, { status: 'working', changedAt: Date.now(), ...(cwd !== undefined ? { cwd } : {}), backgroundCompletionFallback: true });
			}
		}));
	}

	// --- バインディングレジストリ（workbenchからIPCチャネル経由で呼ばれる） ---

	async prepareBind(connection: object, request: IParadisPrepareBindRequest): Promise<IParadisPrepareBindResult> {
		const windowCtx = this._requireCurrentRendererConnection(connection);
		const parsedWindow = parseRendererWindowContext(windowCtx);
		const pageInfo = copySharedPageInfo(request.pageInfo);
		if (parsedWindow === undefined || pageInfo === undefined) {
			throw new Error('Para Browser bind preparation rejected');
		}
		// A quarantined token is isolated at the earliest rebind choke point so no new ticket is issued.
		if (this._faultedTokens.has(request.token)) {
			throw new Error('Para Browser bind preparation rejected');
		}
		// 共有を足すと上限を超える（付け替えではなく追加なので、数えるのは今の共有の枚数）
		if (this._userSharedPageCountAfterBind(request.token, request.viewId) > PARADIS_USER_SHARED_PAGE_LIMIT) {
			throw new Error(PARADIS_USER_SHARED_PAGE_LIMIT_ERROR);
		}

		let snapshot: IParadisBindingPrepareSnapshot;
		try {
			snapshot = this._bindingAuthority.capturePrepareSnapshot(
				connection,
				request.revision,
				request.token,
				request.viewId,
			);
		} catch {
			throw new Error('Para Browser bind preparation rejected');
		}
		if (this._pendingBindPreparations >= MAX_PENDING_BIND_PREPARATIONS) {
			throw new Error('Para Browser bind preparation capacity reached');
		}

		this._pendingBindPreparations++;
		try {
			const resolved = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<unknown>('resolveExactViewDescriptor', [parsedWindow.windowId, request.viewId]);
			this._requireCurrentRendererConnection(connection);
			const exactView = paradisParseExactBrowserViewDescriptor(resolved);
			if (exactView === undefined
				|| exactView.windowId !== parsedWindow.windowId
				|| exactView.viewId !== request.viewId) {
				throw new Error('Exact BrowserView is unavailable');
			}
			const ticket = this._bindingAuthority.issueTicket(snapshot, { exactView, pageInfo });
			return Object.freeze({
				ticketId: ticket.id,
				expiresAt: ticket.expiresAt,
				revision: snapshot.revision,
				scope: snapshot.scope,
			});
		} catch {
			throw new Error('Para Browser bind preparation rejected');
		} finally {
			this._pendingBindPreparations--;
		}
	}

	async commitBind(connection: object, request: IParadisBindingTicketRequest): Promise<IParadisCommitBindResult> {
		const windowCtx = this._requireCurrentRendererConnection(connection);
		let preparation: IParadisBindingCommitPreparation<IPreparedBindingDescriptor>;
		try {
			preparation = this._bindingAuthority.prepareTicketCommit(connection, request.ticketId);
		} catch {
			throw new Error('Para Browser binding ticket rejected');
		}

		// Defense in depth against a quarantined token: reject the rebind before touching capacity,
		// coordinator, or registry state. prepareBind already blocks the ticket issuance path.
		if (this._faultedTokens.has(preparation.token)) {
			throw new Error('Para Browser binding token rejected');
		}

		const previous = this._bindings.get(preparation.token);
		// 前の current は外さず、2 枚目以降の共有として残す（同じページの張り直しなら置き換えるだけ）
		const demoted = previous !== undefined && previous.pageId !== preparation.viewId ? previous : undefined;
		const existingGrant = this._agentTabGrants.get(preparation.token)?.get(preparation.viewId);
		const promoted = existingGrant?.userShared ? existingGrant : undefined;
		const demotedGrant = demoted !== undefined ? this._agentTabGrants.get(preparation.token)?.get(demoted.pageId) : undefined;
		const addedEntries = (previous === undefined ? 1 : 0) + (demoted !== undefined && demotedGrant === undefined ? 1 : 0) - (promoted !== undefined ? 1 : 0);
		if (addedEntries > 0 && this._bindings.size + this._quarantinedBindings.size + this._agentTabGrantCount() + addedEntries > MAX_EXTERNAL_BINDINGS) {
			throw new Error('Para Browser binding capacity reached');
		}
		if (this._userSharedPageCountAfterBind(preparation.token, preparation.viewId) > PARADIS_USER_SHARED_PAGE_LIMIT) {
			throw new Error(PARADIS_USER_SHARED_PAGE_LIMIT_ERROR);
		}
		try {
			this._backgroundThrottlingCoordinator.assertCanSetBinding(
				this._throttlingRegistry(),
				preparation.token,
				preparation.descriptor.exactView,
			);
		} catch {
			// A registry/coordinator mismatch means a previous internal transition did not converge.
			// Reject before consuming the ticket and fail closed instead of publishing split state.
			// assertCanSetBinding validates the whole binding registry against the coordinator, so the
			// divergence is not provably scoped to this token; fault globally (conservative) rather than
			// risk leaving split state published on another pane. Only genuinely unrecoverable path that
			// still sets _authorityFaulted outside dispose().
			this._runNonThrowingDiagnostic(() => this.logService.warn(
				`[ParadisAgentBrowser] commitBind: coordinator/registry mismatch; faulting authority for pane ${this._tokenFingerprint(preparation.token)} in ${windowCtx}`,
			));
			this._authorityFaulted = true;
			throw new Error('Para Browser binding state rejected');
		}

		const generation = this._nextBindingGeneration + 1;
		const binding: IBindingEntry = Object.freeze({
			windowCtx,
			pageId: preparation.viewId,
			pageInfo: preparation.descriptor.pageInfo,
			generation,
			boundAt: Date.now(),
			exactView: preparation.descriptor.exactView,
			scope: preparation.scope,
		});
		try {
			this._bindingAuthority.commitPreparedTicket(connection, preparation, binding);
		} catch {
			throw new Error('Para Browser binding ticket rejected');
		}

		// From this point the authority commit is final. All remaining state changes are synchronous,
		// bounded, and non-observably ordered before the IPC promise settles.
		this._nextBindingGeneration = generation;
		// 前の current を 2 枚目以降の共有へ移す。世代はそのまま（tab_id でそのタブを使っている接続を切らない）。
		// 描画止めの参照を先に足してから current を付け替える（間で描画止めが一度戻らないように）
		const throttlingEffects: IParadisExactViewBackgroundThrottlingEffect[] = [];
		if (demoted !== undefined) {
			throttlingEffects.push(...this._putUserSharedPage(preparation.token, demoted));
		}
		this._bindings.set(preparation.token, binding);
		throttlingEffects.push(...this._backgroundThrottlingCoordinator.setBinding(preparation.token, binding.exactView));
		if (promoted !== undefined) {
			// 2 枚目以降として共有していたページを current にした。許可の側からは外す（エージェントのタブでもあれば許可へ戻す）
			throttlingEffects.push(...this._releaseUserSharedEntry(preparation.token, promoted));
			// 同じビューのままなら、そのタブを tab_id で使っている接続は切らない
			this._keepTabScope(preparation.token, promoted, binding);
		}
		// 新しく共有したページを、tab_id を省いたときのタブにする。ただしエージェントが自分のタブを選んでいれば
		// それを保つ（ユーザーが共有したことは list_browser_tabs の shared で分かる）
		const selected = this._selectedTabs.get(preparation.token);
		if (selected === undefined || !this._isAgentOwnTab(preparation.token, selected)) {
			this._selectedTabs.delete(preparation.token);
		}
		this._activateBindingGeneration(preparation.token, generation, true);
		this._dispatchBackgroundThrottlingEffects(throttlingEffects);
		this._runNonThrowingDiagnostic(() => this.logService.debug(
			`[ParadisAgentBrowser] Bound pane ${this._tokenFingerprint(preparation.token)} generation=${generation} -> exact BrowserView in ${windowCtx}`,
		));

		return Object.freeze({
			committed: true,
			binding: Object.freeze({
				token: preparation.token,
				pageId: binding.pageId,
				pageInfo: binding.pageInfo,
				generation: binding.generation,
				boundAt: binding.boundAt,
				scope: binding.scope,
			}),
		});
	}

	async abortBind(connection: object, request: IParadisBindingTicketRequest): Promise<IParadisAbortBindResult> {
		this._requireCurrentRendererConnection(connection);
		try {
			this._bindingAuthority.abortTicket(connection, request.ticketId);
		} catch {
			throw new Error('Para Browser binding ticket rejected');
		}
		return Object.freeze({ aborted: true });
	}

	async unbind(connection: object, token: string): Promise<boolean> {
		if (!this._isEligibleToken(connection, token)) {
			return false;
		}
		const entry = this._bindings.get(token);
		// ペイン単位の解除: 2 枚目以降の共有もまとめて外す
		const removedShares = this._dropUserSharedPages(token);
		if (entry === undefined) {
			return removedShares;
		}
		this._deleteActiveBinding(token, entry);
		this._bindingAuthority.recordBindingMutation(token, undefined);
		return true;
	}

	/**
	 * BrowserView消滅を観測したgenerationが現在と一致する場合だけ解除する。
	 * generation確認から解除までawaitを挟まず、検出後のrebindを保護する。
	 */
	async unbindIfCurrent(connection: object, token: string, expectedGeneration: number): Promise<boolean> {
		if (!this._isEligibleToken(connection, token)) {
			return false;
		}
		const entry = this._bindings.get(token);
		if (!paradisBindingMatchesGeneration(entry, expectedGeneration)) {
			// 2 枚目以降の共有はページごとに外す（その世代のものだけ）
			return this._deleteUserSharedPageIfCurrent(token, expectedGeneration);
		}
		this._deleteActiveBinding(token, entry);
		this._bindingAuthority.recordBindingMutation(token, undefined);
		// current を外した。残りの共有のうち最後に共有したものを current にする
		this._promoteLatestUserSharedPage(token);
		return true;
	}

	private _deleteActiveBinding(token: string, expected?: IBindingEntry): number | undefined {
		const current = this._bindings.get(token);
		if (current === undefined || (expected !== undefined && current !== expected)) {
			return undefined;
		}
		this._bindings.delete(token);
		this._dispatchBackgroundThrottlingEffects(this._backgroundThrottlingCoordinator.releaseBinding(token));
		const generation = this._advanceBindingGeneration(token);
		this._runNonThrowingCleanup(
			'binding-log',
			() => this.logService.debug(`[ParadisAgentBrowser] Unbound pane ${this._tokenFingerprint(token)} generation=${generation}`),
		);
		return generation;
	}

	/** IPCServerのconnection identityをrenderer世代authorityとして登録する。 */
	registerRendererConnection(windowCtx: string, connection: object): boolean {
		// 新しいウィンドウのペインは、同期が済むまで hook の受け口が知らない（W2-20 レビュー M3）。
		this._hookSyncGraceSince = Date.now();
		const parsed = parseRendererWindowContext(windowCtx);
		if (this._authorityFaulted
			|| parsed === undefined
			|| (this._hasMainRendererManifest && !this._mainLiveWindowIds.has(parsed.windowId))) {
			return false;
		}
		const registeredContext = this._rendererConnectionContexts.get(connection);
		if (registeredContext !== undefined && registeredContext !== windowCtx) {
			return false;
		}
		try {
			this._bindingAuthority.registerConnection(windowCtx, connection);
		} catch {
			return false;
		}
		const previous = this._rendererConnections.get(windowCtx);
		if (previous !== undefined && previous !== connection) {
			this._rendererConnectionContexts.delete(previous);
		}
		if (previous !== connection) {
			// エージェントのタブの台帳は renderer のメモリにだけある（再読み込みで忘れる）。新しい接続になったら、
			// そのウィンドウの許可も外す（取り消す側が居なくなった許可を残さない）
			// ユーザーが共有したページ（2 枚目以降）は current の共有と同じく再読み込みでも残す（エージェントのタブの印だけ外す）
			this._dropAgentTabGrants(grant => grant.windowCtx === windowCtx && grant.userShared !== true);
			for (const grants of this._agentTabGrants.values()) {
				for (const [tabId, grant] of grants) {
					if (grant.windowCtx === windowCtx && grant.agentTab) {
						const { agentTab: _agentTab, ...rest } = grant;
						grants.set(tabId, Object.freeze(rest));
					}
				}
			}
		}
		this._rendererConnections.set(windowCtx, connection);
		this._rendererConnectionContexts.set(connection, windowCtx);
		this._knownRendererContexts.add(windowCtx);
		return true;
	}

	unregisterRendererConnection(windowCtx: string, connection: object): void {
		if (this._rendererConnections.get(windowCtx) === connection) {
			this._rendererConnections.delete(windowCtx);
			this._rendererConnectionContexts.delete(connection);
		}
	}

	isCurrentRendererConnection(windowCtx: string, connection: object): boolean {
		return parseRendererWindowContext(windowCtx) !== undefined
			&& this._rendererConnections.get(windowCtx) === connection
			&& this._rendererConnectionContexts.get(connection) === windowCtx;
	}

	/** Global channel登録後に各connection専用channelで上書きし、reload前rendererを識別可能にする。 */
	installRendererConnectionChannels(
		createChannel: (connection: (typeof this.ipcServer.connections)[number]) => IServerChannel<string>,
	): void {
		const registerConnection = (connection: (typeof this.ipcServer.connections)[number]) => {
			this.registerRendererConnection(connection.ctx, connection);
			connection.channelServer.registerChannel(PARADIS_AGENT_BROWSER_CHANNEL, createChannel(connection));
		};
		for (const connection of this.ipcServer.connections) {
			registerConnection(connection);
		}
		this._register(this.ipcServer.onDidAddConnection(registerConnection));
		this._register(this.ipcServer.onDidRemoveConnection(connection => this.unregisterRendererConnection(connection.ctx, connection)));
	}

	/**
	 * Electron Mainの単調revision付き完全manifestを適用する。pending rendererもentryに残るため、
	 * absentだけが実window close/destroyの確定を意味する。
	 */
	observeRendererManifest(manifest: IParadisMobileRendererManifest): void {
		// A protocol fault blocks new Renderer-owned operations, but Electron Main remains the
		// authoritative source for destroyed windows. Continue accepting only its strict manifest
		// so faulted state can still converge and release resources.
		if (this._serverDisposed) {
			return;
		}
		const accepted = parseMainRendererManifest(manifest);
		if (accepted === undefined || accepted.revision <= this._rendererManifestRevision) {
			return;
		}
		const liveWindowIds = new Set(accepted.entries.map(entry => entry.windowId));
		const destroyedContexts = [...this._knownRendererContexts].filter(windowCtx => {
			const parsed = parseRendererWindowContext(windowCtx);
			return parsed !== undefined && !liveWindowIds.has(parsed.windowId);
		});
		this._rendererManifestRevision = accepted.revision;
		this._mainLiveWindowIds = liveWindowIds;
		this._hasMainRendererManifest = true;
		for (const windowCtx of destroyedContexts) {
			const connection = this._rendererConnections.get(windowCtx);
			if (connection !== undefined) {
				this._rendererConnectionContexts.delete(connection);
			}
			this._rendererConnections.delete(windowCtx);
			this._knownRendererContexts.delete(windowCtx);
			const preservedTokens = this._processOwnerRelease(this._bindingAuthority.destroyWindow(windowCtx));
			this._cleanupRemainingWindowState(windowCtx, preservedTokens);
			// 戻りトンネルとソケット転送の所有者からも外す。ウィンドウ側の取り下げは投げっぱなしで
			// クラッシュ時には届かないので、window の生死を知っている唯一の権威であるここで必ず外す
			// （reload でも起きる IPC 切断を根拠にすると、リロードのたびにトンネルが落ちて番号が変わる）
			this._runNonThrowingCleanup('remote-agent-tunnel', () => this._releaseRemoteAgentTunnelsForWindow(windowCtx));
		}
	}

	async syncBindingAuthority(connection: object, manifest: unknown): Promise<{ readonly accepted: true; readonly revision: number }> {
		const windowCtx = this._requireCurrentRendererConnection(connection);
		let acceptance: IParadisBindingManifestAcceptance<IBindingEntry>;
		let acceptedManifest: IParadisBindingAuthorityManifest;
		try {
			const parsedManifest = paradisParseBindingAuthorityManifest(manifest);
			this._validateProjectedShellPids(windowCtx, parsedManifest);
			acceptance = this._bindingAuthority.acceptManifest(connection, parsedManifest);
			acceptedManifest = this._bindingAuthority.getCurrentAcceptedManifest(connection);
		} catch {
			throw new Error('Para Browser protocol rejected');
		}
		for (const pane of acceptedManifest.panes) {
			if (pane.remoteAuthority !== undefined) {
				this._paneRemoteAuthorities.set(pane.token, pane.remoteAuthority);
				this._remotePaneWindows.set(pane.token, windowCtx);
			}
			const existing = this._paneShells.get(pane.token);
			const terminalExited = this._terminalExitedTokens.has(pane.token);
			const preserveRecoveryPid = !acceptedManifest.complete
				&& pane.shellPid === undefined
				&& existing?.windowCtx === windowCtx
				&& !terminalExited;
			const desiredShellPid = preserveRecoveryPid
				? existing.shellPid
				: pane.shellPid !== undefined && !terminalExited
					? pane.shellPid
					: undefined;
			// 不完全な manifest で番号を引き継ぐときは、接続先の印も引き継ぐ（番号だけ引き継ぐと、接続先の番号が
			// 手元の番号として扱われる）
			const desiredRemoteAuthority = preserveRecoveryPid ? existing.remoteAuthority : pane.remoteAuthority;
			if (existing !== undefined
				&& (existing.windowCtx !== windowCtx || existing.shellPid !== desiredShellPid || existing.remoteAuthority !== desiredRemoteAuthority)) {
				this._paneShells.delete(pane.token);
				this._runNonThrowingCleanup('gateway-connections', () => this._cdpGateway.closeConnectionsForToken(pane.token));
				// tab_id のタブの接続（`?pane=&tab=`）も、ペインのシェル・接続先が変わったら閉じる
				for (const tabId of this._tabScopes.get(pane.token)?.keys() ?? []) {
					this._runNonThrowingCleanup('gateway-tab-connections', () => this._cdpGateway.closeConnectionsForToken(paradisAgentTabScopeKey(pane.token, tabId)));
				}
			}
			if (desiredShellPid !== undefined) {
				this._paneShells.set(pane.token, { windowCtx, token: pane.token, shellPid: desiredShellPid, ...(desiredRemoteAuthority !== undefined ? { remoteAuthority: desiredRemoteAuthority } : {}) });
				// A quarantined token re-entering as a live pane under a different shell PID is a genuinely
				// new binding lifecycle (e.g. the pane was reopened after its window was closed). Lift the
				// isolation so a closed-window quarantine that never receives a TerminalExit can recover.
				this._maybeReleaseQuarantineOnFreshShell(pane.token, desiredShellPid);
			}
		}
		this._processOwnerRelease(acceptance);
		this._runNonThrowingCleanup('agent-tab-scope', () => this._dropAgentTabGrantsOutOfScope(acceptedManifest));
		// current が外れたときに確かめられず繰り上げを見送ったペイン（再読み込みの途中など）を見直す
		for (const pane of acceptedManifest.panes) {
			if (!this._bindings.has(pane.token) && this._userSharedPageEntries(pane.token).length > 0) {
				this._runNonThrowingCleanup('user-share-promotion', () => this._promoteLatestUserSharedPage(pane.token));
			}
		}
		// Para Code が止まっている間の hook の控えを流し直す（W2-20）。受け口はトークンが今生きている
		// ペインのものかを確かめるので、ペインの同期が済んだこの時点で読む。
		for (const pane of acceptedManifest.panes) {
			this._scheduleAgentHookSpoolReplay(pane.token);
		}
		return { accepted: true, revision: acceptance.revision };
	}

	/**
	 * 知らないトークンが「まだ同期していないだけ」かもしれないか。終わったペイン・隔離したペインは違う。
	 * 起動とウィンドウの接続から一定時間だけそう扱う。
	 */
	private _isHookTokenPossiblyUnsynced(token: string): boolean {
		return typeof token === 'string'
			&& token.length > 0
			&& token.length <= MAX_PANE_TOKEN_LENGTH
			&& !this._serverDisposed
			&& !this._terminalExitedTokens.has(token)
			&& !this._faultedTokens.has(token)
			&& Date.now() - this._hookSyncGraceSince < PARADIS_AGENT_HOOK_SYNC_GRACE_MS;
	}

	private _rememberHookId(id: string): void {
		this._recentHookIds.delete(id);
		this._recentHookIds.add(id);
		if (this._recentHookIds.size > 4096) {
			const oldest = this._recentHookIds.values().next().value;
			if (oldest !== undefined) {
				this._recentHookIds.delete(oldest);
			}
		}
	}

	private _scheduleAgentHookSpoolReplay(token: string): void {
		if (this._hookSpoolCheckedTokens.has(token) || this._terminalExitedTokens.has(token)) {
			return;
		}
		this._hookSpoolCheckedTokens.add(token);
		void this._replayAgentHookSpool(token).catch(error => {
			this._runNonThrowingDiagnostic(() => this.logService.warn('[ParadisAgentBrowser] could not replay spooled agent hooks', error));
		});
	}

	/**
	 * 1 つのペインの控えを流し直す。控えは読んだら消す。
	 *
	 * - 本物の hook がこの起動で既に届いたペインは、控えより新しいので状態を触らない。
	 * - 控えの hook は発信元のプロセスを確かめられないので、所有者の判定は transcript だけで行う
	 *   （pid 無しの hook と同じ fail-closed の判定）。
	 * - 状態を触るのは、まだ状態が付いていないペインだけ（transcript から分かった状態を上書きしない）。
	 * - hook のバスへは流さない。完了は鳴らさずに印だけを付け、許可要求・質問は画面を確かめて
	 *   もらってから（`confirmReplayedPrompt`）ライブと同じ経路へ出す。
	 */
	private async _replayAgentHookSpool(token: string): Promise<void> {
		await this._hookSpoolPruned;
		const ingressLease = this.captureIngressLease(token);
		if (ingressLease === undefined) {
			return;
		}
		const records = (await paradisTakeAgentHookSpool(this._hookSpoolDir, token, Date.now(), this._hookSpoolReplayAfter))
			// 受け口の返事が遅れて控えてしまった重複（この起動で既に届いたもの）は流さない。
			.filter(record => record.id === undefined || !this._recentHookIds.has(record.id));
		if (records.length === 0 || !this.isIngressLeaseCurrent(ingressLease) || this._hookReportedTokens.has(token)) {
			return;
		}
		const accepted: IParadisSpooledAgentHook[] = [];
		for (const record of records) {
			const field = (name: string): string | undefined => {
				const value = record.payload?.[name];
				return typeof value === 'string' ? value : undefined;
			};
			const transcriptPath = field('transcript_path');
			const origin = await this._hookOwnership.classify({ token, hookPid: undefined, transcriptPath, at: record.at });
			if (!this.isIngressLeaseCurrent(ingressLease) || this._hookReportedTokens.has(token)) {
				return;
			}
			if (origin.origin === 'invalid') {
				const rejection = origin.rejection;
				this._noteAgentHookDrop(() => ({
					reason: 'spool-origin-mismatch', pane: this._tokenFingerprint(token), event: record.event,
					side: this._paneShells.get(token)?.remoteAuthority !== undefined ? 'remote' : 'local', pid: 'absent',
					identityLoss: rejection?.identityLoss, ownerPinnedBy: rejection?.ownerPinnedBy,
					transcriptPath, ownerTranscriptPath: rejection?.ownerTranscriptPath,
					ownerIdleMs: rejection !== undefined ? Date.now() - rejection.ownerAt : undefined,
				}));
			}
			if (origin.origin !== 'owner') {
				continue;
			}
			accepted.push(record);
			this._recordPaneSession(token, record.event, field('session_id'), transcriptPath, field('cwd'));
		}
		if (accepted.length === 0) {
			return;
		}
		this._agentHookTokens.add(token);
		const plan = paradisPlanAgentHookReplay(accepted, Date.now());
		const alreadyKnown = this._paneStatuses.has(token);
		if (!alreadyKnown && plan.kind === 'status' && plan.status !== 'idle') {
			const cwd = [...accepted].reverse().map(record => record.payload?.cwd).find((value): value is string => typeof value === 'string');
			this._paneStatuses.set(token, {
				status: plan.status,
				changedAt: plan.at,
				...(cwd !== undefined ? { cwd } : {}),
				...(plan.quiet ? { quiet: true } : {}),
			});
		} else if (!alreadyKnown && plan.kind === 'prompt') {
			this._replayedPrompts.set(token, { status: plan.status, record: plan.record });
		}
		this._runNonThrowingDiagnostic(() => this.logService.info(`[ParadisAgentBrowser] replayed ${accepted.length} spooled agent hook(s) for a pane: ${plan.kind === 'none' ? 'no state' : `${plan.kind === 'prompt' ? 'waiting for a screen check: ' : ''}${plan.status}`}${alreadyKnown ? ' (state already known; left alone)' : ''}`));
	}

	/**
	 * ウィンドウ側が、流し直した許可要求・質問の確認が画面に今も出ていると確かめた（W2-20）。
	 * ここで初めて状態を付け、hook のバスへ流して承認カードと通知をライブと同じ経路で出す。
	 */
	async confirmReplayedPrompt(connection: object, token: string): Promise<boolean> {
		if (!this._isEligibleToken(connection, token)) {
			return false;
		}
		const pending = this._replayedPrompts.get(token);
		this._replayedPrompts.delete(token);
		const ingressLease = this.captureIngressLease(token);
		if (pending === undefined || ingressLease === undefined || this._hookReportedTokens.has(token) || this._paneStatuses.has(token)
			|| Date.now() - pending.record.at > PARADIS_AGENT_HOOK_REPLAY_PROMPT_WINDOW_MS) {
			return false;
		}
		const { record } = pending;
		const field = (name: string): string | undefined => {
			const value = record.payload?.[name];
			return typeof value === 'string' ? value : undefined;
		};
		const cwd = field('cwd');
		const now = Date.now();
		this._paneStatuses.set(token, { status: pending.status, changedAt: now, ...(cwd !== undefined ? { cwd } : {}) });
		fireParadisAgentHookEvent({
			token, event: record.event, sessionId: field('session_id'), transcriptPath: field('transcript_path'), cwd,
			toolName: field('tool_name'), toolInput: record.payload?.tool_input, toolUseId: field('tool_use_id'),
			payload: record.payload, ownerUnverified: true, at: now,
		});
		this._runNonThrowingDiagnostic(() => this.logService.info(`[ParadisAgentBrowser] a replayed ${pending.status} is still on screen; showing it`));
		return true;
	}

	/**
	 * ペインの Claude Code が OSC 7501（Program Status Protocol）で知らせた状態（renderer の端末が読んで送る。
	 * paradisProgramStatus.contribution.ts）。hook が届いていないペイン（WSL・手で ssh した先など）の状態の補助に
	 * だけ使い、hook が一度でも届いたペインでは何もしない。状態を書き換えたら true。
	 */
	async notePaneProgramStatus(connection: object, token: string, value: unknown): Promise<boolean> {
		if (!this._isEligibleToken(connection, token)) {
			return false;
		}
		const status = paradisCopyProgramStatus(value);
		const ingressLease = this.captureIngressLease(token);
		if (status === undefined || ingressLease === undefined || !paradisProgramStatusApplies(this._hookReportedTokens.has(token))) {
			return false;
		}
		const now = Date.now();
		// renderer でも間引いているが、ここでも 1 秒に数回までにする（renderer 以外の呼び出しや不具合で IPC が続いても状態を振らない）
		const times = (this._programStatusTimes.get(token) ?? []).filter(at => now - at < 1000);
		if (status.state !== 'clear' && times.length >= PARADIS_PROGRAM_STATUS_MAX_CHANGES_PER_SECOND) {
			this._programStatusTimes.set(token, times);
			return false;
		}
		times.push(now);
		this._programStatusTimes.set(token, times);
		const next = paradisProgramStatusToAgentStatus(status);
		const previous = this._paneStatuses.get(token);
		// hook の実績（_agentHookTokens・_hookReportedTokens）には混ぜず、別の印で持つ
		if (status.state === 'clear') {
			this._programStatusTokens.delete(token);
			this._programStatusTimes.delete(token);
		} else {
			this._programStatusTokens.add(token);
		}
		if (next === 'idle') {
			return this._paneStatuses.delete(token);
		}
		if (next === 'review') {
			if (previous?.status === 'review') {
				return false;
			}
			this._paneStatuses.set(token, this._reviewEntry(token, now, previous?.cwd));
			return true;
		}
		if (previous?.status === next) {
			return false;
		}
		// 待ちや完了の後でない working は、新しいターンの始まり（完了の知らせを同じターンで二度出さないための印）
		if (next === 'working' && (previous === undefined || previous.status === 'review')) {
			this._userTurnStarts.set(token, now);
		}
		this._paneStatuses.set(token, { status: next, changedAt: now, ...(previous?.cwd !== undefined ? { cwd: previous.cwd } : {}) });
		return true;
	}

	private _validateProjectedShellPids(windowCtx: string, manifest: IParadisBindingAuthorityManifest): void {
		const projected = new Map(this._paneShells);
		const retiringTokensByPid = new Map<number, Set<string>>();
		const manifestTokens = new Set(manifest.panes.map(pane => pane.token));
		if (manifest.complete) {
			for (const [token, entry] of projected) {
				if (entry.windowCtx !== windowCtx || manifestTokens.has(token)) {
					continue;
				}
				if (entry.remoteAuthority !== undefined) {
					projected.delete(token);
					continue;
				}
				let retiringTokens = retiringTokensByPid.get(entry.shellPid);
				if (retiringTokens === undefined) {
					retiringTokens = new Set();
					retiringTokensByPid.set(entry.shellPid, retiringTokens);
				}
				retiringTokens.add(token);
				projected.delete(token);
			}
		}
		for (const pane of manifest.panes) {
			const existing = projected.get(pane.token);
			if (existing !== undefined && existing.windowCtx !== windowCtx) {
				throw new Error('Cross-window pane token collision');
			}
			const terminalExited = this._terminalExitedTokens.has(pane.token);
			const preserveRecoveryPid = !manifest.complete
				&& pane.shellPid === undefined
				&& existing?.windowCtx === windowCtx
				&& !terminalExited;
			const desiredShellPid = preserveRecoveryPid
				? existing.shellPid
				: pane.shellPid !== undefined && !terminalExited
					? pane.shellPid
					: undefined;
			if (desiredShellPid === undefined) {
				projected.delete(pane.token);
			} else {
				const desiredRemoteAuthority = preserveRecoveryPid ? existing.remoteAuthority : pane.remoteAuthority;
				const retiringTokens = desiredRemoteAuthority === undefined ? retiringTokensByPid.get(desiredShellPid) : undefined;
				if (retiringTokens !== undefined && [...retiringTokens].some(token => token !== pane.token)) {
					// Retirement can be conservatively preserved by an ABA check. Never transfer its
					// PID to another token until a later manifest observes the completed retirement.
					throw new Error('Shell PID retirement is not yet committed');
				}
				projected.set(pane.token, { windowCtx, token: pane.token, shellPid: desiredShellPid, ...(desiredRemoteAuthority !== undefined ? { remoteAuthority: desiredRemoteAuthority } : {}) });
			}
		}
		const ownersByPid = new Map<number, string>();
		for (const entry of projected.values()) {
			if (entry.remoteAuthority !== undefined) {
				continue;
			}
			const owner = ownersByPid.get(entry.shellPid);
			if (owner !== undefined && owner !== entry.token) {
				throw new Error('Duplicate shell PID authority');
			}
			ownersByPid.set(entry.shellPid, entry.token);
		}
	}

	private _getTokenForShellPid(pid: number): string | undefined {
		let resolvedToken: string | undefined;
		for (const entry of this._paneShells.values()) {
			// 接続先のペインの番号は手元のプロセスとは無関係（偶然一致した手元のプロセスを当てない）
			if (entry.shellPid !== pid || entry.remoteAuthority !== undefined || this.captureIngressLease(entry.token) === undefined) {
				continue;
			}
			if (resolvedToken !== undefined && resolvedToken !== entry.token) {
				return undefined;
			}
			resolvedToken = entry.token;
		}
		if (resolvedToken !== undefined) {
			// CDPゲートウェイがPID経由で呼び出し元ペインを識別できた＝接続実績あり。
			this._seenTokens.add(resolvedToken);
		}
		return resolvedToken;
	}

	async listBindings(connection: object): Promise<IParadisPaneBinding[]> {
		const windowCtx = this._requireCurrentRendererConnection(connection);
		const eligibleTokens = this._currentEligibleTokens(connection);
		const result: IParadisPaneBinding[] = [];
		for (const [token, entry] of this._bindings) {
			if (eligibleTokens.has(token) && entry.windowCtx === windowCtx) {
				result.push({ token, pageId: entry.pageId, pageInfo: entry.pageInfo, generation: entry.generation, boundAt: entry.boundAt, scope: entry.scope });
			}
		}
		// 2 枚目以降の共有（同じペインの current の後ろに、新しく共有した順＝世代の大きい順で並べる）
		for (const [token, grants] of this._agentTabGrants) {
			if (!eligibleTokens.has(token)) {
				continue;
			}
			for (const entry of [...grants.values()].filter(grant => grant.userShared && grant.windowCtx === windowCtx).sort((a, b) => b.generation - a.generation)) {
				result.push({ token, pageId: entry.pageId, pageInfo: entry.pageInfo, generation: entry.generation, boundAt: entry.boundAt, scope: entry.scope, additional: true });
			}
		}
		return result;
	}

	/**
	 * MCP/CDP経由で接続実績のある、現在の接続にeligibleなペイントークンだけを返す。
	 */
	async listSeenTokens(connection: object): Promise<string[]> {
		const eligibleTokens = this._currentEligibleTokens(connection);
		return [...this._seenTokens].filter(token => eligibleTokens.has(token));
	}

	/**
	 * バインド済み共有ページの「CDP targetId → ペイントークン」対応を返す（モバイルの
	 * ブラウザ一覧で「このエージェントと共有中のタブ」を判別するため）。targetId未解決の
	 * バインドはここで解決を試み、解決できなかったものは結果に含めない。
	 * {@link IParadisSharedPageBindings} の実装（モバイルリレーへ依存注入される）。
	 */
	async listBoundCdpTargets(): Promise<{ token: string; targetId: string }[]> {
		if (this._authorityFaulted) {
			return [];
		}
		const result: { token: string; targetId: string }[] = [];
		for (const token of [...this._bindings.keys()]) {
			if (!this._bindingAuthority.isOwnedToken(token) || this._terminalExitedTokens.has(token)) {
				continue;
			}
			const targetId = await this._ensureBoundTargetId(token);
			if (targetId !== undefined) {
				result.push({ token, targetId });
			}
		}
		return result;
	}

	private _requireCurrentRendererConnection(connection: object): string {
		if (this._authorityFaulted) {
			throw new Error('Para Browser protocol rejected');
		}
		const windowCtx = this._rendererConnectionContexts.get(connection);
		if (windowCtx === undefined || this._rendererConnections.get(windowCtx) !== connection) {
			throw new Error('Para Browser protocol rejected');
		}
		return windowCtx;
	}

	private _currentEligibleTokens(connection: object): ReadonlySet<string> {
		this._requireCurrentRendererConnection(connection);
		try {
			return new Set(this._bindingAuthority.listCurrentOwnedTokens(connection));
		} catch {
			throw new Error('Para Browser protocol rejected');
		}
	}

	private _isEligibleToken(connection: object, token: string): boolean {
		if (typeof token !== 'string' || token.length === 0 || token.length > MAX_PANE_TOKEN_LENGTH || this._authorityFaulted) {
			return false;
		}
		try {
			this._requireCurrentRendererConnection(connection);
			return this._bindingAuthority.isCurrentOwnedToken(connection, token);
		} catch {
			return false;
		}
	}

	/** Captures one uninterrupted owner lifecycle for all non-Renderer ingress. */
	captureIngressLease(token: string): IParadisAgentBrowserIngressLease | undefined {
		if (typeof token !== 'string'
			|| token.length === 0
			|| token.length > MAX_PANE_TOKEN_LENGTH
			// タブのスコープキーの区切りを含むトークンは受けない（スコープキーと取り違えないため）
			|| paradisParseAgentTabScopeKey(token).tabId !== undefined
			|| this._serverDisposed
			|| this._authorityFaulted
			|| this._faultedTokens.has(token)
			|| this._terminalExitedTokens.has(token)) {
			return undefined;
		}
		const ownerLease = this._bindingAuthority.captureOwnedTokenLease(token);
		if (ownerLease === undefined) {
			return undefined;
		}
		const lease = Object.freeze({ token });
		this._ingressLeaseStates.set(lease, ownerLease);
		return lease;
	}

	isIngressLeaseCurrent(lease: IParadisAgentBrowserIngressLease): boolean {
		const ownerLease = this._ingressLeaseStates.get(lease);
		return ownerLease !== undefined
			&& !this._serverDisposed
			&& !this._authorityFaulted
			&& !this._faultedTokens.has(lease.token)
			&& !this._terminalExitedTokens.has(lease.token)
			&& this._bindingAuthority.isOwnedTokenLeaseCurrent(ownerLease);
	}

	private _requireIngressLease(lease: IParadisAgentBrowserIngressLease): void {
		if (!this.isIngressLeaseCurrent(lease)) {
			throw new ParadisIngressLeaseError();
		}
	}

	private _processOwnerRelease(release: IParadisBindingOwnerRelease<IBindingEntry>): ReadonlySet<string> {
		const preservedTokens = new Set<string>();
		// ウィンドウの持ち物でなくなったタブ（閉じた・別のウィンドウへ移った）の許可を外す
		if (release.retiredViewIds.length > 0) {
			const retiredViews = new Set(release.retiredViewIds);
			this._dropAgentTabGrants(grant => retiredViews.has(grant.pageId));
			// 2 枚目以降から current へ繰り上がった後でそのビューが消えた（renderer の片付けは繰り上げ前の世代を
			// 見ていて外せない）。ペインがまだ生きていれば current を外し、残りから繰り上げ直す。ペインごと消えるものは
			// 下の retire が扱う
			const retiringTokens = new Set(release.bindingRetirements.map(retirement => retirement.token));
			for (const [token, binding] of [...this._bindings]) {
				if (retiredViews.has(binding.pageId) && !retiringTokens.has(token) && this._bindingAuthority.isOwnedToken(token)
					&& this._deleteActiveBinding(token, binding) !== undefined) {
					this._bindingAuthority.recordBindingMutation(token, undefined);
					this._promoteLatestUserSharedPage(token);
				}
			}
		}
		for (const retirement of release.bindingRetirements) {
			const active = this._bindings.get(retirement.token);
			if (!Object.is(active, retirement.bindingIdentity)) {
				let generation: number | undefined;
				if (active !== undefined) {
					this._bindings.delete(retirement.token);
					this._dispatchBackgroundThrottlingEffects(this._backgroundThrottlingCoordinator.releaseBinding(retirement.token));
					this._quarantinedBindings.add(active);
					generation = this._advanceBindingGeneration(retirement.token);
				}
				this._bindingAuthority.abandonBindingRetirement(retirement);
				// A retirement handle that no longer matches the live binding is a token-scoped
				// service/authority divergence, not a process-wide corruption. Isolate only this token
				// (block its rebind + ingress) and keep the rest of the authority live so a single window
				// close/reload/space switch can no longer stall every pane. Released on terminal exit or a
				// genuinely new pane lifecycle. Capture the quarantine record before token-local cleanup
				// deletes the pane shell entry we read the shellPid from.
				this._quarantineToken(retirement.token, active);
				this._runNonThrowingDiagnostic(() => this.logService.warn(
					`[ParadisAgentBrowser] processOwnerRelease: binding identity mismatch; quarantining pane ${this._tokenFingerprint(retirement.token)} generation=${generation ?? 'none'}`,
				));
				this._cleanupTokenLocalState(retirement.token, generation);
				continue;
			}
			if (!this._bindingAuthority.completeBindingRetirement(retirement)) {
				// The handle is stale because the token was re-bound to a new, legitimate owner after the
				// handle was issued (ABA), or the retirement was already consumed. The current binding and
				// authority state stay consistent, so preserve them and keep the authority live; do not
				// quarantine (the binding is a valid owner) and do not fault globally.
				preservedTokens.add(retirement.token);
				this._runNonThrowingDiagnostic(() => this.logService.warn(
					`[ParadisAgentBrowser] processOwnerRelease: completeBindingRetirement failed (superseded/stale handle); preserving pane ${this._tokenFingerprint(retirement.token)}`,
				));
				continue;
			}
			const generation = active === undefined
				? undefined
				: this._deleteActiveBinding(retirement.token, active);
			this._cleanupTokenLocalState(retirement.token, generation);
		}
		return preservedTokens;
	}

	private _cleanupRemainingWindowState(windowCtx: string, preservedTokens: ReadonlySet<string>): void {
		this._dropAgentTabGrants(grant => grant.windowCtx === windowCtx);
		for (const [token, binding] of [...this._bindings]) {
			if (binding.windowCtx === windowCtx && !preservedTokens.has(token)) {
				this._bindings.delete(token);
				this._dispatchBackgroundThrottlingEffects(this._backgroundThrottlingCoordinator.releaseBinding(token));
				this._quarantinedBindings.add(binding);
				// A binding still attached to a destroyed window that the authority never retired is a
				// token-scoped residual, not a reason to stop every other pane. Quarantine just this token
				// and keep the authority live; released on terminal exit or a genuinely new pane lifecycle.
				// Capture the quarantine record before the pane shell loop below deletes it.
				this._quarantineToken(token, binding);
				this._runNonThrowingDiagnostic(() => this.logService.warn(
					`[ParadisAgentBrowser] cleanupRemainingWindowState: residual binding for destroyed window ${windowCtx}; quarantining pane ${this._tokenFingerprint(token)}`,
				));
				this._cleanupTokenLocalState(token, this._advanceBindingGeneration(token));
			}
		}
		for (const [token, entry] of [...this._paneShells]) {
			if (entry.windowCtx === windowCtx && !preservedTokens.has(token)) {
				this._cleanupTokenLocalState(token);
			}
		}
	}

	/**
	 * Isolates a single token after a token-scoped divergence: blocks its rebind + ingress and records
	 * the quarantined binding (if any) plus the shell PID observed at quarantine time so the isolation
	 * can be lifted, and its capacity reclaimed, once the pane's lifecycle genuinely resets.
	 */
	private _quarantineToken(token: string, binding: IBindingEntry | undefined): void {
		this._faultedTokens.add(token);
		this._quarantinedTokenState.set(token, { binding, shellPid: this._paneShells.get(token)?.shellPid });
	}

	/**
	 * Lifts a token quarantine and reclaims the capacity its quarantined binding was holding. The binding
	 * was already removed from `_bindings`, had its generation advanced, and its gateway/devtools state
	 * retired at quarantine time, so nothing can reference it again once the pane lifecycle has reset.
	 */
	private _releaseTokenQuarantine(token: string): void {
		this._faultedTokens.delete(token);
		const record = this._quarantinedTokenState.get(token);
		if (record === undefined) {
			return;
		}
		this._quarantinedTokenState.delete(token);
		if (record.binding !== undefined) {
			this._quarantinedBindings.delete(record.binding);
		}
	}

	/**
	 * Releases a quarantine only when the token re-enters as a genuinely new pane lifecycle, identified by
	 * a shell PID that differs from the one seen at quarantine time. The same shell re-syncing (e.g. a
	 * still-diverged window) keeps the isolation, so this never nullifies the quarantine.
	 */
	private _maybeReleaseQuarantineOnFreshShell(token: string, shellPid: number): void {
		const record = this._quarantinedTokenState.get(token);
		if (record === undefined || record.shellPid === shellPid) {
			return;
		}
		this._releaseTokenQuarantine(token);
	}

	/** hook から、そのペインで動いている会話を控える（`_paneSessions`）。 */
	private _recordPaneSession(token: string, eventType: string, sessionId: string | undefined, transcriptPath: string | undefined, cwd: string | undefined): void {
		if (eventType === 'SessionEnd' || eventType === 'TerminalExit') {
			this._paneSessions.delete(token);
			return;
		}
		if (sessionId === undefined || sessionId.length === 0 || sessionId.length > 500) {
			return;
		}
		const previous = this._paneSessions.get(token);
		const agent = transcriptPath !== undefined
			? paradisHookAgentKindForTranscript(transcriptPath)
			: previous?.agent;
		if (agent === undefined) {
			return;
		}
		// 同じ会話の間は最初に報告された作業ディレクトリを使い続ける。後の hook の cwd は、ツールが
		// `cd` した先になることがあり、分岐（`claude --resume <id> --fork-session`）がそこでは会話を
		// 見つけられない（Claude Code は会話をプロジェクトのフォルダごとに持つ）。
		const nextCwd = previous?.sessionId === sessionId ? (previous.cwd ?? cwd) : cwd;
		this._paneSessions.set(token, { agent, sessionId, at: Date.now(), ...(nextCwd !== undefined ? { cwd: nextCwd } : {}) });
	}

	/**
	 * エージェントが止まって利用者の次の指示を待っているペイン（許可を拒否された等）を、状態なし（idle）へ移す。
	 * 許可待ち・作業中のときだけ動かす。確認待ち（review）にはしない（review は完了の通知の対象）。
	 */
	private _settlePaneTurnEnded(token: string, at: number, cause: ParadisAgentTurnEndCause): void {
		const ingressLease = this.captureIngressLease(token);
		if (ingressLease === undefined || this._programStatusTokens.has(token)) {
			return;
		}
		const entry = this._paneStatuses.get(token);
		// CLI が終わったのに許可待ち・質問中のままだと（承認待ちで Ctrl+C・異常終了）、答える相手が居ないのに
		// 鈴・件数・スリープ防止が残る。完了ではないので確認待ち（review）ではなく状態なし（idle）へ移す。
		if (cause === 'cli-exit' && (entry?.status === 'permission' || entry?.status === 'question')) {
			this._settlePaneAwaitingUser(token, true);
			return;
		}
		if (entry === undefined || entry.status !== 'working') {
			return;
		}
		if (!this.isIngressLeaseCurrent(ingressLease)) {
			return;
		}
		if (paradisCountLiveBackgroundTasks(token, at) > 0) {
			this._paneStatuses.set(token, { ...entry, changedAt: at, backgroundCompletionFallback: true });
		} else {
			this._paneStatuses.set(token, this._reviewEntry(token, at, entry.cwd));
		}
	}

	/**
	 * @param includeQuestion 質問中も解く（CLI が終わったとき）。許可の拒否では質問中は触らない
	 */
	private _settlePaneAwaitingUser(token: string, includeQuestion: boolean = false): void {
		const ingressLease = this.captureIngressLease(token);
		if (ingressLease === undefined || this._programStatusTokens.has(token)) {
			return;
		}
		const entry = this._paneStatuses.get(token);
		if (entry === undefined || (entry.status !== 'permission' && entry.status !== 'working' && !(includeQuestion && entry.status === 'question'))) {
			return;
		}
		if (!this.isIngressLeaseCurrent(ingressLease)) {
			return;
		}
		this._activityApprovalTokens.delete(token);
		this._paneStatuses.delete(token);
		this._awaitingUserTokens.add(token);
	}

	private _cleanupTokenLocalState(token: string, generation?: number, preserveTerminalExit: boolean = false): void {
		// サイトメモを添え終えた控え（E4）
		this._siteNotesShown?.delete(token);
		this._siteNoteSpaces?.delete(token);
		// 操作の後に添えたブラウザの状態の控え（ペインとそのタブごと）
		this._browserObserver.forget(token);
		this._runNonThrowingCleanup('agent-tabs', () => this._forgetAgentTabState(token));
		const cleanupGeneration = generation ?? this._advanceBindingGeneration(token);
		this._paneShells.delete(token);
		this._paneRemoteAuthorities.delete(token);
		this._remotePaneWindows.delete(token);
		this._paneStatuses.delete(token);
		this._userTurnStarts.delete(token);
		this._announcedReviews.delete(token);
		paradisClaudeModBridge.forgetToken(token);
		this._paneSessions.delete(token);
		this._activityApprovalTokens.delete(token);
		this._awaitingUserTokens.delete(token);
		this._agentHookTokens.delete(token);
		this._hookReportedTokens.delete(token);
		this._programStatusTokens.delete(token);
		this._programStatusTimes.delete(token);
		this._replayedPrompts.delete(token);
		this._hookSpoolCheckedTokens.delete(token);
		this._unconfirmedReleaseTokens.delete(token);
		this._unconfirmableTokens.delete(token);
		this._seenTokens.delete(token);
		if (!preserveTerminalExit) {
			this._terminalExitedTokens.delete(token);
		}
		this._runNonThrowingCleanup('activity', () => clearParadisAgentPaneActivity(token));
		this._runNonThrowingCleanup('issue-urls', () => clearParadisAgentPaneIssueUrls(token));
		this._runNonThrowingCleanup('gateway', () => this._cdpGateway.retireToken(token));
		this._runNonThrowingCleanup('devtools', () => this._devtoolsGenerationCoordinator.forgetWhenIdle(token, cleanupGeneration));
	}

	private _advanceBindingGeneration(token: string, cancelPendingForget: boolean = false): number {
		const generation = ++this._nextBindingGeneration;
		this._activateBindingGeneration(token, generation, cancelPendingForget);
		return generation;
	}

	/**
	 * `token` はペインのトークン（共有の世代）か、タブのスコープキー（そのタブの世代）。ペインのトークンのときは、
	 * 共有が変わったのに合わせて、タブのスコープのうち裏の entry が変わったものだけを切り直す。
	 */
	private _activateBindingGeneration(token: string, generation: number, cancelPendingForget: boolean): void {
		this._runNonThrowingCleanup('generation', () => this._devtoolsGenerationCoordinator.setGeneration(token, generation, cancelPendingForget));
		this._runNonThrowingCleanup('gateway-connections', () => this._cdpGateway.closeConnectionsForToken(token));
		this._runNonThrowingCleanup('devtools-retire', () => this._devtoolsProxy.retire(token, generation));
		// 共有が入れ替わったら、そのペインがタブへ掛けた上書き（ヘッダ・認証・ルール）を外す
		this._runNonThrowingCleanup('page-ops-release', () => this._pageOps.releaseOwner(token, generation));
		if (paradisParseAgentTabScopeKey(token).tabId === undefined) {
			this._runNonThrowingCleanup('tab-scopes', () => this._reconcileTabScopes(token));
		}
	}

	// --- エージェントのタブの許可と、タブのスコープ ---

	/** そのペインからそのタブを使うときの entry。許可を先に見る（共有が付け替わっても許可のタブは切らない）。 */
	private _scopeBinding(token: string, tabId: string): IBindingEntry | undefined {
		const grant = this._agentTabGrants.get(token)?.get(tabId);
		if (grant !== undefined && this._bindingAuthority.isViewOwnedWithToken(token, tabId)) {
			return grant;
		}
		const primary = this._bindings.get(token);
		return primary?.pageId === tabId ? primary : undefined;
	}

	/** キー（ペインのトークン、またはスコープキー）の entry。トークンだけなら共有中のページ。 */
	private _bindingForKey(key: string): IBindingEntry | undefined {
		const { token, tabId } = paradisParseAgentTabScopeKey(key);
		return tabId === undefined ? this._bindings.get(token) : this._scopeBinding(token, tabId);
	}

	/** tab_id を省いたときのタブ。選んだタブがまだ使えればそれ、無ければ共有のページ。 */
	private _defaultTabId(token: string): string | undefined {
		const selected = this._selectedTabs.get(token);
		if (selected !== undefined && this._scopeBinding(token, selected) !== undefined) {
			return selected;
		}
		return this._bindings.get(token)?.pageId;
	}

	/** lease のページのキー（tab_id を解決していなければペインのトークン）。 */
	private _pageKeyOf(ingressLease: IParadisAgentBrowserIngressLease): string {
		return ingressLease.pageKey ?? ingressLease.token;
	}

	/**
	 * ツールの呼び出しの tab_id（省略可）から、使うタブのスコープを決めた lease を作る。tab_id がこのペインの
	 * 使えるタブでなければエラーの結果を返す。tab_id が無く、共有も選んだタブも無いときはスコープ無しの lease
	 * （これまでどおり「共有がありません」の案内になる）。
	 */
	private _scopeToolCall(ingressLease: IParadisAgentBrowserIngressLease, args: unknown): { readonly ok: true; readonly lease: IParadisAgentBrowserIngressLease; readonly args: unknown; readonly tabId?: string } | { readonly ok: false; readonly error: unknown } {
		const taken = paradisTakeTabIdArgument(args);
		if (taken.invalid) {
			return { ok: false, error: this._toolError(`"${PARADIS_TAB_ID_ARGUMENT}" must be a tabId string from list_browser_tabs or open_browser_tab.`) };
		}
		const token = ingressLease.token;
		const tabId = taken.tabId ?? this._defaultTabId(token);
		if (tabId === undefined) {
			return { ok: true, lease: ingressLease, args: taken.rest };
		}
		const binding = this._scopeBinding(token, tabId);
		if (binding === undefined) {
			return { ok: false, error: this._toolError(`Tab ${tabId} is not a tab this terminal pane can use (it was closed, the user stopped sharing it, or it belongs to another pane). Call list_browser_tabs for the tabs you can pass as ${PARADIS_TAB_ID_ARGUMENT}.`) };
		}
		const pageKey = paradisAgentTabScopeKey(token, tabId);
		this._noteTabScope(token, tabId, binding);
		const ownerLease = this._ingressLeaseStates.get(ingressLease);
		if (ownerLease === undefined) {
			throw new ParadisIngressLeaseError();
		}
		const scoped: IParadisAgentBrowserIngressLease = Object.freeze({ token, pageKey });
		this._ingressLeaseStates.set(scoped, ownerLease);
		return { ok: true, lease: scoped, args: taken.rest, tabId };
	}

	/** そのタブのスコープを使い始めた。前に使ったときと裏の entry が違えば、そのスコープだけ切り直す。 */
	private _noteTabScope(token: string, tabId: string, binding: IBindingEntry): void {
		let scopes = this._tabScopes.get(token);
		if (scopes?.get(tabId) === binding.generation) {
			return;
		}
		if (scopes === undefined) {
			scopes = new Map();
			this._tabScopes.set(token, scopes);
		}
		scopes.set(tabId, binding.generation);
		this._activateBindingGeneration(paradisAgentTabScopeKey(token, tabId), binding.generation, true);
	}

	/**
	 * 共有の付け替え・許可の増減・ペインの片付けの後に呼ぶ。使えなくなったスコープは子プロセス・接続・ページの
	 * 上書きを片付け、裏の entry が変わったスコープだけを切り直す（ほかのタブの接続は切らない）。
	 */
	private _reconcileTabScopes(token: string): void {
		const selected = this._selectedTabs.get(token);
		if (selected !== undefined && this._scopeBinding(token, selected) === undefined) {
			this._selectedTabs.delete(token);
		}
		const scopes = this._tabScopes.get(token);
		if (scopes === undefined) {
			return;
		}
		for (const [tabId, generation] of [...scopes]) {
			const key = paradisAgentTabScopeKey(token, tabId);
			const binding = this._scopeBinding(token, tabId);
			if (binding === undefined) {
				scopes.delete(tabId);
				this._retireTabScope(key);
			} else if (binding.generation !== generation) {
				scopes.set(tabId, binding.generation);
				this._activateBindingGeneration(key, binding.generation, true);
			}
		}
		if (scopes.size === 0) {
			this._tabScopes.delete(token);
		}
	}

	private _retireTabScope(key: string): void {
		const generation = this._advanceBindingGeneration(key);
		this._runNonThrowingCleanup('tab-scope-devtools', () => this._devtoolsGenerationCoordinator.forgetWhenIdle(key, generation));
		this._runNonThrowingCleanup('tab-scope-gateway', () => this._cdpGateway.retireToken(key));
		this._inputRejections.forget(key);
	}

	/** ペインが片付いた。許可・選んだタブ・タブのスコープをすべて外す。 */
	private _forgetAgentTabState(token: string): void {
		this._selectedTabs.delete(token);
		const grants = this._agentTabGrants.get(token);
		if (grants !== undefined) {
			this._agentTabGrants.delete(token);
			for (const tabId of grants.keys()) {
				this._dispatchBackgroundThrottlingEffects(this._backgroundThrottlingCoordinator.releaseBinding(paradisAgentTabScopeKey(token, tabId)));
			}
		}
		const scopes = this._tabScopes.get(token);
		if (scopes !== undefined) {
			this._tabScopes.delete(token);
			for (const tabId of scopes.keys()) {
				this._retireTabScope(paradisAgentTabScopeKey(token, tabId));
			}
		}
	}

	/** 許可を外す（ビューが消えた・ペインが閉じた・ユーザーが共有を止めた）。外したら true。 */
	private _deleteAgentTabGrant(token: string, tabId: string): boolean {
		if (this._agentTabGrants.get(token)?.has(tabId) !== true) {
			return false;
		}
		this._dispatchBackgroundThrottlingEffects(this._removeAgentTabGrantEntry(token, tabId));
		return true;
	}

	/** 許可の entry を外し、描画止めの効果を返す（送るのは呼び出し側）。 */
	private _removeAgentTabGrantEntry(token: string, tabId: string): readonly IParadisExactViewBackgroundThrottlingEffect[] {
		const grants = this._agentTabGrants.get(token);
		if (grants === undefined || !grants.delete(tabId)) {
			return [];
		}
		if (grants.size === 0) {
			this._agentTabGrants.delete(token);
		}
		return this._backgroundThrottlingCoordinator.releaseBinding(paradisAgentTabScopeKey(token, tabId));
	}

	// --- ユーザーが 1 つのペインへ共有した 2 枚目以降のページ ---

	/** そのペインへユーザーが共有している 2 枚目以降のページ（current を除く）。 */
	private _userSharedPageEntries(token: string): IBindingEntry[] {
		return [...(this._agentTabGrants.get(token)?.values() ?? [])].filter(grant => grant.userShared === true);
	}

	/** そのタブが、そのペインのエージェントが自分で開いたタブ（許可）か。 */
	private _isAgentOwnTab(token: string, tabId: string): boolean {
		const grant = this._agentTabGrants.get(token)?.get(tabId);
		return grant !== undefined && (!grant.userShared || grant.agentTab === true);
	}

	/** ユーザーの共有を外した後に残す許可（エージェントのタブでもあった entry だけ）。 */
	private _agentTabEntryOf(entry: IBindingEntry): IBindingEntry | undefined {
		if (!entry.agentTab) {
			return undefined;
		}
		const { userShared: _userShared, agentTab: _agentTab, ...rest } = entry;
		return Object.freeze(rest);
	}

	/**
	 * 2 枚目以降の共有の entry からユーザーの共有を外す。エージェントのタブでもあれば許可へ戻し（世代も描画止めも
	 * そのまま）、そうでなければ entry を外す。描画止めの効果を返す。
	 */
	private _releaseUserSharedEntry(token: string, entry: IBindingEntry): readonly IParadisExactViewBackgroundThrottlingEffect[] {
		const agentEntry = this._agentTabEntryOf(entry);
		if (agentEntry !== undefined) {
			this._agentTabGrants.get(token)?.set(entry.pageId, agentEntry);
			return [];
		}
		return this._removeAgentTabGrantEntry(token, entry.pageId);
	}

	/**
	 * 2 枚目以降の共有が current へ上がる（同じビューのまま世代だけ変わる）。そのタブを tab_id で使っているスコープの
	 * 世代を先に書き換えて、`_reconcileTabScopes` がゲートウェイの接続とページの上書きを切らないようにする（current から
	 * 外れるときも切らないので、それと揃える）。devtools の子プロセスは世代に結びつくので作り直す。ビューが変わっていれば
	 * 全部切る。
	 */
	private _keepTabScope(token: string, previous: IBindingEntry, next: IBindingEntry): void {
		const scopes = this._tabScopes.get(token);
		// エージェントのタブでもあった entry は許可へ戻り、そのタブのスコープは許可（元の世代）を指したままになる
		if (!previous.agentTab && scopes?.get(previous.pageId) === previous.generation && this._sameExactView(previous.exactView, next.exactView)) {
			scopes.set(previous.pageId, next.generation);
			// devtools の道具は世代を見る（`_callDevtoolsTool`）ので、そのスコープの世代は進める。子プロセスは
			// 新しい世代で作り直される。切らないのはゲートウェイの接続と、エージェントが掛けたヘッダ・認証・ルール
			// （`_activateBindingGeneration` の closeConnectionsForToken と `_pageOps.releaseOwner`）だけ
			const key = paradisAgentTabScopeKey(token, previous.pageId);
			this._runNonThrowingCleanup('generation', () => this._devtoolsGenerationCoordinator.setGeneration(key, next.generation, true));
			this._runNonThrowingCleanup('devtools-retire', () => this._devtoolsProxy.retire(key, next.generation));
		}
	}

	/**
	 * 2 枚目以降の共有が、受理済みの最新の manifest で今も使えるか。current へ繰り上げる前に確かめる。
	 * - `usable`: ペインとページが同じウィンドウにあり、どちらの確定したスペースも共有したときと同じ
	 * - `gone`: ページがペインのウィンドウに無い、またはどちらかのスペースが変わったと確定した（外してよい）
	 * - `unknown`: 確かめられない（再読み込みの途中で接続や manifest が無い、不完全な manifest に載っていない）。
	 *   外さずに残し、繰り上げは manifest が揃ったとき（{@link syncBindingAuthority}）に見直す
	 */
	private _userSharedEntryState(token: string, entry: IBindingEntry): 'usable' | 'gone' | 'unknown' {
		if (!this._bindingAuthority.isViewOwnedWithToken(token, entry.pageId)) {
			return 'gone';
		}
		const connection = this._rendererConnections.get(entry.windowCtx);
		if (connection === undefined) {
			return 'unknown';
		}
		let manifest: IParadisBindingAuthorityManifest;
		try {
			manifest = this._bindingAuthority.getCurrentAcceptedManifest(connection);
		} catch {
			return 'unknown';
		}
		const paneScope = manifest.panes.find(pane => pane.token === token)?.scope;
		const viewScope = manifest.browserViews.find(view => view.viewId === entry.pageId)?.scope;
		if ((paneScope !== undefined && paradisScopeMovedFrom(paneScope, entry.scope))
			|| (viewScope !== undefined && paradisScopeMovedFrom(viewScope, entry.scope))) {
			return 'gone';
		}
		if (paneScope === undefined || viewScope === undefined) {
			// 完全な manifest に無いものは retire 済み（ここへは来ない）。不完全な manifest では判定しない
			return manifest.complete ? 'gone' : 'unknown';
		}
		return 'usable';
	}

	/** そのページを、ユーザーがそのペインへ共有しているか（current か 2 枚目以降か）。 */
	private _isUserSharedPage(token: string, pageId: string): boolean {
		return this._bindings.get(token)?.pageId === pageId || this._agentTabGrants.get(token)?.get(pageId)?.userShared === true;
	}

	/** そのページを共有したら、そのペインの共有が何枚になるか。 */
	private _userSharedPageCountAfterBind(token: string, viewId: string): number {
		const pages = new Set(this._userSharedPageEntries(token).map(entry => entry.pageId));
		const primary = this._bindings.get(token);
		if (primary !== undefined) {
			pages.add(primary.pageId);
		}
		pages.add(viewId);
		return pages.size;
	}

	/**
	 * current から外れたページを、2 枚目以降の共有として許可へ置く。エージェントが同じタブの許可を持っていれば、
	 * それを置き換える（1 つのタブの entry はペインごとに 1 つ）。描画止めの効果を返す。
	 */
	private _putUserSharedPage(token: string, entry: IBindingEntry): readonly IParadisExactViewBackgroundThrottlingEffect[] {
		let grants = this._agentTabGrants.get(token);
		if (grants === undefined) {
			grants = new Map();
			this._agentTabGrants.set(token, grants);
		}
		// エージェントが自分で開いたタブの許可を持っていれば、その印を残す（共有を外したら許可へ戻す）
		const agentTab = grants.get(entry.pageId)?.userShared === undefined && grants.has(entry.pageId);
		grants.set(entry.pageId, Object.freeze({ ...entry, userShared: true, ...(agentTab ? { agentTab: true } : {}) }));
		return this._backgroundThrottlingCoordinator.setBinding(paradisAgentTabScopeKey(token, entry.pageId), entry.exactView);
	}

	/** 2 枚目以降の共有のうち、その世代のものを外す。外したら true。 */
	private _deleteUserSharedPageIfCurrent(token: string, generation: number): boolean {
		const entry = this._userSharedPageEntries(token).find(candidate => candidate.generation === generation);
		if (entry === undefined) {
			return false;
		}
		this._dispatchBackgroundThrottlingEffects(this._releaseUserSharedEntry(token, entry));
		this._reconcileTabScopes(token);
		return true;
	}

	/** 2 枚目以降の共有をすべて外す（ペイン単位の解除）。外したものがあれば true。 */
	private _dropUserSharedPages(token: string): boolean {
		let removed = false;
		for (const entry of this._userSharedPageEntries(token)) {
			this._dispatchBackgroundThrottlingEffects(this._releaseUserSharedEntry(token, entry));
			removed = true;
		}
		if (removed) {
			this._reconcileTabScopes(token);
		}
		return removed;
	}

	/**
	 * current が外れた後に呼ぶ。2 枚目以降の共有のうち最後に共有したものを current（`_bindings`）へ戻す。
	 * ペインがもう使えない（閉じた・隔離した・終わった）ときは何もしない（許可はペインの片付けで外れる）。
	 */
	private _promoteLatestUserSharedPage(token: string): void {
		if (this._bindings.has(token) || this._faultedTokens.has(token) || this._terminalExitedTokens.has(token)
			|| !this._bindingAuthority.isOwnedToken(token)) {
			return;
		}
		// 世代は共有するたびに進み、current から外れても変わらないので、大きいほど後に共有したもの。
		// 繰り上げる前に、今も使えるか（ペインやページのスペースが変わっていない・ビューが消えていない）を確かめ、
		// 使えないものは外して次を見る（別のスペースのページや消えたページを current にしない）
		// 確かめられない候補があれば、そこで繰り上げを見送る（残りも消さない。manifest が揃ったら見直す）
		let latest: IBindingEntry | undefined;
		let removed = false;
		for (const candidate of this._userSharedPageEntries(token).sort((a, b) => b.generation - a.generation)) {
			const state = this._userSharedEntryState(token, candidate);
			if (state === 'usable') {
				latest = candidate;
				break;
			}
			if (state === 'unknown') {
				break;
			}
			this._dispatchBackgroundThrottlingEffects(this._removeAgentTabGrantEntry(token, candidate.pageId));
			removed = true;
		}
		if (latest === undefined) {
			if (removed) {
				this._reconcileTabScopes(token);
			}
			return;
		}
		const generation = ++this._nextBindingGeneration;
		const binding: IBindingEntry = Object.freeze({
			windowCtx: latest.windowCtx,
			pageId: latest.pageId,
			pageInfo: latest.pageInfo,
			generation,
			boundAt: latest.boundAt,
			exactView: latest.exactView,
			scope: latest.scope,
		});
		this._bindings.set(token, binding);
		this._bindingAuthority.recordBindingMutation(token, binding);
		const throttlingEffects = [
			...this._backgroundThrottlingCoordinator.setBinding(token, binding.exactView),
			...this._releaseUserSharedEntry(token, latest),
		];
		this._keepTabScope(token, latest, binding);
		this._activateBindingGeneration(token, generation, true);
		this._dispatchBackgroundThrottlingEffects(throttlingEffects);
		this._runNonThrowingDiagnostic(() => this.logService.debug(
			`[ParadisAgentBrowser] Promoted the latest shared page of pane ${this._tokenFingerprint(token)} generation=${generation}`,
		));
	}

	/** 条件に合う許可を外し、外したペインのタブのスコープを片付ける。 */
	private _dropAgentTabGrants(predicate: (grant: IBindingEntry, token: string) => boolean): void {
		for (const [token, grants] of [...this._agentTabGrants]) {
			let changed = false;
			for (const [tabId, grant] of [...grants]) {
				if (predicate(grant, token)) {
					changed = this._deleteAgentTabGrant(token, tabId) || changed;
				}
			}
			if (changed) {
				this._runNonThrowingCleanup('agent-tab-drop', () => this._reconcileTabScopes(token));
			}
		}
	}

	/**
	 * 受け取った manifest で、許可したタブかペインの（確定した）スペースが許可したときと変わっていたら外す。
	 * 共有（バインド）で renderer がスペースの変化に合わせて解除するのと同じ扱い。切替の途中（pending）は外さない。
	 */
	private _dropAgentTabGrantsOutOfScope(manifest: IParadisBindingAuthorityManifest): void {
		const paneScopes = new Map(manifest.panes.map(pane => [pane.token, pane.scope] as const));
		const viewScopes = new Map(manifest.browserViews.map(view => [view.viewId, view.scope] as const));
		const moved = (current: IParadisBindingAuthorityManifest['panes'][number]['scope'] | undefined, granted: ParadisBindingAuthorityStableScope) =>
			current !== undefined && paradisScopeMovedFrom(current, granted);
		this._dropAgentTabGrants((grant, token) => moved(paneScopes.get(token), grant.scope) || moved(viewScopes.get(grant.pageId), grant.scope));
	}

	private _agentTabGrantCount(): number {
		let count = 0;
		for (const grants of this._agentTabGrants.values()) {
			count += grants.size;
		}
		return count;
	}

	/** 背景の描画止めの coordinator が持っているはずの一覧（共有と許可）。 */
	private _throttlingRegistry(): (readonly [string, IParadisExactBrowserViewDescriptor])[] {
		const registry: (readonly [string, IParadisExactBrowserViewDescriptor])[] = Array.from(this._bindings, ([token, binding]) => [token, binding.exactView] as const);
		for (const [token, grants] of this._agentTabGrants) {
			for (const [tabId, grant] of grants) {
				registry.push([paradisAgentTabScopeKey(token, tabId), grant.exactView] as const);
			}
		}
		return registry;
	}

	/**
	 * renderer から: エージェントが自分で開いたタブを、そのペインが tab_id で使えるようにする（共有は付け替えない）。
	 * 確かめ方は prepareBind と同じ（ペインとタブが同じウィンドウ・同じスコープ、exactView を main で固定）。
	 */
	async grantAgentTab(connection: object, request: IParadisGrantAgentTabRequest): Promise<boolean> {
		const windowCtx = this._requireCurrentRendererConnection(connection);
		const parsedWindow = parseRendererWindowContext(windowCtx);
		const pageInfo = copySharedPageInfo(request.pageInfo);
		const { token, viewId } = request;
		if (parsedWindow === undefined || pageInfo === undefined || !paradisIsValidAgentTabId(viewId)
			|| this._faultedTokens.has(token) || this._terminalExitedTokens.has(token)) {
			return false;
		}
		let snapshot: IParadisBindingPrepareSnapshot;
		try {
			snapshot = this._bindingAuthority.capturePrepareSnapshot(connection, request.revision, token, viewId);
		} catch {
			return false;
		}
		if (this._pendingBindPreparations >= MAX_PENDING_BIND_PREPARATIONS) {
			return false;
		}
		let exactView: IParadisExactBrowserViewDescriptor | undefined;
		this._pendingBindPreparations++;
		try {
			const resolved = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<unknown>('resolveExactViewDescriptor', [parsedWindow.windowId, viewId]);
			this._requireCurrentRendererConnection(connection);
			exactView = paradisParseExactBrowserViewDescriptor(resolved);
		} catch {
			return false;
		} finally {
			this._pendingBindPreparations--;
		}
		if (exactView === undefined || exactView.windowId !== parsedWindow.windowId || exactView.viewId !== viewId
			|| !this._bindingAuthority.isPrepareSnapshotCurrent(snapshot)
			|| this._faultedTokens.has(token) || this._terminalExitedTokens.has(token)) {
			return false;
		}
		const grants = this._agentTabGrants.get(token);
		const existing = grants?.get(viewId);
		// ユーザーがこのペインへ共有しているページなら、もう tab_id で使える（共有の印を消さない）
		if (existing !== undefined && (existing.userShared || JSON.stringify(existing.exactView) === JSON.stringify(exactView))) {
			return true;
		}
		const agentGrantCount = [...(grants?.values() ?? [])].filter(grant => !grant.userShared || grant.agentTab).length;
		if (existing === undefined
			&& (agentGrantCount >= PARADIS_AGENT_TAB_LIMIT
				|| this._bindings.size + this._quarantinedBindings.size + this._agentTabGrantCount() >= MAX_EXTERNAL_BINDINGS)) {
			return false;
		}
		const key = paradisAgentTabScopeKey(token, viewId);
		try {
			this._backgroundThrottlingCoordinator.assertCanSetBinding(this._throttlingRegistry(), key, exactView);
		} catch {
			this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] grantAgentTab: coordinator/registry mismatch for pane ${this._tokenFingerprint(token)}; not granting`));
			return false;
		}
		const generation = ++this._nextBindingGeneration;
		const grant: IBindingEntry = Object.freeze({
			windowCtx,
			pageId: viewId,
			pageInfo,
			generation,
			boundAt: Date.now(),
			exactView,
			scope: snapshot.scope,
		});
		let tokenGrants = grants;
		if (tokenGrants === undefined) {
			tokenGrants = new Map();
			this._agentTabGrants.set(token, tokenGrants);
		}
		tokenGrants.set(viewId, grant);
		this._dispatchBackgroundThrottlingEffects(this._backgroundThrottlingCoordinator.setBinding(key, exactView));
		this._reconcileTabScopes(token);
		this._runNonThrowingDiagnostic(() => this.logService.debug(`[ParadisAgentBrowser] Granted an agent tab to pane ${this._tokenFingerprint(token)} generation=${generation}`));
		return true;
	}

	/** renderer から: エージェントのタブの許可を外す（タブを閉じた・ユーザーが共有を止めた）。 */
	async revokeAgentTab(connection: object, token: string, viewId: string): Promise<boolean> {
		// ユーザーが共有したページはエージェントのタブの取り消しでは外さない（外すのは共有の解除）。エージェントの
		// タブの印だけを外す
		const existing = this._agentTabGrants.get(token)?.get(viewId);
		if (existing?.userShared) {
			if (!existing.agentTab || !this._isEligibleToken(connection, token)) {
				return false;
			}
			const { agentTab: _agentTab, ...rest } = existing;
			this._agentTabGrants.get(token)?.set(viewId, Object.freeze(rest));
			return true;
		}
		if (!this._isEligibleToken(connection, token) || !this._deleteAgentTabGrant(token, viewId)) {
			return false;
		}
		this._reconcileTabScopes(token);
		return true;
	}

	/** renderer の共有の表示用: このウィンドウのペインに許可しているエージェントのタブ。 */
	async listAgentTabGrants(connection: object): Promise<IParadisAgentTabGrant[]> {
		const windowCtx = this._requireCurrentRendererConnection(connection);
		const eligibleTokens = this._currentEligibleTokens(connection);
		const result: IParadisAgentTabGrant[] = [];
		for (const [token, grants] of this._agentTabGrants) {
			if (!eligibleTokens.has(token)) {
				continue;
			}
			for (const grant of grants.values()) {
				// ユーザーが共有したページは listBindings に載せる（ここはエージェントのタブだけ）
				if (grant.windowCtx === windowCtx && (!grant.userShared || grant.agentTab)) {
					result.push({ token, pageId: grant.pageId });
				}
			}
		}
		return result;
	}

	/** ゲートウェイ向けの lease。スコープキーなら、そのペインがそのタブを今使えるときだけ発行する。 */
	private _captureGatewayLease(key: string): IParadisAgentBrowserIngressLease | undefined {
		const { token, tabId } = paradisParseAgentTabScopeKey(key);
		const paneLease = this.captureIngressLease(token);
		if (paneLease === undefined || tabId === undefined) {
			return paneLease;
		}
		const binding = this._scopeBinding(token, tabId);
		if (binding === undefined) {
			return undefined;
		}
		this._noteTabScope(token, tabId, binding);
		const lease: IParadisAgentBrowserIngressLease = Object.freeze({ token: key });
		this._gatewayScopedLeases.set(lease, paneLease);
		return lease;
	}

	private _isGatewayLeaseCurrent(lease: IParadisAgentBrowserIngressLease): boolean {
		const paneLease = this._gatewayScopedLeases.get(lease);
		if (paneLease === undefined) {
			return this.isIngressLeaseCurrent(lease);
		}
		return this.isIngressLeaseCurrent(paneLease) && this._bindingForKey(lease.token) !== undefined;
	}

	private _dispatchBackgroundThrottlingEffects(effects: readonly IParadisExactViewBackgroundThrottlingEffect[]): void {
		if (effects.length === 0) {
			return;
		}
		this._getBackgroundThrottlingDispatcher().dispatchEffects(effects);
	}

	private _getBackgroundThrottlingDispatcher(): ParadisExactViewBackgroundThrottlingDispatcher {
		return this._backgroundThrottlingDispatcher ??= new ParadisExactViewBackgroundThrottlingDispatcher({
			apply: async effect => this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<boolean>('setExactViewBackgroundThrottling', [effect.descriptor, effect.enabled]),
			onDisableFailure: descriptor => this._retireBindingsForUnavailableExactView(descriptor),
			onDiagnostic: (error, effect) => this._runNonThrowingDiagnostic(() => this.logService.debug(
				`[ParadisAgentBrowser] exact BrowserView background throttling update failed enabled=${effect.enabled}`,
				error,
			)),
		});
	}

	/** Removes only identities that are still the current generation when Main reports the exact view absent. */
	private _retireBindingsForUnavailableExactView(descriptor: IParadisExactBrowserViewDescriptor): void {
		if (this._serverDisposed) {
			return;
		}
		// 2 枚目以降として共有していたそのビューを先に外す（current の繰り上げ先に選ばないように）
		this._dropAgentTabGrants(grant => grant.userShared === true && this._sameExactView(grant.exactView, descriptor));
		for (const [token, binding] of [...this._bindings]) {
			if (!this._sameExactView(binding.exactView, descriptor)
				|| !paradisBindingMatchesGeneration(this._bindings.get(token), binding.generation)) {
				continue;
			}
			const retiredGeneration = this._deleteActiveBinding(token, binding);
			if (retiredGeneration === undefined) {
				continue;
			}
			this._bindingAuthority.recordBindingMutation(token, undefined);
			this._promoteLatestUserSharedPage(token);
		}
	}

	private _sameExactView(
		left: IParadisExactBrowserViewDescriptor,
		right: IParadisExactBrowserViewDescriptor,
	): boolean {
		return left.windowId === right.windowId
			&& left.viewId === right.viewId
			&& left.targetId === right.targetId
			&& left.viewLease === right.viewLease;
	}

	private _runNonThrowingCleanup(kind: string, action: () => void): void {
		try {
			action();
		} catch (error) {
			try {
				this.logService.warn(`[ParadisAgentBrowser] Ignored ${kind} cleanup failure`, error);
			} catch {
				// Cleanup must remain non-throwing even if the logger itself is unavailable during teardown.
			}
		}
	}

	private _runNonThrowingDiagnostic(action: () => void): void {
		try {
			action();
		} catch {
			// Diagnostics must never alter request, lifecycle, or cleanup semantics.
		}
	}

	private _tokenFingerprint(token: string): string {
		return createHash('sha256').update(token).digest('hex').slice(0, 12);
	}

	/**
	 * 捨てた hook を数え、ペイン・理由の組ごとに初回と件数が 2 の累乗のときだけログに出す。
	 * 診断専用（hook の扱いは変えない）。会話のパスと token そのものは出さない。
	 */
	private _noteAgentHookDrop(build: () => IParadisAgentHookDropRecord): void {
		this._runNonThrowingDiagnostic(() => {
			const record = build();
			const count = this._hookDrops.note(record.pane, record.reason);
			if (count.emit) {
				this.logService.info(`[ParadisAgentBrowser] ${paradisFormatHookDropLog(record, count.paneCount, count.reasonTotal)}`);
			}
		});
	}

	/** hook が手元か接続先か、pid が来たか（`_handleAgentHook` の pid の扱いと同じ読み方）。 */
	private _agentHookDropSource(url: URL, token: string | undefined): Pick<IParadisAgentHookDropRecord, 'side' | 'pid'> {
		const remote = paradisIsAgentHookRemoteHostId(url.searchParams.get(PARADIS_AGENT_HOOK_REMOTE_HOST_PARAM))
			|| (token !== undefined && this._paneShells.get(token)?.remoteAuthority !== undefined);
		const pidParam = url.searchParams.get('pid');
		const pidSent = pidParam !== null && /^\d{1,10}$/.test(pidParam);
		return { side: remote ? 'remote' : 'local', pid: !pidSent ? 'absent' : remote ? 'stripped' : 'sent' };
	}

	/** 受け口で hook を断った（または処理の途中で印が使えなくなった）ときに数える。 */
	private _noteAgentHookIngressDrop(req: http.IncomingMessage, token: string | undefined, stage: 'ingress' | 'lease-lost', status: number): void {
		this._noteAgentHookDrop(() => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const lockedCause = this._agentHookIngressCause(token);
			// 503 は「まだ同期していないだけかもしれない」ペイン。印そのものが断られている理由があればそちらを出す
			const cause: ParadisHookIngressCause = status === 503 && lockedCause === 'unknown-pane' ? 'unsynced' : lockedCause;
			// 知っているペイン（シェルの記録がある・終わった・隔離した）だけ token ごとに分け、知らない token は
			// 1 つにまとめて数える（token を毎回変えて送られても間引きが効くように）。
			const known = token !== undefined && (this._paneShells.has(token) || cause === 'exited-pane' || cause === 'faulted-pane');
			return {
				reason: `${stage}-${cause}`,
				pane: paradisHookDropPaneKey(known, () => this._tokenFingerprint(token ?? '')),
				event: url.searchParams.get('event') ?? '',
				...this._agentHookDropSource(url, known ? token : undefined),
				status,
			};
		});
	}

	/** {@link captureIngressLease} が印を断る理由（診断ログ用。同じ条件を同じ順に見る）。 */
	private _agentHookIngressCause(token: string | undefined): ParadisHookIngressCause {
		if (token === undefined || token.length === 0 || token.length > MAX_PANE_TOKEN_LENGTH) {
			return 'no-token';
		}
		if (this._serverDisposed) {
			return 'server-disposed';
		}
		if (this._authorityFaulted) {
			return 'authority-faulted';
		}
		if (this._faultedTokens.has(token)) {
			return 'faulted-pane';
		}
		if (this._terminalExitedTokens.has(token)) {
			return 'exited-pane';
		}
		return 'unknown-pane';
	}

	/**
	 * Returns only the target fixed by the committed exact BrowserView descriptor.
	 * `key` はペインのトークン（共有中のページ）か、タブのスコープキー（そのタブ）。
	 */
	private async _ensureBoundTargetId(key: string): Promise<string | undefined> {
		const ingressLease = this.captureIngressLease(paradisPaneTokenOfScopeKey(key));
		if (ingressLease === undefined) {
			return undefined;
		}
		const binding = this._bindingForKey(key);
		if (!binding) {
			return undefined;
		}
		return this.isIngressLeaseCurrent(ingressLease) && this._bindingForKey(key) === binding
			? binding.exactView.targetId
			: undefined;
	}

	/**
	 * CDPゲートウェイからの `Page.captureScreenshot` 委譲。electron-mainの
	 * {@link PARADIS_CDP_TARGET_CHANNEL} 経由でupstream実装（非表示時の回避策付き）を呼び、
	 * base64画像データを返す。失敗・世代変更時はretryable errorにし、生CDPへfallbackさせない。
	 * encode-size上限だけは同じ入力の再試行で回復しないため、明示的なnon-retryable errorを保持する。
	 */
	private async _captureBoundPageScreenshot(key: string, options: IParadisCdpScreenshotOptions): Promise<string | undefined> {
		const token = paradisPaneTokenOfScopeKey(key);
		const ingressLease = this.captureIngressLease(token);
		if (ingressLease === undefined) {
			throw new ParadisIngressLeaseError();
		}
		const binding = this._bindingForKey(key);
		if (!binding) {
			throw new Error('PARA_BROWSER_RETRYABLE: no browser page is bound to this pane; share the page and retry the screenshot.');
		}
		const route = options.fullPage ? 'full-page'
			: options.pageRect && options.captureBeyondViewport ? 'document-rect'
				: options.pageRect ? 'viewport-rect' : 'viewport';
		const fingerprint = this._tokenFingerprint(token);
		const startedAt = Date.now();
		this._runNonThrowingDiagnostic(() => this.logService.trace(`[ParadisAgentBrowser] screenshot start pane=${fingerprint} generation=${binding.generation} page=${binding.pageId} route=${route}`));
		try {
			const data = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<string | null>('captureExactViewScreenshot', [binding.exactView, options]);
			this._requireIngressLease(ingressLease);
			const current = this._bindingForKey(key);
			if (current !== binding || current?.generation !== binding.generation) {
				throw new Error('PARA_BROWSER_RETRYABLE: the browser binding changed while the screenshot was being captured; retry the screenshot.');
			}
			if (!data) {
				throw new Error('PARA_BROWSER_RETRYABLE: the BrowserView returned no screenshot; retry the screenshot.');
			}
			this._runNonThrowingDiagnostic(() => this.logService.trace(`[ParadisAgentBrowser] screenshot complete pane=${fingerprint} generation=${binding.generation} page=${binding.pageId} route=${route} durationMs=${Date.now() - startedAt}`));
			return data;
		} catch (error) {
			if (error instanceof ParadisIngressLeaseError) {
				throw error;
			}
			if (error instanceof Error && error.message.startsWith(BROWSER_VIEW_SCREENSHOT_ENCODED_SIZE_ERROR_PREFIX)) {
				this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] screenshot failed pane=${fingerprint} generation=${binding.generation} page=${binding.pageId} route=${route} durationMs=${Date.now() - startedAt} reason=encoded-size`));
				throw error;
			}
			if (error instanceof Error && error.message.startsWith('PARA_BROWSER_RETRYABLE:')) {
				this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] screenshot failed pane=${fingerprint} generation=${binding.generation} page=${binding.pageId} route=${route} durationMs=${Date.now() - startedAt} reason=retryable`));
				throw error;
			}
			this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] screenshot failed pane=${fingerprint} generation=${binding.generation} page=${binding.pageId} route=${route} durationMs=${Date.now() - startedAt} reason=channel-error`));
			throw new Error('PARA_BROWSER_RETRYABLE: delegated BrowserView capture failed; retry the screenshot.', { cause: error });
		}
	}

	/**
	 * 素通しの WebP の撮影の前に、見えているかを確かめ、見えていればカーソルの演出を隠す。隠したビューは
	 * `_rawCaptureViews` に積み、`_endRawCapture` で同じビューへ戻す。
	 */
	private async _beginRawCapture(key: string): Promise<boolean> {
		const shown: IParadisExactBrowserViewDescriptor[] = [];
		let visible: boolean;
		try {
			visible = await this._isBoundPageVisible(key, 'beginExactViewRawCapture', exactView => shown.push(exactView));
		} catch (error) {
			// 隠した後に共有が変わった・ペインが止まった（撮らない）。ここで戻す。
			if (shown.length > 0) {
				this._endRawCaptureOf(shown[0], false);
			}
			throw error;
		}
		if (shown.length > 0) {
			if (visible) {
				const stack = this._rawCaptureViews.get(key) ?? [];
				stack.push(shown[0]);
				this._rawCaptureViews.set(key, stack);
			} else {
				// 隠した後に共有が変わった（撮らない）。ここで戻す。
				this._endRawCaptureOf(shown[0], false);
			}
		}
		return visible;
	}

	private _endRawCapture(key: string, captured: boolean): void {
		const stack = this._rawCaptureViews.get(key);
		const exactView = stack?.shift();
		if (stack && stack.length === 0) {
			this._rawCaptureViews.delete(key);
		}
		if (exactView) {
			this._endRawCaptureOf(exactView, captured);
		}
	}

	private _endRawCaptureOf(exactView: IParadisExactBrowserViewDescriptor, captured: boolean): void {
		try {
			void this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<void>('endExactViewRawCapture', [exactView, captured])
				.then(undefined, () => undefined);
		} catch {
			// 戻せなくても撮影は変えない（main 側の台帳は次の撮影で整う）。
		}
	}

	/**
	 * Read visibility through electron-main while protecting the result with the same binding generation.
	 * `method` を `beginExactViewRawCapture` にすると、見えているビューのカーソルを隠す。main が true を
	 * 返したら（隠したら）、その後の確認で断るときでも `onHidden` で呼び出し側へ伝える（戻すため）。
	 */
	private async _isBoundPageVisible(key: string, method: 'isExactViewVisible' | 'beginExactViewRawCapture' = 'isExactViewVisible', onHidden?: (exactView: IParadisExactBrowserViewDescriptor) => void): Promise<boolean> {
		const ingressLease = this.captureIngressLease(paradisPaneTokenOfScopeKey(key));
		if (ingressLease === undefined) {
			throw new ParadisIngressLeaseError();
		}
		const binding = this._bindingForKey(key);
		if (!binding) {
			throw new Error('PARA_BROWSER_RETRYABLE: no browser page is bound to this pane.');
		}
		try {
			const visible = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<boolean | null>(method, [binding.exactView]);
			if (visible === true && onHidden) {
				onHidden(binding.exactView);
			}
			this._requireIngressLease(ingressLease);
			const current = this._bindingForKey(key);
			if (current !== binding || current?.generation !== binding.generation) {
				throw new Error('PARA_BROWSER_RETRYABLE: the browser binding changed while visibility was being checked; retry the screenshot.');
			}
			if (visible === null) {
				throw new Error('PARA_BROWSER_RETRYABLE: the bound BrowserView no longer exists; retry after sharing the page again.');
			}
			return visible;
		} catch (error) {
			if (error instanceof ParadisIngressLeaseError) {
				throw error;
			}
			if (error instanceof Error && error.message.startsWith('PARA_BROWSER_RETRYABLE:')) {
				throw error;
			}
			throw new Error('PARA_BROWSER_RETRYABLE: BrowserView visibility could not be checked; retry the screenshot.', { cause: error });
		}
	}

	/**
	 * 診断の印を main へ渡す（Sentry のパンくずとまとめのイベントになる。paradisBrowserFocusDiagnostics.ts）。
	 * 共有中のタブが無ければ捨てる。届かなくても何も変えない。
	 */
	private _noteBrowserDiagnostic(key: string, note: IParadisBrowserDiagnosticNote): void {
		// タブのスコープキーなら、そのタブ（#261 のフォーカス診断をタブごとに分ける）
		const exactView = this._bindingForKey(key)?.exactView;
		if (exactView) {
			this._sendBrowserDiagnostic(exactView, note);
		}
	}

	private _sendBrowserDiagnostic(exactView: IParadisExactBrowserViewDescriptor | undefined, note: IParadisBrowserDiagnosticNote): void {
		try {
			void this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<void>('noteExactViewDiagnostic', [exactView ?? null, note])
				.then(undefined, () => undefined);
		} catch {
			// 診断は入力の配送を変えない。
		}
	}

	private _onCdpInputQueueDiagnostic(event: IParadisCdpInputQueueDiagnostic, queueKey: string | undefined): void {
		this._runNonThrowingDiagnostic(() => {
			// queueKey は共有中のタブの exactView を JSON にしたもの（_dispatchBoundPageInput）。
			let exactView: IParadisExactBrowserViewDescriptor | undefined;
			try {
				exactView = queueKey !== undefined ? paradisParseExactBrowserViewDescriptor(JSON.parse(queueKey)) : undefined;
			} catch {
				exactView = undefined;
			}
			this._sendBrowserDiagnostic(exactView, event.kind === 'saturated'
				? { kind: 'input-queue', queueKind: 'saturated' }
				: { kind: 'input-queue', queueKind: event.kind === 'paused' ? 'paused' : event.how === 'settled' ? 'resumed' : 'abandoned', cause: event.cause, method: event.method });
			switch (event.kind) {
				case 'paused':
					this.logService.warn(`[ParadisAgentBrowser] browser input paused on a page: ${event.method} ${event.cause === 'dispatch-timeout' ? 'did not finish in time' : 'lost its connection after it was sent'}`);
					reportParadisDiagnosticError('owned', 'agent-browser', 'cdp-input-queue-paused', new Error('CDP input queue paused'), { safe_cause: event.cause, safe_method: event.method }, 'warning');
					break;
				case 'resumed':
					if (event.how === 'settled') {
						this.logService.info(`[ParadisAgentBrowser] browser input resumed after ${event.pausedMs}ms: the unfinished ${event.method} settled`);
					} else {
						// 応答が来ないまま上限に達した。その入力は捨てて、後の入力を通す
						this.logService.warn(`[ParadisAgentBrowser] browser input resumed after ${event.pausedMs}ms: abandoned the unfinished ${event.method}`);
						reportParadisDiagnosticError('owned', 'agent-browser', 'cdp-input-queue-abandoned', new Error('CDP input dispatch abandoned'), { safe_cause: event.cause, safe_method: event.method, safe_paused_ms: event.pausedMs }, 'warning');
					}
					break;
				case 'saturated':
					this.logService.warn('[ParadisAgentBrowser] browser input paused on too many pages; pausing all input for one recovery period');
					reportParadisDiagnosticError('owned', 'agent-browser', 'cdp-input-queue-saturated', new Error('CDP input queue saturated'), {}, 'warning');
					break;
			}
		});
	}

	/** `key` はペインのトークン（共有中のページ）か、タブのスコープキー（そのタブ）。入力キューはタブ（exactView）ごと。 */
	private _dispatchBoundPageInput(
		key: string,
		connection: object,
		expectedTargetId: string,
		method: string,
		paramsJson: string,
		isConnectionCurrent: () => boolean,
	): IParadisCdpInputQueueOperation {
		const token = paradisPaneTokenOfScopeKey(key);
		const ingressLease = this.captureIngressLease(token);
		const binding = ingressLease === undefined ? undefined : this._bindingForKey(key);
		if (!ingressLease || !binding || binding.exactView.targetId !== expectedTargetId) {
			return this._cdpInputQueue.enqueue({
				queueKey: `unavailable:${token}`,
				connection,
				isAuthorityCurrent: () => false,
				dispatch: async (): Promise<IParadisCdpInputDispatchResult> => ({ status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: browser input binding is unavailable' }),
			});
		}
		const queueKey = JSON.stringify(binding.exactView);
		const isAuthorityCurrent = () => isConnectionCurrent()
			&& this.isIngressLeaseCurrent(ingressLease)
			&& this._bindingForKey(key) === binding
			&& binding.generation === this._bindingForKey(key)?.generation
			&& binding.exactView.targetId === expectedTargetId;
		return this._cdpInputQueue.enqueue({
			queueKey,
			method,
			connection,
			isAuthorityCurrent,
			dispatch: async () => {
				// 配送の順に待ちの予算を数えるので、指示はキューから出す時に決める
				const pacing = this._cursorPacing.ticketFor(token, method, paramsJson);
				// カーソルは持ち主（ペイン × タブ）ごとに分け、名前と色を付ける
				const owner = this._cursorOwnerFor(token, binding);
				const raw = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
					.call<unknown>('dispatchExactViewInput', [binding.exactView, method, paramsJson, { ...pacing?.pacing, owner }]);
				const result = paradisParseCdpInputDispatchResult(raw);
				if (!result) {
					throw new Error('Invalid exact BrowserView input dispatch response');
				}
				pacing?.settle(result.status === 'success' ? result.cursorWaitMs : undefined);
				return result;
			},
		});
	}

	// --- MCP HTTPサーバー ---

	/**
	 * PARA-PATCH: このMCPサーバーへツールを足す（モバイル端末操作など、別contribの機能）。
	 * shared processの起動時に一度だけ呼ばれる想定。
	 */
	registerToolProvider(provider: IParadisMcpToolProvider): void {
		this._toolProviders.push(provider);
	}

	/** 直接登録されたものと、登録口（`paradisRegisterMcpToolProvider`）から足されたものを合わせる。 */
	private _allToolProviders(): readonly IParadisMcpToolProvider[] {
		return [...this._toolProviders, ...paradisRegisteredMcpToolProviders()];
	}

	/** プロバイダが足したサーバーの説明（`initialize` の `instructions`）。 */
	private _serverInstructions(): string {
		// ブラウザの説明はこのサーバー自身のものなので、プロバイダの有無に関係なく先頭に置く
		const parts: string[] = [PARADIS_BROWSER_MCP_INSTRUCTIONS];
		for (const provider of this._allToolProviders()) {
			try {
				const text = provider.instructions?.();
				if (text && text.trim().length > 0) {
					parts.push(text.trim());
				}
			} catch (error) {
				this._runNonThrowingDiagnostic(() => this.logService.warn('[ParadisAgentBrowser] MCP instructions provider failed', error));
			}
		}
		return parts.join('\n\n');
	}

	/** プロバイダへ渡す、この呼び出し（ingress lease）に結び付いた機能。 */
	private _toolCallContext(ingressLease: IParadisAgentBrowserIngressLease, socket: Socket | undefined): IParadisMcpToolCallContext {
		return {
			hasAgentHookHistory: (paneToken: string): boolean => this._hookReportedTokens.has(paneToken),
			classifyCaller: (): Promise<ParadisMcpCallerKind> => this._classifyCaller(ingressLease.token, socket),
			callOwningWindow: <T>(request: IParadisMcpOwningWindowRequest, signal?: AbortSignal): Promise<ParadisMcpOwningWindowResult<T>> => this._callOwningWindow<T>(ingressLease, request, signal),
			getPaneAgentStatus: (paneToken: string): IParadisMcpPaneAgentStatus | undefined => {
				const entry = this._paneStatuses.get(paneToken);
				const unconfirmedRelease = this._unconfirmedReleaseOf(paneToken);
				return entry ? { status: entry.status, changedAt: entry.changedAt, ...(unconfirmedRelease !== undefined ? { unconfirmedRelease } : {}) } : undefined;
			},
			// 状態の項目は既読（acknowledgePaneStatus）や idle で消えるので、印は状態とは別に引けるようにする
			getUnconfirmedRelease: (paneToken: string) => this._unconfirmedReleaseOf(paneToken),
			getCursorIdentity: (paneToken: string): IParadisMcpCursorIdentity => {
				const labelKey = this._paneCursorLabelKeys.get(paneToken);
				const label = labelKey !== undefined ? this._cursorOwners.labelOf(labelKey) : undefined;
				const cli = this._paneSessions.get(paneToken)?.agent;
				return { ...(cli ? { cli } : {}), ...(label ? { label } : {}) };
			},
		};
	}

	private _unconfirmedReleaseOf(paneToken: string): 'pending' | 'unverifiable' | undefined {
		if (!this._unconfirmedReleaseTokens.has(paneToken)) {
			return undefined;
		}
		return this._unconfirmableTokens.has(paneToken) ? 'unverifiable' : 'pending';
	}

	/**
	 * 接続元のプロセスを分類する。トークンだけでは本人と言えない（同じユーザーのプロセスは他ペインの
	 * 環境変数を `ps eww` で読める）ので、`127.0.0.1:<相手> -> 127.0.0.1:<このサーバー>` の接続を持つ
	 * プロセスを調べる。手元のペインなら、そのペインのシェルの子孫のとき `pane`。SSH など接続先のペインなら、
	 * Para Code が張った戻り経路の `ssh -R` のプロセスそのもののとき `tunnel`（接続先のどのプロセスからかは
	 * 分からない）。どちらで確かめるかはペインの属性で決まる。環境変数は偽装できるので見ない。
	 * 同じ接続（keep-alive）とトークンの組の結果は、接続が閉じるまで覚えておく（1 回に `lsof` / `ps` を数回起こすため）。
	 * シェルの PID や戻り経路が変わったら覚えた結果は使わない。
	 */
	private async _classifyCaller(token: string, socket: Socket | undefined, signal?: AbortSignal): Promise<ParadisMcpCallerKind> {
		if (!socket || this._port === undefined || typeof socket.remotePort !== 'number' || socket.localPort !== this._port) {
			return 'unverified';
		}
		const pane = this._paneShells.get(token);
		if (!pane) {
			return 'unverified';
		}
		// 手元のペインはシェルの子孫だけ、接続先のペインは Para Code が張った `ssh -R` そのものだけを認める。
		// どちらで確かめるかはペインの属性で決める（hook のクエリ `host=` のような名乗りでは決めない）
		const tunnelPid = pane.remoteAuthority !== undefined ? this._remoteTunnels.processPidFor(pane.remoteAuthority) : undefined;
		const ancestorPid = pane.remoteAuthority === undefined && Number.isSafeInteger(pane.shellPid) && pane.shellPid > 1 ? pane.shellPid : undefined;
		const expectation = { tunnelPid, ancestorPid };
		const cacheKey = `${pane.remoteAuthority ?? ''}|${tunnelPid ?? ''}|${ancestorPid ?? ''}`;
		const cached = this._callerClassifications.get(socket);
		const hit = cached?.get(token);
		// シェルが入れ替わった・戻り経路が張り直された後は、前の判定を使わない
		if (hit && hit.key === cacheKey) {
			return hit.kind;
		}
		const flightKey = `${token}\n${cacheKey}`;
		let flights = this._callerClassificationsInFlight.get(socket);
		const running = flights?.get(flightKey);
		if (running) {
			return paradisCallerKindUnlessAborted(running, signal);
		}
		const remotePort = socket.remotePort;
		const port = this._port;
		const flight = (async (): Promise<ParadisMcpCallerKind> => {
			try {
				// 負荷が高いと lsof / ps の起動が数秒かかる。照合はコマンドの失敗・時間切れのときだけ待ちを延ばして
				// やり直す（paradisCdpPeerResolver.ts）。子孫でないと確かめられたものは通さない
				const peer = await paradisClassifyPeer(remotePort, port, process.pid, expectation);
				return peer === 'descendant' && pane.remoteAuthority === undefined
					? 'pane'
					: peer === 'tunnel' && pane.remoteAuthority !== undefined
						? 'tunnel'
						: 'unverified';
			} catch {
				return 'unverified';
			}
		})();
		if (!flights) {
			flights = new Map();
			this._callerClassificationsInFlight.set(socket, flights);
		}
		flights.set(flightKey, flight);
		// 結果は待っている呼び出しが取り消されても覚える（照合は止めず、次の呼び出しで使う）
		void flight.then(kind => {
			if (flights.get(flightKey) === flight) {
				flights.delete(flightKey);
			}
			if (kind !== 'unverified') {
				let cache = this._callerClassifications.get(socket);
				if (!cache) {
					cache = new Map();
					this._callerClassifications.set(socket, cache);
				}
				cache.set(token, { kind, key: cacheKey });
			}
		});
		// 取り消された呼び出しは照合の終わりを待たない
		return paradisCallerKindUnlessAborted(flight, signal);
	}

	/** サーバー起動完了後に、フォールバックを含む実際のlistenポートだけを返す。 */
	async getGatewayEndpoint(): Promise<IParadisGatewayEndpoint> {
		await this._serverStartPromise;
		const port = this._port;
		if (this._serverDisposed || port === undefined || !Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
			throw new Error('Para Browser gateway is not available.');
		}
		return { port };
	}

	/**
	 * SSH 接続先から、このゲートウェイへ戻ってこられるようにする。
	 *
	 * エージェントの hook も para-browser MCP も 127.0.0.1 の番号を叩く作りなので、接続先の
	 * その番号が手元へ向くようにするだけで両方が繋がる。番号は固定せず接続先の sshd に選ばせる
	 * （同じホストへ複数ユーザーが同時に SSH する共有サーバーで固定番号が衝突するのを避けるため）。
	 * @returns 接続先で実際に割り当てられた番号。失敗しても投げない:
	 * 張れない状態は「接続先の hook が届かない」だけで、手元の動きには何も影響しない。
	 */
	/** 張れている戻り経路の接続先の番号（張りには行かない。状態の表示用）。張れていなければ undefined。 */
	async getRemoteAgentTunnelPort(remoteAuthority: string): Promise<number | undefined> {
		return this._remoteTunnels.currentPort(remoteAuthority);
	}

	async ensureRemoteAgentTunnel(remoteAuthority: string, windowCtx?: string): Promise<number | undefined> {
		if (typeof remoteAuthority !== 'string' || remoteAuthority.length === 0) {
			return undefined;
		}
		try {
			const { port } = await this.getGatewayEndpoint();
			return await this._remoteTunnels.ensure(remoteAuthority, port, windowCtx);
		} catch (error) {
			this.logService.trace('[ParadisAgentBrowser] could not set up the return tunnel', error);
			return undefined;
		}
	}

	/**
	 * 接続が切れたら畳む。張っていなければ何もしない。
	 *
	 * 同じ接続先へは複数のウィンドウが繋げるので、**畳むのは最後の1枚が閉じたときだけ**
	 * （2枚開いていて片方を閉じただけで、残った側の hook まで止まらないように）。
	 */
	async closeRemoteAgentTunnel(remoteAuthority: string, windowCtx?: string): Promise<void> {
		if (typeof remoteAuthority === 'string' && remoteAuthority.length > 0) {
			this._remoteTunnels.close(remoteAuthority, windowCtx);
		}
	}

	/**
	 * 接続先で割り当てられた戻りトンネルの番号が変わったことを知らせる。
	 *
	 * 番号は張り直しのたびに変わる。接続先のポートファイルを書き換える側が定期の見直しで
	 * 気付くのを待っていると、その間の通知（承認待ち・完了）が届く先を失って丸ごと消える。
	 *
	 * 絞り込みは `Event.filter`/`Event.map` を使わず購読側で行う。あれは合成のたびに Emitter を
	 * 1つ作るので、購読が張り直されるたび（＝ウィンドウの reload ごと）に捨て場の無い Emitter が
	 * 積み上がる。ここは中継を挟まず、渡された購読をそのまま元のイベントへ繋ぐ。
	 */
	onDidChangeRemoteAgentTunnelPort(remoteAuthority: string): Event<number | undefined> {
		return (listener, thisArgs, disposables) => this._remoteTunnels.onDidChangePort(change => {
			if (change.remoteAuthority === remoteAuthority) {
				listener.call(thisArgs, change.port);
			}
		}, undefined, disposables);
	}

	/**
	 * ウィンドウが destroy されたら、そのウィンドウ名義の戻りトンネルを手放す。
	 *
	 * ウィンドウ側からの取り下げは dispose 時の投げっぱなしなので、クラッシュや終了中の切断では
	 * 届かない。届かないまま所有者として残ると、トンネルは誰も使っていないのに畳まれない。
	 */
	private _releaseRemoteAgentTunnelsForWindow(windowCtx: string): void {
		this._remoteTunnels.releaseWindow(windowCtx);
	}

	/**
	 * 接続先へ置く notify スクリプトの本文。手元に置くものと同じで、生成はここに一本化してある
	 * （renderer 側で作り直すと、手元と接続先で中身がずれる）。
	 *
	 * @param remoteAuthority 接続先を渡すと「接続先から届いた hook」の印を焼き込む。手元へ置く
	 * ぶんは渡さない（印の有無がそのまま、届いた hook をどちらのディスクのものと見るかになる）。
	 */
	async getNotifyScriptContent(fixedPortFilePath?: string, remoteAuthority?: string): Promise<string> {
		return paradisGetNotifyScriptContent(
			typeof fixedPortFilePath === 'string' && fixedPortFilePath.startsWith('/') ? fixedPortFilePath : undefined,
			paradisAgentHookRemoteHostId(typeof remoteAuthority === 'string' && remoteAuthority.length > 0 ? remoteAuthority : undefined),
		);
	}

	/**
	 * 接続先に置いたスクリプトへ実行権を与える。IFileService には権限を触る口が無いので、
	 * 既に張ってある戻り経路と同じ ssh で chmod する。
	 */
	async markRemoteHookExecutable(remoteAuthority: string, path: string): Promise<boolean> {
		return this._remoteTunnels.chmodExecutable(remoteAuthority, path);
	}

	/**
	 * 接続先の settings.json / hooks.json に、手元と同じ規則で hook を差し込んだ中身を返す。
	 *
	 * 読み書きは接続先を見られるウィンドウがやるが、**何を入れるかの判断はここに一本化する**。
	 * renderer 側で組み立て直すと、手元と接続先で入るものがずれる（実際、接続先だけ古い一覧の
	 * まま取り残され、同じ hook が2つ登録される状態になっていた）。
	 *
	 * @returns 書き戻すべき中身。読めない・壊れている場合は undefined（呼び出し側は触らない）
	 */
	async buildRemoteAgentHooksJson(remoteAuthority: string, cli: string, existingRaw: string | undefined): Promise<string | undefined> {
		if (cli === 'codex') {
			return paradisMergeAgentHooksJson(existingRaw, PARADIS_CODEX_HOOK_EVENTS);
		}
		if (cli !== 'claude') {
			return undefined;
		}
		// 版に依らない一式に、その版が受け付けると分かっているものだけを足す。古い版は知らない
		// キーごと設定を拒むことがあるので、確認できないときは足さない（既に置いてあるものは外さない）。
		const version = await this._remoteTunnels.claudeVersion(remoteAuthority);
		return paradisMergeAgentHooksJson(existingRaw, paradisClaudeManagedHookEvents(version));
	}

	/**
	 * 接続先の settings.json / hooks.json から、Para Code が置いた hook だけを外した中身を返す
	 * （hook の自動設置をオフにしたとき用）。判断を手元と同じ規則に揃えるため、ここに置く。
	 *
	 * @returns 書き戻すべき中身。ファイルが無い・壊れている場合は undefined（呼び出し側は触らない）
	 */
	async buildRemoteAgentHooksRemovalJson(existingRaw: string | undefined): Promise<string | undefined> {
		if (existingRaw === undefined || existingRaw.trim().length === 0) {
			return undefined;
		}
		return paradisRemoveAgentHooksJson(existingRaw);
	}

	private async _startServer(): Promise<void> {
		const { createServer } = await import('http');
		if (this._store.isDisposed) {
			return;
		}
		const server = createServer((req, res) => {
			this._handleRequest(req, res).catch(error => {
				this._settleUnexpectedRequestError(res, error);
			});
		});
		// requestTimeout は音声取込の 120 秒に合わせて 130 秒。ほかの経路の 30 秒は _handleRequest で経路ごとに掛ける
		paradisConfigureMcpHttpServer(server);
		// CDPゲートウェイのWebSocket upgrade（/cdp/devtools/* および /devtools/*）
		server.on('upgrade', (req, socket, head) => {
			void this._cdpGateway.handleUpgrade(req, socket, head);
		});
		this._httpServer = server;

		// 固定既定ポートを第一候補にし、専有時のみ動的ポートへフォールバックする。
		// ポートファイルには常に実ポートが書かれるため、stdioシム経路には影響しない。
		const listen = (port: number) => new Promise<boolean>(resolve => {
			const onError = (error: NodeJS.ErrnoException) => {
				server.removeListener('listening', onListening);
				this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] Failed to listen on 127.0.0.1:${port}: ${error.code ?? error.message}`));
				resolve(false);
			};
			const onListening = () => {
				server.removeListener('error', onError);
				resolve(true);
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(port, '127.0.0.1');
		});

		// 既定ポートに粘る。SSH 接続先には「この番号へ返せ」と書いて渡してあり、番号が変わると
		// 書いた先が古くなって通知が届かなくなる。塞いでいるのはたいてい終了しきる前の前回の
		// 自分なので、少し待てば空く（実測: ウィンドウの再読み込みで shared process が入れ替わる際に起きる）。
		let listening = await listen(PARADIS_MCP_DEFAULT_PORT);
		for (let attempt = 0; !listening && attempt < 5 && !this._store.isDisposed; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 400));
			listening = await listen(PARADIS_MCP_DEFAULT_PORT);
		}
		if (!listening && !this._store.isDisposed) {
			this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] Default port ${PARADIS_MCP_DEFAULT_PORT} is in use. Falling back to a dynamic port; clients resolve the live port over IPC or from the port file.`));
			listening = await listen(0);
		}
		if (!listening) {
			this._runNonThrowingDiagnostic(() => this.logService.error('[ParadisAgentBrowser] Failed to start MCP server (no port available)'));
			if (this._httpServer === server) {
				this._httpServer = undefined;
			}
			return;
		}

		// dispose() can run after the listen promise resolves but before this continuation.
		// Keep using the local server identity and never dereference the cleared field.
		if (this._store.isDisposed) {
			server.close();
			if (this._httpServer === server) {
				this._httpServer = undefined;
			}
			return;
		}
		const address = server.address();
		if (!address || typeof address === 'string') {
			this._runNonThrowingDiagnostic(() => this.logService.error('[ParadisAgentBrowser] Unexpected server address', String(address)));
			server.close();
			if (this._httpServer === server) {
				this._httpServer = undefined;
			}
			return;
		}
		this._port = address.port;
		if (this._store.isDisposed) {
			this._port = undefined;
			server.close();
			if (this._httpServer === server) {
				this._httpServer = undefined;
			}
			return;
		}

		const portFileRecord: IParadisMcpPortFileRecord = {
			protocolVersion: PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION,
			port: this._port,
			pid: process.pid,
			instanceId: this._mcpInstanceId,
			serviceStartedAt: this._mcpServiceStartedAt,
		};
		try {
			const published = await writeParadisMcpPortFileAtomic(
				this._portFilePath,
				portFileRecord,
				{ shouldPublish: () => !this._store.isDisposed },
			);
			if (!published || this._store.isDisposed) {
				return;
			}
			const reconciler = new ParadisMcpPortFileReconciler(this._portFilePath, portFileRecord, {
				onError: () => this._runNonThrowingDiagnostic(() => this.logService.warn('[ParadisAgentBrowser] MCP port record reconciliation failed; will retry')),
			});
			this._portFileReconciler = reconciler;
			await reconciler.start();
			this._runNonThrowingDiagnostic(() => this.logService.info(`[ParadisAgentBrowser] MCP server listening on 127.0.0.1:${this._port} (port file: ${this._portFilePath})`));
		} catch (error) {
			reportParadisDiagnosticError('owned', 'agent-browser', 'publish-mcp-port', error, { phase: 'startup' });
			this._runNonThrowingDiagnostic(() => this.logService.error('[ParadisAgentBrowser] Failed to write MCP port file', error));
		}
	}

	private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (this._serverDisposed) {
			if (req.method === 'POST' && req.url === '/paradis-mcp/mobile-voice') {
				// 終了中に届いた音声取込。404 だと接続先の aivis-mcp は ticket が通らなかったとみなして鳴らさないので、503 で接続先に鳴らしてもらう
				paradisSendVoiceIngressUnavailable(res);
				return;
			}
			this._sendIngressRejected(res);
			return;
		}
		// 本文を受け取りきるまで以前と同じ 30 秒で縛る。音声取込は実際に受理した時点で外す（自前の 120 秒・最初の音・
		// 届く速さで縛る）
		const bodyTimeout = paradisArmRequestBodyTimeout(req, res);
		if (req.method === 'GET' && req.url === PARADIS_MCP_HEALTH_PATH) {
			const body = JSON.stringify({
				protocolVersion: PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION,
				instanceId: this._mcpInstanceId,
				serviceStartedAt: this._mcpServiceStartedAt,
			});
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
				'Cache-Control': 'no-store',
			});
			res.end(body);
			return;
		}
		// CDPゲートウェイのHTTPエンドポイント（GET /json/* および GET /cdp/json/*）
		if (this._cdpGateway.isGatewayHttpRequest(req)) {
			return this._cdpGateway.handleRequest(req, res);
		}

		// エージェントCLIのhook通知 (/agent-hook?pane=<token>&event=<eventType>)。
		// Claude Code / Codex の hooks に登録した notify.sh から叩かれる (Superset の
		// GET /hook/complete 方式の移植。ペイントークンで認証)。
		// v2スクリプトは hook stdin JSON をそのまま POST body に載せる (session_id /
		// transcript_path をモバイルのエージェントチャットミラーが使う)。旧v1スクリプトの
		// GET (bodyなし) も引き続き受理する。
		if ((req.method === 'GET' || req.method === 'POST') && (req.url ?? '').startsWith('/agent-hook')) {
			return this._handleAgentHook(req, res);
		}
		// 保存済みスクリーンショットの取り出し。SSH 接続先のエージェントが、手元に落ちた画像を
		// 自分の機械へ持ってくるための口（戻り経路をそのまま使う）。
		if (req.method === 'GET' && (req.url ?? '').startsWith(`${PARADIS_SCREENSHOT_FETCH_PATH}/`)) {
			return this._handleScreenshotFetch(req, res);
		}
		if (req.method === 'POST' && req.url === '/paradis-mcp/mobile-voice') {
			// 自前の 120 秒・最初の音・届く速さで縛る（paradisRemoteVoiceIngress）
			return this._handleMobileVoiceIngress(req, res, bodyTimeout);
		}
		// Claude Code の mod（resources/paradis/claude-mod）。hook と同じくペイントークンで認証する。
		if (req.method === 'POST' && (req.url ?? '').startsWith(PARADIS_CLAUDE_MOD_HTTP_PREFIX)) {
			return this._handleClaudeMod(req, res);
		}
		if (req.method === 'POST' && req.url === '/paradis-mcp/mobile-voice-ticket') {
			return this._handleMobileVoiceTicket(req, res);
		}
		if (req.method === 'POST' && req.url === PARADIS_MOBILE_VOICE_TICKET_RELEASE_PATH) {
			return this._handleMobileVoiceTicketRelease(req, res);
		}

		if (req.method !== 'POST') {
			res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
			res.end(JSON.stringify({ error: 'Method not allowed. This is a Para Code MCP endpoint (Streamable HTTP, POST only) with a CDP gateway under /cdp (GET /cdp/json/version etc.).' }));
			return;
		}

		const requestedToken = this._extractToken(req);
		const ingressLease = requestedToken === undefined ? undefined : this.captureIngressLease(requestedToken);
		if (ingressLease === undefined) {
			this._sendIngressRejected(res);
			return;
		}
		const token = ingressLease.token;

		const ingressReservation = this._reserveIngressRequest(token);
		if (ingressReservation === undefined) {
			this._sendIngressCapacityRejected(res);
			return;
		}
		let activeRequest: ReturnType<ParadisAgentBrowserService['_trackActiveRequest']> | undefined;
		try {
			activeRequest = this._trackActiveRequest(req, res);
			const { controller } = activeRequest;
			let body: string;
			try {
				body = await this._readBody(req, controller.signal);
			} catch (error) {
				if (!controller.signal.aborted) {
					res.writeHead(413, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Request body rejected.' }));
				}
				return;
			}
			if (controller.signal.aborted) {
				return;
			}
			if (!this.isIngressLeaseCurrent(ingressLease)) {
				this._sendIngressRejected(res);
				return;
			}
			// MCP接続実績はbody受信後も同じowner lifecycleである場合だけ記録する。
			this._seenTokens.add(token);

			let message: unknown;
			try {
				message = JSON.parse(body);
			} catch {
				this._sendJsonRpc(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
				return;
			}

			if (Array.isArray(message) || !message || typeof message !== 'object') {
				this._sendJsonRpc(res, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request (batch messages are not supported)' } });
				return;
			}

			const rpc = message as IJsonRpcRequest;
			if (typeof rpc.method !== 'string') {
				// レスポンス/不正メッセージ: statelessサーバーなので受理だけする
				res.writeHead(202);
				res.end();
				return;
			}

			if (rpc.id === undefined || rpc.id === null) {
				// notification（notifications/initialized 等）は202で受理
				if (this.isIngressLeaseCurrent(ingressLease)) {
					res.writeHead(202);
					res.end();
				} else {
					this._sendIngressRejected(res);
				}
				return;
			}

			try {
				const result = await this._dispatch(ingressLease, rpc, controller.signal, req.socket as Socket);
				if (!controller.signal.aborted && this.isIngressLeaseCurrent(ingressLease)) {
					this._sendJsonRpc(res, { jsonrpc: '2.0', id: rpc.id, result });
				} else if (!controller.signal.aborted) {
					this._sendIngressRejected(res);
				}
			} catch (error) {
				if (controller.signal.aborted) {
					return;
				}
				if (!this.isIngressLeaseCurrent(ingressLease) || error instanceof ParadisIngressLeaseError) {
					this._sendIngressRejected(res);
				} else if (error instanceof JsonRpcMethodError) {
					this._sendJsonRpc(res, { jsonrpc: '2.0', id: rpc.id, error: { code: error.code, message: error.message } });
				} else {
					this._runNonThrowingDiagnostic(() => this.logService.warn('[ParadisAgentBrowser] MCP dispatch failed', error));
					this._sendJsonRpc(res, { jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'Internal error' } });
				}
			}
		} finally {
			activeRequest?.dispose();
			ingressReservation.dispose();
		}
	}

	/**
	 * aivis-mcpが生成済みMP3を再利用するためのloopback専用取込口。
	 * pane ownerが直前に発行した1回限りの短命ticketで認証し、音声は保存せずイベントへ渡す。
	 */
	private async _handleMobileVoiceIngress(req: http.IncomingMessage, res: http.ServerResponse, bodyTimeout: { dispose(): void }): Promise<void> {
		// 本文を読まずに断る要求は、接続を使い回させない。返し終えた後は bodyTimeout が残りを 1 秒だけ読み捨ててから閉じる
		// （すぐ切ると、相手が応答を受け取る前に接続が切れることがある。L-2）
		const closeAfterReply = () => {
			res.setHeader('Connection', 'close');
		};
		const requestedTicket = this._extractToken(req);
		const ticket = requestedTicket === undefined ? undefined : this._mobileVoiceTickets.get(requestedTicket);
		if (requestedTicket !== undefined) {
			// 音声ticketは成否を問わず1回だけ。再送には要求元が新しいticketを発行する。
			this._mobileVoiceTickets.delete(requestedTicket);
		}
		if (ticket === undefined || ticket.expiresAt < Date.now() || !this._isMobileVoiceTicketCurrent(ticket)) {
			closeAfterReply();
			// ticket が通らない（知らない・期限切れ・使用済み・今の instance のものでない）。401 を返すと、接続先の
			// aivis-mcp 2.5.1 は手元で鳴らす前提の発話を自分では鳴らさない（ticket-unavailable）。ほかの 4xx・5xx は接続先で鳴らす
			paradisSendVoiceTicketRejected(res);
			return;
		}
		const publishMobileVoiceClip = this.publishMobileVoiceClip;
		// モバイルへ届ける口が無くても、手元で鳴らす約束をした ticket は受け取る
		if (publishMobileVoiceClip === undefined && !ticket.localPlayback) {
			closeAfterReply();
			this._sendIngressRejected(res);
			return;
		}
		const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
		if (contentType !== 'audio/mpeg' && contentType !== 'application/octet-stream') {
			closeAfterReply();
			res.writeHead(415, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify({ error: 'Audio payload rejected.' }));
			return;
		}
		const reservation = this._reserveIngressRequest(ticket.lease?.token ?? this._voiceIngressToken);
		if (reservation === undefined) {
			closeAfterReply();
			this._sendIngressCapacityRejected(res);
			return;
		}
		// 押さえる量は受け取った分だけ増やす（chunked は長さが先に分からない）。枠が埋まっていたら少しだけ空くのを待つ
		const voiceReservation = await this._reserveMobileVoiceIngressWithin(MOBILE_VOICE_SLOT_WAIT_MS, req);
		if (voiceReservation === undefined) {
			reservation.dispose();
			closeAfterReply();
			this._sendIngressCapacityRejected(res);
			return;
		}
		let activeRequest: ReturnType<ParadisAgentBrowserService['_trackActiveRequest']> | undefined;
		try {
			activeRequest = this._trackActiveRequest(req, res);
			// 受理した。ここからは自前の 120 秒・最初の音・届く速さで縛る
			bodyTimeout.dispose();
			const result = await paradisReceiveRemoteVoice(req, res, {
				localPlayback: ticket.localPlayback,
				signal: activeRequest.controller.signal,
				// 接続先の待ち（Content-Length の旧方式は 30 秒）を過ぎてから積むと二重に鳴るので、締め切りを短めに切る
				enqueueDeadlineMs: LOCAL_VOICE_ENQUEUE_DEADLINE_MS,
			}, {
				voiceOutput: this.localVoiceOutput,
				playViaPlayAudio: (audio, options) => this._localVoicePlayer.play(audio, options),
				publishMobileVoiceClip,
				// モバイルへは受け取りながら流す（通知サービスが流れを作る。モバイルへ届ける口があるときだけ）
				beginMobileVoiceStream: publishMobileVoiceClip !== undefined && this.localVoiceOutput?.beginMobileVoiceStream !== undefined
					? gainKey => this.localVoiceOutput!.beginMobileVoiceStream!(gainKey)
					: undefined,
				reserveBytes: bytes => voiceReservation.grow(bytes),
				// 手元で積む待ちの間、音声取込の枠を握り続けない（手元の拡張機能ホストの発話が断られる）
				onBodyReceived: () => {
					voiceReservation.dispose();
					reservation.dispose();
				},
				isTicketCurrent: () => this._isMobileVoiceTicketCurrent(ticket),
				log: message => this._logVoice(message),
			});
			this._logVoice(`voice received (outcome=${result.outcome}, local=${ticket.localPlayback}, chunked=${req.headers['content-length'] === undefined}, listeners=${this._mobileVoiceListenerCount() ?? 'unknown'})`);
		} finally {
			activeRequest?.dispose();
			voiceReservation.dispose();
			reservation.dispose();
		}
	}

	/**
	 * ターミナルのペインを持たない拡張機能ホストへ渡す音声取込トークン。
	 * 呼べるのは同一プロセスのworkbench（IPCチャネル経由）だけで、値はディスクへ書かない。
	 */
	/** Claude Code の設定フォルダ（`CLAUDE_CONFIG_DIR`、無ければ ~/.claude）。中身は返さない。 */
	async getClaudeConfigDir(): Promise<string> {
		return paradisClaudeConfigDir();
	}

	async getVoiceIngressToken(): Promise<string> {
		return this._voiceIngressToken;
	}

	private _isVoiceIngressToken(token: string): boolean {
		return token.length === this._voiceIngressToken.length
			&& timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(this._voiceIngressToken, 'utf8'));
	}

	/** ticketがまだ有効か。pane由来はleaseの現行性、拡張ホスト由来はサーバー生存だけを見る。 */
	private _isMobileVoiceTicketCurrent(ticket: { readonly lease: IParadisAgentBrowserIngressLease | undefined }): boolean {
		return ticket.lease === undefined ? !this._serverDisposed : this.isIngressLeaseCurrent(ticket.lease);
	}

	/** 通常pane BearerをRedis workerへ渡さずに済む、音声POST 1回だけの短命ticketを発行する。 */
	private _handleMobileVoiceTicket(req: http.IncomingMessage, res: http.ServerResponse): void {
		const requestedToken = this._extractToken(req);
		// 拡張機能ホスト（ペイン無し）はインスタンススコープの音声トークンで発行できる。
		const isVoiceToken = requestedToken !== undefined && this._isVoiceIngressToken(requestedToken);
		const ingressLease = requestedToken === undefined || isVoiceToken ? undefined : this.captureIngressLease(requestedToken);
		if (ingressLease === undefined && !isVoiceToken) {
			// 閉じたペインの aivis が発話するたびに出るので debug にとどめる
			this._logVoice('ticket rejected (unknown or stale pane token)', 'debug');
			this._sendIngressRejected(res);
			return;
		}
		if (isVoiceToken && this._serverDisposed) {
			this._sendIngressRejected(res);
			return;
		}
		const now = Date.now();
		for (const [key, value] of this._mobileVoiceTickets) {
			if (value.expiresAt < now || !this._isMobileVoiceTicketCurrent(value)) {
				this._mobileVoiceTickets.delete(key);
			}
		}
		// 拡張ホスト由来のticketも、ペインと同じ上限で数える（トークンはUUID2つ分なのでpaneと衝突しない）。
		const ownerKey = ingressLease?.token ?? this._voiceIngressToken;
		let paneTicketCount = 0;
		for (const value of this._mobileVoiceTickets.values()) {
			if ((value.lease?.token ?? this._voiceIngressToken) === ownerKey) {
				paneTicketCount++;
			}
		}
		if (this._mobileVoiceTickets.size >= MAX_MOBILE_VOICE_TICKETS || paneTicketCount >= MAX_MOBILE_VOICE_TICKETS_PER_PANE) {
			this._logVoice(`ticket rejected (capacity: owner=${ingressLease === undefined ? 'extension-host' : this._tokenFingerprint(ingressLease.token)}, pane=${paneTicketCount}, total=${this._mobileVoiceTickets.size})`);
			this._sendIngressCapacityRejected(res);
			return;
		}
		const voiceTicket = `${randomUUID()}-${randomUUID()}`;
		const expiresAt = now + MOBILE_VOICE_TICKET_TTL_MS;
		// SSH の接続先のペインからの発話は手元で鳴らす。答えを見た接続先の aivis-mcp は自分では鳴らさない
		const localPlayback = ingressLease !== undefined && this._paneRemoteAuthorityOf(ingressLease.token) !== undefined && this._remoteVoiceLocalPlaybackEnabled();
		this._mobileVoiceTickets.set(voiceTicket, { lease: ingressLease, expiresAt, localPlayback });
		// `ingress: "stream-v1"` を名乗ると、接続先の aivis-mcp 2.5.0 は合成を受け取りながら chunked で送る
		// `muteAware: true` を名乗ると、接続先の aivis-mcp 2.5.1 はミュート中の発話に `X-Para-Muted: 1` を付けて送る
		// （Para Code は手元で鳴らさず、モバイルへだけ届ける）
		// `mobileListeners`（声を聞いているモバイルの数）を名乗ると、aivis-mcp 2.6 は 1 以上のとき PC の再生待ちを待たずに
		// 合成してモバイルへ送る。`release: true` を名乗ると、使わなかった ticket を返してくる。古い aivis-mcp はどちらも読まない
		const mobileListeners = this._mobileVoiceListenerCount();
		const body = JSON.stringify({
			ticket: voiceTicket,
			expiresAt,
			instanceId: this._mcpInstanceId,
			...(localPlayback ? { localPlayback } : {}),
			ingress: PARADIS_REMOTE_VOICE_STREAM_INGRESS,
			muteAware: true,
			...(mobileListeners === undefined ? {} : { mobileListeners }),
			release: true,
		});
		this._logVoice(`ticket issued (owner=${ingressLease === undefined ? 'extension-host' : this._tokenFingerprint(ingressLease.token)}, local=${localPlayback}, listeners=${mobileListeners ?? 'unknown'}, outstanding=${paneTicketCount + 1})`);
		res.writeHead(201, {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(body),
			'Cache-Control': 'no-store',
		});
		res.end(body);
	}

	/**
	 * 使わなかった音声 ticket を返す（aivis-mcp 2.6。期限切れで送らなかった件など）。ticket そのもので認証し、その 1 枚だけを
	 * 消す。知らない ticket でも同じ応答を返す（どの ticket が生きているかを漏らさない）。
	 */
	private _handleMobileVoiceTicketRelease(req: http.IncomingMessage, res: http.ServerResponse): void {
		const requestedTicket = this._extractToken(req);
		const found = requestedTicket !== undefined && this._mobileVoiceTickets.delete(requestedTicket);
		// 使い終わった・期限切れの ticket を返されたとき（found=false）は珍しくないので debug にとどめる
		this._logVoice(`ticket released (found=${found}, outstanding=${this._mobileVoiceTickets.size})`, found ? 'info' : 'debug');
		res.writeHead(204, { 'Cache-Control': 'no-store', 'Connection': 'close' });
		res.end();
	}

	/** 声を聞いているモバイルの数（モバイルリレーが動いていなければ undefined）。 */
	private _mobileVoiceListenerCount(): number | undefined {
		const count = this.localVoiceOutput?.mobileVoiceListenerCount?.();
		return count !== undefined && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
	}

	/** 声の行き先の判断を sharedprocess.log に 1 行残す（音声の本文・ticket・トークンは書かない）。 */
	private _logVoice(message: string, level: 'info' | 'debug' = 'info'): void {
		this._runNonThrowingDiagnostic(() => level === 'info' ? this.logService.info(`[ParadisVoice] ${message}`) : this.logService.debug(`[ParadisVoice] ${message}`));
	}

	/**
	 * Claude Code の mod からの要求（`/claude-mod/v1/<op>`）。ペイントークンで認証し、中身は
	 * paradisClaudeModBridge に任せる。長いポーリングは相手が切れたら外す（signal）。
	 */
	private async _handleClaudeMod(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const requestedToken = this._extractToken(req);
		const ingressLease = requestedToken === undefined ? undefined : this.captureIngressLease(requestedToken);
		if (ingressLease === undefined) {
			this._sendIngressRejected(res);
			return;
		}
		const operation = (req.url ?? '').slice(PARADIS_CLAUDE_MOD_HTTP_PREFIX.length).split('?', 1)[0] ?? '';
		const ingressReservation = this._reserveIngressRequest(ingressLease.token, 'mod');
		if (ingressReservation === undefined) {
			this._sendIngressCapacityRejected(res);
			return;
		}
		const activeRequest = this._trackActiveRequest(req, res);
		try {
			const { controller } = activeRequest;
			let body: unknown;
			try {
				body = JSON.parse(await this._readBody(req, controller.signal));
			} catch {
				if (!controller.signal.aborted && !res.writableEnded) {
					res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
					res.end(JSON.stringify({ error: 'Request body rejected.' }));
				}
				return;
			}
			if (!this.isIngressLeaseCurrent(ingressLease)) {
				this._sendIngressRejected(res);
				return;
			}
			// 状態を動かす要求は、hook の許可待ちと同じく送り主がそのペインのプロセスか確かめる（観測だけの便は確かめない）
			const verifyCaller = async () => {
				const caller = await this._classifyCaller(ingressLease.token, req.socket as Socket);
				return caller !== 'unverified' && this.isIngressLeaseCurrent(ingressLease);
			};
			const reply = await paradisClaudeModBridge.handle(ingressLease.token, operation, body, controller.signal, verifyCaller);
			if (controller.signal.aborted || res.writableEnded || !this.isIngressLeaseCurrent(ingressLease)) {
				// 渡すはずだったもの（送る発言）は届いていない
				reply.onNotDelivered?.();
				if (!controller.signal.aborted && !res.writableEnded) {
					this._sendIngressRejected(res);
				}
				return;
			}
			const text = JSON.stringify(reply.body);
			res.writeHead(reply.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
			if (reply.onNotDelivered !== undefined) {
				const onNotDelivered = reply.onNotDelivered;
				res.once('close', () => {
					if (!res.writableFinished) {
						onNotDelivered();
					}
				});
			}
			res.end(text);
		} catch (error) {
			this._runNonThrowingDiagnostic(() => this.logService.warn('[ParadisAgentBrowser] Claude Code mod request failed', error));
			if (!res.writableEnded) {
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
				}
				res.end(JSON.stringify({ error: 'Internal error' }));
			}
		} finally {
			activeRequest.dispose();
			ingressReservation.dispose();
		}
	}

	private async _handleAgentHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const requestedToken = this._extractToken(req);
		const ingressLease = requestedToken === undefined ? undefined : this.captureIngressLease(requestedToken);
		if (ingressLease === undefined) {
			// まだ同期していないだけかもしれないペインには 503 で答え、notify スクリプトに控えさせる。
			// 知らない・終わったペインには 404（控えない）。W2-20 レビュー M3。
			if (requestedToken !== undefined && this._isHookTokenPossiblyUnsynced(requestedToken)) {
				this._noteAgentHookIngressDrop(req, requestedToken, 'ingress', 503);
				res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
				res.end(JSON.stringify({ error: 'Pane not synced yet.' }));
				return;
			}
			this._noteAgentHookIngressDrop(req, requestedToken, 'ingress', 404);
			this._sendIngressRejected(res);
			return;
		}
		const token = ingressLease.token;

		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const eventType = url.searchParams.get('event') ?? '';
		// hook の ID を覚える。受け口の返事が遅れて notify スクリプトが控えてしまっても、流し直しで二重にしない。
		const hookId = url.searchParams.get(PARADIS_AGENT_HOOK_ID_PARAM);
		if (hookId !== null && PARADIS_AGENT_HOOK_ID_PATTERN.test(hookId)) {
			this._rememberHookId(hookId);
		}
		// SSH の接続先へ置いた notify スクリプトだけが名乗る印。これが付いていれば、載っている
		// transcript_path は接続先のディスクのもので、手元では開けない（同じ綴りが手元にあっても別物）。
		// 印の無い hook は従来どおり手元のものとして扱う（旧版のスクリプトが残っていても壊さない）。
		const remoteHostParam = url.searchParams.get(PARADIS_AGENT_HOOK_REMOTE_HOST_PARAM);
		const remoteHostId = paradisIsAgentHookRemoteHostId(remoteHostParam) ? remoteHostParam : undefined;
		if (eventType.length > MAX_HOOK_EVENT_LENGTH) {
			res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify({ error: 'Agent hook rejected.' }));
			return;
		}
		const ingressReservation = this._reserveIngressRequest(token, 'hook');
		if (ingressReservation === undefined) {
			this._sendIngressCapacityRejected(res);
			return;
		}
		let activeRequest: ReturnType<ParadisAgentBrowserService['_trackActiveRequest']> | undefined;
		try {
			activeRequest = this._trackActiveRequest(req, res);
			const { controller } = activeRequest;

			// v2スクリプトのPOST body (hook stdin JSON) から session_id / transcript_path / cwd を
			// 抽出してhookバスへ流す。個別aliasも必ずcopy-ownedなsanitized payloadから読む。
			let hookPayload: Readonly<Record<string, unknown>> | undefined;
			if (req.method === 'POST') {
				let body: string;
				try {
					body = await this._readBody(req, controller.signal);
				} catch {
					if (!controller.signal.aborted && !this._serverDisposed) {
						res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
						res.end(JSON.stringify({ error: 'Request body rejected.' }));
					}
					return;
				}
				try {
					hookPayload = paradisSanitizeAgentHookPayload(JSON.parse(body));
				} catch {
					// 壊れたJSONは旧hookと同じくイベント名だけで処理する。
				}
			}
			const stringField = (name: string): string | undefined => {
				const value = hookPayload?.[name];
				return typeof value === 'string' ? value : undefined;
			};
			const sessionId = stringField('session_id');
			const transcriptPath = stringField('transcript_path');
			const cwd = stringField('cwd');
			const hookMessage = stringField('message');
			const toolName = stringField('tool_name');
			const toolInput = hookPayload?.tool_input;
			const toolUseId = stringField('tool_use_id');
			const messageId = stringField('message_id');
			const messageDelta = stringField('delta');
			const indexValue = hookPayload?.index;
			const messageIndex = typeof indexValue === 'number' && Number.isSafeInteger(indexValue) && indexValue >= 0 ? indexValue : undefined;
			const finalValue = hookPayload?.final;
			const messageFinal = typeof finalValue === 'boolean' ? finalValue : undefined;
			if (controller.signal.aborted) {
				return;
			}
			if (!this.isIngressLeaseCurrent(ingressLease)) {
				this._noteAgentHookIngressDrop(req, token, 'lease-lost', 404);
				this._sendIngressRejected(res);
				return;
			}
			// 許可待ち・質問中のペインの状態は、そのペインの中のプロセス（接続先のペインなら Para Code が
			// 張った戻り経路の ssh）から届いた hook でしか動かさない。トークンは同じユーザーの別プロセスからも
			// 読めるので、偽の Stop などで状態を「完了」に書き換え、IDE 操作ツールの Enter で許可ダイアログを
			// 承認させる経路を塞ぐ。hook は頻繁に来るので、確かめるのはこの 2 つの状態と、transcript から
			// 許可待ちが解かれてまだ確かめた hook が来ていない間だけにする（それ以外の状態を偽装しても、
			// 許可ダイアログを Enter で押させることにはつながらない）。どちらで確かめるかはペインの属性で決まり、
			// クエリの `host=` の名乗りでは変わらない。
			// 相手（curl の 3 秒の待ち）が先に切れても、確かめと状態の更新は最後まで続ける（Windows では
			// 確かめが遅く、承認の後の hook を落とすと許可待ちのまま残るため）。
			const initialEntry = eventType ? this._paneStatuses.get(token) : undefined;
			const initiallyInWait = initialEntry?.status === 'permission' || initialEntry?.status === 'question';
			// 許可待ち・質問へ入れる hook も送り主を確かめ、確かめられたかを状態に記録する（解除の hook を
			// 確かめずに受け付けてよいかは、入れた hook が確かめられなかったかで決める）。
			const entersWait = eventType !== '' && paradisAgentHookEntersWait(eventType, hookMessage, toolName);
			const initiallyChecksPendingRelease = !initiallyInWait && eventType !== '' && eventType !== 'TerminalExit'
				&& this._unconfirmedReleaseTokens.has(token) && !this._unconfirmableTokens.has(token);
			let callerUnverified: boolean | undefined;
			if (initiallyInWait || entersWait || initiallyChecksPendingRelease) {
				const caller = await this._classifyCaller(token, req.socket as Socket);
				if (!this.isIngressLeaseCurrent(ingressLease)) {
					this._noteAgentHookIngressDrop(req, token, 'lease-lost', 404);
					this._sendIngressRejected(res);
					return;
				}
				callerUnverified = caller === 'unverified';
			}
			// 確かめている間に状態が変わっていることがある（本物の許可要求と偽の hook が競る）。決めるのは今の状態で。
			// 確かめなかったときは間に await が無いので、最初に読んだ状態と同じ
			const currentEntry = eventType ? this._paneStatuses.get(token) : undefined;
			const inWait = currentEntry?.status === 'permission' || currentEntry?.status === 'question';
			const checksPendingRelease = !inWait && eventType !== '' && eventType !== 'TerminalExit'
				&& this._unconfirmedReleaseTokens.has(token) && !this._unconfirmableTokens.has(token);
			if (inWait) {
				if (callerUnverified !== false) {
					// tmux のサーバー配下や WSL の中のエージェントは、いつまでも確かめを通れない。許可待ち・質問へ
					// 入れる hook は捨てるが、解除の hook（ツールの完了・ターンの終了など）まで捨てると、承認しても
					// 許可待ちのまま残る。入れた hook も確かめられなかった待ちに限って解除だけは受け付け、確かめ
					// られないまま解いた印を付けて IDE 操作ツールの入力を断る（偽の hook で解いた状態へ送らせない）。
					// 確かめられた hook で入った待ち（普通の手元のペイン）を確かめられない hook で解くのは偽装とみなす。
					if (!paradisIsAgentHookReleaseEvent(eventType) || currentEntry?.waitEntryUnverified !== true) {
						this._noteAgentHookDrop(() => ({ reason: 'wait-caller-unverified', pane: this._tokenFingerprint(token), event: eventType, ...this._agentHookDropSource(url, token) }));
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ ok: false, reason: 'caller not verified' }));
						return;
					}
					this._unconfirmedReleaseTokens.add(token);
					this._unconfirmableTokens.add(token);
					this._runNonThrowingDiagnostic(() => this.logService.info(`[ParadisAgentBrowser] agent-hook released the wait without a verified caller: ${eventType}`));
				} else {
					this._unconfirmedReleaseTokens.delete(token);
					this._unconfirmableTokens.delete(token);
				}
			} else if (checksPendingRelease) {
				// transcript から許可待ちが解かれた後の印は、確かめた hook でだけ外す。確かめられない hook も
				// 捨てずに処理する（tmux・WSL などでは確かめを通れないので、捨てると定期実行の見張りやモバイルの
				// 会話が止まる）。印は IDE 操作ツールの Enter を断る条件にだけ使う。確かめられなかったペインは
				// 次の許可待ちで確かめが通るまで問い合わせない（hook のたびに lsof を起こさない）
				if (callerUnverified === true) {
					this._unconfirmableTokens.add(token);
				} else if (callerUnverified === false) {
					this._unconfirmedReleaseTokens.delete(token);
				}
			}
			// 発信元プロセスの所有権分類。ペイントークンはターミナル配下の全子プロセスへ
			// 継承されるため、所有エージェントの配下で動く別エージェント（例: plugin 経由の
			// `codex exec`）のhookをここで仕分けないと、ペインのセッションrebind・状態・通知の
			// すべてが子に乗っ取られる。分類は状態更新とhookバス発火のどちらよりも前に行う。
			let ownerUnverified = false;
			if (eventType === 'TerminalExit') {
				this._hookOwnership.clear(token);
			} else if (eventType) {
				const pidParam = url.searchParams.get('pid');
				const parsedPid = pidParam !== null && /^\d{1,10}$/.test(pidParam) ? Number.parseInt(pidParam, 10) : undefined;
				// 接続先から届いた hook の pid は**向こうの機械の番号**。所有権の分類が辿るのは
				// 手元のプロセス表なので、そのまま渡すと無関係な手元のプロセスに当たりうる。
				// 番号が偶然ぶつかると、そのプロセスが所有者として焼かれ、以後この接続先の hook が
				// 丸ごと 'invalid' で無言に落ち続ける（接続先の会話が一切出ない状態に戻る）。
				// 素性の分からない発信元として、pid を使わない fail-closed 側の判定へ倒す。
				// 接続先かどうかはクエリの `host=` だけでなくペインの属性でも見る（`host=` の無い古いスクリプトや偽装）
				const paneShell = this._paneShells.get(token);
				const hookPid = remoteHostId !== undefined || paneShell?.remoteAuthority !== undefined ? undefined : parsedPid;
				// ペインのシェルの pid は手元のペインのときだけ渡す（所有者の後継をシェルの子孫に絞る・`claude attach` の会話を
				// 所有者にする判定に使う。接続先の pid は手元のプロセス表と照合できない）。
				const paneShellPid = hookPid !== undefined ? paneShell?.shellPid : undefined;
				const hookOrigin = await this._hookOwnership.classify({ token, hookPid, transcriptPath, at: Date.now(), sessionId, paneShellPid });
				if (!this.isIngressLeaseCurrent(ingressLease)) {
					this._noteAgentHookIngressDrop(req, token, 'lease-lost', 404);
					this._sendIngressRejected(res);
					return;
				}
				ownerUnverified = hookOrigin.unverified === true;
				if (hookOrigin.origin === 'invalid') {
					const rejection = hookOrigin.rejection;
					this._noteAgentHookDrop(() => ({
						reason: rejection?.outsidePane === true ? 'origin-outside-pane' : rejection !== undefined && rejection.identityLoss === undefined ? 'origin-not-ancestor' : 'origin-transcript-mismatch',
						pane: this._tokenFingerprint(token), event: eventType, ...this._agentHookDropSource(url, token),
						identityLoss: rejection?.identityLoss, ownerPinnedBy: rejection?.ownerPinnedBy,
						transcriptPath, ownerTranscriptPath: rejection?.ownerTranscriptPath,
						ownerIdleMs: rejection !== undefined ? Date.now() - rejection.ownerAt : undefined,
						snapshotAgeMs: rejection?.snapshotAgeMs,
					}));
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: false, reason: 'origin rejected' }));
					return;
				}
				if (hookOrigin.origin === 'background') {
					// Claude Code の daemon の配下で動く会話（`/fork` の分岐先・`claude --bg`）。daemon を最初に起こした
					// ペインの token を持っているだけで、そのペインの会話でも子エージェントでもない。ペインの状態・
					// 通知・子エージェントの一覧には出さず、transcript を照合の候補から外すためにだけ知らせる。
					fireParadisAgentNestedHookEvent({
						token, event: eventType, sessionId, transcriptPath, cwd, toolName, toolInput,
						toolUseId, messageId, messageDelta, messageIndex, messageFinal, payload: hookPayload,
						remoteHostId, at: Date.now(), nestedAgent: hookOrigin.agentKind, background: true,
					});
					this._runNonThrowingDiagnostic(() => this.logService.trace(`[ParadisAgentBrowser] agent-hook (daemon-hosted session): ${eventType}`));
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, background: true }));
					return;
				}
				if (hookOrigin.origin === 'nested') {
					fireParadisAgentNestedHookEvent({
						token, event: eventType, sessionId, transcriptPath, cwd, toolName, toolInput,
						toolUseId, messageId, messageDelta, messageIndex, messageFinal, payload: hookPayload,
						remoteHostId, at: Date.now(), nestedAgent: hookOrigin.agentKind,
					});
					this._runNonThrowingDiagnostic(() => this.logService.trace(`[ParadisAgentBrowser] agent-hook (nested ${hookOrigin.agentKind ?? 'unknown'}): ${eventType}`));
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, nested: true }));
					return;
				}
			}
			if (eventType) {
				if (eventType === 'TerminalExit') {
					this._agentHookTokens.delete(token);
					this._hookReportedTokens.delete(token);
					// 確かめられないまま解いた印は、HTTP の TerminalExit では外さない（トークンを持つ誰でも送れるので、
					// 偽の Stop → TerminalExit で印を消して Enter を通す経路になる）。外すのはウィンドウからの
					// 端末の終了の知らせ（_cleanupTokenLocalState）と、確かめた hook だけ。
				} else {
					this._agentHookTokens.add(token);
					this._hookReportedTokens.add(token);
					// hook が届くペインは hook が正本（OSC 7501 の状態は使わない）
					this._programStatusTokens.delete(token);
				}
				// 本物の hook が届いたら、控えから流し直して画面の確認を待っていたものは古い（W2-20）。
				this._replayedPrompts.delete(token);
				this._recordPaneSession(token, eventType, sessionId, transcriptPath, cwd);
				fireParadisAgentHookEvent({
					token, event: eventType, sessionId, transcriptPath, cwd, toolName, toolInput,
					toolUseId, messageId, messageDelta, messageIndex, messageFinal, payload: hookPayload,
					remoteHostId, ...(ownerUnverified ? { ownerUnverified: true } : {}), at: Date.now(),
				});
			}
			if (!this.isIngressLeaseCurrent(ingressLease)) {
				this._noteAgentHookIngressDrop(req, token, 'lease-lost', 404);
				this._sendIngressRejected(res);
				return;
			}

			let normalized = paradisNormalizeAgentHookEvent(eventType, hookMessage);
			// AskUserQuestion の PreToolUse は「選択式質問の回答待ち」の開始（permissionではなく
			// question として扱う）。transcript には決着後まで現れないため、これが唯一のライブ検知点。
			// PermissionRequest も同様: AskUserQuestion は PreToolUse と PermissionRequest の両方を
			// 発火するため、後者を permission にすると質問カードと承認カードが二重表示になる。
			if ((eventType === 'PreToolUse' || eventType === 'PermissionRequest') && toolName === 'AskUserQuestion') {
				normalized = 'question';
			}
			if (normalized === undefined) {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: false, reason: 'ignored event' }));
				return;
			}

			// transcript由来のアクティビティ (ParadisMobileAgentChat の tailer が学習) で補正する:
			//  - ターン終了(Stop)でもバックグラウンドのサブエージェント等が実行中なら「完了」ではなく
			//    「実行中」として表示する (完了通知はタスクが終わって本体が再開・停止した時に出る)
			//  - 質問(AskUserQuestion)が回答待ちの間は working 系イベント (サブエージェントのツール
			//    実行等でも発火する) に赤表示を上書きさせない
			const activity = getParadisAgentPaneActivity(token);
			let backgroundCompletionFallback = false;
			if (normalized === 'review' && eventType === 'Stop' && paradisCountLiveBackgroundTasks(token, Date.now()) > 0) {
				normalized = 'working';
				backgroundCompletionFallback = true;
			}
			// permission も question 中は矯正する: AskUserQuestion は tool_name の無い
			// Notification("permission"を含む本文) や tool_name が取れなかった PermissionRequest
			// でも permission を発火させることがあり、そのまま通すと質問カードの下に
			// 許可/拒否バーが一瞬出る（質問回答待ち中に本物の許可プロンプトは並存しない）。
			// 逆に question は approval で上書きしない: PreToolUse/PermissionRequest の
			// AskUserQuestion 明示検知より、解除され損ねた古い pendingApproval が優先されると
			// 質問中もペインが permission のまま張り付き、モバイルに許可/拒否の2択が出続ける。
			if ((normalized === 'working' || normalized === 'permission') && activity.pendingQuestion) {
				normalized = 'question';
			} else if (normalized === 'working' && activity.pendingApproval) {
				normalized = 'permission';
			}

			// 所有権の分類を待つ間に、別の hook がペインを許可待ち・質問へ入れていることがある。確かめられて
			// いない（または確かめていない）この hook では、その待ちを書き換えない（確かめられた待ちを
			// 確かめられない側へ落とさない。入れた hook も確かめられなかった待ちの解除だけは通す）
			const latest = this._paneStatuses.get(token);
			if ((latest?.status === 'permission' || latest?.status === 'question')
				&& (callerUnverified === undefined ? !inWait : callerUnverified && latest.waitEntryUnverified !== true)) {
				this._runNonThrowingDiagnostic(() => this.logService.info(`[ParadisAgentBrowser] agent-hook left a newer wait alone (caller not verified): ${eventType}`));
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: false, reason: 'caller not verified' }));
				return;
			}
			if (eventType === 'UserPromptSubmit' && !paradisIsHarnessNotificationPrompt(hookPayload?.prompt)) {
				this._userTurnStarts.set(token, Date.now());
			}
			if (normalized === 'idle') {
				this._paneStatuses.delete(token);
			} else if (normalized === 'review') {
				const previous = this._paneStatuses.get(token);
				this._paneStatuses.set(token, this._reviewEntry(token, Date.now(), cwd ?? previous?.cwd));
			} else {
				// cwd はhookが報告した最新値を保持する (今回のイベントに無ければ既知の値を維持)。
				const previous = this._paneStatuses.get(token);
				const knownCwd = cwd ?? previous?.cwd;
				// 待ちへ入れた hook の送り主を確かめられたか。今回確かめていなければ、続いている待ちの記録を引き継ぐ
				const waitEntryUnverified = (normalized === 'permission' || normalized === 'question')
					&& (callerUnverified ?? ((previous?.status === 'permission' || previous?.status === 'question') && previous.waitEntryUnverified === true));
				this._paneStatuses.set(token, {
					status: normalized,
					changedAt: Date.now(),
					...(knownCwd !== undefined ? { cwd: knownCwd } : {}),
					...(backgroundCompletionFallback ? { backgroundCompletionFallback: true } : {}),
					...(waitEntryUnverified ? { waitEntryUnverified: true } : {}),
				});
			}
			this._runNonThrowingDiagnostic(() => this.logService.trace(`[ParadisAgentBrowser] agent-hook: ${eventType} -> ${normalized}`));

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
		} finally {
			activeRequest?.dispose();
			ingressReservation.dispose();
		}
	}

	/**
	 * 確認待ち（review）の記録を作る。同じ利用者のターンで完了の通知を出した後の review は鳴らさない（`quiet`。印は出す。
	 * 規則は paradisIsRepeatedReview）。長いバックグラウンドタスクで親が何度も止まる（完了の知らせで起きては Stop する）
	 * たびに完了の通知が出ていた。
	 */
	private _reviewEntry(token: string, at: number, cwd: string | undefined): IParadisPaneStatusEntry {
		// 確認待ちのまま重ねて届いた Stop は、前の判定のまま（まだ画面が拾っていない初回の通知を消さない）
		const current = this._paneStatuses.get(token);
		if (current?.status === 'review') {
			return { status: 'review', changedAt: at, ...(cwd !== undefined ? { cwd } : {}), ...(current.quiet ? { quiet: true } : {}) };
		}
		const turn = this._userTurnStarts.get(token);
		const certain = getParadisAgentPaneActivity(token).backgroundTasks.size === 0;
		const quiet = paradisIsRepeatedReview(turn, this._announcedReviews.get(token), certain);
		if (turn !== undefined && !quiet) {
			this._announcedReviews.set(token, { turn, certain });
		}
		return { status: 'review', changedAt: at, ...(cwd !== undefined ? { cwd } : {}), ...(quiet ? { quiet: true } : {}) };
	}

	/**
	 * Stop の review がバックグラウンドタスク補正で working になった状態だけを、一定時間後に
	 * reviewへ降格する。通常のPreToolUse→PostToolUse間や長い推論は途中hookが無いため、単に
	 * workingの更新時刻だけを見ると正常な長時間処理を完了扱いにしてしまう。
	 */
	private _sweepStalePaneStatuses(eligibleTokens: ReadonlySet<string>): void {
		const now = Date.now();
		for (const [token, entry] of this._paneStatuses) {
			if (eligibleTokens.has(token)
				&& paradisShouldSweepStaleWorkingStatus(entry.status, entry.backgroundCompletionFallback, entry.changedAt, now, paradisCountLiveBackgroundTasks(token, now))) {
				this._paneStatuses.set(token, this._reviewEntry(token, now, entry.cwd));
			}
		}
	}

	/** workbench のポーリング用: エージェントhookの発火実績があるペイントークン一覧 */
	async listAgentHookTokens(connection: object): Promise<string[]> {
		const eligibleTokens = this._currentEligibleTokens(connection);
		return [...this._agentHookTokens].filter(token => eligibleTokens.has(token));
	}

	/**
	 * ターミナルのシェルプロセス終了を workbench から通知する（renderer の instance.onExit 起点）。
	 * エージェントCLIはクラッシュ・強制終了時に Stop/SessionEnd hook を発火できないため、
	 * ここで実行状態と実績を掃除し、hookバスへ TerminalExit を流してチャットミラーの
	 * ライブ状態（考え中表示）も解除する。
	 */
	async notifyTerminalExit(connection: object, token: string): Promise<boolean> {
		// The pane's shell process is gone, so there is no reason to keep this token isolated and its
		// quarantined binding can never be referenced again. Release before the eligibility gate: a
		// closed/reloaded window drops the connection (so eligibility can fail), and a token whose shell
		// has died must never stay quarantined until the shared process restarts.
		this._releaseTokenQuarantine(token);
		if (!this._isEligibleToken(connection, token)) {
			return false;
		}
		if (this._terminalExitedTokens.has(token)) {
			return true;
		}
		const generation = this._deleteActiveBinding(token);
		this._bindingAuthority.recordBindingMutation(token, undefined);
		this._terminalExitedTokens.add(token);
		this._cleanupTokenLocalState(token, generation, true);
		this._hookOwnership.clear(token);
		this._runNonThrowingCleanup('terminal-exit-hook', () => fireParadisAgentHookEvent({ token, event: 'TerminalExit', sessionId: undefined, transcriptPath: undefined, cwd: undefined, at: Date.now() }));
		this._runNonThrowingCleanup('terminal-exit-acknowledgement', () => this._onDidAcknowledgePane.fire(token));
		return true;
	}

	/** workbench のポーリング用: 現在のペイン実行状態一覧 */
	async listPaneStatuses(connection: object): Promise<IParadisAgentPaneStatus[]> {
		const eligibleTokens = this._currentEligibleTokens(connection);
		this._sweepStalePaneStatuses(eligibleTokens);
		return [...this._paneStatuses]
			.filter(([token]) => eligibleTokens.has(token))
			.map(([token, entry]) => ({ token, status: entry.status, changedAt: entry.changedAt, ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}), ...(entry.quiet && entry.status === 'review' ? { quiet: true as const } : {}) }));
	}

	/** workbench の共有producer用: statusとhook実績を同じowner同期点で返す。 */
	async listAgentStatusSnapshot(connection: object): Promise<IParadisAgentStatusSnapshot> {
		const eligibleTokens = this._currentEligibleTokens(connection);
		this._sweepStalePaneStatuses(eligibleTokens);
		const paneStatuses = [...this._paneStatuses]
			.filter(([token]) => eligibleTokens.has(token))
			.map(([token, entry]) => Object.freeze({ token, status: entry.status, changedAt: entry.changedAt, ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}), ...(entry.quiet && entry.status === 'review' ? { quiet: true as const } : {}) }));
		const agentHookTokens = [...this._agentHookTokens].filter(token => eligibleTokens.has(token));
		// hook実績のある全ペインぶんの Issue URL を同梱する。getParadisAgentPaneIssueUrls は
		// アイドル化しても消えない (paneToken 終了時のみ) ため、ワークスペース一覧側で
		// 「エージェント稼働中」ではなく「ペイン生存中」でマークを出し続けられるようにする。
		// 対象トークンは agentHookTokens ∪ paneStatuses のトークン集合にする必要がある:
		// agentHookTokens は hook イベント (主に Claude) 経由でしか増えず、Codex 等 transcript
		// tailer 由来で _paneStatuses だけに現れるトークンはここに乗らないため
		// (実機レビューで指摘: 素朴に agentHookTokens だけを回すと、hook を送らないエージェント
		// で検出した Issue が一覧から丸ごと落ちる)。
		const issueUrlTokens = new Set<string>([...agentHookTokens, ...paneStatuses.map(status => status.token)]);
		const agentHookTokenIssueUrls = [...issueUrlTokens]
			.map(token => ({ token, issueUrls: [...getParadisAgentPaneIssueUrls(token)] }))
			.filter(entry => entry.issueUrls.length > 0)
			.map(entry => Object.freeze({ token: entry.token, issueUrls: Object.freeze(entry.issueUrls) }));
		const paneSessions = [...this._paneSessions]
			.filter(([token]) => eligibleTokens.has(token))
			.map(([token, session]) => Object.freeze({ token, ...session }));
		// 次の状態が付いたペインは、もう「止まって待っている」ではない
		for (const token of [...this._awaitingUserTokens]) {
			if (this._paneStatuses.has(token)) {
				this._awaitingUserTokens.delete(token);
			}
		}
		const awaitingUserTokens = [...this._awaitingUserTokens].filter(token => eligibleTokens.has(token));
		// 画面の確認を待っている、控えから流し直した許可要求・質問（W2-20）。古くなったものはここで捨てる。
		const replayedPrompts: IParadisReplayedAgentPrompt[] = [];
		for (const [token, pending] of [...this._replayedPrompts]) {
			if (Date.now() - pending.record.at > PARADIS_AGENT_HOOK_REPLAY_PROMPT_WINDOW_MS) {
				this._replayedPrompts.delete(token);
			} else if (eligibleTokens.has(token)) {
				replayedPrompts.push(Object.freeze({ token, status: pending.status }));
			}
		}
		return Object.freeze({
			paneStatuses: Object.freeze(paneStatuses),
			agentHookTokens: Object.freeze(agentHookTokens),
			...(paneSessions.length > 0 ? { paneSessions: Object.freeze(paneSessions) } : {}),
			...(awaitingUserTokens.length > 0 ? { awaitingUserTokens: Object.freeze(awaitingUserTokens) } : {}),
			...(replayedPrompts.length > 0 ? { replayedPrompts: Object.freeze(replayedPrompts) } : {}),
			...(agentHookTokenIssueUrls.length > 0 ? { agentHookTokenIssueUrls: Object.freeze(agentHookTokenIssueUrls) } : {}),
		});
	}

	/** review 状態の確認遷移 (スコープを開いた時に workbench から呼ばれる) */
	async acknowledgePaneStatus(connection: object, token: string): Promise<boolean> {
		if (!this._isEligibleToken(connection, token)) {
			return false;
		}
		const entry = this._paneStatuses.get(token);
		if (entry && entry.status === 'review') {
			this._paneStatuses.delete(token);
			this._runNonThrowingCleanup('pane-acknowledgement', () => this._onDidAcknowledgePane.fire(token));
		}
		return true;
	}

	// --- ワンボタンMCPセットアップ（バインディングダイアログの「自動セットアップ」から呼ばれる） ---

	async setupMcp(request: IParadisMcpSetupRequest): Promise<IParadisMcpSetupResult> {
		if (this._serverDisposed) {
			throw new Error('Para Browser protocol rejected');
		}
		return this._mcpSetupController.setup(request.cli, await this._currentGatewayPort());
	}

	/** バインディングダイアログ「MCP接続設定」タブ表示用のステータス判定（実設定ファイルを読む）。 */
	async getMcpConfigStatus(): Promise<IParadisMcpConfigStatus> {
		if (this._serverDisposed) {
			throw new Error('Para Browser protocol rejected');
		}
		return this._mcpSetupController.status(await this._currentGatewayPort());
	}

	/** 「ワンクリックで修正」/「自動セットアップ」。codexの古いポート決め打ちをHTTP方式の節へ書き換える。 */
	async fixMcp(request: IParadisMcpFixRequest): Promise<IParadisMcpSetupResult> {
		if (this._serverDisposed) {
			throw new Error('Para Browser protocol rejected');
		}
		return this._mcpSetupController.fix(request.cli, await this._currentGatewayPort());
	}

	/** 判定基準となる現在のゲートウェイポート（未起動なら undefined）。 */
	private async _currentGatewayPort(): Promise<number | undefined> {
		try {
			return (await this.getGatewayEndpoint()).port;
		} catch {
			return undefined;
		}
	}

	private async _dispatch(ingressLease: IParadisAgentBrowserIngressLease, rpc: IJsonRpcRequest, signal?: AbortSignal, socket?: Socket): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		switch (rpc.method) {
			case 'initialize': {
				// 新しいエージェント（や接続し直したエージェント）には、サイトメモ（E4）をもう一度添える
				this._siteNotesShown?.delete(ingressLease.token);
				this._siteNoteSpaces?.delete(ingressLease.token);
				const params = rpc.params as { protocolVersion?: unknown } | undefined;
				const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
				const instructions: string | undefined = this._paneRemoteAuthorityOf(ingressLease.token) !== undefined
					? `${this._serverInstructions()}\n\n${PARADIS_REMOTE_PANE_FILE_INSTRUCTIONS}`
					: this._serverInstructions();
				return {
					protocolVersion: requested,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'para-code-agent-browser', version: '1.0.0' },
					...(instructions !== undefined ? { instructions } : {}),
				};
			}
			case 'ping':
				return {};
			case 'tools/list': {
				// para固有ツール＋内蔵chrome-devtools-mcpのツール（子プロセスが起動できない場合は
				// para固有ツールのみに縮退し、一覧自体は失敗させない）
				const tools = await this._listDevtoolsTools(ingressLease, signal);
				this._requireIngressLease(ingressLease);
				// PARA-PATCH: 登録されたツールプロバイダ（モバイル端末操作など）のツールも1本のサーバーに混ぜて出す
				const provided = this._allToolProviders().flatMap(provider => [...provider.listTools()]);
				// ページを操作するツールには、どのタブかを選ぶ `tab_id` を足す（サブエージェントごとに別のタブを使える）
				const listed = [
					...TOOLS.map(tool => PARADIS_TAB_SCOPED_TOOL_NAMES.has(tool.name) ? paradisWithTabIdArgument(tool) : tool),
					...provided,
					...tools.map(tool => paradisWithTabIdArgument(tool)),
				];
				// 接続先のペインには、パスの引数を「エージェントの機械のパス」として説明し直す
				// 操作の後に待つ・状態を添える設定（既定は無効）が有効なら、その引数と説明を足す
				const observeSettings = this._observeSettings?.();
				const observedTools = observeSettings?.settle || observeSettings?.state ? listed.map(tool => paradisWithObserveArguments(tool, observeSettings)) : listed;
				// 手順書の run_steps（E6）は、設定が有効なときだけ説明と引数を替える
				const observed = this._runStepsFlowEnabled?.() === true ? observedTools.map(tool => paradisRunStepsFlowDescriptor(tool)) : observedTools;
				// サイトメモの道具（E4）は、設定が有効なときだけ一覧に出す
				const withNotes = this._siteNotesEnabled?.() === true ? [...observed, ...PARADIS_SITE_NOTE_TOOLS] : observed;
				// サイトの手順の道具（E3）も、設定が有効なときだけ一覧に出す。run_recipe はタブを選べる
				const withRecipes = this._siteRecipesEnabled?.() === true ? [...withNotes, ...PARADIS_SITE_RECIPE_TOOLS.map(tool => tool.name === 'run_recipe' ? paradisWithTabIdArgument(tool) : tool)] : withNotes;
				return { tools: this._paneRemoteAuthorityOf(ingressLease.token) !== undefined ? paradisDescribeToolsForRemotePane(withRecipes) : withRecipes };
			}
			case 'tools/call':
				return this._callTool(ingressLease, rpc.params as { name?: unknown; arguments?: unknown } | undefined, signal, socket);
			default:
				throw new JsonRpcMethodError(-32601, `Method not found: ${rpc.method}`);
		}
	}

	/**
	 * 道具の状態をカーソルの名札に出す（electron-main の `noteExactViewCursorStatus`）。演出なので待たず、
	 * 届かなくても何も変えない。`target` を渡せばそのページへ（道具の始まりのページ。途中で今のタブが替わっても
	 * 終わりの知らせを同じページへ届ける）、無ければ今のタブへ送る。
	 */
	private _noteCursorStatus(ingressLease: IParadisAgentBrowserIngressLease, note: IParadisCursorStatusNote, target?: IBindingEntry): void {
		try {
			const binding = target ?? this._bindingForKey(this._pageKeyOf(ingressLease));
			if (!binding) {
				return;
			}
			void this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<void>('noteExactViewCursorStatus', [binding.exactView, { ...note, owner: this._cursorOwnerFor(ingressLease.token, binding) }])
				.then(undefined, () => undefined);
		} catch {
			// 演出は道具の結果を変えない。
		}
	}

	/** カーソルの持ち主の鍵: ペインのトークン × タブ（タブはビューで表す。同じタブなら tab_id の有無で変わらない）。 */
	private _cursorOwnerKey(token: string, binding: IBindingEntry): string {
		return `${token}\0${binding.exactView.viewId}`;
	}

	/** この入力の持ち主の名前と色。CLI の種類は hook が報告した会話から取る（分からなければ印なし）。 */
	private _cursorOwnerFor(key: string, binding: IBindingEntry): IParadisCursorOwner {
		const token = paradisPaneTokenOfScopeKey(key);
		return this._cursorOwners.resolve(this._cursorOwnerKey(token, binding), JSON.stringify(binding.exactView), this._paneSessions.get(token)?.agent);
	}

	/** `set_cursor_label` と、`open_browser_tab`・`select_browser_tab` の `label`。戻り値は道具の結果の文。 */
	private _setCursorLabel(token: string, binding: IBindingEntry | undefined, raw: unknown): string {
		if (typeof raw !== 'string') {
			return '"label" must be a string.';
		}
		// ブラウザのページが無くても、Computer Use のカーソルの名前としてペインに覚える
		const ownerKey = binding ? this._cursorOwnerKey(token, binding) : `${token}\0${PARADIS_DESKTOP_CURSOR_VIEW}`;
		const result = this._cursorOwners.setLabel(ownerKey, raw.slice(0, 200));
		this._paneCursorLabelKeys.delete(token);
		this._paneCursorLabelKeys.set(token, ownerKey);
		while (this._paneCursorLabelKeys.size > MAX_PANE_CURSOR_LABEL_KEYS) {
			const oldest = this._paneCursorLabelKeys.keys().next();
			if (oldest.done) {
				break;
			}
			this._paneCursorLabelKeys.delete(oldest.value);
		}
		if (!result.ok) {
			return `The name was refused (${result.rejected}); your cursor shows the default name. Name the task, for example "Checkout".`;
		}
		if (result.rateLimited) {
			return `You can change the name up to 3 times a minute; your cursor still shows ${JSON.stringify(result.label)}.`;
		}
		return `Your cursor now shows ${JSON.stringify(result.label)}${result.truncated ? ' (cut to 12 characters wide)' : ''}.`;
	}

	/**
	 * 入力を伴わない道具の間、カーソルの名札に状態を出す（`paradisWithToolCursorStatus`）。知らせは道具の始まりの
	 * ページへ送る（途中で利用者が別のページを共有して今のタブが替わっても、終わりの idle が元のページへ届く）。
	 */
	private _withToolCursorStatus<T>(ingressLease: IParadisAgentBrowserIngressLease, name: string, run: () => Promise<T>, binding?: IBindingEntry): Promise<T> {
		const key = this._pageKeyOf(ingressLease);
		const target = binding ?? this._bindingForKey(key);
		return paradisWithToolCursorStatus(name, this._cursorStatusRuns, target ? paradisToolCursorRunKey(key, target.exactView.viewId) : key, note => {
			if (target) {
				this._noteCursorStatus(ingressLease, note, target);
			}
		}, run);
	}

	/**
	 * ツールの呼び出し。呼び出しの間に届く入力（vendored のツールならゲートウェイ経由）に、カーソルの
	 * 演出のために待ってよいかを伝えるため、どのツールの呼び出しかを台帳に載せる。
	 */
	private async _callTool(ingressLease: IParadisAgentBrowserIngressLease, params: { name?: unknown; arguments?: unknown } | undefined, signal?: AbortSignal, socket?: Socket, nested?: boolean): Promise<unknown> {
		const name = typeof params?.name === 'string' ? params.name : '';
		const pacing = this._cursorPacing.begin(ingressLease.token, name, params?.arguments);
		try {
			// 呼び出し元の照合（負荷が高いと最大 15 秒）は、タブの列に並ぶ前に済ませる。列の中で待つと、確かめられない
			// 呼び出しのたびに同じタブのほかの呼び出しを止める。通ったら結果は接続ごとに覚えるので、列の中の照合はすぐ返る
			const refusal = await this._callerRefusalBeforeLane(ingressLease, name, socket, signal);
			if (refusal !== undefined) {
				return refusal;
			}
			const siteNotes = !nested && this._siteNotesEnabled?.() === true;
			const siteRecipes = !nested && this._siteRecipesEnabled?.() === true;
			if (siteNotes && PARADIS_SITE_NOTE_TOOL_NAMES.has(name)) {
				return await this._siteNoteTool(ingressLease, name, params?.arguments, socket, signal);
			}
			if (siteRecipes && PARADIS_SITE_RECIPE_TOOL_NAMES.has(name)) {
				return await this._siteRecipeTool(ingressLease, name, params?.arguments, socket, signal);
			}
			if ((siteNotes || siteRecipes) && PARADIS_SITE_NOTE_HINT_TOOLS.has(name)) {
				// そのサイトを初めて使った結果に、残されたメモ（E4）と保存した手順の名前（E3）を添える
				const result = await this._callToolDispatch(ingressLease, name, params, signal, socket, nested);
				return await this._withSiteHints(ingressLease, name, params?.arguments, result, { notes: siteNotes, recipes: siteRecipes }, signal);
			}
			return await this._callToolDispatch(ingressLease, name, params, signal, socket, nested);
		} finally {
			pacing.dispose();
		}
	}

	/** 観測（E1・I1）を添えるか決めて道具を呼ぶ（{@link _callTool} の続き）。 */
	private async _callToolDispatch(ingressLease: IParadisAgentBrowserIngressLease, name: string, params: { name?: unknown; arguments?: unknown } | undefined, signal: AbortSignal | undefined, socket: Socket | undefined, nested: boolean | undefined): Promise<unknown> {
		// run_steps の中の手順には添えない（run_steps 全体の後に 1 回だけ）
		const observeSettings = this._observeSettings?.();
		const observeOptions = nested || observeSettings === undefined ? undefined : paradisObserveOptionsFor(name, observeSettings);
		if (observeOptions !== undefined) {
			return this._callToolObserved(ingressLease, name, params, observeOptions, signal, socket);
		}
		return this._callToolInner(ingressLease, params, signal, socket);
	}

	/**
	 * ペインのスペース（メモを分ける鍵）。手元のペインはスペースの最初のフォルダ、接続先のペインは接続先の名前。
	 * 分からなければ undefined（どのリポジトリのメモか決められないので、書きも添えもしない）。
	 */
	private async _siteNoteSpace(ingressLease: IParadisAgentBrowserIngressLease, signal?: AbortSignal): Promise<{ readonly key: string; readonly folder?: string } | undefined> {
		const token = ingressLease.token;
		const remote = this._paneRemoteAuthorityOf(token);
		if (remote !== undefined) {
			return { key: `remote:${remote}` };
		}
		const call = await this._callOwningWindow<unknown>(ingressLease, {
			channelName: PARADIS_AGENT_PREVIEW_CHANNEL,
			method: PARADIS_AGENT_PANE_ROOTS_METHOD,
			args: [token],
			failureLabel: 'site-notes',
			failureMessage: 'Para Code could not resolve the folders of this terminal pane.',
			timeoutMs: 4000,
		}, signal).catch(() => undefined);
		const folder = call?.ok && Array.isArray(call.value) ? call.value.find((value): value is string => typeof value === 'string' && isAbsolute(value)) : undefined;
		return folder !== undefined ? { key: folder, folder } : undefined;
	}

	/** ヒントを添えるときの {@link _siteNoteSpace}。ペインごとに少しの間控える（分からなかったときは控えない）。 */
	private _siteNoteSpaceForHints(ingressLease: IParadisAgentBrowserIngressLease, signal?: AbortSignal): Promise<{ readonly key: string; readonly folder?: string } | undefined> {
		const token = ingressLease.token;
		const cached = this._siteNoteSpaces.get(token);
		if (cached !== undefined && Date.now() - cached.at <= PARADIS_SITE_NOTE_SPACE_CACHE_MS) {
			return cached.space;
		}
		const entry = { space: this._siteNoteSpace(ingressLease, signal), at: Date.now() };
		this._siteNoteSpaces.set(token, entry);
		const forgetFailure = () => {
			if (this._siteNoteSpaces.get(token) === entry) {
				this._siteNoteSpaces.delete(token);
			}
		};
		void entry.space.then(value => value === undefined ? forgetFailure() : undefined, forgetFailure);
		return entry.space;
	}

	/** 書く・消す道具の {@link _siteNoteSpace}。毎回窓に聞き、分かったスペースはヒントの控えにも入れる。 */
	private async _siteNoteSpaceFresh(ingressLease: IParadisAgentBrowserIngressLease, signal?: AbortSignal): Promise<{ readonly key: string; readonly folder?: string } | undefined> {
		const space = await this._siteNoteSpace(ingressLease, signal);
		if (space !== undefined) {
			this._siteNoteSpaces.set(ingressLease.token, { space: Promise.resolve(space), at: Date.now() });
		}
		return space;
	}

	/**
	 * このペインが今使えるタブ（共有されたページと、自分で開いたタブ）の、今の URL（tabId → URL）。共有・許可した
	 * 時点の URL（binding の pageInfo）はタブの中の移動で変わらないので、list_browser_tabs と同じ一覧を窓から読む。
	 * 読めなければ undefined。
	 */
	private async _siteNoteTabUrls(ingressLease: IParadisAgentBrowserIngressLease, signal?: AbortSignal, timeoutMs?: number): Promise<ReadonlyMap<string, string> | undefined> {
		const token = ingressLease.token;
		const call = await this._callOwningWindow<IParadisListAgentTabsResult>(ingressLease, {
			channelName: PARADIS_AGENT_BROWSER_TABS_CHANNEL,
			method: ParadisAgentTabMethod.List,
			args: [token],
			failureLabel: 'site-notes',
			failureMessage: 'Failed to list the browser tabs in Para Code.',
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		}, signal).catch(() => undefined);
		if (!call?.ok || !call.value.ok) {
			return undefined;
		}
		return new Map(call.value.tabs.filter(tab => typeof tab.url === 'string' && this._scopeBinding(token, tab.tabId) !== undefined).map(tab => [tab.tabId, tab.url]));
	}

	/** 道具の結果に、そのサイトのメモ（E4）と保存した手順の名前（E3）を、それぞれペインごとに 1 回だけ添える。 */
	private async _withSiteHints(ingressLease: IParadisAgentBrowserIngressLease, name: string, args: unknown, result: unknown, kinds: { readonly notes: boolean; readonly recipes: boolean }, signal?: AbortSignal): Promise<unknown> {
		if (typeof result !== 'object' || result === null || (result as { isError?: unknown }).isError === true || !Array.isArray((result as { content?: unknown }).content)) {
			return result;
		}
		try {
			const token = ingressLease.token;
			// 道具の後の、そのタブの今の URL（navigate_page や open_browser_tab の後なら移った先）
			// 添えるのはおまけなので、窓の一覧を長く待たない（道具の結果を遅らせない）
			const tabs = await this._siteNoteTabUrls(ingressLease, signal, PARADIS_SITE_HINT_TABS_TIMEOUT_MS);
			const tabId = paradisTakeTabIdArgument(args).tabId ?? this._defaultTabId(token);
			const origin = paradisSiteNoteOrigin(tabId !== undefined ? tabs?.get(tabId) : undefined);
			if (origin === undefined) {
				return result;
			}
			const space = await this._siteNoteSpaceForHints(ingressLease, signal);
			if (space === undefined) {
				return result;
			}
			const shown = this._siteNotesShown.get(token) ?? new Set<string>();
			this._siteNotesShown.set(token, shown);
			const notesKey = `${space.key}\n${origin}`;
			const recipesKey = `recipes\n${notesKey}`;
			const hints: string[] = [];
			if (kinds.notes && !shown.has(notesKey)) {
				shown.add(notesKey);
				const hint = paradisFormatSiteNotesHint(origin, await this._siteNotes.list(space.key, origin));
				if (hint !== undefined) {
					hints.push(hint);
				}
			}
			if (kinds.recipes && !shown.has(recipesKey)) {
				shown.add(recipesKey);
				const hint = paradisFormatSiteRecipesHint(origin, await this._siteRecipes.list(space.key, origin));
				if (hint !== undefined) {
					hints.push(hint);
				}
			}
			if (hints.length === 0) {
				return result;
			}
			const typed = result as { content: unknown[] };
			return { ...typed, content: [...typed.content, ...hints.map(text => ({ type: 'text', text }))] };
		} catch {
			return result;
		}
	}

	/** write_site_note / list_site_notes / delete_site_note（E4）。メモは次のエージェントの文脈に入るので、書き手を確かめる。 */
	private async _siteNoteTool(ingressLease: IParadisAgentBrowserIngressLease, name: string, rawArgs: unknown, socket: Socket | undefined, signal: AbortSignal | undefined): Promise<unknown> {
		const token = ingressLease.token;
		const caller = await this._classifyCaller(token, socket, signal);
		this._requireIngressLease(ingressLease);
		if (caller === 'unverified') {
			return this._toolError(CALLER_UNVERIFIED_PAGE_OPS_MESSAGE);
		}
		const args = isExactRecord(rawArgs) ? rawArgs : {};
		const tabs = await this._siteNoteTabUrls(ingressLease, signal);
		this._requireIngressLease(ingressLease);
		if (tabs === undefined) {
			return this._toolError(`${name}: Para Code could not read the tabs of this terminal pane. Try again.`);
		}
		const defaultTabId = this._defaultTabId(token);
		const origin = paradisSiteNoteOrigin(typeof args.url === 'string' ? args.url : defaultTabId !== undefined ? tabs.get(defaultTabId) : undefined);
		if (origin === undefined) {
			return this._toolError(`${name} needs a website: pass "url" (http or https), or open the site in this pane's current tab first.`);
		}
		const openOrigins = new Set([...tabs.values()].map(url => paradisSiteNoteOrigin(url)));
		if (name !== 'list_site_notes' && !openOrigins.has(origin)) {
			// 開いているページの文が、別のサイトのメモを書き換えさせないように（evil.example から bank.example へ）
			return this._toolError(`${name} only changes notes of a site open in this pane's tabs, and ${origin} is not. Open the site first, or leave the note while you are on it.`);
		}
		const space = await this._siteNoteSpaceFresh(ingressLease, signal);
		this._requireIngressLease(ingressLease);
		if (space === undefined) {
			return this._toolError(`${name}: Para Code could not tell which repository this terminal pane works in, so site notes are not available here.`);
		}
		if (name === 'list_site_notes') {
			return this._toolText(paradisFormatSiteNotesHint(origin, await this._siteNotes.list(space.key, origin)) ?? `No notes for ${origin} in this repository.`);
		}
		if (name === 'delete_site_note') {
			if (typeof args.id !== 'string' || args.id.length === 0) {
				return this._toolError('delete_site_note needs the "id" of a note (see list_site_notes).');
			}
			return await this._siteNotes.delete(space.key, origin, args.id)
				? this._toolText(`Deleted the note ${args.id} of ${origin}.`)
				: this._toolError(`No note ${args.id} for ${origin} in this repository. Call list_site_notes for the ids.`);
		}
		if (typeof args.text !== 'string' || args.text.trim().length === 0) {
			return this._toolError('write_site_note needs "text".');
		}
		if (paradisSiteNoteLooksSecret(args.text)) {
			return this._toolError('write_site_note did not save the note: it looks like it contains a password, token or key. Notes are shown to other agents; describe the step without the secret.');
		}
		let note: IParadisSiteNote;
		try {
			note = await this._siteNotes.write(space.key, origin, args.text, { agent: this._paneSessions.get(token)?.agent, commit: await paradisSiteNoteCommit(space.folder) });
		} catch (error) {
			if (error instanceof ParadisBrowserSiteStoreFullError) {
				return this._toolError(`write_site_note: ${error.message} Call list_site_notes and delete_site_note.`);
			}
			throw error;
		}
		// 書いたペインへはもう添えなくてよい
		const shown = this._siteNotesShown.get(token) ?? new Set<string>();
		shown.add(`${space.key}\n${origin}`);
		this._siteNotesShown.set(token, shown);
		return this._toolText(`Saved the note ${note.id} for ${origin} (${note.date}${note.agent ? `, ${note.agent}` : ''}${note.commit ? `, commit ${note.commit}` : ''}). Later agents in this repository will see it once as a hint when they open the site.`);
	}

	/**
	 * save_recipe / run_recipe / list_recipes / delete_recipe（E3）。手順は次のエージェントが動かすので、書き手を確かめる。
	 * 手順は run_steps の手順書と同じ道筋（{@link _callTool} の入れ子の呼び出し）で、選んだタブに固定して動かす。
	 */
	private async _siteRecipeTool(ingressLease: IParadisAgentBrowserIngressLease, name: string, rawArgs: unknown, socket: Socket | undefined, signal: AbortSignal | undefined): Promise<unknown> {
		const token = ingressLease.token;
		const caller = await this._classifyCaller(token, socket, signal);
		this._requireIngressLease(ingressLease);
		if (caller === 'unverified') {
			return this._toolError(CALLER_UNVERIFIED_PAGE_OPS_MESSAGE);
		}
		const scoped = paradisTakeTabIdArgument(rawArgs);
		if (scoped.invalid) {
			return this._toolError(`${name}: "tab_id" must be a tabId from list_browser_tabs.`);
		}
		const args = isExactRecord(scoped.rest) ? scoped.rest : {};
		const tabs = await this._siteNoteTabUrls(ingressLease, signal);
		this._requireIngressLease(ingressLease);
		if (tabs === undefined) {
			return this._toolError(`${name}: Para Code could not read the tabs of this terminal pane. Try again.`);
		}
		if (scoped.tabId !== undefined && !tabs.has(scoped.tabId)) {
			return this._toolError(`${name}: tab ${scoped.tabId} is not a tab this pane can use. Call list_browser_tabs for usable tabIds.`);
		}
		const tabId = scoped.tabId ?? this._defaultTabId(token);
		if (name === 'run_recipe' && args.url !== undefined) {
			// 動かすのは、タブが今いるサイトの手順だけ（別のサイトの手順を、今のページで動かさない）
			return this._toolError('run_recipe runs the recipes of the site the tab is on now and does not take "url". Open the site first.');
		}
		const origin = paradisSiteNoteOrigin(typeof args.url === 'string' ? args.url : tabId !== undefined ? tabs.get(tabId) : undefined);
		if (origin === undefined) {
			return this._toolError(`${name} needs a website: pass "url" (http or https), or open the site in this pane's current tab first.`);
		}
		if ((name === 'save_recipe' || name === 'delete_recipe') && !new Set([...tabs.values()].map(url => paradisSiteNoteOrigin(url))).has(origin)) {
			// 開いているページの文が、別のサイトの手順を書き換えさせないように
			return this._toolError(`${name} only changes recipes of a site open in this pane's tabs, and ${origin} is not. Open the site first.`);
		}
		const space = await this._siteNoteSpaceFresh(ingressLease, signal);
		this._requireIngressLease(ingressLease);
		if (space === undefined) {
			return this._toolError(`${name}: Para Code could not tell which repository this terminal pane works in, so recipes are not available here.`);
		}
		const recipeName = typeof args.name === 'string' ? args.name.trim() : '';
		switch (name) {
			case 'list_recipes':
				return this._toolText(paradisFormatSiteRecipesList(origin, await this._siteRecipes.list(space.key, origin)));
			case 'delete_recipe':
				return await this._siteRecipes.delete(space.key, origin, recipeName)
					? this._toolText(`Deleted the recipe "${recipeName}" of ${origin}.`)
					: this._toolError(`No recipe "${recipeName}" for ${origin} in this repository. Call list_recipes for the names.`);
			case 'save_recipe': {
				const checked = paradisCheckSiteRecipe(args, { date: new Date(), agent: this._paneSessions.get(token)?.agent, commit: await paradisSiteNoteCommit(space.folder) }, origin);
				if (!checked.ok) {
					return this._toolError(checked.error);
				}
				let replaced: boolean;
				try {
					replaced = await this._siteRecipes.save(space.key, origin, checked.recipe);
				} catch (error) {
					if (error instanceof ParadisBrowserSiteStoreFullError) {
						return this._toolError(`save_recipe: ${error.message} Call list_recipes and delete_recipe.`);
					}
					throw error;
				}
				// 保存したペインへは、手順の名前をもう添えなくてよい
				const shown = this._siteNotesShown.get(token) ?? new Set<string>();
				shown.add(`recipes\n${space.key}\n${origin}`);
				this._siteNotesShown.set(token, shown);
				return this._toolText(`${replaced ? 'Replaced' : 'Saved'} the recipe "${checked.recipe.name}" for ${origin}. Run it with run_recipe${checked.recipe.params.length > 0 ? ` and params ${checked.recipe.params.map(param => param.name).join(', ')}` : ''}; later agents in this repository see its name when they open the site.`);
			}
		}
		// run_recipe
		const recipes = await this._siteRecipes.list(space.key, origin);
		const recipe = recipes.find(item => item.name === recipeName);
		if (recipe === undefined) {
			return this._toolError(`No recipe "${recipeName}" for ${origin} in this repository.${recipes.length > 0 ? ` Saved: ${recipes.map(item => item.name).join(', ')}.` : ''}`);
		}
		const prepared = paradisSiteRecipeSteps(recipe, args.params, origin);
		if (!prepared.ok) {
			return this._toolError(prepared.error);
		}
		// 手順は選んだタブで動かす（途中で既定のタブが動いても、ほかのタブへ飛ばない）
		const withTab = (stepArgs: Record<string, unknown>) => tabId !== undefined && !Object.hasOwn(stepArgs, PARADIS_TAB_ID_ARGUMENT) ? { ...stepArgs, [PARADIS_TAB_ID_ARGUMENT]: tabId } : stepArgs;
		const result = await paradisRunStepsFlow({
			signal,
			sleep: (ms: number) => paradisSleepUnlessAborted(ms, signal),
			callTool: (stepName: string, stepArgs: Record<string, unknown>) => this._callTool(ingressLease, { name: stepName, arguments: withTab(stepArgs) }, signal, socket, true),
		}, { steps: prepared.steps }) as { content: { type: string; text?: string }[]; isError?: boolean };
		if (result.isError !== true) {
			return { ...result, content: [...result.content, { type: 'text', text: `Recipe "${recipe.name}" finished${recipe.doneWhen !== undefined ? ' and its done_when holds' : ''}.` }] };
		}
		// 止まったら、その時のページの頭を添える（直して保存し直せるように）
		const snapshot = await this._siteRecipeSnapshot(ingressLease, withTab({}), signal).catch(() => undefined);
		const snapshotText = isExactRecord(snapshot) && Array.isArray(snapshot.content) ? snapshot.content.map(item => isExactRecord(item) && typeof item.text === 'string' ? item.text : '').join('\n') : '';
		const head = snapshotText.length > PARADIS_SITE_RECIPE_SNAPSHOT_CHARS ? `${snapshotText.slice(0, PARADIS_SITE_RECIPE_SNAPSHOT_CHARS)}\n... (cut; call take_snapshot for the rest)` : snapshotText;
		return { ...result, content: [...result.content, { type: 'text', text: `Recipe "${recipe.name}" stopped at the failed step above. The page now:\n${head}\nFix the steps (the site may have changed) and call save_recipe with the same name "${recipe.name}".` }] };
	}

	/**
	 * run_recipe が止まったときに添えるスナップショット。内蔵の take_snapshot を直接呼び、いつも全体を取る（エージェントの
	 * take_snapshot の扱い、たとえば前回との差分にする設定を通さない。直す手掛かりは全体が要る）。
	 */
	private async _siteRecipeSnapshot(ingressLease: IParadisAgentBrowserIngressLease, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> {
		const scoped = this._scopeToolCall(ingressLease, args);
		return scoped.ok ? this._callDevtoolsTool(scoped.lease, 'take_snapshot', scoped.args, signal) : undefined;
	}

	/**
	 * 呼び出し元を確かめる道具なら、ここで確かめ、確かめられなければ断る（{@link _callResolvedTool} の照合と同じ分け方と文）。
	 * 確かめない道具は undefined。
	 */
	private async _callerRefusalBeforeLane(ingressLease: IParadisAgentBrowserIngressLease, name: string, socket: Socket | undefined, signal: AbortSignal | undefined): Promise<unknown> {
		if (TOOLS.every(tool => tool.name !== name)) {
			return undefined;
		}
		const message = PARADIS_CALLER_VERIFIED_TOOL_NAMES.has(name)
			? CALLER_UNVERIFIED_BROWSER_MESSAGE
			: name === 'read_download' || name === 'capture_screenshot' || PARADIS_PAGE_OPS_TOOL_NAME_SET.has(name) || PARADIS_BROWSER_ACT_TOOL_NAME_SET.has(name)
				? CALLER_UNVERIFIED_PAGE_OPS_MESSAGE
				: undefined;
		if (message === undefined) {
			return undefined;
		}
		const caller = await this._classifyCaller(ingressLease.token, socket, signal);
		this._requireIngressLease(ingressLease);
		return caller === 'unverified' ? this._toolError(message) : undefined;
	}

	/**
	 * 入力・遷移の道具を呼び、成功したら操作の後のページ（E1）とブラウザの状態（I1）を結果の末尾に添える
	 * （paradisBrowserObserve.ts）。観測そのものの失敗は、道具の結果を変えない。
	 *
	 * 観測と操作は同じタブで行う。タブは最初に 1 回だけ決め、操作へは tab_id として渡す（途中で既定のタブが
	 * 変わっても、操作だけが別のタブへ行かない）。前の観測・操作・後の観測は、そのタブの列（paradisToolCallLanes.ts）
	 * を 1 回取ったまま続けて行う（間に同じタブへの別の呼び出しを挟まない）。手順ごとに列へ並ぶ run_steps だけは、
	 * 操作の間は列を手放す。操作の前後でタブの共有（binding）が替わっていたら、後の観測はしない。
	 */
	private async _callToolObserved(ingressLease: IParadisAgentBrowserIngressLease, name: string, params: { name?: unknown; arguments?: unknown } | undefined, options: IParadisObserveOptions, signal?: AbortSignal, socket?: Socket): Promise<unknown> {
		const taken = paradisTakeObserveArguments(params?.arguments);
		const scoped = this._scopeToolCall(ingressLease, taken.rest);
		const tabLease = scoped.ok ? scoped.lease : undefined;
		const tabKey = tabLease !== undefined ? this._pageKeyOf(tabLease) : undefined;
		const binding = tabKey !== undefined ? this._bindingForKey(tabKey) : undefined;
		if (!scoped.ok || tabLease === undefined || tabKey === undefined || binding === undefined) {
			return this._callToolInner(ingressLease, { name, arguments: taken.rest }, signal, socket);
		}
		// 操作に使うタブを固定する（tab_id を省いた呼び出しも、今決めたタブへ）
		const restArgs = isExactRecord(taken.rest) ? taken.rest : {};
		const call = scoped.tabId !== undefined && !Object.hasOwn(restArgs, PARADIS_TAB_ID_ARGUMENT)
			? { name, arguments: { ...restArgs, [PARADIS_TAB_ID_ARGUMENT]: scoped.tabId } }
			: { name, arguments: taken.rest };
		const host = this._observeHost(ingressLease, tabLease, signal);
		const observeBefore = async () => {
			try {
				return await this._browserObserver.before(host, options, taken.observe, taken.settleMs);
			} catch {
				return undefined;
			}
		};
		const observeAfter = async (before: Awaited<ReturnType<typeof observeBefore>>, result: unknown): Promise<unknown> => {
			this._requireIngressLease(ingressLease);
			if (before === undefined || this._bindingForKey(tabKey) !== binding || typeof result !== 'object' || result === null || (result as { isError?: unknown }).isError === true || !Array.isArray((result as { content?: unknown }).content)) {
				return result;
			}
			let note: string | undefined;
			try {
				note = await this._browserObserver.after(host, tabKey, options, before, taken.observe, taken.settleMs);
			} catch {
				note = undefined;
			}
			this._requireIngressLease(ingressLease);
			if (note === undefined) {
				return result;
			}
			const typed = result as { content: unknown[] };
			return { ...typed, content: [...typed.content, { type: 'text', text: note }] };
		};
		if (PARADIS_TOOL_CALL_LANE_EXEMPT_NAMES.has(name)) {
			// run_steps は手順ごとに列へ並ぶので、操作の間は列を持たない（持つと手順が自分を待って止まる）
			const before = await this._toolCallLanes.run(tabKey, observeBefore, signal);
			const result = await this._callToolInner(ingressLease, call, signal, socket);
			return this._toolCallLanes.run(tabKey, () => observeAfter(before, result), signal);
		}
		const observed = await this._toolCallLanes.run(tabKey, async () => {
			// 列に並んでいる間にタブがなくなる・替わることがある。操作が別の列へ並び直すと、2 つの呼び出しが互いの
			// 列を待って止まりうるので、そのときは観測をやめ、列を手放してから普通に呼ぶ
			const scopedNow = this._scopeToolCall(ingressLease, call.arguments);
			if (!scopedNow.ok || this._pageKeyOf(scopedNow.lease) !== tabKey) {
				return undefined;
			}
			const before = await observeBefore();
			const result = await this._callToolInner(ingressLease, call, signal, socket, tabKey);
			return { value: await observeAfter(before, result) };
		}, signal);
		return observed !== undefined ? observed.value : this._callToolInner(ingressLease, { name, arguments: taken.rest }, signal, socket);
	}

	/** 観測（paradisBrowserObserve.ts）に貸す、タブの道具・通信・タブの一覧・ダウンロードの保存先。 */
	private _observeHost(ingressLease: IParadisAgentBrowserIngressLease, tabLease: IParadisAgentBrowserIngressLease, signal?: AbortSignal): IParadisObserveHost {
		const token = ingressLease.token;
		return {
			// 待たずに評価する（vendored の PARA-PATCH。ダイアログが開いていれば断られ、閉じない）
			evaluate: source => this._callDevtoolsTool(tabLease, 'evaluate_script', { function: source, paraCodeObserve: true }, signal),
			listPages: () => this._callDevtoolsTool(tabLease, 'list_pages', {}, signal),
			snapshot: async () => paradisAdjustDevtoolsToolResult('take_snapshot', { args: {}, snapshotOffset: 0 }, await this._callDevtoolsTool(tabLease, 'take_snapshot', {}, signal)),
			// 通信はタブの鍵で見る（ペインの鍵では対象のタブの通信を数えない。wait_until と同じ）
			network: () => this._cdpGateway.getNetworkActivity(this._pageKeyOf(tabLease), 30_000),
			tabs: async () => {
				const call = await this._callOwningWindow<IParadisListAgentTabsResult>(ingressLease, {
					channelName: PARADIS_AGENT_BROWSER_TABS_CHANNEL,
					method: ParadisAgentTabMethod.List,
					args: [token],
					failureLabel: 'list_browser_tabs',
					failureMessage: 'Failed to list the browser tabs in Para Code.',
				}, signal);
				if (!call.ok || !call.value.ok) {
					return undefined;
				}
				const currentTabId = this._defaultTabId(token);
				return call.value.tabs.map(tab => ({ tabId: tab.tabId, url: tab.url, title: tab.title, current: tab.tabId === currentTabId, shared: this._isUserSharedPage(token, tab.tabId) }));
			},
			downloads: async () => {
				const directory = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL).call<string | null>('getAgentDownloadsDirectory').catch(() => null);
				if (typeof directory !== 'string' || directory.length === 0) {
					return undefined;
				}
				const files = new Map<string, number>();
				const entries = await fsPromises.readdir(directory, { withFileTypes: true }).catch(() => []);
				for (const entry of entries.slice(0, 500)) {
					if (entry.isFile()) {
						const stat = await fsPromises.stat(join(directory, entry.name)).catch(() => undefined);
						if (stat) {
							files.set(entry.name, stat.size);
						}
					}
				}
				return files;
			},
			// 取り消された呼び出しは待つのをやめる（列を持ったまま落ち着くのを待ち続けない）
			isCurrent: () => signal?.aborted !== true && this.isIngressLeaseCurrent(ingressLease),
			canEvaluate: () => this._devtoolsProxy.evaluateObserves,
			sleep: ms => paradisSleepUnlessAborted(ms, signal),
			now: () => Date.now(),
		};
	}

	/**
	 * @param heldLane 呼び出し元がすでに持っているタブの列の鍵（{@link _callToolObserved}）。同じ鍵の列には並び直さない
	 * （列は入れ子にできず、並び直すと自分を待って止まる）。
	 */
	private async _callToolInner(ingressLease: IParadisAgentBrowserIngressLease, params: { name?: unknown; arguments?: unknown } | undefined, signal?: AbortSignal, socket?: Socket, heldLane?: string): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		const token = ingressLease.token;
		const name = typeof params?.name === 'string' ? params.name : undefined;
		if (!name) {
			throw new JsonRpcMethodError(-32602, `Unknown tool: ${String(name)}`);
		}
		if (!TOOLS.some(t => t.name === name)) {
			// PARA-PATCH: 登録されたツールプロバイダに先に当てる（自分のツールでなければundefinedを返す約束）
			const context = this._toolCallContext(ingressLease, socket);
			for (const provider of this._allToolProviders()) {
				const result = await provider.callTool(token, name, params?.arguments, signal, context);
				this._requireIngressLease(ingressLease);
				if (result !== undefined) {
					return result;
				}
			}
			// tab_id（省略可）で、どのタブの子プロセスへ回すかを決める。子プロセスへは tab_id を外して渡す
			// （vendored は知らない引数を断る）
			const scopedCall = this._scopeToolCall(ingressLease, params?.arguments);
			if (!scopedCall.ok) {
				return scopedCall.error;
			}
			const pageLease = scopedCall.lease;
			// Para Code だけが付ける内部の引数は、エージェントから来たら捨てる（観測の待たない評価を勝手に使わせない）
			const devtoolsArgs = paradisStripInternalDevtoolsArguments(name, scopedCall.args);
			// 同じタブへの呼び出しは 1 本ずつ（paradisToolCallLanes.ts）。子プロセスの toolMutex は内蔵の道具どうししか
			// 並べないので、Para の道具（click_by など）と同じ列に入れる
			const devtoolsLane = this._pageKeyOf(pageLease);
			return this._runInLane(devtoolsLane, heldLane, async () => {
				// 内蔵chrome-devtools-mcpは手元で動くので、ファイルのパスは手元のパスになる。接続先（SSH・WSL・
				// コンテナ）からのパスは渡す前に断る（手元のファイルの読み書きが機械の境界を越えるため。NOTES.md
				// 「chrome-devtools-mcp のファイルのパスは手元のペインからだけ受け、roots で範囲を絞る」）
				const pathArguments = paradisDevtoolsPathArguments(name, devtoolsArgs);
				if (pathArguments.length > 0) {
					const pathDecision = paradisDevtoolsPathDecision(await this._devtoolsPathCaller(token, socket), name, pathArguments, devtoolsArgs);
					this._requireIngressLease(ingressLease);
					if (pathDecision.kind === 'refuse') {
						// 接続先のペインの `filePath`（スクリーンショット・スナップショットの保存先、upload_file の元）は、
						// 手元の一時ファイルで動かして接続先と中身を受け渡す
						const remoteAuthority = this._paneRemoteAuthorityOf(token);
						const direction = paradisRemoteFileToolDirection(name, pathArguments);
						if (remoteAuthority !== undefined && direction !== undefined) {
							return this._remoteFileTransfer.callTool(name, direction, devtoolsArgs as Record<string, unknown>, this._remoteFileTransferHost(ingressLease, remoteAuthority, name, signal),
								bridgedArgs => this._callDevtoolsTool(pageLease, name, bridgedArgs, signal, false));
						}
						return this._toolError(pathDecision.message);
					}
					// 手元のペイン: シンボリックリンクを通って `.git` などの中を指していないかを、渡す前に realpath で確かめる
					const versionControl = await paradisDevtoolsVersionControlRealpathRefusal(name, pathArguments, devtoolsArgs);
					this._requireIngressLease(ingressLease);
					if (versionControl !== undefined) {
						return this._toolError(versionControl);
					}
				}
				// para固有ツールでなければ、内蔵chrome-devtools-mcpへの転送を試みる
				const devtoolsResult = paradisWithScriptClickHint(name, devtoolsArgs, await this._withToolCursorStatus(pageLease, name, () => this._callDevtoolsTool(pageLease, name, devtoolsArgs, signal)));
				if (paradisFillNeedsInsertTextFallback(name, devtoolsResult)) {
					// キーの抑止を用意できないページでは、fill_by と同じ insertText の経路で入れ直す（paradisBrowserFillFallback.ts）
					return this._refillWithInsertText(ingressLease, pageLease, devtoolsArgs, devtoolsResult, signal, socket);
				}
				return devtoolsResult;
			}, signal);
		}

		// ページを操作する Para のツールは、tab_id（省略可）でどのタブかを決める
		let toolArguments = params?.arguments;
		let pageLease = ingressLease;
		if (PARADIS_TAB_SCOPED_TOOL_NAMES.has(name)) {
			const scopedCall = this._scopeToolCall(ingressLease, toolArguments);
			if (!scopedCall.ok) {
				return scopedCall.error;
			}
			pageLease = scopedCall.lease;
			toolArguments = scopedCall.args;
			if (name === 'run_steps') {
				// 手順は外側で決めたタブで動かす（途中で既定のタブが動いても、ほかのタブへ飛ばない）。
				// 手順ごとの tab_id があればそちらを使う
				const pinnedTabId = scopedCall.tabId;
				const runStepsCall = {
					signal,
					// 決まった時間の待ち（sleep_ms）と条件の確かめ直しの間は、取り消されたらすぐ抜ける
					sleep: (ms: number) => paradisSleepUnlessAborted(ms, signal),
					callTool: (stepName: string, stepArgs: Record<string, unknown>) => this._callTool(ingressLease, {
						name: stepName,
						arguments: pinnedTabId !== undefined && !Object.hasOwn(stepArgs, PARADIS_TAB_ID_ARGUMENT) ? { ...stepArgs, [PARADIS_TAB_ID_ARGUMENT]: pinnedTabId } : stepArgs,
					}, signal, socket, true),
				};
				// 手順書（参照・expect・for_each・repeat_until）は設定が有効なときだけ（E6。paradisBrowserRunStepsFlow.ts）
				return this._runStepsFlowEnabled?.() === true ? paradisRunStepsFlow(runStepsCall, toolArguments) : paradisRunSteps(runStepsCall, toolArguments);
			}
		}

		const laneKey = PARADIS_TOOL_CALL_LANE_EXEMPT_NAMES.has(name) || !PARADIS_TAB_SCOPED_TOOL_NAMES.has(name) ? undefined : this._pageKeyOf(pageLease);
		if (laneKey !== undefined) {
			// 同じタブへの呼び出しは 1 本ずつ（paradisToolCallLanes.ts）。待つのはタブを決めた後なので、tab_id を
			// 省いた呼び出しも、その時点の既定のタブの列に並ぶ
			return this._runInLane(laneKey, heldLane, () => this._callResolvedTool(ingressLease, pageLease, name, toolArguments, params, signal, socket), signal);
		}
		return this._callResolvedTool(ingressLease, pageLease, name, toolArguments, params, signal, socket);
	}

	/** タブの列で動かす。呼び出し元がすでにその列を持っていれば、並び直さずにそのまま動かす。 */
	private _runInLane<T>(key: string, heldLane: string | undefined, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (heldLane !== undefined && key !== heldLane) {
			// 持っている列と違うタブの列に並ぶと、2 つの呼び出しが互いの列を待って止まりうる。並ばずに断る
			// （{@link _callToolObserved} は呼ぶ前にタブを確かめ直すので、ここへ来るのは間にタブが替わったときだけ）
			return Promise.resolve(this._toolError(PARADIS_TAB_CHANGED_DURING_CALL_MESSAGE) as T);
		}
		return key === heldLane ? operation() : this._toolCallLanes.run(key, operation, signal);
	}

	/** タブを決めた後の Para のツールの呼び出し（{@link _callToolInner} の続き）。 */
	private async _callResolvedTool(ingressLease: IParadisAgentBrowserIngressLease, pageLease: IParadisAgentBrowserIngressLease, name: string, toolArguments: unknown, params: { name?: unknown; arguments?: unknown } | undefined, signal: AbortSignal | undefined, socket: Socket | undefined): Promise<unknown> {
		const token = ingressLease.token;
		// 利用者に承認を求める・ページやプロファイルを開く / 切り替える / 消すツールは、トークンだけでなく
		// 接続元のプロセスも確かめる（トークンは同じユーザーの別プロセスが読めるので、他のペインの名で
		// 共有を頼めてしまう）。SSH の接続先のエージェントは戻り経路の ssh（tunnel）として通す。
		// 一覧だけのツールと、ブラウザの共有そのもの（CDP ゲートウェイ）はこれまでどおり
		if (name === 'set_cursor_label') {
			// 呼び出し元のプロセスは確かめない。変えられるのは名札の名前だけ（色と CLI の印は Para Code が決める）で、
			// 同じトークンがあればマウス入力そのものを送れるので、それより強い確認は要らない
			const toolArgs = toolArguments && typeof toolArguments === 'object' ? toolArguments as Record<string, unknown> : {};
			const message = this._setCursorLabel(token, this._bindingForKey(this._pageKeyOf(pageLease)), toolArgs.label);
			return message.startsWith('Your cursor now shows') || message.startsWith('You can change') ? this._toolText(message) : this._toolError(message);
		}

		if (name === 'read_download') {
			// 手元のファイルを読んで返すので、接続元（pane か tunnel）を確かめる
			const caller = await this._classifyCaller(token, socket);
			this._requireIngressLease(ingressLease);
			if (caller === 'unverified') {
				return this._toolError(CALLER_UNVERIFIED_PAGE_OPS_MESSAGE);
			}
			const result = await this._downloadReader.call(params?.arguments);
			this._requireIngressLease(ingressLease);
			return result;
		}

		if (PARADIS_CALLER_VERIFIED_TOOL_NAMES.has(name)) {
			const caller = await this._classifyCaller(token, socket);
			this._requireIngressLease(ingressLease);
			if (caller === 'unverified') {
				return this._toolError(CALLER_UNVERIFIED_BROWSER_MESSAGE);
			}
		}

		if (PARADIS_PAGE_OPS_TOOL_NAME_SET.has(name)) {
			// 追加のブラウザ操作はどれも状態を変えるか、タブへ掛けた上書きを返すので、一覧も含めて
			// 接続元（pane か tunnel）を確かめる。
			const caller = await this._classifyCaller(token, socket);
			this._requireIngressLease(ingressLease);
			if (caller === 'unverified') {
				return this._toolError(CALLER_UNVERIFIED_PAGE_OPS_MESSAGE);
			}
			return this._callPageOpsTool(pageLease, name, toolArguments, signal);
		}

		if (name === 'preview_file') {
			const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : undefined;
			// `filePath` も受ける（他のツールの引数名に合わせて渡してくるエージェントが多い）
			const path = typeof toolArgs?.path === 'string' ? toolArgs.path : typeof toolArgs?.filePath === 'string' ? toolArgs.filePath : undefined;
			// 接続先のペインのパスは接続先のものとして開かせる。台帳に無いペイン・手元のペインのトークンで
			// 戻り経路から来たものは、手元のファイルを開かせない（ゲートウェイ・MCP の層と揃える）
			const remoteAuthority = this._paneRemoteAuthorityOf(token);
			if (remoteAuthority === undefined && typeof path === 'string') {
				const caller = await this._devtoolsPathCaller(token, socket);
				this._requireIngressLease(ingressLease);
				if (!caller.paneKnown) {
					return this._toolError('preview_file was not run: Para Code has not registered this terminal pane yet, so it cannot tell whether the path is on the user\'s local machine. Wait a moment and retry.');
				}
				if (caller.remote) {
					return this._toolError('preview_file was not run: this request came through Para Code\'s return tunnel from a remote window (SSH, WSL, container), so it cannot open files on the user\'s local machine.');
				}
			}
			return this._previewFile(ingressLease, path, signal, remoteAuthority);
		}

		if (PARADIS_AGENT_NOTE_TOOL_OPERATIONS.has(name)) {
			return this._spaceNote(ingressLease, name, params?.arguments, signal);
		}

		if (name === 'open_browser_profile') {
			// バインドを作るツールなので、バインド必須のガードより前で扱う。
			const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : undefined;
			return this._openBrowserProfile(
				ingressLease,
				typeof toolArgs?.profile === 'string' ? toolArgs.profile : undefined,
				typeof toolArgs?.url === 'string' ? toolArgs.url : undefined,
				signal,
			);
		}

		if (PARADIS_AGENT_PROFILE_TOOL_NAMES.has(name)) {
			const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
			return this._agentProfileTool(ingressLease, name, toolArgs, signal);
		}

		if (PARADIS_AGENT_TAB_TOOL_NAMES.has(name)) {
			// タブを開く・共有を移す/頼むツールなので、バインド必須のガードより前で扱う。
			const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
			return this._agentTabTool(ingressLease, name, toolArgs, signal);
		}

		if (name === 'get_session_health') {
			// バインド有無・接続の生死そのものを切り分けるためのツールなので、バインド必須の
			// ガード（この直後の `if (!binding)`）より前で扱う。
			return this._toolText(JSON.stringify(this._buildSessionHealthReport(token), null, 2));
		}

		if (name === 'get_cdp_endpoint') {
			// CDPエンドポイント自体はバインド無しでも案内する（バインド状況も添える）。
			// httpBase（接続元のプロセスでペインを決める）が見せるのは、共有中のページだけ
			const boundEntry = this._bindings.get(token);
			const httpBase = this._port !== undefined ? `http://127.0.0.1:${this._port}/cdp` : undefined;
			const scopedTab = paradisParseAgentTabScopeKey(this._pageKeyOf(pageLease)).tabId;
			const tabEntry = this._bindingForKey(this._pageKeyOf(pageLease));
			if (!httpBase) {
				// allow-any-unicode-next-line
				return this._toolError('CDPゲートウェイのHTTPサーバーがまだ起動していません。少し待って再試行してください。');
			}
			return this._toolText(JSON.stringify({
				httpBase,
				// allow-any-unicode-next-line
				note: 'browser-use など外部の生CDPクライアントのCDP URLにこの httpBase を指定してください。chrome-devtools系ツール（take_snapshot / click / navigate_page 等）はこのMCPサーバーに内蔵済みなので、通常このエンドポイントを直接使う必要はありません。操作できるのはこのターミナルペインに共有されたページのみです。',
				limitations: CDP_LIMITATIONS_NOTE,
				boundPage: boundEntry ? { url: boundEntry.pageInfo.url, title: boundEntry.pageInfo.title, pageId: boundEntry.pageId } : null,
				// tab_id で選んだタブだけを見せる接続（httpBase はペインの共有中のページだけを見せる）。ペインは接続元の
				// プロセスから決めるので、URL にペインのトークンは載せない
				...(scopedTab !== undefined && tabEntry !== undefined && this._port !== undefined
					? { tab: { tabId: scopedTab, url: tabEntry.pageInfo.url, title: tabEntry.pageInfo.title }, tabWebSocketDebuggerUrl: `ws://127.0.0.1:${this._port}/cdp/devtools/browser/${EMBEDDED_DEVTOOLS_WS_ID}?tab=${encodeURIComponent(scopedTab)}` }
					: {}),
				...(boundEntry ? {} : { hint: NOT_BOUND_MESSAGE }),
			}, null, 2));
		}

		const binding = this._bindingForKey(this._pageKeyOf(pageLease));
		if (!binding) {
			return this._toolError(NOT_BOUND_MESSAGE);
		}

		if (PARADIS_BROWSER_QUERY_TOOL_NAME_SET.has(name)) {
			return this._callBrowserQueryTool(pageLease, binding, name, toolArguments, signal);
		}

		if (name === 'capture_screenshot') {
			// ファイルを書くので、接続元（pane か tunnel）を確かめる
			const caller = await this._classifyCaller(token, socket);
			this._requireIngressLease(ingressLease);
			if (caller === 'unverified') {
				return this._toolError(CALLER_UNVERIFIED_PAGE_OPS_MESSAGE);
			}
			return this._callCaptureTool(pageLease, binding, toolArguments, signal, socket);
		}

		if (PARADIS_BROWSER_ACT_TOOL_NAME_SET.has(name)) {
			// マウス・キーを送るので、mouse_action と同じく接続元（pane か tunnel）を確かめる
			const caller = await this._classifyCaller(token, socket);
			this._requireIngressLease(ingressLease);
			if (caller === 'unverified') {
				return this._toolError(CALLER_UNVERIFIED_PAGE_OPS_MESSAGE);
			}
			return this._callBrowserActTool(pageLease, binding, name, toolArguments, signal);
		}

		switch (name) {
			case 'get_shared_page':
				return this._toolText(JSON.stringify({ url: binding.pageInfo.url, title: binding.pageInfo.title, pageId: binding.pageId, shared: this._isUserSharedPage(token, binding.pageId) }, null, 2));
			case 'upload_file_to_drop_zone':
				return this._uploadFileToDropZone(pageLease, binding, toolArguments, signal);
			default:
				throw new JsonRpcMethodError(-32602, `Unknown tool: ${name}`);
		}
	}

	/**
	 * 追加のブラウザ操作（B7）の実体（paradisBrowserPageOps.ts）を呼ぶ。引数（HTTP 認証のパスワードを含む）は
	 * ログにも Sentry にも出さない。失敗の詳細も返さず、ツール名だけを残す。
	 */
	private async _callPageOpsTool(ingressLease: IParadisAgentBrowserIngressLease, name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		// 接続先のペインには、手元に保存した PDF・ダウンロードを接続先のホームの受け渡し用フォルダへ写す
		const remoteAuthority = this._paneRemoteAuthorityOf(ingressLease.token);
		try {
			return await this._pageOps.call({
				// タブのスコープキー: マウスの状態・上書きの持ち主・init scripts はタブごと
				token: this._pageKeyOf(ingressLease),
				signal,
				requireCurrent: () => this._requireIngressLease(ingressLease),
				resolveElement: uid => this._resolveElementForPageOps(ingressLease, uid, signal),
				confirmPaneProfile: async profileId => {
					const call = await this._callOwningWindow<boolean>(ingressLease, {
						channelName: PARADIS_BROWSER_PROFILE_MCP_CHANNEL,
						method: PARADIS_BROWSER_PROFILE_MCP_PANE_OWNED_METHOD,
						args: [ingressLease.token, profileId],
						failureLabel: name,
						failureMessage: 'Para Code could not check who uses the browser profile of this tab.',
					}, signal);
					return call.ok && call.value === true;
				},
				...(remoteAuthority !== undefined ? {
					deliverSavedFile: (localPath: string) => this._remoteFileTransfer.deliverToRemoteTemporaryFolder(localPath, this._remoteFileTransferHost(ingressLease, remoteAuthority, name, signal)),
				} : {}),
			}, name, args);
		} catch (error) {
			if (error instanceof ParadisIngressLeaseError || !this.isIngressLeaseCurrent(ingressLease)) {
				throw new ParadisIngressLeaseError();
			}
			this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] ${name} failed for pane ${this._tokenFingerprint(ingressLease.token)}`));
			return this._toolError(`PARA_BROWSER_RETRYABLE: ${name} failed inside Para Code. Retry once; if it keeps failing, call get_session_health.`);
		}
	}

	/**
	 * 読む・待つツール（paradisBrowserQuery.ts）を呼ぶ。ページで動かすのは内蔵 chrome-devtools-mcp の
	 * evaluate_script と同じ経路なので、接続元の確認も evaluate_script と同じ（トークンと ingress lease）。
	 */
	private async _callBrowserQueryTool(ingressLease: IParadisAgentBrowserIngressLease, binding: IBindingEntry, name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		// タブのスコープキー（tab_id を解決していなければペインのトークン）
		const token = this._pageKeyOf(ingressLease);
		return this._withToolCursorStatus(ingressLease, name, () => this._browserQuery.call({
			signal,
			isCurrent: () => {
				this._requireIngressLease(ingressLease);
				return this._bindingForKey(token) === binding;
			},
			networkActivity: ignoreOlderThanMs => this._cdpGateway.getNetworkActivity(token, ignoreOlderThanMs),
			// 枠だけを出す（名札の状態は道具の始まりと終わりの知らせが持つ）
			noteLook: rect => this._noteCursorStatus(ingressLease, { rect }, binding),
			evaluate: async (functionSource, uids) => {
				try {
					// 待っている間に開いたダイアログ（confirm など）を承認しないよう、閉じる側にする
					return await this._callDevtoolsTool(ingressLease, 'evaluate_script', { function: functionSource, ...(uids.length > 0 ? { args: [...uids] } : {}), dialogAction: 'dismiss' }, signal);
				} catch (error) {
					if (error instanceof ParadisIngressLeaseError || !this.isIngressLeaseCurrent(ingressLease)) {
						throw new ParadisIngressLeaseError();
					}
					return this._toolError(`${name} could not run because the embedded DevTools bridge is unavailable right now. Call get_session_health to check its status, then retry.`);
				}
			},
		}, name, args), binding);
	}

	/**
	 * 内蔵の `fill` がキーの抑止を用意できずに断られたとき、fill_by（uid で探す）で入れ直す。fill_by と同じく
	 * 接続元（pane か tunnel）を確かめ、確かめられなければ元の失敗を返す。
	 */
	private async _refillWithInsertText(ingressLease: IParadisAgentBrowserIngressLease, pageLease: IParadisAgentBrowserIngressLease, args: unknown, originalResult: unknown, signal: AbortSignal | undefined, socket: Socket | undefined): Promise<unknown> {
		const fillArgs = paradisFillFallbackArgs(args);
		const binding = this._bindingForKey(this._pageKeyOf(pageLease));
		if (!fillArgs || !binding || signal?.aborted) {
			return originalResult;
		}
		const caller = await this._classifyCaller(ingressLease.token, socket);
		this._requireIngressLease(ingressLease);
		if (caller === 'unverified' || this._bindingForKey(this._pageKeyOf(pageLease)) !== binding) {
			return originalResult;
		}
		const refilled = await this._callBrowserActTool(pageLease, binding, 'fill_by', fillArgs, signal);
		return paradisMergeFillFallbackResult(originalResult, refilled);
	}

	/**
	 * 探して操作するツール（paradisBrowserActBy.ts）を呼ぶ。探すのは読む・待つツールと同じ evaluate_script、
	 * 押す・入れるのは mouse_action と同じ入力の通り道（ユーザーがそのタブを使っている間は断られる）。
	 */
	private async _callBrowserActTool(ingressLease: IParadisAgentBrowserIngressLease, binding: IBindingEntry, name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		// タブのスコープキー（tab_id を解決していなければペインのトークン）
		const token = this._pageKeyOf(ingressLease);
		return this._browserActBy.call({
			signal,
			isCurrent: () => {
				this._requireIngressLease(ingressLease);
				return this._bindingForKey(token) === binding;
			},
			evaluate: async (functionSource, uids) => {
				try {
					return await this._callDevtoolsTool(ingressLease, 'evaluate_script', { function: functionSource, ...(uids.length > 0 ? { args: [...uids] } : {}), dialogAction: 'dismiss' }, signal);
				} catch (error) {
					if (error instanceof ParadisIngressLeaseError || !this.isIngressLeaseCurrent(ingressLease)) {
						throw new ParadisIngressLeaseError();
					}
					return this._toolError(`${name} could not run because the embedded DevTools bridge is unavailable right now. Call get_session_health to check its status, then retry.`);
				}
			},
			dispatch: (method, params) => this._dispatchBoundPageInput(token, {}, binding.exactView.targetId, method, JSON.stringify(params), () => this._bindingForKey(token) === binding).response,
			noteCursor: note => this._noteCursorStatus(ingressLease, note, binding),
		}, name, args);
	}

	/**
	 * capture_screenshot（paradisBrowserCapture.ts）を呼ぶ。撮るのは take_screenshot と同じ electron-main の撮影。
	 * `saveTo` は、接続先のペインなら接続先のパスへ書き戻す既存の経路（take_screenshot の filePath と同じ）、
	 * 手元のペインならスペースのフォルダと一時フォルダの中だけに書く。
	 */
	private async _callCaptureTool(ingressLease: IParadisAgentBrowserIngressLease, binding: IBindingEntry, args: unknown, signal: AbortSignal | undefined, socket: Socket | undefined): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		// タブのスコープキー（tab_id を解決していなければペインのトークン）
		const token = this._pageKeyOf(ingressLease);
		return this._browserCapture.call({
			isCurrent: () => {
				this._requireIngressLease(ingressLease);
				return this._bindingForKey(token) === binding;
			},
			evaluate: async (functionSource, uids) => {
				try {
					return await this._callDevtoolsTool(ingressLease, 'evaluate_script', { function: functionSource, ...(uids.length > 0 ? { args: [...uids] } : {}), dialogAction: 'dismiss' }, signal);
				} catch (error) {
					if (error instanceof ParadisIngressLeaseError || !this.isIngressLeaseCurrent(ingressLease)) {
						throw new ParadisIngressLeaseError();
					}
					return this._toolError('capture_screenshot could not run because the embedded DevTools bridge is unavailable right now. Call get_session_health to check its status, then retry.');
				}
			},
			capture: async options => {
				const data = await this._captureBoundPageScreenshot(token, options);
				if (!data) {
					throw new Error('PARA_BROWSER_RETRYABLE: the BrowserView returned no screenshot; retry.');
				}
				return data;
			},
			save: (path, data) => this._saveAgentFile(ingressLease, path, data, signal, socket),
		}, args);
	}

	/** エージェントの機械のパスへ書く（capture_screenshot の saveTo）。 */
	private async _saveAgentFile(ingressLease: IParadisAgentBrowserIngressLease, path: string, data: Buffer, signal: AbortSignal | undefined, socket: Socket | undefined): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string }> {
		const token = ingressLease.token;
		const remoteAuthority = this._paneRemoteAuthorityOf(token);
		if (remoteAuthority !== undefined) {
			const result = await this._remoteFileTransfer.callTool('capture_screenshot', 'output', { filePath: path }, this._remoteFileTransferHost(ingressLease, remoteAuthority, 'capture_screenshot', signal), async bridged => {
				await fsPromises.writeFile(bridged.filePath as string, data);
				return this._toolText('saved');
			});
			this._requireIngressLease(ingressLease);
			const record = result as { isError?: unknown; content?: { text?: unknown }[] };
			if (record.isError === true) {
				const message = typeof record.content?.[0]?.text === 'string' ? record.content[0].text : 'the file could not be written.';
				return { ok: false, message: message.replace(/^capture_screenshot (was not run|ran, but)\s*:?\s*/, '') };
			}
			const line = record.content?.map(part => part.text).find((value): value is string => typeof value === 'string' && value.startsWith('The file was written to '));
			const written = line?.slice('The file was written to '.length).replace(/ on the machine this agent runs on.*$/s, '');
			return { ok: true, path: written ?? path };
		}
		const caller = await this._devtoolsPathCaller(token, socket);
		this._requireIngressLease(ingressLease);
		if (caller.remote) {
			return { ok: false, message: 'this request came through Para Code\'s return tunnel from a remote window, so it cannot write files on the user\'s local machine. Omit "saveTo" to get the images inline.' };
		}
		if (!caller.paneKnown) {
			return { ok: false, message: 'Para Code has not registered this terminal pane yet, so it cannot tell where it may write. Retry in a few seconds, or omit "saveTo".' };
		}
		const roots = await this._resolveDevtoolsRoots(token);
		this._requireIngressLease(ingressLease);
		const temporary = this._devtoolsProxy.ensureTemporaryDirectory();
		const refusal = await paradisCaptureLocalPathRefusal(path, [...roots.folders, ...(temporary !== undefined ? [temporary] : [])]);
		if (refusal !== undefined) {
			return { ok: false, message: refusal };
		}
		try {
			await fsPromises.mkdir(dirname(path), { recursive: true });
			// 確かめたのはフォルダまで。ファイル自体がシンボリックリンク（外を指しうる）なら書かない
			const existing = await fsPromises.lstat(path).catch(() => undefined);
			if (existing !== undefined && !existing.isFile()) {
				return { ok: false, message: `${path} already exists and is not a regular file (for example a symbolic link), so Para Code does not overwrite it. Choose another path.` };
			}
			const handle = await fsPromises.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0), 0o644);
			try {
				await handle.writeFile(data);
			} finally {
				await handle.close();
			}
		} catch {
			return { ok: false, message: `Para Code could not write ${path} (permissions, a symbolic link, or the disk is full).` };
		}
		this._requireIngressLease(ingressLease);
		return { ok: true, path };
	}

	/** uid の要素の中心座標などを evaluate_script で求める（upload_file_to_drop_zone と同じ関数）。 */
	private async _resolveElementForPageOps(ingressLease: IParadisAgentBrowserIngressLease, uid: string, signal?: AbortSignal): Promise<{ readonly ok: true; readonly target: IParadisResolvedDropTarget } | { readonly ok: false; readonly result: unknown }> {
		let evaluation: unknown;
		try {
			evaluation = await this._callDevtoolsTool(ingressLease, 'evaluate_script', { function: PARADIS_RESOLVE_ELEMENT_CENTER_FUNCTION, args: [uid] }, signal);
		} catch (error) {
			if (error instanceof ParadisIngressLeaseError) {
				throw error;
			}
			return { ok: false, result: this._toolError('The position of the element could not be resolved because the embedded DevTools bridge is unavailable right now. Call get_session_health to check its status, then retry (or pass x/y coordinates instead of a uid).') };
		}
		this._requireIngressLease(ingressLease);
		if ((evaluation as { isError?: unknown } | undefined)?.isError === true) {
			return { ok: false, result: evaluation };
		}
		const target = paradisParseResolvedDropTarget(evaluation);
		if (!target) {
			return { ok: false, result: this._toolError(`Could not resolve the position of uid "${uid}". Take a fresh take_snapshot and make sure the uid still refers to a visible element.`) };
		}
		return { ok: true, target };
	}

	/**
	 * 内蔵chrome-devtools-mcp（ペイン毎の子プロセス）のツール一覧を返す。
	 * 起動や応答に失敗した場合は空配列に縮退する（para固有ツールの提供は妨げない）。
	 */
	private async _listDevtoolsTools(ingressLease: IParadisAgentBrowserIngressLease, signal?: AbortSignal): Promise<IParadisProxiedTool[]> {
		this._requireIngressLease(ingressLease);
		// 一覧は全ペイン共通で一度だけ取る。子プロセスを起こすなら、次のツール呼び出しでも使う既定のタブのものにする
		const scoped = this._scopeToolCall(ingressLease, undefined);
		const token = scoped.ok ? this._pageKeyOf(scoped.lease) : ingressLease.token;
		const paneToken = ingressLease.token;
		const wsEndpoint = this._devtoolsWsEndpoint(token);
		if (!wsEndpoint) {
			return [];
		}
		return this._devtoolsGenerationCoordinator.runWithLease(token, async () => {
			try {
				this._requireIngressLease(ingressLease);
				const generation = this._bindingForKey(token)?.generation ?? this._devtoolsGenerationCoordinator.getGeneration(token) ?? 0;
				const tools = await this._devtoolsProxy.listTools(token, generation, wsEndpoint, signal);
				this._requireIngressLease(ingressLease);
				return tools;
			} catch (error) {
				if (error instanceof ParadisIngressLeaseError || !this.isIngressLeaseCurrent(ingressLease)) {
					throw new ParadisIngressLeaseError();
				}
				const message = error instanceof Error ? error.message : String(error);
				const safeMessage = message
					.replaceAll(wsEndpoint, '<redacted-endpoint>')
					.replaceAll(encodeURIComponent(paneToken), this._tokenFingerprint(paneToken))
					.replaceAll(paneToken, this._tokenFingerprint(paneToken));
				this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] Embedded chrome-devtools-mcp is unavailable for pane ${this._tokenFingerprint(paneToken)}; serving para-browser tools only: ${safeMessage}`));
				return [];
			}
		});
	}

	/**
	 * パスの引数を受けてよいかを決めるための、呼び出し元の属性。接続元の確認（`_classifyCaller`）が
	 * `tunnel` と `pane` のどちらで確かめるかを決めるのと同じ、ペインの `remoteAuthority` で見る
	 * （名乗りや環境変数では決めない）。加えて、手元のペインのトークンでも、接続の相手が Para Code の
	 * 張った戻り経路の ssh なら接続先からの呼び出しとして扱う（トークンが接続先へ漏れた場合）。
	 * 手元のペインに `pane`（シェルの子孫）であることは求めない（tmux・WSL・採用した Codex app-server で
	 * パスが使えなくなるため）。
	 */
	private async _devtoolsPathCaller(token: string, socket: Socket | undefined): Promise<IParadisDevtoolsPathCaller> {
		if (this._paneRemoteAuthorityOf(token) !== undefined) {
			return { paneKnown: this._paneShells.has(token), remote: true };
		}
		if (!this._paneShells.has(token)) {
			return { paneKnown: false, remote: false };
		}
		const remotePort = socket?.remotePort;
		const localPort = socket?.localPort;
		const viaTunnel = typeof remotePort === 'number' && typeof localPort === 'number' && await this._isTunnelPeer(remotePort, localPort);
		return { paneKnown: true, remote: viaTunnel };
	}

	/**
	 * CDP ゲートウェイ向け: 接続先のペインか。台帳に無いトークンも接続先として扱う（手元のファイルに触れる
	 * コマンドだけが断られる側へ倒す。MCP の層で台帳に無いペインのパスを断るのと揃える）。
	 */
	private _isRemotePaneForGateway(token: string): boolean {
		return this._paneRemoteAuthorityOf(token) !== undefined || !this._paneShells.has(token);
	}

	/** ペインの接続先。手元のペイン・知らないトークンは undefined。 */
	private _paneRemoteAuthorityOf(token: string): string | undefined {
		return this._paneRemoteAuthorities.get(token) ?? this._paneShells.get(token)?.remoteAuthority;
	}

	/**
	 * loopback 接続の相手が、Para Code の張った戻り経路（`ssh -R`）のプロセスか。戻り経路が1本も無ければ
	 * プロセス表を調べず false。戻り経路があるのに相手を特定できない（lsof 等の失敗）ときは true
	 * （手元のファイルに触れる操作だけが断られる側へ倒す）。
	 */
	private async _isTunnelPeer(remotePort: number, localPort: number): Promise<boolean> {
		const tunnels = this._remoteTunnels;
		if (tunnels === undefined || localPort !== this._port) {
			return false;
		}
		const pids = tunnels.authorities
			.map(authority => tunnels.processPidFor(authority))
			.filter((pid): pid is number => pid !== undefined);
		if (pids.length === 0) {
			return false;
		}
		try {
			return await paradisPeerIsOneOf(remotePort, localPort, process.pid, pids) ?? true;
		} catch {
			return true;
		}
	}

	/**
	 * 内蔵chrome-devtools-mcpの `roots/list` に載せる、ペインの手元のフォルダ。ペインのスペースのフォルダを、
	 * ペインを所有するウィンドウに尋ね、利用者の一時フォルダ（{@link paradisDevtoolsUserTemporaryFolders}）を足す。
	 * 接続先のペインは空（子プロセスの roots は Para Code の一時フォルダだけになる）。ペインやウィンドウが
	 * まだ分からないときは一時フォルダだけを「揃っていない」として返す（proxy が後で引き直す）。
	 */
	private async _resolveDevtoolsRoots(token: string): Promise<IParadisDevtoolsRootsResolution> {
		if (this._paneRemoteAuthorityOf(token) !== undefined) {
			return { folders: [], complete: true };
		}
		const pane = this._paneShells.get(token);
		const temporaryFolders = paradisDevtoolsUserTemporaryFolders();
		const degraded = { folders: temporaryFolders, complete: false };
		const ingressLease = pane === undefined ? undefined : this.captureIngressLease(token);
		if (ingressLease === undefined) {
			return degraded;
		}
		try {
			const call = await this._callOwningWindow<unknown>(ingressLease, {
				channelName: PARADIS_AGENT_PREVIEW_CHANNEL,
				method: PARADIS_AGENT_PANE_ROOTS_METHOD,
				args: [token],
				failureLabel: 'devtools-roots',
				failureMessage: 'Para Code could not resolve the folders of this terminal pane.',
				timeoutMs: 4000,
			});
			if (!call.ok || !Array.isArray(call.value)) {
				return degraded;
			}
			const folders = call.value.filter((folder): folder is string => typeof folder === 'string' && isAbsolute(folder));
			return { folders: [...folders, ...temporaryFolders], complete: true };
		} catch {
			return degraded;
		}
	}

	/** ツール呼び出しを内蔵chrome-devtools-mcpへ転送する（転送対象外の名前は -32602）。 */
	private async _callDevtoolsTool(ingressLease: IParadisAgentBrowserIngressLease, name: string, args: unknown, signal?: AbortSignal, offerScreenshotHandoff: boolean = true): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		// 子プロセスと世代はタブのスコープキーごと（tab_id を解決していなければペインのトークン）。別のタブの
		// 子プロセスは別なので、別のタブへの呼び出しは並行に走る
		const token = this._pageKeyOf(ingressLease);
		return this._devtoolsGenerationCoordinator.runWithLease(token, async () => {
			this._requireIngressLease(ingressLease);
			const binding = this._bindingForKey(token);
			const generation = binding?.generation ?? this._devtoolsGenerationCoordinator.getGeneration(token) ?? 0;
			const wsEndpoint = this._devtoolsWsEndpoint(token);
			const proxied = wsEndpoint ? await this._devtoolsProxy.isProxiedTool(token, generation, wsEndpoint, name, signal) : false;
			this._requireIngressLease(ingressLease);
			const currentAfterLookup = this._bindingForKey(token);
			if (currentAfterLookup !== binding || !this._devtoolsGenerationCoordinator.isCurrentGeneration(token, generation)) {
				return this._toolError('PARA_BROWSER_RETRYABLE: binding changed while the tool was running');
			}
			if (wsEndpoint && proxied) {
				// DevToolsツールは全て「ペインに共有されたページ」前提。未共有なら既存ツールと
				// 同じ案内文を返す（子プロセス側の英語エラーより行動可能なガイダンスを優先）。
				if (!binding) {
					return this._toolError(NOT_BOUND_MESSAGE);
				}
				const result = await this._devtoolsProxy.tryCallTool(token, generation, wsEndpoint, name, args, signal);
				this._requireIngressLease(ingressLease);
				const current = this._bindingForKey(token);
				if (current !== binding || !this._devtoolsGenerationCoordinator.isCurrentGeneration(token, generation)) {
					return this._toolError('PARA_BROWSER_RETRYABLE: binding changed while the tool was running');
				}
				if (result !== undefined) {
					// ファイルへ落ちたスクリーンショットは、呼び出し元が別の機械に居ると見えない。
					// 取りに来るための口を添える（保存に失敗した場合も、どこへ書こうとしたかは示す）。
					return name === 'take_screenshot' && offerScreenshotHandoff ? this._offerScreenshotHandoff(ingressLease.token, result, args) : result;
				}
			}
			throw new JsonRpcMethodError(-32602, `Unknown tool: ${name}`);
		});
	}

	/**
	 * `upload_file_to_drop_zone` の実体。座標解決を内蔵chrome-devtools-mcpの `evaluate_script`
	 * （uid引数付き）へ委譲し、取れた中心座標へ dragEnter → dragOver → drop の
	 * `Input.dispatchDragEvent` 列を `_dispatchBoundPageInput` 経由で信頼済み配信する
	 * （組み立て・base64検証・一時ファイル書き出しは paradisFileDropUpload.ts が担う）。
	 */
	private async _uploadFileToDropZone(ingressLease: IParadisAgentBrowserIngressLease, binding: IBindingEntry, args: unknown, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		// タブのスコープキー（tab_id を解決していなければペインのトークン）
		const token = this._pageKeyOf(ingressLease);
		const toolArgs = args && typeof args === 'object' ? args as Record<string, unknown> : undefined;
		const uid = typeof toolArgs?.uid === 'string' && toolArgs.uid.length > 0 ? toolArgs.uid : undefined;
		const fileName = paradisSanitizeFileDropName(toolArgs?.fileName);
		const content = paradisDecodeFileDropContent(toolArgs?.contentBase64);
		if (!uid) {
			return this._toolError('upload_file_to_drop_zone requires "uid" (the drop zone element\'s uid from a recent take_snapshot).');
		}
		if (fileName === undefined) {
			return this._toolError('upload_file_to_drop_zone requires a valid "fileName" (no path separators or control characters, 1-200 characters).');
		}
		if (content === undefined) {
			return this._toolError(`upload_file_to_drop_zone requires "contentBase64" to be non-empty, valid base64, and decode to at most ${PARADIS_FILE_DROP_MAX_BYTES_LABEL} — this is the MCP transport's request-size limit, not an arbitrary choice; a larger value would make the whole MCP connection for this pane crash.`);
		}

		// 座標解決: uid → 要素は chrome-devtools-mcp内部の状態でしかないため、evaluate_script
		// (vendored、uid引数付き) へ委譲してビューポート座標を取得する。評価関数自身に
		// scrollIntoViewさせ、メインフレーム所属か・ビューポート寸法・遮蔽の有無も一緒に返させる
		// ことで、「iframe内の別要素」「スクロール外」「stickyヘッダー/モーダルに覆われている」を
		// 後段で検出できるようにしている（HIGH-2 / Warning対応）。
		// - behavior: "instant" を明示: 省略するとページの `scroll-behavior: smooth` に従い、
		//   アニメーション中に getBoundingClientRect() が走ってスクロール前の座標を返しかねない。
		// - occluded: 中心座標へ document.elementFromPoint した実際の最前面要素が、対象要素
		//   自身でもその祖先/子孫でもなければ true（信頼済み入力なので、無関係な要素へ誤って
		//   ドロップしないよう後段で拒否する）。
		let evaluation: unknown;
		try {
			evaluation = await this._callDevtoolsTool(ingressLease, 'evaluate_script', {
				function: PARADIS_RESOLVE_ELEMENT_CENTER_FUNCTION,
				args: [uid],
			}, signal);
		} catch (error) {
			if (error instanceof ParadisIngressLeaseError) {
				throw error;
			}
			// evaluate_scriptがツールとして解決できない＝内蔵DevToolsブリッジが使えない状態。
			// JSON-RPCの生エラーではなくLLMが読める案内にする（get_session_healthへの誘導つき）。
			return this._toolError('upload_file_to_drop_zone could not resolve the drop zone\'s position because the embedded DevTools bridge is unavailable right now. Call get_session_health to check its status, then retry.');
		}
		this._requireIngressLease(ingressLease);
		if ((evaluation as { isError?: unknown } | undefined)?.isError === true) {
			// 既にLLMが読める形のエラー（evaluate_script側のuid未解決メッセージ等）なのでそのまま返す。
			return evaluation;
		}
		const target = paradisParseResolvedDropTarget(evaluation);
		if (!target) {
			return this._toolError(`Could not resolve the drop zone's position from uid "${uid}". Take a fresh take_snapshot and make sure the uid still refers to a visible element.`);
		}
		if (target.width <= 0 || target.height <= 0) {
			return this._toolError(`The drop zone (uid "${uid}") has zero size, so it may not currently be visible or laid out. Take a fresh take_snapshot and retry.`);
		}
		if (!target.inMainFrame) {
			// Input.dispatchDragEvent の x/y はメインフレームのビューポート基準なので、iframe内の
			// 要素へは正しい座標を出せない（別の要素へ誤ってドロップされかねない、信頼済み入力なので
			// サイレントな誤動作は避ける）。
			return this._toolError(`The drop zone (uid "${uid}") is inside a nested frame (iframe). upload_file_to_drop_zone only supports drop zones in the page's main frame, because trusted drag-and-drop coordinates are relative to the main frame's viewport and would land on the wrong element inside a nested frame.`);
		}
		if (target.x < 0 || target.y < 0 || target.x >= target.viewportWidth || target.y >= target.viewportHeight) {
			return this._toolError(`The drop zone (uid "${uid}") is not currently within the visible viewport (resolved at (${Math.round(target.x)}, ${Math.round(target.y)}) against a ${Math.round(target.viewportWidth)}x${Math.round(target.viewportHeight)} viewport), so a trusted drop there would miss it or land on the wrong element. Take a fresh take_snapshot after any scrolling/animation settles and retry.`);
		}
		if (target.occluded) {
			// 中心座標の実際の最前面要素が対象要素自身でもその祖先/子孫でもない＝stickyヘッダーや
			// モーダル等に覆われている。信頼済み入力なので、無関係な要素への誤ドロップを避ける。
			return this._toolError(`The drop zone (uid "${uid}") is currently covered by another element at its center point (for example a sticky header, overlay, or modal), so a trusted drop there would land on that element instead. Dismiss whatever is covering it, take a fresh take_snapshot, and retry.`);
		}
		if (this._bindingForKey(token) !== binding) {
			return this._toolError('PARA_BROWSER_RETRYABLE: the shared page binding changed while resolving the drop target; retry.');
		}

		let filePath: string;
		try {
			filePath = await this._fileDropStaging.stage(content, fileName);
		} catch (error) {
			return this._toolError(`Failed to stage "${fileName}" for upload: ${error instanceof Error ? error.message : String(error)}`);
		}

		this._noteCursorStatus(ingressLease, { status: 'upload', point: { x: target.x, y: target.y } });
		const commands = paradisBuildFileDropDragCommands(target.x, target.y, filePath);
		let dragEntered = false;
		let completed = false;
		try {
			for (const [index, command] of commands.entries()) {
				if (this._bindingForKey(token) !== binding) {
					return this._toolError('PARA_BROWSER_RETRYABLE: the shared page binding changed mid-drag; retry.');
				}
				const operation = this._dispatchBoundPageInput(token, {}, binding.exactView.targetId, command.method, command.paramsJson, () => true);
				// `_requireIngressLease` がここで（abort等により）throwすると、finally節が
				// dragEntered済みかどうかに応じて後始末を担う（下記）。
				this._requireIngressLease(ingressLease);
				const result = await operation.response;
				if (result.status !== 'success') {
					const stage = index === 0 ? 'dragenter' : index === 1 ? 'dragover' : 'drop';
					return this._toolError(`upload_file_to_drop_zone failed while dispatching "${stage}": ${result.message}`);
				}
				if (index === 0) {
					dragEntered = true;
				}
				if (index < commands.length - 1) {
					// dragOver→drop間に短い猶予を置く（vendoredの `drag` ツールも同様に挟んでいる。
					// isDragActive等のReact状態遷移がイベントハンドラの後で反映されるのを待つ）。
					await new Promise<void>(resolve => setTimeout(resolve, 50));
				}
			}
			completed = true;
			return this._toolText(`Dispatched a trusted drag-and-drop of "${fileName}" (${content.byteLength} bytes) onto the drop zone (uid "${uid}").`);
		} finally {
			// dragEnterまで届いたのに最後まで完走しなかった（早期return・例外・abortのいずれでも）
			// 場合、ページ側に残りうる isDragActive 等の状態をベストエフォートで片付ける。
			// `_cancelFileDropDrag` 自体は内部で例外を握りつぶすため、ここではthrowしない。
			if (dragEntered && !completed) {
				await this._cancelFileDropDrag(token, binding, target.x, target.y, filePath);
			}
		}
	}

	/**
	 * dragEnter/dragOverが成功した後に中断・失敗したとき、ページ側に残りうる `isDragActive` 等の
	 * ドラッグ中状態を片付けるベストエフォートの `dragCancel`。この呼び出し自体の成否は、
	 * 呼び出し元が既に確定させた元のエラーには一切影響させない。
	 */
	private async _cancelFileDropDrag(token: string, binding: IBindingEntry, x: number, y: number, filePath: string): Promise<void> {
		try {
			const cancel = paradisBuildFileDropDragCancelCommand(x, y, filePath);
			const operation = this._dispatchBoundPageInput(token, {}, binding.exactView.targetId, cancel.method, cancel.paramsJson, () => true);
			await operation.response;
		} catch {
			// ベストエフォート。キャンセルに失敗しても呼び出し元は元のエラーを返す。
		}
	}

	/**
	 * take_screenshot が `filePath` 付きで呼ばれたとき、そのファイルを取りに来る口を応答へ添える。
	 *
	 * SSH で繋いだ先で動くエージェントが `filePath` を渡すと、画像は**手元**に落ちて接続先からは
	 * 見えない。既に張ってある戻り経路で取り出せるが、接続先で開いている番号は ssh が空きから
	 * 選ぶので手元とは違う。案内には手元の番号だけを書き、接続先にはポートファイルを読ませる。
	 *
	 * 保存が成功したか失敗したかに関わらず、`filePath` が渡されている限り「実際にどのマシン/
	 * プロセスで書き込みを試みたか」は必ず案内する（詳細は paradisAppendScreenshotFetchHint 参照）。
	 */
	private _offerScreenshotHandoff(token: string, result: unknown, toolArgs: unknown): unknown {
		const requestedFilePath = typeof (toolArgs as { filePath?: unknown } | undefined)?.filePath === 'string';
		// パスの解析（応答本文から読めるかどうか）と、取り出し口を登録できるかどうか（ゲートウェイの
		// ポートが確定しているか）は別の話。混同すると、保存には成功しているのにポート未確定な
		// だけの状況で「パースできなかった」という誤った案内が出る。paths はポートの有無に関係なく
		// 常に読み、targets（実際の取り出し口）だけをポート確定時に限って作る。
		const paths = paradisScreenshotPathsFromToolResult(result);
		const localPort = this._port;
		const targets = localPort === undefined
			? []
			: paths.map(path => ({ id: this._screenshotHandoff.register(token, path), localPort }));
		return paradisAppendScreenshotFetchHint(result, targets, requestedFilePath, paths.length > 0);
	}

	/**
	 * 保存済みスクリーンショットの取り出し (GET /paradis-mcp/screenshot/<id>)。
	 *
	 * 渡すのは私たちが登録したパスだけで、要求側はパスを指定できない。撮ったペインと同じ
	 * トークンでなければ渡さない。
	 */
	private async _handleScreenshotFetch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const token = this._extractToken(req);
		const id = paradisScreenshotIdFromUrl(req.url);
		if (token === undefined || id === undefined || this.captureIngressLease(token) === undefined) {
			this._sendIngressRejected(res);
			return;
		}
		// MCP/hook/voice と同じ ingress 枠管理に組み込む。この経路だけ外側だと
		// server.maxConnections 分の同時 fs.readFile が可能で、AbortSignal も無いため
		// クライアント切断しても読み込みが最後まで走ってしまう。
		const ingressReservation = this._reserveIngressRequest(token);
		if (ingressReservation === undefined) {
			this._sendIngressCapacityRejected(res);
			return;
		}
		let activeRequest: ReturnType<ParadisAgentBrowserService['_trackActiveRequest']> | undefined;
		try {
			activeRequest = this._trackActiveRequest(req, res);
			const path = this._screenshotHandoff.resolve(token, id);
			const body = path === undefined ? undefined : await paradisReadScreenshotFile(path, activeRequest.controller.signal);
			// クライアント切断時は読み込みが signal で止まって undefined になり得る。その場合
			// レスポンスはもう書けないので、404 と混同せずに静かに諦める。
			if (activeRequest.controller.signal.aborted) {
				return;
			}
			if (path === undefined || body === undefined) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'No screenshot is available for that id.' }));
				return;
			}
			res.writeHead(200, {
				'Content-Type': paradisScreenshotContentType(path),
				'Content-Length': body.byteLength,
				'Cache-Control': 'no-store',
			});
			res.end(body);
		} finally {
			activeRequest?.dispose();
			ingressReservation.dispose();
		}
	}

	/**
	 * `get_session_health` の実体。バインド有無・接続状態に関わらず動作する
	 * （そもそもそれを切り分けるためのツールなので）。秘密情報（生トークン等）は含めない。
	 */
	private _buildSessionHealthReport(token: string): unknown {
		const binding = this._bindings.get(token);
		const currentTabId = this._defaultTabId(token);
		const paneShell = this._paneShells.get(token);
		const paneStatus = this._paneStatuses.get(token);
		const wsEndpoint = this._devtoolsWsEndpoint(token);
		return {
			pane: {
				// このMCPサーバーへ実際に (HTTPでもCDPゲートウェイのPID識別でも) 接続実績があるか。
				seenByMcpServer: this._seenTokens.has(token),
				// renderer側から同期された「PTYがまだ生きているペイン」台帳に載っているか。
				shellRegistered: paneShell !== undefined,
				shellPid: paneShell?.shellPid,
				// TerminalExitを受理済み（owner retirementまでingressを抑止中）か。
				terminalExited: this._terminalExitedTokens.has(token),
				// リタイア不整合等で個別隔離され、バインド・ingressが一切通らない状態か。
				quarantined: this._faultedTokens.has(token),
			},
			binding: binding ? {
				bound: true,
				generation: binding.generation,
				boundAtEpochMs: binding.boundAt,
				pageUrl: binding.pageInfo.url,
				pageTitle: binding.pageInfo.title,
				// ユーザーがこのペインへ共有している 2 枚目以降のページ（tab_id で使える）
				additionalSharedTabIds: this._userSharedPageEntries(token).map(entry => entry.pageId),
			} : { bound: false },
			// エージェントが開いて tab_id で使えるタブと、tab_id を省いたときのタブ
			agentTabs: {
				tabIds: [...(this._agentTabGrants.get(token)?.values() ?? [])].filter(grant => !grant.userShared || grant.agentTab).map(grant => grant.pageId),
				currentTabId,
			},
			agent: {
				// エージェントCLIのhook (POST /agent-hook) がこのペインで一度でも発火したか。
				hookEverFired: this._agentHookTokens.has(token),
				status: paneStatus?.status,
				statusChangedAtEpochMs: paneStatus?.changedAt,
			},
			devtoolsBridge: {
				wsEndpointConfigured: wsEndpoint !== undefined,
				// ペイン専用のvendored chrome-devtools-mcp子プロセスが今生きているか
				// (未起動/アイドルkill後は false。次回ツール呼び出しで透過的に再起動する)。
				// tab_id で使うタブは、タブごとに子プロセスが分かれる。ここは tab_id を省いたときのタブのもの
				childProcessAlive: this._devtoolsProxy.hasLiveChild(currentTabId !== undefined ? paradisAgentTabScopeKey(token, currentTabId) : token),
				tabChildProcessesAlive: [...(this._tabScopes.get(token)?.keys() ?? [])].filter(tabId => this._devtoolsProxy.hasLiveChild(paradisAgentTabScopeKey(token, tabId))),
			},
			gateway: {
				httpServerListening: this._httpServer !== undefined,
				port: this._port,
				cdpHttpBase: this._port !== undefined ? `http://127.0.0.1:${this._port}/cdp` : undefined,
			},
			mcpServer: {
				instanceId: this._mcpInstanceId,
				startedAtEpochMs: this._mcpServiceStartedAt,
				portFilePath: this._portFilePath,
			},
		};
	}

	/**
	 * 内蔵chrome-devtools-mcp子プロセスが接続するCDPゲートウェイのWSエンドポイント。
	 * `?pane=` クエリはゲートウェイのトークン解決の最優先経路（全OSで決定的）。
	 */
	private _devtoolsWsEndpoint(key: string): string | undefined {
		if (this._port === undefined) {
			return undefined;
		}
		// タブのスコープキーなら `&tab=` を付け、ゲートウェイがそのタブだけを見せる
		return `ws://127.0.0.1:${this._port}/cdp/devtools/browser/${EMBEDDED_DEVTOOLS_WS_ID}${paradisGatewayPaneQuery(key)}`;
	}

	/**
	 * `preview_file` ツールの実体。呼び出し元ペインのウィンドウを `_paneShells` で特定し、
	 * そのウィンドウが登録した {@link PARADIS_AGENT_PREVIEW_CHANNEL} 経由でエディタを開かせる。
	 * ページ共有（bind）とは独立して、ペイントークンだけで最初から使える。
	 *
	 * ウィンドウ内のどのスペースへ開くかは renderer 側の責務（ウィンドウ粒度のルーティングでは
	 * スペースの取り違えを防げない）。ここではトークンを渡し、renderer が返した構造化された
	 * 状態（`reason` / `deferred`）だけを定型文へ翻訳する。renderer は内部情報を含み得る
	 * 文字列を一切返さない（失敗の詳細は renderer 側の log に残る）。
	 */
	private async _previewFile(ingressLease: IParadisAgentBrowserIngressLease, path: string | undefined, signal?: AbortSignal, remoteAuthority?: string): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		if (!path || !isAbsolute(path)) {
			return this._toolError(path === undefined
				? 'preview_file requires `path`: the absolute path of the file to open.'
				: `preview_file requires an absolute file path (got: ${path}). Resolve the path against your working directory first.`);
		}
		const call = await this._callOwningWindow<IParadisPreviewFileResult>(ingressLease, {
			channelName: PARADIS_AGENT_PREVIEW_CHANNEL,
			method: 'previewFile',
			// トークンはウィンドウ内で「どのスペースへ開くか」を解くためだけに渡す。接続先のペインは接続先も渡し、
			// パスをその接続先のものとして開かせる
			args: remoteAuthority !== undefined ? [ingressLease.token, path, remoteAuthority] : [ingressLease.token, path],
			failureLabel: 'preview_file',
			failureMessage: 'Failed to open the file in Para Code.',
		}, signal);
		if (!call.ok) {
			return this._toolError(call.error);
		}
		if (!call.value.ok) {
			return this._toolError(this._previewFailureMessage(call.value.reason));
		}
		if (call.value.deferred) {
			const space = this._describeSpace(call.value.spaceName);
			return this._toolText(`The user is looking at a different space right now, so ${path} was not opened yet: Para Code queued it for ${space ?? 'the space this terminal pane belongs to'} and it opens as soon as the user switches back. Nothing was shown on screen, so do not assume the user has seen the file.`);
		}
		return this._toolText(`Opened ${path} in the Para Code space that owns this terminal pane.`);
	}

	/**
	 * `open_browser_profile` ツールの実体。`preview_file` と同型で、呼び出し元ペインの
	 * ウィンドウが登録した {@link PARADIS_BROWSER_PROFILE_MCP_CHANNEL} へ委ねる。
	 * どのスペースへ開くか・名前からプロファイルを引く判断は renderer 側が持ち、ここでは
	 * 構造化された結果を定型英文へ翻訳するだけ（renderer は内部情報を含む文字列を返さない）。
	 */
	private async _openBrowserProfile(ingressLease: IParadisAgentBrowserIngressLease, profile: string | undefined, url: string | undefined, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		if (!profile || !profile.trim()) {
			return this._toolError('open_browser_profile requires the name of a browser profile the user created in Para Code (for example "PRD").');
		}
		const call = await this._callOwningWindow<IParadisOpenProfileResult>(ingressLease, {
			channelName: PARADIS_BROWSER_PROFILE_MCP_CHANNEL,
			method: PARADIS_BROWSER_PROFILE_MCP_METHOD,
			args: [ingressLease.token, profile, url],
			failureLabel: 'open_browser_profile',
			failureMessage: 'Failed to open a browser page in that profile in Para Code.',
			// ユーザーのプロファイルなら承認を待ち、開いたタブの共有ではスペースの確定も待つ。
			timeoutMs: PARADIS_AGENT_PAGE_REQUEST_TIMEOUT_MS,
			timeoutMessage: 'Para Code did not finish opening the page in time. The tab may still have opened - call list_browser_tabs before trying again.',
		}, signal);
		if (!call.ok) {
			return this._toolError(call.error);
		}
		if (!call.value.ok) {
			return this._toolError(this._openProfileFailureMessage(call.value.reason, profile));
		}
		const where = url ? `${url} in` : 'a page in';
		const login = call.value.restored
			? 'It reuses the cookies already stored in that profile, so a previous login should still be active.'
			: 'That profile has no stored cookies yet, so the page opens logged out - ask the user to log in once, and the login will be reused from then on.';
		const usable = call.value.bound && (call.value.tabId === undefined || this._selectTab(ingressLease.token, call.value.tabId));
		const shared = usable
			? `The page is now this pane's current tab, so the browser tools (take_snapshot, click, navigate_page, ...) act on it when you omit tab_id${call.value.tabId ? ` (or pass tab_id "${call.value.tabId}")` : ''}.`
			: 'The page was opened but could NOT be shared with this terminal pane, so the chrome-devtools tools do not target it yet - ask the user to share it from Para Code.';
		const tab = call.value.tabId ? ` The tab is one of your own tabs (tabId ${call.value.tabId}); close it with close_browser_tab when you are done.` : '';
		return this._toolText(`Opened ${where} the "${call.value.profileName}" browser profile. ${login} ${shared}${tab}`);
	}

	/**
	 * エージェントのタブ操作（open/list/select/close_browser_tab）と共有の要求（request_browser_page）の実体。
	 * 判断はすべて呼び出し元ペインのウィンドウ（paradisAgentBrowserTabs.contribution.ts）が持ち、
	 * ここでは構造化された結果を定型英文へ翻訳するだけ（renderer は内部情報を含む文字列を返さない）。
	 */
	private async _agentTabTool(ingressLease: IParadisAgentBrowserIngressLease, name: string, toolArgs: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		const text = (key: string) => typeof toolArgs[key] === 'string' ? toolArgs[key] as string : undefined;
		const token = ingressLease.token;
		switch (name) {
			case 'open_browser_tab': {
				const call = await this._callOwningWindow<IParadisOpenAgentTabResult>(ingressLease, {
					channelName: PARADIS_AGENT_BROWSER_TABS_CHANNEL,
					method: ParadisAgentTabMethod.Open,
					// `private` のタブは、そのペイン専用の保存領域（ペインのトークンから作る affinity）で開く。
					args: [token, text('url'), toolArgs.background === true, ...(toolArgs.private === true ? [paradisPaneStorageAffinity(paradisPageOpsOwnerKey(token))] : [])],
					failureLabel: name,
					failureMessage: 'Failed to open a browser tab in Para Code.',
					// 読み込み待ち（最大20秒）の分だけ長く待つ。
					timeoutMs: 40_000,
					timeoutMessage: 'Para Code did not finish opening the tab in time. The tab may still have opened - call list_browser_tabs before opening another one.',
				}, signal);
				if (!call.ok) {
					return this._toolError(call.error);
				}
				if (!call.value.ok) {
					return this._toolError(this._agentTabFailureMessage(call.value.reason));
				}
				const tabId = call.value.tab.tabId;
				const usable = call.value.bound && this._selectTab(token, tabId);
				const shared = usable
					? `It is now this pane's current tab, so the browser tools act on it when you omit tab_id; pass tab_id "${tabId}" to keep using it after other tabs are opened or selected (for example from a subagent).`
					: 'It could NOT be made usable from this terminal pane yet, so the browser tools do not target it - retry with select_browser_tab.';
				const opened = `Opened tab ${tabId} (${call.value.tab.url || 'about:blank'}). ${shared} You have ${call.value.openedCount} of ${PARADIS_AGENT_TAB_LIMIT} tabs of your own open.`;
				const openLabel = toolArgs.label;
				return this._toolText(openLabel === undefined ? opened : `${opened} ${this._setCursorLabel(token, this._scopeBinding(token, tabId), openLabel)}`);
			}
			case 'list_browser_tabs': {
				const call = await this._callOwningWindow<IParadisListAgentTabsResult>(ingressLease, {
					channelName: PARADIS_AGENT_BROWSER_TABS_CHANNEL,
					method: ParadisAgentTabMethod.List,
					args: [token],
					failureLabel: name,
					failureMessage: 'Failed to list the browser tabs in Para Code.',
				}, signal);
				if (!call.ok) {
					return this._toolError(call.error);
				}
				if (!call.value.ok) {
					return this._toolError(this._agentTabFailureMessage(call.value.reason));
				}
				const currentTabId = this._defaultTabId(token);
				const tabs = call.value.tabs.map(tab => ({
					tabId: tab.tabId,
					url: tab.url,
					title: tab.title,
					openedByAgent: tab.openedByAgent,
					// ユーザーがこのペインに共有しているページか（複数ありうる）
					shared: this._isUserSharedPage(token, tab.tabId),
					// tab_id を省いたときに使うタブか
					current: tab.tabId === currentTabId,
					// tab_id で使えるか（ユーザーのタブは共有されている間だけ）
					usable: this._scopeBinding(token, tab.tabId) !== undefined,
				}));
				return this._toolText(JSON.stringify({ tabs, openedByYou: call.value.openedCount, limit: PARADIS_AGENT_TAB_LIMIT, hint: 'Pass a usable tabId as tab_id to any browser tool to act on that tab; give each subagent its own tab_id. The user can share several pages with this pane (shared: true); each of them is usable by its tabId, and the one shared most recently is the current tab unless you open or select another.' }, null, 2));
			}
			case 'select_browser_tab':
			case 'close_browser_tab': {
				const tabId = text('tabId');
				if (!tabId) {
					return this._toolError(`${name} requires the tabId of a tab from list_browser_tabs.`);
				}
				if (name === 'select_browser_tab') {
					const call = await this._callOwningWindow<IParadisSelectAgentTabResult>(ingressLease, {
						channelName: PARADIS_AGENT_BROWSER_TABS_CHANNEL,
						method: ParadisAgentTabMethod.Select,
						args: [token, tabId],
						failureLabel: name,
						failureMessage: 'Failed to switch the shared browser tab in Para Code.',
					}, signal);
					if (!call.ok) {
						return this._toolError(call.error);
					}
					if (!call.value.ok) {
						return this._toolError(this._agentTabFailureMessage(call.value.reason));
					}
					const selectLabel = toolArgs.label;
					return call.value.bound && this._selectTab(token, tabId)
						? this._toolText(`Tab ${tabId} (${call.value.tab.url || 'about:blank'}) is now this pane's current tab: the browser tools act on it when you omit tab_id.${selectLabel === undefined ? '' : ` ${this._setCursorLabel(token, this._scopeBinding(token, tabId), selectLabel)}`}`)
						: this._toolError(`PARA_BROWSER_RETRYABLE: Para Code could not make tab ${tabId} usable from this terminal pane. Retry once; if it keeps failing, ask the user to share it from Para Code.`);
				}
				const call = await this._callOwningWindow<IParadisCloseAgentTabResult>(ingressLease, {
					channelName: PARADIS_AGENT_BROWSER_TABS_CHANNEL,
					method: ParadisAgentTabMethod.Close,
					args: [token, tabId],
					failureLabel: name,
					failureMessage: 'Failed to close the browser tab in Para Code.',
				}, signal);
				if (!call.ok) {
					return this._toolError(call.error);
				}
				if (!call.value.ok) {
					return this._toolError(this._agentTabFailureMessage(call.value.reason));
				}
				return this._toolText(`Closed tab ${tabId}. You have ${call.value.openedCount} of ${PARADIS_AGENT_TAB_LIMIT} tabs of your own open.`);
			}
			case 'request_browser_page': {
				if (!text('reason')?.trim()) {
					return this._toolError('request_browser_page requires a reason: one short sentence the user will see, explaining why you need their page.');
				}
				const call = await this._callOwningWindow<IParadisAgentPageRequestResult>(ingressLease, {
					channelName: PARADIS_AGENT_BROWSER_TABS_CHANNEL,
					method: ParadisAgentTabMethod.RequestPage,
					args: [token, text('reason'), text('url')],
					failureLabel: name,
					failureMessage: 'Failed to ask the user for a browser page in Para Code.',
					timeoutMs: PARADIS_AGENT_PAGE_REQUEST_TIMEOUT_MS,
					timeoutMessage: 'The user did not answer in time, so no page was shared. Do not ask again right away.',
				}, signal);
				if (!call.ok) {
					return this._toolError(call.error);
				}
				if (!call.value.ok) {
					return this._toolError(this._agentPageRequestFailureMessage(call.value.reason));
				}
				if (!call.value.approved) {
					return this._toolText(call.value.timedOut
						? 'The user did not answer in time, so no page was shared. Do not ask again right away; continue without it, or open a tab of your own with open_browser_tab if a login is not needed.'
						: 'The user declined to share a page. Do not ask again; continue without it, or open a tab of your own with open_browser_tab if a login is not needed.');
				}
				this._selectTab(token, call.value.tab.tabId);
				return this._toolText(`The user shared tab ${call.value.tab.tabId} (${call.value.tab.url || 'about:blank'}). It is now the page shared with this terminal pane and its current tab, so the browser tools act on it when you omit tab_id; pass tab_id "${call.value.tab.tabId}" to use it while working in other tabs. It stays usable until the user stops sharing it or shares another page with this pane.`);
			}
		}
		throw new JsonRpcMethodError(-32602, `Unknown tool: ${name}`);
	}

	/** そのタブを、tab_id を省いたときの既定にする。そのペインが今使えるタブでなければ false。 */
	private _selectTab(token: string, tabId: string): boolean {
		if (this._scopeBinding(token, tabId) === undefined) {
			return false;
		}
		this._selectedTabs.set(token, tabId);
		return true;
	}

	private _agentTabFailureMessage(reason: ParadisAgentTabFailure): string {
		switch (reason) {
			case 'switching':
				return 'PARA_BROWSER_RETRYABLE: Para Code is switching spaces right now. Retry in a moment.';
			case 'paneUnresolved':
				return 'PARA_BROWSER_RETRYABLE: Para Code is still restoring this terminal pane, so it cannot tell which space it belongs to. Retry in a few seconds.';
			case 'spaceNotVisible':
				return 'The space this terminal pane belongs to is not on screen right now, so a tab opened there would not be visible or controllable. Ask the user to switch back to that space, then call this tool again.';
			case 'unreachableSpace':
				return 'The space this terminal pane belongs to can no longer be opened in Para Code (its repository or worktree is gone from the list).';
			case 'limitReached':
				return `You already have ${PARADIS_AGENT_TAB_LIMIT} tabs of your own open for this terminal pane, which is the limit. Close one you no longer need with close_browser_tab (see list_browser_tabs), then try again.`;
			case 'invalidUrl':
				return 'Only http:// and https:// URLs (or no URL, for a blank tab) can be opened.';
			case 'openFailed':
				return 'PARA_BROWSER_RETRYABLE: Para Code could not open the tab. Retry once.';
			case 'unknownTab':
				return 'There is no tab with that tabId that this terminal pane may use. You can only select tabs you opened (and the page currently shared with this pane); call list_browser_tabs to see them. To use a user tab, call request_browser_page.';
			case 'tabNotVisible':
				return 'That tab is in a space that is not on screen right now, so it was not closed. Ask the user to switch back to that space, then call this tool again.';
			case 'notOwned':
				return 'That tab was not opened by you, so it cannot be closed from here. Ask the user to close it if needed.';
		}
	}

	private _agentPageRequestFailureMessage(reason: ParadisAgentPageRequestFailure): string {
		switch (reason) {
			case 'switching':
			case 'paneUnresolved':
			case 'spaceNotVisible':
			case 'unreachableSpace':
				return this._agentTabFailureMessage(reason);
			case 'noPages':
				return 'The user has no browser tab open in the space of this terminal pane, so there is nothing to share. Open a tab of your own with open_browser_tab, or ask the user to open the page first.';
			case 'alreadyPending':
				return 'A request from this terminal pane is already waiting for the user\'s answer. Wait for it instead of asking again.';
			case 'recentlyDenied':
				return 'The user declined a request from this terminal pane a moment ago, so Para Code declined this one automatically. Continue without the page, or open a tab of your own with open_browser_tab if a login is not needed.';
			case 'shareFailed':
				return 'The user chose a page, but Para Code could not share it with this terminal pane (the page may not allow sharing under the current agent network restrictions, or the share confirmation was declined).';
		}
	}

	/**
	 * プロファイルの一覧・作成・切替・削除の実体。判断は呼び出し元ペインのウィンドウ
	 * （paradisBrowserProfileMcp.contribution.ts）が持ち、ここでは結果を定型英文へ翻訳するだけ。
	 */
	private async _agentProfileTool(ingressLease: IParadisAgentBrowserIngressLease, name: string, toolArgs: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		const text = (key: string) => typeof toolArgs[key] === 'string' ? (toolArgs[key] as string).trim() || undefined : undefined;
		const token = ingressLease.token;
		const request = (method: string, args: unknown[]) => ({
			channelName: PARADIS_BROWSER_PROFILE_MCP_CHANNEL,
			method,
			args: [token, ...args],
			failureLabel: name,
			failureMessage: 'Failed to update the browser profiles in Para Code.',
			// 切替は承認・タブの作り直し・共有まで待つ。ほかは短い処理なので時間は同じでも困らない。
			timeoutMs: PARADIS_AGENT_PAGE_REQUEST_TIMEOUT_MS,
			timeoutMessage: 'Para Code did not finish in time. If you were switching a tab, it may already have been recreated with a new tabId - call list_browser_tabs to check.',
		});
		switch (name) {
			case 'list_browser_profiles': {
				const call = await this._callOwningWindow<IParadisListProfilesResult>(ingressLease, request(PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD, []), signal);
				if (!call.ok) {
					return this._toolError(call.error);
				}
				const notes = [
					call.value.hiddenProfileCount > 0 ? `There are ${call.value.hiddenProfileCount} other browser profile(s) (the user's, or ones created from other terminal panes). Their names are not listed; to use one, ask the user for its name and call open_browser_profile - the user will be asked to approve.` : undefined,
					call.value.usable ? undefined : 'This workspace is not trusted, so named profiles cannot be used until the user trusts it.',
					call.value.shareable ? undefined : 'Agent network filtering is enabled, so pages in named profiles cannot be shared with agents right now.',
				].filter(note => note !== undefined);
				return this._toolText(JSON.stringify({ profiles: call.value.profiles, ...(notes.length ? { notes } : {}) }, null, 2));
			}
			case 'create_browser_profile': {
				const profileName = text('name');
				if (!profileName) {
					return this._toolError('create_browser_profile requires a non-empty name.');
				}
				const call = await this._callOwningWindow<IParadisManageProfileResult<{ readonly profileName: string }>>(ingressLease, request(PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD, [profileName]), signal);
				if (!call.ok) {
					return this._toolError(call.error);
				}
				if (!call.value.ok) {
					return this._toolError(this._profileManageFailureMessage(call.value.reason, profileName));
				}
				return this._toolText(`Created the "${call.value.profileName}" browser profile. It has no stored login yet; open it with open_browser_profile.`);
			}
			case 'switch_browser_profile': {
				const profileName = text('profile');
				if (!profileName) {
					return this._toolError('switch_browser_profile requires the name of a browser profile (see list_browser_profiles).');
				}
				// tabId を省いたら、このペインの既定のタブ（最後に開いた・選んだタブ、無ければ共有のページ）
				const tabId = text('tabId') ?? text(PARADIS_TAB_ID_ARGUMENT) ?? this._defaultTabId(token);
				const call = await this._callOwningWindow<IParadisSwitchProfileResult>(ingressLease, request(PARADIS_BROWSER_PROFILE_MCP_SWITCH_METHOD, [profileName, tabId]), signal);
				if (!call.ok) {
					return this._toolError(call.error);
				}
				if (!call.value.ok) {
					return this._toolError(this._profileManageFailureMessage(call.value.reason, profileName));
				}
				const login = call.value.restored ? 'The profile has a stored login.' : 'The profile has no stored login yet, so the page may show logged out.';
				const shared = call.value.bound && this._selectTab(ingressLease.token, call.value.tabId) ? 'It is this pane\'s current tab now (pass the new tabId as tab_id to use it explicitly).' : 'It could NOT be shared with this terminal pane yet - retry with select_browser_tab.';
				return this._toolText(`Reopened the tab in the "${call.value.profileName}" browser profile as tab ${call.value.tabId} (the old tabId is gone). ${login} ${shared}`);
			}
			case 'delete_browser_profile': {
				const profileName = text('profile');
				if (!profileName) {
					return this._toolError('delete_browser_profile requires the name of a browser profile you created.');
				}
				const call = await this._callOwningWindow<IParadisManageProfileResult<{ readonly profileName: string }>>(ingressLease, request(PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, [profileName]), signal);
				if (!call.ok) {
					return this._toolError(call.error);
				}
				if (!call.value.ok) {
					return this._toolError(this._profileManageFailureMessage(call.value.reason, profileName));
				}
				return this._toolText(`Deleted the "${call.value.profileName}" browser profile and its stored data.`);
			}
		}
		throw new JsonRpcMethodError(-32602, `Unknown tool: ${name}`);
	}

	private _profileManageFailureMessage(reason: ParadisProfileManageFailure, requestedProfile: string): string {
		switch (reason) {
			case 'switching':
				return 'PARA_BROWSER_RETRYABLE: Para Code is switching spaces right now. Retry in a moment.';
			case 'paneUnresolved':
				return 'PARA_BROWSER_RETRYABLE: Para Code is still restoring this terminal pane. Retry in a few seconds.';
			case 'untrustedWorkspace':
				return 'This workspace is not trusted, so Para Code keeps every browser page in a throwaway session and named profiles cannot be used. Ask the user to trust the workspace first.';
			case 'unknownProfile':
				return `There is no browser profile named "${requestedProfile}" that you can use for this (list_browser_profiles shows the profiles created from this terminal pane; you can only delete those). For a profile of the user, ask the user for its exact name.`;
			case 'profileNotShareable':
				return 'Agent network filtering (the chat.agent.networkFilter setting) is enabled, and pages in named browser profiles do not enforce that network policy, so Para Code does not share them with agents. Nothing was changed.';
			case 'invalidName':
				return 'A browser profile cannot be created with that name (it is empty, or not available). Pick another short name.';
			case 'tooManyProfiles':
				return `You have already created ${PARADIS_AGENT_CREATED_PROFILE_LIMIT} browser profiles, which is the limit. Delete one you no longer need with delete_browser_profile first.`;
			case 'tooManyAgentProfiles':
				return `Agents have created ${PARADIS_AGENT_CREATED_PROFILE_TOTAL_LIMIT} browser profiles in total, which is the limit, and most of them were made by earlier agent sessions that you cannot delete. Ask the user to delete browser profiles that agents created and no longer need, or reuse a profile you created.`;
			case 'inUse':
				return `The "${requestedProfile}" browser profile still has tabs open that are not yours (the user or another terminal pane is using it), so it was not deleted.`;
			case 'notAgentTab':
				return 'Only tabs you opened (with open_browser_tab or open_browser_profile) can be switched to another profile, and the given tab (or the page currently shared with this terminal pane) is not one of them. Call list_browser_tabs to see your tabs.';
			case 'switchFailed':
				return 'PARA_BROWSER_RETRYABLE: Para Code could not reopen the tab in that profile. Retry once.';
			case 'denied':
				return `The user declined to let you use the "${requestedProfile}" browser profile. Do not ask again; continue without it.`;
			case 'approvalTimedOut':
				return `The user did not answer the request to use the "${requestedProfile}" browser profile in time, so nothing was changed. Do not ask again right away.`;
			case 'alreadyPending':
				return 'Another request from this terminal pane is still waiting for the user\'s answer. Wait for it instead of asking again.';
			case 'recentlyDenied':
				return 'The user declined a request from this terminal pane a moment ago, so Para Code declined this one automatically. Continue without it; do not keep asking.';
		}
	}

	/** renderer が返した `open_browser_profile` の失敗理由を英語メッセージへ翻訳する。 */
	private _openProfileFailureMessage(reason: ParadisOpenProfileFailure, requestedProfile: string): string {
		switch (reason) {
			case 'switching':
				return 'PARA_BROWSER_RETRYABLE: Para Code is switching spaces right now, so no page was opened. Retry in a moment.';
			case 'paneUnresolved':
				return 'PARA_BROWSER_RETRYABLE: Para Code is still restoring this terminal pane, so it cannot tell which space to open the page in. Retry in a few seconds.';
			case 'unknownProfile':
				return `There is no browser profile named "${requestedProfile}" in Para Code. Create one of your own with create_browser_profile, or ask the user for the exact name of theirs (the profile pill at the right of the browser address bar shows them).`;
			case 'invalidUrl':
				return 'Only http:// and https:// URLs (or no URL) can be opened.';
			case 'denied':
				return `The user declined to let you use the "${requestedProfile}" browser profile, so no page was opened. Do not ask again; continue without it.`;
			case 'approvalTimedOut':
				return `The user did not answer the request to use the "${requestedProfile}" browser profile in time, so no page was opened. Do not ask again right away.`;
			case 'alreadyPending':
				return 'Another request from this terminal pane is still waiting for the user\'s answer, so no page was opened. Wait for it instead of asking again.';
			case 'recentlyDenied':
				return 'The user declined a request from this terminal pane a moment ago, so Para Code declined this one automatically and opened no page. Continue without it; do not keep asking.';
			case 'untrustedWorkspace':
				return 'This workspace is not trusted, so Para Code keeps every browser page in a throwaway session and named profiles cannot be used. Ask the user to trust the workspace first.';
			case 'profileNotShareable':
				return `Agent network filtering (the chat.agent.networkFilter setting) is enabled, and pages in named browser profiles such as "${requestedProfile}" do not enforce that network policy, so Para Code does not share them with agents. No page was opened. Ask the user to disable agent network filtering, or to share a page from Para Code and log in there.`;
			case 'spaceNotVisible':
				return 'The space this terminal pane belongs to is not on screen right now, so opening a page there would not be visible or controllable. Ask the user to switch back to that space, then call this tool again.';
			case 'unreachableSpace':
				return 'The space this terminal pane belongs to can no longer be opened in Para Code (its repository or worktree is gone from the list), so there is nowhere to open the page.';
			case 'openFailed':
				return `PARA_BROWSER_RETRYABLE: Para Code found the "${requestedProfile}" browser profile but could not open a page in it. Retry once; if it keeps failing, ask the user to open the profile from the profile pill next to the browser address bar.`;
			case 'limitReached':
				return this._agentTabFailureMessage('limitReached');
		}
	}

	/**
	 * renderer が返した既知の失敗理由を、LLM がそのまま読める英語メッセージへ翻訳する。
	 * 理由なしだけを先に返して switch を網羅させ、理由が増えたら型で気付けるようにしている
	 * （`noImplicitReturns` により、case を足し忘れると戻り値の無い経路として弾かれる）。
	 */
	private _previewFailureMessage(reason: ParadisPreviewFileFailure | undefined): string {
		if (reason === undefined) {
			return 'Failed to open the file in Para Code.';
		}
		switch (reason) {
			case 'switching':
				return 'PARA_BROWSER_RETRYABLE: Para Code is switching spaces right now, so the file was not opened. Retry in a moment.';
			case 'paneUnresolved':
				return 'PARA_BROWSER_RETRYABLE: Para Code is still restoring this terminal pane, so it cannot tell which space to open the file in. Retry in a few seconds.';
			case 'unreachableSpace':
				return 'The space this terminal pane belongs to can no longer be opened in Para Code (its repository or worktree is gone from the list), so there is nowhere to show the file. Tell the user the path instead.';
			case 'notFound':
				return 'preview_file did not open anything: the file does not exist (on a remote window, the path is looked up on the machine this agent runs on). Check the path and retry.';
			case 'isDirectory':
				return 'preview_file did not open anything: the path is a folder. Give the path of a file.';
			case 'unreadable':
				return 'preview_file did not open anything: Para Code could not read the file (permissions, or the remote connection was interrupted). Retry, or tell the user the path instead.';
			case 'openFailed':
				return 'preview_file did not open anything: Para Code found the file but could not open an editor for it. Tell the user the path instead.';
		}
	}

	/**
	 * renderer が返したスペース表示名（ユーザーが付けたリポジトリ名 / worktree 名）を、
	 * 応答文へ埋められる1行の語句にする。制御文字を落として空白を畳み、長すぎる名前は
	 * サロゲートペアの途中で割らないよう文字単位で切る。
	 */
	private _describeSpace(name: string | undefined): string | undefined {
		if (name === undefined) {
			return undefined;
		}
		const flattened = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().replace(/\s+/g, ' ');
		if (flattened.length === 0) {
			return undefined;
		}
		const characters = Array.from(flattened);
		const clipped = characters.length > 80 ? `${characters.slice(0, 80).join('')}...` : flattened;
		return `the "${clipped}" space`;
	}

	/**
	 * スペースのメモ系ツール（list/read/write/add/check/delete）の実体。引数の検証は common の
	 * パーサに任せ、実際の読み書きは `preview_file` と同じく「呼び出し元ペインのウィンドウ」
	 * に登録された {@link PARADIS_AGENT_NOTES_CHANNEL} へ委ねる（メモの実体は workbench 側の
	 * ストレージにあるため）。ページ共有（bind）とは独立して、ペイントークンだけで使える。
	 */
	private async _spaceNote(ingressLease: IParadisAgentBrowserIngressLease, name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		const parsed = paradisParseAgentNoteToolArgs(name, args);
		if (!parsed.ok) {
			return this._toolError(parsed.error);
		}
		const call = await this._callOwningWindow<IParadisAgentNoteResult>(ingressLease, {
			channelName: PARADIS_AGENT_NOTES_CHANNEL,
			method: PARADIS_AGENT_NOTES_METHOD,
			// トークンはウィンドウ内で「どのスペースが既定か」を解くためだけに渡す
			args: [ingressLease.token, parsed.request],
			failureLabel: name,
			failureMessage: 'Failed to read or update the space note in Para Code.',
		}, signal);
		if (!call.ok) {
			return this._toolError(call.error);
		}
		const result = call.value;
		if (!result.ok) {
			return this._toolError(result.error);
		}
		return this._toolText(JSON.stringify(
			result.kind === 'spaces'
				? { spaces: result.spaces }
				// replaced: 全文置換で消えた本文。メモにundoが無いため、復元できるよう応答に残す
				: { note: result.note, ...(result.replaced !== undefined ? { replaced: result.replaced } : {}) },
			null,
			2,
		));
	}

	/**
	 * 呼び出し元ペインを所有するウィンドウの IPC チャネルを1回だけ呼ぶ。ウィンドウ特定は
	 * `_paneShells`（トークン → ウィンドウctx）で行い、取り違えを防ぐ。
	 * 失敗理由は LLM がそのまま読める英語メッセージで返し、内部例外は外へ出さない。
	 */
	private async _callOwningWindow<T>(
		ingressLease: IParadisAgentBrowserIngressLease,
		request: IParadisMcpOwningWindowRequest,
		signal?: AbortSignal,
	): Promise<ParadisMcpOwningWindowResult<T>> {
		this._requireIngressLease(ingressLease);
		const token = ingressLease.token;
		// 接続先のペインはシェルの PID が分からず `_paneShells` に載らないことがある（SSH の再読み込み直後など）
		const remoteWindowCtx = this._remotePaneWindows.get(token);
		const pane = this._paneShells.get(token) ?? (remoteWindowCtx !== undefined ? { windowCtx: remoteWindowCtx } : undefined);
		if (!pane) {
			return { ok: false, error: 'Para Code could not identify the window that owns this terminal pane (the pane may have just been created, or Para Code was restarted after this CLI started). Retry in a few seconds; if it keeps failing, re-launch this CLI in a terminal pane inside Para Code.' };
		}
		// getChannel の ctx フィルタは「接続が現れるまで待つ」ため、ウィンドウが既に閉じて
		// いると永久に解決しない。先に接続の存在を確認し、呼び出し自体にもタイムアウトを張る。
		if (!this.ipcServer.connections.some(connection => connection.ctx === pane.windowCtx)) {
			return { ok: false, error: 'The Para Code window that owns this terminal pane is not connected (it may have been closed or is reloading). Retry in a few seconds.' };
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		let timedOut = false;
		// 呼び出し元が諦めた（時間切れ・MCP の取り消し）ことを renderer へも伝える。承認ダイアログなど、
		// renderer 側で待っているものを閉じさせるため。
		const cancellation = new CancellationTokenSource();
		try {
			const channel = this.ipcServer.getChannel(request.channelName, client => client.ctx === pane.windowCtx);
			const aborted = new Promise<never>((_, reject) => {
				onAbort = () => {
					cancellation.cancel();
					reject(new ParadisIngressLeaseError());
				};
				if (signal?.aborted) {
					onAbort();
				} else {
					signal?.addEventListener('abort', onAbort, { once: true });
				}
			});
			const timeoutMs = request.timeoutMs ?? 10000;
			const value = await Promise.race([
				channel.call<T>(request.method, request.args, cancellation.token),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						timedOut = true;
						cancellation.cancel();
						reject(new Error(`timed out after ${timeoutMs}ms`));
					}, timeoutMs);
				}),
				aborted,
			]);
			this._requireIngressLease(ingressLease);
			return { ok: true, value };
		} catch (error) {
			if (error instanceof ParadisIngressLeaseError || !this.isIngressLeaseCurrent(ingressLease)) {
				throw new ParadisIngressLeaseError();
			}
			this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] ${request.failureLabel} failed for pane ${this._tokenFingerprint(token)}`, error));
			return { ok: false, error: timedOut && request.timeoutMessage ? request.timeoutMessage : request.failureMessage };
		} finally {
			cancellation.dispose();
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			if (onAbort !== undefined) {
				signal?.removeEventListener('abort', onAbort);
			}
		}
	}

	/** 接続先のペインとのファイルの受け渡しを、そのペインを所有するウィンドウへ頼む口。 */
	private _remoteFileTransferHost(ingressLease: IParadisAgentBrowserIngressLease, remoteAuthority: string, label: string, signal?: AbortSignal) {
		return {
			callWindow: <T>(method: string, args: unknown[]) => this._callOwningWindow<T>(ingressLease, {
				channelName: PARADIS_AGENT_PREVIEW_CHANNEL,
				method,
				// トークンは読み書きしてよい場所（ペインのスペースのフォルダ）を解くためだけに渡す
				args: [ingressLease.token, remoteAuthority, ...args],
				failureLabel: label,
				failureMessage: 'Para Code could not transfer the file between the browser and the machine this agent runs on.',
				// 大きなファイルを接続先へ送る時間を見込む
				timeoutMs: 120_000,
			}, signal),
			// 受け渡し用フォルダを本人だけのものにする（SSH の接続先だけ）
			restrictFolder: (remoteFolder: string) => this._remoteTunnels.chmodPrivateFolder(remoteAuthority, remoteFolder),
		};
	}

	private _toolText(text: string): unknown {
		return { content: [{ type: 'text', text }] };
	}

	private _toolError(text: string): unknown {
		return { content: [{ type: 'text', text }], isError: true };
	}

	private _extractToken(req: http.IncomingMessage): string | undefined {
		const auth = req.headers.authorization;
		if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 7) {
			return auth.slice(7).trim() || undefined;
		}
		try {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const pane = url.searchParams.get('pane');
			return pane || undefined;
		} catch {
			return undefined;
		}
	}

	private _trackActiveRequest(req: http.IncomingMessage, res: http.ServerResponse): { readonly controller: AbortController; dispose(): void } {
		const controller = new AbortController();
		let disposed = false;
		const onRequestAborted = () => controller.abort();
		const onRequestClosed = () => {
			if (req.complete !== true && !res.writableEnded) {
				controller.abort();
			}
		};
		const onResponseClosed = () => {
			if (!res.writableEnded) {
				controller.abort();
			}
		};
		req.once('aborted', onRequestAborted);
		req.once('close', onRequestClosed);
		res.once('close', onResponseClosed);
		if (this._serverDisposed) {
			controller.abort();
		} else {
			this._activeRequestControllers.add(controller);
		}
		return {
			controller,
			dispose: () => {
				if (disposed) {
					return;
				}
				disposed = true;
				req.removeListener('aborted', onRequestAborted);
				req.removeListener('close', onRequestClosed);
				res.removeListener('close', onResponseClosed);
				this._activeRequestControllers.delete(controller);
			},
		};
	}

	private _reserveIngressRequest(token: string, pool: 'default' | 'hook' | 'mod' = 'default'): { dispose(): void } | undefined {
		const byToken = pool === 'hook' ? this._activeHookRequestsByToken : pool === 'mod' ? this._activeModRequestsByToken : this._activeIngressRequestsByToken;
		const readTotal = () => pool === 'hook' ? this._activeHookRequestCount : pool === 'mod' ? this._activeModRequestCount : this._activeIngressRequestCount;
		const writeTotal = (value: number) => {
			if (pool === 'hook') {
				this._activeHookRequestCount = value;
			} else if (pool === 'mod') {
				this._activeModRequestCount = value;
			} else {
				this._activeIngressRequestCount = value;
			}
		};
		const tokenCount = byToken.get(token) ?? 0;
		if (this._serverDisposed
			|| readTotal() >= MAX_ACTIVE_INGRESS_REQUESTS
			|| tokenCount >= (pool === 'mod' ? MAX_ACTIVE_MOD_REQUESTS_PER_TOKEN : MAX_ACTIVE_INGRESS_REQUESTS_PER_TOKEN)) {
			return undefined;
		}
		writeTotal(readTotal() + 1);
		byToken.set(token, tokenCount + 1);
		let released = false;
		return {
			dispose: () => {
				if (released) {
					return;
				}
				released = true;
				writeTotal(Math.max(0, readTotal() - 1));
				const current = byToken.get(token);
				if (current === undefined || current <= 1) {
					byToken.delete(token);
				} else {
					byToken.set(token, current - 1);
				}
			},
		};
	}

	/** 音声取込の枠を押さえる。埋まっていれば `waitMs` まで空くのを待つ（相手が切れたらやめる）。 */
	private async _reserveMobileVoiceIngressWithin(waitMs: number, req: http.IncomingMessage): Promise<{ grow(bytes: number): boolean; dispose(): void } | undefined> {
		const deadline = Date.now() + waitMs;
		for (; ;) {
			const reservation = this._reserveMobileVoiceIngress();
			if (reservation !== undefined || this._serverDisposed || req.destroyed || Date.now() >= deadline) {
				return reservation;
			}
			await new Promise<void>(resolve => setTimeout(resolve, MOBILE_VOICE_SLOT_POLL_MS));
		}
	}

	private _reserveMobileVoiceIngress(): { grow(bytes: number): boolean; dispose(): void } | undefined {
		if (this._serverDisposed
			|| this._activeMobileVoiceRequestCount >= MAX_ACTIVE_MOBILE_VOICE_REQUESTS) {
			return undefined;
		}
		this._activeMobileVoiceRequestCount++;
		let bytes = 0;
		let released = false;
		return {
			grow: (more: number) => {
				if (released || this._activeMobileVoiceBytes + more > MAX_ACTIVE_MOBILE_VOICE_BYTES) {
					return false;
				}
				bytes += more;
				this._activeMobileVoiceBytes += more;
				return true;
			},
			dispose: () => {
				if (released) {
					return;
				}
				released = true;
				this._activeMobileVoiceRequestCount = Math.max(0, this._activeMobileVoiceRequestCount - 1);
				this._activeMobileVoiceBytes = Math.max(0, this._activeMobileVoiceBytes - bytes);
			},
		};
	}

	private _readBody(req: http.IncomingMessage, signal?: AbortSignal): Promise<string> {
		return this._readBodyBytes(req, MAX_BODY_BYTES, signal).then(bytes => bytes.toString('utf8'));
	}

	private _readBodyBytes(req: http.IncomingMessage, maximumBytes: number, signal?: AbortSignal): Promise<Buffer> {
		return new Promise<Buffer>((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			let settled = false;
			const cleanup = () => {
				req.removeListener('data', onData);
				req.removeListener('end', onEnd);
				req.removeListener('error', onError);
				req.removeListener('aborted', onAborted);
				req.removeListener('close', onClose);
				signal?.removeEventListener('abort', onSignalAborted);
			};
			const fail = (error: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				chunks.length = 0;
				cleanup();
				reject(error);
			};
			const onData = (value: Buffer | string) => {
				if (settled) {
					return;
				}
				const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
				size += chunk.byteLength;
				if (size > maximumBytes) {
					fail(new Error('Request body too large'));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			};
			const onEnd = () => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(Buffer.concat(chunks, size));
			};
			const onError = (error: Error) => fail(error);
			const onAborted = () => fail(new Error('Request aborted'));
			const onClose = () => fail(new Error('Request closed before completion'));
			const onSignalAborted = () => {
				fail(new Error('Request cancelled'));
				try {
					req.destroy();
				} catch {
					// The request is already revoked; transport destruction remains best-effort.
				}
			};
			req.on('data', onData);
			req.once('end', onEnd);
			req.once('error', onError);
			req.once('aborted', onAborted);
			req.once('close', onClose);
			signal?.addEventListener('abort', onSignalAborted, { once: true });
			if (signal?.aborted) {
				onSignalAborted();
			}
		});
	}

	private _sendJsonRpc(res: http.ServerResponse, payload: unknown): void {
		if (res.writableEnded) {
			return;
		}
		if (!res.headersSent) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
		}
		res.end(JSON.stringify(payload));
	}

	private _sendIngressRejected(res: http.ServerResponse): void {
		if (res.writableEnded) {
			return;
		}
		if (!res.headersSent) {
			res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
		}
		res.end(JSON.stringify({ error: 'Para Browser endpoint unavailable.' }));
	}

	private _sendIngressCapacityRejected(res: http.ServerResponse): void {
		if (res.writableEnded) {
			return;
		}
		if (!res.headersSent) {
			res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' });
		}
		res.end(JSON.stringify({ error: 'Para Browser endpoint is busy.' }));
	}

	private _settleUnexpectedRequestError(res: http.ServerResponse, error: unknown): void {
		this._runNonThrowingDiagnostic(() => this.logService.error('[ParadisAgentBrowser] Unhandled error in HTTP handler', error));
		if (res.writableEnded) {
			return;
		}
		try {
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
			}
			if (!res.writableEnded) {
				res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
			}
		} catch {
			// The transport itself may already be gone; diagnostics and settlement remain best-effort.
		}
	}

	override dispose(): void {
		if (this._serverDisposed) {
			return;
		}
		// Revoke before aborting or closing anything: abort callbacks and delayed awaits must
		// observe an invalid authority synchronously and cannot refresh into a replacement owner.
		this._serverDisposed = true;
		this._authorityFaulted = true;
		for (const controller of [...this._activeRequestControllers]) {
			try {
				controller.abort();
			} catch {
				// Continue invalidating every request even if an abort listener misbehaves.
			}
		}
		this._activeRequestControllers.clear();
		this._activeIngressRequestsByToken.clear();
		this._activeIngressRequestCount = 0;
		this._activeHookRequestsByToken.clear();
		this._activeHookRequestCount = 0;
		this._activeModRequestsByToken.clear();
		this._activeModRequestCount = 0;
		this._activeMobileVoiceRequestCount = 0;
		this._activeMobileVoiceBytes = 0;
		this._mobileVoiceTickets.clear();
		this._runNonThrowingCleanup('devtools-generation-coordinator', () => this._devtoolsGenerationCoordinator.dispose());
		this._runNonThrowingCleanup('file-drop-staging', () => this._fileDropStaging.dispose());
		this._runNonThrowingCleanup('remote-file-transfer', () => this._remoteFileTransfer.dispose());
		for (const token of new Set([
			...this._paneShells.keys(),
			...this._paneStatuses.keys(),
			...this._activityApprovalTokens,
			...this._agentHookTokens,
			...this._seenTokens,
		])) {
			this._runNonThrowingCleanup('disposed-activity', () => clearParadisAgentPaneActivity(token));
		}
		for (const token of this._bindings.keys()) {
			this._dispatchBackgroundThrottlingEffects(this._backgroundThrottlingCoordinator.releaseBinding(token));
		}
		for (const [token, grants] of this._agentTabGrants) {
			for (const tabId of grants.keys()) {
				this._dispatchBackgroundThrottlingEffects(this._backgroundThrottlingCoordinator.releaseBinding(paradisAgentTabScopeKey(token, tabId)));
			}
		}
		this._agentTabGrants.clear();
		this._selectedTabs.clear();
		this._tabScopes.clear();
		this._backgroundThrottlingDispatcher?.dispose();
		this._backgroundThrottlingDispatcher = undefined;
		this._bindings.clear();
		this._quarantinedBindings.clear();
		this._faultedTokens.clear();
		this._quarantinedTokenState.clear();
		this._paneShells.clear();
		this._paneRemoteAuthorities.clear();
		this._remotePaneWindows.clear();
		this._paneStatuses.clear();
		this._paneSessions.clear();
		this._activityApprovalTokens.clear();
		this._awaitingUserTokens.clear();
		this._agentHookTokens.clear();
		this._hookReportedTokens.clear();
		this._replayedPrompts.clear();
		this._unconfirmedReleaseTokens.clear();
		this._unconfirmableTokens.clear();
		this._seenTokens.clear();
		this._terminalExitedTokens.clear();
		this._rendererConnections.clear();
		this._rendererConnectionContexts.clear();
		this._knownRendererContexts.clear();
		this._mainLiveWindowIds.clear();
		this._runNonThrowingCleanup('port-file-reconciler', () => this._portFileReconciler?.dispose());
		this._portFileReconciler = undefined;
		this._port = undefined;
		try {
			this._httpServer?.close();
		} catch {
			// Authority is already revoked; a transport close failure must not undo teardown.
		}
		this._httpServer = undefined;
		// Do not unlink the fixed record here: an older shared process can dispose after a newer
		// generation atomically published its own record. Shim-side PID validation rejects stale files.
		super.dispose();
	}
}

/** JSON-RPCのエラーレスポンスに変換されるエラー。 */
class JsonRpcMethodError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

class ParadisIngressLeaseError extends Error { }
