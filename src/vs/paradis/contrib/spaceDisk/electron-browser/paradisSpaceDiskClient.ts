/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペース(リポジトリ/worktree)の容量を shared process へ問い合わせる renderer 側の窓口。
// 「どのスペースがあるか」を知っているのは renderer だけなので、パスの解決はここで行う。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ParadisWarmLeaseController, PARADIS_WARM_LEASE_RENEW_INTERVAL_MS } from '../../../common/paradisWarmLease.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisSpaceDiskResult,
	IParadisSpaceDiskService,
	IParadisSpaceDiskTarget,
	IParadisSpaceDiskWorktree,
	PARADIS_SPACE_DISK_CHANNEL,
	ParadisSpaceDiskWarmLeasePayload,
} from '../common/paradisSpaceDisk.js';

interface IWarmLeaseGeneration {
	generation: number;
	active: boolean;
	releaseRequested: boolean;
	processedGeneration: number;
	running: Promise<void> | undefined;
	cancelBarrier: (() => void) | undefined;
	cancellation: AbortSignal | undefined;
}

const WARM_LEASE_MAX_OPERATIONS = 128;

export class ParadisSpaceDiskClient {

	private readonly service: IParadisSpaceDiskService;
	private readonly channel: IChannel;
	private readonly warmLeaseGenerations = new Map<string, IWarmLeaseGeneration>();
	private nextWarmLeaseGeneration = 0;

	constructor(
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@ISharedProcessService sharedProcessService: ISharedProcessService,
	) {
		this.channel = sharedProcessService.getChannel(PARADIS_SPACE_DISK_CHANNEL);
		this.service = ProxyChannel.toService<IParadisSpaceDiskService>(this.channel);
	}

	/**
	 * 登録済みスペースの容量を返す。
	 * 既定ではキャッシュ済みの値が即座に返り、`bypassCache` のときだけ測り直す。
	 */
	async measure(bypassCache = false): Promise<IParadisSpaceDiskResult> {
		// worktree の一覧は起動直後まだ空。待たずに測ると worktree を親から除外できず、
		// 二重計上した過大な値になる上に18倍遅くなり、その誤った結果がTTLぶん居座る。
		await this.worktreeService.initializationBarrier.catch(() => { /* 一覧が取れなくても本体は測る */ });
		return this.service.measure(this.collectTargets(), bypassCache);
	}

	/** mobile provider などが owner-scoped lease を1回更新する。 */
	setWarmLease(ownerId: string, active: boolean, cancellation?: AbortSignal): Promise<void> {
		const state = this.updateWarmLeaseGeneration(ownerId, active, true, cancellation);
		return state ? this.startWarmLeaseReconcile(ownerId, state) : Promise.resolve();
	}

	/** desktop consumer が生存する間、5分ごとに current target snapshot を renew する。 */
	createWarmLease(): IDisposable {
		const ownerId = `space-disk:${generateUuid()}`;
		const controller = new ParadisWarmLeaseController(
			() => this.setWarmLease(ownerId, true),
			() => this.setWarmLease(ownerId, true),
			() => this.setWarmLease(ownerId, false),
			runner => new RunOnceScheduler(runner, PARADIS_WARM_LEASE_RENEW_INTERVAL_MS),
			() => ownerId,
		);
		controller.setEnabled(true);
		let disposed = false;
		return toDisposable(() => {
			if (disposed) {
				return;
			}
			disposed = true;
			// barrier 待機中の acquire を無効化してから controller の補償 release へ渡す。
			this.updateWarmLeaseGeneration(ownerId, false, false);
			controller.dispose();
		});
	}

	private sendWarmLease(payload: ParadisSpaceDiskWarmLeasePayload): Promise<void> {
		return this.channel.call<void>('setWarmLease', [payload]);
	}

	private updateWarmLeaseGeneration(ownerId: string, active: boolean, releaseRequested: boolean, cancellation?: AbortSignal): IWarmLeaseGeneration | undefined {
		let state = this.warmLeaseGenerations.get(ownerId);
		if (!state) {
			if (this.warmLeaseGenerations.size >= WARM_LEASE_MAX_OPERATIONS) {
				return undefined;
			}
			state = { generation: 0, active, releaseRequested, processedGeneration: 0, running: undefined, cancelBarrier: undefined, cancellation: undefined };
			this.warmLeaseGenerations.set(ownerId, state);
		}
		state.generation = ++this.nextWarmLeaseGeneration;
		state.active = active;
		state.releaseRequested = releaseRequested && !active;
		state.cancellation = active ? cancellation : undefined;
		if (!active) {
			state.cancelBarrier?.();
		}
		return state;
	}

