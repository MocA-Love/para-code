// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { radius, space, status, type StatusKey } from '../theme.js';
import { agentDotColor, connectionColor, connectionLabel, isSpinningKind, type ConnectionKind } from './statusColors.js';

/**
 * PC とのつながりの点（Orca の StatusDot。8×8）。種類は `connectionKind(connection, pcOnline)` で決める。
 *
 * ```tsx
 * <StatusDot kind={connectionKind(pc.connection, pc.pcOnline)} />
 * ```
 */
export function StatusDot({ kind, size = 8 }: { kind: ConnectionKind; size?: 6 | 7 | 8 }) {
	return (
		<View
			style={[styles.dot, { width: size, height: size, backgroundColor: connectionColor(kind) }]}
			accessibilityLabel={connectionLabel(kind)}
		/>
	);
}

/** 1周の時間（ms。Orca と同じ）。 */
const SPIN_MS = 1000;

/** 実行中の間だけ回し続ける値。 */
function useSpin(spinning: boolean): Animated.AnimatedInterpolation<string> {
	const value = useRef(new Animated.Value(0)).current;
	useEffect(() => {
		if (!spinning) {
			value.setValue(0);
			return undefined;
		}
		const loop = Animated.loop(Animated.timing(value, { toValue: 1, duration: SPIN_MS, easing: Easing.linear, useNativeDriver: true }));
		loop.start();
		return () => loop.stop();
	}, [spinning, value]);
	return value.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
}

/** 外枠と中の印の寸法。外枠を固定しておくと、状態が変わっても行の高さと揃えが動かない。 */
const GLYPH = {
	/** スペース（ワークツリー）単位の印。12 の枠に 8 の点・輪（線 2）。 */
	md: { box: 12, mark: 8, ring: 2 },
	/** エージェント1体ぶんの印。10 の枠に 6 の点・輪（線 1.5）。 */
	sm: { box: 10, mark: 6, ring: 1.5 },
} as const;

function StateGlyph({ kind, size }: { kind: StatusKey; size: keyof typeof GLYPH }) {
	const spinning = isSpinningKind(kind);
	const rotate = useSpin(spinning);
	const g = GLYPH[size];
	const color = agentDotColor(kind);
	return (
		<View style={[styles.box, { width: g.box, height: g.box }]} accessibilityLabel={status[kind].label}>
			{spinning ? (
				<Animated.View
					style={[
						styles.mark,
						{ width: g.mark, height: g.mark, borderWidth: g.ring, borderColor: color, borderTopColor: 'transparent', transform: [{ rotate }] },
					]}
				/>
			) : (
				<View style={[styles.mark, { width: g.mark, height: g.mark, backgroundColor: color }]} />
			)}
		</View>
	);
}

/**
 * スペース（ワークツリー）の状態の印（Orca の AgentSpinner。12 の枠に 8）。実行中は黄色の輪が回る。
 * 状態は既存の判定で畳んだもの（`agentStatusKind(t.agentStatus)`）を渡す。
 */
export function AgentSpinner({ kind }: { kind: StatusKey }) {
	return <StateGlyph kind={kind} size="md" />;
}

/** エージェント1体の状態の印（Orca の AgentStateDot。10 の枠に 6）。実行中は回る。 */
export function AgentStateDot({ kind }: { kind: StatusKey }) {
	return <StateGlyph kind={kind} size="sm" />;
}

const styles = StyleSheet.create({
	dot: {
		borderRadius: radius.pill,
		marginRight: space.sm,
	},
	box: {
		alignItems: 'center',
		justifyContent: 'center',
	},
	mark: {
		borderRadius: radius.pill,
	},
});
