// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { ConnectionGate } from '../src/components/connectionGate.js';
import { ProviderLogo } from '../src/components/providerLogo.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useTabBarSpacer } from '../src/hooks/useTabBarSpacer.js';
import { colors } from '../src/theme.js';
import { useNow } from '../src/time.js';
import { hapticImpact } from '../src/haptics.js';
import type { RateLimitAccount, RateLimitProviderSnapshot, RateLimitWindow, RateLimitsResult } from '../src/store.js';

/**
 * Rate Limit(AIリミット)画面。設定 → Rate Limit から開く。
 * PC版タイトルバーのリミットモニターと同じスナップショット（Claude=claude-swap全スロット、
 * Codex=各ホーム）を閲覧専用で表示する。アカウントの追加・再ログインはPC側のみ。
 */

const SEVERITY_ELEVATED_PERCENT = 60;
const SEVERITY_HIGH_PERCENT = 85;

function severityColor(usedPercent: number): string {
	if (usedPercent >= SEVERITY_HIGH_PERCENT) { return colors.red; }
	if (usedPercent >= SEVERITY_ELEVATED_PERCENT) { return colors.yellow; }
	return colors.green;
}

/** '3d 12h' / '2h 27m' / '41m' 形式の残り時間（PC版 paradisLimitsFormatCountdown と同じ規則）。 */
function formatCountdown(resetsAt: number | undefined, now: number): string | undefined {
	if (resetsAt === undefined || !isFinite(resetsAt)) { return undefined; }
	const remainingMs = resetsAt - now;
	if (remainingMs <= 0) { return undefined; }
	const totalMinutes = Math.ceil(remainingMs / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) { return `${days}d ${hours}h`; }
	if (hours > 0) { return `${hours}h ${minutes}m`; }
	return `${minutes}m`;
}

function accountWindows(account: RateLimitAccount): { label: string; window: RateLimitWindow }[] {
	const rows: { label: string; window: RateLimitWindow }[] = [];
	if (account.fiveHour) { rows.push({ label: '5時間', window: account.fiveHour }); }
	if (account.sevenDay) { rows.push({ label: '7日', window: account.sevenDay }); }
	for (const scoped of account.scoped ?? []) {
		rows.push({ label: scoped.label ?? '追加枠', window: scoped });
	}
	return rows;
}

/** 全アカウントの最悪使用率（KPI用）。 */
function worstUsage(data: RateLimitsResult): { percent: number; account: RateLimitAccount; label: string } | undefined {
	let worst: { percent: number; account: RateLimitAccount; label: string } | undefined;
	for (const account of [...data.claude.accounts, ...data.codex.accounts]) {
		for (const row of accountWindows(account)) {
			if (!worst || row.window.usedPercent > worst.percent) {
				worst = { percent: row.window.usedPercent, account, label: row.label };
			}
		}
	}
	return worst;
}

/** 使用中(>0%)ウィンドウのうち最も近いリセット（KPI用）。 */
function nextReset(data: RateLimitsResult, now: number): { resetsAt: number; account: RateLimitAccount; label: string } | undefined {
	let next: { resetsAt: number; account: RateLimitAccount; label: string } | undefined;
	for (const account of [...data.claude.accounts, ...data.codex.accounts]) {
		for (const row of accountWindows(account)) {
			const resetsAt = row.window.resetsAt;
			if (resetsAt === undefined || resetsAt <= now || row.window.usedPercent <= 0) { continue; }
			if (!next || resetsAt < next.resetsAt) {
				next = { resetsAt, account, label: row.label };
			}
		}
	}
	return next;
}

function accountName(account: RateLimitAccount): string {
	return account.email ?? account.homeLabel ?? account.id;
}

