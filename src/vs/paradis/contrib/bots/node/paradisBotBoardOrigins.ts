/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「Bot が載せたタスクを、タスクボードが動かしたペイン」の印の表。shared process のメモリに持ち、
// `<userData>/paradis/bots/panes.json` に Bot の結び付けと一緒に保存する。
//
// - Bot が bot_board_add_task で載せたタスクの id と Bot を控える（項目を閉じた・結び付けが外れた・Bot を消した後も残す）
// - ボードの接続口が、そのタスクのためにペインを起動した・そのペインへ工程の指示を送ったら、ペインに印を付ける。
//   鍵は接続口のターミナルの id（ペイントークンの SHA-1 の頭。paradisTaskBoardTerminalId）で、トークンの値は持たない。
//   接続口が自分の MCP の道具で使う鍵と同じなので、道具の呼び出しのときにトークンから引き直せる
// - 印は外さない。印のあるペインは Bot ではない（bot_item_* などは使えない）が、Bot を変える道具と IDE の操作を断られる

import { isPlainRecord } from '../../../common/paradisGuards.js';

/** 控えるタスクと、印を付けるペインの上限（古いものから落とす）。 */
export const PARADIS_BOT_BOARD_ORIGINS_LIMIT = 1000;

/** Bot が載せたタスク 1 件。 */
export interface IParadisBotBoardTaskRecord {
	readonly taskId: string;
	readonly botId: string;
	readonly at: number;
}

/** Bot が載せたタスクのために、ボードが動かしたペイン 1 件。`terminal` はボードの接続口のターミナルの id（トークンのハッシュ）。 */
export interface IParadisBotBoardPaneRecord {
	readonly terminal: string;
	readonly taskId: string;
	readonly botId: string;
	readonly at: number;
}

const TASK_ID = /^t-[A-Za-z0-9_-]{1,64}$/;
const TERMINAL_ID = /^t_[0-9a-f]{12}$/;

function parseList<T>(value: unknown, parse: (entry: Record<string, unknown>) => T | undefined): T[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const result: T[] = [];
	for (const entry of value.slice(-PARADIS_BOT_BOARD_ORIGINS_LIMIT)) {
		const parsed = isPlainRecord(entry) ? parse(entry) : undefined;
		if (parsed !== undefined) {
			result.push(parsed);
		}
	}
	return result;
}

/** 保存した印を読む（形の違う 1 件は捨てる）。 */
export function paradisParseBotBoardOrigins(tasks: unknown, panes: unknown): { readonly boardTasks: IParadisBotBoardTaskRecord[]; readonly boardPanes: IParadisBotBoardPaneRecord[] } {
	const valid = (entry: Record<string, unknown>) => typeof entry.taskId === 'string' && TASK_ID.test(entry.taskId) && typeof entry.botId === 'string' && entry.botId.length > 0 && typeof entry.at === 'number' && Number.isFinite(entry.at);
	return {
		boardTasks: parseList(tasks, entry => valid(entry) ? { taskId: entry.taskId as string, botId: entry.botId as string, at: entry.at as number } : undefined),
		boardPanes: parseList(panes, entry => valid(entry) && typeof entry.terminal === 'string' && TERMINAL_ID.test(entry.terminal)
			? { terminal: entry.terminal, taskId: entry.taskId as string, botId: entry.botId as string, at: entry.at as number }
			: undefined),
	};
}

/** ボードのタスクの印（launchId・送りの印は `<タスクの id>:<試行番号>`）からタスクの id を取る。 */
export function paradisBoardTaskIdOf(launchId: string): string | undefined {
	const at = launchId.lastIndexOf(':');
	const taskId = at > 0 ? launchId.slice(0, at) : undefined;
	return taskId !== undefined && TASK_ID.test(taskId) ? taskId : undefined;
}

export class ParadisBotBoardOrigins {

	private readonly tasks = new Map<string, IParadisBotBoardTaskRecord>();
	private readonly panes = new Map<string, IParadisBotBoardPaneRecord>();

	load(tasks: readonly IParadisBotBoardTaskRecord[], panes: readonly IParadisBotBoardPaneRecord[]): void {
		// 保存した分を古い順に先へ入れ、読み込みの前に付けた印（起動の直後に届いた、新しいもの）を後ろへ入れ直す
		// （上限を超えたときに古いものから落とすため）
		const earlyTasks = [...this.tasks.values()];
		const earlyPanes = [...this.panes.values()];
		this.tasks.clear();
		this.panes.clear();
		for (const record of [...tasks, ...earlyTasks]) {
			this.tasks.delete(record.taskId);
			this.tasks.set(record.taskId, record);
		}
		for (const record of panes) {
			this.panes.set(record.terminal, record);
		}
		for (const record of earlyPanes) {
			// 印は付け替えない（保存した印があればそれを残す）
			if (!this.panes.has(record.terminal)) {
				this.panes.set(record.terminal, record);
			}
		}
		trim(this.tasks);
		trim(this.panes);
	}

	boardTasks(): IParadisBotBoardTaskRecord[] {
		return [...this.tasks.values()];
	}

	boardPanes(): IParadisBotBoardPaneRecord[] {
		return [...this.panes.values()];
	}

	/** Bot がボードへ載せたタスクを控える。変わったら true。 */
	noteTask(taskId: string, botId: string, now: number): boolean {
		if (!TASK_ID.test(taskId) || botId.length === 0 || this.tasks.get(taskId)?.botId === botId) {
			return false;
		}
		this.tasks.delete(taskId);
		this.tasks.set(taskId, { taskId, botId, at: now });
		trim(this.tasks);
		return true;
	}

	/** そのタスクを載せた Bot（控えていなければ undefined）。 */
	botOfTask(taskId: string): string | undefined {
		return this.tasks.get(taskId)?.botId;
	}

	/** ボードがそのタスクのためにペインを動かした。`botId` はタスクを載せた Bot。変わったら true。 */
	notePane(terminal: string, taskId: string, botId: string, now: number): boolean {
		if (!TERMINAL_ID.test(terminal) || this.panes.has(terminal)) {
			// 印は外さず、付け替えもしない（最初に付けた Bot のまま）
			return false;
		}
		this.panes.set(terminal, { terminal, taskId, botId, at: now });
		trim(this.panes);
		return true;
	}

	/** そのペイン（ボードの接続口のターミナルの id）に付けた印。 */
	paneOrigin(terminal: string): IParadisBotBoardPaneRecord | undefined {
		return this.panes.get(terminal);
	}
}

function trim<T>(map: Map<string, T>): void {
	while (map.size > PARADIS_BOT_BOARD_ORIGINS_LIMIT) {
		map.delete(map.keys().next().value!);
	}
}
