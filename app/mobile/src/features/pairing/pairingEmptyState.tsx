// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { QrCode } from 'lucide-react-native';
import { useAppStore } from '../../appState.js';
import { hapticImpact } from '../../haptics.js';
import { routes } from '../../routes.js';
import { colors, radius, space, type } from '../../theme.js';
import { Icon, SectionHeader, iconSize } from '../../ui/index.js';

/**
 * PC を1台もペアリングしていないか（起動の読み込みが済んだうえで）。
 *
 * 旧来は自動で `/pair` へ飛ばす処理は無く、ホームのタブ（`legacy-screens/(tabs)/index.tsx`）と
 * 接続ガード（`src/components/connectionGate.tsx`）が `ready && !paired` のときに
 * 「ペアリングが必要です」を出していた。新しい構成ではホーム（`app/index.tsx`）がこれを見て
 * 下の {@link PairingEmptyState} を出す。読み込み前（`ready` が false）は true にしない
 * （起動直後に一瞬この案内が見えるのを防ぐ）。
 */
export function usePairingRequired(): boolean {
	return useAppStore(s => s.ready && !s.paired);
}

const STEPS: readonly { readonly title: string; readonly body: string }[] = [
	{ title: 'PC で Para Code を開く', body: 'コマンドパレットで「Para Code: モバイルデバイスを接続」を実行し、ペアリング用の QR コードを出します。' },
	{ title: 'コードを読み取る', body: '上のボタンを押すと読み取りの画面が開きます。PC の画面の QR コードに向けてください。' },
	{ title: 'つながりました', body: 'PC がここに出ます。通信はすべて端末どうしで暗号化されます。' },
];

/**
 * 未ペアリングのホームの本文（モックの「未ペアリング」、Orca の MobileHomeEmptyState）。
 * 見出し・説明・白い主ボタン「デスクトップとペアリング」と、下に「しくみ」の3手順。
 * ホームの見出し（ロゴと設定のボタン）は置き場所（ホーム）が描く。
 */
export function PairingEmptyState() {
	const router = useRouter();
	return (
		<ScrollView contentContainerStyle={styles.root}>
			<View style={styles.hero}>
				<Text style={styles.title} accessibilityRole="header">デスクトップをつなぐ</Text>
				<Text style={styles.body}>PC の Para Code とペアリングすると、エージェントの様子を確かめたり、どのターミナルにも入ったり、スマホから作業を進めたりできます。</Text>
				<Pressable
					onPress={() => { hapticImpact('medium'); router.push(routes.pair()); }}
					style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : undefined]}
					accessibilityRole="button"
					accessibilityLabel="デスクトップとペアリング"
				>
					<Icon icon={QrCode} size={iconSize.md} color={colors.onPrimary} />
					<Text style={styles.buttonText}>デスクトップとペアリング</Text>
				</Pressable>
			</View>
			<View style={styles.steps}>
				<SectionHeader title="しくみ" />
				{STEPS.map((step, index) => (
					<View key={step.title} style={[styles.step, index > 0 ? styles.stepDivider : undefined]}>
						<View style={styles.stepNumber}><Text style={styles.stepNumberText}>{index + 1}</Text></View>
						<View style={styles.stepText}>
							<Text style={styles.stepTitle}>{step.title}</Text>
							<Text style={styles.stepBody}>{step.body}</Text>
						</View>
					</View>
				))}
			</View>
		</ScrollView>
	);
}

/** 手順の番号の枠（pt。モックの `.stepn`）。 */
const STEP_NUMBER_SIZE = 28;
/** 説明の最大幅（pt）。iPad で1行が伸びきらないように。 */
const BODY_MAX_WIDTH = 420;

const styles = StyleSheet.create({
	root: {
		flexGrow: 1,
	},
	hero: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: space.xl + space.sm,
		paddingTop: space.xl,
		paddingBottom: space.xl + space.lg,
	},
	title: {
		fontSize: type.large,
		fontWeight: '700',
		color: colors.text,
		textAlign: 'center',
		marginBottom: space.sm + 2,
	},
	body: {
		fontSize: type.input,
		lineHeight: 22,
		color: colors.textDim,
		textAlign: 'center',
		marginBottom: space.xl + space.sm,
		maxWidth: BODY_MAX_WIDTH,
	},
	button: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm + 2,
		backgroundColor: colors.primary,
		paddingVertical: space.md + 2,
		paddingHorizontal: space.xl + space.xs,
		borderRadius: radius.card,
	},
	buttonPressed: {
		opacity: 0.8,
	},
	buttonText: {
		fontSize: type.input,
		fontWeight: '700',
		color: colors.onPrimary,
	},
	steps: {
		paddingHorizontal: space.xl,
		paddingBottom: space.xl + space.lg,
	},
	step: {
		flexDirection: 'row',
		gap: space.md + 2,
		paddingVertical: space.lg,
	},
	stepDivider: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	stepNumber: {
		width: STEP_NUMBER_SIZE,
		height: STEP_NUMBER_SIZE,
		borderRadius: radius.row,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.panel,
		alignItems: 'center',
		justifyContent: 'center',
		marginTop: 1,
	},
	stepNumberText: {
		fontSize: type.meta,
		fontWeight: '700',
		color: colors.textDim,
	},
	stepText: {
		flex: 1,
		minWidth: 0,
	},
	stepTitle: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
		marginBottom: 3,
	},
	stepBody: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
	},
});
