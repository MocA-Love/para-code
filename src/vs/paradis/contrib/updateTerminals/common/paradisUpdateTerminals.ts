/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 更新の前に、接続先 (SSH) とこの PC の常駐に残したターミナルを終わらせる判断（純粋な部分）。
//
// なぜ要るのか: 接続先のサーバーも、この PC の常駐（`paradis.terminal.daemon.enabled` の方式）も、
// Para Code の版ごとに別物になる。更新すると新しい版のものへ繋がるので、前の版に残した
// ターミナルは二度と開けず、猶予時間が尽きるまで動き続ける（`paradisRemoteTerminalShutdown.ts`）。
// そこで「再起動して更新」の前に1回だけまとめて確認し、終わらせてから更新する。
//
// 確認を出すか・並べ順・「ほか N 個」・30 秒で答えが無いときの扱い・Ready のまま終了したときの
// 扱いはここに置き、テストで固定する。ウィンドウへの問い合わせや実際に止める処理は
// `electron-main/` と `electron-browser/` 側にある。

import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { StateType } from '../../../../platform/update/common/update.js';
import { ParadisKeepTerminalsChoice } from '../../../common/paradisTerminalKeepPlan.js';

/** main がウィンドウへ問い合わせるチャネル（各ウィンドウの renderer が持つ）。 */
export const PARADIS_UPDATE_TERMINALS_WINDOW_CHANNEL = 'paradisUpdateTerminalsWindow';
/** ウィンドウが main へ頼むチャネル（この PC の常駐を止める）。 */
export const PARADIS_UPDATE_TERMINALS_MAIN_CHANNEL = 'paradisUpdateTerminalsMain';

/** 確認に答えるまでの上限。過ぎたら「あとで更新」として扱う（勝手に止めない）。 */
export const PARADIS_UPDATE_CONFIRM_TIMEOUT_MS = 30_000;

/** 1つの枠に並べる行の上限。超えたぶんは最後の1行に「ほか N 個」でまとめる。 */
export const PARADIS_UPDATE_MAX_ROWS = 5;

/** 「この PC の常駐」を表す枠の鍵。接続先は remote authority をそのまま使う。 */
export const PARADIS_UPDATE_LOCAL_HOST_KEY = 'local';

export type ParadisUpdateTerminalAgent = 'claude' | 'codex';
export type ParadisUpdateTerminalAgentState = 'working' | 'permission' | 'question' | 'review';

/**
 * 更新でターミナルが取り残されるか。
 *
 * - `stranded`: 版ごとに別物（接続先のサーバー、版で区切られた常駐）。更新すると開けなくなる
 * - `survives`: 更新をまたいで繋ぎ直せる常駐の中に居る（`reattachAcrossUpdates`）。対象外
 * - `unknown`: 問い合わせに答えが無かった
 */
export type ParadisTerminalsAcrossUpdate = 'stranded' | 'survives' | 'unknown';

export interface IParadisUpdateTerminal {
	/** その機械の pty host での番号。複数のウィンドウから同じものが報告されたときの重複除けに使う。 */
	readonly id: number;
	readonly title: string;
	readonly agent?: ParadisUpdateTerminalAgent;
	readonly agentState?: ParadisUpdateTerminalAgentState;
	/** シェルの下で何か動いているか。 */
	readonly busy: boolean;
}

/** 1つのウィンドウが main へ返す報告。 */
export interface IParadisUpdateWindowReport {
	/** 接続先なら remote authority、この PC なら {@link PARADIS_UPDATE_LOCAL_HOST_KEY}。 */
	readonly hostKey: string;
	readonly hostLabel: string;
	readonly isRemote: boolean;
	/** 閉じたときに残すかの設定。`never` なら終了時にどうせ終わるので確認に含めない。 */
	readonly choice: ParadisKeepTerminalsChoice;
	readonly acrossUpdate: ParadisTerminalsAcrossUpdate;
	/** 開いているものと、この PC が前に残したもの（同じ機械の孤児）。 */
	readonly terminals: readonly IParadisUpdateTerminal[];
}

