// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { colors, radius, squircle, type } from '../theme.js';
import { monoFamily } from '../monoFont.js';
import { Badge, BADGE_HEIGHT, STATUS_TONE } from './badge.js';
import { agentStatusColor, agentStatusKind, agentStatusLabel } from '../agentStatus.js';

/**
 * ホーム一覧のエージェント行の見た目を、リスト本体と長押し時の「リフト（浮き上がり）
 * クローン」の双方で共有するためのプレゼンテーショナルコンポーネント群。
 * 行UIの実装を二重管理しないよう、内部の描画は必ず {@link AgentRowContent} を通す。
 *
 * リフト演出は、対象行のウィンドウ座標（measureInWindow）を親から受け取り、
 * OverlayPortal内のスクリム上に {@link AgentRowClone} として同じ行UIを再描画する
 * （iOSのコンテキストメニューと同じ考え方。ScrollViewのスタッキングコンテキストを
 * 越えて前面へ出すため、リスト内でのzIndex昇格では実現できない）。
 */

export interface AgentRowData {
	title: string;
	wsName: string;
	wsColor: string;
	branch?: string;
	pinned: boolean;
	agentStatus: string | undefined;
}

/** measureInWindow で得た対象行のウィンドウ座標（pageX/pageY と同じ座標系）。 */
export interface AgentRowRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

function orbStyle(status: string | undefined) {
	return { backgroundColor: agentStatusColor(status) };
}

/**
 * 1行の小さな札（バッジ・チップ）の高さ。**アプリ全体でこの値に揃える。**
 *
 * ここを共有していなかったので、エージェント情報シートでは `<Text>` のバッジ（約16pt）と
 * `<View>` のチップ（約21.5pt）が隣同士に並び、5.5ptの段差が見えていた。`<Text>` の高さは
 * 行の高さで決まるため、padding を合わせるだけでは揃わない——高さそのものを決める。
 */
export const CHIP_HEIGHT = BADGE_HEIGHT;


/**
 * ステータスバッジ（非インタラクティブ）。レビュー行のタップ操作はリスト側でこれをPressableで包む。
 *
 * 見た目は共通の `Badge`。`Badge` は既定で `alignSelf: 'flex-start'` なので、行の中で
 * 上に寄らないよう縦中央に戻す。
 */
export function AgentBadge({ status }: { status: string | undefined }) {
	return <Badge label={agentStatusLabel(status)} tone={STATUS_TONE[agentStatusKind(status)]} style={styles.badge} />;
}

/**
 * 行の内側（ピン・オーブ・タイトル・ワークスペース・バッジ）。リストのPressableと
 * クローンのViewの双方から同じ見た目で描画する。`badge` を渡すとバッジ部分を差し替える
 * （リストのレビュー行は「確認済みにする」ポップオーバーを開くPressableを渡す）。
 */
export function AgentRowContent({ data, badge }: { data: AgentRowData; badge?: ReactNode }) {
	return (
		<>
			{data.pinned ? <Ionicons name="bookmark" size={11} color={colors.accent} style={styles.pinIcon} /> : null}
			<View style={[styles.orb, orbStyle(data.agentStatus)]} />
			<View style={styles.agentBody}>
				<Text style={styles.agentTitle} numberOfLines={1}>{data.title}</Text>
				<View style={styles.agentSub}>
					<Text style={[styles.agentWs, { color: data.wsColor }]} numberOfLines={1}>{data.wsName}</Text>
					{data.branch ? <Text style={styles.agentBranch} numberOfLines={1}> · {data.branch}</Text> : null}
				</View>
			</View>
			{badge ?? <AgentBadge status={data.agentStatus} />}
		</>
	);
}

/**
 * 長押しされた行の「浮き上がり」クローン。スクリムの上・メニューの下に、対象行の
 * ウィンドウ座標そのままの位置で描画し、scale 1.0→1.04 で前面へ持ち上げる。
 * タッチはそのまま背後のスクリム（タップで閉じる）へ通すため pointerEvents="none"。
 */
export function AgentRowClone({ data, rect }: { data: AgentRowData; rect: AgentRowRect }) {
	const scale = useSharedValue(1);
	useEffect(() => {
		scale.value = withTiming(1.04, { duration: 200, easing: Easing.out(Easing.back(1.4)) });
	}, [scale]);
	const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
	return (
		<Animated.View
			pointerEvents="none"
			style={[styles.clonePos, { top: rect.y, left: rect.x, width: rect.width }, animatedStyle]}
		>
			<View style={[agentRowStyles.container, styles.cloneRow]}>
				<AgentRowContent data={data} />
			</View>
		</Animated.View>
	);
}

/** 行の外枠。リストのPressableとクローンで共有する（見た目を一致させるため）。 */
export const agentRowStyles = StyleSheet.create({
	container: {
		flexDirection: 'row', alignItems: 'center', gap: 11,
		backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, paddingVertical: 12, paddingHorizontal: 14,
		borderWidth: 1, borderColor: colors.border, marginBottom: 8,
	},
});

const styles = StyleSheet.create({
	pinIcon: { marginRight: -2 },
	// 色は状態ごとに agentStatusColor が決める。idle は最も沈んだ状態だが、非テキスト3:1規範に
	// 届かないと「描画漏れ」と区別がつかないため colors.idle（#6e7681 = 4.04:1）を使っている。
	orb: { width: 10, height: 10, borderRadius: radius.pill },
	agentBody: { flex: 1, minWidth: 0 },
	agentTitle: { color: colors.text, fontSize: type.body, fontWeight: '600' },
	agentSub: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
	agentWs: { fontSize: type.caption, fontFamily: monoFamily, flexShrink: 1 },
	agentBranch: { color: colors.textDim, fontSize: type.caption, flexShrink: 1 },
	badge: { alignSelf: 'center' },
	// クローンは前面へ持ち上げるため、面と枠をわずかに強調し、強い影で浮遊感を出す。
	// marginBottom はレイアウト用なのでクローンでは打ち消す（絶対配置のため不要）。
	clonePos: { position: 'absolute' },
	cloneRow: {
		marginBottom: 0,
		backgroundColor: colors.surface2,
		borderColor: colors.borderStrong,
		shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 16,
	},
});
