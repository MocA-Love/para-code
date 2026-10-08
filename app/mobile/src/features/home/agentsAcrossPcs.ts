// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { archivedLookup, isAttentionAgent, isRunningAgent } from '../../attentionCount.js';
import { lastKnownLabelFor, lastKnownTotals, type LastKnownPcSnapshot } from '../../lastKnownPcs.js';
import { status } from '../../theme.js';
import { formatRelativeTime } from '../../time.js';
import { resolveTerminalSpace, type PcListSpace, type PcListTerminal } from '../pc/pcList.js';
import { isCountedPc, type HomePcLike } from './homeSummary.js';

/**
 * 全 PC 横断のエージェントの一覧（`/agents?state=…`。ホームの「要対応」「実行中」のカードを押した先）を
 * 組み立てる純関数。
 *
 *  - 段は PC ごと。いま見ている PC を先頭に、残りは台帳の順
 *  - 行を出すのは合計に足す PC（`isCountedPc`）だけ。行の選び方はカードの数と同じ関数（`attentionCount.ts`）
 *    なので、押した数と行の数が揃う。行の無い PC の段は出さない
 *  - つながっていない PC は段の見出しだけを出し、前回の一覧（`LastKnownPcSnapshot`）の件数を添える。
 *    前回の一覧はスペースごとの件数しか持たないので行は出せない
 */

/** 一覧の切り替え（要対応・実行中）。 */
export type AgentsAcrossState = 'waiting' | 'running';

export const AGENTS_ACROSS_STATES: readonly AgentsAcrossState[] = ['waiting', 'running'];

/** 切り替えの呼び名（theme.status に揃える）。 */
export function agentsAcrossStateLabel(state: AgentsAcrossState): string {
	return state === 'waiting' ? status.attention.label : status.running.label;
}

/** 段の見出しに出す PC の要約（実体は `PcSummary`）。 */
export interface AgentsAcrossPc extends HomePcLike {
	readonly name: string;
	readonly lastKnown?: LastKnownPcSnapshot | undefined;
}

/** PC 1台ぶんの行の元（実体は `appState.ts` の `PcAgentSource`）。 */
export interface AgentsAcrossSource<T extends PcListTerminal> {
	readonly terminals: readonly T[];
	readonly spaces: readonly PcListSpace[];
	readonly activeWs: string | undefined;
	readonly archived: readonly string[];
}

export interface AgentsAcrossRow<T extends PcListTerminal> {
	readonly terminal: T;
	readonly space: PcListSpace | undefined;
}

/** つながっている PC の段。 */
export interface AgentsAcrossLiveSection<T extends PcListTerminal> {
	readonly kind: 'live';
	readonly pcId: string;
	readonly name: string;
	/** いま見ている PC か（行の会話の一言・経過時間は、見ている PC のぶんしか手元に無い）。 */
	readonly active: boolean;
	readonly rows: readonly AgentsAcrossRow<T>[];
}

/** つながっていない PC の段（行は無く、前回の件数だけ）。 */
export interface AgentsAcrossUnconnectedSection {
	readonly kind: 'unconnected';
	readonly pcId: string;
	readonly name: string;
	/** 前回の一覧の件数と、受け取った時刻。前回の一覧が無ければ undefined。 */
	readonly lastKnown: { readonly count: number; readonly savedAt: number } | undefined;
}

export type AgentsAcrossSection<T extends PcListTerminal> = AgentsAcrossLiveSection<T> | AgentsAcrossUnconnectedSection;

export interface AgentsAcrossList<T extends PcListTerminal> {
	readonly sections: readonly AgentsAcrossSection<T>[];
	/** 切り替えに添える件数（つながっている PC の行の数。ホームのカードの数と同じ）。 */
	readonly counts: Readonly<Record<AgentsAcrossState, number>>;
}

export interface BuildAgentsAcrossInput<T extends PcListTerminal> {
	/** 台帳の順の PC。 */
	readonly pcs: readonly AgentsAcrossPc[];
	/** PC ID → 行の元。State をまだ受けていない PC は無い。 */
	readonly sources: Readonly<Record<string, AgentsAcrossSource<T>>>;
	readonly activePcId: string | undefined;
	readonly state: AgentsAcrossState;
}

