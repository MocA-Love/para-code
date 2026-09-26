// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAttentionAgent } from '../../src/attentionCount.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { TerminalBodyLayout } from '../../src/components/terminalBodyLayout.js';
import { TermView } from '../../src/components/termView.js';
import { useWsHeader, useEffectiveWs } from '../../src/components/wsDrawer.js';
import { GlassComposer } from '../../src/components/glassComposer.js';
import { TerminalCompactMenu, TerminalFallbackBand, TerminalPicker, terminalPickerIsNative } from '../../src/components/terminalPicker.js';
import { otherAttentionCount, terminalAttentionSubtitle, terminalNativeHeaderLayout } from '../../src/components/terminalHeaderBehavior.js';
import { TerminalKeyRow, useTerminalKeyInput } from '../../src/components/terminalKeyRow.js';
import { PresetSheet } from '../../src/components/presetSheet.js';
import { useKeyboardCoverage, useKeyboardVisible } from '../../src/hooks/useKeyboardVisible.js';
import { useSizeClass } from '../../src/hooks/useSizeClass.js';
import { useTabBarSpacer } from '../../src/hooks/useTabBarSpacer.js';
import { useParaHeaderHeight, type ParaHeaderIcon } from '../../src/paraHeader.js';
import { monoFamily } from '../../src/monoFont.js';
import { alpha, colors, radius, squircle, tint, type } from '../../src/theme.js';
import { hapticSelection } from '../../src/haptics.js';
import { resolveExplicitTerminalSelection } from '../../src/agentNavigation.js';
import { terminalViewportForPrefs, type TerminalGrid } from '../../src/terminalViewport.js';
import { terminalSubmitIcon, terminalSubmitPlan } from '../../src/terminalKeys.js';

/**
 * ターミナル画面（モックアップ準拠）。選択中ワークスペースのターミナルタブを
 * チップで切り替え、PCの実ターミナルをミラー表示・入力する。応答待ちのタブは
 * 赤ドットで示す。キー行（terminalKeyRow.tsx）から Esc/Tab/Ctrl/矢印なども送れる。
 *
 * 表示は xterm.js（WebView、termView.tsx）で行い、claude / codex などの TUI も
 * PC と同じ描画になる。cols/rows は PC 側ターミナルと同一に保つ。
 */
