// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Fragment, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { BreadcrumbItem } from '../filesBreadcrumb.js';
import { HIT_SIZE, colors, type } from '../theme.js';

/**
 * ファイルタブのパンくず。途中の階層を押すと、そこへ直接戻れる（以前は文字だけで押せず、
 * 深い階層から戻るには「..」を何度も押すしかなかった）。
 *
 * 押せる段はリンクの色（accent）、いま開いている段は本文の色で押せない。
 * 深くて1行に収まらないときは横にスクロールし、開いたときは現在地（右端）を見せる。
 */
export function FilesBreadcrumbs({ crumbs, disabled, onSelect }: {
	crumbs: readonly BreadcrumbItem[];
	/** 接続が無いなど、移動できないとき。 */
	disabled: boolean;
	onSelect: (target: string) => void;
}) {
	const scrollRef = useRef<ScrollView>(null);
	return (
		<ScrollView
			ref={scrollRef}
			horizontal
			showsHorizontalScrollIndicator={false}
			style={styles.bar}
			contentContainerStyle={styles.content}
			onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
			keyboardShouldPersistTaps="handled"
		>
			{crumbs.map((crumb, index) => {
				const pressable = !crumb.current && !disabled;
				return (
					<Fragment key={crumb.target}>
						{index > 0 ? <Ionicons name="chevron-forward" size={12} color={colors.textDim} /> : null}
						<Pressable
							style={[styles.crumb, index === 0 && styles.first]}
							disabled={!pressable}
							onPress={() => onSelect(crumb.target)}
							accessibilityRole="button"
							accessibilityState={{ disabled: !pressable, selected: crumb.current }}
							accessibilityLabel={crumb.current ? `${crumb.label}（現在のフォルダ）` : `${crumb.label}へ移動`}
						>
							<Text style={[styles.text, crumb.current ? styles.current : pressable ? styles.link : styles.inactive]} numberOfLines={1}>{crumb.label}</Text>
						</Pressable>
					</Fragment>
				);
			})}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	bar: { flexGrow: 0 },
	content: { flexDirection: 'row', alignItems: 'center', gap: 2 },
	// 当たり判定は44pt。文字が短い段でも押し損ねないよう最小幅も持つ。
	crumb: { minHeight: HIT_SIZE, minWidth: HIT_SIZE, paddingHorizontal: 6, justifyContent: 'center', alignItems: 'center', maxWidth: 220 },
	// 先頭の段は一覧の左端と文字の頭をそろえる。
	first: { paddingLeft: 0, alignItems: 'flex-start' },
	text: { fontSize: type.meta },
	link: { color: colors.accent },
	current: { color: colors.text, fontWeight: '600' },
	inactive: { color: colors.textDim },
});
