// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { hapticSelection } from '../haptics.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { hitSlopToMinimum } from '../components/hitSlop.js';
import { PointerHover } from '../ipad/pointerHover.js';
import { useWindowControlsInset } from '../ipad/windowControls.js';
import { colors, radius, space, type } from '../theme.js';
import { Icon, iconSize, type LucideIcon } from './icon.js';

/** 丸い戻る・右の操作の見た目の大きさ（pt。モックの `.back36` / `.hbtn`）。当たり判定は 44 に広げる。 */
const BUTTON_SIZE = 36;

/**
 * ヘッダーの右に並べる操作（モックの `.hbtn`: 36×36・角丸 6・アイコン 18）。
 * `badge` を渡すと右上に赤い件数を出す（通知のベル）。`active` は押しっぱなしの状態の地。
 */
export function HeaderButton({ icon, label, onPress, badge, badgeTone = 'alert', active = false, round = false, disabled = false, color = colors.textDim }: {
	icon: LucideIcon;
	/** 読み上げの名前（必須。アイコンだけのボタンなので）。 */
	label: string;
	onPress: () => void;
	badge?: number;
	/** 件数の地。`neutral` は灰（メモの未完了のように、急ぎではない件数）。 */
	badgeTone?: 'alert' | 'neutral';
	active?: boolean;
	/** 丸い地（ホームの見出しの `.iconbtn`）。既定は角丸 6 の四角。 */
	round?: boolean;
	disabled?: boolean;
	color?: string;
}) {
	return (
		<PointerHover effect="highlight" cornerRadius={round ? BUTTON_SIZE / 2 : radius.button}>
		<Pressable
			onPress={onPress}
			disabled={disabled}
			hitSlop={hitSlopToMinimum(BUTTON_SIZE, BUTTON_SIZE)}
			style={({ pressed }) => [
				styles.button,
				round ? styles.round : undefined,
				pressed || active ? styles.buttonOn : undefined,
				disabled ? styles.disabled : undefined,
			]}
			accessibilityRole="button"
			accessibilityLabel={badge !== undefined && badge > 0 ? `${label}、${badge}件` : label}
			accessibilityState={{ disabled, selected: active }}
		>
			<Icon icon={icon} size={iconSize.lg} color={color} />
			{badge !== undefined && badge > 0 ? (
				<View style={[styles.badge, badgeTone === 'neutral' ? styles.badgeNeutral : undefined]}><Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text></View>
			) : null}
		</Pressable>
		</PointerHover>
	);
}

/** `ScreenHeader` の `meta` に状態の点と並べて置く 12pt の補足（モックの `.smeta`）。 */
export function HeaderMetaText({ children }: { children: string }) {
	return <Text style={styles.metaText} numberOfLines={1}>{children}</Text>;
}

/**
 * ヘッダーの寸法の種類（モックの3種）。
 *  - `session`: セッション画面の上（`.stop`。高さ 44、タイトル 14）。下に `meta` の行を持つ
 *  - `standard`: ファイル・差分など（`.gtop`。高さ 58、タイトル 18）
 *  - `settings`: 設定まわり（`.settop`。タイトル 20）
 */
export type ScreenHeaderVariant = 'session' | 'standard' | 'settings';

/**
 * 画面の上端の自前ヘッダー（OS 標準のナビゲーションバーは使わない）。
 * 左に丸い戻る（36pt、当たり判定 44）、タイトルと補足、右に操作。セーフエリアの上端ぶんは
 * ここで空ける（`safeTop={false}` で外せる）。iPad のウィンドウアプリで左上に出る操作ボタンも、
 * `safeTop` のときはここで避ける（`useWindowControlsInset()`）。
 *
 * 戻るの既定は「前の画面へ」。通知からいきなり開いたときのように戻る先が無ければホームへ移る。
 *
 * ```tsx
 * <ScreenHeader
 *   title="ファイル"
 *   subtitle="para-code · main"
 *   right={<HeaderButton icon={Search} label="ファイルを検索" onPress={toggleSearch} />}
 * />
 * ```
 */
