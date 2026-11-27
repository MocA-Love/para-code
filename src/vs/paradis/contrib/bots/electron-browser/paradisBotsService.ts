/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のサービスの、ウィンドウ側の窓口。paradis.electron-browser.contribution.ts から読み込む。
// 画面はまだ無い（一覧・ページは後の PR）。使う側が現れるまで実体は作られない（Delayed）。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import { IParadisBotItem, IParadisBotItemOwnerComment, ParadisBotItemStatus } from '../common/paradisBotItems.js';
import { IParadisBotSuggestion } from '../common/paradisBotSuggestions.js';
import { IParadisBot, IParadisBotPatch, ParadisBotFaceColor, ParadisBotFaceShape } from '../common/paradisBots.js';
import { EMPTY_PARADIS_BOTS_SNAPSHOT, IParadisBotLaunch, IParadisBotRevealRequest, IParadisBotsService, IParadisBotsSnapshot, IParadisBotStopRequest, PARADIS_BOTS_CHANNEL, PARADIS_BOTS_ENABLED_SETTING, ParadisBotPanePurpose, ParadisBotsServiceResult } from '../common/paradisBotsApi.js';

const UNAVAILABLE: ParadisBotsServiceResult<never> = { ok: false, code: 'unavailable', message: 'Para Code could not reach the bot service.' };

export class ParadisBotsClient extends Disposable implements IParadisBotsService {

	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	readonly onDidRequestStop: Event<IParadisBotStopRequest>;
	readonly onDidRequestReveal: Event<IParadisBotRevealRequest>;

