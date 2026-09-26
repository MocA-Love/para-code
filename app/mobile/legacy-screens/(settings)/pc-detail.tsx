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
import { SectionHeader } from '../../src/components/sectionHeader.js';
import { SettingsCard, SettingsRow } from '../../src/components/settingsRow.js';
import { colors, radius, squircle, type } from '../../src/theme.js';
import { hapticImpact, hapticSelection } from '../../src/haptics.js';

/**
 * PCごとの詳細画面。設定 →「PC」の行から開く。
 *
 * 使用量（まとめ画面「使用量」と、その先のコスト / 利用上限 / RTK の節約 / GitHub API / システム）は
 * 「いま見ているPC」のものを出す作りなので、ここから開くときは先にそのPCへ切り替える。そうしないと、
 * Aの詳細から開いたのにBの数字が出る、という取り違えが起きる（複数PC対応で使用量がどのPCのものか
 * 分からなくなった、という指摘の本体）。以前は使用量の5画面への行をここにも並べていたが、
 * 設定トップと同じく「使用量」の1行にまとめてある。
 *
 * 名前の変更・ペアリング解除もこの画面に集めてある（一覧の行にアイコンを並べると、
 * 「開く」つもりの指が消すボタンに当たる）。
 */

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
	 * **副作用として、アプリ全体の「いま見ているPC」がこのPCに変わる**（設定を閉じたあとの
	 * ホームや他のタブもこのPCになる）。使用量の画面をPCごとに持たせない限り避けられないので、
	 * 意図して残している。その旨は下の注記で開く前に伝えている。
	 *
	 * `switchPcWithReturn`（画面上部に「戻る」付きの告知を出す版）は**ここでは使えない**。
	 * この画面は設定シートの上に載っており、告知の描画先（OverlayHost）はシートの背面にある。
	 * 出しても隠れたまま数秒で消えるので、あるはずの戻り道を約束することになってしまう。
	 * 代わりに、切り替わること自体を下の注記で先に伝えている。
	 */
	const openUsage = () => {
		hapticSelection();
		if (!isActive) {
			switchPc(pc.id);
		}
		router.push('/usage');
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

				<SectionHeader title="使用量" />
				<SettingsCard>
					<SettingsRow
						icon="stats-chart-outline"
						title="使用量"
						description="利用上限・コスト・RTK の節約・GitHub API・PCのリソースをまとめて確認します"
						onPress={openUsage}
					/>
				</SettingsCard>
				{!isActive ? (
					<Text style={styles.note}>
						使用量を開くと、見ているPCがこのPCに切り替わります（数字は必ず開いたPCのものになります）。
						設定を閉じたあとのホームや他のタブも、このPCの内容になります。
					</Text>
				) : null}

				<SectionHeader title="このPCの設定" />
				<SettingsCard>
					<SettingsRow
						icon="pencil-outline"
						iconColor={colors.textDim}
						title="名前を変更"
						description="この端末だけで使う呼び名です（PC側の名前より優先されます）"
						onPress={promptRename}
					/>
					<SettingsRow
						icon="trash-outline"
						title="ペアリングを解除"
						description="この端末からこのPCへの接続情報を削除します"
						destructive
						onPress={confirmRemove}
					/>
				</SettingsCard>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1, paddingHorizontal: 16 },
	missing: { color: colors.textDim, fontSize: type.meta, lineHeight: 18, paddingHorizontal: 20 },
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
	identity: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, marginTop: 4 },
	identityBody: { flex: 1, minWidth: 0 },
	identityName: { color: colors.text, fontSize: type.title, fontWeight: '700' },
	switchBtn: { marginTop: 10, borderRadius: radius.control, ...squircle },
	switchBtnHit: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 11 },
	switchText: { color: colors.accent, fontSize: type.meta, fontWeight: '700' },
	rowDesc: { color: colors.textDim, fontSize: type.caption, marginTop: 2, lineHeight: 15 },
	// 行の marginTop は statusRow 側で持つ。バッテリーは縮まないので、詰まるときは文字を縮める。
	statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
	statusText: { marginTop: 0, flexShrink: 1 },
	statusSep: { color: colors.textDim, fontSize: type.caption, opacity: 0.6 },
	note: { color: colors.textDim, fontSize: type.meta, lineHeight: 18, marginTop: 8, paddingHorizontal: 4 },
});