/** 行を選ぶ判定（カードの数と同じ関数を通す）。 */
function rowsFor<T extends PcListTerminal>(source: AgentsAcrossSource<T> | undefined, state: AgentsAcrossState): AgentsAcrossRow<T>[] {
	if (source === undefined) {
		return [];
	}
	const isArchived = archivedLookup(source.archived);
	// 要対応はアーカイブを見ない（要対応になったものはアーカイブ中でもホームへ戻る。archivedAgents.ts）。
	const picked = source.terminals.filter(terminal => (state === 'waiting' ? isAttentionAgent(terminal) : isRunningAgent(terminal, isArchived)));
	const spaceIndex = new Map(source.spaces.map((space, index) => [space.id, index]));
	const rows = picked.map((terminal, order) => {
		const space = resolveTerminalSpace(terminal, source.spaces, source.activeWs);
		return { row: { terminal, space }, spaceOrder: space !== undefined ? spaceIndex.get(space.id) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER, order };
	});
	// スペースの並び（PC から届いた順）、同じスペースの中は PC から届いた順。
	rows.sort((a, b) => a.spaceOrder - b.spaceOrder || a.order - b.order);
	return rows.map(entry => entry.row);
}

/** PC の並び（いま見ている PC を先頭に、残りは台帳の順）。 */
function orderPcs(pcs: readonly AgentsAcrossPc[], activePcId: string | undefined): AgentsAcrossPc[] {
	const active = pcs.filter(pc => pc.id === activePcId);
	return [...active, ...pcs.filter(pc => pc.id !== activePcId)];
}

export function buildAgentsAcrossPcs<T extends PcListTerminal>(input: BuildAgentsAcrossInput<T>): AgentsAcrossList<T> {
	const { pcs, sources, activePcId, state } = input;
	const counts: Record<AgentsAcrossState, number> = { waiting: 0, running: 0 };
	const sections: AgentsAcrossSection<T>[] = [];
	const unconnected: AgentsAcrossUnconnectedSection[] = [];
	for (const pc of orderPcs(pcs, activePcId)) {
		if (!isCountedPc(pc)) {
			const totals = pc.lastKnown !== undefined ? lastKnownTotals(pc.lastKnown) : undefined;
			unconnected.push({
				kind: 'unconnected',
				pcId: pc.id,
				name: pc.name,
				lastKnown: totals !== undefined && pc.lastKnown !== undefined
					? { count: state === 'waiting' ? totals.waiting : totals.working, savedAt: pc.lastKnown.savedAt }
					: undefined,
			});
			continue;
		}
		const source = sources[pc.id];
		const byState = { waiting: rowsFor(source, 'waiting'), running: rowsFor(source, 'running') };
		counts.waiting += byState.waiting.length;
		counts.running += byState.running.length;
		const rows = byState[state];
		if (rows.length > 0) {
			sections.push({ kind: 'live', pcId: pc.id, name: pc.name, active: pc.id === activePcId, rows });
		}
	}
	// つながっていない PC は末尾にまとめる（行のある段を先に読ませる）。
	return { sections: [...sections, ...unconnected], counts };
}

/** つながっていない PC の段に添える1文（「最終確認 2時間前の時点で要対応 0」）。 */
export function unconnectedNote(section: AgentsAcrossUnconnectedSection, state: AgentsAcrossState, now: number): string {
	if (section.lastKnown === undefined) {
		return 'まだ一覧を受け取っていません。つながると数えます';
	}
	return `${lastKnownLabelFor(formatRelativeTime(section.lastKnown.savedAt, now))}の時点で${agentsAcrossStateLabel(state)} ${section.lastKnown.count}`;
}

/** クエリの値から切り替えを読む。知らない値・無いときは要対応。 */
export function parseAgentsAcrossState(raw: string | undefined): AgentsAcrossState {
	return raw === 'running' ? 'running' : 'waiting';
}
