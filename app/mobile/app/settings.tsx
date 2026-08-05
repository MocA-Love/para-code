// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, type PcSummary } from '../src/appState.js';
import { PcAvatar } from '../src/components/pcSwitcher.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../src/ipad/useContentColumn.js';
import { APP_VERSION } from '../src/components/updateSheet.js';
import { colors } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';
import { formatCpu, usagePercent } from '../src/systemResources.js';

/** PC一覧の1行に出す状態の説明。 */
function pcStatusText(pc: PcSummary, active: boolean): string {
	const state = pc.connection === 'online' && pc.pcOnline
		? (active ? '接続中' : '待機中')
		: pc.connection === 'online' || pc.connection === 'handshaking' ? 'PCオフライン'
			: pc.connection === 'connecting' ? '接続しています…' : 'オフライン';
	const detail = active ? '使用中' : pc.waiting > 0 ? `応答待ち ${pc.waiting}件` : undefined;
	return detail !== undefined ? `${state} · ${detail}` : state;
}

/**
 * 設定画面。ワークスペースドロワーの設定アイコンから開く。
 * 現状は通知設定のみ（エージェントの完了通知・質問通知のON/OFF）。
 * OFFにするとOS通知（バナー）を抑制する。アプリ内の通知一覧には引き続き残る。
 */
