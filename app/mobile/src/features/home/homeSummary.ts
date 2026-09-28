// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { statusBucket, type HomeStatusBucket } from '../../homeSort.js';
import { pinKeyForTerminal } from '../../store.js';
import { formatRelativeTime } from '../../time.js';
import type { ConnectionKind } from '../../ui/statusColors.js';
import { PAIRING_REJECTED_LABEL } from '../../pcStatus.js';
import { updateRequiredLabel, type UpdateTarget } from '../../pcCompat.js';

/**
 * ホーム（`/`）の数字を決める純関数。統計カード3枚と、PC のカードの件数・接続の一文。
 *
 * **統計カードの中身（Orca は「起動回数・稼働時間・作成した PR」）**: PC 側がこれらを集計して
 * 送っていないので、いまある値で代える（作り直し計画の【要確認】）。
 *  - 要対応: 答えを待っているエージェントの数。ホームで一番先に知りたいもの。全 PC ぶん
 *  - 実行中: いま見ている PC で動いているエージェントの数（他の PC は件数の内訳が届かない）
 *  - 今日のコスト: いま見ている PC の ccusage の今日の合計（使用量の画面と同じ `todayCost`）
 */

/** 件数の元になる PC の要約（実体は `appState.ts` の `PcSummary`）。 */
export interface HomePcLike {
	readonly id: string;
	readonly connection: string;
	readonly pcOnline: boolean;
	readonly workspaces: number;
	/** 要対応の数（数え方は `attentionCount.ts`）。 */
	readonly waiting: number;
}

/** 件数の元になるターミナル（実体は `workspace.terminals`）。 */
export interface HomeTerminalLike {
	readonly terminalKey: string;
	readonly agent?: boolean;
	readonly agentStatus?: string;
}

/**
 * 要対応の合計。**つながっている PC だけ**を足す。切れた PC の件数は最後に見えた値でしかなく、
 * その間に答えられているかもしれない（PC のカードでも切れた PC には件数を出さない）。
 */
export function totalAttention(pcs: readonly HomePcLike[]): number {
	return pcs.reduce((sum, pc) => (pc.connection === 'online' && pc.pcOnline ? sum + pc.waiting : sum), 0);
}

/** いま見ている PC で実行中のエージェントの数（アーカイブしたものは数えない）。 */
export function runningAgents(terminals: readonly HomeTerminalLike[] | undefined, archivedKeys: ReadonlySet<string>): number {
	let count = 0;
	for (const terminal of terminals ?? []) {
		if (terminal.agent === true && terminal.agentStatus === 'working' && !archivedKeys.has(pinKeyForTerminal(terminal))) {
			count++;
		}
	}
	return count;
}

/** 今日のコストの表示（小数2桁のドル）。取れていなければダッシュ。 */
export function formatCost(cost: number | undefined): string {
	return cost === undefined || !Number.isFinite(cost) ? '—' : `$${cost.toFixed(2)}`;
}

/** PC のカードの3・4行目（「3 スペース · 7 エージェント」と状態ごとの件数）。 */
export interface PcCardCounts {
	readonly spaces: number;
	/** エージェントの数。いま見ていない PC は内訳が届かないので undefined。 */
	readonly agents: number | undefined;
	/** 状態ごとの件数（0 の状態は含めない。並びは要対応 → 実行中 → 未確認 → 待機）。 */
	readonly buckets: readonly { readonly bucket: HomeStatusBucket; readonly count: number }[];
}

const BUCKET_ORDER: readonly HomeStatusBucket[] = ['waiting', 'working', 'review', 'idle'];

/**
 * PC のカードの件数。いま見ている PC はターミナルの一覧から状態ごとに数え、
 * それ以外の PC は台帳の要約（スペース数と要対応の数）だけを使う。
 */
export function pcCardCounts(
	pc: HomePcLike,
	activeTerminals: readonly HomeTerminalLike[] | undefined,
	archivedKeys: ReadonlySet<string>,
): PcCardCounts {
	if (activeTerminals === undefined) {
		return {
			spaces: pc.workspaces,
			agents: undefined,
			buckets: pc.waiting > 0 ? [{ bucket: 'waiting', count: pc.waiting }] : [],
		};
	}
	const counts = new Map<HomeStatusBucket, number>();
	let agents = 0;
	for (const terminal of activeTerminals) {
		if (terminal.agent !== true || archivedKeys.has(pinKeyForTerminal(terminal))) {
			continue;
		}
		agents++;
		const bucket = statusBucket(terminal.agentStatus);
		counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
	}
	return {
		spaces: pc.workspaces,
		agents,
		buckets: BUCKET_ORDER
			.map(bucket => ({ bucket, count: counts.get(bucket) ?? 0 }))
			.filter(entry => entry.count > 0),
	};
}

/** 接続の一文の語（`connectionLabel` と揃える）。 */
const CONNECTION_WORD: Record<ConnectionKind, string> = {
	connected: '接続中',
	connecting: '接続しています…',
	pcOffline: 'PCオフライン',
	offline: 'オフライン',
};

/**
 * PC のカードの接続の一文（モックの `.hmeta`）。つながっていれば経路（Para Code の PC とは常に
 * リレー経由でつながる。モックの「LAN」に当たる欄）、切れているときは最後につながっていた時刻を添える
 * （「オフライン · 2時間前まで接続」）。
 */
export function pcConnectionLine(kind: ConnectionKind, lastOnlineAt: number | undefined, now: number, pairingRejected = false, updateRequired?: UpdateTarget): string {
	// 資格を拒まれた PC は、待っても直らないので接続の語を出さない（`isPairingRejected` の結果を渡す）。
	if (pairingRejected && kind !== 'connected') {
		return PAIRING_REJECTED_LABEL;
	}
	// 版が合わない PC も、待っても直らない。どちらを更新するかを出す（`PcSummary.updateRequired`）。
	if (updateRequired !== undefined) {
		return updateRequiredLabel(updateRequired);
	}
	const word = CONNECTION_WORD[kind];
	if (kind === 'connected') {
		return `${word} · リレー経由`;
	}
	if ((kind === 'offline' || kind === 'pcOffline') && lastOnlineAt !== undefined) {
		return `${word} · ${formatRelativeTime(lastOnlineAt, now)}まで接続`;
	}
	return word;
}

/** バッテリーの一文（「バッテリー 82%」「バッテリー 40%（充電中）」）。 */
export function batteryLine(battery: { readonly level: number; readonly charging: boolean }): string {
	return `バッテリー ${Math.round(battery.level)}%${battery.charging ? '（充電中）' : ''}`;
}