	private startWarmLeaseReconcile(ownerId: string, state: IWarmLeaseGeneration): Promise<void> {
		if (state.running) {
			return state.running;
		}
		const running = this.reconcileWarmLease(ownerId, state).finally(() => {
			if (state.running === running) {
				state.running = undefined;
				this.cleanupWarmLeaseGeneration(ownerId, state);
			}
		});
		state.running = running;
		return running;
	}

	private async reconcileWarmLease(ownerId: string, state: IWarmLeaseGeneration): Promise<void> {
		while (state.processedGeneration !== state.generation) {
			let generation = state.generation;
			if (state.active) {
				const cancellation = state.cancellation;
				const initialized = await this.waitForInitialization(state, cancellation);
				if (!initialized || this.warmLeaseGenerations.get(ownerId) !== state || !state.active) {
					if (!initialized && cancellation?.aborted && state.generation === generation) {
						state.active = false;
						state.releaseRequested = false;
						state.cancellation = undefined;
					}
					state.processedGeneration = generation;
					continue;
				}
				generation = state.generation;
				await this.sendWarmLease({ ownerId, active: true, targets: this.collectTargets() });
			} else if (state.releaseRequested) {
				await this.sendWarmLease({ ownerId, active: false, targets: [] });
			}
			state.processedGeneration = generation;
		}
	}

	private waitForInitialization(state: IWarmLeaseGeneration, cancellation: AbortSignal | undefined): Promise<boolean> {
		if (cancellation?.aborted) {
			return Promise.resolve(false);
		}
		let cancel!: () => void;
		const cancelled = new Promise<boolean>(resolve => cancel = () => resolve(false));
		const onAbort = () => cancel();
		cancellation?.addEventListener('abort', onAbort, { once: true });
		state.cancelBarrier = cancel;
		return Promise.race([
			this.worktreeService.initializationBarrier.then(() => true, () => true),
			cancelled,
		]).finally(() => {
			cancellation?.removeEventListener('abort', onAbort);
			if (state.cancelBarrier === cancel) {
				state.cancelBarrier = undefined;
			}
		});
	}

	private cleanupWarmLeaseGeneration(ownerId: string, state: IWarmLeaseGeneration): void {
		if (this.warmLeaseGenerations.get(ownerId) === state && !state.active && state.running === undefined && state.cancelBarrier === undefined) {
			this.warmLeaseGenerations.delete(ownerId);
		}
	}

	/**
	 * 計測対象。リポジトリと、それぞれが持つ worktree のパスを集める。
	 *
	 * **worktree の場所は決め打ちしない**。`IParadisWorktreeService` が返す実際の URI を
	 * そのまま渡し、親の中にあるかどうかの判定は計測側に任せる。親の中に置く人・外に置く人・
	 * WSL の UNC パスの人がいて、どれも同じ経路で扱える必要があるため。
	 *
	 * リモート(SSH/WSLのremote拡張経由)のスペースは、この shared process からは
	 * ファイルとして見えないので対象から外す。見えないものを測ろうとして毎回失敗するより、
	 * 一覧に出さないほうが正直になる。
	 */
	private collectTargets(): IParadisSpaceDiskTarget[] {
		const targets: IParadisSpaceDiskTarget[] = [];
		for (const repository of this.workspaceSwitchService.repositories) {
			if (repository.uri.scheme !== Schemas.file) {
				continue;
			}
			const worktrees: IParadisSpaceDiskWorktree[] = [];
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				// `isMainCheckout` はリポジトリ本体を一覧の1行として見せるための合成エントリで、
				// 実体は repository と同じフォルダ。worktree として数えると本体を二重に数える。
				if (worktree.isMainCheckout || worktree.missing || worktree.uri.scheme !== Schemas.file) {
					continue;
				}
				worktrees.push({
					stateKey: paradisWorktreeStateKey(worktree.uri),
					name: worktree.name,
					path: worktree.uri.fsPath,
				});
			}
			targets.push({
				stateKey: repository.id,
				name: repository.name,
				path: repository.uri.fsPath,
				worktrees,
			});
		}
		return targets;
	}
}
