/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「どのペインがどの Bot か」の表。shared process のメモリに持ち、アプリを起動し直しても結び付けを戻せるよう、
// ペイントークンのハッシュ（SHA-256）だけを `<userData>/paradis/bots/panes.json` に保存する。トークンの値は書かない。
// ペイントークンは復元をまたいで同じ値に戻る（paradisPaneTokenService.ts が shellIntegrationNonce から作り直す）ので、
// 起動し直した後に同じトークンのペインが hook か道具の呼び出しで現れたら、保存したハッシュと照らして結び付けを戻す。
//
// 表に書けるのは起動の経路だけにする。Bot のサービスが起動の番号（launchId）を発行し、ウィンドウが
// 起動したターミナルのペイントークンをその番号付きで報告したときだけ結び付く。発行していない番号、
// 2 回目の報告、もう別の Bot に結び付いているトークンは断る。Bot の道具（bot_item_*）は引数で Bot を
// 受けず、この表から引くので、ほかのペインのエージェントが Bot を名乗って項目を書くことはできない。

import { createHash } from 'crypto';
import { isPlainRecord } from '../../../common/paradisGuards.js';
import { paradisNormalizeAgentHookEvent } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisBotPaneState, PARADIS_BOT_PANE_PURPOSES, ParadisBotPaneHalt, ParadisBotPanePurpose } from '../common/paradisBotsApi.js';
import { IParadisBotBoardPaneRecord, IParadisBotBoardTaskRecord, paradisParseBotBoardOrigins } from './paradisBotBoardOrigins.js';

/** 起動の番号が有効な時間。起動に失敗して報告が来なかった番号を残さない。 */
export const PARADIS_BOT_LAUNCH_TTL_MS = 5 * 60_000;

/**
 * 発行して報告がまだの会話の起動を「起動中」と数える時間。2 つのウィンドウから同時に開いたとき 1 つにするためで、
 * 起動に失敗して取り消しも来なかった番号が、その Bot をいつまでも開けなくしないよう短くする。
 */
export const PARADIS_BOT_LAUNCHING_TTL_MS = 2 * 60_000;

/**
 * 起動してから hook が 1 つも来ないまま、この時間が過ぎたら「操作が要ります」にする（Claude Code の初回設定・ログイン・
 * フォルダの信頼の画面で止まっている）。Claude Code は起動するとすぐ SessionStart を出すので、普通に待っている会話は
 * これにかからない。起動の直後に hook を出さないエージェント（Codex など）では見ない。
 */
export const PARADIS_BOT_SETUP_STALL_MS = 30_000;

/** 起動してすぐ hook を出すので、hook が来ないことを「止まっている」と読めるエージェント。 */
const AGENTS_WITH_START_HOOK: ReadonlySet<string> = new Set(['claude']);

/** 保存する結び付けの上限（古いものから落とす）。 */
export const PARADIS_BOT_REMEMBERED_PANES_LIMIT = 200;

/** 保存する結び付け 1 件。トークンの値は持たない。 */
export interface IParadisBotPaneRecord {
	/** ペイントークンの SHA-256（16 進 64 字）。 */
	readonly hash: string;
	readonly botId: string;
	readonly purpose: ParadisBotPanePurpose;
	readonly boundAt: number;
}

export interface IParadisBotPanesState {
	readonly version: number;
	readonly panes: readonly IParadisBotPaneRecord[];
	/** Bot がタスクボードへ載せたタスク（paradisBotBoardOrigins.ts）。 */
	readonly boardTasks?: readonly IParadisBotBoardTaskRecord[];
	/** Bot が載せたタスクのためにボードが動かしたペイン（ターミナルの id。paradisBotBoardOrigins.ts）。 */
	readonly boardPanes?: readonly IParadisBotBoardPaneRecord[];
}

export const PARADIS_BOT_PANES_VERSION = 1;
export const EMPTY_PARADIS_BOT_PANES_STATE: IParadisBotPanesState = Object.freeze({ version: PARADIS_BOT_PANES_VERSION, panes: Object.freeze([]) });

export function paradisBotPaneTokenHash(paneToken: string): string {
	return createHash('sha256').update(paneToken).digest('hex');
}

