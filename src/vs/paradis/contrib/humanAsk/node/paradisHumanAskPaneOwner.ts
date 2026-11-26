/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「人が答えるもの」の台帳の、ペインの分の持ち主（shared process）。
//
// 書く: 中継（モバイル向けに質問・承認を見ている所）が持っている今の待ちを読み、台帳へ丸ごと知らせる。読むのは
// 中継がもう持っているものだけで、ここから tailer を起こしたり、定期的に読み直したりはしない（中継の「ペインの様子が
// 変わった」の知らせと、通知の台帳の変化のときだけ読む）。
//
// 届ける: 台帳から回答の依頼が来たら、今の待ちから写し直した 1 件が、答えたときの 1 件と丸ごと同じかを確かめてから、
// ペインを持っているウィンドウへ流す。ウィンドウは PC のチャット表示・タスクボードと同じ口（ParadisAgentChatInput。
// スマホと同じ claim を取り、画面を確かめてから打鍵する）で届け、結果を返す。依頼は必ず「回答済み」「届かなかった」の
// どちらかで終える（返事が来なければ、時間切れの後に一覧を知らせ直して台帳に決めさせる）。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisSharedNotificationInboxService } from '../../notificationInbox/node/paradisNotificationInboxChannel.js';
import { IParadisHumanAskAnswerRequest, IParadisHumanAskInput, paradisHumanAskKey } from '../common/paradisHumanAsk.js';
import { PARADIS_HUMAN_ASK_LEDGER_DEFAULTS } from '../common/paradisHumanAskLedger.js';
import {
	IParadisHumanAskPaneAnswerRequest,
	IParadisHumanAskPaneLabel,
	IParadisHumanAskPaneSource,
	PARADIS_HUMAN_ASK_PANE_OWNER,
	PARADIS_HUMAN_ASK_PANES_CHANNEL,
	paradisHumanAskPaneDelivery,
	paradisHumanAskPaneInput,
} from '../common/paradisHumanAskPane.js';
import { ParadisHumanAskService, paradisSharedHumanAskService } from './paradisHumanAskChannel.js';

/** 中継と通知の台帳の知らせをまとめてから読む間隔。 */
const REFRESH_DELAY = 50;

/** ペインの名札の出どころ（通知の台帳）。 */
export interface IParadisHumanAskPaneLabels {
	readonly onDidChange: Event<unknown>;
	get(paneKey: string): IParadisHumanAskPaneLabel | undefined;
}

interface IListed {
	readonly interactionId: string;
	readonly input: IParadisHumanAskInput;
}

export class ParadisHumanAskPaneOwner extends Disposable {

