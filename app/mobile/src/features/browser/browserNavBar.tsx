// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ArrowLeftRight, ChevronLeft, ChevronRight, Globe, Image as ImageGlyph, Maximize2, Minimize2, RotateCw, Search, Server, Wifi, X, type LucideIcon } from 'lucide-react-native';
import { Icon } from '../../ui/icon.js';
import { PointerHover } from '../../ipad/pointerHover.js';
import { useThemeColors } from '../../ui/themeColorsStore.js';
import { colors, radius, squircle, type } from '../../theme.js';
import { monoFamily } from '../../monoFont.js';
import { hapticImpact, hapticSelection } from '../../haptics.js';
import { addressHost, addressLabel, type AddressDisplayMode } from '../../browserAddress.js';
import { MIRROR_ROUTE_INFO, type MirrorRoute } from '../../browserRoute.js';
import type { BrowserPopoverAnchor } from './browserListOverlay.js';

/** ボタンの見た目の大きさ（モックの `.m-nb`）。当たり判定は hitSlop で 44 にする。 */
const BUTTON = 36;
const SLOP = { top: 4, bottom: 4, left: 2, right: 2 };

const ROUTE_ICONS: { readonly [R in MirrorRoute]: LucideIcon } = { lan: Wifi, direct: ArrowLeftRight, turn: Server, relay: ImageGlyph };

export function routeColor(route: MirrorRoute): string {
	const tone = MIRROR_ROUTE_INFO[route].tone;
	return tone === 'good' ? colors.green : tone === 'warn' ? colors.amber : colors.textDim;
}

export function RouteGlyph({ route, size = 14 }: { route: MirrorRoute; size?: number }) {
	return <Icon icon={ROUTE_ICONS[route]} size={size} color={routeColor(route)} />;
}

/**
 * ブラウザの上の段（案A）: 戻る・進む・再読み込み（読み込み中は停止）・アドレス・ページ数・全画面。
 *
 * アドレスは既定で題名を出し、長押しで URL の表示と切り替える。押すと URL 全体を選んだ編集になり、確定した
 * 生の文字を `onSubmitAddress` に渡す（URL か検索かは呼び出し側・PC が決める）。左端は接続経路の印
 * （押すと説明）。読み込み中は URL を出し、下端に進み具合の線を引く。
 */
