/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCPサーバーに chrome-devtools-mcp のツール群をプロキシ合流させるための
// 子プロセス管理＋最小stdio MCPクライアント。
//
// 設計（背景は media/chrome-devtools-mcp/README.md も参照）:
//   - vendored chrome-devtools-mcp をペイントークン毎に1子プロセスとして遅延spawnする
//     （ELECTRON_RUN_AS_NODE=1 + process.execPath。Electron同梱NodeはESM/Node20+要件を満たす）
//   - CDPゲートウェイへの接続は `--wsEndpoint=ws://127.0.0.1:<port>/cdp/devtools/browser/<id>?pane=<token>`
//     で行う。`?pane=` クエリは _resolveIngress の最優先経路なので、lsof/psによるピアPID推定に
//     一切依存せず全OSで決定的にペインへ紐付く（puppeteerがwsEndpointのクエリを保持することは実測確認済み。
//     --browserUrl だと puppeteer がパス・クエリを落とすため使わない）。保険として env にもトークンを注入する
//   - chrome-devtools-mcp はブラウザ接続を初回 tools/call まで遅延するため、子プロセス自体の
//     spawn は安価（tools/list はブラウザ未接続でも成功する）
//   - CDPゲートウェイが非対応のツール（new_page / close_page / resize_page）は一覧から除外する
//   - アイドル一定時間で子プロセスをkillし、次の呼び出しで透過的に再spawnする
//   - roots 機能を名乗り、`roots/list` にペインのフォルダ（サービスが決める）と Para Code の一時フォルダを
//     返す。vendored の validatePath は roots が未設定だと何も確かめないため（NOTES.md「chrome-devtools-mcp の
//     ファイルのパスは手元のペインからだけ受け、roots で範囲を絞る」）。子プロセスの一時フォルダ（TMPDIR 等）も
//     同じ Para Code の一時フォルダへ向ける。ペインのフォルダが引けなかったときは一時フォルダだけで答え、
//     引け次第 `notifications/roots/list_changed` で取り直させる

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_PANE_TOKEN_ENV_VAR } from '../common/paradisAgentBrowser.js';
import { paradisPaneTokenOfScopeKey } from '../common/paradisAgentTabScope.js';
import { paradisClassifyBrowserToolErrorText } from '../common/paradisBrowserErrorReason.js';
import { paradisCrashRoleNodeArgs } from '../../sentry/common/paradisCrashRole.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisDevtoolsRoot, paradisDevtoolsExplainRootsDenial, paradisDevtoolsRoots } from './paradisDevtoolsPathPolicy.js';
import { ParadisDevtoolsTemporaryDirectory } from './paradisDevtoolsTemporaryDirectory.js';
import { ParadisSnapshotBaselines, ParadisSnapshotDiffMode } from './paradisBrowserSnapshotDiff.js';
import { IParadisDevtoolsRecycleLimits, PARADIS_DEVTOOLS_HEALTH_INTERVAL_MS, PARADIS_DEVTOOLS_RECYCLE_LIMITS, PARADIS_DEVTOOLS_RECYCLE_QUIET_MS, ParadisDevtoolsReplacedReason, paradisAppendStderrTail, paradisDevtoolsReadsRecords, paradisDevtoolsRecordsResetNote, paradisDevtoolsRecycleReason, paradisDevtoolsStaleUidMessage, paradisNewUidTag, PARADIS_UID_TAG_HISTORY, paradisParseV8FatalStderr, paradisReadProcessRssMib, paradisTagChildUids, paradisTagSnapshotFileText, paradisUntagUids } from './paradisDevtoolsChildHealth.js';
import { ParadisSnapshotCache, paradisAdjustCachedSnapshotResult, paradisAttachSnapshotRootRect, paradisSnapshotCacheUsable, paradisAdjustDevtoolsToolDescriptor, paradisAdjustDevtoolsToolResult, paradisPrepareDevtoolsToolCall, paradisShouldRetryDevtoolsToolAfterTargetClosed, paradisSnapshotMeasuresRoot, paradisTakeSnapshotRootRect, paradisEvaluateObserves, paradisEvaluateHasDeadline, paradisDevtoolsTimeoutTools, paradisDevtoolsToolIsRetrySafe } from './paradisDevtoolsToolAdjustments.js';
import { IParadisDevtoolsCallOrigin, paradisDevtoolsCallOriginExtra } from './paradisDevtoolsCallOrigin.js';

/** vendored chrome-devtools-mcp のstdioエントリ（同梱物。更新手順は同フォルダのREADME.md）。 */
const DEVTOOLS_MCP_ENTRY = 'vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js';

/**
 * CDPゲートウェイでは動作しないため一覧から除外するツール。
 * ゲートウェイは「ペインに共有された1ページ」のみを見せる設計で、ページの開閉・リサイズは
 * Para Code UI側の責務（理由はサービス側の CDP_LIMITATIONS_NOTE と同じ）。
 */
const EXCLUDED_TOOLS = new Set(['new_page', 'close_page', 'resize_page']);

/** initialize / tools/list 応答の待ち時間上限。 */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** tools/call の待ち時間上限（performance trace / lighthouse は分単位かかりうる）。 */
const CALL_TIMEOUT_MS = 300_000;
/** この時間ツール呼び出しが無ければ子プロセスをkillする（次の呼び出しで再spawn）。 */
const IDLE_KILL_MS = 30 * 60_000;
/** 改行されない子プロセスstdoutを保持できる最大byte数。 */
const MAX_STDOUT_BUFFER_BYTES = 4 * 1024 * 1024;
/** 1子プロセスで同時に待機できるJSON-RPC要求数。 */
const MAX_PENDING_REQUESTS = 256;
/** 1子プロセスのstdinに滞留できる最大byte数。 */
const MAX_STDIN_QUEUED_BYTES = 1024 * 1024;
/**
 * サービス全体で同時に保持できる子プロセス数。tab_id で使うタブごとに 1 つ起こすので、1 ペインで共有のページ
 * （PARADIS_USER_SHARED_PAGE_LIMIT）・自分のタブ（PARADIS_AGENT_TAB_LIMIT）・開いたタブ（PARADIS_OPENED_TAB_LIMIT）のぶんまで
 * 起こしうる。全ペインでこの数を分け合い、達したら使っていない一番古い子を止める（{@link ParadisDevtoolsMcpProxy._evictIdleChild}）。
 */
const MAX_CHILDREN = 64;
/** generation高水位を保持できるtoken数。 */
const MAX_GENERATION_HIGH_WATERMARKS = 4096;
/** SIGTERMを無視する子プロセスを強制終了するまでの猶予。 */
const KILL_GRACE_TIMEOUT_MS = 5_000;
/**
 * `roots/list` に答えるまでの待ち時間上限。vendored の SDK は 60 秒で要求を諦め、そのとき roots は
 * 未設定のまま（＝パスを何も確かめない）になるので、それより十分短くし、時間切れでも一時フォルダだけを返す。
 */
const ROOTS_RESOLVE_TIMEOUT_MS = 5_000;
/** ペインのフォルダが引けなかったときに取り直すまでの待ち（回ごとに倍にする）と回数。 */
const ROOTS_RETRY_DELAY_MS = 2_000;
const MAX_ROOTS_RETRIES = 5;
const RESOURCE_LIMIT_ERROR_MESSAGE = 'PARA_BROWSER_RETRYABLE: embedded DevTools bridge resource limit reached; retry';
const TERMINATED_ERROR_MESSAGE = 'PARA_BROWSER_RETRYABLE: embedded DevTools bridge terminated; retry';
/** 落ちた子プロセスの標準エラーの残りを待つ時間の上限。 */
const STDERR_SETTLE_MS = 1_000;
/** 答えの uid に印を付けないツール（vendored の uid を出さず、ページの中身をそのまま返すもの）。 */
const UNTAGGED_RESULT_TOOLS: ReadonlySet<string> = new Set(['evaluate_script', 'list_network_requests', 'get_network_request']);
/** 印を付け直すスナップショットのファイルの大きさの上限。 */
const MAX_TAGGED_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;

/** MCP `tools/list` が返すツール記述子（未知フィールドはそのまま透過する）。 */
export interface IParadisProxiedTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
	readonly [key: string]: unknown;
}

/** 子プロセス生成と待機時間をテスト・実行環境ごとに差し替えるための設定。 */
export interface IParadisDevtoolsMcpProxyOptions {
	readonly spawnChild?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams;
	readonly handshakeTimeoutMs?: number;
	readonly callTimeoutMs?: number;
	/** ツール呼び出しの持ち時間を測る時計（テスト用。既定 `Date.now`）。 */
	readonly now?: () => number;
	readonly maxStdoutBufferBytes?: number;
	readonly maxPendingRequests?: number;
	readonly maxStdinQueuedBytes?: number;
	readonly maxChildren?: number;
	readonly maxGenerationHighWatermarks?: number;
	readonly killGraceTimeoutMs?: number;
	/**
	 * ペインの手元のフォルダ（絶対パス）。子プロセスの `roots/list` に答えるときに呼ぶ。接続先のペインは
	 * 空配列を返すこと（Para Code の一時フォルダだけが roots になる）。ウィンドウに尋ねられなかった等で
	 * 本来のフォルダが揃っていないときは `complete: false`（後で取り直す）。省略時は空で揃っている扱い。
	 */
	readonly resolveRoots?: (token: string) => Promise<IParadisDevtoolsRootsResolution>;
	readonly rootsTimeoutMs?: number;
	readonly rootsRetryDelayMs?: number;
	/**
	 * 子プロセスの一時フォルダ兼 root を固定する（テスト用。作成・後始末をしない）。省略時は os.tmpdir() の
	 * 下に作り、子プロセスを起こすたびに在るかを確かめ、終了時に消す。
	 */
	readonly temporaryDirectory?: string;
	/**
	 * CDP ゲートウェイがこのペインの入力を `since` 以降に断った理由（直近の 1 件）。click / fill などが
	 * 「not interactive」とだけ返したときに書き足す。
	 */
	readonly recentInputRejection?: (token: string, since: number) => string | undefined;
	/**
	 * ツールが失敗した（結果が isError、時間切れ、JSON-RPC のエラー）。値はどれも固定の語で、
	 * 共有中のタブのフォーカス診断（Sentry のパンくずとまとめのイベント）へ回す。
	 */
	readonly onToolFailure?: (token: string, failure: { readonly tool: string; readonly errorKind: string; readonly gateReason?: string }) => void;
	/** 子プロセスを作り直す目安（テスト用。既定 {@link PARADIS_DEVTOOLS_RECYCLE_LIMITS}）。 */
	readonly recycleLimits?: IParadisDevtoolsRecycleLimits;
	/** 最後の呼び出しからこれだけ経つまでは作り直さない（テスト用）。 */
	readonly recycleQuietMs?: number;
	/** RSS を測り、作り直すかを確かめる間隔（テスト用）。 */
	readonly healthIntervalMs?: number;
	/** 子プロセスの RSS（MiB）を読む（テスト用。既定は `ps`）。 */
	readonly readRssMib?: (pid: number | undefined) => Promise<number | undefined>;
	/** 子プロセスが落ちたあと、標準エラーの残りを待つ時間（テスト用）。 */
	readonly stderrSettleMs?: number;
	/** 子プロセスの uid の印を作る（テスト用。既定は {@link paradisNewUidTag}）。 */
	readonly newUidTag?: (used: readonly string[]) => string;
}

