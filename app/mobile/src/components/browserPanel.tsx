// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ComponentType, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, GestureResponderEvent, Image, Keyboard, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, ChevronRight, Globe, Keyboard as KeyboardGlyph, Link2, Minimize2, RotateCw, X } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { useAppInFront } from '../hooks/useAppInFront.js';
import { isTablet, useIsRegularWidth } from '../hooks/useSizeClass.js';
import { useKeyboardVisible } from '../hooks/useKeyboardVisible.js';
import { usePcCapability } from '../hooks/usePcCapability.js';
import { PcCapability } from '../pcCompat.js';
import type { BrowserInput } from '../browserKeys.js';
import type { BrowserTargetsScope } from '../store.js';
import { BrowserKeyInput } from './browserKeyInput.js';
import { Icon } from '../ui/icon.js';
import { BottomDrawer } from '../ui/bottomDrawer.js';
import { DrawerCaption } from '../ui/drawerHeader.js';
import { getRtcView, startWebrtcMirror, WebrtcMirrorCoordinator, type WebrtcMirrorSession } from '../webrtcMirror.js';
import { colors, radius, squircle, type } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';
import { useThemeColors } from '../ui/themeColorsStore.js';
import { useWindowControlsInset } from '../ipad/windowControls.js';
import { addressHost, legacyNavigateUrl } from '../browserAddress.js';
import { displayedRoute, MIRROR_ROUTE_INFO, type MirrorRoute } from '../browserRoute.js';
import { bookmarkLabel, bookmarkFolderView, bookmarkNavigateUrl, isCurrentBookmark } from '../browserBookmarks.js';
import { BROWSER_KEYBOARD_CLOSED, browserFieldCaption, browserKeyboardMultiline, browserKeyboardNotice, browserKeyboardPlaceholder, browserKeyboardSubmit, nextBrowserKeyboard } from '../browserKeyboard.js';
import { PARADIS_MOBILE_BROWSER_INPUT_TEXT_MAX } from '../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileBrowserProtocol.js';
import { landscapeAllowed, selectionForScope, sidebarForFullscreen } from '../browserFullscreen.js';
import { observeDeviceOrientation, setLandscapeAllowed, supportsLandscapeGate } from '../../modules/para-ipad-input/index.js';
import { BrowserNavBar, RouteGlyph } from '../features/browser/browserNavBar.js';
import { BookmarkLeading, BrowserBookmarkBar } from '../features/browser/browserBookmarkBar.js';
import { BrowserListOverlay, type BrowserListItem, type BrowserPopoverAnchor } from '../features/browser/browserListOverlay.js';
import { useBrowserAddressMode, useBrowserFullscreen } from '../features/browser/browserFullscreenStore.js';
import { useBrowserBookmarks } from '../features/browser/useBrowserBookmarks.js';

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

/** WebRTC の経路を調べ直す間隔（ICE の再選択で変わるため）。 */
const ROUTE_POLL_MS = 5_000;

/**
 * ブラウザパネル（セッションのブラウザのタブの本体。案A、`mobile-browser-ux-mock.html`）。
 * PC側 para-browser の写しを出し、タップ・スクロール・戻る/進む/再読み込み・アドレス・文字入力を送る。
 *
 * - 上の段（`BrowserNavBar`）: 戻る・進む・再読み込み（読み込み中は停止）・アドレス（左端に接続経路の印）・
 *   ページ数（押すとこのスペースのページの一覧。iPhone はシート、iPad はポップオーバー）・全画面
 * - その下: PC と同じブックマークバー（見て開くだけ。PC が `browser.bookmarks.v1` を持つときだけ）
 * - 映像: 外周の余白なし。ピンチで拡大、1 本指でページをスクロール、タップでクリック
 * - ページの入力欄をタップすると、PC の知らせ（`browser.focus.v1`）で文字入力が自動で開く。映像の右下の丸い
 *   ボタンでも開ける（控え）
 * - 全画面: ボタンで入る。iPhone では横に倒しても入り、全画面の間だけ横向きを許す（`browserFullscreen.ts`）
 *
 * ページの一覧は `scope`（いま見ているスペース）で絞ってもらう（`browser.space.v1` の PC だけ。古い PC は全部）。
 * ターゲット一覧の取得後は自動でミラーを開始する: `preferredToken` と共有中のページがあればそれを優先し、
 * 無ければ先頭のページを選ぶ。`active` が false の間（画面がフォーカスを失った間）は止める。
 */
