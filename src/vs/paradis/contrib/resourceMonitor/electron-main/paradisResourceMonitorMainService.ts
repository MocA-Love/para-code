/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// electron-main側でCPU/RAM使用率スナップショットを収集するサービス(Superset apps/desktop の
// src/main/lib/resource-metrics/index.ts 移植)。app.ts の PARA-PATCH 点から
// ProxyChannel.fromService でメインプロセスのIPCサーバーへ直接公開される
// (shared processは経由しない。収集はメインプロセスのみで完結する)。
//
// ProxyChannel.fromService でそのままチャネル化できるよう、公開メソッドはasyncのみ。

import * as electron from 'electron';
import { homedir, totalmem } from 'os';
import {
	IParadisHostResources,
	IParadisHostResourcesRequest,
	IParadisResourceMonitorAppMetrics,
	IParadisResourceMonitorMainService,
	IParadisResourceMonitorScopeMetrics,
	IParadisResourceMonitorSessionMetrics,
	IParadisResourceMonitorSessionRequest,
	IParadisResourceMonitorSnapshot,
	IParadisResourceMonitorSnapshotRequest,
	IParadisResourceUsage,
} from '../common/paradisResourceMonitor.js';
import { ParadisHostResourceSampler } from '../node/paradisHostResources.js';
import { captureParadisProcessSnapshot, getParadisSubtreeResources, IParadisProcessSnapshot } from './paradisResourceMonitorProcessTree.js';

/** パネル表示中のポーリング間隔(2秒)より短い鮮度でキャッシュを再利用する。 */
const ACTIVE_SNAPSHOT_MAX_AGE_MS = 2_500;
/** 閉じたパネルの5秒ポーリングをwindow間で同じraw世代へ集約する。 */
const IDLE_SNAPSHOT_MAX_AGE_MS = 5_000;
/** モバイルのhost resources取得は従来の2.5秒cacheを維持する。 */
const HOST_RESOURCES_MAX_AGE_MS = 2_500;

export interface IParadisResourceMonitorRawSample {
	/** renderer所有のsessionsを含まない、main processで共有できる1世代分の収集結果。 */
	readonly processSnapshot: IParadisProcessSnapshot;
	readonly app: IParadisResourceMonitorAppMetrics;
	readonly hostTotalMemory: number;
	readonly collectedAt: number;
}

export interface IParadisResourceMonitorMainServiceDependencies {
	readonly collectRawSample: () => Promise<IParadisResourceMonitorRawSample>;
	readonly now: () => number;
	readonly schedule: (callback: () => void, delayMs: number) => { dispose(): void };
}

function normalizeFiniteNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isParadisRendererProcessType(type: string): boolean {
	const normalized = type.toLowerCase();
	return normalized === 'renderer' || normalized === 'tab';
}

/**
 * `app.getAppMetrics()` からアプリ自身(Superset App相当)のプロセス種別別リソースを集計する。
 */
function collectAppMetrics(): IParadisResourceMonitorAppMetrics {
	const main: { cpu: number; memory: number } = { cpu: 0, memory: 0 };
	const renderer: { cpu: number; memory: number } = { cpu: 0, memory: 0 };
	const other: { cpu: number; memory: number } = { cpu: 0, memory: 0 };

	for (const proc of electron.app.getAppMetrics()) {
		const cpu = normalizeFiniteNumber(proc.cpu?.percentCPUUsage);
		// Electronの workingSetSize はKB単位。
		const memory = normalizeFiniteNumber(proc.memory?.workingSetSize) * 1024;

		let target = other;
		if (proc.type === 'Browser') {
			target = main;
		} else if (typeof proc.type === 'string' && isParadisRendererProcessType(proc.type)) {
			target = renderer;
		}
		target.cpu += cpu;
		target.memory += memory;
	}

	return {
		cpu: main.cpu + renderer.cpu + other.cpu,
		memory: main.memory + renderer.memory + other.memory,
		main,
		renderer,
		other,
	};
}

