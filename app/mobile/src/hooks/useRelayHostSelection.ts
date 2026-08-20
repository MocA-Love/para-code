// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { defaultRelayHostId, relayHostsFrom, type RelayHost } from '../relayHosts.js';

/**
 * 「接続先セグメント」(rtk/ccusage/rate limit) が共通で使う、選択中の接続先。
 *
 * `effectiveHostId` は、明示選択（`selectedHostId`）が一覧にまだ生きていればそれを、
 * 無ければ既定（いま見ているワークスペースのウィンドウ→無ければ最初の ready ホスト）を返す。
 * 明示選択したホストが desktop state の部分更新で一瞬消えても、ここでは選択を保持したまま
 * （`hosts` から探しても見つからない = 呼び出し側はオフライン扱いにする。別マシンの数字を
 * 同じUIで見せてしまう取り違えを避けるため、勝手に他ホストへは移さない）。
 */
export function useRelayHostSelection(): { hosts: RelayHost[]; effectiveHostId: string | undefined; selectHost: (id: string) => void } {
	const { renderers, workspaces, activeWs, selectedHostId, setSelectedHost } = useAppStore(useShallow(s => ({
		renderers: s.workspace?.renderers, workspaces: s.workspace?.workspaces, activeWs: s.workspace?.activeWs,
		selectedHostId: s.selectedHostId, setSelectedHost: s.setSelectedHost,
	})));
	const hosts = useMemo(() => relayHostsFrom(renderers ?? []), [renderers]);
	const activeWindowId = useMemo(() => workspaces?.find(w => w.id === activeWs)?.windowId, [workspaces, activeWs]);
	// 明示選択があれば、一覧に今いるかどうかに関わらずそれを返す（消えていても保持する。
	// 上のコメント参照）。未選択のときだけ既定へ落ちる。
	const effectiveHostId = selectedHostId ?? defaultRelayHostId(hosts, renderers ?? [], activeWindowId);
	return { hosts, effectiveHostId, selectHost: setSelectedHost };
}
