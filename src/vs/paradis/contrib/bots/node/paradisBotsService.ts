/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の台帳のサービス（shared process）。Bot の一覧と作業項目を持ち、保存し、変わったら知らせる。
//
// - Bot の書き込み（bot_item_* の道具）と持ち主の書き込み（画面）の両方がここを通る。書き込みは 1 つずつ順に
//   行い、保存できなかったら元の中身へ戻して断る。
// - 「Needs you」の項目は、「聞く・答える」の台帳（humanAsk）へ丸ごと知らせ直す（{@link syncAsks}）。
//   あちらはメモリだけの索引なので、起動時と変更のたびに今の待ちを全部送る。答えが来たら持ち主のコメント
//   として項目に書き、作業中へ戻す。
// - どのペインがどの Bot かは {@link ParadisBotPanes} が持つ。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisHumanAskAnswerRequest, paradisHumanAskKey, paradisSanitizeHumanAskInput } from '../../humanAsk/common/paradisHumanAsk.js';
import { ParadisHumanAskService } from '../../humanAsk/node/paradisHumanAskChannel.js';
import { PARADIS_BOTS_ASK_OWNER, paradisBotAnswerComment, paradisBotAskId, paradisBotAskInput, paradisBotItemMailText, paradisParseBotAskId } from '../common/paradisBotAsk.js';
import {
	EMPTY_PARADIS_BOT_ITEMS_STATE,
	IParadisBotItem,
	IParadisBotItemChanges,
	IParadisBotItemOwnerComment,
	IParadisBotItemsState,
	PARADIS_BOT_ITEMS_BYTE_LIMIT,
	PARADIS_BOT_ITEMS_VERSION,
	ParadisBotItemsResult,
	ParadisBotItemStatus,
	paradisBotItemAdd,
	paradisBotItemLinkBoardTask,
	paradisBotItemNoteBoardStep,
	paradisBotItemOwnerComment,
	paradisBotItemOwnerSnooze,
	paradisBotItemOwnerStatus,
	paradisBotItemsMarkDelivered,
	paradisBotItemsOf,
	paradisBotItemsPendingMail,
	paradisBotItemsToStored,
	paradisBotItemsRemoveBot,
	paradisBotItemUndelivered,
	paradisBotItemUpdate,
	paradisBotItemWaitsForOwner,
	paradisIsBotItemSnoozed,
} from '../common/paradisBotItems.js';
import { EMPTY_PARADIS_BOTS_STATE, IParadisBot, IParadisBotCreateInput, IParadisBotPatch, IParadisBotsState, PARADIS_BOTS_VERSION, paradisBotCreate, paradisBotRemove, paradisBotUpdate } from '../common/paradisBots.js';
import { IParadisBotGithubView, PARADIS_BOT_GITHUB_OFF_VIEW } from '../common/paradisBotGithub.js';
import { IParadisBotLaunch, IParadisBotRevealRequest, IParadisBotsSnapshot, IParadisBotStopRequest, ParadisBotPanePurpose, ParadisBotsServiceResult, paradisBotSummary } from '../common/paradisBotsApi.js';
import { IParadisBotItemAddArgs, paradisBotLaunchApprovalFlags, paradisBotPatrolLaunchArgs, ParadisBotPatrolLaunchContext, paradisBotPatrolSupported, paradisBotPatrolTemplateRefusal } from '../common/paradisBotTools.js';
import { PARADIS_READ_ONLY_MCP_TOOL_NAMES } from '../../agentBrowser/common/paradisMcpReadOnlyTools.js';
import { ParadisBotPatrolGateState } from '../../scheduledRuns/common/paradisScheduledRunBotPatrol.js';
import { EMPTY_PARADIS_BOT_SUGGESTIONS_STATE, IParadisBotSuggestion, PARADIS_BOT_SUGGESTIONS_VERSION, IParadisBotSuggestionsState, paradisBotOpenSuggestions, paradisBotSuggestionAdd, paradisBotSuggestionDismiss, paradisBotSuggestionsRemoveBot, paradisBotSuggestionsRunEnded, paradisBotSuggestionStart } from '../common/paradisBotSuggestions.js';
import { ParadisBotHomeError, ParadisBotHomes } from './paradisBotHomes.js';
import { IParadisBotMemorySnapshot, IParadisBotMemoryUndo, ParadisBotMemorySnapshots } from './paradisBotMemorySnapshots.js';
import { IParadisBotPanesState, PARADIS_BOT_PANES_VERSION, ParadisBotPanes, paradisBotPaneTokenHash } from './paradisBotPanes.js';
import { IParadisBotsJsonFile, IParadisBotsLoaded } from './paradisBotsStore.js';

/** 連続した変更をまとめてから知らせる間隔。 */
const CHANGE_DELAY = 50;

/** 新しい Bot のフォルダを取り直す回数の上限。 */
const CREATE_FOLDER_ATTEMPTS = 5;

/** Bot へ渡す、持ち主の書き込み 1 項目ぶん。 */
export interface IParadisBotMail {
	readonly uid: string;
	readonly number: number;
	readonly eventIds: readonly number[];
	/** ペインへ送る文（持ち主の言葉は囲いの中）。 */
	readonly text: string;
}

export interface IParadisBotsServiceOptions {
	readonly now?: () => number;
	readonly uuid?: () => string;
	/** shared process の hook のバス。Bot のペインの様子（動いている・待っている）を追う。 */
	readonly hookEvents?: Event<{ readonly token: string; readonly event: string }>;
	/** ペインとの結び付けの保存先（トークンのハッシュだけ）。渡さなければ結び付けはメモリだけ。 */
	readonly panesFile?: IParadisBotsJsonFile<IParadisBotPanesState>;
	/** 専用フォルダの読み書き。渡さなければフォルダを作らず、起動の依頼とファイルの口は `unavailable` で断る。 */
	readonly homes?: ParadisBotHomes;
	/** 提案の台帳。渡さなければ提案は空で、見回りの提案は `unavailable` で断る。 */
	readonly suggestionsFile?: IParadisBotsJsonFile<IParadisBotSuggestionsState>;
	/** 記憶の整理の写し。渡さなければ整理の写しと取り消しは `unavailable` で断る。 */
	readonly memorySnapshots?: ParadisBotMemorySnapshots;
	/**
	 * Bot の機能（試験中の設定 `paradis.bots.enabled`）がオンか。オフのあいだは「聞く・答える」の台帳へ問いを
	 * 出さない（出していた分は取り下げる）。変わったら {@link ParadisBotsService.refresh} を呼ぶ。既定はオン。
	 */
	readonly enabled?: () => boolean;
	/** 項目の台帳の大きさの上限（テストで小さくする）。既定は {@link PARADIS_BOT_ITEMS_BYTE_LIMIT}。 */
	readonly itemsByteLimit?: number;
	/** 前に出す依頼にウィンドウが応えるのを待つ時間。既定は {@link PARADIS_BOT_REVEAL_TIMEOUT_MS}。 */
	readonly revealTimeoutMs?: number;
	/**
	 * 見回りの起動のたびに、読むだけに制限するのに要るもの（Claude Code の設定ファイル・Codex の止める MCP サーバー）を
	 * 用意する（paradisBotPatrolLaunch.ts）。用意できなければ断る理由（英文）。渡さなければ見回りは `unavailable` で断る。
	 */
	readonly preparePatrol?: (agent: 'claude' | 'codex', botId: string) => Promise<ParadisBotPatrolLaunchContext | string>;
	/** そのエージェントの起動の雛形（利用者の設定 `paradis.workspaceSwitch.agents` を反映した `command`）。 */
	readonly agentCommand?: (agentId: string) => string | undefined;
}