async function collectRawSample(): Promise<IParadisResourceMonitorRawSample> {
	const processSnapshot = await captureParadisProcessSnapshot();
	return {
		processSnapshot,
		app: collectAppMetrics(),
		hostTotalMemory: normalizeFiniteNumber(totalmem()),
		collectedAt: Date.now(),
	};
}

const defaultDependencies: IParadisResourceMonitorMainServiceDependencies = {
	collectRawSample,
	now: () => Date.now(),
	schedule: (callback, delayMs) => {
		const handle = setTimeout(callback, delayMs);
		return { dispose: () => clearTimeout(handle) };
	},
};

/**
 * `shared process only` ではなく、メインプロセスのみで完結するCPU/RAM収集サービス。
 * `getSnapshot` はactive要求で2.5秒、idle要求で5秒までraw収集結果を共有し、並行呼び出しを1つの
 * in-flight Promiseへ集約する。sessionsは共有せず、各requestの復帰時に同じraw世代へ投影する。
 */
export class ParadisResourceMonitorMainService implements IParadisResourceMonitorMainService {

	private cachedRawSample: IParadisResourceMonitorRawSample | undefined;
	private inflightCollection: Promise<IParadisResourceMonitorRawSample> | undefined;
	private rawSampleExpiry: { dispose(): void } | undefined;
	private rawSampleGeneration = 0;

	// ホスト全体の使用量(モバイルの「システム」画面専用)。CPUは累積値の差分なので
	// サンプラーを1つだけ持ち回る。
	private readonly hostSampler = new ParadisHostResourceSampler();
	// 呼び出し元はモバイルの「システム」画面ひとつで diskPaths の顔ぶれは同じなので、
	// キャッシュキーには含めない（複数の呼び出し元が別々のパスを渡すようになったら要見直し）。
	private cachedHostResources: IParadisHostResources | undefined;
	private inflightHostCollection: Promise<IParadisHostResources> | undefined;

	constructor(private readonly dependencies: IParadisResourceMonitorMainServiceDependencies = defaultDependencies) { }

	async getHostResources(request: IParadisHostResourcesRequest): Promise<IParadisHostResources> {
		if (!request.force && this.cachedHostResources && Date.now() - this.cachedHostResources.collectedAt <= HOST_RESOURCES_MAX_AGE_MS) {
			return this.cachedHostResources;
		}
		// force（モバイルのプルダウン更新）は進行中の収集に相乗りさせない。相乗りさせると
		// 「引っ張っても更新されない」ことがある（合流先はその要求より前に始まった収集のため）。
		if (this.inflightHostCollection && !request.force) {
			return this.inflightHostCollection;
		}
		// ホームのボリュームは常に先頭に入れる(モバイル側が「主ボリューム」として最初の1件を大きく出す)。
		// 同じボリュームを指すパスはサンプラー側でまとめられるので、重複は気にしなくてよい。
		const collection = this.hostSampler.read([homedir(), ...(request.diskPaths ?? [])])
			.then(resources => {
				this.cachedHostResources = resources;
				return resources;
			})
			.finally(() => {
				this.inflightHostCollection = undefined;
			});
		this.inflightHostCollection = collection;
		return collection;
	}

	async getSnapshot(request: IParadisResourceMonitorSnapshotRequest): Promise<IParadisResourceMonitorSnapshot> {
		const maxAgeMs = request.freshness === 'idle' ? IDLE_SNAPSHOT_MAX_AGE_MS : ACTIVE_SNAPSHOT_MAX_AGE_MS;
		if (!request.force && this.cachedRawSample && this.dependencies.now() - this.cachedRawSample.collectedAt <= maxAgeMs) {
			return this.projectSnapshot(this.cachedRawSample, request.sessions);
		}

		if (this.inflightCollection) {
			return this.projectSnapshot(await this.inflightCollection, request.sessions);
		}

		const collection = this.dependencies.collectRawSample()
			.catch(() => this.cachedRawSample ?? this.createEmptyRawSample())
			.then(rawSample => {
				this.cacheRawSample(rawSample);
				return rawSample;
			})
			.finally(() => {
				this.inflightCollection = undefined;
			});
		this.inflightCollection = collection;

		return this.projectSnapshot(await collection, request.sessions);
	}

