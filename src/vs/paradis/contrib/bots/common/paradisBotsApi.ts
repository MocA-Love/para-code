/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のサービスが画面（一覧・ページ・スマホ）へ見せる形。台帳そのものではなく、Bot ごとにまとめた値。

import type { IParadisBotGithubView } from './paradisBotGithub.js';
import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import type { ParadisBotTaskTools } from '../../scheduledRuns/common/paradisScheduledRuns.js';
import type { IParadisAgentChatMessage } from '../../agentChat/common/paradisAgentChat.js';
import { IParadisBotItem, IParadisBotItemOwnerComment, IParadisBotItemsState, ParadisBotItemStatus, paradisBotItemCounts } from './paradisBotItems.js';
import type { IParadisBotSuggestion } from './paradisBotSuggestions.js';
import { IParadisBot, IParadisBotPatch, ParadisBotFaceColor, ParadisBotFaceShape } from './paradisBots.js';

/**
 * Bot の今の様子。
 *
 * - `stopped`: ペインが無い（起動していない・一時停止中）
 * - `idle`: ペインはあるが、エージェントは待っている
 * - `working`: 会話のペインでエージェントが動いている
 * - `patrolling`: 見回り（定期実行）のペインでエージェントが動いている
 */
/**
 * Bot の機能を使えるようにするか（試験中、既定 false）。設定の登録は Bot の一覧の帯の側にあり、ここは id だけを
 * 持つ（帯・Bot の道具・管理の道具が同じ id を読む）。
 */
export const PARADIS_BOTS_ENABLED_SETTING = 'paradis.bots.enabled';

/**
 * 会話のペインのエージェントが、何もしないままこの時間が過ぎたら止める（Orca と同じ 30 分。待機中の CPU とメモリを返す）。
 * 止めた後は「眠っている」になり、話しかけたら同じ会話を続けて起こす（報告書の D1 (a)）。
 */
export const PARADIS_BOT_IDLE_STOP_MS = 30 * 60_000;

export type ParadisBotActivity = 'stopped' | 'idle' | 'working' | 'patrolling';

/** ペインを起動した目的。`chat` は Bot の会話、`patrol` は見回り（PR 12 が使う）。 */
export type ParadisBotPanePurpose = 'chat' | 'patrol';
export const PARADIS_BOT_PANE_PURPOSES: readonly ParadisBotPanePurpose[] = ['chat', 'patrol'];

/**
 * Bot のペインでエージェントが動いていない・止まっている理由（`activity` が待機中のときに、帯とページへ「待機中」の代わりに出す）。
 * - `notFound`: 起動のコマンドが見つからなかった（シェルの終了コード 127）
 * - `exited`: エージェントが終わり、シェルだけが残っている（`exitCode` は分かれば）
 * - `needsUser`: 許可・質問で利用者の答えを待っている、または起動してから hook が 1 つも来ない（初回設定・ログインの画面で止まっている）
 */
export type ParadisBotPaneHalt =
	| { readonly kind: 'notFound' }
	| { readonly kind: 'exited'; readonly exitCode?: number }
	| { readonly kind: 'needsUser' };

/** Bot のペイン 1 つの様子（shared process のメモリだけに持つ。ペイントークンは外へ出さない）。 */
export interface IParadisBotPaneState {
	readonly purpose: ParadisBotPanePurpose;
	readonly working: boolean;
	/** そのペインのエージェントが最後に動いた時刻（hook が届いた時刻）。 */
	readonly lastSeenAt: number;
	/** エージェントが動いていない・止まっている理由（分からなければ無い）。 */
	readonly halt?: ParadisBotPaneHalt;
}

/** 一覧の 1 行に要る値。最後の発言の本文は会話の記録の側（agentChat）から取るので、ここには持たない。 */
export interface IParadisBotSummary extends Omit<IParadisBot, 'preserved'> {
	/** 新しい Para Code が足した欄を持っていて、この版からは変えられない。 */
	readonly readOnly?: true;
	/** 「あなたの番」の件数（Needs you の項目。後回し中と、一時停止中の Bot の分は数えない）。 */
	readonly needsYou: number;
	readonly openItems: number;
	/** まだ決めていない提案の数（Bot のホームの節だけに出す。ベルにも「あなたの番」にも数えない）。 */
	readonly openSuggestions: number;
	readonly activity: ParadisBotActivity;
	/** `activity` が待機中のときの、会話のペインのエージェントが動いていない・止まっている理由（{@link ParadisBotPaneHalt}）。 */
	readonly halt?: ParadisBotPaneHalt;
	/** 最後に動いた時刻（項目の動き・ペインのエージェントの動き・Bot の作成のうち一番新しいもの）。 */
	readonly lastActivityAt: number;
	/**
	 * 眠っている（`activity` が `stopped` で、続けられる前の会話がある）。話しかけたら同じ会話を続けて起こす。
	 * 再起動の後・何もしない 30 分で止めた後・止めた後に付く。
	 */
	readonly sleeping?: true;
}