/** main が見る、この PC の常駐（版で区切られた方）の姿。 */
export interface IParadisUpdateLocalDaemon {
	/** 版で区切られた常駐が使われ、動いているか。更新をまたげる方式なら false。 */
	readonly stranded: boolean;
	/** 抱えている本数。聞けなかったら undefined。 */
	readonly terminalCount: number | undefined;
	readonly choice: ParadisKeepTerminalsChoice;
	readonly hostLabel: string;
}

export interface IParadisUpdateHostGroup {
	readonly hostKey: string;
	readonly hostLabel: string;
	readonly isRemote: boolean;
	/** 並べ順に並んだもの。 */
	readonly terminals: readonly IParadisUpdateTerminal[];
	/** あるのは分かっているが名前の無いもの（閉じたウィンドウから常駐へ残したもの）。 */
	readonly unlistedCount: number;
}

export interface IParadisUpdateTerminalSummary {
	readonly groups: readonly IParadisUpdateHostGroup[];
}

/** 確認の答え。 */
export type ParadisUpdateConfirmAnswer = 'update' | 'later';

/** main がウィンドウへ頼むこと（各ウィンドウの renderer が答える）。 */
export interface IParadisUpdateTerminalsWindowService {
	/** このウィンドウで、更新すると取り残されるターミナル。関わりが無ければ undefined。 */
	collect(): Promise<IParadisUpdateWindowReport | undefined>;
	/** まとめた確認を出す。答えが無ければ 30 秒で `later`。 */
	confirm(summary: IParadisUpdateTerminalSummary): Promise<ParadisUpdateConfirmAnswer>;
	/** 「終わらせて更新」が選ばれた。この PC が残したものを止め、合図が届くのを待って返す。 */
	stopForUpdate(): Promise<void>;
	/**
	 * 止めた後で更新が行われなかった（終了が取り消された・Ready から外れた）。合図を取り消し、
	 * このウィンドウで止めていたらそう知らせる。
	 */
	cancelUpdateQuit(): Promise<void>;
}

/** ウィンドウが main へ頼むこと（この PC の常駐は main しか触れない）。 */
export interface IParadisUpdateTerminalsMainService {
	/** この PC の常駐（版で区切られた方）の姿。使っていなければ undefined。 */
	getLocalDaemon(): Promise<IParadisUpdateLocalDaemon | undefined>;
	/**
	 * 「更新の準備ができました」を出してよいか。同じ接続先・同じ版について、全ウィンドウを通して
	 * 最初に聞いた1つにだけ true を返す（同じ接続先のウィンドウが複数あっても1回だけ出す）。
	 */
	claimReadyNotice(hostKey: string, version: string): Promise<boolean>;
}

/**
 * 確認を出すウィンドウを選ぶ。
 *
 * 選ぶのは問い合わせに答えたウィンドウ（この口を持つもの）の中からだけ。前面にあるのが答えない
 * ウィンドウ（Agent Sessions のウィンドウ・準備中のウィンドウ）なら、答えたウィンドウを前に出して
 * そこへ出す。答えたウィンドウが1つも無ければ undefined（main から OS の確認を出す）。
 */
export function paradisPickConfirmWindow(answeredIds: readonly number[], focusedId: number | undefined, lastActiveId: number | undefined): number | undefined {
	if (focusedId !== undefined && answeredIds.includes(focusedId)) {
		return focusedId;
	}
	if (lastActiveId !== undefined && answeredIds.includes(lastActiveId)) {
		return lastActiveId;
	}
	return answeredIds[0];
}

/** 止めた後、更新が本当に始まるかを見張る段階。 */
export type ParadisAfterStopPhase = 'waiting' | 'restarting' | 'cancelled';

