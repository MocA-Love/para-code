/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code の Monitor（出力を1行ずつ会話へ通知するバックグラウンドのシェル）を transcript から追う。
//
// transcript に残る形（2026-10-02 に実データで確認）:
//  - 起動: assistant の tool_use `name: "Monitor"`。input は command / description / persistent / timeout_ms
//  - 起動応答: tool_result の本文 `Monitor started (task bXXXX, ...)`。その行の `toolUseResult` に
//    `{ taskId, timeoutMs, persistent }`
//  - 出力: `<task-notification>` に `<task-id>` と `<summary>Monitor event: "説明"</summary>` と `<event>出力</event>`。
//    `<status>` は無い。時間切れも同じ形で `<event>` が `[Monitor timed out — re-arm if needed.]`
//  - 終了: `<status>` 付きの通知（completed / killed / failed、次のセッションの冒頭に stopped）。
//    バックグラウンドの Bash も同じ b 始まりの ID と形で終わるので、知らない ID は `Monitor "` で始まる要約のときだけ拾う
//  - 停止: エージェントが TaskStop を呼ぶ（結果の `toolUseResult` に `task_id`）。TUI から止めた場合は `queue-operation` の
//    enqueue 行にだけ `<status>killed</status>` の通知が残る（{@link paradisQueueOperationSignals}）
//
// 通知はユーザーの発言（content が文字列）か、作業中なら `queued_command` の attachment として書かれる。
// Node の API は使わない（パーサーと同じく common に置き、テストから直接呼ぶ）。
// バックグラウンドの Bash（paradisAgentShells.ts）も同じ時計と同じ知らせの口で追う（{@link ParadisAgentMonitorWatch}）。

import { IParadisAgentShell, IParadisShellSignal, ParadisAgentShellTracker, paradisShellNotificationSignals } from './paradisAgentShells.js';

/** モバイルへ送る Monitor 1件（agent の snapshot / delta の任意項目 `monitors`）。 */
export interface IParadisAgentMonitor {
	/** タスク ID（`bXXXX`）。 */
	readonly id: string;
	/** 人が読む説明（tool_use の description。起動行が読めなかったときは通知の要約から）。 */
	readonly description: string;
	/** 見張っているシェル。起動行が読めなかったときは無い。 */
	readonly command?: string;
	/**
	 * 起動した時刻（起動行が読めなかったときは最初の通知の時刻。そのときは {@link startUnknown}）。
	 * 時刻はすべて **PC の時計**に直してある（SSH の写しでは transcript の時刻が接続先の時計のため）。
	 * モバイルは一緒に届く `monitorsAt`（PC の送信時刻）との差で手元の時計へ直す。
	 */
	readonly startedAt: number;
	/** 起動行が読めず、startedAt は最初に見えた通知の時刻（本当の起動はそれより前）。 */
	readonly startUnknown?: true;
	/** 上限時間（ms）。常駐・不明なら無い。 */
	readonly timeoutMs?: number;
	/** 常駐（TaskStop かセッションの終わりまで動く）。 */
	readonly persistent?: true;
	readonly status: ParadisAgentMonitorStatus;
	/** 状態を transcript の印ではなく推定で決めた（上限時間の経過・セッションの終わり）。 */
	readonly estimated?: true;
	readonly endedAt?: number;
	/** 失敗したときの終了コード（`script failed (exit 1)`）。 */
	readonly exitCode?: number;
	/** 出力の末尾の行（古い順、上限 {@link PARADIS_MONITOR_LIMITS.outputLines} 行）。 */
	readonly output: readonly { readonly at: number; readonly text: string }[];
	/** 届いた出力の通知の件数。 */
	readonly eventCount: number;
}

export type ParadisAgentMonitorStatus = 'running' | 'completed' | 'stopped' | 'failed' | 'timedOut';

