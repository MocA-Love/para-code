// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { statusBucket, type HomeStatusBucket } from '../../homeSort.js';
import { countRunningAgents } from '../../attentionCount.js';
import { pinKeyForTerminal } from '../../store.js';
import { formatRelativeTime } from '../../time.js';
import type { ConnectionKind } from '../../ui/statusColors.js';
import { PAIRING_REJECTED_LABEL } from '../../pcStatus.js';
import { updateRequiredLabel, type UpdateTarget } from '../../pcCompat.js';
import { lastKnownTotals, type LastKnownPcSnapshot } from '../../lastKnownPcs.js';

/**
 * ホーム（`/`）の数字を決める純関数。統計カード3枚と、PC のカードの件数・接続の一文。
 *
 * **統計カードの中身（Orca は「起動回数・稼働時間・作成した PR」）**: PC 側がこれらを集計して
 * 送っていないので、いまある値で代える。3枚とも全 PC の合計で、押すと内訳の画面を開く。
 *  - 要対応: 答えを待っているエージェントの数。ホームで一番先に知りたいもの。つながっている全 PC ぶん
 *    （押すと全 PC 横断の一覧 `/agents?state=waiting`）
 *  - 実行中: 動いているエージェントの数。見ていない PC も、接続を保っていれば（既定）その PC の状態から数える
 *    （押すと `/agents?state=running`）
 *  - 今日のコスト: 全 PC と SSH の接続先の ccusage の今日の合計（`useHomeUsage` の `todayCostTotal`。
 *    押すとコストの画面）
 *
 * つながっていない PC は要対応・実行中に足さず、カードの下の1行（`statScopeNote`）で台数だけを言う。
 */

/** 件数の元になる PC の要約（実体は `appState.ts` の `PcSummary`）。 */
export interface HomePcLike {
	readonly id: string;
	readonly connection: string;
	readonly pcOnline: boolean;
	readonly workspaces: number;
	/** 要対応の数（数え方は `attentionCount.ts`）。 */
	readonly waiting: number;
	/** 実行中の数（アーカイブを除く。数え方は `attentionCount.ts` の `countRunningAgents`）。 */
	readonly running: number;
	/** 版が合わない（どちらかの更新が必要）。この間は State を捨てるので件数は 0 のまま。 */
	readonly updateRequired?: UpdateTarget | undefined;
	/** リレーがこの端末の資格を拒んだ（再ペアリングが必要。待ってもつながらない）。 */
	readonly pairingRejected?: boolean;
}

/**
 * 合計から見た PC の状態。
 *  - `counted`: 合計に足す（リレーにつながり、向こうで Para Code が動いていて、版が合う）
 *  - `connecting`: つなごうとしている（起動直後・つなぎ直し）
 *  - `updateRequired`: つながっていても版が合わず、State を受け取らない
 *  - `unconnected`: それ以外（オフライン・PC の Para Code が止まっている・資格を拒まれた）
 */
export type PcCountState = 'counted' | 'connecting' | 'updateRequired' | 'unconnected';

type CountStateInput = Pick<HomePcLike, 'connection' | 'pcOnline' | 'updateRequired' | 'pairingRejected'>;

export function pcCountState(pc: CountStateInput): PcCountState {
	if (pc.updateRequired !== undefined) {
		return 'updateRequired';
	}
	if (pc.connection === 'online' && pc.pcOnline) {
		return 'counted';
	}
	// 資格を拒まれた PC は 1〜15 分おきの確認の間だけ「接続しています」になるので、つなぎ中には数えない。
	if (pc.pairingRejected !== true && (pc.connection === 'connecting' || pc.connection === 'handshaking')) {
		return 'connecting';
	}
	return 'unconnected';
}

/** 件数の元になるターミナル（実体は `workspace.terminals`）。 */
export interface HomeTerminalLike {
	readonly terminalKey: string;
	readonly agent?: boolean;
	readonly agentStatus?: string;
}

/**
 * 合計に足す PC か（`pcCountState` が `counted`）。切れた PC の件数は最後に見えた値でしかなく、その間に答えられて
 * いる・終わっているかもしれない（PC のカードでも切れた PC には件数を出さない）。版が合わない PC は State を
 * 受け取らないので数えない。全 PC 横断の一覧（`agentsAcrossPcs.ts`）も同じ判定で行を出すので、押した数と行の数が揃う。
 */
