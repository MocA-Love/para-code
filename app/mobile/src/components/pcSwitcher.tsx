// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { BackHandler, Dimensions, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, type PcSummary } from '../appState.js';
import { BatteryGauge } from './batteryGauge.js';
import { BottomSheet, useSheetCloseThen } from './bottomSheet.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { GlassSurface } from './glassSurface.js';
import { OverlayPortal, PopIn } from './overlayHost.js';
import { HIT_SIZE, alpha, colors, radius, squircle, tint, type, status } from '../theme.js';
import { monoFamily } from '../monoFont.js';
import { Badge } from './badge.js';
import { SectionHeader } from './sectionHeader.js';
import { hapticSelection } from '../haptics.js';
import { useNow } from '../time.js';

/**
 * ペアリング済みPCの切り替え。
 *
 * iPhone（狭い幅）ではドロワーのPCカードから立ち上がるボトムシート、iPad（広い幅）では
 * サイドバーのPCカードにぶら下がるポップオーバーとして出す。中身はどちらも同じ行部品で、
 * 「いま繋いでいるPC」「待機中の他のPC」「オフラインのPC」を同じ形で並べる。
 *
 * PCが1台しかない場合も出す（「新しいPCとペアリング」への入口を兼ねるため）。
 */

const POPOVER_WIDTH = 288;

/** 一覧に出す状態表示。接続を保っているPCは「待機中」＝いつでも切り替えられる。 */
function pcStateLabel(pc: PcSummary, active: boolean): { text: string; tone: 'live' | 'dim' | 'warn' } {
	if (pc.connection === 'online' && pc.pcOnline) {
		return active ? { text: '● 接続中', tone: 'live' } : { text: '● 待機中', tone: 'live' };
	}
	if (pc.connection === 'online' || pc.connection === 'handshaking') {
		return { text: '○ PCオフライン', tone: 'dim' };
	}
	if (pc.connection === 'connecting') {
		return { text: '◐ 接続しています…', tone: 'warn' };
	}
	return { text: '○ オフライン', tone: 'dim' };
}

