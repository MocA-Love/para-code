// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Bell, ChevronRight, Plus, QrCode, Settings, SquareTerminal } from 'lucide-react-native';
import { ProviderLogo } from '../../components/providerLogo.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import type { RateLimitAccount, RateLimitsResult } from '../../store.js';
import { colors, radius, space, type } from '../../theme.js';
import { pickRateLimitAccount } from '../../usageFormat.js';
import { Card, HeaderButton, Icon, Meter, MeterRow, SectionHeader, iconSize, useThemeColors } from '../../ui/index.js';
import { ParaLogo } from '../pairing/paraLogo.js';
import { accountName } from '../settings/usageSummary.js';

/**
 * ホーム（Orca の MobileHomeScreen）の部品。寸法はモック（concept-orca.html の `.topbar` `.stats`
 * `.resume` `.qas` `.usagecard`）の値。
 */

/** 上端の帯（ロゴと「Para Code」、右に通知のベルと設定）。セーフエリアの上端ぶんはここで空ける。 */
export function HomeTopBar({ unread, onNotifications, onSettings, showBell = true }: {
	unread: number;
	onNotifications: () => void;
	onSettings: () => void;
	/** PC が無いとき（ペアリング前）はベルを出さない（モックの空の状態）。 */
	showBell?: boolean;
}) {
	const insets = useStableInsets();
	return (
		<View style={[styles.topBar, { paddingTop: insets.top + space.sm }]}>
			<View style={styles.brand}>
				<ParaLogo size={BRAND_LOGO} />
				<Text style={styles.brandText} accessibilityRole="header">Para Code</Text>
			</View>
			<View style={styles.topActions}>
				{showBell ? <HeaderButton icon={Bell} label="通知" round badge={unread} onPress={onNotifications} /> : null}
				<HeaderButton icon={Settings} label="設定" round onPress={onSettings} />
			</View>
		</View>
	);
}

/** 統計カード3枚（モックの `.stats`）。 */
export function StatCards({ items }: { items: readonly { readonly label: string; readonly value: string }[] }) {
	return (
		<View style={styles.stats}>
			{items.map(item => (
				<View key={item.label} style={styles.stat} accessible accessibilityLabel={`${item.label} ${item.value}`}>
					<Text style={styles.statValue} numberOfLines={1}>{item.value}</Text>
					<Text style={styles.statLabel} numberOfLines={1}>{item.label}</Text>
				</View>
			))}
		</View>
	);
}

/** アイコンを載せる角丸の台（PC のカード・再開カードの 46×46）。 */
export function IconTile({ children }: { children: ReactNode }) {
	return <View style={styles.tile}>{children}</View>;
}

/** 「再開」カード（最後に開いたセッションへ）。 */
export function ResumeCard({ title, subtitle, dotColor, onPress }: { title: string; subtitle: string; dotColor: string | undefined; onPress: () => void }) {
	return (
		<Card onPress={onPress} style={styles.resume} accessibilityLabel={`再開、${title}、${subtitle}`}>
			<IconTile><Icon icon={SquareTerminal} size={iconSize.lg} color={colors.textDim} /></IconTile>
			<View style={styles.resumeBody}>
				<Text style={styles.resumeTitle} numberOfLines={1}>{title}</Text>
				<View style={styles.resumeSub}>
					{dotColor !== undefined ? <View style={[styles.repoDot, { backgroundColor: dotColor }]} /> : null}
					<Text style={styles.resumeSubText} numberOfLines={1}>{subtitle}</Text>
				</View>
			</View>
			<Icon icon={ChevronRight} size={iconSize.md} color={colors.textMuted} />
		</Card>
	);
}

/** クイック操作2枚（デスクトップをペアリング・新しいスペース）。 */
export function QuickActions({ onPair, onNewSpace, newSpaceDisabled }: { onPair: () => void; onNewSpace: () => void; newSpaceDisabled: boolean }) {
	return (
		<View style={styles.quickRow}>
			<QuickAction icon={<Icon icon={QrCode} size={iconSize.md} color={colors.textDim} />} label="デスクトップをペアリング" onPress={onPair} />
			<QuickAction icon={<Icon icon={Plus} size={iconSize.md} color={colors.textDim} />} label="新しいスペース" onPress={onNewSpace} disabled={newSpaceDisabled} />
		</View>
	);
}

