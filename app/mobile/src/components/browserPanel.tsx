// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ComponentType, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, GestureResponderEvent, Image, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { useTabBarSpacer } from '../hooks/useTabBarSpacer.js';
import { getRtcView, startWebrtcMirror, WebrtcMirrorSession } from '../webrtcMirror.js';
import { colors } from '../theme.js';

/** RTCView（react-native-webrtc）。未リンクのビルドでは undefined（JPEGミラーのみ）。 */
const RTCViewComponent = getRtcView() as ComponentType<{
	streamURL: string;
	style?: object;
	objectFit?: string;
	/** 描画中の映像テクスチャの実寸法が変わると発火（タップ座標マッピングの正）。 */
	onDimensionsChange?: (e: { nativeEvent: { width: number; height: number } }) => void;
}> | undefined;

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
	const { browserTargets, browserStart, browserStop, browserInput, frame, connection, setJpegFramesSuspended } = useAppStore(useShallow(s => ({
		browserTargets: s.browserTargets, browserStart: s.browserStart, browserStop: s.browserStop,
		browserInput: s.browserInput, frame: s.browserFrame, connection: s.connection,
		setJpegFramesSuspended: s.setJpegFramesSuspended,
	})));

	const tabBarSpacer = useTabBarSpacer();
	const [targets, setTargets] = useState<{ targetId: string; title: string; url: string }[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [activeUrl, setActiveUrl] = useState<string | undefined>();
	const [viewSize, setViewSize] = useState({ w: 1, h: 1 });

	// ミラー中の targetId。ユーザーが明示的に「切替」した時のみ undefined に戻す。
	// active の解除→再有効化の往復では、これが残っていれば同じ targetId でミラーを自動で張り直す。
	const mirrorActiveRef = useRef<string | undefined>(undefined);

	// WebRTCミラー（低遅延経路）。確立できたら RTCView 表示、失敗・切断時は
	// 既存のJPEGフレーム表示へ自動フォールバックする（JPEGは並行して流れ続けている）。
	const webrtcSessionRef = useRef<WebrtcMirrorSession | undefined>(undefined);
	// 確立中(await中)に stop/切替/非active化が起きた場合に、解決後のセッションを
	// 復活させないための世代トークン。stopWebrtc / tryWebrtc のたびに進める。
	const webrtcGenRef = useRef(0);
	const [webrtcUrl, setWebrtcUrl] = useState<string | undefined>();
	// RTCView が実際に描画している映像の実寸法（onDimensionsChange で更新）。
	// タップ/スワイプの座標計算はこれを最優先で使う。PC側リサイズの途中でも
	// 「描画されている映像そのもの」の寸法なので、表示と計算が絶対にずれない。
	const webrtcDimsRef = useRef<{ w: number; h: number } | undefined>(undefined);
	const stopWebrtc = useCallback(() => {
		webrtcGenRef.current++;
		webrtcSessionRef.current?.stop();
		webrtcSessionRef.current = undefined;
		webrtcDimsRef.current = undefined;
		setWebrtcUrl(undefined);
	}, []);
	const tryWebrtc = useCallback(async (targetId: string) => {
		if (RTCViewComponent === undefined) {
			return; // このビルドにはネイティブモジュールが無い
		}
		webrtcSessionRef.current?.stop();
		webrtcSessionRef.current = undefined;
		webrtcDimsRef.current = undefined; // 旧セッションの映像寸法をJPEGの座標計算に残さない
		const gen = ++webrtcGenRef.current;
		try {
			const session = await startWebrtcMirror(targetId);
			if (gen !== webrtcGenRef.current) {
				session.stop(); // 確立中に stop/切替された（古い世代）→ 即破棄
				return;
			}
			webrtcSessionRef.current = session;
			session.onClosed(() => {
				if (webrtcSessionRef.current === session) {
					webrtcSessionRef.current = undefined;
					webrtcDimsRef.current = undefined;
					setWebrtcUrl(undefined);
				}
			});
			webrtcDimsRef.current = undefined; // 初回 onDimensionsChange まではJPEGフレーム寸法で代用
			setWebrtcUrl(session.streamUrl);
		} catch (e) {
			console.log('[browser] webrtc unavailable, falling back to JPEG mirror:', e instanceof Error ? e.message : e);
			if (gen === webrtcGenRef.current) {
				setWebrtcUrl(undefined);
			}
		}
	}, []);

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
	const stopWebrtcRef = useRef(stopWebrtc);
	stopWebrtcRef.current = stopWebrtc;
	useEffect(() => {
		return () => {
			stopWebrtcRef.current();
			void browserStopRef.current();
		};
	}, []);

	// WebRTC表示中はJPEGフレームの受信処理を止める（表示に使わない数百KB/フレームの
	// フルパースがJSスレッドを飽和させ、タップ・画面切替が遅くなるのを防ぐ）。
	// WebRTCが切断されたら自動で再開し、並走しているJPEGへ継ぎ目なく戻る。
	useEffect(() => {
		setJpegFramesSuspended(webrtcUrl !== undefined);
		return () => setJpegFramesSuspended(false);
	}, [webrtcUrl, setJpegFramesSuspended]);

	// 接続が切れたらミラー表示を畳んでターゲット選択に戻す
	// （復帰時に古い activeUrl のままスピナーで固まるのを防ぐ）。ミラー中フラグも落として、
	// 再接続後に裏で勝手に張り直さない（既存の「再選択させる」挙動を維持する）。
	useEffect(() => {
		if (connection !== 'online') {
			mirrorActiveRef.current = undefined;
			setActiveUrl(undefined);
			stopWebrtc();
		}
	}, [connection, stopWebrtc]);

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
			void tryWebrtc(mirrorActiveRef.current);
		} else {
			stopWebrtc();
			void browserStop(true);
		}
	}, [active, connection, browserStart, browserStop, tryWebrtc, stopWebrtc]);

	const start = async (targetId: string, url: string) => {
		setError(undefined);
		try {
			await browserStart(targetId);
			mirrorActiveRef.current = targetId;
			setActiveUrl(url);
			void tryWebrtc(targetId);
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		}
	};

	const onLayout = (e: LayoutChangeEvent) => {
		setViewSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
	};

	// URL欄の編集値。ミラー対象の切り替えで追従させ、確定(go)でPC側へ遷移を送る。
	const [urlInput, setUrlInput] = useState('');
	useEffect(() => {
		setUrlInput(activeUrl ?? '');
	}, [activeUrl]);
	const navigate = () => {
		const raw = urlInput.trim();
		if (raw.length === 0) {
			return;
		}
		const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
		browserInput({ kind: 'navigate', url });
		setActiveUrl(url);
	};

	const frameRef = useRef(frame);
	frameRef.current = frame;
	// 巨大なdata URI文字列の再生成はフレームが変わった時だけにする（他要因の再レンダーで
	// RN Imageに新しいsourceオブジェクトを渡して再デコードさせない）
	const frameSource = useMemo(() => frame ? { uri: `data:image/jpeg;base64,${frame.data}` } : undefined, [frame]);
	const viewSizeRef = useRef(viewSize);
	viewSizeRef.current = viewSize;

	// 座標計算に使う「表示中コンテンツ」の寸法。WebRTC表示中は RTCView が実際に描画
	// している映像寸法（onDimensionsChange）、JPEG表示中は表示中フレーム自身の寸法。
	// どちらも「画面に映っているものそのもの」なので、PC側リサイズの伝搬中でもずれない。
	const contentDims = (): { w: number; h: number } | undefined => {
		const d = webrtcDimsRef.current ?? (frameRef.current && frameRef.current.w > 0 && frameRef.current.h > 0
			? { w: frameRef.current.w, h: frameRef.current.h }
			: undefined);
		return d && d.w > 0 && d.h > 0 ? d : undefined;
	};
	const contentDimsRef = useRef(contentDims);
	contentDimsRef.current = contentDims;

	const onTap = (e: GestureResponderEvent) => {
		const dims = contentDimsRef.current();
		if (!dims) {
			return;
		}
		const scale = Math.min(viewSize.w / dims.w, viewSize.h / dims.h);
		const drawnW = dims.w * scale;
		const drawnH = dims.h * scale;
		const offsetX = (viewSize.w - drawnW) / 2;
		const offsetY = (viewSize.h - drawnH) / 2;
		const nx = (e.nativeEvent.locationX - offsetX) / drawnW;
		const ny = (e.nativeEvent.locationY - offsetY) / drawnH;
		if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
			browserInput({ kind: 'tap', nx, ny });
		}
	};

	// タップ検出はresponder獲得に依存しない生の onTouchStart/End/Cancel で行う。
	// ズーム中はScrollViewがパン/ピンチのresponderを奪うため、PanResponderのrelease
	// 経由ではタップが一切届かない（ピンチ後にタップが効かなくなる不具合の原因）。
	// touchイベントは責任の所在と無関係に子ビューへ届くので、ズーム状態に依存しない。
	// 移動量の判定は pageX/Y（画面座標）で行う: ズームパン中はコンテンツが指に追従して
	// 動くため、ローカル座標だと変位がほぼ0になりパン終了を誤タップしてしまう。
	const tapCandidateRef = useRef<{ pageX: number; pageY: number } | undefined>(undefined);
	const onFrameTouchStart = (e: GestureResponderEvent) => {
		if (e.nativeEvent.touches.length === 1) {
			tapCandidateRef.current = { pageX: e.nativeEvent.pageX, pageY: e.nativeEvent.pageY };
		} else {
			tapCandidateRef.current = undefined; // ピンチ等のマルチタッチはタップにしない
		}
	};
	const onFrameTouchCancel = () => {
		tapCandidateRef.current = undefined; // ネイティブのスクロール/ズームに移行した
	};
	const onFrameTouchEnd = (e: GestureResponderEvent) => {
		const start = tapCandidateRef.current;
		tapCandidateRef.current = undefined;
		if (!start || e.nativeEvent.touches.length > 0) {
			return; // マルチタッチ経由、またはまだ指が残っている
		}
		if (Math.abs(e.nativeEvent.pageX - start.pageX) < 8 && Math.abs(e.nativeEvent.pageY - start.pageY) < 8) {
			onTap(e);
		}
	};

	// スワイプでPC側ページをスクロールする。ズーム中（zoomScale>1）はScrollViewのパンに
	// 譲るため捕捉しない（タップは上記のtouchハンドラが常時拾う）。
	// 描画中のコンテンツ寸法・ビュー寸法はrefで参照する（PanResponderはマウント時に固定されるため）。
	const zoomScaleRef = useRef(1);
	const browserInputRef = useRef(browserInput);
	browserInputRef.current = browserInput;
	const onZoomScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
		zoomScaleRef.current = e.nativeEvent.zoomScale ?? 1;
	};
	const panResponder = useMemo(() => {
		// 前回moveまでの累積移動量（送信済みぶんを差し引くための基準）
		let lastX = 0;
		let lastY = 0;
		let moved = false;
		const drawnSize = () => {
			const dims = contentDimsRef.current();
			const v = viewSizeRef.current;
			if (!dims) {
				return undefined;
			}
			const scale = Math.min(v.w / dims.w, v.h / dims.h);
			return { w: dims.w * scale, h: dims.h * scale };
		};
		return PanResponder.create({
			// タップも拾うため開始時から責任を持つ（ズーム中とマルチタッチはScrollViewへ譲る）
			onStartShouldSetPanResponder: () => zoomScaleRef.current <= 1.01,
			onMoveShouldSetPanResponder: (_e, g) => zoomScaleRef.current <= 1.01 && g.numberActiveTouches === 1,
			onPanResponderGrant: () => {
				lastX = 0;
				lastY = 0;
				moved = false;
			},
			onPanResponderMove: (_e, g) => {
				if (g.numberActiveTouches !== 1) {
					return;
				}
				if (!moved && Math.abs(g.dx) < 8 && Math.abs(g.dy) < 8) {
					return; // まだタップの可能性がある
				}
				moved = true;
				const drawn = drawnSize();
				if (!drawn) {
					return;
				}
				const stepX = g.dx - lastX;
				const stepY = g.dy - lastY;
				lastX = g.dx;
				lastY = g.dy;
				// 指の移動と同方向にコンテンツが動く自然なスクロール（指を下へ→ページは上へ戻る）
				const dx = -stepX / drawn.w;
				const dy = -stepY / drawn.h;
				if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
					browserInputRef.current({ kind: 'scroll', dx, dy });
				}
			},
			// タップの発火は onFrameTouchEnd 側が担う（responder獲得に依存しないため、
			// ここでのrelease処理は不要。二重発火させない）
		});
	}, []);

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
			<View style={styles.urlBar}>
				<Ionicons name="globe-outline" size={13} color={colors.textDim} />
				<TextInput
					style={styles.urlInput}
					value={urlInput}
					onChangeText={setUrlInput}
					onSubmitEditing={navigate}
					placeholder="URLを入力…"
					placeholderTextColor={colors.textDim}
					keyboardType="url"
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="go"
					selectTextOnFocus
				/>
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
				onScroll={onZoomScroll}
				onScrollEndDrag={onZoomScroll}
				onMomentumScrollEnd={onZoomScroll}
				scrollEventThrottle={100}
			>
				{webrtcUrl !== undefined && RTCViewComponent !== undefined ? (
					<View style={styles.frameWrap} {...panResponder.panHandlers} onTouchStart={onFrameTouchStart} onTouchEnd={onFrameTouchEnd} onTouchCancel={onFrameTouchCancel}>
						<RTCViewComponent
							streamURL={webrtcUrl}
							style={styles.frameImage}
							objectFit="contain"
							onDimensionsChange={e => {
								const { width, height } = e.nativeEvent;
								webrtcDimsRef.current = width > 0 && height > 0 ? { w: width, h: height } : undefined;
							}}
						/>
					</View>
				) : frameSource ? (
					<View style={styles.frameWrap} {...panResponder.panHandlers} onTouchStart={onFrameTouchStart} onTouchEnd={onFrameTouchEnd} onTouchCancel={onFrameTouchCancel}>
						<Image
							source={frameSource}
							style={styles.frameImage}
							resizeMode="contain"
							fadeDuration={0}
						/>
					</View>
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
				<Pressable style={[styles.toolBtn, styles.stopBtn]} onPress={() => { mirrorActiveRef.current = undefined; stopWebrtc(); void browserStop().then(() => setActiveUrl(undefined)); }}>
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
	urlBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, marginHorizontal: 12, marginTop: 8, paddingVertical: 4, paddingHorizontal: 12 },
	urlInput: { flex: 1, color: colors.text, fontSize: 12, fontFamily: 'Menlo', paddingVertical: 6 },
	viewport: { flex: 1, margin: 12, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' },
	frameWrap: { flex: 1 },
	frameImage: { flex: 1 },
	center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
	toolbar: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingBottom: 10, paddingHorizontal: 12, gap: 8 },
	toolBtn: { flex: 1, alignItems: 'center', paddingVertical: 9, backgroundColor: colors.panel, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
	stopBtn: { borderColor: 'rgba(244,135,113,.4)' },
	toolText: { color: colors.text, fontSize: 15 },
});
