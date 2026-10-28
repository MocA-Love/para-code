/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';

/** 止まっている間に、前面に戻ったかを確かめ直す間隔。確かめるのは IPC 1 回で、git は投げない。 */
const RECHECK_INTERVAL_MS = 10_000;

type ParadisWindowActivityHost = Pick<IHostService, 'hasFocus' | 'onDidChangeFocus' | 'hadLastFocus'>;

/** ウィンドウの document の見え方だけを読む最小の形（テストで差し替える）。 */
export interface IParadisWindowVisibility {
	readonly hidden: boolean;
	readonly onDidChange: Event<unknown>;
}

/**
 * Para Code のウィンドウが表に出ているか（最小化されておらず、フォーカスが Para Code にある）。
 *
 * `IHostService.hasFocus` だけで決めると、内蔵ブラウザ（別の WebContents）にフォーカスがある間は、表にいても
 * false になる。そこで hasFocus が false のときは `hadLastFocus()`（OS が見ている前面のウィンドウがこれか）で
 * 確かめ直す。Web では hadLastFocus が常に true なので、見えている間は止めない。
 *
 * `onDidChangeFocus` は同じ値が続くと鳴らない。ほかのアプリから内蔵ブラウザを直接クリックして戻ると hasFocus は
 * false のままで知らせが来ないので、止まっている間（最小化を除く）は {@link RECHECK_INTERVAL_MS} ごとに確かめ直す。
 */
export class ParadisWorkspacesWindowActivity extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private active: boolean;
	private sequence = 0;
	private readonly recheck = this._register(new RunOnceScheduler(() => this.update(), RECHECK_INTERVAL_MS));

	constructor(
		private readonly hostService: ParadisWindowActivityHost,
		private readonly visibility: IParadisWindowVisibility,
	) {
		super();
		this.active = !visibility.hidden && hostService.hasFocus;
		this._register(hostService.onDidChangeFocus(() => this.update()));
		this._register(visibility.onDidChange(() => this.update()));
		if (!this.active) {
			this.update();
		}
	}

	get isActive(): boolean {
		return this.active;
	}

	private update(): void {
		const sequence = ++this.sequence;
		if (this.visibility.hidden) {
			this.set(false);
			return;
		}
		if (this.hostService.hasFocus) {
			this.set(true);
			return;
		}
		this.hostService.hadLastFocus().then(hadFocus => {
			if (sequence === this.sequence && !this._store.isDisposed) {
				this.set(!this.visibility.hidden && (this.hostService.hasFocus || hadFocus));
			}
		}, () => {
			if (sequence === this.sequence && !this._store.isDisposed) {
				this.set(false);
			}
		});
	}

	private set(active: boolean): void {
		if (!active && !this.visibility.hidden) {
			this.recheck.schedule();
		} else {
			this.recheck.cancel();
		}
		if (this.active !== active) {
			this.active = active;
			this._onDidChange.fire();
		}
	}
}
