// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { isTerminalViewportRevoked, onTerminalViewportRevoked, pcHasCapabilityFor, reclaimTerminalViewport, sendPcRequest, useAppStore } from '../../appState.js';
import { appendUploadedPath } from '../../components/agentComposerDraft.js';
import { Button } from '../../components/button.js';
import { useTerminalKeyInput } from '../../components/terminalKeyRow.js';
import { TermView } from '../../components/termView.js';
import { WorkspaceFileViewer } from '../../components/workspaceFileViewer.js';
import type { LocalFileTarget } from '../../localFileTarget.js';
import { PcCapability } from '../../pcCompat.js';
import { encodeSessionTab } from '../../routes.js';
import { terminalLinkNeedsConfirmation, terminalUrlDestination, terminalUrlHost, type TerminalLinkTarget } from '../../terminalLinks.js';
import { terminalSubmitPlan } from '../../terminalKeys.js';
import { terminalViewportForPrefs, type TerminalGrid } from '../../terminalViewport.js';
import type { SpaceTerminal } from '../../navigationTargets.js';
import { monoFamily } from '../../monoFont.js';
import { colors, radius, space, type } from '../../theme.js';
import { AccessoryKeyBar } from './commandDock.js';
import { errorKind } from './errorKind.js';
import { createTerminalAttachments } from './terminalAttachments.js';
import { terminalDraftKey, useTerminalDrafts } from './terminalDrafts.js';
import { TerminalInputBar } from './terminalInputBar.js';
import { liveInputEnabled, useTerminalLiveInputChoices } from './terminalLiveInputChoice.js';
import { LiveInputResync } from './liveInputResync.js';
import { useParaToast } from '../../paraToast.js';
import { openUrlInPcBrowser } from './terminalLinkOpen.js';
import { readClipboardText } from '../../nativeClipboard.js';

/**
 * 画面のペインが持つターミナルの出力購読。同じターミナルのセッションが2枚積まれても、上を閉じたときに
 * 下の購読まで解かないよう、最後の1つが手放したときだけ detach する（`terminalAttachments.ts`）。
 */
const terminalAttachments = createTerminalAttachments(
	terminalKey => useAppStore.getState().attachTerminal(terminalKey),
	terminalKey => useAppStore.getState().detachTerminal(terminalKey),
);

/**
 * ターミナルのタブ（とエージェントのターミナル表示）。PC の実ターミナルを xterm.js（既存の TermView）で
 * 写し、下に Orca のコマンドドック（アクセサリキーの行＋入力バー）を置く。
 *
 * 送る内容は旧画面（legacy-screens/(tabs)/terminal.tsx）と同じ:
 *  - 入力バーの送信: 空なら Enter 単独、文字があれば貼り付けとして送り、「Enter なし」でなければ実行する
 *  - キー: `terminalKeys.ts` の対応（Ctrl は押しっぱなしにして次のキーか1文字に掛かる）
 *
 * ライブ入力（キー行の » ）をオンにすると、入力欄を介さず打った文字をそのまま送る（英数のキーボード）。
 *
 * キーボードを開いてもターミナルの高さは変えない（縮めると PC 側がリサイズされ、TUI が開閉のたびに
 * 全画面を描き直す）。枠だけを縮めて下端で揃え、はみ出した上側を切る。
 *
 * ターミナルに出たリンクを押すと開く（W2-31、Q123 A）。URL は `localhost` やプライベートアドレスなら
 * PC の内蔵ブラウザで開いてブラウザのタブで映し、それ以外は Safari。ファイルパスはこのターミナルの
 * 作業フォルダを基準に PC が解決し、ワークスペースの中のファイルだけをファイルビューアで開く（外なら何もしない）。
 *
 * 「スマホの幅に合わせる」で PC のターミナルを縮めている間に PC で［PC の幅に戻す］が押されたら（W2-19）、
 * ターミナルの上に「PC 側で元の幅に戻されました」と［再び合わせる］を出す。開き直すまではスマホから縮めない。
 */