	private projectSnapshot(rawSample: IParadisResourceMonitorRawSample, sessions: readonly IParadisResourceMonitorSessionRequest[]): IParadisResourceMonitorSnapshot {
		const scopesByStateKey = new Map<string, { scopeName: string; usage: IParadisResourceUsage; sessions: IParadisResourceMonitorSessionMetrics[] }>();

		for (const session of sessions) {
			if (!Number.isFinite(session.pid) || session.pid <= 0) {
				continue;
			}

			const resources = getParadisSubtreeResources(rawSample.processSnapshot, session.pid);
			const sessionMetrics: IParadisResourceMonitorSessionMetrics = {
				name: session.sessionName,
				pid: session.pid,
				cpu: normalizeFiniteNumber(resources.cpu),
				memory: normalizeFiniteNumber(resources.memory),
			};

			let scope = scopesByStateKey.get(session.stateKey);
			if (!scope) {
				scope = { scopeName: session.scopeName, usage: { cpu: 0, memory: 0 }, sessions: [] };
				scopesByStateKey.set(session.stateKey, scope);
			}
			scope.sessions.push(sessionMetrics);
			scope.usage = { cpu: scope.usage.cpu + sessionMetrics.cpu, memory: scope.usage.memory + sessionMetrics.memory };
		}

		const scopes: IParadisResourceMonitorScopeMetrics[] = [];
		let sessionCpuTotal = 0;
		let sessionMemoryTotal = 0;
		for (const [stateKey, scope] of scopesByStateKey) {
			scopes.push({
				stateKey,
				scopeName: scope.scopeName,
				cpu: scope.usage.cpu,
				memory: scope.usage.memory,
				sessions: scope.sessions,
			});
			sessionCpuTotal += scope.usage.cpu;
			sessionMemoryTotal += scope.usage.memory;
		}

		return {
			app: rawSample.app,
			scopes,
			totalCpu: rawSample.app.cpu + sessionCpuTotal,
			totalMemory: rawSample.app.memory + sessionMemoryTotal,
			hostTotalMemory: rawSample.hostTotalMemory,
			collectedAt: rawSample.collectedAt,
		};
	}

	private cacheRawSample(rawSample: IParadisResourceMonitorRawSample): void {
		this.rawSampleExpiry?.dispose();
		this.rawSampleExpiry = undefined;

		const remainingMs = rawSample.collectedAt + IDLE_SNAPSHOT_MAX_AGE_MS - this.dependencies.now();
		if (remainingMs <= 0) {
			this.cachedRawSample = undefined;
			this.rawSampleGeneration++;
			return;
		}

		this.cachedRawSample = rawSample;
		const generation = ++this.rawSampleGeneration;
		this.rawSampleExpiry = this.dependencies.schedule(() => {
			if (this.rawSampleGeneration === generation) {
				this.cachedRawSample = undefined;
				this.rawSampleExpiry = undefined;
			}
		}, remainingMs);
	}

	private createEmptyRawSample(): IParadisResourceMonitorRawSample {
		const zero: IParadisResourceUsage = { cpu: 0, memory: 0 };
		return {
			processSnapshot: { byPid: new Map(), childrenOf: new Map() },
			app: { ...zero, main: zero, renderer: zero, other: zero },
			hostTotalMemory: normalizeFiniteNumber(totalmem()),
			collectedAt: this.dependencies.now(),
		};
	}
}
