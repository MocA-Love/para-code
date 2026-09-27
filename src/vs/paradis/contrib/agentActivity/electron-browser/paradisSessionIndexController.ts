/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// セッション履歴から全文索引を使うための窓口。
//
// - 既定でオン（設定 `paradis.sessionIndex.enabled`）。オンのときは、履歴を開くたびに索引を会話ログへ合わせる（続きだけ読むので2回目以降は軽い）
// - 検索は索引で行い、索引に入っていない会話（保存日数より古いもの、SSH 先のもの）だけを従来の
//   方法（会話の先頭と末尾を読む）で探す

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	PARADIS_SESSION_INDEX_DEFAULT_RETENTION_DAYS,
	PARADIS_SESSION_INDEX_SETTING_ENABLED,
	PARADIS_SESSION_INDEX_SETTING_INCLUDE_TOOL_OUTPUT,
	PARADIS_SESSION_INDEX_SETTING_RETENTION_DAYS,
} from '../common/paradisSessionIndex.js';
import { IParadisSessionIndexSearchResult, ParadisAgentActivityClient } from './paradisAgentActivityClient.js';

const $ = dom.$;

/** 同じダイアログの中で索引を合わせ直す最短の間隔。 */
const MIN_UPDATE_INTERVAL_MS = 30_000;

export type ParadisSessionIndexState = 'on' | 'off';

export class ParadisSessionIndexController extends Disposable {

	private readonly client: ParadisAgentActivityClient;
	private readonly _onDidChange = this._register(new Emitter<void>());
	/** オン・オフが変わった、または索引の更新が終わった。検索をやり直す合図。 */
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private updating: Promise<void> | undefined;
	private lastUpdate = 0;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.client = instantiationService.createInstance(ParadisAgentActivityClient);
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_SESSION_INDEX_SETTING_ENABLED)
				|| event.affectsConfiguration(PARADIS_SESSION_INDEX_SETTING_RETENTION_DAYS)
				|| event.affectsConfiguration(PARADIS_SESSION_INDEX_SETTING_INCLUDE_TOOL_OUTPUT)) {
				this.lastUpdate = 0;
				this._onDidChange.fire();
			}
		}));
	}

	get state(): ParadisSessionIndexState {
		return this.configurationService.getValue<boolean>(PARADIS_SESSION_INDEX_SETTING_ENABLED) === false ? 'off' : 'on';
	}

	/** 索引の更新中なら true（一覧に「索引を更新しています」と出す）。 */
	get isUpdating(): boolean {
		return this.updating !== undefined;
	}

	/** 索引の状態を1行で出す（オンのときだけ）。 */
	renderStatus(parent: HTMLElement): void {
		if (this.state !== 'on') {
			return;
		}
		const status = dom.append(parent, $('span.paradis-session-index-status'));
		const icon = dom.append(status, $(`span${ThemeIcon.asCSSSelector(this.isUpdating ? Codicon.loading : Codicon.database)}`));
		if (this.isUpdating) {
			icon.classList.add('codicon-modifier-spin');
		}
		dom.append(status, $('span')).textContent = this.isUpdating
			? localize('paradis.sessionIndex.statusUpdating', "全文索引を更新しています")
			: localize('paradis.sessionIndex.statusOn', "全文検索: オン");
	}

	/**
	 * オンなら索引を会話ログへ合わせる（バックグラウンド）。終わったら {@link onDidChange} を鳴らす。
	 * 短い間隔で何度呼ばれても、実際に合わせ直すのは {@link MIN_UPDATE_INTERVAL_MS} に1回まで。
	 */
	requestUpdate(): void {
		if (this.state !== 'on' || this.updating || Date.now() - this.lastUpdate < MIN_UPDATE_INTERVAL_MS) {
			return;
		}
		this.lastUpdate = Date.now();
		const update = this.client.indexUpdate({
			retentionDays: this.retentionDays(),
			includeToolOutput: this.configurationService.getValue<boolean>(PARADIS_SESSION_INDEX_SETTING_INCLUDE_TOOL_OUTPUT) === true,
		}).then(() => undefined, error => {
			this.logService.warn('[ParadisSessionIndex] unable to update the full-text index', error);
		}).finally(() => {
			if (this.updating === update) {
				this.updating = undefined;
			}
			if (!this._store.isDisposed) {
				this._onDidChange.fire();
			}
		});
		this.updating = update;
		this._onDidChange.fire();
	}

	/**
	 * 索引で探す。オフのとき・索引の更新中（worker が更新を終えるまで検索が待たされる）・失敗したときは
	 * undefined（呼び出し側は従来の方法で探し、更新が終わった合図で探し直す）。索引がまだ無いときは
	 * `covered` が空になり、すべての会話を従来の方法で探すことになる。
	 */
	async search(query: string): Promise<IParadisSessionIndexSearchResult | undefined> {
		if (this.state !== 'on' || this.isUpdating) {
			return undefined;
		}
		try {
			return await this.client.indexSearch(query);
		} catch (error) {
			this.logService.warn('[ParadisSessionIndex] full-text search failed', error);
			return undefined;
		}
	}

	private retentionDays(): number {
		const value = this.configurationService.getValue<number>(PARADIS_SESSION_INDEX_SETTING_RETENTION_DAYS);
		return typeof value === 'number' && value > 0 ? value : PARADIS_SESSION_INDEX_DEFAULT_RETENTION_DAYS;
	}
}
