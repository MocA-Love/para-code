/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のサービスが画面（一覧・ページ・スマホ）へ見せる形。台帳そのものではなく、Bot ごとにまとめた値。

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
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

export type ParadisBotActivity = 'stopped' | 'idle' | 'working' | 'patrolling';

/** ペインを起動した目的。`chat` は Bot の会話、`patrol` は見回り（PR 12 が使う）。 */
export type ParadisBotPanePurpose = 'chat' | 'patrol';
export const PARADIS_BOT_PANE_PURPOSES: readonly ParadisBotPanePurpose[] = ['chat', 'patrol'];

/** Bot のペイン 1 つの様子（shared process のメモリだけに持つ。ペイントークンは外へ出さない）。 */
export interface IParadisBotPaneState {
	readonly purpose: ParadisBotPanePurpose;
	readonly working: boolean;
	/** そのペインのエージェントが最後に動いた時刻（hook が届いた時刻）。 */
	readonly lastSeenAt: number;
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
	/** 最後に動いた時刻（項目の動き・ペインのエージェントの動き・Bot の作成のうち一番新しいもの）。 */
	readonly lastActivityAt: number;
}

export interface IParadisBotsSnapshot {
	/** Bot・項目・様子のどれかが変わるたびに増える番号。 */
	readonly revision: number;
	/** 台帳が新しい版で書かれていて、この版からは変えられない。 */
	readonly readOnly: boolean;
	readonly bots: readonly IParadisBotSummary[];
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

export function paradisBotSummary(bot: IParadisBot, items: IParadisBotItemsState, panes: readonly IParadisBotPaneState[], now: number, openSuggestions = 0): IParadisBotSummary {
	const counts = paradisBotItemCounts(items, bot.id, now);
	// 読んだ値（知らない欄）は画面へ送らず、読み取り専用の印だけにする
	const { preserved, ...known } = bot;
	return {
		...known,
		...(preserved !== undefined ? { readOnly: true } : {}),
		needsYou: bot.paused ? 0 : counts.needsYou,
		openItems: counts.open,
		openSuggestions,
		activity: paradisBotActivity(bot, panes),
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
	 * 起動のコマンドに足す引数（Codex だけ。Bot の道具の前もっての許可）。利用者の設定ファイルには書かず、この起動に
	 * だけ渡す。起動する側（paradisBotsLaunch.contribution.ts）が `paradisLaunchAgentInWorkspace` の `extraFlags` へ渡す。
	 */
	readonly extraFlags?: string;
}

/** Bot を止める依頼。トークンの値は出さず、ハッシュで渡す。 */
export interface IParadisBotStopRequest {
	readonly botId: string;
	readonly paneHashes: readonly string[];
}

/** 開いている Bot のペインを前に出してほしい（別のウィンドウから開こうとした）。ハッシュで渡す。 */
export interface IParadisBotRevealRequest {
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
	requestLaunch(botId: string, purpose?: ParadisBotPanePurpose): Promise<ParadisBotsServiceResult<IParadisBotLaunch>>;
	/** 起動したターミナルのペイントークンを知らせる。結び付いたら true。 */
	reportLaunch(launchId: string, paneToken: string): Promise<boolean>;
	/** 起動できなかった。 */
	cancelLaunch(launchId: string): Promise<void>;
	requestStop(botId: string): Promise<boolean>;
	/** 別のウィンドウで開いている会話のペインを前に出してもらう（利用者の操作からだけ）。 */
	requestReveal(botId: string): Promise<boolean>;
	/** その Bot のペインのトークンの SHA-256（16 進）。開くときに、このウィンドウにもうあるかを照らす。`purpose` を渡せばその用途だけ。 */
	paneHashesOf(botId: string, purpose?: ParadisBotPanePurpose): Promise<readonly string[]>;

	/** その Bot のまだ決めていない提案（新しい順）。Bot のホームの節にだけ出す。 */
	listSuggestions(botId: string): Promise<readonly IParadisBotSuggestion[]>;
	/** 「始める」。返った提案の `request` を、画面が Bot の会話の入力欄へ未送信で入れる。 */
	startSuggestion(id: string): Promise<ParadisBotsServiceResult<IParadisBotSuggestion>>;
	/** 「見送る」。同じ題を 30 日出さない。 */
	dismissSuggestion(id: string): Promise<ParadisBotsServiceResult<IParadisBotSuggestion>>;
	/** 記憶の整理の前に、記憶のファイルの写しを取る。 */
	snapshotMemory(botId: string): Promise<ParadisBotsServiceResult<{ readonly takenAt: number; readonly files: number }>>;
	/** 記憶の整理を取り消す（一番新しい写しを書き戻す。整理でできたファイルは `added` で知らせ、消さない）。 */
	undoMemoryTidy(botId: string): Promise<ParadisBotsServiceResult<{ readonly restored: readonly string[]; readonly added: readonly string[]; readonly takenAt: number }>>;

	readHomeFile(botId: string, relativePath: string): Promise<ParadisBotsServiceResult<string | undefined>>;
	writeHomeFile(botId: string, relativePath: string, text: string): Promise<ParadisBotsServiceResult<void>>;
}
