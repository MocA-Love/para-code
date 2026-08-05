// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { BackHandler, Dimensions, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, type PcSummary } from '../appState.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { GlassSurface, liquidGlass } from './glassSurface.js';
import { OverlayPortal, PopIn } from './overlayHost.js';
import { colors } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';

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

export function pcColor(hue: number): string {
	return PC_PALETTE[hue % PC_PALETTE.length] ?? colors.accent;
}

export function PcAvatar({ name, hue, size = 40 }: { name: string; hue: number; size?: number }) {
	const color = pcColor(hue);
	return (
		<View style={[styles.avatar, { width: size, height: size, borderRadius: size * 0.29, backgroundColor: `${color}22`, borderColor: `${color}66` }]}>
			<Text style={[styles.avatarText, { color, fontSize: size * 0.38 }]}>{name.trim().charAt(0).toUpperCase() || 'P'}</Text>
		</View>
	);
}

function PcRow({ pc, active, onPress }: { pc: PcSummary; active: boolean; onPress: () => void }) {
	const state = pcStateLabel(pc, active);
	const lastSeen = state.tone === 'dim' && pc.connection !== 'online' ? lastSeenLabel(pc.lastOnlineAt, Date.now()) : undefined;
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
				<View style={styles.waitingBadge}><Text style={styles.waitingBadgeText}>{`質問 ${pc.waiting}`}</Text></View>
			) : null}
			{active ? <Ionicons name="checkmark" size={17} color={colors.accent} /> : null}
		</Pressable>
	);
}

function PcList({ onClose }: { onClose: () => void }) {
	const router = useRouter();
	const { pcs, activePcId, switchPc } = useAppStore(useShallow(s => ({
		pcs: s.pcs, activePcId: s.activePcId, switchPc: s.switchPc,
	})));

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
				<PcRow key={pc.id} pc={pc} active={pc.id === activePcId} onPress={() => select(pc.id)} />
			))}
			<View style={styles.divider} />
			<Pressable
				style={styles.row}
				onPress={() => { hapticSelection(); onClose(); router.push('/pair'); }}
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
				onPress={() => { hapticSelection(); onClose(); router.push('/settings'); }}
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

	if (!visible) {
		return null;
	}

	if (regular && anchor !== undefined) {
		const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
		const left = Math.min(Math.max(anchor.x, 12), Math.max(12, screenWidth - POPOVER_WIDTH - 12));
		const top = Math.min(anchor.y, Math.max(80, screenHeight - 320));
		return (
			<OverlayPortal>
				<Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="閉じる" />
				<PopIn style={[styles.popoverPos, { top, left }]}>
					<GlassSurface style={[styles.popover, !liquidGlass && styles.popoverFallbackBorder]}>
						<Text style={styles.head}>ペアリング済みのPC</Text>
						<ScrollView style={styles.popoverScroll} bounces={false}>
							<PcList onClose={onClose} />
						</ScrollView>
					</GlassSurface>
				</PopIn>
			</OverlayPortal>
		);
	}

	return (
		<OverlayPortal>
			<Pressable style={[StyleSheet.absoluteFill, styles.scrim]} onPress={onClose} accessibilityLabel="閉じる" />
			<PopIn style={styles.sheetPos}>
				<GlassSurface style={[styles.sheet, !liquidGlass && styles.popoverFallbackBorder, { paddingBottom: insets.bottom + 16 }]}>
					<View style={styles.grabber} />
					<Text style={styles.head}>ペアリング済みのPC</Text>
					<ScrollView style={styles.sheetScroll} bounces={false}>
						<PcList onClose={onClose} />
					</ScrollView>
				</GlassSurface>
			</PopIn>
		</OverlayPortal>
	);
}

/**
 * 通知タップなどで自動的にPCが切り替わったときに、画面上部へ出す告知。
 * 切り替わったこと自体を隠さないための最小限の表示で、「戻る」で直前のPCへ帰れる。
 */