/** 前に出す依頼にウィンドウが応えるのを待つ時間。 */
export const PARADIS_BOT_REVEAL_TIMEOUT_MS = 2_000;

const ITEMS_FULL_MESSAGE = 'Para Code\'s list of bot items is full. Close the items you no longer need (status "done" or "canceled"), or ask your owner to close or remove some items; then you can write again.';

type Result<T> = ParadisBotsServiceResult<T>;

/** Bot の機能（`paradis.bots.enabled`）がオフの間に、フォルダを作る・書く・起動する口を断る結果。道具と画面にそのまま出せる。 */
const BOTS_DISABLED = { ok: false, code: 'disabled', message: 'Para Code bots are turned off. Turn on the bot setting (paradis.bots.enabled) first.' } as const;

export class ParadisBotsService extends Disposable {

	private bots: IParadisBotsState = EMPTY_PARADIS_BOTS_STATE;
	private githubView: IParadisBotGithubView = PARADIS_BOT_GITHUB_OFF_VIEW;
	private items: IParadisBotItemsState = EMPTY_PARADIS_BOT_ITEMS_STATE;
	private revision = 0;
	private loaded = false;
	private panesVersion = PARADIS_BOT_PANES_VERSION;

	protected readonly panes = new ParadisBotPanes(() => this.savePanes());
	private readonly now: () => number;
	private readonly uuid: () => string;
	private readonly homes: ParadisBotHomes | undefined;
	private readonly panesFile: IParadisBotsJsonFile<IParadisBotPanesState> | undefined;
	private readonly suggestionsFile: IParadisBotsJsonFile<IParadisBotSuggestionsState> | undefined;
	private readonly memorySnapshots: ParadisBotMemorySnapshots | undefined;
	private suggestions: IParadisBotSuggestionsState = EMPTY_PARADIS_BOT_SUGGESTIONS_STATE;
	private readonly itemsByteLimit: number;
	private readonly revealTimeoutMs: number;
	/** 前に出す依頼の番号 → ウィンドウが応えたときに呼ぶもの。 */
	private readonly pendingReveals = new Map<string, () => void>();
	private readonly enabled: () => boolean;
	private readonly preparePatrol: IParadisBotsServiceOptions['preparePatrol'];
	private readonly agentCommand: IParadisBotsServiceOptions['agentCommand'];

	/** 読み込みが終わった（壊れたファイルの退避も済んだ）。 */
	readonly ready: Promise<void>;
	private queue: Promise<unknown> = Promise.resolve();

	private readonly _onDidChange = this._register(new Emitter<IParadisBotsSnapshot>());
	/** Bot・項目・Bot の様子のどれかが変わった（少しまとめてから出す）。 */
	readonly onDidChange: Event<IParadisBotsSnapshot> = this._onDidChange.event;

	private readonly _onDidQueueMail = this._register(new Emitter<{ readonly botId: string; readonly uid: string }>());
	/** 持ち主が項目に書いた。Bot へ届ける役（後の PR）が {@link pendingMail} を読んで届ける。 */
	readonly onDidQueueMail: Event<{ readonly botId: string; readonly uid: string }> = this._onDidQueueMail.event;

	private readonly _onDidRequestStop = this._register(new Emitter<IParadisBotStopRequest>());
	/** Bot を止めてほしい。そのターミナルを持つウィンドウが閉じる（閉じると結び付けが外れる）。 */
	readonly onDidRequestStop: Event<IParadisBotStopRequest> = this._onDidRequestStop.event;

	private readonly _onDidRemoveBot = this._register(new Emitter<string>());
	/** Bot を台帳から外した（定期実行の見回りの定義を消すのに使う）。 */
	readonly onDidRemoveBot: Event<string> = this._onDidRemoveBot.event;

	private readonly _onDidRequestReveal = this._register(new Emitter<IParadisBotRevealRequest>());
	/** 開いている Bot のペインを前に出してほしい（別のウィンドウから開こうとして断った）。 */
	readonly onDidRequestReveal: Event<IParadisBotRevealRequest> = this._onDidRequestReveal.event;

	private readonly changeScheduler = this._register(new RunOnceScheduler(() => this._onDidChange.fire(this.getSnapshot()), CHANGE_DELAY));
	/** 後回しの期限が来たら、件数と「あなたの番」を数え直す。 */
	private readonly wakeScheduler = this._register(new RunOnceScheduler(() => this.changed(), 0));

	constructor(
		private readonly botsFile: IParadisBotsJsonFile<IParadisBotsState>,
		private readonly itemsFile: IParadisBotsJsonFile<IParadisBotItemsState>,
		private readonly humanAsk: ParadisHumanAskService,
		private readonly logService: ILogService,
		options: IParadisBotsServiceOptions = {},
	) {
		super();
		this.now = options.now ?? Date.now;
		this.uuid = options.uuid ?? generateUuid;
		this.homes = options.homes;
		this.panesFile = options.panesFile;
		this.suggestionsFile = options.suggestionsFile;
		this.memorySnapshots = options.memorySnapshots;
		this.itemsByteLimit = options.itemsByteLimit ?? PARADIS_BOT_ITEMS_BYTE_LIMIT;
		this.revealTimeoutMs = options.revealTimeoutMs ?? PARADIS_BOT_REVEAL_TIMEOUT_MS;
		this.enabled = options.enabled ?? (() => true);
		this.preparePatrol = options.preparePatrol;
		this.agentCommand = options.agentCommand;
		this._register(this.humanAsk.onDidRequestAnswer(request => this.onAnswerRequest(request)));
		if (options.hookEvents) {
			this._register(options.hookEvents(event => {
				// ペインのシェルが終わった（ウィンドウが shared process へ知らせ、hook のバスに流れる）。結び付けを外す
				if (event.event === 'TerminalExit') {
					this.releasePane(event.token);
					return;
				}
				// 起動し直した後に現れた Bot のペインなら、保存した結び付けを戻す
				const restored = this.restorePane(event.token);
				if (this.panes.noteHook(event.token, event.event, this.now())?.changed || restored) {
					this.notify();
				}
			}));
		}
		this.ready = this.load();
	}