export default function SettingsScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	const {
		notifyPrefs, setNotifyPref, resources, pcs, activePcId, switchPc, renamePc, removePc,
		keepBackgroundPcs, setKeepBackgroundPcs, notifyOtherPcs, setNotifyOtherPcs,
	} = useAppStore(useShallow(s => ({
		notifyPrefs: s.notifyPrefs, setNotifyPref: s.setNotifyPref, resources: s.workspace?.resources,
		pcs: s.pcs, activePcId: s.activePcId, switchPc: s.switchPc, renamePc: s.renamePc, removePc: s.removePc,
		keepBackgroundPcs: s.keepBackgroundPcs, setKeepBackgroundPcs: s.setKeepBackgroundPcs,
		notifyOtherPcs: s.notifyOtherPcs, setNotifyOtherPcs: s.setNotifyOtherPcs,
	})));
	// 行を開かずに済むよう、ドロワーと同じ配信値（CPU · RAM）を右端に出す。旧PCでは届かないので出さない。
	const systemSummary = resources !== undefined
		? `${formatCpu(resources.cpu)} · ${Math.round(usagePercent(resources.memUsed, resources.memTotal))}%`
		: undefined;

	const toggle = (key: 'agentDone' | 'agentQuestion' | 'suppressWhenPcFocused') => (value: boolean) => {
		hapticSelection();
		setNotifyPref(key, value);
	};

	/**
	 * PCの名前を変える。PCから名前が届く場合でも、ここで付けた名前が優先される
	 * （手元で見分けるための呼び名なので、PC側の設定に上書きさせない）。
	 *
	 * `Alert.prompt` はiOS専用。このアプリの配信先はiOS（iPhone/iPad）なので今はこれで足りる。
	 * Androidへ広げるときは入力欄付きのシートに置き換えること（Androidでは何も起きない）。
	 */
	const promptRename = (id: string, current: string) => {
		hapticSelection();
		Alert.prompt(
			'PCの名前',
			'一覧に表示する名前を入力します',
			[
				{ text: 'キャンセル', style: 'cancel' },
				{
					text: '変更', onPress: (value?: string) => {
						if (value !== undefined && value.trim().length > 0) {
							void renamePc(id, value).catch(error => Alert.alert('名前を変更できませんでした', error instanceof Error ? error.message : String(error)));
						}
					},
				},
			],
			'plain-text',
			current,
		);
	};

	const confirmRemove = (id: string, name: string) => {
		hapticImpact('medium');
		Alert.alert(
			'ペアリング解除',
			`${name} とのペアリング情報を削除します。再接続にはPC側でQRコードを再発行してのペアリングが必要です。`,
			[
				{ text: 'キャンセル', style: 'cancel' },
				{
					text: '解除する', style: 'destructive', onPress: () => {
						void removePc(id).catch(error => Alert.alert('ペアリングを解除できませんでした', error instanceof Error ? error.message : String(error)));
					},
				},
			],
		);
	};

	return (
		<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
			<View style={styles.header}>
				<Text style={styles.title}>設定</Text>
				<Pressable style={styles.closeBtn} onPress={() => { hapticImpact('light'); router.back(); }} accessibilityLabel="閉じる">
					<Ionicons name="close" size={16} color={colors.textDim} />
				</Pressable>
			</View>
			<ScrollView style={styles.scroll} contentContainerStyle={[{ paddingBottom: insets.bottom + 24 }, column]}>
				<Text style={styles.sectionTitle}>使用量</Text>
				<View style={styles.card}>
					<Pressable style={styles.row} onPress={() => { hapticSelection(); router.push('/ccusage'); }}>
						<Ionicons name="stats-chart-outline" size={18} color={colors.accent} />
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>Ccusage</Text>
							<Text style={styles.rowDesc}>コーディングエージェントのトークン使用量・コストを確認します</Text>
						</View>
						<Ionicons name="chevron-forward" size={16} color={colors.textDim} />
					</Pressable>
					<View style={styles.separator} />
					<Pressable style={styles.row} onPress={() => { hapticSelection(); router.push('/ratelimit'); }}>
						<Ionicons name="speedometer-outline" size={18} color={colors.accent} />
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>Rate Limit</Text>
							<Text style={styles.rowDesc}>Claude Code / Codex のレート制限と残量をアカウントごとに確認します</Text>
						</View>
						<Ionicons name="chevron-forward" size={16} color={colors.textDim} />
					</Pressable>
					<View style={styles.separator} />
					<Pressable style={styles.row} onPress={() => { hapticSelection(); router.push('/github-usage'); }}>
						<Ionicons name="logo-github" size={18} color={colors.accent} />
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>GitHub API</Text>
							<Text style={styles.rowDesc}>GitHubのレート枠と、Para Codeが送ったリクエストの内訳を確認します</Text>
						</View>
						<Ionicons name="chevron-forward" size={16} color={colors.textDim} />
					</Pressable>
					<View style={styles.separator} />
					<Pressable style={styles.row} onPress={() => { hapticSelection(); router.push('/system'); }}>
						<Ionicons name="hardware-chip-outline" size={18} color={colors.accent} />
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>システム</Text>
							<Text style={styles.rowDesc}>PCのCPU・メモリ・ディスクの空きと、何が使っているかを確認します</Text>
						</View>
						{systemSummary ? <Text style={styles.rowValue}>{systemSummary}</Text> : null}
						<Ionicons name="chevron-forward" size={16} color={colors.textDim} />
					</Pressable>
				</View>

				<Text style={styles.sectionTitle}>ペアリング済みのPC</Text>
				<View style={styles.card}>
					{pcs.map((pc, index) => (
						<View key={pc.id}>
							{index > 0 ? <View style={styles.separator} /> : null}
							<Pressable
								style={styles.row}
								onPress={() => { hapticSelection(); if (pc.id !== activePcId) { switchPc(pc.id); } }}
								onLongPress={() => promptRename(pc.id, pc.name)}
								accessibilityLabel={`${pc.name}（長押しで名前を変更）`}
							>
								<PcAvatar name={pc.name} hue={pc.hue} size={34} />
								<View style={styles.rowBody}>
									<Text style={styles.rowTitle} numberOfLines={1}>{pc.name}</Text>
									<Text style={styles.rowDesc} numberOfLines={1}>{pcStatusText(pc, pc.id === activePcId)}</Text>
								</View>
								<Pressable
									style={styles.iconBtn}
									hitSlop={8}
									onPress={() => promptRename(pc.id, pc.name)}
									accessibilityLabel="名前を変更"
								>
									<Ionicons name="pencil-outline" size={15} color={colors.textDim} />
								</Pressable>
								<Pressable
									style={styles.iconBtn}
									hitSlop={8}
									onPress={() => confirmRemove(pc.id, pc.name)}
									accessibilityLabel="ペアリングを解除"
								>
									<Ionicons name="trash-outline" size={15} color={colors.red} />
								</Pressable>
							</Pressable>
						</View>
					))}
					{pcs.length > 0 ? <View style={styles.separator} /> : null}
					<Pressable style={styles.row} onPress={() => { hapticSelection(); router.push('/pair'); }}>
						<Ionicons name="add" size={18} color={colors.accent} />
						<View style={styles.rowBody}>
							<Text style={[styles.rowTitle, { color: colors.accent }]}>新しいPCとペアリング</Text>
							<Text style={styles.rowDesc}>PC側の「Para Code: モバイルデバイスを接続」でQRを出して読み取ります</Text>
						</View>
					</Pressable>
				</View>
				<View style={[styles.card, styles.cardSpaced]}>
					<View style={styles.row}>
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>見ていないPCとの接続を保つ</Text>
							<Text style={styles.rowDesc}>他のPCの様子も更新し続けます（オフにすると通信量は減りますが、切り替えるまで件数が分かりません）</Text>
						</View>
						<Switch
							value={keepBackgroundPcs}
							onValueChange={value => { hapticSelection(); setKeepBackgroundPcs(value); }}
							trackColor={{ true: colors.accent2 }}
						/>
					</View>
					<View style={styles.separator} />
					<View style={styles.row}>
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>他のPCからの通知も出す</Text>
							<Text style={styles.rowDesc}>アプリを開いている間の話です。オフにすると、いま見ているPCの通知だけがバナーで出ます（アプリを閉じている間はどのPCからも届きます）</Text>
						</View>
						<Switch
							value={notifyOtherPcs}
							onValueChange={value => { hapticSelection(); setNotifyOtherPcs(value); }}
							trackColor={{ true: colors.accent2 }}
						/>
					</View>
				</View>

				<Text style={styles.sectionTitle}>通知</Text>
				<View style={styles.card}>
					<View style={styles.row}>
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>作業完了を通知</Text>
							<Text style={styles.rowDesc}>エージェントの作業が終わったときにバナーを出します</Text>
						</View>
						<Switch
							value={notifyPrefs.agentDone}
							onValueChange={toggle('agentDone')}
							trackColor={{ true: colors.accent2 }}
						/>
					</View>
					<View style={styles.separator} />
					<View style={styles.row}>
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>質問を通知</Text>
							<Text style={styles.rowDesc}>エージェントから質問・承認要求があったときにバナーを出します</Text>
						</View>
						<Switch
							value={notifyPrefs.agentQuestion}
							onValueChange={toggle('agentQuestion')}
							trackColor={{ true: colors.accent2 }}
						/>
					</View>
					<View style={styles.separator} />
					<View style={styles.row}>
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>PC作業中は鳴らさない</Text>
							<Text style={styles.rowDesc}>PCを操作している間はバナーを出しません</Text>
						</View>
						<Switch
							value={notifyPrefs.suppressWhenPcFocused}
							onValueChange={toggle('suppressWhenPcFocused')}
							trackColor={{ true: colors.accent2 }}
						/>
					</View>
				</View>
				<Text style={styles.note}>
					どれもバナーを止めるだけで、通知そのものは届きます（ホーム右上のベルからあとで読み返せます）。このアプリでそのエージェントの画面を開いている間も、同じ内容のバナーは出しません。
				</Text>

				<Text style={styles.sectionTitle}>このアプリについて</Text>
				<View style={styles.card}>
					<Pressable style={styles.row} onPress={() => { hapticSelection(); router.push('/changelog'); }}>
						<Ionicons name="sparkles-outline" size={18} color={colors.accent} />
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>更新履歴</Text>
							<Text style={styles.rowDesc}>アプリの各バージョンで何が変わったかを確認します</Text>
						</View>
						<Text style={styles.rowValue}>{APP_VERSION}</Text>
						<Ionicons name="chevron-forward" size={16} color={colors.textDim} />
					</Pressable>
				</View>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 10 },
	title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3, flex: 1 },
	rowValue: { color: colors.textDim, fontSize: 11.5, fontWeight: '600' },
	closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	scroll: { flex: 1, paddingHorizontal: 16 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8, marginBottom: 8 },
	card: { backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
	cardSpaced: { marginTop: 8 },
	iconBtn: { width: 30, height: 30, borderRadius: 9, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
	rowBody: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
	rowDesc: { color: colors.textDim, fontSize: 11.5, marginTop: 2, lineHeight: 15 },
	separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 10, paddingHorizontal: 4 },
});
