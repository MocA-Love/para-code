// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';
import { CircleAlert, CircleCheck, CloudOff, FileX, List, MessageSquare } from 'lucide-react-native';
import { useAppStore } from '../../../../src/appState.js';
import { parseUnifiedDiff, type DiffRow } from '../../../../src/components/diffParser.js';
import { guardWebViewNavigation } from '../../../../src/components/webViewLinkGuard.js';
import { isDiffViewerJavaScriptEnabled } from '../../../../src/components/webViewScriptPolicy.js';
import { usePcCapability } from '../../../../src/hooks/usePcCapability.js';
import { useIsRegularWidth } from '../../../../src/hooks/useSizeClass.js';
import { useStableInsets } from '../../../../src/hooks/useStableInsets.js';
import { monoFamily } from '../../../../src/monoFont.js';
import { useParaToast } from '../../../../src/paraToast.js';
import { PcCapability } from '../../../../src/pcCompat.js';
import { firstParam } from '../../../../src/routes.js';
import { colors, space, type } from '../../../../src/theme.js';
import type { WorktreeAgentDef } from '../../../../src/store.js';
import { BottomDrawer, ConfirmDrawer, EmptyState, HeaderButton, Screen, ScreenHeader } from '../../../../src/ui/index.js';
import { CenterSpinner, OfflineBanner, SpaceGateBody } from '../../../../src/features/code/codeParts.js';
import { fileViewerHref } from '../../../../src/features/code/codeRoutes.js';
import { FileViewerBody } from '../../../../src/features/code/fileViewerBody.js';
import { canOpenWorkingFile, diffStats, nextUnreviewed, reviewQueue, reviewStateOf, reviewedCount, stageableEntries, stepReview, type ReviewFilter } from '../../../../src/features/code/diffReview.js';
import { NoteComposer, ReviewNotesPanel, type NoteComposerTarget } from '../../../../src/features/code/reviewNoteParts.js';
import { clearNotesConfirmMessage, newReviewNoteId, noteAnchorOf, noteCountsByPath, placeReviewNotes, reviewSendTargets, selectedExistingNotes, unsentNoteIds, type PlacedNotes, type ReviewNote } from '../../../../src/features/code/reviewNotes.js';
import { DiffLines, ReviewFileList, ReviewFileSummary, ReviewFooter, ReviewSummary } from '../../../../src/features/code/reviewParts.js';
import { MAX_RAW_LINES } from '../../../../src/features/code/officeRawDiff.js';
import { effectiveReviewMode, reviewContentKindOf, reviewSidesOf, reviewViewPlan, type ReviewContentKind, type ReviewViewMode } from '../../../../src/features/code/reviewViewModes.js';
import { OfficeDiffWebView, ReviewImageCompare, ReviewViewSwitch } from '../../../../src/features/code/reviewViewParts.js';
import { RightDrawer } from '../../../../src/features/code/rightDrawer.js';
import { orderedScmEntries, scmEntries } from '../../../../src/features/code/scmModel.js';
import { useCodeSpace } from '../../../../src/features/code/useCodeSpace.js';
import { useDiffContent, type DiffContent } from '../../../../src/features/code/useDiffContent.js';
import { useReviewView, type ReviewViewState } from '../../../../src/features/code/useReviewView.js';
import { useReviewMarksController } from '../../../../src/features/code/useReviewMarks.js';
import { useReviewNotesController } from '../../../../src/features/code/useReviewNotes.js';
import { useScmStatus } from '../../../../src/features/code/useScmData.js';
import { useStageFile } from '../../../../src/features/code/useScmSync.js';

