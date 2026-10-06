// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Fragment, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronDown, ChevronRight, ChevronUp, RotateCcw } from 'lucide-react-native';
import { ProviderLogo } from '../../components/providerLogo.js';
import { haptic } from '../../haptics.js';
import type { RateLimitAccount, RateLimitProviderSnapshot, RateLimitResetCredits } from '../../store.js';
import { alpha, colors, radius, space, type } from '../../theme.js';
import { Icon, Meter, MeterRow, iconSize, useThemeColors, type LucideIcon } from '../../ui/index.js';
import { accountHint, accountName, accountWindows, hasPreviousValue, previousWindows, providerEmptyMessage, resetCreditRows, resetCreditsSummary, resetInLabel, WINDOW_RESET_UNKNOWN_LABEL } from './usageSummary.js';
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
export function ProviderUsageSection({ provider, title, snapshot, now, loading, dimmed, expandResets = false, metersPerRow = 2 }: {
	provider: 'claude' | 'codex';
	title: string;
	snapshot: RateLimitProviderSnapshot | undefined;
	now: number;
	loading: boolean;
	dimmed: boolean;
	/** リセットの期限の一覧を最初から開いておく（iPad の広い幅）。 */
	expandResets?: boolean;
	/** メーターを1行に何個並べるか（iPad で左右に並べた列が狭いときは 1）。 */
	metersPerRow?: 1 | 2;
}) {
	const accounts = snapshot?.accounts ?? [];
	const remoteHost = snapshot?.remoteHost;
	const { shown, unavailable } = splitUnavailable(accounts, account => account, remoteHost);
	return (
		<UsageSection title={title} logo={<ProviderLogo provider={provider} size={iconSize.sm} />} dimmed={dimmed}>
			{snapshot === undefined ? (
				<UsageRow><UsageRowTitle title={loading ? '取得しています…' : 'まだ取得していません'} /></UsageRow>
			) : accounts.length === 0 ? (
				<UsageRow><UsageRowTitle title="アカウントがありません" hint={providerEmptyMessage(snapshot)} /></UsageRow>
			) : (
				<>
					{shown.map((account, index) => (
						<View key={account.id}>
							{index > 0 ? <UsageSeparator /> : null}
							<AccountRow account={account} now={now} remoteHost={remoteHost} expandResets={expandResets} metersPerRow={metersPerRow} />
						</View>
					))}
					<UnavailableAccountsGroup names={unavailable.map(accountName)} separated={shown.length > 0}>
						{unavailable.map((account, index) => (
							<Fragment key={account.id}>
								{index > 0 ? <UsageSeparator /> : null}
								<AccountRow account={account} now={now} remoteHost={remoteHost} metersPerRow={metersPerRow} />
							</Fragment>
						))}
					</UnavailableAccountsGroup>
				</>
			)}
		</UsageSection>
	);
}

/**
 * 取得できていない（'unavailable'）アカウントを、ほかと分ける。これらは同じような説明文が何行も並ぶので、
 * {@link UnavailableAccountsGroup} の1行に畳む。接続先（SSH など）のログインは1つしか無いので畳まない。
 * 取りに行くのを控えている間の前の値を持つアカウントは、値を見せるので畳まない。
 */
export function splitUnavailable<T>(items: readonly T[], accountOf: (item: T) => RateLimitAccount, remoteHost: RateLimitProviderSnapshot['remoteHost']): { shown: T[]; unavailable: T[] } {
	if (remoteHost !== undefined) {
		return { shown: [...items], unavailable: [] };
	}
	const folded = (item: T) => accountOf(item).status === 'unavailable' && !hasPreviousValue(accountOf(item));
	return {
		shown: items.filter(item => !folded(item)),
		unavailable: items.filter(folded),
	};
}

/**
 * 取得できていないアカウントを畳んだ1行（「取得できていないアカウント 2 件」とメールの並び）。押すと、
 * それぞれの行（理由の説明つき）を開く。1件も無ければ何も出さない。
 */
