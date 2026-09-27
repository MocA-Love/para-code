/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP サーバーへ「IDE 操作ツール」（O1）と「ガイドを読む」ツール（O4）を足すプロバイダ。
// shared process で動く。スペースやターミナルの実体はウィンドウ側にあるので、ここでは
//  - 設定で送信・作成・削除が許されているかの門番
//  - 操作系のツールで、接続元のプロセスが本当にそのペインの中にあるかの確かめ（トークンのなりすまし防止）
//  - 送る直前と Enter の直前の「作業中・許可待ち・質問中ではないか」の確かめ（hook から分かる最新の状態で行う）
//  - 待機（1 秒ごとにウィンドウへ画面と状態を聞く。上限と同時数の制限つき）
//  - エージェントへ返す文面の組み立て（ペイントークンは絶対に載せない）
// を受け持ち、範囲（同じスペースか・自分が作ったものか）の判断はウィンドウ側が行う。

import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import {
	IParadisAgentIdeInternal,
	PARADIS_AGENT_IDE_ACTIONS_DISABLED_MESSAGE,
	PARADIS_AGENT_IDE_CHANNEL,
	PARADIS_AGENT_IDE_LAUNCH_GRACE_MS,
	PARADIS_AGENT_IDE_MAX_WAITS_PER_PANE,
	PARADIS_AGENT_IDE_MAX_WAITS_TOTAL,
	PARADIS_AGENT_IDE_METHOD,
	PARADIS_AGENT_IDE_SHELL_DISABLED_MESSAGE,
	PARADIS_AGENT_IDE_START_GRACE_MS,
	PARADIS_AGENT_IDE_TOOLS,
	PARADIS_AGENT_IDE_TOOL_NAMES,
	ParadisAgentIdeActionScope,
	ParadisAgentIdeRequest,
	ParadisAgentIdeResult,
	ParadisAgentIdeTerminalStatus,
	ParadisAgentIdeWaitCondition,
	ParadisAgentStopWatcher,
	paradisAgentIdeNeedsHuman,
	paradisAgentIdeScreenShowsPrompt,
	paradisAgentIdeStatusLabel,
	paradisParseAgentIdeCall,
} from '../common/paradisAgentIde.js';
import { PARADIS_AGENT_IDE_SERVER_INSTRUCTIONS, paradisAgentIdeGuide } from '../common/paradisAgentIdeGuide.js';

/** 設定の読み手（shared process の IConfigurationService を包む。テストでは差し替える）。 */
export interface IParadisAgentIdeSettings {
	actionsEnabled(): boolean;
	actionScope(): ParadisAgentIdeActionScope;
	readOtherSpaces(): boolean;
	shellCommands(): boolean;
}

/** 時間の扱い（テストで差し替える）。 */
export interface IParadisAgentIdeClock {
	now(): number;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const REAL_CLOCK: IParadisAgentIdeClock = {
	now: () => Date.now(),
	sleep: (ms, signal) => new Promise<void>(resolve => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	}),
};

/** 待機でウィンドウへ聞きに行く間隔。 */
const WAIT_POLL_MS = 1_000;
/** 待機の結果に添える画面の行数。 */
const WAIT_RESULT_TAIL_LINES = 20;
/** 貼り付けから Enter までの間（TUI が貼り付けを確定させる時間。モバイルからの送信と同じ）。 */
const PASTE_SETTLE_MS = 250;

/** worktree の作成（命名・git worktree add・setup スクリプト）を待つ上限。 */
const CREATE_SPACE_TIMEOUT_MS = 150_000;
/** ターミナルを開いてシェルが立ち上がるのを待つ上限。 */
const OPEN_TERMINAL_TIMEOUT_MS = 30_000;

