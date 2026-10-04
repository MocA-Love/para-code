// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { ShieldQuestion, TriangleAlert } from 'lucide-react-native';
import { PARADIS_AGENT_APPROVAL_DENY_MESSAGE_LIMIT, type IParadisAgentApprovalRequest, type ParadisAgentApprovalSuggestionScope } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisAgentApprovalRequest.js';
import { isSubmissionLocked } from '../../components/answerSubmission.js';
import { approvalButtonLayout, APPROVAL_DETAIL_LINES } from '../../components/approvalCardBehavior.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import type { QuestionFreeTextRequest } from '../../components/questionCard.js';
import { approvalButtons, approvalDangers, approvalMeasureCopy, approvalEditDiff, approvalHeading, approvalLineCount, approvalSender, approvalUrlParts, type ApprovalButton, type ApprovalDiffLine } from '../../approvalDetail.js';
import { haptic } from '../../haptics.js';
import { useAnswerSubmission } from '../../hooks/useAnswerSubmission.js';
import { useIsRegularWidth } from '../../hooks/useSizeClass.js';
import { approvalDetailSplit, APPROVAL_DETAIL_SIDE_WIDTH } from '../../ipad/ipadLayout.js';
import { monoFamily } from '../../monoFont.js';
import type { AgentApprovalChoice, AgentMessageSendResult } from '../../store.js';
import { alpha, colors, radius, space, tint, type } from '../../theme.js';
import { BottomDrawer, DrawerTitle, Icon, iconSize, useThemeColors } from '../../ui/index.js';
import { scaleChatSize } from '../../chatTextScale.js';
import { useChatIconSize, useChatStyles, useChatTextScale } from '../../ui/chatTextScale.js';
import { cardStyles as baseCardStyles } from './answerCardStyles.js';
import { SubmissionStatus } from './submissionStatus.js';

/** 「全文を表示」の見た目の高さ（会話の文字サイズが 100% のとき。当たり判定は 44 に広げる）。 */
const LINK_HEIGHT = 20;
/** カードに出す Edit の差分の行数（残りはシートで見る）。 */
const CARD_DIFF_LINES = 4;
/** カードに出す Write の中身の行数。 */
const CARD_CONTENT_LINES = 3;
/** カードに出す引数の数（MCP など）。 */
const CARD_ARGS = 6;
/** カードで 1 項目（差分の行・パス・URL・引数の値）に使う行数の上限。 */
const CARD_ITEM_LINES = 2;
/** カードに出す説明の行数。 */
const CARD_DESCRIPTION_LINES = 4;

/** 「拒否して指示を書く」（決定 3）。押すとコンポーザーが指示の入力に切り替わる。 */
const DENY_WITH_MESSAGE_ID = 'deny-with-message';

/**
 * 許可待ちに答えるカード（Orca の MobileNativeChatPermission。`mobile-approval-detail-mock.html` の案 A + 案 C）。
 *
 * PC が操作の中身（`request`。`agent.approval.detail.v1`）を送ってくれば、ツールごとに本文を出し分ける。
 * Bash は説明とコマンドの全文（等幅。6 行を超えたら折りたたんで「すべて表示」でシート）、Edit はパスと差分の先頭、
 * Write はパスと先頭、WebFetch は URL、MCP はツール名と引数。サブエージェントからの許可は送り元を出し、
 * 危険の札はコマンドの全文から拾う。古い PC は今までどおり `detail`（「ツール名: 説明」の 1 行）を出す。
 *
 * 送る内容と送り方は今までと同じ: PC が広告した選択肢の ID を `onApprove` で送り、送信後の状態は `useAnswerSubmission`。
 * ボタンは許可を左（縦に積むときは上）に置き、「以後は確認しない」は足されるルールを添えた 2 番手、拒否は「拒否」1 つ。
 * iPad の広い幅（カードの実際の幅で決める）では、コマンドを左、説明・札・警告を右に並べる（ツリーの形は変えない）。
 */