	private readonly _onDidRequestPaneAnswer = this._register(new Emitter<IParadisHumanAskPaneAnswerRequest>());
	/** ペインを持っているウィンドウへの、回答を届ける依頼。 */
	readonly onDidRequestPaneAnswer: Event<IParadisHumanAskPaneAnswerRequest> = this._onDidRequestPaneAnswer.event;

	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => this.refresh(), REFRESH_DELAY));
	/** 届けている最中の依頼（鍵 → 依頼の番号と、時間切れの後に一覧を知らせ直すタイマー）。 */
	private readonly delivering = this._register(new DisposableMap<string, IDisposable & { readonly claim: string }>());

	constructor(
		private readonly source: IParadisHumanAskPaneSource,
		private readonly labels: IParadisHumanAskPaneLabels,
		private readonly service: ParadisHumanAskService,
		private readonly logService: Pick<ILogService, 'trace'>,
		/** 返事を待つ時間。台帳の「届かなかった」とみなす時間より少し長くする。 */
		private readonly settleTimeoutMs = PARADIS_HUMAN_ASK_LEDGER_DEFAULTS.claimTimeoutMs + 1_000,
	) {
		super();
		this._register(source.onDidChange(() => this.refreshScheduler.schedule()));
		this._register(labels.onDidChange(() => this.refreshScheduler.schedule()));
		this._register(service.onDidRequestAnswer(request => this.deliver(request)));
		this._register(toDisposable(() => this.service.removeOwner(PARADIS_HUMAN_ASK_PANE_OWNER)));
		this.refresh();
	}

	/** 今の待ち（鍵 → 写した 1 件）。名札をまだ引けないペインは載せない（どのペインの問いか出せないものを押させない）。 */
	private read(): Map<string, IListed> {
		const listed = new Map<string, IListed>();
		for (const state of this.source.read()) {
			const label = this.labels.get(state.paneKey);
			const input = label !== undefined ? paradisHumanAskPaneInput(state, label) : undefined;
			if (input !== undefined) {
				listed.set(paradisHumanAskKey(input.source, input.id), { interactionId: state.interaction.id, input });
			}
		}
		return listed;
	}

	/** 今の待ちを台帳へ丸ごと知らせる。 */
	refresh(): void {
		const refused = this.service.sync(PARADIS_HUMAN_ASK_PANE_OWNER, [...this.read().values()].map(item => item.input));
		if (refused > 0) {
			this.logService.trace(`[paradisHumanAsk] ${refused} pane ask(s) did not fit the ledger`);
		}
	}

	private deliver(request: IParadisHumanAskAnswerRequest): void {
		if (request.owner !== PARADIS_HUMAN_ASK_PANE_OWNER) {
			return;
		}
		// 答えたときの 1 件（台帳が持っているもの）と、今の待ちから写し直した 1 件を比べる。選択肢の id は並びの番号なので、
		// 問い・選択肢・ボタンのどれかが変わっていたら、同じ id でも別の選択肢に入る。丸ごと同じときだけ届ける
		const answered = this.service.get(request.key);
		const current = this.read().get(request.key);
		const delivery = current !== undefined && answered !== undefined ? paradisHumanAskPaneDelivery(current.input, request.answer) : undefined;
		if (current === undefined || answered === undefined || delivery === undefined || current.input.paneKey === undefined || current.input.windowId === undefined
			|| JSON.stringify([current.input.questions, current.input.actions]) !== JSON.stringify([answered.questions, answered.actions])) {
			this.service.reject(PARADIS_HUMAN_ASK_PANE_OWNER, request.key, request.claim);
			this.refreshScheduler.schedule();
			return;
		}
		// 返事が来ないとき（ウィンドウが閉じた・再読み込み中）は、時間切れの後に一覧を知らせ直す。まだ待っていれば
		// 台帳が「届かなかった」にし、もう待っていなければ「回答済み」にする
		const timer = setTimeout(() => {
			if (this.delivering.get(request.key)?.claim === request.claim) {
				this.delivering.deleteAndDispose(request.key);
				this.refresh();
			}
		}, this.settleTimeoutMs);
		this.delivering.set(request.key, { claim: request.claim, dispose: () => clearTimeout(timer) });
		this._onDidRequestPaneAnswer.fire({
			claim: request.claim,
			key: request.key,
			paneKey: current.input.paneKey,
			windowId: current.input.windowId,
			interactionId: current.interactionId,
			delivery,
		});
	}

	/** ウィンドウが届け終えた（`delivered`）か、届けられなかった。今の依頼の番号でなければ何もしない（遅れて届いた古い結果）。 */
	settle(claim: unknown, key: unknown, delivered: unknown): void {
		if (typeof claim !== 'string' || typeof key !== 'string' || this.delivering.get(key)?.claim !== claim) {
			return;
		}
		this.delivering.deleteAndDispose(key);
		if (delivered === true) {
			this.service.resolve(PARADIS_HUMAN_ASK_PANE_OWNER, key);
		} else {
			this.service.reject(PARADIS_HUMAN_ASK_PANE_OWNER, key, claim);
		}
		this.refreshScheduler.schedule();
	}
}

/** ウィンドウへ出すチャネル。依頼は、そのペインを持っているウィンドウ（`listen` の引数の windowId）にだけ流す。 */
export class ParadisHumanAskPaneChannel implements IServerChannel<string> {

	constructor(private readonly owner: ParadisHumanAskPaneOwner) { }

	listen<T>(_ctx: string, event: string, arg?: unknown): Event<T> {
		switch (event) {
			case 'onDidRequestPaneAnswer': return Event.filter(this.owner.onDidRequestPaneAnswer, request => request.windowId === arg) as Event<T>;
			default: throw new Error(`Event not found: ${event}`);
		}
	}

	async call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'settle': this.owner.settle(args[0], args[1], args[2]); return undefined as T;
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}

/** 通知の台帳から、そのペインの名札と持っているウィンドウを引く。 */
function inboxLabels(): IParadisHumanAskPaneLabels {
	const inbox = paradisSharedNotificationInboxService();
	return {
		onDidChange: inbox.onDidChange,
		get: paneKey => {
			const entry = inbox.latestOfPane(paneKey);
			return entry === undefined || !entry.live ? undefined : {
				windowId: entry.windowId,
				space: entry.space,
				...(entry.stateKey !== undefined ? { stateKey: entry.stateKey } : {}),
				...(entry.worktree !== undefined ? { worktree: entry.worktree } : {}),
				...(entry.tab !== undefined ? { tab: entry.tab } : {}),
			};
		},
	};
}

/** shared process の登録口（中継の登録 registerParadisMobileRelay から、今の待ちの読むだけの口を受け取る）。 */
export function registerParadisHumanAskPaneOwner(server: IPCServer, source: IParadisHumanAskPaneSource, logService: ILogService): IDisposable {
	const owner = new ParadisHumanAskPaneOwner(source, inboxLabels(), paradisSharedHumanAskService(), logService);
	server.registerChannel(PARADIS_HUMAN_ASK_PANES_CHANNEL, new ParadisHumanAskPaneChannel(owner));
	return owner;
}