const NEEDS_HUMAN_MESSAGE = 'That terminal is waiting for the user to answer a permission request or a question, so Para Code does not send anything to it. Tell the user which terminal is waiting (its id and title from list_terminals) and let them answer.';
const WORKING_MESSAGE = 'The agent in that terminal is working right now, so Para Code does not press Enter there (a permission prompt could appear at any moment and Enter would answer it). Wait with wait_for_terminal until="agent_stopped" and send again.';
const NO_HOOKS_MESSAGE = 'Para Code cannot see the status of the agent in that terminal (its hooks have never reported), so it cannot tell whether a permission prompt is on screen and does not press Enter there. Ask the user to turn on the agent hooks in Para Code settings, or to send it themselves.';
const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside your own terminal pane, so it refuses actions. This always happens for agents connected over SSH; reading tools still work there.';
const READ_CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside a Para Code terminal pane, so it refuses the request. Start this agent CLI from a terminal inside Para Code.';
const REMOTE_TARGET_ENTER_MESSAGE = 'That terminal runs on an SSH host, where Para Code cannot tell a genuine status report from a forged one, so it does not press Enter there. Type the text without Enter and ask the user to submit it.';
const UNVERIFIABLE_RELEASE_MESSAGE = 'That agent answered a permission request or a question, and Para Code cannot confirm from the agent itself that it moved on (for example it runs inside tmux, WSL or a container), so it leaves pressing Enter there to the user. Ask the user to send it.';
const UNCONFIRMED_RELEASE_MESSAGE = 'That agent was waiting for a permission or question answer, and Para Code has not yet confirmed from the agent itself that it moved on, so it does not press Enter there yet. Wait with wait_for_terminal and try again.';
const SCREEN_UNREADABLE_MESSAGE = 'Para Code cannot read that terminal\'s screen right now (it may not have been drawn yet), so it cannot check for a confirmation prompt and does not press Enter. Retry in a moment.';
const PROMPT_ON_SCREEN_MESSAGE = 'That terminal shows a confirmation prompt on screen (for example a permission question), so Para Code does not press Enter there. Tell the user instead.';
const TOO_MANY_WAITS_MESSAGE = 'Too many wait_for_terminal calls are running at once. Wait for the current ones to return before starting another.';

