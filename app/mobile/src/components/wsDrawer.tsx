// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Alert, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import ReanimatedDrawerLayout, { DrawerLayoutMethods, DrawerPosition, DrawerType } from 'react-native-gesture-handler/ReanimatedDrawerLayout';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { isAgentWaiting } from '../store.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { GlassSurface, liquidGlass } from './glassSurface.js';
import { colors } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';

/**
 * ワークスペースドロワー（mock.html 案A準拠）。全タブ共通の左スライドドロワーに
 * ワークスペース選択を一本化する（旧wsBar.tsxのボトムシートを置き換え）。
 *
 * RNGHの`ReanimatedDrawerLayout`を使い、ジェスチャ認識はネイティブ・アニメは
 * Reanimated worklet（UIスレッド）で駆動する。これによりJSスレッドが混雑していても
 * X等のネイティブアプリ同様、指に追従するエッジスワイプと速度を引き継ぐ
 * スプリング開閉になる（旧実装のPanResponder+Modal方式はJS駆動のため体感が重かった）。
 *
 * 使い方: `(tabs)/_layout.tsx` で `WsDrawerLayout` がNativeTabs全体を1回だけ包み、
 * 各画面のヘッダー（`WsHeader`）のチップは `useWsDrawer().open()` で開く。
 *  - 上部: 接続中PCのステータスと統計（旧ホームの「接続中のPC」カードから移設）
 *  - 中央: ワークスペース一覧（応答待ちは「質問あり」バッジで強調）
 *  - 下部: 接続/切断トグルとペアリング解除（同じく旧ホームカードから移設）
 */

/** ワークスペースの表示色。PC側がcolorを配信していればそれを、無ければ名前のハッシュで安定に決める。 */
const WS_PALETTE = [colors.accent, colors.purple, colors.green, colors.orange, colors.yellow, colors.red] as const;
export function wsColor(ws: { id: string; color?: string }): string {
	if (ws.color) {
		return ws.color;
	}
	let hash = 0;
	for (let i = 0; i < ws.id.length; i++) {
		hash = (hash * 31 + ws.id.charCodeAt(i)) >>> 0;
	}
	return WS_PALETTE[hash % WS_PALETTE.length] ?? colors.accent;
}

/** 現在有効な選択ワークスペースを返すフック（未選択時は先頭）。旧wsBar.tsxから移設。 */
export function useEffectiveWs(): { id: string; name: string; branch?: string; color?: string } | undefined {
	const { workspace, selectedWs } = useAppStore(useShallow(s => ({ workspace: s.workspace, selectedWs: s.selectedWs })));
	const list = workspace?.workspaces ?? [];
	return list.find(w => w.id === selectedWs) ?? list[0];
}

interface WsDrawerApi {
	open(): void;
	close(): void;
	/**
	 * 画面全域の右スワイプでドロワーを開けるようにする（ホームタブ用）。
	 * 横スクロールやWebView操作を持つタブでは左端エッジのみに戻すこと。
	 * タブのフォーカスが外れたら必ずfalseに戻す（呼び出し側のeffectのクリーンアップで）。
	 */
	setFullWidthSwipe(enabled: boolean): void;
}

const WsDrawerContext = createContext<WsDrawerApi | undefined>(undefined);

/** ドロワーの開閉API。`WsDrawerLayout` 配下でのみ有効（外では no-op）。 */
export function useWsDrawer(): WsDrawerApi {
	return useContext(WsDrawerContext) ?? { open: () => { }, close: () => { }, setFullWidthSwipe: () => { } };
}

/**
 * タブナビゲータ全体を包むドロワーレイアウト（`(tabs)/_layout.tsx` から1回だけ使う）。
 * ドロワーはタブバーごと覆う（X等と同じ全画面オーバーレイ）。
 */
