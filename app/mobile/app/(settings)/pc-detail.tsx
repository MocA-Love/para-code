// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { BatteryGauge } from '../../src/components/batteryGauge.js';
import { GlassSurface } from '../../src/components/glassSurface.js';
import { PcAvatar } from '../../src/components/pcSwitcher.js';
import { ScreenHeader } from '../../src/components/screenHeader.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { pcStatusText, shouldShowBattery } from '../../src/pcStatus.js';
import { colors, radius, squircle } from '../../src/theme.js';
import { hapticImpact, hapticSelection } from '../../src/haptics.js';

/**
 * PCごとの詳細画面。設定 →「ペアリング済みのPC」の行から開く。
 *
 * 使用量（Ccusage / Rate Limit / GitHub API / システム）は「いま見ているPC」のものを出す作りなので、
 * ここから開くときは先にそのPCへ切り替える。そうしないと、Aの詳細から開いたのにBの数字が出る、
 * という取り違えが起きる（複数PC対応で使用量がどのPCのものか分からなくなった、という指摘の本体）。
 *
 * 名前の変更・ペアリング解除もこの画面に集めてある（一覧の行にアイコンを並べると、
 * 「開く」つもりの指が消すボタンに当たる）。
 */

const USAGE_LINKS = [
	{ route: '/ccusage', icon: 'stats-chart-outline', title: 'Ccusage', desc: 'コーディングエージェントのトークン使用量・コストを確認します' },
	{ route: '/rtk', icon: 'flash-outline', title: 'RTK節約状況', desc: 'RTKがコマンド出力から削ったトークン量を確認します' },
	{ route: '/ratelimit', icon: 'speedometer-outline', title: 'Rate Limit', desc: 'Claude Code / Codex のレート制限と残量をアカウントごとに確認します' },
	{ route: '/github-usage', icon: 'logo-github', title: 'GitHub API', desc: 'GitHubのレート枠と、Para Codeが送ったリクエストの内訳を確認します' },
	{ route: '/system', icon: 'hardware-chip-outline', title: 'システム', desc: 'PCのCPU・メモリ・ディスクの空きと、何が使っているかを確認します' },
] as const;