/** {@link IParadisDevtoolsMcpProxyOptions.resolveRoots} の結果。 */
export interface IParadisDevtoolsRootsResolution {
	readonly folders: readonly string[];
	readonly complete: boolean;
}

interface IPendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface IChildEntry {
	readonly child: ChildProcessWithoutNullStreams;
	readonly generation: number;
	readonly wsEndpoint: string;
	readonly tokenFingerprint: string;
	readonly spawnedAt: number;
	/** 子プロセスの一時フォルダ（roots に必ず載せる）。 */
	readonly temporaryDirectory: string;
	/** 揃ったペインのフォルダ。揃う前は undefined（遅れて届いた古い応答で上書きさせないため、以後はこれで答える）。 */
	completeFolders: readonly string[] | undefined;
	/** 最後に答えた roots（validatePath に断られたときの案内に使う）。 */
	lastRoots: readonly IParadisDevtoolsRoot[];
	rootsRetryTimer: ReturnType<typeof setTimeout> | undefined;
	rootsRetries: number;
	/** initialize ハンドシェイク完了（失敗時はreject）。spawn直後に一度だけ代入される。 */
	ready: Promise<void>;
	readonly pending: Map<number, IPendingRequest>;
	nextId: number;
	stdoutBuffer: Buffer;
	stdoutBufferLength: number;
	stdinBackpressured: boolean;
	stdinDrainListener: (() => void) | undefined;
	stdoutDataListener: ((chunk: Buffer) => void) | undefined;
	processErrorListener: ((error: Error) => void) | undefined;
	processExitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
	processCloseListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
	killTimer: ReturnType<typeof setTimeout> | undefined;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	killed: boolean;
	/** 起動した時刻（作り直しの寿命に使う）。 */
	readonly bornAt: number;
	/** 受けたツール呼び出しの回数。 */
	calls: number;
	/** 最後にツール呼び出しが始まった・終わった時刻。 */
	lastActivityAt: number;
	/** 今受けているツールの名前（Sentry に載せる固定の名前。落ちたときに応答待ちだったもの）。 */
	readonly activeTools: string[];
	/**
	 * 止めると消える状態を持っているか（performance_start_trace で始めたまま止めていない trace、emulate の設定）。
	 * 上限で子を止めるとき後回しにする（{@link ParadisDevtoolsMcpProxy._evictIdleChild}）。
	 */
	tracing: boolean;
	emulated: boolean;
	/** 最後に測った RSS と、その最大（MiB）。 */
	rssMib: number | undefined;
	peakRssMib: number | undefined;
	healthTimer: ReturnType<typeof setInterval> | undefined;
	healthCheckRunning: boolean;
	/** 標準エラーの末尾（外へは出さない。V8 のメモリ不足の数値だけを抜く）。 */
	stderrTail: string;
	stderrDataListener: ((chunk: Buffer) => void) | undefined;
	/** 落ちたあと、標準エラーの残りを読み終えるまで閉じない。 */
	keepStderrOpen: boolean;
	/** この子プロセスの uid に付ける印（paradisDevtoolsChildHealth.ts の「uid の世代の印」）。 */
	readonly uidTag: string;
}

/** 子プロセスを入れ替えたあとの、そのキーの様子。 */
interface IReplacedState {
	readonly reason: ParadisDevtoolsReplacedReason;
	/** 次に記録を読むツールの結果へ、記録が消えた旨を 1 行添える。 */
	recordsNote: boolean;
	/** 止めた子が、始めたまま止めていない performance trace を持っていたか（注記に trace の文を足す）。 */
	readonly hadTrace: boolean;
}

class StaleParadisDevtoolsGenerationError extends Error {
	constructor() {
		super('PARA_BROWSER_RETRYABLE: stale browser binding generation');
	}
}

class ParadisDevtoolsResourceLimitError extends Error {
	constructor() {
		super(RESOURCE_LIMIT_ERROR_MESSAGE);
	}
}

/** 子プロセスが自分から（こちらが止めたのではなく）終わり、応答待ちの呼び出しが答えを失った。 */
class ParadisDevtoolsChildExitedError extends Error {
	constructor() {
		super(TERMINATED_ERROR_MESSAGE);
	}
}

/** 要求の uid の印が、呼び出す子プロセスのものでない（前の子プロセスの uid）。 */
class ParadisDevtoolsStaleUidError extends Error {
	constructor() {
		super('PARA_BROWSER_STALE_UID');
	}
}

class ParadisDevtoolsUnavailableError extends Error {
	/** JSON-RPC error code from the child, when that is what made the call unavailable. */
	constructor(readonly rpcCode?: number) {
		super(TERMINATED_ERROR_MESSAGE);
	}
}

/** Vendored chrome-devtools-mcp tool names only; anything else is folded so no free text reaches Sentry. */
const vendoredToolName = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Buckets a failed tool result's leading text. Until 2026-09 the shared process never looked
 * at `result.isError`, so a page whose every call answered `Protocol error: Target closed`
 * left no trace here (the agent saw the text, Sentry saw nothing).
 */
function classifyToolErrorText(text: string): 'unresponsive' | 'target-closed' | 'protocol-error' | 'timeout' | 'dialog' | 'navigation' | 'other' {
	// The page did not answer within Para Code's deadline (PARA_BROWSER_PAGE_UNRESPONSIVE, and the 3 s bound of the
	// observation, whose text says a dialog "may" have opened). Checked before 'dialog': these were counted as dialogs
	// (Sentry PARA-CODE-DESKTOP-MW) or 'other' (HP) although no dialog was confirmed.
	if (/PARA_BROWSER_PAGE_UNRESPONSIVE|PARA_BROWSER_DIALOG_OPEN: the page did not answer/.test(text)) {
		return 'unresponsive';
	}
	if (/Target closed|Session closed|frame was detached/i.test(text)) {
		return 'target-closed';
	}
	if (/Protocol error/i.test(text)) {
		return 'protocol-error';
	}
	if (/timed? ?out|TimeoutError/i.test(text)) {
		return 'timeout';
	}
	if (/dialog/i.test(text)) {
		return 'dialog';
	}
	if (/navigat/i.test(text)) {
		return 'navigation';
	}
	return 'other';
}

/**
 * ペイントークン毎の chrome-devtools-mcp 子プロセスを管理し、tools/list・tools/call を
 * 転送するプロキシ。`ParadisAgentBrowserService` が所有する。
 *
 * `token` と書いてある引数は子プロセスの台帳のキーで、tab_id で使うタブごとに分けるときは
 * トークンとタブの組（paradisAgentTabScope.ts のスコープキー）になる。タブごとに子プロセスが分かれるので、
 * 別のタブへの呼び出しは並行に走り、同じタブへの呼び出しは子プロセスの中の toolMutex で直列になる。
 * options のコールバックには、このキーがそのまま渡る（サービスがペインのトークンへ分ける）。
 */
export class ParadisDevtoolsMcpProxy extends Disposable {

	private readonly _children = new Map<string, IChildEntry>();
	/** take_snapshot の続き（offset）用に、上限より長かった直近のスナップショット（ペインごと）。 */
	private readonly _snapshots = new ParadisSnapshotCache();
	/** エージェントが前回 take_snapshot で受け取ったページ（差分の元。設定 snapshotDiff が有効なときだけ使う）。 */
	private readonly _snapshotBaselines = new ParadisSnapshotBaselines();
	/** kill要求済みでも実process exit/errorを観測するまではslotを占有する。 */
	private readonly _childSlots = new Set<IChildEntry>();
	private readonly _generationHighWatermarks = new Map<string, number>();
	/** キーごとの、今走っている tryCallTool の数（0 のときだけ作り直す）。 */
	private readonly _inFlight = new Map<string, number>();
	/** 子プロセスを入れ替えたキー（uid と記録が新しい子プロセスに無いことを、エージェントに分かる形で伝える）。 */
	private readonly _replaced = new Map<string, IReplacedState>();
	/** キーごとの、子プロセスに付けた uid の印（古い順、{@link PARADIS_UID_TAG_HISTORY} 個まで。この印の uid だけを uid として扱う）。 */
	private readonly _issuedUidTags = new Map<string, string[]>();
	/** 落ちた子プロセスの標準エラーの残りを待っている後片付け（dispose で打ち切る）。 */
	private readonly _stderrSettlers = new Set<() => void>();
	private _disposed = false;
	/**
	 * ツール一覧のキャッシュ（除外前の生リスト）。同じvendoredバイナリ＋同じフラグで起動する
	 * ため全ペインで同一。一度取得したらサービス生存中は再取得しない。
	 */
	private _toolsCache: readonly IParadisProxiedTool[] | undefined;
	/** vendored の take_snapshot が root の測り（`paraCodeRootRect`、PARA-PATCH）を知っているか。tools/list で控える。 */
	private _measuresSnapshotRoot = false;
	private _evaluateObserves = false;
	/** vendored の evaluate_script が締め切り付きの評価（`paraCodeDeadlineMs`）を知っているか。tools/list を読むまでは false。 */
	private _evaluateHasDeadline = false;
	private _timeoutTools: ReadonlySet<string> = new Set();

