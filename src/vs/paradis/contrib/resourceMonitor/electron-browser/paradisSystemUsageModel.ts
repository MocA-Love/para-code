/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// システム使用率の履歴を、画面（タイトルバー・パネル・エディタ・モバイルの「システム」）に渡す側。
//
// マシンは「このコンピューター」（shared process が測る）と、SSH のウィンドウなら「接続先」（REH が測る）の 2 台。
// 段（5 秒刻み・1 分刻み）ごとに手元の写しを持ち、2 回目からは `since` を付けて差分だけを取る。
// 同じウィンドウの中の画面どうしは写しを共有する（タイトルバーとエディタが別々に全点を取らない）。
//
// 接続先が古い REH（履歴のコマンドを知らない）なら、今の値（getHostResources）だけを返し `legacy` を立てる。

import { localize } from '../../../../nls.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { Schemas } from '../../../../base/common/network.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisHostResources, PARADIS_HOST_RESOURCES_CHANNEL } from '../common/paradisResourceMonitor.js';
import {
	IParadisSystemUsageMachine,
	IParadisSystemUsageRequest,
	IParadisSystemUsageResponse,
	IParadisSystemUsageSample,
	PARADIS_SYSTEM_USAGE_CHANNEL,
	PARADIS_SYSTEM_USAGE_COMMAND,
	PARADIS_SYSTEM_USAGE_VERSION,
	ParadisSystemUsageMetric,
	ParadisSystemUsageRange,
	ParadisSystemUsageTier,
	paradisDecodeSystemUsageSeries,
	paradisIsSystemUsageUnsupportedError,
	paradisMergeSystemUsageSamples,
	paradisParseSystemUsageSample,
	paradisSystemUsageRangeSpec,
	paradisSystemUsageTierCapacity,
	paradisSystemUsageWindow,
} from '../common/paradisSystemUsage.js';

export type ParadisSystemUsageMachineId = 'local' | 'remote';

export interface IParadisSystemUsageMachineEntry {
	readonly id: ParadisSystemUsageMachineId;
	readonly label: string;
}

/** 1 台・1 つの時間の幅ぶんの、画面に出す値。 */
export interface IParadisSystemUsageView {
	readonly machineId: ParadisSystemUsageMachineId;
	readonly label: string;
	readonly range: ParadisSystemUsageRange;
	readonly machine: IParadisSystemUsageMachine | undefined;
	/** 接続先の Para Code が古く、履歴が無い（`latest` だけ）。 */
	readonly legacy: boolean;
	/** 取れなかった理由（取れていれば undefined）。 */
	readonly error: string | undefined;
	readonly unsupported: readonly ParadisSystemUsageMetric[];
	/** 時間の幅に入る点（古い順）。 */
	readonly samples: readonly IParadisSystemUsageSample[];
	readonly windowStart: number;
	readonly windowEnd: number;
	readonly windowMs: number;
	readonly stepMs: number;
	/** 今の値（細かい段の最新の点）。 */
	readonly latest: IParadisSystemUsageSample | undefined;
}

export const IParadisSystemUsageModel = createDecorator<IParadisSystemUsageModel>('paradisSystemUsageModel');

export interface IParadisSystemUsageModel {
	readonly _serviceBrand: undefined;
	/** 選べるマシン（このコンピューター、SSH のウィンドウなら接続先も）。 */
	getMachines(): IParadisSystemUsageMachineEntry[];
	/** 最初に選んでおくマシン（SSH のウィンドウなら接続先）。 */
	getDefaultMachineId(): ParadisSystemUsageMachineId;
	/** 差分を取り、写しを更新して返す。 */
	refresh(machineId: ParadisSystemUsageMachineId, range: ParadisSystemUsageRange): Promise<IParadisSystemUsageView>;
	/**
	 * 写しを通さずに 1 回問い合わせる（モバイルへの中継用。モバイルは自分で写しを持つ）。
	 * 古い REH は undefined。
	 */
	fetchRaw(machineId: ParadisSystemUsageMachineId, request: IParadisSystemUsageRequest): Promise<IParadisSystemUsageResponse | undefined>;
}

interface IParadisSystemUsageTierCache {
	instanceId: string | undefined;
	samples: IParadisSystemUsageSample[];
}

