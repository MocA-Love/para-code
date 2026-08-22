// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { GlassSurface } from '../src/components/glassSurface.js';
import { wsColor } from '../src/components/wsDrawer.js';
import { useKeyboardVisible } from '../src/hooks/useKeyboardVisible.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useParaHeader, PARA_HEADER_HIDDEN } from '../src/paraHeader.js';
import { useContentColumnStyle } from '../src/ipad/useContentColumn.js';
import { appendSpaceNoteEntry, applySpaceNotePrefix, continueSpaceNoteChecklist, parseSpaceNote, SPACE_NOTE_MAX_LENGTH, spaceNoteSummary, toggleSpaceNoteTask, trimSpaceNoteTrailingEmptyTask, type SpaceNotePrefix } from '../src/spaceNote.js';
import { colors, mono, squircle } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';

/**
 * スペースのメモ（PC版 Workspaces ビュー下部のメモ欄と同じ本文）を読み書きする画面。
 * ドロワーのスペース行のメモボタンから Link.AppleZoom で開く独立ルート
 * （旧spaceNoteSheet.tsxのボトムシートを置き換え。ズーム遷移はヘッダー付き画面と
 * 相性が悪いため、通知一覧と同じく独自ヘッダーを描画する）。
 *
 * - 表示中は `- [ ]` / `- [x]` をチェックボックスとして描き、タップで完了をトグルする
 *   （楽観更新してから noteSet を送り、失敗したら元に戻す）
 * - 一覧末尾の「項目を追加」から、編集モードに入らずチェック項目を足せる。改行で1件確定し
 *   入力欄は残るので、続けて何件でも書ける（記号を手打ちしなくてよい）
 * - 「編集」で本文全体を書き換えられる。保存はPC側の storage へ反映され、PCの表示・
 *   一覧の未完了バッジ・他のモバイル端末にも波及する
 * - 確定操作（キャンセル／保存）はヘッダーに置く。キーボードのすぐ上に置くと
 *   フリック入力の指と重なって誤タップするため
 *
 * 日本語IMEについて（エージェントタブと同じ扱い。glassComposer.tsx のコメント参照）:
 * 入力欄はいずれもuncontrolled（`value` を渡さない）で、文字列はネイティブ側が保持する。
 * PCや他端末からの同期pushで再レンダしても未確定文字列（marked text）へ書き戻さないため、
 * 変換途中で確定される・濁点が分離する、といった事故が起きない。ストアの購読も
 * この画面が描く値だけに絞ってある（`workspace` 全体を購読すると無関係な更新で再レンダする）。
 */
