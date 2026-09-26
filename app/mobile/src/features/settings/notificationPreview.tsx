// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from '../../theme.js';
import { ParaLogo } from '../pairing/paraLogo.js';

/** 見本の通知（実データではない。エージェントの種類と、よくある出来事の言い回しだけ）。 */
const SAMPLES: readonly { readonly title: string; readonly body: string }[] = [
	{ title: 'Claude が入力を待っています', body: '認証フローの整理' },
	{ title: 'Codex が完了しました', body: 'テストが通りました。' },
];

/** 降りてくる・留まる・消える の時間（ms。モックの `ndrop` 4.8 秒周期）。 */
const DROP_MS = 450;
const HOLD_MS = 3_200;
const FADE_MS = 450;
const REST_MS = 700;
/** 2枚目の遅れ（ms。モックの animation-delay .55s）。 */
const STAGGER_MS = 550;
/** 降りてくる距離（pt）。 */
const DROP_DISTANCE = 16;
/** 印の台（pt。モックの `.nlogo` 34×34）。 */
const LOGO_TILE = 34;

/**
 * 「はじめて」の2ページ目の、通知の見本（モックの `.nstack`、Orca の NotificationOnboardingPreview）。
 * OS の通知のバナーに似せた2枚が、少しずらして上から降りてきては消えるのを繰り返す。
 * 視差効果を減らす設定のときは動かさずに置くだけにする。
 */
export function NotificationPreview() {
	const progress = useRef(SAMPLES.map(() => new Animated.Value(0))).current;
	useEffect(() => {
		let loop: Animated.CompositeAnimation | undefined;
		let cancelled = false;
		void AccessibilityInfo.isReduceMotionEnabled().then(reduced => {
			if (cancelled) {
				return;
			}
			if (reduced) {
				progress.forEach(value => value.setValue(1));
				return;
			}
			loop = Animated.loop(Animated.stagger(STAGGER_MS, progress.map(value => Animated.sequence([
				Animated.timing(value, { toValue: 1, duration: DROP_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
				Animated.delay(HOLD_MS),
				Animated.timing(value, { toValue: 0, duration: FADE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
				Animated.delay(REST_MS),
			]))));
			loop.start();
		}).catch(() => progress.forEach(value => value.setValue(1)));
		return () => {
			cancelled = true;
			loop?.stop();
		};
	}, [progress]);
	return (
		<View style={styles.stack} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
			{SAMPLES.map((sample, index) => {
				const value = progress[index];
				if (value === undefined) {
					return null;
				}
				return (
					<Animated.View
						key={sample.title}
						style={[styles.banner, {
							opacity: value,
							transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [-DROP_DISTANCE, 0] }) }],
						}]}
					>
						<View style={styles.logo}><ParaLogo size={20} /></View>
						<View style={styles.text}>
							<Text style={styles.title} numberOfLines={1}>{sample.title}</Text>
							<Text style={styles.body} numberOfLines={1}>{sample.body}</Text>
						</View>
						<Text style={styles.time}>いま</Text>
					</Animated.View>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	stack: {
		width: '100%',
		gap: space.sm,
		marginBottom: space.xl + space.xs,
	},
	banner: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm + 2,
		paddingVertical: space.sm + 2,
		paddingHorizontal: space.md,
		borderRadius: radius.sheet,
		// OS のバナーの灰（モックの rgba(58,58,60,.85)）に近い、トークンの中でいちばん明るい面
		backgroundColor: colors.borderStrong,
	},
	logo: {
		width: LOGO_TILE,
		height: LOGO_TILE,
		borderRadius: radius.row,
		backgroundColor: colors.bg,
		alignItems: 'center',
		justifyContent: 'center',
	},
	text: {
		flex: 1,
		minWidth: 0,
	},
	title: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	body: {
		fontSize: type.label,
		color: colors.textDim,
	},
	time: {
		alignSelf: 'flex-start',
		fontSize: type.caption,
		color: colors.textMuted,
	},
});
