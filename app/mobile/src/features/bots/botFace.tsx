// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo } from 'react';
import Svg, { Circle, Ellipse, G, Path, Polygon, Rect } from 'react-native-svg';
import { colors } from '../../theme.js';
import type { BotFaceColor, BotFaceShape, BotFaceState } from './bots.js';

/** 顔の色（PC の `.paradis-bot-face[data-color]` に当たるアプリの色）。 */
const FACE_COLORS: Record<BotFaceColor, string> = {
	blue: colors.blue,
	teal: colors.teal,
	green: colors.green,
	amber: colors.amber,
	pink: colors.pink,
	violet: colors.purple,
	red: colors.red,
	orange: colors.orange,
};

export function botFaceColor(color: BotFaceColor): string {
	return FACE_COLORS[color];
}

/** 体の薄さ（PC の帯の CSS と同じ: 起動していない・一時停止中は 0.5、終了した・見つからないは 0.6）。 */
function bodyOpacity(state: BotFaceState): number {
	switch (state) {
		case 'off':
		case 'paused': return 0.5;
		case 'halt': return 0.6;
		default: return 1;
	}
}

/** 目の位置のずれ（PC の帯と同じ: 作業中は右上、見回り中は左）。 */
function eyeShift(state: BotFaceState): { readonly x: number; readonly y: number } {
	switch (state) {
		case 'work': return { x: 7, y: -7 };
		case 'patrol': return { x: -8, y: 0 };
		default: return { x: 0, y: 0 };
	}
}

/** 小道具を出す大きさ（PC の帯と同じ: 「?」と汗は 18pt から、ほかは 22pt から）。 */
const PROPS_ATTENTION_MIN = 18;
const PROPS_ALL_MIN = 22;

/**
 * Bot の顔（PC の `renderParadisBotFace` と同じ形: 100×100 の枠に体と 2 つの目）。
 *
 * `state`（`bots.status.v1` の PC のときだけ。{@link botFaceState}）があれば、PC の帯の顔の止まった姿（動きを切ったときに残る
 * 形）を描く: 眠っている＝閉じた目と「z z」、起動していない＝横の線の目と薄い体、作業中＝上を見る目と 3 つの点、見回り中＝
 * 横を見る目と虫めがね、要対応＝「?」、操作が要る＝細めた目と汗、終了した＝細めた目と薄い体、一時停止中＝薄い体と 2 本線。
 * 小道具が枠の外（上）にはみ出すので、そのときは枠を上と右へ広げる（同じ置き場所では様子が変わっても体の大きさは変えない）。
 * `state` が無いとき（古い PC）は今までどおり開いた目で、`dim` なら薄くする。
 */
export const BotFace = memo(function BotFace({ color, shape, size, dim = false, state }: { color: BotFaceColor; shape: BotFaceShape; size: number; dim?: boolean; state?: BotFaceState | undefined }) {
	const fill = FACE_COLORS[color];
	const body = (() => {
		switch (shape) {
			case 'circle': return <Circle cx="50" cy="52" r="42" fill={fill} />;
			case 'squircle': return <Rect x="9" y="11" width="82" height="82" rx="30" fill={fill} />;
			case 'hex': return <Polygon points="50,12 86,31 86,69 50,88 14,69 14,31" fill={fill} stroke={fill} strokeWidth="14" strokeLinejoin="round" />;
			case 'blob': return <Path d="M50 8C78 6 94 30 92 56C90 82 66 94 44 92C20 90 8 70 10 46C12 22 30 10 50 8Z" fill={fill} />;
			case 'drop': return <Path d="M46 6C70 4 90 28 90 56C90 80 72 94 50 94C28 94 10 80 10 58C10 30 24 8 46 6Z" fill={fill} />;
			case 'penta': return <Polygon points="50,14 88,41 74,86 26,86 12,41" fill={fill} stroke={fill} strokeWidth="14" strokeLinejoin="round" />;
		}
	})();
	if (state === undefined) {
		return (
			<Svg width={size} height={size} viewBox="0 0 100 100" opacity={dim ? 0.45 : 1} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
				{body}
				<Ellipse cx="38" cy="47" rx="5.5" ry="10" fill={colors.bg} />
				<Ellipse cx="62" cy="45" rx="5.5" ry="10" fill={colors.bg} />
			</Svg>
		);
	}
	const attentionProps = size >= PROPS_ATTENTION_MIN;
	const allProps = size >= PROPS_ALL_MIN;
	const shift = eyeShift(state);
	const narrowed = state === 'need' || state === 'halt';
	const eyeLine = { fill: 'none', stroke: colors.bg, strokeWidth: 6, strokeLinecap: 'round' as const };
	const prop = { fill: 'none', stroke: colors.textMuted, strokeWidth: 5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
	const eyes = (() => {
		switch (state) {
			case 'sleep': return (
				<G {...eyeLine}>
					<Path d="M32 46Q38 53 44 46" />
					<Path d="M56 44Q62 51 68 44" />
				</G>
			);
			case 'off': return (
				<G {...eyeLine}>
					<Path d="M32 48H44" />
					<Path d="M56 46H68" />
				</G>
			);
			default: return (
				<G transform={`translate(${shift.x} ${shift.y})`}>
					<Ellipse cx="38" cy="47" rx="5.5" ry={narrowed ? 4.5 : 10} fill={colors.bg} />
					<Ellipse cx="62" cy="45" rx="5.5" ry={narrowed ? 4.5 : 10} fill={colors.bg} />
				</G>
			);
		}
	})();
	const props = (() => {
		switch (state) {
			case 'work': return allProps ? (
				<G fill={colors.textMuted}>
					<Circle cx="36" cy="-6" r="4.5" />
					<Circle cx="50" cy="-6" r="4.5" />
					<Circle cx="64" cy="-6" r="4.5" />
				</G>
			) : null;
			case 'patrol': return allProps ? (
				<G {...prop}>
					<Circle cx="80" cy="16" r="9" />
					<Path d="M86.5 22.5L95 31" />
				</G>
			) : null;
			case 'sleep': return allProps ? (
				<G {...prop} strokeWidth={4}>
					<Path d="M74 8H84L74 18H84" />
					<Path d="M88 -6H95L88 1H95" />
				</G>
			) : null;
			case 'paused': return allProps ? (
				<G fill={colors.textMuted}>
					<Rect x="78" y="2" width="6" height="18" rx="2" />
					<Rect x="89" y="2" width="6" height="18" rx="2" />
				</G>
			) : null;
			case 'ask': return attentionProps ? (
				<G>
					<Circle cx="86" cy="16" r="16" fill={colors.bg} />
					<Path d="M80 11Q80 4 86 4Q92 4 92 10Q92 14 86 17V20" {...prop} stroke={colors.amber} strokeWidth={5.5} />
					<Circle cx="86" cy="27" r="2.6" fill={colors.amber} />
				</G>
			) : null;
			case 'need': return attentionProps ? (
				<Path d="M86 14C91 22 94 27 94 31A8 8 0 0 1 78 31C78 27 81 22 86 14Z" fill={colors.blue} stroke={colors.bg} strokeWidth={3} />
			) : null;
			default: return null;
		}
	})();
	return (
		<Svg width={size} height={size} viewBox={attentionProps ? '0 -12 108 112' : '0 0 100 100'} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
			<G opacity={bodyOpacity(state)}>{body}</G>
			{eyes}
			{props}
		</Svg>
	);
});