export function UnavailableAccountsGroup({ names, separated, children }: {
	names: readonly string[];
	/** 上にほかのアカウントの行があり、区切り線が要る。 */
	separated: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	if (names.length === 0) {
		return null;
	}
	const title = `取得できていないアカウント ${names.length} 件`;
	return (
		<>
			{separated ? <UsageSeparator /> : null}
			<Pressable
				onPress={() => { haptic('tick'); setOpen(value => !value); }}
				style={({ pressed }) => (pressed ? styles.pressed : undefined)}
				accessibilityRole="button"
				accessibilityState={{ expanded: open }}
				accessibilityLabel={`${title}、${names.join('、')}`}
				accessibilityHint={open ? '説明を閉じます' : 'それぞれの理由を開きます'}
			>
				<View style={styles.row}>
					<View style={styles.main}>
						<Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
						<Text style={styles.rowHint} numberOfLines={open ? undefined : 1}>{names.join('・')}</Text>
					</View>
					<View style={styles.trailing}>
						<Icon icon={open ? ChevronUp : ChevronDown} color={colors.textMuted} />
					</View>
				</View>
			</Pressable>
			<View style={open ? styles.groupBody : styles.hidden}>
				<UsageSeparator />
				{children}
			</View>
		</>
	);
}

/**
 * アカウント1行（見出し・補足・メーター）。全 PC の合計では、見えている PC のチップを `extra` に渡し、
 * オフラインの PC の最後の値なら `dimmed` で薄くする。
 */
export function AccountRow({ account, now, remoteHost, extra, dimmed = false, expandResets = false, metersPerRow = 2 }: {
	account: RateLimitAccount;
	now: number;
	remoteHost: RateLimitProviderSnapshot['remoteHost'];
	/** メーターの下に添えるもの（見えている PC のチップ）。 */
	extra?: ReactNode;
	dimmed?: boolean;
	/** リセットの期限の一覧を最初から開いておく（iPad の広い幅）。 */
	expandResets?: boolean;
	/** メーターを1行に何個並べるか（既定は2つ。iPad で左右に並べた列が狭いときは 1）。 */
	metersPerRow?: 1 | 2;
}) {
	// 取りに行くのを控えている間は、前に取れた値を薄く出す（補足に古さと理由を書く）。
	const previous = hasPreviousValue(account);
	const windows = previous ? previousWindows(account) : accountWindows(account);
	const hint = accountHint(account, remoteHost, now);
	const inUse = remoteHost === undefined && account.active === true;
	const showMeters = account.status === 'ok' || previous;
	// メーターは2つずつ横に並べる（5時間・7日 → 追加の枠）。狭い列では1つずつ積む
	const pairs: (typeof windows)[] = [];
	for (let i = 0; i < windows.length; i += metersPerRow) {
		pairs.push(windows.slice(i, i + metersPerRow));
	}
	return (
		<UsageRow trailing={inUse ? 'check' : undefined}>
			<View style={[styles.accountBody, dimmed ? styles.dimmed : undefined]}>
				<UsageRowTitle title={accountName(account)} hint={hint} />
				{account.status === 'ok' && windows.length === 0 ? <Text style={styles.rowHint}>使用状況のデータがありません</Text> : null}
				{showMeters ? (
					<View style={[styles.meters, previous ? styles.dimmed : undefined]}>
						{pairs.map(pair => (
							<MeterRow key={pair.map(item => item.label).join('|')}>
								{pair.map(item => (
									<Meter
										key={item.label}
										label={item.label}
										// リセット時刻を過ぎた枠（オフラインの PC の最後の値・控えている間の前の値など）は、取り直すまで使用率を出さない。
										percent={windowPercent(item.window, now)}
										reset={isWindowExpired(item.window, now) ? WINDOW_RESET_UNKNOWN_LABEL : resetInLabel(item.window.resetsAt, now)}
									/>
								))}
								{pair.length < metersPerRow ? <View style={styles.meterSpacer} /> : null}
							</MeterRow>
						))}
					</View>
				) : null}
				{account.status === 'ok' && account.resetCredits !== undefined ? (
					<ResetCreditsLine resetCredits={account.resetCredits} now={now} defaultOpen={expandResets} />
				) : null}
			</View>
			{extra}
		</UsageRow>
	);
}

/**
 * Codex の枠のリセット（「リセット 残り 4 回 · 次は今日 11:12 に期限」）。残りが2回以上で期限が分かるときは、
 * 押すと1件ごとの期限の一覧を開く。モバイルは表示だけで、リセットを使うのは PC から。
 *
 * 一覧は開閉で出し入れせず、閉じている間は表示を消すだけにする（幅で既定の開閉が変わっても木の形を変えない）。
 */
function ResetCreditsLine({ resetCredits, now, defaultOpen }: { resetCredits: RateLimitResetCredits; now: number; defaultOpen: boolean }) {
	const theme = useThemeColors();
	// 利用者が開け閉めするまでは、幅で決まる既定に従う
	const [chosen, setChosen] = useState<boolean | undefined>(undefined);
	const summary = resetCreditsSummary(resetCredits, now);
	const open = summary.listable && (chosen ?? defaultOpen);
	const rows = summary.listable ? resetCreditRows(resetCredits, now) : [];
	return (
		<View style={styles.reset}>
			<Pressable
				disabled={!summary.listable}
				onPress={() => { haptic('tick'); setChosen(!open); }}
				style={({ pressed }) => [styles.resetLine, pressed ? styles.pressed : undefined]}
				accessibilityRole={summary.listable ? 'button' : 'text'}
				accessibilityState={summary.listable ? { expanded: open } : undefined}
				accessibilityLabel={summary.text}
				accessibilityHint={summary.listable ? (open ? '期限の一覧を閉じます' : 'それぞれの期限を開きます') : undefined}
			>
				<Icon icon={RotateCcw} size={iconSize.xs} color={colors.textDim} />
				<Text style={[styles.resetText, summary.soon ? { color: colors.amber } : undefined]} numberOfLines={1}>{summary.text}</Text>
				{summary.listable ? (
					<View style={styles.resetToggle}>
						<Text style={[styles.resetToggleText, { color: theme.accent }]}>期限</Text>
						<Icon icon={open ? ChevronUp : ChevronDown} size={iconSize.xs} color={theme.accent} />
					</View>
				) : null}
			</Pressable>
			<View style={open ? styles.resetList : styles.hidden}>
				{rows.map((row, index) => (
					<View key={index} style={styles.resetRow}>
						<Text style={styles.resetRowLabel}>{row.label}</Text>
						{row.relative !== undefined ? <Text style={[styles.resetRowRelative, row.soon ? { color: colors.amber, fontWeight: '600' } : undefined]}>{row.relative}</Text> : null}
					</View>
				))}
			</View>
		</View>
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
	/** メーターの行どうしの間隔（行の本文 `accountBody` と同じ）。 */
	meters: {
		gap: space.xs,
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
	hidden: {
		display: 'none',
	},
	groupBody: {
		gap: 0,
	},
	reset: {
		gap: space.xs,
		marginTop: 2,
	},
	resetLine: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs + 2,
		minHeight: 22,
	},
	resetText: {
		flexShrink: 1,
		fontSize: type.meta,
		color: colors.textDim,
		fontVariant: ['tabular-nums'],
	},
	resetToggle: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 2,
		marginLeft: 'auto',
		paddingLeft: space.sm,
	},
	resetToggleText: {
		fontSize: type.meta,
	},
	resetList: {
		gap: 2,
		paddingLeft: iconSize.xs + space.xs + 2,
	},
	resetRow: {
		flexDirection: 'row',
		alignItems: 'baseline',
		gap: space.sm,
	},
	resetRowLabel: {
		fontSize: type.meta,
		color: colors.text,
		fontVariant: ['tabular-nums'],
	},
	resetRowRelative: {
		fontSize: type.meta,
		color: colors.textDim,
	},
});
