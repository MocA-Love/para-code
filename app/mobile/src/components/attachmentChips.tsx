// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useState } from 'react';
import { ActivityIndicator, Image, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Copy } from 'lucide-react-native';
import { useAppStore } from '../appState.js';
import { attachmentShareableUri, useAttachmentImage, type AttachmentLoad, type AttachmentTarget } from '../attachments/attachmentImages.js';
import type { MessageAttachment } from '../attachments/attachmentText.js';
import type { ComposerAttachment } from '../attachments/composerAttachments.js';
import { haptic } from '../haptics.js';
import { writeClipboardText } from '../nativeClipboard.js';
import { paraAlert } from '../paraAlert.js';
import { useParaToast } from '../paraToast.js';
import { isPhotoLibrarySaveAvailable, saveImageToPhotos } from '../photoLibrary.js';
import type { AgentChatImage } from '../store.js';
import { colors, radius, space, squircle, type } from '../theme.js';
import { ActionSheet } from '../ui/index.js';
import { ImageLightbox, useToolImage, type ImageLightboxAction, type ImageLoad } from './toolImage.js';

/**
 * 添付画像の札（案 C2 / P2）。「小さなサムネイル＋画像 N」を高さ 26pt に揃え、吹き出しでは本文の前に、
 * 入力欄では文字の上に並べる。押すと全画面のビューア（共有・写真に保存）、吹き出しでは長押しでパスをコピー。
 */

/** 札の高さ。文字の行（22pt）とサムネイルを縦の中央で揃える。 */
const CHIP_HEIGHT = 26;
/** 札の中のサムネイル。 */
const THUMB_SIZE = 22;
/** 文字の拡大（アクセシビリティ）で札の文字が伸びる上限。札は最小の高さだけを決めているので、超えた分は札が伸びる。 */
const LABEL_MAX_FONT_SCALE = 1.6;

/** 吹き出しの添付と、transcript の画像のブロックの対応（枚数と大きさで照合できたときだけ渡す。`attachmentImagesMatch`）。 */
export interface AttachmentFallbackImages {
	readonly terminalKey: string;
	readonly rev: number;
	readonly images: readonly AgentChatImage[];
}

function fallbackImageAt(fallback: AttachmentFallbackImages | undefined, index: number): AgentChatImage | undefined {
	return fallback?.images[index];
}

/** 端末・PC から取れなかったときだけ、transcript の画像のブロックへ切り替える。 */
function useAttachmentWithFallback(target: AttachmentTarget | undefined, variant: 'thumb' | 'full', fallback: AttachmentFallbackImages | undefined, index: number): ImageLoad {
	const load = useAttachmentImage(target, variant);
	const fallbackImage = fallbackImageAt(fallback, index);
	const useFallback = load.status === 'error' && fallbackImage !== undefined && (variant === 'full' || fallbackImage.bytes <= 1024 * 1024);
	const fallbackLoad = useToolImage(fallback?.terminalKey, fallback?.rev ?? 0, fallbackImage, useFallback);
	return useFallback ? fallbackLoad : load;
}

/** 札の見た目（吹き出しと入力欄で共通）。 */
function ChipFace({ index, load, onBubble, failed, uploading, removable, onRemove }: {
	index: number;
	load: ImageLoad | AttachmentLoad;
	/** 吹き出しの上に置くときの文字色（無ければ入力欄の色）。 */
	onBubble?: string;
	failed?: boolean;
	uploading?: boolean;
	removable?: boolean;
	onRemove?: () => void;
}) {
	const textColor = failed === true ? colors.red : onBubble ?? colors.text;
	return (
		<View style={[styles.chip, onBubble !== undefined ? styles.chipOnBubble : styles.chipInComposer, failed === true ? styles.chipFailed : undefined]}>
			<View style={styles.thumb}>
				{load.status === 'ready' ? (
					<Image source={{ uri: load.uri }} style={styles.thumbImage} resizeMode="cover" accessibilityIgnoresInvertColors />
				) : load.status === 'loading' ? (
					<ActivityIndicator size="small" color={colors.textDim} />
				) : (
					<Ionicons name="image-outline" size={13} color={colors.textDim} />
				)}
				{uploading === true ? (
					<View style={styles.thumbVeil}>
						<ActivityIndicator size="small" color="#ffffff" />
					</View>
				) : null}
			</View>
			<Text style={[styles.label, { color: textColor }]} numberOfLines={1} maxFontSizeMultiplier={LABEL_MAX_FONT_SCALE}>{`画像 ${index + 1}`}</Text>
			{failed === true ? <Ionicons name="alert-circle" size={14} color={colors.red} /> : null}
			{removable === true ? (
				<Pressable onPress={onRemove} hitSlop={{ top: 9, bottom: 9, left: 4, right: 8 }} accessibilityRole="button" accessibilityLabel={`画像 ${index + 1} を外す`} style={styles.remove}>
					<Ionicons name="close" size={13} color={colors.textDim} />
				</Pressable>
			) : null}
		</View>
	);
}

