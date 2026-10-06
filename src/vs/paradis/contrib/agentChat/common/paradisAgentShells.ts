/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code のバックグラウンドのシェル（Bash の run_in_background）を transcript から追う。
// Monitor（paradisAgentMonitors.ts）の追跡をなぞり、決まり（一覧の上限・終わったものを残す時間）も同じにする。
//
// transcript に残る形（Claude Code 2.1.289 で実測）:
//  - 起動: assistant の tool_use `name: "Bash"`、input に `run_in_background: true`・command・description。
//    tool_result は `Command running in background with ID: <id>. Output is being written to: <path>`。
//    その行の `toolUseResult.backgroundTaskId` に ID。手動で背景に回すと `backgroundedByUser`、時間切れで
//    回ったときは `timedOutAfterMs`（本文は `Command did not complete within ... moved to the background (ID: <id>)`）
//  - 終了: `<task-notification>` に `<task-id>`・`<tool-use-id>`・`<output-file>`・`<status>completed|failed|killed</status>`・
//    `<summary>Background command "説明" completed (exit code 0)</summary>`。待機中は user 行、作業中は
//    `queue-operation` の enqueue 行と、後から `queued_command` の attachment の両方に書かれる
//  - TUI の x で止めた: すぐに `queue-operation` の enqueue 行。status は killed、要約は `Task "…" was stopped by the user`
//  - モデルが TaskStop を呼んだ: 通知は無く、結果の `toolUseResult` に `{ message, task_id, task_type: "local_bash", command }`
//  - mod（Claude Mods）から TaskStop を呼んだ: transcript には何も残らない。止めた側（{@link ParadisAgentShellTracker.markStoppedFromMobile}）が直す
//
// Node の API は使わない（パーサーと同じく common に置き、テストから直接呼ぶ）。出力ファイルを読むのは
// mobileRelay/node/paradisAgentShellOutput.ts。

/** モバイルへ送るシェル 1 件（agent の snapshot / delta の任意項目 `shells`）。出力ファイルのパスは送らない。 */
export interface IParadisAgentShell {
	/** タスク ID（`bXXXX`）。 */
	readonly id: string;
	/** 実行しているコマンド。起動の行が読めなかったときは無い。 */
	readonly command?: string;
	/** tool_use の description（無いことも多い）。 */
	readonly description?: string;
	/** 起動した時刻（PC の時計。モバイルは `shellsAt` との差で手元の時計へ直す）。 */
	readonly startedAt: number;
	/** 起動の行が読めず、startedAt は終わりの通知の時刻。 */
	readonly startUnknown?: true;
	readonly status: ParadisAgentShellStatus;
	/** 止めたのは誰か（status が stopped のとき。分からなければ無い）。 */
	readonly stoppedBy?: ParadisAgentShellStopper;
	/** 状態を印ではなく推定で決めた（セッションの終わり・ペインが止まった）。 */
	readonly estimated?: true;
	readonly endedAt?: number;
	readonly exitCode?: number;
	/** 最初から背景で動かしたのではなく、手動（user）や時間切れ（timeout）で背景へ回った。 */
	readonly movedToBackground?: 'user' | 'timeout';
	/**
	 * 起動した子（サブエージェント・Workflow の子）の ID。子の transcript・子の hook から読んだときだけ。親が起動したものには無い
	 * （モバイルは Workflow の子のシェルを、ペインの一覧ではなく Workflow のカードへ寄せる。agent.workflows.v1）。
	 */
	readonly ownerAgentId?: string;
}

export type ParadisAgentShellStatus = 'running' | 'completed' | 'failed' | 'stopped';
/** user: TUI の x で止めた。agent: エージェントが TaskStop を呼んだ。mobile: アプリから止めた。 */
export type ParadisAgentShellStopper = 'user' | 'agent' | 'mobile';