	/** vendored の evaluate_script が待たない評価（`paraCodeObserve`）を知っているか。tools/list を読むまでは false。 */
	get evaluateObserves(): boolean {
		return this._evaluateObserves;
	}
	/** 作成・後始末まで受け持つ一時フォルダ（`options.temporaryDirectory` で固定したときは無い）。 */
	private readonly _temporaryDirectory: ParadisDevtoolsTemporaryDirectory | undefined;

	constructor(
		/** para-browser 側の静的ツール名。子プロセス側と衝突した場合は子プロセス側を隠す。 */
		private readonly reservedToolNames: ReadonlySet<string>,
		private readonly logService: ILogService,
		private readonly options: IParadisDevtoolsMcpProxyOptions = {},
	) {
		super();
		if (options.temporaryDirectory === undefined) {
			this._temporaryDirectory = new ParadisDevtoolsTemporaryDirectory(tmpdir());
			void ParadisDevtoolsTemporaryDirectory.sweepStale(tmpdir()).then(removed => {
				if (removed.length > 0) {
					this._debug(`[ParadisDevtoolsProxy] Removed ${removed.length} stale temporary folder(s) of chrome-devtools-mcp`);
				}
			}, () => undefined);
		}
	}

	/**
	 * 子プロセスの一時フォルダ（roots に必ず載るもの）。接続先のペインのファイルを手元で受け渡すときの置き場。
	 * 作れなければ undefined。
	 */
	ensureTemporaryDirectory(): string | undefined {
		return this.options.temporaryDirectory ?? this._temporaryDirectory?.ensure();
	}

	/**
	 * 転送対象のツール一覧（除外・衝突フィルタ適用済み）を返す。
	 * 子プロセスの起動や応答に失敗した場合はthrowする（呼び出し側で縮退させる）。
	 */
	async listTools(token: string, generation: number, wsEndpoint: string, signal?: AbortSignal): Promise<IParadisProxiedTool[]> {
		return this._listTools(token, generation, wsEndpoint, signal);
	}

	private async _listTools(token: string, generation: number, wsEndpoint: string, signal?: AbortSignal): Promise<IParadisProxiedTool[]> {
		this._throwIfDisposed();
		this._observeGeneration(token, generation);
		if (!this._toolsCache) {
			const entry = this._ensureChild(token, generation, wsEndpoint);
			await this._awaitReady(token, entry, signal);
			this._throwIfDisposed();
			const result = await this._request(token, entry, 'tools/list', {}, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS, signal) as { tools?: unknown } | undefined;
			this._throwIfDisposed();
			if (!Array.isArray(result?.tools) || !result.tools.every(tool => this._isProxiedTool(tool))) {
				throw new Error('chrome-devtools-mcp returned an unexpected tools/list response');
			}
			// vendored の take_snapshot が root の測りを知っているか（PARA-PATCH が当たっているか）を控える
			this._measuresSnapshotRoot = paradisSnapshotMeasuresRoot(result.tools);
			// vendored の evaluate_script が待たずに評価する引数を知っているか（操作の後の観測。paradisBrowserObserve.ts）
			this._evaluateObserves = paradisEvaluateObserves(result.tools);
			this._evaluateHasDeadline = paradisEvaluateHasDeadline(result.tools);
			// evaluate_script・take_snapshot が締め切りの引数を知っているか（q.html Q394）
			this._timeoutTools = paradisDevtoolsTimeoutTools(result.tools);
			// wait_for / take_snapshot の引数は Para Code 側で足す・広げる（paradisDevtoolsToolAdjustments.ts）
			this._toolsCache = Object.freeze(result.tools.map(tool => this._deepFreeze(paradisAdjustDevtoolsToolDescriptor(tool))));
		}
		return this._toolsCache.filter(tool => !EXCLUDED_TOOLS.has(tool.name) && !this.reservedToolNames.has(tool.name));
	}

	/**
	 * `name` が転送対象のツールかどうかを返す（子プロセスが起動できない場合は false）。
	 */
	async isProxiedTool(token: string, generation: number, wsEndpoint: string, name: string, signal?: AbortSignal): Promise<boolean> {
		try {
			return (await this.listTools(token, generation, wsEndpoint, signal)).some(tool => tool.name === name);
		} catch {
			this._warn(`[ParadisDevtoolsProxy] tools/list failed while resolving a tool name for pane ${this._tokenFingerprint(token)}`);
			return false;
		}
	}

	/**
	 * ツール呼び出しを子プロセスへ転送する。`name` が転送対象でなければ `undefined` を返す
	 * （未知ツールのJSON-RPCエラー化は呼び出し側の責務）。転送対象で実行に失敗した場合は
	 * MCPツールエラー（`isError: true` のcontent）を返し、プロトコルエラーにはしない。
	 * @param snapshotDiff エージェントの take_snapshot を前回との差分にするか（paradisBrowserSnapshotDiff.ts）。省くと従来どおり。
	 */
	/**
	 * @param origin 何のための呼び出しか（エージェントが呼んだ道具・Para Code の見張り）。失敗の報告にだけ使う（paradisDevtoolsCallOrigin.ts）。
	 */
	async tryCallTool(token: string, generation: number, wsEndpoint: string, name: string, args: unknown, signal?: AbortSignal, snapshotDiff?: ParadisSnapshotDiffMode, origin?: IParadisDevtoolsCallOrigin): Promise<unknown | undefined> {
		let known: boolean;
		try {
			known = (await this._listTools(token, generation, wsEndpoint, signal)).some(tool => tool.name === name);
		} catch (error) {
			if (signal?.aborted || error instanceof StaleParadisDevtoolsGenerationError || error instanceof ParadisDevtoolsResourceLimitError || error instanceof ParadisDevtoolsUnavailableError) {
				return this._toolCallError(name, error);
			}
			// 一覧すら取れない＝子プロセスが起動できない。para側ツールの解決を妨げないよう
			// 「知らないツール」として扱う（呼び出し側が -32602 を返す）。
			this._warn(`[ParadisDevtoolsProxy] tools/list failed while resolving a tool call for pane ${this._tokenFingerprint(token)}`);
			return undefined;
		}
		if (!known) {
			return undefined;
		}
		const prepared = paradisPrepareDevtoolsToolCall(name, args, { measureRoot: this._measuresSnapshotRoot, evaluateObserve: this._evaluateObserves, evaluateDeadline: this._evaluateHasDeadline, timeoutTools: this._timeoutTools });
		if (prepared.refuse !== undefined) {
			return { content: [{ type: 'text', text: prepared.refuse }], isError: true };
		}
		const live = this._children.get(token);
		const liveTag = live !== undefined && !live.killed && live.generation === generation && live.wsEndpoint === wsEndpoint ? live.uidTag : undefined;
		if (paradisUntagUids(args, liveTag, this._issuedUidTags.get(token) ?? []).stale) {
			// 前の子プロセスの uid（新しい子プロセスは数え直すので、同じ uid が別の要素を指すこともある）。
			// 子プロセスを起こさず、取り直せば使えることを伝える
			return this._staleUidResult(token);
		}
		this._inFlight.set(token, (this._inFlight.get(token) ?? 0) + 1);
		try {
			return await this._callProxiedTool(token, generation, wsEndpoint, name, args, prepared, signal, snapshotDiff, origin);
		} finally {
			const remaining = (this._inFlight.get(token) ?? 1) - 1;
			if (remaining > 0) {
				this._inFlight.set(token, remaining);
			} else {
				this._inFlight.delete(token);
			}
		}
	}