	private async load(): Promise<void> {
		try {
			const [bots, items, panes, suggestions] = await Promise.all([this.botsFile.read(), this.itemsFile.read(), this.readPanes(), this.readSuggestions()]);
			for (const quarantined of [bots.quarantined, items.quarantined, panes?.quarantined, suggestions?.quarantined]) {
				if (quarantined !== undefined) {
					this.logService.error(`[ParadisBots] a saved file could not be read; it was moved to ${quarantined} and the list starts empty`);
				}
			}
			this.bots = bots.state;
			this.items = items.state;
			this.suggestions = suggestions?.state ?? EMPTY_PARADIS_BOT_SUGGESTIONS_STATE;
			// 消した Bot の結び付けは戻さない
			this.panes.loadRemembered((panes?.state.panes ?? []).filter(record => this.getBot(record.botId) !== undefined));
			this.panesVersion = panes?.state.version ?? PARADIS_BOT_PANES_VERSION;
		} catch (error) {
			// 読めなかったときは空で動かすが、上書きはしない（次の起動で読めるかもしれない）
			this.logService.error('[ParadisBots] could not read the saved bots; they are read-only until the next start', error);
			this.bots = { ...EMPTY_PARADIS_BOTS_STATE, version: PARADIS_BOTS_VERSION + 1 };
			this.items = { ...EMPTY_PARADIS_BOT_ITEMS_STATE, version: PARADIS_BOT_ITEMS_VERSION + 1 };
		}
		this.loaded = true;
		if (!this._store.isDisposed) {
			this.changed();
		}
	}

	// ---- 読む -----------------------------------------------------------------------------------

	getSnapshot(): IParadisBotsSnapshot {
		const now = this.now();
		return {
			revision: this.revision,
			readOnly: this.bots.version !== PARADIS_BOTS_VERSION || this.items.version !== PARADIS_BOT_ITEMS_VERSION,
			bots: this.bots.bots.map(bot => paradisBotSummary(bot, this.items, this.panes.statesOf(bot.id), now, paradisBotOpenSuggestions(this.suggestions, bot.id).length)),
			...(this.githubView.status.state !== 'off' ? { github: this.githubView } : {}),
		};
	}

	/** GitHub の見張りの様子が変わった（見張りだけが呼ぶ）。画面へ知らせる。 */
	setGithubView(view: IParadisBotGithubView): void {
		this.githubView = view;
		this.notify();
	}

	/** 見張る Bot（GitHub の入り切りがオンで一時停止していない）の開いている項目に結んだ PR（`owner/repo#n`、重なりなし）。 */
	githubPullRequestRefs(): string[] {
		const watching = new Set(this.bots.bots.filter(bot => bot.watchGithub === true && !bot.paused).map(bot => bot.id));
		return [...new Set(paradisBotItemsOf(this.items, { open: true }).filter(item => watching.has(item.botId)).flatMap(item => item.links.filter(link => link.kind === 'pr').map(link => link.ref)))];
	}

	/** 台帳の Bot（知らない欄を持つものも含む）。 */
	listBots(): readonly IParadisBot[] {
		return this.bots.bots;
	}

	getBot(botId: string): IParadisBot | undefined {
		return this.bots.bots.find(bot => bot.id === botId);
	}

	listItems(filter: { readonly botId?: string; readonly open?: boolean } = {}): IParadisBotItem[] {
		return paradisBotItemsOf(this.items, filter);
	}

	getItem(uid: string): IParadisBotItem | undefined {
		return this.items.items.find(item => item.uid === uid);
	}

	/** そのペインの用途（会話か見回りか）。Bot のペインでなければ undefined。 */
	purposeOfPane(paneToken: string): ParadisBotPanePurpose | undefined {
		return this.panes.purposeOf(paneToken);
	}

	/** そのペインの Bot（Bot のペインでなければ undefined）。起動し直した後に初めて現れたペインは、保存した結び付けを戻す。 */
	botOfPane(paneToken: string): IParadisBot | undefined {
		if (this.restorePane(paneToken)) {
			this.notify();
		}
		const botId = this.panes.botOf(paneToken);
		return botId !== undefined ? this.getBot(botId) : undefined;
	}

	/** 保存した結び付けを戻した（このペインが今 Bot になった）か。 */
	private restorePane(paneToken: string): boolean {
		if (!this.loaded || this.panes.botOf(paneToken) !== undefined) {
			return false;
		}
		return this.panes.restore(paneToken, botId => this.getBot(botId) !== undefined, this.now()) !== undefined;
	}

	/** 提案の台帳を読む。読めなくても Bot と項目の読み込みは止めず、提案だけをこの起動の間は読むだけにする。 */
	private async readSuggestions(): Promise<IParadisBotsLoaded<IParadisBotSuggestionsState> | undefined> {
		try {
			return await this.suggestionsFile?.read();
		} catch (error) {
			this.logService.error('[ParadisBots] could not read the saved suggestions; they are read-only until the next start', error);
			return { state: { ...EMPTY_PARADIS_BOT_SUGGESTIONS_STATE, version: PARADIS_BOT_SUGGESTIONS_VERSION + 1 } };
		}
	}

	private async readPanes(): Promise<IParadisBotsLoaded<IParadisBotPanesState> | undefined> {
		try {
			return await this.panesFile?.read();
		} catch (error) {
			// 結び付けが戻らないだけなので、Bot と項目の読み込みは止めない
			this.logService.warn('[ParadisBots] could not read the saved bot panes', error);
			return undefined;
		}
	}

	/** 保存する結び付け（トークンのハッシュ）を書き直す。書けなくても結び付けはメモリにあるので、記録だけする。 */
	private savePanes(): void {
		if (!this.loaded || this.panesFile === undefined || this.panesVersion !== PARADIS_BOT_PANES_VERSION) {
			return;
		}
		this.panesFile.write({ version: PARADIS_BOT_PANES_VERSION, panes: this.panes.rememberedPanes() }).catch(error => {
			this.logService.warn('[ParadisBots] could not save the bot panes', error);
		});
	}

