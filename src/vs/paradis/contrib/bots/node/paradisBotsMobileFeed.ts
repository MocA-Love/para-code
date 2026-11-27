/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホへ送る Bot の一覧（設計の PR 16、`bots.page.v1`）。shared process の中で、台帳が変わるたびに中継の受け口
// （mobileRelay/node/paradisMobileBotsFeed.ts）へ一覧を置く。設定 `paradis.bots.enabled` がオフの間は置かない（State から外れる）。
//
// 一覧の 1 行は PC の帯と同じ値で、専用フォルダの名前・パス・ペインのトークンは載せない。ターミナルの行の `botId` は、
// State に載るペインのトークンをハッシュにして、Bot ごとのペインのハッシュと照らす（#1207 のウィンドウ側と同じ照らし方）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IParadisMobileBot } from '../../mobileRelay/common/paradisMobileRelay.js';
import { paradisPublishMobileBots } from '../../mobileRelay/node/paradisMobileBotsFeed.js';
import { IParadisBotSummary, IParadisBotsSnapshot, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';
import { paradisBotPaneTokenHash } from './paradisBotPanes.js';

/** 一覧の 1 行（送ってよい欄だけを写す）。 */
export function paradisMobileBotOf(bot: IParadisBotSummary): IParadisMobileBot {
	return {
		id: bot.id,
		name: bot.name,
		agent: bot.agent,
		...(bot.modelId !== undefined ? { modelId: bot.modelId } : {}),
		...(bot.effortId !== undefined ? { effortId: bot.effortId } : {}),
		...(bot.permissionId !== undefined ? { permissionId: bot.permissionId } : {}),
		faceColor: bot.faceColor,
		faceShape: bot.faceShape,
		paused: bot.paused,
		pinned: bot.pinned,
		needsYou: bot.needsYou,
		openItems: bot.openItems,
		openSuggestions: bot.openSuggestions,
		activity: bot.activity,
		lastActivityAt: bot.lastActivityAt,
	};
}

/** 台帳の側が渡すもの（テストで差し替える）。 */
export interface IParadisBotsMobileFeedSource {
	readonly onDidChange: (listener: (snapshot: IParadisBotsSnapshot) => void) => { dispose(): void };
	getSnapshot(): IParadisBotsSnapshot;
	paneHashesOf(botId: string): readonly string[];
}

export class ParadisBotsMobileFeed extends Disposable {

	constructor(
		private readonly source: IParadisBotsMobileFeedSource,
		private readonly configurationService: Pick<IConfigurationService, 'getValue' | 'onDidChangeConfiguration'>,
		private readonly publish: typeof paradisPublishMobileBots = paradisPublishMobileBots,
	) {
		super();
		this._register(source.onDidChange(() => this.update()));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_BOTS_ENABLED_SETTING)) {
				this.update();
			}
		}));
		this.update();
	}

	update(): void {
		if (this.configurationService.getValue(PARADIS_BOTS_ENABLED_SETTING) !== true) {
			this.publish(undefined);
			return;
		}
		const snapshot = this.source.getSnapshot();
		const owners = new Map<string, string>();
		for (const bot of snapshot.bots) {
			for (const hash of this.source.paneHashesOf(bot.id)) {
				owners.set(hash, bot.id);
			}
		}
		this.publish({
			bots: snapshot.bots.map(paradisMobileBotOf),
			botOfToken: paneToken => owners.get(paradisBotPaneTokenHash(paneToken)),
			panesKey: JSON.stringify([...owners].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
		});
	}

	override dispose(): void {
		this.publish(undefined);
		super.dispose();
	}
}
