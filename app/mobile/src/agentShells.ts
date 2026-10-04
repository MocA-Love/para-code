// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Claude Code のバックグラウンドのシェル（Bash の run_in_background）の一覧と、Monitor と 1 つにまとめたピルの中身。
 *
 * PC は agent の snapshot / delta に任意項目 `shells`・`shellsAt`・`shellsAccess` を載せる（`agent.shells.v1`。PC 側は
 * `src/vs/paradis/contrib/agentChat/common/paradisAgentShells.ts`）。古い PC は送らないので、そのときは一覧が無い
 * （undefined）＝ピルは今までどおり Monitor だけを出す。ここは画面から切り出した純関数だけを置く。
 *
 * 決まり（ユーザーの決定、`background-shells-mock.html` の案 B-2）:
 * - Monitor とシェルを 1 つのピルにまとめる。両方あるときの文字は「実行中 N」、片方だけなら「Shell 2」「Monitor」
 * - 終わったものの残し方は Monitor と同じ（ピルは終了から 1 分、一覧は PC が持つ間ずっと）
 * - 一覧は出力の末尾 1 行、詳細は 20 行
 */

import { MONITOR_PILL_LINGER_MS, formatMonitorDuration, monitorEndWord, monitorPillSummary, monitorTone, pillMonitors, type AgentMonitor, type MonitorTone } from './agentMonitors.js';

export type AgentShellStatus = 'running' | 'completed' | 'failed' | 'stopped';
export type AgentShellStopper = 'user' | 'agent' | 'mobile';

export interface AgentShell {
	id: string;
	command?: string;
	description?: string;
	/** 時刻はすべて手元の時計（{@link localizeAgentShells} で PC の時計から直したもの）。 */
	startedAt: number;
	startUnknown?: true;
	status: AgentShellStatus;
	stoppedBy?: AgentShellStopper;
	estimated?: true;
	endedAt?: number;
	exitCode?: number;
	movedToBackground?: 'user' | 'timeout';
}

/** 出力と停止をこの構成で使えるか。`where` があればその構成では使えない。 */
export interface AgentShellsAccess {
	output: boolean;
	stop: boolean;
	where?: 'ssh' | 'wsl' | 'windows';
}

/** 一覧の行に出す出力の行数と、詳細に出す行数（ユーザーの決定）。 */
export const SHELL_LIST_OUTPUT_LINES = 1;
export const SHELL_DETAIL_OUTPUT_LINES = 20;
/** シートを開いている間、動いているシェルの出力を取り直す間隔。 */
export const SHELL_OUTPUT_POLL_MS = 2_000;

const MAX_SHELLS = 50;
const STATUSES = new Set<AgentShellStatus>(['running', 'completed', 'failed', 'stopped']);
const STOPPERS = new Set<AgentShellStopper>(['user', 'agent', 'mobile']);
const SHELL_ID = /^[A-Za-z0-9_-]{1,64}$/;

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** PC から届いた `shells` を読む。配列でなければ undefined（古い PC・壊れた値）。形の合わない要素は捨てる。 */
export function parseAgentShells(value: unknown): AgentShell[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const shells: AgentShell[] = [];
	for (const candidate of value.slice(0, MAX_SHELLS)) {
		const item = record(candidate);
		if (item === undefined || typeof item['id'] !== 'string' || !SHELL_ID.test(item['id']) || !finite(item['startedAt']) || !STATUSES.has(item['status'] as AgentShellStatus)) {
			continue;
		}
		shells.push({
			id: item['id'],
			...(typeof item['command'] === 'string' ? { command: item['command'].slice(0, 2_000) } : {}),
			...(typeof item['description'] === 'string' && item['description'].length > 0 ? { description: item['description'].slice(0, 500) } : {}),
			startedAt: item['startedAt'],
			...(item['startUnknown'] === true ? { startUnknown: true as const } : {}),
			status: item['status'] as AgentShellStatus,
			...(STOPPERS.has(item['stoppedBy'] as AgentShellStopper) ? { stoppedBy: item['stoppedBy'] as AgentShellStopper } : {}),
			...(item['estimated'] === true ? { estimated: true as const } : {}),
			...(finite(item['endedAt']) ? { endedAt: item['endedAt'] } : {}),
			...(finite(item['exitCode']) ? { exitCode: Math.trunc(item['exitCode']) } : {}),
			...(item['movedToBackground'] === 'user' || item['movedToBackground'] === 'timeout' ? { movedToBackground: item['movedToBackground'] } : {}),
		});
	}
	return shells;
}