interface IParadisSystemUsageMachineCache {
	readonly tiers: Map<ParadisSystemUsageTier, IParadisSystemUsageTierCache>;
	machine: IParadisSystemUsageMachine | undefined;
	unsupported: readonly ParadisSystemUsageMetric[];
	latest: IParadisSystemUsageSample | undefined;
	legacy: boolean;
	error: string | undefined;
}

/** ホスト名の最初の区切りまで（`dev-server.example.com` → `dev-server`）。 */
function shortHostname(hostname: string): string {
	const short = hostname.split('.')[0];
	return short.length > 0 ? short : hostname;
}

/** 古い REH の今の値を、1 点の形にする。 */
function sampleFromHostResources(host: IParadisHostResources): IParadisSystemUsageSample {
	const disk = host.disks[0];
	const percent = (used: number, total: number) => total > 0 ? Math.round(Math.min(100, Math.max(0, (used / total) * 100)) * 10) / 10 : undefined;
	const mem = percent(host.memory.used, host.memory.total);
	const diskPercent = disk !== undefined ? percent(disk.total - disk.free, disk.total) : undefined;
	return {
		t: host.collectedAt,
		...(host.cpu !== undefined ? { cpu: Math.round(host.cpu * 10) / 10 } : {}),
		...(mem !== undefined ? { mem } : {}),
		...(diskPercent !== undefined ? { disk: diskPercent } : {}),
	};
}

export class ParadisSystemUsageModel implements IParadisSystemUsageModel {

	declare readonly _serviceBrand: undefined;