/** 保存した結び付けを読む。全体の形が違えば undefined（退避される）、1 件だけ違えばその 1 件を捨てる。 */
export function paradisParseBotPanesState(value: unknown): IParadisBotPanesState | undefined {
	if (!isPlainRecord(value) || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || !Array.isArray(value.panes)) {
		return undefined;
	}
	if (value.version > PARADIS_BOT_PANES_VERSION) {
		// 新しい版は読まずに書き込みだけ断る（結び付けは戻らないが、ファイルは残る）
		return { version: value.version, panes: [] };
	}
	const panes: IParadisBotPaneRecord[] = [];
	for (const entry of value.panes.slice(-PARADIS_BOT_REMEMBERED_PANES_LIMIT)) {
		if (isPlainRecord(entry) && typeof entry.hash === 'string' && /^[0-9a-f]{64}$/.test(entry.hash) && typeof entry.botId === 'string' && entry.botId.length > 0
			&& PARADIS_BOT_PANE_PURPOSES.some(purpose => purpose === entry.purpose) && typeof entry.boundAt === 'number' && Number.isFinite(entry.boundAt)) {
			panes.push({ hash: entry.hash, botId: entry.botId, purpose: entry.purpose as ParadisBotPanePurpose, boundAt: entry.boundAt });
		}
	}
	const { boardTasks, boardPanes } = paradisParseBotBoardOrigins(value.boardTasks, value.boardPanes);
	return { version: PARADIS_BOT_PANES_VERSION, panes, ...(boardTasks.length > 0 ? { boardTasks } : {}), ...(boardPanes.length > 0 ? { boardPanes } : {}) };
}

interface IPending {
	readonly botId: string;
	readonly purpose: ParadisBotPanePurpose;
	readonly issuedAt: number;
	readonly agent?: string;
}

interface IPane {
	readonly botId: string;
	readonly purpose: ParadisBotPanePurpose;
	working: boolean;
	lastSeenAt: number;
	/** 結び付けた時刻（シェルでコマンドを起動し直したらその時刻）。 */
	boundAt: number;
	/** 起動したエージェント（分からなければ無い。初回設定で止まっているかを見るのに使う）。 */
	readonly agent?: string;
	/** hook を 1 つでも受けた。 */
	hookSeen: boolean;
	/** 許可・質問で利用者の答えを待っている。 */
	asking: boolean;
	/** エージェントが見つからなかった・終わった（シェルのコマンドの終わりか SessionEnd で付け、次のコマンドか動いた hook で外す）。 */
	ended?: ParadisBotPaneHalt;
}

function newPane(botId: string, purpose: ParadisBotPanePurpose, now: number, agent?: string): IPane {
	return { botId, purpose, working: false, lastSeenAt: now, boundAt: now, ...(agent !== undefined ? { agent } : {}), hookSeen: false, asking: false };
}

/** ペインの止まっている理由（{@link ParadisBotPaneHalt}）。動いている・分からないときは undefined。 */
function haltOf(pane: IPane, now: number): ParadisBotPaneHalt | undefined {
	if (pane.working) {
		return undefined;
	}
	if (pane.ended !== undefined) {
		return pane.ended;
	}
	if (pane.asking) {
		return { kind: 'needsUser' };
	}
	if (!pane.hookSeen && pane.agent !== undefined && AGENTS_WITH_START_HOOK.has(pane.agent) && now - pane.boundAt >= PARADIS_BOT_SETUP_STALL_MS) {
		return { kind: 'needsUser' };
	}
	return undefined;
}

export class ParadisBotPanes {

	private readonly pending = new Map<string, IPending>();
	private readonly panes = new Map<string, IPane>();
	/** 保存した結び付け（ハッシュ → Bot）。生きているかは分からないので、現れるまで {@link statesOf} に数えない。 */
	private readonly remembered = new Map<string, IParadisBotPaneRecord>();
	/**
	 * 会話として数えるのをやめたが、まだ閉じたと分かっていないペイン（トークン → Bot の id）。前に出す依頼にどのウィンドウも
	 * 応えなかったときと、起動し直した後に同じ Bot の会話がもう別のペインにあったときに入る。会話・Bot の道具・様子には
	 * 数えないが、Bot の制限（{@link restrictedBotOf}）は本物の終了（{@link release}）まで残す（生きていれば制限の外で
	 * 動き続けないように）。
	 */
	private readonly detached = new Map<string, string>();

