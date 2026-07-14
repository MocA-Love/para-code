// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ComponentType, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, GestureResponderEvent, Image, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { getRtcView, startWebrtcMirror, WebrtcMirrorSession } from '../webrtcMirror.js';
import { colors } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';

/** RTCView（react-native-webrtc）。未リンクのビルドでは undefined（JPEGミラーのみ）。 */
const RTCViewComponent = getRtcView() as ComponentType<{
	streamURL: string;
	style?: object;
	objectFit?: string;
	/** 描画中の映像テクスチャの実寸法が変わると発火（タップ座標マッピングの正）。 */
	onDimensionsChange?: (e: { nativeEvent: { width: number; height: number } }) => void;
}> | undefined;

/** targets 応答の1件（PC側 paradisMobileBrowserMirror.ts の応答と一致）。 */
interface BrowserTarget {
	targetId: string;
	title: string;
	url: string;
	/** そのページを共有中のターミナルペインのトークン（未共有ページには無い）。 */
	sharedToken?: string;
}

/**
 * ブラウザパネル（設計書 M3。/browser スタック画面の本体、旧ブラウザタブから移設）。
 * PC側 para-browser の screencast を同期表示し、タップ・スクロール・戻る/進む/再読み込みを送る。
 *
 * ページ選択は上部のタブチップで行う。ターゲット一覧の取得後は自動でミラーを開始する:
 * `preferredToken`（エージェント詳細から渡されるペイントークン）と共有中のページがあれば
 * それを優先し、無ければ先頭のページを選ぶ。
 *
 * `active` が false の間（画面がフォーカスを失った間）は screencast を停止する。
 */
