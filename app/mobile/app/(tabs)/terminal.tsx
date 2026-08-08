// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting } from '../../src/store.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { TermView } from '../../src/components/termView.js';
import { useWsHeader, useEffectiveWs } from '../../src/components/wsDrawer.js';
import { GlassComposer } from '../../src/components/glassComposer.js';
import { TerminalPicker, terminalPickerIsNative } from '../../src/components/terminalPicker.js';
import { useKeyboardVisible } from '../../src/hooks/useKeyboardVisible.js';
import { useIsRegularWidth } from '../../src/hooks/useSizeClass.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { GlassSurface } from '../../src/components/glassSurface.js';
import { useParaHeaderHeight, type ParaHeaderIcon } from '../../src/paraHeader.js';
import { colors, radius, squircle } from '../../src/theme.js';
import { hapticImpact, hapticSelection, hapticWarning } from '../../src/haptics.js';
import { resolveExplicitTerminalSelection } from '../../src/agentNavigation.js';
import { terminalViewportForPrefs, type TerminalGrid } from '../../src/terminalViewport.js';

/**
 * ターミナル画面（モックアップ準拠）。選択中ワークスペースのターミナルタブを
 * チップで切り替え、PCの実ターミナルをミラー表示・入力する。応答待ちのタブは
 * 赤ドットで示す。修飾キー行から Esc/Tab/^C/矢印も送れる。
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
	const [input, setInput] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const insets = useStableInsets();
	const keyboardVisible = useKeyboardVisible();
	// iPad幅ではタブバーがサイドバー側にあり、入力欄の下に避けるものが無い。
	const regular = useIsRegularWidth();
	const isFocused = useIsFocused();

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
	const actions = useMemo<ParaHeaderIcon[]>(() => [{
		key: 'new-terminal',
		icon: 'add',
		label: '新しいターミナル',
		size: 21,
		onPress: createHere,
	}], [createHere]);

	// ターミナルの切り替えは**ヘッダーの中央の島から出る標準のメニュー**（terminalPicker.tsx）。
	// エージェント詳細と同じ「3つの島」の形に揃うぶん、横スクロールのチップ列を畳んでいる。
	// ネイティブの標準メニューを持たないビルドでは、従来どおり帯にチップ列を出す。
	const pickerEntries = useMemo(() => terminals.map((t, i) => ({
		terminalKey: t.terminalKey,
		title: t.title,
		index: i + 1,
		waiting: isAgentWaiting(t.agentStatus),
		working: t.agentStatus === 'working',
	})), [terminals]);
	// 他のターミナルに応答待ちがあることの合図。畳んだぶん、ここで気づけるようにする
	// （チップ列は各行の赤ドットを常に見せていた）。
	const otherWaiting = pickerEntries.some(entry => entry.waiting && entry.terminalKey !== activeKey);
	const mid = useMemo(() => (terminalPickerIsNative ? {
		label: 'ターミナルを切り替える',
		badge: otherWaiting,
		node: (
			<TerminalPicker
				entries={pickerEntries}
				activeKey={activeKey}
				onSelect={setSelectedTerminalKey}
				onCreate={createHere}
			/>
		),
	} : undefined), [pickerEntries, activeKey, setSelectedTerminalKey, createHere, otherWaiting]);

	// フォールバックのタブ列。ネイティブの標準メニューが無いビルド（Android・このモジュールを
	// 含まない旧バイナリ）でだけ帯に出す。
	const chipBand = terminalPickerIsNative || terminals.length === 0 ? undefined : (
		<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabContent}>
			{terminals.map((t, i) => {
				const active = t.terminalKey === activeKey;
				const body = (
					<Pressable style={styles.tabHit} onPress={() => { hapticSelection(); setSelectedTerminalKey(t.terminalKey); }} accessibilityRole="button" accessibilityState={{ selected: active }}>
						{isAgentWaiting(t.agentStatus)
							? <View style={styles.dotRed} />
							: t.agentStatus === 'working' ? <View style={styles.dotGreen} /> : null}
						<Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>{i + 1}: {t.title}</Text>
					</Pressable>
				);
				// 選んでいるものだけ不透明なアクセントの地にする（ホームの絞り込みチップと同じ作法）。
				return active
					? <View key={t.terminalKey} style={[styles.tabChip, styles.tabChipActive]}>{body}</View>
					: <GlassSurface key={t.terminalKey} style={styles.tabChip} interactive>{body}</GlassSurface>;
			})}
		</ScrollView>
	);

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
	const submit = async () => {
		if (activeKey === undefined || submitting) {
			return;
		}
		setSubmitting(true);
		const submitted = input;
		const submittedKey = activeKey;
		let accepted = false;
		if (input === '') {
			// 空のまま送信 = Enter 単独（TUIの確認プロンプト等に必要）。bracketed paste で
			// 包むと空ペーストになってしまうため生のEnterを送る。
			accepted = await sendInput(activeKey, '\r');
		} else {
			// テキストはPC側でbracketed paste対応の上で実行される（複数行対応）。
			accepted = await sendTextInput(activeKey, submitted, true);
		}
		if (accepted && activeKeyRef.current === submittedKey) {
			setInput(current => current === submitted ? '' : current);
		}
		setSubmitting(false);
	};

	useWsHeader({ actions, mid, below: chipBand });

	return (
		<ConnectionGate>
		{/* enabled={isFocused}: NativeTabsの画面凍結中に keyboardWillHide を取り逃すと
		    下パディングが張り付き、復帰時にUIが上へ潰れる（非フォーカスで無効化→復帰時に
		    クリーンな状態から再計算させる） */}
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90} enabled={isFocused}>
			{/* ヘッダーは浮かぶ島。タブチップ列がその下に潜らないよう、実測した高さぶん上を空ける。
			    この画面だけドロワーの全域スワイプを巻かないのは、チップ列が横スクロールで
			    指の動きの向きが同じになり、どちらが取るか状況で変わるため（左端24ptのエッジ
			    スワイプは WsDrawerLayout 側で従来どおり効く）。 */}
			{/* キーボードを開いても**ターミナルの高さは変えない**。縮めると行数が変わり、
			    PTYのリサイズ → SIGWINCH → TUIの全画面再描画が開閉のたびに2往復する。
			    枠だけを縮めて中身を下端で揃え、はみ出した上側を切って「上へずれた」ように
			    見せる（下端のプロンプトは常に見えるので実用上これで足りる）。

			    高さは「キーボードが閉じているとき」の枠の高さを採る。広がる向きの変化は
			    常に採るのは、初回マウント時に既にキーボードが出ていた場合（他画面から戻る等）に
			    0 のまま固定されるのを避けるため。回転や Split View の幅変更でも測り直されるが、
			    それはキーボードを閉じている間に限る（出したまま回すと、閉じるまで旧い高さのまま
			    上へはみ出す。閉じれば直る）。 */}
			<View
				// ヘッダーは浮いているので、その高さぶん上を空ける（ここを変えると箱の高さ＝
				// PCへ申告するPTYの行数まで変わる点に注意）。
				style={[styles.outputSlot, { marginTop: headerHeight }]}
				onLayout={event => {
					// **このタブを見ている間だけ採る。** 高さの基準（ヘッダー）はアプリ全体で
					// 共有しているので、裏に回っている間に別画面のヘッダー高さでこの箱が動く。
					// 裏の値を拾うと、戻ったときに上端がはみ出したまま固まる。
					// ただし**一度も測れていないときは採る**——タブは非フォーカスで先に
					// マウントされることがあり、遷移元とヘッダー高さが同じだと再レイアウトが
					// 起きないので、0 のまま固まって初回のキーボードで縮んだ高さを拾ってしまう。
					if (!isFocused && outputHeight > 0) {
						return;
					}
					const next = event.nativeEvent.layout.height;
					if (!keyboardVisible || next > outputHeight) {
						setOutputHeight(next);
					}
				}}
			>
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
									fontSize={isFocused && terminalPrefs.matchPcWidth ? terminalPrefs.fontSize : undefined}
							onGridChange={setGrid}
							onScroll={scroll}
						/>
					) : (
						<Text style={styles.placeholder}>(ターミナルなし — 右上の + で作成できます)</Text>
					)}
				</View>
			</View>
			<View style={[styles.inputBar, { paddingBottom: keyboardVisible ? 8 : insets.bottom + (regular ? 12 : 30) }]}>
				<GlassComposer
					value={input}
					onChangeText={setInput}
					onSubmit={submit}
					placeholder="コマンドまたは回答を入力…"
					sendIcon={input ? 'arrow-up' : 'return-down-back'}
					monospace
					tools={
						<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.keyRowScroll} contentContainerStyle={styles.keyRow} keyboardShouldPersistTaps="always">
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('\u001b'); }}><Text style={styles.keyText}>Esc</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('\t'); }}><Text style={styles.keyText}>Tab</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticWarning(); send('\u0003'); }}><Text style={[styles.keyText, styles.keyDanger]}>^C</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('up'); }}><Text style={styles.keyText}>↑</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('down'); }}><Text style={styles.keyText}>↓</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('left'); }}><Text style={styles.keyText}>←</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('right'); }}><Text style={styles.keyText}>→</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('/'); }}><Text style={styles.keyText}>/</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('|'); }}><Text style={styles.keyText}>|</Text></Pressable>
						</ScrollView>
					}
				/>
			</View>
		</KeyboardAvoidingView>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	// ここの余白を変えると、出力領域の高さ＝PCへ申告するPTYの行数まで変わる。
	// 今回のガラス化でヘッダーが8pt高く、チップ行が4pt低くなり、差し引き**4ptほど狭い**。
	// 行送りより小さいので通常は行数が変わらないが、「変わらない」と決め打たないこと
	// （実測値は TermView が測り直してPCへ申告し直す）。
	// 帯（ヘッダー層）が左右の余白を持つので、ここは持たない。
	tabContent: { gap: 7, alignItems: 'center' },
	tabChip: { height: 32, borderRadius: radius.pill, ...squircle, maxWidth: 200 },
	tabChipActive: { backgroundColor: 'rgba(9,175,217,0.30)', borderWidth: 1, borderColor: 'rgba(9,175,217,0.5)' },
	tabHit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13 },
	tabText: { color: colors.text, fontSize: 11.5, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	tabTextActive: { color: '#bfeeff', fontWeight: '700' },
	dotRed: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.red },
	dotGreen: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
	operationWarning: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: 'rgba(245,158,11,.12)', borderWidth: 1, borderColor: 'rgba(245,158,11,.35)' },
	operationWarningText: { flex: 1, color: colors.text, fontSize: 11, lineHeight: 16 },
	// キーボードで縮む「枠」。中の箱は高さを保ったまま下端で揃え、はみ出す上側をここで切る。
	// **左右の余白と枠は持たない。** エージェント詳細の会話が地色に直接流れているのと同じ
	// 言語に揃える（枠があると同じアプリの同じ役割の画面に見えない）。
	// 注意: この余白を変えると箱の高さが変わり、PCへ申告するPTYの行数まで変わる。
	outputSlot: { flex: 1, overflow: 'hidden', justifyContent: 'flex-end' },
	output: { backgroundColor: '#1e1e1e', overflow: 'hidden' },
	placeholder: { color: colors.textDim, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, padding: 10 },
	keyRowScroll: { flex: 1, minWidth: 0 },
	keyRow: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingRight: 8 },
	key: { backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, ...squircle, paddingHorizontal: 13, paddingVertical: 7 },
	keyPressed: { backgroundColor: colors.accentWash, borderColor: colors.accent },
	keyText: { color: colors.text, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	keyDanger: { color: colors.red },
	inputBar: { paddingHorizontal: 12, paddingTop: 10 },
});