export default function PcDetailScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	// ヘッダーは本文の上に浮いているので、その実測高さぶんだけ本文の頭を空ける
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	const { id } = useLocalSearchParams<{ id?: string }>();
	const { pcs, activePcId, switchPc, renamePc, removePc } = useAppStore(useShallow(s => ({
		pcs: s.pcs, activePcId: s.activePcId, switchPc: s.switchPc, renamePc: s.renamePc, removePc: s.removePc,
	})));

	const pc = pcs.find(item => item.id === id);
	const isActive = pc !== undefined && pc.id === activePcId;

	// 台帳から消えたPCを参照してもクラッシュしないようにする。
	// ただしペアリング解除の直後は、この画面を畳む前に一瞬これが見えてしまう
	// （解除は先に一覧を書き換えてから resolve するため）。解除を始めた時点で
	// 一覧へ戻しているので、その場合はここへ来ない。
	if (pc === undefined) {
		return (
			<View style={styles.screen}>
				<ScreenHeader title="PC" onHeightChange={setHeaderHeight} />
				<ScrollView style={styles.scroll} contentContainerStyle={[{ paddingTop: headerHeight }, column]}>
					<Text style={styles.missing}>このPCは一覧にありません（ペアリングを解除した可能性があります）。</Text>
				</ScrollView>
			</View>
		);
	}

	/**
	 * 使用量を開く。対象が「いま見ているPC」でなければ、先に切り替えてから開く
	 * （使用量の画面はいま見ているPCのものを出すので、切り替えないと別のPCの数字が出る）。
	 *
	 * `switchPcWithReturn`（画面上部に「戻る」付きの告知を出す版）は**ここでは使えない**。
	 * この画面は設定シートの上に載っており、告知の描画先（OverlayHost）はシートの背面にある。
	 * 出しても隠れたまま数秒で消えるので、あるはずの戻り道を約束することになってしまう。
	 * 代わりに、切り替わること自体を下の注記で先に伝えている。
	 */
	const openUsage = (route: string) => {
		hapticSelection();
		if (!isActive) {
			switchPc(pc.id);
		}
		router.push(route as '/ccusage');
	};

	/**
	 * PCの名前を変える。PCから名前が届く場合でも、ここで付けた名前が優先される
	 * （手元で見分けるための呼び名なので、PC側の設定に上書きさせない）。
	 *
	 * `Alert.prompt` はiOS専用。このアプリの配信先はiOS（iPhone/iPad）なので今はこれで足りる。
	 */
	const promptRename = () => {
		hapticSelection();
		Alert.prompt(
			'PCの名前',
			'一覧に表示する名前を入力します',
			[
				{ text: 'キャンセル', style: 'cancel' },
				{
					text: '変更', onPress: (value?: string) => {
						if (value !== undefined && value.trim().length > 0) {
							void renamePc(pc.id, value).catch(error => Alert.alert('名前を変更できませんでした', error instanceof Error ? error.message : String(error)));
						}
					},
				},
			],
			'plain-text',
			pc.name,
		);
	};

	const confirmRemove = () => {
		hapticImpact('medium');
		Alert.alert(
			'ペアリング解除',
			`${pc.name} とのペアリング情報を削除します。再接続にはPC側でQRコードを再発行してのペアリングが必要です。`,
			[
				{ text: 'キャンセル', style: 'cancel' },
				{
					text: '解除する', style: 'destructive', onPress: () => {
						// 先に一覧へ戻してから解除する。解除は一覧を書き換えてから終わるので、
						// この画面を開いたままだと「このPCは一覧にありません」が一瞬見えてしまう。
						router.back();
						void removePc(pc.id)
							.catch(error => Alert.alert('ペアリングを解除できませんでした', error instanceof Error ? error.message : String(error)));
					},
				},
			],
		);
	};

	return (
		<View style={styles.screen}>
			<ScreenHeader title={pc.name} onHeightChange={setHeaderHeight} />
			<ScrollView style={styles.scroll} contentContainerStyle={[{ paddingTop: headerHeight, paddingBottom: insets.bottom + 24 }, column]}>
				<View style={[styles.card, styles.identity]}>
					<PcAvatar name={pc.name} hue={pc.hue} size={44} />
					<View style={styles.identityBody}>
						<Text style={styles.identityName} numberOfLines={1}>{pc.name}</Text>
						<View style={styles.statusRow}>
							<Text style={[styles.rowDesc, styles.statusText]} numberOfLines={1}>{pcStatusText(pc, isActive)}</Text>
							{shouldShowBattery(pc) && pc.battery !== undefined ? (
								<>
									<Text style={styles.statusSep}>・</Text>
									<BatteryGauge level={pc.battery.level} charging={pc.battery.charging} />
								</>
							) : null}
						</View>
					</View>
				</View>

				{!isActive ? (
					<GlassSurface style={styles.switchBtn} interactive tintColor={colors.accent}>
						<Pressable style={styles.switchBtnHit} onPress={() => { hapticSelection(); switchPc(pc.id); }}>
							<Ionicons name="swap-horizontal-outline" size={16} color={colors.accent} />
							<Text style={styles.switchText}>このPCに切り替えて操作する</Text>
						</Pressable>
					</GlassSurface>
				) : null}

				<Text style={styles.sectionTitle}>使用量</Text>
				<View style={styles.card}>
					{USAGE_LINKS.map((link, index) => (
						<View key={link.route}>
							{index > 0 ? <View style={styles.separator} /> : null}
							<Pressable style={styles.row} onPress={() => openUsage(link.route)}>
								<Ionicons name={link.icon} size={18} color={colors.accent} />
								<View style={styles.rowBody}>
									<Text style={styles.rowTitle}>{link.title}</Text>
									<Text style={styles.rowDesc}>{link.desc}</Text>
								</View>
								<Ionicons name="chevron-forward" size={16} color={colors.textDim} />
							</Pressable>
						</View>
					))}
				</View>
				{!isActive ? (
					<Text style={styles.note}>
						使用量を開くと、見ているPCがこのPCに切り替わります（数字は必ず開いたPCのものになります）。
						設定を閉じたあとのホームや他のタブも、このPCの内容になります。
					</Text>
				) : null}

				<Text style={styles.sectionTitle}>このPCの設定</Text>
				<View style={styles.card}>
					<Pressable style={styles.row} onPress={promptRename}>
						<Ionicons name="pencil-outline" size={18} color={colors.textDim} />
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>名前を変更</Text>
							<Text style={styles.rowDesc}>この端末だけで使う呼び名です（PC側の名前より優先されます）</Text>
						</View>
						<Ionicons name="chevron-forward" size={16} color={colors.textDim} />
					</Pressable>
					<View style={styles.separator} />
					<Pressable style={styles.row} onPress={confirmRemove}>
						<Ionicons name="trash-outline" size={18} color={colors.red} />
						<View style={styles.rowBody}>
							<Text style={[styles.rowTitle, { color: colors.red }]}>ペアリングを解除</Text>
							<Text style={styles.rowDesc}>この端末からこのPCへの接続情報を削除します</Text>
						</View>
					</Pressable>
				</View>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1, paddingHorizontal: 16 },
	missing: { color: colors.textDim, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 20 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
	identity: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, marginTop: 4 },
	identityBody: { flex: 1, minWidth: 0 },
	identityName: { color: colors.text, fontSize: 15, fontWeight: '700' },
	switchBtn: { marginTop: 10, borderRadius: 12, ...squircle },
	switchBtnHit: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 11 },
	switchText: { color: colors.accent, fontSize: 12.5, fontWeight: '700' },
	row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
	rowBody: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
	rowDesc: { color: colors.textDim, fontSize: 11, marginTop: 2, lineHeight: 15 },
	// 行の marginTop は statusRow 側で持つ。バッテリーは縮まないので、詰まるときは文字を縮める。
	statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
	statusText: { marginTop: 0, flexShrink: 1 },
	statusSep: { color: colors.textDim, fontSize: 11, opacity: 0.6 },
	separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 8, paddingHorizontal: 4 },
});
