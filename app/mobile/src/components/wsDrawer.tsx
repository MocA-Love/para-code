// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, LayoutAnimation, Platform, Pressable, ScrollView, StyleSheet, Text, UIManager, View, useWindowDimensions } from 'react-native';
import { Gesture, type PanGesture } from 'react-native-gesture-handler';
import ReanimatedDrawerLayout, { DrawerLayoutMethods, DrawerLockMode, DrawerPosition, DrawerState, DrawerType } from 'react-native-gesture-handler/ReanimatedDrawerLayout';
import { useSegments, usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { isAgentWaiting, type DesktopResources } from '../store.js';
import {
	CPU_THRESHOLDS, MEMORY_THRESHOLDS, diskLevel, formatCpu, usageLevel, usagePercent,
	type UsageLevel,
} from '../systemResources.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { shouldReturnHomeOnSpaceChange } from '../ipad/ipadTabs.js';
import { screenCornerRadius } from '../screenCornerRadius.js';
import { useOfflineNotice } from '../offlineNotice.js';
import { useParaHeader, PARA_HEADER_HIDDEN, type ParaHeaderIcon, type ParaHeaderSpec } from '../paraHeader.js';
import { GlassSurface } from './glassSurface.js';
import { PcCardHeader, PcSwitcher } from './pcSwitcher.js';
import { useConnectionGateBlocked } from './connectionGate.js';
import { WorktreeCreateSheet } from './worktreeCreateSheet.js';
import { colors, radius, squircle, withAlpha } from '../theme.js';
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
type WsEntry = { id: string; name: string; color?: string; branch?: string; parent?: string; note?: { open: number; done: number }; pinned?: boolean };

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
	 * 画面全域の右スワイプでドロワーを開けるようにする。
	 * 横スクロールやWebView操作を持つタブでは左端エッジのみに戻すこと。
	 * タブのフォーカスが外れたら必ずfalseに戻す（呼び出し側のeffectのクリーンアップで）。
	 *
	 * **現在どこからも有効にしていない。** RNGHのドロワーは全画面モードだと、向きを問わず
	 * 指が動いた最初の1pxでジェスチャを取ってしまい、配下の行に付けた横スワイプ（ホームの
	 * アーカイブ等）が毎回そこで潰れる。ホームは自前の右向きジェスチャで開いている
	 * （app/(tabs)/index.tsx）。ここを再び有効にする場合はその競合を必ず確かめること。
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
 *
 * 開閉の見せ方はX（Twitter）の実機スクリーンショットをピクセル解析した実測値に合わせている:
 *  - コンテンツは縮小しない（scale=1.0のまま）。ドロワー幅ぶんちょうど右へ押し出すだけ
 *  - コンテンツの角は端末のディスプレイ角丸と同じ半径で丸める。開いたときに覗く左端の角丸が
 *    「iPhoneの枠が見えながら出てくる」という見え方の正体で、コンテンツの縮小ではない
 *  - 暗転オーバーレイは掛けない（実機では文字がrgb(255,255,255)のまま = 一切暗くなっていない）
 *
 * 角丸は開閉に合わせてアニメーションさせる必要がない。閉じている間はコンテンツの角が端末の
 * 画面角とぴったり重なって見えないため、常に同じ半径を当てておけば足りる（半径が端末の実値と
 * 一致していることが前提なので `screenCornerRadius` で機種ごとの値を引く）。
 */
export function WsDrawerLayout({ children }: { children: ReactNode }) {
	const ref = useRef<DrawerLayoutMethods>(null);
	const { width } = useWindowDimensions();
	const [fullWidthSwipe, setFullWidthSwipe] = useState(false);
	// iPadの広い幅では同じ中身が常設サイドバー（ipadShell.tsx）として画面左に出ている。
	// スライド式ドロワーはそこでは二重表示になるため、開けないよう錠を掛ける。
	const regular = useIsRegularWidth();
	// **タブ以外の画面では開かせない。** ここは `Stack` ごと包んでいるので、錠を掛けないと
	// エージェント詳細などで左端スワイプがドロワーに取られ、標準の「戻る」が効かなくなる。
	// `useSegments()` の先頭がルートの区画。`/` は `['(tabs)', 'index']` になる。
	const rootSegment = useSegments()[0] as string | undefined;
	const onTabs = rootSegment === undefined || rootSegment === '(tabs)';
	const locked = regular || !onTabs;
	// `locked` を ref で読むのは、api の参照を安定させたまま最新値を見るため
	// （api が毎回変わると renderDrawer ごと作り直しになる）。
	const lockedRef = useRef(locked);
	lockedRef.current = locked;
	const api = useMemo<WsDrawerApi>(() => ({
		// 触覚フィードバックは開き切った/閉じ切った瞬間（onDrawerOpen/onDrawerClose）に鳴らす。
		// ここで鳴らすとスワイプで開いたときだけ無音になり、かつ「開き始め」に鳴って早すぎる。
		//
		// iPad幅では開かせない。`drawerLockMode` はスワイプしか止めず、命令的な
		// `openDrawer()` は素通ししてしまう（RNGHの実装が lock mode を見ていない）ため、
		// ここで塞ぐ。塞がないと、中身が null の見えないパネルが開いて操作を飲み込む。
		open: () => { if (!lockedRef.current) { ref.current?.openDrawer(); } },
		close: () => ref.current?.closeDrawer(),
		setFullWidthSwipe,
	}), []);
	// iPad幅では中身を描かない（＝常設サイドバーと二重にしない）。ただしドロワー自体は
	// 描画し続ける。ここで早期returnして`children`のツリー上の位置を変えると、幅がしきい値を
	// またぐたびにタブ配下が丸ごと作り直され、ターミナルのWebViewや入力途中の文字が消える。
	// **中身を描くかは `regular` だけで決める。** `locked` で null にすると、閉じる
	// アニメーションの途中（onClose→push の順で遷移する経路）や、開いたままタブ外へ
	// push したときに、左に見えているドロワーが空の板になる。
	const renderDrawer = useCallback(() => (regular ? null : <WsDrawerContent onClose={api.close} />), [api, regular]);

	// タブ外へ移ったら必ず閉じる。ここは `Stack` ごと包んでいるので、開いたまま push すると
	// **遷移先までドロワーぶん右にずれて描かれる**（コンテンツコンテナの中にいるため）。
	// 錠（`drawerLockMode`）はスワイプしか止めないので、閉じるのは自分でやる必要がある。
	//
	// **開いているときだけ閉じる。** RNGHの `closeDrawer()` には「既に閉じている」の判定が
	// 無く、無条件にばねを走らせて `onDrawerClose` まで呼ぶ。閉じたまま呼ぶと、タブ外へ出る
	// 操作の**すべてに余分な触覚が1発付く**（エージェントを開く・通知・設定…）。
	//
	// 「開き切った」ではなく「**開こうとしている**」で立てる。`onDrawerOpen` はばねが完走
	// （約200ms）してから呼ばれるので、その途中に遷移が入ると（通知の自動遷移など）
	// 閉じ損ねて、遷移先がドロワーぶん右にずれたまま出る。
	const openRef = useRef(false);
	const onDrawerStateChanged = useCallback((_state: DrawerState, willShow: boolean) => {
		openRef.current = willShow;
	}, []);
	useEffect(() => {
		if (locked && openRef.current) {
			ref.current?.closeDrawer();
		}
	}, [locked]);

	return (
		<WsDrawerContext.Provider value={api}>
			<ReanimatedDrawerLayout
				ref={ref}
				drawerWidth={Math.min(width * 0.82, 360)}
				drawerPosition={DrawerPosition.LEFT}
				// ドロワーは定位置で待ち、コンテンツがどくことで露出する。
				drawerType={DrawerType.BACK}
				// 実測どおり暗転させない。RNGHはoverlayをコンテンツの上に必ず1枚敷くため、
				// 無効化は透明色の指定で行う（overlayタップでの閉じる操作はこのままでも効く）。
				overlayColor="transparent"
				// コンテンツを載せるコンテナ自体を角丸にする（角丸の外側は下のドロワーが覗く）。
				contentContainerStyle={styles.contentContainer}
				// 通常は左端エッジのみでスワイプ開始を受け付ける（ターミナル/ブラウザWebViewの
				// 横操作との競合を最小化。認識はネイティブなので閾値未満のタップは阻害しない）。
				// ホームタブのフォーカス中のみ画面全域の右スワイプで開ける（X方式）。
				// iPad幅ではエッジ幅を0にし、錠も掛けて一切開かないようにする。
				edgeWidth={locked ? 0 : fullWidthSwipe ? width : 24}
				drawerLockMode={locked ? DrawerLockMode.LOCKED_CLOSED : DrawerLockMode.UNLOCKED}
				renderNavigationView={renderDrawer}
				onDrawerStateChanged={onDrawerStateChanged}
				onDrawerOpen={onDrawerSettled}
				onDrawerClose={onDrawerSettled}
			>
				{children}
			</ReanimatedDrawerLayout>
		</WsDrawerContext.Provider>
	);
}

/** 開き切った/閉じ切った瞬間の触覚フィードバック（スワイプ・タップのどちらで操作しても鳴る）。 */
function onDrawerSettled() {
	hapticImpact('light');
}

/** 逼迫の度合いを色へ。平常時は控えめな既定色のままにして、視線を奪わない。 */
function resourceColor(level: UsageLevel, normal: string): string {
	return level === 'critical' ? colors.red : level === 'warn' ? colors.yellow : normal;
}

/**
 * PCカード内のCPU/メモリ/ディスクの3連ミニゲージ（バッテリーと同じ「PCの体調」の枠）。
 * 平常時は数字が並ぶだけで、閾値を超えたときだけ色と一言が出る。タップで「システム」画面へ。
 */
function PcResourceRow({ resources, onPress }: { resources: DesktopResources; onPress: () => void }) {
	const memoryPercent = usagePercent(resources.memUsed, resources.memTotal);
	const { diskTotal, diskFree } = resources;
	const hasDisk = diskTotal !== undefined && diskFree !== undefined;
	const diskPercent = hasDisk ? usagePercent(diskTotal - diskFree, diskTotal) : undefined;
	const cpuLevel = usageLevel(resources.cpu ?? 0, CPU_THRESHOLDS);
	const memoryLevel = usageLevel(memoryPercent, MEMORY_THRESHOLDS);
	const volumeLevel: UsageLevel = hasDisk ? diskLevel(diskTotal, diskFree) : 'normal';

	const items: { label: string; value: string; percent: number; color: string }[] = [
		{ label: 'CPU', value: formatCpu(resources.cpu), percent: resources.cpu ?? 0, color: resourceColor(cpuLevel, colors.accent) },
		{ label: 'RAM', value: `${Math.round(memoryPercent)}%`, percent: memoryPercent, color: resourceColor(memoryLevel, colors.textDim) },
	];
	if (diskPercent !== undefined) {
		items.push({ label: 'SSD', value: `${Math.round(diskPercent)}%`, percent: diskPercent, color: resourceColor(volumeLevel, colors.textDim) });
	}

	return (
		<>
			{/* 逼迫は**数値とバーの色だけ**で示し、面には色を乗せない。
			    暗いガラスに薄い赤（tintOpacity 0.14）を混ぜると、赤にも灰色にもならない
			    中間の濁り（茶色い板）になって、警告として読めなくなる。色の面積が小さいほど
			    彩度はそのまま出るので、98%の赤字のほうが面を染めるより強く目に入る。
			    tintColor はApple的には「押せて、いま重要」を示す前面性の記号で、
			    読む情報である数値の行に当てるものではない。 */}
			<GlassSurface style={styles.resourceRow} interactive>
				<Pressable
					style={styles.resourceHit}
					onPress={onPress}
					accessibilityLabel="PCのリソースを見る"
				>
					{items.map(item => (
						<View key={item.label} style={styles.resourceItem}>
							<View style={styles.resourceHead}>
								<Text style={styles.resourceLabel}>{item.label}</Text>
								<Text style={[styles.resourceValue, { color: item.color }]}>{item.value}</Text>
							</View>
							<View style={styles.resourceTrack}>
								<View style={[styles.resourceFill, { width: `${Math.max(2, Math.min(100, item.percent))}%`, backgroundColor: item.color }]} />
							</View>
						</View>
					))}
					{/* 山形も赤にしない。数値・バーに続く3つ目の赤になると、
					    「この行そのものがエラー」と読まれる。実際には RAM が98%という
					    事実の表示であって、行が壊れているわけではない。 */}
					<Ionicons name="chevron-forward" size={13} color={colors.textDim} style={styles.resourceChevron} />
				</Pressable>
			</GlassSurface>
			{/* 見出し文（「メモリが逼迫しています」等）は出さない。逼迫は数値とバーの色が
			    既に伝えており、文まで足すと1行ぶん場所を取るだけになる。 */}
		</>
	);
}

/**
 * ドロワーの中身。ReanimatedDrawerLayoutのrenderNavigationViewから描画される。
 *
 * iPadの広い幅では同じ中身を常設サイドバーとしても使う（`ipadSidebar.tsx`）。そちらは
 * 閉じる操作を持たないため `onClose` にno-opを渡し、下部タブの代わりになるセグメントを
 * `navigation` として差し込む。中身を作り分けないのは、PCステータス・ワークスペース一覧・
 * メモ・接続管理といった実装をiPhone版と1つに保つため。
 *
 * `navigation` を接続管理（切断・ペアリング解除）より**上**へ置くのは、主要な移動手段が
 * 破壊的な操作の下に来ないようにするため。
 */
export function WsDrawerContent({ onClose, navigation }: { onClose: () => void; navigation?: ReactNode }) {
	const insets = useStableInsets();
	const router = useRouter();
	const pathname = usePathname();
	const {
		workspace, selectedWs, setSelectedWs, homeShowAllWorkspaces, setHomeShowAllWorkspaces, connection, pcOnline, sessionProtocolReady,
		disconnectRelay, connectRelay, removePc, pcs, activePcId,
	} = useAppStore(useShallow(s => ({
		workspace: s.workspace, selectedWs: s.selectedWs, setSelectedWs: s.setSelectedWs,
		homeShowAllWorkspaces: s.homeShowAllWorkspaces, setHomeShowAllWorkspaces: s.setHomeShowAllWorkspaces,
		connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady,
		disconnectRelay: s.disconnectRelay, connectRelay: s.connectRelay, removePc: s.removePc,
		pcs: s.pcs, activePcId: s.activePcId,
	})));

	// PC切り替え（iPhoneはシート、iPadはこの位置にぶら下がるポップオーバー）の表示位置。
	// undefined の間は閉じている。
	const [switcherAnchor, setSwitcherAnchor] = useState<{ x: number; y: number } | undefined>(undefined);

	const list: WsEntry[] = workspace?.workspaces ?? [];
	const terminals = workspace?.terminals ?? [];
	const effective = selectedWs !== undefined && list.some(w => w.id === selectedWs) ? selectedWs : list[0]?.id;
	const waitingTotal = terminals.filter(t => isAgentWaiting(t.agentStatus)).length;
	const online = connection === 'online' && pcOnline && sessionProtocolReady;
	// PC本体（マシン全体）のCPU/メモリ/ディスク（旧PCでは未配信）。バッテリーと同じ「PCの体調」
	// としてこのカードに並べる。内訳（何が使っているか）は行タップで開く「システム」画面が持つ。
	const resources = workspace?.resources;

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

	/**
	 * スペースを変えたらホームへ戻す。
	 *
	 * ターミナル・ソース管理・ファイルの各タブは、いま選んでいるスペースの中身を映している。
	 * 切り替えたのにそこへ留まると、前のスペースの文脈で開いていたファイルや差分だけが残り、
	 * どちらの話を見ているのか分からなくなる。設定やダッシュボード類は対象外
	 * （判定は `shouldReturnHomeOnSpaceChange`）。
	 *
	 * スタック画面（エージェント詳細など）を開いている間に `navigate` すると、React Navigationは
	 * 既存の `(tabs)` へ戻さずもう1枚積んでしまうため、畳める場合は `dismissTo` を使う
	 * （iPadサイドバーのタブ切り替えと同じ作法）。
	 */
	const returnHome = () => {
		if (!shouldReturnHomeOnSpaceChange(pathname)) {
			return;
		}
		if (router.canDismiss()) {
			router.dismissTo('/');
			return;
		}
		router.navigate('/');
	};

	const select = (id: string) => {
		hapticSelection();
		setSelectedWs(id);
		setHomeShowAllWorkspaces(false);
		returnHome();
		onClose();
	};

	/** ワークスペース一覧上部の「すべて表示」。ホームの絞り込みを解除する（他タブのselectedWsは変えない）。 */
	const selectAll = () => {
		hapticSelection();
		setHomeShowAllWorkspaces(true);
		returnHome();
		onClose();
	};

	// ws未タグのターミナルは他画面と同様にPC側アクティブワークスペース所属として数える
	const wsTerminalsOf = (id: string) => terminals.filter(t => (t.ws ?? workspace?.activeWs) === id);

	/**
	 * ワークスペース1行。child=worktree行（インデント＋ガイド線）、childCount>0=グループ親行
	 * （ワークツリー数＋開閉シェブロン付き。折りたたみ中はaggWaiting/aggRunningで配下の
	 * 応答待ち・実行中を集約表示し、閉じていても見落とさないようにする）。
	 */
	const renderRow = (ws: WsEntry, opts: { child?: boolean; childCount?: number; open?: boolean; aggWaiting?: number; aggRunning?: number; kept?: boolean } = {}) => {
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
		// 選択中は行の地色をワークスペース色でうっすら染める。ここは**要素の型をswitchしない**
		// （active ? <GlassSurface> : <Pressable> のように型そのものを切り替えると、選択が
		// 移るたびに対象行がReactツリー上でunmount→mountされる。CLAUDE.md「条件分岐でReact
		// ツリーの形を変えない」に抵触するため、常に同じPressableのままstyleだけを変える）。
		// ワークスペースは多いとScrollView内に数十行並ぶため、選択行だけでも毎回ネイティブの
		// GlassSurfaceへ差し替えることはしない（UIVisualEffectView量産を避ける）。
		const activeTint = withAlpha(color, 0.16) ?? colors.accentWash;
		const content = (
			<>
				{active && !opts.child ? <View style={[styles.rowIndicator, { backgroundColor: color }]} /> : null}
				{opts.child ? <View style={[styles.wtGuide, (active || opts.kept) && styles.wtGuideActive]} /> : null}
				<View style={[styles.avatar, opts.child && styles.wtAvatar, { backgroundColor: withAlpha(color, 0.13) ?? colors.surface2 }]}>
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
				{/* PC側でピン留めされた印。折りたたんでも残る理由がひと目で分かるようにする
				    （留め外しはPC側の Workspaces ビューで行う） */}
				{ws.pinned ? <Ionicons name="pin" size={11} color={colors.accent} /> : null}
				{waiting > 0 ? (
					<View style={styles.alertBadge}><Text style={styles.alertBadgeText}>{waiting > 1 ? `質問あり ${waiting}` : '質問あり'}</Text></View>
				) : null}
				{/* メモ（PC版 Workspaces ビュー下部のメモ欄と同じ本文）。未完了があれば件数を出す。
				    **押したら必ずドロワーを閉じてから開く。** 以前は Link.AppleZoom のズーム遷移を
				    成立させるため閉じずに push していたが、ヘッダー層の導入でドロワーが `Stack` ごと
				    包む形になったため、開いたまま push すると遷移先がドロワーぶん右へずれて描かれる。
				    ここはズームより「ずれない」を採る。 */}
				<Pressable
					style={[styles.noteBtn, (ws.note?.open ?? 0) > 0 && styles.noteBtnActive]}
					hitSlop={6}
					onPress={() => {
						hapticSelection();
						onClose();
						router.push({ pathname: '/space-note', params: { ws: ws.id } });
					}}
					accessibilityRole="button"
					accessibilityLabel={(ws.note?.open ?? 0) > 0 ? `メモ（未完了 ${ws.note?.open} 件）` : 'メモ'}
				>
					<Ionicons name="checkbox-outline" size={12} color={(ws.note?.open ?? 0) > 0 ? colors.accent : colors.textDim} />
					{(ws.note?.open ?? 0) > 0 ? <Text style={styles.noteBtnText}>{ws.note?.open}</Text> : null}
				</Pressable>
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
			</>
		);
		return (
			<Pressable
				key={ws.id}
				style={[styles.row, opts.child && styles.wtRow, opts.kept && styles.wtRowKept, active && { backgroundColor: activeTint }]}
				onPress={() => select(ws.id)}
			>
				{content}
			</Pressable>
		);
	};

	const confirmUnpair = () => {
		if (activePcId === undefined) {
			return;
		}
		const name = pcs.find(pc => pc.id === activePcId)?.name ?? 'このPC';
		hapticWarning();
		Alert.alert(
			'ペアリング解除',
			// 解除は「いま見ているPC」だけ。他のPCとのペアリングはそのまま残る。
			`${name} とのペアリング情報を削除します。再接続にはPC側でQRコードを再発行してのペアリングが必要です。`,
			[
				{ text: 'キャンセル', style: 'cancel' },
				{
					text: '解除する', style: 'destructive', onPress: () => {
						void removePc(activePcId).catch(error => Alert.alert('ペアリングを解除できませんでした', error instanceof Error ? error.message : String(error)));
					},
				},
			],
		);
	};

	return (
		<View style={[styles.drawer, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 }]}>
			{/* 接続中PCのカード。押すとペアリング済みPCの切り替えを開く */}
			<View style={styles.pcSection}>
				<PcCardHeader
					onOpen={anchor => setSwitcherAnchor(anchor)}
					onOpenSettings={() => { onClose(); router.push('/settings'); }}
				/>
				<PcSwitcher
					visible={switcherAnchor !== undefined}
					anchor={switcherAnchor}
					onClose={() => setSwitcherAnchor(undefined)}
				/>
				{/* 統計の3枚は**ガラスにしない**。数を読むだけで押せない面であり、
				    ここは背後に透けるものが無い（ドロワーの不透明な地の上）ので、
				    ガラスを敷いても屈折する対象が無く素材のベース明度だけが残る
				    ＝同じ明度の灰色の板が3つ並ぶ。ガラスはこのドロワーでは
				    「押せるもの」（PCカード・歯車・CPU行・スペース作成・フッター）の
				    目印として使い、読むだけの面は不透明にして引かせる。 */}
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
				{/* PC本体のCPU/メモリ/ディスク。接続中でPCが配信している場合だけ出す
				    （切断中に古い数字を残すと「今のPCの状態」に見えてしまう）。 */}
				{online && resources !== undefined ? (
					<PcResourceRow
						resources={resources}
						onPress={() => { hapticSelection(); onClose(); router.push('/system'); }}
					/>
				) : null}
			</View>

			<View style={styles.sectionHead}>
				<Text style={styles.sectionTitle}>ワークスペース</Text>
				{/* PC版の「スペース名右の＋」に対応する、新しいスペース（worktree）作成の入口。
				    箱自体を当たり判定ぶんの大きさにする（GlassViewはhitTestを上書きしないため、
				    内側Pressableのhitslopは箱の外側では効かない）。無効時はガラスにopacityを
				    当てず、アイコンの色だけ落とす（素材にopacityを当てると効果ごと薄まって見える）。 */}
				<GlassSurface style={styles.addSpaceBtn} interactive={online}>
					<Pressable
						disabled={!online}
						style={styles.addSpaceHit}
						onPress={() => { hapticSelection(); setCreateSheetOpen(true); }}
						accessibilityLabel="新しいスペースを作成"
						accessibilityState={{ disabled: !online }}
					>
						<Ionicons name="add" size={15} color={online ? colors.text : colors.textDim} />
					</Pressable>
				</GlassSurface>
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
					// 折りたたみ中もピン留めされたスペースは残す（PC版 Workspaces ビューと同じ挙動）
					const shown = open ? children : children.filter(c => c.pinned);
					// 折りたたみ中は配下の応答待ち/実行中を親行に集約表示する。残して見せている
					// ピン留め行のぶんは、その行自体が出しているので二重に数えない
					const hidden = open ? [] : children.filter(c => !c.pinned);
					const aggWaiting = hidden.reduce((n, c) => n + wsTerminalsOf(c.id).filter(t => isAgentWaiting(t.agentStatus)).length, 0);
					const aggRunning = hidden.reduce((n, c) => n + wsTerminalsOf(c.id).filter(t => t.agentStatus === 'working').length, 0);
					return (
						<View key={repo.id}>
							{renderRow(repo, { childCount: children.length, open, aggWaiting, aggRunning })}
							{shown.map(c => renderRow(c, { child: true, kept: !open }))}
						</View>
					);
				})}
				{orphans.map(ws => renderRow(ws))}
				{list.length === 0 ? (
					<Text style={styles.dim}>ワークスペース情報を取得中… PCの Para Code でリポジトリを登録すると表示されます。</Text>
				) : null}
			</ScrollView>

			{navigation}

			{/* 接続管理（旧ホームカードのボタン群から移設） */}
			<View style={styles.footer}>
				{connection === 'online' ? (
					<GlassSurface style={styles.footerBtn} interactive>
						<Pressable style={styles.footerBtnHit} onPress={() => { hapticImpact('light'); disconnectRelay(); }} accessibilityLabel="切断">
							<Ionicons name="power-outline" size={13} color={colors.red} />
							<Text style={[styles.footerBtnText, { color: colors.red }]}>切断</Text>
						</Pressable>
					</GlassSurface>
				) : (
					<GlassSurface style={styles.footerBtn} interactive>
						<Pressable style={styles.footerBtnHit} onPress={() => { hapticImpact('light'); connectRelay(); }} accessibilityLabel="接続">
							<Ionicons name="power-outline" size={13} color={colors.green} />
							<Text style={[styles.footerBtnText, { color: colors.green }]}>接続</Text>
						</Pressable>
					</GlassSurface>
				)}
				<GlassSurface style={styles.footerBtn} interactive>
					<Pressable style={styles.footerBtnHit} onPress={confirmUnpair} accessibilityLabel="ペアリング解除">
						<Ionicons name="trash-outline" size={13} color={colors.textDim} />
						<Text style={styles.footerBtnText}>ペアリング解除</Text>
					</Pressable>
				</GlassSurface>
			</View>
			<WorktreeCreateSheet visible={createSheetOpen} onClose={() => setCreateSheetOpen(false)} />
		</View>
	);
}