/** 共有と写真に保存（ビューアの上の帯の右）。 */
function useLightboxActions(uri: string | undefined, name: string): readonly ImageLightboxAction[] {
	const [saving, setSaving] = useState(false);
	const share = useCallback(async () => {
		if (uri === undefined) {
			return;
		}
		haptic('move');
		try {
			const file = await attachmentShareableUri(uri, name);
			if (file !== undefined) {
				await Share.share({ url: file });
			}
		} catch {
			paraAlert.alert('共有できませんでした', 'もう一度お試しください。');
		}
	}, [uri, name]);
	const save = useCallback(async () => {
		if (uri === undefined || saving) {
			return;
		}
		setSaving(true);
		try {
			const file = await attachmentShareableUri(uri, name);
			const result = file !== undefined ? await saveImageToPhotos(file) : 'unavailable';
			if (result === 'saved') {
				haptic('success');
				useParaToast.getState().show({ key: `photo-saved:${name}`, text: '写真に保存しました', icon: 'checkmark-circle', tone: 'done' }, 2_000);
			} else if (result === 'denied') {
				haptic('warning');
				paraAlert.alert('写真に保存できません', '設定 → Para Code →「写真」で追加を許可してください。');
			} else {
				paraAlert.alert('写真に保存できません', '共有から「画像を保存」を選んでください。');
			}
		} catch {
			haptic('error');
			paraAlert.alert('写真に保存できませんでした', 'もう一度お試しください。');
		} finally {
			setSaving(false);
		}
	}, [uri, name, saving]);
	return [
		{ key: 'share', icon: 'share-outline', label: '共有', onPress: () => { void share(); } },
		...(isPhotoLibrarySaveAvailable() ? [{ key: 'save', icon: 'download-outline' as const, label: '写真に保存', busy: saving, onPress: () => { void save(); } }] : []),
	];
}

/** 吹き出しの添付の全画面ビューア。原寸を取り寄せ（端末の控え → PC）、取れなければ transcript の画像。 */
function AttachmentLightbox({ targets, initialIndex, fallback, onClose }: {
	targets: readonly AttachmentTarget[];
	initialIndex: number;
	fallback: AttachmentFallbackImages | undefined;
	onClose: () => void;
}) {
	const [index, setIndex] = useState(initialIndex);
	const target = targets[index];
	const load = useAttachmentWithFallback(target, 'full', fallback, index);
	const actions = useLightboxActions(load.status === 'ready' ? load.uri : undefined, target?.name ?? 'image.jpg');
	return (
		<ImageLightbox
			load={load}
			count={targets.length}
			index={index}
			onIndexChange={setIndex}
			title={`画像 ${index + 1}`}
			subtitle={target?.name}
			actions={actions}
			onClose={onClose}
		/>
	);
}

/** 吹き出しの札 1 枚。 */
function MessageChip({ target, index, fallback, onBubble, onOpen, onMenu }: {
	target: AttachmentTarget;
	index: number;
	fallback: AttachmentFallbackImages | undefined;
	onBubble: string;
	onOpen: (index: number) => void;
	onMenu: (index: number) => void;
}) {
	const load = useAttachmentWithFallback(target, 'thumb', fallback, index);
	return (
		<Pressable
			onPress={() => { haptic('move'); onOpen(index); }}
			delayLongPress={400}
			onLongPress={() => { haptic('lift'); onMenu(index); }}
			accessibilityRole="button"
			accessibilityLabel={`画像 ${index + 1}`}
			accessibilityHint={load.status === 'error' ? load.message : '押すと全画面で開きます。長押しでパスをコピーします'}
		>
			<ChipFace index={index} load={load} onBubble={onBubble} />
		</Pressable>
	);
}

/**
 * 吹き出しの本文の前に並べる札（案 C2）。札の並びのあとで改行し、本文は呼び出し側が次の行から出す。
 */