/**
 * 差分レビュー（`/pc/[pcId]/review/[spaceId]?path=…`）。Orca の MobileDiffReview に合わせ、
 * 見出しの下に「n/m 確認済み」と絞り込み、いまのファイルの札、1ファイル分の差分、下に前後の移動と
 * 「確認済みにする」を置く。ファイルの一覧は見出しの右のボタンから（iPad は右から、iPhone は下から）。
 *
 * いま見ているファイルはクエリの `path` が持つ（`router.setParams` で差し替えるので戻る履歴は増えない）。
 * 「確認済み」は確認したときの中身の識別と一緒に持ち、確認後に書き換えられたファイルは「確認後に変更あり」にする
 * （`useReviewMarks.ts`、Orca W2-14）。
 *
 * PC がメモを扱えれば（`review.notes.v1`）、差分の行を長押ししてメモを書け、見出しの「メモ」から選んだメモを
 * そのスペースのエージェントへ送れる。送ったメモは「送信済み」として残し、送信済みと古いメモはまとめて消せる。
 * PC が扱えれば（`review.stage.v1`）、確認済みのファイルだけをまとめてステージできる（Orca W2-28）。
 */
export default function ReviewScreen() {
	const router = useRouter();
	const params = useLocalSearchParams<{ path?: string | string[] }>();
	const codeSpace = useCodeSpace();
	const statusState = useScmStatus(codeSpace);
	const regular = useIsRegularWidth();
	const insets = useStableInsets();
	const [filter, setFilter] = useState<ReviewFilter>('all');
	const [listOpen, setListOpen] = useState(false);
	const review = useReviewMarksController(codeSpace);
	const { marks } = review;
	const notes = useReviewNotesController(codeSpace, review);
	const [notesOpen, setNotesOpen] = useState(false);
	const [composer, setComposer] = useState<NoteComposerTarget | undefined>(undefined);
	const [pickedNotes, setSelectedNotes] = useState<ReadonlySet<string>>(new Set());
	// 片付け・別の端末での削除で消えたメモは選択から落とす（件数と送る対象に残さない）
	const selectedNotes = useMemo(() => selectedExistingNotes(pickedNotes, notes.notes), [pickedNotes, notes.notes]);
	/** 確認済みのステージを待っている間（メモの保存・送信とは別に持つ）。 */
	const [staging, setStaging] = useState(false);
	/** シートの中に出すお知らせ（片付けの結果）。 */
	const [panelNotice, setPanelNotice] = useState<string | undefined>(undefined);
	/** シートを閉じ切った後に出すトースト（Modal の裏に隠れないように、閉じてから出す）。 */
	const afterCloseToast = useRef<string | undefined>(undefined);
	/**
	 * 「送信済みと古いメモを消す」の確かめ（Q143 A）。メモのシートを閉じ切ってから確かめのシートを出し（シートを重ねて
	 * 出すと iOS が取りこぼす）、確定でもキャンセルでもメモのシートへ戻る。本文は閉じる動きの間も出したままにする
	 */
	const clearAfterClose = useRef(false);
	const [confirmingClear, setConfirmingClear] = useState(false);
	const [clearMessage, setClearMessage] = useState<string | undefined>(undefined);
	const [agents, setAgents] = useState<readonly WorktreeAgentDef[]>([]);
	const [agentsRequested, setAgentsRequested] = useState(false);
	const terminals = useAppStore(s => s.workspace?.terminals);
	const stageFile = useStageFile(codeSpace, showStageFailure);
	const sendTargets = useMemo(() => reviewSendTargets(terminals ?? [], codeSpace.wsId), [terminals, codeSpace.wsId]);

	const entries = orderedScmEntries(scmEntries(statusState.status));
	const requested = firstParam(params.path);
	// クエリに無ければ（ソース管理以外から開いた）先頭のファイルから見る。
	const path = requested ?? entries[0]?.path;
	const entry = entries.find(candidate => candidate.path === path);
	// 見方（表示・差分・Raw）。種類と PC の機能で並べる見方と既定が決まり、ファイルを移ったら既定に戻る（項目 6）
	const fileAtCapable = usePcCapability(PcCapability.ScmFileAt);
	const wordDiffCapable = usePcCapability(PcCapability.ScmWordDiff);
	const contentKind = path !== undefined ? reviewContentKindOf(path) : 'text';
	const sides = reviewSidesOf(entry);
	const viewPlan = reviewViewPlan(contentKind, sides, { fileAt: fileAtCapable, wordDiff: wordDiffCapable }, path ?? '');
	const [chosenView, setChosenView] = useState<{ readonly path: string; readonly mode: ReviewViewMode } | undefined>(undefined);
	const viewMode = effectiveReviewMode(viewPlan, chosenView !== undefined && chosenView.path === path ? chosenView.mode : undefined);
	const office = contentKind === 'spreadsheet' || contentKind === 'docx';
	// Excel・Word の Raw はセルの値・段落の比較（両側の中身が要る）。読めない古い PC では git の差分の文字に戻す
	const officeRaw = office && fileAtCapable;
	const textRaw = viewMode === 'raw' && !officeRaw;
	const view = useReviewView(codeSpace, path, contentKind, viewMode, sides, entry?.identity, officeRaw);
	// 識別もキーにする（確認した後に書き換えられたら差分を取り直す）。テキストの差分は Office 以外でだけ読む
	// （行数・行へのメモに使うので、見方が「表示」でも読む）
	const diff = useDiffContent(codeSpace, !office || textRaw ? path : undefined, entry?.staged ?? false, entry?.identity);
	// 差分の解析は重いので、差分の本文が変わったときだけやり直す（再描画のたびに解析しない）。
	const diffText = diff.text;
	const rows = useMemo(() => (diffText !== undefined ? parseUnifiedDiff(diffText) : undefined), [diffText]);
	const officeRows = view.content?.rows;
	// 画像の比較を左右に並べるか。ウィンドウの幅ではなく本文の幅で決める（iPad の詳細の列は左の列の幅で変わる）
	const [bodyWidth, setBodyWidth] = useState(0);
	const stats = rows !== undefined ? diffStats(rows) : officeRows !== undefined ? diffStats(officeRows) : undefined;
	const placedNotes: PlacedNotes | undefined = useMemo(() => (notes.enabled && rows !== undefined && path !== undefined ? placeReviewNotes(rows, notes.notes, path) : undefined), [notes.enabled, notes.notes, rows, path]);
	const stageable = notes.canStage ? stageableEntries(entries, marks) : [];
	const queue = reviewQueue(entries, marks, filter);
	const at = queue.findIndex(candidate => candidate.path === path);
	const reviewState = entry !== undefined ? reviewStateOf(entry, marks) : 'todo';
	const isReviewed = reviewState === 'reviewed';
	const subtitle = [codeSpace.name, statusState.status?.branch ?? codeSpace.branch].filter(part => part !== undefined && part.length > 0).join(' · ');

	const show = (next: string | undefined) => {
		if (next !== undefined && next !== path) {
			router.setParams({ path: next });
		}
	};

	const toggleReviewed = () => {
		if (path === undefined || entry === undefined) {
			return;
		}
		review.setReviewed(entry, !isReviewed);
		if (isReviewed) {
			return;
		}
		useParaToast.getState().show({ key: 'review-marked', text: '確認済みにしました', icon: 'checkmark-circle-outline', tone: 'done' }, 1_500);
		show(nextUnreviewed(entries, { ...marks, [path]: { identity: entry.identity, reviewedAt: Date.now() } }, path));
	};

	const openFile = () => {
		if (codeSpace.pcId !== undefined && codeSpace.spaceId !== undefined && path !== undefined) {
			router.push(fileViewerHref(codeSpace.pcId, codeSpace.spaceId, path));
		}
	};

	const openNotes = () => {
		// 送っていないメモを選んでおく（送った後にまた開いたときは、そのとき未送信のものを選び直す）
		setSelectedNotes(new Set(unsentNoteIds(notes.notes)));
		notes.clearError();
		setPanelNotice(undefined);
		setNotesOpen(true);
	};

	const openComposer = (target: NoteComposerTarget) => {
		notes.clearError();
		setComposer(target);
	};

	const showAfterCloseToast = () => {
		const text = afterCloseToast.current;
		afterCloseToast.current = undefined;
		if (text !== undefined) {
			useParaToast.getState().show({ key: 'review-note-sent', text, icon: 'checkmark-circle-outline', tone: 'done' }, 2_000);
		}
	};

	/** メモのシートが閉じ切った。片付けの確かめを待っていれば出す。 */
	const afterNotesClosed = () => {
		showAfterCloseToast();
		if (clearAfterClose.current) {
			clearAfterClose.current = false;
			setConfirmingClear(true);
		}
	};

	const requestClearNotes = () => {
		setPanelNotice(undefined);
		setClearMessage(clearNotesConfirmMessage(notes.notes));
		clearAfterClose.current = true;
		setNotesOpen(false);
	};

	const toggleSelected = (id: string) => {
		setSelectedNotes(previous => {
			const next = new Set(previous);
			if (!next.delete(id)) {
				next.add(id);
			}
			return next;
		});
	};

	const submitNote = async (body: string) => {
		if (composer === undefined) {
			return;
		}
		const saved = composer.mode === 'add'
			? await notes.add(composer.path, composer.line, composer.lineText, body, composer.noteId)
			: await notes.edit(composer.note.id, body);
		if (saved) {
			setComposer(undefined);
		}
	};

	const deleteNote = async (note: ReviewNote) => {
		if (await notes.remove([note.id])) {
			setComposer(undefined);
		}
	};

	const sendNotes = async (target: { readonly terminalKey: string } | { readonly agent: string }) => {
		// 選んだ後に別の端末で消されたメモは送らない
		const ids = notes.notes.filter(note => selectedNotes.has(note.id)).map(note => note.id);
		if (ids.length > 0 && await notes.send(ids, target)) {
			afterCloseToast.current = `メモを ${ids.length} 件送りました`;
			setNotesOpen(false);
		}
	};

	const clearNotes = async () => {
		setPanelNotice(undefined);
		const removed = await notes.clear();
		if (removed !== undefined) {
			// シートの中に出す（トーストはシートの裏に隠れる）
			setPanelNotice(removed > 0 ? `メモを ${removed} 件消しました。` : '消せるメモはありませんでした。');
		}
	};

	/**
	 * いまのファイルだけをステージする・外す（Orca W2-15）。確認済みで確認後に変わっていないファイルは、確認済みの印ごと
	 * ステージ後の中身へ付け替える `reviewStage` を使う（ただのステージだと「確認後に変更あり」に変わるため）。
	 */
	const toggleStageCurrent = async () => {
		if (entry === undefined) {
			return;
		}
		if (!entry.staged && reviewState === 'reviewed' && notes.canStage) {
			const result = await notes.stage([entry]);
			if (result !== undefined && result.staged > 0) {
				void statusState.refresh();
				return;
			}
		}
		if (await stageFile.toggle(entry)) {
			void statusState.refresh();
		}
	};

	const stageReviewed = async () => {
		setStaging(true);
		const result = await notes.stage(stageable).finally(() => setStaging(false));
		if (result === undefined) {
			return;
		}
		void statusState.refresh();
		useParaToast.getState().show({
			key: 'review-staged',
			text: `${result.staged} 件をステージしました`,
			...(result.skipped > 0 ? { sub: `${result.skipped} 件は確認した後に変わっていたなどの理由でステージしていません。` } : {}),
			icon: 'checkmark-circle-outline',
			tone: result.skipped > 0 ? 'warn' : 'done',
		}, 3_000);
	};

	// 起動できるエージェントは、メモの一覧を初めて開いたときに PC から読む（開かなければ読まない）
	useEffect(() => {
		if (!notesOpen || agentsRequested || !notes.enabled) {
			return;
		}
		setAgentsRequested(true);
		useAppStore.getState().worktreeForm({ agentsOnly: true })
			.then(result => setAgents(result.agents))
			.catch(() => undefined);
	}, [notesOpen, agentsRequested, notes.enabled]);

	const notesPanel = (
		<ReviewNotesPanel
			notes={notes.notes}
			selected={selectedNotes}
			currentLines={placedNotes?.currentLines}
			onToggle={toggleSelected}
			onOpenNote={note => { setNotesOpen(false); openComposer({ mode: 'edit', note }); }}
			targets={sendTargets}
			agents={agents}
			busy={notes.busy}
			error={notes.error}
			notice={panelNotice}
			onSend={target => void sendNotes({ terminalKey: target.terminalKey })}
			onLaunch={agent => void sendNotes({ agent: agent.id })}
			onClear={requestClearNotes}
			onClose={() => setNotesOpen(false)}
		/>
	);

	const fileList = (
		<ReviewFileList
			entries={entries}
			marks={marks}
			{...(notes.enabled ? { noteCounts: noteCountsByPath(notes.notes) } : {})}
			currentPath={path}
			onPick={picked => { setListOpen(false); show(picked); }}
			onClose={() => setListOpen(false)}
		/>
	);

	return (
		<Screen>
			<ScreenHeader
				title="変更"
				subtitle={subtitle.length > 0 ? subtitle : undefined}
				surface="panel"
				right={(
					<>
						{notes.enabled ? <HeaderButton icon={MessageSquare} label="メモ" onPress={openNotes} active={notesOpen} {...(notes.notes.length > 0 ? { badge: notes.notes.length, badgeTone: 'neutral' as const } : {})} /> : null}
						<HeaderButton icon={List} label="ファイルの一覧" onPress={() => setListOpen(true)} active={listOpen} />
					</>
				)}
			/>
			<SpaceGateBody gate={codeSpace.gate}>
				<View style={styles.body}>
					<OfflineBanner reason={codeSpace.unavailable} />
					<ReviewSummary
						reviewed={reviewedCount(entries, marks)}
						total={entries.length}
						synced={review.stored}
						position={at >= 0 ? { index: at, count: queue.length } : undefined}
						filter={filter}
						onFilter={setFilter}
						{...(stageable.length > 0 ? { stage: { count: stageable.length, busy: staging, onPress: () => void stageReviewed() } } : {})}
					/>
					{path === undefined ? (
						statusState.status === undefined
							? (codeSpace.unavailable !== undefined ? <EmptyState icon={CloudOff} title="読み込めません" body={`${codeSpace.unavailable}。つながると読み込みます。`} /> : <CenterSpinner label="読み込み中…" />)
							: <EmptyState icon={CircleCheck} title="変更はありません" body="作業ツリーは最後のコミットと同じ状態です。" />
					) : (
						<>
							<ReviewFileSummary
								entry={entry}
								path={path}
								stats={stats}
								state={reviewState}
								{...(stageFile.enabled && entry !== undefined && entry.kind !== 'conflict'
									? { stage: { busy: stageFile.pending.has(entry.path) || staging, disabled: !codeSpace.live, onPress: () => void toggleStageCurrent() } }
									: {})}
							/>
							{viewPlan.modes.length > 1 ? <ReviewViewSwitch modes={viewPlan.modes} mode={viewMode} onChange={mode => setChosenView({ path, mode })} /> : null}
							{textRaw ? (
								<DiffBody
									diff={diff}
									rows={rows}
									unavailable={codeSpace.unavailable}
									notes={placedNotes}
									onLongPressRow={notes.enabled ? row => openComposer({ mode: 'add', path, ...noteAnchorOf(row), noteId: newReviewNoteId() }) : undefined}
									onPressNote={note => openComposer({ mode: 'edit', note })}
								/>
							) : (
								<View style={styles.body} onLayout={event => setBodyWidth(event.nativeEvent.layout.width)}>
									<ReviewViewBody path={path} kind={contentKind} mode={viewMode} view={view} unavailable={codeSpace.unavailable} sideBySide={bodyWidth >= SIDE_BY_SIDE_MIN_WIDTH} />
								</View>
							)}
							<ReviewFooter
								reviewed={isReviewed}
								changed={reviewState === 'changed'}
								canOpen={canOpenWorkingFile(entry)}
								canMove={entries.length > 1 || (entries.length === 1 && entries[0]?.path !== path)}
								bottomInset={insets.bottom}
								onPrev={() => show(stepReview(entries, queue, path, -1))}
								onNext={() => show(stepReview(entries, queue, path, 1))}
								onOpen={openFile}
								onToggleReviewed={toggleReviewed}
							/>
						</>
					)}
				</View>
			</SpaceGateBody>
			{/* 幅で部品を差し替えず、両方を木に置いて visible だけを切り替える（木の形を幅で変えない）。 */}
			<BottomDrawer visible={listOpen && !regular} onClose={() => setListOpen(false)} accessibilityLabel="ファイルの一覧">
				{fileList}
			</BottomDrawer>
			<RightDrawer visible={listOpen && regular} onClose={() => setListOpen(false)} accessibilityLabel="ファイルの一覧">
				{fileList}
			</RightDrawer>
			<BottomDrawer visible={notesOpen && !regular} onClose={() => setNotesOpen(false)} onAfterClose={afterNotesClosed} accessibilityLabel="メモ">
				{notesPanel}
			</BottomDrawer>
			<RightDrawer visible={notesOpen && regular} onClose={() => setNotesOpen(false)} onAfterClose={afterNotesClosed} accessibilityLabel="メモ">
				{notesPanel}
			</RightDrawer>
			<ConfirmDrawer
				visible={confirmingClear}
				title="送信済みと古いメモを消しますか？"
				message={clearMessage}
				confirmLabel="消す"
				onConfirm={() => {
					// 結果はメモのシートの中に出す
					setNotesOpen(true);
					void clearNotes();
				}}
				onCancelled={() => setNotesOpen(true)}
				onClose={() => setConfirmingClear(false)}
			/>
			<NoteComposer
				target={composer}
				busy={notes.busy}
				error={notes.error}
				currentLines={placedNotes?.currentLines}
				onSubmit={body => void submitNote(body)}
				onDelete={note => void deleteNote(note)}
				onClose={() => setComposer(undefined)}
			/>
		</Screen>
	);
}

