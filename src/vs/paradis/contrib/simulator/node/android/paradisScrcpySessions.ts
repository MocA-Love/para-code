/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Android の端末ごとの scrcpy の通話を、使う側（ペインの映像・エージェントの 2 本指や日本語の入力）で分け合う
// （q.html Q585 の ⑥b）。最初に使うときに起こし、誰も使わなくなって {@link IDLE_MS} 経ったら止める。
// 落ちたら次に使うときに起こし直す。

import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ParadisScrcpySession, IParadisScrcpySessionOptions } from './paradisScrcpySession.js';

/** 誰も使わなくなってから止めるまで。 */
const IDLE_MS = 30_000;

interface IEntry {
	/** options を待ち終えるまでは undefined。 */
	session: ParadisScrcpySession | undefined;
	started: Promise<ParadisScrcpySession>;
	users: number;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	endListener?: IDisposable;
}

export type ParadisScrcpySessionFactory = (serial: string) => Promise<Omit<IParadisScrcpySessionOptions, 'serial'>>;

export class ParadisScrcpySessions extends Disposable {

	private readonly _entries = new Map<string, IEntry>();

	constructor(
		private readonly _options: ParadisScrcpySessionFactory,
		private readonly _logService: ILogService,
		private readonly _idleMs = IDLE_MS,
	) {
		super();
		this._register(toDisposable(() => {
			for (const entry of this._entries.values()) {
				if (entry.idleTimer) {
					clearTimeout(entry.idleTimer);
				}
				entry.endListener?.dispose();
				entry.session?.dispose();
			}
			this._entries.clear();
		}));
	}

	/** その端末の通話を使い始める。返した IDisposable を dispose したら使い終わり。 */
	async acquire(serial: string): Promise<{ readonly session: ParadisScrcpySession; readonly lease: IDisposable }> {
		let entry = this._entries.get(serial);
		if (entry?.session?.ended) {
			this._drop(serial, entry);
			entry = undefined;
		}
		if (!entry) {
			// 台帳へは await の前に入れる（初めての 2 件が重なっても、通話を 2 つ立てないように）。
			// options を待つのも、通話を始めるのも started の中で行う
			const created: IEntry = { session: undefined, started: undefined!, users: 0, idleTimer: undefined };
			created.started = (async () => {
				const options = await this._options(serial);
				if (this._entries.get(serial) !== created) {
					throw new Error('The Android connection was closed before it started');
				}
				const session = new ParadisScrcpySession({ ...options, serial }, this._logService);
				created.session = session;
				created.endListener = session.onDidEnd(() => {
					if (this._entries.get(serial) === created) {
						this._drop(serial, created);
					}
				});
				await session.start();
				return session;
			})();
			created.started.catch(() => {
				if (this._entries.get(serial) === created) {
					this._drop(serial, created);
				}
			});
			this._entries.set(serial, created);
			entry = created;
		}
		const current = entry;
		current.users++;
		if (current.idleTimer) {
			clearTimeout(current.idleTimer);
			current.idleTimer = undefined;
		}
		let released = false;
		const lease = toDisposable(() => {
			if (released) {
				return;
			}
			released = true;
			current.users--;
			if (current.users === 0 && this._entries.get(serial) === current) {
				current.idleTimer = setTimeout(() => this._drop(serial, current), this._idleMs);
			}
		});
		try {
			return { session: await current.started, lease };
		} catch (error) {
			lease.dispose();
			throw error;
		}
	}

	/** その端末の通話を、少しの間だけ使う（エージェントの 1 回の操作）。 */
	async use<T>(serial: string, run: (session: ParadisScrcpySession) => Promise<T>): Promise<T> {
		const { session, lease } = await this.acquire(serial);
		try {
			return await run(session);
		} finally {
			lease.dispose();
		}
	}

	private _drop(serial: string, entry: IEntry): void {
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
		}
		if (this._entries.get(serial) === entry) {
			this._entries.delete(serial);
		}
		entry.endListener?.dispose();
		entry.session?.dispose();
	}
}