export function BrowserPanel({ active, preferredToken }: { active: boolean; preferredToken?: string }) {
	const { browserTargets, browserStart, browserStop, browserInput, frame, connection, pcOnline, sessionProtocolReady, setJpegFramesSuspended, workspace, browserSelection, setBrowserSelection } = useAppStore(useShallow(s => ({
		browserTargets: s.browserTargets, browserStart: s.browserStart, browserStop: s.browserStop,
		browserInput: s.browserInput, frame: s.browserFrame, connection: s.connection,
		pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady,
		setJpegFramesSuspended: s.setJpegFramesSuspended, workspace: s.workspace,
		browserSelection: s.browserSelection, setBrowserSelection: s.setBrowserSelection,
	})));
	const live = connection === 'online' && pcOnline && sessionProtocolReady;
	const cachedSelection = browserSelection;
	const cachedTargetIsCurrent = cachedSelection?.desktopEpoch === workspace?.desktopEpoch;
	const liveRef = useRef(live);
	liveRef.current = live;
	const activeRef = useRef(active);
	activeRef.current = active;
	const workspaceEpochRef = useRef(workspace?.desktopEpoch);
	workspaceEpochRef.current = workspace?.desktopEpoch;

	const insets = useStableInsets();
	const [targets, setTargets] = useState<BrowserTarget[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [activeUrl, setActiveUrl] = useState<string | undefined>(cachedSelection?.url);
	const [activeTargetId, setActiveTargetId] = useState<string | undefined>(cachedSelection?.targetId);
	const [viewSize, setViewSize] = useState({ w: 1, h: 1 });

	// ミラー中の targetId。ユーザーがチップで切り替えた時は新しい targetId に張り替える。
	// active の解除→再有効化の往復では、これが残っていれば同じ targetId でミラーを自動で張り直す。
	const mirrorActiveRef = useRef<string | undefined>(cachedTargetIsCurrent ? cachedSelection?.targetId : undefined);
	// ターゲット一覧到着時の自動ミラー開始を発火済みか（マウントごと・再接続ごとに1回だけ）。
	const autoStartedRef = useRef(false);
	const browserStartGenRef = useRef(0);
	const targetLoadGenRef = useRef(0);
	const targetsEpochRef = useRef<string | undefined>();

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
			console.warn('[browser] webrtc unavailable, falling back to JPEG mirror:', e instanceof Error ? e.message : e);
			if (gen === webrtcGenRef.current) {
				setWebrtcUrl(undefined);
			}
		}
	}, []);

	const loadTargets = useCallback(async () => {
		if (!live) {
			return;
		}
		const gen = ++targetLoadGenRef.current;
		const requestEpoch = workspace?.desktopEpoch;
		setError(undefined);
		try {
			const result = await browserTargets();
			if (targetLoadGenRef.current !== gen || !liveRef.current || requestEpoch !== workspaceEpochRef.current) {
				return;
			}
			const currentTarget = mirrorActiveRef.current;
			if (currentTarget !== undefined && !result.targets.some(target => target.targetId === currentTarget)) {
				mirrorActiveRef.current = undefined;
					autoStartedRef.current = false;
			}
			targetsEpochRef.current = requestEpoch;
			setTargets(result.targets);
		} catch (e) {
			if (targetLoadGenRef.current === gen) {
				setError(String(e instanceof Error ? e.message : e));
				setTargets(current => current ?? []);
			}
		}
	}, [browserTargets, live, workspace?.desktopEpoch]);

	// ターゲット一覧の読み込みは接続状態に追従させる。
	useEffect(() => {
		void loadTargets();
	}, [loadTargets]);

	const desktopEpochRef = useRef(workspace?.desktopEpoch);
	useEffect(() => {
		const previous = desktopEpochRef.current;
		desktopEpochRef.current = workspace?.desktopEpoch;
		if (previous === undefined || workspace?.desktopEpoch === undefined || previous === workspace.desktopEpoch) {
			return;
		}
		// PC再起動後は旧target IDを再利用しない。最後のURL/JPEGは新targetが開始するまで残す。
		browserStartGenRef.current++;
		targetLoadGenRef.current++;
		targetsEpochRef.current = undefined;
		stopWebrtc();
		mirrorActiveRef.current = undefined;
		autoStartedRef.current = false;
		setTargets(undefined);
		void loadTargets();
	}, [workspace?.desktopEpoch, loadTargets, stopWebrtc]);

	// screencast の停止は画面のアンマウント時にだけ送る。接続の瞬断で
	// loadTargets が作り直されても stop が飛ばないよう、この effect は依存を持たず
	// browserStop は ref 経由で参照する（再接続時にミラーが止まる不具合の防止）。
	const browserStopRef = useRef(browserStop);
	browserStopRef.current = browserStop;
	const stopWebrtcRef = useRef(stopWebrtc);
	stopWebrtcRef.current = stopWebrtc;
	useEffect(() => {
		return () => {
			browserStartGenRef.current++;
			targetLoadGenRef.current++;
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

	// 接続断では低遅延セッションだけ閉じ、最後のURL・target・JPEGフレームは保持する。
	useEffect(() => {
		if (!live) {
			browserStartGenRef.current++;
			targetLoadGenRef.current++;
			stopWebrtc();
		}
	}, [live, stopWebrtc]);

	// active の解除/有効化で screencast を止め／再開する（バッテリー対策）。
	// 解除時は最後のフレームを残したまま停止し（browserStop(true)）、再有効化時はミラーが
	// 有効だった場合のみ同じ targetId で張り直す。ユーザーには静止画→最新画面の自然な
	// 切り替えだけが見え、空白やスピナーは出さない。ミラー未開始時は何もしない。
	useEffect(() => {
		if (!live || mirrorActiveRef.current === undefined) {
			return;
		}
		if (active) {
			const targetId = mirrorActiveRef.current;
			const gen = ++browserStartGenRef.current;
			void browserStart(targetId).then(() => {
				if (browserStartGenRef.current === gen && liveRef.current && activeRef.current && mirrorActiveRef.current === targetId) {
					void tryWebrtc(targetId);
				}
			}).catch(() => {
				if (browserStartGenRef.current === gen && mirrorActiveRef.current === targetId) {
					mirrorActiveRef.current = undefined;
					autoStartedRef.current = false;
					void loadTargets();
				}
			});
		} else {
			browserStartGenRef.current++;
			stopWebrtc();
			void browserStop(true);
		}
	}, [active, live, browserStart, browserStop, tryWebrtc, stopWebrtc, loadTargets]);

	const start = async (targetId: string, url: string) => {
		const gen = ++browserStartGenRef.current;
		const startEpoch = workspaceEpochRef.current;
		setError(undefined);
		try {
			await browserStart(targetId);
			if (browserStartGenRef.current !== gen || !liveRef.current || !activeRef.current || startEpoch !== workspaceEpochRef.current) {
				return;
			}
			mirrorActiveRef.current = targetId;
			setActiveUrl(url);
			setActiveTargetId(targetId);
			if (workspace !== undefined) {
				setBrowserSelection({ targetId, url, desktopEpoch: workspace.desktopEpoch });
			}
			void tryWebrtc(targetId);
		} catch (e) {
			if (browserStartGenRef.current === gen) {
				mirrorActiveRef.current = undefined;
				autoStartedRef.current = false;
				setError(String(e instanceof Error ? e.message : e));
			}
		}
	};

	// ターゲット一覧が届いたら自動でミラーを開始する（画面を開いてすぐ見える状態にする）。
	// preferredToken と共有中のページを最優先、無ければ先頭。ユーザーがチップで切り替えた後や
	// 一覧の再取得では発火しない（autoStartedRef、マウントごと・再接続ごとに1回だけ）。
	useEffect(() => {
		if (autoStartedRef.current || !active || !live || mirrorActiveRef.current !== undefined
			|| targetsEpochRef.current !== workspace?.desktopEpoch) {
			return;
		}
		const candidate = (preferredToken !== undefined ? targets?.find(t => t.sharedToken === preferredToken) : undefined) ?? targets?.[0];
		if (candidate === undefined) {
			return;
		}
		autoStartedRef.current = true;
		void start(candidate.targetId, candidate.url);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [targets, active, live, preferredToken, workspace?.desktopEpoch]);

	// チップ表示用: 共有トークン → ターミナルタイトル（「2: claude と共有中」の表示に使う）
	const terminalTitleOf = (token: string | undefined): string | undefined => {
		if (token === undefined) {
			return undefined;
		}
		return workspace?.terminals.find(t => t.agentToken === token)?.title;
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
		if (activeTargetId !== undefined && workspace !== undefined) {
			setBrowserSelection({ targetId: activeTargetId, url, desktopEpoch: workspace.desktopEpoch });
		}
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
		if (!liveRef.current) {
			return;
		}
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
		if (liveRef.current && e.nativeEvent.touches.length === 1) {
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
			onStartShouldSetPanResponder: () => liveRef.current && zoomScaleRef.current <= 1.01,
			onMoveShouldSetPanResponder: (_e, g) => liveRef.current && zoomScaleRef.current <= 1.01 && g.numberActiveTouches === 1,
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

	// 上部のタブチップ: ミラー対象の切り替え。共有中のページはリンクアイコン＋ターミナル名で示す
	const chipLabel = (t: BrowserTarget): string => {
		const shared = terminalTitleOf(t.sharedToken);
		const title = t.title || t.url.replace(/^https?:\/\//, '') || '(無題)';
		return shared !== undefined ? `${shared} · ${title}` : title;
	};
	const tabStrip = targets !== undefined && targets.length > 0 ? (
		<View style={styles.tabStripWrap}>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabStripContent}>
				{targets.map(t => {
					const selected = t.targetId === activeTargetId;
					const shared = t.sharedToken !== undefined;
					return (
						<Pressable
							key={t.targetId}
							disabled={!live}
							style={[styles.tabChip, selected && styles.tabChipSelected]}
							onPress={() => {
								if (t.targetId === activeTargetId && mirrorActiveRef.current === t.targetId) {
									return;
								}
								hapticSelection();
								void start(t.targetId, t.url);
							}}
						>
							{shared ? <Ionicons name="link" size={11} color={selected ? colors.accent : colors.green} /> : null}
							<Text style={[styles.tabChipText, selected && styles.tabChipTextSelected]} numberOfLines={1}>{chipLabel(t)}</Text>
						</Pressable>
					);
				})}
				<Pressable disabled={!live} style={[styles.tabChip, !live && styles.disabled]} onPress={() => { hapticImpact('light'); autoStartedRef.current = false; void loadTargets(); }} accessibilityLabel="一覧を更新">
					<Ionicons name="refresh" size={12} color={colors.textDim} />
				</Pressable>
			</ScrollView>
		</View>
	) : null;

	if (activeUrl === undefined) {
		return (
			<View style={styles.screen}>
				{tabStrip}
				<View style={styles.emptyBox}>
					{error ? <Text style={styles.error}>{error}</Text> : null}
					{targets === undefined ? <ActivityIndicator style={styles.spinner} /> : null}
					{targets && targets.length === 0 ? (
						<Text style={styles.dim}>ミラーできるブラウザページがありません。PCの para-browser でページを開いてください。</Text>
					) : null}
					{targets !== undefined ? (
						<Pressable disabled={!live} style={[styles.reloadTargets, !live && styles.disabled]} onPress={() => { hapticImpact('light'); autoStartedRef.current = false; void loadTargets(); }}>
							<Text style={styles.link}>一覧を更新</Text>
						</Pressable>
					) : null}
				</View>
			</View>
		);
	}

	return (
		<View style={styles.screen}>
			{tabStrip}
			<View style={styles.urlBar}>
				<Ionicons name="globe-outline" size={13} color={colors.textDim} />
				<TextInput
					style={styles.urlInput}
					value={urlInput}
					onChangeText={setUrlInput}
					onFocus={() => hapticSelection()}
					onSubmitEditing={navigate}
					placeholder="URLを入力…"
					placeholderTextColor={colors.textDim}
					keyboardType="url"
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="go"
					selectTextOnFocus
					editable={live}
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
				// 等倍時のラバーバンドを無効化。有効だとページスクロールのスワイプ
				// （PanResponderが処理）と同時にミラー描画自体が上下にバウンスして見える。
				// ズーム中のパンはコンテンツがビューポートより大きいため影響しない。
				bounces={false}
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
			<View style={[styles.toolbar, { paddingBottom: insets.bottom + 10 }]}>
				<Pressable disabled={!live} style={[styles.toolBtn, !live && styles.disabled]} onPress={() => { hapticImpact('light'); browserInput({ kind: 'back' }); }}><Ionicons name="chevron-back" size={17} color={colors.text} /></Pressable>
				<Pressable disabled={!live} style={[styles.toolBtn, !live && styles.disabled]} onPress={() => { hapticImpact('light'); browserInput({ kind: 'forward' }); }}><Ionicons name="chevron-forward" size={17} color={colors.text} /></Pressable>
				<Pressable disabled={!live} style={[styles.toolBtn, !live && styles.disabled]} onPress={() => { hapticImpact('light'); browserInput({ kind: 'reload' }); }}><Ionicons name="refresh" size={17} color={colors.text} /></Pressable>
				<Pressable disabled={!live} style={[styles.toolBtn, !live && styles.disabled]} onPress={() => { hapticImpact('light'); browserInput({ kind: 'scroll', dy: -0.5 }); }}><Ionicons name="chevron-up" size={17} color={colors.text} /></Pressable>
				<Pressable disabled={!live} style={[styles.toolBtn, !live && styles.disabled]} onPress={() => { hapticImpact('light'); browserInput({ kind: 'scroll', dy: 0.5 }); }}><Ionicons name="chevron-down" size={17} color={colors.text} /></Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	// ミラー対象切り替えのタブチップ（横スクロール）
	tabStripWrap: { flexShrink: 0 },
	tabStripContent: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingVertical: 8 },
	tabChip: {
		flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 6,
		borderRadius: 14, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, maxWidth: 220,
	},
	tabChipSelected: { backgroundColor: colors.accentWash, borderColor: 'rgba(9,175,217,0.5)' },
	disabled: { opacity: 0.45 },
	tabChipText: { color: colors.textDim, fontSize: 11 },
	tabChipTextSelected: { color: colors.accent },
	emptyBox: { flex: 1, justifyContent: 'center', padding: 24 },
	spinner: { marginTop: 24 },
	dim: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 16, lineHeight: 20 },
	error: { color: colors.red, fontSize: 12, marginBottom: 8, textAlign: 'center' },
	reloadTargets: { alignItems: 'center', marginTop: 16 },
	link: { color: colors.accent, fontSize: 13 },
	urlBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, marginHorizontal: 12, marginTop: 2, paddingVertical: 4, paddingHorizontal: 12 },
	urlInput: { flex: 1, color: colors.text, fontSize: 12, fontFamily: 'Menlo', paddingVertical: 6 },
	viewport: { flex: 1, margin: 12, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' },
	frameWrap: { flex: 1 },
	frameImage: { flex: 1 },
	center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
	toolbar: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
	toolBtn: { flex: 1, alignItems: 'center', paddingVertical: 9, backgroundColor: colors.panel, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
});