/** `shellsAccess` を読む。無い・壊れていれば undefined（出力も停止も出さない）。 */
export function parseAgentShellsAccess(value: unknown): AgentShellsAccess | undefined {
	const item = record(value);
	if (item === undefined || typeof item['output'] !== 'boolean' || typeof item['stop'] !== 'boolean') {
		return undefined;
	}
	const where = item['where'] === 'ssh' || item['where'] === 'wsl' || item['where'] === 'windows' ? item['where'] : undefined;
	return { output: item['output'] && where === undefined, stop: item['stop'] && where === undefined, ...(where !== undefined ? { where } : {}) };
}

/** PC の時計の時刻を手元の時計へ直す（Monitor の localizeAgentMonitors と同じ考え方。`shellsAt` は PC の送信時刻）。 */
export function localizeAgentShells(shells: readonly AgentShell[], shellsAt: unknown, receivedAt: number): AgentShell[] {
	if (!finite(shellsAt)) {
		return [...shells];
	}
	const shift = receivedAt - shellsAt;
	return shells.map(shell => ({ ...shell, startedAt: shell.startedAt + shift, ...(shell.endedAt !== undefined ? { endedAt: shell.endedAt + shift } : {}) }));
}

function isLingering(shell: AgentShell, now: number): boolean {
	return shell.status !== 'running' && shell.endedAt !== undefined && now - shell.endedAt < MONITOR_PILL_LINGER_MS;
}

/** ピルに数えるシェル（実行中か、終わってから 1 分以内。Monitor と同じ）。 */
export function pillShells(shells: readonly AgentShell[] | undefined, now: number): AgentShell[] {
	return (shells ?? []).filter(shell => shell.status === 'running' || isLingering(shell, now));
}

export function shellTone(shell: Pick<AgentShell, 'status'>): MonitorTone {
	switch (shell.status) {
		case 'running': return 'running';
		case 'completed': return 'done';
		case 'failed': return 'failed';
		default: return 'idle';
	}
}

/** 終わり方の短い言葉（ピル用）。 */
function shellEndWord(shell: AgentShell): string {
	switch (shell.status) {
		case 'completed': return '終了';
		case 'failed': return '失敗';
		case 'stopped': return '停止';
		default: return '実行中';
	}
}

/** 一覧の行の右上と詳細の「状態」に出す言葉（「終了（exit 0）」「失敗（exit 2）」「TUI で停止」）。実行中は「実行中」。 */
export function shellStatusLabel(shell: AgentShell): string {
	if (shell.status === 'running') {
		return '実行中';
	}
	if (shell.status === 'stopped') {
		if (shell.estimated === true) {
			return '停止（推定）';
		}
		switch (shell.stoppedBy) {
			case 'user': return 'TUI で停止';
			case 'agent': return 'エージェントが停止';
			case 'mobile': return 'アプリから停止';
			default: return '停止';
		}
	}
	const word = shellEndWord(shell);
	// 推定（出力ファイルの最後の印から PC が決めた。本物の通知が来れば直る）
	const estimated = shell.estimated === true ? '（推定）' : '';
	return shell.exitCode !== undefined ? `${word}（exit ${shell.exitCode}）${estimated}` : `${word}${estimated}`;
}

/** 行の題（コマンドの 1 行目。無ければ説明、それも無ければ ID）。 */
export function shellTitle(shell: Pick<AgentShell, 'command' | 'description' | 'id'>): string {
	const firstLine = shell.command?.split('\n').find(line => line.trim().length > 0)?.trim();
	return firstLine ?? shell.description ?? shell.id;
}