	/** 項目の台帳に書けるか（新しい版の台帳なら false。届けた印も外せない）。 */
	itemsWritable(): boolean {
		return this.items.version === PARADIS_BOT_ITEMS_VERSION;
	}

	/** 設定（Bot の機能のオン・オフ）が変わった。「聞く・答える」の台帳へ出す問いを数え直す。 */
	refresh(): void {
		this.changed();
	}

	/** Bot へまだ届けていない、持ち主の書き込み。 */
	pendingMail(botId: string): IParadisBotMail[] {
		const mail: IParadisBotMail[] = [];
		for (const { item, events } of paradisBotItemsPendingMail(this.items, botId)) {
			const text = paradisBotItemMailText(item, events);
			if (text !== undefined) {
				mail.push({ uid: item.uid, number: item.number, eventIds: events.map(event => event.id), text });
			}
		}
		return mail;
	}

	// ---- Bot の一覧（持ち主が書く） --------------------------------------------------------------

	/** @param soul 人格メモの種（テンプレートから作るとき）。 */
	createBot(input: Omit<IParadisBotCreateInput, 'id' | 'takenFolders'>, soul?: string): Promise<Result<IParadisBot>> {
		return this.write(async () => {
			// Bot の機能がオフの間は、専用フォルダも作らない
			if (!this.enabled()) {
				return BOTS_DISABLED;
			}
			// ディスクにもうあるフォルダは予約しない（消した Bot のフォルダを引き継がない）
			const takenFolders = await this.homes?.existingFolders() ?? [];
			const id = this.uuid();
			// フォルダは保存の前に整える。読んだ後に他人のフォルダができていた（not_owner）ら、その名前も使用中に
			// 数えて取り直す（保存してから断られると、起動できない Bot が残る）
			for (let attempt = 0; ; attempt++) {
				const result = paradisBotCreate(this.bots, { ...input, id, takenFolders }, this.now());
				if (!result.ok) {
					return result;
				}
				try {
					await this.homes?.ensure(result.bot, soul);
				} catch (error) {
					if (error instanceof ParadisBotHomeError && error.code === 'not_owner') {
						if (attempt < CREATE_FOLDER_ATTEMPTS - 1) {
							takenFolders.push(result.bot.folder);
							continue;
						}
						return { ok: false, code: 'not_owner', message: 'Para Code could not find a free home folder for the bot.' };
					}
					// ほかの失敗は、起動のときにもう一度整えるので作成は通す
					this.logService.warn('[ParadisBots] could not prepare the home folder of a new bot', error);
				}
				return this.saveBots(result.state, result.bot);
			}
		});
	}

	updateBot(botId: string, patch: IParadisBotPatch): Promise<Result<IParadisBot>> {
		return this.write(async () => {
			const result = paradisBotUpdate(this.bots, botId, patch, this.now());
			return result.ok ? this.saveBots(result.state, result.bot) : result;
		});
	}

	/** 台帳から外し、その項目と結び付けも外す。専用フォルダは消さない。動いているペインには止める依頼を出す。 */
	removeBot(botId: string): Promise<Result<IParadisBot>> {
		return this.write(async () => {
			const result = paradisBotRemove(this.bots, botId);
			if (!result.ok) {
				return result;
			}
			// Bot を先に消す（項目を先に消すと、Bot の保存に失敗したときに項目だけが消える）。項目の保存に失敗しても、
			// 持ち主のいない項目は一覧にも「あなたの番」にも出ない
			const removed = await this.saveBots(result.state, result.bot);
			this._onDidRemoveBot.fire(botId);
			this._onDidRequestStop.fire({ botId, paneHashes: this.paneHashesOf(botId) });
			this.panes.releaseBot(botId);
			await this.saveItems(paradisBotItemsRemoveBot(this.items, botId), undefined);
			await this.saveSuggestions(paradisBotSuggestionsRemoveBot(this.suggestions, botId)).catch(error => this.logService.warn('[ParadisBots] could not remove the suggestions of a removed bot', error));
			// 記憶の整理の写し（専用フォルダの外）も消す。専用フォルダは残す
			await this.memorySnapshots?.remove(result.bot).catch(error => this.logService.warn('[ParadisBots] could not remove the memory copies of a removed bot', error));
			return removed;
		});
	}

	// ---- 項目（持ち主が書く） --------------------------------------------------------------------

	/** Bot のページからのコメント。待っている問いへの答えになったら、「聞く・答える」の台帳でも回答済みにする。 */
	ownerComment(uid: string, input: IParadisBotItemOwnerComment): Promise<Result<IParadisBotItem>> {
		return this.write(() => {
			const before = this.getItem(uid);
			const result = paradisBotItemOwnerComment(this.items, uid, input, this.now());
			const answered = result.ok && before?.ask !== undefined && result.item.ask === undefined ? paradisHumanAskKey('bot', paradisBotAskId(uid, before.ask.eventId)) : undefined;
			// 待ちの一覧の知らせ直しより先に回答済みにする（後だと「取り下げ」と出る）
			return this.applyOwner(result, answered !== undefined ? () => this.humanAsk.resolve(PARADIS_BOTS_ASK_OWNER, answered, { surface: 'bot', ...(input.text.trim() ? { summary: input.text } : {}) }) : undefined);
		});
	}

	ownerSetStatus(uid: string, to: ParadisBotItemStatus, note?: string): Promise<Result<IParadisBotItem>> {
		return this.write(() => this.applyOwner(paradisBotItemOwnerStatus(this.items, uid, to, note, this.now())));
	}

	/** 後回しにする・解く（`until` が undefined）。Bot には知らせない。 */
	ownerSnooze(uid: string, until: number | undefined): Promise<Result<IParadisBotItem>> {
		return this.write(() => this.apply(paradisBotItemOwnerSnooze(this.items, uid, until, this.now())));
	}

	/** Bot へ届けた分の印を外す。 */
	markMailDelivered(uid: string, eventIds: readonly number[]): Promise<Result<void>> {
		return this.write(() => this.saveItems(paradisBotItemsMarkDelivered(this.items, uid, eventIds), undefined));
	}

	// ---- 項目（Bot が書く。道具の提供元だけが呼ぶ） ------------------------------------------------

	botAddItem(botId: string, input: IParadisBotItemAddArgs): Promise<Result<IParadisBotItem>> {
		return this.write(async () => {
			const result = paradisBotItemAdd(this.items, { ...input, uid: this.uuid(), botId }, this.now());
			return result.ok && this.tooLarge(result.state) ? { ok: false, code: 'limit', message: ITEMS_FULL_MESSAGE } : this.apply(result);
		});
	}

