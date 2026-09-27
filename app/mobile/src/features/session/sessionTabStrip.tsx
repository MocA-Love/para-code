// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Globe, Plus, Sparkles, SquareChevronRight } from 'lucide-react-native';
import { useAppStore } from '../../appState.js';
import { ProviderLogo } from '../../components/providerLogo.js';
import { hapticSelection } from '../../haptics.js';
import { HIT_SIZE, colors, radius, space, type } from '../../theme.js';
import { AgentStateDot, Icon, agentKindFromStatus } from '../../ui/index.js';
import type { SessionTabItem } from './sessionTabs.js';
import { PointerHover } from '../../ipad/pointerHover.js';

/**
 * タブの大きさ（モックの `.tab` は 128×36、下線 2）。横スクロールの中の要素は hitSlop が
 * スクロール領域の外へ出ると拾われないので、行の高さそのものを当たり判定の 44 にしている
 * （モックより 8pt 高い）。
 */
const TAB_WIDTH = 128;
const TAB_HEIGHT = HIT_SIZE;
/** 右端の固定ボタン（モックの `.tabbtn`: 幅 40）。 */
const TAB_BUTTON_WIDTH = 40;
const TAB_BUTTON_SLOP = { top: 0, bottom: 0, left: 2, right: 2 };
/** ロゴ（モックの AG(…, 13)）。 */
const LOGO_SIZE = 13;

/**
 * セッションのタブの列（Orca の MobileSessionHeader の下段）。横にスクロールするタブと、右端に固定の
 * ＋（新しいタブ）・区切り・クイックコマンド。選択中のタブは下線 2pt。長押しでタブの操作を開く。
 *
 * エージェントのタブにはロゴと状態の点を出す（ロゴはエージェントの種類が分かってから。分かるまでは星）。
 */
export function SessionTabStrip({ items, activeKey, onSelect, onLongPress, onNew, onQuick }: {
	items: readonly SessionTabItem[];
	activeKey: string | undefined;
	onSelect: (item: SessionTabItem) => void;
	onLongPress: (item: SessionTabItem) => void;
	onNew: () => void;
	onQuick: () => void;
}) {
	const scrollRef = useRef<ScrollView>(null);
	// 選択中のタブが見えるように寄せる（通知から右端のタブを開いたときなど）。
	const activeIndex = items.findIndex(item => item.key === activeKey);
	useEffect(() => {
		if (activeIndex >= 0) {
			scrollRef.current?.scrollTo({ x: Math.max(0, activeIndex * TAB_WIDTH - TAB_WIDTH / 2), animated: true });
		}
	}, [activeIndex]);
	return (
		<View style={styles.bar}>
			<ScrollView
				ref={scrollRef}
				horizontal
				showsHorizontalScrollIndicator={false}
				style={styles.scroll}
				contentContainerStyle={styles.tabs}
				accessibilityRole="tablist"
			>
				{items.map(item => (
					<SessionTab
						key={item.key}
						item={item}
						active={item.key === activeKey}
						onPress={() => onSelect(item)}
						onLongPress={() => onLongPress(item)}
					/>
				))}
			</ScrollView>
			<StripButton icon={Plus} label="新しいタブ" onPress={onNew} />
			<View style={styles.divider} />
			<StripButton icon={SquareChevronRight} label="クイックコマンド" onPress={onQuick} />
		</View>
	);
}

function SessionTab({ item, active, onPress, onLongPress }: {
	item: SessionTabItem;
	active: boolean;
	onPress: () => void;
	onLongPress: () => void;
}) {
	return (
		<PointerHover effect="highlight" cornerRadius={radius.button}>
		<Pressable
			onPress={() => { hapticSelection(); onPress(); }}
			onLongPress={() => { hapticSelection(); onLongPress(); }}
			style={({ pressed }) => [styles.tab, active ? styles.tabOn : undefined, pressed ? styles.pressed : undefined]}
			accessibilityRole="tab"
			accessibilityState={{ selected: active }}
			accessibilityLabel={item.title}
			accessibilityHint="長押しでタブの操作を開きます"
		>
			<View style={styles.label}>
				{item.kind === 'browser' ? <Icon icon={Globe} size={LOGO_SIZE} color={active ? colors.text : colors.textDim} /> : null}
				{item.kind === 'terminal' && item.agent ? <AgentTabGlyph terminalKey={item.terminal.terminalKey} agentStatus={item.terminal.agentStatus} /> : null}
				<Text style={[styles.text, active ? styles.textOn : undefined]} numberOfLines={1}>{item.title}</Text>
			</View>
		</Pressable>
		</PointerHover>
	);
}

/** エージェントのロゴと状態の点。種類は会話の状態（読み込んだものだけ）から取る。 */
function AgentTabGlyph({ terminalKey, agentStatus }: { terminalKey: string; agentStatus: string | undefined }) {
	const agent = useAppStore(s => s.agentChats.get(terminalKey)?.agent);
	return (
		<>
			{agent === 'claude' || agent === 'codex'
				? <ProviderLogo provider={agent} size={LOGO_SIZE} />
				: <Icon icon={Sparkles} size={LOGO_SIZE} color={colors.textDim} />}
			<AgentStateDot kind={agentKindFromStatus(agentStatus)} />
		</>
	);
}

function StripButton({ icon, label, onPress }: { icon: typeof Plus; label: string; onPress: () => void }) {
	return (
		<PointerHover effect="highlight" cornerRadius={radius.button}>
		<Pressable
			onPress={() => { hapticSelection(); onPress(); }}
			hitSlop={TAB_BUTTON_SLOP}
			style={({ pressed }) => [styles.button, pressed ? styles.pressed : undefined]}
			accessibilityRole="button"
			accessibilityLabel={label}
		>
			<Icon icon={icon} color={colors.textDim} strokeWidth={2.2} />
		</Pressable>
		</PointerHover>
	);
}

const styles = StyleSheet.create({
	bar: {
		flexDirection: 'row',
		alignItems: 'center',
		borderTopWidth: 1,
		borderTopColor: colors.border,
	},
	scroll: {
		flex: 1,
		minWidth: 0,
		maxHeight: TAB_HEIGHT,
	},
	tabs: {
		paddingHorizontal: space.sm,
	},
	tab: {
		width: TAB_WIDTH,
		height: TAB_HEIGHT,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: space.sm,
		borderBottomWidth: 2,
		borderBottomColor: 'transparent',
	},
	tabOn: {
		borderBottomColor: colors.textDim,
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	label: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		maxWidth: '100%',
		minWidth: 0,
	},
	text: {
		flexShrink: 1,
		fontSize: type.label,
		color: colors.textDim,
	},
	textOn: {
		color: colors.text,
	},
	button: {
		width: TAB_BUTTON_WIDTH,
		height: TAB_HEIGHT,
		alignItems: 'center',
		justifyContent: 'center',
	},
	divider: {
		width: StyleSheet.hairlineWidth,
		height: 18,
		backgroundColor: colors.border,
	},
});
