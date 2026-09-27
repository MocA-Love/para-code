/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	IParadisInboxEntry,
	IParadisInboxPaneStatus,
	IParadisInboxRecordInput,
	IParadisInboxSnapshot,
	PARADIS_NOTIFICATION_INBOX_LIMIT,
	paradisInboxAttentionPaneCount,
} from './paradisNotificationInbox.js';

type MutableEntry = Omit<IParadisInboxEntry, 'read' | 'live'> & { read: boolean };

/**
 * 通知の台帳本体（shared process で1つだけ動く）。I/O を持たない純粋なクラスで、変更系の
 * メソッドは「中身が変わったか」を返す。変わったときだけ呼び出し側が知らせを出す。
 *
 * 既読になる条件:
 * - 受信箱で行を押した・「既読にする」「すべて既読にする」を押した
 * - そのペインへフォーカスした（{@link markPanesRead}）
 * - ペインの状態が通知の種類から変わった（{@link syncPaneStatuses}）。完了の通知はスペースを
 *   見て確認済みになった（または次の作業を始めた）とき、許可待ち・質問の通知は答えたとき
 *   （モバイルから答えた場合も含む）に既読になる
 *
 * 件数（要対応のペイン数）には、いまもどれかのウィンドウに開いているペインだけを数える。
 * 開いているペインは各ウィンドウが {@link setLivePanes} で知らせ、ウィンドウとの接続が
 * 切れたら {@link removeClient} で外す。
 */
export class ParadisNotificationInboxLedger {

	private readonly entries: MutableEntry[] = [];
	private readonly livePanesByClient = new Map<string, ReadonlySet<string>>();
	/** ペインごとに最後に知らされた状態。記録が状態の知らせより遅れて届いたときに使う。 */
	private readonly lastStatusByPane = new Map<string, IParadisInboxPaneStatus['status']>();
	private sequence = 0;
	private revision = 0;

	constructor(
		private readonly now: () => number = Date.now,
		private readonly limit = PARADIS_NOTIFICATION_INBOX_LIMIT,
	) { }

	record(input: IParadisInboxRecordInput): IParadisInboxEntry {
		const entry: MutableEntry = {
			kind: input.kind,
			paneKey: input.paneKey,
			instanceId: input.instanceId,
			windowId: input.windowId,
			...(input.stateKey !== undefined ? { stateKey: input.stateKey } : {}),
			space: input.space,
			...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
			...(input.tab !== undefined ? { tab: input.tab } : {}),
			...(input.message !== undefined ? { message: input.message } : {}),
			delivery: input.delivery,
			id: String(++this.sequence),
			at: this.now(),
			// 記録より先に「もう別の状態になった」と知らされていれば（本文の取得を待つ間に確認された等）、
			// 最初から既読で入れる。未読のまま入れると、次に状態が変わるまで件数に残り続ける。
			read: input.read === true || (this.lastStatusByPane.has(input.paneKey) && this.lastStatusByPane.get(input.paneKey) !== input.kind),
		};
		this.entries.unshift(entry);
		if (this.entries.length > this.limit) {
			this.entries.length = this.limit;
		}
		return this.toEntry(entry, this.livePanes());
	}

	get(id: string): IParadisInboxEntry | undefined {
		const entry = this.entries.find(candidate => candidate.id === id);
		return entry ? this.toEntry(entry, this.livePanes()) : undefined;
	}

	markRead(ids: readonly string[]): boolean {
		const targets = new Set(ids);
		return this.update(entry => targets.has(entry.id) && !entry.read, true);
	}

	markUnread(id: string): boolean {
		return this.update(entry => entry.id === id && entry.read, false);
	}

	markAllRead(): boolean {
		return this.update(entry => !entry.read, true);
	}

	markPanesRead(tokens: readonly string[]): boolean {
		const targets = new Set(tokens);
		return this.update(entry => targets.has(entry.paneKey) && !entry.read, true);
	}

	remove(id: string): boolean {
		const index = this.entries.findIndex(entry => entry.id === id);
		if (index < 0) {
			return false;
		}
		this.entries.splice(index, 1);
		return true;
	}

	/** ペインの状態が通知の種類と違っていたら、そのペインの未読を既読にする。 */
	syncPaneStatuses(statuses: readonly IParadisInboxPaneStatus[]): boolean {
		const statusByPane = new Map(statuses.map(status => [status.paneKey, status.status]));
		for (const [paneKey, status] of statusByPane) {
			this.lastStatusByPane.set(paneKey, status);
		}
		return this.update(entry => !entry.read && statusByPane.has(entry.paneKey) && statusByPane.get(entry.paneKey) !== entry.kind, true);
	}

	/** あるウィンドウ（接続）がいま開いているペインを丸ごと置き換える。 */
	setLivePanes(client: string, tokens: readonly string[]): boolean {
		const before = this.attentionSignature();
		this.livePanesByClient.set(client, new Set(tokens));
		return before !== this.attentionSignature();
	}

	removeClient(client: string): boolean {
		const panes = this.livePanesByClient.get(client);
		if (panes === undefined) {
			return false;
		}
		const before = this.attentionSignature();
		this.livePanesByClient.delete(client);
		const live = this.livePanes();
		for (const paneKey of panes) {
			if (!live.has(paneKey)) {
				this.lastStatusByPane.delete(paneKey);
			}
		}
		return before !== this.attentionSignature();
	}

	/** 変更系のメソッドが true を返したら呼ぶ（スナップショットの番号を進める）。 */
	bumpRevision(): void {
		this.revision++;
	}

	snapshot(): IParadisInboxSnapshot {
		const live = this.livePanes();
		const entries = this.entries.map(entry => this.toEntry(entry, live));
		return {
			entries,
			attentionPaneCount: paradisInboxAttentionPaneCount({ entries }),
			unreadCount: entries.filter(entry => !entry.read).length,
			revision: this.revision,
		};
	}

	private update(predicate: (entry: MutableEntry) => boolean, read: boolean): boolean {
		let changed = false;
		for (const entry of this.entries) {
			if (predicate(entry)) {
				entry.read = read;
				changed = true;
			}
		}
		return changed;
	}

	private livePanes(): ReadonlySet<string> {
		const live = new Set<string>();
		for (const tokens of this.livePanesByClient.values()) {
			for (const token of tokens) {
				live.add(token);
			}
		}
		return live;
	}

	/** 表示に影響する「どの行が開いているペインのものか」の指紋。 */
	private attentionSignature(): string {
		const live = this.livePanes();
		return this.entries.map(entry => live.has(entry.paneKey) ? '1' : '0').join('');
	}

	private toEntry(entry: MutableEntry, live: ReadonlySet<string>): IParadisInboxEntry {
		return { ...entry, live: live.has(entry.paneKey) };
	}
}