/** 一覧と出力の上限。 */
export const PARADIS_MONITOR_LIMITS = {
	/** 持つ Monitor の数。超えたら終わったものの古い方から捨てる。 */
	monitors: 20,
	/** 1件あたりに持つ出力の行数。 */
	outputLines: 5,
	lineLength: 300,
	commandLength: 500,
	descriptionLength: 200,
	/** 起動応答を待っている tool_use の数。 */
	pendingCalls: 20,
	/** 終わった Monitor を持ち続ける時間。 */
	endedRetentionMs: 30 * 60_000,
	/** 上限時間を過ぎてから「時間切れ（推定）」にするまでの猶予（本物の時間切れの通知を待つ）。 */
	timeoutGraceMs: 30_000,
	/** 起動行が読めなかった Monitor を、最後の出力からこれだけ何も無ければ「時間切れ（推定）」にする。 */
	unknownStartStaleMs: 60 * 60_000,
} as const;

/** transcript の解析で集める Monitor の手がかり（順序どおりに追跡へ渡す）。 */
export type IParadisMonitorSignal =
	| { readonly type: 'call'; readonly toolUseId: string; readonly description?: string; readonly command?: string; readonly persistent?: boolean; readonly timeoutMs?: number; readonly at: number }
	| { readonly type: 'started'; readonly toolUseId?: string; readonly taskId: string; readonly persistent?: boolean; readonly timeoutMs?: number; readonly at: number }
	| { readonly type: 'event'; readonly taskId: string; readonly description?: string; readonly text: string; readonly at: number }
	| { readonly type: 'ended'; readonly taskIds: readonly string[]; readonly status: 'completed' | 'stopped' | 'failed'; readonly description?: string; readonly exitCode?: number; readonly at: number };