/**
 * 画面のどこからでも右へスワイプしてドロワーを開くジェスチャ。タブ画面のルートに巻く。
 *
 * RNGH自身の全幅スワイプ（`edgeWidth={width}` / {@link WsDrawerApi.setFullWidthSwipe}）は使わない。
 * あちらは**向きを問わず指が動いた最初の1pxで発動する**ため、縦スクロールも行の横スワイプも
 * まとめて潰れる。ここでは右へ24pt動いたときだけ発動し、縦へ16pt動いたら諦める。
 *
 * 横スクロールを持つ画面（ターミナルのタブチップ列）やWebViewを敷く画面には巻かないこと。
 * 指の動きの向きが同じで、どちらが取るかが状況で変わる。
 */
export function useOpenDrawerPan(): PanGesture {
	const drawer = useWsDrawer();
	const regular = useIsRegularWidth();
	return useMemo(() => Gesture.Pan()
		.runOnJS(true)
		.enabled(!regular)
		.activeOffsetX(24)
		.failOffsetY([-16, 16])
		.onStart(() => drawer.open()), [drawer, regular]);
}

/**
 * タブ画面のヘッダー。**中身は描かず、常設のヘッダー層へ仕様を登録するだけ**（`src/paraHeader.ts`）。
 *
 * **コンポーネントではなくフックにしてある。** 以前 `<WsHeader />` として `ConnectionGate` の
 * 子に置いていたら、ゲートが閉じた瞬間（未接続のPCへ切り替えた・プロトコルエラー）に登録者ごと
 * アンマウントされ、**切り替える前のスペースの島が「接続しています…」の上に残り続けた**。
 * フックなら画面本体で走るので、ゲートの内外に関係なく必ず登録される。
 *
 * 島に出すのは「いまどのスペースのどのブランチを見ているか」だけで、画面名（ホーム・
 * ターミナル…）は出さない。同じ名前が下のタブバーにあり二重になるうえ、リポジトリの
 * 誤認はエージェントが走っている状態では実害があるので、常時見せる価値はこちらが高い。
 *
 * 押すとドロワーが開くが、シェブロンは付けない（押せることは `isInteractive` の光で返す）。
 * ホーム以外の3タブではこれがドロワーへの唯一の可視の入口になる（スワイプは
 * `useOpenDrawerPan` が全タブで受ける）。
 *
 * **本文の `paddingTop` は `useParaHeaderHeight()` から取ること**。高さは subtitle の有無・
 * 帯の有無・Dynamic Type で変わるため定数では足りない。
 */