/** 眠っている Bot の前の会話（{@link IParadisBotsService.sleepingChat}）。 */
export interface IParadisBotSleepingChat {
	readonly agent: 'claude' | 'codex';
	readonly messages: readonly IParadisAgentChatMessage[];
	/** 読んだ範囲より前を落とした。 */
	readonly truncated: boolean;
	/** 会話の記録が見つからない・読めない（話しかければ続きから起きる）。 */
	readonly unreadable?: true;
}

export interface IParadisBotsSnapshot {
	/** Bot・項目・様子のどれかが変わるたびに増える番号。 */
	readonly revision: number;
	/** 台帳が新しい版で書かれていて、この版からは変えられない。 */
	readonly readOnly: boolean;
	readonly bots: readonly IParadisBotSummary[];
	/**
	 * GitHub の見張りの様子（止まっている理由）と、項目に結んだ PR の今の状態（`owner/repo#n` → 状態）。
	 * 見張っていなければ持たない。
	 */
	readonly github?: IParadisBotGithubView;
}

/**
 * 復元・つなぎ直しで戻ったターミナルが、捨てるべき Bot のペインの残りか。Bot のペインを起動するフォルダ（`roots` の下）で
 * 起動したもので、今の Bot の台帳に結び付いていない（窓の再読み込みでつなぎ直したペインは結び付いたまま）もの。
 * Bot のペインは終了時に閉じるが、閉じる前に保存された待避のスペースの一覧や pty の常駐から戻ることがあるので、戻った側でも捨てる。
 * 結び付いているかが分からない（`bound` が undefined。shared process から取れなかった）ときは捨てない（生きた Bot のペインを閉じない側へ倒す）。
 */
export function paradisIsLeftoverBotTerminal(cwd: string | undefined, roots: readonly string[], bound: boolean | undefined, isEqualOrParent: (path: string, parent: string) => boolean): boolean {
	return bound === false && cwd !== undefined && cwd.length > 0 && roots.some(root => root.length > 0 && isEqualOrParent(cwd, root));
}

/**
 * Bot のペインのコマンドの見張りを付けたときに、今の様子として知らせるもの（`finished` が false なら実行中、true なら最後の
 * コマンドの終わり）。知らせるものが無ければ undefined。
 *
 * 実行中かは `executingCommand`（コマンドの文字列）で見る。シェル統合は、プロンプトに戻った後も中身が空の「実行中」の
 * コマンド（`executingCommandObject`）を持ち続けることがあり（実機の zsh で、`claude` が見つからずに終わった後に見た）、
 * それを実行中と読むと、終わったコマンドの終了コードを捨てて「待機中」のままになる。
 * つなぎ直したペイン（`reattached`）は前のコマンドだけが戻ることがあるので、終わりは知らせない。
 */
export function paradisBotCommandStateOnAttach(state: { readonly executingCommand: string | undefined; readonly lastExitCode: number | undefined; readonly hasLast: boolean; readonly reattached: boolean }): { readonly exitCode: number | undefined; readonly finished: boolean } | undefined {
	if (state.executingCommand !== undefined && state.executingCommand.trim().length > 0) {
		return { exitCode: undefined, finished: false };
	}
	if (state.hasLast && !state.reattached) {
		return { exitCode: state.lastExitCode, finished: true };
	}
	return undefined;
}

export function paradisBotActivity(bot: Pick<IParadisBot, 'paused'>, panes: readonly IParadisBotPaneState[]): ParadisBotActivity {
	if (bot.paused || panes.length === 0) {
		return 'stopped';
	}
	if (panes.some(pane => pane.working && pane.purpose === 'chat')) {
		return 'working';
	}
	return panes.some(pane => pane.working) ? 'patrolling' : 'idle';
}