export function MessageAttachmentChips({ attachments, terminalKey, fallback, onBubble }: {
	attachments: readonly MessageAttachment[];
	terminalKey: string;
	fallback: AttachmentFallbackImages | undefined;
	/** 吹き出しの文字色。 */
	onBubble: string;
}) {
	const pcId = useAppStore(state => state.activePcId);
	const ws = useAppStore(state => state.workspace?.terminals.find(terminal => terminal.terminalKey === terminalKey)?.ws);
	const targets = attachments.map(attachment => ({ pcId, ws, name: attachment.name, path: attachment.path }));
	const [open, setOpen] = useState<number | undefined>(undefined);
	const [menu, setMenu] = useState<number | undefined>(undefined);
	const menuTarget = menu !== undefined ? targets[menu] : undefined;
	return (
		<View style={styles.row}>
			{targets.map((target, index) => (
				<MessageChip key={target.name} target={target} index={index} fallback={fallback} onBubble={onBubble} onOpen={setOpen} onMenu={setMenu} />
			))}
			{open !== undefined ? <AttachmentLightbox targets={targets} initialIndex={open} fallback={fallback} onClose={() => setOpen(undefined)} /> : null}
			<ActionSheet
				visible={menuTarget !== undefined}
				title={menu !== undefined ? `画像 ${menu + 1}` : undefined}
				message={menuTarget?.name}
				actions={menuTarget !== undefined && menu !== undefined ? [{
					label: `画像 ${menu + 1} のパスをコピー`,
					icon: Copy,
					onPress: () => {
						void writeClipboardText(menuTarget.path).then(copied => {
							if (copied) {
								haptic('success');
								useParaToast.getState().show({ key: `attachment-path:${menuTarget.name}`, text: 'パスをコピーしました', icon: 'copy-outline', tone: 'done' }, 2_000);
							}
						});
					},
				}] : []}
				onClose={() => setMenu(undefined)}
			/>
		</View>
	);
}

/** 入力欄の札 1 枚（送る前。ピッカーが返した端末の画像をそのまま出す）。 */
function ComposerChip({ item, index, onOpen, onRemove, onRetry }: {
	item: ComposerAttachment;
	index: number;
	onOpen: (index: number) => void;
	onRemove: (id: string) => void;
	onRetry: (id: string) => void;
}) {
	const failed = item.status === 'failed';
	return (
		<Pressable
			onPress={() => {
				haptic('move');
				if (failed) {
					onRetry(item.id);
				} else {
					onOpen(index);
				}
			}}
			accessibilityRole="button"
			accessibilityLabel={`画像 ${index + 1}${item.status === 'uploading' ? '（アップロード中）' : failed ? '（送れませんでした）' : ''}`}
			accessibilityHint={failed ? '押すともう一度アップロードします' : '押すと全画面で確認できます'}
		>
			<ChipFace
				index={index}
				load={{ status: 'ready', uri: item.previewUri }}
				failed={failed}
				uploading={item.status === 'uploading'}
				removable
				onRemove={() => { haptic('move'); onRemove(item.id); }}
			/>
		</Pressable>
	);
}

/** 入力欄の札の全画面（端末の画像）。 */
function ComposerLightbox({ items, initialIndex, onClose }: { items: readonly ComposerAttachment[]; initialIndex: number; onClose: () => void }) {
	const [index, setIndex] = useState(initialIndex);
	const item = items[index];
	const load: ImageLoad = item !== undefined ? { status: 'ready', uri: item.previewUri } : { status: 'idle' };
	const actions = useLightboxActions(item?.previewUri, item?.name ?? item?.fileName ?? 'image.jpg');
	return (
		<ImageLightbox
			load={load}
			count={items.length}
			index={index}
			onIndexChange={setIndex}
			title={`画像 ${index + 1}`}
			subtitle={item?.fileName}
			actions={actions}
			onClose={onClose}
		/>
	);
}

/** 入力欄の文字の上に並べる札（案 P2）。 */
export function ComposerAttachmentChips({ items, onRemove, onRetry }: {
	items: readonly ComposerAttachment[];
	onRemove: (id: string) => void;
	onRetry: (id: string) => void;
}) {
	const [open, setOpen] = useState<number | undefined>(undefined);
	return (
		<View style={styles.row}>
			{items.map((item, index) => <ComposerChip key={item.id} item={item} index={index} onOpen={setOpen} onRemove={onRemove} onRetry={onRetry} />)}
			{open !== undefined && open < items.length ? <ComposerLightbox items={items} initialIndex={open} onClose={() => setOpen(undefined)} /> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 6,
	},
	chip: {
		minHeight: CHIP_HEIGHT,
		flexDirection: 'row',
		alignItems: 'center',
		gap: 5,
		paddingTop: 2,
		paddingBottom: 2,
		paddingLeft: 2,
		paddingRight: 8,
		borderRadius: radius.control,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
	},
	chipOnBubble: {
		backgroundColor: 'rgba(127,127,127,0.16)',
		borderColor: 'rgba(127,127,127,0.32)',
	},
	chipInComposer: {
		backgroundColor: colors.raised,
		borderColor: colors.border,
	},
	chipFailed: {
		borderColor: colors.red,
	},
	thumb: {
		width: THUMB_SIZE,
		height: THUMB_SIZE,
		borderRadius: 4,
		...squircle,
		overflow: 'hidden',
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: colors.surface3,
	},
	thumbImage: {
		width: '100%',
		height: '100%',
	},
	thumbVeil: {
		position: 'absolute',
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(0,0,0,0.45)',
	},
	label: {
		fontSize: type.label,
		lineHeight: 22,
		fontWeight: '600',
	},
	remove: {
		marginLeft: 2,
		marginRight: -space.xs,
		width: 18,
		height: 18,
		alignItems: 'center',
		justifyContent: 'center',
	},
});
