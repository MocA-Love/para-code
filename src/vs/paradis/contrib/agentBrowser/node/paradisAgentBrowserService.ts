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
import { writeFileSync } from 'fs';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isAbsolute, join } from '../../../../base/common/path.js';
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
import { IParadisAgentPageRequestResult, IParadisCloseAgentTabResult, IParadisListAgentTabsResult, IParadisOpenAgentTabResult, IParadisSelectAgentTabResult, PARADIS_AGENT_BROWSER_TABS_CHANNEL, PARADIS_AGENT_PAGE_REQUEST_TIMEOUT_MS, PARADIS_AGENT_TAB_LIMIT, ParadisAgentPageRequestFailure, ParadisAgentTabFailure, ParadisAgentTabMethod } from '../common/paradisAgentBrowserTabs.js';
import { IParadisAbortBindResult, IParadisAgentPaneSession, IParadisAgentPaneStatus, IParadisAgentStatusSnapshot, IParadisBindingTicketRequest, IParadisCdpInputDispatchResult, IParadisCdpScreenshotOptions, IParadisCommitBindResult, IParadisExactBrowserViewDescriptor, IParadisGatewayEndpoint, IParadisMcpConfigStatus, IParadisMcpFixRequest, IParadisMcpSetupRequest, IParadisMcpSetupResult, IParadisPaneBinding, IParadisPrepareBindRequest, IParadisPrepareBindResult, IParadisPreviewFileResult, IParadisSharedPageInfo, ParadisPreviewFileFailure, PARADIS_AGENT_BROWSER_CHANNEL, PARADIS_AGENT_PANE_ROOTS_METHOD, PARADIS_AGENT_PREVIEW_CHANNEL, PARADIS_CDP_TARGET_CHANNEL, PARADIS_MCP_DEFAULT_PORT, PARADIS_MCP_PORT_FILE_NAME, paradisCodexPaneSocketPath, paradisRemoteCodexPaneSocketPath, ParadisAgentStatus, paradisNormalizeAgentHookEvent, paradisParseCdpInputDispatchResult, paradisParseExactBrowserViewDescriptor } from '../common/paradisAgentBrowser.js';
import { PARADIS_AGENT_HOOK_MAX_BODY_BYTES, PARADIS_AGENT_HOOK_REMOTE_HOST_PARAM, PARADIS_AGENT_HOOKS_ENABLED_SETTING, PARADIS_CODEX_HOOK_EVENTS, paradisAgentHookRemoteHostId, paradisAgentHooksEnabled, paradisIsAgentHookRemoteHostId } from '../common/paradisAgentHooks.js';
import { IParadisBindingAuthorityManifest, IParadisBindingCommitPreparation, IParadisBindingManifestAcceptance, IParadisBindingOwnedTokenLease, IParadisBindingOwnerRelease, IParadisBindingPrepareSnapshot, ParadisBindingAuthority, ParadisBindingAuthorityStableScope, paradisParseBindingAuthorityManifest } from '../common/paradisBindingAuthority.js';
import { paradisBindingMatchesGeneration } from '../common/paradisBrowserBindingLifecycle.js';
import { paradisShouldSweepStaleWorkingStatus } from '../common/paradisAgentStatusStale.js';
import { IParadisExactViewBackgroundThrottlingEffect, PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS, ParadisExactViewBackgroundThrottlingCoordinator, ParadisExactViewBackgroundThrottlingDispatcher } from '../common/paradisExactViewBackgroundThrottling.js';
import { IParadisMobileRendererManifest, PARADIS_MOBILE_WINDOW_LEASE_CHANNEL } from '../../mobileRelay/common/paradisMobileWindowLease.js';
import { PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES } from '../../notifications/common/paradisNotifications.js';
import { clearParadisAgentPaneActivity, clearParadisAgentPaneIssueUrls, fireParadisAgentHookEvent, fireParadisAgentNestedHookEvent, getParadisAgentPaneActivity, getParadisAgentPaneIssueUrls, onParadisAgentAwaitingUser, onParadisAgentPaneActivity, onParadisAgentTurnEnded, onParadisAgentTurnStarted, ParadisAgentTurnEndCause, paradisCountLiveBackgroundTasks, paradisSanitizeAgentHookPayload, registerParadisAgentPaneActivityGuard } from './paradisAgentHookBus.js';
import { ParadisAgentHookOwnership, paradisHookAgentKindForTranscript } from './paradisAgentHookOwnership.js';
import { IParadisReplayedAgentPrompt, IParadisSpooledAgentHook, PARADIS_AGENT_HOOK_ID_PARAM, PARADIS_AGENT_HOOK_ID_PATTERN, PARADIS_AGENT_HOOK_REPLAY_PROMPT_WINDOW_MS, PARADIS_AGENT_HOOK_SPOOL_ALIVE_FILE, PARADIS_AGENT_HOOK_SPOOL_ALIVE_INTERVAL_MS, PARADIS_AGENT_HOOK_SPOOL_DIR_NAME, PARADIS_AGENT_HOOK_SYNC_GRACE_MS, paradisPlanAgentHookReplay } from '../common/paradisAgentHookSpool.js';
import { paradisPruneAgentHookSpool, paradisStampAgentHookSpoolAlive, paradisTakeAgentHookSpool } from './paradisAgentHookSpoolStore.js';
import { onDidChangeParadisCodexHomes, paradisCodexHome, paradisCodexHomes } from './paradisAgentHome.js';
import { ParadisAgentHooksReconciler, paradisClaudeManagedHookEvents, paradisGetNotifyScriptContent, paradisMergeAgentHooksJson, paradisRemoveAgentHooks, paradisRemoveAgentHooksJson } from './paradisAgentHooksSetup.js';
import { ParadisAgentHooksAutoInstall } from './paradisAgentHooksAutoInstall.js';
import { ParadisRemoteAgentTunnels } from './paradisRemoteAgentTunnel.js';
import { createParadisMcpSetupController, ParadisMcpSetupController } from './paradisMcpSetup.js';
import { IParadisMcpPortFileRecord, PARADIS_MCP_HEALTH_PATH, PARADIS_MCP_LOCAL_TOOLS, PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION, ParadisMcpPortFileReconciler, writeParadisMcpPortFileAtomic } from './paradisBrowserMcpShimCore.js';
import { ParadisCdpGateway } from './paradisCdpGateway.js';
import { paradisClassifyPeer, paradisPeerIsOneOf } from './paradisCdpPeerResolver.js';
import { IParadisCdpInputQueueOperation, ParadisCdpInputQueue } from './paradisCdpInputQueue.js';
import { ParadisCdpUpstream } from './paradisCdpUpstream.js';
import { IParadisDevtoolsRootsResolution, IParadisProxiedTool, ParadisDevtoolsMcpProxy } from './paradisDevtoolsMcpProxy.js';
import { IParadisDevtoolsPathCaller, paradisDevtoolsPathArguments, paradisDevtoolsPathDecision, paradisDevtoolsUserTemporaryFolders } from './paradisDevtoolsPathPolicy.js';
// PARA-PATCH: 他のparadis contribがこのMCPサーバーへ自前のツールを足すための拡張点（モバイル端末操作など）
import { IParadisMcpOwningWindowRequest, IParadisMcpPaneAgentStatus, IParadisMcpToolCallContext, IParadisMcpToolProvider, ParadisMcpCallerKind, ParadisMcpOwningWindowResult, paradisRegisteredMcpToolProviders } from '../common/paradisMcpToolProvider.js';
import { PARADIS_SCREENSHOT_FETCH_PATH, ParadisScreenshotHandoff, paradisAppendScreenshotFetchHint, paradisReadScreenshotFile, paradisScreenshotContentType, paradisScreenshotIdFromUrl, paradisScreenshotPathsFromToolResult } from './paradisScreenshotHandoff.js';
import { PARADIS_PAGE_OPS_TOOL_NAME_SET, ParadisBrowserPageOps, paradisPageOpsOwnerKey } from './paradisBrowserPageOps.js';
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
}

