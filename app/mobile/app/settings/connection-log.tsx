// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Activity, Copy, RefreshCw } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { connectionDiagnosticPcs, useAppStore } from '../../src/appState.js';
import { APP_VERSION } from '../../src/components/updateSheet.js';
import { runConnectionDiagnostics, type DiagnosticItem, type DiagnosticStatus } from '../../src/connectionDiagnostics.js';
import { describeConnectionEntry, formatConnectionReport, formatLogTime } from '../../src/connectionLog.js';
import { connectionLog, readNetworkState } from '../../src/connectionLogStore.js';
import { GroupHeader, GroupNote, SettingsScreen, SettingsSwitch } from '../../src/features/settings/settingsScaffold.js';
import { formatAppLinkMetricsReport } from '../../src/linkMetrics.js';
import { appLinkMetrics } from '../../src/linkMetricsRuntime.js';
import { haptic } from '../../src/haptics.js';
import { isClipboardAvailable, writeClipboardText } from '../../src/nativeClipboard.js';
import { useParaToast } from '../../src/paraToast.js';
import { colors, radius, space, type } from '../../src/theme.js';
import { ListGroup, ListRow, connectionKind } from '../../src/ui/index.js';

const STATUS_COLOR: Record<DiagnosticStatus, string> = {
	ok: colors.emerald,
	warn: colors.amber,
	fail: colors.red,
	unknown: colors.textMuted,
};

const STATUS_WORD: Record<DiagnosticStatus, string> = {
	ok: '正常',
	warn: '注意',
	fail: '問題あり',
	unknown: '不明',
};

/** 画面に並べる記録の件数（保存は PC ごとに 200 件。全部並べても重くない）。 */
const VISIBLE_ENTRIES = 200;

function StatusDot({ status }: { status: DiagnosticStatus }) {
	return <View style={[styles.dot, { backgroundColor: STATUS_COLOR[status] }]} accessibilityLabel={STATUS_WORD[status]} />;
}

/**
 * 接続の記録（`/settings/connection-log`。W2-22、Orca の connection-log / troubleshoot の画面）。
 *
 * 上から: 簡単な診断（PC の数・インターネット・リレー・PC がオンラインか・通信の版）と「もう一度調べる」、
 * 報告のコピー、PC の選択（2台以上のとき）、選んだ PC の記録（新しい順）。
 * 報告はクリップボードへのコピーだけ（Q118 A。送るかどうか・どこへ送るかは利用者が決める）。
 * 報告には PC の名前・リレーの場所・識別子を入れない。iPad の広い幅では設定の骨組みが列幅に収める。
 */