/** 実行中の経過時間、または終わるまでにかかった時間（起動が分からないものは出さない）。 */
export function shellDurationLabel(shell: AgentShell, now: number): string | undefined {
	if (shell.status === 'running') {
		const label = formatMonitorDuration(now - shell.startedAt);
		return shell.startUnknown === true ? `${label}以上` : label;
	}
	if (shell.endedAt === undefined || shell.startUnknown === true) {
		return undefined;
	}
	return formatMonitorDuration(shell.endedAt - shell.startedAt);
}

/** 一覧の並び: 実行中（古い順）と、終わったもの（新しく終わった順）。Monitor の partitionMonitors と同じ。 */
export function partitionShells(shells: readonly AgentShell[] | undefined): { readonly running: AgentShell[]; readonly ended: AgentShell[] } {
	const list = shells ?? [];
	return {
		running: list.filter(shell => shell.status === 'running').sort((a, b) => a.startedAt - b.startedAt),
		ended: list.filter(shell => shell.status !== 'running').sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)),
	};
}

export type BackgroundTab = 'shells' | 'monitors';

export interface BackgroundPillSummary {
	readonly tone: MonitorTone;
	/** ピルの文字（「実行中 3」「Shell 2」「Shell 失敗」「Monitor」）。 */
	readonly label: string;
	readonly accessibilityLabel: string;
	/** シートを開いたときに最初に見せる方。 */
	readonly tab: BackgroundTab;
}

/**
 * コンポーザーのピルの中身。出さないときは undefined。
 * - Monitor だけ: 今の Monitor のピルと同じ
 * - シェルだけ: 実行中があればその件数（2 件以上で数字）、無ければ直前に終わったものの終わり方
 * - 両方: 実行中の合計「実行中 N」（モデルのピルを切らないため短くする）。実行中が無ければ、直前に終わった方の終わり方
 */
export function backgroundPillSummary(monitors: readonly AgentMonitor[] | undefined, shells: readonly AgentShell[] | undefined, now: number): BackgroundPillSummary | undefined {
	const shownShells = pillShells(shells, now);
	const shownMonitors = pillMonitors(monitors, now);
	if (shownShells.length === 0) {
		const monitor = monitorPillSummary(monitors, now);
		return monitor !== undefined ? { ...monitor, tab: 'monitors' } : undefined;
	}
	const runningShells = shownShells.filter(shell => shell.status === 'running').length;
	const runningMonitors = shownMonitors.filter(monitor => monitor.status === 'running').length;
	if (shownMonitors.length > 0 && runningShells + runningMonitors > 0) {
		const total = runningShells + runningMonitors;
		return {
			tone: 'running',
			label: `実行中 ${total}`,
			accessibilityLabel: `シェルが ${runningShells} 件、Monitor が ${runningMonitors} 件実行中。押すと一覧を開きます`,
			tab: runningShells > 0 ? 'shells' : 'monitors',
		};
	}
	if (runningShells > 0) {
		return {
			tone: 'running',
			label: runningShells >= 2 ? `Shell ${runningShells}` : 'Shell',
			accessibilityLabel: `バックグラウンドのシェルが ${runningShells} 件実行中。押すと一覧を開きます`,
			tab: 'shells',
		};
	}
	// 終わったものだけ。失敗があれば失敗を、無ければいちばん最後に終わったものの終わり方を出す（両方あるときも同じ並べ方）。
	const ended: { readonly tab: BackgroundTab; readonly tone: MonitorTone; readonly label: string; readonly word: string; readonly endedAt: number }[] = [
		...shownShells.map(shell => ({ tab: 'shells' as const, tone: shellTone(shell), label: 'Shell', word: shellEndWord(shell), endedAt: shell.endedAt ?? 0 })),
		...shownMonitors.filter(monitor => monitor.status !== 'running').map(monitor => ({ tab: 'monitors' as const, tone: monitorTone(monitor), label: 'Monitor', word: monitorEndWord(monitor), endedAt: monitor.endedAt ?? 0 })),
	];
	const latest = ended.find(item => item.tone === 'failed') ?? [...ended].sort((a, b) => b.endedAt - a.endedAt)[0];
	if (latest === undefined) {
		return undefined;
	}
	const what = latest.tab === 'shells' ? 'バックグラウンドのシェル' : 'Monitor';
	return { tone: latest.tone, label: `${latest.label} ${latest.word}`, accessibilityLabel: `${what}が${latest.word}しました。押すと一覧を開きます`, tab: latest.tab };
}

