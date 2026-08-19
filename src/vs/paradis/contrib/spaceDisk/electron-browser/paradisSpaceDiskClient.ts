/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペース(リポジトリ/worktree)の容量を shared process / REH サーバーへ問い合わせる renderer 側の窓口。
// 「どのスペースがあるか」を知っているのは renderer だけなので、パスの解決はここで行う。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { ParadisWarmLeaseController, PARADIS_WARM_LEASE_RENEW_INTERVAL_MS } from '../../../common/paradisWarmLease.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisSpaceDiskEntry,
	IParadisSpaceDiskResult,
	IParadisSpaceDiskService,
	IParadisSpaceDiskTarget,
	IParadisSpaceDiskWorktree,
	PARADIS_SPACE_DISK_CHANNEL,
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

interface IHost {
	readonly channel: IChannel;
	readonly service: IParadisSpaceDiskService;
}

const WARM_LEASE_MAX_OPERATIONS = 128;

export class ParadisSpaceDiskClient {

	private readonly local: IHost;
	private readonly warmLeaseGenerations = new Map<string, IWarmLeaseGeneration>();
	private nextWarmLeaseGeneration = 0;

	constructor(
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ILogService private readonly logService: ILogService,
	) {
		const channel = sharedProcessService.getChannel(PARADIS_SPACE_DISK_CHANNEL);
		this.local = { channel, service: ProxyChannel.toService<IParadisSpaceDiskService>(channel) };
	}

	private remoteHost(): { host: IHost; authority: string } | undefined {
		const connection = this.remoteAgentService.getConnection();
		if (!connection) {
			return undefined;
		}
		const channel = connection.getChannel<IChannel>(PARADIS_SPACE_DISK_CHANNEL);
		return { host: { channel, service: ProxyChannel.toService<IParadisSpaceDiskService>(channel) }, authority: connection.remoteAuthority.toLowerCase() };
	}