export function ScreenHeader({
	title, subtitle, meta, right, children, variant = 'standard', surface = 'base', safeTop = true,
	back = true, onBack, backLabel = '戻る', backIcon = ChevronLeft, leading,
}: {
	title: string;
	/** タイトルの下の 12pt の補足（スペース名・ブランチなど）。 */
	subtitle?: string;
	/** 補足の代わりに置く任意の行（状態の点＋文字など）。 */
	meta?: ReactNode;
	/** 右端の操作（`HeaderButton` を並べる）。 */
	right?: ReactNode;
	/** ヘッダーの帯の中で、タイトル行の下に置くもの（タブの列・ツールバーなど）。 */
	children?: ReactNode;
	variant?: ScreenHeaderVariant;
	/** `panel` にすると帯を `colors.panel` で塗り、下に境界線を引く（モックの `.chrome`）。 */
	surface?: 'base' | 'panel';
	safeTop?: boolean;
	/** 戻るを出すか（ホームなど根の画面では false）。 */
	back?: boolean;
	onBack?: () => void;
	backLabel?: string;
	/** 戻るのアイコン（iPad のドックでは閉じる X）。 */
	backIcon?: LucideIcon;
	/** 戻るより左に置くもの（iPad で隠した左の列を戻すボタン）。 */
	leading?: ReactNode;
}) {
	const router = useRouter();
	const insets = useStableInsets();
	// iPad のウィンドウアプリでは左上に操作ボタンが出る。画面の上端に置くとき（`safeTop`）だけ、その右から始める。
	const controlsInset = useWindowControlsInset();
	const goBack = () => {
		hapticSelection();
		if (onBack !== undefined) {
			onBack();
			return;
		}
		if (router.canGoBack()) {
			router.back();
		} else {
			router.replace('/');
		}
	};
	const titleStyle = variant === 'session' ? styles.titleSession : variant === 'settings' ? styles.titleSettings : styles.titleStandard;
	const rowStyle = variant === 'session' ? styles.rowSession : variant === 'settings' ? styles.rowSettings : styles.rowStandard;
	return (
		<View style={[surface === 'panel' ? styles.chrome : undefined, { paddingTop: safeTop ? insets.top : 0 }]}>
			<View style={[styles.row, rowStyle, safeTop && controlsInset > 0 ? { paddingLeft: space.sm + controlsInset } : undefined]}>
				{leading}
				{back ? (
					<PointerHover effect="highlight" cornerRadius={BUTTON_SIZE / 2}>
					<Pressable
						onPress={goBack}
						hitSlop={hitSlopToMinimum(BUTTON_SIZE, BUTTON_SIZE)}
						style={({ pressed }) => [styles.back, pressed ? styles.buttonOn : undefined]}
						accessibilityRole="button"
						accessibilityLabel={backLabel}
					>
						<Icon icon={backIcon} size={iconSize.back} color={colors.textDim} strokeWidth={2.2} />
					</Pressable>
					</PointerHover>
				) : null}
				<View style={styles.titleCol}>
					<Text style={titleStyle} numberOfLines={1} accessibilityRole="header">{title}</Text>
					{meta !== undefined ? <View style={styles.meta}>{meta}</View> : subtitle !== undefined ? (
						<Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
					) : null}
				</View>
				{right !== undefined ? <View style={styles.right}>{right}</View> : null}
			</View>
			{children}
		</View>
	);
}

const styles = StyleSheet.create({
	chrome: {
		backgroundColor: colors.panel,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: space.sm,
	},
	rowSession: {
		minHeight: 44,
		paddingVertical: space.xs,
	},
	rowStandard: {
		minHeight: 58,
	},
	rowSettings: {
		minHeight: 58,
	},
	back: {
		width: BUTTON_SIZE,
		height: BUTTON_SIZE,
		borderRadius: radius.pill,
		alignItems: 'center',
		justifyContent: 'center',
		marginRight: space.xs,
	},
	titleCol: {
		flex: 1,
		minWidth: 0,
	},
	titleSession: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	titleStandard: {
		fontSize: type.title,
		fontWeight: '600',
		color: colors.text,
	},
	titleSettings: {
		fontSize: type.large,
		fontWeight: '700',
		color: colors.text,
	},
	subtitle: {
		fontSize: type.meta,
		color: colors.textDim,
		marginTop: 2,
	},
	meta: {
		flexDirection: 'row',
		alignItems: 'center',
		marginTop: 2,
	},
	metaText: {
		flexShrink: 1,
		fontSize: type.meta,
		color: colors.textDim,
	},
	right: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		marginLeft: space.xs,
	},
	button: {
		width: BUTTON_SIZE,
		height: BUTTON_SIZE,
		borderRadius: radius.button,
		alignItems: 'center',
		justifyContent: 'center',
	},
	round: {
		borderRadius: radius.pill,
	},
	buttonOn: {
		backgroundColor: colors.raised,
	},
	disabled: {
		opacity: 0.45,
	},
	badge: {
		position: 'absolute',
		top: 2,
		right: 0,
		minWidth: 16,
		height: 16,
		borderRadius: radius.pill,
		backgroundColor: colors.red,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: space.xs,
	},
	badgeNeutral: {
		backgroundColor: colors.borderStrong,
	},
	badgeText: {
		fontSize: type.badge,
		fontWeight: '700',
		color: colors.onRed,
	},
});