	/** @param onDidChangeRemembered 保存する結び付けが変わった（保存し直す）。 */
	constructor(private readonly onDidChangeRemembered: () => void = () => { }) { }

	/** 保存した結び付けを読み込む（起動時に 1 回）。 */
	loadRemembered(records: readonly IParadisBotPaneRecord[]): void {
		this.remembered.clear();
		for (const record of records) {
			this.remembered.set(record.hash, record);
		}
	}

	/** 保存する結び付け（古い順）。 */
	rememberedPanes(): IParadisBotPaneRecord[] {
		return [...this.remembered.values()];
	}

	/**
	 * 起動し直した後に現れたペイン。保存した結び付けがあり、その Bot がまだあれば結び付けを戻して Bot の id を返す。
	 * もう結び付いているペインは今の Bot の id を返す。
	 */
	restore(paneToken: string, botExists: (botId: string) => boolean, now: number): string | undefined {
		const bound = this.panes.get(paneToken)?.botId;
		if (bound !== undefined || paneToken.length === 0 || this.detached.has(paneToken)) {
			return bound;
		}
		const record = this.remembered.get(paradisBotPaneTokenHash(paneToken));
		if (record === undefined || !botExists(record.botId)) {
			return undefined;
		}
		// その Bot に別の会話のペインがもう結び付いていれば会話として戻さない（会話を 2 つ結び付けない）。
		// 古いペインは生きているので、制限だけは残す
		if (record.purpose === 'chat' && [...this.panes.values()].some(pane => pane.botId === record.botId && pane.purpose === 'chat')) {
			this.detached.set(paneToken, record.botId);
			return undefined;
		}
		// 戻したペインは hook で現れたもの（エージェントが動いている）
		const pane = newPane(record.botId, record.purpose, now);
		pane.hookSeen = true;
		this.panes.set(paneToken, pane);
		return record.botId;
	}

	private forget(predicate: (record: IParadisBotPaneRecord) => boolean): void {
		let changed = false;
		for (const [hash, record] of this.remembered) {
			if (predicate(record)) {
				this.remembered.delete(hash);
				changed = true;
			}
		}
		if (changed) {
			this.onDidChangeRemembered();
		}
	}

	/** 起動の番号を控える（番号はサービスが作る）。 */
	issue(launchId: string, botId: string, purpose: ParadisBotPanePurpose, now: number, agent?: string): void {
		for (const [id, entry] of this.pending) {
			if (now - entry.issuedAt > PARADIS_BOT_LAUNCH_TTL_MS) {
				this.pending.delete(id);
			}
		}
		this.pending.set(launchId, { botId, purpose, issuedAt: now, ...(agent !== undefined ? { agent } : {}) });
	}

	/** 起動の報告。結び付けたら Bot の id、断ったら undefined。番号は 1 回で使い切る。 */
	report(launchId: string, paneToken: string, now: number): string | undefined {
		const entry = this.pending.get(launchId);
		if (entry === undefined) {
			return undefined;
		}
		this.pending.delete(launchId);
		const hash = paneToken.length > 0 ? paradisBotPaneTokenHash(paneToken) : '';
		// 保存した結び付けで別の Bot のものになっているトークンも断る（起動し直した後、まだ現れていないペイン）
		const remembered = this.remembered.get(hash);
		if (now - entry.issuedAt > PARADIS_BOT_LAUNCH_TTL_MS || paneToken.length === 0 || this.panes.has(paneToken) || (remembered !== undefined && remembered.botId !== entry.botId)) {
			return undefined;
		}
		// 「起動中」の期限（2 分）を過ぎてから遅れて届いた会話の報告は、その間に別のウィンドウで開いた会話があれば断る
		// （断られたウィンドウはそのターミナルを閉じる。会話を 2 つにしない）
		if (entry.purpose === 'chat' && [...this.panes.values()].some(pane => pane.botId === entry.botId && pane.purpose === 'chat')) {
			return undefined;
		}
		this.panes.set(paneToken, newPane(entry.botId, entry.purpose, now, entry.agent));
		this.remembered.delete(hash);
		this.remembered.set(hash, { hash, botId: entry.botId, purpose: entry.purpose, boundAt: now });
		while (this.remembered.size > PARADIS_BOT_REMEMBERED_PANES_LIMIT) {
			this.remembered.delete(this.remembered.keys().next().value!);
		}
		this.onDidChangeRemembered();
		return entry.botId;
	}

