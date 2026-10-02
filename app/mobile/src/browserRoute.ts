// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ブラウザの映像がどの経路で届いているか（アドレス欄の左端の印、案A）。
 *
 * WebRTC で写しているときは、`RTCPeerConnection.getStats()` の transport が指す選ばれた候補の組
 * （`selectedCandidatePairId`）から、手元と相手の候補の `candidateType` を見る。transport の統計を
 * 返さない実装向けに、`nominated` かつ `succeeded` の組を控えに使う。WebRTC が無く JPEG を写して
 * いるときは、browser チャネルがリレーサーバーの E2E の経路を通るので常に `relay`。
 */

/** `lan` 同じネットワークで直接 / `direct` インターネット越しに直接 / `turn` 中継サーバー経由 / `relay` リレーサーバー経由の画像。 */
export type MirrorRoute = 'lan' | 'direct' | 'turn' | 'relay';

/** 統計の 1 件（react-native-webrtc の RTCStatsReport の値）。使う項目だけ。 */
export interface RtcStatLike {
	readonly id?: string;
	readonly type?: string;
	readonly selectedCandidatePairId?: string;
	readonly localCandidateId?: string;
	readonly remoteCandidateId?: string;
	readonly candidateType?: string;
	readonly nominated?: boolean;
	readonly state?: string;
}

/** `getStats()` の戻り値（Map と同じ形）。 */
export interface RtcStatsReportLike {
	forEach(callback: (value: RtcStatLike, key: string) => void): void;
}

/** 選ばれた候補の組から経路を決める。組が分からなければ `undefined`。 */
export function routeFromStats(report: RtcStatsReportLike): Exclude<MirrorRoute, 'relay'> | undefined {
	const stats = new Map<string, RtcStatLike>();
	report.forEach((value, key) => {
		stats.set(value?.id ?? key, value);
	});
	let pair: RtcStatLike | undefined;
	for (const stat of stats.values()) {
		if (stat?.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') {
			pair = stats.get(stat.selectedCandidatePairId);
			if (pair !== undefined) {
				break;
			}
		}
	}
	pair ??= [...stats.values()].find(stat => stat?.type === 'candidate-pair' && stat.nominated === true && stat.state === 'succeeded');
	if (pair === undefined) {
		return undefined;
	}
	const local = pair.localCandidateId !== undefined ? stats.get(pair.localCandidateId)?.candidateType : undefined;
	const remote = pair.remoteCandidateId !== undefined ? stats.get(pair.remoteCandidateId)?.candidateType : undefined;
	if (local === undefined || remote === undefined) {
		return undefined;
	}
	if (local === 'relay' || remote === 'relay') {
		return 'turn';
	}
	return local === 'host' && remote === 'host' ? 'lan' : 'direct';
}

/**
 * 画面に出す経路。WebRTC の映像を出していれば WebRTC の経路（まだ分からなければ `undefined`）、
 * JPEG を出していれば `relay`、どちらも無ければ `undefined`。
 */
export function displayedRoute(showingWebrtc: boolean, webrtcRoute: Exclude<MirrorRoute, 'relay'> | undefined, showingJpeg: boolean): MirrorRoute | undefined {
	if (showingWebrtc) {
		return webrtcRoute;
	}
	return showingJpeg ? 'relay' : undefined;
}

/** 経路の名前と説明と色の種類（`good` 緑・`warn` 黄・`dim` 灰）。 */
export const MIRROR_ROUTE_INFO: { readonly [R in MirrorRoute]: { readonly label: string; readonly description: string; readonly tone: 'good' | 'warn' | 'dim' } } = {
	lan: { label: '同じネットワークで直接', description: 'PC と同じネットワークから、映像を直接受け取っています。いちばん速い経路です。', tone: 'good' },
	direct: { label: 'インターネット越しに直接', description: 'インターネットを通して、PC から映像を直接受け取っています。', tone: 'good' },
	turn: { label: '中継サーバー（TURN）経由', description: '直接つながらないため、中継サーバーを通して映像を受け取っています。少し遅れることがあります。', tone: 'warn' },
	relay: { label: 'リレーサーバー経由の画像', description: '映像の経路をつなげないため、リレーサーバーを通して静止画を順に受け取っています。動きは粗くなります。', tone: 'dim' },
};