	private readonly caches = new Map<ParadisSystemUsageMachineId, IParadisSystemUsageMachineCache>();
	private readonly inflight = new Map<string, Promise<void>>();

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ILabelService private readonly labelService: ILabelService,
	) { }

	getMachines(): IParadisSystemUsageMachineEntry[] {
		const machines: IParadisSystemUsageMachineEntry[] = [{ id: 'local', label: this.labelOf('local') }];
		if (this.remoteAgentService.getConnection() !== null) {
			machines.push({ id: 'remote', label: this.labelOf('remote') });
		}
		return machines;
	}

	getDefaultMachineId(): ParadisSystemUsageMachineId {
		return this.remoteAgentService.getConnection() !== null ? 'remote' : 'local';
	}

	private labelOf(machineId: ParadisSystemUsageMachineId): string {
		if (machineId === 'local') {
			return isMacintosh
				? localize('paradis.systemUsage.thisMac', "この Mac")
				: localize('paradis.systemUsage.thisComputer', "このコンピューター");
		}
		const hostname = this.caches.get('remote')?.machine?.hostname;
		if (hostname !== undefined && hostname.length > 0) {
			return shortHostname(hostname);
		}
		const authority = this.remoteAgentService.getConnection()?.remoteAuthority;
		return authority !== undefined
			? this.labelService.getHostLabel(Schemas.vscodeRemote, authority)
			: localize('paradis.systemUsage.remote', "接続先");
	}

	private channelOf(machineId: ParadisSystemUsageMachineId): IChannel | undefined {
		if (machineId === 'local') {
			return this.sharedProcessService.getChannel(PARADIS_SYSTEM_USAGE_CHANNEL);
		}
		return this.remoteAgentService.getConnection()?.getChannel(PARADIS_HOST_RESOURCES_CHANNEL);
	}

	private cacheOf(machineId: ParadisSystemUsageMachineId): IParadisSystemUsageMachineCache {
		let cache = this.caches.get(machineId);
		if (cache === undefined) {
			cache = { tiers: new Map(), machine: undefined, unsupported: [], latest: undefined, legacy: false, error: undefined };
			this.caches.set(machineId, cache);
		}
		return cache;
	}

	async fetchRaw(machineId: ParadisSystemUsageMachineId, request: IParadisSystemUsageRequest): Promise<IParadisSystemUsageResponse | undefined> {
		const channel = this.channelOf(machineId);
		if (channel === undefined) {
			throw new Error('not connected');
		}
		try {
			return await channel.call<IParadisSystemUsageResponse>(PARADIS_SYSTEM_USAGE_COMMAND, request);
		} catch (error) {
			if (machineId === 'remote' && paradisIsSystemUsageUnsupportedError(error)) {
				return undefined;
			}
			throw error;
		}
	}

	async refresh(machineId: ParadisSystemUsageMachineId, range: ParadisSystemUsageRange): Promise<IParadisSystemUsageView> {
		const spec = paradisSystemUsageRangeSpec(range);
		const key = `${machineId}|${spec.tier}`;
		let job = this.inflight.get(key);
		if (job === undefined) {
			job = this.fetchTier(machineId, spec.tier).finally(() => this.inflight.delete(key));
			this.inflight.set(key, job);
		}
		await job;
		return this.viewOf(machineId, range);
	}

	private async fetchTier(machineId: ParadisSystemUsageMachineId, tier: ParadisSystemUsageTier): Promise<void> {
		const cache = this.cacheOf(machineId);
		let tierCache = cache.tiers.get(tier);
		if (tierCache === undefined) {
			tierCache = { instanceId: undefined, samples: [] };
			cache.tiers.set(tier, tierCache);
		}
		const last = tierCache.samples.at(-1);
		const request: IParadisSystemUsageRequest = {
			tier,
			...(last !== undefined && tierCache.instanceId !== undefined ? { since: last.t, instanceId: tierCache.instanceId } : {}),
		};
		try {
			const response = await this.fetchRaw(machineId, request);
			if (response === undefined) {
				await this.fetchLegacy(machineId, cache);
				return;
			}
			if (response.version !== PARADIS_SYSTEM_USAGE_VERSION) {
				throw new Error(`unsupported system usage version ${response.version}`);
			}
			const reset = response.reset || response.instanceId !== tierCache.instanceId;
			tierCache.samples = paradisMergeSystemUsageSamples(tierCache.samples, paradisDecodeSystemUsageSeries(response.series), reset, paradisSystemUsageTierCapacity(tier));
			tierCache.instanceId = response.instanceId;
			// 段どうしで測る側が違う（片方だけ再起動した）ことは無いが、念のため別の段の写しも捨てる
			for (const [otherTier, other] of cache.tiers) {
				if (otherTier !== tier && other.instanceId !== undefined && other.instanceId !== response.instanceId) {
					other.instanceId = undefined;
					other.samples = [];
				}
			}
			cache.machine = response.machine;
			cache.unsupported = Array.isArray(response.unsupported) ? response.unsupported : [];
			cache.latest = paradisParseSystemUsageSample(response.latest) ?? tierCache.samples.at(-1);
			cache.legacy = false;
			cache.error = undefined;
		} catch (error) {
			cache.error = error instanceof Error ? error.message : String(error);
		}
	}

	private async fetchLegacy(machineId: ParadisSystemUsageMachineId, cache: IParadisSystemUsageMachineCache): Promise<void> {
		const channel = this.channelOf(machineId);
		if (channel === undefined) {
			throw new Error('not connected');
		}
		const host = await channel.call<IParadisHostResources>('getHostResources', {});
		cache.tiers.clear();
		cache.legacy = true;
		cache.error = undefined;
		cache.latest = sampleFromHostResources(host);
		cache.unsupported = ['diskIo', 'network', 'swap'];
		cache.machine = {
			os: '',
			hostname: cache.machine?.hostname ?? '',
			cores: host.cores,
			memTotal: host.memory.total,
			...(host.disks[0] !== undefined ? { diskPath: host.disks[0].path, diskTotal: host.disks[0].total } : {}),
		};
	}

	private viewOf(machineId: ParadisSystemUsageMachineId, range: ParadisSystemUsageRange): IParadisSystemUsageView {
		const spec = paradisSystemUsageRangeSpec(range);
		const cache = this.cacheOf(machineId);
		const all = cache.tiers.get(spec.tier)?.samples ?? [];
		const window = paradisSystemUsageWindow(all, spec.windowMs);
		return {
			machineId,
			label: this.labelOf(machineId),
			range,
			machine: cache.machine,
			legacy: cache.legacy,
			error: cache.error,
			unsupported: cache.unsupported,
			samples: window.samples,
			windowStart: window.start,
			windowEnd: window.end,
			windowMs: spec.windowMs,
			stepMs: spec.stepMs,
			latest: cache.latest,
		};
	}
}

registerSingleton(IParadisSystemUsageModel, ParadisSystemUsageModel, InstantiationType.Delayed);