export function WsDrawerLayout({ children }: { children: ReactNode }) {
	const ref = useRef<DrawerLayoutMethods>(null);
	const { width } = useWindowDimensions();
	const [fullWidthSwipe, setFullWidthSwipe] = useState(false);
	const api = useMemo<WsDrawerApi>(() => ({
		open: () => {
			hapticImpact('light');
			ref.current?.openDrawer();
		},
		close: () => ref.current?.closeDrawer(),
		setFullWidthSwipe,
	}), []);
	const renderDrawer = useCallback(() => <WsDrawerContent onClose={api.close} />, [api]);

	return (
		<WsDrawerContext.Provider value={api}>
			<ReanimatedDrawerLayout
				ref={ref}
				drawerWidth={Math.min(width * 0.82, 360)}
				drawerPosition={DrawerPosition.LEFT}
				drawerType={DrawerType.FRONT}
				overlayColor="rgba(0,0,0,0.55)"
				// 通常は左端エッジのみでスワイプ開始を受け付ける（ターミナル/ブラウザWebViewの
				// 横操作との競合を最小化。認識はネイティブなので閾値未満のタップは阻害しない）。
				// ホームタブのフォーカス中のみ画面全域の右スワイプで開ける（X方式）。
				edgeWidth={fullWidthSwipe ? width : 24}
				renderNavigationView={renderDrawer}
			>
				{children}
			</ReanimatedDrawerLayout>
		</WsDrawerContext.Provider>
	);
}

/** ドロワーの中身。ReanimatedDrawerLayoutのrenderNavigationViewから描画される。 */
function WsDrawerContent({ onClose }: { onClose: () => void }) {
	const insets = useStableInsets();
	const router = useRouter();
	const {
		workspace, selectedWs, setSelectedWs, connection, pcOnline, manualOffline,
		disconnectRelay, connectRelay, unpair,
	} = useAppStore(useShallow(s => ({
		workspace: s.workspace, selectedWs: s.selectedWs, setSelectedWs: s.setSelectedWs,
		connection: s.connection, pcOnline: s.pcOnline, manualOffline: s.manualOffline,
		disconnectRelay: s.disconnectRelay, connectRelay: s.connectRelay, unpair: s.unpair,
	})));

	const list = workspace?.workspaces ?? [];
	const terminals = workspace?.terminals ?? [];
	const effective = selectedWs !== undefined && list.some(w => w.id === selectedWs) ? selectedWs : list[0]?.id;
	const waitingTotal = terminals.filter(t => isAgentWaiting(t.agentStatus)).length;
	const online = connection === 'online' && pcOnline;

	const select = (id: string) => {
		hapticSelection();
		setSelectedWs(id);
		onClose();
	};

	const confirmUnpair = () => {
		Alert.alert(
			'ペアリング解除',
			'このPCとのペアリング情報を削除します。再接続にはPC側でQRコードを再発行してのペアリングが必要です。',
			[
				{ text: 'キャンセル', style: 'cancel' },
				{ text: '解除する', style: 'destructive', onPress: () => { void unpair(); } },
			],
		);
	};

	return (
		<View style={[styles.drawer, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 }]}>
			{/* 接続中PCステータス（旧ホームカードから移設） */}
			<View style={styles.pcSection}>
				<View style={styles.pcRow}>
					<Image source={require('../../assets/pairing-logo.png')} style={styles.pcIcon} resizeMode="contain" />
					<View style={styles.pcBody}>
						<Text style={styles.pcName}>Para Code</Text>
						<Text style={[styles.pcState, !online && styles.pcStateOff]}>
							{online ? '● 接続中' : (connection === 'online' || connection === 'handshaking') && !pcOnline ? '○ PCオフライン' : manualOffline ? '○ 切断中' : '接続中…'}
						</Text>
					</View>
					<Pressable
						style={styles.settingsBtn}
						onPress={() => { onClose(); router.push('/settings'); }}
						accessibilityLabel="設定"
						hitSlop={6}
					>
						<Ionicons name="settings-outline" size={17} color={colors.textDim} />
					</Pressable>
				</View>
				<View style={styles.statsRow}>
					<View style={styles.stat}>
						<Text style={styles.statValue}>{list.length}</Text>
						<Text style={styles.statLabel}>ワークスペース</Text>
					</View>
					<View style={styles.stat}>
						<Text style={styles.statValue}>{terminals.length}</Text>
						<Text style={styles.statLabel}>ターミナル</Text>
					</View>
					<View style={styles.stat}>
						<Text style={[styles.statValue, waitingTotal > 0 && styles.statValueAlert]}>{waitingTotal}</Text>
						<Text style={styles.statLabel}>応答待ち</Text>
					</View>
				</View>
			</View>

			<Text style={styles.sectionTitle}>ワークスペース</Text>
			<ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
				{list.map(ws => {
					const active = ws.id === effective;
					// ws未タグのターミナルは他画面と同様にPC側アクティブワークスペース所属として数える
					const wsTerminals = terminals.filter(t => (t.ws ?? workspace?.activeWs) === ws.id);
					const waiting = wsTerminals.filter(t => isAgentWaiting(t.agentStatus)).length;
					const running = wsTerminals.filter(t => t.agentStatus === 'working').length;
					const color = wsColor(ws);
					return (
						<Pressable key={ws.id} style={[styles.row, active && styles.rowActive]} onPress={() => select(ws.id)}>
							{active ? <View style={styles.rowIndicator} /> : null}
							<View style={[styles.avatar, { backgroundColor: color + '22' }]}>
								<Text style={[styles.avatarText, { color }]}>{ws.name.charAt(0).toUpperCase()}</Text>
							</View>
							<View style={styles.rowBody}>
								<Text style={[styles.rowName, active && styles.rowNameActive]} numberOfLines={1}>{ws.name}</Text>
								{ws.branch ? (
									<View style={styles.rowBranchRow}>
										<Ionicons name="git-branch-outline" size={10} color={colors.accent} />
										<Text style={styles.rowBranch} numberOfLines={1}>{ws.branch}</Text>
									</View>
								) : null}
							</View>
							{waiting > 0 ? (
								<View style={styles.alertBadge}><Text style={styles.alertBadgeText}>質問あり</Text></View>
							) : null}
							{running > 0 ? <View style={styles.runOrb} /> : null}
							{wsTerminals.length === 0 ? <Text style={styles.countText}>0</Text> : null}
						</Pressable>
					);
				})}
				{list.length === 0 ? (
					<Text style={styles.dim}>ワークスペース情報を取得中… PCの Para Code でリポジトリを登録すると表示されます。</Text>
				) : null}
			</ScrollView>

			{/* 接続管理（旧ホームカードのボタン群から移設） */}
			<View style={styles.footer}>
				{connection === 'online' ? (
					<Pressable style={styles.footerBtn} onPress={disconnectRelay} accessibilityLabel="切断">
						<Ionicons name="power-outline" size={13} color={colors.red} />
						<Text style={[styles.footerBtnText, { color: colors.red }]}>切断</Text>
					</Pressable>
				) : (
					<Pressable style={styles.footerBtn} onPress={connectRelay} accessibilityLabel="接続">
						<Ionicons name="power-outline" size={13} color={colors.green} />
						<Text style={[styles.footerBtnText, { color: colors.green }]}>接続</Text>
					</Pressable>
				)}
				<Pressable style={styles.footerBtn} onPress={confirmUnpair} accessibilityLabel="ペアリング解除">
					<Ionicons name="trash-outline" size={13} color={colors.textDim} />
					<Text style={styles.footerBtnText}>ペアリング解除</Text>
				</Pressable>
			</View>
		</View>
	);
}