/**
 * 止めた後の更新の状態の変化を読む。
 *
 * Restarting に進めば更新が始まった。Restarting の後に Ready へ戻ったら終了が取り消された
 * （`quitAndInstall` が veto のときに戻す）。Restarting に進む前に Ready 以外へ外れても、更新は
 * 行われない。どちらも、止めたターミナルは戻らないので知らせる。
 */
export function paradisNextAfterStopPhase(phase: ParadisAfterStopPhase, stateType: StateType | string): ParadisAfterStopPhase {
	if (phase === 'cancelled') {
		return phase;
	}
	if (stateType === StateType.Restarting) {
		return 'restarting';
	}
	if (phase === 'waiting' && stateType === StateType.Ready) {
		return 'waiting';
	}
	return 'cancelled';
}

/**
 * main の終了処理（`onWillShutdown`）で、この PC の常駐（版で区切られた方）を止めるか。
 *
 * 止めるのは main の終了処理に入ってから。それより前に止めると、pty host が「予期せず終わった」と
 * 読んで同じ版の常駐を起こし直す（`ptyHostService` は終了の合図を受けるまで立て直す）。
 * 「終わらせて更新」の後（Restarting）と、Ready のまま更新が当たる終了（ウィンドウを全部閉じた
 * macOS を含む）が対象。設定が `never` なら、閉じる処理がもう終わらせているので触らない。
 */
export function paradisShouldStopDaemonOnQuit(input: { readonly stateType: StateType | string; readonly appliesOnQuit: boolean; readonly daemonStranded: boolean; readonly choice: ParadisKeepTerminalsChoice }): boolean {
	if (!input.daemonStranded || input.choice === 'never') {
		return false;
	}
	return input.stateType === StateType.Restarting || (input.stateType === StateType.Ready && input.appliesOnQuit);
}

/** 作業中のエージェントの再開の案内に出す種類。種類の分からないものがあれば `unknown`。 */
export function paradisWorkingAgentKinds(summary: IParadisUpdateTerminalSummary): { readonly claude: boolean; readonly codex: boolean; readonly unknown: boolean } {
	const working = summary.groups.flatMap(group => group.terminals).filter(terminal => paradisUpdateTerminalRank(terminal) === 0);
	return {
		claude: working.some(terminal => terminal.agent === 'claude'),
		codex: working.some(terminal => terminal.agent === 'codex'),
		unknown: working.some(terminal => terminal.agent === undefined),
	};
}

/**
 * 「終わらせて更新」で、このウィンドウが接続先のターミナルを止めるか。
 *
 * この PC の常駐は main が止めるので、ローカルのウィンドウは止めない。設定が `never` の接続先と、
 * 更新をまたげる常駐の中のもの（`survives`）も止めない。
 */
export function paradisStopsRemoteForUpdate(input: { readonly isRemote: boolean; readonly choice: ParadisKeepTerminalsChoice; readonly acrossUpdate: ParadisTerminalsAcrossUpdate }): boolean {
	return input.isRemote && input.choice !== 'never' && input.acrossUpdate !== 'survives';
}

/**
 * 止めた後で更新が行われなかったとき、このウィンドウで知らせるか。実際に1本以上止めたときだけ。
 * 止め直しを防ぐ旗（止めようとしたか）とは別に数える。何も止めていないウィンドウで「終わらせました」と
 * 言うと誤報になる。
 */
export function paradisShouldNoticeCancelledUpdate(endedCount: number): boolean {
	return endedCount > 0;
}

/** 枠の中での総数。 */
export function paradisUpdateGroupCount(group: IParadisUpdateHostGroup): number {
	return group.terminals.length + group.unlistedCount;
}

/**
 * 並べ順の段。小さいほど上。
 *
 * 0. エージェントが作業中・許可や返事を待っている（止めると一番困るもの）
 * 1. それ以外のエージェント
 * 2. シェルの下で何か動いている
 * 3. 待機中
 */
