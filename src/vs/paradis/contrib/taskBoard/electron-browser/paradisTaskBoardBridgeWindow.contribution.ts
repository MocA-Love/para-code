/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボードの接続口のウィンドウ側。shared process（taskBoard/node）が ctx でこのウィンドウを選んで呼ぶ
// チャネルを登録し、起動・入力・回答・画面の読み取り・閉じるを、このウィンドウのターミナルで行う。
// ボードが起動したターミナルの状態を見張り、変わったら shared process へ報告する（SSE で流れる）。
//
// 入力の安全側の規則はチャット表示（agentChat）と同じに倒す:
//  - 文は、エージェントが入力待ち（idle / review）で、確認の画面が出ていないときだけ送る
//  - 質問・許可の回答は ParadisAgentChatInput（画面に目印が出たのを確かめて打鍵する。claim つき）で送る
// ペイントークンは shared process の外（ボード）へ出さない。ID はトークンのハッシュ。

import { IntervalTimer, timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IChannel, IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisCollectLivePaneInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { IParadisAgentChatSource, IParadisAgentChatMessage, paradisAgentQuestionHasPreview } from '../../agentChat/common/paradisAgentChat.js';
import { paradisPendingCodexQuestion } from '../../agentChat/common/paradisAgentChatTimeline.js';
import { IParadisAgentChatTerminal, ParadisAgentChatInput, paradisCodexApprovalFormOptions, paradisIsShellProcessName } from '../../agentChat/browser/paradisAgentChatInput.js';
import { ParadisAgentChatSession } from '../../agentChat/browser/paradisAgentChatSession.js';
import { paradisScreenShowsAgentPrompt, paradisVisibleTerminalText } from '../../agentChat/browser/paradisAgentTuiInput.js';
import { paradisTerminalRunsAgent } from '../../agentIde/browser/paradisAgentIdeTerminalInput.js';
import { IParadisAgentChoiceMenu } from '../../agentIde/common/paradisAgentChoiceMenu.js';
import { PARADIS_AGENT_IDE_LAUNCH_GRACE_MS, paradisAgentIdeChoiceMenuOf, paradisAgentIdeKeySequence, paradisAgentIdeStatusLabel, paradisAgentIdeTailLines } from '../../agentIde/common/paradisAgentIde.js';
import { paradisAgentStartupScreenState, paradisTrustDialogCursor } from '../../agentIde/common/paradisAgentStartupScreen.js';
import { IParadisAgentModelCatalogService } from '../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { paradisCodexApprovalFormShown, paradisSplitCodexFormOption } from '../../mobileRelay/common/paradisAgentApprovalOptions.js';
import { paradisStripAgentInvisibleCharacters } from '../../mobileRelay/common/paradisAgentInvisibleText.js';
import { paradisSendAgentMessageToTui } from '../../mobileRelay/common/paradisAgentMessageSender.js';
import { ParadisAgentQuestionAnswer } from '../../mobileRelay/common/paradisAgentQuestionKeys.js';
import { PARADIS_MOBILE_RELAY_CHANNEL } from '../../mobileRelay/common/paradisMobileRelay.js';
import { paradisScheduledRunLaunchPrompt } from '../../scheduledRuns/common/paradisScheduledRuns.js';
import { paradisBuildPresetInsertText } from '../../terminalPresets/common/paradisTerminalPresets.js';
import { IParadisAgentStatusStore, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisAgentPromptQuotingError } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { paradisLaunchAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import {
	IParadisTaskBoardAnswerRequest,
	IParadisTaskBoardExitWatch,
	IParadisTaskBoardKeyRequest,
	IParadisTaskBoardLaunchRequest,
	IParadisTaskBoardQuestionPayload,
	IParadisTaskBoardScreen,
	IParadisTaskBoardSendRequest,
	IParadisTaskBoardStatusReport,
	IParadisTaskBoardWindowDescription,
	PARADIS_TASK_BOARD_BRIDGE_CHANNEL,
	PARADIS_TASK_BOARD_WINDOW_CHANNEL,
	ParadisTaskBoardResult,
	ParadisTaskBoardTerminalStatus,
	paradisParseTaskBoardAnswer,
	paradisParseTaskBoardKey,
	paradisParseTaskBoardLaunch,
	paradisParseTaskBoardSend,
	paradisParseTaskBoardTerminalOnly,
	paradisTaskBoardAgentExitConfirmed,
	paradisTaskBoardApprovalChoices,
	paradisTaskBoardConfirmAgentExit,
	paradisTaskBoardFail,
	paradisTaskBoardIsLastingApproval,
	paradisTaskBoardKeyBlockedOnApprovalForm,
	paradisTaskBoardMissingTerminalExited,
	paradisTaskBoardSamePath,
	paradisTaskBoardSendBlock,
	paradisTaskBoardStatusFrom,
	paradisTaskBoardTerminalId,
} from '../common/paradisTaskBoardBridge.js';

/** 状態を見直す間隔（Codex の選択画面は hook の後に描かれ、状態の変化の知らせが無い）。 */
const POLL_INTERVAL_MS = 2_000;
/** 中継へ「このペインの質問を拾って」と頼み直す間隔（チャット表示と同じ）。 */
const WATCH_RENEW_INTERVAL_MS = 10_000;
/** 報告を shared process に断られ続けたら（台帳に無い）見張りをやめる回数。 */
const MAX_REJECTED_REPORTS = 5;
/** 画面の読み取りで、見えている範囲の上に足す行数。 */
const SCREEN_EXTRA_LINES = 200;
const ANSWER_DIGIT_LIMIT = 9;
/** 信頼の確認で、承諾の行までカーソルを動かす回数の上限（選択肢は 2 つなので 1 回で足りるはず）。 */
const TRUST_CURSOR_MAX_STEPS = 4;
/** 矢印を送ってから画面が描き直されるのを待つ時間。 */
const TRUST_CURSOR_SETTLE_MS = 100;
/** 矢印の後、画面が描き直されるのを待つ上限。 */
const TRUST_CURSOR_REDRAW_LIMIT_MS = 2_000;

/** 見張っているボードのターミナル 1 つ。 */
interface IWatchedTerminal {
	readonly terminal: string;
	/** このウィンドウで起動した時刻（再読み込みの後に戻したものは undefined）。 */
	readonly launchedAt: number | undefined;
	/** 指示を渡して起動した（最初の hook までは作業中とみなす）。 */
	readonly prompted: boolean;
	sawAgentStatus: boolean;
	sawAgent: boolean;
	/** 前面がシェルへ戻ったのを続けて見ているか（終わりと決めるのは続いたときだけ）。 */
	readonly exitWatch: IParadisTaskBoardExitWatch;
	missingSince?: number;
	/** 見張っていた instance が破棄された時刻（同じペインが別の instance で戻れば消す）。 */
	disposedAt?: number;
	instanceId?: number;
	listener?: IDisposable;
	lastSent?: string;
	rejected: number;
	/** 許可の確認として出した、画面の番号の選択肢（Codex の MCP のツールの許可）。回答で同じ承認・同じ文言かを確かめる。 */
	approvalOptions?: { readonly interactionId: string; readonly options: readonly { readonly n: number; readonly label: string }[] };
}

interface IResolvedTerminal {
	readonly instance: ITerminalInstance;
	readonly token: string;
}

interface IComputedStatus {
	readonly status: ParadisTaskBoardTerminalStatus;
	/** 画面から分かった中身（信頼の確認・選択画面）。質問・許可の中身は会話から別に取る。 */
	readonly question?: IParadisTaskBoardQuestionPayload;
	readonly choiceMenu?: IParadisAgentChoiceMenu;
	readonly trustDialog: boolean;
	/** 前面がシェルへ戻って見える（終わりとはまだ決めていなくても、文はシェルへ打ち込まれうる）。 */
	readonly shellBack: boolean;
}

type Result<T> = ParadisTaskBoardResult<T>;

function success<T>(value: T): Result<T> {
	return { ok: true, value };
}

/** 窓口の控え（ターミナルが閉じれば消える）。 */
const chatTerminals = new WeakMap<ITerminalInstance, IParadisAgentChatTerminal>();

/**
 * 回答・送信に使うターミナルの窓口。同じターミナルには同じものを返す（ParadisAgentChatInput は送る前と各キーの
 * 前に、送り先が同じものかを `!==` で比べる。毎回作ると必ず「送り先のターミナルが変わりました」で止まり、
 * ボードからキーで答える許可と質問がすべて送れなかった）。
 */
function chatTerminalFor(instance: ITerminalInstance): IParadisAgentChatTerminal {
	let terminal = chatTerminals.get(instance);
	if (terminal === undefined) {
		terminal = createChatTerminal(instance);
		chatTerminals.set(instance, terminal);
	}
	return terminal;
}

/** ITerminalInstance を、チャットの入力が使う形へ写す（agentChat の写しと同じ規則）。 */
function createChatTerminal(instance: ITerminalInstance): IParadisAgentChatTerminal {
	return {
		sendText: (text, shouldExecute, bracketedPasteMode) => instance.sendText(text, shouldExecute, bracketedPasteMode),
		readScreen: () => paradisVisibleTerminalText(instance),
		foreground: () => {
			const processName = instance.processName.trim();
			if (processName.length > 0) {
				return paradisIsShellProcessName(processName) ? 'shell' : 'agent';
			}
			return paradisTerminalRunsAgent(instance) ? 'agent' : 'unknown';
		},
		bracketedPasteMode: () => instance.xterm?.raw.modes.bracketedPasteMode === true,
	};
}

/** 見えている画面とその上 `extraLines` 行。折り返しでできた行は元の 1 行へつなぐ。読めなければ undefined。 */
function readScreen(instance: ITerminalInstance, extraLines: number): string | undefined {
	const raw = instance.xterm?.raw;
	if (!raw) {
		return undefined;
	}
	const buffer = raw.buffer.active;
	const limit = raw.rows + extraLines;
	const start = Math.max(0, buffer.length - limit * 4);
	const logical: string[] = [];
	for (let y = start; y < buffer.length; y++) {
		const line = buffer.getLine(y);
		if (!line) {
			continue;
		}
		const text = line.translateToString(true);
		if (line.isWrapped && logical.length > 0) {
			logical[logical.length - 1] += text;
		} else {
			logical.push(text);
		}
	}
	return paradisAgentIdeTailLines(logical, limit);
}

export class ParadisTaskBoardBridgeWindow extends Disposable implements IWorkbenchContribution, IServerChannel<string> {

	static readonly ID = 'workbench.contrib.paradisTaskBoardBridgeWindow';

	private readonly bridge: IChannel;
	private readonly source: IParadisAgentChatSource;
	private readonly input: ParadisAgentChatInput;
	private readonly sessions = this._register(new DisposableMap<string, ParadisAgentChatSession>());
	private readonly watched = new Map<string, IWatchedTerminal>();
	private readonly idCache = new Map<string, string>();
	private readonly watcherId = generateUuid();
	/** ウィンドウを閉じる・再読み込みする途中（ターミナルの片付けを「終わった」と報告しない）。 */
	private shuttingDown = false;
	private polling = false;
	private pollAgain = false;
	private readonly ready: Promise<void>;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisAgentStatusStore private readonly statusStore: IParadisAgentStatusStore,
		@IParadisWorkspaceSwitchService private readonly switchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IParadisAgentModelCatalogService private readonly modelCatalogService: IParadisAgentModelCatalogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHostService private readonly hostService: IHostService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		this.bridge = sharedProcessService.getChannel(PARADIS_TASK_BOARD_BRIDGE_CHANNEL);
		this.source = ProxyChannel.toService<IParadisAgentChatSource>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));
		this.input = new ParadisAgentChatInput({
			source: this.source,
			terminal: (instanceId, token) => {
				const resolved = this.resolveByToken(token);
				return resolved && resolved.instance.instanceId === instanceId ? chatTerminalFor(resolved.instance) : undefined;
			},
			session: token => this.session(token),
		});
		sharedProcessService.registerChannel(PARADIS_TASK_BOARD_WINDOW_CHANNEL, this);

		this._register(this.statusStore.onDidChangeAgentStatuses(() => this.poll()));
		// 再読み込みではターミナルは常駐側で生き続ける。閉じる途中の片付けを終わりとして報告しない
		// （ウィンドウごと閉じたなら、shared process が接続の切れたのを見て終わりにする）
		this._register(lifecycleService.onWillShutdown(() => this.shuttingDown = true));
		const poll = this._register(new IntervalTimer());
		poll.cancelAndSet(() => this.poll(), POLL_INTERVAL_MS);
		const renew = this._register(new IntervalTimer());
		renew.cancelAndSet(() => this.renewWatch(), WATCH_RENEW_INTERVAL_MS);
		this._register(toDisposable(() => {
			for (const watched of this.watched.values()) {
				watched.listener?.dispose();
			}
			this.watched.clear();
			void this.source.watchAgentChat(this.watcherId, []).catch(() => undefined);
		}));

		this.ready = this.initialize();
	}

	private async initialize(): Promise<void> {
		// リポジトリ一覧とターミナルの復元が済むまで待つ（済む前に起動すると、復元の途中のスペースへ足すことになる）
		try {
			await Promise.all([this.worktreeService.initializationBarrier, this.terminalService.whenConnected]);
		} catch (error) {
			this.logService.warn('[ParadisTaskBoardBridge] waiting for the window to be ready failed', error);
		}
		if (this._store.isDisposed) {
			return;
		}
		// 再読み込みの後: このウィンドウが受け持っていたボードのターミナルの見張りを戻す
		try {
			const terminals = await this.bridge.call<string[]>('listWindowTerminals');
			for (const terminal of terminals ?? []) {
				this.watch(terminal, undefined, false);
			}
		} catch (error) {
			this.logService.warn('[ParadisTaskBoardBridge] could not read the board terminals of this window', error);
		}
	}

	// --- チャネル（shared process から） --------------------------------------------------------

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: string, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		switch (command) {
			case 'describe': return this.describe() as T;
			case 'launch': {
				const parsed = paradisParseTaskBoardLaunch(arg);
				return (parsed.ok ? await this.launch(parsed.value, cancellationToken ?? CancellationToken.None) : parsed) as T;
			}
			case 'send': {
				const parsed = paradisParseTaskBoardSend(arg);
				return (parsed.ok ? await this.send(parsed.value) : parsed) as T;
			}
			case 'key': {
				const parsed = paradisParseTaskBoardKey(arg);
				return (parsed.ok ? await this.key(parsed.value) : parsed) as T;
			}
			case 'answer': {
				const parsed = paradisParseTaskBoardAnswer(arg);
				return (parsed.ok ? await this.answer(parsed.value) : parsed) as T;
			}
			case 'screen': {
				const parsed = paradisParseTaskBoardTerminalOnly(arg);
				return (parsed.ok ? this.screen(parsed.value.terminal) : parsed) as T;
			}
			case 'close': {
				const parsed = paradisParseTaskBoardTerminalOnly(arg);
				return (parsed.ok ? this.close(parsed.value.terminal) : parsed) as T;
			}
		}
		throw new Error(`Call not found: ${command}`);
	}

	private describe(): IParadisTaskBoardWindowDescription {
		const repositories = this.switchService.repositories
			.filter(repository => repository.uri.scheme === Schemas.file)
			.map(repository => ({ path: repository.uri.fsPath, name: repository.name }));
		const spaces = paradisListSpaces(this.switchService.repositories, this.worktreeService)
			.filter(space => space.uri.scheme === Schemas.file)
			.map(space => ({ path: space.uri.fsPath, name: space.name }));
		return { focused: this.hostService.hasFocus, canAddRepository: this.contextService.getWorkbenchState() === WorkbenchState.WORKSPACE, remote: this.environmentService.remoteAuthority !== undefined, repositories, spaces };
	}

	// --- ターミナルの特定 ---------------------------------------------------------------------

	private idOf(token: string): string {
		let id = this.idCache.get(token);
		if (id === undefined) {
			id = paradisTaskBoardTerminalId(token);
			if (this.idCache.size > 1000) {
				this.idCache.clear();
			}
			this.idCache.set(token, id);
		}
		return id;
	}

	private livePanes() {
		return paradisCollectLivePaneInstances(this.terminalService, this.terminalGroupService, this.paneTokenService);
	}

	/** ボードのターミナルだけを引く（このウィンドウで見張っているもの）。 */
	private resolve(terminal: string): IResolvedTerminal | undefined {
		if (!this.watched.has(terminal)) {
			return undefined;
		}
		return this.livePanes().find(pane => this.idOf(pane.token) === terminal);
	}

	private resolveByToken(token: string): IResolvedTerminal | undefined {
		return this.watched.has(this.idOf(token)) ? this.livePanes().find(pane => pane.token === token) : undefined;
	}

	private session(token: string): ParadisAgentChatSession {
		let session = this.sessions.get(token);
		if (!session) {
			session = new ParadisAgentChatSession(token, this.source, this.logService);
			this.sessions.set(token, session);
		}
		return session;
	}

	/** 中継へ、ボードのペインの質問・許可の中身を拾うよう頼む（チャット表示を使っていなくても）。 */
	private renewWatch(): void {
		const tokens = this.livePanes().filter(pane => this.watched.has(this.idOf(pane.token))).map(pane => pane.token);
		if (tokens.length === 0 && this.watched.size === 0) {
			return;
		}
		this.source.watchAgentChat(this.watcherId, tokens).catch(error => this.logService.trace('[ParadisTaskBoardBridge] watch failed', String(error)));
	}

	// --- 見張り --------------------------------------------------------------------------------

	private watch(terminal: string, launchedAt: number | undefined, prompted: boolean): void {
		if (this.watched.has(terminal)) {
			return;
		}
		this.watched.set(terminal, {
			terminal,
			launchedAt,
			prompted,
			// 再読み込みの後に戻したものは、もう動き出している
			sawAgentStatus: launchedAt === undefined,
			sawAgent: launchedAt === undefined,
			exitWatch: { shellSeen: 0 },
			rejected: 0,
		});
		this.renewWatch();
		this.poll();
	}

	private unwatch(terminal: string): void {
		const watched = this.watched.get(terminal);
		if (!watched) {
			return;
		}
		watched.listener?.dispose();
		this.watched.delete(terminal);
		for (const [token, id] of this.idCache) {
			if (id === terminal) {
				this.sessions.deleteAndDispose(token);
				this.input.forget(token);
			}
		}
		this.renewWatch();
	}

	private poll(): void {
		if (this.polling) {
			this.pollAgain = true;
			return;
		}
		this.polling = true;
		void (async () => {
			try {
				do {
					this.pollAgain = false;
					for (const watched of [...this.watched.values()]) {
						if (this._store.isDisposed || this.shuttingDown) {
							return;
						}
						await this.update(watched);
					}
				} while (this.pollAgain);
			} catch (error) {
				this.logService.warn('[ParadisTaskBoardBridge] updating the board status failed', error);
			} finally {
				this.polling = false;
			}
		})();
	}

	private async update(watched: IWatchedTerminal): Promise<void> {
		const resolved = this.resolve(watched.terminal);
		if (!resolved) {
			const now = Date.now();
			watched.missingSince ??= now;
			if (paradisTaskBoardMissingTerminalExited({ missingSince: watched.missingSince, disposedAt: watched.disposedAt }, now)) {
				await this.report(watched, { terminal: watched.terminal, status: 'exited' });
				this.unwatch(watched.terminal);
			}
			return;
		}
		watched.missingSince = undefined;
		watched.disposedAt = undefined;
		if (watched.instanceId !== resolved.instance.instanceId) {
			watched.listener?.dispose();
			watched.instanceId = resolved.instance.instanceId;
			watched.listener = resolved.instance.onDisposed(() => {
				if (this.shuttingDown || this._store.isDisposed) {
					return;
				}
				// 同じ pty を別の instance へ付け替えた（detach / reattach）だけなら、ペイン（トークン）は新しい
				// instance で生きている。ここで終わりと知らせず、次の見直しでトークンから引き直す
				watched.disposedAt ??= Date.now();
				this.poll();
			});
		}
		const computed = this.computeStatus(watched, resolved, true);
		let question = computed.question;
		if (question === undefined && (computed.status === 'question' || computed.status === 'permission')) {
			question = await this.questionFromSession(resolved.token, computed.status, watched, resolved.instance);
		}
		await this.report(watched, { terminal: watched.terminal, status: computed.status, ...(question ? { question } : {}) });
	}

	private async report(watched: IWatchedTerminal, report: IParadisTaskBoardStatusReport): Promise<void> {
		const key = JSON.stringify(report);
		if (watched.lastSent === key) {
			return;
		}
		let accepted = false;
		try {
			accepted = await this.bridge.call<boolean>('reportStatus', report) === true;
		} catch (error) {
			this.logService.trace('[ParadisTaskBoardBridge] reportStatus failed', String(error));
			return;
		}
		if (accepted) {
			watched.lastSent = key;
			watched.rejected = 0;
		} else if (++watched.rejected >= MAX_REJECTED_REPORTS) {
			// shared process の台帳に無い（shared process が立ち上がり直した等）。もうボードのものではない
			this.unwatch(watched.terminal);
		}
	}

	/** いまの状態（同期。送る直前の確かめにも使う）。 */
	/**
	 * ターミナルの今の様子。`advance` は見張りの見直し（poll）だけが true にする。前面がシェルへ戻ったのを「見た回数」を
	 * 進めるのはそのときだけで、画面の取得・送信・回答の確かめで呼ぶときは読むだけにする（数えると、続けて見たことにならない）。
	 */
	private computeStatus(watched: IWatchedTerminal, resolved: IResolvedTerminal, advance = false): IComputedStatus {
		const instance = resolved.instance;
		const agentStatus = this.statusStore.getInstanceStatus(instance.instanceId);
		if (agentStatus !== undefined) {
			watched.sawAgentStatus = true;
		}
		const processName = instance.processName.trim();
		const foregroundShell = processName.length > 0 && paradisIsShellProcessName(processName);
		const runsAgent = paradisTerminalRunsAgent(instance) || (processName.length > 0 && !foregroundShell);
		if (runsAgent) {
			watched.sawAgent = true;
		}
		// 一度エージェントが動いた後に、前面がシェルへ戻った（エージェントが終わった）。続けて見たときだけ認める
		const shellBack = watched.sawAgent && !runsAgent && foregroundShell;
		const agentExited = advance
			? paradisTaskBoardConfirmAgentExit(watched.exitWatch, shellBack, Date.now())
			: paradisTaskBoardAgentExitConfirmed(watched.exitWatch, shellBack, Date.now());
		const label = paradisAgentIdeStatusLabel(agentStatus);
		const screen = agentStatus === 'working' || !runsAgent ? undefined : readScreen(instance, 0);
		// 起動直後の信頼の確認（hook が届く前に出る）。人が答える
		const justLaunched = watched.launchedAt !== undefined && Date.now() - watched.launchedAt <= PARADIS_AGENT_IDE_LAUNCH_GRACE_MS;
		const trustDialog = agentStatus === undefined && (justLaunched || !watched.sawAgentStatus) && paradisAgentStartupScreenState(screen) === 'trust_dialog';
		if (trustDialog && !agentExited) {
			return {
				status: 'permission',
				trustDialog: true,
				// allow-any-unicode-next-line
				question: { text: localize('paradis.taskBoard.trustDialog', "エージェントが、このフォルダを信頼するかを確かめています。"), options: [], allowText: false },
				shellBack,
			};
		}
		const choiceMenu = screen !== undefined ? paradisAgentIdeChoiceMenuOf(screen, true, label) : undefined;
		let status = paradisTaskBoardStatusFrom({ closed: instance.isDisposed, agentExited, agentStatus, choiceMenu: choiceMenu !== undefined });
		// 指示を渡して起動した直後は、最初の hook が届くまで作業中とみなす（入力待ちと取り違えて指示を重ねないように）
		if (status === 'idle' && watched.prompted && !watched.sawAgentStatus && justLaunched) {
			status = 'working';
		}
		const menuQuestion = status === 'question' && agentStatus !== 'question' && choiceMenu !== undefined
			? { text: choiceMenu.title ?? choiceMenu.enterWould, options: choiceMenu.options.map(label => ({ label })), allowText: false }
			: undefined;
		return { status, trustDialog: false, shellBack, ...(choiceMenu ? { choiceMenu } : {}), ...(menuQuestion ? { question: menuQuestion } : {}) };
	}

	/** 質問・許可の中身を、中継の会話（hook と transcript から拾ったもの）から取る。 */
	private async questionFromSession(token: string, status: 'question' | 'permission', watched: IWatchedTerminal, instance: ITerminalInstance): Promise<IParadisTaskBoardQuestionPayload | undefined> {
		const session = this.session(token);
		await session.refresh();
		const state = session.state;
		const interaction = state?.interaction ?? null;
		if (status === 'question') {
			if (interaction?.kind === 'question') {
				const questions = state?.pendingQuestions ?? [];
				const first = questions[0];
				if (!first) {
					return undefined;
				}
				const more = questions.length > 1
					// allow-any-unicode-next-line
					? `\n${localize('paradis.taskBoard.moreQuestions', "（ほかに {0} 問あります。ターミナルで答えてください）", questions.length - 1)}`
					: '';
				return {
					text: `${first.text}${more}`,
					options: (first.options ?? []).map(option => ({ label: option.label, ...(option.description ? { detail: option.description } : {}) })),
					allowText: questions.length === 1 && first.multiSelect !== true && !paradisAgentQuestionHasPreview(first),
				};
			}
			const codex = state?.agent === 'codex' ? paradisPendingCodexQuestion(state.messages) : undefined;
			return codex ? { text: codex.text, options: [], allowText: false } : undefined;
		}
		if (interaction?.kind === 'approval') {
			// Codex の MCP のツールの許可は、画面の選択肢から「このセッションでは許可」「常に許可」（paradisTaskBoardIsLastingApproval）と
			// 「Cancel」（「拒否」と同じ）を除いて出す。残りが 1 つ以下なら「許可 / 拒否」のまま
			const screenOptions = paradisCodexApprovalFormOptions(paradisVisibleTerminalText(instance), interaction.detail);
			const formOptions = screenOptions !== undefined ? paradisTaskBoardApprovalChoices(screenOptions) : undefined;
			watched.approvalOptions = formOptions !== undefined && formOptions.length >= 2 ? { interactionId: interaction.id, options: formOptions } : undefined;
			return {
				text: [interaction.title, interaction.detail].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n'),
				options: watched.approvalOptions?.options.map(option => paradisSplitCodexFormOption(option.label))
					?? interaction.choices?.map(choice => ({ label: choice.label }))
					// allow-any-unicode-next-line
					?? [{ label: localize('paradis.taskBoard.allow', "許可") }, { label: localize('paradis.taskBoard.deny', "拒否") }],
				allowText: false,
			};
		}
		return undefined;
	}

	// --- 起動 ----------------------------------------------------------------------------------

	private async launch(request: IParadisTaskBoardLaunchRequest, token: CancellationToken): Promise<Result<{ readonly terminal: string }>> {
		await this.ready;
		// SSH のウィンドウでは起動しない（IParadisTaskBoardWindowDescription.remote。接続口も選ばないが、念のため）
		if (this.environmentService.remoteAuthority !== undefined) {
			return paradisTaskBoardFail('unavailable', 'This Para Code window is connected to a remote host.');
		}
		const agent = this.modelCatalogService.getAgentTemplates().find(candidate => candidate.id === request.agent);
		if (!agent) {
			return paradisTaskBoardFail('invalid', `Agent "${request.agent}" is not configured in Para Code.`);
		}
		if (request.modelId !== undefined && !(agent.models ?? []).some(model => model.id === request.modelId)) {
			return paradisTaskBoardFail('invalid', `Unknown model "${request.modelId}" for ${agent.id}.`);
		}
		if (request.effortId !== undefined && !(agent.efforts ?? []).some(effort => effort.id === request.effortId)) {
			return paradisTaskBoardFail('invalid', `Unknown effort "${request.effortId}" for ${agent.id}.`);
		}
		const permission = request.permissionId !== undefined ? (agent.permissions ?? []).find(candidate => candidate.id === request.permissionId) : undefined;
		if (request.permissionId !== undefined && !permission) {
			return paradisTaskBoardFail('invalid', `Unknown permission "${request.permissionId}" for ${agent.id}.`);
		}
		// 確認を全部飛ばす権限（--dangerously-*）では起動しない。接続口の鍵はこの PC のプログラムなら読めるので、
		// それを読んだエージェントが確認なしのエージェントを増やせないようにする
		if (permission?.danger) {
			return paradisTaskBoardFail('invalid', `The task board cannot start an agent with the "${permission.id}" permission.`);
		}
		const ignoreCase = isMacintosh || isWindows;
		let rootUri: URI;
		let stateKey: string;
		const space = paradisListSpaces(this.switchService.repositories, this.worktreeService)
			.find(candidate => candidate.uri.scheme === Schemas.file && paradisTaskBoardSamePath(candidate.uri.fsPath, request.repoPath, ignoreCase));
		if (space) {
			rootUri = space.uri;
			stateKey = space.space;
		} else {
			try {
				const repository = await this.switchService.addRepository(URI.file(request.repoPath));
				rootUri = repository.uri;
				stateKey = repository.id;
			} catch (error) {
				return paradisTaskBoardFail('failed', `Para Code could not add the repository: ${toErrorMessage(error)}`);
			}
		}
		// 指示は打鍵されるコマンドの一部になるので、制御文字を落として 1 行にする（定期実行と同じ）
		const prompt = paradisScheduledRunLaunchPrompt(request.prompt);
		let launched;
		try {
			launched = await this.instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
				rootUri,
				stateKey,
				agentId: agent.id,
				...(prompt.length > 0 ? { prompt } : {}),
				...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
				...(request.effortId !== undefined ? { effortId: request.effortId } : {}),
				...(request.permissionId !== undefined ? { permissionId: request.permissionId } : {}),
				// 利用者の作業中に起動するので、入力を新しいターミナルへ横取りしない
				preserveFocus: true,
			});
		} catch (error) {
			if (error instanceof ParadisAgentPromptQuotingError) {
				return paradisTaskBoardFail('invalid', toErrorMessage(error));
			}
			this.logService.error('[ParadisTaskBoardBridge] launching the agent failed', error);
			return paradisTaskBoardFail('failed', `Para Code could not launch the agent: ${toErrorMessage(error)}`);
		}
		if (launched.paneToken === undefined) {
			const instance = this.livePanes().find(pane => pane.instance.instanceId === launched.instanceId)?.instance
				?? this.terminalService.getInstanceFromId(launched.instanceId);
			instance?.dispose(TerminalExitReason.User);
			return paradisTaskBoardFail('failed', 'Para Code started a terminal but could not identify it, so it closed it.');
		}
		if (token.isCancellationRequested) {
			// shared process が待ちきれずに失敗を返した後に起動し終えた。台帳に載らない端末を残さない
			const orphan = this.livePanes().find(pane => pane.instance.instanceId === launched.instanceId)?.instance ?? this.terminalService.getInstanceFromId(launched.instanceId);
			orphan?.dispose(TerminalExitReason.User);
			return paradisTaskBoardFail('failed', 'The launch was cancelled because it took too long.');
		}
		const terminal = this.idOf(launched.paneToken);
		this.watch(terminal, Date.now(), prompt.length > 0);
		return success({ terminal });
	}

	// --- 入力 ----------------------------------------------------------------------------------

	private watchedOf(terminal: string): IWatchedTerminal | undefined {
		return this.watched.get(terminal);
	}

	/**
	 * 文を送ってはいけない理由（送る直前と、貼り付けてから Enter までの間に確かめる）。
	 * `viaApi` は OpenCode へ連携の API で送るとき（画面の確認と貼り付けの囲みは打鍵のためのものなので見ない）。
	 */
	private sendBlock(terminal: string, text: string, viaApi = false): Result<never> | undefined {
		const watched = this.watchedOf(terminal);
		const resolved = this.resolve(terminal);
		if (!watched || !resolved || resolved.instance.isDisposed) {
			// allow-any-unicode-next-line
			return paradisTaskBoardFail('not-found', localize('paradis.taskBoard.noTerminal', "送り先のターミナルが見つかりません"));
		}
		const computed = this.computeStatus(watched, resolved);
		// 終わりと決める前でも、前面がシェルに見える間は送らない（指示がシェルのコマンドとして走らないように）
		const block = paradisTaskBoardSendBlock(computed.status, computed.shellBack);
		if (block !== undefined) {
			return paradisTaskBoardFail(block, this.blockMessage(block));
		}
		if (viaApi) {
			return undefined;
		}
		const chat = chatTerminalFor(resolved.instance);
		if (paradisScreenShowsAgentPrompt(chat.readScreen(), this.session(resolved.token).state?.agent)) {
			// allow-any-unicode-next-line
			return paradisTaskBoardFail('question', localize('paradis.taskBoard.promptOnScreen', "ターミナルに確認の画面が出ています。先に答えてください"));
		}
		if (text.includes('\n') && !chat.bracketedPasteMode()) {
			// allow-any-unicode-next-line
			return paradisTaskBoardFail('invalid', localize('paradis.taskBoard.multiline', "いまは複数行の文を送れません。1 行にして送ってください"));
		}
		return undefined;
	}

	private blockMessage(block: 'busy' | 'question' | 'permission' | 'exited'): string {
		switch (block) {
			// allow-any-unicode-next-line
			case 'busy': return localize('paradis.taskBoard.busy', "エージェントが作業中です。終わってから送ってください");
			// allow-any-unicode-next-line
			case 'question': return localize('paradis.taskBoard.waitingQuestion', "エージェントが質問の答えを待っています。先に答えてください");
			// allow-any-unicode-next-line
			case 'permission': return localize('paradis.taskBoard.waitingPermission', "エージェントが許可を待っています。先に答えてください");
			// allow-any-unicode-next-line
			case 'exited': return localize('paradis.taskBoard.exited', "エージェントはもう動いていません");
		}
	}

	private async send(request: IParadisTaskBoardSendRequest): Promise<Result<true>> {
		// 制御文字を落とす（ESC が残ると貼り付けの終わりを偽造できる）。改行は貼り付けモードで送るので残す
		const text = paradisBuildPresetInsertText(request.text, true);
		if (text === undefined) {
			// allow-any-unicode-next-line
			return paradisTaskBoardFail('invalid', localize('paradis.taskBoard.empty', "送る文がありません"));
		}
		// OpenCode の入力欄へは打鍵しない。送るのは連携の API だけ（チャット表示の送信と同じ経路で、会話の ID を確かめて渡す）
		const pane = this.resolve(request.terminal);
		const session = pane !== undefined ? this.session(pane.token) : undefined;
		if (session !== undefined && (session.state === undefined || session.state.agent === 'opencode')) {
			await session.refresh();
		}
		if (pane !== undefined && session?.state?.agent === 'opencode') {
			const blockedApi = this.sendBlock(request.terminal, text, true);
			if (blockedApi) {
				return blockedApi;
			}
			if (!request.submit) {
				// allow-any-unicode-next-line
				return paradisTaskBoardFail('invalid', localize('paradis.taskBoard.openCodeDraft', "OpenCode の入力欄へは書きかけを置けません。送信として送ってください"));
			}
			const error = await this.input.sendMessage(pane.instance.instanceId, pane.token, text);
			this.poll();
			return error === undefined ? success(true) : paradisTaskBoardFail('rejected', error);
		}
		const blocked = this.sendBlock(request.terminal, text);
		if (blocked) {
			return blocked;
		}
		const instance = this.resolve(request.terminal)!.instance;
		if (!request.submit) {
			await instance.sendText(paradisStripAgentInvisibleCharacters(text), false, true);
			return success(true);
		}
		let late: Result<never> | undefined;
		const outcome = await paradisSendAgentMessageToTui(
			text,
			(value, execute, bracketedPasteMode) => instance.sendText(value, execute ?? false, bracketedPasteMode),
			async () => {
				late = this.sendBlock(request.terminal, text);
				return late === undefined;
			},
		);
		if (!outcome.executed) {
			if (late !== undefined && !late.ok && outcome.consumed) {
				// allow-any-unicode-next-line
				return paradisTaskBoardFail(late.code, localize('paradis.taskBoard.pastedNotSent', "貼り付けた後に状態が変わったため、Enter を送りませんでした（{0}）", late.message));
			}
			// allow-any-unicode-next-line
			return late ?? paradisTaskBoardFail('busy', localize('paradis.taskBoard.changed', "送る前にターミナルの状態が変わりました"));
		}
		this.poll();
		return success(true);
	}

	private async key(request: IParadisTaskBoardKeyRequest): Promise<Result<true>> {
		const resolved = this.resolve(request.terminal);
		if (!resolved) {
			// allow-any-unicode-next-line
			return paradisTaskBoardFail('not-found', localize('paradis.taskBoard.noTerminal', "送り先のターミナルが見つかりません"));
		}
		const instance = resolved.instance;
		if (paradisTaskBoardKeyBlockedOnApprovalForm(request.key) && paradisCodexApprovalFormShown(paradisVisibleTerminalText(instance))) {
			// allow-any-unicode-next-line
			return paradisTaskBoardFail('rejected', localize('paradis.taskBoard.keyOnApprovalForm', "ツールの許可の確認には、キーではなく回答で答えてください"));
		}
		const sequence = /^[1-9]$/.test(request.key)
			? request.key
			: paradisAgentIdeKeySequence(request.key as Exclude<typeof request.key, '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'>, instance.xterm?.raw.modes.applicationCursorKeysMode === true);
		await instance.sendText(sequence, false);
		this.poll();
		return success(true);
	}

	private async answer(request: IParadisTaskBoardAnswerRequest): Promise<Result<true>> {
		const watched = this.watchedOf(request.terminal);
		const resolved = this.resolve(request.terminal);
		if (!watched || !resolved) {
			// allow-any-unicode-next-line
			return paradisTaskBoardFail('not-found', localize('paradis.taskBoard.noTerminal', "送り先のターミナルが見つかりません"));
		}
		const { instance, token } = resolved;
		const computed = this.computeStatus(watched, resolved);
		const session = this.session(token);
		await session.refresh();
		const state = session.state;
		const interaction = state?.interaction ?? null;
		const done = (error: string | undefined): Result<true> => {
			this.poll();
			return error === undefined ? success(true) : paradisTaskBoardFail('rejected', error);
		};
		if (request.kind === 'question') {
			if (interaction?.kind === 'question') {
				const questions: readonly IParadisAgentChatMessage[] = state?.pendingQuestions ?? [];
				if (questions.length !== 1) {
					// allow-any-unicode-next-line
					return paradisTaskBoardFail('rejected', localize('paradis.taskBoard.multipleQuestions', "複数の質問が出ています。ターミナルで答えてください"));
				}
				const question = questions[0];
				const optionCount = question.options?.length ?? 0;
				let answer: ParadisAgentQuestionAnswer;
				if (request.optionIndex !== undefined) {
					if (request.optionIndex >= optionCount) {
						return paradisTaskBoardFail('invalid', `optionIndex must be less than ${optionCount}.`);
					}
					answer = question.multiSelect === true ? { kind: 'multi', indices: [request.optionIndex] } : { kind: 'option', index: request.optionIndex };
				} else {
					answer = { kind: 'text', optionCount, text: request.text ?? '' };
				}
				return done(await this.input.answerQuestions(instance.instanceId, token, interaction.id, [answer]));
			}
			if (state?.agent === 'codex' && paradisPendingCodexQuestion(state.messages) !== undefined) {
				// allow-any-unicode-next-line
				return paradisTaskBoardFail('rejected', localize('paradis.taskBoard.codexQuestion', "Codex の質問にはボードから答えられません。ターミナルで答えてください"));
			}
			// Codex の Plan メニューなどの選択画面は、番号のキーで選ぶ
			if (computed.choiceMenu !== undefined && request.optionIndex !== undefined) {
				if (request.optionIndex >= Math.min(computed.choiceMenu.options.length, ANSWER_DIGIT_LIMIT)) {
					return paradisTaskBoardFail('invalid', 'optionIndex is out of range for the menu on screen.');
				}
				await instance.sendText(String(request.optionIndex + 1), false);
				return done(undefined);
			}
			// allow-any-unicode-next-line
			return paradisTaskBoardFail('rejected', localize('paradis.taskBoard.noQuestion', "回答を待っている質問がありません"));
		}
		if (interaction?.kind === 'approval') {
			// 画面の番号の選択肢として出した許可（Codex の MCP のツールの許可）は、その番号と見せた文言で答える
			const offered = watched.approvalOptions;
			if (request.allow === undefined && request.optionIndex !== undefined && offered?.interactionId === interaction.id) {
				const option = offered.options[request.optionIndex];
				if (option === undefined) {
					return paradisTaskBoardFail('invalid', `optionIndex must be less than ${offered.options.length}.`);
				}
				if (paradisTaskBoardIsLastingApproval(option.label)) {
					// allow-any-unicode-next-line
					return paradisTaskBoardFail('rejected', localize('paradis.taskBoard.lastingApproval', "この許可はボードからは選べません。ターミナルで答えてください"));
				}
				return done(await this.input.answerApproval(instance.instanceId, token, interaction.id, `opt:${option.n}`, option.label));
			}
			const choiceId = request.allow !== undefined
				? (request.allow ? 'yes' : 'no')
				: request.optionIndex !== undefined ? interaction.choices?.[request.optionIndex]?.id : undefined;
			if (choiceId === undefined) {
				return paradisTaskBoardFail('invalid', 'Give allow (true or false) for this permission.');
			}
			return done(await this.input.answerApproval(instance.instanceId, token, interaction.id, choiceId));
		}
		if (computed.trustDialog && request.allow !== undefined) {
			if (!request.allow) {
				// 断る: Esc（エージェントは終わる）
				await instance.sendText('\x1b', false);
				return done(undefined);
			}
			// 信頼する: 既定でカーソルがどちらにあるかは CLI の版で違う（Claude Code 2.1.283 は断る側）。
			// 1 つ動かすたびに画面を読み直し、承諾の行にカーソルが来たのを確かめてから Enter を送る
			for (let step = 0; step < TRUST_CURSOR_MAX_STEPS; step++) {
				const cursor = paradisTrustDialogCursor(readScreen(instance, SCREEN_EXTRA_LINES));
				if (!cursor) {
					break;
				}
				if (cursor.on === 'accept') {
					await instance.sendText('\r', false);
					return done(undefined);
				}
				const before = readScreen(instance, SCREEN_EXTRA_LINES);
				await instance.sendText(cursor.acceptIsAbove ? '\x1b[A' : '\x1b[B', false);
				// 描き直されるまで待ってから読み直す（読み直しが早いと矢印を 2 回送り、行き過ぎる）
				for (let waited = 0; waited < TRUST_CURSOR_REDRAW_LIMIT_MS && readScreen(instance, SCREEN_EXTRA_LINES) === before; waited += TRUST_CURSOR_SETTLE_MS) {
					await timeout(TRUST_CURSOR_SETTLE_MS);
				}
			}
			// allow-any-unicode-next-line
			return paradisTaskBoardFail('rejected', localize('paradis.taskBoard.trustUnreadable', "信頼の確認の選択肢を読み取れませんでした。Para Code のターミナルで答えてください"));
		}
		// allow-any-unicode-next-line
		return paradisTaskBoardFail('rejected', localize('paradis.taskBoard.noPermission', "回答を待っている許可の確認がありません"));
	}

	// --- 読み取り・閉じる ----------------------------------------------------------------------

	private screen(terminal: string): Result<IParadisTaskBoardScreen> {
		const watched = this.watchedOf(terminal);
		const resolved = this.resolve(terminal);
		if (!watched || !resolved) {
			return paradisTaskBoardFail('not-found', 'There is no board terminal with that id in this window.');
		}
		const status = this.computeStatus(watched, resolved).status;
		// 別のスペースへ退避（park）中のターミナルは画面が描かれていない
		const text = readScreen(resolved.instance, SCREEN_EXTRA_LINES);
		return success(text === undefined ? { text: '', status, readable: false } : { text, status, readable: true });
	}

	private close(terminal: string): Result<true> {
		const resolved = this.resolve(terminal);
		if (resolved && !resolved.instance.isDisposed) {
			// 確認のダイアログは出さない（ボードの操作で閉じる。誰も PC の前にいないこともある）
			resolved.instance.dispose(TerminalExitReason.User);
		}
		this.unwatch(terminal);
		return success(true);
	}
}

registerWorkbenchContribution2(ParadisTaskBoardBridgeWindow.ID, ParadisTaskBoardBridgeWindow, WorkbenchPhase.AfterRestored);
