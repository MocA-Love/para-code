// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';
import { CircleAlert, CircleCheck, CloudOff, FileX, List } from 'lucide-react-native';
import { parseUnifiedDiff } from '../../../../src/components/diffParser.js';
import { guardWebViewNavigation } from '../../../../src/components/webViewLinkGuard.js';
import { isDiffViewerJavaScriptEnabled } from '../../../../src/components/webViewScriptPolicy.js';
import { useIsRegularWidth } from '../../../../src/hooks/useSizeClass.js';
import { useStableInsets } from '../../../../src/hooks/useStableInsets.js';
import { monoFamily } from '../../../../src/monoFont.js';
import { useParaToast } from '../../../../src/paraToast.js';
import { firstParam } from '../../../../src/routes.js';
import { colors, space, type } from '../../../../src/theme.js';
import { BottomDrawer, EmptyState, HeaderButton, Screen, ScreenHeader } from '../../../../src/ui/index.js';
import { CenterSpinner, OfflineBanner, SpaceGateBody } from '../../../../src/features/code/codeParts.js';
import { fileViewerHref } from '../../../../src/features/code/codeRoutes.js';
import { canOpenWorkingFile, diffStats, nextUnreviewed, reviewQueue, reviewStateOf, reviewedCount, stepReview, type ReviewFilter } from '../../../../src/features/code/diffReview.js';
import { DiffLines, ReviewFileList, ReviewFileSummary, ReviewFooter, ReviewSummary } from '../../../../src/features/code/reviewParts.js';
import { RightDrawer } from '../../../../src/features/code/rightDrawer.js';
import { orderedScmEntries, scmEntries } from '../../../../src/features/code/scmModel.js';
import { useCodeSpace } from '../../../../src/features/code/useCodeSpace.js';
import { useDiffContent, type DiffContent } from '../../../../src/features/code/useDiffContent.js';
import { useReviewMarksController } from '../../../../src/features/code/useReviewMarks.js';
import { useScmStatus } from '../../../../src/features/code/useScmData.js';

/**
 * 差分レビュー（`/pc/[pcId]/review/[spaceId]?path=…`）。Orca の MobileDiffReview に合わせ、
 * 見出しの下に「n/m 確認済み」と絞り込み、いまのファイルの札、1ファイル分の差分、下に前後の移動と
 * 「確認済みにする」を置く。ファイルの一覧は見出しの右のボタンから（iPad は右から、iPhone は下から）。
 *
 * いま見ているファイルはクエリの `path` が持つ（`router.setParams` で差し替えるので戻る履歴は増えない）。
 * 「確認済み」は確認したときの中身の識別と一緒に持ち、確認後に書き換えられたファイルは「確認後に変更あり」にする
 * （`useReviewMarks.ts`、Orca W2-14）。
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

	const entries = orderedScmEntries(scmEntries(statusState.status));
	const requested = firstParam(params.path);
	// クエリに無ければ（ソース管理以外から開いた）先頭のファイルから見る。
	const path = requested ?? entries[0]?.path;
	const entry = entries.find(candidate => candidate.path === path);
	const diff = useDiffContent(codeSpace, path, entry?.staged ?? false);
	// 差分の解析は重いので、差分の本文が変わったときだけやり直す（再描画のたびに解析しない）。
	const diffText = diff.text;
	const rows = useMemo(() => (diffText !== undefined ? parseUnifiedDiff(diffText) : undefined), [diffText]);
	const stats = rows !== undefined ? diffStats(rows) : undefined;
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

	const fileList = (
		<ReviewFileList
			entries={entries}
			marks={marks}
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
				right={<HeaderButton icon={List} label="ファイルの一覧" onPress={() => setListOpen(true)} active={listOpen} />}
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
					/>
					{path === undefined ? (
						statusState.status === undefined
							? (codeSpace.unavailable !== undefined ? <EmptyState icon={CloudOff} title="読み込めません" body={`${codeSpace.unavailable}。つながると読み込みます。`} /> : <CenterSpinner label="読み込み中…" />)
							: <EmptyState icon={CircleCheck} title="変更はありません" body="作業ツリーは最後のコミットと同じ状態です。" />
					) : (
						<>
							<ReviewFileSummary entry={entry} path={path} stats={stats} state={reviewState} />
							<DiffBody diff={diff} rows={rows} unavailable={codeSpace.unavailable} />
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
		</Screen>
	);
}

/** 差分の本文（読み込み中・切断・失敗・差分なし・表計算の差分・テキストの差分）。 */
function DiffBody({ diff, rows, unavailable }: { diff: DiffContent; rows: ReturnType<typeof parseUnifiedDiff> | undefined; unavailable: string | undefined }) {
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
	return <DiffLines rows={rows} />;
}

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
});