export function PermissionCard({ interactionId, onApprove, title, detail, choices, screenLabels, request, warning, suggestions, suggestionScope, onDenyWithMessage, onRequestDenyMessage, denyMessageActive, refreshing }: {
	interactionId: string;
	onApprove: (interactionId: string, choice: string) => Promise<AgentMessageSendResult>;
	title?: string;
	detail?: string;
	choices?: readonly AgentApprovalChoice[];
	/** 画面から読んだ選択肢の文言（`opt:<n>` → 画面の文言。「以後は確認しない」を見分けるのに使う）。 */
	screenLabels?: ReadonlyMap<string, string>;
	/** 操作の中身（新しい PC だけ）。 */
	request?: IParadisAgentApprovalRequest;
	/** 選択肢の上に出ている警告の行（PC が画面から読めたときだけ）。 */
	warning?: string;
	/** 「以後は確認しない」で足されるルール。 */
	suggestions?: readonly string[];
	suggestionScope?: ParadisAgentApprovalSuggestionScope;
	/** 指示を添えて拒否する（mod が待っている承認だけ。渡さなければ「拒否して指示を書く」を出さない）。 */
	onDenyWithMessage?: (interactionId: string, message: string) => Promise<AgentMessageSendResult>;
	/** コンポーザーを指示の入力に切り替える（undefined で戻す）。 */
	onRequestDenyMessage?: (request: QuestionFreeTextRequest | undefined) => void;
	/** コンポーザーがこの承認への指示の入力になっているか。 */
	denyMessageActive?: boolean;
	refreshing: boolean;
}) {
	const submission = useAnswerSubmission(interactionId);
	const theme = useThemeColors();
	const cardStyles = useChatStyles(baseCardStyles);
	const styles = useChatStyles(baseStyles);
	const headIconSize = useChatIconSize(iconSize.md);
	const dangerIconSize = useChatIconSize(11);
	// 文字を小さくしても「全文を表示」の当たり判定が 44pt を割らないよう、見た目の高さに同じ割合をかける。
	const linkHitSlop = hitSlopToMinimum(scaleChatSize(LINK_HEIGHT, useChatTextScale()));
	const regular = useIsRegularWidth();
	const [width, setWidth] = useState(0);
	const [fullOpen, setFullOpen] = useState(false);
	// どこかが行数の上限で折りたたまれた（onTextLayout で実際の行数を測る）。折りたたんだら「すべて表示」でシートを開ける
	const [overflow, setOverflow] = useState(false);
	const markOverflow = useCallback(() => setOverflow(true), []);
	const locked = isSubmissionLocked(submission.state);
	const disabled = locked || refreshing;
	const effectiveChoices: readonly AgentApprovalChoice[] = choices ?? [
		{ id: 'yes', label: '許可', tone: 'approve' },
		{ id: 'no', label: '拒否', tone: 'deny' },
	];
	const buttons = useMemo(() => {
		const list = approvalButtons(effectiveChoices, { ...(screenLabels !== undefined ? { screenLabels } : {}), ...(suggestions !== undefined ? { suggestions } : {}), ...(suggestionScope !== undefined ? { scope: suggestionScope } : {}) });
		if (onDenyWithMessage === undefined || onRequestDenyMessage === undefined || !effectiveChoices.some(choice => choice.id === 'no')) {
			return list;
		}
		// 2 番手として、拒否の前に置く
		const denyAt = list.findIndex(button => button.variant === 'destructive');
		const extra: ApprovalButton = { choice: { id: DENY_WITH_MESSAGE_ID, label: '拒否して指示を書く', tone: 'neutral' }, variant: 'secondary', title: '拒否して指示を書く' };
		return denyAt < 0 ? [...list, extra] : [...list.slice(0, denyAt), extra, ...list.slice(denyAt)];
	}, [effectiveChoices, screenLabels, suggestions, suggestionScope, onDenyWithMessage, onRequestDenyMessage]);
	const layout = approvalButtonLayout(buttons.map(button => ({ ...button.choice, label: button.title })));
	const heading = approvalHeading(request, title);
	const sender = approvalSender(request?.agent);
	const dangers = useMemo(() => approvalDangers(request, title, detail), [request, title, detail]);
	const split = approvalDetailSplit(regular, width);
	const description = request?.kind === 'bash' ? request.description : undefined;
	const sideEmpty = description === undefined && dangers.length === 0 && warning === undefined;
	const error = submission.state.phase === 'idle' ? submission.state.error : undefined;
	const submit = (choice: AgentApprovalChoice) => {
		if (choice.id === DENY_WITH_MESSAGE_ID) {
			haptic('move');
			if (denyMessageActive === true) {
				onRequestDenyMessage?.(undefined);
				return;
			}
			const deny = onDenyWithMessage;
			onRequestDenyMessage?.({
				id: interactionId, prompt: heading, mode: 'deny', maxLength: PARADIS_AGENT_APPROVAL_DENY_MESSAGE_LIMIT,
				submit: text => deny !== undefined ? submission.run(() => deny(interactionId, text)) : Promise.resolve({ status: 'rejected', message: '指示を添えて拒否できません' }),
			});
			return;
		}
		// 許可も拒否も同じ重さの「押した」。結果（失敗だけ）は useAnswerSubmission が鳴らす
		haptic('commit');
		void submission.run(() => onApprove(interactionId, choice.id));
	};
	const openFull = () => {
		haptic('move');
		setFullOpen(true);
	};
	return (
		<View style={cardStyles.card} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
			<View style={cardStyles.head}>
				<Icon icon={ShieldQuestion} size={headIconSize} color={theme.accent} />
				<Text style={cardStyles.title}>{heading}</Text>
			</View>
			{sender !== undefined ? (
				<Text style={styles.from}>送り元: <Text style={styles.fromName}>{sender.name}</Text>（{sender.role}）</Text>
			) : null}
			<View style={split ? styles.bodySplit : styles.body}>
				<View style={[styles.side, split ? { width: APPROVAL_DETAIL_SIDE_WIDTH } : undefined, sideEmpty ? styles.hidden : undefined]}>
					{description !== undefined ? <ClampText lines={CARD_DESCRIPTION_LINES} style={styles.description} onOverflow={markOverflow}>{description}</ClampText> : null}
					{dangers.length > 0 ? (
						<View style={styles.dangers}>
							{dangers.map(label => (
								<View key={label} style={styles.danger}>
									<Icon icon={TriangleAlert} size={dangerIconSize} color={colors.red} strokeWidth={2.4} />
									<Text style={styles.dangerText}>{label}</Text>
								</View>
							))}
						</View>
					) : null}
					{warning !== undefined ? (
						<View style={styles.alert}>
							<Text style={styles.alertTitle}>確認できない操作があります</Text>
							<Text style={styles.alertText} selectable>{warning}</Text>
						</View>
					) : null}
				</View>
				<View style={styles.main}>
					<ApprovalBody request={request} detail={detail} overflow={overflow} onOverflow={markOverflow} onOpenFull={openFull} linkHitSlop={linkHitSlop} accent={theme.accent} />
				</View>
			</View>
			{locked ? (
				<SubmissionStatus state={submission.state} onRetry={submission.retry} onReselect={submission.reset} />
			) : buttons.length > 0 ? (
				<View style={layout === 'row' ? styles.row : styles.column}>
					{buttons.map(button => {
						const active = button.choice.id === DENY_WITH_MESSAGE_ID && denyMessageActive === true;
						return (
							<Pressable
								key={button.choice.id}
								disabled={disabled}
								onPress={() => submit(button.choice)}
								style={({ pressed }) => [
									cardStyles.option,
									layout === 'row' ? (split ? styles.choiceRowWide : styles.choiceRow) : undefined,
									button.rule !== undefined ? styles.choiceWithRule : styles.choice,
									button.variant === 'primary' ? { backgroundColor: theme.primary, borderColor: theme.primary } : undefined,
									active ? cardStyles.optionSelected : undefined,
									disabled ? cardStyles.optionDisabled : undefined,
									pressed ? cardStyles.optionPressed : undefined,
								]}
								accessibilityRole="button"
								accessibilityState={{ disabled, selected: active }}
								accessibilityHint={button.rule !== undefined ? `足されるルール: ${button.rule}` : undefined}
							>
								<Text style={[
									styles.choiceText,
									button.variant === 'primary' ? { color: theme.onPrimary } : undefined,
									button.variant === 'destructive' ? styles.denyText : undefined,
								]}>{button.title}</Text>
								{button.rule !== undefined ? <Text style={styles.rule}>{button.rule}</Text> : null}
							</Pressable>
						);
					})}
				</View>
			) : null}
			{error !== undefined ? <Text style={cardStyles.error}>{error}</Text> : null}
			{refreshing ? <Text style={cardStyles.error}>最新の内容を取得しています。届くまで回答できません</Text> : null}
			{!locked ? <Text style={cardStyles.hint}>{effectiveChoices.length > 0 ? 'PC 側で回答した場合も自動的に閉じます' : 'PC の Codex の画面で承認内容を確認してください'}</Text> : null}
			<BottomDrawer visible={fullOpen} onClose={() => setFullOpen(false)} accessibilityLabel="確認の内容">
				<DrawerTitle title={heading} />
				<ApprovalFull request={request} detail={detail} />
			</BottomDrawer>
		</View>
	);
}