	/**
	 * 登録済みスペースの容量を返す。
	 * 既定ではキャッシュ済みの値が即座に返り、`bypassCache` のときだけ測り直す。
	 */
	async measure(bypassCache = false): Promise<IParadisSpaceDiskResult> {
		// worktree の一覧は起動直後まだ空。待たずに測ると worktree を親から除外できず、
		// 二重計上した過大な値になる上に18倍遅くなり、その誤った結果がTTLぶん居座る。
		await this.worktreeService.initializationBarrier.catch(() => { /* 一覧が取れなくても本体は測る */ });
		const remote = this.remoteHost();
		const { localTargets, remoteTargets } = this.collectTargets(remote);
		const attempts: Promise<IParadisSpaceDiskResult>[] = [];
		if (localTargets.length > 0) {
			attempts.push(this.local.service.measure(localTargets, bypassCache));
		}
		if (remote !== undefined && remoteTargets.length > 0) {
			attempts.push(remote.host.service.measure(remoteTargets, bypassCache));
		}
		const results = await Promise.allSettled(attempts);
		const spaces: IParadisSpaceDiskEntry[] = [];
		const measuredAts: number[] = [];
		const durationMs: number[] = [];
		const rejections: unknown[] = [];
		for (const result of results) {
			if (result.status === 'fulfilled') {
				spaces.push(...result.value.spaces);
				// キャッシュヒット時はサーバー側が過去の計測時刻をそのまま返す。ここで
				// Date.now() に差し替えると、キャッシュが効いているのに「たった今計測した」
				// ことになってしまう（モバイル側の「N分前に計測」表示が壊れる）。
				measuredAts.push(result.value.measuredAt);
				durationMs.push(result.value.durationMs);
			} else {
				rejections.push(result.reason);
				this.logService.warn('[ParadisSpaceDisk] a machine failed to measure disk usage', result.reason);
			}
		}
		if (attempts.length > 0 && rejections.length === attempts.length) {
			throw rejections[0];
		}
		return {
			spaces,
			// 両マシンの結果のうち古い方に合わせる（新しい方に寄せると、まだ古いままの
			// もう一方の鮮度を過大評価してしまう）。
			measuredAt: measuredAts.length > 0 ? Math.min(...measuredAts) : Date.now(),
			// 両マシンは並行して計測するので、体感の所要時間は合計ではなく最大値。
			durationMs: durationMs.length > 0 ? Math.max(...durationMs) : 0,
		};
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

	private async sendWarmLease(ownerId: string, active: boolean): Promise<void> {
		const remote = this.remoteHost();
		const { localTargets, remoteTargets } = active ? this.collectTargets(remote) : { localTargets: [], remoteTargets: [] };
		// 対象が0件のマシンには active: false を送る。targets が空でも active: true のまま送ると、
		// そのマシンに向けた無意味な warm lease を都度更新し続けることになる上、以前そのマシンに
		// 対象があった場合の古いリースを残す側にもなりうる。
		const attempts: Promise<void>[] = [this.local.channel.call<void>('setWarmLease', [{ ownerId, active: active && localTargets.length > 0, targets: localTargets }])];
		if (remote !== undefined) {
			attempts.push(remote.host.channel.call<void>('setWarmLease', [{ ownerId, active: active && remoteTargets.length > 0, targets: remoteTargets }]));
		}
		const results = await Promise.allSettled(attempts);
		// 片方のマシンが失敗しても、もう片方が受理していれば lease 自体は成立している。
		// ここで両方待って1本でも失敗したら reject すると、ambiguousOwnerId 経由で無関係な
		// 側まで release/再取得が回る（ParadisWarmLeaseController の設計）。
		const rejections = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
		if (rejections.length === results.length) {
			throw rejections[0].reason;
		}
		for (const rejection of rejections) {
			this.logService.warn('[ParadisSpaceDisk] a machine failed to receive the warm lease', rejection.reason);
		}
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
				if (!initialized || cancellation?.aborted || this.warmLeaseGenerations.get(ownerId) !== state || state.generation !== generation || !state.active) {
					if (cancellation?.aborted && state.generation === generation) {
						state.active = false;
						state.releaseRequested = false;
						state.cancellation = undefined;
					}
					state.processedGeneration = generation;
					continue;
				}
				generation = state.generation;
				await this.sendWarmLease(ownerId, true);
			} else if (state.releaseRequested) {
				await this.sendWarmLease(ownerId, false);
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
	 * 計測対象。リポジトリと、それぞれが持つ worktree のパスを、そのスペースがあるマシン
	 * (ローカル / 接続中の SSH 接続先) ごとに分けて集める。
	 *
	 * **worktree の場所は決め打ちしない**。`IParadisWorktreeService` が返す実際の URI を
	 * そのまま渡し、親の中にあるかどうかの判定は計測側に任せる。親の中に置く人・外に置く人・
	 * WSL の UNC パスの人がいて、どれも同じ経路で扱える必要があるため。
	 *
	 * リポジトリと worktree で行き先のマシンが割れることは無い (worktree は親と同じ接続の中にしか
	 * 作れない) が、念のため worktree ごとにも判定し、一致しない場合は対象から外す。
	 */
	private collectTargets(remote: { readonly host: IHost; readonly authority: string } | undefined): { localTargets: IParadisSpaceDiskTarget[]; remoteTargets: IParadisSpaceDiskTarget[] } {
		const localTargets: IParadisSpaceDiskTarget[] = [];
		const remoteTargets: IParadisSpaceDiskTarget[] = [];
		for (const repository of this.workspaceSwitchService.repositories) {
			const isRemote = remote !== undefined && repository.uri.scheme === Schemas.vscodeRemote && repository.uri.authority.toLowerCase() === remote.authority;
			if (!isRemote && repository.uri.scheme !== Schemas.file) {
				// 別ホストの vscode-remote、または未接続なのに vscode-remote — どちらのマシンの
				// ものとも確証が持てないため、手元へ流さずスキップする。
				continue;
			}
			const worktrees: IParadisSpaceDiskWorktree[] = [];
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				// `isMainCheckout` はリポジトリ本体を一覧の1行として見せるための合成エントリで、
				// 実体は repository と同じフォルダ。worktree として数えると本体を二重に数える。
				if (worktree.isMainCheckout || worktree.missing) {
					continue;
				}
				// worktree 自身の scheme を独立して判定する（`isRemote` が false だからといって
				// worktree が file とは限らない — 親と違うマシンの worktree が紛れていた場合、
				// isRemote だけで早期判定すると素通りして誤って手元の fsPath を返してしまう）。
				const worktreeIsRemote = remote !== undefined && worktree.uri.scheme === Schemas.vscodeRemote && worktree.uri.authority.toLowerCase() === remote.authority;
				if ((!worktreeIsRemote && worktree.uri.scheme !== Schemas.file) || worktreeIsRemote !== isRemote) {
					continue;
				}
				worktrees.push({
					stateKey: paradisWorktreeStateKey(worktree.uri),
					name: worktree.name,
					path: isRemote ? worktree.uri.path : worktree.uri.fsPath,
				});
			}
			const target: IParadisSpaceDiskTarget = {
				stateKey: repository.id,
				name: repository.name,
				path: isRemote ? repository.uri.path : repository.uri.fsPath,
				worktrees,
			};
			(isRemote ? remoteTargets : localTargets).push(target);
		}
		return { localTargets, remoteTargets };
	}
}
