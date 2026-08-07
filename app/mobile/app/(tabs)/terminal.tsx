// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting } from '../../src/store.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { TermView } from '../../src/components/termView.js';
import { WsHeader, useEffectiveWs } from '../../src/components/wsDrawer.js';
import { GlassComposer } from '../../src/components/glassComposer.js';
import { useKeyboardVisible } from '../../src/hooks/useKeyboardVisible.js';
import { useIsRegularWidth } from '../../src/hooks/useSizeClass.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { GlassSurface } from '../../src/components/glassSurface.js';
import { HeaderActionButton, HeaderActionPill } from '../../src/components/screenHeader.js';
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
	const { workspace, terminalOutput, selectedTerminalKey, setSelectedTerminalKey, attachTerminal, detachTerminal, subscribeTerminal, sendInput, sendArrowKey, sendTextInput, createTerminal, terminalPrefs, setTerminalViewport, activePcId } = useAppStore(useShallow(s => ({
		workspace: s.workspace, terminalOutput: s.terminalOutput,
		selectedTerminalKey: s.selectedTerminalKey, setSelectedTerminalKey: s.setSelectedTerminalKey,
		attachTerminal: s.attachTerminal, detachTerminal: s.detachTerminal, subscribeTerminal: s.subscribeTerminal, sendInput: s.sendInput,
		sendArrowKey: s.sendArrowKey, sendTextInput: s.sendTextInput, createTerminal: s.createTerminal,
		terminalPrefs: s.terminalPrefs, setTerminalViewport: s.setTerminalViewport, activePcId: s.activePcId,
	})));
	const [headerHeight, setHeaderHeight] = useState(0);
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
	const terminals = (workspace?.terminals ?? []).filter(t =>
		!ws || t.ws === ws.id || (!t.ws && ws.id === workspace?.activeWs));
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

	const send = (data: string) => {
		if (activeKey !== undefined) {
			void sendInput(activeKey, data);
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
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				style={styles.tabBar}
				contentContainerStyle={[styles.tabContent, { paddingTop: headerHeight }]}
			>
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
					// ガラスのままだと、並んだときにどれが選ばれているかが背景次第で読めなくなる。
					return active
						? <View key={t.terminalKey} style={[styles.tabChip, styles.tabChipActive]}>{body}</View>
						: <GlassSurface key={t.terminalKey} style={styles.tabChip} interactive>{body}</GlassSurface>;
				})}
				{terminals.length === 0 ? <Text style={styles.dim}>このワークスペースにターミナルはありません</Text> : null}
			</ScrollView>
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
				style={styles.outputSlot}
				onLayout={event => {
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
			<WsHeader
				onHeightChange={setHeaderHeight}
				right={
					<HeaderActionPill>
						<HeaderActionButton
							icon="add"
							label="新しいターミナル"
							size={21}
							onPress={() => { hapticSelection(); createTerminal(ws?.id); }}
						/>
					</HeaderActionPill>
				}
			/>
		</KeyboardAvoidingView>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	tabBar: { flexGrow: 0, flexShrink: 0 },
	// ここの余白を変えると、出力領域の高さ＝PCへ申告するPTYの行数まで変わる。
	// 今回のガラス化でヘッダーが8pt高く、チップ行が4pt低くなり、差し引き**4ptほど狭い**。
	// 行送りより小さいので通常は行数が変わらないが、「変わらない」と決め打たないこと
	// （実測値は TermView が測り直してPCへ申告し直す）。
	tabContent: { paddingHorizontal: 16, paddingBottom: 4, gap: 7, alignItems: 'center' },
	tabChip: { height: 32, borderRadius: radius.pill, ...squircle, maxWidth: 200 },
	tabChipActive: { backgroundColor: 'rgba(9,175,217,0.30)', borderWidth: 1, borderColor: 'rgba(9,175,217,0.5)' },
	tabHit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13 },
	tabText: { color: colors.text, fontSize: 11.5, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	tabTextActive: { color: '#bfeeff', fontWeight: '700' },
	dotRed: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.red },
	dotGreen: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
	dim: { color: colors.textDim, fontSize: 12 },
	operationWarning: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: 'rgba(245,158,11,.12)', borderWidth: 1, borderColor: 'rgba(245,158,11,.35)' },
	operationWarningText: { flex: 1, color: colors.text, fontSize: 11, lineHeight: 16 },
	// キーボードで縮む「枠」。中の箱は高さを保ったまま下端で揃え、はみ出す上側をここで切る。
	// 箱と同じ角丸を持たせるのは、切っている間も上側の角が直角にならないようにするため。
	outputSlot: { flex: 1, marginHorizontal: 12, borderRadius: radius.control, ...squircle, overflow: 'hidden', justifyContent: 'flex-end' },
	output: { backgroundColor: '#1e1e1e', borderRadius: radius.control, ...squircle, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
	placeholder: { color: colors.textDim, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, padding: 10 },
	keyRowScroll: { flex: 1, minWidth: 0 },
	keyRow: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingRight: 8 },
	key: { backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, ...squircle, paddingHorizontal: 13, paddingVertical: 7 },
	keyPressed: { backgroundColor: colors.accentWash, borderColor: colors.accent },
	keyText: { color: colors.text, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	keyDanger: { color: colors.red },
	inputBar: { paddingHorizontal: 12, paddingTop: 10 },
});
