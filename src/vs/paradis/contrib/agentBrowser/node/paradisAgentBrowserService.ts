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
import { createHash, randomUUID } from 'crypto';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isAbsolute, join } from '../../../../base/common/path.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BROWSER_VIEW_SCREENSHOT_ENCODED_SIZE_ERROR_PREFIX } from '../../../../platform/browserView/common/browserViewScreenshot.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { reportParadisDiagnosticError, reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisAbortBindResult, IParadisAgentPaneStatus, IParadisBindingTicketRequest, IParadisCdpInputDispatchResult, IParadisCdpScreenshotOptions, IParadisCommitBindResult, IParadisExactBrowserViewDescriptor, IParadisGatewayEndpoint, IParadisMcpConfigStatus, IParadisMcpFixRequest, IParadisMcpSetupRequest, IParadisMcpSetupResult, IParadisPaneBinding, IParadisPrepareBindRequest, IParadisPrepareBindResult, IParadisPreviewFileResult, IParadisSharedPageInfo, PARADIS_AGENT_BROWSER_CHANNEL, PARADIS_AGENT_PREVIEW_CHANNEL, PARADIS_CDP_TARGET_CHANNEL, PARADIS_MCP_DEFAULT_PORT, PARADIS_MCP_PORT_FILE_NAME, ParadisAgentStatus, paradisNormalizeAgentHookEvent, paradisParseCdpInputDispatchResult, paradisParseExactBrowserViewDescriptor } from '../common/paradisAgentBrowser.js';
import { PARADIS_AGENT_HOOK_MAX_BODY_BYTES } from '../common/paradisAgentHooks.js';
import { IParadisBindingAuthorityManifest, IParadisBindingCommitPreparation, IParadisBindingManifestAcceptance, IParadisBindingOwnedTokenLease, IParadisBindingOwnerRelease, IParadisBindingPrepareSnapshot, ParadisBindingAuthority, ParadisBindingAuthorityStableScope, paradisParseBindingAuthorityManifest } from '../common/paradisBindingAuthority.js';
import { paradisBindingMatchesGeneration } from '../common/paradisBrowserBindingLifecycle.js';
import { paradisShouldSweepStaleWorkingStatus } from '../common/paradisAgentStatusStale.js';
import { IParadisExactViewBackgroundThrottlingEffect, PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS, ParadisExactViewBackgroundThrottlingCoordinator, ParadisExactViewBackgroundThrottlingDispatcher } from '../common/paradisExactViewBackgroundThrottling.js';
import { IParadisMobileRendererManifest, PARADIS_MOBILE_WINDOW_LEASE_CHANNEL } from '../../mobileRelay/common/paradisMobileWindowLease.js';
import { clearParadisAgentPaneActivity, fireParadisAgentHookEvent, fireParadisAgentNestedHookEvent, getParadisAgentPaneActivity, onParadisAgentPaneActivity, onParadisAgentTurnEnded, onParadisAgentTurnStarted, paradisCountLiveBackgroundTasks, paradisSanitizeAgentHookPayload, registerParadisAgentPaneActivityGuard } from './paradisAgentHookBus.js';
import { ParadisAgentHookOwnership } from './paradisAgentHookOwnership.js';
import { paradisCodexHome } from './paradisAgentHome.js';
import { ParadisAgentHooksReconciler } from './paradisAgentHooksSetup.js';
import { createParadisMcpSetupController, ParadisMcpSetupController } from './paradisMcpSetup.js';
import { IParadisMcpPortFileRecord, PARADIS_MCP_HEALTH_PATH, PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION, ParadisMcpPortFileReconciler, writeParadisMcpPortFileAtomic } from './paradisBrowserMcpShimCore.js';
import { ParadisCdpGateway } from './paradisCdpGateway.js';
import { IParadisCdpInputQueueOperation, ParadisCdpInputQueue } from './paradisCdpInputQueue.js';
import { ParadisCdpUpstream } from './paradisCdpUpstream.js';
import { IParadisProxiedTool, ParadisDevtoolsMcpProxy } from './paradisDevtoolsMcpProxy.js';

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
const MAX_ACTIVE_INGRESS_REQUESTS_PER_TOKEN = 8;

