// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { RtcStatsReportLike } from './browserRoute.js';

/**
 * WebRTC の映像が実際に届いているか（設計書 4 章の着手順 8、browser.frame-pause.v1）。
 *
 * WebRTC でつながっても、映像が 1 枚も届かない・途中で止まることがある（経路の詰まり・PC 側のキャプチャの停止）。
 * そこで、復号したフレーム数（`inbound-rtp` の `framesDecoded`）が増えているときだけ「流れている」とみなし、
 * 流れている間だけ PC に JPEG を止めてもらう。止まったら JPEG を再開し、画面も JPEG に戻す。
 *
 * 変化の無いページでは映像のフレームも来ないことがある。そのときは「止まった」とみなして JPEG に戻すが、JPEG も
 * 変化の無い画面は送らないので、通信はほとんど増えない。ページが動けば映像が流れ、また JPEG を止める。
 */

/** フレーム数が増えないまま、この時間が過ぎたら止まったとみなす。 */
export const VIDEO_STALL_MS = 5_000;
/** 統計を読む間隔。 */
export const VIDEO_HEALTH_POLL_MS = 1_500;

export interface VideoHealth {
	/** 最後に見たフレーム数。 */
	readonly frames: number | undefined;
	/** フレーム数が最後に増えた時刻。 */
	readonly advancedAt: number | undefined;
	/** 映像が流れている（JPEG を止めてよい）。 */
	readonly flowing: boolean;
}

export const INITIAL_VIDEO_HEALTH: VideoHealth = { frames: undefined, advancedAt: undefined, flowing: false };

/** 統計から、受けている映像の復号済みフレーム数を読む。分からなければ undefined。 */
export function framesDecodedFromStats(report: RtcStatsReportLike): number | undefined {
	let frames: number | undefined;
	report.forEach(stat => {
		if (stat?.type === 'inbound-rtp' && (stat.kind ?? stat.mediaType) === 'video' && typeof stat.framesDecoded === 'number') {
			frames = (frames ?? 0) + stat.framesDecoded;
		}
	});
	return frames;
}

/**
 * 新しい標本で状態を進める。フレーム数が 1 以上で前より増えていれば流れている（最初の 1 枚を確かめてから止めるため、
 * 0 のままでは流れているとみなさない）。増えないまま {@link VIDEO_STALL_MS} 過ぎたら止まった。
 */
export function nextVideoHealth(previous: VideoHealth, frames: number | undefined, now: number): VideoHealth {
	if (frames === undefined) {
		return previous;
	}
	const advanced = frames > 0 && (previous.frames === undefined || frames > previous.frames);
	const advancedAt = advanced ? now : previous.advancedAt;
	const flowing = advancedAt !== undefined && now - advancedAt < VIDEO_STALL_MS;
	return { frames, advancedAt, flowing };
}