export function paradisBotSummary(bot: IParadisBot, items: IParadisBotItemsState, panes: readonly IParadisBotPaneState[], now: number, openSuggestions = 0, resumable = false): IParadisBotSummary {
	const counts = paradisBotItemCounts(items, bot.id, now);
	// 読んだ値（知らない欄）は画面へ送らず、読み取り専用の印だけにする
	const { preserved, ...known } = bot;
	const activity = paradisBotActivity(bot, panes);
	const halt = activity === 'idle' ? panes.find(pane => pane.purpose === 'chat' && pane.halt !== undefined)?.halt : undefined;
	return {
		...known,
		...(preserved !== undefined ? { readOnly: true } : {}),
		needsYou: bot.paused ? 0 : counts.needsYou,
		openItems: counts.open,
		openSuggestions,
		activity,
		...(halt !== undefined ? { halt } : {}),
		// 会話のペインが無ければ眠っている（見回りのペインが動いていても、会話は眠ったまま）
		...(!panes.some(pane => pane.purpose === 'chat') && !bot.paused && resumable ? { sleeping: true } : {}),
		lastActivityAt: Math.max(bot.createdAt, counts.lastActivityAt, ...panes.map(pane => pane.lastSeenAt)),
	};
}

/** サービスの結果。断った理由は `code`（台帳の関数の code、または `storage`・`not_a_bot`）と英文。 */
export type ParadisBotsServiceResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };

/** ターミナルを起動するのに要るもの（{@link IParadisBotsService.requestLaunch} の結果）。 */
export interface IParadisBotLaunch {
	/** 起動の番号。起動したペインを知らせるときに返す（1 回だけ使える。5 分で切れる）。 */
	readonly launchId: string;
	readonly botId: string;
	readonly purpose: ParadisBotPanePurpose;
	/** Bot の専用フォルダ。ここを cwd にして起動する（常設の指示文と人格メモ・記憶がある）。 */
	readonly cwd: string;
	readonly name: string;
	readonly agent: ParadisAgentKind;
	readonly modelId?: string;
	readonly effortId?: string;
	readonly permissionId?: string;
	/**
	 * 起動のコマンドに足す引数。利用者の設定ファイルには書かず、この起動にだけ渡す。起動する側
	 * （paradisBotsLaunch.contribution.ts）が `paradisLaunchAgentInWorkspace` の `extraFlags` へ渡す。
	 * 会話は引用済みの文字列（Codex だけ。Bot の道具の前もっての許可）。見回りは生の引数の配列で、起動するシェルに
	 * 合わせて引用する（設定ファイルのパスが空白を含みうるため。paradisBotPatrolLaunchArgs）。
	 */
	readonly extraFlags?: string | readonly string[];
	/** 眠った会話を続けて起こす（`extraFlags` に続ける引数が入っている）。 */
	readonly resumed?: true;
	/** 定期実行（会話の 1 ターン）として起こす。値は道具の段。 */
	readonly task?: ParadisBotTaskTools;
}

/** 起動の依頼に添えるもの。 */
export interface IParadisBotLaunchOptions {
	/**
	 * 定期実行（報告書の D6 (a)）として会話を起こす。値は道具の段で、`read`・`web` は制限の引数で起動し、`bot` は会話と
	 * 同じ権限で起動する。会話のペインが開いている・起動中なら断られる（`already_open`・`launching`）。
	 */
	readonly task?: ParadisBotTaskTools;
}

/** Bot を止める依頼。トークンの値は出さず、ハッシュで渡す。 */
export interface IParadisBotStopRequest {
	readonly botId: string;
	readonly paneHashes: readonly string[];
	/**
	 * 何もしない 30 分で止める依頼（利用者の操作ではない）。ウィンドウは、見えている・フォーカスがある・打ちかけの入力が
	 * ある・最近出力のあったペインは止めず、{@link IParadisBotsService.notePaneActive} で「まだ使っている」と返す。
	 */
	readonly idle?: true;
}

/** 開いている Bot のペインを前に出してほしい（別のウィンドウから開こうとした）。ハッシュで渡す。 */
export interface IParadisBotRevealRequest {
	/** 応えるときに {@link IParadisBotsService.ackReveal} へ返す番号。 */
	readonly revealId: string;
	readonly botId: string;
	readonly paneHashes: readonly string[];
}

// ---- ウィンドウ側のサービス ---------------------------------------------------------------------

export const PARADIS_BOTS_CHANNEL = 'paradisBots';

/**
 * ウィンドウが shared process へ登録する窓口（エージェントの管理の道具が `callOwningWindow` で呼ぶ）。
 * 引数は `[呼び出し元のペイントークン, …]`。`start`（Bot のターミナルを裏で起動）、`confirmRemove`（利用者に削除を
 * 確かめる）、`confirmChange`（エージェント・権限・役割の変更を確かめる）。確かめるものは確かめる前に返る。
 */
export const PARADIS_BOTS_WINDOW_CHANNEL = 'paradisBotsWindow';

export type ParadisBotsWindowResult = { readonly ok: true; readonly data: object } | { readonly ok: false; readonly error: string };