	private async _callProxiedTool(token: string, generation: number, wsEndpoint: string, name: string, args: unknown, prepared: ReturnType<typeof paradisPrepareDevtoolsToolCall>, signal: AbortSignal | undefined, snapshotDiff: ParadisSnapshotDiffMode | undefined, origin: IParadisDevtoolsCallOrigin | undefined): Promise<unknown> {
		const startedAt = Date.now();
		const now = this.options.now ?? Date.now;
		const budgetStartedAt = now();
		const safeToolName = vendoredToolName.test(name) ? name : 'other';
		const measuresRoot = this._isRecord(prepared.args) && prepared.args.paraCodeRootRect !== undefined;
		const snapshotCacheUsable = paradisSnapshotCacheUsable(name, prepared);
		const snapshotEpoch = this._snapshots.epoch(token);
		if (name !== 'take_snapshot' && name !== 'wait_for') {
			// ほかのツール（クリック・遷移など）でページが変わりうる。控えた続きはもう当てにしない。
			this._snapshots.forget(token);
		} else if (snapshotCacheUsable && name === 'take_snapshot' && (prepared.snapshotOffset ?? 0) > 0) {
			// 続きは、直前に返したスナップショットから切り出す（取り直すとページが変わって続きがずれる）。
			const current = this._children.get(token);
			const cached = this._snapshots.recall(token, current, generation);
			if (cached !== undefined) {
				return paradisAdjustCachedSnapshotResult(prepared, cached.result, cached.at);
			}
		}
		const callTimeoutMs = this.options.callTimeoutMs ?? CALL_TIMEOUT_MS;
		try {
			const first = await this._callChildOnce(token, generation, wsEndpoint, name, safeToolName, prepared.args, callTimeoutMs, signal).catch(async error => {
				// 子プロセスが答える前に落ちた（メモリ不足など）。読むだけのツールは新しい子プロセスで 1 回だけ呼び直す。
				// uid を使う呼び出しは、新しい子プロセスの印と合わないので取り直しの案内になる（_trackedToolCall）
				const retryBudgetMs = callTimeoutMs - (now() - budgetStartedAt);
				if (!(error instanceof ParadisDevtoolsChildExitedError) || !paradisDevtoolsToolIsRetrySafe(name) || signal?.aborted || retryBudgetMs <= 0) {
					throw error;
				}
				this._debug(`[ParadisDevtoolsProxy] ${safeToolName} lost its child for pane ${this._tokenFingerprint(token)}; retrying once on a new one`);
				const retried = await this._callChildOnce(token, generation, wsEndpoint, name, safeToolName, prepared.args, retryBudgetMs, signal);
				reportParadisDiagnosticError('owned', 'agent-browser', 'devtools-child-exited-retry', new Error('chrome-devtools-mcp tool retried after the child exited'), {
					safe_tool_name: safeToolName,
					safe_retry_succeeded: !(this._isRecord(retried.result) && retried.result.isError === true),
				}, 'info');
				return retried;
			});
			const entry = first.producer;
			let result = first.result;
			// 結果を返した子プロセス（再試行したら 2 回目のもの）。スナップショットの控えはこれに結び付ける。
			let producer = entry;
			const remainingMs = callTimeoutMs - (now() - budgetStartedAt);
			if (paradisShouldRetryDevtoolsToolAfterTargetClosed(name, result) && !signal?.aborted && remainingMs > 0) {
				// The CDP connection or the page's session went away under the call (a rebind sweep, a
				// detach, a transport error). chrome-devtools-mcp reconnects on its next call when it sees
				// the browser disconnected, so one more try of a read-only tool usually succeeds.
				this._reportToolResultError(token, safeToolName, result, Date.now() - startedAt, origin);
				this._debug(`[ParadisDevtoolsProxy] ${safeToolName} failed with a closed target for pane ${entry.tokenFingerprint}; retrying once`);
				const retryEntry = this._ensureChild(token, generation, wsEndpoint);
				await this._awaitReady(token, retryEntry, signal);
				// 2 回目は 1 回の呼び出しの持ち時間の残りまで（呼び出し元の上限を超えない）。子プロセスの
				// 起動を待つ間に使い切ったら、呼び直さずに 1 回目の結果を返す。
				const retryBudgetMs = callTimeoutMs - (now() - budgetStartedAt);
				if (retryBudgetMs > 0) {
					result = await this._trackedToolCall(token, retryEntry, name, safeToolName, prepared.args, retryBudgetMs, signal);
					producer = retryEntry;
					reportParadisDiagnosticError('owned', 'agent-browser', 'devtools-target-closed-retry', new Error('chrome-devtools-mcp tool retried after Target closed'), {
						safe_tool_name: safeToolName,
						safe_retry_succeeded: !(this._isRecord(result) && result.isError === true),
					}, 'info');
					this._reportToolResultError(token, safeToolName, result, Date.now() - startedAt, origin);
				}
			} else {
				this._reportToolResultError(token, safeToolName, result, Date.now() - startedAt, origin);
			}
			// root の位置の行は、控える前・エージェントへ返す前に取り除き、位置は返す結果に結び付ける
			const measured = measuresRoot ? paradisTakeSnapshotRootRect(result) : undefined;
			if (measured) {
				result = measured.result;
			}
			if (snapshotCacheUsable && (name === 'take_snapshot' || (name === 'wait_for' && prepared.includeSnapshot === true))) {
				this._snapshots.remember(token, result, producer, producer.generation, snapshotEpoch);
			}
			if (snapshotDiff !== undefined && name === 'take_snapshot' && snapshotCacheUsable && prepared.snapshotRoot === undefined && (prepared.snapshotOffset ?? 0) === 0) {
				// 続き（offset）の控えは全体のまま。エージェントへ返す分だけを差分にする
				result = this._snapshotBaselines.apply(token, producer, producer.generation, result, snapshotDiff);
			}
			const adjusted = paradisAdjustDevtoolsToolResult(name, prepared, result, this.options.recentInputRejection?.(token, startedAt));
			// undefined は呼び出し側で「未知ツール」を意味するため、成功時は必ずオブジェクトを返す。
			// vendored の validatePath に断られたときは、許された場所とパス無しで呼ぶ手を添える
			const returned = paradisDevtoolsExplainRootsDenial(adjusted, entry.lastRoots) ?? { content: [] };
			paradisAttachSnapshotRootRect(returned, measured?.rect);
			this._noteReplacementAfterCall(token, name, returned);
			return returned;
		} catch (error) {
			if (error instanceof ParadisDevtoolsStaleUidError) {
				return this._staleUidResult(token);
			}
			this._reportToolCallFailure(token, safeToolName, error, Date.now() - startedAt, signal, origin);
			return this._toolCallError(name, error);
		}
	}

	/** 子プロセスを用意して 1 回呼ぶ。落ちたときは {@link ParadisDevtoolsChildExitedError} で失敗する。 */
	private async _callChildOnce(token: string, generation: number, wsEndpoint: string, name: string, safeToolName: string, toolArgs: unknown, timeoutMs: number, signal: AbortSignal | undefined): Promise<{ readonly result: unknown; readonly producer: IChildEntry }> {
		const entry = this._ensureChild(token, generation, wsEndpoint);
		await this._awaitReady(token, entry, signal);
		return { result: await this._trackedToolCall(token, entry, name, safeToolName, toolArgs, timeoutMs, signal), producer: entry };
	}

	/** tools/call を送り、呼び出しの回数・最後に使った時刻・応答待ちのツール名を子プロセスに控える。 */
	private async _trackedToolCall(token: string, entry: IChildEntry, name: string, safeToolName: string, toolArgs: unknown, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
		const untagged = paradisUntagUids(toolArgs ?? {}, entry.uidTag, this._issuedUidTags.get(token) ?? []);
		if (untagged.stale) {
			throw new ParadisDevtoolsStaleUidError();
		}
		entry.calls++;
		entry.lastActivityAt = this._now();
		entry.activeTools.push(safeToolName);
		try {
			const raw = await this._request(token, entry, 'tools/call', { name, arguments: untagged.value }, timeoutMs, signal);
			this._noteChildState(entry, name, untagged.value, raw);
			if (UNTAGGED_RESULT_TOOLS.has(name)) {
				return raw;
			}
			const tagged = paradisTagChildUids(raw, entry.uidTag);
			if (name === 'take_snapshot') {
				await this._tagSnapshotFile(tagged, entry.uidTag);
			}
			return tagged;
		} finally {
			const index = entry.activeTools.indexOf(safeToolName);
			if (index >= 0) {
				entry.activeTools.splice(index, 1);
			}
			entry.lastActivityAt = this._now();
		}
	}

	/** 止めると消える状態（実行中の trace・emulate の設定）を子プロセスに控える。 */
	private _noteChildState(entry: IChildEntry, name: string, toolArgs: unknown, raw: unknown): void {
		if (this._isRecord(raw) && raw.isError === true) {
			return;
		}
		if (name === 'performance_start_trace') {
			// autoStop の trace は呼び出しの中で終わる（既定は autoStop: true）
			entry.tracing = this._isRecord(toolArgs) && toolArgs.autoStop === false;
		} else if (name === 'performance_stop_trace') {
			entry.tracing = false;
		} else if (name === 'emulate') {
			entry.emulated = true;
		}
	}

	/**
	 * 子の上限で止めた（{@link _evictIdleChild}）ことを、そのキーの次の呼び出しへ 1 回だけ伝える文を取り出す。どの道具の
	 * 呼び出しでも伝えるよう、サービスがエージェントへ返す結果に添える（記録を読む道具の注記と重ねない）。
	 */
	takeEvictionNote(token: string): string | undefined {
		const state = this._replaced.get(token);
		if (state === undefined || state.reason !== 'evicted' || !state.recordsNote) {
			return undefined;
		}
		state.recordsNote = false;
		return paradisDevtoolsRecordsResetNote(state.reason, state.hadTrace);
	}

	/** 入れ替えの後、最初に記録を読むツールの結果へ、入れ替えの前の記録が無いことを 1 回だけ添える。 */
	private _noteReplacementAfterCall(token: string, name: string, returned: unknown): void {
		const state = this._replaced.get(token);
		if (state === undefined || !state.recordsNote || !paradisDevtoolsReadsRecords(name) || !this._isRecord(returned) || !Array.isArray(returned.content)) {
			return;
		}
		returned.content.push({ type: 'text', text: paradisDevtoolsRecordsResetNote(state.reason, state.hadTrace) });
		this._replaced.delete(token);
	}

	/** 前の子プロセスの uid を使う呼び出しへ返す結果。 */
	private _staleUidResult(token: string): unknown {
		return { content: [{ type: 'text', text: paradisDevtoolsStaleUidMessage(this._replaced.get(token)?.reason) }], isError: true };
	}

	/**
	 * `filePath` に保存したスナップショットの uid にも印を付ける（エージェントがファイルから読んだ uid を
	 * 前の子プロセスの要素と取り違えないように）。保存先は vendored の答えの `snapshotFilePath`。
	 */
	private async _tagSnapshotFile(result: unknown, tag: string): Promise<void> {
		if (!this._isRecord(result) || result.isError === true || !this._isRecord(result.structuredContent)) {
			return;
		}
		const path = result.structuredContent.snapshotFilePath;
		if (typeof path !== 'string' || path.length === 0) {
			return;
		}
		try {
			const stat = await fsPromises.stat(path);
			if (!stat.isFile() || stat.size > MAX_TAGGED_SNAPSHOT_FILE_BYTES) {
				return;
			}
			const text = await fsPromises.readFile(path, 'utf8');
			const tagged = paradisTagSnapshotFileText(text, tag);
			if (tagged !== text) {
				await fsPromises.writeFile(path, tagged, 'utf8');
			}
		} catch {
			this._warn('[ParadisDevtoolsProxy] Could not mark the uids in a saved snapshot file');
		}
	}

	/** そのキーの子プロセスを、エージェントの知らないうちに入れ替えた（作り直した・落ちた・使われず止めた）。 */
	private _markReplaced(token: string, entry: IChildEntry, reason: ParadisDevtoolsReplacedReason): void {
		if (this._children.get(token) !== entry) {
			return;
		}
		this._replaced.set(token, { reason, recordsNote: true, hadTrace: entry.tracing });
		this._snapshots.forget(token);
		this._snapshotBaselines.forget(token);
	}