/** カードの本文（ツールごと）。長いものは先頭だけ出し、「すべて表示」でシートを開く。 */
function ApprovalBody({ request, detail, overflow, onOverflow, onOpenFull, linkHitSlop, accent }: {
	request: IParadisAgentApprovalRequest | undefined;
	detail: string | undefined;
	/** カードのどこかが行数の上限で折りたたまれている（説明も含む）。 */
	overflow: boolean;
	onOverflow: () => void;
	onOpenFull: () => void;
	linkHitSlop: ReturnType<typeof hitSlopToMinimum>;
	accent: string;
}) {
	const cardStyles = useChatStyles(baseCardStyles);
	const styles = useChatStyles(baseStyles);
	const link = (label: string) => (
		<Pressable onPress={onOpenFull} hitSlop={linkHitSlop} accessibilityRole="button">
			<Text style={[cardStyles.link, { color: accent }]}>{label}</Text>
		</Pressable>
	);
	if (request === undefined) {
		if (detail === undefined || detail.length === 0) {
			return null;
		}
		return (
			<>
				<ClampText lines={APPROVAL_DETAIL_LINES} style={cardStyles.command} onOverflow={onOverflow}>{detail}</ClampText>
				{overflow ? link('全文を表示') : null}
			</>
		);
	}
	switch (request.kind) {
		case 'bash': {
			const command = request.command ?? '';
			return (
				<>
					<ClampText lines={APPROVAL_DETAIL_LINES} style={cardStyles.command} onOverflow={onOverflow}>{command}</ClampText>
					{request.truncated === true ? <Text style={cardStyles.hint}>コマンドが長いため、途中までです。全体は PC で確認してください</Text> : null}
					{overflow ? link(`すべて表示（${approvalLineCount(command)} 行）`) : null}
				</>
			);
		}
		case 'edit': {
			const diff = approvalEditDiff(request.oldText ?? '', request.newText ?? '', CARD_DIFF_LINES);
			return (
				<>
					<ClampText lines={CARD_ITEM_LINES} style={styles.path} onOverflow={onOverflow}>{request.path}</ClampText>
					{request.replaceAll === true ? <View style={styles.chips}><Text style={cardStyles.chip}>すべて置き換え</Text></View> : null}
					<DiffBox lines={diff.lines} clamp={{ lines: CARD_ITEM_LINES, onOverflow }} />
					{diff.hidden > 0 || request.truncated === true || overflow ? link('差分をすべて表示') : null}
				</>
			);
		}
		case 'write': {
			const content = request.content ?? '';
			const lines = request.contentLines ?? approvalLineCount(content);
			return (
				<>
					<ClampText lines={CARD_ITEM_LINES} style={styles.path} onOverflow={onOverflow}>{request.path}</ClampText>
					<View style={styles.chips}><Text style={cardStyles.chip}>{lines} 行</Text></View>
					{content.length > 0 ? <ClampText lines={CARD_CONTENT_LINES} style={cardStyles.command} onOverflow={onOverflow}>{content}</ClampText> : null}
					{lines > CARD_CONTENT_LINES || request.truncated === true || overflow ? link('全文を表示') : null}
				</>
			);
		}
		case 'fetch': {
			const parts = approvalUrlParts(request.url ?? '');
			return (
				<>
					<ClampText lines={CARD_ITEM_LINES} style={styles.path} onOverflow={onOverflow} measureText={request.url ?? ''}>
						<Text style={styles.urlDim}>{parts.scheme}</Text>
						<Text style={styles.host}>{parts.host}</Text>
						<Text style={styles.urlDim}>{parts.rest}</Text>
					</ClampText>
					{request.prompt !== undefined ? <ClampText lines={3} style={styles.from} onOverflow={onOverflow}>目的: {request.prompt}</ClampText> : null}
					{overflow ? link('すべて表示') : null}
				</>
			);
		}
		case 'mcp':
		case 'other': {
			const args = request.args ?? [];
			return (
				<>
					{request.kind === 'mcp' ? (
						<Text style={styles.from}>サーバー <Text style={styles.fromName}>{request.mcpServer}</Text> · ツール <Text style={styles.fromName}>{request.mcpTool}</Text></Text>
					) : request.path !== undefined ? <ClampText lines={CARD_ITEM_LINES} style={styles.path} onOverflow={onOverflow}>{request.path}</ClampText> : null}
					{args.length > 0 ? <ArgsBox args={args.slice(0, CARD_ARGS)} clamp={{ lines: CARD_ITEM_LINES, onOverflow }} /> : null}
					{args.length > CARD_ARGS || request.truncated === true || overflow ? link('すべて表示') : null}
				</>
			);
		}
	}
}

