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
import { spawn } from 'child_process';
import { promises as fs, unlinkSync } from 'fs';
import { homedir } from 'os';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isAbsolute, join } from '../../../../base/common/path.js';
import { IPCServer } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { IParadisAgentPaneStatus, IParadisCdpScreenshotOptions, IParadisMcpSetupRequest, IParadisMcpSetupResult, IParadisMcpSetupServerResult, IParadisPaneBinding, IParadisPreviewFileResult, IParadisSharedPageInfo, PARADIS_AGENT_PREVIEW_CHANNEL, PARADIS_CDP_TARGET_CHANNEL, PARADIS_MCP_DEFAULT_PORT, PARADIS_MCP_PORT_FILE_ENV_VAR, PARADIS_MCP_PORT_FILE_NAME, PARADIS_PANE_TOKEN_ENV_VAR, ParadisAgentStatus, paradisNormalizeAgentHookEvent } from '../common/paradisAgentBrowser.js';
import { paradisShouldSweepStaleWorkingStatus } from '../common/paradisAgentStatusStale.js';
import { fireParadisAgentHookEvent, getParadisAgentPaneActivity, onParadisAgentPaneActivity, onParadisAgentTurnEnded, paradisCountLiveBackgroundTasks } from './paradisAgentHookBus.js';
import { paradisSetupAgentHooks } from './paradisAgentHooksSetup.js';
import { ParadisCdpGateway } from './paradisCdpGateway.js';
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
	/** バインドされた時刻（epoch ms）。 */
	readonly boundAt: number;
	/** バインド済みページのChromium DevTools targetId（electron-mainへの問い合わせ結果のキャッシュ）。 */
	cdpTargetId?: string;
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

const MAX_BODY_BYTES = 4 * 1024 * 1024;

interface IParadisPaneStatusEntry {
	readonly status: ParadisAgentStatus;
	readonly changedAt: number;
	readonly cwd?: string;
	/** Stop後のバックグラウンドタスク補正によるworkingだけがstale降格の対象。 */
	readonly backgroundCompletionFallback?: boolean;
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

/**
 * バインディングレジストリ + MCP HTTPサーバー + CDPゲートウェイ。
 * `127.0.0.1` の固定既定ポート（{@link PARADIS_MCP_DEFAULT_PORT}、専有時のみ動的フォールバック）で
 * listenし、`<userDataDir>/paradis-browser-mcp.json` に `{ port, pid }` を書き出す（dispose時に削除）。
 */
export class ParadisAgentBrowserService extends Disposable {