	/** 台帳が大きさの上限を超えるか（保存と同じ形で数える）。 */
	private tooLarge(state: IParadisBotItemsState): boolean {
		return Buffer.byteLength(JSON.stringify(paradisBotItemsToStored(state), undefined, '\t'), 'utf8') > this.itemsByteLimit;
	}

	botUpdateItem(botId: string, number: number, changes: IParadisBotItemChanges): Promise<Result<IParadisBotItem>> {
		return this.write(async () => {
			const result = paradisBotItemUpdate(this.items, botId, number, changes, this.now());
			const bot = this.getBot(botId);
			// 問いは「聞く・答える」の台帳の形でも通るかを、確定する前に確かめる。あちらは上限を超えた 1 件を
			// 断るので、確かめずに書くと「Needs you なのにどこにも出ない」項目ができる
			if (result.ok && bot !== undefined && result.item.ask !== undefined && paradisSanitizeHumanAskInput(paradisBotAskInput(bot, result.item)) === undefined) {
				return { ok: false, code: 'invalid_argument', message: 'Para Code could not show this question to your owner. Shorten the questions and the options, then set "needs_you" again.' };
			}
			// 上限を超えても、項目を閉じる書き込みは通す（閉じないと減らす手が無い）
			const closing = changes.status === 'done' || changes.status === 'canceled';
			if (result.ok && !closing && this.tooLarge(result.state)) {
				return { ok: false, code: 'limit', message: ITEMS_FULL_MESSAGE };
			}
			return this.apply(result);
		});
	}

	/** Bot が自分の項目を読んだ。読んだ分は届いたものとして印を外す（ペインへ届ける前に自分で読むこともあるため）。 */
	botReadItem(botId: string, number: number): Promise<Result<IParadisBotItem>> {
		return this.write(async () => {
			const item = this.items.items.find(candidate => candidate.number === number);
			if (item === undefined || item.botId !== botId) {
				return { ok: false, code: item === undefined ? 'not_found' : 'not_owner', message: item === undefined ? `There is no item #${number}.` : `Item #${number} belongs to another bot.` };
			}
			const pending = paradisBotItemUndelivered(item).map(event => event.id);
			if (pending.length > 0) {
				// 印を外せなくても読むことは通す（次に読んだときにもう一度出るだけ）
				await this.saveItems(paradisBotItemsMarkDelivered(this.items, item.uid, pending), undefined);
			}
			return { ok: true, value: item };
		});
	}

	// ---- タスクボードとの行き来（Para Code が書く） ----------------------------------------------------

	/** Bot が自分の項目からボードへ載せたタスクを項目に結ぶ。ボードへ載せた道具だけが呼ぶ。 */
	linkBoardTask(botId: string, uid: string, taskId: string): Promise<Result<IParadisBotItem>> {
		return this.write(async () => this.apply(paradisBotItemLinkBoardTask(this.items, botId, uid, taskId, this.now())));
	}

	/**
	 * ボードのエージェントの工程の終わりの報告を、そのタスクを結んだ項目へ写す（`launchId` は `<タスクの id>:<試行番号>`）。
	 * Bot の機能がオフ・写す先が無いときは何もしない。
	 */
	async noteBoardStep(launchId: string, summary: string): Promise<void> {
		const at = launchId.lastIndexOf(':');
		if (!this.enabled() || at <= 0) {
			return;
		}
		const taskId = launchId.slice(0, at);
		await this.write<IParadisBotItem | undefined>(async () => {
			const result = paradisBotItemNoteBoardStep(this.items, taskId, launchId, summary, this.now());
			return result === undefined ? { ok: true, value: undefined } : this.apply(result);
		});
	}

	// ---- ペインとの結び付け ----------------------------------------------------------------------

	/**
	 * 起動の依頼。専用フォルダを整え（指示文の生成の範囲を今の版にする）、起動の番号を発行して、ターミナルを
	 * 起動するのに要るものを返す。呼んだウィンドウがそのフォルダを cwd にエージェントを起動し、
	 * {@link reportLaunch} でペインを知らせる（起動できなければ {@link cancelLaunch}）。
	 */
	requestLaunch(botId: string, purpose: ParadisBotPanePurpose): Promise<Result<IParadisBotLaunch>> {
		return this.write(async () => {
			// Bot の機能がオフの間は、フォルダを整えず、起動の番号も出さない
			if (!this.enabled()) {
				return BOTS_DISABLED;
			}
			const bot = this.getBot(botId);
			if (bot === undefined || bot.paused) {
				return { ok: false, code: bot === undefined ? 'not_found' : 'paused', message: bot === undefined ? 'There is no such bot.' : 'The bot is paused.' };
			}
			if (bot.preserved !== undefined) {
				// 新しい版が足した設定（権限など）を、この版は分からないまま起動しない
				return { ok: false, code: 'read_only', message: 'This bot was changed by a newer Para Code, so this version does not start it.' };
			}
			// 会話は 1 つの Bot に 1 つだけ（2 つのエージェントが同じ記憶と項目を書かないように）。この口は書き込みの列で
			// 1 つずつ走るので、2 つのウィンドウから同時に開いても、先に発行した番号が「起動中」になって 2 つ目は断る。
			// 見回りは別のペインなので、会話があっても断らない
			if (purpose === 'chat') {
				const inUse = this.panes.chatInUse(botId, this.now());
				if (inUse?.state === 'open') {
					return { ok: false, code: 'already_open', message: 'This bot is already open in another window.' };
				}
				if (inUse?.state === 'launching') {
					return { ok: false, code: 'launching', message: 'This bot is starting in another window.' };
				}
			}
			if (this.homes === undefined) {
				return { ok: false, code: 'unavailable', message: 'Bot home folders are not available.' };
			}
			// 見回りは、読むだけに制限できるエージェントのときだけ起動する（機能がオフなら上で断っている）
			let patrolArgs: readonly string[] | undefined;
			if (purpose === 'patrol') {
				const agent = bot.agent;
				if (!paradisBotPatrolSupported(agent)) {
					return { ok: false, code: 'unsupported', message: 'Para Code cannot limit this agent to reading, so it does not start a look-around with it.' };
				}
				const command = this.agentCommand?.(agent);
				const forbidden = command !== undefined ? paradisBotPatrolTemplateRefusal(agent, command) : undefined;
				if (forbidden !== undefined) {
					return { ok: false, code: 'unsafe_template', message: `The command template for this agent contains ${forbidden}, which can lift the read-only limits, so Para Code does not start a look-around with it.` };
				}
				const context = this.preparePatrol === undefined ? 'Para Code cannot prepare the read-only settings here.' : await this.preparePatrol(agent, bot.id);
				if (typeof context === 'string') {
					return { ok: false, code: 'patrol_unavailable', message: context };
				}
				patrolArgs = paradisBotPatrolLaunchArgs(context, PARADIS_READ_ONLY_MCP_TOOL_NAMES);
			}
			let cwd: string;
			try {
				cwd = await this.homes.ensure(bot);
			} catch (error) {
				this.logService.warn('[ParadisBots] could not prepare the home folder', error);
				return { ok: false, code: error instanceof ParadisBotHomeError ? error.code : 'storage', message: error instanceof ParadisBotHomeError ? error.message : 'Para Code could not prepare the bot\'s home folder.' };
			}
			const launchId = this.issueLaunch(botId, purpose);
			const extraFlags = purpose === 'patrol' ? patrolArgs : paradisBotLaunchApprovalFlags(bot.agent);
			if (launchId === undefined) {
				return { ok: false, code: 'not_found', message: 'There is no such bot.' };
			}
			return {
				ok: true,
				value: {
					launchId, botId, purpose, cwd, name: bot.name, agent: bot.agent,
					...(bot.modelId !== undefined ? { modelId: bot.modelId } : {}),
					...(bot.effortId !== undefined ? { effortId: bot.effortId } : {}),
					// 見回りは Bot の権限の設定を使わない（読むだけの引数だけで起動する）
					...(bot.permissionId !== undefined && purpose !== 'patrol' ? { permissionId: bot.permissionId } : {}),
					...(extraFlags !== undefined ? { extraFlags } : {}),
				},
			};
		});
	}

