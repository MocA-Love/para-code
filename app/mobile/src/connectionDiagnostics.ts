// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { updateRequiredLabel, type UpdateTarget } from './pcCompat.js';

/**
 * 「接続の記録」の簡単な診断（W2-22。Orca の use-troubleshoot-diagnostics.ts に倣った）。
 * 調べるのは、ペアリング済みの PC の数・インターネット・リレーへの到達・PC がオンラインか・版が合うか。
 * LAN や Tailscale の項目は Para Code に無いので入れない。
 *
 * インターネットは端末の回線状態（expo-network の `isInternetReachable`）で見る。外部のサイトへは
 * 問い合わせない。リレーはリレー自身に問い合わせる（リレーに `/health` は無いので、ルートへの GET が
 * 404 を返すことを「届いた」とみなす。どの HTTP 応答でも経路は通っている）。
 */

export type DiagnosticStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface DiagnosticItem {
	readonly key: string;
	readonly label: string;
	readonly status: DiagnosticStatus;
	readonly detail: string;
}

/** 診断に要る PC の要約（実体は `PcSummary` と台帳の `relayUrl`）。名前は画面だけに使う。 */
export interface DiagnosticPc {
	readonly id: string;
	readonly name: string;
	readonly relayUrl: string;
	readonly connection: string;
	readonly pcOnline: boolean;
	readonly pairingRejected: boolean;
	readonly updateRequired?: UpdateTarget | undefined;
}

/** 回線の状態（expo-network の NetworkState のうち使う分）。 */
export interface DiagnosticNetworkState {
	readonly isConnected?: boolean;
	readonly isInternetReachable?: boolean;
	readonly type?: string;
}

export type DiagnosticFetch = (url: string, init: { readonly method: 'GET'; readonly signal: AbortSignal }) => Promise<{ readonly status: number }>;

export const RELAY_PROBE_TIMEOUT_MS = 5_000;