	private readonly _bindings = new Map<string, IBindingEntry>();
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
	/**
	 * 一度でもエージェントhook (POST /agent-hook) を発火したペイントークンの集合。
	 * 「そのターミナルでエージェントCLIが動いた実績」の判定に使う（プレーンなターミナルと
	 * エージェントペインの区別。モバイルのホーム一覧・Live Activity のフィルタ用）。
	 * idle（Stop確認済み・SessionEnd後）でも消さない: エージェントは次のターンで再開し得る。
	 * ペイン消滅（TerminalExit）でのみ削除する。
	 */
	private readonly _agentHookTokens = new Set<string>();
	private readonly _portFilePath: string;
	private readonly _cdpGateway: ParadisCdpGateway;
	/** vendored chrome-devtools-mcp をペイン毎の子プロセスとして管理するプロキシ。 */
	private readonly _devtoolsProxy: ParadisDevtoolsMcpProxy;
	private _httpServer: http.Server | undefined;
	private _port: number | undefined;

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
				getBoundTargetId: token => this._bindings.get(token)?.cdpTargetId,
				ensureBoundTargetId: token => this._ensureBoundTargetId(token),
				getTokenForShellPid: pid => {
					for (const entry of this._paneShells.values()) {
						if (entry.shellPid === pid) {
							// CDPゲートウェイがPID経由で呼び出し元ペインを識別できた＝接続実績あり。
							this._seenTokens.add(entry.token);
							return entry.token;
						}
					}
					return undefined;
				},
				captureBoundPageScreenshot: (token, options) => this._captureBoundPageScreenshot(token, options),
				focusBoundPage: token => this._focusBoundPage(token),
			},
			new ParadisCdpUpstream(userDataPath, logService),
			logService,
		));
		this._devtoolsProxy = this._register(new ParadisDevtoolsMcpProxy(RESERVED_TOOL_NAMES, logService));
		// ウィンドウ切断（リロード・クローズ）時はページ共有（tracked pages）も失われるため、
		// そのウィンドウ由来のバインディングをまとめて破棄して整合させる。
		this._register(ipcServer.onDidRemoveConnection(connection => this.removeBindingsForWindow(connection.ctx)));
		void this._startServer();
		// エージェントCLI (Claude Code / Codex) の通知hookを冪等に自動設置する
		// (Superset の setupAgentHooks 相当。失敗しても起動は妨げない)。
		const cachedShellEnv = new ParadisCachedShellEnv(
			logService,
			'ParadisAgentHooks',
			createParadisShellEnvResolver(logService, configurationService, args),
		);
		paradisSetupAgentHooks(logService, () => cachedShellEnv.getEnv()).catch(error => logService.warn('[ParadisAgentBrowser] Agent hooks setup failed', error));
		// transcript由来のターン終了（Codex の usage limit エラー・中断等、Stop hook が
		// 発火しないケース）を working 状態の解除に反映する。Stop hook と同じく、
		// バックグラウンドタスクが残っていれば working を維持する（stale掃除の対象になる）。
		this._register(onParadisAgentTurnEnded(({ token, at }) => {
			const entry = this._paneStatuses.get(token);
			if (entry === undefined || entry.status !== 'working') {
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
			const entry = this._paneStatuses.get(token);
			const current = entry?.status;
			// hookが報告済みのcwd (スコープ解決フォールバック用) は補正更新でも維持する
			const cwd = entry?.cwd;
			if (activity.pendingQuestion) {
				if (current !== 'question' && current !== 'permission') {
					this._paneStatuses.set(token, { status: 'question', changedAt: Date.now(), ...(cwd !== undefined ? { cwd } : {}) });
				}
				return; // 質問への回答待ちが最優先。バックグラウンドタスク補正で上書きさせない
			}
			if (current === 'question') {
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

	async bind(windowCtx: string, token: string, pageId: string, pageInfo: IParadisSharedPageInfo): Promise<void> {
		const previous = this._bindings.get(token);
		this._bindings.set(token, { windowCtx, pageId, pageInfo, boundAt: Date.now() });
		this.logService.debug(`[ParadisAgentBrowser] Bound pane ${token} -> page ${pageId} (${pageInfo.url}) in ${windowCtx}`);
		// 既存のCDP接続は古いページのスコープスナップショットを持つため強制切断する
		// （クライアントは次のツール呼び出しで再接続し、新しいバインドを拾う）。
		this._cdpGateway.closeConnectionsForToken(token);
		// targetIdを先行解決してキャッシュを温める（ゲートウェイの同期クロージャ用）。
		void this._ensureBoundTargetId(token);
		// バインド中は backgroundThrottling を無効化する（非表示状態でも rAF/タイマーが
		// 抑制されず、MCPの navigate / wait_for が停滞しない。Superset知見の移植）。
		// 同じペインの旧バインドページは、他のペインからも参照されていなければ既定へ戻す。
		this._setBackgroundThrottling(pageId, false);
		if (previous && previous.pageId !== pageId && !this._isPageBound(previous.pageId)) {
			this._setBackgroundThrottling(previous.pageId, true);
		}
	}

	async unbind(token: string): Promise<void> {
		const entry = this._bindings.get(token);
		if (this._bindings.delete(token)) {
			this.logService.debug(`[ParadisAgentBrowser] Unbound pane ${token}`);
			this._cdpGateway.closeConnectionsForToken(token);
			// 他のペインからも参照されていなければ backgroundThrottling をElectron既定（true）へ戻す
			if (entry && !this._isPageBound(entry.pageId)) {
				this._setBackgroundThrottling(entry.pageId, true);
			}
		}
	}

	/**
	 * workbenchウィンドウから「ペイントークン ⇔ シェルPID」の対応表を同期する
	 * （ウィンドウ単位で全置換）。CDPゲートウェイが接続元PIDの祖先チェーンと突合して
	 * 呼び出し元ペインを識別するために使う（env読み取り不可のWindowsでは主経路）。
	 */
	async syncPaneShells(windowCtx: string, entries: readonly { token: string; shellPid: number }[]): Promise<void> {
		const nextTokens = new Set<string>();
		for (const entry of entries) {
			if (typeof entry.token === 'string' && typeof entry.shellPid === 'number' && entry.shellPid > 0) {
				nextTokens.add(entry.token);
			}
		}
		for (const [token, entry] of [...this._paneShells]) {
			if (entry.windowCtx === windowCtx) {
				this._paneShells.delete(token);
				// 同ウィンドウの全置換で消えた＝そのペインが閉じられた。まだバインド中でなければ
				// (アクティブなCDP接続を巻き込まないため) 実行状態などトークン別エントリを掃除する。
				if (!nextTokens.has(token) && !this._bindings.has(token)) {
					this._retirePaneToken(token);
				}
			}
		}
		for (const entry of entries) {
			if (typeof entry.token === 'string' && typeof entry.shellPid === 'number' && entry.shellPid > 0) {
				this._paneShells.set(entry.token, { windowCtx, token: entry.token, shellPid: entry.shellPid });
			}
		}
	}

	async listBindings(windowCtx: string): Promise<IParadisPaneBinding[]> {
		const result: IParadisPaneBinding[] = [];
		for (const [token, entry] of this._bindings) {
			if (entry.windowCtx === windowCtx) {
				result.push({ token, pageId: entry.pageId, pageInfo: entry.pageInfo, boundAt: entry.boundAt });
			}
		}
		return result;
	}

	/**
	 * MCP/CDP経由で接続実績のあるペイントークンの一覧を返す。
	 * トークンはウィンドウをまたいで一意（UUID）なので、windowCtxでの絞り込みは行わない。
	 */
	async listSeenTokens(): Promise<string[]> {
		return [...this._seenTokens];
	}

	/** ウィンドウ切断時に、そのウィンドウのバインディングとシェルPID表をまとめて破棄する。 */
	removeBindingsForWindow(windowCtx: string): void {
		const removedPageIds = new Set<string>();
		const windowTokens = new Set<string>();
		for (const [token, entry] of [...this._bindings]) {
			if (entry.windowCtx === windowCtx) {
				this._bindings.delete(token);
				this._cdpGateway.closeConnectionsForToken(token);
				removedPageIds.add(entry.pageId);
				windowTokens.add(token);
			}
		}
		// バインドが完全に消えたページは backgroundThrottling を既定へ戻す
		// （ウィンドウリロード時はビュー自体も破棄されるため、単にno-opになる）
		for (const pageId of removedPageIds) {
			if (!this._isPageBound(pageId)) {
				this._setBackgroundThrottling(pageId, true);
			}
		}
		for (const [token, entry] of [...this._paneShells]) {
			if (entry.windowCtx === windowCtx) {
				this._paneShells.delete(token);
				windowTokens.add(token);
			}
		}
		// ウィンドウが消えた＝そのペインのトークン（ペインごとに一意なUUIDで再利用されない）は
		// 二度と現れない。実行状態・接続実績・CDPの飾りIDのトークン別エントリを掃除して、
		// shared process の生存期間を通じた単調リークを防ぐ。
		for (const token of windowTokens) {
			this._retirePaneToken(token);
		}
	}

	/**
	 * ペイン/ウィンドウ終了で二度と使われないトークンのトークン別エントリを掃除する。
	 * hook 由来の実行状態・接続実績・CDPゲートウェイのトークン別キャッシュをまとめて落とす。
	 */
	private _retirePaneToken(token: string): void {
		this._paneStatuses.delete(token);
		this._seenTokens.delete(token);
		this._cdpGateway.retireToken(token);
		this._devtoolsProxy.retire(token);
	}

	/**
	 * バインド済みページのDevTools targetIdを解決して返す（キャッシュ付き）。
	 * 解決はelectron-mainの {@link PARADIS_CDP_TARGET_CHANNEL} チャネル経由で行う。
	 */
	private async _ensureBoundTargetId(token: string): Promise<string | undefined> {
		const binding = this._bindings.get(token);
		if (!binding) {
			return undefined;
		}
		if (binding.cdpTargetId) {
			return binding.cdpTargetId;
		}
		try {
			const targetId = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<string | null>('resolveTargetId', [binding.pageId]);
			const current = this._bindings.get(token);
			if (targetId && current === binding) {
				current.cdpTargetId = targetId;
			}
			return targetId ?? undefined;
		} catch (error) {
			this.logService.warn(`[ParadisAgentBrowser] Failed to resolve CDP targetId for page ${binding.pageId}`, error);
			return undefined;
		}
	}

	/**
	 * CDPゲートウェイからの `Page.captureScreenshot` 委譲。electron-mainの
	 * {@link PARADIS_CDP_TARGET_CHANNEL} 経由でupstream実装（非表示時の回避策付き）を呼び、
	 * base64画像データを返す。失敗時はundefined（ゲートウェイが上流へフォールバックする）。
	 */
	private async _captureBoundPageScreenshot(token: string, options: IParadisCdpScreenshotOptions): Promise<string | undefined> {
		const binding = this._bindings.get(token);
		if (!binding) {
			return undefined;
		}
		try {
			const data = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<string | null>('captureScreenshot', [binding.pageId, options]);
			return data ?? undefined;
		} catch (error) {
			this.logService.warn(`[ParadisAgentBrowser] Delegated screenshot failed for page ${binding.pageId}`, error);
			return undefined;
		}
	}

	/** CDPゲートウェイからの `Input.*` 直前フォーカス強制（fire-and-forget、失敗は握りつぶす）。 */
	private _focusBoundPage(token: string): void {
		const binding = this._bindings.get(token);
		if (!binding) {
			return;
		}
		this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
			.call('focusView', [binding.pageId])
			.then(undefined, () => undefined);
	}

	/** 指定ページがいずれかのペインにバインドされているか。 */
	private _isPageBound(pageId: string): boolean {
		for (const entry of this._bindings.values()) {
			if (entry.pageId === pageId) {
				return true;
			}
		}
		return false;
	}

	/** バインド済みページの backgroundThrottling 切り替え（fire-and-forget）。 */
	private _setBackgroundThrottling(pageId: string, enabled: boolean): void {
		this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
			.call('setBackgroundThrottling', [pageId, enabled])
			.then(undefined, error => this.logService.debug(`[ParadisAgentBrowser] setBackgroundThrottling(${enabled}) failed for page ${pageId}`, error));
	}

	// --- MCP HTTPサーバー ---

	private async _startServer(): Promise<void> {
		const { createServer } = await import('http');
		if (this._store.isDisposed) {
			return;
		}
		const server = createServer((req, res) => {
			this._handleRequest(req, res).catch(error => {
				this.logService.error('[ParadisAgentBrowser] Unhandled error in HTTP handler', error);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
				}
				res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
			});
		});
		// CDPゲートウェイのWebSocket upgrade（/cdp/devtools/* および /devtools/*）
		server.on('upgrade', (req, socket, head) => {
			void this._cdpGateway.handleUpgrade(req, socket, head);
		});
		this._httpServer = server;

		// 固定既定ポートを第一候補にする（`PARA_CODE_CDP_URL` が再起動を跨いで同一文字列に
		// なることが要件）。専有時のみ動的ポートへフォールバックし、警告を残す。
		// ポートファイルには常に実ポートが書かれるため、stdioシム経路には影響しない。
		const listen = (port: number) => new Promise<boolean>(resolve => {
			const onError = (error: NodeJS.ErrnoException) => {
				server.removeListener('listening', onListening);
				this.logService.warn(`[ParadisAgentBrowser] Failed to listen on 127.0.0.1:${port}: ${error.code ?? error.message}`);
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
			this.logService.warn(`[ParadisAgentBrowser] Default port ${PARADIS_MCP_DEFAULT_PORT} is in use. Falling back to a dynamic port — the PARA_CODE_CDP_URL injected into terminals will be stale; use the get_cdp_endpoint MCP tool (or the port file) for the live URL.`);
			listening = await listen(0);
		}
		if (!listening) {
			this.logService.error('[ParadisAgentBrowser] Failed to start MCP server (no port available)');
			this._httpServer = undefined;
			return;
		}

		const address = this._httpServer.address();
		if (!address || typeof address === 'string') {
			this.logService.error('[ParadisAgentBrowser] Unexpected server address', String(address));
			return;
		}
		this._port = address.port;

		try {
			await fs.writeFile(this._portFilePath, JSON.stringify({ port: this._port, pid: process.pid }));
			this.logService.info(`[ParadisAgentBrowser] MCP server listening on 127.0.0.1:${this._port} (port file: ${this._portFilePath})`);
		} catch (error) {
			this.logService.error('[ParadisAgentBrowser] Failed to write MCP port file', error);
		}
	}

	private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

		const token = this._extractToken(req);
		if (!token) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing pane token. Provide it via "Authorization: Bearer <token>" or the "?pane=<token>" query parameter.' }));
			return;
		}
		// MCPリクエストが届いた＝このペインのエージェントCLIはMCP接続済み（listSeenTokens用）。
		this._seenTokens.add(token);

		let body: string;
		try {
			body = await this._readBody(req);
		} catch (error) {
			res.writeHead(413, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: String(error) }));
			return;
		}

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
			res.writeHead(202);
			res.end();
			return;
		}

		try {
			const result = await this._dispatch(token, rpc);
			this._sendJsonRpc(res, { jsonrpc: '2.0', id: rpc.id, result });
		} catch (error) {
			if (error instanceof JsonRpcMethodError) {
				this._sendJsonRpc(res, { jsonrpc: '2.0', id: rpc.id, error: { code: error.code, message: error.message } });
			} else {
				this._sendJsonRpc(res, { jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` } });
			}
		}
	}

	private async _handleAgentHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const token = this._extractToken(req);
		if (!token) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing pane token. Provide it via the "?pane=<token>" query parameter.' }));
			return;
		}

		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const eventType = url.searchParams.get('event') ?? '';

		// v2スクリプトのPOST body (hook stdin JSON) から session_id / transcript_path / cwd を
		// 抽出してhookバスへ流す (モバイルのエージェントチャットミラー用)。パース失敗や
		// 旧v1のGETでは undefined のまま流す (イベント名だけでも購読側の用途がある)。
		let sessionId: string | undefined;
		let transcriptPath: string | undefined;
		let cwd: string | undefined;
		let hookMessage: string | undefined;
		let toolName: string | undefined;
		let toolInput: unknown;
		let toolUseId: string | undefined;
		let messageId: string | undefined;
		let messageDelta: string | undefined;
		let messageIndex: number | undefined;
		let messageFinal: boolean | undefined;
		if (req.method === 'POST') {
			try {
				const body = await this._readBody(req);
				const parsed: unknown = JSON.parse(body);
				if (parsed && typeof parsed === 'object') {
					const record = parsed as Record<string, unknown>;
					sessionId = typeof record['session_id'] === 'string' ? record['session_id'] : undefined;
					transcriptPath = typeof record['transcript_path'] === 'string' ? record['transcript_path'] : undefined;
					cwd = typeof record['cwd'] === 'string' ? record['cwd'] : undefined;
					// Notification イベントの本文 (許可要求かアイドル通知かの判別に使う)
					hookMessage = typeof record['message'] === 'string' ? record['message'] : undefined;
					// PreToolUse / PostToolUse のツール情報 (AskUserQuestion のライブ質問検出に使う)
					toolName = typeof record['tool_name'] === 'string' ? record['tool_name'] : undefined;
					toolInput = record['tool_input'];
					toolUseId = typeof record['tool_use_id'] === 'string' ? record['tool_use_id'] : undefined;
					// Claude Code MessageDisplay (2.1.205+): 生成中に完成した行だけをdeltaで渡す。
					messageId = typeof record['message_id'] === 'string' ? record['message_id'] : undefined;
					messageDelta = typeof record['delta'] === 'string' ? record['delta'] : undefined;
					messageIndex = typeof record['index'] === 'number' ? record['index'] : undefined;
					messageFinal = typeof record['final'] === 'boolean' ? record['final'] : undefined;
				}
			} catch {
				// bodyの欠落・壊れたJSONは無視する (イベント名ベースの状態更新は継続)
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
				toolUseId, messageId, messageDelta, messageIndex, messageFinal, at: Date.now(),
			});
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
			res.end(JSON.stringify({ ok: false, reason: `ignored event: ${eventType}` }));
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
		this.logService.trace(`[ParadisAgentBrowser] agent-hook: ${eventType} -> ${normalized}`);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true }));
	}

	/**
	 * Stop の review がバックグラウンドタスク補正で working になった状態だけを、一定時間後に
	 * reviewへ降格する。通常のPreToolUse→PostToolUse間や長い推論は途中hookが無いため、単に
	 * workingの更新時刻だけを見ると正常な長時間処理を完了扱いにしてしまう。
	 */
	private _sweepStalePaneStatuses(): void {
		const now = Date.now();
		for (const [token, entry] of this._paneStatuses) {
			if (paradisShouldSweepStaleWorkingStatus(entry.status, entry.backgroundCompletionFallback, entry.changedAt, now)) {
				this._paneStatuses.set(token, { status: 'review', changedAt: now, ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}) });
			}
		}
	}

	/** workbench のポーリング用: エージェントhookの発火実績があるペイントークン一覧 */
	async listAgentHookTokens(): Promise<string[]> {
		return [...this._agentHookTokens];
	}

	/**
	 * ターミナルのシェルプロセス終了を workbench から通知する（renderer の instance.onExit 起点）。
	 * エージェントCLIはクラッシュ・強制終了時に Stop/SessionEnd hook を発火できないため、
	 * ここで実行状態と実績を掃除し、hookバスへ TerminalExit を流してチャットミラーの
	 * ライブ状態（考え中表示）も解除する。
	 */
	async notifyTerminalExit(token: string): Promise<void> {
		this._agentHookTokens.delete(token);
		this._paneStatuses.delete(token);
		fireParadisAgentHookEvent({ token, event: 'TerminalExit', sessionId: undefined, transcriptPath: undefined, cwd: undefined, at: Date.now() });
	}

	/** workbench のポーリング用: 現在のペイン実行状態一覧 */
	async listPaneStatuses(): Promise<IParadisAgentPaneStatus[]> {
		this._sweepStalePaneStatuses();
		return [...this._paneStatuses].map(([token, entry]) => ({ token, status: entry.status, changedAt: entry.changedAt, ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}) }));
	}

	/** review 状態の確認遷移 (スコープを開いた時に workbench から呼ばれる) */
	async acknowledgePaneStatus(token: string): Promise<void> {
		const entry = this._paneStatuses.get(token);
		if (entry && entry.status === 'review') {
			this._paneStatuses.delete(token);
		}
	}

	// --- ワンボタンMCPセットアップ（バインディングダイアログの「自動セットアップ」から呼ばれる） ---

	/**
	 * ユーザーレベル（-s user / ~/.codex/config.toml）にpara-browserとchrome-devtoolsのMCPを登録する。
	 * Claudeは `claude mcp add` をログインシェル経由で実行（GUIアプリのPATH問題回避）、
	 * Codexは config.toml へセクション追記（既存セクションはスキップ）。
	 */
	async setupMcp(request: IParadisMcpSetupRequest): Promise<IParadisMcpSetupResult> {
		if (request.cli === 'claude') {
			return this._setupClaudeMcp(request);
		}
		return this._setupCodexMcp(request);
	}

	private async _setupClaudeMcp(request: IParadisMcpSetupRequest): Promise<IParadisMcpSetupResult> {
		// claude がPATH上にあるか確認（無ければ手動セットアップへ誘導させる）。
		const probeCommand = process.platform === 'win32' ? 'where claude' : 'command -v claude';
		const probe = await this._runLoginShellCommand(probeCommand);
		if (probe.code !== 0) {
			return { cli: 'claude', cliAvailable: false, servers: [] };
		}

		const shimArg = `"${request.shimPath}"`;
		// chrome-devtools系ツールはpara-browserサーバーに内蔵済み（vendored chrome-devtools-mcpを
		// ペイン毎の子プロセスとしてプロキシ）のため、登録するのは para-browser 1エントリのみ。
		const commands: { readonly server: string; readonly command: string }[] = [
			{ server: 'para-browser', command: `claude mcp add -s user para-browser -- node ${shimArg}` },
		];

		const servers: IParadisMcpSetupServerResult[] = [];
		for (const { server, command } of commands) {
			const { code, output } = await this._runLoginShellCommand(command);
			if (code === 0) {
				servers.push({ server, outcome: 'success' });
			} else if (/already exists/i.test(output)) {
				servers.push({ server, outcome: 'already' });
			} else {
				servers.push({ server, outcome: 'error', detail: output.trim().slice(0, 500) || `exit code ${code}` });
			}
		}
		return { cli: 'claude', cliAvailable: true, servers };
	}

	private async _setupCodexMcp(request: IParadisMcpSetupRequest): Promise<IParadisMcpSetupResult> {
		const configDir = join(homedir(), '.codex');
		const configPath = join(configDir, 'config.toml');

		let existing = '';
		try {
			existing = await fs.readFile(configPath, 'utf8');
		} catch {
			existing = '';
		}
		// TOMLの完全パースはせず、`[mcp_servers.<name>]` のセクション見出し行の存在だけで判定する。
		const hasSection = (name: string) => existing.split(/\r?\n/).some(line => line.trim() === `[mcp_servers.${name}]`);

		// TOML basic string ではバックスラッシュがエスケープ扱いになるため、Windowsパスを考慮して二重化する。
		// chrome-devtools系ツールはpara-browserサーバーに内蔵済みのため、セクションは para-browser のみ。
		const shimPathToml = request.shimPath.replace(/\\/g, '\\\\');
		const sections: { readonly server: string; readonly text: string }[] = [
			{
				server: 'para-browser',
				text: [
					'[mcp_servers.para-browser]',
					'command = "node"',
					`args = ["${shimPathToml}"]`,
					`env_vars = ["${PARADIS_PANE_TOKEN_ENV_VAR}", "${PARADIS_MCP_PORT_FILE_ENV_VAR}"]`,
				].join('\n'),
			},
		];

		const plan = sections.map(section => ({ ...section, present: hasSection(section.server) }));
		const toAppend = plan.filter(entry => !entry.present);

		let writeError: string | undefined;
		if (toAppend.length > 0) {
			try {
				await fs.mkdir(configDir, { recursive: true });
				let content = existing;
				if (content.length > 0 && !content.endsWith('\n')) {
					content += '\n';
				}
				if (content.length > 0) {
					content += '\n';
				}
				content += toAppend.map(entry => entry.text).join('\n\n') + '\n';
				await fs.writeFile(configPath, content);
			} catch (error) {
				writeError = error instanceof Error ? error.message : String(error);
			}
		}

		const servers: IParadisMcpSetupServerResult[] = plan.map(entry => {
			if (entry.present) {
				return { server: entry.server, outcome: 'already' };
			}
			if (writeError !== undefined) {
				return { server: entry.server, outcome: 'error', detail: writeError };
			}
			return { server: entry.server, outcome: 'success' };
		});
		return { cli: 'codex', cliAvailable: true, target: configPath, servers };
	}

	/**
	 * コマンドをログインインタラクティブシェル（`/bin/zsh -lic ...`、Windowsは `cmd /c`）で実行し、
	 * 標準出力+標準エラーを結合して返す。ログインシェル経由にすることで、GUIアプリ由来の
	 * shared processでも `claude`/`npx` 等のPATHが正しく解決される。
	 */
	private _runLoginShellCommand(command: string, timeoutMs = 30000): Promise<{ code: number; output: string }> {
		return new Promise<{ code: number; output: string }>(resolve => {
			const isWindows = process.platform === 'win32';
			const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/zsh');
			const args = isWindows ? ['/c', command] : ['-lic', command];

			let output = '';
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (code: number) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				resolve({ code, output });
			};

			try {
				const child = spawn(shell, args, { env: process.env });
				timer = setTimeout(() => {
					output += `\n[para-browser-mcp] command timed out after ${timeoutMs}ms`;
					try {
						child.kill();
					} catch {
						// 既に終了している場合は無視
					}
					finish(124);
				}, timeoutMs);
				child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
				child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
				child.on('error', (error: Error) => { output += String(error); finish(127); });
				child.on('close', (code: number | null) => finish(code ?? 0));
			} catch (error) {
				output += String(error);
				finish(127);
			}
		});
	}

	private async _dispatch(token: string, rpc: IJsonRpcRequest): Promise<unknown> {
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
			case 'tools/list':
				// para固有ツール＋内蔵chrome-devtools-mcpのツール（子プロセスが起動できない場合は
				// para固有ツールのみに縮退し、一覧自体は失敗させない）
				return { tools: [...TOOLS, ...await this._listDevtoolsTools(token)] };
			case 'tools/call':
				return this._callTool(token, rpc.params as { name?: unknown; arguments?: unknown } | undefined);
			default:
				throw new JsonRpcMethodError(-32601, `Method not found: ${rpc.method}`);
		}
	}

	private async _callTool(token: string, params: { name?: unknown; arguments?: unknown } | undefined): Promise<unknown> {
		const name = typeof params?.name === 'string' ? params.name : undefined;
		if (!name) {
			throw new JsonRpcMethodError(-32602, `Unknown tool: ${String(name)}`);
		}
		if (!TOOLS.some(t => t.name === name)) {
			// para固有ツールでなければ、内蔵chrome-devtools-mcpへの転送を試みる
			return this._callDevtoolsTool(token, name, params?.arguments);
		}

		if (name === 'preview_file') {
			const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : undefined;
			const path = typeof toolArgs?.path === 'string' ? toolArgs.path : undefined;
			return this._previewFile(token, path);
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
	private async _listDevtoolsTools(token: string): Promise<IParadisProxiedTool[]> {
		const wsEndpoint = this._devtoolsWsEndpoint(token);
		if (!wsEndpoint) {
			return [];
		}
		try {
			return await this._devtoolsProxy.listTools(token, wsEndpoint);
		} catch (error) {
			this.logService.warn('[ParadisAgentBrowser] Embedded chrome-devtools-mcp is unavailable; serving para-browser tools only', error);
			return [];
		}
	}

	/** ツール呼び出しを内蔵chrome-devtools-mcpへ転送する（転送対象外の名前は -32602）。 */
	private async _callDevtoolsTool(token: string, name: string, args: unknown): Promise<unknown> {
		const wsEndpoint = this._devtoolsWsEndpoint(token);
		if (wsEndpoint && await this._devtoolsProxy.isProxiedTool(token, wsEndpoint, name)) {
			// DevToolsツールは全て「ペインに共有されたページ」前提。未共有なら既存ツールと
			// 同じ案内文を返す（子プロセス側の英語エラーより行動可能なガイダンスを優先）。
			if (!this._bindings.get(token)) {
				return this._toolError(NOT_BOUND_MESSAGE);
			}
			const result = await this._devtoolsProxy.tryCallTool(token, wsEndpoint, name, args);
			if (result !== undefined) {
				return result;
			}
		}
		throw new JsonRpcMethodError(-32602, `Unknown tool: ${name}`);
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
	private async _previewFile(token: string, path: string | undefined): Promise<unknown> {
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
		try {
			const channel = this.ipcServer.getChannel(PARADIS_AGENT_PREVIEW_CHANNEL, client => client.ctx === pane.windowCtx);
			const result = await Promise.race([
				channel.call<IParadisPreviewFileResult>('previewFile', [path]),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out after 10s')), 10000); }),
			]);
			if (!result.ok) {
				return this._toolError(result.error ?? 'Failed to open the file in Para Code.');
			}
			return this._toolText(`Opened ${path} in the Para Code window that owns this terminal pane.`);
		} catch (error) {
			return this._toolError(`Failed to open the file in Para Code: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
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

	private _readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					reject(new Error('Request body too large'));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}

	private _sendJsonRpc(res: http.ServerResponse, payload: unknown): void {
		if (!res.headersSent) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
		}
		res.end(JSON.stringify(payload));
	}

	override dispose(): void {
		this._httpServer?.close();
		this._httpServer = undefined;
		try {
			unlinkSync(this._portFilePath);
		} catch {
			// ポートファイルが既に無い場合は無視
		}
		super.dispose();
	}
}

/** JSON-RPCのエラーレスポンスに変換されるエラー。 */
class JsonRpcMethodError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}
