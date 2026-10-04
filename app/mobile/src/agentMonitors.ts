// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Claude Code の Monitor（出力を1行ずつエージェントへ知らせるバックグラウンドのシェル）の一覧。
 *
 * PC は agent の snapshot / delta に任意項目 `monitors` を載せる（`agent.monitors.v1`。PC 側は
 * `src/vs/paradis/contrib/agentChat/common/paradisAgentMonitors.ts`）。古い PC は送らないので、そのときは
 * 一覧が無い（undefined）＝コンポーザーにピルを出さない。ここは画面から切り出した純関数だけを置く。
 */

export type AgentMonitorStatus = 'running' | 'completed' | 'stopped' | 'failed' | 'timedOut';

export interface AgentMonitorOutputLine {
	at: number;
	text: string;
}

export interface AgentMonitor {
	id: string;
	description: string;
	command?: string;
	/** 時刻はすべて手元の時計（{@link localizeAgentMonitors} で PC の時計から直したもの）。 */
	startedAt: number;
	/** 起動を PC が読めず、startedAt は最初に見えた出力の時刻（本当の起動はそれより前）。 */
	startUnknown?: true;
	timeoutMs?: number;
	persistent?: true;
	status: AgentMonitorStatus;
	/** 状態を transcript の印ではなく推定で決めた（上限時間の経過・セッションの終わり）。 */
	estimated?: true;
	endedAt?: number;
	exitCode?: number;
	output: AgentMonitorOutputLine[];
	eventCount: number;
}

/** 終わった Monitor をコンポーザーのピルに残す時間（ユーザーの決定: 終了から 1 分）。 */
export const MONITOR_PILL_LINGER_MS = 60_000;

const MAX_MONITORS = 50;
const MAX_OUTPUT_LINES = 10;
const STATUSES = new Set<AgentMonitorStatus>(['running', 'completed', 'stopped', 'failed', 'timedOut']);

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** PC から届いた `monitors` を読む。配列でなければ undefined（古い PC・壊れた値）。形の合わない要素は捨てる。 */
export function parseAgentMonitors(value: unknown): AgentMonitor[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const monitors: AgentMonitor[] = [];
	for (const candidate of value.slice(0, MAX_MONITORS)) {
		if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
			continue;
		}
		const item = candidate as Record<string, unknown>;
		if (typeof item['id'] !== 'string' || typeof item['description'] !== 'string' || !finite(item['startedAt'])
			|| !STATUSES.has(item['status'] as AgentMonitorStatus)) {
			continue;
		}
		const output: AgentMonitorOutputLine[] = [];
		if (Array.isArray(item['output'])) {
			for (const line of item['output'].slice(-MAX_OUTPUT_LINES)) {
				const record = line !== null && typeof line === 'object' && !Array.isArray(line) ? line as Record<string, unknown> : undefined;
				if (record !== undefined && finite(record['at']) && typeof record['text'] === 'string') {
					output.push({ at: record['at'], text: record['text'].slice(0, 1_000) });
				}
			}
		}
		monitors.push({
			id: item['id'].slice(0, 100),
			description: item['description'].slice(0, 500),
			...(typeof item['command'] === 'string' ? { command: item['command'].slice(0, 2_000) } : {}),
			startedAt: item['startedAt'],
			...(item['startUnknown'] === true ? { startUnknown: true as const } : {}),
			...(finite(item['timeoutMs']) && item['timeoutMs'] > 0 ? { timeoutMs: item['timeoutMs'] } : {}),
			...(item['persistent'] === true ? { persistent: true as const } : {}),
			status: item['status'] as AgentMonitorStatus,
			...(item['estimated'] === true ? { estimated: true as const } : {}),
			...(finite(item['endedAt']) ? { endedAt: item['endedAt'] } : {}),
			...(finite(item['exitCode']) ? { exitCode: item['exitCode'] } : {}),
			output,
			eventCount: finite(item['eventCount']) && item['eventCount'] >= 0 ? Math.trunc(item['eventCount']) : output.length,
		});
	}
	return monitors;
}

/**
 * PC の時計の時刻を手元の時計へ直す。PC は一覧と一緒に送信時刻 `monitorsAt` を送るので、
 * 受け取った時刻との差（＝時計のずれ＋届くまでの時間）をすべての時刻に足す。「終了から 1 分」を
 * 手元の時計で判定しても、PC との時計のずれで崩れないようにするため。
 * `monitorsAt` が無い（送らない PC）・読めないときは直さない。
 */
export function localizeAgentMonitors(monitors: readonly AgentMonitor[], monitorsAt: unknown, receivedAt: number): AgentMonitor[] {
	if (!finite(monitorsAt)) {
		return [...monitors];
	}
	const shift = receivedAt - monitorsAt;
	return monitors.map(monitor => ({
		...monitor,
		startedAt: monitor.startedAt + shift,
		...(monitor.endedAt !== undefined ? { endedAt: monitor.endedAt + shift } : {}),
		output: monitor.output.map(line => ({ at: line.at + shift, text: line.text })),
	}));
}

/** 実行中の経過時間（起動を PC が読めなかったものは「以上」を付ける）。 */
export function monitorElapsedLabel(monitor: Pick<AgentMonitor, 'startedAt' | 'startUnknown'>, now: number): string {
	const label = formatMonitorDuration(now - monitor.startedAt);
	return monitor.startUnknown === true ? `${label}以上` : label;
}

/** 終わってから {@link MONITOR_PILL_LINGER_MS} 以内か。終わった時刻が無いものは今終わったとみなさない。 */
function isLingering(monitor: AgentMonitor, now: number): boolean {
	return monitor.status !== 'running' && monitor.endedAt !== undefined && now - monitor.endedAt < MONITOR_PILL_LINGER_MS;
}