export default function RateLimitScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const tabBarSpacer = useTabBarSpacer();
	// リセット残り時間の表示を画面を開いたままでも追従させる
	const now = useNow();
	const { rateLimits, connection } = useAppStore(useShallow(s => ({ rateLimits: s.rateLimits, connection: s.connection })));

	const [data, setData] = useState<RateLimitsResult | undefined>();
	const [loading, setLoading] = useState(false);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const refresh = useCallback(async (bypassCache = false) => {
		if (connection !== 'online') { return; }
		setLoading(true);
		setError(undefined);
		try {
			const result = await rateLimits(bypassCache);
			setData(result);
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}, [rateLimits, connection]);

	useEffect(() => { void refresh(); }, [refresh]);

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await refresh(true);
		} finally {
			setPullRefreshing(false);
		}
	}, [refresh]);

	const worst = useMemo(() => data ? worstUsage(data) : undefined, [data]);
	const upcoming = useMemo(() => data ? nextReset(data, now) : undefined, [data, now]);

	const renderMeter = (label: string, window: RateLimitWindow) => {
		const percent = Math.min(100, Math.max(0, window.usedPercent));
		return (
			<View key={label} style={styles.meterRow}>
				<Text style={styles.meterLabel} numberOfLines={1}>{label}</Text>
				<View style={styles.barTrack}>
					<View style={[styles.barFill, { width: `${percent}%`, backgroundColor: severityColor(window.usedPercent) }]} />
				</View>
				<Text style={styles.meterValue}>{Math.round(window.usedPercent)}%</Text>
			</View>
		);
	};

	const renderAccount = (account: RateLimitAccount, index: number) => {
		const windows = accountWindows(account);
		const countdown = formatCountdown(
			windows.filter(row => (row.window.resetsAt ?? 0) > now && row.window.usedPercent > 0)
				.sort((a, b) => a.window.resetsAt! - b.window.resetsAt!)[0]?.window.resetsAt,
			now,
		);
		return (
			<View key={account.id} style={[styles.acct, index > 0 && styles.acctSeparator]}>
				<View style={styles.acctTop}>
					<Text style={styles.acctMail} numberOfLines={1}>{accountName(account)}</Text>
					{account.provider === 'codex' && account.homeLabel && account.email ? (
						<Text style={styles.badge}>{account.homeLabel}</Text>
					) : null}
					{account.active ? <Text style={[styles.badge, styles.badgeActive]}>使用中</Text> : null}
					{account.status !== 'ok' ? (
						<Text style={[styles.badge, styles.badgeErr]}>{account.status === 'token_expired' ? 'トークン失効' : 'エラー'}</Text>
					) : null}
					{account.status === 'ok' && countdown ? <Text style={styles.acctReset}>リセットまで {countdown}</Text> : null}
				</View>
				{account.status !== 'ok' ? (
					<Text style={styles.errText}>再ログインが必要です — PC側のリミットモニターから操作してください</Text>
				) : windows.length > 0 ? (
					windows.map(row => renderMeter(row.label, row.window))
				) : (
					<Text style={styles.errText}>使用状況データがありません</Text>
				)}
			</View>
		);
	};

	const renderProvider = (provider: 'claude' | 'codex', title: string, snapshot: RateLimitProviderSnapshot) => (
		<>
			<View style={styles.sectionTitleRow}>
				<ProviderLogo provider={provider} size={15} />
				<Text style={styles.sectionTitle}>{title} · {snapshot.accounts.length} アカウント</Text>
			</View>
			<View style={styles.card}>
				{snapshot.cswapMissing ? (
					<Text style={styles.dim}>claude-swap (cswap) がPCにインストールされていません。PC側のリミットモニターの案内からセットアップしてください。</Text>
				) : snapshot.sourceError ? (
					<Text style={styles.dim}>{snapshot.sourceError}</Text>
				) : snapshot.accounts.length === 0 ? (
					<Text style={styles.dim}>アカウントが見つかりません</Text>
				) : (
					snapshot.accounts.map((account, index) => renderAccount(account, index))
				)}
			</View>
		</>
	);

	return (
		<ConnectionGate>
			<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
				<View style={styles.header}>
					<Text style={styles.title}>Rate Limit</Text>
					<Pressable style={styles.closeBtn} onPress={() => { hapticImpact('light'); router.back(); }} accessibilityLabel="閉じる">
						<Ionicons name="close" size={16} color={colors.textDim} />
					</Pressable>
				</View>
				<ScrollView
					style={styles.scroll}
					contentContainerStyle={{ paddingBottom: tabBarSpacer }}
					refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { void onPullRefresh(); }} tintColor={colors.textDim} />}
				>
					{loading && !data ? <ActivityIndicator style={styles.spinner} color={colors.accent} /> : null}
					{error ? <Text style={styles.error}>{error}</Text> : null}

					{data ? (
						<>
							<View style={styles.kpiRow}>
								<View style={styles.kpiCard}>
									<Text style={styles.kpiLabel}>最大使用率</Text>
									<Text style={[styles.kpiValue, worst && worst.percent >= SEVERITY_HIGH_PERCENT ? styles.kpiValueWarn : undefined]}>
										{worst ? `${Math.round(worst.percent)}%` : '—'}
									</Text>
									{worst ? <Text style={styles.kpiSub} numberOfLines={1}>{accountName(worst.account)} · {worst.label}枠</Text> : null}
								</View>
								<View style={styles.kpiCard}>
									<Text style={styles.kpiLabel}>次のリセット</Text>
									<Text style={styles.kpiValue}>{upcoming ? formatCountdown(upcoming.resetsAt, now) ?? '—' : '—'}</Text>
									{upcoming ? <Text style={styles.kpiSub} numberOfLines={1}>{accountName(upcoming.account)} · {upcoming.label}枠</Text> : null}
								</View>
							</View>

							{renderProvider('claude', 'Claude', data.claude)}
							{renderProvider('codex', 'Codex', data.codex)}

							<Text style={styles.note}>
								アカウントの追加・再ログインはPC側のリミットモニター（タイトルバー）から行えます。表示はPCがオンラインの間だけ更新されます。
							</Text>
						</>
					) : null}
				</ScrollView>
			</View>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 10 },
	title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3, flex: 1 },
	closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	scroll: { flex: 1, paddingHorizontal: 16 },
	spinner: { marginTop: 24 },
	error: { color: colors.red, fontSize: 12.5, marginTop: 8, marginBottom: 4 },
	kpiRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
	kpiCard: { flex: 1, backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 4 },
	kpiLabel: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
	kpiValue: { color: colors.text, fontSize: 22, fontWeight: '800' },
	kpiValueWarn: { color: colors.red },
	kpiSub: { color: colors.textDim, fontSize: 11 },
	sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18, marginBottom: 8 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
	card: { backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 2 },
	dim: { color: colors.textDim, fontSize: 12.5, paddingVertical: 10, lineHeight: 18 },
	acct: { paddingVertical: 10 },
	acctSeparator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	acctTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, minWidth: 0 },
	acctMail: { color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
	badge: { fontSize: 10, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 9, overflow: 'hidden', backgroundColor: colors.surface3, color: colors.textDim },
	badgeActive: { backgroundColor: colors.accentWash, color: colors.accent },
	badgeErr: { backgroundColor: 'rgba(244,114,114,0.16)', color: colors.red },
	acctReset: { color: colors.textDim, fontSize: 11, marginLeft: 'auto', fontVariant: ['tabular-nums'] },
	meterRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
	meterLabel: { color: colors.text, fontSize: 11.5, width: 64 },
	barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.surface3, overflow: 'hidden' },
	barFill: { height: 8, borderRadius: 4 },
	meterValue: { color: colors.textDim, fontSize: 11.5, width: 44, textAlign: 'right', fontVariant: ['tabular-nums'] },
	errText: { color: colors.textDim, fontSize: 11.5, lineHeight: 16 },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 14, paddingHorizontal: 4 },
});