	/**
	 * 会話のペインを持つウィンドウへ、前に出してほしいと頼む（別のウィンドウから開こうとして `already_open` で断られた
	 * ときに、利用者の操作からだけ呼ぶ。エージェントの道具からの起動では呼ばない＝フォーカスを奪わない）。
	 * 現れた会話のペインが無ければ false。
	 */
	async requestReveal(botId: string): Promise<boolean> {
		const inUse = this.panes.chatInUse(botId, this.now());
		if (inUse?.state !== 'open') {
			return false;
		}
		const revealId = this.uuid();
		const answered = await new Promise<boolean>(resolve => {
			const timer = setTimeout(() => {
				this.pendingReveals.delete(revealId);
				resolve(false);
			}, this.revealTimeoutMs);
			this.pendingReveals.set(revealId, () => {
				clearTimeout(timer);
				this.pendingReveals.delete(revealId);
				resolve(true);
			});
			this._onDidRequestReveal.fire({ revealId, botId, paneHashes: inUse.tokens.map(paradisBotPaneTokenHash) });
		});
		// どのウィンドウもそのペインを持っていなかった（閉じたことが伝わらなかった）。会話のペインを「まだ現れていない」に
		// 戻し、呼んだ側が起動へ進めるようにする（本当に生きていれば、hook か道具の呼び出しで現れたときに戻る）
		if (!answered && this.panes.detachChat(botId)) {
			this.notify();
		}
		return answered;
	}

	/** 前に出す依頼に、そのペインを持つウィンドウが応えた。 */
	ackReveal(revealId: string): void {
		this.pendingReveals.get(revealId)?.();
	}


	/** Bot を止める依頼を全ウィンドウへ出す。結び付いた・保存したペインが無ければ false。 */
	requestStop(botId: string): boolean {
		// 起動し直した後でまだ現れていないペインも止める（保存した結び付けのハッシュも渡す）
		const paneHashes = this.paneHashesOf(botId);
		if (paneHashes.length === 0) {
			return false;
		}
		this._onDidRequestStop.fire({ botId, paneHashes });
		return true;
	}

	/** その Bot のペインのトークンの SHA-256（結び付いているものと、保存してまだ現れていないもの）。`purpose` を渡せばその用途だけ。 */
	paneHashesOf(botId: string, purpose?: ParadisBotPanePurpose): string[] {
		return [...new Set([
			...this.panes.tokensOf(botId, { purpose }).map(paradisBotPaneTokenHash),
			...this.panes.rememberedPanes().filter(record => record.botId === botId && (purpose === undefined || record.purpose === purpose)).map(record => record.hash),
		])];
	}

	// ---- 定期実行の見回りの門（定期実行のサービスが呼ぶ） -------------------------------------------

	/**
	 * 定期実行から見回りを走らせてよいか。台帳を読み終える前は undefined。Bot の機能がオフ・Bot が無い・一時停止・
	 * 読むだけに制限できないエージェント・前の見回りのエージェントがまだ動いている、のどれかならその答え。
	 */
	patrolGateState(botId: string): ParadisBotPatrolGateState | undefined {
		if (!this.loaded) {
			return undefined;
		}
		if (!this.enabled()) {
			return 'off';
		}
		const bot = this.getBot(botId);
		if (bot === undefined) {
			return 'missing';
		}
		if (bot.paused) {
			return 'paused';
		}
		if (bot.preserved !== undefined || this.homes === undefined || !paradisBotPatrolSupported(bot.agent)) {
			return 'unsupported';
		}
		return this.panes.statesOf(botId).some(pane => pane.purpose === 'patrol' && pane.working) ? 'busy' : 'ok';
	}

	/**
	 * 前の回の見回りのペインのうち、もう動いていないものを閉じる依頼を全ウィンドウへ出す（会話のペインは閉じない）。
	 * 起動し直した後でまだ結び付いていない（hook が来ていない）見回りのペインも、保存したハッシュで閉じる。
	 */
	closeIdlePatrolPanes(botId: string): void {
		const idle = new Set(this.panes.tokensOf(botId, { purpose: 'patrol', idle: true }));
		const working = new Set(this.panes.tokensOf(botId, { purpose: 'patrol' }).filter(token => !idle.has(token)).map(paradisBotPaneTokenHash));
		const paneHashes = this.paneHashesOf(botId, 'patrol').filter(hash => !working.has(hash));
		if (paneHashes.length > 0) {
			this._onDidRequestStop.fire({ botId, paneHashes });
		}
	}

	/** 専用フォルダの中のファイルを読む（人格メモ・記憶など。相対パスだけ）。無ければ `value` は undefined。 */
	readHomeFile(botId: string, relative: unknown): Promise<Result<string | undefined>> {
		return this.homeFile(botId, (homes, bot) => homes.read(bot, relative));
	}