export function TerminalPane({ terminal, active, keyboardVisible, bottomInset }: {
	terminal: SpaceTerminal;
	/** この画面が前面にあり、このタブを見ているか。 */
	active: boolean;
	keyboardVisible: boolean;
	bottomInset: number;
}) {
	const terminalKey = terminal.terminalKey;
	// 旧 PC の経路（出力の文字列を丸ごと渡す）でだけ使う。同期ストリームの snapshot を一度受けたら、TermView は
	// これを見ない。見ない値を購読し続けると、出力 1 フレームごとにこのペイン全体が再描画され、大量出力の間
	// JS が詰まる（出力は TermView がストリームから直接受けるので、ここで追う必要は無い）。
	const streamingRef = useRef(false);
	const output = useAppStore(s => streamingRef.current ? '' : (s.terminalOutput.get(terminalKey) ?? ''));
	const { attachTerminal, subscribeTerminal, sendInput, sendLiveKeys, sendLiveArrowKey, sendTextInput, scrollTerminal, terminalPrefs, setTerminalPref, setTerminalViewport, activePcId, fsUpload } = useAppStore(useShallow(s => ({
		attachTerminal: s.attachTerminal,
		subscribeTerminal: s.subscribeTerminal,
		sendInput: s.sendInput,
		sendLiveKeys: s.sendLiveKeys,
		sendLiveArrowKey: s.sendLiveArrowKey,
		sendTextInput: s.sendTextInput,
		scrollTerminal: s.scrollTerminal,
		terminalPrefs: s.terminalPrefs,
		setTerminalPref: s.setTerminalPref,
		setTerminalViewport: s.setTerminalViewport,
		activePcId: s.activePcId,
		fsUpload: s.fsUpload,
	})));

	// タブを離れたら PC 側の購読を解く（放置すると全ターミナルの出力が送られ続ける）。ただし同じターミナルを
	// 別の画面がまだ見ていれば解かない。
	useEffect(() => terminalAttachments.hold(terminalKey), [terminalKey]);
	const subscribe = useMemo(() => (listener: Parameters<typeof subscribeTerminal>[1]) => subscribeTerminal(terminalKey, listener), [terminalKey, subscribeTerminal]);
	useEffect(() => {
		streamingRef.current = false;
		return subscribeTerminal(terminalKey, event => {
			if (event.kind === 'snapshot') {
				streamingRef.current = true;
			}
		});
	}, [terminalKey, subscribeTerminal]);
	const resync = useMemo(() => () => attachTerminal(terminalKey), [terminalKey, attachTerminal]);

	// TermView が実測したグリッドと設定から、PC への寸法の申告を組み立てる（旧画面と同じ）。
	const [grid, setGrid] = useState<TerminalGrid | undefined>(undefined);
	useEffect(() => {
		setTerminalViewport(terminalViewportForPrefs(grid, terminalPrefs));
	}, [grid, terminalPrefs, activePcId, setTerminalViewport]);
	useEffect(() => () => setTerminalViewport(undefined), [setTerminalViewport]);

	// PC で幅を戻されたか（W2-19）。開き直す（このペインを作り直す）と PC も印を外すので、ペインの間だけ持つ。
	const [viewportRevoked, setViewportRevoked] = useState(() => isTerminalViewportRevoked(terminalKey));
	useEffect(() => {
		setViewportRevoked(isTerminalViewportRevoked(terminalKey));
		const subscription = onTerminalViewportRevoked((key, revoked) => {
			if (key === terminalKey) {
				setViewportRevoked(revoked);
			}
		});
		return () => subscription.dispose();
	}, [terminalKey, activePcId]);

	// 枠の高さ。キーボードが閉じているときの高さを保つ（開閉で PTY をリサイズさせない）。
	const [outputHeight, setOutputHeight] = useState(0);
	const outputWidthRef = useRef(0);
	/** 前面でない間に届いた枠の寸法（回転・Split View の幅変更）。前面に戻ったときに当てる。 */
	const deferredLayoutRef = useRef<{ readonly height: number; readonly width: number } | undefined>(undefined);
	const applyOutputLayout = (next: number, nextWidth: number) => {
		const widthChanged = outputWidthRef.current !== 0 && Math.abs(outputWidthRef.current - nextWidth) > 0.5;
		outputWidthRef.current = nextWidth;
		if (!keyboardVisible || next > outputHeight || widthChanged) {
			setOutputHeight(next);
		}
	};
	const onOutputLayout = (event: LayoutChangeEvent) => {
		const { height, width } = event.nativeEvent.layout;
		if (!active && outputHeight > 0) {
			// 前面に戻っても寸法が変わらなければ onLayout は来ないので、控えておいて戻ったときに当てる。
			deferredLayoutRef.current = height > 0 ? { height, width } : undefined;
			return;
		}
		deferredLayoutRef.current = undefined;
		applyOutputLayout(height, width);
	};
	useEffect(() => {
		const deferred = deferredLayoutRef.current;
		if (!active || deferred === undefined) {
			return;
		}
		deferredLayoutRef.current = undefined;
		applyOutputLayout(deferred.height, deferred.width);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 前面に戻ったときだけ
	}, [active]);

	// ターミナルに出たリンク（W2-31）。
	const router = useRouter();
	const [viewer, setViewer] = useState<{ ws: string; path: string; line?: number } | undefined>(undefined);
	const openGeneration = useRef(0);
	useEffect(() => () => { openGeneration.current++; }, []);
	const openFile = (target: LocalFileTarget) => {
		const ws = terminal.ws ?? useAppStore.getState().workspace?.activeWs;
		if (ws === undefined) {
			return;
		}
		const generation = ++openGeneration.current;
		// terminalKey を付けると、このターミナルの作業フォルダを基準に相対パスを解決する（受けられる PC にだけ付ける。
		// 付けない PC はワークスペースの根から解決する）。外のファイル・無いファイルは何もしない。
		const fromTerminal = pcHasCapabilityFor(activePcId, PcCapability.FsResolveLinkTerminal) ? { terminalKey } : {};
		sendPcRequest<{ path?: unknown }>(activePcId, 'fs', { t: 'resolveLink', ws, path: target.path, ...fromTerminal }).then(resolved => {
			if (openGeneration.current === generation && typeof resolved.path === 'string') {
				setViewer({ ws, path: resolved.path, ...(target.line !== undefined ? { line: target.line } : {}) });
			}
		}).catch(() => { /* ワークスペースの外・存在しないパス */ });
	};
	const openUrlOnPc = async (url: string) => {
		if (!pcHasCapabilityFor(activePcId, PcCapability.BrowserOpenUrl)) {
			Alert.alert('PC のブラウザで開けません', 'PC の Para Code を更新すると、PC の中でしか見られない URL（localhost など）をスマホから開けます。');
			return;
		}
		const generation = ++openGeneration.current;
		// このターミナルのスペースに開く（browser.space.v1 の PC。古い PC は ws を見ずに PC の今のスペースへ開く）。
		// ページの一覧も同じスペースで絞り、ブラウザのタブに出る一覧と揃える。
		const ws = terminal.ws ?? useAppStore.getState().workspace?.activeWs;
		const space = ws !== undefined ? useAppStore.getState().workspace?.workspaces.find(candidate => candidate.id === ws) : undefined;
		const scope = space !== undefined ? { windowId: space.windowId, ws: space.sourceId } : undefined;
		let target: { targetId: string; url: string } | undefined;
		try {
			target = await openUrlInPcBrowser(url, {
				open: () => sendPcRequest(activePcId, 'fs', { t: 'openUrl', url, ...(ws !== undefined && space !== undefined ? { ws } : {}) }),
				listTargets: async () => (await useAppStore.getState().browserTargets(scope)).targets,
				wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
			});
		} catch (err) {
			console.warn('[session] opening a terminal URL on the PC failed', errorKind(err));
			if (err instanceof Error && err.message === 'space-not-visible') {
				Alert.alert('PC のブラウザで開けませんでした', 'PC でこのスペースを表示していないため、このスペースにページを開けません。PC でこのスペースに切り替えてから、もう一度お試しください。');
				return;
			}
			Alert.alert('PC のブラウザで開けませんでした', 'PC との接続を確認して、もう一度お試しください。');
			return;
		}
		if (openGeneration.current !== generation) {
			return;
		}
		const desktopEpoch = useAppStore.getState().workspace?.desktopEpoch;
		if (target !== undefined && desktopEpoch !== undefined) {
			useAppStore.getState().setBrowserSelection({ targetId: target.targetId, url: target.url, desktopEpoch, ...(scope !== undefined ? { scopeKey: `${scope.windowId}:${scope.ws}` } : {}) });
		}
		router.setParams({ tab: encodeSessionTab({ kind: 'browser' }) });
	};
	const openLink = (link: TerminalLinkTarget) => {
		if (link.kind === 'file') {
			openFile(link.target);
			return;
		}
		const destination = terminalUrlDestination(link.url);
		if (destination === 'external') {
			void Linking.openURL(link.url).catch(() => { /* 開けない URL は無視 */ });
		} else if (destination === 'pc') {
			if (terminalLinkNeedsConfirmation(link)) {
				// OSC 8 のリンクは見えている文字と行き先が違いうる。PC の中を開くときだけ、行き先を見せて確かめる。
				const shown = link.label !== undefined && link.label.length > 80 ? `${link.label.slice(0, 80)}…` : link.label;
				Alert.alert('PC のブラウザで開きますか', `「${shown}」の行き先は ${terminalUrlHost(link.url) ?? link.url} です。\n${link.url}`, [
					{ text: 'キャンセル', style: 'cancel' },
					{ text: '開く', onPress: () => { void openUrlOnPc(link.url); } },
				]);
				return;
			}
			void openUrlOnPc(link.url);
		}
	};

	// 入力欄の書きかけはターミナルごとにペインの外へ置く（タブや表示を切り替えても消えないように）。
	const draftKey = terminalDraftKey(activePcId, terminalKey);
	const input = useTerminalDrafts(s => s.drafts[draftKey] ?? '');
	const setInput = (next: string | ((current: string) => string)) => useTerminalDrafts.getState().update(draftKey, next);
	const [enterless, setEnterless] = useState(false);
	// ライブ入力は既定でオン。自分で切り替えたターミナルはその選択を覚えている（terminalLiveInputChoice.ts）。
	const live = useTerminalLiveInputChoices(s => liveInputEnabled(s.choices, draftKey));
	useEffect(() => useTerminalLiveInputChoices.getState().load(), []);
	const [submitting, setSubmitting] = useState(false);
	const [uploading, setUploading] = useState(false);
	// 打鍵（ライブ入力・キーの列）はアウトボックスへ積まない。つながっていなければ捨て、ライブ入力の入力欄は
	// つながり直したときに空から作り直す（切断中の打鍵を再接続の後に別のプロンプトへ流さない。Q144 A）
	const liveReady = useAppStore(s => s.connection === 'online' && s.pcOnline && s.sessionProtocolReady);
	const [liveResetKey, setLiveResetKey] = useState(0);
	const [liveResync] = useState(() => new LiveInputResync(() => setLiveResetKey(key => key + 1)));
	useEffect(() => liveResync.setReady(liveReady), [liveResync, liveReady]);
	// 届かなかったら黙らずに知らせる（Ctrl-C や Esc が効いたと思わせない）
	const settleKeys = (accepted: boolean) => {
		liveResync.settle(accepted);
		if (!accepted) {
			useParaToast.getState().show({ key: 'terminal-keys-dropped', text: 'PC につながっていないため、キーを送れませんでした', icon: 'alert-circle-outline', tone: 'warn' }, 1_900);
		}
	};
	const send = (data: string) => { void sendLiveKeys(terminalKey, data).then(settleKeys); };
	const sendArrow = (key: 'up' | 'down' | 'left' | 'right') => { void sendLiveArrowKey(terminalKey, key).then(settleKeys); };
	const keyInput = useTerminalKeyInput({ send, sendArrow, resetKey: terminalKey });

	const onChangeInput = (next: string) => {
		const accepted = keyInput.filterComposerText(input, next);
		if (accepted !== undefined) {
			setInput(accepted);
		}
	};
	const submit = async () => {
		if (submitting) {
			return;
		}
		setSubmitting(true);
		const submitted = input;
		const plan = terminalSubmitPlan(submitted, enterless);
		// 空のまま送信 = Enter 単独（貼り付けで包むと空の貼り付けになるため生の Enter を送る）。
		const accepted = plan.kind === 'enter'
			? await sendInput(terminalKey, '\r')
			: await sendTextInput(terminalKey, plan.text, plan.execute);
		// 書きかけはターミナルごとなので、送り終える前にタブを移っていても送ったターミナルの分だけを空にする。
		if (accepted) {
			setInput(current => current === submitted ? '' : current);
		}
		setSubmitting(false);
	};

	/** ライブ入力で打った1文字（Ctrl が点いていれば制御文字にする）。制御文字として送ったら true。 */
	const sendLiveText = (text: string): boolean => {
		if (text.length === 1) {
			const filtered = keyInput.filterComposerText('', text);
			if (filtered === undefined) {
				return true;
			}
		}
		send(text);
		return false;
	};

	const paste = async () => {
		// 読めなければ空文字（nativeClipboard.ts。クリップボードのネイティブ部品が無いビルドでも落ちない）。
		const text = await readClipboardText();
		if (text.length === 0) {
			return;
		}
		if (live) {
			void sendTextInput(terminalKey, text, false);
		} else {
			setInput(current => current + text);
		}
	};
	const attachImage = async () => {
		if (uploading) {
			return;
		}
		const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.8 });
		const asset = result.assets?.[0];
		if (result.canceled || asset?.base64 === undefined || asset.base64 === null) {
			return;
		}
		setUploading(true);
		try {
			const { path } = await fsUpload(asset.fileName ?? 'photo.jpg', asset.base64);
			if (live) {
				void sendTextInput(terminalKey, `${path} `, false);
			} else {
				setInput(current => appendUploadedPath(current, path));
			}
		} catch (err) {
			console.warn('[session] terminal image upload failed', errorKind(err));
			Alert.alert('画像を送れませんでした', 'PC との接続を確認して、もう一度お試しください。');
		} finally {
			setUploading(false);
		}
	};

	return (
		<View style={styles.root}>
			<View style={styles.frame} onLayout={onOutputLayout}>
				<View style={[styles.output, outputHeight > 0 ? { height: outputHeight } : styles.fill]}>
					<TermView
						key={terminalKey}
						output={output}
						cols={terminal.cols}
						rows={terminal.rows}
						subscribe={subscribe}
						onNeedResync={resync}
						// 見ている間だけ渡す（渡さない間は実測を報告せず、PC への申告も取り下がる）。
						fontSize={active && terminalPrefs.matchPcWidth ? terminalPrefs.fontSize : undefined}
						onGridChange={setGrid}
						onScroll={(dir, lines) => scrollTerminal(terminalKey, dir, lines)}
						onOpenLink={openLink}
					/>
				</View>
				{/* 高さを変えないよう、ターミナルの上に重ねる（枠の中で位置だけ決める）。 */}
				{viewportRevoked && terminalPrefs.matchPcWidth ? (
					<View style={styles.revokedWrap} pointerEvents="box-none">
						<View style={styles.revoked}>
							<Text style={styles.revokedText}>PC 側で元の幅に戻されました</Text>
							<Button size="sm" variant="secondary" label="再び合わせる" onPress={() => reclaimTerminalViewport(terminalKey)} />
						</View>
					</View>
				) : null}
			</View>
			<AccessoryKeyBar
				keyboardVisible={keyboardVisible}
				phoneWidth={terminalPrefs.matchPcWidth}
				live={live}
				ctrlLatched={keyInput.ctrlLatched}
				onKey={keyInput.pressKey}
				onToggleDisplay={() => setTerminalPref('matchPcWidth', !terminalPrefs.matchPcWidth)}
				onToggleLive={() => useTerminalLiveInputChoices.getState().choose(draftKey, !live)}
				onPaste={() => { void paste(); }}
			/>
			<TerminalInputBar
				live={live}
				liveResetKey={liveResetKey}
				liveConnected={liveReady}
				input={input}
				onChangeInput={onChangeInput}
				onSubmit={() => { void submit(); }}
				submitting={submitting}
				enterless={enterless}
				onToggleEnterless={() => setEnterless(value => !value)}
				uploading={uploading}
				onAttachImage={() => { void attachImage(); }}
				onLiveText={sendLiveText}
				onLiveKey={data => send(data)}
				onLiveArrow={sendArrow}
			/>
			<View style={[styles.bottom, { height: bottomInset }]} />
			{viewer !== undefined ? (
				<WorkspaceFileViewer ws={viewer.ws} path={viewer.path} focusLine={viewer.line} backLabel="ターミナル" onClose={() => setViewer(undefined)} />
			) : null}
		</View>
	);
}

