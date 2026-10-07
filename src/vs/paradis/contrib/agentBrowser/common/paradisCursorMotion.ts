/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのカーソルの軌跡を cursor-motion（vendored、MIT、./cursorMotion/README.md）で計算し、
// ページで `element.animate()` の keyframes として再生できる形に畳む（純粋関数のみ）。
//
// 計算は electron-main で行い、ページへは keyframes だけを送る（q.html Q271 A）。ページに rAF の
// ループを置かず、今のページ注入（isolated world・撮影前に隠す・使われなければ消える）をそのまま使う。
// 先端が着く時刻は今の式（距離 ÷ 2.2px/ms、90〜380ms）に合わせる（Q270 A）。行き過ぎと向きの戻りは
// 着いた後に描くだけで、入力の配送はその分を待たない。

import { planMove, REST_HEADING } from './cursorMotion/plan.js';

/** ページへ送る 1 コマ。`o` は再生全体に対する位置（0..1）、`r` は矢印の傾き（度、休みの向きで 0）。 */
export interface IParadisCursorKeyframe {
	readonly x: number;
	readonly y: number;
	readonly r: number;
	readonly o: number;
}

/** 1 回の移動の再生。`durationMs` は行き過ぎと向きの戻りを含めた長さ、`arrivalMs` は先端が着く時刻。 */
export interface IParadisCursorGlide {
	readonly frames: readonly IParadisCursorKeyframe[];
	readonly durationMs: number;
	readonly arrivalMs: number;
	/** 再生し終えたときの向き（ラジアン、cursor-motion の heading）。次の移動の始まりに使う。 */
	readonly endHeading: number;
}

/** カーソルの今の姿勢。 */
export interface IParadisCursorPose {
	readonly x: number;
	readonly y: number;
	/** cursor-motion の heading（ラジアン）。休みは π/4。 */
	readonly heading: number;
}

/** 休みの向き（矢印が左上を指す）。 */
export const PARADIS_CURSOR_REST_HEADING = REST_HEADING;

/** ページへ送るコマの上限。120Hz の標本を間引く（380ms の移動と戻りで 60 コマ前後）。 */
const MAX_FRAMES = 48;

/** 座標と角度を送る桁（ページの描画にはこれで足りる）。 */
function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function rotationDeg(heading: number): number {
	return round1((heading - REST_HEADING) * 180 / Math.PI);
}

/** その場に置くだけの再生（瞬間移動・動きを減らす設定・ドラッグの追従）。 */
function still(to: IParadisCursorPose, durationMs: number): IParadisCursorGlide {
	const frame = { x: round1(to.x), y: round1(to.y), r: rotationDeg(to.heading), o: 1 };
	return { frames: [{ ...frame, o: 0 }, frame], durationMs, arrivalMs: durationMs, endHeading: to.heading };
}

/**
 * `from` から `to` への移動を計画する。`arrivalMs` に先端が着くよう、cursor-motion の時間を伸び縮みさせる。
 *
 * - `arrivalMs` が 0 以下なら、その場に置く（距離が短い・動きを減らす設定）
 * - `straight` はドラッグ中の追従。弧を描くと掴んでいる点から離れて見えるので直線にする
 */
export function paradisPlanCursorGlide(
	from: IParadisCursorPose,
	to: { readonly x: number; readonly y: number },
	arrivalMs: number,
	options: { readonly straight?: boolean } = {},
): IParadisCursorGlide {
	if (!(arrivalMs > 0) || !Number.isFinite(from.x) || !Number.isFinite(from.y)) {
		return still({ x: to.x, y: to.y, heading: from.heading }, 0);
	}
	if (options.straight) {
		return {
			frames: [
				{ x: round1(from.x), y: round1(from.y), r: rotationDeg(from.heading), o: 0 },
				{ x: round1(to.x), y: round1(to.y), r: rotationDeg(from.heading), o: 1 },
			],
			durationMs: Math.round(arrivalMs),
			arrivalMs: Math.round(arrivalMs),
			endHeading: from.heading,
		};
	}
	let trajectory: ReturnType<typeof planMove>;
	try {
		trajectory = planMove(
			// 光・尾・吸着の枠は keyframes では描けないので切る（波紋と縮みはページ側で描く）
			{ style: 'signature_arc', timing: 'fixed', glideDurationMs: Math.round(arrivalMs), effects: { glow: false, trail: false, magnet: false } },
			{ from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, fromHeading: from.heading },
		);
	} catch {
		return still({ x: to.x, y: to.y, heading: from.heading }, 0);
	}
	const samples = trajectory.samples;
	const totalSeconds = trajectory.duration();
	if (samples.length < 2 || !(totalSeconds > 0)) {
		return still({ x: to.x, y: to.y, heading: trajectory.end().heading }, 0);
	}
	// 先端が着く時刻を今の式に揃える（cursor-motion の固定時間は滑り全体の長さで、着く時刻とは少しずれる）
	const scale = trajectory.arrivalT > 0 ? arrivalMs / (trajectory.arrivalT * 1000) : 1;
	const durationMs = Math.max(1, Math.round(totalSeconds * 1000 * scale));
	const step = Math.max(1, Math.ceil((samples.length - 1) / (MAX_FRAMES - 1)));
	const frames: IParadisCursorKeyframe[] = [];
	for (let i = 0; i < samples.length; i += step) {
		const sample = samples[i];
		frames.push({ x: round1(sample.x), y: round1(sample.y), r: rotationDeg(sample.heading), o: Math.min(1, Math.max(0, sample.t / totalSeconds)) });
	}
	const last = samples[samples.length - 1];
	if (frames[frames.length - 1].o < 1) {
		frames.push({ x: round1(last.x), y: round1(last.y), r: rotationDeg(last.heading), o: 1 });
	}
	return { frames, durationMs, arrivalMs: Math.round(arrivalMs), endHeading: last.heading };
}

/**
 * 再生の途中の姿勢。次の移動を今いる場所から始めるために使う（ページへは問い合わせない）。
 * 再生が終わっていれば最後の姿勢。
 */
export function paradisSampleCursorGlide(glide: IParadisCursorGlide, elapsedMs: number): IParadisCursorPose {
	const frames = glide.frames;
	const last = frames[frames.length - 1];
	const toPose = (frame: IParadisCursorKeyframe): IParadisCursorPose => ({ x: frame.x, y: frame.y, heading: REST_HEADING + frame.r * Math.PI / 180 });
	if (glide.durationMs <= 0 || elapsedMs >= glide.durationMs) {
		return { ...toPose(last), heading: glide.endHeading };
	}
	const at = Math.max(0, elapsedMs / glide.durationMs);
	for (let i = 1; i < frames.length; i++) {
		const b = frames[i];
		if (b.o >= at) {
			const a = frames[i - 1];
			const span = b.o - a.o;
			const f = span > 0 ? (at - a.o) / span : 1;
			return {
				x: a.x + (b.x - a.x) * f,
				y: a.y + (b.y - a.y) * f,
				heading: REST_HEADING + (a.r + (b.r - a.r) * f) * Math.PI / 180,
			};
		}
	}
	return toPose(last);
}
