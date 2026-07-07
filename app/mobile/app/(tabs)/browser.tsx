// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, GestureResponderEvent, Image, LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { WsBar } from '../../src/components/wsBar.js';
import { colors } from '../../src/theme.js';

/**
 * ブラウザ画面（モックアップ準拠、設計書 M3）。PC側 para-browser の screencast を
 * 同期表示し、タップ・スクロール・戻る/進む/再読み込みを送る。
 */
export default function BrowserScreen() {
	const { browserTargets, browserStart, browserStop, browserInput, frame, connection } = useAppStore(useShallow(s => ({
		browserTargets: s.browserTargets, browserStart: s.browserStart, browserStop: s.browserStop,
		browserInput: s.browserInput, frame: s.browserFrame, connection: s.connection,
	})));

	const [targets, setTargets] = useState<{ targetId: string; title: string; url: string }[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [activeUrl, setActiveUrl] = useState<string | undefined>();
	const [viewSize, setViewSize] = useState({ w: 1, h: 1 });

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
	// （復帰時に古い activeUrl のままスピナーで固まるのを防ぐ）。
	useEffect(() => {
		if (connection !== 'online') {
			setActiveUrl(undefined);
		}
	}, [connection]);

	const start = async (targetId: string, url: string) => {
		setError(undefined);
		try {
			await browserStart(targetId);
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
			<ConnectionGate>
			<View style={styles.screen}>
				<WsBar />
				<ScrollView style={styles.picker} contentContainerStyle={styles.pickerContent}>
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
			</ConnectionGate>
		);
	}

	return (
		<ConnectionGate>
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
			<View style={styles.toolbar}>
				<Pressable style={styles.toolBtn} onPress={() => browserInput({ kind: 'back' })}><Ionicons name="chevron-back" size={17} color={colors.text} /></Pressable>
				<Pressable style={styles.toolBtn} onPress={() => browserInput({ kind: 'forward' })}><Ionicons name="chevron-forward" size={17} color={colors.text} /></Pressable>
				<Pressable style={styles.toolBtn} onPress={() => browserInput({ kind: 'reload' })}><Ionicons name="refresh" size={17} color={colors.text} /></Pressable>
				<Pressable style={styles.toolBtn} onPress={() => browserInput({ kind: 'scroll', dy: -0.5 })}><Ionicons name="chevron-up" size={17} color={colors.text} /></Pressable>
				<Pressable style={styles.toolBtn} onPress={() => browserInput({ kind: 'scroll', dy: 0.5 })}><Ionicons name="chevron-down" size={17} color={colors.text} /></Pressable>
				<Pressable style={[styles.toolBtn, styles.stopBtn]} onPress={() => { void browserStop().then(() => setActiveUrl(undefined)); }}>
					<Text style={styles.toolText}>切替</Text>
				</Pressable>
			</View>
		</View>
		</ConnectionGate>
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
	syncBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,122,204,.12)', borderWidth: 1, borderColor: colors.accent2, borderRadius: 10, marginHorizontal: 12, marginTop: 8, paddingVertical: 8, paddingHorizontal: 12 },
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