export function paradisUpdateTerminalRank(terminal: IParadisUpdateTerminal): number {
	if (terminal.agentState === 'working' || terminal.agentState === 'permission' || terminal.agentState === 'question') {
		return 0;
	}
	// 状態だけ分かって種類が分からない（hook は届いたが会話の記録がまだ無い）ものもエージェントとして扱う。
	if (terminal.agent !== undefined || terminal.agentState !== undefined) {
		return 1;
	}
	return terminal.busy ? 2 : 3;
}

/** 並べ順に並べる。同じ段の中では元の順を保つ。 */
export function paradisSortUpdateTerminals(terminals: readonly IParadisUpdateTerminal[]): IParadisUpdateTerminal[] {
	return terminals
		.map((terminal, index) => ({ terminal, index, rank: paradisUpdateTerminalRank(terminal) }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map(entry => entry.terminal);
}

/**
 * ウィンドウからの報告と常駐の姿を、接続先ごとの枠にまとめる。
 *
 * - 設定が `never` のものは入れない（確認しなくても終了時に終わる。今までどおり）
 * - 更新をまたげる常駐の中のものは入れない（更新しても繋ぎ直せる）
 * - 同じ接続先を複数のウィンドウで開いていたら1つの枠にまとめ、同じ番号は1つにする
 * - この PC の枠には、ウィンドウに出ていない常駐の中身を「名前の無いもの」として足す
 */
export function paradisMergeUpdateReports(
	reports: readonly IParadisUpdateWindowReport[],
	localDaemon: IParadisUpdateLocalDaemon | undefined,
): IParadisUpdateTerminalSummary {
	const groups = new Map<string, { hostKey: string; hostLabel: string; isRemote: boolean; terminals: IParadisUpdateTerminal[]; ids: Set<number> }>();
	const groupFor = (hostKey: string, hostLabel: string, isRemote: boolean) => {
		let group = groups.get(hostKey);
		if (!group) {
			group = { hostKey, hostLabel, isRemote, terminals: [], ids: new Set() };
			groups.set(hostKey, group);
		}
		return group;
	};
	const localIncluded = localDaemon !== undefined && localDaemon.stranded && localDaemon.choice !== 'never';
	for (const report of reports) {
		if (report.choice === 'never' || report.acrossUpdate === 'survives') {
			continue;
		}
		// この PC のターミナルは、版で区切られた常駐が動いているときだけ取り残される。そうでなければ
		// アプリの中の pty host に居て、終了と一緒に終わる。
		if (!report.isRemote && !localIncluded) {
			continue;
		}
		if (report.terminals.length === 0) {
			continue;
		}
		const group = groupFor(report.hostKey, report.hostLabel, report.isRemote);
		for (const terminal of report.terminals) {
			if (!group.ids.has(terminal.id)) {
				group.ids.add(terminal.id);
				group.terminals.push(terminal);
			}
		}
	}

	let localUnlisted = 0;
	if (localIncluded && localDaemon) {
		const listed = groups.get(PARADIS_UPDATE_LOCAL_HOST_KEY)?.terminals.length ?? 0;
		localUnlisted = Math.max(0, (localDaemon.terminalCount ?? 0) - listed);
		if (localUnlisted > 0) {
			groupFor(PARADIS_UPDATE_LOCAL_HOST_KEY, localDaemon.hostLabel, false);
		}
	}

	const result: IParadisUpdateHostGroup[] = [];
	for (const group of groups.values()) {
		const unlistedCount = group.hostKey === PARADIS_UPDATE_LOCAL_HOST_KEY ? localUnlisted : 0;
		if (group.terminals.length + unlistedCount === 0) {
			continue;
		}
		result.push({
			hostKey: group.hostKey,
			hostLabel: group.hostLabel,
			isRemote: group.isRemote,
			terminals: paradisSortUpdateTerminals(group.terminals),
			unlistedCount,
		});
	}
	// 接続先を先に、この PC を最後に。接続先どうしは報告の来た順のまま。
	result.sort((a, b) => Number(!a.isRemote) - Number(!b.isRemote));
	return { groups: result };
}

/** 確認を出すか。終わるものが1つも無ければ、今までどおり確認なしで更新する。 */
export function paradisShouldConfirmUpdate(summary: IParadisUpdateTerminalSummary): boolean {
	return summary.groups.some(group => paradisUpdateGroupCount(group) > 0);
}

/** 答えが無かった（30 秒過ぎた・ウィンドウが答えられなかった）ときは「あとで更新」。 */
export function paradisResolveUpdateConfirmAnswer(answer: ParadisUpdateConfirmAnswer | undefined): ParadisUpdateConfirmAnswer {
	return answer === 'update' ? 'update' : 'later';
}

/** 枠の1行。 */
export type IParadisUpdateHostRow =
	| { readonly kind: 'terminal'; readonly terminal: IParadisUpdateTerminal }
	| {
		readonly kind: 'rest';
		/** まとめた中で先頭のものの名前。名前の無いものだけなら undefined。 */
		readonly firstTitle: string | undefined;
		/** 名前を出したもの以外の数（「ほか N 個」の N）。 */
		readonly otherCount: number;
		/** 待機中のもの（名前の無いものを含む）が混ざっているか。 */
		readonly includesIdle: boolean;
	};

/**
 * 枠に並べる行を決める。
 *
 * 全部で {@link PARADIS_UPDATE_MAX_ROWS} 行に収まれば全部出す。収まらなければ先頭から
 * `maxRows - 1` 行を出し、残りを最後の1行「<名前> ほか N 個」にまとめる。名前の無いもの
 * （閉じたウィンドウから常駐へ残したもの）は常に最後にまとめる。
 */
export function paradisUpdateHostRows(group: IParadisUpdateHostGroup, maxRows: number = PARADIS_UPDATE_MAX_ROWS): IParadisUpdateHostRow[] {
	const limit = Math.max(1, maxRows);
	const total = paradisUpdateGroupCount(group);
	const fitsAll = total <= limit;
	const shownCount = fitsAll ? group.terminals.length : Math.min(group.terminals.length, limit - 1);
	const rows: IParadisUpdateHostRow[] = group.terminals.slice(0, shownCount).map(terminal => ({ kind: 'terminal', terminal }));
	const rest = group.terminals.slice(shownCount);
	if (rest.length === 0 && group.unlistedCount === 0) {
		return rows;
	}
	const first = rest[0];
	rows.push({
		kind: 'rest',
		firstTitle: first !== undefined ? paradisUpdateTerminalLabel(first) : undefined,
		otherCount: rest.length + group.unlistedCount - (first !== undefined ? 1 : 0),
		includesIdle: group.unlistedCount > 0 || rest.some(terminal => paradisUpdateTerminalRank(terminal) === 3),
	});
	return rows;
}

function paradisAgentName(agent: ParadisUpdateTerminalAgent): string {
	return agent === 'claude' ? 'Claude' : 'Codex';
}

/** 行に出す名前。エージェントなら「Claude · <題名>」。 */
export function paradisUpdateTerminalLabel(terminal: IParadisUpdateTerminal): string {
	const title = terminal.title.trim() || localize('paradis.updateTerminals.untitled', "ターミナル");
	return terminal.agent !== undefined ? `${paradisAgentName(terminal.agent)} · ${title}` : title;
}

/** 行の右に付ける札。`tone` は色の種類（作業中は警告色、待っているものは危険色）。 */
export function paradisUpdateTerminalTag(terminal: IParadisUpdateTerminal): { readonly text: string; readonly tone: 'work' | 'ask' | 'plain' } {
	if (terminal.agent !== undefined || terminal.agentState !== undefined) {
		switch (terminal.agentState) {
			case 'working': return { text: localize('paradis.updateTerminals.tag.working', "作業中"), tone: 'work' };
			case 'permission': return { text: localize('paradis.updateTerminals.tag.permission', "許可を待っている"), tone: 'ask' };
			case 'question': return { text: localize('paradis.updateTerminals.tag.question', "返事を待っている"), tone: 'ask' };
			case 'review': return { text: localize('paradis.updateTerminals.tag.review', "確認待ち"), tone: 'plain' };
			default: return { text: localize('paradis.updateTerminals.tag.agentIdle', "待機中"), tone: 'plain' };
		}
	}
	return terminal.busy
		? { text: localize('paradis.updateTerminals.tag.busy', "実行中"), tone: 'plain' }
		: { text: localize('paradis.updateTerminals.tag.idle', "待機中"), tone: 'plain' };
}

// --- 更新による終了かどうか -----------------------------------------------------------------------

/**
 * Ready のまま普通に終了したときに更新が当たるか。
 *
 * macOS は Squirrel が終了時に入れ替える。Windows と Linux は「再起動して更新」を押したときだけ
 * 入れ替わる前提で扱う（Windows は実機で確かめていない）。
 */
export function paradisUpdateAppliesOnQuit(platform: string): boolean {
	return platform === 'darwin';
}

/** {@link paradisUpdateAppliesOnQuit} を、いま動いている OS で。 */
export function paradisUpdateAppliesOnQuitHere(): boolean {
	return paradisUpdateAppliesOnQuit(isMacintosh ? 'darwin' : isWindows ? 'win32' : 'linux');
}

export interface IParadisUpdateQuitInput {
	/** renderer が知っている更新の状態。 */
	readonly stateType: StateType | string;
	readonly appliesOnQuit: boolean;
	/** 「終わらせて更新」で確認済みか（main から合図が来た）。 */
	readonly approved: boolean;
	readonly acrossUpdate: ParadisTerminalsAcrossUpdate;
}

/**
 * この終了で、残すはずのターミナルを終わらせるか。
 *
 * - 「終わらせて更新」を押した後: 更新をまたげる常駐の中のもの以外は終わらせる
 * - 確認を経ていない（Restarting・Ready のまま終了）: 取り残されると分かっているものだけ
 *   終わらせる。分からないときは残す（終わらせた作業は戻らない）
 */
export function paradisUpdateQuitEndsTerminals(input: IParadisUpdateQuitInput): boolean {
	if (input.approved) {
		return input.acrossUpdate !== 'survives';
	}
	const updating = input.stateType === StateType.Restarting || (input.stateType === StateType.Ready && input.appliesOnQuit);
	return updating && input.acrossUpdate === 'stranded';
}

// 「終わらせて更新」の合図。main から届いてから、そのウィンドウの終了処理が読む。
// 閉じるのが取り消されたら消す（取り消した後の普通の終了で、尋ねずに終わらせないため）。
const APPROVAL_LIFETIME_MS = 2 * 60 * 1000;
let approvedAt: number | undefined;

export function paradisMarkUpdateQuitApproved(now: number): void {
	approvedAt = now;
}

export function paradisClearUpdateQuitApproved(): void {
	approvedAt = undefined;
}

export function paradisIsUpdateQuitApproved(now: number): boolean {
	return approvedAt !== undefined && now >= approvedAt && now - approvedAt <= APPROVAL_LIFETIME_MS;
}

// 接続先のターミナルが更新をまたげるか（接続先の常駐の有無）。問い合わせは非同期なので、
// 閉じる処理の最中に聞かずに済むよう、分かった時点でここへ控える。
let remoteAcrossUpdate: ParadisTerminalsAcrossUpdate = 'unknown';

export function paradisSetRemoteTerminalsAcrossUpdate(value: ParadisTerminalsAcrossUpdate): void {
	remoteAcrossUpdate = value;
}

export function paradisGetRemoteTerminalsAcrossUpdate(): ParadisTerminalsAcrossUpdate {
	return remoteAcrossUpdate;
}

/** この PC のターミナルが更新をまたげるか。設定2つから決まる（`paradisPtyHostStarterFactory.ts` と同じ優先順）。 */
export function paradisLocalTerminalsAcrossUpdate(perBuildDaemonEnabled: boolean, acrossUpdatesDaemonEnabled: boolean): ParadisTerminalsAcrossUpdate {
	if (acrossUpdatesDaemonEnabled) {
		return 'survives';
	}
	return perBuildDaemonEnabled ? 'stranded' : 'survives';
}

// --- 更新の準備ができたときのお知らせ ------------------------------------------------------------

export interface IParadisReadyNoticeInput {
	readonly stateType: StateType | string;
	readonly appliesOnQuit: boolean;
	readonly choice: ParadisKeepTerminalsChoice;
	readonly acrossUpdate: ParadisTerminalsAcrossUpdate;
	readonly terminalCount: number;
	/** 用意できた更新の版。分からなければ undefined。 */
	readonly updateVersion: string | undefined;
	/** この接続先について前に知らせた版。 */
	readonly noticedVersion: string | undefined;
}

/**
 * 「次に終了すると更新されます。そのとき…のターミナル N 個は終わります」を出すか。
 *
 * 終了の途中では確認を出せない（出すと、ほかのウィンドウだけ先に閉じる）ので、用意できた時点で
 * 先に知らせておく。同じ版について同じ接続先へは1回だけ。
 */
export function paradisShouldNoticeReadyUpdate(input: IParadisReadyNoticeInput): boolean {
	if (input.stateType !== StateType.Ready || !input.appliesOnQuit) {
		return false;
	}
	if (input.choice === 'never' || input.acrossUpdate !== 'stranded' || !(input.terminalCount > 0)) {
		return false;
	}
	return input.updateVersion === undefined || input.updateVersion !== input.noticedVersion;
}

// --- この PC が残したものだけに絞る ----------------------------------------------------------------

export interface IParadisOrphanCandidate {
	readonly id: number;
	readonly paradisPaneToken?: string;
}

/**
 * 接続先の pty host に残っているもののうち、この PC が残したものだけを選ぶ。
 *
 * 同じ接続先を別の PC も使っていることがある。その PC が残したものは止めない。見分けは、残すときに
 * この PC で控えたペイントークン（`paradisMergeKeptPaneTokens`）で行う。開いているものは別に数えて
 * いるので除く。
 */
export function paradisSelectOwnOrphans<T extends IParadisOrphanCandidate>(processes: readonly T[], ownTokens: ReadonlySet<string>, liveIds: ReadonlySet<number>): T[] {
	return processes.filter(process => !liveIds.has(process.id)
		&& typeof process.paradisPaneToken === 'string'
		&& process.paradisPaneToken.length > 0
		&& ownTokens.has(process.paradisPaneToken));
}

/** 控えるペイントークンの上限。古いものから捨てる。 */
export const PARADIS_KEPT_PANE_TOKENS_LIMIT = 500;

/** 控えてあるペイントークンを読む。壊れていれば空。 */
export function paradisParseKeptPaneTokens(raw: string | undefined): string[] {
	if (raw === undefined) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200) : [];
	} catch {
		return [];
	}
}

/** 控えに足す。重複は後ろ（新しい方）へ寄せ、上限を超えたら古いものから捨てる。 */
export function paradisMergeKeptPaneTokens(existing: readonly string[], added: readonly string[], limit: number = PARADIS_KEPT_PANE_TOKENS_LIMIT): string[] {
	const addedSet = new Set(added);
	const merged = [...existing.filter(token => !addedSet.has(token)), ...addedSet];
	return merged.slice(Math.max(0, merged.length - limit));
}
