// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../appState.js';
import type { AgentChatImage } from '../store.js';
import { formatImageBytes, loadToolImage, toolImageCache, toolImageKey } from '../agentToolImages.js';
import { GlassSurface } from './glassSurface.js';
import { OverlayPortal } from './overlayHost.js';
import { haptic } from '../haptics.js';
import { colors, radius, squircle, type } from '../theme.js';
import { useWindowControlsInset } from '../ipad/windowControls.js';
import { monoFamily } from '../monoFont.js';

/**
 * ツール結果に含まれていた画像（Readで読んだスクリーンショット、MCPのスクショ等）の表示。
 *
 * - PC側は画像のメタ情報だけを常時送り、実体はステップを開いたときにだけ取り寄せる
 * - 取れた実体はサムネと全画面ビューアで共有する（同じ画像を二度運ばない）
 * - 全画面は Modal ではなく OverlayPortal に載せる。Modal 内では Liquid Glass の効果が
 *   消えるため（overlayHost.tsx の制約コメント参照）
 */

/** 取り寄せの状態。枠は先に出し、実体が来たら差し替える。 */
export type ImageLoad =
	| { readonly status: 'idle' }
	| { readonly status: 'loading' }
	| { readonly status: 'ready'; readonly uri: string }
	| { readonly status: 'error'; readonly message: string };

/**
 * 一覧のプレビューを自動で取り寄せる上限（デコード後のバイト数）。
 *
 * RN の <Image> は data URI を表示サイズに関係なく原寸でデコードするため、大きな
 * スクリーンショットは 28px のプレビューのために数十MBのビットマップを確保してしまう。
 * PC側で縮小できない（shared process に画像処理が無い）ぶん、ここで線を引き、
 * 大きい画像は開いたときにだけデコードする。
 */
const PREVIEW_AUTOLOAD_MAX_BYTES = 1024 * 1024;

/** カードのプレビューを自動で出してよい画像か。 */
export function isPreviewableToolImage(image: AgentChatImage): boolean {
	return image.oversize !== true && image.bytes <= PREVIEW_AUTOLOAD_MAX_BYTES;
}

/**
 * 画像1枚の取り寄せ。取得済みならキャッシュを即返し、未取得なら1回だけ要求を出す。
 * ステップを開くたびに通信しないよう、結果はモジュール共有のキャッシュへ入れる。
 * `enabled` が false の間は要求を出さない（大きい画像のプレビュー抑止）。
 */
export function useToolImage(terminalKey: string | undefined, rev: number, image: AgentChatImage | undefined, enabled = true): ImageLoad {
	const epoch = useAppStore(state => (terminalKey !== undefined ? state.agentChats.get(terminalKey)?.epoch : undefined));
	const requestImage = useAppStore(state => state.requestAgentToolImage);
	const key = terminalKey !== undefined && epoch !== undefined && image !== undefined
		? toolImageKey(terminalKey, epoch, rev, image.index)
		: undefined;
	const [load, setLoad] = useState<ImageLoad>(() => {
		const cached = key !== undefined ? toolImageCache.get(key) : undefined;
		return cached !== undefined ? { status: 'ready', uri: cached.uri } : { status: 'idle' };
	});
	// 画面から外れた後に届いた応答で state を触らないための世代カウンタ。
	const generation = useRef(0);

	useEffect(() => {
		generation.current++;
		const current = generation.current;
		if (key === undefined || terminalKey === undefined || image === undefined) {
			setLoad({ status: 'idle' });
			return;
		}
		const cached = toolImageCache.get(key);
		if (cached !== undefined) {
			setLoad({ status: 'ready', uri: cached.uri });
			return;
		}
		if (image.oversize === true) {
			setLoad({ status: 'error', message: '大きすぎるため表示できません' });
			return;
		}
		if (!enabled) {
			setLoad({ status: 'idle' });
			return;
		}
		setLoad({ status: 'loading' });
		loadToolImage(key, () => requestImage(terminalKey, rev, image.index))
			.then(result => {
				if (generation.current === current) {
					setLoad({ status: 'ready', uri: result.uri });
				}
			})
			.catch((error: Error) => {
				if (generation.current === current) {
					setLoad({ status: 'error', message: error.message });
				}
			});
		return () => { generation.current++; };
	}, [key, terminalKey, rev, image, requestImage, enabled]);

	return load;
}

/**
 * ファイルカードの左に出す小さなプレビュー。読み込めるまでは枠だけを出し、
 * 失敗しても画像アイコンに戻すだけで、ステップの行の高さは変えない。
 * 状態は呼び出し側（カード）が持つ。1枚につき取り寄せは1回だけにするため。
 */
