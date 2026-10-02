// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { PcResourceSummary, PcUsageTarget } from '../../appState.js';
import { pcHasCapability } from '../../pcCompat.js';
import { localRelayWindowId, relayHostsFrom, type RelayHostRendererLike } from '../../relayHosts.js';
import { USAGE_MACHINE_ID_CAPABILITY, pcSourceKey, sshSourceKey, type UsageSourceInfo } from './usageAggregate.js';
import type { UsageCacheRecord } from './usageCache.js';

/** 出どころを作るのに要る PC の要約（実体は `PcSummary`）。 */
export interface UsageSourcePc {
	readonly id: string;
	readonly name: string;
	readonly connection: string;
	readonly pcOnline: boolean;
	readonly machineIdHash?: string | undefined;
}

/** 出どころ1つの、要求を送る先。 */
export interface UsageSourceRoute {
	readonly pcId: string;
	readonly windowId: number | undefined;
	/** SSH の接続先（Claude を接続先のログインで出してもらう）。 */
	readonly remote: boolean;
}

/** `buildUsageTargets` が読む、PC 1台ぶんの desktop state の一部。 */
export interface UsageTargetSource {
	readonly pcId: string;
	readonly workspace: { readonly capabilities?: readonly string[]; readonly renderers: readonly RelayHostRendererLike[] } | undefined;
}

/**
 * PC ごとの使用量を取る先（手元のウィンドウと SSH の接続先）。機械のハッシュ（`usage.machine-id.v1`）を広告しない PC の
 * 接続先にはハッシュを持たせない（別の機械として扱う）。
 */
export function buildUsageTargets(list: readonly UsageTargetSource[]): PcUsageTarget[] {
	return list.map(({ pcId, workspace }) => {
		const renderers = workspace?.renderers ?? [];
		const machineIds = pcHasCapability(workspace, USAGE_MACHINE_ID_CAPABILITY);
		return {
			pcId,
			localWindowId: localRelayWindowId(renderers),
			remotes: relayHostsFrom(renderers)
				.filter(host => host.kind === 'remote')
				.map(host => {
					if (machineIds || host.machineIdHash === undefined) {
						return host;
					}
					const { machineIdHash: _dropped, ...rest } = host;
					return rest;
				}),
		};
	});
}

/**
 * ペアリング済みの PC と、いま開いている SSH の接続先、控えにだけ残っている SSH の接続先（いまは開いていない）
 * から出どころの一覧を作る。PC がオフライン（裏の PC との接続を保たない設定で繋いでいないときを含む）なら、
 * その PC も接続先もオフライン扱い。CPU・メモリ・SSD（`resources`）は使用量の画面だけが読む別の値から渡す。
 */
export function buildUsageSources(
	pcs: readonly UsageSourcePc[],
	targets: readonly PcUsageTarget[],
	cached: Readonly<Record<string, UsageCacheRecord>>,
	resources: Readonly<Record<string, PcResourceSummary | undefined>> = {},
): { readonly sources: UsageSourceInfo[]; readonly routes: ReadonlyMap<string, UsageSourceRoute> } {
	const sources: UsageSourceInfo[] = [];
	const routes = new Map<string, UsageSourceRoute>();
	const targetByPc = new Map(targets.map(target => [target.pcId, target]));
	for (const pc of pcs) {
		const online = pc.connection === 'online' && pc.pcOnline;
		const key = pcSourceKey(pc.id);
		const target = targetByPc.get(pc.id);
		sources.push({ key, kind: 'pc', pcId: pc.id, pcName: pc.name, online, machineIdHash: pc.machineIdHash, resources: resources[pc.id] });
		routes.set(key, { pcId: pc.id, windowId: target?.localWindowId, remote: false });
		const live = new Set<string>();
		for (const host of target?.remotes ?? []) {
			const sshKey = sshSourceKey(pc.id, host.id);
			live.add(sshKey);
			sources.push({ key: sshKey, kind: 'ssh', pcId: pc.id, pcName: pc.name, hostLabel: host.label, online: online && host.ready, machineIdHash: host.machineIdHash });
			routes.set(sshKey, { pcId: pc.id, windowId: host.windowId, remote: true });
		}
		// いまは開いていない接続先も、7日以内の値が残っていればオフラインとして出す。
		for (const [cachedKey, record] of Object.entries(cached).sort(([a], [b]) => a.localeCompare(b))) {
			if (record.kind === 'ssh' && record.pcId === pc.id && !live.has(cachedKey)) {
				sources.push({ key: cachedKey, kind: 'ssh', pcId: pc.id, pcName: pc.name, hostLabel: record.hostLabel, online: false, machineIdHash: record.machineIdHash });
			}
		}
	}
	return { sources, routes };
}
