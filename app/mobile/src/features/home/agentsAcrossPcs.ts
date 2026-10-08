// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { archivedLookup, isAttentionAgent, isRunningAgent } from '../../attentionCount.js';
import { lastKnownLabelFor, lastKnownTotals, type LastKnownPcSnapshot } from '../../lastKnownPcs.js';
import { updateRequiredLabel, type UpdateTarget } from '../../pcCompat.js';
import { status } from '../../theme.js';
import { formatRelativeTime } from '../../time.js';
import { resolveTerminalSpace, type PcListSpace, type PcListTerminal } from '../pc/pcList.js';
import { pcCountState, type HomePcLike } from './homeSummary.js';

/**
 * 全 PC 横断のエージェントの一覧（`/agents?state=…`。ホームの「要対応」「実行中」のカードを押した先）を
 * 組み立てる純関数。
 *
 *  - 段は PC ごと。いま見ている PC を先頭に、残りは台帳の順
 *  - 行を出すのは合計に足す PC（`isCountedPc`）だけ。行の選び方はカードの数と同じ関数（`attentionCount.ts`）
 *    なので、押した数と行の数が揃う。行の無い PC の段は出さない
 *  - 行を出せない PC（つながっていない・つなぎ中・版が合わない・State をまだ受けていない）は段の見出しだけを
 *    末尾に薄く出し、理由と、分かれば前回の一覧（`LastKnownPcSnapshot`）の件数を添える。前回の一覧はスペースごとの
 *    件数しか持たないので行は出せない。黙って段を消すと、合計に入らない理由が分からない
 *  - `createAgentsAcrossBuilder` は PC ごとの行と段を、行の元（`PcAgentSource`）の参照でキャッシュする。
 *    見ていない PC の State は最大 10Hz で届くので、変わっていない PC の段は同じオブジェクトを返して描き直させない
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

/**
 * 行を出せない理由。
 *  - `unconnected` / `connecting`: つながっていない・つなごうとしている（前回の件数を添える）
 *  - `updateRequired`: 版が合わない（`updateRequired` にどちらを更新するか）
 *  - `loading`: つながっているが、State をまだ受けていない
 */
export type AgentsAcrossIdleReason = 'unconnected' | 'connecting' | 'updateRequired' | 'loading';