/** ピルの見た目が次に変わる時刻（終わったシェルが 1 分を過ぎて消える時刻）。Monitor の分は nextMonitorPillChange。 */
export function nextShellPillChange(shells: readonly AgentShell[] | undefined, now: number): number | undefined {
	let next: number | undefined;
	for (const shell of shells ?? []) {
		if (isLingering(shell, now) && shell.endedAt !== undefined) {
			const at = shell.endedAt + MONITOR_PILL_LINGER_MS;
			if (next === undefined || at < next) {
				next = at;
			}
		}
	}
	return next;
}

/** この構成で出力を読めない理由（読めるなら undefined）。 */
export function shellOutputUnavailableReason(access: AgentShellsAccess | undefined): string | undefined {
	switch (access?.where) {
		case 'ssh': return 'SSH の接続先で動いているため、出力はこのアプリへ届きません。PC の端末で /tasks を開くと読めます。';
		case 'wsl': return 'WSL の中で動いているため、出力はこのアプリへ届きません。PC の端末で /tasks を開くと読めます。';
		case 'windows': return 'Windows の PC では、出力をこのアプリへ届けられません。PC の端末で /tasks を開くと読めます。';
		default: return access === undefined || !access.output ? 'この PC からは出力を読めません。' : undefined;
	}
}

/**
 * 停止のボタンの出し方。`hidden` は出さない（終わっている・mod がつながっていない・PC とつながっていない）、
 * `disabled` は理由を添えて押せなくする（その構成では止められない）、`enabled` は押せる。
 */
/**
 * 止める対象になるか（動いているもの。推定で終わったもの（出力の最後の印・セッションの終わり）も、本当は動いている
 * かもしれないので含める。PC の判定と同じ）。
 */
export function isShellStoppable(shell: Pick<AgentShell, 'status' | 'estimated'>): boolean {
	return shell.status === 'running' || shell.estimated === true;
}

export function shellStopState(shell: Pick<AgentShell, 'status' | 'estimated'>, access: AgentShellsAccess | undefined, pcConnected: boolean): { readonly kind: 'hidden' } | { readonly kind: 'disabled'; readonly reason: string } | { readonly kind: 'enabled' } {
	if (!isShellStoppable(shell) || access === undefined) {
		return { kind: 'hidden' };
	}
	switch (access.where) {
		case 'ssh': return { kind: 'disabled', reason: 'SSH の接続先では Claude Mods が動かないため、ここからは止められません。' };
		case 'wsl': return { kind: 'disabled', reason: 'WSL の中では Claude Mods が動かないため、ここからは止められません。' };
		case 'windows': return { kind: 'disabled', reason: 'Windows の PC では Claude Mods が動かないため、ここからは止められません。' };
	}
	return access.stop && pcConnected ? { kind: 'enabled' } : { kind: 'hidden' };
}

/** 構成の表記（詳細の「場所」）。手元なら undefined。 */
export function shellWhereLabel(access: AgentShellsAccess | undefined): string | undefined {
	switch (access?.where) {
		case 'ssh': return 'SSH の接続先';
		case 'wsl': return 'WSL';
		case 'windows': return 'Windows';
		default: return undefined;
	}
}

export interface AgentShellOutput {
	readonly lines: readonly string[];
	readonly truncated: boolean;
	readonly error?: 'not-found' | 'unavailable';
}

