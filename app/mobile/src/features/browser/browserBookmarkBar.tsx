// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Globe } from 'lucide-react-native';
import type { IParadisMobileBookmarkFolder, IParadisMobileBookmarks, ParadisMobileBookmarkNode } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileBrowserProtocol.js';
import { HorizontalScrollFade } from '../../components/horizontalScrollFade.js';
import { Icon } from '../../ui/icon.js';
import { colors, radius, squircle, type } from '../../theme.js';
import { bookmarkFavicon, bookmarkFolderIcon, bookmarkLabel, isCurrentBookmark } from '../../browserBookmarks.js';
import type { BrowserPopoverAnchor } from './browserListOverlay.js';

/** バーの高さ（モックの `.m-bm`）。 */
export const BOOKMARK_BAR_HEIGHT = 32;

/** 項目の頭（favicon、無ければ地球。フォルダは PC と同じアイコンと色）。 */
export function BookmarkLeading({ node, bookmarks, size = 14 }: { node: ParadisMobileBookmarkNode; bookmarks: IParadisMobileBookmarks; size?: number }) {
	if (node.type === 'folder') {
		return <Ionicons name={bookmarkFolderIcon(node) as keyof typeof Ionicons.glyphMap} size={size} color={node.color ?? colors.textDim} />;
	}
	const favicon = bookmarkFavicon(node, bookmarks);
	return favicon !== undefined
		? <Image source={{ uri: favicon }} style={{ width: size, height: size, borderRadius: 3 }} />
		: <Icon icon={Globe} size={size} color={colors.textDim} />;
}

/**
 * PC のブックマークバーと同じ並び（案A。見て開くだけ）。押すと今のページでそのページを開き、フォルダは中身の
 * 一覧を開く。あふれたら横にスクロールし、右端を薄くする。0 件なら何も出さない（呼び出し側が出さない）。
 */
export function BrowserBookmarkBar({ bookmarks, pageUrl, disabled, onOpen, onOpenFolder }: {
	bookmarks: IParadisMobileBookmarks;
	pageUrl: string | undefined;
	disabled: boolean;
	onOpen: (url: string) => void;
	onOpenFolder: (folder: IParadisMobileBookmarkFolder, anchor: BrowserPopoverAnchor) => void;
}) {
	return (
		<HorizontalScrollFade style={styles.bar} contentStyle={styles.content}>
			{bookmarks.nodes.map(node => {
				const current = node.type === 'bookmark' && isCurrentBookmark(node.url, pageUrl);
				return (
					<Pressable
						key={node.id}
						disabled={disabled}
						style={({ pressed }) => [styles.item, (current || pressed) && styles.itemOn, disabled && styles.disabled]}
						onPress={event => {
							if (node.type === 'folder') {
								const { pageX, pageY, locationX, locationY } = event.nativeEvent;
								onOpenFolder(node, { top: pageY - locationY + BOOKMARK_BAR_HEIGHT - 4, x: pageX - locationX, align: 'left' });
							} else {
								onOpen(node.url);
							}
						}}
						accessibilityRole="button"
						accessibilityLabel={node.type === 'folder' ? `フォルダ ${bookmarkLabel(node)}` : bookmarkLabel(node)}
					>
						<BookmarkLeading node={node} bookmarks={bookmarks} />
						<Text style={styles.label} numberOfLines={1}>{bookmarkLabel(node)}</Text>
					</Pressable>
				);
			})}
		</HorizontalScrollFade>
	);
}

const styles = StyleSheet.create({
	bar: { height: BOOKMARK_BAR_HEIGHT, flexShrink: 0, backgroundColor: colors.bg },
	content: { alignItems: 'center', gap: 2, paddingHorizontal: 8 },
	item: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 8, borderRadius: radius.row, ...squircle, maxWidth: 160 },
	itemOn: { backgroundColor: colors.raised },
	disabled: { opacity: 0.45 },
	label: { flexShrink: 1, color: colors.text, fontSize: type.meta },
});
