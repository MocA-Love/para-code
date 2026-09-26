// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { BatteryGauge } from '../../src/components/batteryGauge.js';
import { PcAvatar } from '../../src/components/pcSwitcher.js';
import { ScreenHeader } from '../../src/components/screenHeader.js';
import { pcStatusText, shouldShowBattery } from '../../src/pcStatus.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { APP_VERSION } from '../../src/components/updateSheet.js';
import { SectionHeader } from '../../src/components/sectionHeader.js';
import { SettingsCard, SettingsRow } from '../../src/components/settingsRow.js';
import { colors, type } from '../../src/theme.js';
import { hapticSelection } from '../../src/haptics.js';
import { formatCpu, usagePercent } from '../../src/systemResources.js';

/**
 * 設定画面。ワークスペースドロワーの設定アイコンから開く。
 * 現状は通知設定のみ（エージェントの完了通知・質問通知のON/OFF）。
 * OFFにするとOS通知（バナー）を抑制する。アプリ内の通知一覧には引き続き残る。
 */
export default function SettingsScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	// ヘッダーは本文の上に浮いているので、その実測高さぶんだけ本文の頭を空ける
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	const {
		notifyPrefs, setNotifyPref, resources, pcs, activePcId,
		keepBackgroundPcs, setKeepBackgroundPcs, notifyOtherPcs, setNotifyOtherPcs, terminalPrefs,
	} = useAppStore(useShallow(s => ({
		notifyPrefs: s.notifyPrefs, setNotifyPref: s.setNotifyPref, resources: s.workspace?.resources,
		pcs: s.pcs, activePcId: s.activePcId,
		keepBackgroundPcs: s.keepBackgroundPcs, setKeepBackgroundPcs: s.setKeepBackgroundPcs,
		notifyOtherPcs: s.notifyOtherPcs, setNotifyOtherPcs: s.setNotifyOtherPcs,
		terminalPrefs: s.terminalPrefs,
	})));
	const activePc = pcs.find(pc => pc.id === activePcId);
	// 行を開かずに済むよう、ドロワーと同じ配信値（CPU · RAM）を右端に出す。旧PCでは届かないので出さない。
	const systemSummary = resources !== undefined
		? `${formatCpu(resources.cpu)} · ${Math.round(usagePercent(resources.memUsed, resources.memTotal))}%`
		: undefined;

	const toggle = (key: 'agentDone' | 'agentQuestion' | 'suppressWhenPcFocused') => (value: boolean) => {
		hapticSelection();
		setNotifyPref(key, value);
	};

	return (
		<View style={styles.screen}>
			{/* ここが設定の最上段なので、戻る先はこのモーダルの中に無い */}
			<ScreenHeader title="設定" showBack={false} onHeightChange={setHeaderHeight} />
			<ScrollView style={styles.scroll} contentContainerStyle={[{ paddingTop: headerHeight, paddingBottom: insets.bottom + 24 }, column]}>
				{/* どのPCの数字なのかを見出しで名指しする（複数PCだと「使用量」だけでは分からない）。
				    他のPCの数字は「ペアリング済みのPC」の行から開く。 */}
				<SectionHeader first title={`使用量${activePc !== undefined && pcs.length > 1 ? `（${activePc.name}）` : ''}`} />
				<SettingsCard>
					<SettingsRow
						icon="stats-chart-outline"
						title="Ccusage"
						description="コーディングエージェントのトークン使用量・コストを確認します"
						onPress={() => { hapticSelection(); router.push('/ccusage'); }}
					/>
					<SettingsRow
						icon="flash-outline"
						title="RTK節約状況"
						description="RTKがコマンド出力から削ったトークン量を確認します"
						onPress={() => { hapticSelection(); router.push('/rtk'); }}
					/>
					<SettingsRow
						icon="speedometer-outline"
						title="Rate Limit"
						description="Claude Code / Codex のレート制限と残量をアカウントごとに確認します"
						onPress={() => { hapticSelection(); router.push('/ratelimit'); }}
					/>
					<SettingsRow
						icon="logo-github"
						title="GitHub API"
						description="GitHubのレート枠と、Para Codeが送ったリクエストの内訳を確認します"
						onPress={() => { hapticSelection(); router.push('/github-usage'); }}
					/>
					<SettingsRow
						icon="hardware-chip-outline"
						title="システム"
						description="PCのCPU・メモリ・ディスクの空きと、何が使っているかを確認します"
						value={systemSummary}
						onPress={() => { hapticSelection(); router.push('/system'); }}
					/>
				</SettingsCard>

				<SectionHeader title="表示" />
				<SettingsCard>
					<SettingsRow
						icon="terminal-outline"
						title="ターミナル"
						description="文字サイズと、PC側の端末幅をこの画面に合わせるかを設定します"
						value={`${terminalPrefs.fontSize}pt`}
						onPress={() => { hapticSelection(); router.push('/terminal-settings'); }}
					/>
					<SettingsRow
						icon="flash-outline"
						title="コマンドプリセット"
						description="ターミナル画面の一覧に出すプリセットを選びます"
						onPress={() => { hapticSelection(); router.push('/presets'); }}
					/>
					{/* 見た目を決めるための実験台。決まったら本番へ移してこの行は消す。 */}
					<SettingsRow
						icon="color-wand-outline"
						title="ヘッダーの動きを試す"
						description="画面を移るときの上のバーの動きを、案ごとに見比べます"
						onPress={() => { hapticSelection(); router.push('/morph-lab'); }}
					/>
				</SettingsCard>

				<SectionHeader title="ペアリング済みのPC" />
				<SettingsCard>
					{/* 行はアバター・名前・状態だけにして、開くことに専念させる。
						    名前の変更とペアリング解除は開いた先（pc-detail）に集めてある
						    （並べたアイコンに「開く」つもりの指が当たって消えてしまうのを防ぐ）。
						    アバターと状態＋バッテリーの並びは SettingsRow の形に収まらないので行を自前で組む。 */}
					{pcs.map(pc => (
						<Pressable
							key={pc.id}
							style={styles.row}
							onPress={() => { hapticSelection(); router.push({ pathname: '/pc-detail', params: { id: pc.id } }); }}
							accessibilityLabel={`${pc.name} の詳細`}
						>
							<PcAvatar name={pc.name} hue={pc.hue} size={34} />
							<View style={styles.rowBody}>
								<Text style={styles.rowTitle} numberOfLines={1}>{pc.name}</Text>
								{/* 状態の右にバッテリーを添える（ノートPCのみ・接続中のときだけ）。
								    切れている相手の残量は「最後に見えた値」でしかないので出さない。 */}
								<View style={styles.statusRow}>
									<Text style={[styles.rowDesc, styles.statusText]} numberOfLines={1}>{pcStatusText(pc, pc.id === activePcId)}</Text>
									{shouldShowBattery(pc) && pc.battery !== undefined ? (
										<>
											<Text style={styles.statusSep}>・</Text>
											<BatteryGauge level={pc.battery.level} charging={pc.battery.charging} />
										</>
									) : null}
								</View>
							</View>
							<Ionicons name="chevron-forward" size={16} color={colors.textDim} />
						</Pressable>
					))}
					{/* 文字を accent にしてシェブロンを付けない「追加」の行なので、SettingsRow ではなく自前で組む。 */}
					<Pressable style={styles.row} onPress={() => { hapticSelection(); router.push('/pair'); }}>
						<Ionicons name="add" size={18} color={colors.accent} />
						<View style={styles.rowBody}>
							<Text style={[styles.rowTitle, { color: colors.accent }]}>新しいPCとペアリング</Text>
							<Text style={styles.rowDesc}>PC側の「Para Code: モバイルデバイスを接続」でQRを出して読み取ります</Text>
						</View>
					</Pressable>
				</SettingsCard>
				<SettingsCard style={styles.cardSpaced}>
					<SettingsRow
						title="見ていないPCとの接続を保つ"
						description="他のPCの様子も更新し続けます（オフにすると通信量は減りますが、切り替えるまで件数が分かりません）"
						right={(
							<Switch
								value={keepBackgroundPcs}
								onValueChange={value => { hapticSelection(); setKeepBackgroundPcs(value); }}
								trackColor={{ true: colors.accent2 }}
							/>
						)}
					/>
					<SettingsRow
						title="他のPCからの通知も出す"
						description="アプリを開いている間の話です。オフにすると、いま見ているPCの通知だけがバナーで出ます（アプリを閉じている間はどのPCからも届きます）"
						right={(
							<Switch
								value={notifyOtherPcs}
								onValueChange={value => { hapticSelection(); setNotifyOtherPcs(value); }}
								trackColor={{ true: colors.accent2 }}
							/>
						)}
					/>
				</SettingsCard>

				<SectionHeader title="通知" />
				<SettingsCard>
					<SettingsRow
						title="作業完了を通知"
						description="エージェントの作業が終わったときにバナーを出します"
						right={<Switch value={notifyPrefs.agentDone} onValueChange={toggle('agentDone')} trackColor={{ true: colors.accent2 }} />}
					/>
					<SettingsRow
						title="質問を通知"
						description="エージェントから質問・承認要求があったときにバナーを出します"
						right={<Switch value={notifyPrefs.agentQuestion} onValueChange={toggle('agentQuestion')} trackColor={{ true: colors.accent2 }} />}
					/>
					<SettingsRow
						title="PC作業中は鳴らさない"
						description="PCを操作している間はバナーを出しません"
						right={<Switch value={notifyPrefs.suppressWhenPcFocused} onValueChange={toggle('suppressWhenPcFocused')} trackColor={{ true: colors.accent2 }} />}
					/>
				</SettingsCard>
				<Text style={styles.note}>
					どれもバナーを止めるだけで、通知そのものは届きます（ホーム右上のベルからあとで読み返せます）。このアプリでそのエージェントの画面を開いている間も、同じ内容のバナーは出しません。
				</Text>

				<SectionHeader title="このアプリについて" />
				<SettingsCard>
					<SettingsRow
						icon="sparkles-outline"
						title="更新履歴"
						description="アプリの各バージョンで何が変わったかを確認します"
						value={APP_VERSION}
						onPress={() => { hapticSelection(); router.push('/changelog'); }}
					/>
				</SettingsCard>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1, paddingHorizontal: 16 },
	cardSpaced: { marginTop: 8 },
	// PCの行と「新しいPCとペアリング」の行だけ自前で組むので、寸法は SettingsRow に合わせる。
	row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 44 },
	rowBody: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: type.body, fontWeight: '600' },
	rowDesc: { color: colors.textDim, fontSize: type.meta, marginTop: 2, lineHeight: 16 },
	// 状態＋バッテリーを1行に並べる。名前が長いPCでも状態が押し出されないよう縮める側は文字にする。
	statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
	// 行の marginTop は statusRow 側で持つ。バッテリーは縮まないので、詰まるときは文字を縮める。
	statusText: { marginTop: 0, flexShrink: 1 },
	statusSep: { color: colors.textDim, fontSize: type.meta, opacity: 0.6 },
	note: { color: colors.textDim, fontSize: type.meta, lineHeight: 18, marginTop: 10, paddingHorizontal: 4 },
});
