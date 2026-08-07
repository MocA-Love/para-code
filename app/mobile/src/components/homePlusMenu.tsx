// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, useEffect, useRef, useState } from 'react';
import { Animated, Easing, LayoutAnimation, Platform, Pressable, StyleSheet, Text, UIManager, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassGroup, GlassSurface } from './glassSurface.js';
import { ProviderLogo } from './providerLogo.js';
import { colors, radius, squircle } from '../theme.js';
import { hapticImpact } from '../haptics.js';

/** メニューの幅。3つ並べた上段のラベルが2行で収まる最小幅。 */
const MENU_WIDTH = 274;
/** ヘッダーのボタンのピルの高さ。メニューはこのすぐ下から生える。 */
const PILL_HEIGHT = 40;
/** 生えて・畳まれるまでの時間（ミリ秒）。枠の変化と中身の濃さで共有する。 */
const MORPH_MS = 280;

if (Platform.OS === 'android') {
	UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

export type HomePlusMenuAction =
	| 'launch-claude'
	| 'launch-codex'
	| 'new-terminal'
	| 'new-worktree'
	| 'space-note'
	| 'sort'
	| 'ack-all';

/**
 * ホームヘッダーの＋から生えるメニューと、それを包むガラスの器。
 *
 * **ボタンのピルとメニューを同じ器（`GlassGroup`）の直下に置く**のが要点。器は中の
 * ガラス同士が `spacing` 以内に近づくと1つの塊として描く。
 *
 * 融合の**動き**は、器が「中のガラスの枠が変わったとき」に自分で起こす。だからここでは
 * 高さを0から本来の高さへ伸ばすだけでよく、ガラスに直接アニメーションを掛ける必要はない。
 * 枠の変化は `LayoutAnimation` に任せる——UIKit側の普通の仕組みなので、器はそれを融合の
 * 動きとして拾う。
 *
 * **Reanimated は使わない。** ガラス自体を動かすとネイティブへ直接プロパティを書き込む形に
 * なって落ちるし、worklet から `runOnJS` で予約した後始末は、木から外れた後に走ると
 * 解放済みの参照を触って落ちる（worklets の既知の不具合）。ここは開閉のたびに木へ
 * 出入りする場所なので、その条件を最も踏みやすい。
 */
export function HomePlusMenu({ visible, onClose, onSelect, ackCount, hasSpace, children }: {
	visible: boolean;
	onClose: () => void;
	onSelect: (action: HomePlusMenuAction) => void;
	/** 「すべて確認済みにする」の対象件数。0件のときはその行を出さない。 */
	ackCount: number;
	/** 開く先のスペースが決まっているか。決まっていないとメモは開けないので行ごと出さない。 */
	hasSpace: boolean;
	/** ＋を含むボタンのピル。メニューと融合させるため、ここへ渡して同じ器に入れる。 */
	children: ReactNode;
}) {
	// 中身の高さ。畳んでいる間も本来の幅で置いてあるので、閉じたままでも測れる
	// （器が切り抜いているだけで、中身の配置そのものは変わらない）。
	const [contentHeight, setContentHeight] = useState(0);
	const [open, setOpen] = useState(visible);
	const fade = useRef(new Animated.Value(visible ? 1 : 0)).current;

	useEffect(() => {
		// 枠の変化をUIKitのアニメーションとして起こす。器はこれを融合の動きとして拾う。
		LayoutAnimation.configureNext({
			duration: MORPH_MS,
			create: { type: 'easeInEaseOut', property: 'opacity' },
			update: { type: 'easeInEaseOut' },
			delete: { type: 'easeInEaseOut', property: 'opacity' },
		});
		setOpen(visible);
		Animated.timing(fade, {
			toValue: visible ? 1 : 0,
			// 中身は器より少し遅れて出て、閉じるときは先に消える。同時だと、伸び切る前の
			// 潰れた面に文字が乗って読めてしまう。
			duration: visible ? MORPH_MS * 0.65 : MORPH_MS * 0.5,
			delay: visible ? MORPH_MS * 0.35 : 0,
			easing: Easing.out(Easing.quad),
			useNativeDriver: true,
		}).start();
	}, [visible, fade]);

	const pick = (action: HomePlusMenuAction) => {
		hapticImpact('light');
		onClose();
		onSelect(action);
	};

	return (
		<GlassGroup style={styles.group} spacing={16}>
			{children}
			<GlassSurface
				style={[styles.menu, { height: open ? contentHeight : 0 }]}
				appearance={{ visible: open, duration: MORPH_MS / 1000 }}
				pointerEvents={visible ? 'auto' : 'none'}
			>
				{/* 中身は器の高さに関係なく本来の大きさで置く。器が切り抜くだけなので、
				    畳んでいる間にここで測った高さが、そのまま開いたときの高さになる。 */}
				<View style={styles.content} onLayout={event => setContentHeight(event.nativeEvent.layout.height)}>
					{/* 素のガラスのままだと、後ろの一覧の文字が項目名と重なって読めない。
					    縁の光と融合の首は素材が持っているので、内側だけ地の板で埋める。 */}
					<Animated.View style={[styles.plate, { opacity: fade }]} pointerEvents="none" />
					<Animated.View style={{ opacity: fade }}>
						<View style={styles.top}>
							<TopItem label={'Claude\nを起動'} onPress={() => pick('launch-claude')}>
								<ProviderLogo provider="claude" size={26} />
							</TopItem>
							<TopItem label={'Codex\nを起動'} onPress={() => pick('launch-codex')}>
								<ProviderLogo provider="codex" size={26} />
							</TopItem>
							<TopItem label={'ターミナル\nを作成'} onPress={() => pick('new-terminal')}>
								<Ionicons name="terminal-outline" size={24} color={colors.text} />
							</TopItem>
						</View>
						<View style={styles.divider} />
						<MenuRow icon="git-branch-outline" label="ワークツリーを作成" onPress={() => pick('new-worktree')} />
						{hasSpace ? <MenuRow icon="document-text-outline" label="スペースのメモ" onPress={() => pick('space-note')} /> : null}
						<View style={styles.divider} />
						<MenuRow icon="swap-vertical-outline" label="並び替えと絞り込み" onPress={() => pick('sort')} />
						{ackCount > 0 ? (
							<MenuRow icon="checkmark-done-outline" label="すべて確認済みにする" onPress={() => pick('ack-all')} />
						) : null}
					</Animated.View>
				</View>
			</GlassSurface>
		</GlassGroup>
	);
}

/**
 * メニューの下に敷く地。
 *
 * ヘッダーより下の層に置くので、島と＋のピルは暗くならずに残る。メニューがそこから
 * 伸びていることが見えたままになり、「どこから開いたか」を見失わない。
 */
export function PlusMenuScrim({ visible, onClose }: { visible: boolean; onClose: () => void }) {
	const fade = useRef(new Animated.Value(visible ? 1 : 0)).current;
	const [mounted, setMounted] = useState(visible);

	useEffect(() => {
		if (visible) {
			setMounted(true);
		}
		Animated.timing(fade, {
			toValue: visible ? 1 : 0,
			duration: MORPH_MS,
			easing: Easing.out(Easing.quad),
			useNativeDriver: true,
		}).start();
		if (visible) {
			return undefined;
		}
		// 消え切ってから木から外す。アニメーションの完了コールバックに頼らないのは、
		// 木から外れた後にコールバックが走ると落ちる経路を踏まないため。
		const timer = setTimeout(() => setMounted(false), MORPH_MS);
		return () => clearTimeout(timer);
	}, [visible, fade]);

	if (!mounted) {
		return null;
	}
	return (
		<Animated.View style={[styles.scrim, { opacity: fade }]}>
			<Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="メニューを閉じる" />
		</Animated.View>
	);
}

function TopItem({ label, children, onPress }: { label: string; children: ReactNode; onPress: () => void }) {
	return (
		<Pressable
			style={({ pressed }) => [styles.topItem, pressed && styles.pressed]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label.replace('\n', '')}
		>
			{children}
			<Text style={styles.topLabel}>{label}</Text>
		</Pressable>
	);
}

function MenuRow({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
	return (
		<Pressable
			style={({ pressed }) => [styles.row, pressed && styles.pressed]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
		>
			<View style={styles.rowIcon}><Ionicons name={icon} size={18} color="#d6d6de" /></View>
			<Text style={styles.rowLabel}>{label}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9, backgroundColor: 'rgba(0,0,0,0.45)' },
	// 器はピルの大きさのまま。メニューは絶対配置なので、ヘッダーの高さを押し広げない
	// （押し広げると本文の余白が跳ねる）。
	group: { alignItems: 'flex-end' },
	// ピルのすぐ下・右端を揃えて置く。器の spacing より近いので、伸びる途中でピルと繋がる。
	// 高さ0のときに中身をはみ出させないよう、ここだけは切り抜く。
	menu: {
		position: 'absolute', top: PILL_HEIGHT + 6, right: 0, width: MENU_WIDTH,
		borderRadius: 30, ...squircle, overflow: 'hidden',
	},
	content: { position: 'absolute', top: 0, left: 0, width: MENU_WIDTH, paddingBottom: 6 },
	plate: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(16,16,19,0.97)' },
	top: { flexDirection: 'row', paddingTop: 16, paddingBottom: 14, paddingHorizontal: 6 },
	topItem: { flex: 1, alignItems: 'center', gap: 7, paddingHorizontal: 4, paddingVertical: 4, borderRadius: radius.card, ...squircle },
	topLabel: { color: colors.text, fontSize: 11, lineHeight: 15, textAlign: 'center' },
	divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 18, backgroundColor: 'rgba(255,255,255,0.12)' },
	row: { flexDirection: 'row', alignItems: 'center', gap: 14, height: 48, paddingHorizontal: 20 },
	rowIcon: { width: 22, alignItems: 'center' },
	rowLabel: { color: colors.text, fontSize: 14.5 },
	pressed: { backgroundColor: 'rgba(255,255,255,0.10)' },
});
