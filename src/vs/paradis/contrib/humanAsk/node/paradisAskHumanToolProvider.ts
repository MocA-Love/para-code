/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の `ask_human`（shared process）。どのペインのエージェントからでも、人に問いを出せる。
//
// 書く: 問いを「人が答えるもの」の台帳へ 1 件載せる（持ち主 `askHuman`、出どころ `pane`）。道具は待たずにすぐ返し、
// エージェントはターンを終える（ボードの board_ask_human と同じ）。
//
// 届ける: 台帳から回答の依頼が来たら、ペインを持っているウィンドウへ流す。ウィンドウは PC のチャット表示と同じ口
// （ParadisAgentChatInput.sendMessage。エージェントが前面で動いていて、許可・質問の画面が出ていないと確かめてから
// 次の発言として送る）で届け、結果を返す。返事が無ければ時間切れで「届かなかった」にする（その間にそのペインで
// 発言が送られていれば「届いた」にする）。
//
// 守り:
//  - 呼び出し元はそのペインのシェルの子孫に限る（`classifyCaller` が `pane`）。SSH の戻り経路・確かめられない
//    呼び出しは断る（トークンは同じユーザーの別プロセスからも読めるため）
//  - 1 ペインの待ちは 1 件。新しい問いは前の問いを取り下げる（Orca と同じ）。1 ペインから 1 分に
//    {@link PARADIS_ASK_HUMAN_RATE_PER_MINUTE} 回まで
//  - そのペインで利用者が次の発言を送った・会話が終わった・ターミナルが閉じたら取り下げる

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider, paradisMcpToolError as toolError } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { paradisIsHarnessNotificationPrompt } from '../../agentBrowser/common/paradisAgentStatusStale.js';
import type { IParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { paradisAgentDescriptor } from '../../agentChat/common/paradisAgentDescriptor.js';
import { paradisInboxPaneKey } from '../../notificationInbox/common/paradisNotificationInbox.js';
import { IParadisHumanAskAnswerRequest, paradisHumanAskKey } from '../common/paradisHumanAsk.js';
import { PARADIS_HUMAN_ASK_LEDGER_DEFAULTS } from '../common/paradisHumanAskLedger.js';
import { IParadisHumanAskPaneAnswerRequest } from '../common/paradisHumanAskPane.js';
import {
	PARADIS_ASK_HUMAN_DESCRIBE_METHOD,
	PARADIS_ASK_HUMAN_OWNER,
	PARADIS_ASK_HUMAN_RATE_PER_MINUTE,
	PARADIS_ASK_HUMAN_TOOL,
	PARADIS_ASK_HUMAN_TOOL_DEFINITION,
	PARADIS_ASK_HUMAN_WINDOW_CHANNEL,
	paradisAskHumanAdvice,
	paradisAskHumanAnswerMessage,
	paradisAskHumanLedgerInput,
	paradisParseAskHumanArgs,
	paradisSanitizeAskHumanPaneLabel,
} from '../common/paradisAskHumanTool.js';
import type { ParadisHumanAskService } from './paradisHumanAskChannel.js';

/** 台帳のうち、この持ち主が使う分（本物は ParadisHumanAskService。テストでも本物を渡す）。 */
export type IParadisAskHumanLedger = Pick<ParadisHumanAskService, 'onDidRequestAnswer' | 'get' | 'upsert' | 'resolve' | 'reject' | 'withdraw' | 'removeOwner'>;

const CALLER_MESSAGE = 'ask_human only works for an agent running in a local Para Code terminal pane. Ask in the conversation instead.';
const RATE_MESSAGE = `Too many questions from this terminal (up to ${PARADIS_ASK_HUMAN_RATE_PER_MINUTE} a minute). Wait for the person's answer instead of asking again.`;
const WINDOW_MESSAGE = 'Para Code could not identify the window and space of this terminal. Retry in a few seconds, or ask in the conversation.';
const BUSY_MESSAGE = 'The person\'s answer to your earlier question is being delivered to this terminal right now. Wait for it instead of asking again.';
const FULL_MESSAGE = 'Para Code could not add the question (too many questions are waiting). Ask in the conversation instead.';

interface IPaneAsk {
	readonly key: string;
	/** 届けている最中の依頼（依頼の番号と時間切れのタイマー）と、その間にそのペインで発言が送られたか。 */
	delivering?: { readonly claim: string; readonly windowId: number; prompted: boolean };
}

export interface IParadisAskHumanToolOptions {
	readonly now?: () => number;
	readonly newId?: () => string;
	/** 返事を待つ時間。台帳の「届かなかった」とみなす時間より少し長くする。 */
	readonly settleTimeoutMs?: number;
}

export class ParadisAskHumanToolProvider extends Disposable implements IParadisMcpToolProvider {

	readonly cliGroup = 'ide' as const;

	private readonly _onDidRequestPaneAnswer = this._register(new Emitter<IParadisHumanAskPaneAnswerRequest>());
	/** ペインを持っているウィンドウへの、回答を届ける依頼。 */
	readonly onDidRequestPaneAnswer: Event<IParadisHumanAskPaneAnswerRequest> = this._onDidRequestPaneAnswer.event;

	/** ペインの鍵 → そのペインの待ち（1 件）。 */
	private readonly asks = new Map<string, IPaneAsk>();
	/** ペインの鍵 → 最近の呼び出しの時刻。 */
	private readonly calls = new Map<string, number[]>();
	private readonly timers = this._register(new DisposableMap<string>());
	private readonly now: () => number;
	private readonly newId: () => string;
	private readonly settleTimeoutMs: number;

	constructor(private readonly ledger: IParadisAskHumanLedger, options: IParadisAskHumanToolOptions = {}) {
		super();
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? generateUuid;
		this.settleTimeoutMs = options.settleTimeoutMs ?? PARADIS_HUMAN_ASK_LEDGER_DEFAULTS.claimTimeoutMs + 1_000;
		this._register(ledger.onDidRequestAnswer(request => this.deliver(request)));
		this._register(toDisposable(() => ledger.removeOwner(PARADIS_ASK_HUMAN_OWNER)));
	}

	listTools(): readonly IParadisMcpToolDefinition[] {
		return [PARADIS_ASK_HUMAN_TOOL_DEFINITION];
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (name !== PARADIS_ASK_HUMAN_TOOL) {
			return undefined;
		}
		// 問いの答えはそのペインへ打ち込まれる。そのペインの中から来たと確かめられないものは受けない
		if (context === undefined || (await context.classifyCaller()) !== 'pane') {
			return toolError(CALLER_MESSAGE);
		}
		const parsed = paradisParseAskHumanArgs(args);
		if (!parsed.ok) {
			return toolError(parsed.message);
		}
		const paneKey = paradisInboxPaneKey(paneToken);
		if (!this.takeCall(paneKey)) {
			return toolError(RATE_MESSAGE);
		}
		const previous = this.asks.get(paneKey);
		if (previous?.delivering !== undefined) {
			return toolError(BUSY_MESSAGE);
		}
		const call = await context.callOwningWindow<unknown>({
			channelName: PARADIS_ASK_HUMAN_WINDOW_CHANNEL,
			method: PARADIS_ASK_HUMAN_DESCRIBE_METHOD,
			args: [paneToken],
			failureLabel: PARADIS_ASK_HUMAN_TOOL,
			failureMessage: WINDOW_MESSAGE,
		}, signal);
		const label = call.ok ? paradisSanitizeAskHumanPaneLabel(call.value) : undefined;
		if (label === undefined) {
			return toolError(call.ok ? WINDOW_MESSAGE : call.error);
		}
		// 名札を引く間に、同じペインの別の問いが届けられ始めた
		if (this.asks.get(paneKey)?.delivering !== undefined) {
			return toolError(BUSY_MESSAGE);
		}
		this.withdrawPane(paneKey);
		const agent = paradisAgentDescriptor(context.getCursorIdentity?.(paneToken).cli)?.displayName;
		const id = `ask:${paneKey}:${this.newId()}`;
		const input = paradisAskHumanLedgerInput(id, paneKey, label, agent, parsed.value, this.now());
		if (!this.ledger.upsert(PARADIS_ASK_HUMAN_OWNER, input)) {
			return toolError(FULL_MESSAGE);
		}
		this.asks.set(paneKey, { key: paradisHumanAskKey('pane', id) });
		const advice = paradisAskHumanAdvice(parsed.value);
		return {
			content: [{
				type: 'text',
				text: ['Asked. The person can answer from the Para Code inbox; the answer will arrive as the user\'s next message. End your turn now and wait.', ...(advice !== undefined ? [advice] : [])].join('\n'),
			}],
		};
	}

	/** 1 分の上限の内なら数えて true。 */
	private takeCall(paneKey: string): boolean {
		const at = this.now();
		const recent = (this.calls.get(paneKey) ?? []).filter(time => at - time < 60_000);
		if (recent.length >= PARADIS_ASK_HUMAN_RATE_PER_MINUTE) {
			this.calls.set(paneKey, recent);
			return false;
		}
		recent.push(at);
		this.calls.set(paneKey, recent);
		return true;
	}

	/** そのペインの待ちを取り下げる。 */
	private withdrawPane(paneKey: string): void {
		const ask = this.asks.get(paneKey);
		if (ask === undefined) {
			return;
		}
		this.asks.delete(paneKey);
		this.timers.deleteAndDispose(ask.key);
		this.ledger.withdraw(PARADIS_ASK_HUMAN_OWNER, ask.key);
	}

	/** hook のイベント（shared process のバス）。利用者の発言・会話の終わり・ターミナルの終わりで取り下げる。 */
	onHookEvent(event: IParadisAgentHookEvent): void {
		if (this.asks.size === 0 && this.calls.size === 0) {
			return;
		}
		const paneKey = paradisInboxPaneKey(event.token);
		if (event.event === 'TerminalExit') {
			this.calls.delete(paneKey);
		}
		const ask = this.asks.get(paneKey);
		if (ask === undefined) {
			return;
		}
		if (event.event === 'TerminalExit' || event.event === 'SessionEnd') {
			this.withdrawPane(paneKey);
			return;
		}
		if (event.event !== 'UserPromptSubmit' || paradisIsHarnessNotificationPrompt(event.payload?.prompt)) {
			return;
		}
		if (ask.delivering !== undefined) {
			// 届けた答えそのものの発言（結果の知らせより先に来ることがある）。結果は知らせか時間切れで決める
			ask.delivering.prompted = true;
			return;
		}
		// 利用者がターミナルで先に答えた・別の話を始めた
		this.withdrawPane(paneKey);
	}

	private deliver(request: IParadisHumanAskAnswerRequest): void {
		if (request.owner !== PARADIS_ASK_HUMAN_OWNER) {
			return;
		}
		const paneKey = request.paneKey;
		const ask = paneKey !== undefined ? this.asks.get(paneKey) : undefined;
		const entry = this.ledger.get(request.key);
		const text = entry !== undefined ? paradisAskHumanAnswerMessage(entry, request.answer) : undefined;
		if (paneKey === undefined || request.windowId === undefined || ask === undefined || ask.key !== request.key || text === undefined) {
			this.ledger.reject(PARADIS_ASK_HUMAN_OWNER, request.key, request.claim);
			return;
		}
		const timer = setTimeout(() => {
			if (ask.delivering?.claim !== request.claim) {
				return;
			}
			// 返事が来ない（ウィンドウが閉じた・再読み込み中）。その間にそのペインで発言が送られていれば届いたとみなす
			this.settle(`window:${request.windowId}`, request.claim, request.key, ask.delivering.prompted);
		}, this.settleTimeoutMs);
		const disposable = toDisposable(() => clearTimeout(timer));
		this.timers.set(request.key, disposable);
		ask.delivering = { claim: request.claim, windowId: request.windowId, prompted: false };
		this._onDidRequestPaneAnswer.fire({
			claim: request.claim,
			key: request.key,
			paneKey,
			windowId: request.windowId,
			interactionId: request.key,
			delivery: { kind: 'message', text },
		});
	}

	/**
	 * ウィンドウが届け終えた（`delivered`）か、届けられなかった。依頼を流したウィンドウ（`ctx`）からの、今の依頼の番号の
	 * 知らせでなければ何もしない（遅れて届いた古い結果・別のウィンドウからの知らせ）。
	 */
	settle(ctx: string, claim: unknown, key: unknown, delivered: unknown): void {
		if (typeof claim !== 'string' || typeof key !== 'string') {
			return;
		}
		for (const [paneKey, ask] of this.asks) {
			if (ask.key !== key || ask.delivering?.claim !== claim || ctx !== `window:${ask.delivering.windowId}`) {
				continue;
			}
			ask.delivering = undefined;
			this.timers.deleteAndDispose(key);
			if (delivered === true) {
				this.asks.delete(paneKey);
				this.ledger.resolve(PARADIS_ASK_HUMAN_OWNER, key);
			} else {
				this.ledger.reject(PARADIS_ASK_HUMAN_OWNER, key, claim);
			}
			return;
		}
	}
}

/** ウィンドウへ出すチャネル。依頼は、そのペインを持っているウィンドウ（`listen` の引数の windowId）にだけ流す。 */
export class ParadisAskHumanChannel implements IServerChannel<string> {

	constructor(private readonly provider: ParadisAskHumanToolProvider) { }

	listen<T>(_ctx: string, event: string, arg?: unknown): Event<T> {
		switch (event) {
			case 'onDidRequestPaneAnswer': return Event.filter(this.provider.onDidRequestPaneAnswer, request => request.windowId === arg) as Event<T>;
			default: throw new Error(`Event not found: ${event}`);
		}
	}

	async call<T>(ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'settle': this.provider.settle(ctx, args[0], args[1], args[2]); return undefined as T;
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}