	/** 起動をやめた（失敗した）番号を捨てる。 */
	cancel(launchId: string): boolean {
		return this.pending.delete(launchId);
	}

	/**
	 * その Bot の会話が使われているか。数えるのは、現れたペイン（報告・hook・道具の呼び出しで確かめたもの）と、
	 * 発行して報告がまだの会話の起動（{@link PARADIS_BOT_LAUNCHING_TTL_MS} の間）だけ。起動し直した後でまだ現れていない
	 * 保存した結び付けは数えない（閉じたことが伝わらなかった古いペインで、その Bot を開けなくしないため）。見回りは数えない。
	 */
	chatInUse(botId: string, now: number): { readonly state: 'open'; readonly tokens: readonly string[] } | { readonly state: 'launching' } | undefined {
		const tokens = [...this.panes].filter(([, pane]) => pane.botId === botId && pane.purpose === 'chat').map(([token]) => token);
		if (tokens.length > 0) {
			return { state: 'open', tokens };
		}
		return [...this.pending.values()].some(entry => entry.botId === botId && entry.purpose === 'chat' && now - entry.issuedAt <= PARADIS_BOT_LAUNCHING_TTL_MS) ? { state: 'launching' } : undefined;
	}

	/**
	 * その Bot の見回りが、起動の途中（発行して報告がまだ。{@link PARADIS_BOT_LAUNCHING_TTL_MS} の間）か、動いている
	 * ペインがあるか。見回りは Bot ごとに 1 つのフォルダを起動のたびに空にして使うので、2 つ目を起動しない。
	 * 動いていない（終わった）見回りのペインは数えない（次の回の前に閉じる）。
	 */
	patrolInUse(botId: string, now: number): 'working' | 'launching' | undefined {
		if ([...this.panes.values()].some(pane => pane.botId === botId && pane.purpose === 'patrol' && pane.working)) {
			return 'working';
		}
		return [...this.pending.values()].some(entry => entry.botId === botId && entry.purpose === 'patrol' && now - entry.issuedAt <= PARADIS_BOT_LAUNCHING_TTL_MS) ? 'launching' : undefined;
	}

	/**
	 * その Bot の会話のペインを会話として数えるのをやめる（前に出す依頼にどのウィンドウも応えなかった）。応えが無いだけでは
	 * 閉じたと言えないので、結び付けは外さず {@link detached} へ移す（Bot の制限は本物の終了まで残る）。
	 */
	detachChat(botId: string): boolean {
		let changed = false;
		for (const [token, pane] of this.panes) {
			if (pane.botId === botId && pane.purpose === 'chat') {
				this.panes.delete(token);
				this.detached.set(token, botId);
				changed = true;
			}
		}
		return changed;
	}

	/** 結び付いているペインのトークン（全部の Bot。会話として数えるのをやめたペインも含む）。 */
	boundTokens(): string[] {
		return [...this.panes.keys(), ...this.detached.keys()];
	}

	botOf(paneToken: string): string | undefined {
		return this.panes.get(paneToken)?.botId;
	}

	/** Bot の制限を掛けるペインなら、その Bot の id（結び付いたペインと、会話として数えるのをやめたペイン）。 */
	restrictedBotOf(paneToken: string): string | undefined {
		return this.panes.get(paneToken)?.botId ?? this.detached.get(paneToken);
	}

	/** その Bot の、会話として数えるのをやめたペインのトークン（止める依頼で一緒に閉じる）。 */
	detachedTokensOf(botId: string): string[] {
		return [...this.detached].filter(([, owner]) => owner === botId).map(([token]) => token);
	}

	/** そのペインの用途（会話か見回りか）。Bot のペインでなければ undefined。 */
	purposeOf(paneToken: string): ParadisBotPanePurpose | undefined {
		return this.panes.get(paneToken)?.purpose;
	}

	statesOf(botId: string, now = Number.MAX_SAFE_INTEGER): IParadisBotPaneState[] {
		return [...this.panes.values()].filter(pane => pane.botId === botId).map(pane => {
			const halt = haltOf(pane, now);
			return { purpose: pane.purpose, working: pane.working, lastSeenAt: pane.lastSeenAt, ...(halt !== undefined ? { halt } : {}) };
		});
	}