export default function TerminalScreen() {
	const ws = useEffectiveWs();
	const { workspace, terminalOutput, selectedTerminalKey, setSelectedTerminalKey, attachTerminal, detachTerminal, subscribeTerminal, sendInput, sendArrowKey, sendTextInput, createTerminal, terminalPrefs, setTerminalViewport, activePcId, scrollTerminal } = useAppStore(useShallow(s => ({
		workspace: s.workspace, terminalOutput: s.terminalOutput,
		selectedTerminalKey: s.selectedTerminalKey, setSelectedTerminalKey: s.setSelectedTerminalKey,
		attachTerminal: s.attachTerminal, detachTerminal: s.detachTerminal, subscribeTerminal: s.subscribeTerminal, sendInput: s.sendInput,
		sendArrowKey: s.sendArrowKey, sendTextInput: s.sendTextInput, createTerminal: s.createTerminal,
		terminalPrefs: s.terminalPrefs, setTerminalViewport: s.setTerminalViewport, activePcId: s.activePcId,
		scrollTerminal: s.scrollTerminal,
	})));
	const headerHeight = useParaHeaderHeight();
	// ターミナルの箱の高さ。キーボードを閉じているときの枠の高さを測って固定し、
	// キーボードが出ている間はこの値を保つ（縮めるとPTYのリサイズを誘発するため）。
	const [outputHeight, setOutputHeight] = useState(0);
	// 枠の幅。回転・Split View 変更（＝PTYの再申告が必要な寸法変化）を検知するための控え。
	const outputWidthRef = useRef(0);
	const [input, setInput] = useState('');
	const [submitting, setSubmitting] = useState(false);
	// 「Enterなし」: 送信しても Enter を付けない（コマンドを PC 側で直してから実行したいとき用）。
	// この画面を開いている間だけの切り替えで、保存はしない。
	const [enterless, setEnterless] = useState(false);
	const keyboardVisible = useKeyboardVisible();
	// 下端がキーボードに食われる高さ。枠をこのぶん縮める（ターミナルの中身の高さは変えない）。
	const keyboardCover = useKeyboardCoverage();
	// 特殊キー列（Esc/^C/矢印）がフローティングタブバーの裏へ潜らないぶんの下余白。
	// index/files/scm と同じ規範値を使う（regular=12 はタブバーがサイドバー側にあるため）。
	const tabBarSpacer = useTabBarSpacer();
	const isFocused = useIsFocused();
	const sizeClass = useSizeClass();
	const nativeHeaderLayout = terminalNativeHeaderLayout(sizeClass);

	// ws 未タグのターミナルはPC側でアクティブなワークスペース所属として扱う
	// （全ワークスペースに重複表示しない）。
	// **memo する。** ヘッダーの仕様（中央の島）へ流れるので、毎レンダー新しい配列だと
	// ターミナル出力のチャンクごとにヘッダー層へ書き込みが走る。
	const terminals = useMemo(() => (workspace?.terminals ?? []).filter(t =>
		!ws || t.ws === ws.id || (!t.ws && ws.id === workspace?.activeWs)),
		[workspace?.terminals, workspace?.activeWs, ws]);
	const activeTerminal = resolveExplicitTerminalSelection(terminals, selectedTerminalKey, () => true);
	const activeKey = activeTerminal?.terminalKey;
	const activeKeyRef = useRef(activeKey);
	activeKeyRef.current = activeKey;
	const output = activeKey !== undefined ? terminalOutput.get(activeKey) ?? '' : '';

	useEffect(() => {
		if (activeKey === undefined) {
			return;
		}
		attachTerminal(activeKey);
		// タブ/ワークスペース切り替え時にPC側の購読を解放する（放置するとPCが全て
		// のターミナルへ出力を送り続けてしまう）。
		return () => detachTerminal(activeKey);
	}, [activeKey, attachTerminal, detachTerminal]);

	// TermView への同期ストリーム購読口（端末ごとに安定した関数を渡す）。
	const subscribeActive = useMemo(() => {
		if (activeKey === undefined) {
			return undefined;
		}
		return (listener: Parameters<typeof subscribeTerminal>[1]) => subscribeTerminal(activeKey, listener);
	}, [activeKey, subscribeTerminal]);
	// WebViewプロセス死・inject欠落時の再同期: 再attach（新epoch）でsnapshotを取り直す。
	const resyncActive = useMemo(() => {
		if (activeKey === undefined) {
			return undefined;
		}
		return () => attachTerminal(activeKey);
	}, [activeKey, attachTerminal]);

	// TermViewが実測したグリッド。設定と掛け合わせてPCへの申告を組み立てる。
	// 「行数も合わせる」を切り替えた直後にも反映されるよう、申告の組み立てはこの画面が持ち、
	// TermView は実測値を報告するだけにしてある（TermView 側に持たせると、設定変更では
	// 実測値が変わらないため再申告の契機が無くなる）。
	const [grid, setGrid] = useState<TerminalGrid | undefined>(undefined);
	// activePcId を依存に入れるのは、PCを切り替えたときに新しいPCへ申告し直すため
	// （申告はアクティブPCの接続にしか送らないので、切り替えただけでは新しいPCが何も知らない）。
	useEffect(() => {
		setTerminalViewport(terminalViewportForPrefs(grid, terminalPrefs));
	}, [grid, terminalPrefs, activePcId, setTerminalViewport]);
	// 画面を完全に離れるときは必ず取り下げる（PCのターミナルを細いまま残さない）。
	useEffect(() => () => setTerminalViewport(undefined), [setTerminalViewport]);

	const createHere = useCallback(() => { hapticSelection(); createTerminal(ws?.id); }, [createTerminal, ws]);
	// コマンドプリセット（PC版のターミナルタブバー右のボタンと同じもの）の一覧。
	// 常用の1件を1タップで、という形にはしていない——プリセットは手元を離れたPCへ
	// コマンドを流す操作なので、何が走るかを見てから押せる場所に置く。
	const [presetsOpen, setPresetsOpen] = useState(false);

	// ターミナルの切り替えは**ヘッダーの中央の島から出る標準のメニュー**（terminalPicker.tsx）。
	// エージェント詳細と同じ「3つの島」の形に揃うぶん、横スクロールのチップ列を畳んでいる。
	// ネイティブの標準メニューを持たないビルドでは、従来どおり帯にチップ列を出す。
	const pickerEntries = useMemo(() => terminals.map((t, i) => ({
		terminalKey: t.terminalKey,
		title: t.title,
		index: i + 1,
		// 要対応かどうかはタブのバッジ・ホームと同じ判定（attentionCount.ts）で決める。
		waiting: isAttentionAgent(t),
		working: t.agentStatus === 'working',
		agentStatus: t.agentStatus,
	})), [terminals]);
	// 他のターミナルに応答待ちがあることの合図。畳んだぶん、ここで気づけるようにする
	// （チップ列は各行の赤ドットを常に見せていた）。赤い点だけでは何件あるか分からないので、
	// 件数を島の副題にも出す。数えるのはこのスペースのターミナルだけ（切り替え先の一覧と同じ範囲）。
	const otherWaitingCount = otherAttentionCount(pickerEntries, activeKey);
	const otherWaiting = otherWaitingCount > 0;
	// 右のボタン群。regularではターミナルの切り替えもここに並べる。
	//
	// 以前はバーの中央に置いていたが、中央（`titleView`）に使える幅は
	// `画面幅 − 2 × max(左, 右)` しかない——左の島が172ptあると中央は26ptしか残らず、
	// 端末名が1文字まで削られた（実機で確認済み）。右のバー項目なら幅の制限が無く、
	// OSがガラスの器を付けて左の島と揃うし、メニューも右下から自然に開く。
	const actions = useMemo<ParaHeaderIcon[]>(() => {
		const operationalActions: ParaHeaderIcon[] = [
			{
				key: 'presets',
				icon: 'flash-outline',
				label: 'コマンドプリセット',
				size: 19,
				onPress: () => { hapticSelection(); setPresetsOpen(true); },
			},
			{
				key: 'new-terminal',
				icon: 'add',
				label: '新しいターミナル',
				size: 21,
				onPress: createHere,
			},
		];
		if (!terminalPickerIsNative) {
			return operationalActions;
		}
		if (nativeHeaderLayout.kind === 'compact-menu') {
			return [{
				key: 'terminal-menu',
				label: 'ターミナル操作',
				badge: otherWaiting ? 'red' : undefined,
				node: (
					<TerminalCompactMenu
						entries={pickerEntries}
						activeKey={activeKey}
						onSelect={setSelectedTerminalKey}
						onOpenPresets={() => setPresetsOpen(true)}
						onCreate={createHere}
					/>
				),
			}];
		}
		return [{
			key: 'picker',
			label: 'ターミナルを切り替える',
			badge: otherWaiting ? 'red' : undefined,
			node: (
				<TerminalPicker
					entries={pickerEntries}
					activeKey={activeKey}
					onSelect={setSelectedTerminalKey}
					onCreate={createHere}
				/>
			),
		}, ...operationalActions];
	}, [activeKey, createHere, nativeHeaderLayout.kind, otherWaiting, pickerEntries, setSelectedTerminalKey]);

	const chipBand = useMemo(() => (
		<TerminalFallbackBand entries={pickerEntries} activeKey={activeKey} onSelect={setSelectedTerminalKey} />
	), [activeKey, pickerEntries, setSelectedTerminalKey]);

	const send = (data: string) => {
		if (activeKey !== undefined) {
			void sendInput(activeKey, data);
		}
	};
	// TUI上のスワイプ。送れなくても再試行しない（指を動かし直せば済む）。
	const scroll = (dir: 'up' | 'down', lines: number) => {
		if (activeKey !== undefined) {
			scrollTerminal(activeKey, dir, lines);
		}
	};
	const sendArrow = (key: 'up' | 'down' | 'right' | 'left') => {
		if (activeKey !== undefined) {
			sendArrowKey(activeKey, key);
		}
	};
	// ターミナルを切り替えたら Ctrl のラッチを外す（切り替え先へ持ち越さない）。
	const keyInput = useTerminalKeyInput({ send, sendArrow, resetKey: activeKey });
	const onChangeInput = (next: string) => {
		const accepted = keyInput.filterComposerText(input, next);
		if (accepted !== undefined) {
			setInput(accepted);
		}
	};
	const submit = async () => {
		if (activeKey === undefined || submitting) {
			return;
		}
		setSubmitting(true);
		const submitted = input;
		const submittedKey = activeKey;
		const plan = terminalSubmitPlan(submitted, enterless);
		let accepted = false;
		if (plan.kind === 'enter') {
			// 空のまま送信 = Enter 単独（TUIの確認プロンプト等に必要）。bracketed paste で
			// 包むと空ペーストになってしまうため生のEnterを送る。
			accepted = await sendInput(activeKey, '\r');
		} else {
			// テキストはPC側でbracketed paste対応の上で送られる（複数行対応）。
			// 「Enterなし」のときは実行せず、PCのコマンド行に置くだけにする。
			accepted = await sendTextInput(activeKey, plan.text, plan.execute);
		}
		if (accepted && activeKeyRef.current === submittedKey) {
			setInput(current => current === submitted ? '' : current);
		}
		setSubmitting(false);
	};

	// 島の副題（既定はブランチ名）の頭に、他のターミナルの要対応の件数を足す。
	useWsHeader({ actions, subtitle: terminalAttentionSubtitle(otherWaitingCount, ws?.branch) });

	const terminalKeyTools = (
		<TerminalKeyRow
			keyboardVisible={keyboardVisible}
			ctrlLatched={keyInput.ctrlLatched}
			enterless={enterless}
			onKey={keyInput.pressKey}
			onToggleEnterless={() => setEnterless(value => !value)}
		/>
	);

	return (
		<ConnectionGate>
		{/* **`KeyboardAvoidingView` は使わない。** あれは自分のフレームの画面上の絶対位置から
		    下端の食われ方を割り出すので、OS標準のバーの下に置かれるとずれる。ここは以前
		    `keyboardVerticalOffset={90}` で辻褄を合わせていたが、その90ptは自前ヘッダー層が
		    浮いていた頃の値で、バーへ移した後は**引きすぎ**になっていた（入力欄とキーの列が
		    30pt強キーボードに潜った。実機で確認済み）。「下端から何pt隠れるか」を直接測って
		    下余白にする（`useKeyboardCoverage`。画面上のどこに置かれても変わらない値）。
		    非フォーカス中に0へ倒す面倒（NativeTabsの画面凍結中に keyboardWillHide を取り逃すと
			下パディングが張り付く）は、あのフック自身が `useIsFocused` で見ている。 */}
		<View style={[styles.screen, { paddingBottom: keyboardCover }]}>
			<TerminalBodyLayout
				headerHeight={headerHeight}
				nativeMenuAvailable={terminalPickerIsNative}
				terminalCount={terminals.length}
				fallback={chipBand}
				onOutputLayout={event => {
					if (!isFocused && outputHeight > 0) {
						return;
					}
					const next = event.nativeEvent.layout.height;
					const nextWidth = event.nativeEvent.layout.width;
					const widthChanged = outputWidthRef.current !== 0 && Math.abs(outputWidthRef.current - nextWidth) > 0.5;
					outputWidthRef.current = nextWidth;
					if (!keyboardVisible || next > outputHeight || widthChanged) {
						setOutputHeight(next);
					}
				}}
				output={(
					/* キーボードを開いても**ターミナルの高さは変えない**。縮めると行数が変わり、
			    PTYのリサイズ → SIGWINCH → TUIの全画面再描画が開閉のたびに2往復する。
			    枠だけを縮めて中身を下端で揃え、はみ出した上側を切って「上へずれた」ように
			    見せる（下端のプロンプトは常に見えるので実用上これで足りる）。

			    高さは「キーボードが閉じているとき」の枠の高さを採る。広がる向きの変化は
			    常に採るのは、初回マウント時に既にキーボードが出ていた場合（他画面から戻る等）に
			    0 のまま固定されるのを避けるため。回転や Split View の幅変更でも測り直される。
			    キーボードを出したまま回すと、旧い実装では閉じるまで旧い高さのまま上へはみ出した
			    ——**幅の変化は回転・Split View 変更の確実な合図**なので（キーボード出し入れでは
			    幅は変わらない）、幅が動いたときだけは表示中でも採り直して即座に追従させる。 */
				<View style={[styles.output, outputHeight > 0 ? { height: outputHeight } : { flex: 1 }]}>
					{activeKey !== undefined ? (
						// fontSize は「このタブを見ている間だけ」渡す。渡さない間 TermView は実測を
						// 報告しないので grid が undefined になり、PCへの申告も自動で取り下がる。
						// キーボード開閉や回転はタブを離れた後にも起きるため、「離れたら1回取り下げる」
						// 副作用では足りず、申告の入力そのものを止める必要がある。
						<TermView
							key={activeKey}
							output={output}
							cols={activeTerminal?.cols}
							rows={activeTerminal?.rows}
							subscribe={subscribeActive}
							onNeedResync={resyncActive}
							// 幅合わせがオフ（既定）のときは PC の桁数に合わせて縮める（下限 7pt、TermView 側の固定値）。
							fontSize={isFocused && terminalPrefs.matchPcWidth ? terminalPrefs.fontSize : undefined}
							onGridChange={setGrid}
							onScroll={scroll}
						/>
					) : (
						<Text style={styles.placeholder}>(ターミナルなし — 右上の + で作成できます)</Text>
					)}
				</View>
				)}
				input={(
					<View style={{ paddingBottom: keyboardVisible ? 8 : tabBarSpacer }}>
				<GlassComposer
					value={input}
					onChangeText={onChangeInput}
					onSubmit={submit}
					placeholder={enterless ? 'Enter なしで入力…' : 'コマンドまたは回答を入力…'}
					// ⏎ = Enter を押す送信、↑ = コマンド行に置くだけの送信（Enterなし）。
					sendIcon={terminalSubmitIcon(input, enterless)}
					monospace
					tools={terminalKeyTools}
				/>
					</View>
				)}
			/>
			<PresetSheet visible={presetsOpen} ws={ws?.id} wsLabel={ws?.name ?? 'このスペース'} onClose={() => setPresetsOpen(false)} />
		</View>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	operationWarning: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.control, ...squircle, backgroundColor: tint(colors.orange, alpha.wash), borderWidth: 1, borderColor: tint(colors.orange, alpha.line) },
	operationWarningText: { flex: 1, color: colors.text, fontSize: type.caption, lineHeight: 16 },
	// キーボードで縮む「枠」。中の箱は高さを保ったまま下端で揃え、はみ出す上側をここで切る。
	// **左右の余白と枠は持たない。** エージェント詳細の会話が地色に直接流れているのと同じ
	// 言語に揃える（枠があると同じアプリの同じ役割の画面に見えない）。
	// 注意: この余白を変えると箱の高さが変わり、PCへ申告するPTYの行数まで変わる。
	output: { backgroundColor: colors.terminalBg, overflow: 'hidden' },
	placeholder: { color: colors.textDim, fontFamily: monoFamily, fontSize: type.caption, padding: 10 },
});