	private _snapshot: IParadisBotsSnapshot = EMPTY_PARADIS_BOTS_SNAPSHOT;
	/** shared process の台帳の知らせの購読（設定 {@link PARADIS_BOTS_ENABLED_SETTING} がオンの間だけ持つ）。 */
	private readonly subscription = this._register(new MutableDisposable());

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.channel = sharedProcessService.getChannel(PARADIS_BOTS_CHANNEL);
		this.onDidRequestStop = this.channel.listen<IParadisBotStopRequest>('onDidRequestStop');
		this.onDidRequestReveal = this.channel.listen<IParadisBotRevealRequest>('onDidRequestReveal');
		// 設定をオフにしたら台帳の購読を外して一覧を空にする（窓を読み直すまで shared process の知らせを受け続けない）。
		// オンに戻したら購読し直して取り直す
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_BOTS_ENABLED_SETTING)) {
				this.syncSubscription();
			}
		}));
		this.syncSubscription();
	}

	private syncSubscription(): void {
		const enabled = this.configurationService.getValue<boolean>(PARADIS_BOTS_ENABLED_SETTING) === true;
		if (!enabled) {
			if (this.subscription.value !== undefined) {
				this.subscription.clear();
				// 次にオンにしたとき、台帳の番号が前より小さくても受け取れるよう、空の一覧（番号 0）へ戻す
				this._snapshot = EMPTY_PARADIS_BOTS_SNAPSHOT;
				this._onDidChange.fire();
			}
			return;
		}
		if (this.subscription.value !== undefined) {
			return;
		}
		this.subscription.value = this.channel.listen<IParadisBotsSnapshot>('onDidChange')(snapshot => this.apply(snapshot));
		this.channel.call<IParadisBotsSnapshot>('getSnapshot').then(
			snapshot => {
				if (this.subscription.value !== undefined) {
					this.apply(snapshot);
				}
			},
			error => this.logService.trace('[paradisBots] getSnapshot failed', String(error)),
		);
	}

	get snapshot(): IParadisBotsSnapshot {
		return this._snapshot;
	}

	createBot(input: { readonly name: string; readonly agent: ParadisAgentKind; readonly modelId?: string; readonly effortId?: string; readonly permissionId?: string; readonly faceColor?: ParadisBotFaceColor; readonly faceShape?: ParadisBotFaceShape }, soul?: string): Promise<ParadisBotsServiceResult<IParadisBot>> {
		return this.result('createBot', [input, soul]);
	}

	updateBot(botId: string, patch: IParadisBotPatch): Promise<ParadisBotsServiceResult<IParadisBot>> {
		return this.result('updateBot', [botId, patch]);
	}

	removeBot(botId: string): Promise<ParadisBotsServiceResult<IParadisBot>> {
		return this.result('removeBot', [botId]);
	}

	listItems(filter: { readonly botId?: string; readonly open?: boolean } = {}): Promise<readonly IParadisBotItem[]> {
		return this.value<readonly IParadisBotItem[]>('listItems', [filter], []);
	}

	getItem(uid: string): Promise<IParadisBotItem | undefined> {
		return this.value<IParadisBotItem | undefined>('getItem', [uid], undefined);
	}

	ownerComment(uid: string, input: IParadisBotItemOwnerComment): Promise<ParadisBotsServiceResult<IParadisBotItem>> {
		return this.result('ownerComment', [uid, input]);
	}

	ownerSetStatus(uid: string, to: ParadisBotItemStatus, note?: string): Promise<ParadisBotsServiceResult<IParadisBotItem>> {
		return this.result('ownerSetStatus', [uid, to, note]);
	}

	ownerSnooze(uid: string, until: number | undefined): Promise<ParadisBotsServiceResult<IParadisBotItem>> {
		return this.result('ownerSnooze', [uid, until]);
	}

	requestLaunch(botId: string, purpose: ParadisBotPanePurpose = 'chat'): Promise<ParadisBotsServiceResult<IParadisBotLaunch>> {
		return this.result('requestLaunch', [botId, purpose]);
	}

	/**
	 * 起動したペインを知らせる。このウィンドウの生きたペインのトークンでなければ知らせず、起動の番号を捨てる
	 * （shared process はトークンがどのウィンドウのものかを知らないので、ここで確かめる）。
	 */
	async reportLaunch(launchId: string, paneToken: string): Promise<boolean> {
		if (this.paneTokenService.getInstanceForToken(paneToken) === undefined) {
			this.logService.warn('[paradisBots] a launch was reported with a token that is not a live pane of this window');
			await this.cancelLaunch(launchId);
			return false;
		}
		return this.value('reportLaunch', [launchId, paneToken], false);
	}

	async cancelLaunch(launchId: string): Promise<void> {
		await this.value('cancelLaunch', [launchId], undefined);
	}

	requestReveal(botId: string): Promise<boolean> {
		return this.value('requestReveal', [botId], false);
	}

	async ackReveal(revealId: string): Promise<void> {
		await this.value('ackReveal', [revealId], undefined);
	}

	requestStop(botId: string): Promise<boolean> {
		return this.value('requestStop', [botId], false);
	}

	paneHashesOf(botId: string): Promise<readonly string[]> {
		return this.value<readonly string[]>('paneHashesOf', [botId], []);
	}

	listSuggestions(botId: string): Promise<readonly IParadisBotSuggestion[]> {
		return this.value<readonly IParadisBotSuggestion[]>('listSuggestions', [botId], []);
	}

	startSuggestion(id: string): Promise<ParadisBotsServiceResult<IParadisBotSuggestion>> {
		return this.result('startSuggestion', [id]);
	}

	markSuggestionStarted(id: string): Promise<ParadisBotsServiceResult<IParadisBotSuggestion>> {
		return this.result('markSuggestionStarted', [id]);
	}

	dismissSuggestion(id: string): Promise<ParadisBotsServiceResult<IParadisBotSuggestion>> {
		return this.result('dismissSuggestion', [id]);
	}

	snapshotMemory(botId: string): Promise<ParadisBotsServiceResult<{ readonly takenAt: number; readonly files: number; readonly total: number; readonly partial: boolean }>> {
		return this.result('snapshotMemory', [botId]);
	}

	undoMemoryTidy(botId: string): Promise<ParadisBotsServiceResult<{ readonly restored: readonly string[]; readonly added: readonly string[]; readonly takenAt: number; readonly skipped: readonly string[] }>> {
		return this.result('undoMemoryTidy', [botId]);
	}

	readHomeFile(botId: string, relativePath: string): Promise<ParadisBotsServiceResult<string | undefined>> {
		return this.result('readHomeFile', [botId, relativePath]);
	}

	writeHomeFile(botId: string, relativePath: string, text: string): Promise<ParadisBotsServiceResult<void>> {
		return this.result('writeHomeFile', [botId, relativePath, text]);
	}

	private result<T>(command: string, args: unknown[]): Promise<ParadisBotsServiceResult<T>> {
		return this.value<ParadisBotsServiceResult<T>>(command, args, UNAVAILABLE);
	}

	private async value<T>(command: string, args: unknown[], fallback: T): Promise<T> {
		try {
			return await this.channel.call<T>(command, args);
		} catch (error) {
			this.logService.trace(`[paradisBots] ${command} failed`, String(error));
			return fallback;
		}
	}

	/** 番号の戻ったもの（知らせより前に頼んだ取得の結果）では上書きしない。 */
	private apply(snapshot: IParadisBotsSnapshot): void {
		if (snapshot.revision < this._snapshot.revision) {
			return;
		}
		this._snapshot = snapshot;
		this._onDidChange.fire();
	}
}

registerSingleton(IParadisBotsService, ParadisBotsClient, InstantiationType.Delayed);
