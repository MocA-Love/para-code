/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP サーバーへ「IDE 操作ツール」（O1）と「ガイドを読む」ツール（O4）を足すプロバイダ。
// shared process で動く。スペースやターミナルの実体はウィンドウ側にあるので、ここでは
//  - 設定で送信・作成・削除が許されているかの門番
//  - 送る直前の「許可待ち・質問中ではないか」の確かめ（hook から分かる最新の状態で行う）
//  - 待機（1 秒ごとにウィンドウへ画面と状態を聞く。上限つき）
//  - エージェントへ返す文面の組み立て（ペイントークンは絶対に載せない）
// だけを受け持ち、範囲（同じスペースか・自分が作ったものか）の判断はウィンドウ側が行う。

import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import {
	IParadisAgentIdeInternal,
	PARADIS_AGENT_IDE_CHANNEL,
	PARADIS_AGENT_IDE_METHOD,
	PARADIS_AGENT_IDE_TOOLS,
	PARADIS_AGENT_IDE_TOOL_NAMES,
	ParadisAgentIdeActionScope,
	ParadisAgentIdeRequest,
	ParadisAgentIdeResult,
	ParadisAgentIdeTerminalStatus,
	ParadisAgentIdeWaitCondition,
	ParadisAgentStopWatcher,
	paradisAgentIdeNeedsHuman,
	paradisAgentIdeStatusLabel,
	paradisParseAgentIdeCall,
} from '../common/paradisAgentIde.js';
import { PARADIS_AGENT_IDE_SERVER_INSTRUCTIONS, paradisAgentIdeGuide } from '../common/paradisAgentIdeGuide.js';

/** 設定の読み手（shared process の IConfigurationService を包む。テストでは差し替える）。 */
export interface IParadisAgentIdeSettings {
	actionsEnabled(): boolean;
	actionScope(): ParadisAgentIdeActionScope;
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
/** 待機で見る画面の行数と、結果に添える行数。 */
const WAIT_SCREEN_LINES = 80;
const WAIT_RESULT_TAIL_LINES = 20;

/** worktree の作成（命名・git worktree add・setup スクリプト）を待つ上限。 */
const CREATE_SPACE_TIMEOUT_MS = 150_000;
/** ターミナルを開いてシェルが立ち上がるのを待つ上限。 */
const OPEN_TERMINAL_TIMEOUT_MS = 30_000;

const ACTIONS_DISABLED_MESSAGE = 'Para Code does not allow agents to send input to terminals or to create and close terminals and spaces. Only the user can allow it: Para Code settings > "Agent control" > "Allow agents to operate terminals and spaces". Tell the user what you wanted to do; do not try to change the setting yourself.';
const NEEDS_HUMAN_MESSAGE = 'That terminal is waiting for the user to answer a permission request or a question, so Para Code does not send anything to it. Tell the user which terminal is waiting (its id and title from list_terminals) and let them answer.';

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
				return toolText(paradisAgentIdeGuide({ actionsEnabled: this.settings.actionsEnabled(), actionScope: this.settings.actionScope() }));
		}
		if (!context) {
			return toolError('This Para Code build cannot route IDE tools to its window. Update Para Code.');
		}
		if (parsed.kind === 'wait') {
			return this._wait(paneToken, parsed.terminal, parsed.until, parsed.text, parsed.timeoutSeconds, context, signal);
		}
		if (parsed.action && !this.settings.actionsEnabled()) {
			return toolError(ACTIONS_DISABLED_MESSAGE);
		}
		const request = parsed.request;
		if (request.op === 'sendInput' || request.op === 'sendKey') {
			// 送る前に、hook から分かる最新の状態で「人の答えを待っていないか」を確かめる。
			// ウィンドウ側の表示は 2 秒ごとの取り直しなので、そちらだけでは許可待ちへ入った直後に送りうる。
			const target = await this._callWindow(paneToken, { op: 'resolveWriteTarget', terminal: request.terminal }, name, context, signal);
			if (!target.ok) {
				return toolError(target.error);
			}
			if (this._needsHuman(target.internal, context)) {
				return toolError(NEEDS_HUMAN_MESSAGE);
			}
		}
		const result = await this._callWindow(paneToken, request, name, context, signal);
		if (!result.ok) {
			return toolError(result.error);
		}
		if (request.op === 'listSpaces' || request.op === 'listTerminals') {
			return toolText({ actions_enabled: this.settings.actionsEnabled(), action_scope: this.settings.actionScope(), ...result.data });
		}
		return toolText(result.data);
	}

	private _needsHuman(internal: IParadisAgentIdeInternal | undefined, context: IParadisMcpToolCallContext): boolean {
		const status = this._statusOf(internal, context);
		return paradisAgentIdeNeedsHuman(status);
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
		const stopWatcher = new ParadisAgentStopWatcher(startedAt);
		let lastStatus: ParadisAgentIdeTerminalStatus = 'idle';
		let lastScreen: string | undefined;

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
			const probe = await this._callWindow(paneToken, { op: 'probeTerminal', terminal, lines: WAIT_SCREEN_LINES }, 'wait_for_terminal', context, signal);
			if (!probe.ok) {
				return toolError(probe.error);
			}
			if (probe.internal?.gone) {
				return report(false, { reason: 'The terminal was closed.' });
			}
			lastScreen = probe.internal?.screen;
			lastStatus = this._statusOf(probe.internal, context);
			const hookStatus = probe.internal?.paneToken !== undefined ? context.getPaneAgentStatus(probe.internal.paneToken) : undefined;
			const now = this.clock.now();

			let met = false;
			switch (until) {
				case 'needs_input':
					met = paradisAgentIdeNeedsHuman(lastStatus);
					break;
				case 'text':
					met = text !== undefined && (lastScreen ?? '').includes(text);
					break;
				case 'agent_stopped':
					met = stopWatcher.observe(lastStatus, hookStatus?.changedAt, now);
					break;
			}
			if (met) {
				return report(true);
			}
			if (now >= deadline) {
				return report(false, { timed_out: true, hint: 'Not reached yet. Call wait_for_terminal again to keep waiting.' });
			}
			await this.clock.sleep(Math.min(WAIT_POLL_MS, deadline - now), signal);
		}
	}
}
