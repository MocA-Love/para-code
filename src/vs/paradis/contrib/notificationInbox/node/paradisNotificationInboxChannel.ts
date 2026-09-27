/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の台帳のチャネル。shared process の登録口から登録する。
// 全ウィンドウがここへ通知を書き、ここから同じ台帳を読む。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import {
	IParadisInboxPaneStatus,
	IParadisInboxRecordInput,
	IParadisInboxRevealRequest,
	IParadisInboxSnapshot,
	PARADIS_NOTIFICATION_INBOX_CHANNEL,
	ParadisInboxDelivery,
	ParadisInboxKind,
} from '../common/paradisNotificationInbox.js';
import { ParadisNotificationInboxLedger } from '../common/paradisNotificationInboxLedger.js';

/** 連続した変更（既読の同期と記録が同時に来る等）をまとめてから知らせる間隔。 */
const CHANGE_DELAY = 50;
/** 文字列の上限（renderer から来る値をそのまま溜め込まない）。 */
const TEXT_LIMIT = 400;

const KINDS: ReadonlySet<string> = new Set<ParadisInboxKind>(['review', 'permission', 'question']);
const DELIVERIES: ReadonlySet<string> = new Set<ParadisInboxDelivery>(['notified', 'silent', 'focused', 'doNotDisturb']);
const STATUSES: ReadonlySet<string> = new Set(['working', 'review', 'permission', 'question']);

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value.slice(0, TEXT_LIMIT) : undefined;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** renderer から来た記録を検める。形が合わなければ undefined（記録しない）。 */
export function paradisSanitizeInboxRecord(value: unknown): IParadisInboxRecordInput | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const input = value as Record<string, unknown>;
	const paneKey = text(input.paneKey);
	const space = text(input.space);
	if (typeof input.kind !== 'string' || !KINDS.has(input.kind) || typeof input.delivery !== 'string' || !DELIVERIES.has(input.delivery)
		|| paneKey === undefined || space === undefined || typeof input.instanceId !== 'number' || typeof input.windowId !== 'number') {
		return undefined;
	}
	const stateKey = text(input.stateKey);
	const worktree = text(input.worktree);
	const tab = text(input.tab);
	const message = text(input.message);
	return {
		kind: input.kind as ParadisInboxKind,
		paneKey,
		instanceId: input.instanceId,
		windowId: input.windowId,
		...(stateKey !== undefined ? { stateKey } : {}),
		space,
		...(worktree !== undefined ? { worktree } : {}),
		...(tab !== undefined ? { tab } : {}),
		...(message !== undefined ? { message } : {}),
		delivery: input.delivery as ParadisInboxDelivery,
		read: input.read === true,
	};
}

function paneStatuses(value: unknown): IParadisInboxPaneStatus[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const result: IParadisInboxPaneStatus[] = [];
	for (const item of value) {
		if (item === null || typeof item !== 'object') {
			continue;
		}
		const { paneKey, status } = item as Record<string, unknown>;
		if (typeof paneKey === 'string' && (status === undefined || status === null || (typeof status === 'string' && STATUSES.has(status)))) {
			result.push({ paneKey, status: typeof status === 'string' ? status as IParadisInboxPaneStatus['status'] : undefined });
		}
	}
	return result;
}

export class ParadisNotificationInboxService extends Disposable {

	private readonly ledger: ParadisNotificationInboxLedger;

	private readonly _onDidChange = this._register(new Emitter<IParadisInboxSnapshot>());
	readonly onDidChange: Event<IParadisInboxSnapshot> = this._onDidChange.event;

	private readonly _onDidRequestReveal = this._register(new Emitter<IParadisInboxRevealRequest>());
	readonly onDidRequestReveal: Event<IParadisInboxRevealRequest> = this._onDidRequestReveal.event;

	private readonly changeScheduler = this._register(new RunOnceScheduler(() => this._onDidChange.fire(this.ledger.snapshot()), CHANGE_DELAY));

	constructor(ledger = new ParadisNotificationInboxLedger()) {
		super();
		this.ledger = ledger;
	}

	getSnapshot(): IParadisInboxSnapshot {
		return this.ledger.snapshot();
	}