/**
 * 出力と停止をこの構成で使えるか（snapshot / delta の任意項目 `shellsAccess`）。
 * `where` があればその構成では使えない（モバイルは理由を添えて押せなくする）。`where` が無く `stop` が false なら
 * mod がつながっていない（モバイルは停止のボタンを出さない）。
 */
export interface IParadisAgentShellsAccess {
	readonly output: boolean;
	readonly stop: boolean;
	readonly where?: 'ssh' | 'wsl' | 'windows';
}

/** 一覧の上限（Monitor と同じ決まり。PARADIS_MONITOR_LIMITS）。 */
export const PARADIS_SHELL_LIMITS = {
	shells: 20,
	commandLength: 1_000,
	descriptionLength: 200,
	/** 結果を待っている Bash の tool_use の数（時間切れで背景へ回るものがあるので、背景指定の無い呼び出しも覚える）。 */
	pendingCalls: 50,
	/** 終わったシェルを持ち続ける時間。 */
	endedRetentionMs: 30 * 60_000,
	/** アプリから止めた・出力の末尾で終わりが分かった、の記録（transcript に残らないので読み直しに備えて持つ）。 */
	externalEnds: 50,
	outputPathLength: 4_096,
	/** 終わったと分かったタスク ID の控え（一覧から捨てた後に、子の transcript の起動の行で生き返らせないため）。 */
	endedIds: 500,
} as const;

/** transcript の解析で集めるシェルの手がかり（順序どおりに追跡へ渡す）。 */
export type IParadisShellSignal =
	/** `background`: input に `run_in_background: true` があった。 */
	| { readonly type: 'call'; readonly toolUseId: string; readonly command?: string; readonly description?: string; readonly background?: true; readonly at: number }
	/**
	 * `fromText`: ID を本文からしか読めなかった（`toolUseResult.backgroundTaskId` が無い）。本文が Claude Code の応答の
	 * 書き出しで始まるときだけ読む（`background`: `Command running in background with ID:`、`timeout`:
	 * `Command did not complete within`）。追跡は、覚えている Bash の呼び出しと tool_use_id で結べ、`background` なら
	 * その呼び出しが `run_in_background: true` だったときだけシェルを作る（前景のコマンドの出力に同じ文が
	 * 含まれていても取り違えない）。
	 */
	| { readonly type: 'started'; readonly toolUseId?: string; readonly taskId: string; readonly outputFile?: string; readonly movedToBackground?: 'user' | 'timeout'; readonly fromText?: 'background' | 'timeout'; readonly ownerAgentId?: string; readonly at: number }
	| { readonly type: 'ended'; readonly taskId: string; readonly status: 'completed' | 'failed' | 'stopped'; readonly stoppedBy?: ParadisAgentShellStopper; readonly exitCode?: number; readonly outputFile?: string; readonly description?: string; readonly at: number };

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

