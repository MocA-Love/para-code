// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo } from 'react';
import Svg, { Circle, Ellipse, Path, Polygon, Rect } from 'react-native-svg';
import { colors } from '../../theme.js';
import type { BotFaceColor, BotFaceShape } from './bots.js';

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

/**
 * Bot の顔（PC の `renderParadisBotFace` と同じ形: 100×100 の枠に体と 2 つの目）。一時停止中は薄くする。
 */
export const BotFace = memo(function BotFace({ color, shape, size, dim = false }: { color: BotFaceColor; shape: BotFaceShape; size: number; dim?: boolean }) {
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
	return (
		<Svg width={size} height={size} viewBox="0 0 100 100" opacity={dim ? 0.45 : 1} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
			{body}
			<Ellipse cx="38" cy="47" rx="5.5" ry="10" fill={colors.bg} />
			<Ellipse cx="62" cy="45" rx="5.5" ry="10" fill={colors.bg} />
		</Svg>
	);
});
