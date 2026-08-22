/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Sequencer } from '../../../../base/common/async.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkingCopyIdentifier } from './workingCopy.js';

export const IWorkingCopyBackupRestoreRouter = createDecorator<IWorkingCopyBackupRestoreRouter>('workingCopyBackupRestoreRouter');

export const enum WorkingCopyBackupRestoreDecision {
	Restore,
	Defer
}

export interface IWorkingCopyBackupRestoreRouteProvider {
	route(identifier: IWorkingCopyIdentifier): WorkingCopyBackupRestoreDecision | Promise<WorkingCopyBackupRestoreDecision>;
}

export interface IWorkingCopyBackupRestoreRouter {
	readonly _serviceBrand: undefined;

	registerProvider(provider: IWorkingCopyBackupRestoreRouteProvider): IDisposable;
	registerRestorer(restorer: () => Promise<void>): IDisposable;
	route(identifier: IWorkingCopyIdentifier): Promise<WorkingCopyBackupRestoreDecision>;
	requestRestore(): Promise<void>;
}

/**
 * Opt-in routing authority for Working Copy backup restoration. Without a
 * provider every backup follows the upstream restore behavior.
 */
export class WorkingCopyBackupRestoreRouter extends Disposable implements IWorkingCopyBackupRestoreRouter {

	declare readonly _serviceBrand: undefined;

	private readonly providers = new Set<IWorkingCopyBackupRestoreRouteProvider>();
	private readonly restorers = new Set<() => Promise<void>>();
	private readonly restoreSequencer = new Sequencer();
	/** まだ始まっていない復元パス。同tick内の複数要求をこれに合流させる。 */
	private pendingRestore: Promise<void> | undefined;

	registerProvider(provider: IWorkingCopyBackupRestoreRouteProvider): IDisposable {
		this.providers.add(provider);
		return toDisposable(() => this.providers.delete(provider));
	}

	registerRestorer(restorer: () => Promise<void>): IDisposable {
		this.restorers.add(restorer);
		return toDisposable(() => this.restorers.delete(restorer));
	}

	async route(identifier: IWorkingCopyIdentifier): Promise<WorkingCopyBackupRestoreDecision> {
		for (const provider of this.providers) {
			if (await provider.route(identifier) === WorkingCopyBackupRestoreDecision.Defer) {
				return WorkingCopyBackupRestoreDecision.Defer;
			}
		}

		return WorkingCopyBackupRestoreDecision.Restore;
	}

	/**
	 * 復元パスを要求する。
	 *
	 * PARA-PATCH: パスが始まる前に届いた要求を同一パスへ合流する。ハンドラ登録とスペース
	 * 切替が同じtickに複数回発火すると、旧実装はSequencerの直列化だけで合流しないため
	 * 「Deferされた全バックアップの再評価」を要求回数分まるごと繰り返していた。マイクロタスクで
	 * 合流することで1回の走査にまとまる。
	 *
	 * パスが**開始した後**に届いた要求は従来どおり次のパスとしてSequencerに並ぶ。route()の判定は
	 * 呼び出し側の状態(切替中フラグ等)に依存するため、「状態を変えてからawaitする」呼び出しには
	 * 自分の状態変更を観測する新しいパスが必要だから(合流の対象は未開始の要求だけ)。
	 */
	requestRestore(): Promise<void> {
		if (!this.pendingRestore) {
			this.pendingRestore = Promise.resolve().then(() => {
				// ここで合流の窓を閉じる。以後の要求は新しいパスとしてSequencerに並ぶ
				this.pendingRestore = undefined;
				return this.restoreSequencer.queue(async () => {
					await Promise.allSettled([...this.restorers].map(restorer => restorer()));
				});
			});
		}
		return this.pendingRestore;
	}
}

registerSingleton(IWorkingCopyBackupRestoreRouter, WorkingCopyBackupRestoreRouter, InstantiationType.Delayed);