function toolText(value: string | object): unknown {
	return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function toolError(text: string): unknown {
	return { content: [{ type: 'text', text }], isError: true };
}

function tailOf(screen: string | undefined, lines: number): string {
	if (!screen) {
		return '';
	}
	const all = screen.split('\n');
	return all.slice(Math.max(0, all.length - lines)).join('\n');
}

export class ParadisAgentIdeToolProvider implements IParadisMcpToolProvider {

	private readonly _waitsByPane = new Map<string, number>();
	private _waitsTotal = 0;

	constructor(
		private readonly settings: IParadisAgentIdeSettings,
		private readonly logService: ILogService | undefined,
		private readonly clock: IParadisAgentIdeClock = REAL_CLOCK,
	) { }

	listTools(): readonly IParadisMcpToolDefinition[] {
		return PARADIS_AGENT_IDE_TOOLS;
	}

	instructions(): string {
		return PARADIS_AGENT_IDE_SERVER_INSTRUCTIONS;
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (!PARADIS_AGENT_IDE_TOOL_NAMES.has(name)) {
			return undefined;
		}
		const parsed = paradisParseAgentIdeCall(name, args);
		switch (parsed.kind) {
			case 'error':
				return toolError(parsed.error);
			case 'guide':
				return toolText(paradisAgentIdeGuide({
					actionsEnabled: this.settings.actionsEnabled(),
					actionScope: this.settings.actionScope(),
					readOtherSpaces: this.settings.readOtherSpaces(),
					shellCommands: this.settings.shellCommands(),
				}));
		}
		if (!context) {
			return toolError('This Para Code build cannot route IDE tools to its window. Update Para Code.');
		}
		const action = parsed.kind === 'input' || (parsed.kind === 'window' && parsed.action);
		if (action && !this.settings.actionsEnabled()) {
			return toolError(PARADIS_AGENT_IDE_ACTIONS_DISABLED_MESSAGE);
		}
		// トークンだけでは本人と言えないので、読み取りも含めて接続元のプロセスを確かめる。
		// 操作はそのペインの中のプロセスだけ、読み取りは SSH の戻り経路（どのペインかは確かめられない）も許す
		const caller = await context.classifyCaller();
		if (caller === 'unverified' || (action && caller !== 'pane')) {
			return toolError(action ? CALLER_UNVERIFIED_MESSAGE : READ_CALLER_UNVERIFIED_MESSAGE);
		}
		if (parsed.kind === 'wait') {
			// 待機の枠は、接続元を確かめた後で数える（偽のトークンで枠を埋められないように）
			return this._withWaitSlot(paneToken, () => this._wait(paneToken, parsed.terminal, parsed.until, parsed.text, parsed.timeoutSeconds, context, signal));
		}
		if (parsed.kind === 'input') {
			return this._sendInput(paneToken, parsed.terminal, parsed.text, parsed.pressEnter, context, signal);
		}
		const request = parsed.request;
		if (request.op === 'sendKey') {
			const refusal = await this._checkTarget(paneToken, request.terminal, request.key === 'enter', name, context, signal);
			if (refusal !== undefined) {
				return toolError(refusal);
			}
		}
		const result = await this._callWindow(paneToken, request, name, context, signal);
		if (!result.ok) {
			return toolError(result.error);
		}
		if (request.op === 'listSpaces' || request.op === 'listTerminals') {
			// 設定がオンでも、このペインの中から来たと確かめられない接続（SSH の戻り経路）では操作できない
			const actionsAvailable = this.settings.actionsEnabled() && caller === 'pane';
			const data = result.data as { terminals?: readonly object[] };
			return toolText({
				actions_enabled: actionsAvailable,
				...(this.settings.actionsEnabled() && !actionsAvailable ? { actions_note: 'Actions are allowed in Para Code settings, but not over this connection (for example an agent on an SSH host). Only reading works here.' } : {}),
				action_scope: this.settings.actionScope(),
				read_other_spaces: this.settings.readOtherSpaces(),
				shell_commands: this.settings.shellCommands(),
				...result.data,
				...(Array.isArray(data.terminals) && !actionsAvailable ? { terminals: data.terminals.map(terminal => ({ ...terminal, can_send: false })) } : {}),
			});
		}
		return toolText(result.data);
	}

	/**
	 * 送ってよい相手かを、ウィンドウの範囲判定と hook の最新の状態で確かめる。断る理由を返す。
	 * @param wantsEnter Enter を送るか（コマンドの実行・プロンプトの送信になる）
	 */
	/**
	 * @param typedText 直前に貼った本文。画面の確認ではその部分を除いて探す（本文に確認の文言が入っていても止めない）
	 */
	private async _checkTarget(paneToken: string, terminal: string, wantsEnter: boolean, toolName: string, context: IParadisMcpToolCallContext, signal: AbortSignal | undefined, typedText?: string): Promise<string | undefined> {
		const target = await this._callWindow(paneToken, { op: 'resolveWriteTarget', terminal }, toolName, context, signal);
		if (!target.ok) {
			return target.error;
		}
		const status = this._statusOf(target.internal, context);
		if (paradisAgentIdeNeedsHuman(status)) {
			return NEEDS_HUMAN_MESSAGE;
		}
		if (!wantsEnter) {
			return undefined;
		}
		// SSH など接続先のターミナルの状態の報告は、戻り経路を通れる誰からでも届きうる（偽の hook で許可待ちを
		// 解けてしまう）ので、そこへの Enter は利用者に任せる
		if (target.internal?.remote === true) {
			return REMOTE_TARGET_ENTER_MESSAGE;
		}
		const token = target.internal?.paneToken;
		// transcript から許可待ちが解かれ、まだ確かめた hook が来ていない（追記で偽装できる）
		const unconfirmedRelease = token !== undefined ? context.getPaneAgentStatus(token)?.unconfirmedRelease : undefined;
		if (unconfirmedRelease === 'unverifiable') {
			return UNVERIFIABLE_RELEASE_MESSAGE;
		}
		if (unconfirmedRelease === 'pending') {
			return UNCONFIRMED_RELEASE_MESSAGE;
		}
		// 状態が正しくても、画面に確認の選択肢が出ていたら Enter を送らない（hook の遅れや偽装への備え）。
		// 素のシェルでも同じ。画面を読めないときは確かめようがないので送らない
		const screen = target.internal?.screen;
		if (screen === undefined) {
			return SCREEN_UNREADABLE_MESSAGE;
		}
		if (paradisAgentIdeScreenShowsPrompt(screen, typedText)) {
			return PROMPT_ON_SCREEN_MESSAGE;
		}
		if (target.internal?.agent !== true) {
			return this.settings.shellCommands() ? undefined : PARADIS_AGENT_IDE_SHELL_DISABLED_MESSAGE;
		}
		if (status === 'working') {
			return WORKING_MESSAGE;
		}
		// hook が一度も届いていない相手は、許可待ちかどうかを確かめられない（安全側に倒す）
		if (token === undefined || !context.hasAgentHookHistory(token)) {
			return NO_HOOKS_MESSAGE;
		}
		return undefined;
	}

	/**
	 * 本文を貼り付け、必要なら Enter を送る。貼り付けと Enter を別の呼び出しに分け、その間に hook の
	 * 状態を確かめ直す（貼り付けている間に許可ダイアログが出たら、Enter でそれを承認してしまうため）。
	 */
	private async _sendInput(paneToken: string, terminal: string, text: string, pressEnter: boolean, context: IParadisMcpToolCallContext, signal: AbortSignal | undefined): Promise<unknown> {
		const toolName = 'send_terminal_input';
		const before = await this._checkTarget(paneToken, terminal, pressEnter, toolName, context, signal);
		if (before !== undefined) {
			return toolError(before);
		}
		if (text.length > 0) {
			const pasted = await this._callWindow(paneToken, { op: 'sendInput', terminal, text }, toolName, context, signal);
			if (!pasted.ok) {
				return toolError(pasted.error);
			}
			if (!pressEnter) {
				return toolText(pasted.data);
			}
			await this.clock.sleep(PASTE_SETTLE_MS, signal);
			// 貼った後の画面では、貼った本文の部分を除いて確認の文言を探す
			const after = await this._checkTarget(paneToken, terminal, true, toolName, context, signal, text);
			if (after !== undefined) {
				return toolError(`The text was typed, but Enter was not pressed: ${after}`);
			}
		}
		const submitted = await this._callWindow(paneToken, { op: 'sendKey', terminal, key: 'enter', ...(text.length > 0 ? { typedText: text } : {}) }, toolName, context, signal);
		if (!submitted.ok) {
			return toolError(text.length > 0 ? `The text was typed, but Enter was not pressed: ${submitted.error}` : submitted.error);
		}
		return toolText({ terminal, typed: text.length > 0, pressed_enter: true });
	}

	/** 状態は hook（shared process）を優先し、無ければウィンドウの見立てを使う。 */
	private _statusOf(internal: IParadisAgentIdeInternal | undefined, context: IParadisMcpToolCallContext): ParadisAgentIdeTerminalStatus {
		const hookStatus = internal?.paneToken !== undefined ? context.getPaneAgentStatus(internal.paneToken) : undefined;
		if (hookStatus !== undefined) {
			return paradisAgentIdeStatusLabel(hookStatus.status);
		}
		return internal?.status ?? 'idle';
	}

	private async _callWindow(paneToken: string, request: ParadisAgentIdeRequest, toolName: string, context: IParadisMcpToolCallContext, signal: AbortSignal | undefined): Promise<ParadisAgentIdeResult> {
		const timeoutMs = request.op === 'createSpace'
			? CREATE_SPACE_TIMEOUT_MS
			: request.op === 'launchAgent' || request.op === 'createTerminal'
				? OPEN_TERMINAL_TIMEOUT_MS
				: undefined;
		const call = await context.callOwningWindow<ParadisAgentIdeResult>({
			channelName: PARADIS_AGENT_IDE_CHANNEL,
			method: PARADIS_AGENT_IDE_METHOD,
			args: [paneToken, request],
			failureLabel: toolName,
			failureMessage: request.op === 'createSpace'
				? 'Para Code did not finish creating the space in time, or failed. It may still appear: call list_spaces before trying again, so that you do not create it twice.'
				: `Para Code failed to run ${toolName} in its window. Retry once; if it keeps failing, tell the user.`,
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		}, signal);
		if (!call.ok) {
			return { ok: false, error: call.error };
		}
		const value = call.value;
		if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') {
			this.logService?.warn(`[ParadisAgentIde] malformed window response for ${toolName}`);
			return { ok: false, error: `Para Code returned an unexpected response for ${toolName}.` };
		}
		return value;
	}

	/** 待機の同時数を制限する（待機は MCP の受付枠を長く占めるので、hook などの受付を枯らさない）。 */
	private async _withWaitSlot(paneToken: string, run: () => Promise<unknown>): Promise<unknown> {
		const perPane = this._waitsByPane.get(paneToken) ?? 0;
		if (perPane >= PARADIS_AGENT_IDE_MAX_WAITS_PER_PANE || this._waitsTotal >= PARADIS_AGENT_IDE_MAX_WAITS_TOTAL) {
			return toolError(TOO_MANY_WAITS_MESSAGE);
		}
		this._waitsByPane.set(paneToken, perPane + 1);
		this._waitsTotal++;
		try {
			return await run();
		} finally {
			this._waitsTotal--;
			const current = (this._waitsByPane.get(paneToken) ?? 1) - 1;
			if (current <= 0) {
				this._waitsByPane.delete(paneToken);
			} else {
				this._waitsByPane.set(paneToken, current);
			}
		}
	}

	private async _wait(
		paneToken: string,
		terminal: string,
		until: ParadisAgentIdeWaitCondition,
		text: string | undefined,
		timeoutSeconds: number,
		context: IParadisMcpToolCallContext,
		signal: AbortSignal | undefined,
	): Promise<unknown> {
		const startedAt = this.clock.now();
		const deadline = startedAt + timeoutSeconds * 1000;
		let stopWatcher: ParadisAgentStopWatcher | undefined;
		let lastStatus: ParadisAgentIdeTerminalStatus = 'idle';
		let lastScreen: string | undefined;
		let probedOnce = false;

		const report = (met: boolean, extra: object = {}) => toolText({
			terminal,
			until,
			met,
			status: lastStatus,
			waited_seconds: Math.round((this.clock.now() - startedAt) / 1000),
			...extra,
			screen_tail: tailOf(lastScreen, WAIT_RESULT_TAIL_LINES),
		});

		while (true) {
			if (signal?.aborted) {
				return toolError('The wait was cancelled.');
			}
			const probe = await this._callWindow(paneToken, { op: 'probeTerminal', terminal }, 'wait_for_terminal', context, signal);
			if (!probe.ok) {
				return toolError(probe.error);
			}
			if (probe.internal?.gone) {
				// 最初から無い ID は呼び出しの誤り、待っている間に消えたのなら「閉じられた」
				return probedOnce
					? report(false, { reason: 'terminal_closed' })
					: toolError(`There is no terminal with id "${terminal}" in this Para Code window (it may have been closed). Call list_terminals for the current ids.`);
			}
			probedOnce = true;
			lastScreen = probe.internal?.screen;
			lastStatus = this._statusOf(probe.internal, context);
			const hookStatus = probe.internal?.paneToken !== undefined ? context.getPaneAgentStatus(probe.internal.paneToken) : undefined;
			const now = this.clock.now();

			switch (until) {
				case 'needs_input':
					if (paradisAgentIdeNeedsHuman(lastStatus)) {
						return report(true, { reason: 'needs_input' });
					}
					break;
				case 'text':
					if (text !== undefined && (lastScreen ?? '').includes(text)) {
						return report(true, { reason: 'text_found' });
					}
					break;
				case 'agent_stopped': {
					if (!stopWatcher) {
						// エージェントのツールで起動したばかりのペインは、CLI が立ち上がるまでの猶予を長く取る
						const launchedAt = probe.internal?.launchedAt;
						const grace = launchedAt !== undefined
							? Math.max(PARADIS_AGENT_IDE_START_GRACE_MS, launchedAt + PARADIS_AGENT_IDE_LAUNCH_GRACE_MS - startedAt)
							: PARADIS_AGENT_IDE_START_GRACE_MS;
						stopWatcher = new ParadisAgentStopWatcher(startedAt, grace);
					}
					const verdict = stopWatcher.observe(lastStatus, hookStatus?.changedAt, now);
					if (verdict === 'stopped' || verdict === 'needs_input') {
						return report(true, { reason: verdict });
					}
					if (verdict === 'no_agent_status') {
						return report(false, { reason: verdict, hint: 'The agent never reported that it started working. This does not mean it finished: read_terminal to see the screen, or use until="text".' });
					}
					break;
				}
			}
			if (now >= deadline) {
				return report(false, { timed_out: true, hint: 'Not reached yet. Call wait_for_terminal again to keep waiting.' });
			}
			await this.clock.sleep(Math.min(WAIT_POLL_MS, deadline - now), signal);
		}
	}
}