export function BrowserNavBar({
	live, hasPage, canGoBack, canGoForward, loading, progress, route, url, title, displayMode, pageCount, fullscreen,
	onBack, onForward, onReload, onStop, onSubmitAddress, onToggleDisplayMode, onOpenPages, onToggleFullscreen, onRoutePress,
}: {
	live: boolean;
	hasPage: boolean;
	/** 分からなければ `undefined`（押せるままにする）。 */
	canGoBack: boolean | undefined;
	canGoForward: boolean | undefined;
	loading: boolean;
	progress: number;
	route: MirrorRoute | undefined;
	url: string;
	title: string;
	displayMode: AddressDisplayMode;
	pageCount: number;
	fullscreen: boolean;
	onBack: () => void;
	onForward: () => void;
	onReload: () => void;
	/** 停止（受けない PC では `undefined`。読み込み中も再読み込みのまま）。 */
	onStop: (() => void) | undefined;
	onSubmitAddress: (text: string) => void;
	onToggleDisplayMode: () => void;
	onOpenPages: (anchor: BrowserPopoverAnchor) => void;
	onToggleFullscreen: () => void;
	onRoutePress: (route: MirrorRoute) => void;
}) {
	const theme = useThemeColors();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState('');
	const countRef = useRef<View>(null);
	const enabled = live && hasPage;
	const stopping = loading && onStop !== undefined;

	const navButton = (key: string, icon: LucideIcon, label: string, disabled: boolean, onPress: () => void, size = 20) => (
		<PointerHover key={key} effect="highlight" cornerRadius={radius.button}>
			<Pressable
				disabled={disabled}
				hitSlop={SLOP}
				style={({ pressed }) => [styles.button, pressed && styles.pressed, disabled && styles.disabled]}
				onPress={() => { hapticImpact('light'); onPress(); }}
				accessibilityRole="button"
				accessibilityLabel={label}
				accessibilityState={{ disabled }}
			>
				<Icon icon={icon} size={size} color={colors.text} />
			</Pressable>
		</PointerHover>
	);

	const submit = () => {
		const text = draft.trim();
		setEditing(false);
		if (text.length > 0) {
			onSubmitAddress(text);
		}
	};

	const shownUrl = loading || displayMode === 'url';
	const label = addressLabel(url, title, shownUrl ? 'url' : 'title');
	const host = shownUrl ? addressHost(url) : undefined;
	const hostIndex = host !== undefined ? label.toLowerCase().indexOf(host) : -1;

	return (
		<View style={styles.row}>
			{navButton('back', ChevronLeft, '戻る', !enabled || canGoBack === false, onBack)}
			{navButton('forward', ChevronRight, '進む', !enabled || canGoForward === false, onForward)}
			{stopping
				? navButton('stop', X, '読み込みを止める', !enabled, () => onStop?.(), 18)
				: navButton('reload', RotateCw, '再読み込み', !enabled, onReload, 17)}
			<View style={[styles.address, editing && { borderColor: theme.accent }, !enabled && !editing && styles.disabled]}>
				{editing ? (
					<>
						<Icon icon={Search} size={14} color={colors.textDim} />
						<TextInput
							style={styles.addressInput}
							value={draft}
							onChangeText={setDraft}
							onSubmitEditing={submit}
							onBlur={() => setEditing(false)}
							placeholder="URL か検索する言葉"
							placeholderTextColor={colors.textMuted}
							keyboardType="web-search"
							autoCapitalize="none"
							autoCorrect={false}
							spellCheck={false}
							returnKeyType="go"
							selectTextOnFocus
							autoFocus
							accessibilityLabel="URL か検索する言葉"
						/>
						<Pressable hitSlop={10} onPress={() => setDraft('')} accessibilityRole="button" accessibilityLabel="消す">
							<Icon icon={X} size={14} color={colors.textDim} />
						</Pressable>
					</>
				) : (
					<>
						{route !== undefined && hasPage ? (
							<Pressable hitSlop={10} onPress={() => { hapticSelection(); onRoutePress(route); }} accessibilityRole="button" accessibilityLabel={`接続経路: ${MIRROR_ROUTE_INFO[route].label}`}>
								<RouteGlyph route={route} />
							</Pressable>
						) : (
							<Icon icon={Globe} size={13} color={colors.textDim} />
						)}
						<Pressable
							style={styles.addressLabel}
							disabled={!live}
							onPress={() => { hapticSelection(); setDraft(url); setEditing(true); }}
							onLongPress={hasPage ? () => { hapticImpact('light'); onToggleDisplayMode(); } : undefined}
							accessibilityRole="button"
							accessibilityLabel={hasPage ? `${label}。押すと URL を編集、長押しで題名と URL を切り替え` : 'URL を入力'}
						>
							{!hasPage ? (
								<Text style={styles.placeholder} numberOfLines={1}>ページがありません</Text>
							) : shownUrl ? (
								<Text style={styles.urlText} numberOfLines={1}>
									{hostIndex >= 0 && host !== undefined ? (
										<>
											{label.slice(0, hostIndex)}
											<Text style={styles.urlHost}>{label.slice(hostIndex, hostIndex + host.length)}</Text>
											{label.slice(hostIndex + host.length)}
										</>
									) : label}
								</Text>
							) : (
								<Text style={styles.titleText} numberOfLines={1}>{label}</Text>
							)}
						</Pressable>
						{loading ? <View pointerEvents="none" style={[styles.progress, { backgroundColor: theme.accent, width: `${Math.round(Math.max(0.08, Math.min(1, progress)) * 100)}%` }]} /> : null}
					</>
				)}
			</View>
			<PointerHover effect="highlight" cornerRadius={radius.button}>
				<Pressable
					ref={countRef}
					disabled={!live}
					hitSlop={SLOP}
					style={({ pressed }) => [styles.button, pressed && styles.pressed, !live && styles.disabled]}
					onPress={() => {
						hapticSelection();
						countRef.current?.measureInWindow((x, y, width, height) => onOpenPages({ top: y + height, x: x + width, align: 'right' }));
					}}
					accessibilityRole="button"
					accessibilityLabel={`このスペースのページ ${pageCount} 件`}
				>
					<View style={styles.count}>
						<Text style={styles.countText}>{pageCount > 99 ? '99+' : pageCount}</Text>
					</View>
				</Pressable>
			</PointerHover>
			{navButton('fullscreen', fullscreen ? Minimize2 : Maximize2, fullscreen ? '全画面をやめる' : '全画面で見る', !hasPage, onToggleFullscreen, 17)}
		</View>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 6, paddingHorizontal: 8, backgroundColor: colors.bg },
	button: { width: BUTTON, height: BUTTON, borderRadius: radius.button, ...squircle, alignItems: 'center', justifyContent: 'center' },
	pressed: { backgroundColor: colors.raised },
	disabled: { opacity: 0.45 },
	address: {
		flex: 1, minWidth: 0, height: BUTTON, marginHorizontal: 4, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10,
		backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.input, ...squircle, overflow: 'hidden',
	},
	addressLabel: { flex: 1, minWidth: 0, height: '100%', justifyContent: 'center' },
	addressInput: { flex: 1, minWidth: 0, height: '100%', color: colors.text, fontSize: type.label, paddingVertical: 0 },
	titleText: { color: colors.text, fontSize: type.label },
	urlText: { color: colors.textMuted, fontSize: type.meta, fontFamily: monoFamily },
	urlHost: { color: colors.text },
	placeholder: { color: colors.textMuted, fontSize: type.label },
	progress: { position: 'absolute', left: 0, bottom: 0, height: 2 },
	count: { minWidth: 20, height: 20, paddingHorizontal: 3, borderWidth: 1.5, borderColor: colors.text, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
	countText: { color: colors.text, fontSize: type.caption, fontWeight: '700' },
});