/** ステージの失敗（差分レビューの画面はシートの外なので、トーストで出す）。 */
function showStageFailure(text: string): void {
	useParaToast.getState().show({ key: 'review-stage-file-failed', text, icon: 'alert-circle', tone: 'warn' }, 4_000);
}

/** 差分の本文（読み込み中・切断・失敗・差分なし・表計算の差分・テキストの差分）。 */
function DiffBody({ diff, rows, unavailable, notes, onLongPressRow, onPressNote }: {
	diff: DiffContent;
	rows: ReturnType<typeof parseUnifiedDiff> | undefined;
	unavailable: string | undefined;
	notes: PlacedNotes | undefined;
	onLongPressRow: ((row: DiffRow & { newNo: number }) => void) | undefined;
	onPressNote: (note: ReviewNote) => void;
}) {
	if (diff.error !== undefined) {
		const office = diff.source === 'officeUnavailable';
		return <EmptyState icon={office ? FileX : CircleAlert} title={office ? '差分を表示できません' : '差分を読み込めませんでした'} body={office ? '「開く」でファイルそのものを見られます。' : diff.error} />;
	}
	if (diff.html !== undefined) {
		return (
			<WebView
				style={styles.web}
				source={{ html: diff.html }}
				originWhitelist={['*']}
				javaScriptEnabled={isDiffViewerJavaScriptEnabled('spreadsheet')}
				onShouldStartLoadWithRequest={guardWebViewNavigation}
			/>
		);
	}
	if (diff.text === undefined || rows === undefined) {
		return unavailable !== undefined
			? <EmptyState icon={CloudOff} title="読み込めません" body={`${unavailable}。つながると読み込みます。`} />
			: <CenterSpinner label="読み込み中…" />;
	}
	if (diff.text.trim().length === 0) {
		return <EmptyState icon={CircleCheck} title="差分はありません" body="このファイルはもう変更されていないかもしれません。" />;
	}
	if (rows.length === 0) {
		// 行に分けられない差分（バイナリなど）は git の出力をそのまま見せる。
		return (
			<ScrollView style={styles.web} contentContainerStyle={styles.rawContent}>
				<Text style={styles.raw}>{diff.text.trim()}</Text>
			</ScrollView>
		);
	}
	const lines = <DiffLines rows={rows} {...(notes !== undefined ? { notes, onPressNote } : {})} {...(onLongPressRow !== undefined ? { onLongPressRow } : {})} />;
	// 大きすぎる差分は PC が先頭だけを送る（scm の diff の truncated）
	return diff.truncated ? (
		<View style={styles.body}>
			<Text style={styles.capped}>差分が大きいため先頭だけを表示しています。続きは PC で確かめてください。</Text>
			{lines}
		</View>
	) : lines;
}