/** ピルに数える Monitor（実行中か、終わってから 1 分以内）。 */
export function pillMonitors(monitors: readonly AgentMonitor[] | undefined, now: number): AgentMonitor[] {
	return (monitors ?? []).filter(monitor => monitor.status === 'running' || isLingering(monitor, now));
}

export type MonitorTone = 'running' | 'done' | 'failed' | 'idle';

export interface MonitorPillSummary {
	readonly tone: MonitorTone;
	/** ピルの文字（「Monitor」「Monitor 2」「Monitor 終了」）。 */
	readonly label: string;
	readonly accessibilityLabel: string;
}

/** 状態の色分け（点とドロワーの終わり方の文字）。 */
export function monitorTone(monitor: Pick<AgentMonitor, 'status'>): MonitorTone {
	switch (monitor.status) {
		case 'running': return 'running';
		case 'completed': return 'done';
		case 'failed': return 'failed';
		default: return 'idle';
	}
}

/**
 * コンポーザーのピルの中身。出さないときは undefined。
 * 実行中があればその件数（2 件以上のときだけ数字を出す）、無ければ直前に終わったものの終わり方を出す。
 */
export function monitorPillSummary(monitors: readonly AgentMonitor[] | undefined, now: number): MonitorPillSummary | undefined {
	const shown = pillMonitors(monitors, now);
	if (shown.length === 0) {
		return undefined;
	}
	const running = shown.filter(monitor => monitor.status === 'running');
	if (running.length > 0) {
		return {
			tone: 'running',
			label: running.length >= 2 ? `Monitor ${running.length}` : 'Monitor',
			accessibilityLabel: `Monitor が ${running.length} 件実行中。押すと一覧を開きます`,
		};
	}
	// 終わったものだけ。失敗があれば失敗を、無ければいちばん最後に終わったものの終わり方を出す。
	const failed = shown.find(monitor => monitor.status === 'failed');
	const latest = failed ?? [...shown].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
	if (latest === undefined) {
		return undefined;
	}
	const word = monitorEndWord(latest);
	return {
		tone: monitorTone(latest),
		label: `Monitor ${word}`,
		accessibilityLabel: `Monitor が${word}しました。押すと一覧を開きます`,
	};
}

/** 終わり方の短い言葉（ピル用。シェルとまとめたピルでも使う）。 */
export function monitorEndWord(monitor: AgentMonitor): string {
	switch (monitor.status) {
		case 'completed': return '終了';
		case 'failed': return '失敗';
		case 'stopped': return '停止';
		case 'timedOut': return '時間切れ';
		default: return '実行中';
	}
}

/** ドロワーの行の右上に出す終わり方（「終了」「失敗（exit 1）」「時間切れ（推定）」）。実行中は undefined。 */
export function monitorStatusLabel(monitor: AgentMonitor): string | undefined {
	if (monitor.status === 'running') {
		return undefined;
	}
	const word = monitorEndWord(monitor);
	if (monitor.status === 'failed' && monitor.exitCode !== undefined) {
		return `${word}（exit ${monitor.exitCode}）`;
	}
	return monitor.estimated === true ? `${word}（推定）` : word;
}

/** 経過時間（「12秒」「5分32秒」「1時間5分」）。 */
export function formatMonitorDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) {
		return `${seconds}秒`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}分${String(seconds % 60).padStart(2, '0')}秒`;
	}
	return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

/** 上限の表記（「上限 30分」「上限 1時間30分」「常駐」）。どちらも分からなければ undefined。 */
export function monitorLimitLabel(monitor: Pick<AgentMonitor, 'timeoutMs' | 'persistent'>): string | undefined {
	if (monitor.persistent === true) {
		return '常駐';
	}
	if (monitor.timeoutMs === undefined) {
		return undefined;
	}
	const minutes = Math.round(monitor.timeoutMs / 60_000);
	if (minutes < 1) {
		return `上限 ${Math.max(1, Math.round(monitor.timeoutMs / 1000))}秒`;
	}
	if (minutes < 60) {
		return `上限 ${minutes}分`;
	}
	const rest = minutes % 60;
	return `上限 ${Math.floor(minutes / 60)}時間${rest > 0 ? `${rest}分` : ''}`;
}

/** 出力の行に添える時刻（端末の時刻で「19:20」）。 */
export function formatMonitorClock(at: number): string {
	const date = new Date(at);
	return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** ドロワーの並び: 実行中（古い順）と、終わったもの（新しく終わった順）。 */
export function partitionMonitors(monitors: readonly AgentMonitor[] | undefined): { readonly running: AgentMonitor[]; readonly ended: AgentMonitor[] } {
	const list = monitors ?? [];
	return {
		running: list.filter(monitor => monitor.status === 'running').sort((a, b) => a.startedAt - b.startedAt),
		ended: list.filter(monitor => monitor.status !== 'running').sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)),
	};
}

/**
 * ピルの見た目が次に変わる時刻（終わったものが 1 分を過ぎて消える時刻）。無ければ undefined。
 * 画面はこの時刻に1回だけ描き直せばよい（毎秒は回さない）。
 */
export function nextMonitorPillChange(monitors: readonly AgentMonitor[] | undefined, now: number): number | undefined {
	let next: number | undefined;
	for (const monitor of monitors ?? []) {
		if (isLingering(monitor, now) && monitor.endedAt !== undefined) {
			const at = monitor.endedAt + MONITOR_PILL_LINGER_MS;
			if (next === undefined || at < next) {
				next = at;
			}
		}
	}
	return next;
}