export default function ConnectionLogScreen() {
	const { pcs, activePcId } = useAppStore(useShallow(s => ({ pcs: s.pcs, activePcId: s.activePcId })));
	const [selectedPcId, setSelectedPcId] = useState<string | undefined>(activePcId);
	const pcId = pcs.some(pc => pc.id === selectedPcId) ? selectedPcId : pcs[0]?.id;
	useSyncExternalStore(useCallback(listener => connectionLog.subscribe(listener), []), () => connectionLog.revision);
	const entries = pcId !== undefined ? connectionLog.list(pcId) : [];
	const measuring = useSyncExternalStore(useCallback(listener => appLinkMetrics.subscribe(listener), []), () => appLinkMetrics.enabled);
	const [diagnostics, setDiagnostics] = useState<DiagnosticItem[] | undefined>(undefined);
	const [checking, setChecking] = useState(false);
	const toast = useParaToast(s => s.show);
	const mounted = useRef(true);
	// StrictMode の開発ビルドは effect を外してから付け直すので、付け直したときに true へ戻す。
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);

	const check = useCallback(async () => {
		setChecking(true);
		try {
			const items = await runConnectionDiagnostics({
				pcs: connectionDiagnosticPcs(),
				network: await readNetworkState(),
				fetcher: (url, init) => fetch(url, init),
			});
			if (mounted.current) {
				setDiagnostics(items);
			}
		} finally {
			if (mounted.current) {
				setChecking(false);
			}
		}
	}, []);
	useEffect(() => { void check(); }, [check]);

	const copyReport = async () => {
		const report = formatConnectionReport({
			appVersion: APP_VERSION,
			generatedAt: Date.now(),
			// 報告では PC の名前を「PC 1」などに置き換える（診断の見出しに入っている名前も外す）。
			diagnostics: (diagnostics ?? []).map(item => ({ label: anonymizeLabel(item, pcs.map(pc => pc.id)), status: STATUS_WORD[item.status], detail: item.detail })),
			pcs: pcs.map(pc => ({
				summary: `${connectionKindWord(connectionKind(pc.connection, pc.pcOnline))}${pc.pairingRejected ? '・資格の拒否' : ''}`,
				entries: connectionLog.list(pc.id),
			})),
		});
		const copied = await writeClipboardText(report);
		haptic(copied ? 'success' : 'error');
		toast({ key: 'connection-log-copy', text: copied ? '報告をコピーしました' : 'コピーできませんでした', icon: copied ? 'checkmark-circle-outline' : 'alert-circle-outline', tone: copied ? 'info' : 'warn' }, 2_500);
	};

	const copyLinkMetrics = async () => {
		const snapshot = appLinkMetrics.snapshot();
		if (snapshot.startedAt === undefined) {
			toast({ key: 'link-metrics-copy', text: 'まだ計測していません', icon: 'alert-circle-outline', tone: 'warn' }, 2_500);
			return;
		}
		const copied = await writeClipboardText(formatAppLinkMetricsReport(snapshot, APP_VERSION, Date.now()));
		haptic(copied ? 'success' : 'error');
		toast({ key: 'link-metrics-copy', text: copied ? '計測の結果をコピーしました' : 'コピーできませんでした', icon: copied ? 'checkmark-circle-outline' : 'alert-circle-outline', tone: copied ? 'info' : 'warn' }, 2_500);
	};

	return (
		<SettingsScreen title="接続の記録">
			<GroupHeader title="診断" first />
			<ListGroup>
				{(diagnostics ?? []).map(item => (
					<ListRow key={item.key} leading={<StatusDot status={item.status} />} label={item.label} hint={item.detail} accessibilityLabel={`${item.label}、${STATUS_WORD[item.status]}、${item.detail}`} />
				))}
				<ListRow icon={RefreshCw} label={diagnostics === undefined ? '調べています…' : 'もう一度調べる'} loading={checking} disabled={checking} onPress={() => { haptic('commit'); void check(); }} />
			</ListGroup>
			<GroupNote after>リレーへの到達は、リレーに1回だけ問い合わせて確かめます。インターネットは端末の回線の状態から判断します。</GroupNote>

			{isClipboardAvailable() ? (
				<>
					<GroupHeader title="報告" />
					<ListGroup>
						<ListRow icon={Copy} label="報告をコピー" onPress={() => { void copyReport(); }} />
					</ListGroup>
					<GroupNote after>診断と記録を文章にしてクリップボードへ写します。PC の名前・リレーの場所・識別子は含めません。</GroupNote>
				</>
			) : null}

			<GroupHeader title="通信の計測" />
			<ListGroup>
				<ListRow icon={Activity} label="計測する" trailing={<SettingsSwitch value={measuring} onValueChange={value => appLinkMetrics.setEnabled(value)} accessibilityLabel="通信の計測" />} />
				{isClipboardAvailable() ? <ListRow icon={Copy} label="計測の結果をコピー" onPress={() => { void copyLinkMetrics(); }} /> : null}
			</ListGroup>
			<GroupNote after>オンの間、キー入力から画面に出るまで・PC との往復・音声の鳴り始めと途切れ・受け取る量を時間と大きさだけで数えます。本文や名前は残しません。オンにするたびに前の結果は消え、アプリを閉じるとオフに戻ります。PC 側の計測と合わせて使います。</GroupNote>

			{pcs.length > 1 ? (
				<>
					<GroupHeader title="PC" />
					<ListGroup>
						{pcs.map(pc => (
							<ListRow key={pc.id} label={pc.name} trailing={pc.id === pcId ? 'check' : 'none'} selected={pc.id === pcId} onPress={() => { haptic('tick'); setSelectedPcId(pc.id); }} />
						))}
					</ListGroup>
				</>
			) : null}

			<GroupHeader title={`記録（新しい順、最大 ${VISIBLE_ENTRIES} 件）`} />
			{entries.length === 0 ? (
				<GroupNote>まだ記録はありません。接続・切断・再接続の待ち・回線の変化がここに残ります。</GroupNote>
			) : (
				<View style={styles.log}>
					{[...entries].reverse().slice(0, VISIBLE_ENTRIES).map((entry, index) => (
						<View key={`${entry.at}:${index}`} style={[styles.logRow, index > 0 ? styles.logSeparator : undefined]}>
							<Text style={styles.logTime}>{formatLogTime(entry.at)}</Text>
							<Text style={styles.logText}>{describeConnectionEntry(entry)}</Text>
						</View>
					))}
				</View>
			)}
		</SettingsScreen>
	);
}

function connectionKindWord(kind: ReturnType<typeof connectionKind>): string {
	return kind === 'connected' ? '接続中' : kind === 'connecting' ? '接続しています' : kind === 'pcOffline' ? 'PC オフライン' : 'オフライン';
}

/** 報告の見出しから PC の名前を外す（PC の項目は台帳の順で「PC n」と呼ぶ）。 */
function anonymizeLabel(item: DiagnosticItem, pcIds: readonly string[]): string {
	const pc = /^(?:pc|compat):(?<id>.+)$/.exec(item.key)?.groups?.id;
	const index = pc !== undefined ? pcIds.indexOf(pc) : -1;
	if (index < 0) {
		return item.label;
	}
	return item.key.startsWith('compat:') ? `PC ${index + 1} の通信の版` : `PC ${index + 1}`;
}

const DOT_SIZE = 8;

const styles = StyleSheet.create({
	dot: {
		width: DOT_SIZE,
		height: DOT_SIZE,
		borderRadius: DOT_SIZE / 2,
	},
	log: {
		backgroundColor: colors.panel,
		borderRadius: radius.card,
		paddingHorizontal: space.md,
	},
	logRow: {
		paddingVertical: space.sm,
	},
	logSeparator: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	logTime: {
		fontSize: type.caption,
		color: colors.textMuted,
		fontVariant: ['tabular-nums'],
	},
	logText: {
		marginTop: 2,
		fontSize: type.meta,
		lineHeight: 16,
		color: colors.text,
	},
});