	/**
	 * ペインのシェルでコマンドが始まった・終わった（ウィンドウがシェル統合から知らせる）。終わったら、終了コードが 127 なら
	 * 「見つからない」、それ以外は「終わった」にする。始まったら外す（利用者がシェルでエージェントを起動し直した）。
	 * Bot のペインで、様子が変わったら Bot の id。
	 */
	noteCommand(paneToken: string, exitCode: number | undefined, finished: boolean, now: number): string | undefined {
		const pane = this.panes.get(paneToken);
		if (pane === undefined) {
			return undefined;
		}
		const before = JSON.stringify(haltOf(pane, now));
		if (finished) {
			pane.ended = exitCode === 127 ? { kind: 'notFound' } : { kind: 'exited', ...(exitCode !== undefined ? { exitCode } : {}) };
			pane.working = false;
			pane.asking = false;
		} else if (pane.ended !== undefined) {
			// 終わった後にシェルで起動し直した。そのエージェントの hook を待ち直す（初回設定で止まっているかを、ここから数える）。
			// 終わっていないときは戻さない（見張りを付けたときの「実行中」が、もう届いた SessionStart の後に来ることがある）
			pane.ended = undefined;
			pane.hookSeen = false;
			pane.boundAt = now;
		}
		return JSON.stringify(haltOf(pane, now)) !== before ? pane.botId : undefined;
	}

	/** その Bot のペインのトークン。`purpose` を渡せばその用途だけ、`idle` が true なら動いていないものだけ。 */
	tokensOf(botId: string, filter: { readonly purpose?: ParadisBotPanePurpose; readonly idle?: boolean } = {}): string[] {
		return [...this.panes]
			.filter(([, pane]) => pane.botId === botId && (filter.purpose === undefined || pane.purpose === filter.purpose) && (filter.idle !== true || !pane.working))
			.map(([token]) => token);
	}

	/** ペインが閉じた。結び付けがあれば Bot の id。まだ現れていない（戻していない）保存した結び付けも忘れる。 */
	release(paneToken: string): string | undefined {
		const botId = this.panes.get(paneToken)?.botId ?? this.detached.get(paneToken);
		this.panes.delete(paneToken);
		this.detached.delete(paneToken);
		const hash = paradisBotPaneTokenHash(paneToken);
		this.forget(record => record.hash === hash);
		return botId;
	}

	/** Bot を消した・止めた。そのペインの結び付けと、使っていない番号を全部外す。 */
	releaseBot(botId: string): boolean {
		let changed = false;
		for (const [token, pane] of this.panes) {
			if (pane.botId === botId) {
				this.panes.delete(token);
				changed = true;
			}
		}
		for (const [id, entry] of this.pending) {
			if (entry.botId === botId) {
				this.pending.delete(id);
			}
		}
		for (const [token, owner] of this.detached) {
			if (owner === botId) {
				this.detached.delete(token);
				changed = true;
			}
		}
		this.forget(record => record.botId === botId);
		return changed;
	}

	/**
	 * hook を 1 つ見る。Bot のペインのものなら、その Bot の id と、様子（動いている・待っている）が変わったか。
	 * hook の名前は CLI ごとに違うので、ペインの状態と同じ正規化（paradisNormalizeAgentHookEvent）を通す。
	 * 許可待ち・質問中・完了は「待っている」、知らない hook は様子を変えない。
	 */
	noteHook(paneToken: string, event: string, now: number): { readonly botId: string; readonly changed: boolean } | undefined {
		const pane = this.panes.get(paneToken);
		if (pane === undefined) {
			return undefined;
		}
		pane.lastSeenAt = now;
		const before = JSON.stringify(haltOf(pane, now));
		const status = paradisNormalizeAgentHookEvent(event);
		const working = status === undefined ? pane.working : status === 'working';
		const changed = working !== pane.working;
		pane.working = working;
		pane.hookSeen = true;
		if (status === 'permission') {
			pane.asking = true;
		} else if (status !== undefined) {
			pane.asking = false;
		}
		if (event === 'SessionEnd') {
			// エージェントの会話が終わった（/exit など）。シェルのコマンドの終わりが来れば終了コードで上書きされる
			pane.ended = { kind: 'exited' };
		} else if (status === 'working' || event === 'SessionStart') {
			pane.ended = undefined;
		}
		return { botId: pane.botId, changed: changed || JSON.stringify(haltOf(pane, now)) !== before };
	}
}