/** 行を出せない PC の段（見出しと、理由・前回の件数の1文だけ）。 */
export interface AgentsAcrossUnconnectedSection {
	readonly kind: 'unconnected';
	readonly pcId: string;
	readonly name: string;
	readonly reason: AgentsAcrossIdleReason;
	readonly updateRequired?: UpdateTarget;
	/** 前回の一覧の件数と、受け取った時刻。前回の一覧が無い・使わない理由なら undefined。 */
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

/** PC ごとの行と段を使い回すための入れ物（`createAgentsAcrossBuilder`）。 */
interface AgentsAcrossCache<T extends PcListTerminal> {
	readonly rows: WeakMap<AgentsAcrossSource<T>, Readonly<Record<AgentsAcrossState, readonly AgentsAcrossRow<T>[]>>>;
	/** `pcId:state` → 前回の段。行の配列・名前・見ている PC かが同じなら使い回す。 */
	readonly sections: Map<string, AgentsAcrossLiveSection<T>>;
}

function rowsBoth<T extends PcListTerminal>(source: AgentsAcrossSource<T>, cache: AgentsAcrossCache<T> | undefined): Readonly<Record<AgentsAcrossState, readonly AgentsAcrossRow<T>[]>> {
	const cached = cache?.rows.get(source);
	if (cached !== undefined) {
		return cached;
	}
	const both = { waiting: rowsFor(source, 'waiting'), running: rowsFor(source, 'running') };
	cache?.rows.set(source, both);
	return both;
}

function liveSection<T extends PcListTerminal>(
	pc: AgentsAcrossPc, active: boolean, state: AgentsAcrossState, rows: readonly AgentsAcrossRow<T>[], cache: AgentsAcrossCache<T> | undefined,
): AgentsAcrossLiveSection<T> {
	const key = `${pc.id}:${state}`;
	const before = cache?.sections.get(key);
	if (before !== undefined && before.rows === rows && before.name === pc.name && before.active === active) {
		return before;
	}
	const section: AgentsAcrossLiveSection<T> = { kind: 'live', pcId: pc.id, name: pc.name, active, rows };
	cache?.sections.set(key, section);
	return section;
}

function idleSection(pc: AgentsAcrossPc, reason: AgentsAcrossIdleReason, state: AgentsAcrossState): AgentsAcrossUnconnectedSection {
	// 前回の件数は、つながっていない・つなぎ中のときだけ添える（版が合わない PC の前回の一覧は PC のカードでも出さない）。
	const snapshot = reason === 'unconnected' || reason === 'connecting' ? pc.lastKnown : undefined;
	const totals = snapshot !== undefined ? lastKnownTotals(snapshot) : undefined;
	return {
		kind: 'unconnected',
		pcId: pc.id,
		name: pc.name,
		reason,
		...(reason === 'updateRequired' && pc.updateRequired !== undefined ? { updateRequired: pc.updateRequired } : {}),
		lastKnown: totals !== undefined && snapshot !== undefined
			? { count: state === 'waiting' ? totals.waiting : totals.working, savedAt: snapshot.savedAt }
			: undefined,
	};
}

function buildWithCache<T extends PcListTerminal>(input: BuildAgentsAcrossInput<T>, cache: AgentsAcrossCache<T> | undefined): AgentsAcrossList<T> {
	const { pcs, sources, activePcId, state } = input;
	const counts: Record<AgentsAcrossState, number> = { waiting: 0, running: 0 };
	const sections: AgentsAcrossSection<T>[] = [];
	const idle: AgentsAcrossUnconnectedSection[] = [];
	for (const pc of orderPcs(pcs, activePcId)) {
		const countState = pcCountState(pc);
		if (countState !== 'counted') {
			idle.push(idleSection(pc, countState, state));
			continue;
		}
		const source = sources[pc.id];
		if (source === undefined) {
			idle.push(idleSection(pc, 'loading', state));
			continue;
		}
		const byState = rowsBoth(source, cache);
		counts.waiting += byState.waiting.length;
		counts.running += byState.running.length;
		const rows = byState[state];
		if (rows.length > 0) {
			sections.push(liveSection(pc, pc.id === activePcId, state, rows, cache));
		}
	}
	// 行を出せない PC は末尾にまとめる（行のある段を先に読ませる）。
	return { sections: [...sections, ...idle], counts };
}

export function buildAgentsAcrossPcs<T extends PcListTerminal>(input: BuildAgentsAcrossInput<T>): AgentsAcrossList<T> {
	return buildWithCache(input, undefined);
}

/**
 * 画面が持つ組み立て器。PC ごとの行を行の元の参照（`WeakMap`）で、段を `pcId:state` で覚えておき、
 * 参照が変わっていない PC には前回の段を返す（`LiveSection` の memo が効く）。
 */
export function createAgentsAcrossBuilder<T extends PcListTerminal>(): (input: BuildAgentsAcrossInput<T>) => AgentsAcrossList<T> {
	const cache: AgentsAcrossCache<T> = { rows: new WeakMap(), sections: new Map() };
	return input => buildWithCache(input, cache);
}

/** 行を出せない PC の段の見出しの右に出す語。 */
export function idleHeaderLabel(section: AgentsAcrossUnconnectedSection): string {
	switch (section.reason) {
		case 'connecting': return '接続しています…';
		case 'updateRequired': return section.updateRequired !== undefined ? updateRequiredLabel(section.updateRequired) : '更新が必要';
		case 'loading': return '受け取っています';
		default: return '未接続';
	}
}

/** 行を出せない PC の段に添える1文（「最終確認 2時間前の時点で要対応 0」など）。 */
export function unconnectedNote(section: AgentsAcrossUnconnectedSection, state: AgentsAcrossState, now: number): string {
	if (section.reason === 'updateRequired') {
		return '版が合わないため数えていません。更新すると数えます';
	}
	if (section.reason === 'loading') {
		return 'PC から一覧を受け取っています';
	}
	if (section.lastKnown === undefined) {
		return 'まだ一覧を受け取っていません。つながると数えます';
	}
	return `${lastKnownLabelFor(formatRelativeTime(section.lastKnown.savedAt, now))}の時点で${agentsAcrossStateLabel(state)} ${section.lastKnown.count}`;
}

/** クエリの値から切り替えを読む。知らない値・無いときは要対応。 */
export function parseAgentsAcrossState(raw: string | undefined): AgentsAcrossState {
	return raw === 'running' ? 'running' : 'waiting';
}