const MAX_BODY_BYTES = PARADIS_AGENT_HOOK_MAX_BODY_BYTES;
const MAX_EXTERNAL_BINDINGS = PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS;
const MAX_RENDERER_WINDOWS = 4096;
const MAX_PANE_TOKEN_LENGTH = 200;
const MAX_HOOK_EVENT_LENGTH = 200;
const MAX_PENDING_BIND_PREPARATIONS = 256;
const MAX_ACTIVE_INGRESS_REQUESTS = 128;
/** `initialize` の `instructions` の先頭に置く、このサーバー自身（ブラウザ共有）の説明。 */
const PARADIS_BROWSER_MCP_INSTRUCTIONS = 'Para Code MCP server (runs inside the Para Code editor that hosts this terminal). Browser tools act on the browser page the user shared with this terminal pane.';
const MAX_ACTIVE_INGRESS_REQUESTS_PER_TOKEN = 8;
const MAX_ACTIVE_MOBILE_VOICE_REQUESTS = 2;
const MAX_ACTIVE_MOBILE_VOICE_BYTES = 16 * 1024 * 1024;
const MOBILE_VOICE_TICKET_TTL_MS = 10 * 60_000;
const MAX_MOBILE_VOICE_TICKETS = 256;
const MAX_MOBILE_VOICE_TICKETS_PER_PANE = 8;

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
const NOT_BOUND_MESSAGE = 'このターミナルペインに共有されたブラウザページはありません。自分用のタブが要るなら open_browser_tab で開けます（承認不要）。ユーザーのタブ（ログイン済みのページなど）を使いたいなら request_browser_page でユーザーに共有を頼めます。ユーザー側から共有する場合は、Para Code側でブラウザページを開き、コマンドパレットから「Para Code: Share Browser Page with Terminal Pane」を実行してこのペインに共有してください。注意: 共有はPara Codeの再起動（自動アップデート適用を含む）でリセットされるため、以前共有していた場合も再共有が必要です。再共有しても届かない場合は、このCLIをペインで起動し直してから再共有してください（ペインの識別トークンが再起動で変わっている可能性があります）。';

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
const CDP_LIMITATIONS_NOTE = 'The gateway exposes exactly one page (the one shared with this terminal pane). new_page (Target.createTarget) and close_page (Target.closeTarget) are not supported - use the open_browser_tab / select_browser_tab / close_browser_tab tools of this server instead (you can only close tabs you opened). list_pages / select_page only ever see the one shared page; list_browser_tabs shows the tabs you can switch to. resize_page is not supported because the embedded browser is laid out by the workbench - use the emulate tool (viewport emulation) instead. Clearing cookies/storage/cache over CDP is blocked because the browser partition is shared across Para Code.';

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
	private readonly _cdpInputQueue = this._register(new ParadisCdpInputQueue());
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
	 * MCPリクエスト（またはCDPゲートウェイのPID識別）で実際に接続実績のあったペイントークンの集合。
	 * バインディングダイアログの「MCP未接続」表示に使う（shared processの生存期間のみ保持）。
	 */
	private readonly _seenTokens = new Set<string>();
	/**
	 * エージェントCLIのhook通知 (GET /agent-hook) で更新される、ペインごとの実行状態。
	 * renderer-local producerがlistAgentStatusSnapshotでatomic取得し、Workspaces表示と通知へ配る。
	 */
	private readonly _paneStatuses = new Map<string, IParadisPaneStatusEntry>();
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
	 * 許可待ち・質問中が hook ではなく transcript から解かれ、その後に確かめた hook がまだ来ていないペイン。
	 * transcript は同じユーザーの別プロセスが追記できるので、これで解かれた状態を IDE 操作ツールは
	 * 信用しない（Enter を送らない）。確かめた hook が来たら外す。
	 */
	private readonly _unconfirmedReleaseTokens = new Set<string>();
	/** 印が付いたまま、hook の接続元を確かめられなかったペイン（tmux・WSL など）。IDE 操作ツールの Enter は利用者に任せる。 */
	private readonly _unconfirmableTokens = new Set<string>();
	/** 接続（keep-alive）ごとの、接続元プロセスの分類の結果。接続が消えれば一緒に消える。 */
	private readonly _callerClassifications = new WeakMap<Socket, Map<string, { readonly kind: ParadisMcpCallerKind; readonly key: string }>>();
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
	private _activeMobileVoiceRequestCount = 0;
	private _activeMobileVoiceBytes = 0;
	// lease未設定のticketは拡張機能ホスト由来（ペインを持たない）。音声取込だけに使える。
	private readonly _mobileVoiceTickets = new Map<string, { readonly lease: IParadisAgentBrowserIngressLease | undefined; readonly expiresAt: number }>();
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
				captureIngressLease: token => this.captureIngressLease(token),
				isIngressLeaseCurrent: lease => this.isIngressLeaseCurrent(lease),
				getBoundTargetId: token => this.captureIngressLease(token) === undefined ? undefined : this._bindings.get(token)?.exactView.targetId,
				ensureBoundTargetId: token => this._ensureBoundTargetId(token),
				getTokenForShellPid: pid => this._getTokenForShellPid(pid),
				captureBoundPageScreenshot: (token, options) => this._captureBoundPageScreenshot(token, options),
				isBoundPageVisible: token => this._isBoundPageVisible(token),
				dispatchBoundPageInput: (token, connection, expectedTargetId, method, paramsJson, isConnectionCurrent) =>
					this._dispatchBoundPageInput(token, connection, expectedTargetId, method, paramsJson, isConnectionCurrent),
				closeInputConnection: connection => this._cdpInputQueue.closeConnection(connection),
				isRemotePane: token => this._isRemotePaneForGateway(token),
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
			resolveRoots: token => this._resolveDevtoolsRoots(token),
		}));
		this._agentNetworkFilter = configurationService ? this._register(new AgentNetworkFilterService(configurationService)) : undefined;
		this._pageOps = new ParadisBrowserPageOps({
			// ingress が止まっているペイン（終了済み・隔離中）には共有が無いものとして扱う
			binding: token => this.captureIngressLease(token) === undefined ? undefined : this._bindings.get(token),
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
		const cachedShellEnv = new ParadisCachedShellEnv(
			logService,
			'ParadisAgentHooks',
			createParadisShellEnvResolver(logService, configurationService, args),
			Date.now,
			reportParadisShellEnvDiagnosticError,
		);
		// 制御ソケット（Codex ソケットの引き込みに使う）は、ペイン用ソケットと同じ場所へ置く。
		// ssh はログインシェル由来の環境で起こす: `SSH_AUTH_SOCK` を rc で設定する鍵エージェント
		// 構成（1Password / gpg-agent 等）だと、shared process が継いだ環境のままでは公開鍵認証が
		// 黙って失敗し、拡張機能側の接続だけ成功して戻り経路が張れない状態になる
		this._remoteTunnels = this._register(new ParadisRemoteAgentTunnels(logService, undefined, join(this._userDataPath, 'pcx'), () => cachedShellEnv.getEnv()));
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
		);
		// ホームが増えたら（アカウントの追加・ログイン、設定で足した）、既定のホームでセットアップ済みの
		// 設定をそこへも入れる。セットアップや修正のときだけでは、後から増えたホームに入らない。
		this._register(onDidChangeParadisCodexHomes(() => {
			void this._currentGatewayPort().then(port => this._mcpSetupController.propagateToCodexHomes(port)).catch(error => {
				this._runNonThrowingDiagnostic(() => this.logService.warn('[ParadisAgentBrowser] Failed to add the MCP settings to new Codex homes', error));
			});
		}));
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
		this._register(registerParadisAgentPaneActivityGuard(token => this.captureIngressLease(token) !== undefined));
		this._register(onParadisAgentTurnStarted(({ token, cwd, at }) => {
			const ingressLease = this.captureIngressLease(token);
			if (ingressLease === undefined) {
				return;
			}
			if (this.isIngressLeaseCurrent(ingressLease)) {
				this._agentHookTokens.add(token);
				const previous = this._paneStatuses.get(token)?.status;
				if (previous === 'permission' || previous === 'question') {
					this._unconfirmedReleaseTokens.add(token);
				}
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
			if (ingressLease === undefined) {
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
		if (previous === undefined && this._bindings.size + this._quarantinedBindings.size >= MAX_EXTERNAL_BINDINGS) {
			throw new Error('Para Browser binding capacity reached');
		}
		try {
			this._backgroundThrottlingCoordinator.assertCanSetBinding(
				Array.from(this._bindings, ([token, binding]) => [token, binding.exactView] as const),
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
		this._bindings.set(preparation.token, binding);
		const throttlingEffects = this._backgroundThrottlingCoordinator.setBinding(preparation.token, binding.exactView);
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
		if (entry === undefined) {
			return false;
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
			return false;
		}
		this._deleteActiveBinding(token, entry);
		this._bindingAuthority.recordBindingMutation(token, undefined);
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
			payload: record.payload, at: now,
		});
		this._runNonThrowingDiagnostic(() => this.logService.info(`[ParadisAgentBrowser] a replayed ${pending.status} is still on screen; showing it`));
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
		if (ingressLease === undefined) {
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
			this._paneStatuses.set(token, { status: 'review', changedAt: at, ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}) });
		}
	}

	/**
	 * @param includeQuestion 質問中も解く（CLI が終わったとき）。許可の拒否では質問中は触らない
	 */
	private _settlePaneAwaitingUser(token: string, includeQuestion: boolean = false): void {
		const ingressLease = this.captureIngressLease(token);
		if (ingressLease === undefined) {
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
		const cleanupGeneration = generation ?? this._advanceBindingGeneration(token);
		this._paneShells.delete(token);
		this._paneRemoteAuthorities.delete(token);
		this._paneStatuses.delete(token);
		this._paneSessions.delete(token);
		this._activityApprovalTokens.delete(token);
		this._awaitingUserTokens.delete(token);
		this._agentHookTokens.delete(token);
		this._hookReportedTokens.delete(token);
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

	private _activateBindingGeneration(token: string, generation: number, cancelPendingForget: boolean): void {
		this._runNonThrowingCleanup('generation', () => this._devtoolsGenerationCoordinator.setGeneration(token, generation, cancelPendingForget));
		this._runNonThrowingCleanup('gateway-connections', () => this._cdpGateway.closeConnectionsForToken(token));
		this._runNonThrowingCleanup('devtools-retire', () => this._devtoolsProxy.retire(token, generation));
		// 共有が入れ替わったら、そのペインがタブへ掛けた上書き（ヘッダ・認証・ルール）を外す
		this._runNonThrowingCleanup('page-ops-release', () => this._pageOps.releaseOwner(token, generation));
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

	/** Returns only the target fixed by the committed exact BrowserView descriptor. */
	private async _ensureBoundTargetId(token: string): Promise<string | undefined> {
		const ingressLease = this.captureIngressLease(token);
		if (ingressLease === undefined) {
			return undefined;
		}
		const binding = this._bindings.get(token);
		if (!binding) {
			return undefined;
		}
		return this.isIngressLeaseCurrent(ingressLease) && this._bindings.get(token) === binding
			? binding.exactView.targetId
			: undefined;
	}

	/**
	 * CDPゲートウェイからの `Page.captureScreenshot` 委譲。electron-mainの
	 * {@link PARADIS_CDP_TARGET_CHANNEL} 経由でupstream実装（非表示時の回避策付き）を呼び、
	 * base64画像データを返す。失敗・世代変更時はretryable errorにし、生CDPへfallbackさせない。
	 * encode-size上限だけは同じ入力の再試行で回復しないため、明示的なnon-retryable errorを保持する。
	 */
	private async _captureBoundPageScreenshot(token: string, options: IParadisCdpScreenshotOptions): Promise<string | undefined> {
		const ingressLease = this.captureIngressLease(token);
		if (ingressLease === undefined) {
			throw new ParadisIngressLeaseError();
		}
		const binding = this._bindings.get(token);
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
			const current = this._bindings.get(token);
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

	/** Read visibility through electron-main while protecting the result with the same binding generation. */
	private async _isBoundPageVisible(token: string): Promise<boolean> {
		const ingressLease = this.captureIngressLease(token);
		if (ingressLease === undefined) {
			throw new ParadisIngressLeaseError();
		}
		const binding = this._bindings.get(token);
		if (!binding) {
			throw new Error('PARA_BROWSER_RETRYABLE: no browser page is bound to this pane.');
		}
		try {
			const visible = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<boolean | null>('isExactViewVisible', [binding.exactView]);
			this._requireIngressLease(ingressLease);
			const current = this._bindings.get(token);
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

	private _dispatchBoundPageInput(
		token: string,
		connection: object,
		expectedTargetId: string,
		method: string,
		paramsJson: string,
		isConnectionCurrent: () => boolean,
	): IParadisCdpInputQueueOperation {
		const ingressLease = this.captureIngressLease(token);
		const binding = ingressLease === undefined ? undefined : this._bindings.get(token);
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
			&& this._bindings.get(token) === binding
			&& binding.generation === this._bindings.get(token)?.generation
			&& binding.exactView.targetId === expectedTargetId;
		return this._cdpInputQueue.enqueue({
			queueKey,
			connection,
			isAuthorityCurrent,
			dispatch: async () => {
				const raw = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
					.call<unknown>('dispatchExactViewInput', [binding.exactView, method, paramsJson]);
				const result = paradisParseCdpInputDispatchResult(raw);
				if (!result) {
					throw new Error('Invalid exact BrowserView input dispatch response');
				}
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
	private async _classifyCaller(token: string, socket: Socket | undefined): Promise<ParadisMcpCallerKind> {
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
		let cached = this._callerClassifications.get(socket);
		const hit = cached?.get(token);
		// シェルが入れ替わった・戻り経路が張り直された後は、前の判定を使わない
		if (hit && hit.key === cacheKey) {
			return hit.kind;
		}
		let kind: ParadisMcpCallerKind = 'unverified';
		try {
			const peer = await paradisClassifyPeer(socket.remotePort, this._port, process.pid, expectation);
			kind = peer === 'descendant' && pane.remoteAuthority === undefined
				? 'pane'
				: peer === 'tunnel' && pane.remoteAuthority !== undefined
					? 'tunnel'
					: 'unverified';
		} catch {
			kind = 'unverified';
		}
		if (kind !== 'unverified') {
			if (!cached) {
				cached = new Map();
				this._callerClassifications.set(socket, cached);
			}
			cached.set(token, { kind, key: cacheKey });
		}
		return kind;
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
	 * ウィンドウが destroy されたら、そのウィンドウ名義の戻りトンネルと Codex ソケットの転送を手放す。
	 *
	 * ウィンドウ側からの取り下げは dispose 時の投げっぱなしなので、クラッシュや終了中の切断では
	 * 届かない。届かないまま所有者として残ると、トンネルは誰も使っていないのに畳まれず、次に同じ
	 * 接続先へ別のウィンドウが繋いだ瞬間に死んだウィンドウのソケットまで張り直される。
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

	/**
	 * 接続先で動く Codex ペインのソケットを、手元の同じ場所へ引いてくる。
	 *
	 * 呼び出し側（接続中のウィンドウ）が今あるペインの一覧を渡し、ここが差分を取る。手元の
	 * ソケットの場所は**こちらで決める**（繋いでいないときと同じ規則）。渡されたパスをそのまま
	 * listen に使うと、ウィンドウ側の言い値で任意の場所にソケットを作れてしまう。
	 */
	async syncRemoteCodexSockets(windowCtx: string, remoteAuthority: string, remoteParaCodeDirectory: string, tokens: readonly string[]): Promise<void> {
		const wanted = new Map<string, string>();
		for (const token of tokens) {
			const localPath = paradisCodexPaneSocketPath(this._userDataPath, token);
			const remotePath = paradisRemoteCodexPaneSocketPath(remoteParaCodeDirectory, token);
			// `-L` の値は `<手元>:<接続先>` を1語で渡すため、コロンが混ざると別の意味に読まれる
			if (localPath !== undefined && remotePath !== undefined && !localPath.includes(':')) {
				wanted.set(localPath, remotePath);
			}
		}
		this._remoteTunnels.syncSocketForwards(windowCtx, remoteAuthority, wanted);
	}

	/** 接続が切れた・ウィンドウが閉じたときに、その接続先ぶんの転送を畳む。 */
	async releaseRemoteCodexSockets(windowCtx: string): Promise<void> {
		this._remoteTunnels.releaseSocketForwards(windowCtx);
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
		server.maxConnections = 256;
		server.maxHeadersCount = 100;
		server.maxRequestsPerSocket = 100;
		server.headersTimeout = 10_000;
		server.requestTimeout = 30_000;
		server.keepAliveTimeout = 5_000;
		server.timeout = 300_000;
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
			this._sendIngressRejected(res);
			return;
		}
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
			return this._handleMobileVoiceIngress(req, res);
		}
		if (req.method === 'POST' && req.url === '/paradis-mcp/mobile-voice-ticket') {
			return this._handleMobileVoiceTicket(req, res);
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
	private async _handleMobileVoiceIngress(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (this.publishMobileVoiceClip === undefined) {
			this._sendIngressRejected(res);
			return;
		}
		const requestedTicket = this._extractToken(req);
		const ticket = requestedTicket === undefined ? undefined : this._mobileVoiceTickets.get(requestedTicket);
		if (requestedTicket !== undefined) {
			// 音声ticketは成否を問わず1回だけ。再送には要求元が新しいticketを発行する。
			this._mobileVoiceTickets.delete(requestedTicket);
		}
		if (ticket === undefined || ticket.expiresAt < Date.now() || !this._isMobileVoiceTicketCurrent(ticket)) {
			this._sendIngressRejected(res);
			return;
		}
		const ingressLease = ticket.lease;
		const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
		if (contentType !== 'audio/mpeg' && contentType !== 'application/octet-stream') {
			res.writeHead(415, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify({ error: 'Audio payload rejected.' }));
			return;
		}
		const declaredLength = Number(req.headers['content-length']);
		if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 || declaredLength > PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES) {
			res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify({ error: 'Audio payload rejected.' }));
			return;
		}
		const reservation = this._reserveIngressRequest(ingressLease?.token ?? this._voiceIngressToken);
		if (reservation === undefined) {
			this._sendIngressCapacityRejected(res);
			return;
		}
		const voiceReservation = this._reserveMobileVoiceIngress(declaredLength);
		if (voiceReservation === undefined) {
			reservation.dispose();
			this._sendIngressCapacityRejected(res);
			return;
		}
		let activeRequest: ReturnType<ParadisAgentBrowserService['_trackActiveRequest']> | undefined;
		try {
			activeRequest = this._trackActiveRequest(req, res);
			let audio: Buffer;
			try {
				audio = await this._readBodyBytes(req, PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES, activeRequest.controller.signal);
			} catch {
				if (!activeRequest.controller.signal.aborted) {
					res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
					res.end(JSON.stringify({ error: 'Audio payload rejected.' }));
				}
				return;
			}
			if (activeRequest.controller.signal.aborted) {
				return;
			}
			if (audio.byteLength !== declaredLength) {
				res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
				res.end(JSON.stringify({ error: 'Audio payload rejected.' }));
				return;
			}
			if (!this._isMobileVoiceTicketCurrent(ticket)) {
				this._sendIngressRejected(res);
				return;
			}
			this.publishMobileVoiceClip(audio);
			res.writeHead(202, { 'Cache-Control': 'no-store' });
			res.end();
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
			this._sendIngressCapacityRejected(res);
			return;
		}
		const voiceTicket = `${randomUUID()}-${randomUUID()}`;
		const expiresAt = now + MOBILE_VOICE_TICKET_TTL_MS;
		this._mobileVoiceTickets.set(voiceTicket, { lease: ingressLease, expiresAt });
		const body = JSON.stringify({ ticket: voiceTicket, expiresAt, instanceId: this._mcpInstanceId });
		res.writeHead(201, {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(body),
			'Cache-Control': 'no-store',
		});
		res.end(body);
	}

	private async _handleAgentHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const requestedToken = this._extractToken(req);
		const ingressLease = requestedToken === undefined ? undefined : this.captureIngressLease(requestedToken);
		if (ingressLease === undefined) {
			// まだ同期していないだけかもしれないペインには 503 で答え、notify スクリプトに控えさせる。
			// 知らない・終わったペインには 404（控えない）。W2-20 レビュー M3。
			if (requestedToken !== undefined && this._isHookTokenPossiblyUnsynced(requestedToken)) {
				res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
				res.end(JSON.stringify({ error: 'Pane not synced yet.' }));
				return;
			}
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
			const currentStatus = eventType ? this._paneStatuses.get(token)?.status : undefined;
			if (currentStatus === 'permission' || currentStatus === 'question') {
				const caller = await this._classifyCaller(token, req.socket as Socket);
				if (!this.isIngressLeaseCurrent(ingressLease)) {
					this._sendIngressRejected(res);
					return;
				}
				if (caller === 'unverified') {
					this._runNonThrowingDiagnostic(() => this.logService.info(`[ParadisAgentBrowser] agent-hook ignored while waiting for the user (caller not verified): ${eventType}`));
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: false, reason: 'caller not verified' }));
					return;
				}
				this._unconfirmedReleaseTokens.delete(token);
				this._unconfirmableTokens.delete(token);
			} else if (eventType && eventType !== 'TerminalExit' && this._unconfirmedReleaseTokens.has(token) && !this._unconfirmableTokens.has(token)) {
				// transcript から許可待ちが解かれた後の印は、確かめた hook でだけ外す。確かめられない hook も
				// 捨てずに処理する（tmux・WSL などでは確かめを通れないので、捨てると定期実行の見張りやモバイルの
				// 会話が止まる）。印は IDE 操作ツールの Enter を断る条件にだけ使う。確かめられなかったペインは
				// 次の許可待ちで確かめが通るまで問い合わせない（hook のたびに lsof を起こさない）
				const caller = await this._classifyCaller(token, req.socket as Socket);
				if (!this.isIngressLeaseCurrent(ingressLease)) {
					this._sendIngressRejected(res);
					return;
				}
				if (caller === 'unverified') {
					this._unconfirmableTokens.add(token);
				} else {
					this._unconfirmedReleaseTokens.delete(token);
				}
			}
			// 発信元プロセスの所有権分類。ペイントークンはターミナル配下の全子プロセスへ
			// 継承されるため、所有エージェントの配下で動く別エージェント（例: plugin 経由の
			// `codex exec`）のhookをここで仕分けないと、ペインのセッションrebind・状態・通知の
			// すべてが子に乗っ取られる。分類は状態更新とhookバス発火のどちらよりも前に行う。
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
				const hookPid = remoteHostId !== undefined || this._paneShells.get(token)?.remoteAuthority !== undefined ? undefined : parsedPid;
				const hookOrigin = await this._hookOwnership.classify({ token, hookPid, transcriptPath, at: Date.now() });
				if (!this.isIngressLeaseCurrent(ingressLease)) {
					this._sendIngressRejected(res);
					return;
				}
				if (hookOrigin.origin === 'invalid') {
					this._runNonThrowingDiagnostic(() => this.logService.info(`[ParadisAgentBrowser] agent-hook rejected (origin mismatch): ${eventType}`));
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: false, reason: 'origin rejected' }));
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
					this._unconfirmedReleaseTokens.delete(token);
					this._unconfirmableTokens.delete(token);
				} else {
					this._agentHookTokens.add(token);
					this._hookReportedTokens.add(token);
				}
				// 本物の hook が届いたら、控えから流し直して画面の確認を待っていたものは古い（W2-20）。
				this._replayedPrompts.delete(token);
				this._recordPaneSession(token, eventType, sessionId, transcriptPath, cwd);
				fireParadisAgentHookEvent({
					token, event: eventType, sessionId, transcriptPath, cwd, toolName, toolInput,
					toolUseId, messageId, messageDelta, messageIndex, messageFinal, payload: hookPayload,
					remoteHostId, at: Date.now(),
				});
			}
			if (!this.isIngressLeaseCurrent(ingressLease)) {
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

			if (normalized === 'idle') {
				this._paneStatuses.delete(token);
			} else {
				// cwd はhookが報告した最新値を保持する (今回のイベントに無ければ既知の値を維持)。
				const knownCwd = cwd ?? this._paneStatuses.get(token)?.cwd;
				this._paneStatuses.set(token, {
					status: normalized,
					changedAt: Date.now(),
					...(knownCwd !== undefined ? { cwd: knownCwd } : {}),
					...(backgroundCompletionFallback ? { backgroundCompletionFallback: true } : {}),
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
	 * Stop の review がバックグラウンドタスク補正で working になった状態だけを、一定時間後に
	 * reviewへ降格する。通常のPreToolUse→PostToolUse間や長い推論は途中hookが無いため、単に
	 * workingの更新時刻だけを見ると正常な長時間処理を完了扱いにしてしまう。
	 */
	private _sweepStalePaneStatuses(eligibleTokens: ReadonlySet<string>): void {
		const now = Date.now();
		for (const [token, entry] of this._paneStatuses) {
			if (eligibleTokens.has(token)
				&& paradisShouldSweepStaleWorkingStatus(entry.status, entry.backgroundCompletionFallback, entry.changedAt, now)) {
				this._paneStatuses.set(token, { status: 'review', changedAt: now, ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}) });
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
				const params = rpc.params as { protocolVersion?: unknown } | undefined;
				const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
				const instructions: string | undefined = this._serverInstructions();
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
				return { tools: [...TOOLS, ...provided, ...tools] };
			}
			case 'tools/call':
				return this._callTool(ingressLease, rpc.params as { name?: unknown; arguments?: unknown } | undefined, signal, socket);
			default:
				throw new JsonRpcMethodError(-32601, `Method not found: ${rpc.method}`);
		}
	}

	private async _callTool(ingressLease: IParadisAgentBrowserIngressLease, params: { name?: unknown; arguments?: unknown } | undefined, signal?: AbortSignal, socket?: Socket): Promise<unknown> {
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
			// 内蔵chrome-devtools-mcpは手元で動くので、ファイルのパスは手元のパスになる。接続先（SSH・WSL・
			// コンテナ）からのパスは渡す前に断る（手元のファイルの読み書きが機械の境界を越えるため。NOTES.md
			// 「chrome-devtools-mcp のファイルのパスは手元のペインからだけ受け、roots で範囲を絞る」）
			const pathArguments = paradisDevtoolsPathArguments(name, params?.arguments);
			if (pathArguments.length > 0) {
				const pathDecision = paradisDevtoolsPathDecision(await this._devtoolsPathCaller(token, socket), name, pathArguments);
				this._requireIngressLease(ingressLease);
				if (pathDecision.kind === 'refuse') {
					return this._toolError(pathDecision.message);
				}
			}
			// para固有ツールでなければ、内蔵chrome-devtools-mcpへの転送を試みる
			return this._callDevtoolsTool(ingressLease, name, params?.arguments, signal);
		}

		// 利用者に承認を求める・ページやプロファイルを開く / 切り替える / 消すツールは、トークンだけでなく
		// 接続元のプロセスも確かめる（トークンは同じユーザーの別プロセスが読めるので、他のペインの名で
		// 共有を頼めてしまう）。SSH の接続先のエージェントは戻り経路の ssh（tunnel）として通す。
		// 一覧だけのツールと、ブラウザの共有そのもの（CDP ゲートウェイ）はこれまでどおり
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
			return this._callPageOpsTool(ingressLease, name, params?.arguments, signal);
		}

		if (name === 'preview_file') {
			const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : undefined;
			const path = typeof toolArgs?.path === 'string' ? toolArgs.path : undefined;
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
			const boundEntry = this._bindings.get(token);
			const httpBase = this._port !== undefined ? `http://127.0.0.1:${this._port}/cdp` : undefined;
			if (!httpBase) {
				// allow-any-unicode-next-line
				return this._toolError('CDPゲートウェイのHTTPサーバーがまだ起動していません。少し待って再試行してください。');
			}
			return this._toolText(JSON.stringify({
				httpBase,
				// allow-any-unicode-next-line
				note: 'browser-use など外部の生CDPクライアントのCDP URLにこの httpBase を指定してください。chrome-devtools系ツール（take_snapshot / click / navigate_page 等）はこのMCPサーバーに内蔵済みなので、通常このエンドポイントを直接使う必要はありません。操作できるのはこのターミナルペインに共有されたページのみです。',
				limitations: CDP_LIMITATIONS_NOTE,
				boundPage: boundEntry ? { url: boundEntry.pageInfo.url, title: boundEntry.pageInfo.title } : null,
				...(boundEntry ? {} : { hint: NOT_BOUND_MESSAGE }),
			}, null, 2));
		}

		const binding = this._bindings.get(token);
		if (!binding) {
			return this._toolError(NOT_BOUND_MESSAGE);
		}

		switch (name) {
			case 'get_shared_page':
				return this._toolText(JSON.stringify({ url: binding.pageInfo.url, title: binding.pageInfo.title, pageId: binding.pageId }, null, 2));
			case 'upload_file_to_drop_zone':
				return this._uploadFileToDropZone(ingressLease, binding, params?.arguments, signal);
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
		try {
			return await this._pageOps.call({
				token: ingressLease.token,
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
			}, name, args);
		} catch (error) {
			if (error instanceof ParadisIngressLeaseError || !this.isIngressLeaseCurrent(ingressLease)) {
				throw new ParadisIngressLeaseError();
			}
			this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] ${name} failed for pane ${this._tokenFingerprint(ingressLease.token)}`));
			return this._toolError(`PARA_BROWSER_RETRYABLE: ${name} failed inside Para Code. Retry once; if it keeps failing, call get_session_health.`);
		}
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
		const token = ingressLease.token;
		const wsEndpoint = this._devtoolsWsEndpoint(token);
		if (!wsEndpoint) {
			return [];
		}
		return this._devtoolsGenerationCoordinator.runWithLease(token, async () => {
			try {
				this._requireIngressLease(ingressLease);
				const generation = this._bindings.get(token)?.generation ?? this._devtoolsGenerationCoordinator.getGeneration(token) ?? 0;
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
					.replaceAll(encodeURIComponent(token), this._tokenFingerprint(token))
					.replaceAll(token, this._tokenFingerprint(token));
				this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] Embedded chrome-devtools-mcp is unavailable for pane ${this._tokenFingerprint(token)}; serving para-browser tools only: ${safeMessage}`));
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
	private async _callDevtoolsTool(ingressLease: IParadisAgentBrowserIngressLease, name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		const token = ingressLease.token;
		return this._devtoolsGenerationCoordinator.runWithLease(token, async () => {
			this._requireIngressLease(ingressLease);
			const binding = this._bindings.get(token);
			const generation = binding?.generation ?? this._devtoolsGenerationCoordinator.getGeneration(token) ?? 0;
			const wsEndpoint = this._devtoolsWsEndpoint(token);
			const proxied = wsEndpoint ? await this._devtoolsProxy.isProxiedTool(token, generation, wsEndpoint, name, signal) : false;
			this._requireIngressLease(ingressLease);
			const currentAfterLookup = this._bindings.get(token);
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
				const current = this._bindings.get(token);
				if (current !== binding || !this._devtoolsGenerationCoordinator.isCurrentGeneration(token, generation)) {
					return this._toolError('PARA_BROWSER_RETRYABLE: binding changed while the tool was running');
				}
				if (result !== undefined) {
					// ファイルへ落ちたスクリーンショットは、呼び出し元が別の機械に居ると見えない。
					// 取りに来るための口を添える（保存に失敗した場合も、どこへ書こうとしたかは示す）。
					return name === 'take_screenshot' ? this._offerScreenshotHandoff(token, result, args) : result;
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
		const token = ingressLease.token;
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
		if (this._bindings.get(token) !== binding) {
			return this._toolError('PARA_BROWSER_RETRYABLE: the shared page binding changed while resolving the drop target; retry.');
		}

		let filePath: string;
		try {
			filePath = await this._fileDropStaging.stage(content, fileName);
		} catch (error) {
			return this._toolError(`Failed to stage "${fileName}" for upload: ${error instanceof Error ? error.message : String(error)}`);
		}

		const commands = paradisBuildFileDropDragCommands(target.x, target.y, filePath);
		let dragEntered = false;
		let completed = false;
		try {
			for (const [index, command] of commands.entries()) {
				if (this._bindings.get(token) !== binding) {
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
			} : { bound: false },
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
				childProcessAlive: this._devtoolsProxy.hasLiveChild(token),
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
	private _devtoolsWsEndpoint(token: string): string | undefined {
		if (this._port === undefined) {
			return undefined;
		}
		return `ws://127.0.0.1:${this._port}/cdp/devtools/browser/${EMBEDDED_DEVTOOLS_WS_ID}?pane=${encodeURIComponent(token)}`;
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
			return this._toolError(`preview_file requires an absolute file path (got: ${String(path)}). Resolve the path against your working directory first.`);
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
		const shared = call.value.bound
			? 'The page is now shared with this terminal pane, so the chrome-devtools tools (take_snapshot, click, navigate_page, ...) act on it.'
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
				const shared = call.value.bound
					? 'It is now the page shared with this terminal pane, so the chrome-devtools tools act on it.'
					: 'It could NOT be shared with this terminal pane, so the chrome-devtools tools do not target it yet - retry with select_browser_tab.';
				return this._toolText(`Opened tab ${call.value.tab.tabId} (${call.value.tab.url || 'about:blank'}). ${shared} You have ${call.value.openedCount} of ${PARADIS_AGENT_TAB_LIMIT} tabs of your own open.`);
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
				return this._toolText(JSON.stringify({ tabs: call.value.tabs, openedByYou: call.value.openedCount, limit: PARADIS_AGENT_TAB_LIMIT }, null, 2));
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
					return call.value.bound
						? this._toolText(`Tab ${tabId} (${call.value.tab.url || 'about:blank'}) is now the page shared with this terminal pane.`)
						: this._toolError(`PARA_BROWSER_RETRYABLE: Para Code could not share tab ${tabId} with this terminal pane. Retry once; if it keeps failing, ask the user to share it from Para Code.`);
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
				return this._toolText(`The user shared tab ${call.value.tab.tabId} (${call.value.tab.url || 'about:blank'}). It is now the page shared with this terminal pane, so the chrome-devtools tools act on it. The share ends when you switch to another tab; to come back to this page you would have to ask again.`);
			}
		}
		throw new JsonRpcMethodError(-32602, `Unknown tool: ${name}`);
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
				const call = await this._callOwningWindow<IParadisSwitchProfileResult>(ingressLease, request(PARADIS_BROWSER_PROFILE_MCP_SWITCH_METHOD, [profileName, text('tabId')]), signal);
				if (!call.ok) {
					return this._toolError(call.error);
				}
				if (!call.value.ok) {
					return this._toolError(this._profileManageFailureMessage(call.value.reason, profileName));
				}
				const login = call.value.restored ? 'The profile has a stored login.' : 'The profile has no stored login yet, so the page may show logged out.';
				const shared = call.value.bound ? 'It is shared with this terminal pane.' : 'It could NOT be shared with this terminal pane yet - retry with select_browser_tab.';
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
		const pane = this._paneShells.get(token);
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

	private _reserveIngressRequest(token: string, pool: 'default' | 'hook' = 'default'): { dispose(): void } | undefined {
		const byToken = pool === 'hook' ? this._activeHookRequestsByToken : this._activeIngressRequestsByToken;
		const readTotal = () => pool === 'hook' ? this._activeHookRequestCount : this._activeIngressRequestCount;
		const writeTotal = (value: number) => {
			if (pool === 'hook') {
				this._activeHookRequestCount = value;
			} else {
				this._activeIngressRequestCount = value;
			}
		};
		const tokenCount = byToken.get(token) ?? 0;
		if (this._serverDisposed
			|| readTotal() >= MAX_ACTIVE_INGRESS_REQUESTS
			|| tokenCount >= MAX_ACTIVE_INGRESS_REQUESTS_PER_TOKEN) {
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

	private _reserveMobileVoiceIngress(bytes: number): { dispose(): void } | undefined {
		if (this._serverDisposed
			|| this._activeMobileVoiceRequestCount >= MAX_ACTIVE_MOBILE_VOICE_REQUESTS
			|| this._activeMobileVoiceBytes + bytes > MAX_ACTIVE_MOBILE_VOICE_BYTES) {
			return undefined;
		}
		this._activeMobileVoiceRequestCount++;
		this._activeMobileVoiceBytes += bytes;
		let released = false;
		return {
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
		this._activeMobileVoiceRequestCount = 0;
		this._activeMobileVoiceBytes = 0;
		this._mobileVoiceTickets.clear();
		this._runNonThrowingCleanup('devtools-generation-coordinator', () => this._devtoolsGenerationCoordinator.dispose());
		this._runNonThrowingCleanup('file-drop-staging', () => this._fileDropStaging.dispose());
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
		this._backgroundThrottlingDispatcher?.dispose();
		this._backgroundThrottlingDispatcher = undefined;
		this._bindings.clear();
		this._quarantinedBindings.clear();
		this._faultedTokens.clear();
		this._quarantinedTokenState.clear();
		this._paneShells.clear();
		this._paneRemoteAuthorities.clear();
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