export const EMPTY_PARADIS_BOTS_SNAPSHOT: IParadisBotsSnapshot = Object.freeze({ revision: 0, readOnly: false, bots: Object.freeze([]) });

export const IParadisBotsService = createDecorator<IParadisBotsService>('paradisBotsService');

/**
 * ウィンドウ（renderer）から見た Bot のサービス。実体は shared process にあり、ここからできるのは読むこと、
 * 持ち主の操作、起動の依頼と報告だけ。Bot の名義の書き込み（bot_item_* の道具）と、任意のペインを Bot に
 * 結び付けることはできない。shared process に届かなかったときは code `unavailable` で返る。
 */
export interface IParadisBotsService {
	readonly _serviceBrand: undefined;

	/** 今の一覧（Bot ごとの「あなたの番」の件数・様子・最後に動いた時刻）。 */
	readonly snapshot: IParadisBotsSnapshot;
	readonly onDidChange: Event<void>;
	/**
	 * Bot を止めてほしい（どのウィンドウからの依頼も全ウィンドウへ届く）。`paneHashes` はその Bot のペインのトークンの
	 * SHA-256（16 進）。自分の生きたペインのトークンをハッシュにして照らし、合ったターミナルを閉じる。
	 */
	readonly onDidRequestStop: Event<IParadisBotStopRequest>;
	/**
	 * 別のウィンドウでその Bot を開こうとして断られた（会話は 1 つだけ）。そのペインを持つウィンドウが、ペインのスペースへ
	 * 切り替えて前に出す。
	 */
	readonly onDidRequestReveal: Event<IParadisBotRevealRequest>;

	createBot(input: { readonly name: string; readonly agent: ParadisAgentKind; readonly modelId?: string; readonly effortId?: string; readonly permissionId?: string; readonly faceColor?: ParadisBotFaceColor; readonly faceShape?: ParadisBotFaceShape }, soul?: string): Promise<ParadisBotsServiceResult<IParadisBot>>;
	updateBot(botId: string, patch: IParadisBotPatch): Promise<ParadisBotsServiceResult<IParadisBot>>;
	removeBot(botId: string): Promise<ParadisBotsServiceResult<IParadisBot>>;

	listItems(filter?: { readonly botId?: string; readonly open?: boolean }): Promise<readonly IParadisBotItem[]>;
	getItem(uid: string): Promise<IParadisBotItem | undefined>;
	ownerComment(uid: string, input: IParadisBotItemOwnerComment): Promise<ParadisBotsServiceResult<IParadisBotItem>>;
	ownerSetStatus(uid: string, to: ParadisBotItemStatus, note?: string): Promise<ParadisBotsServiceResult<IParadisBotItem>>;
	ownerSnooze(uid: string, until: number | undefined): Promise<ParadisBotsServiceResult<IParadisBotItem>>;

	/** 起動の依頼。返ったフォルダを cwd にエージェントを起動し、{@link reportLaunch} でペインを知らせる。 */
	requestLaunch(botId: string, purpose?: ParadisBotPanePurpose, options?: IParadisBotLaunchOptions): Promise<ParadisBotsServiceResult<IParadisBotLaunch>>;
	/** 起動したターミナルのペイントークンを知らせる。結び付いたら true。 */
	reportLaunch(launchId: string, paneToken: string): Promise<boolean>;
	/** 起動できなかった。 */
	cancelLaunch(launchId: string): Promise<void>;
	/** Bot のペインを起動するフォルダの親（会話の専用フォルダの親と、見回りのフォルダの親）。 */
	paneFolderRoots(): Promise<readonly string[]>;
	/** 今 Bot に結び付いているペインのトークンの SHA-256（全部の Bot。保存しただけでまだ現れていないものは含めない）。取れなければ undefined。 */
	boundPaneHashes(): Promise<readonly string[] | undefined>;
	/**
	 * Bot のペインのシェルでコマンドが始まった（`exitCode` が無い）か終わった（終了コード）。エージェントが見つからない・
	 * 終わったことは hook では分からないので、ウィンドウがシェル統合から知らせる。Bot のペインでなければ何もしない。
	 */
	notePaneCommand(paneToken: string, exitCode: number | undefined, finished: boolean): Promise<void>;
	/**
	 * Bot の会話のペインを利用者がまだ使っている（見えていた・入力した・出力があった）。何もしない 30 分の数え直しを、ここから
	 * 始める。Bot のペインでなければ何もしない。
	 */
	notePaneActive(paneToken: string): Promise<void>;
	/**
	 * Bot のペインを閉じた（ウィンドウを再読み込みする前に、隠したペインを閉じる）。シェルの終わりの知らせ（TerminalExit）は
	 * 再読み込みの間に届かないことがあるので、ウィンドウから先に結び付けを外す。会話の控えは残るので「眠っています」になる。
	 */
	releasePane(paneToken: string): Promise<void>;
	requestStop(botId: string): Promise<boolean>;
	/**
	 * 別のウィンドウで開いている会話のペインを前に出してもらう（利用者の操作からだけ）。どのウィンドウも 2 秒以内に
	 * 応えなければ、その会話のペインを「まだ現れていない」に戻して false（呼んだ側は起動へ進める）。
	 */
	requestReveal(botId: string): Promise<boolean>;
	/** 前に出す依頼に、そのペインを持つウィンドウが応える。 */
	ackReveal(revealId: string): Promise<void>;
	/** その Bot のペインのトークンの SHA-256（16 進）。開くときに、このウィンドウにもうあるかを照らす。`purpose` を渡せばその用途だけ。 */
	paneHashesOf(botId: string, purpose?: ParadisBotPanePurpose): Promise<readonly string[]>;
	/**
	 * 眠っている Bot の前の会話を、エージェントを起こさずに会話の記録のファイルから読む（読むだけの吹き出しに出す）。
	 * 続けられる会話が無ければ undefined。
	 */
	sleepingChat(botId: string): Promise<IParadisBotSleepingChat | undefined>;

