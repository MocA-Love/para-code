// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, type ReactNode } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { OverlayPortal, PopIn } from '../../components/overlayHost.js';
import { BottomDrawer } from '../../ui/bottomDrawer.js';
import { DrawerCaption } from '../../ui/drawerHeader.js';
import { ListGroup, ListRow } from '../../ui/listRow.js';
import { colors, radius, space, squircle, type } from '../../theme.js';

/** 一覧の 1 行。 */
export interface BrowserListItem {
	readonly key: string;
	readonly label: string;
	readonly hint?: string;
	readonly leading?: ReactNode;
	readonly trailing?: 'check' | 'chevron' | 'none';
	/**
	 * 押したら一覧を閉じるか（フォルダへ進むときは閉じない）。閉じるときは、シートが閉じ切ってから
	 * `onPress` を呼ぶ（別のシートを開く操作が閉じる途中のモーダルに邪魔されないように）。
	 */
	readonly closes: boolean;
	readonly onPress: () => void;
}

/** ポップオーバーをぶら下げる位置（画面の座標。ボタンの下端と、左右どちらの端に揃えるか）。 */
export interface BrowserPopoverAnchor {
	readonly top: number;
	readonly x: number;
	readonly align: 'left' | 'right';
}

const POPOVER_WIDTH = 340;

/**
 * ブラウザのページの一覧・ブックマークのフォルダの中身（案A）。iPhone などの狭い幅では下から出るシート、
 * iPad の広い幅ではボタンの下にぶら下がるポップオーバーで出す（どちらを使うかは呼び出し側が
 * `useIsRegularWidth()` で決める）。
 */
export function BrowserListOverlay({ visible, popover, anchor, title, caption, items, header, onClose, allowLandscape = false }: {
	visible: boolean;
	popover: boolean;
	anchor: BrowserPopoverAnchor | undefined;
	title: string;
	caption?: string;
	items: readonly BrowserListItem[];
	/** 見出しの上に置くもの（フォルダの「戻る」など）。 */
	header?: ReactNode;
	onClose: () => void;
	/** 横向きでも出す（iPhone のブラウザの全画面から開くとき）。 */
	allowLandscape?: boolean;
}) {
	const pending = useRef<(() => void) | undefined>(undefined);
	const press = (item: BrowserListItem) => {
		if (!item.closes) {
			item.onPress();
			return;
		}
		if (popover) {
			onClose();
			item.onPress();
			return;
		}
		pending.current = item.onPress;
		onClose();
	};
	if (popover) {
		return visible && anchor !== undefined ? <BrowserPopover anchor={anchor} title={caption !== undefined ? `${title} · ${caption}` : title} items={items} header={header} onPress={press} onClose={onClose} /> : null;
	}
	return (
		<BottomDrawer
			visible={visible}
			onClose={onClose}
			onAfterClose={() => {
				const run = pending.current;
				pending.current = undefined;
				run?.();
			}}
			accessibilityLabel={title}
			allowLandscape={allowLandscape}
		>
			{header}
			<DrawerCaption title={title} message={caption} />
			<ListGroup>
				{items.map(item => (
					<ListRow key={item.key} label={item.label} hint={item.hint} leading={item.leading} trailing={item.trailing ?? 'none'} onPress={() => press(item)} />
				))}
			</ListGroup>
		</BottomDrawer>
	);
}

function BrowserPopover({ anchor, title, items, header, onPress, onClose }: {
	anchor: BrowserPopoverAnchor;
	title: string;
	items: readonly BrowserListItem[];
	header?: ReactNode;
	onPress: (item: BrowserListItem) => void;
	onClose: () => void;
}) {
	const { width, height } = useWindowDimensions();
	useEffect(() => {
		const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
			onClose();
			return true;
		});
		return () => subscription.remove();
	}, [onClose]);
	const popoverWidth = Math.min(POPOVER_WIDTH, width - 2 * space.sm);
	const left = Math.max(space.sm, Math.min(anchor.align === 'right' ? anchor.x - popoverWidth : anchor.x, width - popoverWidth - space.sm));
	const top = Math.max(space.sm, anchor.top + 4);
	return (
		<OverlayPortal>
			<Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="閉じる" />
			<PopIn style={[styles.popover, { top, left, width: popoverWidth, maxHeight: Math.max(160, height - top - space.lg) }]}>
				{header}
				<Text style={styles.popoverTitle} numberOfLines={1}>{title}</Text>
				<ScrollView bounces={false}>
					{items.map(item => (
						<ListRow key={item.key} label={item.label} hint={item.hint} leading={item.leading} trailing={item.trailing ?? 'none'} onPress={() => onPress(item)} />
					))}
				</ScrollView>
			</PopIn>
		</OverlayPortal>
	);
}

const styles = StyleSheet.create({
	popover: {
		position: 'absolute',
		backgroundColor: colors.panel,
		borderRadius: radius.panel,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.borderStrong,
		overflow: 'hidden',
		shadowColor: colors.shadow,
		shadowOpacity: 0.5,
		shadowRadius: 12,
		shadowOffset: { width: 0, height: 8 },
	},
	popoverTitle: { color: colors.textMuted, fontSize: type.caption, fontWeight: '600', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 },
});
