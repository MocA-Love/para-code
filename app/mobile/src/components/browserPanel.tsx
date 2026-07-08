// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, GestureResponderEvent, Image, LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { useTabBarSpacer } from '../hooks/useTabBarSpacer.js';
import { colors } from '../theme.js';

/**
 * ブラウザパネル（モックアップ mock-2.html 準拠、設計書 M3、「その他」タブのセグメント）。
 * PC側 para-browser の screencast を同期表示し、タップ・スクロール・戻る/進む/再読み込みを送る。
 *
 * `active` が false の間（タブがフォーカスを失った、またはセグメントがブラウザでない）は
 * screencast を停止する。ファイル/ブラウザがタブ統合される前は `useIsFocused()` のみで
 * 判定できたが、統合後はタブのfocusとセグメント選択の両方を親（more.tsx）から渡してもらう
 * 必要がある（そうしないとセグメント切替時にscreencastが止まらず電池/帯域を無駄にする）。
 */
export function BrowserPanel({ active }: { active: boolean }) {
	const { browserTargets, browserStart, browserStop, browserInput, frame, connection } = useAppStore(useShallow(s => ({
		browserTargets: s.browserTargets, browserStart: s.browserStart, browserStop: s.browserStop,
		browserInput: s.browserInput, frame: s.browserFrame, connection: s.connection,
	})));

	const tabBarSpacer = useTabBarSpacer();
	const [targets, setTargets] = useState<{ targetId: string; title: string; url: string }[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [activeUrl, setActiveUrl] = useState<string | undefined>();
	const [viewSize, setViewSize] = useState({ w: 1, h: 1 });

	// ミラー中の targetId。ユーザーが明示的に「切替」した時のみ undefined に戻す。
	// active の解除→再有効化の往復では、これが残っていれば同じ targetId でミラーを自動で張り直す。
	const mirrorActiveRef = useRef<string | undefined>(undefined);

	const loadTargets = useCallback(async () => {
		if (connection !== 'online') {
			return;
		}
		setError(undefined);
		try {
			const result = await browserTargets();
			setTargets(result.targets);
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
			setTargets([]);
		}
	}, [browserTargets, connection]);

	// ターゲット一覧の読み込みは接続状態に追従させる。
	useEffect(() => {
		void loadTargets();
	}, [loadTargets]);

	// screencast の停止は画面のアンマウント時にだけ送る。接続の瞬断で
	// loadTargets が作り直されても stop が飛ばないよう、この effect は依存を持たず
	// browserStop は ref 経由で参照する（再接続時にミラーが止まる不具合の防止）。
	const browserStopRef = useRef(browserStop);
	browserStopRef.current = browserStop;
	useEffect(() => {
		return () => { void browserStopRef.current(); };
	}, []);

	// 接続が切れたらミラー表示を畳んでターゲット選択に戻す
	// （復帰時に古い activeUrl のままスピナーで固まるのを防ぐ）。ミラー中フラグも落として、
	// 再接続後に裏で勝手に張り直さない（既存の「再選択させる」挙動を維持する）。
	useEffect(() => {
		if (connection !== 'online') {
			mirrorActiveRef.current = undefined;
			setActiveUrl(undefined);
		}
	}, [connection]);

	// active の解除/有効化で screencast を止め／再開する（バッテリー対策）。
	// 解除時は最後のフレームを残したまま停止し（browserStop(true)）、再有効化時はミラーが
	// 有効だった場合のみ同じ targetId で張り直す。ユーザーには静止画→最新画面の自然な
	// 切り替えだけが見え、空白やスピナーは出さない。ミラー未開始時は何もしない。
	useEffect(() => {
		if (connection !== 'online' || mirrorActiveRef.current === undefined) {
			return;
		}
		if (active) {
			void browserStart(mirrorActiveRef.current).catch(() => undefined);
		} else {
			void browserStop(true);
		}
	}, [active, connection, browserStart, browserStop]);

	const start = async (targetId: string, url: string) => {
		setError(undefined);
		try {
			await browserStart(targetId);
			mirrorActiveRef.current = targetId;
			setActiveUrl(url);
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		}
	};

	const onLayout = (e: LayoutChangeEvent) => {
		setViewSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
	};

	const onTap = (e: GestureResponderEvent) => {
		if (!frame || frame.w === 0 || frame.h === 0) {
			return;
		}
		const scale = Math.min(viewSize.w / frame.w, viewSize.h / frame.h);
		const drawnW = frame.w * scale;
		const drawnH = frame.h * scale;
		const offsetX = (viewSize.w - drawnW) / 2;
		const offsetY = (viewSize.h - drawnH) / 2;
		const nx = (e.nativeEvent.locationX - offsetX) / drawnW;
		const ny = (e.nativeEvent.locationY - offsetY) / drawnH;
		if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
			browserInput({ kind: 'tap', nx, ny });
		}
	};

	if (activeUrl === undefined) {
		return (
			<View style={styles.screen}>
				<ScrollView style={styles.picker} contentContainerStyle={[styles.pickerContent, { paddingBottom: tabBarSpacer }]}>
					<Text style={styles.sectionTitle}>ミラーするページを選択</Text>
					{error ? <Text style={styles.error}>{error}</Text> : null}
					{targets === undefined ? <ActivityIndicator style={styles.spinner} /> : null}
					{targets && targets.length === 0 ? (
						<Text style={styles.dim}>ミラーできるブラウザページがありません。PCの para-browser でページを開いてください。</Text>
					) : null}
					{(targets ?? []).map(t => (
						<Pressable key={t.targetId} style={styles.targetRow} onPress={() => { void start(t.targetId, t.url); }}>
							<Text style={styles.targetTitle} numberOfLines={1}>{t.title || '(無題)'}</Text>
							<Text style={styles.targetUrl} numberOfLines={1}>{t.url}</Text>
						</Pressable>
					))}
					<Pressable style={styles.reloadTargets} onPress={() => { void loadTargets(); }}>
						<Text style={styles.link}>一覧を更新</Text>
					</Pressable>
				</ScrollView>
			</View>
		);
	}

	return (
		<View style={styles.screen}>
			<View style={styles.syncBanner}>
				<Ionicons name="link-outline" size={13} color={colors.accent} />
				<Text style={styles.syncText}>PCのPara Codeブラウザビューと同期中</Text>
			</View>
			<View style={styles.urlBar}>
				<Ionicons name="globe-outline" size={13} color={colors.textDim} />
				<Text style={styles.urlText} numberOfLines={1}>{activeUrl.replace(/^https?:\/\//, '')}</Text>
			</View>
			{/* ピンチで拡大縮小・ドラッグでパンできるようScrollViewズームに載せる。
			    タップ座標は子ビューのローカル座標系（ズーム非依存）なのでマッピングはそのまま有効 */}
			<ScrollView
				style={styles.viewport}
				onLayout={onLayout}
				minimumZoomScale={1}
				maximumZoomScale={5}
				bouncesZoom
				showsHorizontalScrollIndicator={false}
				showsVerticalScrollIndicator={false}
				contentContainerStyle={{ width: viewSize.w, height: viewSize.h }}
			>
				{frame ? (
					<Pressable style={styles.frameWrap} onPress={onTap}>
						<Image
							source={{ uri: `data:image/jpeg;base64,${frame.data}` }}
							style={styles.frameImage}
							resizeMode="contain"
							fadeDuration={0}
						/>
					</Pressable>
				) : (
					<View style={styles.center}><ActivityIndicator /><Text style={styles.dim}>フレームを待っています…</Text></View>
				)}
			</ScrollView>
			<View style={[styles.toolbar, { paddingBottom: tabBarSpacer }]}>
				<Pressable style={styles.toolBtn} onPress={() => browserInput({ kind: 'back' })}><Ionicons name="chevron-back" size={17} color={colors.text} /></Pressable>
				<Pressable style={styles.toolBtn} onPress={() => browserInput({ kind: 'forward' })}><Ionicons name="chevron-forward" size={17} color={colors.text} /></Pressable>
				<Pressable style={styles.toolBtn} onPress={() => browserInput({ kind: 'reload' })}><Ionicons name="refresh" size={17} color={colors.text} /></Pressable>
				<Pressable style={styles.toolBtn} onPress={() => browserInput({ kind: 'scroll', dy: -0.5 })}><Ionicons name="chevron-up" size={17} color={colors.text} /></Pressable>
				<Pressable style={styles.toolBtn} onPress={() => browserInput({ kind: 'scroll', dy: 0.5 })}><Ionicons name="chevron-down" size={17} color={colors.text} /></Pressable>
				<Pressable style={[styles.toolBtn, styles.stopBtn]} onPress={() => { mirrorActiveRef.current = undefined; void browserStop().then(() => setActiveUrl(undefined)); }}>
					<Text style={styles.toolText}>切替</Text>
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	picker: { flex: 1 },
	pickerContent: { padding: 16 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginBottom: 12, letterSpacing: 0.5 },
	spinner: { marginTop: 24 },
	dim: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 16, lineHeight: 20 },
	error: { color: colors.red, fontSize: 12, marginBottom: 8 },
	targetRow: { backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 10 },
	targetTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
	targetUrl: { color: colors.textDim, fontSize: 11, marginTop: 3 },
	reloadTargets: { alignItems: 'center', marginTop: 8 },
	link: { color: colors.accent, fontSize: 13 },
	syncBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(9,175,217,.12)', borderWidth: 1, borderColor: colors.accent2, borderRadius: 10, marginHorizontal: 12, marginTop: 8, paddingVertical: 8, paddingHorizontal: 12 },
	syncText: { color: colors.accent, fontSize: 12 },
	urlBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, marginHorizontal: 12, marginTop: 8, paddingVertical: 8, paddingHorizontal: 12 },
	urlText: { color: colors.text, fontSize: 12, fontFamily: 'Menlo' },
	viewport: { flex: 1, margin: 12, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' },
	frameWrap: { flex: 1 },
	frameImage: { flex: 1 },
	center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
	toolbar: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingBottom: 10, paddingHorizontal: 12, gap: 8 },
	toolBtn: { flex: 1, alignItems: 'center', paddingVertical: 9, backgroundColor: colors.panel, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
	stopBtn: { borderColor: 'rgba(244,135,113,.4)' },
	toolText: { color: colors.text, fontSize: 15 },
});