/** シートに出す全体（カードで折りたたんだぶんも含む）。 */
function ApprovalFull({ request, detail }: { request: IParadisAgentApprovalRequest | undefined; detail: string | undefined }) {
	const cardStyles = useChatStyles(baseCardStyles);
	const styles = useChatStyles(baseStyles);
	const truncatedNote = request?.truncated === true ? <Text style={cardStyles.hint}>長いため、先頭だけを表示しています。全体は PC で確認してください</Text> : null;
	switch (request?.kind) {
		case undefined:
			return <Text style={styles.full} selectable>{detail ?? ''}</Text>;
		case 'bash':
			return (
				<>
					{request.description !== undefined ? <Text style={styles.description} selectable>{request.description}</Text> : null}
					<Text style={styles.full} selectable>{request.command ?? ''}</Text>
					{truncatedNote}
				</>
			);
		case 'edit':
			return (
				<>
					<Text style={styles.path} selectable>{request.path}</Text>
					<DiffBox lines={approvalEditDiff(request.oldText ?? '', request.newText ?? '').lines} />
					{truncatedNote}
				</>
			);
		case 'write':
			return (
				<>
					<Text style={styles.path} selectable>{request.path}</Text>
					<Text style={styles.full} selectable>{request.content ?? ''}</Text>
					{truncatedNote}
				</>
			);
		case 'fetch':
			return <Text style={styles.full} selectable>{[request.url, request.prompt].filter(part => part !== undefined).join('\n\n')}</Text>;
		case 'mcp':
		case 'other':
			return (
				<>
					{request.path !== undefined ? <Text style={styles.path} selectable>{request.path}</Text> : null}
					<ArgsBox args={request.args ?? []} />
					{truncatedNote}
				</>
			);
	}
}