export function useWsHeader({ subtitle, actions, mid, below, allWorkspaces, wide = false }: {
	/** 島のサブ行を差し替える（既定はブランチ名。切断中は自動でその状態に差し替わる）。 */
	subtitle?: string;
	/** 右のピルに並べるボタン（1〜4個）。器（ガラスのピル）は層が持つ。 */
	actions?: readonly ParaHeaderIcon[];
	/** スペースの島と右のピルの間に伸びる島（ターミナルタブの「ターミナル名 ▾」）。 */
	mid?: ParaHeaderSpec['mid'];
	/**
	 * 島の下に続けて浮かせる帯（ホームの絞り込みチップ、ターミナルのタブチップ、
	 * ファイルの検索欄）。ここに置いたものは本文と一緒にスクロールせず、
	 * `useParaHeaderHeight()` の実測にも含まれる。
	 */
	below?: ReactNode;
	allWorkspaces?: boolean;
	/**
	 * 本文が読み幅の列に収まらず画面いっぱいを使う画面（ホームの2列など）で true。
	 * ヘッダーだけ列幅に切ると、広いiPadで右上のボタンが本文の右端より100pt以上内側に出る。
	 */
	wide?: boolean;
}) {
	const drawer = useWsDrawer();
	// iPadの広い幅ではワークスペース一覧が常設サイドバーに出ている。島は「開く」ボタンとしては
	// 不要になるが、いま見ているスペースの色・名前・応答待ちバッジを一目で確認できる価値は
	// 残るため、消さずに表示だけ続ける（押せなくするのは下の disabled）。
	const regular = useIsRegularWidth();
	// **画面が中身を出していない間は層も伏せる。** 未ペアリングのときは
	// `PairingRequiredNotice` しか出ていないので、そこにヘッダーを重ねると名前「—」・
	// サブ行「再接続中 — 最後の画面」という**一度も繋いだことがない端末への嘘**が出るうえ、
	// 島（空のドロワー）・ベル・＋がどれも空振りで押せてしまう。
	// 判断は `useConnectionGateBlocked()` に任せる（条件を書き写すとずれる）。
	const gated = useConnectionGateBlocked();
	const { workspace } = useAppStore(useShallow(s => ({ workspace: s.workspace })));
	const current = useEffectiveWs();

	// 他ワークスペースの応答待ち件数（島の左上の赤い点 = ドロワーを開く動機づけ）。
	// ws未タグのターミナルは他画面と同様にPC側アクティブワークスペース所属として数える。
	// allWorkspaces中はすでに全件が見えているため「他」の概念が無く、点は出さない。
	const otherWaiting = allWorkspaces ? 0 : (workspace?.terminals ?? []).filter(t =>
		isAgentWaiting(t.agentStatus) && (t.ws ?? workspace?.activeWs) !== current?.id).length;

	// 繋がっていないあいだは、島のサブ行をその状態に差し替える。**別の部品は出さない**
	// （上端のカプセルで出すとナビの場所を直るまで覆い、いまどのリポジトリを見ているかが
	// 見えなくなる。オフライン中はまさに誤認が実害になるときなので、覆うのは筋が悪い）。
	const offline = useOfflineNotice();
	const chipColor = offline !== undefined ? offline.color
		: allWorkspaces ? colors.textDim : (current ? wsColor(current) : colors.accent);
	const name = allWorkspaces ? 'すべてのスペース' : (current?.name ?? '—');
	const sub = offline?.text ?? subtitle ?? (allWorkspaces ? undefined : current?.branch);
	const drawerOpen = drawer.open;

	const spec = useMemo<ParaHeaderSpec>(() => ({
		left: {
			kind: 'island',
			// iPadでは常設サイドバーに同じ一覧がすでに出ているため、押しても開かない
			// （WsDrawerLayout.open()自体がregular幅ではno-op）。
			onPress: regular ? undefined : drawerOpen,
			disabled: regular,
			label: regular
				? (sub ? `スペース ${name}、${sub}` : `スペース ${name}`)
				: offline !== undefined ? `スペース ${name}。${offline.text}。切り替える`
					: (otherWaiting > 0 ? `スペース ${name}。他のスペースに応答待ちがあります。切り替える` : `スペース ${name}。切り替える`),
			...(allWorkspaces ? { avatarIcon: 'apps-outline' as const } : { avatarText: current ? current.name.charAt(0).toUpperCase() : '—' }),
			color: chipColor,
			// ガラスへの色被せはスペースの固有色があるときだけ。「すべてのスペース」の
			// textDim（グレー）や切断中の橙を被せると島だけ浮き、右のピルと揃わない。
			tint: offline !== undefined || allWorkspaces ? undefined : chipColor,
			name,
			sub,
			subColor: offline?.color,
			badge: otherWaiting > 0,
		},
		mid,
		...(actions !== undefined && actions.length > 0 ? { rightA: { kind: 'icons' as const, items: actions } } : {}),
		band: below,
		wide,
	}), [regular, drawerOpen, sub, name, offline, otherWaiting, allWorkspaces, current, chipColor, actions, mid, below, wide]);
	// フックは**無条件に呼ぶ**（分岐で本数が変わると React が落ちる）。伏せるのは中身だけ。
	useParaHeader(gated ? PARA_HEADER_HIDDEN : spec);
}

