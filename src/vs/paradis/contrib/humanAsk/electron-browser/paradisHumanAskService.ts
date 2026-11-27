/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「人が答えるもの」の台帳の、ウィンドウ側の窓口。paradis.electron-browser.contribution.ts から読み込む。
// 画面はまだ無い（受信箱のカードと件数は後の PR）。使う側が現れるまで実体は作られない（Delayed）。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	EMPTY_PARADIS_HUMAN_ASK_SNAPSHOT,
	IParadisHumanAskService,
	IParadisHumanAskSnapshot,
	PARADIS_HUMAN_ASK_CHANNEL,
	ParadisHumanAskAnswer,
	ParadisHumanAskClientResult,
} from '../common/paradisHumanAsk.js';

export class ParadisHumanAskClient extends Disposable implements IParadisHumanAskService {

	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _snapshot: IParadisHumanAskSnapshot = EMPTY_PARADIS_HUMAN_ASK_SNAPSHOT;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.channel = sharedProcessService.getChannel(PARADIS_HUMAN_ASK_CHANNEL);
		this._register(this.channel.listen<IParadisHumanAskSnapshot>('onDidChange')(snapshot => this.apply(snapshot)));
		this.channel.call<IParadisHumanAskSnapshot>('getSnapshot').then(
			snapshot => this.apply(snapshot),
			error => this.logService.trace('[paradisHumanAsk] getSnapshot failed', String(error)),
		);
	}

	get snapshot(): IParadisHumanAskSnapshot {
		return this._snapshot;
	}

	async answer(key: string, answer: ParadisHumanAskAnswer, surface: 'inbox' | 'bot' | 'mobile' = 'inbox'): Promise<ParadisHumanAskClientResult> {
		try {
			return await this.channel.call<ParadisHumanAskClientResult>('answer', [key, answer, surface]);
		} catch (error) {
			this.logService.trace('[paradisHumanAsk] answer failed', String(error));
			return { ok: false, reason: 'unavailable' };
		}
	}

	/** 番号の戻ったもの（知らせより前に頼んだ取得の結果）では上書きしない。 */
	private apply(snapshot: IParadisHumanAskSnapshot): void {
		if (snapshot.revision < this._snapshot.revision) {
			return;
		}
		this._snapshot = snapshot;
		this._onDidChange.fire();
	}
}

registerSingleton(IParadisHumanAskService, ParadisHumanAskClient, InstantiationType.Delayed);
