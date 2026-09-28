// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { pcHasCapabilityFor, sendPcRequest, useAppStore } from '../../appState.js';
import { appendUploadedPath } from '../../components/agentComposerDraft.js';
import { useTerminalKeyInput } from '../../components/terminalKeyRow.js';
import { TermView } from '../../components/termView.js';
import { WorkspaceFileViewer } from '../../components/workspaceFileViewer.js';
import type { LocalFileTarget } from '../../localFileTarget.js';
import { PcCapability } from '../../pcCompat.js';
import { encodeSessionTab } from '../../routes.js';
import { terminalUrlDestination, type TerminalLinkTarget } from '../../terminalLinks.js';
import { terminalSubmitPlan } from '../../terminalKeys.js';
import { terminalViewportForPrefs, type TerminalGrid } from '../../terminalViewport.js';
import type { SpaceTerminal } from '../../navigationTargets.js';
import { monoFamily } from '../../monoFont.js';
import { colors, space, type } from '../../theme.js';
import { AccessoryKeyBar } from './commandDock.js';
import { errorKind } from './errorKind.js';
import { createTerminalAttachments } from './terminalAttachments.js';
import { terminalDraftKey, useTerminalDrafts } from './terminalDrafts.js';
import { TerminalInputBar } from './terminalInputBar.js';
import { liveInputEnabled, useTerminalLiveInputChoices } from './terminalLiveInputChoice.js';
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
 */
export function TerminalPane({ terminal, active, keyboardVisible, bottomInset }: {
	terminal: SpaceTerminal;
	/** この画面が前面にあり、このタブを見ているか。 */
	active: boolean;
	keyboardVisible: boolean;
	bottomInset: number;
}) {
	const terminalKey = terminal.terminalKey;
	const output = useAppStore(s => s.terminalOutput.get(terminalKey) ?? '');
	const { attachTerminal, subscribeTerminal, sendInput, sendArrowKey, sendTextInput, scrollTerminal, terminalPrefs, setTerminalPref, setTerminalViewport, activePcId, fsUpload } = useAppStore(useShallow(s => ({
		attachTerminal: s.attachTerminal,
		subscribeTerminal: s.subscribeTerminal,
		sendInput: s.sendInput,
		sendArrowKey: s.sendArrowKey,
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
	const resync = useMemo(() => () => attachTerminal(terminalKey), [terminalKey, attachTerminal]);

	// TermView が実測したグリッドと設定から、PC への寸法の申告を組み立てる（旧画面と同じ）。
	const [grid, setGrid] = useState<TerminalGrid | undefined>(undefined);
	useEffect(() => {
		setTerminalViewport(terminalViewportForPrefs(grid, terminalPrefs));
	}, [grid, terminalPrefs, activePcId, setTerminalViewport]);
	useEffect(() => () => setTerminalViewport(undefined), [setTerminalViewport]);

	// 枠の高さ。キーボードが閉じているときの高さを保つ（開閉で PTY をリサイズさせない）。
	const [outputHeight, setOutputHeight] = useState(0);
	const outputWidthRef = useRef(0);
	const onOutputLayout = (event: LayoutChangeEvent) => {
		if (!active && outputHeight > 0) {
			return;
		}
		const next = event.nativeEvent.layout.height;
		const nextWidth = event.nativeEvent.layout.width;
		const widthChanged = outputWidthRef.current !== 0 && Math.abs(outputWidthRef.current - nextWidth) > 0.5;
		outputWidthRef.current = nextWidth;
		if (!keyboardVisible || next > outputHeight || widthChanged) {
			setOutputHeight(next);
		}
	};

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
		// terminalKey を付けると、新しい PC はこのターミナルの作業フォルダを基準に相対パスを解決する
		// （古い PC は無視してワークスペースの根から解決する）。外のファイル・無いファイルは何もしない。
		sendPcRequest<{ path?: unknown }>(activePcId, 'fs', { t: 'resolveLink', ws, path: target.path, terminalKey }).then(resolved => {
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
		let target: { targetId: string; url: string } | undefined;
		try {
			target = await openUrlInPcBrowser(url, {
				open: () => sendPcRequest(activePcId, 'fs', { t: 'openUrl', url }),
				listTargets: async () => (await useAppStore.getState().browserTargets()).targets,
				wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
			});
		} catch (err) {
			console.warn('[session] opening a terminal URL on the PC failed', errorKind(err));
			Alert.alert('PC のブラウザで開けませんでした', 'PC との接続を確認して、もう一度お試しください。');
			return;
		}
		if (openGeneration.current !== generation) {
			return;
		}
		const desktopEpoch = useAppStore.getState().workspace?.desktopEpoch;
		if (target !== undefined && desktopEpoch !== undefined) {
			useAppStore.getState().setBrowserSelection({ targetId: target.targetId, url: target.url, desktopEpoch });
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
	const send = (data: string) => { void sendInput(terminalKey, data); };
	const keyInput = useTerminalKeyInput({ send, sendArrow: key => sendArrowKey(terminalKey, key), resetKey: terminalKey });

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

	/** ライブ入力で打った1文字（Ctrl が点いていれば制御文字にする）。 */
	const sendLiveText = (text: string) => {
		if (text.length === 1) {
			const filtered = keyInput.filterComposerText('', text);
			if (filtered === undefined) {
				return;
			}
		}
		send(text);
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
				onLiveArrow={key => sendArrowKey(terminalKey, key)}
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
