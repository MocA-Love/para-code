// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { ProviderLogo } from '../../src/components/providerLogo.js';
import { HeaderCircleButton, ScreenHeader } from '../../src/components/screenHeader.js';
import { useTabBarSpacer } from '../../src/hooks/useTabBarSpacer.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { colors, radius, squircle } from '../../src/theme.js';
import { useNow } from '../../src/time.js';
import { hapticImpact } from '../../src/haptics.js';
import type { RateLimitAccount, RateLimitProviderSnapshot, RateLimitWindow, RateLimitsResult } from '../../src/store.js';

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

/**
 * リセットの絶対時刻（PC版 paradisLimitsFormatResetClock と同じ規則）。
 * PCは epoch ms だけを送り、見せ方は端末側で決める（タイムゾーン差の混入を避ける）。
 */
function formatResetClock(resetsAt: number | undefined, now: number): string | undefined {
	if (resetsAt === undefined || !isFinite(resetsAt) || resetsAt <= now) { return undefined; }
	const date = new Date(resetsAt);
	const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
	return new Date(now).toDateString() === date.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
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

function accountName(account: RateLimitAccount): string {
	return account.email ?? account.homeLabel ?? account.id;
}

export default function RateLimitScreen() {
	const tabBarSpacer = useTabBarSpacer();
	// ヘッダーは本文の上に浮いているので、その実測高さぶんだけ本文の頭を空ける
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
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

	// 枠ごとに使用率とリセットを並べる。以前は5時間枠・7日枠・モデル別枠を混ぜて
	// 「最も近い1つ」だけを枠名なしでアカウント行に出していたため、表示された残り時間が
	// どの制限のものか分からず、使っていない枠のリセットは永久に見えなかった。
	// key は label だけだと scoped.label の重複や '5時間' との衝突で React の警告になる。
	const renderMeter = (label: string, window: RateLimitWindow, index: number) => {
		const percent = Math.min(100, Math.max(0, window.usedPercent));
		const countdown = formatCountdown(window.resetsAt, now);
		const clock = formatResetClock(window.resetsAt, now);
		return (
			<View key={`${label}-${index}`} style={styles.meterRow}>
				<Text style={styles.meterLabel} numberOfLines={1}>{label}</Text>
				<View style={styles.barTrack}>
					<View style={[styles.barFill, { width: `${percent}%`, backgroundColor: severityColor(window.usedPercent) }]} />
				</View>
				<Text style={styles.meterValue}>{Math.round(window.usedPercent)}%</Text>
				<Text style={styles.meterReset} numberOfLines={1}>
					{countdown !== undefined ? (clock !== undefined ? `${countdown}後（${clock}）` : `${countdown}後`) : ''}
				</Text>
			</View>
		);
	};

	const renderAccount = (account: RateLimitAccount, index: number) => {
		const windows = accountWindows(account);
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
				</View>
				{account.status !== 'ok' ? (
					<Text style={styles.errText}>再ログインが必要です — PC側のリミットモニターから操作してください</Text>
				) : windows.length > 0 ? (
					windows.map((row, meterIndex) => renderMeter(row.label, row.window, meterIndex))
				) : (
					<Text style={styles.errText}>使用状況データがありません</Text>
				)}
			</View>
		);
	};

	const renderProvider = (provider: 'claude' | 'codex', title: string, snapshot: RateLimitProviderSnapshot, first = false) => (
		<>
			<View style={[styles.sectionTitleRow, first && styles.sectionTitleRowFirst]}>
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
			<View style={styles.screen}>
				<ScreenHeader
					title="Rate Limit"
					actions={
						<HeaderCircleButton
							icon="refresh-outline"
							label="再取得"
							onPress={() => { hapticImpact('light'); void onPullRefresh(); }}
							disabled={pullRefreshing || loading}
						/>
					}
					onHeightChange={setHeaderHeight}
				/>
				<ScrollView
					style={styles.scroll}
					contentContainerStyle={[{ paddingTop: headerHeight, paddingBottom: tabBarSpacer }, column]}
					refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { void onPullRefresh(); }} tintColor={colors.textDim} progressViewOffset={headerHeight} />}
				>
					{loading && !data ? <ActivityIndicator style={styles.spinner} color={colors.accent} /> : null}
					{error ? <Text style={styles.error}>{error}</Text> : null}

					{data ? (
						<>
							{renderProvider('claude', 'Claude', data.claude, true)}
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
	scroll: { flex: 1, paddingHorizontal: 16 },
	spinner: { marginTop: 24 },
	error: { color: colors.red, fontSize: 12.5, marginTop: 8, marginBottom: 4 },
	// 先頭のセクション見出しは上の余白を詰める（集約KPIカードを外したぶん、頭が空きすぎる）。
	sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18, marginBottom: 8 },
	sectionTitleRowFirst: { marginTop: 6 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 2 },
	dim: { color: colors.textDim, fontSize: 12.5, paddingVertical: 10, lineHeight: 18 },
	acct: { paddingVertical: 10 },
	acctSeparator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	acctTop: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6, minWidth: 0 },
	acctMail: { color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
	badge: { fontSize: 10, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 9, ...squircle, overflow: 'hidden', backgroundColor: colors.surface3, color: colors.textDim },
	badgeActive: { backgroundColor: colors.accentWash, color: colors.accent },
	badgeErr: { backgroundColor: 'rgba(244,114,114,0.16)', color: colors.red },
	meterRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
	meterLabel: { color: colors.text, fontSize: 11.5, width: 64 },
	barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.surface3, overflow: 'hidden' },
	barFill: { height: 8, borderRadius: 4 },
	meterValue: { color: colors.textDim, fontSize: 11.5, width: 40, textAlign: 'right', fontVariant: ['tabular-nums'] },
	// 固定幅にすると '3d 12h後（7/29 00:30）' が末尾から切れる（7日枠＝この表示の主目的）。
	meterReset: { color: colors.textDim, fontSize: 11, opacity: 0.85, flexShrink: 0, textAlign: 'right', fontVariant: ['tabular-nums'] },
	errText: { color: colors.textDim, fontSize: 11.5, lineHeight: 16 },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 14, paddingHorizontal: 4 },
});