export function BrowserPanel({ active: screenActive, preferredToken, scope, spaceName }: {
	active: boolean;
	preferredToken?: string;
	/** ページの一覧を絞るスペース。 */
	scope?: BrowserTargetsScope;
	/** 一覧の見出しに出すスペースの名前。 */
	spaceName?: string;
}) {
	// 画面が見えているのは、画面にフォーカスがあり、アプリが裏に回っていないとき。裏に回っても接続を
	// 保つようになった（W2-34）ので、裏では止め、前に戻ったら同じ target で張り直す。
	const inFront = useAppInFront();
	const active = screenActive && inFront;
	const theme = useThemeColors();
	const { browserTargets, browserStart, browserStop, browserInput, frame, browserPage, browserFocus, browserInputRejected, connection, pcOnline, sessionProtocolReady, setJpegFramesSuspended, workspace, browserSelection, setBrowserSelection, sidebarCollapsed, setSidebarCollapsed, activePcId } = useAppStore(useShallow(s => ({
		browserTargets: s.browserTargets, browserStart: s.browserStart, browserStop: s.browserStop,
		browserInput: s.browserInput, frame: s.browserFrame, browserPage: s.browserPage, browserFocus: s.browserFocus, browserInputRejected: s.browserInputRejected,
		connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady,
		setJpegFramesSuspended: s.setJpegFramesSuspended, workspace: s.workspace,
		browserSelection: s.browserSelection, setBrowserSelection: s.setBrowserSelection,
		sidebarCollapsed: s.sidebarCollapsed, setSidebarCollapsed: s.setSidebarCollapsed, activePcId: s.activePcId,
	})));
	const regular = useIsRegularWidth();
	const live = connection === 'online' && pcOnline && sessionProtocolReady;
	// 前回の選択は、同じスペースのものだけ使う（別のスペースのページを、一覧が届く前に映し始めないため）。
	const scopeKey = scope !== undefined ? `${scope.windowId}:${scope.ws}` : undefined;
	const cachedSelection = selectionForScope(browserSelection, scopeKey);
	const cachedTargetIsCurrent = cachedSelection?.desktopEpoch === workspace?.desktopEpoch;
	const liveRef = useRef(live);
	liveRef.current = live;
	const activeRef = useRef(active);
	activeRef.current = active;
	const workspaceEpochRef = useRef(workspace?.desktopEpoch);
	workspaceEpochRef.current = workspace?.desktopEpoch;

	const stableInsets = useStableInsets();
	// 全画面の横向きでは上の余白が 0・左右がノッチぶんになるので、起動時の値で底上げしない生の値を使う。
	const rawInsets = useSafeAreaInsets();
	const controlsInset = useWindowControlsInset();
	// キーボードが出ている間はセッションの画面が被覆ぶん下を空けるので、下の段に Home インジケータの余白は要らない。
	const keyboardVisible = useKeyboardVisible();
	const keysSupported = usePcCapability(PcCapability.BrowserKeys);
	const pageSupported = usePcCapability(PcCapability.BrowserPage);
	const focusSupported = usePcCapability(PcCapability.BrowserFocus);
	const bookmarksSupported = usePcCapability(PcCapability.BrowserBookmarks);
	const [targets, setTargets] = useState<BrowserTarget[] | undefined>();
	const [scoped, setScoped] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [activeUrl, setActiveUrl] = useState<string | undefined>(cachedSelection?.url);
	const [activeTargetId, setActiveTargetId] = useState<string | undefined>(cachedSelection?.targetId);
	const [viewSize, setViewSize] = useState({ w: 1, h: 1 });
	const scopeRef = useRef(scope);
	scopeRef.current = scope;

	// ミラー中の targetId。ユーザーが一覧で切り替えた時は新しい targetId に張り替える。
	// active の解除→再有効化の往復では、これが残っていれば同じ targetId でミラーを自動で張り直す。
	const mirrorActiveRef = useRef<string | undefined>(cachedTargetIsCurrent ? cachedSelection?.targetId : undefined);
	// ターゲット一覧到着時の自動ミラー開始を発火済みか（マウントごと・再接続ごとに1回だけ）。
	const autoStartedRef = useRef(false);
	const browserStartGenRef = useRef(0);
	const targetLoadGenRef = useRef(0);
	const targetsEpochRef = useRef<string | undefined>(undefined);

	// WebRTCミラー（低遅延経路）。確立できたら RTCView 表示、失敗・切断時は
	// 既存のJPEGフレーム表示へ自動フォールバックする（JPEGは並行して流れ続けている）。
	const [webrtcUrl, setWebrtcUrl] = useState<string | undefined>();
	const webrtcSessionRef = useRef<WebrtcMirrorSession | undefined>(undefined);
	const [webrtcRoute, setWebrtcRoute] = useState<Exclude<MirrorRoute, 'relay'> | undefined>();
	// RTCView が実際に描画している映像の実寸法（onDimensionsChange で更新）。
	// タップ/スワイプの座標計算はこれを最優先で使う。PC側リサイズの途中でも
	// 「描画されている映像そのもの」の寸法なので、表示と計算が絶対にずれない。
	const webrtcDimsRef = useRef<{ w: number; h: number } | undefined>(undefined);
	const webrtcCoordinatorRef = useRef<WebrtcMirrorCoordinator | undefined>(undefined);
	if (webrtcCoordinatorRef.current === undefined) {
		webrtcCoordinatorRef.current = new WebrtcMirrorCoordinator(
			startWebrtcMirror,
			session => {
				webrtcDimsRef.current = undefined;
				webrtcSessionRef.current = session;
				setWebrtcRoute(undefined);
				setWebrtcUrl(session?.streamUrl);
			},
			error => console.warn('[browser] webrtc unavailable, falling back to JPEG mirror:', error instanceof Error ? error.message : error),
		);
	}
	const stopWebrtc = useCallback(() => {
		webrtcDimsRef.current = undefined;
		webrtcCoordinatorRef.current?.stop();
	}, []);
	const tryWebrtc = useCallback((targetId: string) => {
		if (RTCViewComponent === undefined) {
			return; // このビルドにはネイティブモジュールが無い
		}
		webrtcDimsRef.current = undefined; // 旧セッションの映像寸法をJPEGの座標計算に残さない
		webrtcCoordinatorRef.current?.start(targetId);
	}, []);

	// 経路の印: WebRTC がつながった直後と、その後 5 秒おきに選ばれた候補の組を調べる。
	useEffect(() => {
		if (webrtcUrl === undefined || !active) {
			return;
		}
		let disposed = false;
		const poll = () => {
			void webrtcSessionRef.current?.route().then(route => {
				if (!disposed) {
					setWebrtcRoute(route);
				}
			});
		};
		poll();
		const timer = setInterval(poll, ROUTE_POLL_MS);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	}, [webrtcUrl, active]);

	const browserStopRef = useRef(browserStop);
	browserStopRef.current = browserStop;
	const loadTargets = useCallback(async () => {
		if (!live) {
			return;
		}
		const gen = ++targetLoadGenRef.current;
		const requestEpoch = workspace?.desktopEpoch;
		setError(undefined);
		try {
			const result = await browserTargets(scopeRef.current);
			if (targetLoadGenRef.current !== gen || !liveRef.current || requestEpoch !== workspaceEpochRef.current) {
				return;
			}
			// 映していたページが一覧から外れた（閉じた・別のスペースのページだった）。PC のミラーも止めてから、
			// 自動で選び直す（0 件なら空の表示に戻る）。
			const currentTarget = mirrorActiveRef.current;
			if (currentTarget !== undefined && !result.targets.some(target => target.targetId === currentTarget)) {
				mirrorActiveRef.current = undefined;
				autoStartedRef.current = false;
				browserStartGenRef.current++;
				stopWebrtc();
				void browserStopRef.current();
				setActiveUrl(undefined);
				setActiveTargetId(undefined);
			}
			targetsEpochRef.current = requestEpoch;
			setScoped(result.scoped === true);
			setTargets(result.targets);
		} catch (e) {
			if (targetLoadGenRef.current === gen) {
				setError(String(e instanceof Error ? e.message : e));
				setTargets(current => current ?? []);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- scope と browserStop は ref で読み、スペースが変わったら下の effect で読み直す
	}, [browserTargets, live, workspace?.desktopEpoch, stopWebrtc]);

	// ターゲット一覧の読み込みは接続状態とスペースに追従させる。
	useEffect(() => {
		void loadTargets();
	}, [loadTargets, scopeKey]);

	// ページの状態（PC の通知）でページが閉じられた・URL が変わったことを知ったら、一覧も読み直す
	// （題名と URL は一覧の行にも出すため）。頻繁な通知で読み直しすぎないよう 1 秒まとめる。
	const pageForActive = browserPage !== undefined && browserPage.targetId === activeTargetId ? browserPage : undefined;
	const pageUrlForList = pageForActive?.loading === false ? pageForActive.url : undefined;
	useEffect(() => {
		if (pageUrlForList === undefined || !active) {
			return;
		}
		const timer = setTimeout(() => { void loadTargets(); }, 1000);
		return () => clearTimeout(timer);
	}, [pageUrlForList, active, loadTargets]);

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
	useEffect(() => {
		return () => {
			browserStartGenRef.current++;
			targetLoadGenRef.current++;
			webrtcCoordinatorRef.current?.dispose();
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

	// 文字入力（ページの欄との対応は browserKeyboard.ts）。
	const [keyboard, dispatchKeyboard] = useReducer(nextBrowserKeyboard, BROWSER_KEYBOARD_CLOSED);

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
			dispatchKeyboard({ kind: 'restart' });
			void browserStart(targetId, scopeRef.current).then(() => {
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
		dispatchKeyboard({ kind: 'target', targetId });
		dispatchKeyboard({ kind: 'restart' });
		try {
			await browserStart(targetId, scopeRef.current);
			if (browserStartGenRef.current !== gen || !liveRef.current || !activeRef.current || startEpoch !== workspaceEpochRef.current) {
				return;
			}
			mirrorActiveRef.current = targetId;
			setActiveUrl(url);
			setActiveTargetId(targetId);
			if (workspace !== undefined) {
				setBrowserSelection({ targetId, url, desktopEpoch: workspace.desktopEpoch, ...(scopeKey !== undefined ? { scopeKey } : {}) });
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
	// preferredToken と共有中のページを最優先、無ければ先頭。ユーザーが一覧で切り替えた後や
	// 一覧の再取得では発火しない（autoStartedRef、マウントごと・再接続ごとに1回だけ）。
	// 前に見ていたページが一覧に無い（別のスペースのページだった）ときは選び直す。
	useEffect(() => {
		if (autoStartedRef.current || !active || !live || mirrorActiveRef.current !== undefined
			|| targetsEpochRef.current !== workspace?.desktopEpoch) {
			return;
		}
		const candidate = (preferredToken !== undefined ? targets?.find(t => t.sharedToken === preferredToken) : undefined)
			?? (cachedSelection !== undefined ? targets?.find(t => t.targetId === cachedSelection.targetId) : undefined)
			?? targets?.[0];
		if (candidate === undefined) {
			return;
		}
		autoStartedRef.current = true;
		void start(candidate.targetId, candidate.url);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [targets, active, live, preferredToken, workspace?.desktopEpoch]);

	// 見ていたページが一覧に無い（読み込みの途中など）間は映像を出さない。
	const activeInList = targets === undefined || activeTargetId === undefined || targets.some(target => target.targetId === activeTargetId);

	// ページの状態が届いたら、画面を離れて戻ったときに出す URL も追従させる。
	const pageUrl = pageForActive?.url;
	useEffect(() => {
		if (pageUrl !== undefined && pageUrl.length > 0 && activeTargetId !== undefined && workspace !== undefined) {
			setActiveUrl(pageUrl);
			setBrowserSelection({ targetId: activeTargetId, url: pageUrl, desktopEpoch: workspace.desktopEpoch, ...(scopeKey !== undefined ? { scopeKey } : {}) });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- URL が変わったときだけ
	}, [pageUrl]);

	// PC のページの欄のフォーカス（browser.focus.v1）を文字入力へ。
	useEffect(() => {
		if (browserFocus !== undefined && browserFocus.targetId === activeTargetId && focusSupported) {
			dispatchKeyboard({ kind: 'focus', focus: browserFocus });
		}
	}, [browserFocus, activeTargetId, focusSupported]);
	// PC が入力を断った（欄が替わった・長すぎる）。基準を戻し、入力欄の見出しに理由を出す。
	useEffect(() => {
		if (browserInputRejected !== undefined && browserInputRejected.targetId === activeTargetId) {
			dispatchKeyboard({ kind: 'rejected', input: browserInputRejected.kind, reason: browserInputRejected.reason });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 届くたびに 1 回（n が増える）
	}, [browserInputRejected?.n]);

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

	const activeTarget = targets?.find(target => target.targetId === activeTargetId);
	const currentUrl = pageForActive?.url ?? activeUrl ?? '';
	const currentTitle = pageForActive?.title ?? activeTarget?.title ?? '';

	// アドレス欄の確定。PC が URL か検索かを決められるならそのまま送り、古い PC には手元で URL にして送る。
	const submitAddress = (text: string) => {
		if (pageSupported) {
			browserInput({ kind: 'open', text });
			return;
		}
		const url = legacyNavigateUrl(text);
		if (url === undefined) {
			return;
		}
		browserInput({ kind: 'navigate', url });
		setActiveUrl(url);
		if (activeTargetId !== undefined && workspace !== undefined) {
			setBrowserSelection({ targetId: activeTargetId, url, desktopEpoch: workspace.desktopEpoch, ...(scopeKey !== undefined ? { scopeKey } : {}) });
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

	// --- 全画面（browserFullscreen.ts） ---------------------------------------------------------
	const fullscreen = useBrowserFullscreen(s => s.fullscreen);
	const fullscreenVia = useBrowserFullscreen(s => s.via);
	const dispatchFullscreen = useBrowserFullscreen(s => s.dispatch);
	const hasPage = activeUrl !== undefined;
	const phoneFullscreen = fullscreen && !isTablet;
	// iPhone では全画面の間だけ横向きを許す。抜けたら縦に戻す（ネイティブ側）。
	useEffect(() => {
		setLandscapeAllowed(landscapeAllowed({ fullscreen, via: fullscreenVia }, isTablet));
	}, [fullscreen, fullscreenVia]);
	// 画面を離れたら（タブの切り替え・別の画面・アプリが裏）抜ける。
	useEffect(() => {
		if (!active) {
			dispatchFullscreen({ kind: 'exit' });
		}
	}, [active, dispatchFullscreen]);
	useEffect(() => () => {
		dispatchFullscreen({ kind: 'exit' });
		setLandscapeAllowed(false);
	}, [dispatchFullscreen]);
	// 横に倒して入る（iPhone だけ。横向きを切り替えられない古いバイナリではやらない）。
	useEffect(() => {
		if (!active || isTablet || !hasPage || !supportsLandscapeGate()) {
			return;
		}
		return observeDeviceOrientation(orientation => dispatchFullscreen({ kind: 'device', orientation, tablet: isTablet }));
	}, [active, hasPage, dispatchFullscreen]);
	// iPad の 2 列では、全画面の間だけ左の列も畳む（抜けたら元に戻す）。
	const collapsedForFullscreen = useRef(false);
	useEffect(() => {
		const next = sidebarForFullscreen(fullscreen, regular, sidebarCollapsed, collapsedForFullscreen.current);
		collapsedForFullscreen.current = next.collapsedByFullscreen;
		if (next.set !== undefined) {
			setSidebarCollapsed(next.set, { persist: false });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 全画面の出入りのときだけ
	}, [fullscreen]);
	const toggleFullscreen = () => {
		hapticImpact('light');
		dispatchFullscreen({ kind: 'toggle' });
	};

	// --- ブックマーク・一覧 -----------------------------------------------------------------------
	const bookmarks = useBrowserBookmarks(activePcId, active && live, bookmarksSupported);
	const [pagesAnchor, setPagesAnchor] = useState<BrowserPopoverAnchor | undefined>();
	const [pagesOpen, setPagesOpen] = useState(false);
	const [folderPath, setFolderPath] = useState<readonly string[] | undefined>();
	const [folderAnchor, setFolderAnchor] = useState<BrowserPopoverAnchor | undefined>();
	const [routeInfo, setRouteInfo] = useState<MirrorRoute | undefined>();
	const addressMode = useBrowserAddressMode(s => s.mode);
	const toggleAddressMode = useBrowserAddressMode(s => s.toggle);
	const loadAddressMode = useBrowserAddressMode(s => s.load);
	useEffect(() => { loadAddressMode(); }, [loadAddressMode]);

	const openBookmark = (url: string) => {
		const target = bookmarkNavigateUrl(url);
		if (target === undefined || !hasPage) {
			return;
		}
		browserInput({ kind: 'navigate', url: target });
		setActiveUrl(target);
	};

	const pageItems: BrowserListItem[] = (targets ?? []).map(target => {
		const shared = terminalTitleOf(target.sharedToken);
		const host = addressHost(target.url) ?? target.url;
		return {
			key: target.targetId,
			label: target.title.trim().length > 0 ? target.title : host,
			hint: shared !== undefined ? `${shared} と共有中 · ${host}` : target.sharedToken !== undefined ? `エージェントと共有中 · ${host}` : host,
			leading: <Icon icon={target.sharedToken !== undefined ? Link2 : Globe} size={16} color={target.sharedToken !== undefined ? colors.green : colors.textDim} />,
			trailing: target.targetId === activeTargetId ? 'check' : 'none',
			closes: true,
			onPress: () => {
				if (target.targetId === activeTargetId && mirrorActiveRef.current === target.targetId) {
					return;
				}
				hapticSelection();
				void start(target.targetId, target.url);
			},
		};
	});
	pageItems.push({
		key: '__reload',
		label: '一覧を更新',
		leading: <Icon icon={RotateCw} size={16} color={theme.accent} />,
		closes: true,
		onPress: () => { autoStartedRef.current = false; void loadTargets(); },
	});

	const folderView = bookmarks !== undefined && folderPath !== undefined ? bookmarkFolderView(bookmarks, folderPath) : undefined;
	const folderItems: BrowserListItem[] = folderView !== undefined && bookmarks !== undefined ? folderView.nodes.map(node => ({
		key: node.id,
		label: bookmarkLabel(node),
		...(node.type === 'bookmark' ? { hint: addressHost(node.url) ?? node.url } : { hint: `${node.children.length} 件` }),
		leading: <BookmarkLeading node={node} bookmarks={bookmarks} size={16} />,
		trailing: node.type === 'folder' ? 'chevron' : node.type === 'bookmark' && isCurrentBookmark(node.url, currentUrl) ? 'check' : 'none',
		closes: node.type === 'bookmark',
		onPress: () => {
			if (node.type === 'folder') {
				setFolderPath(path => [...(path ?? []), node.id]);
			} else {
				openBookmark(node.url);
			}
		},
	})) : [];
	const folderTitle = folderView?.trail[folderView.trail.length - 1]?.title ?? 'ブックマーク';

	// --- 文字入力 ------------------------------------------------------------------------------
	const sendKeyboard = (): boolean => {
		const input = browserKeyboardSubmit(keyboard, keysSupported, focusSupported);
		if (input === undefined) {
			return false;
		}
		browserInput(input);
		dispatchKeyboard({ kind: 'sent', input });
		return true;
	};
	const closeKeyboard = () => {
		Keyboard.dismiss();
		dispatchKeyboard({ kind: 'close' });
	};
	const sendInput = (input: BrowserInput) => browserInput(input);
	const focusForCaption = browserFocus !== undefined && browserFocus.targetId === activeTargetId && browserFocus.focused ? browserFocus : undefined;

	const route = displayedRoute(webrtcUrl !== undefined && RTCViewComponent !== undefined, webrtcRoute, frameSource !== undefined);
	const loading = pageForActive?.loading === true;
	const bottomSpacer = keyboard.open ? 0 : phoneFullscreen ? 0 : (keyboardVisible ? 0 : stableInsets.bottom);
	const showBookmarks = bookmarks !== undefined && bookmarks.nodes.length > 0 && !keyboardVisible && !keyboard.open;
	// iPad の全画面では見出しが隠れるので、上の段が画面の上端に来る（セーフエリアと左上の操作ボタンを避ける）。
	const chromeTop = fullscreen && isTablet ? rawInsets.top : 0;

	const viewport = (
		// ピンチで拡大縮小・ドラッグでパンできるようScrollViewズームに載せる。
		// タップ座標は子ビューのローカル座標系（ズーム非依存）なのでマッピングはそのまま有効
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
			// 文字入力中は、映像をタップしてページの入力欄を選んでもキーボードを閉じない。
			keyboardShouldPersistTaps={keyboard.open ? 'handled' : 'never'}
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
			) : frameSource && viewSize.w > 1 ? (
				// 枠の大きさが分かる前に描くと、iOS が 1pt の大きさで画像を読み、同じ URI の間はその粗い絵を使い回す
				// （PC は変化の無いフレームを送らないので、止まったページはぼやけたままになる）。
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
	);

	const capsuleButton = (key: string, icon: typeof X, label: string, onPress: () => void, disabled = false) => (
		<Pressable
			key={key}
			disabled={disabled || !live}
			hitSlop={4}
			style={({ pressed }) => [styles.capsuleButton, pressed && styles.capsulePressed, (disabled || !live) && styles.disabled]}
			onPress={() => { hapticImpact('light'); onPress(); }}
			accessibilityRole="button"
			accessibilityLabel={label}
		>
			<Icon icon={icon} size={18} color={colors.text} />
		</Pressable>
	);

	return (
		<View style={[styles.screen, phoneFullscreen && styles.screenFullscreen]}>
			{/* 上の段とブックマーク。iPhone の全画面では高さ 0 で隠す（木の形は変えない）。 */}
			<View style={[phoneFullscreen ? styles.hidden : undefined, { paddingTop: chromeTop, paddingLeft: fullscreen && isTablet ? controlsInset : 0 }]}>
				<BrowserNavBar
					live={live}
					hasPage={hasPage}
					canGoBack={pageForActive?.canGoBack}
					canGoForward={pageForActive?.canGoForward}
					loading={loading}
					progress={pageForActive?.progress ?? 0}
					route={route}
					url={currentUrl}
					title={currentTitle}
					displayMode={addressMode}
					pageCount={targets?.length ?? 0}
					fullscreen={fullscreen}
					onBack={() => browserInput({ kind: 'back' })}
					onForward={() => browserInput({ kind: 'forward' })}
					onReload={() => browserInput({ kind: 'reload' })}
					onStop={pageSupported ? () => browserInput({ kind: 'stop' }) : undefined}
					onSubmitAddress={submitAddress}
					onToggleDisplayMode={toggleAddressMode}
					onOpenPages={anchor => { setPagesAnchor(anchor); setPagesOpen(true); if (live) { void loadTargets(); } }}
					onToggleFullscreen={toggleFullscreen}
					onRoutePress={setRouteInfo}
				/>
				{showBookmarks && bookmarks !== undefined ? (
					<BrowserBookmarkBar
						bookmarks={bookmarks}
						pageUrl={currentUrl}
						disabled={!live || !hasPage}
						onOpen={openBookmark}
						onOpenFolder={(folder, anchor) => { setFolderAnchor(anchor); setFolderPath([folder.id]); }}
					/>
				) : null}
			</View>
			<View style={[styles.body, phoneFullscreen && { paddingTop: rawInsets.top }]}>
				{hasPage && activeInList ? viewport : (
					<View style={styles.emptyBox}>
						{error ? <Text style={styles.error}>{error}</Text> : null}
						{targets === undefined ? <ActivityIndicator style={styles.spinner} /> : null}
						{targets !== undefined && targets.length === 0 ? (
							<>
								<Text style={styles.emptyTitle}>{scoped ? 'このスペースにページがありません' : 'ミラーできるページがありません'}</Text>
								<Text style={styles.dim}>{scoped ? 'PC の Para Code で、このスペースにブラウザのページを開くと、ここに写ります。' : 'PC の para-browser でページを開いてください。'}</Text>
							</>
						) : null}
						{targets !== undefined ? (
							<Pressable disabled={!live} style={[styles.reloadTargets, !live && styles.disabled]} onPress={() => { hapticImpact('light'); autoStartedRef.current = false; void loadTargets(); }}>
								<Text style={[styles.link, { color: theme.accent }]}>一覧を更新</Text>
							</Pressable>
						) : null}
					</View>
				)}
				{/* iPhone の全画面: 上に操作のカプセルと接続経路の札を浮かべる。 */}
				{phoneFullscreen ? (
					<>
						<View style={[styles.glass, styles.capsule, { top: rawInsets.top + 8, left: rawInsets.left + 12 }]}>
							{capsuleButton('exit', Minimize2, '全画面をやめる', toggleFullscreen)}
							{capsuleButton('back', ChevronLeft, '戻る', () => browserInput({ kind: 'back' }), pageForActive?.canGoBack === false)}
							{capsuleButton('forward', ChevronRight, '進む', () => browserInput({ kind: 'forward' }), pageForActive?.canGoForward === false)}
							{loading && pageSupported
								? capsuleButton('stop', X, '読み込みを止める', () => browserInput({ kind: 'stop' }))
								: capsuleButton('reload', RotateCw, '再読み込み', () => browserInput({ kind: 'reload' }))}
						</View>
						<Pressable
							style={[styles.glass, styles.badge, { top: rawInsets.top + 14, right: rawInsets.right + 12 }]}
							onPress={() => { if (route !== undefined) { hapticSelection(); setRouteInfo(route); } }}
							accessibilityRole="button"
							accessibilityLabel={route !== undefined ? `接続経路: ${MIRROR_ROUTE_INFO[route].label}` : 'ページ'}
						>
							{route !== undefined ? <RouteGlyph route={route} size={12} /> : null}
							<Text style={styles.badgeText} numberOfLines={1}>{addressHost(currentUrl) ?? currentTitle}</Text>
						</Pressable>
					</>
				) : null}
				{/* 文字入力の控え（ページの欄をタップすると自動で開く）。 */}
				{hasPage && activeInList && !keyboard.open ? (
					<Pressable
						disabled={!live}
						style={({ pressed }) => [styles.glass, styles.fab, { right: (phoneFullscreen ? rawInsets.right : 0) + 12, bottom: (phoneFullscreen ? rawInsets.bottom : 0) + 12 }, pressed && styles.capsulePressed, !live && styles.disabled]}
						onPress={() => { hapticSelection(); dispatchKeyboard({ kind: 'open' }); }}
						accessibilityRole="button"
						accessibilityLabel="ページに文字を入力"
					>
						<Icon icon={KeyboardGlyph} size={18} color={colors.text} />
					</Pressable>
				) : null}
			</View>
			{keyboard.open ? (
				<BrowserKeyInput
					live={live}
					keysSupported={keysSupported}
					bottomPadding={(keyboardVisible ? 0 : stableInsets.bottom) + 10}
					text={keyboard.text}
					onChangeText={text => dispatchKeyboard({ kind: 'text', text })}
					onSubmit={sendKeyboard}
					onInput={sendInput}
					onClose={closeKeyboard}
					placeholder={browserKeyboardPlaceholder(keyboard)}
					secure={keyboard.secret}
					multiline={browserKeyboardMultiline(keyboard)}
					maxLength={PARADIS_MOBILE_BROWSER_INPUT_TEXT_MAX}
					caption={browserFieldCaption(keyboard, focusForCaption?.inputType)}
					notice={browserKeyboardNotice(keyboard)}
				/>
			) : (
				<View style={{ height: bottomSpacer }} />
			)}

			<BrowserListOverlay
				allowLandscape={phoneFullscreen}
				visible={pagesOpen}
				popover={regular}
				anchor={pagesAnchor}
				title={scoped ? 'このスペースのページ' : 'ブラウザのページ'}
				caption={`${scoped && spaceName !== undefined ? `${spaceName} · ` : ''}${targets?.length ?? 0} 件`}
				items={pageItems}
				onClose={() => setPagesOpen(false)}
			/>
			<BrowserListOverlay
				allowLandscape={phoneFullscreen}
				visible={folderPath !== undefined && folderView !== undefined}
				popover={regular}
				anchor={folderAnchor}
				title={folderTitle}
				caption="PC のブックマークと同じ並びです。追加と編集は PC で行います"
				items={folderItems}
				header={folderPath !== undefined && folderPath.length > 1 ? (
					<Pressable style={styles.folderBack} onPress={() => setFolderPath(path => path?.slice(0, -1))} accessibilityRole="button" accessibilityLabel="ひとつ上のフォルダへ">
						<Icon icon={ChevronLeft} size={16} color={theme.accent} />
						<Text style={[styles.folderBackText, { color: theme.accent }]}>{folderView?.trail[folderView.trail.length - 2]?.title ?? '戻る'}</Text>
					</Pressable>
				) : undefined}
				onClose={() => setFolderPath(undefined)}
			/>
			<BottomDrawer visible={routeInfo !== undefined} onClose={() => setRouteInfo(undefined)} accessibilityLabel="接続経路" allowLandscape={phoneFullscreen}>
				{routeInfo !== undefined ? (
					<View style={styles.routeInfo}>
						<RouteGlyph route={routeInfo} size={20} />
						<DrawerCaption title={MIRROR_ROUTE_INFO[routeInfo].label} message={MIRROR_ROUTE_INFO[routeInfo].description} />
					</View>
				) : null}
			</BottomDrawer>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	screenFullscreen: { backgroundColor: '#000' },
	hidden: { height: 0, overflow: 'hidden' },
	body: { flex: 1 },
	disabled: { opacity: 0.45 },
	emptyBox: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
	emptyTitle: { color: colors.text, fontSize: type.heading, fontWeight: '600', textAlign: 'center' },
	spinner: { marginTop: 24 },
	dim: { color: colors.textDim, fontSize: type.body, textAlign: 'center', lineHeight: 22, maxWidth: 320 },
	error: { color: colors.red, fontSize: type.meta, marginBottom: 8, textAlign: 'center' },
	reloadTargets: { alignItems: 'center', marginTop: 8, minHeight: 44, justifyContent: 'center' },
	link: { color: colors.accent, fontSize: type.body },
	viewport: { flex: 1, backgroundColor: '#000' },
	frameWrap: { flex: 1 },
	frameImage: { flex: 1 },
	center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
	glass: { position: 'absolute', backgroundColor: colors.glassBg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder, flexDirection: 'row', alignItems: 'center' },
	capsule: { borderRadius: radius.pill, padding: 2 },
	capsuleButton: { width: 36, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	capsulePressed: { backgroundColor: colors.raised },
	badge: { borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: 9, gap: 5, maxWidth: 220 },
	badgeText: { flexShrink: 1, color: colors.text, fontSize: type.caption },
	fab: { width: 40, height: 40, borderRadius: radius.pill, justifyContent: 'center' },
	folderBack: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: 12 },
	folderBackText: { fontSize: type.body },
	routeInfo: { alignItems: 'center', gap: 8, paddingTop: 4, ...squircle },
});
