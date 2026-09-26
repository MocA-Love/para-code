// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * エージェントの状態が「いつから今の状態か」を、この端末で見ていた範囲で記録する純関数。
 *
 * PC からはターミナルごとの時刻が届かないので、行の経過時間を出すには手元で状態の変化を見張るしかない。
 * **初めて見たときの状態には時刻を付けない**（アプリを開いた時刻を「その状態になった時刻」と
 * 取り違えると、何時間も待機しているものが「今」と出る）。目の前で状態が変わったときだけ時刻を持つ。
 */

export interface StatusSinceEntry {
	readonly status: string | undefined;
	/** その状態になったのを見た時刻（epoch ms）。初めて見たときから同じ状態なら undefined。 */
	readonly since: number | undefined;
}

export type StatusSinceMap = ReadonlyMap<string, StatusSinceEntry>;

/**
 * 最新のターミナルの並びで記録を更新する。消えたターミナルの記録は落とす。
 * 何も変わらなければ受け取った記録をそのまま返す（購読側が無駄に描き直さないように）。
 */
export function nextStatusSince(
	previous: StatusSinceMap,
	terminals: readonly { readonly terminalKey: string; readonly agentStatus?: string }[],
	now: number,
): StatusSinceMap {
	let changed = terminals.length !== previous.size;
	const next = new Map<string, StatusSinceEntry>();
	for (const terminal of terminals) {
		const before = previous.get(terminal.terminalKey);
		if (before === undefined) {
			next.set(terminal.terminalKey, { status: terminal.agentStatus, since: undefined });
			changed = true;
		} else if (before.status !== terminal.agentStatus) {
			next.set(terminal.terminalKey, { status: terminal.agentStatus, since: now });
			changed = true;
		} else {
			next.set(terminal.terminalKey, before);
		}
	}
	return changed ? next : previous;
}