	/** 専用フォルダの中のファイルを書く（相対パスだけ。フォルダの外・持ち主の印は断る）。 */
	writeHomeFile(botId: string, relative: unknown, text: string): Promise<Result<void>> {
		if (!this.enabled()) {
			return Promise.resolve(BOTS_DISABLED);
		}
		return this.homeFile(botId, (homes, bot) => homes.write(bot, relative, text));
	}

	private async homeFile<T>(botId: string, operation: (homes: ParadisBotHomes, bot: IParadisBot) => Promise<T>): Promise<Result<T>> {
		await this.ready;
		const bot = this.getBot(botId);
		if (bot === undefined || this.homes === undefined) {
			return { ok: false, code: bot === undefined ? 'not_found' : 'unavailable', message: bot === undefined ? 'There is no such bot.' : 'Bot home folders are not available.' };
		}
		try {
			return { ok: true, value: await operation(this.homes, bot) };
		} catch (error) {
			if (error instanceof ParadisBotHomeError) {
				return { ok: false, code: error.code, message: error.message };
			}
			this.logService.warn('[ParadisBots] a home file could not be read or written', error);
			return { ok: false, code: 'storage', message: 'Para Code could not read or write the file.' };
		}
	}

	/** 起動の番号を発行する。ウィンドウはこの番号を付けて {@link reportLaunch} する。 */
	issueLaunch(botId: string, purpose: ParadisBotPanePurpose): string | undefined {
		const bot = this.getBot(botId);
		if (bot === undefined || bot.paused) {
			return undefined;
		}
		const launchId = this.uuid();
		this.panes.issue(launchId, botId, purpose, this.now());
		return launchId;
	}

	/** 起動したペインの報告。発行していない番号・2 回目・もう結び付いているトークンは断る（false）。 */
	reportLaunch(launchId: string, paneToken: string): boolean {
		const botId = this.panes.report(launchId, paneToken, this.now());
		if (botId === undefined) {
			return false;
		}
		this.notify();
		return true;
	}

	/** 起動に失敗した番号を捨てる。 */
	cancelLaunch(launchId: string): void {
		this.panes.cancel(launchId);
	}

	/** ペインが閉じた。見回りのペインなら、その Bot はもう最初の見回りではない。 */
	releasePane(paneToken: string): void {
		const purpose = this.panes.purposeOf(paneToken);
		const botId = this.panes.release(paneToken);
		if (botId === undefined) {
			return;
		}
		if (purpose === 'patrol') {
			void this.write(async () => {
				await this.saveSuggestions(paradisBotSuggestionsRunEnded(this.suggestions, botId));
				return { ok: true, value: undefined };
			});
		}
		this.notify();
	}

	// ---- 提案（見回りで見つけた「やってもよいこと」。ベルにも「あなたの番」にも数えない） --------------

	/** その Bot のまだ決めていない提案（新しい順）。 */
	listSuggestions(botId: string): IParadisBotSuggestion[] {
		return paradisBotOpenSuggestions(this.suggestions, botId);
	}

	/** 見回りのペインが提案を足す（道具の提供元だけが呼ぶ）。会話のペインからは断る。 */
	botSuggest(botId: string, paneToken: string, title: unknown, request: unknown): Promise<Result<IParadisBotSuggestion>> {
		return this.write(async () => {
			if (this.suggestionsFile === undefined) {
				return { ok: false, code: 'unavailable', message: 'Suggestions are not available.' };
			}
			if (this.panes.purposeOf(paneToken) !== 'patrol') {
				return { ok: false, code: 'not_patrol', message: 'Offer suggestions only in a look-around (a terminal Para Code started for you on a schedule). In a conversation, tell your owner in your reply.' };
			}
			const result = paradisBotSuggestionAdd(this.suggestions, { id: this.uuid(), botId, run: paradisBotPaneTokenHash(paneToken), title, request }, this.now());
			return result.ok ? this.saveSuggestions(result.state, result.value) : result;
		});
	}

	/**
	 * 「始める」。まだ決めていない提案を返すだけで、台帳は変えない（会話の入力欄へ未送信で入れるのは画面の側）。
	 * 画面が入れ終えたら {@link markSuggestionStarted} を呼ぶ（入れられなかった提案を「始めた」にしない）。
	 */
	async startSuggestion(id: string): Promise<Result<IParadisBotSuggestion>> {
		await this.ready;
		const result = paradisBotSuggestionStart(this.suggestions, id, this.now());
		if (!result.ok) {
			return result;
		}
		const current = this.suggestions.suggestions.find(suggestion => suggestion.id === id);
		return current !== undefined ? { ok: true, value: current } : { ok: false, code: 'not_found', message: 'There is no such suggestion.' };
	}

	/** 画面が提案の文を会話の入力欄へ入れ終えた。提案を「始めた」にする。 */
	markSuggestionStarted(id: string): Promise<Result<IParadisBotSuggestion>> {
		return this.write(async () => {
			const result = paradisBotSuggestionStart(this.suggestions, id, this.now());
			return result.ok ? this.saveSuggestions(result.state, result.value) : result;
		});
	}

	/** 「見送る」。同じ題を 30 日出さない。 */
	dismissSuggestion(id: string): Promise<Result<IParadisBotSuggestion>> {
		return this.write(async () => {
			const result = paradisBotSuggestionDismiss(this.suggestions, id, this.now());
			return result.ok ? this.saveSuggestions(result.state, result.value) : result;
		});
	}

	private async saveSuggestions<T>(next: IParadisBotSuggestionsState, value?: T): Promise<Result<T>> {
		if (next !== this.suggestions && this.suggestionsFile !== undefined) {
			const previous = this.suggestions;
			this.suggestions = next;
			try {
				await this.suggestionsFile.write(next);
			} catch (error) {
				this.suggestions = previous;
				throw error;
			}
			this.notify();
		}
		return { ok: true, value: value as T };
	}

	// ---- 記憶の整理 ------------------------------------------------------------------------------

	/** 記憶の整理を始める前に、記憶のファイルの写しを取る（写しは専用フォルダの外）。 */
	snapshotMemory(botId: string): Promise<Result<IParadisBotMemorySnapshot>> {
		return this.memory(botId, (snapshots, bot) => snapshots.take(bot));
	}

	/** 記憶の整理を取り消す（一番新しい写しを書き戻す）。写しが無ければ `not_found`。 */
	async undoMemoryTidy(botId: string): Promise<Result<IParadisBotMemoryUndo>> {
		const result = await this.memory(botId, (snapshots, bot) => snapshots.undo(bot));
		if (result.ok && result.value === undefined) {
			return { ok: false, code: 'not_found', message: 'There is no copy of the memory to go back to.' };
		}
		return result as Result<IParadisBotMemoryUndo>;
	}