	/** RSS を測り、溜まっていれば合間に作り直す。 */
	private async _checkHealth(token: string, entry: IChildEntry): Promise<void> {
		if (entry.killed || entry.healthCheckRunning) {
			return;
		}
		entry.healthCheckRunning = true;
		try {
			const rssMib = await (this.options.readRssMib ?? paradisReadProcessRssMib)(entry.child.pid);
			if (entry.killed) {
				return;
			}
			if (rssMib !== undefined) {
				entry.rssMib = rssMib;
				entry.peakRssMib = Math.max(entry.peakRssMib ?? 0, rssMib);
			}
			this._recycleIfDue(token, entry);
		} catch {
			// 測れなくても子プロセスはそのまま使う
		} finally {
			entry.healthCheckRunning = false;
		}
	}

	/**
	 * 応答待ちの呼び出しが無く、しばらく呼ばれていない合間だけ作り直す。呼び出しの最中には作り直さない。
	 * 作り直した子プロセスは止めるだけで、次の呼び出しが新しい子プロセスを起こす（_ensureChild）。
	 */
	private _recycleIfDue(token: string, entry: IChildEntry): void {
		if (entry.killed || this._disposed || this._children.get(token) !== entry) {
			return;
		}
		if (entry.pending.size > 0 || entry.activeTools.length > 0 || (this._inFlight.get(token) ?? 0) > 0) {
			return;
		}
		const now = this._now();
		if (now - entry.lastActivityAt < (this.options.recycleQuietMs ?? PARADIS_DEVTOOLS_RECYCLE_QUIET_MS)) {
			return;
		}
		const ageMs = now - entry.bornAt;
		const reason = paradisDevtoolsRecycleReason({ rssMib: entry.rssMib, ageMs, calls: entry.calls }, this.options.recycleLimits ?? PARADIS_DEVTOOLS_RECYCLE_LIMITS);
		if (reason === undefined) {
			return;
		}
		this._debug(`[ParadisDevtoolsProxy] Recycling chrome-devtools-mcp for pane ${entry.tokenFingerprint} generation=${entry.generation} (${reason})`);
		reportParadisDiagnosticError('owned', 'agent-browser', 'devtools-child-recycled', new Error('chrome-devtools-mcp recycled while idle'), {
			duration_ms: ageMs,
			safe_recycle_reason: reason,
			safe_calls: entry.calls,
			...(entry.rssMib !== undefined ? { safe_rss_mib: entry.rssMib } : {}),
		}, 'info');
		this._markReplaced(token, entry, 'recycled');
		this._killChild(token, entry, `recycled (${reason})`);
	}

	/**
	 * 落ちた子プロセスを Sentry へ送る。V8 は落ちる直前に標準エラーへ書くが、終了の知らせの方が先に届くことがあるので、
	 * 標準エラーが閉じる（か少し待つ）まで待ってから、その末尾の数値だけを載せる。
	 */
	private _reportUnexpectedExit(entry: IChildEntry, code: number | null, signal: NodeJS.Signals | null): void {
		const extra: Record<string, string | number> = {
			duration_ms: Date.now() - entry.spawnedAt,
			safe_pending_count: entry.pending.size,
			safe_pending_tool: entry.activeTools[0] ?? 'none',
			safe_calls: entry.calls,
			...(entry.rssMib !== undefined ? { safe_rss_mib: entry.rssMib } : {}),
			...(entry.peakRssMib !== undefined ? { safe_peak_rss_mib: entry.peakRssMib } : {}),
			...(typeof code === 'number' ? { exit_code: code } : {}),
			...(signal ? { signal } : {}),
		};
		const stderr = entry.child.stderr;
		const report = (): void => {
			entry.keepStderrOpen = false;
			if (entry.stderrDataListener) {
				stderr.removeListener('data', entry.stderrDataListener);
				entry.stderrDataListener = undefined;
			}
			try {
				stderr.destroy();
			} catch {
				// 既に閉じていれば無視
			}
			const fatal = paradisParseV8FatalStderr(entry.stderrTail);
			entry.stderrTail = '';
			reportParadisDiagnosticError('owned', 'agent-browser', 'devtools-child-exited', new Error('chrome-devtools-mcp exited unexpectedly'), {
				...extra,
				...(fatal ? { safe_oom_kind: fatal.kind } : {}),
				...(fatal?.heapBeforeMib !== undefined ? { safe_heap_before_mib: fatal.heapBeforeMib } : {}),
				...(fatal?.heapAfterMib !== undefined ? { safe_heap_after_mib: fatal.heapAfterMib } : {}),
			});
		};
		if (stderr.readableEnded || stderr.destroyed) {
			report();
			return;
		}
		const finish = (): void => {
			if (this._stderrSettlers.delete(finish)) {
				clearTimeout(timer);
				stderr.removeListener('end', finish);
				stderr.removeListener('close', finish);
				report();
			}
		};
		this._stderrSettlers.add(finish);
		entry.keepStderrOpen = true;
		stderr.once('end', finish);
		stderr.once('close', finish);
		const timer = setTimeout(finish, this.options.stderrSettleMs ?? STDERR_SETTLE_MS);
	}

	/** 作り直しの寿命・合間を測る時計（呼び出しの持ち時間の `options.now` とは別。そちらの読みを減らさないため）。 */
	private _now(): number {
		return Date.now();
	}

	/** Transport succeeded but the tool itself failed (`result.isError`): the text stays with the agent, the bucket goes to Sentry. */
	private _reportToolResultError(token: string, safeToolName: string, result: unknown, durationMs: number, origin?: IParadisDevtoolsCallOrigin): void {
		if (!this._isRecord(result) || result.isError !== true) {
			return;
		}
		const content = Array.isArray(result.content) ? result.content : [];
		const first = content.find((part): part is { type: 'text'; text: string } => this._isRecord(part) && part.type === 'text' && typeof part.text === 'string');
		// The kind is part of the operation so each bucket gets its own issue and rate-limit
		// window; otherwise an agent's ordinary mis-clicks would crowd out a real transport fault.
		const kind = first ? classifyToolErrorText(first.text) : 'other';
		const gate = first ? paradisClassifyBrowserToolErrorText(first.text) : undefined;
		// Para Code's own watcher (the observation around an action) gets its own operation: the agent never sees
		// those failures, and they would crowd the agents' real failures out of the rate-limit window (q.html Q462 D1).
		const operation = origin?.internal !== undefined ? `devtools-observe-error-${kind}` : `devtools-tool-error-${kind}`;
		reportParadisDiagnosticError('owned', 'agent-browser', operation, new Error('chrome-devtools-mcp tool returned isError'), {
			duration_ms: durationMs,
			safe_tool_name: safeToolName,
			safe_error_kind: kind,
			// The tool the agent called (wait_until, click_by, ...) when it ran this one inside (q.html Q462 D2).
			...paradisDevtoolsCallOriginExtra(origin),
			// Whether Para Code's own input gate refused it (PARA_BROWSER_*), and which CDP method failed.
			...gate,
		}, 'info');
		this._noteToolFailure(token, safeToolName, kind, gate?.safe_gate_reason);
	}

	/** The call never produced a result: timeout, JSON-RPC error, or a bridge we killed ourselves. */
	private _noteToolFailure(token: string, tool: string, errorKind: string, gateReason: string | undefined): void {
		try {
			this.options.onToolFailure?.(token, { tool, errorKind, gateReason });
		} catch {
			// Diagnostics must never change the tool result.
		}
	}

	private _reportToolCallFailure(token: string, safeToolName: string, error: unknown, durationMs: number, signal: AbortSignal | undefined, origin?: IParadisDevtoolsCallOrigin): void {
		if (signal?.aborted || error instanceof StaleParadisDevtoolsGenerationError || error instanceof ParadisDevtoolsResourceLimitError) {
			return;
		}
		if (error instanceof ParadisDevtoolsUnavailableError) {
			if (error.rpcCode !== undefined) {
				reportParadisDiagnosticError('owned', 'agent-browser', 'devtools-rpc-error', error, {
					duration_ms: durationMs,
					safe_tool_name: safeToolName,
					safe_rpc_code: error.rpcCode,
					...paradisDevtoolsCallOriginExtra(origin),
				}, 'warning');
				this._noteToolFailure(token, safeToolName, 'rpc-error', undefined);
			}
			return;
		}
		const message = error instanceof Error ? error.message : '';
		if (/ timed out after \d+ms$/.test(message)) {
			reportParadisDiagnosticError('owned', 'agent-browser', 'devtools-call-timeout', error, {
				duration_ms: durationMs,
				safe_tool_name: safeToolName,
				safe_method: message.startsWith('tools/call') ? 'tools/call' : message.startsWith('initialize') ? 'initialize' : 'other',
				...paradisDevtoolsCallOriginExtra(origin),
			}, 'warning');
			this._noteToolFailure(token, safeToolName, 'call-timeout', undefined);
		}
	}

	/**
	 * 指定tokenの子プロセスが現在生きているか（副作用なし、子プロセスをspawnしない）。
	 * `get_session_health` の可観測性のためだけの読み取り専用イントロスペクション。
	 */
	hasLiveChild(token: string): boolean {
		const entry = this._children.get(token);
		return entry !== undefined && !entry.killed;
	}

	/** 新しいbinding generationを記録し、それより古い子プロセスを退役させる。 */
	retire(token: string, generation: number): void {
		if (this._disposed) {
			return;
		}
		const highWatermark = this._generationHighWatermarks.get(token);
		if (highWatermark !== undefined && generation < highWatermark) {
			return;
		}
		if (highWatermark === undefined || generation > highWatermark) {
			if (highWatermark === undefined && this._generationHighWatermarks.size >= this._limit(this.options.maxGenerationHighWatermarks, MAX_GENERATION_HIGH_WATERMARKS)) {
				return;
			}
			this._generationHighWatermarks.set(token, generation);
		}
		const entry = this._children.get(token);
		if (entry && entry.generation < generation) {
			this._killChild(token, entry, 'pane retired');
			this._snapshots.forget(token);
			this._snapshotBaselines.forget(token);
		}
	}