interface IParadisPaneStatusEntry {
	readonly status: ParadisAgentStatus;
	readonly changedAt: number;
	readonly cwd?: string;
	/** Stop後のバックグラウンドタスク補正によるworkingだけがstale降格の対象。 */
	readonly backgroundCompletionFallback?: boolean;
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
const NOT_BOUND_MESSAGE = 'このターミナルペインに共有されたブラウザページはありません。Para Code側でブラウザページを開き、コマンドパレットから「Para Code: Share Browser Page with Terminal Pane」を実行してこのペインに共有してください。注意: 共有はPara Codeの再起動（自動アップデート適用を含む）でリセットされるため、以前共有していた場合も再共有が必要です。再共有しても届かない場合は、このCLIをペインで起動し直してから再共有してください（ペインの識別トークンが再起動で変わっている可能性があります）。';

const TOOLS = [
	{
		name: 'get_shared_page',
		description: 'Get the URL and title of the browser page currently shared with this terminal pane in Para Code. Returns an error message if no page is shared yet.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'preview_file',
		description: 'Open a file in the Para Code window that owns this terminal pane, rendered with its rich viewer (Markdown preview, HTML/WebKit rendering, PDF, images, spreadsheets, ...). Use this instead of shell commands like "open" or "xdg-open" when you want to show an HTML/Markdown/other file to the user. Requires an absolute file path.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute path of the file to open (relative paths are rejected because this server does not share your working directory).' },
			},
			required: ['path'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_cdp_endpoint',
		description: 'Get the Chrome DevTools Protocol (CDP) gateway endpoint of Para Code, for connecting an external raw-CDP client such as browser-use. You normally do NOT need this: the chrome-devtools tools (take_snapshot, click, navigate_page, take_screenshot, ...) are built into this MCP server and already target the page shared with this terminal pane. Note: the gateway exposes exactly one shared page, so new_page, resize_page and close_page are not supported (use the emulate tool to change the viewport, and ask the user to open/close pages from Para Code).',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
] as const;

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
const CDP_LIMITATIONS_NOTE = 'The gateway exposes exactly one page (the one shared with this terminal pane). new_page (Target.createTarget) and close_page (Target.closeTarget) are not supported - ask the user to open or close pages from the Para Code UI instead. resize_page is not supported because the embedded browser is laid out by the workbench - use the emulate tool (viewport emulation) instead. Clearing cookies/storage/cache over CDP is blocked because the browser partition is shared across Para Code.';

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
	private readonly _ingressLeaseStates = new WeakMap<IParadisAgentBrowserIngressLease, IParadisBindingOwnedTokenLease>();
	private _nextBindingGeneration = 0;
	/** workbenchから同期される「ペイントークン ⇔ シェルPID」表（CDPゲートウェイの呼び出し元識別用）。 */
	private readonly _paneShells = new Map<string, IPaneShellEntry>();
	/**
	 * MCPリクエスト（またはCDPゲートウェイのPID識別）で実際に接続実績のあったペイントークンの集合。
	 * バインディングダイアログの「MCP未接続」表示に使う（shared processの生存期間のみ保持）。
	 */
	private readonly _seenTokens = new Set<string>();
	/**
	 * エージェントCLIのhook通知 (GET /agent-hook) で更新される、ペインごとの実行状態。
	 * workbench が listPaneStatuses でポーリングし、Workspaces ビューのスピナー表示に使う。
	 */
	private readonly _paneStatuses = new Map<string, IParadisPaneStatusEntry>();
	/** transcript/app-server由来の承認待ちを一度観測したtoken。解除時だけpermissionをworkingへ戻す。 */
	private readonly _activityApprovalTokens = new Set<string>();
	/**
	 * 一度でもエージェントhook (POST /agent-hook) を発火したペイントークンの集合。
	 * 「そのターミナルでエージェントCLIが動いた実績」の判定に使う（プレーンなターミナルと
	 * エージェントペインの区別。モバイルのホーム一覧・Live Activity のフィルタ用）。
	 * idle（Stop確認済み・SessionEnd後）でも消さない: エージェントは次のターンで再開し得る。
	 * ペイン消滅（TerminalExit）でのみ削除する。
	 */
	private readonly _agentHookTokens = new Set<string>();
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
	private _portFileReconciler: ParadisMcpPortFileReconciler | undefined;
	private readonly _serverStartPromise: Promise<void>;
	private _serverDisposed = false;
	private readonly _activeRequestControllers = new Set<AbortController>();
	private readonly _activeIngressRequestsByToken = new Map<string, number>();
	private _activeIngressRequestCount = 0;