/** ターミナルが無いときの表示（ターミナルの地のまま）。 */
export function TerminalLoading() {
	return (
		<View style={[styles.root, styles.center]}>
			<ActivityIndicator color={colors.textDim} />
			<Text style={styles.placeholder}>ターミナルを読み込んでいます…</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	root: {
		flex: 1,
		minHeight: 0,
		backgroundColor: colors.terminalBg,
	},
	// キーボードで縮む枠。中の箱は高さを保ったまま下端で揃え、はみ出す上側をここで切る。
	frame: {
		flex: 1,
		minHeight: 0,
		justifyContent: 'flex-end',
		overflow: 'hidden',
	},
	output: {
		backgroundColor: colors.terminalBg,
	},
	fill: {
		flex: 1,
	},
	bottom: {
		backgroundColor: colors.panel,
	},
	revokedWrap: {
		position: 'absolute',
		top: space.sm,
		left: space.sm,
		right: space.sm,
		alignItems: 'center',
	},
	// iPad の広い幅で横に伸びすぎないよう、幅は絶対値で抑える。
	revoked: {
		maxWidth: 420,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingVertical: space.xs,
		paddingLeft: space.md,
		paddingRight: space.xs,
		borderRadius: radius.panel,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.borderStrong,
		backgroundColor: colors.panel,
	},
	revokedText: {
		flexShrink: 1,
		fontSize: type.meta,
		color: colors.text,
	},
	center: {
		alignItems: 'center',
		justifyContent: 'center',
		gap: space.sm,
	},
	placeholder: {
		fontFamily: monoFamily,
		fontSize: type.caption,
		color: colors.textMuted,
	},
});
