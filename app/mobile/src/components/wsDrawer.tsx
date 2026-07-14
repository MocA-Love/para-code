// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, LayoutAnimation, Platform, Pressable, ScrollView, StyleSheet, Text, UIManager, View, useWindowDimensions } from 'react-native';
import ReanimatedDrawerLayout, { DrawerLayoutMethods, DrawerPosition, DrawerType } from 'react-native-gesture-handler/ReanimatedDrawerLayout';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { isAgentWaiting } from '../store.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { GlassSurface, liquidGlass } from './glassSurface.js';
import { WorktreeCreateSheet } from './worktreeCreateSheet.js';
import { colors } from '../theme.js';
import { hapticImpact, hapticSelection, hapticWarning } from '../haptics.js';

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

// AndroidのLayoutAnimation（ワークツリー開閉アニメ）は旧アーキテクチャでは明示的な有効化が必要
// （新アーキテクチャではこの呼び出しはno-opで無害）。
if (Platform.OS === 'android') {
	UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

/** stateスナップショットのワークスペースエントリ（parentはworktreeの親リポジトリid）。 */
type WsEntry = { id: string; name: string; color?: string; branch?: string; parent?: string };

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
		workspace, selectedWs, setSelectedWs, homeShowAllWorkspaces, setHomeShowAllWorkspaces, connection, pcOnline, sessionProtocolReady, manualOffline,
		disconnectRelay, connectRelay, unpair,
	} = useAppStore(useShallow(s => ({
		workspace: s.workspace, selectedWs: s.selectedWs, setSelectedWs: s.setSelectedWs,
		homeShowAllWorkspaces: s.homeShowAllWorkspaces, setHomeShowAllWorkspaces: s.setHomeShowAllWorkspaces,
		connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady, manualOffline: s.manualOffline,
		disconnectRelay: s.disconnectRelay, connectRelay: s.connectRelay, unpair: s.unpair,
	})));

	const list: WsEntry[] = workspace?.workspaces ?? [];
	const terminals = workspace?.terminals ?? [];
	const effective = selectedWs !== undefined && list.some(w => w.id === selectedWs) ? selectedWs : list[0]?.id;
	const waitingTotal = terminals.filter(t => isAgentWaiting(t.agentStatus)).length;
	const online = connection === 'online' && pcOnline && sessionProtocolReady;

	// ── ワークツリー（スペース）の親子グルーピング ──
	// parent付きエントリを親リポジトリ行の配下にまとめ、開閉できるようにする。
	// 旧PC（parent未配信）では全エントリがrepos側に入り、従来通りのフラット表示になる。
	const repos = list.filter(w => w.parent === undefined);
	const repoIds = new Set(repos.map(r => r.id));
	// 親が一覧に見つからないworktree（不整合時の保険）はフラット表示にフォールバック
	const orphans = list.filter(w => w.parent !== undefined && !repoIds.has(w.parent));
	// 閉じているリポジトリidの集合（既定は全展開）。ドロワーはマウントされ続けるため
	// セッション中は保持される（永続化はしない）。
	const [collapsedRepos, setCollapsedRepos] = useState<ReadonlySet<string>>(new Set());
	// 「新しいスペース（worktree）を作成」シートの表示状態（見出し右の＋から開く）。
	const [createSheetOpen, setCreateSheetOpen] = useState(false);

	// 選択が閉じたグループ内へ移ったときだけ自動展開する（選択行が隠れたままにならないように）。
	// 依存をeffective/selectedParentに絞ることで、選択中グループを手動で閉じ直す操作は妨げない。
	const selectedParent = list.find(w => w.id === effective)?.parent;
	useEffect(() => {
		if (selectedParent === undefined) {
			return;
		}
		setCollapsedRepos(prev => {
			if (!prev.has(selectedParent)) {
				return prev;
			}
			const next = new Set(prev);
			next.delete(selectedParent);
			return next;
		});
	}, [effective, selectedParent]);

	const toggleRepo = (id: string) => {
		hapticImpact('light');
		LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
		setCollapsedRepos(prev => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const select = (id: string) => {
		hapticSelection();
		setSelectedWs(id);
		setHomeShowAllWorkspaces(false);
		onClose();
	};

	/** ワークスペース一覧上部の「すべて表示」。ホームの絞り込みを解除する（他タブのselectedWsは変えない）。 */
	const selectAll = () => {
		hapticSelection();
		setHomeShowAllWorkspaces(true);
		onClose();
	};

	// ws未タグのターミナルは他画面と同様にPC側アクティブワークスペース所属として数える
	const wsTerminalsOf = (id: string) => terminals.filter(t => (t.ws ?? workspace?.activeWs) === id);

	/**
	 * ワークスペース1行。child=worktree行（インデント＋ガイド線）、childCount>0=グループ親行
	 * （ワークツリー数＋開閉シェブロン付き。折りたたみ中はaggWaiting/aggRunningで配下の
	 * 応答待ち・実行中を集約表示し、閉じていても見落とさないようにする）。
	 */
	const renderRow = (ws: WsEntry, opts: { child?: boolean; childCount?: number; open?: boolean; aggWaiting?: number; aggRunning?: number } = {}) => {
		// 「すべて表示」が選ばれている間はどのワークスペース行もアクティブ表示にしない
		// （ホームの絞り込み先が無いことを一目で示す）。
		const active = !homeShowAllWorkspaces && ws.id === effective;
		const wsTerminals = wsTerminalsOf(ws.id);
		const waiting = wsTerminals.filter(t => isAgentWaiting(t.agentStatus)).length + (opts.aggWaiting ?? 0);
		const running = wsTerminals.filter(t => t.agentStatus === 'working').length + (opts.aggRunning ?? 0);
		const color = wsColor(ws);
		// グループ表示ではPCが旧アプリ互換のために付ける「✦ 」接頭辞を取り除く
		const name = opts.child ? ws.name.replace(/^✦ /, '') : ws.name;
		const grouped = (opts.childCount ?? 0) > 0;
		return (
			<Pressable key={ws.id} style={[styles.row, opts.child && styles.wtRow, active && styles.rowActive]} onPress={() => select(ws.id)}>
				{active && !opts.child ? <View style={styles.rowIndicator} /> : null}
				{opts.child ? <View style={[styles.wtGuide, active && styles.wtGuideActive]} /> : null}
				<View style={[styles.avatar, opts.child && styles.wtAvatar, { backgroundColor: color + '22' }]}>
					<Text style={[styles.avatarText, opts.child && styles.wtAvatarText, { color }]}>{opts.child ? '✦' : name.charAt(0).toUpperCase()}</Text>
				</View>
				<View style={styles.rowBody}>
					<Text style={[styles.rowName, opts.child && styles.wtName, active && styles.rowNameActive]} numberOfLines={1}>{name}</Text>
					{ws.branch ? (
						<View style={styles.rowBranchRow}>
							<Ionicons name="git-branch-outline" size={10} color={colors.accent} />
							<Text style={styles.rowBranch} numberOfLines={1}>{ws.branch}</Text>
						</View>
					) : null}
				</View>
				{waiting > 0 ? (
					<View style={styles.alertBadge}><Text style={styles.alertBadgeText}>{waiting > 1 ? `質問あり ${waiting}` : '質問あり'}</Text></View>
				) : null}
				{running > 0 ? <View style={styles.runOrb} /> : null}
				{!grouped && wsTerminals.length === 0 ? <Text style={styles.countText}>0</Text> : null}
				{grouped ? (
					<>
						<Text style={styles.wtCount}>{opts.childCount}</Text>
						<Pressable
							style={styles.twistBtn}
							hitSlop={6}
							onPress={() => toggleRepo(ws.id)}
							accessibilityLabel={opts.open ? 'ワークツリーを折りたたむ' : 'ワークツリーを展開'}
						>
							<Ionicons name={opts.open ? 'chevron-down' : 'chevron-forward'} size={13} color={colors.textDim} />
						</Pressable>
					</>
				) : null}
			</Pressable>
		);
	};

	const confirmUnpair = () => {
		hapticWarning();
		Alert.alert(
			'ペアリング解除',
			'このPCとのペアリング情報を削除します。再接続にはPC側でQRコードを再発行してのペアリングが必要です。',
			[
				{ text: 'キャンセル', style: 'cancel' },
				{
					text: '解除する', style: 'destructive', onPress: () => {
						void unpair().catch(error => Alert.alert('ペアリングを解除できませんでした', error instanceof Error ? error.message : String(error)));
					},
				},
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
						onPress={() => { hapticSelection(); onClose(); router.push('/settings'); }}
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

			<View style={styles.sectionHead}>
				<Text style={styles.sectionTitle}>ワークスペース</Text>
				{/* PC版の「スペース名右の＋」に対応する、新しいスペース（worktree）作成の入口 */}
				<Pressable
					disabled={!online}
					style={[styles.addSpaceBtn, !online && styles.actionDisabled]}
					hitSlop={8}
					onPress={() => { hapticSelection(); setCreateSheetOpen(true); }}
					accessibilityLabel="新しいスペースを作成"
				>
					<Ionicons name="add" size={16} color={colors.text} />
				</Pressable>
			</View>
			<ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
				<Pressable style={[styles.row, styles.allRow, homeShowAllWorkspaces && styles.rowActive]} onPress={selectAll}>
					{homeShowAllWorkspaces ? <View style={styles.rowIndicator} /> : null}
					<View style={[styles.avatar, styles.allIcon]}>
						<Ionicons name="apps-outline" size={16} color={homeShowAllWorkspaces ? colors.accent : colors.textDim} />
					</View>
					<View style={styles.rowBody}>
						<Text style={[styles.rowName, homeShowAllWorkspaces && styles.rowNameActive]}>すべて表示</Text>
						<Text style={styles.allSub}>全ワークスペース横断で見る</Text>
					</View>
				</Pressable>
				{repos.map(repo => {
					const children = list.filter(w => w.parent === repo.id);
					if (children.length === 0) {
						return renderRow(repo);
					}
					const open = !collapsedRepos.has(repo.id);
					// 折りたたみ中は配下の応答待ち/実行中を親行に集約表示する
					const aggWaiting = open ? 0 : children.reduce((n, c) => n + wsTerminalsOf(c.id).filter(t => isAgentWaiting(t.agentStatus)).length, 0);
					const aggRunning = open ? 0 : children.reduce((n, c) => n + wsTerminalsOf(c.id).filter(t => t.agentStatus === 'working').length, 0);
					return (
						<View key={repo.id}>
							{renderRow(repo, { childCount: children.length, open, aggWaiting, aggRunning })}
							{open ? children.map(c => renderRow(c, { child: true })) : null}
						</View>
					);
				})}
				{orphans.map(ws => renderRow(ws))}
				{list.length === 0 ? (
					<Text style={styles.dim}>ワークスペース情報を取得中… PCの Para Code でリポジトリを登録すると表示されます。</Text>
				) : null}
			</ScrollView>

			{/* 接続管理（旧ホームカードのボタン群から移設） */}
			<View style={styles.footer}>
				{connection === 'online' ? (
					<Pressable style={styles.footerBtn} onPress={() => { hapticImpact('light'); disconnectRelay(); }} accessibilityLabel="切断">
						<Ionicons name="power-outline" size={13} color={colors.red} />
						<Text style={[styles.footerBtnText, { color: colors.red }]}>切断</Text>
					</Pressable>
				) : (
					<Pressable style={styles.footerBtn} onPress={() => { hapticImpact('light'); connectRelay(); }} accessibilityLabel="接続">
						<Ionicons name="power-outline" size={13} color={colors.green} />
						<Text style={[styles.footerBtnText, { color: colors.green }]}>接続</Text>
					</Pressable>
				)}
				<Pressable style={styles.footerBtn} onPress={confirmUnpair} accessibilityLabel="ペアリング解除">
					<Ionicons name="trash-outline" size={13} color={colors.textDim} />
					<Text style={styles.footerBtnText}>ペアリング解除</Text>
				</Pressable>
			</View>
			<WorktreeCreateSheet visible={createSheetOpen} onClose={() => setCreateSheetOpen(false)} />
		</View>
	);
}

/**
 * タブ画面のヘッダー（旧screenTitle.tsxのレイアウトを踏襲）。
 * 左端のワークスペースチップのタップでドロワーを開く（エッジスワイプは
 * WsDrawerLayoutがネイティブで処理するため、ここにジェスチャは持たない）。
 */
export function WsHeader({ title, subtitle, right, allWorkspaces }: { title: string; subtitle?: string; right?: ReactNode; allWorkspaces?: boolean }) {
	const insets = useStableInsets();
	const drawer = useWsDrawer();
	const { workspace } = useAppStore(useShallow(s => ({ workspace: s.workspace })));
	const current = useEffectiveWs();

	// 他ワークスペースの応答待ち件数（チップ上の赤バッジ = ドロワーを開く動機づけ）。
	// ws未タグのターミナルは他画面と同様にPC側アクティブワークスペース所属として数える。
	// allWorkspaces中はすでに全件が見えているため「他」の概念が無く、バッジは出さない。
	const otherWaiting = allWorkspaces ? 0 : (workspace?.terminals ?? []).filter(t =>
		isAgentWaiting(t.agentStatus) && (t.ws ?? workspace?.activeWs) !== current?.id).length;

	const chipColor = allWorkspaces ? colors.textDim : (current ? wsColor(current) : colors.accent);
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
					{allWorkspaces ? (
						<Ionicons name="apps-outline" size={16} color={chipColor} />
					) : (
						<Text style={[styles.chipText, { color: chipColor }]}>{current ? current.name.charAt(0).toUpperCase() : '—'}</Text>
					)}
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
	sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 16 },
	sectionTitle: { color: colors.textDim, fontSize: 10.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 8 },
	addSpaceBtn: { width: 24, height: 24, borderRadius: 7, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
	actionDisabled: { opacity: 0.45 },
	list: { flex: 1 },
	listContent: { paddingHorizontal: 10, paddingBottom: 8 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, paddingHorizontal: 10, borderRadius: 12, marginBottom: 2 },
	rowActive: { backgroundColor: colors.accentWash },
	rowIndicator: { position: 'absolute', left: 0, top: 10, bottom: 10, width: 3, borderRadius: 2, backgroundColor: colors.accent },
	// 「すべて表示」行: 通常のワークスペース行とアイコン以外は共通のスタイルを流用する
	allRow: { marginBottom: 8 },
	allIcon: { backgroundColor: colors.surface2 },
	allSub: { color: colors.textDim, fontSize: 10.5, marginTop: 2 },
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
	// ワークツリー（グループ子行）: インデント＋左端の縦ガイド線で親子関係を示す
	wtRow: { marginLeft: 27, paddingLeft: 14, paddingVertical: 9 },
	wtGuide: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 1.5, borderRadius: 1, backgroundColor: colors.borderStrong },
	wtGuideActive: { backgroundColor: colors.accent },
	wtAvatar: { width: 26, height: 26, borderRadius: 8 },
	wtAvatarText: { fontSize: 11 },
	wtName: { fontSize: 12.5 },
	// グループ親行: ワークツリー数バッジ＋開閉シェブロン（行本体タップ=選択と分離した独立ヒット領域）
	wtCount: { color: colors.textDim, fontSize: 10, backgroundColor: colors.surface3, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	twistBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginVertical: -6, marginRight: -4 },
	dim: { color: colors.textDim, fontSize: 12, paddingHorizontal: 8, lineHeight: 18 },
	footer: { flexDirection: 'row', gap: 8, paddingHorizontal: 18, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
	footerBtn: {
		flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
		backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 9,
	},
	footerBtnText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
});
