/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の片付けの台帳（`paradisNotifyDismissLedger.ts`）をディスクに残し、回答の成立（hook）で許可・質問を片付ける。
//
// 保存先は userData の `paradis-mobile-notify-dismiss.json`（0600、原子的に置き換える）。設計書の保存層（Q234 A の SQLite）が
// 入るまでは、push の outbox と同じ小さな JSON に載せる。件数と期間の上限は台帳が持つ（200 件・7 日）。書き込みは
// まとめて 1 秒に 1 回まで。書き損じても通知の配送には影響させない（次の変化で書き直す）。

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { IParadisAgentHookEvent, onParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { ParadisNotifyDismissLedger, paradisNotifyAnswerFromHook } from '../common/paradisNotifyDismissLedger.js';

const SAVE_DELAY_MS = 1_000;

export interface IParadisNotifyDismissStoreHost {
	read(): Promise<string | undefined>;
	write(content: string): Promise<void>;
	warn(message: string, error?: unknown): void;
	now?(): number;
	/** hook の出来事を購読するか（テストでは購読せず {@link ParadisNotifyDismissStore.handleHookEvent} を直接呼ぶ）。 */
	readonly subscribeHooks?: boolean;
}

/** ファイルを読み書きする既定の host。 */
export function paradisNotifyDismissFileHost(path: string, warn: (message: string, error?: unknown) => void): IParadisNotifyDismissStoreHost {
	return {
		read: async () => {
			try {
				return await fs.readFile(path, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
					return undefined;
				}
				throw error;
			}
		},
		write: content => paradisWriteFileAtomic(path, content, { forceMode: 0o600 }),
		warn,
	};
}

/** エージェントトークンを台帳に残す形（生のトークンはディスクへ書かない）。 */
function tokenKey(token: string): string {
	return createHash('sha256').update(`para.notify.dismiss\n${token}`).digest('base64url').slice(0, 32);
}

export class ParadisNotifyDismissStore extends Disposable {

	readonly ledger = new ParadisNotifyDismissLedger({ tokenKey });

	/** hook で回答が成立して片付いた通知 ID（スマホへ `dismissed` を送るため）。 */
	private readonly _onDidAnswer = this._register(new Emitter<readonly string[]>());
	readonly onDidAnswer = this._onDidAnswer.event;

	/** 読み終えた（読めなかったときも解決する）。 */
	readonly ready: Promise<void>;

	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private saving: Promise<void> = Promise.resolve();
	private loaded = false;
	private dirty = false;

	constructor(private readonly host: IParadisNotifyDismissStoreHost) {
		super();
		this.ready = this.load();
		if (host.subscribeHooks !== false) {
			this._register(onParadisAgentHookEvent(event => this.handleHookEvent(event)));
		}
		this._register(toDisposable(() => {
			if (this.saveTimer !== undefined) {
				clearTimeout(this.saveTimer);
				this.saveTimer = undefined;
				// 閉じる直前の変化も残す（待たない）。
				void this.flush();
			}
		}));
	}

	private now(): number {
		return this.host.now?.() ?? Date.now();
	}

	private async load(): Promise<void> {
		try {
			this.ledger.restore(await this.host.read(), this.now());
		} catch (error) {
			this.host.warn('[paradisMobileRelay] failed to read the notification dismiss ledger', error);
		}
		this.loaded = true;
		if (this.dirty) {
			this.changed();
		}
	}

	/** 台帳が変わった。少し待ってまとめて書く。 */
	changed(): void {
		this.dirty = true;
		if (!this.loaded || this.saveTimer !== undefined) {
			return; // 読み終える前に書くと、読む前の台帳を消してしまう
		}
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush();
		}, SAVE_DELAY_MS);
	}

	/** 今の台帳を書く（テストと閉じるとき）。 */
	flush(): Promise<void> {
		if (!this.loaded || !this.dirty) {
			return this.saving;
		}
		this.dirty = false;
		const content = this.ledger.serialize(this.now());
		this.saving = this.saving
			.then(() => this.host.write(content))
			.catch(error => {
				this.dirty = true;
				this.host.warn('[paradisMobileRelay] failed to save the notification dismiss ledger', error);
			});
		return this.saving;
	}

	/** hook の出来事で、そのエージェントの許可・質問の回答が成立したなら片付ける。 */
	handleHookEvent(event: Pick<IParadisAgentHookEvent, 'token' | 'event' | 'toolUseId' | 'payload' | 'ownerUnverified'> & { readonly sessionId?: string; readonly at?: number }): void {
		const answer = paradisNotifyAnswerFromHook(event.event, event.toolUseId, { ownerUnverified: event.ownerUnverified === true, payload: event.payload, sessionId: event.sessionId });
		if (answer === undefined || event.token.length === 0) {
			return;
		}
		const settled = this.ledger.markAnswered(event.token, answer.interactionId, event.at ?? this.now(), answer.origin, answer.wholeSession === true);
		if (settled.length > 0) {
			this.changed();
			this._onDidAnswer.fire(settled);
		}
	}
}