	private async memory<T>(botId: string, operation: (snapshots: ParadisBotMemorySnapshots, bot: IParadisBot) => Promise<T>): Promise<Result<T>> {
		// 設定がオフの間は、写しのフォルダも作らず、専用フォルダへも書き戻さない
		if (!this.enabled()) {
			return BOTS_DISABLED;
		}
		if (this.memorySnapshots === undefined) {
			return { ok: false, code: 'unavailable', message: 'Memory copies are not available.' };
		}
		const snapshots = this.memorySnapshots;
		return this.homeFile(botId, (_homes, bot) => operation(snapshots, bot));
	}

	// ---- 中身 -----------------------------------------------------------------------------------

	/** 書き込みを 1 つずつ順に行う（読み込みが終わってから）。 */
	private write<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
		const run = async (): Promise<Result<T>> => {
			await this.ready;
			try {
				return await operation();
			} catch (error) {
				this.logService.error('[ParadisBots] a write failed', error);
				return { ok: false, code: 'storage', message: 'Para Code could not save the change.' };
			}
		};
		const next = this.queue.then(run, run);
		this.queue = next;
		return next;
	}

	private async saveBots(next: IParadisBotsState, bot: IParadisBot): Promise<Result<IParadisBot>> {
		const previous = this.bots;
		this.bots = next;
		try {
			await this.botsFile.write(next);
		} catch (error) {
			this.bots = previous;
			throw error;
		}
		this.changed();
		return { ok: true, value: bot };
	}

	/** @param saved 保存できた直後、知らせる前に呼ぶ（回答済みの知らせを、待ちの一覧の知らせ直しより先にするため）。 */
	private async saveItems<T>(next: IParadisBotItemsState, value: T, saved?: () => void): Promise<Result<T>> {
		if (next === this.items) {
			return { ok: true, value };
		}
		const previous = this.items;
		this.items = next;
		try {
			await this.itemsFile.write(next);
		} catch (error) {
			this.items = previous;
			throw error;
		}
		saved?.();
		this.changed();
		return { ok: true, value };
	}

	private apply(result: ParadisBotItemsResult, saved?: () => void): Promise<Result<IParadisBotItem>> {
		return result.ok ? this.saveItems(result.state, result.item, saved) : Promise.resolve(result);
	}

	private async applyOwner(result: ParadisBotItemsResult, saved?: () => void): Promise<Result<IParadisBotItem>> {
		const applied = await this.apply(result, saved);
		if (applied.ok && result.ok && !result.unchanged) {
			this._onDidQueueMail.fire({ botId: applied.value.botId, uid: applied.value.uid });
		}
		return applied;
	}

	/** 台帳が変わった。「聞く・答える」の台帳へ知らせ直し、画面へ知らせる。 */
	private changed(): void {
		if (!this.loaded) {
			return;
		}
		this.syncAsks();
		this.notify();
	}

	private notify(): void {
		this.revision++;
		this.changeScheduler.schedule();
	}

	/**
	 * 今待っている問いを丸ごと知らせる。一時停止中の Bot と後回し中の項目は出さない（答えても Bot が動かない・
	 * 利用者が後で見ると決めたもの）。後回しの期限が来たら数え直す。
	 */
	private syncAsks(): void {
		const now = this.now();
		const asks: unknown[] = [];
		let wakeAt: number | undefined;
		// Bot の機能がオフなら、問いを 1 つも出さない（出していた分は空の一覧で取り下げる）
		for (const item of this.enabled() ? this.items.items : []) {
			const bot = this.getBot(item.botId);
			if (bot === undefined || bot.paused || item.status !== 'needs_you') {
				continue;
			}
			if (paradisIsBotItemSnoozed(item, now)) {
				wakeAt = Math.min(wakeAt ?? Infinity, item.snoozedUntil ?? Infinity);
			}
			// Bot の行の「あなたの番」と同じ式で選ぶ（件数が割れないように）
			if (!paradisBotItemWaitsForOwner(item, now)) {
				continue;
			}
			const input = paradisBotAskInput(bot, item);
			if (input !== undefined) {
				asks.push(input);
			}
		}
		const refused = this.humanAsk.sync(PARADIS_BOTS_ASK_OWNER, asks);
		if (refused > 0) {
			this.logService.warn(`[ParadisBots] ${refused} waiting question(s) did not fit the ask ledger`);
		}
		this.wakeScheduler.cancel();
		if (wakeAt !== undefined && Number.isFinite(wakeAt)) {
			// setTimeout の上限（約 24.8 日）を超える待ちは、上限で一度起きて数え直す
			this.wakeScheduler.schedule(Math.min(Math.max(wakeAt - now, 0) + 1, 2 ** 31 - 1));
		}
	}

	/** 「聞く・答える」の台帳から来た答えを、持ち主のコメントとして項目に書く。 */
	private onAnswerRequest(request: IParadisHumanAskAnswerRequest): void {
		if (request.owner !== PARADIS_BOTS_ASK_OWNER) {
			return;
		}
		void this.write(async () => {
			const id = paradisParseBotAskId(request.id);
			const item = id !== undefined ? this.getItem(id.uid) : undefined;
			const ask = item?.status === 'needs_you' ? item.ask : undefined;
			const comment = ask !== undefined && ask.eventId === id?.askEventId ? paradisBotAnswerComment(ask, request.answer) : undefined;
			if (item === undefined || ask === undefined || comment === undefined) {
				return { ok: false, code: 'item_changed', message: 'The question no longer waits.' };
			}
			// 順番は 保存 → 回答済みの知らせ → 待ちの一覧の知らせ直し。項目の台帳に書けた時点で回答済みにする
			// （Bot のペインへ届くのは待たない。待つと「聞く・答える」の台帳の時間切れに当たる）
			return this.applyOwner(paradisBotItemOwnerComment(this.items, item.uid, { text: comment.text, askEventId: ask.eventId, skipped: comment.skipped }, this.now()), () => {
				// 何も渡さなければ、台帳が依頼した場所と答えの要約を使う
				this.humanAsk.resolve(PARADIS_BOTS_ASK_OWNER, request.key);
			});
		}).then(result => {
			// 届かなかった。台帳は、まだ待っていれば待ちへ戻す
			if (!result.ok && !this._store.isDisposed) {
				this.humanAsk.reject(PARADIS_BOTS_ASK_OWNER, request.key, request.claim);
			}
		});
	}
}