/**
 * タブ画面のヘッダー（旧screenTitle.tsxのレイアウトを踏襲）。
 * 左端のワークスペースチップのタップでドロワーを開く（エッジスワイプは
 * WsDrawerLayoutがネイティブで処理するため、ここにジェスチャは持たない）。
 */
export function WsHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
	const insets = useStableInsets();
	const drawer = useWsDrawer();
	const { workspace } = useAppStore(useShallow(s => ({ workspace: s.workspace })));
	const current = useEffectiveWs();

	// 他ワークスペースの応答待ち件数（チップ上の赤バッジ = ドロワーを開く動機づけ）。
	// ws未タグのターミナルは他画面と同様にPC側アクティブワークスペース所属として数える。
	const otherWaiting = (workspace?.terminals ?? []).filter(t =>
		isAgentWaiting(t.agentStatus) && (t.ws ?? workspace?.activeWs) !== current?.id).length;

	const chipColor = current ? wsColor(current) : colors.accent;
	const defaultSubtitle = current ? `${current.name}${current.branch ? ` · ${current.branch}` : ''}` : undefined;

	return (
		<View style={[styles.headerWrap, { paddingTop: insets.top + 4 }]}>
			<Pressable onPress={drawer.open} accessibilityLabel="ワークスペースを切り替え">
				{/* iOS 26+はワークスペース色をtintしたLiquid Glass、それ未満は従来の色付きチップ */}
				<GlassSurface
					style={[styles.chip, !liquidGlass && { backgroundColor: chipColor + '22', borderColor: chipColor + '55', borderWidth: 1 }]}
					interactive
					tintColor={liquidGlass ? chipColor + '33' : undefined}
				>
					<Text style={[styles.chipText, { color: chipColor }]}>{current ? current.name.charAt(0).toUpperCase() : '—'}</Text>
				</GlassSurface>
				{otherWaiting > 0 ? (
					<View style={styles.chipBadge}><Text style={styles.chipBadgeText}>{otherWaiting}</Text></View>
				) : null}
			</Pressable>
			<View style={styles.textCol}>
				<Text style={styles.title}>{title}</Text>
				{(subtitle ?? defaultSubtitle) ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle ?? defaultSubtitle}</Text> : null}
			</View>
			{right}
		</View>
	);
}