	/** その Bot のまだ決めていない提案（新しい順）。Bot のホームの節にだけ出す。 */
	listSuggestions(botId: string): Promise<readonly IParadisBotSuggestion[]>;
	/** 「始める」。返った提案の `request` を、画面が Bot の会話の入力欄へ未送信で入れる。台帳は変えない。 */
	startSuggestion(id: string): Promise<ParadisBotsServiceResult<IParadisBotSuggestion>>;
	/** 画面が提案の文を入力欄へ入れ終えた。提案を「始めた」にする。 */
	markSuggestionStarted(id: string): Promise<ParadisBotsServiceResult<IParadisBotSuggestion>>;
	/** 「見送る」。同じ題を 30 日出さない。 */
	dismissSuggestion(id: string): Promise<ParadisBotsServiceResult<IParadisBotSuggestion>>;
	/**
	 * 記憶の整理の前に、記憶のファイルの写しを取る（`kind: 'manual'`。会話の起動ごとの自動の写しでは押し出されない）。
	 * `partial` なら上限で打ち切り、`total` 件のうち `files` 件だけを写した。
	 */
	snapshotMemory(botId: string): Promise<ParadisBotsServiceResult<{ readonly takenAt: number; readonly files: number; readonly total: number; readonly partial: boolean; readonly kind: 'auto' | 'manual' }>>;
	/**
	 * 記憶の写しの一覧（新しい順。時刻・写したファイルの数・記憶のファイルの数・一部だけか・種類）。`auto` は会話を起動する
	 * たびに本体が取る写し、`manual` は {@link snapshotMemory} で取った写し。種類ごとに 5 件までで、古いものから消える。
	 */
	listMemorySnapshots(botId: string): Promise<ParadisBotsServiceResult<readonly { readonly takenAt: number; readonly files: number; readonly total: number; readonly partial: boolean; readonly kind: 'auto' | 'manual' }[]>>;
	/**
	 * 記憶の整理を取り消す。{@link listMemorySnapshots} から選んだ写し（`takenAt`）を書き戻す。その写しが無い（消えた・
	 * 古すぎる）なら `not_found`。整理でできたファイルは `added` で知らせ、消さない。書き戻すのは `MEMORY.md` と
	 * `memory/` の直下だけ。写しにほかのパスがあれば `skipped` で知らせる。
	 */
	undoMemoryTidy(botId: string, takenAt: number): Promise<ParadisBotsServiceResult<{ readonly restored: readonly string[]; readonly added: readonly string[]; readonly takenAt: number; readonly skipped: readonly string[] }>>;

	readHomeFile(botId: string, relativePath: string): Promise<ParadisBotsServiceResult<string | undefined>>;
	writeHomeFile(botId: string, relativePath: string, text: string): Promise<ParadisBotsServiceResult<void>>;
	/**
	 * 同梱のテンプレートのスキルを専用フォルダに置き（Claude Code と Codex の両方の置き場）、人格メモにスキルの節を足す。
	 * 渡すのはテンプレートの id だけ（中身は shared process が同梱のカタログから引く）。置いたスキルの名前を返す。
	 */
	installTemplateSkill(botId: string, templateId: string): Promise<ParadisBotsServiceResult<string>>;
}
