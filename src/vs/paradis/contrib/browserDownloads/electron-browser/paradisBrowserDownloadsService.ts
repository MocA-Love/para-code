/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのダウンロード一覧の renderer 側の写し。main（paradisBrowserDownloadsTracker.ts）が
// 権威で、ここは購読して持っているだけ。操作は id を付けて main へそのまま頼む。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisBrowserDownloadItem, IParadisBrowserDownloadsMainService, PARADIS_BROWSER_DOWNLOADS_CHANNEL, paradisHasNewlyFinished } from '../common/paradisBrowserDownloads.js';

export const IParadisBrowserDownloadsService = createDecorator<IParadisBrowserDownloadsService>('paradisBrowserDownloadsService');

export interface IParadisBrowserDownloadsService {
	readonly _serviceBrand: undefined;

	/** 一覧か「未確認」の状態が変わったとき。 */
	readonly onDidChange: Event<void>;

	/** 新しい順の全件。 */
	readonly items: readonly IParadisBrowserDownloadItem[];

	/** 一覧を最後に開いてから、終わった（完了・失敗）ものがあるか。ボタンに印を出す。 */
	readonly hasUnseen: boolean;

	/** 一覧を開いたときに呼ぶ。 */
	markSeen(): void;

	cancel(id: string): Promise<void>;
	open(id: string): Promise<boolean>;
	showInFolder(id: string): Promise<boolean>;
	remove(id: string): Promise<void>;
	clearFinished(): Promise<void>;
	openDownloadsFolder(): Promise<boolean>;
}

export class ParadisBrowserDownloadsService extends Disposable implements IParadisBrowserDownloadsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _main: IParadisBrowserDownloadsMainService;
	private _items: readonly IParadisBrowserDownloadItem[] = [];
	private _hasUnseen = false;
	/** 初回の list() より後に届いた通知があれば、list() の結果で上書きしない。 */
	private _receivedEvent = false;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._main = ProxyChannel.toService<IParadisBrowserDownloadsMainService>(mainProcessService.getChannel(PARADIS_BROWSER_DOWNLOADS_CHANNEL));
		this._register(this._main.onDidChangeDownloads(items => {
			this._receivedEvent = true;
			this._update(items);
		}));
		this._main.list().then(items => {
			if (!this._receivedEvent && !this._store.isDisposed) {
				// 起動前から続いているものは「未確認」にしない（別のウィンドウで見ているかもしれない）。
				this._items = items;
				this._onDidChange.fire();
			}
		}, error => this._logService.warn('[ParadisBrowserDownloads] could not read the download list', error));
	}

	get items(): readonly IParadisBrowserDownloadItem[] {
		return this._items;
	}

	get hasUnseen(): boolean {
		return this._hasUnseen;
	}

	markSeen(): void {
		if (this._hasUnseen) {
			this._hasUnseen = false;
			this._onDidChange.fire();
		}
	}

	cancel(id: string): Promise<void> { return this._main.cancel(id); }
	open(id: string): Promise<boolean> { return this._main.open(id); }
	showInFolder(id: string): Promise<boolean> { return this._main.showInFolder(id); }
	remove(id: string): Promise<void> { return this._main.remove(id); }
	clearFinished(): Promise<void> { return this._main.clearFinished(); }
	openDownloadsFolder(): Promise<boolean> { return this._main.openDownloadsFolder(); }

	private _update(items: readonly IParadisBrowserDownloadItem[]): void {
		if (paradisHasNewlyFinished(this._items, items)) {
			this._hasUnseen = true;
		}
		this._items = items;
		this._onDidChange.fire();
	}
}

registerSingleton(IParadisBrowserDownloadsService, ParadisBrowserDownloadsService, InstantiationType.Delayed);
