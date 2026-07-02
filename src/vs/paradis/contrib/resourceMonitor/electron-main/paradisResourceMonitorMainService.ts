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

import { app } from 'electron';
import { totalmem } from 'os';
import {
	IParadisResourceMonitorAppMetrics,
	IParadisResourceMonitorMainService,
	IParadisResourceMonitorScopeMetrics,
	IParadisResourceMonitorSessionMetrics,
	IParadisResourceMonitorSessionRequest,
	IParadisResourceMonitorSnapshot,
	IParadisResourceMonitorSnapshotRequest,
	IParadisResourceUsage,
} from '../common/paradisResourceMonitor.js';
import { captureParadisProcessSnapshot, getParadisSubtreeResources } from './paradisResourceMonitorProcessTree.js';

/** パネル表示中のポーリング間隔(2秒)より短い鮮度でキャッシュを再利用する。 */
const SNAPSHOT_MAX_AGE_MS = 2_500;

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

	for (const proc of app.getAppMetrics()) {
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

/**
 * `shared process only` ではなく、メインプロセスのみで完結するCPU/RAM収集サービス。
 * `getSnapshot` は2.5秒以内の再呼び出しをキャッシュから返し、並行呼び出しは1つの
 * in-flight Promiseへ集約する(パネル表示中の2秒ポーリングによる `ps` の多重実行を防ぐ)。
 */
export class ParadisResourceMonitorMainService implements IParadisResourceMonitorMainService {

	private cachedSnapshot: IParadisResourceMonitorSnapshot | undefined;
	private inflightCollection: Promise<IParadisResourceMonitorSnapshot> | undefined;

	async getSnapshot(request: IParadisResourceMonitorSnapshotRequest): Promise<IParadisResourceMonitorSnapshot> {
		if (!request.force && this.cachedSnapshot && Date.now() - this.cachedSnapshot.collectedAt <= SNAPSHOT_MAX_AGE_MS) {
			return this.cachedSnapshot;
		}

		if (this.inflightCollection) {
			return this.inflightCollection;
		}

		const collection = this.collectSnapshotNow(request.sessions)
			.catch(() => this.cachedSnapshot ?? this.createEmptySnapshot())
			.then(snapshot => {
				this.cachedSnapshot = snapshot;
				return snapshot;
			})
			.finally(() => {
				this.inflightCollection = undefined;
			});
		this.inflightCollection = collection;

		return collection;
	}

	private async collectSnapshotNow(sessions: readonly IParadisResourceMonitorSessionRequest[]): Promise<IParadisResourceMonitorSnapshot> {
		const processSnapshot = await captureParadisProcessSnapshot();
		const appMetrics = collectAppMetrics();

		const scopesByStateKey = new Map<string, { scopeName: string; usage: IParadisResourceUsage; sessions: IParadisResourceMonitorSessionMetrics[] }>();

		for (const session of sessions) {
			if (!Number.isFinite(session.pid) || session.pid <= 0) {
				continue;
			}

			const resources = getParadisSubtreeResources(processSnapshot, session.pid);
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
			app: appMetrics,
			scopes,
			totalCpu: appMetrics.cpu + sessionCpuTotal,
			totalMemory: appMetrics.memory + sessionMemoryTotal,
			hostTotalMemory: normalizeFiniteNumber(totalmem()),
			collectedAt: Date.now(),
		};
	}

	private createEmptySnapshot(): IParadisResourceMonitorSnapshot {
		const zero: IParadisResourceUsage = { cpu: 0, memory: 0 };
		return {
			app: { ...zero, main: zero, renderer: zero, other: zero },
			scopes: [],
			totalCpu: 0,
			totalMemory: 0,
			hostTotalMemory: normalizeFiniteNumber(totalmem()),
			collectedAt: Date.now(),
		};
	}
}