/** カードでは各行を `clamp.lines` 行で折りたたむ（シートでは折りたたまない）。 */
function DiffBox({ lines, clamp }: { lines: readonly ApprovalDiffLine[]; clamp?: { readonly lines: number; readonly onOverflow: () => void } }) {
	const styles = useChatStyles(baseStyles);
	return (
		<View style={styles.diff}>
			{lines.map((line, index) => {
				const style = [styles.diffLine, line.kind === 'del' ? styles.diffDel : line.kind === 'add' ? styles.diffAdd : styles.diffCtx];
				const text = `${line.kind === 'del' ? '- ' : line.kind === 'add' ? '+ ' : '  '}${line.text}`;
				return clamp !== undefined
					? <ClampText key={index} lines={clamp.lines} style={style} onOverflow={clamp.onOverflow}>{text}</ClampText>
					: <Text key={index} style={style} selectable>{text}</Text>;
			})}
		</View>
	);
}

/** 写しに渡す文。文字列（と文字列の並び）なら上限の行数 + 1 行ぶんで切る（10,000 字のコマンドを丸ごと 2 回組まない）。 */
function measureCopy(children: ReactNode, lines: number): ReactNode {
	const parts = Array.isArray(children) ? children : [children];
	if (!parts.every(part => typeof part === 'string' || typeof part === 'number')) {
		return children;
	}
	return approvalMeasureCopy(parts.join(''), lines);
}

/**
 * 行数の上限で折りたたむ文。見えない写しを同じ幅・同じ書式で重ね、その `onTextLayout` で実際の行数を測る
 * （文字数から行数を見積もると、折り返しや文字の幅で外れる）。上限を超えたら `onOverflow` を呼ぶ。
 * 子が文字列でないとき（URL の色分け）は、`measureText` を写しに使う。
 */
function ClampText({ lines, style, onOverflow, children, measureText }: { lines: number; style: StyleProp<TextStyle>; onOverflow: () => void; children: ReactNode; measureText?: string }) {
	const styles = useChatStyles(baseStyles);
	const copy = measureCopy(measureText ?? children, lines);
	return (
		<View>
			<Text style={style} numberOfLines={lines} selectable>{children}</Text>
			<View style={styles.measure} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
				<Text style={style} onTextLayout={event => { if (event.nativeEvent.lines.length > lines) { onOverflow(); } }}>{copy}</Text>
			</View>
		</View>
	);
}