/** リレーの WebSocket の URL から、到達を確かめる HTTP の URL（ルート）を作る。読めなければ undefined。 */
export function relayProbeUrl(relayUrl: string): string | undefined {
	const match = /^(?<scheme>wss?|https?):\/\/(?:[^/?#\s@]*@)?(?<host>[^/?#\s@]+)/i.exec(relayUrl.trim());
	if (match?.groups === undefined) {
		return undefined;
	}
	// 資格（user:pass@）は問い合わせに載せない。
	const scheme = match.groups.scheme!.toLowerCase();
	const secure = scheme === 'wss' || scheme === 'https';
	return `${secure ? 'https' : 'http'}://${match.groups.host}/`;
}

/** リレーの応答の見立て。HTTP の応答が返れば経路は通っている。5xx はリレー側の不調として注意にする。 */
export function classifyRelayProbe(result: { readonly status: number } | { readonly error: 'timeout' | 'network' }): { readonly status: DiagnosticStatus; readonly detail: string } {
	if ('error' in result) {
		return result.error === 'timeout'
			? { status: 'fail', detail: `${RELAY_PROBE_TIMEOUT_MS / 1_000} 秒以内に応答がありません` }
			: { status: 'fail', detail: 'リレーに届きません' };
	}
	if (result.status >= 500) {
		return { status: 'warn', detail: `応答はありますが、リレーの調子が悪いようです（HTTP ${result.status}）` };
	}
	return { status: 'ok', detail: `届いています（HTTP ${result.status}）` };
}

async function probeRelay(url: string, fetcher: DiagnosticFetch, timeoutMs: number): Promise<{ readonly status: number } | { readonly error: 'timeout' | 'network' }> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
	try {
		const response = await fetcher(url, { method: 'GET', signal: controller.signal });
		return { status: response.status };
	} catch {
		return { error: timedOut ? 'timeout' : 'network' };
	} finally {
		clearTimeout(timer);
	}
}

/** PC の状態の見立て（リレーまでつながっているか、PC の Para Code が居るか、資格・版）。 */
export function diagnosePc(pc: DiagnosticPc): { readonly online: DiagnosticItem; readonly compat: DiagnosticItem } {
	let online: DiagnosticItem;
	if (pc.pairingRejected) {
		online = { key: `pc:${pc.id}`, label: pc.name, status: 'fail', detail: 'リレーがこの端末の資格を拒んでいます。PC とペアリングし直してください' };
	} else if (pc.connection === 'online' && pc.pcOnline) {
		online = { key: `pc:${pc.id}`, label: pc.name, status: 'ok', detail: 'オンライン' };
	} else if (pc.connection === 'online' || pc.connection === 'handshaking') {
		// PC がいないと暗号の握手が終わらないので、接続は handshaking のまま止まる。リレーが PC の不在を
		// 伝えてきている（pcOnline が false）なら、「接続しています…」ではなく PC 側の問題として出す。
		online = { key: `pc:${pc.id}`, label: pc.name, status: 'warn', detail: 'リレーにはつながっていますが、PC の Para Code が応答していません（スリープ中・終了している）' };
	} else if (pc.connection === 'connecting') {
		online = { key: `pc:${pc.id}`, label: pc.name, status: 'unknown', detail: '接続しています…' };
	} else {
		online = { key: `pc:${pc.id}`, label: pc.name, status: 'fail', detail: 'リレーにつながっていません' };
	}
	const compat: DiagnosticItem = pc.updateRequired !== undefined
		? { key: `compat:${pc.id}`, label: `${pc.name} の通信の版`, status: 'fail', detail: updateRequiredLabel(pc.updateRequired) }
		: { key: `compat:${pc.id}`, label: `${pc.name} の通信の版`, status: pc.connection === 'online' && pc.pcOnline ? 'ok' : 'unknown', detail: pc.connection === 'online' && pc.pcOnline ? '合っています' : 'つながると確かめられます' };
	return { online, compat };
}

/** 回線の状態の見立て。 */
export function diagnoseInternet(state: DiagnosticNetworkState | undefined): DiagnosticItem {
	const label = 'インターネット';
	if (state === undefined) {
		return { key: 'internet', label, status: 'unknown', detail: 'このビルドでは回線の状態を読めません' };
	}
	if (state.isConnected === false) {
		return { key: 'internet', label, status: 'fail', detail: '回線につながっていません' };
	}
	const via = state.type !== undefined && state.type !== 'UNKNOWN' ? `（${networkTypeLabel(state.type)}）` : '';
	if (state.isInternetReachable === false) {
		return { key: 'internet', label, status: 'fail', detail: `回線はありますが、インターネットに届きません${via}` };
	}
	if (state.isInternetReachable === true) {
		return { key: 'internet', label, status: 'ok', detail: `つながっています${via}` };
	}
	return { key: 'internet', label, status: 'unknown', detail: `確かめられませんでした${via}` };
}

function networkTypeLabel(type: string): string {
	switch (type) {
		case 'WIFI': return 'Wi-Fi';
		case 'CELLULAR': return 'モバイル回線';
		case 'ETHERNET': return '有線';
		case 'VPN': return 'VPN';
		case 'NONE': return '回線なし';
		default: return type;
	}
}

/** 診断をまとめて行う。リレーは URL ごとに1回だけ問い合わせる（同じリレーの PC が複数あっても）。 */
export async function runConnectionDiagnostics(input: {
	readonly pcs: readonly DiagnosticPc[];
	readonly network: DiagnosticNetworkState | undefined;
	readonly fetcher: DiagnosticFetch;
	readonly timeoutMs?: number;
}): Promise<DiagnosticItem[]> {
	const items: DiagnosticItem[] = [
		{ key: 'pcs', label: 'ペアリング済みの PC', status: input.pcs.length > 0 ? 'ok' : 'warn', detail: input.pcs.length > 0 ? `${input.pcs.length} 台` : 'まだありません' },
		diagnoseInternet(input.network),
	];
	const relays = [...new Set(input.pcs.map(pc => relayProbeUrl(pc.relayUrl)).filter((url): url is string => url !== undefined))];
	const probes = await Promise.all(relays.map(async url => classifyRelayProbe(await probeRelay(url, input.fetcher, input.timeoutMs ?? RELAY_PROBE_TIMEOUT_MS))));
	relays.forEach((url, index) => {
		// URL は画面と報告に出さない（自前のリレーの場所も利用者の情報）。何台目のリレーかだけを言う。
		items.push({ key: `relay:${url}`, label: relays.length > 1 ? `リレー ${index + 1}` : 'リレー', ...probes[index]! });
	});
	for (const pc of input.pcs) {
		const { online, compat } = diagnosePc(pc);
		items.push(online, compat);
	}
	return items;
}