const TIMED_OUT_EVENT = /^\[Monitor timed out\b/;

function decodeEntities(value: string): string {
	return value
		.replace(/&#(\d{1,6});/g, (_match, code: string) => safeCodePoint(Number(code)))
		.replace(/&#x([0-9a-fA-F]{1,6});/g, (_match, code: string) => safeCodePoint(parseInt(code, 16)))
		.replace(/&quot;/g, '"').replace(/&apos;/g, String.fromCodePoint(39)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function safeCodePoint(code: number): string {
	return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function clip(value: string, limit: number): string {
	// allow-any-unicode-next-line
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** `Monitor event: "説明"` / `Monitor "説明" stream ended` の説明。 */
function monitorDescriptionFromSummary(summary: string): string | undefined {
	const match = /^Monitor(?: event:)? "(?<description>[\s\S]*)"(?: (?:stream ended|stopped|script failed|ended without producing output)\b[\s\S]*)?$/.exec(summary.trim());
	const description = match?.groups?.description?.trim();
	return description !== undefined && description.length > 0 ? description : undefined;
}

/**
 * tool_use の input（`Monitor`）から起動の手がかりを作る。形が合わなければ undefined。
 */
export function paradisMonitorCallSignal(input: Record<string, unknown> | undefined, toolUseId: string | undefined, at: number): IParadisMonitorSignal | undefined {
	if (toolUseId === undefined) {
		return undefined;
	}
	const description = typeof input?.description === 'string' ? input.description.trim() : undefined;
	const command = typeof input?.command === 'string' ? input.command : undefined;
	const timeoutMs = typeof input?.timeout_ms === 'number' && Number.isFinite(input.timeout_ms) && input.timeout_ms > 0 ? input.timeout_ms : undefined;
	return {
		type: 'call', toolUseId, at,
		...(description !== undefined && description.length > 0 ? { description } : {}),
		...(command !== undefined ? { command } : {}),
		...(typeof input?.persistent === 'boolean' ? { persistent: input.persistent } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	};
}

/**
 * tool_result の本文と、その行の `toolUseResult` から Monitor の起動応答を読む。Monitor の応答でなければ undefined。
 */
export function paradisMonitorStartedSignal(text: string, toolUseResult: Record<string, unknown> | undefined, toolUseId: string | undefined, at: number): IParadisMonitorSignal | undefined {
	const match = /^\s*Monitor started \(task ([A-Za-z0-9_-]{1,64})/.exec(text);
	if (match === null) {
		return undefined;
	}
	const resultTaskId = typeof toolUseResult?.taskId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(toolUseResult.taskId) ? toolUseResult.taskId : undefined;
	// toolUseResult に taskId・timeoutMs が無い起動行もある（実データ）。そのときは本文
	// `Monitor started (task bXXX, timeout 150000ms)` / `(task bXXX, persistent — ...)` から読む。
	const textTimeout = /^\s*Monitor started \(task [A-Za-z0-9_-]+, timeout (?<timeout>\d{1,12})ms\)/.exec(text)?.groups?.timeout;
	const textPersistent = /^\s*Monitor started \(task [A-Za-z0-9_-]+, persistent\b/.test(text);
	const resultTimeout = typeof toolUseResult?.timeoutMs === 'number' && Number.isFinite(toolUseResult.timeoutMs) ? toolUseResult.timeoutMs : undefined;
	const timeoutCandidate = resultTimeout ?? (textTimeout !== undefined ? Number(textTimeout) : undefined);
	const timeoutMs = timeoutCandidate !== undefined && timeoutCandidate > 0 ? timeoutCandidate : undefined;
	const persistent = typeof toolUseResult?.persistent === 'boolean' ? toolUseResult.persistent : textPersistent ? true : textTimeout !== undefined ? false : undefined;
	return {
		type: 'started', taskId: resultTaskId ?? match[1], at,
		...(toolUseId !== undefined ? { toolUseId } : {}),
		...(persistent !== undefined ? { persistent } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	};
}

/**
 * TaskStop の結果（`toolUseResult: { message: 'Successfully stopped task: ...', task_id }`）を停止の手がかりにする。
 * Monitor 以外のタスクにも当たるが、追跡は知っている ID にしか当てない。
 */
export function paradisMonitorTaskStopSignal(toolUseResult: Record<string, unknown> | undefined, at: number): IParadisMonitorSignal | undefined {
	const taskId = typeof toolUseResult?.task_id === 'string' ? toolUseResult.task_id : undefined;
	const message = typeof toolUseResult?.message === 'string' ? toolUseResult.message : undefined;
	if (taskId === undefined || message === undefined || !message.startsWith('Successfully stopped task')) {
		return undefined;
	}
	return { type: 'ended', taskIds: [taskId], status: 'stopped', at };
}

/**
 * `<task-notification>`（1つの本文に複数並ぶこともある）から Monitor の出力・終了の手がかりを読む。
 */
export function paradisMonitorNotificationSignals(text: string, at: number): IParadisMonitorSignal[] {
	const out: IParadisMonitorSignal[] = [];
	for (const block of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
		const body = block[1];
		const taskIds = [...body.matchAll(/<task-id>([^<\n]+)<\/task-id>/g)].map(match => match[1].trim()).filter(id => /^[A-Za-z0-9_-]{1,64}$/.test(id));
		if (taskIds.length === 0) {
			continue;
		}
		const summaryRaw = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1];
		const summary = summaryRaw !== undefined ? decodeEntities(summaryRaw).trim() : undefined;
		const status = /<status>([^<\n]+)<\/status>/.exec(body)?.[1]?.trim();
		const description = summary !== undefined ? monitorDescriptionFromSummary(summary) : undefined;
		if (status === undefined) {
			// 出力の通知。`<event>` の後ろに付く指示文（PushNotification の案内）はタグの外なので拾わない。
			const eventRaw = /<event>([\s\S]*?)<\/event>/.exec(body)?.[1];
			if (eventRaw === undefined || summary === undefined || !summary.startsWith('Monitor event:')) {
				continue;
			}
			out.push({ type: 'event', taskId: taskIds[0], text: decodeEntities(eventRaw), at, ...(description !== undefined ? { description } : {}) });
			continue;
		}
		const mapped = status === 'completed' ? 'completed' : status === 'killed' || status === 'stopped' ? 'stopped' : status === 'failed' ? 'failed' : undefined;
		if (mapped === undefined) {
			continue;
		}
		const exitCode = summary !== undefined ? /\(exit (?:code )?(-?\d{1,5})\)/.exec(summary)?.[1] : undefined;
		out.push({
			type: 'ended', taskIds, status: mapped, at,
			// 知らない ID を Monitor として拾ってよいのは、要約が Monitor のものと読めたときだけ（Bash と同じ形で届くため）
			...(description !== undefined && summary?.startsWith('Monitor "') ? { description } : {}),
			...(exitCode !== undefined ? { exitCode: Number(exitCode) } : {}),
		});
	}
	return out;
}

/**
 * transcript の `queue-operation` 行（作業中に届いた通知・発言の待ち行列）から、終わりの手がかりを読む。
 * TUI の x で止めたものはここにしか残らない。Monitor の出力の通知（`<event>`）は後から queued_command か user 行にも
 * 同じものが時刻を変えて書かれ、数え直しになるので、ここでは状態の付いた終わりだけを拾う。
 */
export function paradisQueueOperationSignals(obj: Record<string, unknown>, at: number | undefined): { readonly monitors: IParadisMonitorSignal[]; readonly shells: IParadisShellSignal[] } {
	const content = obj.operation === 'enqueue' && typeof obj.content === 'string' ? obj.content : undefined;
	if (content === undefined || !content.trimStart().startsWith('<task-notification>')) {
		return { monitors: [], shells: [] };
	}
	const when = at ?? Date.now();
	return {
		monitors: paradisMonitorNotificationSignals(content, when).filter(signal => signal.type === 'ended'),
		shells: paradisShellNotificationSignals(content, when),
	};
}

interface IMutableMonitor {
	id: string;
	description: string;
	command?: string;
	startedAt: number;
	timeoutMs?: number;
	persistent?: boolean;
	status: ParadisAgentMonitorStatus;
	estimated?: boolean;
	endedAt?: number;
	exitCode?: number;
	output: { at: number; text: string }[];
	eventCount: number;
	lastEventAt?: number;
	/** 直前に当てた出力の通知（taskId は表のキー）。同じ通知が queued_command と user 行の両方に書かれることがある。 */
	lastEventKey?: string;
	/** 起動行（tool_result）を読めた。読めなかったものは上限時間が分からない。 */
	startKnown: boolean;
}

/**
 * 1つのセッション（tailer の epoch）の Monitor の一覧。transcript の手がかりを順に当て、
 * 時間の経過による推定（時間切れ・古いものの破棄）は {@link refresh} で行う。
 */
export class ParadisAgentMonitorTracker {

	private readonly calls = new Map<string, Extract<IParadisMonitorSignal, { type: 'call' }>>();
	/** 挿入順 = 見つけた順。 */
	private readonly monitors = new Map<string, IMutableMonitor>();
	/**
	 * PC の時計 − transcript の時計（ms）。SSH の写しでは transcript の時刻が接続先の時計なので、
	 * 推定の時間切れの判定と送る時刻をこれで PC の時計へ直す。ライブ追記の行の時刻を見て、
	 * 書かれてから読むまでの遅れを含まない最小値を採る（遅れは差を大きくする向きにしか働かない）。
	 */
	private clockSkewMs: number | undefined;

	get size(): number {
		return this.monitors.size;
	}

	/** セッションが替わった（epoch の切り替え）。 */
	clear(): boolean {
		const changed = this.monitors.size > 0;
		this.monitors.clear();
		this.calls.clear();
		this.clockSkewMs = undefined;
		return changed;
	}

	/** ライブ追記で読んだ行の transcript の時刻と、読んだときの PC の時刻。 */
	observeClock(transcriptAt: number, localNow: number): void {
		if (!Number.isFinite(transcriptAt)) {
			return;
		}
		const observed = localNow - transcriptAt;
		this.clockSkewMs = this.clockSkewMs === undefined ? observed : Math.min(this.clockSkewMs, observed);
	}

	/** transcript の時計の時刻を PC の時計へ（ずれが分からないうちはそのまま）。 */
	private toLocal(at: number): number {
		return at + (this.clockSkewMs ?? 0);
	}

	/** PC の時計の時刻を transcript の時計へ。 */
	private toTranscript(at: number): number {
		return at - (this.clockSkewMs ?? 0);
	}

	/** 手がかりを順に当てる。一覧が変わったら true。 */
	apply(signals: readonly IParadisMonitorSignal[], now: number): boolean {
		let changed = false;
		for (const signal of signals) {
			changed = this.applyOne(signal) || changed;
		}
		if (changed) {
			this.enforceLimit();
		}
		return this.refresh(now) || changed;
	}

	/**
	 * Claude Code のセッションが終わった（SessionEnd）。Monitor はプロセスと一緒に止まるが transcript には
	 * 印が残らないので、動いているものを「停止（推定）」にする。
	 */
	endSession(at: number): boolean {
		let changed = false;
		for (const monitor of this.monitors.values()) {
			if (monitor.status === 'running') {
				monitor.status = 'stopped';
				monitor.estimated = true;
				monitor.endedAt = this.toTranscript(at);
				changed = true;
			}
		}
		return changed;
	}

	/** 時間の経過による推定と、古いものの破棄（now は PC の時計）。一覧が変わったら true。 */
	refresh(localNow: number): boolean {
		const now = this.toTranscript(localNow);
		let changed = false;
		for (const monitor of [...this.monitors.values()]) {
			if (monitor.status === 'running') {
				const deadline = this.estimatedDeadline(monitor);
				if (deadline !== undefined && now >= deadline.at) {
					monitor.status = 'timedOut';
					monitor.estimated = true;
					monitor.endedAt = deadline.endedAt;
					changed = true;
				}
			}
			if (monitor.status !== 'running' && monitor.endedAt !== undefined && now - monitor.endedAt >= PARADIS_MONITOR_LIMITS.endedRetentionMs) {
				this.monitors.delete(monitor.id);
				changed = true;
			}
		}
		return changed;
	}

	/** 次に {@link refresh} が一覧を変えうる時刻（PC の時計。無ければ undefined）。tailer の時計に使う。 */
	nextDeadline(): number | undefined {
		const next = this.nextTranscriptDeadline();
		return next !== undefined ? this.toLocal(next) : undefined;
	}

	private nextTranscriptDeadline(): number | undefined {
		let next: number | undefined;
		for (const monitor of this.monitors.values()) {
			const at = monitor.status === 'running'
				? this.estimatedDeadline(monitor)?.at
				: monitor.endedAt !== undefined ? monitor.endedAt + PARADIS_MONITOR_LIMITS.endedRetentionMs : undefined;
			if (at !== undefined && (next === undefined || at < next)) {
				next = at;
			}
		}
		return next;
	}

	/** モバイルへ送る形（起動の古い順）。 */
	snapshot(): IParadisAgentMonitor[] {
		return [...this.monitors.values()]
			.sort((a, b) => a.startedAt - b.startedAt)
			.map(monitor => ({
				id: monitor.id,
				description: monitor.description,
				...(monitor.command !== undefined ? { command: monitor.command } : {}),
				startedAt: this.toLocal(monitor.startedAt),
				...(!monitor.startKnown ? { startUnknown: true as const } : {}),
				...(monitor.timeoutMs !== undefined ? { timeoutMs: monitor.timeoutMs } : {}),
				...(monitor.persistent === true ? { persistent: true as const } : {}),
				status: monitor.status,
				...(monitor.estimated === true ? { estimated: true as const } : {}),
				...(monitor.endedAt !== undefined ? { endedAt: this.toLocal(monitor.endedAt) } : {}),
				...(monitor.exitCode !== undefined ? { exitCode: monitor.exitCode } : {}),
				output: monitor.output.map(line => ({ at: this.toLocal(line.at), text: line.text })),
				eventCount: monitor.eventCount,
			}));
	}

	private estimatedDeadline(monitor: IMutableMonitor): { readonly at: number; readonly endedAt: number } | undefined {
		if (monitor.startKnown) {
			if (monitor.persistent === true || monitor.timeoutMs === undefined) {
				return undefined;
			}
			const endedAt = monitor.startedAt + monitor.timeoutMs;
			// 上限を過ぎても出力が届いた（推定が外れた）なら、最後の出力から猶予を数え直す。
			const reference = Math.max(endedAt, monitor.lastEventAt ?? endedAt);
			return { at: reference + PARADIS_MONITOR_LIMITS.timeoutGraceMs, endedAt: reference };
		}
		// 起動行が読めなかった（長い transcript の末尾だけ読んだ）。上限も常駐かも分からないので、
		// 出力が長く途絶えたら止まったものとみなす（いつまでも「実行中」に見せないため）。
		const last = monitor.lastEventAt ?? monitor.startedAt;
		const endedAt = last + PARADIS_MONITOR_LIMITS.unknownStartStaleMs;
		return { at: endedAt, endedAt };
	}

	private applyOne(signal: IParadisMonitorSignal): boolean {
		switch (signal.type) {
			case 'call': {
				this.calls.delete(signal.toolUseId);
				this.calls.set(signal.toolUseId, signal);
				while (this.calls.size > PARADIS_MONITOR_LIMITS.pendingCalls) {
					const oldest = this.calls.keys().next();
					if (oldest.done === true) {
						break;
					}
					this.calls.delete(oldest.value);
				}
				return false;
			}
			case 'started': {
				const call = signal.toolUseId !== undefined ? this.calls.get(signal.toolUseId) : undefined;
				if (signal.toolUseId !== undefined) {
					this.calls.delete(signal.toolUseId);
				}
				const existing = this.monitors.get(signal.taskId);
				const monitor: IMutableMonitor = existing ?? { id: signal.taskId, description: '', startedAt: signal.at, status: 'running', output: [], eventCount: 0, startKnown: true };
				monitor.description = clip(call?.description ?? (existing !== undefined ? existing.description : signal.taskId), PARADIS_MONITOR_LIMITS.descriptionLength);
				monitor.startedAt = signal.at;
				monitor.startKnown = true;
				if (call?.command !== undefined) {
					monitor.command = clip(call.command, PARADIS_MONITOR_LIMITS.commandLength);
				}
				const timeoutMs = signal.timeoutMs ?? call?.timeoutMs;
				if (timeoutMs !== undefined) {
					monitor.timeoutMs = timeoutMs;
				}
				if ((signal.persistent ?? call?.persistent) === true) {
					monitor.persistent = true;
				}
				if (existing === undefined) {
					this.monitors.set(signal.taskId, monitor);
				}
				return true;
			}
			case 'event': {
				let monitor = this.monitors.get(signal.taskId);
				if (monitor === undefined) {
					// 起動行が読み込み範囲の外（8MB を超える transcript は末尾だけ読む）。通知の要約の説明で代わりにする。
					monitor = {
						id: signal.taskId,
						description: clip(signal.description ?? signal.taskId, PARADIS_MONITOR_LIMITS.descriptionLength),
						startedAt: signal.at, status: 'running', output: [], eventCount: 0, startKnown: false,
					};
					this.monitors.set(signal.taskId, monitor);
				}
				const eventKey = `${signal.at}\0${signal.text}`;
				if (monitor.lastEventKey === eventKey) {
					return false; // queued_command と user 行に同じ通知が書かれた
				}
				monitor.lastEventKey = eventKey;
				if (TIMED_OUT_EVENT.test(signal.text.trim())) {
					monitor.status = 'timedOut';
					monitor.estimated = undefined;
					monitor.endedAt = signal.at;
					this.pushOutput(monitor, signal.text, signal.at);
					return true;
				}
				if (monitor.status !== 'running' && monitor.estimated === true) {
					// 推定で終わらせたが、まだ出力が届く＝動いている。
					monitor.status = 'running';
					monitor.estimated = undefined;
					monitor.endedAt = undefined;
				}
				monitor.eventCount++;
				monitor.lastEventAt = signal.at;
				this.pushOutput(monitor, signal.text, signal.at);
				return true;
			}
			case 'ended': {
				let changed = false;
				for (const taskId of signal.taskIds) {
					let monitor = this.monitors.get(taskId);
					if (monitor === undefined) {
						if (signal.description === undefined || signal.taskIds.length !== 1) {
							continue; // Monitor と分からない（バックグラウンドの Bash など）
						}
						monitor = {
							id: taskId,
							description: clip(signal.description, PARADIS_MONITOR_LIMITS.descriptionLength),
							startedAt: signal.at, status: 'running', output: [], eventCount: 0, startKnown: false,
						};
						this.monitors.set(taskId, monitor);
					}
					// 本物の終わりの印が付いているものは上書きしない（時間切れの後の killed など）。推定は印で直す。
					if (monitor.status !== 'running' && monitor.estimated !== true) {
						continue;
					}
					monitor.status = signal.status;
					monitor.estimated = undefined;
					monitor.endedAt = signal.at;
					if (signal.exitCode !== undefined && signal.status === 'failed') {
						monitor.exitCode = signal.exitCode;
					}
					changed = true;
				}
				return changed;
			}
		}
	}

	private pushOutput(monitor: IMutableMonitor, text: string, at: number): void {
		const lines = text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim().length > 0);
		for (const line of lines.slice(-PARADIS_MONITOR_LIMITS.outputLines)) {
			monitor.output.push({ at, text: clip(line, PARADIS_MONITOR_LIMITS.lineLength) });
		}
		if (monitor.output.length > PARADIS_MONITOR_LIMITS.outputLines) {
			monitor.output.splice(0, monitor.output.length - PARADIS_MONITOR_LIMITS.outputLines);
		}
	}

	/** 上限を超えたら、終わったものの古い方から、それでも多ければ古い方から捨てる。 */
	private enforceLimit(): void {
		while (this.monitors.size > PARADIS_MONITOR_LIMITS.monitors) {
			const victim = [...this.monitors.values()].find(monitor => monitor.status !== 'running') ?? this.monitors.values().next().value;
			if (victim === undefined) {
				break;
			}
			this.monitors.delete(victim.id);
		}
	}
}

/**
 * ペインでエージェントが動いていない（SessionEnd の後・ペインが生きていない）ときに送る形。
 * 動いているものを「停止（推定）」に直す。TUI から止めた・落ちた・hook が来ない構成では transcript に
 * 何も残らないうえ、推定は tailer のメモリにしか無い（作り直すと再生で running に戻る）ため、送るたびに判定する。
 */
export function paradisMonitorsForStoppedPane(monitors: readonly IParadisAgentMonitor[], endedAt: number | undefined): IParadisAgentMonitor[] {
	return monitors.map(monitor => monitor.status !== 'running' ? monitor : {
		...monitor,
		status: 'stopped' as const,
		estimated: true as const,
		...(endedAt !== undefined ? { endedAt: Math.max(endedAt, monitor.startedAt) } : {}),
	});
}

/** {@link ParadisAgentMonitorWatch} の時計（テストで差し替える）。 */
export interface IParadisMonitorTimers {
	now(): number;
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const DEFAULT_TIMERS: IParadisMonitorTimers = {
	now: () => Date.now(),
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * tailer が持つ Monitor の一覧と、時間の経過で一覧が変わる時刻の時計を1本だけ張る係。
 * 一覧が変わったら onChange（tailer はモバイルへ空 delta で丸ごと送る）を呼ぶ。
 * 初回読み込み・epoch の読み直し（live でない読み）では呼ばない（その後の snapshot が一覧を運ぶため）。
 */
export class ParadisAgentMonitorWatch {

	private readonly tracker = new ParadisAgentMonitorTracker();
	/** バックグラウンドの Bash（Monitor と同じ時計・同じ知らせの口を使う）。 */
	private readonly shells = new ParadisAgentShellTracker();
	private timer: unknown;
	private disposed = false;

	constructor(
		private readonly onChange: () => void,
		private readonly timers: IParadisMonitorTimers = DEFAULT_TIMERS,
	) { }

	get size(): number {
		return this.tracker.size + this.shells.size;
	}

	snapshot(): IParadisAgentMonitor[] {
		return this.tracker.snapshot();
	}

	/** バックグラウンドのシェルの一覧（起動の古い順。時刻は PC の時計）。 */
	shellSnapshot(): IParadisAgentShell[] {
		return this.shells.snapshot();
	}

	/** シェルの出力ファイル（transcript で覚えたもの）。 */
	shellOutputFile(taskId: string): string | undefined {
		return this.shells.outputFileFor(taskId);
	}

	isShellRunning(taskId: string): boolean {
		return this.shells.isRunning(taskId);
	}

	/** アプリから止めた（transcript に残らない）。変われば知らせる。 */
	markShellStoppedFromMobile(taskId: string): void {
		if (this.shells.markStoppedFromMobile(taskId, this.timers.now())) {
			this.schedule();
			this.onChange();
		}
	}

	/** 出力ファイルの最後の行が印ではなかった（印から推定した終わりを取り消す）。変われば知らせる。 */
	markShellRunningFromOutput(taskId: string): void {
		if (this.shells.markRunningFromOutput(taskId)) {
			this.schedule();
			this.onChange();
		}
	}

	/** 出力ファイルの最後の印で終わりが分かった（推定。本物の通知が上書きする）。変われば知らせる。 */
	markShellEndedFromOutput(taskId: string, end: { readonly status: 'completed' | 'failed' | 'stopped'; readonly exitCode?: number }): void {
		if (this.shells.markEndedFromOutput(taskId, end, this.timers.now())) {
			this.schedule();
			this.onChange();
		}
	}

	/** ライブ追記で読んだ行の transcript の時刻（時計のずれを測る）。 */
	observeClock(transcriptAt: number): void {
		this.tracker.observeClock(transcriptAt, this.timers.now());
		this.shells.observeClock(transcriptAt, this.timers.now());
	}

	apply(signals: readonly IParadisMonitorSignal[], live: boolean, shellSignals: readonly IParadisShellSignal[] = []): void {
		const monitorsChanged = signals.length > 0 && this.tracker.apply(signals, this.timers.now());
		const shellsChanged = shellSignals.length > 0 && this.shells.apply(shellSignals, this.timers.now());
		if (!monitorsChanged && !shellsChanged) {
			return;
		}
		this.schedule();
		if (live) {
			this.onChange();
		}
	}

	/** SessionEnd。動いているものを「停止（推定）」にする（at は PC の時計）。 */
	endSession(at: number): void {
		const monitorsChanged = this.tracker.endSession(at);
		if (this.shells.endSession(at) || monitorsChanged) {
			this.schedule();
			this.onChange();
		}
	}

	/** epoch の切り替え。空にしたかを返す（呼び出し側は続く snapshot で知らせる）。 */
	clear(): boolean {
		this.cancel();
		const shellsCleared = this.shells.clear();
		return this.tracker.clear() || shellsCleared;
	}

	dispose(): void {
		this.disposed = true;
		this.cancel();
	}

	private cancel(): void {
		if (this.timer !== undefined) {
			this.timers.clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private schedule(): void {
		this.cancel();
		const monitorDeadline = this.tracker.nextDeadline();
		const shellDeadline = this.shells.nextDeadline();
		const deadline = monitorDeadline === undefined ? shellDeadline : shellDeadline === undefined ? monitorDeadline : Math.min(monitorDeadline, shellDeadline);
		if (deadline === undefined || this.disposed) {
			return;
		}
		// setTimeout の上限（約24.8日）を超えないよう丸める。早く起きても張り直すだけ。
		const delay = Math.min(Math.max(1_000, deadline - this.timers.now() + 50), 2 ** 31 - 1);
		this.timer = this.timers.setTimeout(() => {
			this.timer = undefined;
			if (this.disposed) {
				return;
			}
			const shellsChanged = this.shells.refresh(this.timers.now());
			const changed = this.tracker.refresh(this.timers.now()) || shellsChanged;
			this.schedule();
			if (changed) {
				this.onChange();
			}
		}, delay);
	}
}