	constructor(
		userDataPath: string,
		// ウィンドウ毎のPlaywrightServiceへの橋渡し。read_page廃止（chrome-devtools側の
		// take_snapshot に一本化）以降は未使用だが、sharedProcessMain側の配線を安定させるため維持。
		_playwrightInvoker: IParadisPlaywrightInvoker,
		private readonly ipcServer: IPCServer<string>,
		private readonly mainProcessService: IMainProcessService,
		private readonly logService: ILogService,
		configurationService?: IConfigurationService,
		args?: NativeParsedArgs,
	) {
		super();
		this._portFilePath = join(userDataPath, PARADIS_MCP_PORT_FILE_NAME);
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
			},
			new ParadisCdpUpstream(userDataPath, logService),
			logService,
		));
		this._devtoolsProxy = this._register(new ParadisDevtoolsMcpProxy(RESERVED_TOOL_NAMES, logService));
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
		// エージェントCLI (Claude Code / Codex) の通知hookを冪等に自動設置する
		// (Superset の setupAgentHooks 相当。失敗しても起動は妨げない)。
		const cachedShellEnv = new ParadisCachedShellEnv(
			logService,
			'ParadisAgentHooks',
			createParadisShellEnvResolver(logService, configurationService, args),
			Date.now,
			reportParadisShellEnvDiagnosticError,
		);
		this._mcpSetupController = createParadisMcpSetupController(
			() => cachedShellEnv.getEnv(),
			paradisCodexHome(),
			(message, error) => {
				reportParadisDiagnosticError('owned', 'agent-browser', 'configure-mcp', error ?? new Error(message), { phase: 'setup' });
				this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] ${message}`, error));
			},
		);
		const agentHooksReconciler = this._register(new ParadisAgentHooksReconciler(logService, {}, () => cachedShellEnv.getEnv()));
		void agentHooksReconciler.start().catch(error => {
			reportParadisDiagnosticError('owned', 'agent-browser', 'configure-agent-hooks', error, { phase: 'setup' });
			this._runNonThrowingDiagnostic(() => logService.warn('[ParadisAgentBrowser] Agent hooks setup failed', error));
		});
		this._register(registerParadisAgentPaneActivityGuard(token => this.captureIngressLease(token) !== undefined));
		this._register(onParadisAgentTurnStarted(({ token, cwd, at }) => {
			const ingressLease = this.captureIngressLease(token);
			if (ingressLease === undefined) {
				return;
			}
			if (this.isIngressLeaseCurrent(ingressLease)) {
				this._agentHookTokens.add(token);
				this._paneStatuses.set(token, { status: 'working', changedAt: at, ...(cwd !== undefined ? { cwd } : {}) });
			}
		}));
		// transcript由来のターン終了（Codex の usage limit エラー・中断等、Stop hook が
		// 発火しないケース）を working 状態の解除に反映する。Stop hook と同じく、
		// バックグラウンドタスクが残っていれば working を維持する（stale掃除の対象になる）。
		this._register(onParadisAgentTurnEnded(({ token, at }) => {
			const ingressLease = this.captureIngressLease(token);
			if (ingressLease === undefined) {
				return;
			}
			const entry = this._paneStatuses.get(token);
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
		}));

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
				if (current !== 'question' && current !== 'permission') {
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
			if (existing !== undefined
				&& (existing.windowCtx !== windowCtx || existing.shellPid !== desiredShellPid)) {
				this._paneShells.delete(pane.token);
				this._runNonThrowingCleanup('gateway-connections', () => this._cdpGateway.closeConnectionsForToken(pane.token));
			}
			if (desiredShellPid !== undefined) {
				this._paneShells.set(pane.token, { windowCtx, token: pane.token, shellPid: desiredShellPid });
				// A quarantined token re-entering as a live pane under a different shell PID is a genuinely
				// new binding lifecycle (e.g. the pane was reopened after its window was closed). Lift the
				// isolation so a closed-window quarantine that never receives a TerminalExit can recover.
				this._maybeReleaseQuarantineOnFreshShell(pane.token, desiredShellPid);
			}
		}
		this._processOwnerRelease(acceptance);
		return { accepted: true, revision: acceptance.revision };
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
				const retiringTokens = retiringTokensByPid.get(desiredShellPid);
				if (retiringTokens !== undefined && [...retiringTokens].some(token => token !== pane.token)) {
					// Retirement can be conservatively preserved by an ABA check. Never transfer its
					// PID to another token until a later manifest observes the completed retirement.
					throw new Error('Shell PID retirement is not yet committed');
				}
				projected.set(pane.token, { windowCtx, token: pane.token, shellPid: desiredShellPid });
			}
		}
		const ownersByPid = new Map<number, string>();
		for (const entry of projected.values()) {
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
			if (entry.shellPid !== pid || this.captureIngressLease(entry.token) === undefined) {
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

	private _cleanupTokenLocalState(token: string, generation?: number, preserveTerminalExit: boolean = false): void {
		const cleanupGeneration = generation ?? this._advanceBindingGeneration(token);
		this._paneShells.delete(token);
		this._paneStatuses.delete(token);
		this._activityApprovalTokens.delete(token);
		this._agentHookTokens.delete(token);
		this._seenTokens.delete(token);
		if (!preserveTerminalExit) {
			this._terminalExitedTokens.delete(token);
		}
		this._runNonThrowingCleanup('activity', () => clearParadisAgentPaneActivity(token));
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

	/** サーバー起動完了後に、フォールバックを含む実際のlistenポートだけを返す。 */
	async getGatewayEndpoint(): Promise<IParadisGatewayEndpoint> {
		await this._serverStartPromise;
		const port = this._port;
		if (this._serverDisposed || port === undefined || !Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
			throw new Error('Para Browser gateway is not available.');
		}
		return { port };
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

		let listening = await listen(PARADIS_MCP_DEFAULT_PORT);
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
				const result = await this._dispatch(ingressLease, rpc, controller.signal);
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

	private async _handleAgentHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const requestedToken = this._extractToken(req);
		const ingressLease = requestedToken === undefined ? undefined : this.captureIngressLease(requestedToken);
		if (ingressLease === undefined) {
			this._sendIngressRejected(res);
			return;
		}
		const token = ingressLease.token;

		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const eventType = url.searchParams.get('event') ?? '';
		if (eventType.length > MAX_HOOK_EVENT_LENGTH) {
			res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify({ error: 'Agent hook rejected.' }));
			return;
		}
		const ingressReservation = this._reserveIngressRequest(token);
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
			const toolInput = hookPayload?.['tool_input'];
			const toolUseId = stringField('tool_use_id');
			const messageId = stringField('message_id');
			const messageDelta = stringField('delta');
			const indexValue = hookPayload?.['index'];
			const messageIndex = typeof indexValue === 'number' && Number.isSafeInteger(indexValue) && indexValue >= 0 ? indexValue : undefined;
			const finalValue = hookPayload?.['final'];
			const messageFinal = typeof finalValue === 'boolean' ? finalValue : undefined;
			if (controller.signal.aborted) {
				return;
			}
			if (!this.isIngressLeaseCurrent(ingressLease)) {
				this._sendIngressRejected(res);
				return;
			}
			// 発信元プロセスの所有権分類。ペイントークンはターミナル配下の全子プロセスへ
			// 継承されるため、所有エージェントの配下で動く別エージェント（例: plugin 経由の
			// `codex exec`）のhookをここで仕分けないと、ペインのセッションrebind・状態・通知の
			// すべてが子に乗っ取られる。分類は状態更新とhookバス発火のどちらよりも前に行う。
			if (eventType === 'TerminalExit') {
				this._hookOwnership.clear(token);
			} else if (eventType) {
				const pidParam = url.searchParams.get('pid');
				const hookPid = pidParam !== null && /^\d{1,10}$/.test(pidParam) ? Number.parseInt(pidParam, 10) : undefined;
				const hookOrigin = await this._hookOwnership.classify({ token, hookPid, transcriptPath, at: Date.now() });
				if (controller.signal.aborted) {
					return;
				}
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
						at: Date.now(), nestedAgent: hookOrigin.agentKind,
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
				} else {
					this._agentHookTokens.add(token);
				}
				fireParadisAgentHookEvent({
					token, event: eventType, sessionId, transcriptPath, cwd, toolName, toolInput,
					toolUseId, messageId, messageDelta, messageIndex, messageFinal, payload: hookPayload, at: Date.now(),
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
			if ((normalized === 'working' || normalized === 'permission') && activity.pendingQuestion) {
				normalized = 'question';
			} else if ((normalized === 'working' || normalized === 'question') && activity.pendingApproval) {
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
			.map(([token, entry]) => ({ token, status: entry.status, changedAt: entry.changedAt, ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}) }));
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
		return this._mcpSetupController.setup(request.cli);
	}

	/** バインディングダイアログ「MCP接続設定」タブ表示用のステータス判定（実設定ファイルを読む）。 */
	async getMcpConfigStatus(): Promise<IParadisMcpConfigStatus> {
		if (this._serverDisposed) {
			throw new Error('Para Browser protocol rejected');
		}
		return this._mcpSetupController.status(await this._currentGatewayPort());
	}

	/** 「ワンクリックで修正」/「自動セットアップ」。codexの古いポート決め打ちをshim方式へ書き換える。 */
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

	private async _dispatch(ingressLease: IParadisAgentBrowserIngressLease, rpc: IJsonRpcRequest, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		switch (rpc.method) {
			case 'initialize': {
				const params = rpc.params as { protocolVersion?: unknown } | undefined;
				const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
				return {
					protocolVersion: requested,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'para-code-agent-browser', version: '1.0.0' },
				};
			}
			case 'ping':
				return {};
			case 'tools/list': {
				// para固有ツール＋内蔵chrome-devtools-mcpのツール（子プロセスが起動できない場合は
				// para固有ツールのみに縮退し、一覧自体は失敗させない）
				const tools = await this._listDevtoolsTools(ingressLease, signal);
				this._requireIngressLease(ingressLease);
				return { tools: [...TOOLS, ...tools] };
			}
			case 'tools/call':
				return this._callTool(ingressLease, rpc.params as { name?: unknown; arguments?: unknown } | undefined, signal);
			default:
				throw new JsonRpcMethodError(-32601, `Method not found: ${rpc.method}`);
		}
	}

	private async _callTool(ingressLease: IParadisAgentBrowserIngressLease, params: { name?: unknown; arguments?: unknown } | undefined, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		const token = ingressLease.token;
		const name = typeof params?.name === 'string' ? params.name : undefined;
		if (!name) {
			throw new JsonRpcMethodError(-32602, `Unknown tool: ${String(name)}`);
		}
		if (!TOOLS.some(t => t.name === name)) {
			// para固有ツールでなければ、内蔵chrome-devtools-mcpへの転送を試みる
			return this._callDevtoolsTool(ingressLease, name, params?.arguments, signal);
		}

		if (name === 'preview_file') {
			const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : undefined;
			const path = typeof toolArgs?.path === 'string' ? toolArgs.path : undefined;
			return this._previewFile(ingressLease, path, signal);
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
			default:
				throw new JsonRpcMethodError(-32602, `Unknown tool: ${name}`);
		}
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
					return result;
				}
			}
			throw new JsonRpcMethodError(-32602, `Unknown tool: ${name}`);
		});
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
	 */
	private async _previewFile(ingressLease: IParadisAgentBrowserIngressLease, path: string | undefined, signal?: AbortSignal): Promise<unknown> {
		this._requireIngressLease(ingressLease);
		const token = ingressLease.token;
		if (!path || !isAbsolute(path)) {
			return this._toolError(`preview_file requires an absolute file path (got: ${String(path)}). Resolve the path against your working directory first.`);
		}
		const pane = this._paneShells.get(token);
		if (!pane) {
			return this._toolError('Para Code could not identify the window that owns this terminal pane (the pane may have just been created, or Para Code was restarted after this CLI started). Retry in a few seconds; if it keeps failing, re-launch this CLI in a terminal pane inside Para Code.');
		}
		// getChannel の ctx フィルタは「接続が現れるまで待つ」ため、ウィンドウが既に閉じて
		// いると永久に解決しない。先に接続の存在を確認し、呼び出し自体にもタイムアウトを張る。
		if (!this.ipcServer.connections.some(connection => connection.ctx === pane.windowCtx)) {
			return this._toolError('The Para Code window that owns this terminal pane is not connected (it may have been closed or is reloading). Retry in a few seconds.');
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			const channel = this.ipcServer.getChannel(PARADIS_AGENT_PREVIEW_CHANNEL, client => client.ctx === pane.windowCtx);
			const aborted = new Promise<never>((_, reject) => {
				onAbort = () => reject(new ParadisIngressLeaseError());
				if (signal?.aborted) {
					onAbort();
				} else {
					signal?.addEventListener('abort', onAbort, { once: true });
				}
			});
			const result = await Promise.race([
				channel.call<IParadisPreviewFileResult>('previewFile', [path]),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out after 10s')), 10000); }),
				aborted,
			]);
			this._requireIngressLease(ingressLease);
			if (!result.ok) {
				return this._toolError('Failed to open the file in Para Code.');
			}
			return this._toolText(`Opened ${path} in the Para Code window that owns this terminal pane.`);
		} catch (error) {
			if (error instanceof ParadisIngressLeaseError || !this.isIngressLeaseCurrent(ingressLease)) {
				throw new ParadisIngressLeaseError();
			}
			this._runNonThrowingDiagnostic(() => this.logService.warn(`[ParadisAgentBrowser] preview_file failed for pane ${this._tokenFingerprint(token)}`, error));
			return this._toolError('Failed to open the file in Para Code.');
		} finally {
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

	private _reserveIngressRequest(token: string): { dispose(): void } | undefined {
		const tokenCount = this._activeIngressRequestsByToken.get(token) ?? 0;
		if (this._serverDisposed
			|| this._activeIngressRequestCount >= MAX_ACTIVE_INGRESS_REQUESTS
			|| tokenCount >= MAX_ACTIVE_INGRESS_REQUESTS_PER_TOKEN) {
			return undefined;
		}
		this._activeIngressRequestCount++;
		this._activeIngressRequestsByToken.set(token, tokenCount + 1);
		let released = false;
		return {
			dispose: () => {
				if (released) {
					return;
				}
				released = true;
				this._activeIngressRequestCount = Math.max(0, this._activeIngressRequestCount - 1);
				const current = this._activeIngressRequestsByToken.get(token);
				if (current === undefined || current <= 1) {
					this._activeIngressRequestsByToken.delete(token);
				} else {
					this._activeIngressRequestsByToken.set(token, current - 1);
				}
			},
		};
	}

	private _readBody(req: http.IncomingMessage, signal?: AbortSignal): Promise<string> {
		return new Promise<string>((resolve, reject) => {
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
				if (size > MAX_BODY_BYTES) {
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
				resolve(Buffer.concat(chunks, size).toString('utf8'));
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
		this._runNonThrowingCleanup('devtools-generation-coordinator', () => this._devtoolsGenerationCoordinator.dispose());
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
		this._paneStatuses.clear();
		this._activityApprovalTokens.clear();
		this._agentHookTokens.clear();
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
