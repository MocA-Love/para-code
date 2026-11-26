// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash } from 'node:crypto';
import type { ITaskBoardManualSession, ITaskBoardPaneAsk, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import type { TaskBoardEngine } from '@engine/paradisTaskBoardEngine.js';
import { TASK_BOARD_ASKS_ROUTE, TASK_BOARD_ASKS_SETTLE_ROUTE, taskBoardApplyAskAnswer, taskBoardAskOf, taskBoardAsks, type ITaskBoardAskAnswerEvent } from '@engine/paradisTaskBoardAsks.js';

/*
 * ボードの「あなたの番」を、Para Code の「人が答えるもの」の台帳へ写す。
 *
 * 真の記録はボードの台帳（state.json）のまま。ここでは、今の人の出番の丸ごとの一覧を接続口の `PUT /v1/asks` へ
 * 送り、Para Code の側（受信箱など）で答えられたら SSE の `ask-answer` を受けて、ボードの画面のボタンと同じ
 * エンジンの操作をする。結果は `POST /v1/asks/settle` で必ず返す（返さないと、その 1 件はほかの場所から
 * 答えられないまま残る）。
 *
 * 一覧は 1 本ずつ送る（順序が入れ替わると古い一覧が新しい一覧を上書きする）。送っている間に変わった分は、
 * 終わってから最新の 1 回にまとめる。変わっていなくても一定の間隔で送り直す: Para Code の台帳は、届かなかった
 * 答えを待ちへ戻すのも、同じ id で出直した問い（「報告を促す」の後にまた止まった等）を戻すのも、次に一覧が
 * 届いたときに行うため。
 */

/** 送り直す間隔。 */
const RESEND_MS = 15_000;
/** ボードの画面で答えた印を覚えておく時間（操作が失敗して一覧に残ったままの印を、後の取り下げに使わない）。 */
const ANSWERED_HERE_TTL_MS = 60_000;

/** 台帳の名前（リポジトリごとの保存先から作る 16 桁）。別のリポジトリの同じ番号のタスクと id が重ならないようにする。 */
export function askLedgerId(directory: string): string {
	return createHash('sha256').update(directory).digest('hex').slice(0, 16);
}

/** 一覧に出すボードの外のペインの待ちの数の上限（画面の Dock と「あなたの番」に並べる分）。 */
const PANE_ASKS_SHOWN = 50;

/**
 * Para Code が流してきたボードの外のペインの待ちを、「フロー外のエージェント」の欄の 1 件にする。形の合わない 1 件は捨てる
 * （接続口が作ったものだけが来る前提だが、画面に出す前に型だけは確かめる）。
 */
export function taskBoardPaneManualSessions(asks: readonly unknown[]): ITaskBoardManualSession[] {
	const sessions: ITaskBoardManualSession[] = [];
	for (const value of asks) {
		const ask = value as ITaskBoardPaneAsk;
		if (!ask || typeof ask.key !== 'string' || (ask.kind !== 'question' && ask.kind !== 'permission') || typeof ask.from?.title !== 'string' || typeof ask.text !== 'string' || typeof ask.askedAt !== 'number') {
			continue;
		}
		sessions.push({
			id: ask.key,
			name: ask.from.title,
			...(typeof ask.from.detail === 'string' ? { branch: ask.from.detail } : {}),
			status: ask.kind,
			text: ask.text,
			since: ask.askedAt,
			ask,
		});
		if (sessions.length >= PANE_ASKS_SHOWN) {
			break;
		}
	}
	return sessions;
}

/** 画面の選択肢から、接続口へ送る答えを作る。Para Code が流してきた選択肢でなければ undefined（許可には答えない）。 */
export function taskBoardPaneAskAnswer(ask: ITaskBoardPaneAsk, pressed: { readonly optionId?: string }): unknown {
	return pressed.optionId !== undefined && ask.questionId !== undefined && ask.options?.some(option => option.id === pressed.optionId)
		? { type: 'answers', answers: [{ questionId: ask.questionId, optionIds: [pressed.optionId] }] }
		: undefined;
}

export interface IAskPublisherOptions {
	readonly engine: () => TaskBoardEngine;
	/** 接続口への要求（ParaCodeBridgeClient.request）。 */
	readonly request: (method: 'PUT' | 'POST', route: string, body: unknown) => Promise<unknown>;
	readonly ledgerId: string;
	/** そのタスクのエージェントが動いているターミナル（Para Code がペインへ引き直す）。 */
	readonly terminalOf?: (task: ITaskBoardTask) => string | undefined;
	readonly log?: (message: string) => void;
	readonly resendMs?: number;
	readonly clock?: () => number;
}

export class AskPublisher {
	private connected = false;
	private disposed = false;
	private sending = false;
	private dirty = false;
	/** 最後に送れた一覧（同じ中身を変更のたびに送らない）。 */
	private sent: string | undefined;
	/** ボードの画面で答えた 1 件（id → 印を付けた時刻）。一覧から外れたときに「回答済み」として知らせる。 */
	private readonly answeredHere = new Map<string, number>();
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly options: IAskPublisherOptions) { }

	private now(): number {
		return (this.options.clock ?? Date.now)();
	}

	/** id → タスク（id を分解せずに引き当てる。タスクの id に `:` が入りうるため）。 */
	private tasksById(): Map<string, ITaskBoardTask> {
		const engine = this.options.engine();
		const byId = new Map<string, ITaskBoardTask>();
		for (const task of engine.getTasks()) {
			const ask = taskBoardAskOf(task, engine.flowOf(task), this.options.ledgerId);
			if (ask) {
				byId.set(ask.id, task);
			}
		}
		return byId;
	}

	start(): void {
		this.timer = setInterval(() => this.publish(true), this.options.resendMs ?? RESEND_MS);
		this.timer.unref?.();
	}

	/** 接続口の SSE がつながった・切れた。つながるたびに丸ごと送り直す（Para Code の側は切れたときに取り下げている）。 */
	onConnection(connected: boolean): void {
		this.connected = connected;
		if (connected) {
			this.publish(true);
		}
	}

	onEngineChange(): void {
		this.publish(false);
	}

	/**
	 * ボードの画面の操作（回答・承認・差し戻し・やり直し など）の前に呼ぶ。そのタスクの今の 1 件が操作の後に一覧から
	 * 外れたら、Para Code の台帳では「ボードで回答済み」になる（印が無ければ取り下げ）。
	 */
	markAnsweredHere(taskId: string): string | undefined {
		const engine = this.options.engine();
		const task = engine.getTask(taskId);
		const ask = task ? taskBoardAskOf(task, engine.flowOf(task), this.options.ledgerId) : undefined;
		if (ask) {
			this.answeredHere.set(ask.id, this.now());
		}
		return ask?.id;
	}

	/** 操作が失敗した。印を外す（その後にターミナルで答えられても「ボードで回答済み」としない）。 */
	unmarkAnsweredHere(id: string | undefined): void {
		if (id !== undefined) {
			this.answeredHere.delete(id);
		}
	}

	private publish(force: boolean): void {
		if (this.disposed || !this.connected) {
			return;
		}
		this.dirty = true;
		if (force) {
			this.sent = undefined;
		}
		if (!this.sending) {
			void this.drain();
		}
	}

	private async drain(): Promise<void> {
		this.sending = true;
		try {
			while (this.dirty && !this.disposed && this.connected) {
				this.dirty = false;
				const engine = this.options.engine();
				const tasks = this.tasksById();
				const asks = taskBoardAsks(engine.getTasks(), task => engine.flowOf(task), this.options.ledgerId).map(ask => {
					const task = tasks.get(ask.id);
					const terminal = task ? this.options.terminalOf?.(task) : undefined;
					return terminal !== undefined ? { ...ask, terminal } : ask;
				});
				const current = new Set(asks.map(ask => ask.id));
				const at = this.now();
				for (const [id, markedAt] of [...this.answeredHere]) {
					if (at - markedAt >= ANSWERED_HERE_TTL_MS) {
						this.answeredHere.delete(id);
					}
				}
				const answered = [...this.answeredHere.keys()].filter(id => !current.has(id));
				const body = JSON.stringify(asks);
				if (body === this.sent && answered.length === 0) {
					continue;
				}
				try {
					await this.options.request('PUT', TASK_BOARD_ASKS_ROUTE, { asks, ...(answered.length ? { answered } : {}) });
					this.sent = body;
					for (const id of answered) {
						this.answeredHere.delete(id);
					}
				} catch (err) {
					// 次の送り直し（一定の間隔・つなぎ直し）に任せる
					this.sent = undefined;
					this.options.log?.(`asks: ${(err as Error).message}`);
					return;
				}
			}
		} finally {
			this.sending = false;
		}
	}

	/**
	 * Para Code の台帳の側で答えられた。今の一覧から id で引き当て、ボードの画面と同じ操作をして、結果を必ず返す。
	 * 引き当てられない（もう待っていない）・操作が断られたときは「届かなかった」で返す。
	 */
	async onAskAnswer(event: ITaskBoardAskAnswerEvent): Promise<void> {
		if (this.disposed) {
			return;
		}
		let ok = false;
		let message: string | undefined;
		try {
			const engine = this.options.engine();
			const task = this.tasksById().get(event.id);
			const ask = task ? taskBoardAskOf(task, engine.flowOf(task), this.options.ledgerId) : undefined;
			if (!task || !ask) {
				message = 'the task is no longer waiting for this answer';
			} else {
				taskBoardApplyAskAnswer(engine, task, engine.flowOf(task), ask, event.answer);
				ok = true;
			}
		} catch (err) {
			message = (err as Error).message;
		}
		try {
			await this.options.request('POST', TASK_BOARD_ASKS_SETTLE_ROUTE, { claim: event.claim, ok, ...(message !== undefined ? { message } : {}) });
		} catch (err) {
			// 返せなかった結果は、次の一覧で決まる（外れていれば回答済み、残っていれば時間切れの後に待ちへ戻る）
			this.options.log?.(`asks settle: ${(err as Error).message}`);
		}
		this.publish(true);
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
}