/** 「表示」「差分」と Office の「Raw」の本文（テキストの Raw は {@link DiffBody}）。 */
function ReviewViewBody({ path, kind, mode, view, unavailable, sideBySide }: {
	path: string;
	kind: ReviewContentKind;
	mode: ReviewViewMode;
	view: ReviewViewState;
	unavailable: string | undefined;
	sideBySide: boolean;
}) {
	const content = view.content;
	if (content?.error !== undefined) {
		return <EmptyState icon={CircleAlert} title={mode === 'diff' ? '差分を読み込めませんでした' : 'ファイルを読み込めませんでした'} body={content.error} />;
	}
	if (content === undefined) {
		return unavailable !== undefined
			? <EmptyState icon={CloudOff} title="読み込めません" body={`${unavailable}。つながると読み込みます。`} />
			: <CenterSpinner label="読み込み中…" />;
	}
	if (content.render !== undefined && kind !== 'text') {
		return <FileViewerBody path={path} kind={kind} mode="render" content={content.render} focusLine={undefined} onSelectSheet={view.selectSheet} />;
	}
	if (content.images !== undefined) {
		return <ReviewImageCompare path={path} before={content.images.before} after={content.images.after} sideBySide={sideBySide} />;
	}
	if (content.html !== undefined && (kind === 'spreadsheet' || kind === 'docx')) {
		return <OfficeDiffWebView html={content.html} kind={kind} />;
	}
	if (content.rows !== undefined) {
		const unit = kind === 'docx' ? '段落' : 'セル';
		const cappedNote = `先頭 ${MAX_RAW_LINES.toLocaleString('en-US')} ${unit}だけ比べました`;
		if (content.rows.length === 0) {
			// 打ち切ったときは、残りに違いがあるかもしれないので「違いなし」とは言わない
			return content.rowsCapped === true
				? <EmptyState icon={CircleAlert} title={cappedNote} body={`比べた範囲では${unit}の中身は同じです。それより後ろは比べていません。`} />
				: <EmptyState icon={CircleCheck} title="中身の違いはありません" body={kind === 'docx' ? '段落の文字は同じです。書式だけが変わっているかもしれません。' : 'セルの値は同じです。書式だけが変わっているかもしれません。'} />;
		}
		return (
			<View style={styles.body}>
				{content.rowsCapped === true ? <Text style={styles.capped}>{cappedNote}</Text> : null}
				<DiffLines rows={content.rows} />
			</View>
		);
	}
	return <CenterSpinner label="読み込み中…" />;
}

/** 画像の変更前・変更後を左右に並べる本文の幅の下限（pt）。狭ければ上下に並べる。 */
const SIDE_BY_SIDE_MIN_WIDTH = 560;

const styles = StyleSheet.create({
	body: {
		flex: 1,
	},
	web: {
		flex: 1,
		backgroundColor: colors.bg,
	},
	rawContent: {
		padding: space.lg,
	},
	raw: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		color: colors.textDim,
	},
	capped: {
		fontSize: type.caption,
		color: colors.amber,
		paddingHorizontal: space.lg,
		paddingVertical: space.xs,
		backgroundColor: colors.panel,
	},
});