	/** 当該tokenへのproxy呼び出しが無いことを呼び出し側が保証した後、高水位を破棄する。 */
	forget(token: string): void {
		if (this._disposed) {
			return;
		}
		const entry = this._children.get(token);
		if (entry) {
			this._killChild(token, entry, 'pane forgotten');
		}
		this._snapshots.forget(token);
		this._snapshotBaselines.forget(token);
		this._replaced.delete(token);
		this._issuedUidTags.delete(token);
		this._generationHighWatermarks.delete(token);
	}

	/** 条件に合うキーの、差分の元にする控えを捨てる（新しいエージェントがつながったペイン）。 */
	forgetSnapshotBaselines(predicate: (token: string) => boolean): void {
		this._snapshotBaselines.forgetWhere(predicate);
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const [token, entry] of [...this._children]) {
			this._killChild(token, entry, 'service disposed');
		}
		this._generationHighWatermarks.clear();
		this._replaced.clear();
		this._issuedUidTags.clear();
		for (const settle of [...this._stderrSettlers]) {
			settle();
		}
		this._snapshots.clear();
		this._snapshotBaselines.clear();
		this._toolsCache = undefined;
		void this._temporaryDirectory?.dispose();
		super.dispose();
	}

	// --- 子プロセス管理 ---

	private _ensureChild(token: string, generation: number, wsEndpoint: string): IChildEntry {
		this._throwIfDisposed();
		this._observeGeneration(token, generation);
		const existing = this._children.get(token);
		const reusable = existing
			&& !existing.killed
			&& existing.generation === generation
			&& existing.wsEndpoint === wsEndpoint;
		if (reusable) {
			this._resetIdleTimer(token, existing);
			return existing;
		}
		if (existing) {
			this._killChild(token, existing, 'binding generation changed');
		}
		if (this._childSlots.size >= this._limit(this.options.maxChildren, MAX_CHILDREN)) {
			// 使っていない一番古い子を止めて席を空ける。席が空くのは止めた子が終わってからなので、この呼び出しは
			// 再試行を頼み、次の呼び出しで起こす
			this._evictIdleChild();
			throw new ParadisDevtoolsResourceLimitError();
		}

		const entryPath = FileAccess.asFileUri(DEVTOOLS_MCP_ENTRY).fsPath;
		const tokenFingerprint = this._tokenFingerprint(token);
		this._debug(`[ParadisDevtoolsProxy] Spawning chrome-devtools-mcp for pane ${tokenFingerprint} generation=${generation}`);
		const spawnChild = this.options.spawnChild ?? ((command, args, options) => spawn(command, args, options));
		// 起こすたびに在るかを確かめる（OS の掃除で消えていれば作り直す。作れなければ次の起動でまた試す）
		const ownTemporaryDirectory = this.options.temporaryDirectory ?? this._temporaryDirectory?.ensure();
		if (ownTemporaryDirectory === undefined) {
			this._warn('[ParadisDevtoolsProxy] Could not create a temporary folder for chrome-devtools-mcp; it keeps the default one');
		}
		// Node の os.tmpdir() は POSIX で TMPDIR→TMP→TEMP、Windows で TEMP→TMP を読む
		const temporaryEnv: NodeJS.ProcessEnv = ownTemporaryDirectory === undefined ? {} : { TMPDIR: ownTemporaryDirectory, TMP: ownTemporaryDirectory, TEMP: ownTemporaryDirectory };
		const child = spawnChild(process.execPath, [
			// 落ちたときの minidump に、どの子かの印を残す（paradisCrashRole.ts）
			...paradisCrashRoleNodeArgs('devtools-mcp', !!process.versions.electron),
			entryPath,
			`--wsEndpoint=${wsEndpoint}`,
			// テレメトリ送信（Google Clearcut / CrUX APIへのURL送信）は同梱コンポーネントとして無効化する
			'--usageStatistics=false',
			'--performanceCrux=false',
			// 座標クリック等のvisionベースツール（click_at等）を解禁する。既に許可済みの
			// Input.dispatchMouseEvent（allowlist、dispatchExactViewInput経由）で配信されるため、
			// 信頼済みイベントとして届く（座標はLLMがスクリーンショットから読み取る前提）。
			'--experimentalVision=true',
			// get_network_request などが返すヘッダのうち、許可リストに無いもの（Cookie・Set-Cookie・
			// Authorization など）を伏せる。エージェントは Cookie を読めない（q.html Q69）。ゲートウェイでも
			// CDP のイベントから Cookie を落としているので二重の備え。
			'--redactNetworkHeaders=true',
		], {
			env: {
				...process.env,
				...temporaryEnv,
				ELECTRON_RUN_AS_NODE: '1',
				CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
				// 保険: wsEndpointクエリが使えない経路に万一落ちても、macOS/Linuxではピアプロセスの
				// env読み取り（ゲートウェイの解決経路2）でペインへ紐付けられるようにしておく
				[PARADIS_PANE_TOKEN_ENV_VAR]: paradisPaneTokenOfScopeKey(token),
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		const entry: IChildEntry = {
			child,
			generation,
			wsEndpoint,
			tokenFingerprint,
			spawnedAt: Date.now(),
			temporaryDirectory: ownTemporaryDirectory ?? tmpdir(),
			completeFolders: undefined,
			lastRoots: [],
			rootsRetryTimer: undefined,
			rootsRetries: 0,
			ready: Promise.resolve(),
			pending: new Map(),
			nextId: 1,
			stdoutBuffer: Buffer.alloc(0),
			stdoutBufferLength: 0,
			stdinBackpressured: false,
			stdinDrainListener: undefined,
			stdoutDataListener: undefined,
			processErrorListener: undefined,
			processExitListener: undefined,
			processCloseListener: undefined,
			killTimer: undefined,
			idleTimer: undefined,
			killed: false,
			bornAt: this._now(),
			calls: 0,
			tracing: false,
			emulated: false,
			lastActivityAt: this._now(),
			activeTools: [],
			rssMib: undefined,
			peakRssMib: undefined,
			healthTimer: undefined,
			healthCheckRunning: false,
			stderrTail: '',
			stderrDataListener: undefined,
			keepStderrOpen: false,
			uidTag: (this.options.newUidTag ?? paradisNewUidTag)(this._issuedUidTags.get(token) ?? []),
		};
		const issuedTags = [...(this._issuedUidTags.get(token) ?? []), entry.uidTag].slice(-PARADIS_UID_TAG_HISTORY);
		this._issuedUidTags.set(token, issuedTags);
		this._childSlots.add(entry);

		entry.stdoutDataListener = (chunk: Buffer) => this._onStdout(token, entry, chunk);
		child.stdout.on('data', entry.stdoutDataListener);
		// 子プロセスのstderrは秘密情報を含み得るため、表示も送信もしない。末尾だけを手元に置き、落ちたときに
		// V8 のメモリ不足の行から数値だけを抜く（paradisParseV8FatalStderr）。
		entry.stderrDataListener = (chunk: Buffer) => {
			entry.stderrTail = paradisAppendStderrTail(entry.stderrTail, chunk.toString('utf8'));
		};
		child.stderr.on('data', entry.stderrDataListener);
		entry.processErrorListener = (error: Error) => {
			this._warn(`[ParadisDevtoolsProxy] chrome-devtools-mcp process error for pane ${tokenFingerprint} generation=${generation}`);
			// spawn failures (ENOENT, EACCES) never reach the exit listener's report; `code` is the errno name only.
			const code = (error as NodeJS.ErrnoException).code;
			reportParadisDiagnosticError('owned', 'agent-browser', 'devtools-child-error', error, {
				duration_ms: Date.now() - entry.spawnedAt,
				...(typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code) ? { safe_errno: code } : {}),
			});
			this._killChild(token, entry, 'process error');
		};
		entry.processExitListener = (code, signal) => {
			if (!entry.killed) {
				this._debug(`[ParadisDevtoolsProxy] chrome-devtools-mcp for pane ${tokenFingerprint} generation=${generation} exited (code=${code}, signal=${signal})`);
				// Not one of our kills (idle, retire, generation change): the bridge died under the agent.
				this._reportUnexpectedExit(entry, code, signal);
				this._markReplaced(token, entry, 'exited');
				// 応答待ちの呼び出しは、読むだけのツールなら新しい子プロセスで呼び直す（tryCallTool）
				this._cleanupEntry(token, entry, `process exited (code=${code}, signal=${signal})`, new ParadisDevtoolsChildExitedError());
			} else {
				this._cleanupEntry(token, entry, `process exited (code=${code}, signal=${signal})`);
			}
			this._releaseChildSlot(entry);
		};
		entry.processCloseListener = (code, signal) => {
			this._cleanupEntry(token, entry, `process closed (code=${code}, signal=${signal})`);
			this._releaseChildSlot(entry);
		};
		child.on('error', entry.processErrorListener);
		child.on('exit', entry.processExitListener);
		child.on('close', entry.processCloseListener);
		this._children.set(token, entry);
		this._resetIdleTimer(token, entry);
		entry.healthTimer = setInterval(() => void this._checkHealth(token, entry), this._limit(this.options.healthIntervalMs, PARADIS_DEVTOOLS_HEALTH_INTERVAL_MS));

		// initialize ハンドシェイク（応答確認後に initialized 通知を送る）
		entry.ready = this._request(token, entry, 'initialize', {
			protocolVersion: '2024-11-05',
			// roots を名乗らないと vendored は roots/list を呼ばず、validatePath が何も確かめない。
			// ペインのフォルダが遅れて引けたときに取り直させるので、変更通知（listChanged）を出す
			capabilities: { roots: { listChanged: true } },
			clientInfo: { name: 'para-code-agent-browser', version: '1.0.0' },
		}, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS).then(() => {
			if (!this._send(token, entry, { jsonrpc: '2.0', method: 'notifications/initialized' })) {
				this._killChild(token, entry, 'failed to send initialized notification', new ParadisDevtoolsResourceLimitError());
			}
		});
		// ready の失敗は _request 側で pending 経由でも観測されるため、未処理拒否だけ握りつぶす
		entry.ready.catch(() => { });

		return entry;
	}

	private _onStdout(token: string, entry: IChildEntry, chunk: Buffer): void {
		if (entry.killed) {
			return;
		}
		const maxBufferBytes = this._limit(this.options.maxStdoutBufferBytes, MAX_STDOUT_BUFFER_BYTES);
		let offset = 0;
		while (offset < chunk.byteLength) {
			const newlineIndex = chunk.indexOf(0x0A, offset);
			const segmentEnd = newlineIndex >= 0 ? newlineIndex + 1 : chunk.byteLength;
			const segment = chunk.subarray(offset, segmentEnd);
			const requiredBytes = entry.stdoutBufferLength + segment.byteLength;
			if (requiredBytes > maxBufferBytes) {
				entry.stdoutBuffer = Buffer.alloc(0);
				entry.stdoutBufferLength = 0;
				this._killChild(token, entry, 'stdout buffer resource limit reached', new ParadisDevtoolsResourceLimitError());
				return;
			}
			if (entry.stdoutBuffer.byteLength < requiredBytes) {
				const capacity = Math.min(maxBufferBytes, Math.max(requiredBytes, Math.max(1024, entry.stdoutBuffer.byteLength * 2)));
				const expanded = Buffer.allocUnsafe(capacity);
				entry.stdoutBuffer.copy(expanded, 0, 0, entry.stdoutBufferLength);
				entry.stdoutBuffer = expanded;
			}
			segment.copy(entry.stdoutBuffer, entry.stdoutBufferLength);
			entry.stdoutBufferLength = requiredBytes;
			offset = segmentEnd;
			if (newlineIndex < 0) {
				return;
			}
			const line = entry.stdoutBuffer.subarray(0, entry.stdoutBufferLength - 1).toString('utf8').trim();
			entry.stdoutBufferLength = 0;
			if (!line) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				this._trace(`[ParadisDevtoolsProxy] Ignoring non-JSON stdout line for pane ${entry.tokenFingerprint} generation=${entry.generation}`);
				continue;
			}
			if (!this._isRecord(parsed)) {
				this._trace(`[ParadisDevtoolsProxy] Ignoring non-object stdout message for pane ${entry.tokenFingerprint} generation=${entry.generation}`);
				continue;
			}
			const message = parsed;
			const method = message.method;
			if (method !== undefined && typeof method !== 'string') {
				this._trace(`[ParadisDevtoolsProxy] Ignoring malformed stdout message for pane ${entry.tokenFingerprint} generation=${entry.generation}`);
				continue;
			}
			const hasRequestId = typeof message.id === 'number' || typeof message.id === 'string';
			if (typeof method === 'string' && hasRequestId) {
				// サーバー→クライアント要求。roots/list は非同期に答える（エラーでは答えない。エラーだと
				// vendored は roots を未設定のままにし、パスを何も確かめなくなる）
				if (method === 'roots/list') {
					this._answerRoots(token, entry, message.id as number | string);
					continue;
				}
				const response = method === 'ping'
					? { jsonrpc: '2.0', id: message.id, result: {} }
					: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${method}` } };
				if (!this._send(token, entry, response)) {
					this._killChild(token, entry, 'failed to send child response', new ParadisDevtoolsResourceLimitError());
					return;
				}
				continue;
			}
			if (typeof method === 'string') {
				// 通知（logging等）は読み捨てる
				continue;
			}
			const pending = typeof message.id === 'number' ? entry.pending.get(message.id) : undefined;
			if (!pending) {
				continue;
			}
			const responseError = message.error;
			if (responseError !== undefined) {
				if (!this._isRecord(responseError)) {
					pending.reject(new ParadisDevtoolsUnavailableError());
					continue;
				}
				pending.reject(new ParadisDevtoolsUnavailableError(typeof responseError.code === 'number' ? responseError.code : undefined));
			} else {
				pending.resolve(message.result);
			}
		}
	}

	/**
	 * `roots/list` に答える。ペインのフォルダの解決に失敗・時間切れしても、一時フォルダだけの一覧で必ず答える
	 * （エラーで答えると vendored は roots を未設定のままにし、パスを何も確かめなくなる）。
	 * 一度揃ったフォルダは以後の応答すべてに使う。解決の遅い先の要求（初期化時のもの）の応答が、後の要求の
	 * 正しい応答の後に届いても、揃ったフォルダで答えるので上書きにならない。
	 */
	private _answerRoots(token: string, entry: IChildEntry, id: number | string): void {
		const answer = (folders: readonly string[]) => {
			if (entry.killed) {
				return;
			}
			entry.lastRoots = paradisDevtoolsRoots(entry.completeFolders ?? folders, entry.temporaryDirectory, dropped => this._warnRootsOverflow(entry, dropped));
			if (!this._send(token, entry, { jsonrpc: '2.0', id, result: { roots: entry.lastRoots } })) {
				this._killChild(token, entry, 'failed to send roots', new ParadisDevtoolsResourceLimitError());
			}
		};
		if (entry.completeFolders !== undefined) {
			answer(entry.completeFolders);
			return;
		}
		this._resolveRootFolders(token).then(resolution => {
			if (resolution.complete && entry.completeFolders === undefined) {
				entry.completeFolders = resolution.folders;
			}
			answer(resolution.folders);
			if (entry.completeFolders === undefined) {
				this._scheduleRootsRetry(token, entry);
			}
		}).catch(() => {
			answer([]);
			this._scheduleRootsRetry(token, entry);
		});
	}

	/** ペインのフォルダを引く。失敗・時間切れは「揃っていない空」として返し、reject しない。 */
	private _resolveRootFolders(token: string): Promise<IParadisDevtoolsRootsResolution> {
		const resolveRoots = this.options.resolveRoots;
		if (resolveRoots === undefined) {
			return Promise.resolve({ folders: [], complete: true });
		}
		const degraded: IParadisDevtoolsRootsResolution = { folders: [], complete: false };
		let timer: ReturnType<typeof setTimeout> | undefined;
		return Promise.race([
			Promise.resolve().then(() => resolveRoots(token)).then(
				resolution => resolution && Array.isArray(resolution.folders) ? resolution : degraded,
				() => degraded,
			),
			new Promise<IParadisDevtoolsRootsResolution>(resolve => {
				timer = setTimeout(() => resolve(degraded), this._limit(this.options.rootsTimeoutMs, ROOTS_RESOLVE_TIMEOUT_MS));
			}),
		]).finally(() => clearTimeout(timer));
	}

	/**
	 * フォルダが揃わないまま答えたとき、少し置いて引き直す。揃ったら `notifications/roots/list_changed` を送る
	 * （vendored はこの通知で `roots/list` を取り直す）。
	 */
	private _scheduleRootsRetry(token: string, entry: IChildEntry): void {
		if (entry.killed || entry.rootsRetryTimer !== undefined || entry.completeFolders !== undefined || entry.rootsRetries >= MAX_ROOTS_RETRIES) {
			return;
		}
		const delay = this._limit(this.options.rootsRetryDelayMs, ROOTS_RETRY_DELAY_MS) * 2 ** entry.rootsRetries;
		entry.rootsRetries++;
		entry.rootsRetryTimer = setTimeout(() => {
			entry.rootsRetryTimer = undefined;
			if (entry.killed) {
				return;
			}
			void this._resolveRootFolders(token).then(resolution => {
				if (entry.killed || entry.completeFolders !== undefined) {
					return;
				}
				if (!resolution.complete) {
					this._scheduleRootsRetry(token, entry);
					return;
				}
				entry.completeFolders = resolution.folders;
				if (!this._send(token, entry, { jsonrpc: '2.0', method: 'notifications/roots/list_changed' })) {
					this._killChild(token, entry, 'failed to send roots change', new ParadisDevtoolsResourceLimitError());
				}
			});
		}, delay);
	}

	private _warnRootsOverflow(entry: IChildEntry, dropped: number): void {
		this._warn(`[ParadisDevtoolsProxy] ${dropped} workspace folder(s) were left out of the chrome-devtools-mcp roots for pane ${entry.tokenFingerprint} (too many folders)`);
	}

	private _request(token: string, entry: IChildEntry, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			if (entry.killed) {
				reject(new Error('chrome-devtools-mcp process is not running'));
				return;
			}
			if (entry.pending.size >= this._limit(this.options.maxPendingRequests, MAX_PENDING_REQUESTS) || entry.stdinBackpressured) {
				reject(new ParadisDevtoolsResourceLimitError());
				return;
			}
			const id = entry.nextId++;
			let settled = false;
			const cleanup = (): boolean => {
				if (settled) {
					return false;
				}
				settled = true;
				clearTimeout(timer);
				entry.pending.delete(id);
				signal?.removeEventListener('abort', onAbort);
				return true;
			};
			const resolveOnce = (value: unknown): void => {
				if (cleanup()) {
					resolve(value);
				}
			};
			const rejectOnce = (error: Error): void => {
				if (cleanup()) {
					reject(error);
				}
			};
			const failAndKill = (reason: string): void => {
				if (!cleanup()) {
					return;
				}
				reject(new Error(reason));
				this._killChild(token, entry, reason);
			};
			const onAbort = (): void => failAndKill(`${method} aborted by client`);
			const timer = setTimeout(() => failAndKill(`${method} timed out after ${timeoutMs}ms`), timeoutMs);
			entry.pending.set(id, { resolve: resolveOnce, reject: rejectOnce });
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			if (!this._send(token, entry, { jsonrpc: '2.0', id, method, params })) {
				rejectOnce(new ParadisDevtoolsResourceLimitError());
			}
		});
	}

	private _awaitReady(token: string, entry: IChildEntry, signal?: AbortSignal): Promise<void> {
		if (!signal) {
			return entry.ready;
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) {
					return;
				}
				settled = true;
				signal.removeEventListener('abort', onAbort);
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};
			const onAbort = (): void => {
				finish(new Error('initialize aborted by client'));
				this._killChild(token, entry, 'initialize aborted by client');
			};
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
			entry.ready.then(() => finish(), error => finish(error instanceof Error ? error : new Error(String(error))));
		});
	}

	private _send(token: string, entry: IChildEntry, message: unknown): boolean {
		if (entry.killed || entry.stdinBackpressured) {
			return false;
		}
		let payload: string;
		try {
			payload = JSON.stringify(message) + '\n';
		} catch {
			return false;
		}
		const maxQueuedBytes = this._limit(this.options.maxStdinQueuedBytes, MAX_STDIN_QUEUED_BYTES);
		const queuedBytes = Math.max(0, entry.child.stdin.writableLength);
		const payloadBytes = Buffer.byteLength(payload);
		if (queuedBytes > maxQueuedBytes) {
			this._killChild(token, entry, 'stdin queue resource limit exceeded', new ParadisDevtoolsResourceLimitError());
			return false;
		}
		if (payloadBytes > maxQueuedBytes - queuedBytes) {
			return false;
		}
		try {
			const acceptsMore = entry.child.stdin.write(payload);
			if (entry.child.stdin.writableLength > maxQueuedBytes) {
				this._killChild(token, entry, 'stdin queue resource limit exceeded', new ParadisDevtoolsResourceLimitError());
				return false;
			}
			if (!acceptsMore) {
				entry.stdinBackpressured = true;
				entry.stdinDrainListener = () => {
					entry.stdinDrainListener = undefined;
					if (!entry.killed) {
						entry.stdinBackpressured = false;
					}
				};
				entry.child.stdin.once('drain', entry.stdinDrainListener);
			}
			return true;
		} catch {
			this._warn(`[ParadisDevtoolsProxy] Failed to write to chrome-devtools-mcp stdin for pane ${entry.tokenFingerprint} generation=${entry.generation}`);
			this._killChild(token, entry, 'stdin write failed', new ParadisDevtoolsResourceLimitError());
			return false;
		}
	}

	/**
	 * 子プロセスの数が上限のとき、使っていない（応答待ちが無く、{@link PARADIS_DEVTOOLS_RECYCLE_QUIET_MS} 以上呼ばれていない）
	 * 子のうち最後に使ったのが一番古いものを止める。止めると消える状態（実行中の trace・emulate の設定）を持つ子は、
	 * 持たない子が無いときだけ止める。止めている途中の子がもうあれば、それが終わるのを待つ（続けて止めない）。
	 */
	private _evictIdleChild(): void {
		if ([...this._childSlots].some(entry => entry.killed)) {
			return;
		}
		const now = this._now();
		const quietMs = this.options.recycleQuietMs ?? PARADIS_DEVTOOLS_RECYCLE_QUIET_MS;
		let oldest: [string, IChildEntry] | undefined;
		for (const [token, entry] of this._children) {
			if (entry.killed || entry.pending.size > 0 || entry.activeTools.length > 0 || (this._inFlight.get(token) ?? 0) > 0
				|| now - entry.lastActivityAt < quietMs) {
				continue;
			}
			const keeps = entry.tracing || entry.emulated;
			const oldestKeeps = oldest !== undefined && (oldest[1].tracing || oldest[1].emulated);
			if (oldest === undefined || (oldestKeeps && !keeps) || (oldestKeeps === keeps && entry.lastActivityAt < oldest[1].lastActivityAt)) {
				oldest = [token, entry];
			}
		}
		if (oldest !== undefined) {
			const [token, entry] = oldest;
			this._debug(`[ParadisDevtoolsProxy] Stopping the least recently used chrome-devtools-mcp for pane ${entry.tokenFingerprint} to make room`);
			this._markReplaced(token, entry, 'evicted');
			this._killChild(token, entry, 'evicted at the child cap');
		}
	}

	private _resetIdleTimer(token: string, entry: IChildEntry): void {
		if (entry.idleTimer !== undefined) {
			clearTimeout(entry.idleTimer);
		}
		entry.idleTimer = setTimeout(() => {
			this._debug(`[ParadisDevtoolsProxy] Killing idle chrome-devtools-mcp for pane ${entry.tokenFingerprint} generation=${entry.generation}`);
			this._markReplaced(token, entry, 'idle');
			this._killChild(token, entry, 'idle timeout');
		}, IDLE_KILL_MS);
	}

	private _killChild(token: string, entry: IChildEntry, reason: string, pendingError?: Error): void {
		if (entry.killed) {
			return;
		}
		this._cleanupEntry(token, entry, reason, pendingError);
		try {
			entry.child.kill();
		} catch {
			// 既に終了している場合は無視
		}
		if (this._childSlots.has(entry)) {
			entry.killTimer = setTimeout(() => {
				entry.killTimer = undefined;
				if (!this._childSlots.has(entry)) {
					return;
				}
				try {
					entry.child.kill('SIGKILL');
				} catch {
					// exit/close未確認ならslotは保守的に保持する
				}
			}, this._limit(this.options.killGraceTimeoutMs, KILL_GRACE_TIMEOUT_MS));
		}
	}

	private _cleanupEntry(token: string, entry: IChildEntry, _reason: string, pendingError: Error = new Error(TERMINATED_ERROR_MESSAGE)): void {
		if (entry.killed) {
			return;
		}
		entry.killed = true;
		if (entry.idleTimer !== undefined) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
		}
		if (entry.rootsRetryTimer !== undefined) {
			clearTimeout(entry.rootsRetryTimer);
			entry.rootsRetryTimer = undefined;
		}
		if (entry.healthTimer !== undefined) {
			clearInterval(entry.healthTimer);
			entry.healthTimer = undefined;
		}
		if (entry.stdoutDataListener) {
			entry.child.stdout.removeListener('data', entry.stdoutDataListener);
			entry.stdoutDataListener = undefined;
		}
		if (entry.stdinDrainListener) {
			entry.child.stdin.removeListener('drain', entry.stdinDrainListener);
			entry.stdinDrainListener = undefined;
		}
		entry.stdinBackpressured = false;
		entry.stdoutBuffer = Buffer.alloc(0);
		entry.stdoutBufferLength = 0;
		if (this._children.get(token) === entry) {
			this._children.delete(token);
		}
		for (const pending of [...entry.pending.values()]) {
			try {
				pending.reject(pendingError);
			} catch {
				// cleanupは診断・consumer側の例外に左右されず最後まで行う
			}
		}
		entry.pending.clear();
		if (!entry.keepStderrOpen && entry.stderrDataListener) {
			entry.child.stderr.removeListener('data', entry.stderrDataListener);
			entry.stderrDataListener = undefined;
			entry.stderrTail = '';
		}
		// 落ちた子プロセスの標準エラーは、残りを読み終えるまで閉じない（_reportUnexpectedExit が閉じる）
		for (const stream of entry.keepStderrOpen ? [entry.child.stdin, entry.child.stdout] : [entry.child.stdin, entry.child.stdout, entry.child.stderr]) {
			try {
				stream.destroy();
			} catch {
				// 既にclose済みなら無視
			}
		}
	}

	private _releaseChildSlot(entry: IChildEntry): void {
		if (!this._childSlots.delete(entry)) {
			return;
		}
		if (entry.killTimer !== undefined) {
			clearTimeout(entry.killTimer);
			entry.killTimer = undefined;
		}
		if (entry.processErrorListener) {
			entry.child.removeListener('error', entry.processErrorListener);
			entry.processErrorListener = undefined;
		}
		if (entry.processExitListener) {
			entry.child.removeListener('exit', entry.processExitListener);
			entry.processExitListener = undefined;
		}
		if (entry.processCloseListener) {
			entry.child.removeListener('close', entry.processCloseListener);
			entry.processCloseListener = undefined;
		}
	}

	private _limit(value: number | undefined, fallback: number): number {
		return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
	}

	private _throwIfDisposed(): void {
		if (this._disposed) {
			throw new ParadisDevtoolsUnavailableError();
		}
	}

	private _isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	private _isProxiedTool(value: unknown): value is IParadisProxiedTool {
		return this._isRecord(value) && typeof value.name === 'string';
	}

	private _deepFreeze<T>(root: T): T {
		if (typeof root !== 'object' || root === null) {
			return root;
		}
		const pending: object[] = [root];
		const visited = new Set<object>();
		while (pending.length > 0) {
			const value = pending.pop()!;
			if (visited.has(value)) {
				continue;
			}
			visited.add(value);
			for (const nested of Object.values(value)) {
				if (typeof nested === 'object' && nested !== null) {
					pending.push(nested);
				}
			}
			Object.freeze(value);
		}
		return root;
	}

	private _debug(message: string): void {
		try {
			this.logService.debug(message);
		} catch {
			// 診断失敗で子プロセス管理を中断しない
		}
	}

	private _trace(message: string): void {
		try {
			this.logService.trace(message);
		} catch {
			// 診断失敗で子プロセス管理を中断しない
		}
	}

	private _warn(message: string): void {
		try {
			this.logService.warn(message);
		} catch {
			// 診断失敗で子プロセス管理を中断しない
		}
	}

	private _tokenFingerprint(token: string): string {
		return createHash('sha256').update(token).digest('hex').slice(0, 12);
	}

	private _toolCallError(name: string, error: unknown): unknown {
		const message = error instanceof StaleParadisDevtoolsGenerationError || error instanceof ParadisDevtoolsResourceLimitError || error instanceof ParadisDevtoolsUnavailableError
			? error.message
			: TERMINATED_ERROR_MESSAGE;
		return {
			content: [{ type: 'text', text: `chrome-devtools tool "${name}" failed: ${message}` }],
			isError: true,
		};
	}

	private _observeGeneration(token: string, generation: number): void {
		const highWatermark = this._generationHighWatermarks.get(token);
		if (highWatermark !== undefined && generation < highWatermark) {
			throw new StaleParadisDevtoolsGenerationError();
		}
		if (highWatermark === undefined || generation > highWatermark) {
			if (highWatermark === undefined && this._childSlots.size >= this._limit(this.options.maxChildren, MAX_CHILDREN)) {
				return;
			}
			if (highWatermark === undefined && this._generationHighWatermarks.size >= this._limit(this.options.maxGenerationHighWatermarks, MAX_GENERATION_HIGH_WATERMARKS)) {
				throw new ParadisDevtoolsResourceLimitError();
			}
			this._generationHighWatermarks.set(token, generation);
			const entry = this._children.get(token);
			if (entry && entry.generation < generation) {
				this._killChild(token, entry, 'newer binding generation observed');
			}
		}
	}
}