/** `shell-output` の返事を読む。形が合わなければ undefined。 */
export function parseShellOutputReply(value: Record<string, unknown>): { readonly outputs: ReadonlyMap<string, AgentShellOutput>; readonly readAt?: number; readonly error?: string } | undefined {
	if (typeof value['error'] === 'string') {
		return { outputs: new Map(), error: value['error'].slice(0, 100) };
	}
	if (!Array.isArray(value['shells'])) {
		return undefined;
	}
	const outputs = new Map<string, AgentShellOutput>();
	for (const candidate of value['shells'].slice(0, MAX_SHELLS)) {
		const item = record(candidate);
		if (item === undefined || typeof item['id'] !== 'string' || !SHELL_ID.test(item['id'])) {
			continue;
		}
		if (item['error'] === 'not-found' || item['error'] === 'unavailable') {
			outputs.set(item['id'], { lines: [], truncated: false, error: item['error'] });
			continue;
		}
		const lines = Array.isArray(item['lines']) ? item['lines'].filter((line): line is string => typeof line === 'string').slice(-50).map(line => line.slice(0, 1_001)) : [];
		outputs.set(item['id'], { lines, truncated: item['truncated'] === true });
	}
	return { outputs, ...(finite(value['readAt']) ? { readAt: value['readAt'] } : {}) };
}

/** 出力の取り寄せが PC で混み合っていた（同じペインで別の読み取りが走っている）。 */
export class ShellOutputBusyError extends Error {
	constructor() {
		super('出力を読み込み中です');
	}
}

/** busy のときに読み直すまでの間。 */
export const SHELL_OUTPUT_BUSY_RETRY_MS = 500;

/** {@link ShellOutputPoller} の時計（テストで差し替える）。 */
export interface ShellOutputTimers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(handler: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

const DEFAULT_TIMERS: ShellOutputTimers = {
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
	setInterval: (handler, ms) => setInterval(handler, ms),
	clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * シートを開いている間の出力の取り寄せ（1 つの画面の 1 つの組み合わせ（ID・行数）ごとに 1 つ作り、変わったら作り直す）。
 * - 作ったらすぐ 1 回読む（前の組み合わせの読み取りが残っていても待たない。前のものの結果は捨てる）
 * - 読んでいる間に次の読み（間隔の時計）が来たら重ねず、終わってから 1 回だけ読み直す
 * - PC が busy と答えたら、{@link SHELL_OUTPUT_BUSY_RETRY_MS} 待って 1 回だけ読み直す。それでも busy なら error を返す
 */
export class ShellOutputPoller {
	private inFlight = false;
	private again = false;
	private disposed = false;
	private interval: unknown;
	private retry: unknown;

	constructor(
		private readonly request: () => Promise<{ readonly outputs: ReadonlyMap<string, AgentShellOutput> }>,
		private readonly onResult: (result: { readonly outputs: ReadonlyMap<string, AgentShellOutput> } | { readonly error: string }) => void,
		poll: boolean,
		private readonly timers: ShellOutputTimers = DEFAULT_TIMERS,
	) {
		this.load(true);
		if (poll) {
			this.interval = timers.setInterval(() => this.load(true), SHELL_OUTPUT_POLL_MS);
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.interval !== undefined) {
			this.timers.clearInterval(this.interval);
		}
		if (this.retry !== undefined) {
			this.timers.clearTimeout(this.retry);
		}
	}

	private load(mayRetryBusy: boolean): void {
		if (this.disposed) {
			return;
		}
		if (this.inFlight) {
			this.again = true;
			return;
		}
		this.inFlight = true;
		this.request().then(result => {
			if (!this.disposed) {
				this.onResult(result);
			}
		}, (error: unknown) => {
			if (this.disposed) {
				return;
			}
			if (error instanceof ShellOutputBusyError && mayRetryBusy) {
				if (this.retry === undefined) {
					this.retry = this.timers.setTimeout(() => {
						this.retry = undefined;
						this.load(false);
					}, SHELL_OUTPUT_BUSY_RETRY_MS);
				}
				return;
			}
			// 読み直しでも busy なら、文言を出す（黙って空のままにしない）
			this.onResult({ error: error instanceof Error ? error.message : '出力を読めませんでした' });
		}).finally(() => {
			this.inFlight = false;
			if (this.again && !this.disposed) {
				this.again = false;
				this.load(true);
			}
		});
	}
}
