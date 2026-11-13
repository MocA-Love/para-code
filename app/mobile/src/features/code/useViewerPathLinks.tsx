// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WebView } from 'react-native-webview';
import { useAppStore } from '../../appState.js';
import { contextMenuSheetActions } from '../../components/contextMenu.js';
import type { ContextMenuSpec } from '../../components/contextMenuModel.js';
import { contextMenuOps } from '../../components/copyActions.js';
import { createMobileOfficeNonce } from '../../components/officeCapability.js';
import { haptic } from '../../haptics.js';
import { useParaToast } from '../../paraToast.js';
import { isPcUnreachableError } from '../../store.js';
import { ActionSheet, useThemeColors } from '../../ui/index.js';
import { buildViewerPathLinkMenu } from './pathMenu.js';
import { useAbsolutePathOption } from './useAbsolutePath.js';
import {
	buildPathLinkBridgeScript,
	buildPathLinkCollectScript,
	buildPathLinkMarkScript,
	isHomePath,
	isOutsideSpaceRoot,
	parsePathLinkMessage,
	pathLinkFailureOf,
	pathLinkFailureText,
	pathLinkResolveOrder,
	pathLinksOf,
	spaceRootOf,
	type ViewerPathLink,
} from './viewerPathLinks.js';

/** どのスペースのどのファイルを見ているか。`live` は PC へ要求を出せるか（絶対パスの項目の状態に使う）。 */
export interface ViewerPathLinkSpace {
	readonly pcId: string | undefined;
	readonly wsId: string | undefined;
	readonly live: boolean;
	/** 見ているファイル（スペースの根からの相対パス）。リンクの相対パスはこのファイルのフォルダから読む。 */
	readonly viewerPath: string;
	/** 解決できたファイルを開く（スペースの根からの相対パスと、書いてあった行）。 */
	readonly open: (path: string, line: number | undefined) => void;
}

export interface ViewerPathLinksBinding {
	/** WebView の読み込みが終わったら呼ぶ（候補を集めるスクリプトを流す）。 */
	onLoadEnd(): void;
	/** WebView から届いたメッセージ。このフックのものなら受けて true。 */
	onMessage(data: string): boolean;
	/** 長押しのメニュー。画面の木に必ず置く（開くまでは何も描かない）。 */
	readonly sheet: ReactNode;
	/**
	 * ページより先に読み込ませるスクリプト（`injectedJavaScriptBeforeContentLoaded`）。知らせの送り主を確かめる口を置く。
	 * 対象外の表示では undefined。
	 */
	readonly beforeContentLoaded: string | undefined;
}

type Resolution = { readonly kind: 'resolved'; readonly path: string } | { readonly kind: 'failed'; readonly text: string };

function showFailure(text: string): void {
	haptic('warning');
	useParaToast.getState().show({ key: 'viewer-path-link', text, icon: 'alert-circle-outline', tone: 'warn' }, 2_500);
}

/**
 * ファイルビューアの Markdown・HTML の中に書かれたパスを押して開く・長押しでコピーする（`viewerPathLinks.ts`）。
 * `space` が undefined（対象外の表示）なら何もしない。`webRef` はその WebView。
 *
 * 押したら PC の `fsResolveLink` でスペースの中のファイルへ解決し（`pathLinkResolveOrder` の順に試す）、開く。
 * 見つからない・スペースの外ならトーストで知らせる。長押しは、ネイティブのメニューを WebView の中の文字に付けられない
 * ため、常にアプリのシートで出す。
 */