const styles = StyleSheet.create({
	// ヘッダー（旧screenTitle.tsxのスタイルを踏襲。左paddingはチップがあるため少し狭める）
	headerWrap: { paddingLeft: 16, paddingRight: 12, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
	chip: { width: 36, height: 36, borderRadius: 11, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
	chipText: { fontSize: 14, fontWeight: '800', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	chipBadge: {
		position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, borderRadius: 8,
		backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
		borderWidth: 2, borderColor: colors.bg,
	},
	chipBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
	textCol: { flex: 1, minWidth: 0 },
	title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3 },
	subtitle: { color: colors.textDim, fontSize: 11.5, marginTop: 2 },

	// ドロワー
	drawer: {
		flex: 1, backgroundColor: '#0e0e11',
		borderRightWidth: 1, borderRightColor: colors.borderStrong,
	},
	pcSection: { paddingHorizontal: 18, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
	pcRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
	pcIcon: { width: 38, height: 38 },
	settingsBtn: { width: 32, height: 32, borderRadius: 10, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
	pcBody: { flex: 1, minWidth: 0 },
	pcName: { color: colors.text, fontSize: 14, fontWeight: '700' },
	pcState: { color: colors.green, fontSize: 11, marginTop: 1 },
	pcStateOff: { color: colors.textDim },
	statsRow: { flexDirection: 'row', gap: 6, marginTop: 12 },
	stat: { flex: 1, backgroundColor: colors.surface2, borderRadius: 10, paddingVertical: 7, alignItems: 'center' },
	statValue: { color: colors.accent, fontSize: 15, fontWeight: '700' },
	statValueAlert: { color: colors.red },
	statLabel: { color: colors.textDim, fontSize: 9.5, marginTop: 1 },
	sectionTitle: { color: colors.textDim, fontSize: 10.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 8 },
	list: { flex: 1 },
	listContent: { paddingHorizontal: 10, paddingBottom: 8 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, paddingHorizontal: 10, borderRadius: 12, marginBottom: 2 },
	rowActive: { backgroundColor: colors.accentWash },
	rowIndicator: { position: 'absolute', left: 0, top: 10, bottom: 10, width: 3, borderRadius: 2, backgroundColor: colors.accent },
	avatar: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
	avatarText: { fontSize: 13, fontWeight: '800', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	rowBody: { flex: 1, minWidth: 0 },
	rowName: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
	rowNameActive: { color: colors.accent },
	rowBranchRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
	rowBranch: { color: colors.textDim, fontSize: 10.5, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', flexShrink: 1 },
	alertBadge: { backgroundColor: 'rgba(244,114,114,0.15)', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
	alertBadgeText: { color: colors.red, fontSize: 9.5, fontWeight: '700' },
	runOrb: { width: 8, height: 8, borderRadius: 5, backgroundColor: colors.green },
	countText: { color: colors.textDim, fontSize: 10, backgroundColor: colors.surface3, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
	dim: { color: colors.textDim, fontSize: 12, paddingHorizontal: 8, lineHeight: 18 },
	footer: { flexDirection: 'row', gap: 8, paddingHorizontal: 18, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
	footerBtn: {
		flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
		backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 9,
	},
	footerBtnText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
});