export function ToolImagePreview({ load, size = 28 }: { load: ImageLoad; size?: number }) {
	return (
		<View style={[styles.thumb, { width: size, height: size, borderRadius: radius.control, ...squircle }]}>
			{load.status === 'ready' ? (
				<Image source={{ uri: load.uri }} style={styles.thumbImage} resizeMode="cover" accessibilityIgnoresInvertColors />
			) : load.status === 'loading' ? (
				<ActivityIndicator size="small" color={colors.textDim} />
			) : (
				<Ionicons name="image-outline" size={Math.round(size * 0.5)} color={load.status === 'error' ? colors.textDim : colors.accent} />
			)}
		</View>
	);
}

/**
 * 全画面の画像ビューア（ツールの結果の画像）。中身の取り寄せだけを持ち、見た目は {@link ImageLightbox}。
 */
export function ToolImageLightbox({ terminalKey, rev, images, initialIndex, title, subtitle, onClose }: {
	terminalKey?: string;
	rev: number;
	images: readonly AgentChatImage[];
	initialIndex: number;
	/** ヘッダーの見出し（ファイル名など）。 */
	title: string;
	/** ヘッダーの副題（ディレクトリなど）。 */
	subtitle?: string;
	onClose: () => void;
}) {
	const [index, setIndex] = useState(() => Math.min(Math.max(0, initialIndex), Math.max(0, images.length - 1)));
	const image = images[index];
	const load = useToolImage(terminalKey, rev, image);
	return (
		<ImageLightbox
			load={load}
			count={images.length}
			index={index}
			onIndexChange={setIndex}
			title={title}
			subtitle={subtitle}
			mediaType={image?.mediaType}
			bytes={image?.bytes}
			onClose={onClose}
		/>
	);
}

/** ビューアの上の帯の右に並べる操作（共有・写真に保存など）。 */
export interface ImageLightboxAction {
	readonly key: string;
	/** Ionicons の名前。 */
	readonly icon: keyof typeof Ionicons.glyphMap;
	readonly label: string;
	/** 実行中（くるくる回して押せなくする）。 */
	readonly busy?: boolean;
	readonly onPress: () => void;
}

/**
 * 全画面の画像ビューアの見た目。ヘッダーとフッターは Liquid Glass で画像の上に浮かせ、
 * 画像自体は等倍で中央に置いてピンチズームできるようにする。
 * OverlayPortal に載せるので、iPad の 2 列でもウィンドウ全体に出る。
 */