export function isCountedPc(pc: CountStateInput): boolean {
	return pcCountState(pc) === 'counted';
}

/** 要対応の合計。**つながっている PC だけ**を足す（`isCountedPc`）。 */
export function totalAttention(pcs: readonly HomePcLike[]): number {
	return pcs.reduce((sum, pc) => (isCountedPc(pc) ? sum + pc.waiting : sum), 0);
}

/** 実行中の合計。要対応と同じく**つながっている PC だけ**を足す（`isCountedPc`）。 */
export function totalRunning(pcs: readonly HomePcLike[]): number {
	return pcs.reduce((sum, pc) => (isCountedPc(pc) ? sum + pc.running : sum), 0);
}

/**
 * 統計カードの下の1行（合計の範囲）。「2 台の合計 · 1 台は未接続」「1 台の合計 · 1 台は接続しています」。
 * PC があれば必ず何か言う（起動直後に行が出たり消えたりして、下の PC のカードがずれないように）。
 * つなごうとしている PC は「未接続」と言わずに分けて数える。PC が無ければ undefined。
 */
export function statScopeNote(pcs: readonly CountStateInput[]): string | undefined {
	const tally: Record<PcCountState, number> = { counted: 0, connecting: 0, updateRequired: 0, unconnected: 0 };
	for (const pc of pcs) {
		tally[pcCountState(pc)]++;
	}
	const parts: string[] = [];
	if (tally.counted > 0) {
		parts.push(`${tally.counted} 台の合計`);
	}
	if (tally.connecting > 0) {
		parts.push(`${tally.connecting} 台は接続しています`);
	}
	if (tally.updateRequired > 0) {
		parts.push(`${tally.updateRequired} 台は更新が必要`);
	}
	if (tally.unconnected > 0) {
		parts.push(`${tally.unconnected} 台は未接続`);
	}
	return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** 今日のコストの表示（小数2桁のドル）。取れていなければダッシュ。 */
export function formatCost(cost: number | undefined): string {
	return cost === undefined || !Number.isFinite(cost) ? '—' : `$${cost.toFixed(2)}`;
}

/** PC のカードの3・4行目（「3 スペース · 7 エージェント」と状態ごとの件数）。 */
export interface PcCardCounts {
	readonly spaces: number;
	/** エージェントの数。いま見ていない PC は台帳の要約（要対応と実行中の数）しか使わないので undefined。 */
	readonly agents: number | undefined;
	/** 状態ごとの件数（0 の状態は含めない。並びは要対応 → 実行中 → 未確認 → 待機）。 */
	readonly buckets: readonly { readonly bucket: HomeStatusBucket; readonly count: number }[];
}

const BUCKET_ORDER: readonly HomeStatusBucket[] = ['waiting', 'working', 'review', 'idle'];

/**
 * PC のカードの件数。いま見ている PC はターミナルの一覧から状態ごとに数え、
 * それ以外の PC は台帳の要約（スペース数・要対応と実行中の数）だけを使う。
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
			buckets: [
				{ bucket: 'waiting' as const, count: pc.waiting },
				{ bucket: 'working' as const, count: pc.running },
			].filter(entry => entry.count > 0),
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
		// 実行中はホームのカード・見ていない PC のチップと同じ関数で数える（下で上書きする）。
		if (bucket !== 'working') {
			counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
		}
	}
	counts.set('working', countRunningAgents(activeTerminals, archivedKeys));
	return {
		spaces: pc.workspaces,
		agents,
		buckets: BUCKET_ORDER
			.map(bucket => ({ bucket, count: counts.get(bucket) ?? 0 }))
			.filter(entry => entry.count > 0),
	};
}

/**
 * つながっていない PC のカードに出す、前回の一覧の件数（W2-25）。**表示だけ**に使い、
 * 要対応の合計（`totalAttention`）には足さない（その間に答えられているかもしれない）。
 */
export function lastKnownCardCounts(snapshot: LastKnownPcSnapshot): PcCardCounts {
	const totals = lastKnownTotals(snapshot);
	return {
		spaces: totals.spaces,
		agents: totals.agents,
		buckets: BUCKET_ORDER
			.map(bucket => ({ bucket, count: totals[bucket] }))
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