function lastSeenLabel(at: number | undefined, now: number): string | undefined {
	if (at === undefined) {
		return undefined;
	}
	const minutes = Math.floor((now - at) / 60_000);
	if (minutes < 1) {
		return 'たった今まで接続';
	}
	if (minutes < 60) {
		return `${minutes}分前まで接続`;
	}
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}時間前まで接続` : `${Math.floor(hours / 24)}日前まで接続`;
}

/**
 * PCのアイコン（頭文字）。色はPCの長期公開鍵から決まる固定値（`PcSummary.hue`）で、
 * 一覧の並び順では変わらない。同じ名前を名乗るPCがあっても色で見分けられる。
 */
export const PC_PALETTE = [colors.accent, colors.purple, colors.green, colors.orange, colors.yellow, colors.red] as const;

export function pcColor(hue: number): (typeof PC_PALETTE)[number] {
	return PC_PALETTE[hue % PC_PALETTE.length] ?? colors.accent;
}

export function PcAvatar({ name, hue, size = 40 }: { name: string; hue: number; size?: number }) {
	const color = pcColor(hue);
	return (
		<View style={[styles.avatar, { width: size, height: size, borderRadius: size * 0.29, backgroundColor: tint(color, alpha.wash), borderColor: tint(color, alpha.line) }]}>
			{/* 頭文字はアイコンの大きさに比例させる（文字サイズの段ではなく枠から決める）。 */}
			<Text style={[styles.avatarText, { color, fontSize: size * 0.38 }]}>{name.trim().charAt(0).toUpperCase() || 'P'}</Text>
		</View>
	);
}

function PcRow({ pc, active, now, onPress }: { pc: PcSummary; active: boolean; /** 「〇分前まで接続」をシート表示中も経時で進めるための現在時刻。 */ now: number; onPress: () => void }) {
	const state = pcStateLabel(pc, active);
	const lastSeen = state.tone === 'dim' && pc.connection !== 'online' ? lastSeenLabel(pc.lastOnlineAt, now) : undefined;
	return (
		<Pressable
			style={[styles.row, active && styles.rowActive]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityState={{ selected: active }}
			accessibilityLabel={`${pc.name}へ切り替え`}
		>
			<PcAvatar name={pc.name} hue={pc.hue} size={38} />
			<View style={styles.rowBody}>
				<Text style={[styles.rowName, active && styles.rowNameActive]} numberOfLines={1}>{pc.name}</Text>
				<View style={styles.rowMeta}>
					<Text style={[styles.rowState, state.tone === 'live' && styles.rowStateLive, state.tone === 'warn' && styles.rowStateWarn]} numberOfLines={1}>
						{state.text}
					</Text>
					{pc.connection === 'online' && pc.pcOnline ? (
						<>
							<Text style={styles.sep}>・</Text>
							<Text style={styles.rowSub} numberOfLines={1}>{`ワークスペース ${pc.workspaces}`}</Text>
						</>
					) : null}
					{lastSeen !== undefined ? (
						<>
							<Text style={styles.sep}>・</Text>
							<Text style={styles.rowSub} numberOfLines={1}>{lastSeen}</Text>
						</>
					) : null}
				</View>
			</View>
			{pc.waiting > 0 && !active ? (
				<Badge label={`${status.attention.label} ${pc.waiting}`} tone="red" style={styles.badge} />
			) : null}
			{active ? <Ionicons name="checkmark" size={17} color={colors.accent} /> : null}
		</Pressable>
	);
}

function PcList({ onClose, closeThen }: { onClose: () => void; /** 遷移を伴う閉じ方（シート経路は暗幕が残るため遅延する。ポップオーバー経路は即時）。 */ closeThen: (go: () => void) => void }) {
	const router = useRouter();
	const { pcs, activePcId, switchPc } = useAppStore(useShallow(s => ({
		pcs: s.pcs, activePcId: s.activePcId, switchPc: s.switchPc,
	})));
	// 「〇分前まで接続」をシート表示中も経時で進める（Date.now() を描画時のみ評価していたため、
	// 開いたままのシートでは表示が凍結していた）。
	const now = useNow();

	const select = (id: string) => {
		if (id === activePcId) {
			onClose();
			return;
		}
		hapticSelection();
		switchPc(id);
		onClose();
	};

	return (
		<>
			{pcs.map(pc => (
				<PcRow key={pc.id} pc={pc} active={pc.id === activePcId} now={now} onPress={() => select(pc.id)} />
			))}
			<View style={styles.divider} />
			<Pressable
				style={styles.row}
				onPress={() => { hapticSelection(); closeThen(() => router.push('/pair')); }}
				accessibilityLabel="新しいPCとペアリング"
			>
				<View style={[styles.avatar, styles.addAvatar]}>
					<Ionicons name="add" size={19} color={colors.textDim} />
				</View>
				<View style={styles.rowBody}>
					<Text style={styles.addLabel}>新しいPCとペアリング</Text>
				</View>
			</Pressable>
			<Pressable
				style={styles.row}
				onPress={() => { hapticSelection(); closeThen(() => router.push('/settings')); }}
				accessibilityLabel="PCの管理"
			>
				<View style={[styles.avatar, styles.addAvatar]}>
					<Ionicons name="settings-outline" size={17} color={colors.textDim} />
				</View>
				<View style={styles.rowBody}>
					<Text style={styles.addLabel}>PCの管理</Text>
				</View>
			</Pressable>
		</>
	);
}

/**
 * PC切り替えの本体。`anchor` はiPad（広い幅）でポップオーバーをぶら下げる位置。
 * 渡されない・狭い幅ではボトムシートとして出す。
 */
export function PcSwitcher({ visible, anchor, onClose }: {
	visible: boolean;
	anchor?: { x: number; y: number };
	onClose: () => void;
}) {
	const regular = useIsRegularWidth();
	const insets = useStableInsets();
	const inSheet = !(regular && anchor !== undefined);
	// シート（iPhone）は暗幕が閉じアニメのあいだ残るため、遷移は閉じ切ってから。
	// ポップオーバー（iPad）は OverlayPortal の暗幕が即アンマウントされるため遅延しない。
	const sheetCloseThen = useSheetCloseThen(onClose);
	const closeThen = (go: () => void) => {
		if (inSheet) {
			sheetCloseThen(go);
		} else {
			onClose();
			go();
		}
	};

	// Android物理戻るボタンで閉じる
	useEffect(() => {
		if (!visible) {
			return;
		}
		const sub = BackHandler.addEventListener('hardwareBackPress', () => {
			onClose();
			return true;
		});
		return () => sub.remove();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visible]);

	// 狭い幅は共通の {@link BottomSheet} に載せる（器・出方・グラバーのドラッグを1箇所に集約する）。
	// `visible` はそのまま渡す——ここで早期returnすると閉じるアニメーションが再生されないまま
	// 木から外れてしまう。
	if (inSheet) {
		return (
			<BottomSheet visible={visible} onClose={onClose} title="ペアリング済みのPC" glass>
				<ScrollView style={styles.sheetScroll} contentContainerStyle={{ paddingBottom: insets.bottom + 16 }} bounces={false}>
					<PcList onClose={onClose} closeThen={closeThen} />
				</ScrollView>
			</BottomSheet>
		);
	}

	if (!visible) {
		return null;
	}

	{
		const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
		const left = Math.min(Math.max(anchor.x, 12), Math.max(12, screenWidth - POPOVER_WIDTH - 12));
		const top = Math.min(anchor.y, Math.max(80, screenHeight - 320));
		return (
			<OverlayPortal>
				<Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="閉じる" />
				<PopIn style={[styles.popoverPos, { top, left }]}>
					<GlassSurface style={styles.popover}>
						<SectionHeader title="ペアリング済みのPC" first style={styles.head} />
						<ScrollView style={styles.popoverScroll} bounces={false}>
							<PcList onClose={onClose} closeThen={closeThen} />
						</ScrollView>
					</GlassSurface>
				</PopIn>
			</OverlayPortal>
		);
	}
}

/**
 * ドロワー／サイドバー上部のPCカード（押すと切り替えを開く）。
 * ペアリング済みが1台のときも、右端に「他のPCを追加する」入口として矢印を出す。
 */
export function PcCardHeader({ onOpen, onOpenSettings }: {
	onOpen: (anchor: { x: number; y: number }) => void;
	onOpenSettings: () => void;
}) {
	const { pcs, activePcId, connection, pcOnline, sessionProtocolReady, manualOffline, battery } = useAppStore(useShallow(s => ({
		pcs: s.pcs,
		activePcId: s.activePcId,
		connection: s.connection,
		pcOnline: s.pcOnline,
		sessionProtocolReady: s.sessionProtocolReady,
		manualOffline: s.manualOffline,
		battery: s.workspace?.battery,
	})));
	const active = pcs.find(pc => pc.id === activePcId);
	const online = connection === 'online' && pcOnline && sessionProtocolReady;
	// 他のPCで待たれている件数（切り替える動機になるので、カードの時点で見せる）。
	const otherWaiting = pcs.filter(pc => pc.id !== activePcId).reduce((total, pc) => total + pc.waiting, 0);
	const others = pcs.length - 1;

	return (
		<View style={styles.cardRow}>
			<Pressable
				style={styles.cardMain}
				onPress={event => {
					hapticSelection();
					const { pageX, pageY } = event.nativeEvent;
					onOpen({ x: Math.max(12, pageX - 40), y: pageY + 18 });
				}}
				accessibilityLabel="PCを切り替え"
			>
				{active !== undefined
					? <PcAvatar name={active.name} hue={active.hue} size={30} />
					: <Image source={require('../../assets/pairing-logo.png')} style={styles.logo} resizeMode="contain" />}
				<View style={styles.cardBody}>
					<Text style={styles.cardName} numberOfLines={1}>{active?.name ?? 'Para Code'}</Text>
					<View style={styles.cardStateRow}>
						<Text style={[styles.cardState, !online && styles.cardStateOff]}>
							{online ? '● 接続中' : (connection === 'online' || connection === 'handshaking') && !pcOnline ? '○ PCオフライン' : manualOffline ? '○ 切断中' : '接続中…'}
						</Text>
						{online && battery !== undefined && (
							<>
								<Text style={styles.sep}>・</Text>
								<BatteryGauge level={battery.level} charging={battery.charging} />
							</>
						)}
					</View>
				</View>
				{others > 0 ? (
					<Badge
						label={otherWaiting > 0 ? `他${others}台 ${otherWaiting}` : `他${others}台`}
						tone={otherWaiting > 0 ? 'red' : 'neutral'}
						style={styles.badge}
					/>
				) : null}
				<Ionicons name="chevron-forward" size={14} color={colors.textDim} />
			</Pressable>
			{/* 箱自体を当たり判定ぶんの大きさにする（GlassViewはhitTestを上書きしないため、
			    内側Pressableのhitslopは箱の外側では効かない）。 */}
			<GlassSurface style={styles.settingsBtn} interactive>
				<Pressable
					style={styles.settingsBtnHit}
					onPress={() => { hapticSelection(); onOpenSettings(); }}
					accessibilityRole="button"
					accessibilityLabel="設定"
				>
					<Ionicons name="settings-outline" size={17} color={colors.textDim} />
				</Pressable>
			</GlassSurface>
		</View>
	);
}

const styles = StyleSheet.create({
	avatar: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, flexShrink: 0 },
	avatarText: { fontWeight: '800', fontFamily: monoFamily },
	addAvatar: { width: 38, height: 38, borderRadius: radius.control, ...squircle, backgroundColor: colors.surface2, borderColor: colors.border },
	addLabel: { color: colors.textDim, fontSize: type.body, fontWeight: '600' },

	row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 12, borderRadius: radius.card, ...squircle, marginHorizontal: 8, marginBottom: 2 },
	rowActive: { backgroundColor: colors.accentWash },
	rowBody: { flex: 1, minWidth: 0 },
	rowName: { color: colors.text, fontSize: type.body, fontWeight: '700' },
	rowNameActive: { color: colors.accent },
	rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
	rowState: { color: colors.textDim, fontSize: type.caption },
	rowStateLive: { color: colors.green },
	rowStateWarn: { color: colors.yellow },
	rowSub: { color: colors.textDim, fontSize: type.caption, flexShrink: 1 },
	sep: { color: 'rgba(255,255,255,0.25)', fontSize: type.caption },
	// `Badge` は既定で上寄せ（alignSelf: 'flex-start'）なので、行の中で縦中央に戻す。
	badge: { alignSelf: 'center' },
	divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder, marginVertical: 6, marginHorizontal: 14 },
	// 見出しの書式は SectionHeader。左右の余白だけ行の文字位置に合わせる。
	head: { paddingHorizontal: 20, marginTop: 10 },

	// ポップオーバー（iPad）
	popoverPos: { position: 'absolute', width: POPOVER_WIDTH },
	popover: { borderRadius: radius.panel, ...squircle, overflow: 'hidden', paddingBottom: 8 },
	popoverScroll: { maxHeight: 360 },

	// ボトムシート（iPhone）
	// 器・暗幕・グラバーは BottomSheet が持つので、ここでは中身の高さだけを決める。
	sheetScroll: { maxHeight: 420 },


	// PCカード（ドロワー／サイドバー上部）
	// marginは左だけに効かせる。両側に -8 を掛けると cardRow の gap をちょうど相殺してしまい、
	// 歯車ボタンとの間に余白が残らない。複数PC時は chevron の手前に「他N台」バッジ（縮まない）
	// が増えるため、その状態で chevron が歯車へ食い込んで重なって見えていた。
	cardRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
	// 高さは右の歯車ボタン（HIT_SIZE）に合わせる。左右で違うと1本の帯に見えない。
	cardMain: { flex: 1, minHeight: HIT_SIZE, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, marginLeft: -8, borderRadius: radius.control, ...squircle, backgroundColor: 'rgba(255,255,255,0.04)' },
	logo: { width: 30, height: 30 },
	cardBody: { flex: 1, minWidth: 0 },
	cardName: { color: colors.text, fontSize: type.body, fontWeight: '700' },
	cardStateRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
	cardState: { color: colors.green, fontSize: type.caption },
	cardStateOff: { color: colors.textDim },
	// 箱自体が当たり判定（ガラスの内側では hitSlop が効かない）なので、44pt そのものにする。
	settingsBtn: { width: HIT_SIZE, height: HIT_SIZE, borderRadius: radius.card, ...squircle },
	settingsBtnHit: { flex: 1, alignItems: 'center', justifyContent: 'center' },

});
