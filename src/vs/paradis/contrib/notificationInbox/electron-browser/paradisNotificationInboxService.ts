/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	EMPTY_PARADIS_INBOX_SNAPSHOT,
	IParadisInboxEntry,
	IParadisInboxPaneStatus,
	IParadisInboxRecordInput,
	IParadisInboxRevealRequest,
	IParadisInboxSnapshot,
	IParadisNotificationInboxService,
	PARADIS_NOTIFICATION_INBOX_CHANNEL,
} from '../common/paradisNotificationInbox.js';

/**
 * {@link IParadisNotificationInboxService} の実装。shared process の台帳へ書き、台帳から届いた
 * 最新のスナップショットを手元に写して返す。
 */
export class ParadisNotificationInboxClient extends Disposable implements IParadisNotificationInboxService {

	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidRequestOpenInbox = this._register(new Emitter<void>());
	readonly onDidRequestOpenInbox: Event<void> = this._onDidRequestOpenInbox.event;

	readonly onDidRequestReveal: Event<IParadisInboxRevealRequest>;

	private _snapshot: IParadisInboxSnapshot = EMPTY_PARADIS_INBOX_SNAPSHOT;
	/** 知らせで届いたスナップショットの方が新しいので、それより前に頼んだ取得結果では上書きしない。 */
	private pushed = false;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.channel = sharedProcessService.getChannel(PARADIS_NOTIFICATION_INBOX_CHANNEL);
		this._register(this.channel.listen<IParadisInboxSnapshot>('onDidChange')(snapshot => {
			this.pushed = true;
			this.apply(snapshot);
		}));
		this.onDidRequestReveal = this.channel.listen<IParadisInboxRevealRequest>('onDidRequestReveal');
		this.channel.call<IParadisInboxSnapshot>('getSnapshot').then(snapshot => {
			if (!this.pushed) {
				this.apply(snapshot);
			}
		}, error => this.logService.trace('[paradisNotificationInbox] getSnapshot failed', String(error)));
	}

	get snapshot(): IParadisInboxSnapshot {
		return this._snapshot;
	}

	record(input: IParadisInboxRecordInput): Promise<void> {
		return this.send('record', [input]);
	}

	markRead(ids: readonly string[]): Promise<void> {
		return this.send('markRead', [ids]);
	}

	markUnread(id: string): Promise<void> {
		return this.send('markUnread', [id]);
	}

	markAllRead(): Promise<void> {
		return this.send('markAllRead', []);
	}

	markPanesRead(tokens: readonly string[]): Promise<void> {
		return tokens.length > 0 ? this.send('markPanesRead', [tokens]) : Promise.resolve();
	}

	remove(id: string): Promise<void> {
		return this.send('remove', [id]);
	}

	reveal(entry: IParadisInboxEntry): Promise<void> {
		return this.send('requestReveal', [entry.id]);
	}

	requestOpenInbox(): void {
		this._onDidRequestOpenInbox.fire();
	}

	syncPaneStatuses(statuses: readonly IParadisInboxPaneStatus[]): Promise<void> {
		return this.send('syncPaneStatuses', [statuses]);
	}

	setLivePanes(tokens: readonly string[]): Promise<void> {
		return this.send('setLivePanes', [tokens]);
	}

	private async send(command: string, args: unknown[]): Promise<void> {
		try {
			await this.channel.call(command, args);
		} catch (error) {
			this.logService.trace(`[paradisNotificationInbox] ${command} failed`, String(error));
		}
	}

	private apply(snapshot: IParadisInboxSnapshot): void {
		this._snapshot = snapshot;
		this._onDidChange.fire();
	}
}

registerSingleton(IParadisNotificationInboxService, ParadisNotificationInboxClient, InstantiationType.Delayed);