/** 引数を「名前 値」の行で並べる（MCP・形を知らないツール）。 */
function ArgsBox({ args, clamp }: { args: readonly { readonly key: string; readonly value: string }[]; clamp?: { readonly lines: number; readonly onOverflow: () => void } }) {
	const styles = useChatStyles(baseStyles);
	return (
		<View style={styles.args}>
			{args.map((arg, index) => (
				<View key={`${index}:${arg.key}`} style={styles.argRow}>
					<Text style={styles.argKey}>{arg.key}</Text>
					{clamp !== undefined
						? <View style={styles.argValueBox}><ClampText lines={clamp.lines} style={styles.argValueText} onOverflow={clamp.onOverflow}>{arg.value}</ClampText></View>
						: <Text style={styles.argValue} selectable>{arg.value}</Text>}
				</View>
			))}
		</View>
	);
}

const baseStyles = StyleSheet.create({
	from: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textDim,
	},
	fromName: {
		fontWeight: '600',
		color: colors.text,
	},
	/** 狭い幅: 説明・札・警告を上、コマンドを下に積む。 */
	body: {
		flexDirection: 'column',
		gap: space.sm,
	},
	/** 広い幅: コマンドを左、説明・札・警告を右に並べる（子の順は同じで、向きだけ変える）。 */
	bodySplit: {
		flexDirection: 'row-reverse',
		alignItems: 'flex-start',
		gap: space.md,
	},
	side: {
		gap: space.sm,
	},
	main: {
		flexGrow: 1,
		flexShrink: 1,
		minWidth: 0,
		gap: space.sm,
	},
	hidden: {
		display: 'none',
	},
	description: {
		fontSize: type.body,
		lineHeight: 20,
		color: colors.text,
	},
	dangers: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.xs,
	},
	danger: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: tint(colors.red, alpha.strong),
		borderRadius: radius.key,
		paddingHorizontal: 6,
		paddingVertical: 1,
	},
	dangerText: {
		fontSize: type.caption,
		fontWeight: '700',
		color: colors.red,
	},
	alert: {
		gap: 2,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: tint(colors.yellow, alpha.strong),
		backgroundColor: tint(colors.yellow, alpha.faint),
		borderRadius: radius.control,
		paddingHorizontal: space.sm,
		paddingVertical: 6,
	},
	alertTitle: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.yellow,
	},
	alertText: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.text,
	},
	path: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.text,
	},
	urlDim: {
		color: colors.textMuted,
	},
	host: {
		fontWeight: '700',
		color: colors.yellow,
	},
	chips: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.xs,
	},
	diff: {
		backgroundColor: colors.bg,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		borderRadius: radius.control,
		paddingVertical: 6,
	},
	diffLine: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: 17,
		paddingHorizontal: 10,
	},
	diffDel: {
		color: colors.text,
		backgroundColor: colors.delBg,
	},
	diffAdd: {
		color: colors.text,
		backgroundColor: colors.addBg,
	},
	diffCtx: {
		color: colors.textMuted,
	},
	args: {
		gap: 2,
		backgroundColor: colors.bg,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		borderRadius: radius.control,
		paddingHorizontal: 10,
		paddingVertical: space.sm,
	},
	argRow: {
		flexDirection: 'row',
		gap: 10,
	},
	argKey: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textDim,
	},
	argValue: {
		flex: 1,
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.text,
	},
	argValueBox: {
		flex: 1,
		minWidth: 0,
	},
	argValueText: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.text,
	},
	/** 行数を測るための見えない写し（同じ幅に重ねる）。 */
	measure: {
		position: 'absolute',
		top: 0,
		left: 0,
		right: 0,
		opacity: 0,
	},
	row: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.sm,
	},
	column: {
		gap: space.sm,
	},
	/** 横に並べるときは同じ幅で分け合う。 */
	choiceRow: {
		flexGrow: 1,
		flexBasis: 0,
	},
	/** 広い幅では伸ばさず、押しやすい幅だけ取る（モックの iPad の `.btn`）。 */
	choiceRowWide: {
		minWidth: 120,
	},
	choice: {
		alignItems: 'center',
	},
	/** ルールを添えるボタンは左に揃える（モックの `.btn.sub`）。 */
	choiceWithRule: {
		alignItems: 'flex-start',
		gap: 2,
	},
	choiceText: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	denyText: {
		color: colors.red,
	},
	rule: {
		fontFamily: monoFamily,
		fontSize: type.caption,
		lineHeight: 15,
		color: colors.textDim,
	},
	full: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: 18,
		color: colors.text,
		backgroundColor: colors.panel,
		borderRadius: radius.control,
		padding: space.md,
	},
});