	record(value: unknown): void {
		const input = paradisSanitizeInboxRecord(value);
		if (input !== undefined) {
			this.ledger.record(input);
			this.changed(true);
		}
	}

	markRead(ids: unknown): void {
		this.changed(this.ledger.markRead(strings(ids)));
	}

	markUnread(id: unknown): void {
		this.changed(typeof id === 'string' && this.ledger.markUnread(id));
	}

	markAllRead(): void {
		this.changed(this.ledger.markAllRead());
	}

	markPanesRead(tokens: unknown): void {
		this.changed(this.ledger.markPanesRead(strings(tokens)));
	}

	remove(id: unknown): void {
		this.changed(typeof id === 'string' && this.ledger.remove(id));
	}

	syncPaneStatuses(statuses: unknown): void {
		this.changed(this.ledger.syncPaneStatuses(paneStatuses(statuses)));
	}

	setLivePanes(client: string, tokens: unknown): void {
		this.changed(this.ledger.setLivePanes(client, strings(tokens)));
	}

	removeClient(client: string): void {
		this.changed(this.ledger.removeClient(client));
	}

	/** 行を押された。既読にし、ペインを持っているウィンドウへ移動を頼む。 */
	requestReveal(id: unknown): void {
		const entry = typeof id === 'string' ? this.ledger.get(id) : undefined;
		if (entry === undefined) {
			return;
		}
		this.changed(this.ledger.markPanesRead([entry.paneKey]));
		this._onDidRequestReveal.fire({
			entryId: entry.id,
			paneKey: entry.paneKey,
			windowId: entry.windowId,
			...(entry.stateKey !== undefined ? { stateKey: entry.stateKey } : {}),
		});
	}

	private changed(changed: boolean): void {
		if (changed) {
			this.ledger.bumpRevision();
			this.changeScheduler.schedule();
		}
	}
}

export class ParadisNotificationInboxChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisNotificationInboxService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		switch (event) {
			case 'onDidChange': return this.service.onDidChange as Event<T>;
			case 'onDidRequestReveal': return this.service.onDidRequestReveal as Event<T>;
			default: throw new Error(`Event not found: ${event}`);
		}
	}

	async call<T>(ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'getSnapshot': return this.service.getSnapshot() as T;
			case 'record': this.service.record(args[0]); return undefined as T;
			case 'markRead': this.service.markRead(args[0]); return undefined as T;
			case 'markUnread': this.service.markUnread(args[0]); return undefined as T;
			case 'markAllRead': this.service.markAllRead(); return undefined as T;
			case 'markPanesRead': this.service.markPanesRead(args[0]); return undefined as T;
			case 'remove': this.service.remove(args[0]); return undefined as T;
			case 'syncPaneStatuses': this.service.syncPaneStatuses(args[0]); return undefined as T;
			// 開いているペインは接続（ウィンドウ）ごとに持つ。接続が切れたら外す（下の登録を参照）。
			case 'setLivePanes': this.service.setLivePanes(ctx, args[0]); return undefined as T;
			case 'requestReveal': this.service.requestReveal(args[0]); return undefined as T;
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}

ParadisSharedProcessContributions.register(PARADIS_NOTIFICATION_INBOX_CHANNEL, ({ server }) => {
	const service = new ParadisNotificationInboxService();
	server.registerChannel(PARADIS_NOTIFICATION_INBOX_CHANNEL, new ParadisNotificationInboxChannel(service));
	// ウィンドウを閉じた（再読み込みした）ら、そのウィンドウのペインを「開いている」から外す。
	// 再読み込みなら、新しい接続がすぐに同じペインを知らせ直す。
	// 接続名（ctx）は再読み込みしても変わらない。古い接続の切断が新しい接続の知らせより後に届いたときに
	// 新しいウィンドウの分まで消さないよう、同じ接続名がまだ繋がっていれば外さない。
	const listener = server.onDidRemoveConnection(connection => {
		if (!server.connections.some(candidate => candidate.ctx === connection.ctx)) {
			service.removeClient(connection.ctx);
		}
	});
	return {
		dispose: () => {
			listener.dispose();
			service.dispose();
		},
	};
});
