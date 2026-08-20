// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 「接続先セグメント」(rtk/ccusage/rate limit) が使う、1PC内の接続先（ローカル/SSHリモート）の一覧化。
 *
 * PCが1台でも、複数のウィンドウ（ローカルのworkspaceを開いたもの、SSHリモート先を開いたもの）を
 * 同時に起動していることがある。rtk/ccusage/rate limit の値はウィンドウが繋がっている先の
 * ホストでCLIを実行して取得するため、ウィンドウごとに異なりうる。ここでは PC から届く
 * renderer 一覧（ウィンドウ単位）を、ユーザーに見せる「接続先」（ホスト単位）へ束ねる。
 *
 * ホスト単位で束ねるのは、同じホストを複数ウィンドウで開いていても値は同じだから
 * （「ローカル｜ローカル」のような無意味な重複をセグメントに出さない）。
 */

export type RelayHostKind = 'local' | 'remote';

/** PCの desktop state に載ってくる、1ウィンドウぶんの接続先。 */
export interface RelayWindowHost {
	readonly kind: RelayHostKind;
	/** 同一ホストを束ねるための安定キー。local は常に 'local'。 */
	readonly id: string;
	/** remote のときだけ付与される表示名。 */
	readonly label?: string;
}

/** `relayHostsFrom` が受け取る、renderer 一覧の最小形。 */
export interface RelayHostRendererLike {
	readonly windowId: number;
	readonly ready: boolean;
	readonly host?: RelayWindowHost;
}

/** セグメントに出す1接続先（ホスト単位でユニーク化済み）。 */
export interface RelayHost {
	readonly id: string;
	readonly kind: RelayHostKind;
	readonly label: string;
	/** リクエストを飛ばす代表ウィンドウ（同一ホストに複数ウィンドウがあれば ready なものを優先）。 */
	readonly windowId: number;
	readonly ready: boolean;
}

const LOCAL_LABEL = 'ローカル';

/**
 * renderer 一覧から、host が付いているものだけを host.id で束ねる。
 * host 未配信（旧PC、または state 未同期のウィンドウ）は対象外——このためホストが1つも
 * 定まらないことがあり、その場合は呼び出し側がセグメント自体を出さない判断をする。
 */
export function relayHostsFrom(renderers: readonly RelayHostRendererLike[]): RelayHost[] {
	const byId = new Map<string, RelayHost>();
	for (const renderer of renderers) {
		if (renderer.host === undefined) {
			continue;
		}
		const { host } = renderer;
		const label = host.kind === 'local' ? LOCAL_LABEL : (host.label ?? host.id);
		const existing = byId.get(host.id);
		// 同じホストに複数ウィンドウがあるとき、ready なものを代表に選ぶ（無ければ最初に見つかったもの）。
		if (existing === undefined || (!existing.ready && renderer.ready)) {
			byId.set(host.id, { id: host.id, kind: host.kind, label, windowId: renderer.windowId, ready: renderer.ready });
		}
	}
	// local を先頭に、以降はラベル順（renderer の到着順で毎回並びが変わるとセグメントがチラつく）。
	return [...byId.values()].sort((a, b) => {
		if (a.kind !== b.kind) { return a.kind === 'local' ? -1 : 1; }
		return a.label.localeCompare(b.label);
	});
}

/**
 * 明示選択が無いときの既定ホスト。「いま見ているワークスペース(activeWs)のウィンドウ」を
 * 優先し、無ければ最初の ready なホストに落とす（`warmLeaseTarget()` と同じ優先順位）。
 *
 * **`renderers`（束ねる前の生一覧）から解決すること。** `hosts` の `windowId` は
 * 同一ホストを束ねたときの代表ウィンドウであり、activeWs のウィンドウがそのホストの
 * 別ウィンドウ（代表ではない方）だと一致しない。代表だけで比較すると、SSH先で作業中でも
 * 既定がローカルへ落ちる（取り違えそのもの）ことがある。
 */
export function defaultRelayHostId(hosts: readonly RelayHost[], renderers: readonly RelayHostRendererLike[], activeWindowId: number | undefined): string | undefined {
	const activeHostId = activeWindowId !== undefined
		? renderers.find(renderer => renderer.windowId === activeWindowId)?.host?.id
		: undefined;
	if (activeHostId !== undefined && hosts.some(host => host.id === activeHostId)) {
		return activeHostId;
	}
	return (hosts.find(host => host.ready) ?? hosts[0])?.id;
}
