/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// hook の自動設置を設定（`paradis.agentHooks.enabled`）に合わせて入れたり止めたりする。
//
// 決まりは3つだけ:
//  - オンの間は今までどおり設置し、消されたら置き直す（`ParadisAgentHooksReconciler`）
//  - オフに**切り替わったその時だけ**、Para Code が置いた hook を取り外す
//  - 起動した時点でオフなら、何もしない（設置もしないし、取り外しもしない）
//
// 起動時に取り外さないのは、hook の設定ファイル（~/.claude/settings.json・~/.codex/hooks.json）が
// PC 全体で1つしかないため。同じ PC で動く別の Para Code（開発版など）がオンで使っている hook を、
// こちらが起動するたびに消してしまう。

import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/** 設置を続ける側（`ParadisAgentHooksReconciler`）のうち、ここで使うところ。 */
export interface IParadisAgentHooksInstaller extends IDisposable {
	start(): Promise<void>;
	/** 走っている設置が終わるのを待つ。取り外しがそれに上書きされないようにするため。 */
	whenIdle(): Promise<void>;
}

export interface IParadisAgentHooksAutoInstallOptions {
	readonly isEnabled: () => boolean;
	/** 設定が変わったかもしれないときに発火する（値が同じでもよい。ここで比べる）。 */
	readonly onDidChangeEnabled: Event<void>;
	readonly createInstaller: () => IParadisAgentHooksInstaller;
	readonly removeHooks: () => Promise<void>;
	readonly logService: ILogService;
	/** 設置の開始に失敗したとき（既定はログだけ）。 */
	readonly onInstallError?: (error: unknown) => void;
}

export class ParadisAgentHooksAutoInstall extends Disposable {

	private readonly installer = this._register(new MutableDisposable<IParadisAgentHooksInstaller>());
	/** いま設置を続けているか。起動時は「まだ何もしていない」から始める。 */
	private installing = false;
	/** 切り替えを1つずつ順に処理する（オフ→オンが速く続いても、取り外しと設置が交差しない）。 */
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly options: IParadisAgentHooksAutoInstallOptions) {
		super();
		this._register(options.onDidChangeEnabled(() => this.apply()));
		if (options.isEnabled()) {
			// 起動時の設置はその場で始める。直後にオフへ切り替わっても、この設置の後に取り外しが並ぶ
			this.installing = true;
			this.queue = this.startInstaller();
		} else {
			options.logService.info('[ParadisAgentHooks] automatic hook setup is turned off; not installing (and not removing) agent hooks');
		}
	}

	/** 待っている切り替えがすべて済むまで待つ（テスト用）。 */
	whenIdle(): Promise<void> {
		return this.queue;
	}

	private async startInstaller(): Promise<void> {
		const installer = this.options.createInstaller();
		this.installer.value = installer;
		try {
			await installer.start();
		} catch (error) {
			if (this.options.onInstallError) {
				this.options.onInstallError(error);
			} else {
				this.options.logService.warn('[ParadisAgentHooks] Agent hooks setup failed', error);
			}
		}
	}

	private apply(): void {
		const run = () => this.applyNow();
		this.queue = this.queue.then(run, run);
	}

	private async applyNow(): Promise<void> {
		if (this._store.isDisposed) {
			return;
		}
		const wanted = this.options.isEnabled();
		if (wanted === this.installing) {
			return;
		}
		this.installing = wanted;
		if (wanted) {
			await this.startInstaller();
			return;
		}
		// 走っている設置が後から書き込んで、取り外した hook を戻してしまわないよう、止めてから待つ
		const installer = this.installer.value;
		const idle = installer?.whenIdle();
		this.installer.clear();
		await idle?.catch(() => undefined);
		this.options.logService.info('[ParadisAgentHooks] automatic hook setup was turned off; removing the hooks Para Code installed');
		try {
			await this.options.removeHooks();
		} catch (error) {
			this.options.logService.warn('[ParadisAgentHooks] Failed to remove agent hooks', error);
		}
	}
}