function QuickAction({ icon, label, onPress, disabled = false }: { icon: ReactNode; label: string; onPress: () => void; disabled?: boolean }) {
	return (
		<Pressable
			style={({ pressed }) => [styles.quick, pressed ? styles.quickPressed : undefined, disabled ? styles.disabled : undefined]}
			onPress={onPress}
			disabled={disabled}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled }}
		>
			<View style={styles.quickIcon}>{icon}</View>
			<Text style={styles.quickText} numberOfLines={2}>{label}</Text>
		</Pressable>
	);
}

/** アカウントの使用量（Claude / Codex の 5時間・7日）。押すと使用量の画面へ。 */
export function AccountUsageCard({ limits, onPress }: { limits: RateLimitsResult | undefined; onPress: () => void }) {
	const rows: { provider: 'claude' | 'codex'; account: RateLimitAccount | undefined }[] = [
		{ provider: 'claude', account: limits !== undefined ? pickRateLimitAccount(limits.claude) : undefined },
		{ provider: 'codex', account: limits !== undefined ? pickRateLimitAccount(limits.codex) : undefined },
	];
	return (
		<Card onPress={onPress} style={styles.usage} accessibilityLabel="アカウントの使用量を開く">
			{rows.map(row => (
				<View key={row.provider} style={styles.usageRow}>
					<View style={styles.usageIcon}><ProviderLogo provider={row.provider} size={iconSize.lg} /></View>
					<View style={styles.usageInfo}>
						<Text style={styles.usageName} numberOfLines={1}>
							{row.account !== undefined ? accountName(row.account) : limits === undefined ? '読み込み中…' : 'アカウントがありません'}
						</Text>
						<MeterRow>
							<Meter label="5時間" percent={row.account?.fiveHour?.usedPercent} />
							<Meter label="7日" percent={row.account?.sevenDay?.usedPercent} />
						</MeterRow>
					</View>
				</View>
			))}
		</Card>
	);
}

/** PC が1台も無いときのホーム（Orca の MobileHomeEmptyState）。 */
export function HomeEmptyState({ onPair }: { onPair: () => void }) {
	const theme = useThemeColors();
	const steps = [
		{ title: 'PC で Para Code を開く', body: '設定 → モバイル を開き、ペアリング用の QR コードを表示します。' },
		{ title: 'コードを読み取る', body: '上のボタンを押すと読み取り画面が開きます。PC の画面の QR コードに向けてください。' },
		{ title: '接続できました', body: 'PC がここに表示されます。通信はすべて端末間で暗号化されます。' },
	];
	return (
		<View style={styles.empty}>
			<View style={styles.emptyHero}>
				<Text style={styles.emptyTitle} accessibilityRole="header">デスクトップをつなぐ</Text>
				<Text style={styles.emptyBody}>PC の Para Code とペアリングすると、エージェントの様子を確かめたり、どのターミナルにも入ったり、スマホから作業を進めたりできます。</Text>
				<Pressable
					style={({ pressed }) => [styles.pairButton, { backgroundColor: theme.primary }, pressed ? styles.pairButtonPressed : undefined]}
					onPress={onPair}
					accessibilityRole="button"
					accessibilityLabel="デスクトップとペアリング"
				>
					<Icon icon={QrCode} size={iconSize.lg} color={theme.onPrimary} />
					<Text style={[styles.pairButtonText, { color: theme.onPrimary }]}>デスクトップとペアリング</Text>
				</Pressable>
			</View>
			<View style={styles.steps}>
				<SectionHeader title="しくみ" />
				{steps.map((step, index) => (
					<View key={step.title} style={[styles.step, index > 0 ? styles.stepBorder : undefined]}>
						<View style={styles.stepNumber}><Text style={styles.stepNumberText}>{index + 1}</Text></View>
						<View style={styles.stepBody}>
							<Text style={styles.stepTitle}>{step.title}</Text>
							<Text style={styles.stepText}>{step.body}</Text>
						</View>
					</View>
				))}
			</View>
		</View>
	);
}

/** モックの寸法（pt）。 */
const BRAND_LOGO = 18;
const TILE_SIZE = 46;
const QUICK_ICON = 28;
const USAGE_ICON = 32;
const REPO_DOT = 7;
const STEP_NUMBER = 28;