export function ImageLightbox({ load, count, index, onIndexChange, title, subtitle, mediaType, bytes, actions, onClose }: {
	/** いま出している 1 枚の取り寄せの状態。 */
	load: ImageLoad;
	/** 何枚あるか（2 枚以上でページャを出す）。 */
	count: number;
	index: number;
	onIndexChange: (index: number) => void;
	title: string;
	subtitle?: string;
	/** ヘッダーの副題に出す種類と容量（分からなければ省く）。 */
	mediaType?: string;
	bytes?: number;
	actions?: readonly ImageLightboxAction[];
	onClose: () => void;
}) {
	// OverlayPortal は Modal ではないため、OSの戻る操作は自前で拾う（既存のポップオーバーと同じ作法）。
	useEffect(() => {
		const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
		return () => subscription.remove();
	}, [onClose]);

	const { width, height } = useWindowDimensions();
	// iPad のウィンドウアプリでは、左上のウィンドウ操作ボタンを避ける（OverlayPortal はウィンドウの左上から描く）。
	const controlsInset = useWindowControlsInset();
	const [natural, setNatural] = useState<{ readonly width: number; readonly height: number } | undefined>(undefined);
	const uri = load.status === 'ready' ? load.uri : undefined;

	// 実寸は画面に収める倍率とヘッダーの寸法表示に使う。取れなくても表示自体は続ける。
	useEffect(() => {
		setNatural(undefined);
		if (uri === undefined) {
			return;
		}
		let cancelled = false;
		Image.getSize(uri, (w, h) => {
			if (!cancelled) {
				setNatural({ width: w, height: h });
			}
		}, () => { /* ignore */ });
		return () => { cancelled = true; };
	}, [uri]);

	const step = useCallback((delta: number) => {
		haptic('tick');
		onIndexChange(Math.min(Math.max(0, index + delta), count - 1));
	}, [count, index, onIndexChange]);

	// 画面いっぱいに収まる大きさへ落とす（縦横比は保つ）。寸法が取れるまでは幅基準で置く。
	const fitted = useMemo(() => {
		const available = { width, height: Math.max(120, height - CHROME_RESERVED_HEIGHT * 2) };
		if (natural === undefined || natural.width <= 0 || natural.height <= 0) {
			return { width: available.width, height: available.height };
		}
		const scale = Math.min(available.width / natural.width, available.height / natural.height);
		return { width: natural.width * scale, height: natural.height * scale };
	}, [natural, width, height]);

	const meta = [
		mediaType !== undefined ? mediaType.replace(/^image\//, '').toUpperCase() : undefined,
		natural !== undefined ? `${natural.width} × ${natural.height}` : undefined,
		bytes !== undefined ? formatImageBytes(bytes) : undefined,
	].filter((part): part is string => part !== undefined && part.length > 0).join(' · ');

	return (
		<OverlayPortal>
			<View style={styles.lightbox}>
				<ScrollView
					style={StyleSheet.absoluteFill}
					contentContainerStyle={styles.stage}
					maximumZoomScale={4}
					minimumZoomScale={1}
					centerContent
					showsVerticalScrollIndicator={false}
					showsHorizontalScrollIndicator={false}
				>
					{uri !== undefined ? (
						<Image source={{ uri }} style={fitted} resizeMode="contain" accessibilityIgnoresInvertColors accessibilityLabel={title} />
					) : load.status === 'error' ? (
						<View style={styles.stageMessage}>
							<Ionicons name="image-outline" size={30} color={colors.textDim} />
							<Text style={styles.stageError}>{load.message}</Text>
						</View>
					) : (
						<ActivityIndicator size="large" color={colors.textDim} />
					)}
				</ScrollView>

				<GlassSurface style={[styles.bar, controlsInset > 0 ? { left: 12 + controlsInset } : undefined]}>
					<Pressable onPress={() => { haptic('move'); onClose(); }} hitSlop={10} accessibilityRole="button" accessibilityLabel="閉じる" style={styles.close}>
						<Ionicons name="close" size={18} color={colors.text} />
					</Pressable>
					<View style={styles.barBody}>
						<Text style={styles.barTitle} numberOfLines={1}>{title}</Text>
						<Text style={styles.barSub} numberOfLines={1} ellipsizeMode="head">
							{[subtitle, meta].filter(part => part !== undefined && part.length > 0).join(' · ')}
						</Text>
					</View>
					{(actions ?? []).map(action => (
						<Pressable
							key={action.key}
							onPress={action.onPress}
							disabled={action.busy === true || uri === undefined}
							hitSlop={8}
							accessibilityRole="button"
							accessibilityLabel={action.label}
							accessibilityState={{ disabled: action.busy === true || uri === undefined, busy: action.busy === true }}
							style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : undefined]}
						>
							{action.busy === true
								? <ActivityIndicator size="small" color={colors.text} />
								: <Ionicons name={action.icon} size={18} color={uri === undefined ? colors.textDim : colors.text} />}
						</Pressable>
					))}
				</GlassSurface>

				{count > 1 ? (
					<GlassSurface style={styles.pager}>
						<Pressable onPress={() => step(-1)} disabled={index === 0} hitSlop={13} accessibilityRole="button" accessibilityLabel="前の画像">
							<Ionicons name="chevron-back" size={18} color={index === 0 ? colors.textDim : colors.text} />
						</Pressable>
						<Text style={styles.pagerText}>{index + 1} / {count}</Text>
						<Pressable onPress={() => step(1)} disabled={index >= count - 1} hitSlop={13} accessibilityRole="button" accessibilityLabel="次の画像">
							<Ionicons name="chevron-forward" size={18} color={index >= count - 1 ? colors.textDim : colors.text} />
						</Pressable>
					</GlassSurface>
				) : null}
			</View>
		</OverlayPortal>
	);
}

/** 上のヘッダー・下のページャが画像に被らないよう、上下に空けておく高さ。 */
const BAR_TOP = 52;
const PAGER_BOTTOM = 46;
const CHROME_RESERVED_HEIGHT = 110;

const styles = StyleSheet.create({
	thumb: { backgroundColor: colors.surface3, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
	thumbImage: { width: '100%', height: '100%' },
	lightbox: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
	stage: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: CHROME_RESERVED_HEIGHT },
	stageMessage: { alignItems: 'center', gap: 10, paddingHorizontal: 32 },
	stageError: { color: colors.textDim, fontSize: type.meta, textAlign: 'center', lineHeight: 19 },
	bar: {
		position: 'absolute', top: BAR_TOP, left: 12, right: 12,
		flexDirection: 'row', alignItems: 'center', gap: 10,
		paddingHorizontal: 12, paddingVertical: 10,
		borderRadius: radius.panel, ...squircle, overflow: 'hidden',
	},
	action: { width: 32, height: 32, borderRadius: radius.pill, ...squircle, alignItems: 'center', justifyContent: 'center' },
	actionPressed: { opacity: 0.6 },
	close: { width: 28, height: 28, borderRadius: radius.pill, ...squircle, backgroundColor: colors.surface3, alignItems: 'center', justifyContent: 'center' },
	barBody: { flex: 1, minWidth: 0 },
	barTitle: { color: colors.text, fontSize: type.body, fontWeight: '600' },
	barSub: { color: colors.textDim, fontSize: type.badge, fontFamily: monoFamily, marginTop: 2 },
	pager: {
		position: 'absolute', bottom: PAGER_BOTTOM, alignSelf: 'center',
		flexDirection: 'row', alignItems: 'center', gap: 14,
		paddingHorizontal: 16, paddingVertical: 9,
		borderRadius: radius.pill, ...squircle, overflow: 'hidden',
	},
	pagerText: { color: colors.text, fontSize: type.meta, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