export function useViewerPathLinks(space: ViewerPathLinkSpace | undefined, webRef: { readonly current: WebView | null }): ViewerPathLinksBinding {
	const token = useMemo(() => createMobileOfficeNonce(), []);
	// 知らせの送り主を確かめる秘密（ページには見せない。`viewerPathLinks.ts` の冒頭）
	const secret = useMemo(() => createMobileOfficeNonce(), []);
	// 送る口の名前に付ける値（ページが同じ名前の口を先に置けないように。`viewerPathLinks.ts` の bridgeNameOf）
	const channel = useMemo(() => createMobileOfficeNonce(), []);
	const theme = useThemeColors();
	const fsResolveLink = useAppStore(s => s.fsResolveLink);
	const absolutePath = useAbsolutePathOption({ pcId: space?.pcId, wsId: space?.wsId, live: space?.live ?? false });
	const linksRef = useRef<readonly ViewerPathLink[]>([]);
	// 候補は 1 回の読み込みで最初の 1 回だけ受ける（後から届いたもの＝ページのスクリプトによるすり替えは捨てる）。
	// 集めるスクリプトを流した時点で立て、受けたら下ろす
	const awaitingCandidatesRef = useRef(false);
	// スペースの根の絶対パス（見ているファイルの絶対パスから出す。外の絶対パスを見分けるため。ファイルごとに 1 回だけ問い合わせる）
	const rootRef = useRef<{ readonly viewerPath: string; readonly root: Promise<string | undefined> } | undefined>(undefined);
	const spaceRef = useRef(space);
	spaceRef.current = space;
	const generation = useRef(0);
	useEffect(() => () => { generation.current++; }, []);
	const [menu, setMenu] = useState<ContextMenuSpec | undefined>();
	const [menuVisible, setMenuVisible] = useState(false);

	const spaceRoot = useCallback((viewerPath: string): Promise<string | undefined> => {
		if (rootRef.current?.viewerPath === viewerPath) {
			return rootRef.current.root;
		}
		const option = absolutePath(viewerPath);
		const root = option.kind === 'available'
			? option.load().then(absolute => spaceRootOf(absolute, viewerPath), () => undefined)
			: Promise.resolve(undefined);
		// 取れなかった（古い PC・つながっていない）ときは覚えず、次に押したときに問い合わせ直す
		if (option.kind === 'available') {
			rootRef.current = { viewerPath, root };
		}
		return root;
	}, [absolutePath]);

	const resolve = useCallback(async (link: ViewerPathLink): Promise<Resolution> => {
		const current = spaceRef.current;
		if (isHomePath(link.target.path)) {
			return { kind: 'failed', text: pathLinkFailureText('outside') };
		}
		if (current?.wsId === undefined) {
			return { kind: 'failed', text: 'PC につながっていません' };
		}
		let failure = pathLinkFailureText('missing');
		const order = pathLinkResolveOrder(current.viewerPath, link);
		for (const candidate of order) {
			try {
				const resolved = await fsResolveLink(current.wsId, candidate);
				return { kind: 'resolved', path: resolved.path };
			} catch (error) {
				if (isPcUnreachableError(error)) {
					return { kind: 'failed', text: 'PC につながっていません' };
				}
				// 先の候補が「外」でも、次の候補（フォルダからの相対）で見つかることがあるので続ける
				failure = pathLinkFailureText(pathLinkFailureOf(error instanceof Error ? error.message : String(error)));
			}
		}
		// `/` で始まる絶対パスが見つからなかったとき、スペースの根の下に無いと分かれば「外」と出す
		// （PC は根の外の `/…` を根からの相対に読み直すので、断りの文からは見分けられない）
		const [only] = order;
		if (order.length === 1 && only !== undefined && only.startsWith('/')) {
			const root = await spaceRoot(current.viewerPath);
			if (root !== undefined && isOutsideSpaceRoot(only, root)) {
				return { kind: 'failed', text: pathLinkFailureText('outside') };
			}
		}
		return { kind: 'failed', text: failure };
	}, [fsResolveLink, spaceRoot]);

	const openLink = useCallback((link: ViewerPathLink) => {
		const ticket = ++generation.current;
		haptic('move');
		void resolve(link).then(result => {
			if (generation.current !== ticket) {
				return;
			}
			if (result.kind === 'resolved') {
				spaceRef.current?.open(result.path, link.target.line);
			} else {
				showFailure(result.text);
			}
		});
	}, [resolve]);

	const showMenu = useCallback((link: ViewerPathLink) => {
		const ticket = ++generation.current;
		haptic('lift');
		void resolve(link).then(result => {
			if (generation.current !== ticket) {
				return;
			}
			const ops = { ...contextMenuOps(), open: () => openLink(link) };
			setMenu(buildViewerPathLinkMenu(result.kind === 'resolved'
				? { written: link.written, path: link.target.path, resolved: result.path, absolute: absolutePath(result.path) }
				: { written: link.written, path: link.target.path, failure: result.text }, ops));
			setMenuVisible(true);
		});
	}, [resolve, openLink, absolutePath]);

	const enabled = space !== undefined;
	const onLoadEnd = useCallback(() => {
		if (!enabled) {
			return;
		}
		linksRef.current = [];
		awaitingCandidatesRef.current = true;
		webRef.current?.injectJavaScript(buildPathLinkCollectScript(token, secret, channel));
	}, [enabled, token, secret, channel, webRef]);

	const onMessage = useCallback((data: string): boolean => {
		if (!enabled) {
			return false;
		}
		const message = parsePathLinkMessage(data, token, secret);
		if (message === undefined) {
			return false;
		}
		if (message.op === 'candidates') {
			if (!awaitingCandidatesRef.current) {
				return true;
			}
			awaitingCandidatesRef.current = false;
			const found = pathLinksOf(message.items);
			linksRef.current = found.links;
			if (found.marks.length > 0) {
				webRef.current?.injectJavaScript(buildPathLinkMarkScript(token, secret, channel, found.marks, theme.accent));
			}
			return true;
		}
		const link = linksRef.current[message.id];
		if (link !== undefined) {
			if (message.op === 'tap') {
				openLink(link);
			} else {
				showMenu(link);
			}
		}
		return true;
	}, [enabled, token, secret, channel, webRef, theme.accent, openLink, showMenu]);

	const sheet = menu === undefined ? null : (
		<ActionSheet visible={menuVisible} title={menu.title} message={menu.message} actions={contextMenuSheetActions(menu)} onClose={() => setMenuVisible(false)} />
	);
	const beforeContentLoaded = useMemo(() => (enabled ? buildPathLinkBridgeScript(secret, channel) : undefined), [enabled, secret, channel]);
	return { onLoadEnd, onMessage, sheet, beforeContentLoaded };
}