export default function SpaceNoteScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	// この画面は独自のヘッダー（パンくず・スペース選択など層の型に収まらないもの）を
	// 自分で描くので、常設のヘッダー層は伏せる。伏せないと前の画面のヘッダーが上に残る。
	useParaHeader(PARA_HEADER_HIDDEN);
	// キーボードが出ている間は KeyboardAvoidingView が下端を押し上げるため、
	// SafeArea ぶんの余白を足すと二重になる（入力欄がキーボードから浮く）。
	const keyboardVisible = useKeyboardVisible();
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	const { ws: wsParam } = useLocalSearchParams<{ ws?: string }>();
	// 開いた先で別のスペースへ切り替えられるようにするため、いま見ているスペースは
	// ルートパラメータではなくこの state が持つ。
	//
	// **切り替えた先は覚えない。** 次にメモを開いたときは、そのときのスコープ（＝呼び出し側が
	// 渡す `ws`）に従う。前回どこを見たかを引き継ぐと「なぜこのスペースが開くのか」を
	// 説明できなくなるため。
	const [ws, setWs] = useState(wsParam);
	// 呼び出し側が別のスペースを指して開き直したときは追従する（同じ画面が再利用されるため）。
	useEffect(() => { setWs(wsParam); }, [wsParam]);
	// 開いた先で切り替えるためのスペース選択メニューの開閉。
	const [pickerOpen, setPickerOpen] = useState(false);
	// スペース見出しの行の下端（親の padding box 基準）。メニューをここから出す。
	// 手計算の積み上げだと行の高さや Dynamic Type を取りこぼして、狭い端末では
	// 押した見出しをメニューが覆ってしまう。
	const [pickerTop, setPickerTop] = useState(0);

	// 描画に使う値だけを取り出す。ここで `workspace` をそのまま受け取ると、
	// エージェントの進捗など無関係な同期のたびに画面全体が再レンダされる。
	const { name, branch, color, noteGet, noteSet } = useAppStore(useShallow(s => {
		const entry = (s.workspace?.workspaces ?? []).find(w => w.id === ws);
		return {
			// グループ表示ではPCが旧アプリ互換のために付ける「✦ 」接頭辞を取り除く
			name: (entry?.name ?? '').replace(/^✦ /, ''),
			branch: entry?.branch,
			color: entry ? wsColor(entry) : colors.accent,
			noteGet: s.noteGet,
			noteSet: s.noteSet,
		};
	}));
	// 切り替え先の候補。件数だけ購読しても中身が要るので配列を取るが、
	// `useShallow` で参照が変わらない限り再レンダしない。
	const spaces = useAppStore(useShallow(s => s.workspace?.workspaces ?? []));

	const [text, setText] = useState('');
	const [editing, setEditing] = useState(false);
	const [adding, setAdding] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	// 切り替え先の選択肢を出すか。曖昧さが無いのに出すと邪魔になるので2つ以上あるときだけ。
	// **編集・追加の最中は切り替えさせない。** 書きかけを抱えたままスペースを変えると
	// 「どちらのスペースへ保存するのか」が決められない。先に確定させる。
	const canPickSpace = spaces.length > 1 && !editing && !adding;
	/** 応答が返る前に画面を離れた場合に、古い応答を捨てるための世代。 */
	const requestGeneration = useRef(0);
	/** 保存の送信順。連打時に先行応答が新しいローカル状態を巻き戻さないよう、最後の送信だけ反映する。 */
	const saveSequence = useRef(0);
	/** 編集中の下書き。戻る／スワイプバックで離脱したときに保存するため ref でも保持する（PC側の blur 保存と揃える）。 */
	const pendingDraft = useRef<string | undefined>(undefined);
	/** アンマウント時の保存判定で最新の本文を読むための控え。 */
	const textRef = useRef('');
	textRef.current = text;

	const scrollRef = useRef<ScrollView>(null);
	const editorRef = useRef<TextInput>(null);
	/** 編集欄に渡す初期値。uncontrolledなので、編集を始めた時点の本文をここで固定する。 */
	const editorInitial = useRef('');
	/** 編集欄を作り直す契機。編集を開始するたびに変えて、前回の下書きが残らないようにする。 */
	const [editorKey, setEditorKey] = useState(0);
	/** 自動継続の差分検出に使う「1つ前の本文」。setNativePropsでの書き換えも必ずここへ反映する。 */
	const editorBaseline = useRef('');
	/** ツールバーが記号を差し込む位置。 */
	const editorSelection = useRef(0);
	const addRef = useRef<TextInput>(null);
	/** 追加行の入力内容（uncontrolledなのでReactのstateには置かない）。 */
	const addDraft = useRef('');

	// Android物理戻るボタンでメニューだけ閉じる（画面ごと戻ってしまわないように）。
	useEffect(() => {
		if (!pickerOpen) {
			return;
		}
		const sub = BackHandler.addEventListener('hardwareBackPress', () => {
			setPickerOpen(false);
			return true;
		});
		return () => sub.remove();
	}, [pickerOpen]);

	useEffect(() => {
		if (ws === undefined) {
			setLoading(false);
			return;
		}
		const generation = ++requestGeneration.current;
		setLoading(true);
		noteGet(ws)
			.then(result => {
				if (generation === requestGeneration.current) {
					setText(result.text ?? '');
				}
			})
			.catch(err => {
				if (generation === requestGeneration.current) {
					setError(err instanceof Error ? err.message : String(err));
				}
			})
			.finally(() => {
				if (generation === requestGeneration.current) {
					setLoading(false);
				}
			});
	}, [ws, noteGet]);

	// 戻るボタン・スワイプバックのどちらで離れても書きかけを捨てない。
	// 画面が消えた後の送信になるため、store から直接呼ぶ（この時点でこの画面の state は触らない）。
	useEffect(() => () => {
		const draftText = pendingDraft.current;
		// **下書きは持ち越さない。** ここは離脱だけでなく `ws` の切り替えでも走る。
		// 消しておかないと、切り替え前のスペースの本文が「保存」や次の離脱で
		// 切り替え先へ書き込まれてしまう（内容が丸ごと入れ替わる）。
		pendingDraft.current = undefined;
		if (draftText === undefined || ws === undefined) {
			return;
		}
		// 保存経路はどこを通っても、自動継続が残した末尾の空項目を落としてから送る
		const trimmed = trimSpaceNoteTrailingEmptyTask(draftText);
		if (trimmed !== textRef.current) {
			void useAppStore.getState().noteSet(ws, trimmed).catch(() => undefined);
		}
	}, [ws]);

	const save = useCallback(async (next: string, previous: string) => {
		if (ws === undefined) {
			return;
		}
		const generation = requestGeneration.current;
		const sequence = ++saveSequence.current;
		setBusy(true);
		setError(undefined);
		try {
			const result = await noteSet(ws, next);
			// 後から送った保存が既にあるなら、その結果を待つ（先行応答で巻き戻さない）
			if (generation === requestGeneration.current && sequence === saveSequence.current) {
				setText(result.text ?? next);
			}
		} catch (err) {
			if (generation === requestGeneration.current && sequence === saveSequence.current) {
				// 保存できなかったので楽観更新を巻き戻す（チェックが付いたまま残らないように）
				setText(previous);
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (generation === requestGeneration.current && sequence === saveSequence.current) {
				setBusy(false);
			}
		}
	}, [ws, noteSet]);

	const toggle = useCallback((lineIndex: number) => {
		const next = toggleSpaceNoteTask(text, lineIndex);
		if (next === undefined) {
			return;
		}
		hapticSelection();
		const previous = text;
		setText(next);
		void save(next, previous);
	}, [text, save]);

	const summary = spaceNoteSummary(text);
	const lines = parseSpaceNote(text);

	/**
	 * 編集欄の中身をこちらから書き換える。uncontrolledなTextInputの唯一の書き換え口。
	 *
	 * 呼ぶのは改行の直後（＝IMEの変換が確定した後なので未確定文字列は無い）とツールバー操作の2経路。
	 * 後者は変換中でも押せてしまい、未確定文字列を抱えたまま書き戻すと変換が乱れる余地が残る
	 * （ネイティブの変換状態をReact側から知る手段がないため、ここは実機での確認が要る既知の制約）。
	 *
	 * テキストと選択範囲でAPIを分けているのは、`selection` を setNativeProps に混ぜても
	 * New Architecture では反映されないため。カーソル移動は公式の setSelection を使う。
	 */
	const writeEditor = useCallback((next: string, selection: number) => {
		// maxLength はユーザーの打鍵にしか効かないので、こちらの書き換えでも上限を守る
		if (next.length > SPACE_NOTE_MAX_LENGTH) {
			return;
		}
		editorBaseline.current = next;
		pendingDraft.current = next;
		editorSelection.current = selection;
		editorRef.current?.setNativeProps({ text: next });
		editorRef.current?.setSelection(selection, selection);
	}, []);

	const handleEditorChange = useCallback((next: string) => {
		const previous = editorBaseline.current;
		editorBaseline.current = next;
		pendingDraft.current = next;
		// 改行はIMEの変換確定より後にしか発生しないので、ここで書き換えても未確定文字列を壊さない
		const continued = continueSpaceNoteChecklist(previous, next);
		if (continued !== undefined) {
			writeEditor(continued.text, continued.selection);
		}
	}, [writeEditor]);

	const applyPrefix = useCallback((prefix: SpaceNotePrefix) => {
		hapticSelection();
		const result = applySpaceNotePrefix(editorBaseline.current, editorSelection.current, prefix);
		writeEditor(result.text, result.selection);
	}, [writeEditor]);

	const startEditing = () => {
		hapticImpact('light');
		editorInitial.current = text;
		editorBaseline.current = text;
		editorSelection.current = text.length;
		pendingDraft.current = text;
		setEditorKey(key => key + 1);
		setAdding(false);
		setEditing(true);
	};

	const cancelEditing = () => {
		hapticImpact('light');
		pendingDraft.current = undefined;
		setEditing(false);
	};

	const commitEditing = () => {
		hapticImpact('light');
		// 自動継続が置いた末尾の空項目は、未完了1件として数えられてしまうので保存前に落とす
		const next = trimSpaceNoteTrailingEmptyTask(pendingDraft.current ?? text);
		const previous = text;
		pendingDraft.current = undefined;
		setText(next);
		setEditing(false);
		void save(next, previous);
	};

	const startAdding = () => {
		hapticImpact('light');
		addDraft.current = '';
		setError(undefined);
		setAdding(true);
		// 追加行は autoFocus でキーボードを出すが、その間にレイアウトが伸びても自動では
		// 見えない（キーボード裏のまま）。確定後の scrollToEnd と同じく、キーボード出現の
		// アニメが落ち着いてから末尾へ寄せる。
		setTimeout(() => {
			requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
		}, 320);
	};

	const stopAdding = useCallback(() => {
		addDraft.current = '';
		setAdding(false);
	}, []);

	/**
	 * 追加行の内容を1件として確定する。既定では入力欄を空にして残し、続けて書けるようにする。
	 * `close` を渡すとそのまま閉じる（フォーカスが外れたときの取りこぼし防止に使う）。
	 */
	const commitAdding = useCallback((kind: 'task' | 'text', close = false) => {
		const next = appendSpaceNoteEntry(text, addDraft.current, kind);
		if (next === undefined) {
			stopAdding();
			return;
		}
		if (next.length > SPACE_NOTE_MAX_LENGTH) {
			setError('メモが上限に達しているため追加できません。');
			return;
		}
		hapticSelection();
		setError(undefined);
		const previous = text;
		setText(next);
		addDraft.current = '';
		addRef.current?.clear();
		if (close) {
			setAdding(false);
		} else {
			requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
		}
		void save(next, previous);
	}, [text, save, stopAdding]);

	/**
	 * 入力欄からフォーカスが外れたら、書きかけを捨てずに1件として確定する。
	 * 一覧の余白タップやキーボードを閉じる操作でもここへ来るため、破棄すると打った内容が黙って消える
	 * （編集モードは pendingDraft で離脱時に保存しており、それと非対称にしない）。
	 */
	const handleAddBlur = useCallback(() => {
		if (addDraft.current.trim().length === 0) {
			stopAdding();
			return;
		}
		commitAdding('task', true);
	}, [commitAdding, stopAdding]);

	return (
		<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
			<View style={styles.header}>
				{editing ? (
					<GlassButton label="キャンセル" onPress={cancelEditing} disabled={busy} />
				) : (
					<GlassButton icon="chevron-back" onPress={() => { hapticImpact('light'); router.back(); }} accessibilityLabel="戻る" />
				)}
				<Text style={styles.title}>メモ</Text>
				{editing ? (
					<GlassButton label="保存" onPress={commitEditing} disabled={busy} tint={colors.accent} strong />
				) : (
					<GlassButton label="編集" onPress={startEditing} disabled={loading || ws === undefined} />
				)}
			</View>

			{/* スペースの見出し。候補が2つ以上あるときは**そのまま押して切り替えられる**。
			    「すべてのスペース」を見ている状態から＋→メモを押すと、呼び出し側は
			    その時点のスコープ（選択中／一覧の先頭）を渡すしかないため、
			    ユーザーには「どこのメモが開いたのか」が分からない。開いた先で直せるようにして、
			    1タップで開く速さを保ったまま曖昧さだけを消す。 */}
			<Pressable
				onLayout={event => {
					const { y, height } = event.nativeEvent.layout;
					setPickerTop(Math.round(y + height) + 4);
				}}
				style={({ pressed }) => [styles.spaceRow, canPickSpace && pressed && styles.spaceRowPressed]}
				onPress={canPickSpace ? () => { hapticSelection(); setPickerOpen(true); } : undefined}
				disabled={!canPickSpace}
				accessibilityRole={canPickSpace ? 'button' : undefined}
				accessibilityLabel={canPickSpace ? `スペース ${name || 'スペース'}。押すと切り替え` : undefined}
				accessibilityState={canPickSpace ? { expanded: pickerOpen } : undefined}
			>
				<View style={[styles.avatar, { backgroundColor: color + '22' }]}>
					<Text style={[styles.avatarText, { color }]}>✦</Text>
				</View>
				<View style={styles.spaceBody}>
					<Text style={styles.spaceName} numberOfLines={1}>{name || 'スペース'}</Text>
					{branch ? <Text style={styles.spaceBranch} numberOfLines={1}>{branch}</Text> : null}
				</View>
				{canPickSpace ? <Ionicons name="chevron-down" size={14} color={colors.textDim} /> : null}
				{summary.open + summary.done > 0 ? (
					<View style={styles.summaryChip}>
						<Ionicons name="checkbox-outline" size={12} color={summary.open > 0 ? colors.accent : colors.textDim} />
						<Text style={[styles.summaryText, summary.open > 0 && styles.summaryTextOpen]}>{summary.open}/{summary.open + summary.done}</Text>
					</View>
				) : null}
			</Pressable>

			{error ? <Text style={styles.error}>{error}</Text> : null}

			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
				{loading ? (
					<View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
				) : editing ? (
					<TextInput
						key={editorKey}
						ref={editorRef}
						style={styles.editor}
						// value は渡さない。渡すと再レンダのたびにIMEの未確定文字列へ書き戻ってしまう
						defaultValue={editorInitial.current}
						onChangeText={handleEditorChange}
						onSelectionChange={(e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => { editorSelection.current = e.nativeEvent.selection.start; }}
						multiline
						autoFocus
						spellCheck={false}
						autoCorrect={false}
						// PC側と同じ上限。超過分はPC側で切り詰められるため、入力段階で止める
						maxLength={SPACE_NOTE_MAX_LENGTH}
						placeholder={'やることを書けます\n下のボタンでチェックリストにできます'}
						placeholderTextColor={colors.textDim}
						accessibilityLabel="メモの本文"
					/>
				) : (
					<ScrollView ref={scrollRef} style={styles.flex} contentContainerStyle={[styles.bodyContent, { paddingBottom: adding ? 16 : insets.bottom + 32 }, column]} keyboardShouldPersistTaps="handled">
						{lines.length === 0 && !adding ? (
							<Text style={styles.placeholder}>このスペースのメモはまだありません。下の「項目を追加」からすぐ書き始められます。</Text>
						) : lines.map(line => {
							if (line.kind === 'blank') {
								return <View key={line.index} style={styles.blank} />;
							}
							if (line.kind === 'heading') {
								return <Text key={line.index} style={styles.heading}>{line.text}</Text>;
							}
							if (line.kind === 'text') {
								return <Text key={line.index} style={styles.text}>{line.text}</Text>;
							}
							return (
								<Pressable key={line.index} style={styles.task} onPress={() => toggle(line.index)} accessibilityRole="checkbox" accessibilityState={{ checked: line.done }}>
									<View style={[styles.check, line.done && styles.checkDone]}>
										{line.done ? <Ionicons name="checkmark" size={13} color="#04252c" /> : null}
									</View>
									<Text style={[styles.taskLabel, line.done && styles.taskLabelDone]}>{line.text}</Text>
								</Pressable>
							);
						})}

						{adding ? (
							<View style={styles.task}>
								<View style={[styles.check, styles.checkGhost]} importantForAccessibility="no" accessibilityElementsHidden />
								<TextInput
									ref={addRef}
									style={styles.addInput}
									// ここも uncontrolled。確定後のクリアだけ命令APIで行う
									onChangeText={next => { addDraft.current = next; }}
									onSubmitEditing={() => commitAdding('task')}
									onBlur={handleAddBlur}
									autoFocus
									spellCheck={false}
									autoCorrect={false}
									returnKeyType="done"
									submitBehavior="submit"
									maxLength={SPACE_NOTE_MAX_LENGTH}
									placeholder="項目を書いて確定"
									placeholderTextColor={colors.textDim}
									accessibilityLabel="チェック項目を追加"
								/>
							</View>
						) : (
							<Pressable style={styles.addRow} onPress={startAdding} disabled={loading || ws === undefined} accessibilityRole="button" accessibilityLabel="項目を追加">
								<View style={styles.addPlus}><Ionicons name="add" size={14} color={colors.textDim} /></View>
								<Text style={styles.addLabel}>項目を追加</Text>
							</Pressable>
						)}
					</ScrollView>
				)}

				{editing || adding ? (
					<SpaceNoteToolbar
						bottomInset={keyboardVisible ? 8 : insets.bottom + 8}
						actions={editing ? [
							{ key: 'task', icon: 'checkbox-outline', label: 'チェック', onPress: () => applyPrefix('task') },
							{ key: 'heading', icon: 'text', label: '見出し', onPress: () => applyPrefix('heading') },
							{ key: 'bullet', icon: 'list', label: '箇条書き', onPress: () => applyPrefix('bullet') },
							{ key: 'none', icon: 'remove-outline', label: '記号なし', onPress: () => applyPrefix('none') },
						] : [
							{ key: 'task', icon: 'checkbox-outline', label: 'チェック', onPress: () => commitAdding('task') },
							{ key: 'text', icon: 'text', label: 'ふつうの行', onPress: () => commitAdding('text') },
							{ key: 'close', icon: 'chevron-down', label: '閉じる', onPress: stopAdding },
						]}
					/>
				) : null}
			</KeyboardAvoidingView>

			{/* スペース選択メニュー。見出しの真下から出す（押した場所と開く場所を繋げる）。
			    この画面自身の中に絶対配置で置くので、OverlayHost の重ね順に依存しない。 */}
			{pickerOpen ? (
				<>
					<Pressable
						// 絶対配置の子は親の padding box 基準なので、上の余白ぶんを負で打ち消して
						// ステータスバーの領域まで覆う。
						style={[styles.pickerScrim, { top: -(insets.top + 8) }]}
						onPress={() => setPickerOpen(false)}
						accessibilityRole="button"
						accessibilityLabel="スペースの選択を閉じる"
					/>
					<View style={[styles.pickerMenu, { top: pickerTop }]}>
						<GlassSurface style={styles.pickerGlass} />
						<Text style={styles.pickerHead}>メモを開くスペース</Text>
						<ScrollView style={styles.pickerScroll} bounces={false}>
							{spaces.map(space => {
								const spaceName = space.name.replace(/^✦ /, '');
								const spaceColor = wsColor(space);
								const open = space.note?.open ?? 0;
								const active = space.id === ws;
								return (
									<Pressable
										key={space.id}
										style={({ pressed }) => [styles.pickerRow, active && styles.pickerRowActive, pressed && styles.pickerRowPressed]}
										onPress={() => {
											hapticSelection();
											setPickerOpen(false);
											// 同じスペースなら何もしない（読み込みを空振りさせない）。
											if (!active) {
												setWs(space.id);
											}
										}}
										accessibilityRole="button"
										accessibilityState={{ selected: active }}
										accessibilityLabel={open > 0 ? `${spaceName}（未完了 ${open}件）` : spaceName}
									>
										<View style={[styles.pickerAvatar, { backgroundColor: spaceColor + '22' }]}>
											<Text style={[styles.avatarText, { color: spaceColor, fontSize: 11 }]}>✦</Text>
										</View>
										<View style={styles.spaceBody}>
											<Text style={[styles.pickerName, active && { color: colors.accent }]} numberOfLines={1}>{spaceName}</Text>
											{space.branch ? <Text style={styles.spaceBranch} numberOfLines={1}>{space.branch}</Text> : null}
										</View>
										{/* どのスペースにメモが溜まっているかを、選ぶ前に分かるようにする。 */}
										{open > 0 ? <Text style={styles.pickerCount}>未完了 {open}</Text> : null}
										{active ? <Ionicons name="checkmark" size={16} color={colors.accent} /> : null}
									</Pressable>
								);
							})}
						</ScrollView>
					</View>
				</>
			) : null}
		</View>
	);
}

/**
 * キーボード直上に出す入力補助バー。面はLiquid Glass（非対応環境ではBlurViewへ自動フォールバック）で、
 * ヘッダーのボタンと質感を合わせる。Apple HIGに従い、バーの上に載るボタン自体はglass化しない。
 */
function SpaceNoteToolbar({ actions, bottomInset }: {
	actions: { key: string; icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }[];
	/** キーボードが出ていないときにSafeAreaぶんだけ持ち上げるための下余白。 */
	bottomInset: number;
}) {
	return (
		<View style={[styles.toolbar, { marginBottom: bottomInset }]}>
			{/* 角丸はガラス面自体に渡す（ネイティブglassが正しい丸形状で描画される） */}
			<GlassSurface style={styles.toolbarGlass} />
			{actions.map(action => (
				<Pressable
					key={action.key}
					style={({ pressed }) => [styles.toolbarBtn, pressed && styles.toolbarBtnPressed]}
					onPress={action.onPress}
					accessibilityRole="button"
					accessibilityLabel={action.label}
				>
					<Ionicons name={action.icon} size={15} color={colors.text} />
					{/* 狭い端末（iPhone SE幅）でも折り返してバーの高さを崩さない */}
					<Text style={styles.toolbarLabel} numberOfLines={1}>{action.label}</Text>
				</Pressable>
			))}
		</View>
	);
}

/**
 * ヘッダーの操作ボタン。面はLiquid Glass（非対応環境ではBlurViewへ自動フォールバック）。
 * glassの上にglassを重ねないため（Apple HIG）、glass面はここと入力補助バーだけに置き、
 * 互いに重ならない位置（画面上端と下端）へ分けている。
 */
function GlassButton({ label, icon, onPress, disabled, tint, strong, accessibilityLabel }: {
	label?: string;
	icon?: keyof typeof Ionicons.glyphMap;
	onPress: () => void;
	disabled?: boolean;
	/** glassへの色被せ。主要アクション（保存）をアクセント色に染めるために使う。 */
	tint?: string;
	/** 主要アクション。文字を強め、押せることを一目で分かるようにする。 */
	strong?: boolean;
	accessibilityLabel?: string;
}) {
	return (
		<Pressable
			style={[icon !== undefined ? styles.iconBtn : styles.pillBtn, disabled && styles.btnDisabled]}
			onPress={onPress}
			disabled={disabled}
			hitSlop={6}
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel ?? label}
		>
			{/* 角丸はガラス面自体に渡す（ネイティブglassが正しい丸形状で描画される）。
			    tintOpacity=1: ここは薄い色被せではなく、主要アクションをアクセント色で
			    はっきり染めるための指定なので、渡した色をそのまま使う。 */}
			<GlassSurface style={icon !== undefined ? styles.iconGlass : styles.pillGlass} interactive tintColor={tint} tintOpacity={1} />
			{icon !== undefined
				? <Ionicons name={icon} size={18} color={colors.text} />
				: <Text style={[styles.btnText, strong === true && styles.btnTextStrong]}>{label}</Text>}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	flex: { flex: 1 },
	header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 12 },
	title: { flex: 1, color: colors.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
	iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
	iconGlass: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 18, overflow: 'hidden' },
	pillBtn: { height: 36, borderRadius: 18, paddingHorizontal: 15, alignItems: 'center', justifyContent: 'center' },
	pillGlass: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 18, overflow: 'hidden' },
	btnText: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
	btnTextStrong: { fontWeight: '800' },
	btnDisabled: { opacity: 0.45 },
	spaceRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 18, paddingBottom: 12 },
	spaceRowPressed: { opacity: 0.6 },
	avatar: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
	avatarText: { fontSize: 13, fontWeight: '800', fontFamily: mono.default },
	spaceBody: { flex: 1, minWidth: 0 },
	spaceName: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
	spaceBranch: { color: colors.textDim, fontSize: 11, fontFamily: mono.default, marginTop: 2 },

	// スペース選択メニュー
	pickerScrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', zIndex: 20 },
	pickerMenu: { position: 'absolute', left: 14, right: 14, zIndex: 21, borderRadius: 22, ...squircle, overflow: 'hidden', paddingBottom: 6 },
	pickerGlass: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
	pickerHead: { color: colors.textDim, fontSize: 11.5, fontWeight: '700', paddingHorizontal: 16, paddingTop: 13, paddingBottom: 7 },
	pickerScroll: { maxHeight: 340 },
	pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 9 },
	pickerRowActive: { backgroundColor: colors.accentWash },
	pickerRowPressed: { backgroundColor: 'rgba(255,255,255,0.08)' },
	pickerAvatar: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
	pickerName: { color: colors.text, fontSize: 13.5, fontWeight: '700' },
	pickerCount: { color: colors.yellow, fontSize: 10.5, fontWeight: '700' },
	summaryChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.surface3, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
	summaryText: { color: colors.textDim, fontSize: 11, fontFamily: mono.default },
	summaryTextOpen: { color: colors.accent },
	error: { color: colors.red, fontSize: 12, paddingHorizontal: 18, paddingBottom: 6 },
	center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	bodyContent: { paddingHorizontal: 18 },
	placeholder: { color: colors.textDim, fontSize: 13.5, fontStyle: 'italic', lineHeight: 22 },
	blank: { height: 10 },
	heading: { color: colors.text, fontSize: 14.5, fontWeight: '700', marginTop: 12, marginBottom: 2 },
	text: { color: colors.textDim, fontSize: 13.5, lineHeight: 23 },
	task: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 3 },
	// 未チェックが空白に見えないよう、枠と面のコントラストをPC側と揃える
	check: { width: 20, height: 20, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)', backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', marginTop: 2 },
	checkDone: { backgroundColor: colors.accent, borderColor: colors.accent },
	// 追加中の行。まだ存在しない項目なので、枠を弱めて「これから増える1件」に見せる
	checkGhost: { borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.3)', backgroundColor: 'transparent' },
	taskLabel: { flex: 1, color: colors.text, fontSize: 13.5, lineHeight: 23 },
	taskLabelDone: { color: colors.textDim, textDecorationLine: 'line-through' },
	addInput: { flex: 1, color: colors.text, fontSize: 13.5, lineHeight: 23, padding: 0, marginTop: Platform.OS === 'ios' ? 0 : -4 },
	addRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
	addPlus: { width: 20, height: 20, borderRadius: 6, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center' },
	addLabel: { color: colors.textDim, fontSize: 13.5 },
	editor: { flex: 1, marginHorizontal: 14, marginBottom: 10, padding: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, color: colors.text, fontSize: 14, lineHeight: 23, textAlignVertical: 'top' },
	toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 14, paddingHorizontal: 6, paddingVertical: 6, borderRadius: 20 },
	toolbarGlass: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 20, overflow: 'hidden' },
	// ネイティブglassは素材自体が縁の光を持つため、フォールバック時のみ枠線を描く
	toolbarBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, height: 34, borderRadius: 14, paddingHorizontal: 4 },
	toolbarBtnPressed: { backgroundColor: 'rgba(255,255,255,0.10)' },
	toolbarLabel: { color: colors.text, fontSize: 12, fontWeight: '600' },
});
