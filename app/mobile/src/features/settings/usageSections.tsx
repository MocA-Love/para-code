// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronRight } from 'lucide-react-native';
import { ProviderLogo } from '../../components/providerLogo.js';
import type { RateLimitAccount, RateLimitProviderSnapshot } from '../../store.js';
import { alpha, colors, radius, space, type } from '../../theme.js';
import { Icon, Meter, MeterRow, iconSize, useThemeColors, type LucideIcon } from '../../ui/index.js';
import { accountHint, accountName, accountWindows, providerEmptyMessage, resetInLabel } from './usageSummary.js';
import { isWindowExpired, windowPercent } from '../usage/usageAggregate.js';

/**
 * 使用量（`/settings/usage`、Orca の accounts）の束（モックの `.acsec` / `.acsh` / `.accard` / `.acrow`）。
 * 見出し（ロゴかアイコン＋12pt の名前）の下に、角丸 14 の面を置く。
 */
export function UsageSection({ title, icon, logo, onPress, children, dimmed = false }: {
	title: string;
	icon?: LucideIcon;
	/** アイコンの代わりに置くもの（Claude / Codex のロゴ）。 */
	logo?: ReactNode;
	/** 押すと詳しい画面へ進む（見出しの右に山かっこを出す）。 */
	onPress?: () => void;
	children: ReactNode;
	/** 応答しない接続先の直近の値を薄く残す。 */
	dimmed?: boolean;
}) {
	const card = <View style={[styles.card, dimmed ? styles.dimmed : undefined]}>{children}</View>;
	return (
		<View style={styles.section}>
			<View style={styles.header}>
				{logo ?? (icon !== undefined ? <Icon icon={icon} size={iconSize.sm} color={colors.textDim} /> : null)}
				<Text style={styles.headerText} accessibilityRole="header">{title}</Text>
			</View>
			{onPress !== undefined ? (
				<Pressable onPress={onPress} style={({ pressed }) => (pressed ? styles.pressed : undefined)} accessibilityRole="button" accessibilityLabel={`${title} を詳しく見る`}>
					{card}
				</Pressable>
			) : card}
		</View>
	);
}

/** 面の中の1行（モックの `.acrow`）。右端に選択中の印や山かっこを置ける。 */
export function UsageRow({ children, trailing }: { children: ReactNode; trailing?: 'check' | 'chevron' }) {
	const theme = useThemeColors();
	return (
		<View style={styles.row}>
			<View style={styles.main}>{children}</View>
			{trailing !== undefined ? (
				<View style={styles.trailing}>
					<Icon icon={trailing === 'check' ? Check : ChevronRight} color={trailing === 'check' ? theme.accent : colors.textMuted} />
				</View>
			) : null}
		</View>
	);
}

/** 行の中の見出しと補足（モックの `.acmain b` / `small`）。 */
export function UsageRowTitle({ title, hint }: { title: string; hint?: string }) {
	return (
		<>
			<Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
			{hint !== undefined ? <Text style={styles.rowHint}>{hint}</Text> : null}
		</>
	);
}

/** 大きな数字（モックの `.big`。今日のコスト）。 */
export function UsageBigValue({ children }: { children: string }) {
	return <Text style={styles.big}>{children}</Text>;
}

/** 面の区切り線（行と行の間）。 */
export function UsageSeparator() {
	return <View style={styles.separator} />;
}

/**
 * Claude / Codex の束。アカウントごとに行を出し、5時間・7日（と追加の枠）のメーターと、
 * リセットまでの時間を並べる。いま使っているアカウントに印。値が取れていないアカウントは理由を書く。
 *
 * PC の接続先（SSH など）のウィンドウの Claude（`snapshot.remoteHost`）は、接続先の Claude Code がいま
 * ログインしているアカウントだけが届く。「使用中」の印は付けず、行の補足にどの接続先のログインかを書く
 * （接続先の名前は上の接続先の選択にも出るので、見出しには重ねない）。
 */