const styles = StyleSheet.create({
	topBar: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingHorizontal: space.lg,
		paddingBottom: space.md,
	},
	brand: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		flexShrink: 1,
	},
	brandText: {
		fontSize: type.chat,
		fontWeight: '700',
		color: colors.text,
	},
	topActions: {
		flexDirection: 'row',
		gap: 2,
	},
	stats: {
		flexDirection: 'row',
		gap: space.sm + 2,
		marginBottom: space.lg,
	},
	stat: {
		flex: 1,
		minWidth: 0,
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: radius.tile,
		paddingVertical: space.sm,
		paddingHorizontal: space.md,
	},
	statValue: {
		fontSize: type.title,
		fontWeight: '700',
		letterSpacing: -0.3,
		color: colors.text,
	},
	statLabel: {
		fontSize: type.caption,
		fontWeight: '500',
		color: colors.textMuted,
		marginTop: 2,
	},
	tile: {
		width: TILE_SIZE,
		height: TILE_SIZE,
		borderRadius: radius.group,
		backgroundColor: colors.raised,
		alignItems: 'center',
		justifyContent: 'center',
		marginRight: space.md + 2,
	},
	resume: {
		flexDirection: 'row',
		alignItems: 'center',
		padding: space.md,
	},
	resumeBody: {
		flex: 1,
		minWidth: 0,
		marginRight: space.sm,
	},
	resumeTitle: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	resumeSub: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs + 2,
		marginTop: 3,
	},
	repoDot: {
		width: REPO_DOT,
		height: REPO_DOT,
		borderRadius: radius.pill,
	},
	resumeSubText: {
		flexShrink: 1,
		fontSize: type.meta,
		color: colors.textDim,
	},
	quickRow: {
		flexDirection: 'row',
		gap: space.sm,
	},
	quick: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm + 2,
		minHeight: 48,
		paddingVertical: space.sm + 2,
		paddingHorizontal: space.md,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: radius.card,
		backgroundColor: colors.panel,
	},
	quickPressed: {
		backgroundColor: colors.raised,
	},
	quickIcon: {
		width: QUICK_ICON,
		height: QUICK_ICON,
		borderRadius: radius.tile,
		backgroundColor: colors.raised,
		alignItems: 'center',
		justifyContent: 'center',
	},
	quickText: {
		flex: 1,
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.textDim,
	},
	usage: {
		gap: space.sm,
		paddingVertical: space.sm + 2,
		paddingHorizontal: space.md,
	},
	usageRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm + 2,
	},
	usageIcon: {
		width: USAGE_ICON,
		height: USAGE_ICON,
		borderRadius: radius.tile,
		backgroundColor: colors.raised,
		alignItems: 'center',
		justifyContent: 'center',
	},
	usageInfo: {
		flex: 1,
		minWidth: 0,
		gap: 2,
	},
	usageName: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	disabled: {
		opacity: 0.45,
	},
	empty: {
		flex: 1,
	},
	emptyHero: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: space.xl + space.sm,
		paddingBottom: space.xl + space.lg,
	},
	emptyTitle: {
		fontSize: type.large,
		fontWeight: '700',
		color: colors.text,
		marginBottom: space.sm + 2,
	},
	emptyBody: {
		fontSize: type.input,
		lineHeight: 22,
		color: colors.textDim,
		textAlign: 'center',
		marginBottom: space.xl + space.sm,
	},
	pairButton: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm + 2,
		backgroundColor: colors.primary,
		paddingVertical: space.md + 2,
		paddingHorizontal: space.xl + space.xs,
		borderRadius: radius.card,
	},
	pairButtonPressed: {
		opacity: 0.8,
	},
	pairButtonText: {
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
	stepBorder: {
		borderTopWidth: 1,
		borderTopColor: colors.border,
	},
	stepNumber: {
		width: STEP_NUMBER,
		height: STEP_NUMBER,
		borderRadius: radius.button,
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
		alignItems: 'center',
		justifyContent: 'center',
	},
	stepNumberText: {
		fontSize: type.meta,
		fontWeight: '700',
		color: colors.textDim,
	},
	stepBody: {
		flex: 1,
		minWidth: 0,
	},
	stepTitle: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
		marginBottom: 3,
	},
	stepText: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
	},
});