function clip(value: string, limit: number): string {
	// allow-any-unicode-next-line
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function decodeEntities(value: string): string {
	return value.replace(/&quot;/g, '"').replace(/&apos;/g, String.fromCodePoint(39)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** 出力ファイルのパスとして受けてよい形（絶対パス・改行なし・`.output` で終わる）。中身の確かめは読む側が realpath で行う。 */
function outputPath(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed.length <= PARADIS_SHELL_LIMITS.outputPathLength && /^\/[^\n\r\0]*\.output$/.test(trimmed) ? trimmed : undefined;
}

/** Bash の tool_use の input から呼び出しの手がかりを作る（背景指定の無いものも覚える。時間切れで背景へ回るため）。 */
export function paradisShellCallSignal(input: Record<string, unknown> | undefined, toolUseId: string | undefined, at: number): IParadisShellSignal | undefined {
	if (toolUseId === undefined || typeof input?.command !== 'string') {
		return undefined;
	}
	const description = typeof input.description === 'string' ? input.description.trim() : undefined;
	return {
		type: 'call', toolUseId, command: input.command, at,
		...(description !== undefined && description.length > 0 ? { description } : {}),
		...(input.run_in_background === true ? { background: true as const } : {}),
	};
}

/**
 * tool_result の本文と、その行の `toolUseResult` からバックグラウンドのシェルの起動を読む。そうでなければ undefined。
 * Monitor の起動応答（`toolUseResult.taskId`）とは形が違うので取り違えない。
 */
export function paradisShellStartedSignal(text: string, toolUseResult: Record<string, unknown> | undefined, toolUseId: string | undefined, at: number): IParadisShellSignal | undefined {
	const fromResult = typeof toolUseResult?.backgroundTaskId === 'string' && TASK_ID.test(toolUseResult.backgroundTaskId) ? toolUseResult.backgroundTaskId : undefined;
	const head = text.trimStart();
	const textKind = head.startsWith('Command running in background with ID:') ? 'background' as const
		: head.startsWith('Command did not complete within') ? 'timeout' as const : undefined;
	const fromText = textKind === 'background' ? /^Command running in background with ID: (?<id>[A-Za-z0-9_-]{1,64})/.exec(head)?.groups?.id
		: textKind === 'timeout' ? /moved to the background \(ID: (?<id>[A-Za-z0-9_-]{1,64})\)/.exec(head)?.groups?.id : undefined;
	const taskId = fromResult ?? fromText;
	if (taskId === undefined) {
		return undefined;
	}
	const file = outputPath(/Output is being written to: (?<path>\/\S+?\.output)(?=[\s.,;]|$)/.exec(text)?.groups?.path);
	const movedToBackground = toolUseResult?.backgroundedByUser === true ? 'user'
		: typeof toolUseResult?.timedOutAfterMs === 'number' || /did not complete within/.test(text) ? 'timeout' : undefined;
	if (fromResult === undefined && toolUseId === undefined) {
		return undefined;
	}
	return {
		type: 'started', taskId, at,
		...(fromResult === undefined && textKind !== undefined ? { fromText: textKind } : {}),
		...(toolUseId !== undefined ? { toolUseId } : {}),
		...(file !== undefined ? { outputFile: file } : {}),
		...(movedToBackground !== undefined ? { movedToBackground } : {}),
	};
}

/** TaskStop の結果（`toolUseResult: { message, task_id, task_type }`）。追跡は知っている ID にしか当てない。 */
export function paradisShellTaskStopSignal(toolUseResult: Record<string, unknown> | undefined, at: number): IParadisShellSignal | undefined {
	const taskId = typeof toolUseResult?.task_id === 'string' && TASK_ID.test(toolUseResult.task_id) ? toolUseResult.task_id : undefined;
	const message = typeof toolUseResult?.message === 'string' ? toolUseResult.message : undefined;
	if (taskId === undefined || message === undefined || !message.startsWith('Successfully stopped task')) {
		return undefined;
	}
	return { type: 'ended', taskId, status: 'stopped', stoppedBy: 'agent', at };
}

/** `<task-notification>`（1 つの本文に複数並ぶこともある）から、状態の付いた終わりの手がかりを読む。 */
export function paradisShellNotificationSignals(text: string, at: number): IParadisShellSignal[] {
	const out: IParadisShellSignal[] = [];
	for (const block of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
		const body = block[1];
		const taskId = /<task-id>([^<\n]+)<\/task-id>/.exec(body)?.[1]?.trim();
		const status = /<status>([^<\n]+)<\/status>/.exec(body)?.[1]?.trim();
		if (taskId === undefined || !TASK_ID.test(taskId) || status === undefined) {
			continue;
		}
		const mapped = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'killed' || status === 'stopped' ? 'stopped' : undefined;
		if (mapped === undefined) {
			continue;
		}
		const summaryRaw = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1];
		const summary = summaryRaw !== undefined ? decodeEntities(summaryRaw).trim() : '';
		const exitCode = /\bexit code (-?\d{1,5})\b/.exec(summary)?.[1];
		// 知らない ID をシェルとして拾ってよいのは、要約がバックグラウンドのコマンドのものと読めたときだけ（Agent・Monitor も同じ形で届く）
		const description = /^Background command "(?<description>[\s\S]*)" (?:completed|failed|was stopped|was killed|killed)\b/.exec(summary)?.groups?.description?.trim();
		const file = outputPath(/<output-file>([^<\n]+)<\/output-file>/.exec(body)?.[1]);
		out.push({
			type: 'ended', taskId, status: mapped, at,
			...(mapped === 'stopped' && /\bstopped by the user\b/.test(summary) ? { stoppedBy: 'user' as const } : {}),
			...(exitCode !== undefined ? { exitCode: Number(exitCode) } : {}),
			...(file !== undefined ? { outputFile: file } : {}),
			...(description !== undefined && description.length > 0 ? { description } : {}),
		});
	}
	return out;
}

/** 出力ファイルの最後の印（`[exited with code N]` / `[killed]`）。 */
export function paradisShellOutputEndMarker(lastLine: string | undefined): { readonly status: 'completed' | 'failed' | 'stopped'; readonly exitCode?: number } | undefined {
	const trimmed = lastLine?.trim();
	if (trimmed === '[killed]') {
		return { status: 'stopped' };
	}
	const code = trimmed !== undefined ? /^\[exited with code (-?\d{1,5})\]$/.exec(trimmed)?.[1] : undefined;
	if (code === undefined) {
		return undefined;
	}
	const exitCode = Number(code);
	return { status: exitCode === 0 ? 'completed' : 'failed', exitCode };
}

interface IMutableShell {
	id: string;
	command?: string;
	description?: string;
	startedAt: number;
	startKnown: boolean;
	status: ParadisAgentShellStatus;
	stoppedBy?: ParadisAgentShellStopper;
	estimated?: boolean;
	endedAt?: number;
	exitCode?: number;
	outputFile?: string;
	movedToBackground?: 'user' | 'timeout';
	/** 終わりを出力ファイルの最後の印から推定した（次の読み取りで印が無ければ running に戻す）。 */
	endedFromOutput?: boolean;
	ownerAgentId?: string;
}

interface IExternalEnd {
	readonly status: 'completed' | 'failed' | 'stopped';
	readonly stoppedBy?: ParadisAgentShellStopper;
	readonly exitCode?: number;
	/** transcript の時計。 */
	readonly at: number;
}

/**
 * 1 つのセッション（tailer の epoch）のバックグラウンドのシェルの一覧。{@link ParadisAgentMonitorTracker} と同じく、
 * transcript の手がかりを順に当て、古いものの破棄は {@link refresh} で行う。
 */
export class ParadisAgentShellTracker {

	private readonly calls = new Map<string, Extract<IParadisShellSignal, { type: 'call' }>>();
	/** 挿入順 = 見つけた順。 */
	private readonly shells = new Map<string, IMutableShell>();
	/**
	 * transcript に残らない終わり（アプリから止めた・出力の末尾の印）。epoch の切り替え（読み直し）でも捨てない。
	 * タスク ID はセッションをまたいで重ならないので、読み直しで同じシェルが running に戻るのを防げる。
	 */
	private readonly externalEnds = new Map<string, IExternalEnd>();
	/** PC の時計 − transcript の時計（{@link ParadisAgentMonitorTracker} と同じ測り方）。 */
	private clockSkewMs: number | undefined;
	/** このセッションで終わったと分かったタスク ID（一覧から捨てた後も持つ。{@link applyFromChild} が使う）。 */
	private readonly endedIds = new Set<string>();

	get size(): number {
		return this.shells.size;
	}

	/** セッションが替わった（epoch の切り替え）。 */
	clear(): boolean {
		const changed = this.shells.size > 0;
		this.shells.clear();
		this.calls.clear();
		this.endedIds.clear();
		this.clockSkewMs = undefined;
		return changed;
	}

	observeClock(transcriptAt: number, localNow: number): void {
		if (!Number.isFinite(transcriptAt)) {
			return;
		}
		const observed = localNow - transcriptAt;
		this.clockSkewMs = this.clockSkewMs === undefined ? observed : Math.min(this.clockSkewMs, observed);
	}

	private toLocal(at: number): number {
		return at + (this.clockSkewMs ?? 0);
	}

	private toTranscript(at: number): number {
		return at - (this.clockSkewMs ?? 0);
	}

	/** 手がかりを順に当てる（now は PC の時計）。一覧が変わったら true。 */
	apply(signals: readonly IParadisShellSignal[], now: number): boolean {
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
	 * 子（サブエージェント・Workflow の子）が起動したシェルの手がかりを当てる。子の起動は子の transcript（と子の hook）にしか
	 * 書かれず、終わりの通知は親の transcript に届く（Claude Code 2.1.289 で実測）。子の transcript は親より後から読むことが
	 * あるので、既に終わって一覧から捨てたシェルの起動の行では生き返らせない。一覧が変わったら true。
	 */
	applyFromChild(signals: readonly IParadisShellSignal[], now: number): boolean {
		return this.apply(signals.filter(signal => signal.type !== 'started' || this.shells.has(signal.taskId) || !this.endedIds.has(signal.taskId)), now);
	}

	/** PC の時計の時刻を transcript の時計へ直す（hook の受信時刻を手がかりの時刻にするとき）。 */
	transcriptTime(localAt: number): number {
		return this.toTranscript(localAt);
	}

	/**
	 * アプリから止めた（mod の TaskStop が ack で止まったと答えた。at は PC の時計）。transcript に残らないので覚えておき、
	 * 読み直しでも当て直す。動いているシェルにだけ当たる。一覧が変わったら true。
	 */
	markStoppedFromMobile(taskId: string, at: number): boolean {
		if (!TASK_ID.test(taskId)) {
			return false;
		}
		this.externalEnds.delete(taskId);
		this.externalEnds.set(taskId, { status: 'stopped', stoppedBy: 'mobile', at: this.toTranscript(at) });
		while (this.externalEnds.size > PARADIS_SHELL_LIMITS.externalEnds) {
			const oldest = this.externalEnds.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.externalEnds.delete(oldest.value);
		}
		const shell = this.shells.get(taskId);
		return shell !== undefined && this.applyExternalEnd(shell);
	}

	/**
	 * 出力ファイルの最後の印（`[exited with code N]` / `[killed]`）で終わりが分かった（at は PC の時計）。
	 * 推定として当てる（覚えない）。後から届く本物の通知が上書きする。一覧が変わったら true。
	 */
	markEndedFromOutput(taskId: string, end: { readonly status: 'completed' | 'failed' | 'stopped'; readonly exitCode?: number }, at: number): boolean {
		const shell = this.shells.get(taskId);
		if (shell === undefined || shell.status !== 'running') {
			return false;
		}
		this.end(shell, end.status, Math.max(this.toTranscript(at), shell.startedAt), undefined, end.exitCode);
		shell.estimated = true;
		shell.endedFromOutput = true;
		return true;
	}

	/**
	 * 出力ファイルを読み直したら、最後の行が終わりの印ではなかった（前の印は途中の行だった・書き足された）。
	 * 印から推定した終わりだけを取り消して running に戻す。一覧が変わったら true。
	 */
	markRunningFromOutput(taskId: string): boolean {
		const shell = this.shells.get(taskId);
		if (shell === undefined || shell.endedFromOutput !== true || shell.estimated !== true) {
			return false;
		}
		shell.status = 'running';
		shell.estimated = undefined;
		shell.endedAt = undefined;
		shell.exitCode = undefined;
		shell.endedFromOutput = undefined;
		return true;
	}

	/** Claude Code のセッションが終わった（SessionEnd）。背景のシェルはプロセスと一緒に止まる。 */
	endSession(at: number): boolean {
		let changed = false;
		for (const shell of this.shells.values()) {
			if (shell.status === 'running') {
				shell.status = 'stopped';
				shell.estimated = true;
				shell.endedAt = this.toTranscript(at);
				changed = true;
			}
		}
		return changed;
	}

	/** 終わってから {@link PARADIS_SHELL_LIMITS.endedRetentionMs} を過ぎたものを捨てる（now は PC の時計）。 */
	refresh(localNow: number): boolean {
		const now = this.toTranscript(localNow);
		let changed = false;
		for (const shell of [...this.shells.values()]) {
			if (shell.status !== 'running' && shell.endedAt !== undefined && now - shell.endedAt >= PARADIS_SHELL_LIMITS.endedRetentionMs) {
				this.shells.delete(shell.id);
				changed = true;
			}
		}
		return changed;
	}

	/** 次に {@link refresh} が一覧を変えうる時刻（PC の時計）。 */
	nextDeadline(): number | undefined {
		let next: number | undefined;
		for (const shell of this.shells.values()) {
			if (shell.status !== 'running' && shell.endedAt !== undefined) {
				const at = shell.endedAt + PARADIS_SHELL_LIMITS.endedRetentionMs;
				if (next === undefined || at < next) {
					next = at;
				}
			}
		}
		return next !== undefined ? this.toLocal(next) : undefined;
	}

	/** 出力ファイルのパス（transcript で覚えたものだけ。モバイルから受け取ったパスは使わない）。 */
	outputFileFor(taskId: string): string | undefined {
		return this.shells.get(taskId)?.outputFile;
	}

	/** 止める対象になるか（動いているもの。推定で終わったものも、本当は動いているかもしれないので含める）。 */
	isRunning(taskId: string): boolean {
		const shell = this.shells.get(taskId);
		return shell !== undefined && (shell.status === 'running' || shell.estimated === true);
	}

	/** モバイルへ送る形（起動の古い順）。 */
	snapshot(): IParadisAgentShell[] {
		return [...this.shells.values()]
			.sort((a, b) => a.startedAt - b.startedAt)
			.map(shell => ({
				id: shell.id,
				...(shell.command !== undefined ? { command: shell.command } : {}),
				...(shell.description !== undefined ? { description: shell.description } : {}),
				startedAt: this.toLocal(shell.startedAt),
				...(!shell.startKnown ? { startUnknown: true as const } : {}),
				status: shell.status,
				...(shell.stoppedBy !== undefined && shell.status === 'stopped' ? { stoppedBy: shell.stoppedBy } : {}),
				...(shell.estimated === true ? { estimated: true as const } : {}),
				...(shell.endedAt !== undefined ? { endedAt: this.toLocal(shell.endedAt) } : {}),
				...(shell.exitCode !== undefined ? { exitCode: shell.exitCode } : {}),
				...(shell.movedToBackground !== undefined ? { movedToBackground: shell.movedToBackground } : {}),
				...(shell.ownerAgentId !== undefined ? { ownerAgentId: shell.ownerAgentId } : {}),
			}));
	}

	private applyExternalEnd(shell: IMutableShell): boolean {
		const end = this.externalEnds.get(shell.id);
		if (end === undefined || (shell.status !== 'running' && shell.estimated !== true)) {
			return false;
		}
		this.end(shell, end.status, Math.max(end.at, shell.startedAt), end.stoppedBy, end.exitCode);
		return true;
	}

	private end(shell: IMutableShell, status: 'completed' | 'failed' | 'stopped', at: number, stoppedBy: ParadisAgentShellStopper | undefined, exitCode: number | undefined): void {
		shell.status = status;
		shell.estimated = undefined;
		shell.endedFromOutput = undefined;
		shell.endedAt = at;
		this.endedIds.delete(shell.id);
		this.endedIds.add(shell.id);
		while (this.endedIds.size > PARADIS_SHELL_LIMITS.endedIds) {
			const oldest = this.endedIds.values().next();
			if (oldest.done === true) {
				break;
			}
			this.endedIds.delete(oldest.value);
		}
		shell.stoppedBy = status === 'stopped' ? stoppedBy : undefined;
		if (exitCode !== undefined) {
			shell.exitCode = exitCode;
		}
	}

	private applyOne(signal: IParadisShellSignal): boolean {
		switch (signal.type) {
			case 'call': {
				this.calls.delete(signal.toolUseId);
				this.calls.set(signal.toolUseId, signal);
				while (this.calls.size > PARADIS_SHELL_LIMITS.pendingCalls) {
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
				if (signal.fromText !== undefined && (call === undefined || (signal.fromText === 'background' && call.background !== true))) {
					return false; // 本文にしか ID が無く、背景で動かした Bash の呼び出しとも結べない
				}
				if (signal.toolUseId !== undefined) {
					this.calls.delete(signal.toolUseId);
				}
				const existing = this.shells.get(signal.taskId);
				const shell: IMutableShell = existing ?? { id: signal.taskId, startedAt: signal.at, startKnown: true, status: 'running' };
				shell.startedAt = signal.at;
				shell.startKnown = true;
				if (call?.command !== undefined) {
					shell.command = clip(call.command, PARADIS_SHELL_LIMITS.commandLength);
				}
				if (call?.description !== undefined) {
					shell.description = clip(call.description, PARADIS_SHELL_LIMITS.descriptionLength);
				}
				if (signal.outputFile !== undefined) {
					shell.outputFile = signal.outputFile;
				}
				if (signal.movedToBackground !== undefined) {
					shell.movedToBackground = signal.movedToBackground;
				}
				if (signal.ownerAgentId !== undefined) {
					shell.ownerAgentId = signal.ownerAgentId;
				}
				if (existing === undefined) {
					this.shells.set(signal.taskId, shell);
				}
				this.applyExternalEnd(shell);
				return true;
			}
			case 'ended': {
				let shell = this.shells.get(signal.taskId);
				if (shell === undefined) {
					if (signal.description === undefined) {
						return false; // バックグラウンドのコマンドと分からない（Agent・Monitor など）
					}
					shell = { id: signal.taskId, description: clip(signal.description, PARADIS_SHELL_LIMITS.descriptionLength), startedAt: signal.at, startKnown: false, status: 'running' };
					this.shells.set(signal.taskId, shell);
				}
				if (signal.outputFile !== undefined && shell.outputFile === undefined) {
					shell.outputFile = signal.outputFile;
				}
				// 本物の終わりの印が付いているものは上書きしない（TUI で止めた後の通知・同じ通知の二度書き）。推定は印で直す。
				if (shell.status !== 'running' && shell.estimated !== true) {
					return false;
				}
				this.end(shell, signal.status, signal.at, signal.stoppedBy, signal.exitCode);
				return true;
			}
		}
	}

	/** 上限を超えたら、終わったものの古い方から、それでも多ければ古い方から捨てる。 */
	private enforceLimit(): void {
		while (this.shells.size > PARADIS_SHELL_LIMITS.shells) {
			const victim = [...this.shells.values()].find(shell => shell.status !== 'running') ?? this.shells.values().next().value;
			if (victim === undefined) {
				break;
			}
			this.shells.delete(victim.id);
		}
	}
}

/** ペインでエージェントが動いていないときに送る形（Monitor の paradisMonitorsForStoppedPane と同じ理由で、送るたびに判定する）。 */
export function paradisShellsForStoppedPane(shells: readonly IParadisAgentShell[], endedAt: number | undefined): IParadisAgentShell[] {
	return shells.map(shell => shell.status !== 'running' ? shell : {
		...shell,
		status: 'stopped' as const,
		estimated: true as const,
		...(endedAt !== undefined ? { endedAt: Math.max(endedAt, shell.startedAt) } : {}),
	});
}

/** 構成ごとの、出力と停止の可否。 */
export function paradisShellsAccess(where: IParadisAgentShellsAccess['where'], modAlive: boolean): IParadisAgentShellsAccess {
	return where !== undefined ? { output: false, stop: false, where } : { output: true, stop: modAlive };
}