export function ProviderUsageSection({ provider, title, snapshot, now, loading, dimmed }: {
	provider: 'claude' | 'codex';
	title: string;
	snapshot: RateLimitProviderSnapshot | undefined;
	now: number;
	loading: boolean;
	dimmed: boolean;
}) {
	const accounts = snapshot?.accounts ?? [];
	const remoteHost = snapshot?.remoteHost;
	return (
		<UsageSection title={title} logo={<ProviderLogo provider={provider} size={iconSize.sm} />} dimmed={dimmed}>
			{snapshot === undefined ? (
				<UsageRow><UsageRowTitle title={loading ? '取得しています…' : 'まだ取得していません'} /></UsageRow>
			) : accounts.length === 0 ? (
				<UsageRow><UsageRowTitle title="アカウントがありません" hint={providerEmptyMessage(snapshot)} /></UsageRow>
			) : accounts.map((account, index) => (
				<View key={account.id}>
					{index > 0 ? <UsageSeparator /> : null}
					<AccountRow account={account} now={now} remoteHost={remoteHost} />
				</View>
			))}
		</UsageSection>
	);
}

/**
 * アカウント1行（見出し・補足・メーター）。全 PC の合計では、見えている PC のチップを `extra` に渡し、
 * オフラインの PC の最後の値なら `dimmed` で薄くする。
 */
export function AccountRow({ account, now, remoteHost, extra, dimmed = false }: {
	account: RateLimitAccount;
	now: number;
	remoteHost: RateLimitProviderSnapshot['remoteHost'];
	/** メーターの下に添えるもの（見えている PC のチップ）。 */
	extra?: ReactNode;
	dimmed?: boolean;
}) {
	const windows = accountWindows(account);
	const hint = accountHint(account, remoteHost);
	const inUse = remoteHost === undefined && account.active === true;
	// メーターは2つずつ横に並べる（5時間・7日 → 追加の枠）
	const pairs: (typeof windows)[] = [];
	for (let i = 0; i < windows.length; i += 2) {
		pairs.push(windows.slice(i, i + 2));
	}
	return (
		<UsageRow trailing={inUse ? 'check' : undefined}>
			<View style={[styles.accountBody, dimmed ? styles.dimmed : undefined]}>
				<UsageRowTitle title={accountName(account)} hint={hint} />
				{account.status === 'ok' && windows.length === 0 ? <Text style={styles.rowHint}>使用状況のデータがありません</Text> : null}
				{account.status === 'ok' ? pairs.map(pair => (
					<MeterRow key={pair.map(item => item.label).join('|')}>
						{pair.map(item => (
							<Meter
								key={item.label}
								label={item.label}
								// リセット時刻を過ぎた枠（オフラインの PC の最後の値など）は、取り直すまで使用率を出さない。
								percent={windowPercent(item.window, now)}
								reset={isWindowExpired(item.window, now) ? 'リセット済みの可能性' : resetInLabel(item.window.resetsAt, now)}
							/>
						))}
						{pair.length === 1 ? <View style={styles.meterSpacer} /> : null}
					</MeterRow>
				)) : null}
			</View>
			{extra}
		</UsageRow>
	);
}

const styles = StyleSheet.create({
	section: {
		marginBottom: space.xl,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		marginBottom: space.sm,
		paddingHorizontal: space.xs,
	},
	headerText: {
		fontSize: type.meta,
		fontWeight: '600',
		letterSpacing: 0.5,
		color: colors.textDim,
	},
	card: {
		backgroundColor: colors.panel,
		borderRadius: radius.card,
		overflow: 'hidden',
	},
	dimmed: {
		opacity: alpha.strong,
	},
	pressed: {
		opacity: 0.7,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingVertical: space.md,
		paddingHorizontal: space.md + 2,
	},
	main: {
		flex: 1,
		minWidth: 0,
		gap: space.xs,
	},
	accountBody: {
		gap: space.xs,
	},
	trailing: {
		width: space.xl,
		alignItems: 'flex-end',
		marginLeft: space.sm,
	},
	rowTitle: {
		fontSize: type.body,
		fontWeight: '500',
		color: colors.text,
	},
	rowHint: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textDim,
	},
	big: {
		fontSize: type.hero,
		fontWeight: '700',
		letterSpacing: -0.4,
		color: colors.text,
		fontVariant: ['tabular-nums'],
	},
	separator: {
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.border,
		marginHorizontal: space.md,
	},
	meterSpacer: {
		flex: 1,
	},
});
