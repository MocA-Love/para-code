// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useLocalSearchParams } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../appState.js';
import { useUsageHost, type UsageHostState } from '../settings/usageHost.js';
import { pcSourceKey, sshSourceKey } from './usageAggregate.js';

/**
 * 使用量の各画面が「何の値を出すか」。
 *  - `all`: 全 PC の合計（PC が2台以上で、出どころを名指ししていないとき）
 *  - `source`: 1つの出どころ（PC・SSH の接続先）。「PC ごと」の行から来たとき（`?source=`）か、PC が1台のとき
 *    （PC が1台なら今までどおり接続先を選べ、選んだ接続先がその出どころになる）
 */
export type UsageScope =
	| { readonly kind: 'all' }
	| { readonly kind: 'source'; readonly key: string; readonly pcId: string | undefined };

export interface UsageScopeState {
	readonly scope: UsageScope;
	/** 接続先の選択（PC が1台で、出どころを名指ししていないときだけ出す）。 */
	readonly host: UsageHostState;
	readonly showHostPicker: boolean;
	/** 名指しした出どころ（詳しい画面へ引き継ぐ）。 */
	readonly sourceParam: string | undefined;
}

/** 出どころの鍵から PC の ID を取り出す（`pc:<pcId>` / `ssh:<pcId>:<hostId>`）。 */
export function pcIdOfSource(key: string): string | undefined {
	const match = /^(?:pc|ssh):(?<pcId>[^:]+)/.exec(key);
	return match?.groups?.['pcId'];
}

export function useUsageScope(): UsageScopeState {
	const params = useLocalSearchParams<{ source?: string }>();
	const sourceParam = typeof params.source === 'string' && params.source.length > 0 ? params.source : undefined;
	const { pcCount, activePcId } = useAppStore(useShallow(s => ({ pcCount: s.pcs.length, activePcId: s.activePcId })));
	const host = useUsageHost();
	if (sourceParam !== undefined) {
		return { scope: { kind: 'source', key: sourceParam, pcId: pcIdOfSource(sourceParam) }, host, showHostPicker: false, sourceParam };
	}
	if (pcCount > 1) {
		return { scope: { kind: 'all' }, host, showHostPicker: false, sourceParam };
	}
	const selected = host.selectedHost;
	const key = activePcId === undefined
		? 'pc:'
		: selected?.kind === 'remote' ? sshSourceKey(activePcId, selected.id) : pcSourceKey(activePcId);
	return { scope: { kind: 'source', key, pcId: activePcId }, host, showHostPicker: true, sourceParam };
}