const styles = StyleSheet.create({

	// ドロワーを開いたときに右へどくコンテンツ。角丸は端末のディスプレイ角丸に合わせ、
	// borderCurve: 'continuous' でiOSの連続曲線（cornerCurve = .continuous）にする
	// （単純な円弧だと閉じているときに実機の画面角と曲率が合わず、隅に隙間が見える）。
	contentContainer: {
		borderRadius: screenCornerRadius, overflow: 'hidden',
		backgroundColor: colors.bg, borderCurve: 'continuous',
	},

	// ドロワー
	drawer: {
		flex: 1, backgroundColor: '#0e0e11',
		borderRightWidth: 1, borderRightColor: colors.borderStrong,
	},
	// PCカード（接続状態・バッテリー・切り替え）は pcSwitcher.tsx が描く。ここは器だけを持つ。
	pcSection: { paddingHorizontal: 18, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
	statsRow: { flexDirection: 'row', gap: 6, marginTop: 12 },
	// ガラスをやめたぶん、面は自分で持つ（surface2＋ヘアライン）。
	stat: {
		flex: 1, borderRadius: radius.control, ...squircle, paddingVertical: 7, alignItems: 'center',
		backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
	},
	statValue: { color: colors.accent, fontSize: 15, fontWeight: '700' },
	statValueAlert: { color: colors.red },
	statLabel: { color: colors.textDim, fontSize: 9.5, marginTop: 1 },
	resourceRow: { marginTop: 8, borderRadius: 11, ...squircle },
	resourceHit: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, paddingHorizontal: 10 },
	resourceItem: { flex: 1, gap: 5 },
	resourceHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 4 },
	resourceLabel: { color: colors.textDim, fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4 },
	resourceValue: { fontSize: 11, fontWeight: '800' },
	resourceTrack: { height: 3, borderRadius: 2, backgroundColor: colors.surface3, overflow: 'hidden' },
	resourceFill: { height: 3, borderRadius: 2 },
	resourceChevron: { marginLeft: 2 },
	// **余白は行が持つ。** 以前は見出しの文字が `paddingTop/Bottom` で余白を抱えていたため、
	// 行の高さが「文字（36.5pt） vs ＋（36+marginTop:2＝38pt）」の背比べで決まり、背の高い
	// ＋の下端が行の下端＝一覧の1行目の上端とぴったり同じになっていた（選択中の「すべて表示」
	// は面が出るので、札に貼り付いて見えた）。行に paddingBottom を持たせて縁を切る。
	sectionHead: {
		flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
		paddingLeft: 18, paddingRight: 16, paddingTop: 16, paddingBottom: 10,
	},
	sectionTitle: { color: colors.textDim, fontSize: 10.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
	// 10.5ptの小さな見出しに36ptのボタンは大きすぎる。30ptへ落として行の主役を見出しに戻す。
	addSpaceBtn: { width: 30, height: 30, borderRadius: 10, ...squircle },
	addSpaceHit: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	list: { flex: 1 },
	listContent: { paddingHorizontal: 10, paddingBottom: 8 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, paddingHorizontal: 10, borderRadius: 12, ...squircle, marginBottom: 2 },
	rowActive: { backgroundColor: colors.accentWash },
	rowIndicator: { position: 'absolute', left: 0, top: 10, bottom: 10, width: 3, borderRadius: 2, backgroundColor: colors.accent },
	// 「すべて表示」行: 通常のワークスペース行とアイコン以外は共通のスタイルを流用する
	allRow: { marginBottom: 8 },
	allIcon: { backgroundColor: colors.surface2 },
	allSub: { color: colors.textDim, fontSize: 10.5, marginTop: 2 },
	avatar: { width: 36, height: 36, borderRadius: 10, ...squircle, alignItems: 'center', justifyContent: 'center' },
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
	noteBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
	noteBtnActive: { backgroundColor: 'rgba(9,175,217,0.14)' },
	noteBtnText: { color: colors.accent, fontSize: 10, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	// ワークツリー（グループ子行）: インデント＋左端の縦ガイド線で親子関係を示す
	wtRow: { marginLeft: 27, paddingLeft: 14, paddingVertical: 9 },
	// 折りたたみ中もピン留めで残している行（閉じたグループにぶら下がっていることを薄い地色で示す）
	wtRowKept: { backgroundColor: 'rgba(9,175,217,0.05)' },
	wtGuide: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 1.5, borderRadius: 1, backgroundColor: colors.borderStrong },
	wtGuideActive: { backgroundColor: colors.accent },
	wtAvatar: { width: 26, height: 26, borderRadius: 8, ...squircle },
	wtAvatarText: { fontSize: 11 },
	wtName: { fontSize: 12.5 },
	// グループ親行: ワークツリー数バッジ＋開閉シェブロン（行本体タップ=選択と分離した独立ヒット領域）
	wtCount: { color: colors.textDim, fontSize: 10, backgroundColor: colors.surface3, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	twistBtn: { width: 30, height: 30, borderRadius: 8, ...squircle, alignItems: 'center', justifyContent: 'center', marginVertical: -6, marginRight: -4 },
	dim: { color: colors.textDim, fontSize: 12, paddingHorizontal: 8, lineHeight: 18 },
	footer: { flexDirection: 'row', gap: 8, paddingHorizontal: 18, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
	footerBtn: { flex: 1, borderRadius: radius.control, ...squircle },
	footerBtnHit: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9 },
	footerBtnText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
});