export function PcSwitchNotice() {
	const insets = useStableInsets();
	const { notice, pcs, switchPc, dismiss } = useAppStore(useShallow(s => ({
		notice: s.pcSwitchNotice, pcs: s.pcs, switchPc: s.switchPc, dismiss: s.dismissPcSwitchNotice,
	})));

	// 出しっぱなしにしない。数秒で自然に消す（操作を邪魔しないため）。
	useEffect(() => {
		if (notice === undefined) {
			return;
		}
		const timer = setTimeout(() => dismiss(), 6_000);
		return () => clearTimeout(timer);
	}, [notice, dismiss]);

	if (notice === undefined) {
		return null;
	}
	const hue = pcs.find(pc => pc.id === notice.pcId)?.hue ?? 0;
	const previous = notice.previousPcId !== undefined ? pcs.find(pc => pc.id === notice.previousPcId) : undefined;

	return (
		<OverlayPortal>
			<PopIn style={[styles.noticePos, { top: insets.top + 6 }]}>
				<GlassSurface style={[styles.notice, !liquidGlass && styles.popoverFallbackBorder]}>
					<PcAvatar name={notice.name} hue={hue} size={26} />
					<Text style={styles.noticeText} numberOfLines={1}>
						<Text style={styles.noticeName}>{notice.name}</Text>
						{' に切り替えました'}
					</Text>
					{previous !== undefined ? (
						<Pressable
							hitSlop={8}
							onPress={() => { hapticImpact('light'); switchPc(previous.id); dismiss(); }}
							accessibilityLabel={`${previous.name}へ戻る`}
						>
							<Text style={styles.noticeAction}>戻る</Text>
						</Pressable>
					) : (
						<Pressable hitSlop={8} onPress={dismiss} accessibilityLabel="閉じる">
							<Ionicons name="close" size={15} color={colors.textDim} />
						</Pressable>
					)}
				</GlassSurface>
			</PopIn>
		</OverlayPortal>
	);
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
	const batteryLow = battery !== undefined && !battery.charging && battery.level < 20;
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
					? <PcAvatar name={active.name} hue={active.hue} size={38} />
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
								{battery.charging && <Ionicons name="flash" size={9} color={colors.yellow} />}
								<View style={[styles.batteryBody, batteryLow && styles.batteryBodyLow]}>
									<View
										style={[
											styles.batteryFill,
											{ width: `${Math.max(8, battery.level)}%` },
											battery.charging && styles.batteryFillCharging,
											batteryLow && styles.batteryFillLow,
										]}
									/>
								</View>
								<View style={[styles.batteryTip, batteryLow && styles.batteryTipLow]} />
								<Text style={[styles.batteryPct, batteryLow && styles.batteryPctLow]}>{battery.level}%</Text>
							</>
						)}
					</View>
				</View>
				{others > 0 ? (
					<View style={[styles.othersBadge, otherWaiting > 0 && styles.othersBadgeAlert]}>
						<Text style={[styles.othersBadgeText, otherWaiting > 0 && styles.othersBadgeTextAlert]}>
							{otherWaiting > 0 ? `他${others}台 ${otherWaiting}` : `他${others}台`}
						</Text>
					</View>
				) : null}
				<Ionicons name="chevron-forward" size={14} color={colors.textDim} />
			</Pressable>
			<Pressable
				style={styles.settingsBtn}
				onPress={() => { hapticSelection(); onOpenSettings(); }}
				accessibilityLabel="設定"
				hitSlop={6}
			>
				<Ionicons name="settings-outline" size={17} color={colors.textDim} />
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	avatar: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, flexShrink: 0 },
	avatarText: { fontWeight: '800', fontFamily: 'Menlo' },
	addAvatar: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.surface2, borderColor: colors.border },
	addLabel: { color: colors.textDim, fontSize: 13.5, fontWeight: '600' },

	row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 14, marginHorizontal: 8, marginBottom: 2 },
	rowActive: { backgroundColor: colors.accentWash },
	rowBody: { flex: 1, minWidth: 0 },
	rowName: { color: colors.text, fontSize: 14, fontWeight: '700' },
	rowNameActive: { color: colors.accent },
	rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
	rowState: { color: colors.textDim, fontSize: 11 },
	rowStateLive: { color: colors.green },
	rowStateWarn: { color: colors.yellow },
	rowSub: { color: colors.textDim, fontSize: 11, flexShrink: 1 },
	sep: { color: 'rgba(255,255,255,0.25)', fontSize: 11 },
	waitingBadge: { backgroundColor: 'rgba(244,114,114,0.15)', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
	waitingBadgeText: { color: colors.red, fontSize: 9.5, fontWeight: '700' },
	divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder, marginVertical: 6, marginHorizontal: 14 },
	head: { color: colors.textDim, fontSize: 10.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 8 },

	// ポップオーバー（iPad）
	popoverPos: { position: 'absolute', width: POPOVER_WIDTH },
	popover: { borderRadius: 18, overflow: 'hidden', paddingBottom: 8 },
	popoverFallbackBorder: { borderWidth: 1, borderColor: colors.glassBorder },
	popoverScroll: { maxHeight: 360 },

	// ボトムシート（iPhone）
	scrim: { backgroundColor: 'rgba(0,0,0,0.45)' },
	sheetPos: { position: 'absolute', left: 0, right: 0, bottom: 0 },
	sheet: { borderTopLeftRadius: 26, borderTopRightRadius: 26, overflow: 'hidden', paddingTop: 10 },
	sheetScroll: { maxHeight: 420 },
	grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)', alignSelf: 'center', marginBottom: 4 },

	// 切り替えの告知
	noticePos: { position: 'absolute', left: 14, right: 14 },
	notice: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 15, overflow: 'hidden' },
	noticeText: { flex: 1, color: colors.text, fontSize: 12.5 },
	noticeName: { fontWeight: '700' },
	noticeAction: { color: colors.accent, fontSize: 12.5, fontWeight: '700' },

	// PCカード（ドロワー／サイドバー上部）
	cardRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	cardMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.04)' },
	logo: { width: 38, height: 38 },
	cardBody: { flex: 1, minWidth: 0 },
	cardName: { color: colors.text, fontSize: 14, fontWeight: '700' },
	cardStateRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
	cardState: { color: colors.green, fontSize: 11 },
	cardStateOff: { color: colors.textDim },
	othersBadge: { backgroundColor: colors.surface3, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
	othersBadgeAlert: { backgroundColor: 'rgba(244,114,114,0.15)' },
	othersBadgeText: { color: colors.textDim, fontSize: 9.5, fontWeight: '700' },
	othersBadgeTextAlert: { color: colors.red },
	settingsBtn: { width: 32, height: 32, borderRadius: 10, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },

	// バッテリー（従来のPCカードと同じ見た目）
	batteryBody: { width: 17, height: 9, borderRadius: 2.5, borderWidth: 1.2, borderColor: 'rgba(255,255,255,0.5)', padding: 1.5, justifyContent: 'center' },
	batteryBodyLow: { borderColor: 'rgba(244,114,114,0.7)' },
	batteryFill: { height: '100%', borderRadius: 1, backgroundColor: colors.green },
	batteryFillCharging: { backgroundColor: colors.yellow },
	batteryFillLow: { backgroundColor: colors.red },
	batteryTip: { width: 2, height: 3.5, borderTopRightRadius: 1, borderBottomRightRadius: 1, backgroundColor: 'rgba(255,255,255,0.5)', marginLeft: -3 },
	batteryTipLow: { backgroundColor: 'rgba(244,114,114,0.7)' },
	batteryPct: { color: colors.textDim, fontSize: 10.5, fontWeight: '700' },
	batteryPctLow: { color: colors.red },
});
