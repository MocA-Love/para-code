// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { paraAlert } from '../../paraAlert.js';
import { ArrowUp, CircleAlert, CornerDownRight, ImagePlus, Info, Monitor } from 'lucide-react-native';
import { appendQuickReply } from '../../agentConversationUx.js';
import { useAppStore } from '../../appState.js';
import { flattenAnswerInput, reconcileSubmittedDraftTarget, shouldShowSubmissionAlert } from '../../components/agentComposerDraft.js';
import { ComposerAttachmentChips } from '../../components/attachmentChips.js';
import { saveAttachmentDeviceCopy } from '../../attachments/attachmentImages.js';
import { ATTACHMENT_LIMIT, attachmentNameOf, attachmentTextBudget, composeAttachmentMessage } from '../../attachments/attachmentText.js';
import {
	appendComposerAttachments,
	composerAttachmentSendState,
	composerAttachmentsOf,
	patchComposerAttachment,
	remainingAttachmentSlots,
	restoreComposerAttachments,
	setComposerAttachments,
	useComposerAttachments,
	type ComposerAttachment,
} from '../../attachments/composerAttachments.js';
import { agentSlashQuery, filterAgentSlashCommands, normalizeAgentSlashSubmission, selectedAgentSlashCommandText } from '../../components/agentSlashCommands.js';
import { agentBuiltinCommandBadge, agentComposerIntercept, agentPanelLabel, claudeBuiltinCommand, type AgentComposerIntercept } from '../../components/agentBuiltinCommands.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import type { QuestionFreeTextRequest } from '../../components/questionCard.js';
import { haptic } from '../../haptics.js';
import type { AgentMonitor } from '../../agentMonitors.js';
import type { AgentShell, AgentShellsAccess } from '../../agentShells.js';
import { AGENT_COMPOSER_NOT_EMPTY_CODE, AGENT_PANEL_OPEN_CODE, AGENT_SLASH_COMMAND_REJECTED_CODE, type AgentCommandCatalogState, type AgentSlashRejection, type AgentCommandOption, type AgentMessageSendResult, type AgentModelControlState, type AgentPanel, type FsUploadResult } from '../../store.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { useChatIconSize, useChatStyles } from '../../ui/chatTextScale.js';
import { Button, Icon, iconSize, useThemeColors } from '../../ui/index.js';
import { errorKind } from './errorKind.js';
import { ModelPill, type ModelPillHandle } from './modelDrawer.js';
import { SessionStatusCard } from './sessionStatusCard.js';
import { BackgroundPill } from './backgroundPill.js';
import { SlashCommandList } from './slashCommandList.js';
import { useIsFocused } from 'expo-router';
import { useShortcutSlot } from '../../ipad/shortcutRegistry.js';

/** 丸いボタン（モックの `.cib` / `.csend`: 40）。当たり判定は 44 に広げる。 */
const ROUND = 40;
const ROUND_SLOP = hitSlopToMinimum(ROUND, ROUND);

export interface SessionComposerHandle {
	/** クイック返信などの文字を入力欄へ入れる（書きかけがあれば後ろへ足す。送信はしない）。 */
	insertText(text: string): void;
	focus(): void;
}

interface SessionComposerProps {
	/** 下書きの退避キー（ターミナル単位）。 */
	draftKey: string | undefined;
	terminalKey: string | undefined;
	sessionEpoch: string | undefined;
	agent: string | undefined;
	model: string | undefined;
	effort: string | undefined;
	modelControl: AgentModelControlState | undefined;
	/** モデルと effort をモバイルから変えられない（PC が `info.modelControl: 'none'` を送ってきた）。 */
	modelLocked?: boolean;
	commandCatalog: AgentCommandCatalogState | undefined;
	/** Claude Code の Monitor の一覧（古い PC では undefined。そのときピルは出ない）。 */
	monitors: readonly AgentMonitor[] | undefined;
	/** Claude Code のバックグラウンドのシェルの一覧（古い PC では undefined）。Monitor と 1 つのピルにまとめる。 */
	shells: readonly AgentShell[] | undefined;
	/** シェルの出力と停止をこの構成で使えるか。 */
	shellsAccess: AgentShellsAccess | undefined;
	sendText: (text: string) => Promise<AgentMessageSendResult>;
	updateClaudeSetting: (setting: 'model' | 'effort', value: string) => Promise<AgentMessageSendResult>;
	onAfterSubmit: () => void;
	fsUpload: (name: string, dataBase64: string, ws?: string) => Promise<FsUploadResult>;
	/** このエージェントのスペース（添付をそのスペースの PC 画面へ上げる。SSH 接続中は接続先に置かれる）。 */
	ws?: string;
	requestAgentModelCatalog: (terminalKey: string) => void;
	/** 求められなかったら false（Codex の送信を一覧待ちで止めない）。 */
	requestAgentCommandCatalog: (terminalKey: string) => boolean;
	updateAgentSettings: (terminalKey: string, model: string, effort: string) => void;
	/** 受け付けた後で PC が断ったスラッシュコマンド（理由を出し、入力欄が空なら文を戻してから `onSlashRejectionHandled`）。 */
	slashRejection?: AgentSlashRejection;
	onSlashRejectionHandled?: (requestId: string) => void;
	/** 端末の画面へ移る（PC の画面を閉じる・入力欄の文字を消すための導線）。 */
	onOpenTerminal?: () => void;
	/** PC で開いている画面（agent.panel.v1）。あれば入力欄の上に帯を出し、閉じるまで送信を止める。 */
	panel?: AgentPanel;
	/** PC が画面の帯と「閉じる」を扱える（agent.panel.v1）。断りの panel-open は帯に任せる。 */
	panelSupported?: boolean;
	/** 帯の「閉じる」（PC へ Esc を送る）。 */
	onClosePanel?: () => Promise<AgentMessageSendResult>;
	/** `/usage`: アプリの「使用量」の画面へ移る。 */
	onOpenUsage?: () => void;
	/** `/status` のカードに出すスペースの名前とブランチ（この端末が持っている値）。 */
	spaceName?: string;
	branch?: string;
	/** 質問への回答入力に切り替えているときの依頼（無ければ通常のメッセージ入力）。 */
	answerTarget?: QuestionFreeTextRequest;
	onCancelAnswer: () => void;
	answerRefreshing: boolean;
}

/**
 * 会話表示の入力欄（Orca の MobileNativeChatComposer。モックの `.composer`）。
 * 上段に入力、下段に 画像の添付・モデルと effort のピル・Monitor とシェルのピル（あるときだけ）・送信の白い円。
 *
 * 入力と送信の決まりは旧部品（`components/agentComposer.tsx`）をそのまま移している:
 *  - 入力中の文字はネイティブの TextInput が持ち（uncontrolled）、下書きはストアへ一方向に退避する。
 *    日本語の変換中に値を書き戻すと、変換途中の文字が確定・分解されるため
 *  - 送った本文は先に入力欄から外し、PC に拒否されたら入力欄へ戻す（`agentComposerDraft.ts`）
 *  - 質問カードの「その他」を押すと回答入力に切り替わる。書きかけの下書きは入力欄から外し、
 *    回答を送れた・やめた・質問が替わったら戻す（回答に下書きが混ざらないように）
 *  - `/` で始めるとスラッシュコマンドの候補を出す。一覧は `/` を打つたびに PC へ求める（PC が短く覚えている）
 *  - エージェントがスラッシュコマンドを断ったら（候補に無い名前など）、理由を入力欄の上に出し、文を入力欄へ戻す
 *  - 組み込みのコマンドの一部は送らずにこの端末で引き受ける（agentBuiltinCommands.ts）: 引数の無い `/model`・`/effort` は
 *    モデルのシート、`/model <別名>`・`/effort <段階>` はピルと同じ経路、`/usage` は使用量の画面、`/status` はカード。
 *    PC で画面が開くコマンドは候補に札を付け、手で打って送ったときは送る前に確かめる。Codex の `/model …` は案内を出す
 *  - PC で画面が開いている間（agent.panel.v1）は、入力欄の上に帯と「閉じる」（Esc）を出し、送信を止める
 *  - 画像は PC へ上げ、入力欄の文字の上に札で並べる（案 P2。文字にはパスを入れない）。送るときに
 *    パスを本文の先頭に並べる（案 M1）。上げ終わるまで送れず、失敗した画像は確かめてから外して送る
 */
export const SessionComposer = memo(forwardRef<SessionComposerHandle, SessionComposerProps>(function SessionComposer({
	draftKey, terminalKey, sessionEpoch, agent, model, effort, modelControl, modelLocked, commandCatalog, monitors, shells, shellsAccess,
	sendText, updateClaudeSetting, onAfterSubmit, fsUpload, ws, requestAgentModelCatalog, requestAgentCommandCatalog, updateAgentSettings,
	answerTarget, onCancelAnswer, answerRefreshing, slashRejection, onSlashRejectionHandled, onOpenTerminal,
	panel, panelSupported = false, onClosePanel, onOpenUsage, spaceName, branch,
}, ref) {
	const loadDraft = (key: string | undefined): string => key !== undefined ? useAppStore.getState().agentDrafts[key] ?? '' : '';
	const nativeInputRef = useRef<TextInput>(null);
	const theme = useThemeColors();
	// 会話の文字サイズ（設定 → チャット UI）は入力の文字と回答中の案内にだけかける。
	// 丸いボタン・ピル・枠の余白は操作の部品なので変えない。
	const textStyles = useChatStyles(styles);
	const answerIconSize = useChatIconSize(iconSize.sm);
	const inputRef = useRef(loadDraft(draftKey));
	const defaultValueRef = useRef(inputRef.current);
	const submissionGenerationRef = useRef(0);
	const draftKeyRef = useRef(draftKey);
	const [inputMeta, setInputMeta] = useState(() => ({ key: draftKey, sendable: inputRef.current.trim().length > 0 }));
	const [slashQuery, setSlashQuery] = useState<string | undefined>(() => agentSlashQuery(inputRef.current));
	// 入力が `/` で始まっているか（始まったときに一覧を求める。`/name 引数` まで打っても求め直さない）
	const [slashLead, setSlashLead] = useState(() => inputRef.current.startsWith('/'));
	// 送ったスラッシュコマンドをエージェントが断った理由（入力欄の上に出す。書き換えたら消す）
	// `terminal`: 端末の画面で片付ける断り（PC で開いた画面・入力欄に残った文字）。端末へ移るボタンを添える
	// `sheet`: モデルのシートを開くボタンを添える（別名でない `/model <値>` への案内）
	const [slashError, setSlashError] = useState<{ readonly message: string; readonly terminal: boolean; readonly sheet?: boolean } | undefined>(undefined);
	// 入力欄の上に出す、この端末で引き受けたコマンドのカード（`/status`）と案内（Codex の `/model …`）
	const [localCard, setLocalCard] = useState<'status' | 'codex-model' | undefined>(undefined);
	const [closingPanel, setClosingPanel] = useState(false);
	// 「閉じる」を受け付けた画面（since）。PC が閉じたと知らせてくるまで帯を先に隠す（二度押しを防ぐ）。まだ開いていると
	// 断られたら（panel-open）出し直す
	const [dismissedPanelSince, setDismissedPanelSince] = useState<number | undefined>(undefined);
	const modelPillRef = useRef<ModelPillHandle>(null);
	// 候補から選んだコマンドの名前（札を見て選んだので、PC で画面が開くコマンドでも送る前に確かめない）
	const pickedCommandRef = useRef<string | undefined>(undefined);
	// 確かめた・「文章として送る」を選んだ送信は、入力欄で引き受けずにそのまま送る
	const bypassInterceptRef = useRef(false);
	// 入力欄が引き受けた送信の処理（下で毎回作り直す。submit からは最新のものを呼ぶ）
	const handleInterceptRef = useRef<(intercept: AgentComposerIntercept, text: string) => void>(() => { });
	const panelSupportedRef = useRef(panelSupported);
	panelSupportedRef.current = panelSupported;
	const [submitting, setSubmitting] = useState(false);
	const answering = answerTarget !== undefined;
	const answeringRef = useRef(answering);
	answeringRef.current = answering;
	// 添付は入力欄ごと（質問への回答の入力は別）に持つ。
	const attachmentKey = attachmentKeyOf(draftKey, answering);
	const attachments = useComposerAttachments(attachmentKey);
	const attachmentState = composerAttachmentSendState(attachments);
	const hasReadyAttachments = attachments.some(item => item.status === 'ready');
	if (draftKeyRef.current !== draftKey) {
		draftKeyRef.current = draftKey;
		inputRef.current = answering ? '' : loadDraft(draftKey);
		defaultValueRef.current = inputRef.current;
		submissionGenerationRef.current++;
	}
	const sendable = inputMeta.key === draftKey ? inputMeta.sendable : inputRef.current.trim().length > 0;
	useEffect(() => {
		setSubmitting(false);
		setInputMeta({ key: draftKey, sendable: inputRef.current.trim().length > 0 });
		setSlashQuery(agentSlashQuery(inputRef.current));
		setSlashLead(inputRef.current.startsWith('/'));
		setSlashError(undefined);
	}, [draftKey]);
	// `/` を打つたびに（入力が `/` で始まったときに）一覧を求め直す。PC 側で短く覚えているので、打ち直しても重くない
	useEffect(() => {
		if (slashLead && !answeringRef.current && terminalKey !== undefined && agent !== undefined) {
			requestAgentCommandCatalog(terminalKey);
		}
	}, [terminalKey, agent, requestAgentCommandCatalog, slashLead]);

	const updateInput = useCallback((input: string) => {
		// 回答は PC で1行に平坦化されて送られるので、改行を打った時点で空白に置き換えて見せる。
		const text = answeringRef.current ? flattenAnswerInput(input) : input;
		if (text !== input) {
			nativeInputRef.current?.setNativeProps({ text });
		}
		inputRef.current = text;
		if (draftKey !== undefined && !answeringRef.current) {
			useAppStore.getState().setAgentDraft(draftKey, text);
		}
		const nextSendable = text.trim().length > 0;
		setSlashQuery(agentSlashQuery(text));
		setSlashLead(text.startsWith('/'));
		setSlashError(undefined);
		setLocalCard(current => current === 'codex-model' ? undefined : current);
		// 候補から選んだコマンドを打ち替えたら、選んだ印を外す（手で打ったものは送る前に確かめる）
		const picked = pickedCommandRef.current;
		if (picked !== undefined && !text.trimStart().toLocaleLowerCase().startsWith(`/${picked.toLocaleLowerCase()}`)) {
			pickedCommandRef.current = undefined;
		}
		setInputMeta(current => current.key === draftKey && current.sendable === nextSendable ? current : { key: draftKey, sendable: nextSendable });
	}, [draftKey]);
	const replaceActiveInput = useCallback((input: string) => {
		const text = answeringRef.current ? flattenAnswerInput(input) : input;
		inputRef.current = text;
		if (draftKeyRef.current !== undefined && !answeringRef.current) {
			useAppStore.getState().setAgentDraft(draftKeyRef.current, text);
		}
		nativeInputRef.current?.setNativeProps({ text });
		setSlashQuery(agentSlashQuery(text));
		setSlashLead(text.startsWith('/'));
		setInputMeta({ key: draftKeyRef.current, sendable: text.trim().length > 0 });
	}, []);
	const clearActiveInput = useCallback(() => {
		inputRef.current = '';
		if (draftKeyRef.current !== undefined && !answeringRef.current) {
			useAppStore.getState().clearAgentDraft(draftKeyRef.current);
		}
		nativeInputRef.current?.clear();
		setSlashQuery(undefined);
		setSlashLead(false);
		setInputMeta({ key: draftKeyRef.current, sendable: false });
	}, []);
	// 受け付けた後で断られたスラッシュコマンド: 理由を出し、入力欄が空なら送った文を戻す（書きかけは上書きしない）
	const handledRejectionRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (slashRejection === undefined || handledRejectionRef.current === slashRejection.requestId) {
			return;
		}
		handledRejectionRef.current = slashRejection.requestId;
		if (!answeringRef.current && inputRef.current.trim().length === 0) {
			replaceActiveInput(slashRejection.text);
		}
		haptic('error');
		setSlashError({ message: slashRejection.message, terminal: false });
		onSlashRejectionHandled?.(slashRejection.requestId);
	}, [slashRejection, onSlashRejectionHandled, replaceActiveInput]);
	// 回答入力への出入りで入力欄を差し替える（入るときは空に、出るときはストアの下書きを戻す）。
	const previousAnsweringRef = useRef(answering);
	useEffect(() => {
		if (previousAnsweringRef.current === answering) {
			return;
		}
		previousAnsweringRef.current = answering;
		if (!answering) {
			// 回答をやめた・送れたら、回答の入力に付けていた添付は捨てる（次の質問へ持ち越さない）
			setComposerAttachments(attachmentKeyOf(draftKeyRef.current, true), () => []);
		}
		const text = answering ? '' : loadDraft(draftKeyRef.current);
		inputRef.current = text;
		nativeInputRef.current?.setNativeProps({ text });
		setSlashQuery(answering ? undefined : agentSlashQuery(text));
		setSlashLead(!answering && text.startsWith('/'));
		setSlashError(undefined);
		setInputMeta({ key: draftKeyRef.current, sendable: text.trim().length > 0 });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- loadDraft はストアを読むだけの関数
	}, [answering]);

	const submit = useCallback(() => {
		if (submitting) {
			return;
		}
		const text = inputRef.current;
		const submittedAttachmentKey = attachmentKeyOf(draftKey, answerTarget !== undefined);
		const attachmentList = composerAttachmentsOf(submittedAttachmentKey);
		const sendState = composerAttachmentSendState(attachmentList);
		if (sendState.kind === 'uploading') {
			return;
		}
		if (sendState.kind === 'failed') {
			// 失敗した画像は、確かめてから外して送る（画像のために本文まで止めない）
			haptic('warning');
			paraAlert.alert(
				'送れなかった画像があります',
				`アップロードできなかった ${sendState.failed} 枚を外して送りますか？`,
				[
					{ text: 'キャンセル', style: 'cancel' },
					{
						text: '外して送る',
						onPress: () => {
							setComposerAttachments(submittedAttachmentKey, list => list.filter(item => item.status !== 'failed'));
							submitRef.current();
						},
					},
				],
			);
			return;
		}
		const sentAttachments = attachmentList.filter(item => item.status === 'ready');
		if ((text.trim().length === 0 && sendState.paths.length === 0) || (answerTarget !== undefined && answerRefreshing)) {
			return;
		}
		// 組み込みのコマンドの一部は送らずにここで引き受ける（回答の入力と、添付のある文はそのまま送る）
		const bypass = bypassInterceptRef.current;
		bypassInterceptRef.current = false;
		const intercept = bypass || answerTarget !== undefined || sendState.paths.length > 0
			? undefined
			: agentComposerIntercept(text, agent, commandCatalog?.commands ?? [], pickedCommandRef.current);
		if (intercept !== undefined) {
			handleInterceptRef.current(intercept, text);
			return;
		}
		pickedCommandRef.current = undefined;
		const restoreAttachments = () => {
			if (sentAttachments.length > 0) {
				setComposerAttachments(submittedAttachmentKey, list => restoreComposerAttachments(list, sentAttachments));
			}
		};
		setComposerAttachments(submittedAttachmentKey, () => []);
		const submittedDraftKey = draftKey;
		const generation = ++submissionGenerationRef.current;
		setSubmitting(true);
		if (answerTarget !== undefined) {
			// 質問への回答として送る（送り方と失敗の表示は質問カードが持つ）。拒否されたら本文と添付を戻す。
			clearActiveInput();
			answerTarget.submit(composeAttachmentMessage(sendState.paths, text.trim(), true))
				.catch((): AgentMessageSendResult => ({ status: 'rejected', message: '回答を送信できませんでした' }))
				.then(result => {
					if (result.status === 'rejected') {
						restoreAttachments();
					}
					if (result.status === 'rejected' && answeringRef.current && draftKeyRef.current === submittedDraftKey) {
						replaceActiveInput(text + inputRef.current);
					}
				})
				.finally(() => {
					if (submissionGenerationRef.current === generation) {
						setSubmitting(false);
					}
				});
			return;
		}
		clearActiveInput();
		setSlashError(undefined);
		setLocalCard(undefined);
		const normalizedText = normalizeAgentSlashSubmission(text, agent, commandCatalog?.commands ?? []);
		// スラッシュコマンドは先頭が `/` でないと効かないので、添付のパスは後ろへ足す
		const submittedText = sendState.paths.length > 0 && normalizedText.trimStart().startsWith('/')
			? `${normalizedText} ${sendState.paths.join(' ')}`
			: composeAttachmentMessage(sendState.paths, normalizedText);
		sendText(submittedText).catch((): AgentMessageSendResult => ({ status: 'rejected', message: '送信処理中にエラーが発生しました' })).then(result => {
			if (result.status === 'rejected') {
				restoreAttachments();
			}
			const storedDraft = submittedDraftKey !== undefined ? useAppStore.getState().agentDrafts[submittedDraftKey] ?? '' : '';
			const reconciliation = answeringRef.current
				? (result.status === 'rejected' && submittedDraftKey !== undefined
					? { kind: 'stored' as const, key: submittedDraftKey, value: text + storedDraft }
					: { kind: 'none' as const })
				: reconcileSubmittedDraftTarget(draftKeyRef.current, submittedDraftKey, inputRef.current, storedDraft, text, result.status);
			if (reconciliation.kind === 'active' && reconciliation.value !== inputRef.current) {
				replaceActiveInput(reconciliation.value);
			} else if (reconciliation.kind === 'stored') {
				useAppStore.getState().setAgentDraft(reconciliation.key, reconciliation.value);
			}
			if (result.status === 'accepted' && submissionGenerationRef.current === generation) {
				onAfterSubmit();
			}
			if (result.status === 'consumed' && shouldShowSubmissionAlert(result.status, submissionGenerationRef.current, generation)) {
				haptic('warning');
				paraAlert.alert('メッセージは未送信です', result.message ?? '本文はターミナルの入力欄に残っています。ターミナル表示で確認して送信してください。');
			}
			const inlineCode = result.status === 'rejected' ? result.code : undefined;
			if (result.status === 'rejected' && inlineCode === AGENT_PANEL_OPEN_CODE && panelSupportedRef.current && submissionGenerationRef.current === generation) {
				// PC の画面が開いている。帯（panel）が理由と「閉じる」を出すので、ここでは鳴らすだけ（先に隠した帯も出し直す）
				haptic('error');
				setDismissedPanelSince(undefined);
			} else if (result.status === 'rejected' && inlineCode !== undefined && INLINE_REJECTION_CODES.has(inlineCode) && submissionGenerationRef.current === generation) {
				// エージェントが断った・PC の画面が塞がっている。文は入力欄へ戻してあるので、理由を入力欄の上に出す（ダイアログは出さない）
				haptic('error');
				setSlashError({
					message: result.message ?? 'エージェントがこのコマンドを実行しませんでした',
					terminal: inlineCode === AGENT_PANEL_OPEN_CODE || inlineCode === AGENT_COMPOSER_NOT_EMPTY_CODE,
				});
			} else if (result.status === 'rejected' && shouldShowSubmissionAlert(result.status, submissionGenerationRef.current, generation)) {
				// 送った時点で commit を鳴らしている。受理では鳴らさず、届かなかったときだけ知らせる
				haptic('error');
				paraAlert.alert('メッセージを送信できませんでした', result.message ?? '接続とエージェントのセッションを確認して再送してください。');
			}
		}).finally(() => {
			if (submissionGenerationRef.current === generation) {
				setSubmitting(false);
			}
		});
	}, [submitting, draftKey, clearActiveInput, replaceActiveInput, sendText, onAfterSubmit, agent, commandCatalog?.commands, answerTarget, answerRefreshing]);
	// 確認のダイアログから送り直すときは、その時点の submit を呼ぶ
	const submitRef = useRef(submit);
	submitRef.current = submit;

	/** 設定の変更（`/model <別名>`・`/effort <段階>`）。断られたら文を入力欄へ戻し、理由を上に出す。 */
	const applySetting = (setting: 'model' | 'effort', value: string, text: string) => {
		clearActiveInput();
		setSlashError(undefined);
		setSubmitting(true);
		const generation = ++submissionGenerationRef.current;
		updateClaudeSetting(setting, value).catch((): AgentMessageSendResult => ({ status: 'rejected' })).then(result => {
			if (result.status === 'accepted') {
				// 結果は PC の会話に知らせの行で出る（モデルを sonnet に変えました）
				onAfterSubmit();
				return;
			}
			if (!answeringRef.current && inputRef.current.trim().length === 0) {
				replaceActiveInput(text);
			}
			haptic('error');
			setSlashError({ message: (result.status === 'rejected' && result.message) || 'Claude Code が入力待ちであることを確かめてから送り直してください', terminal: false });
		}).finally(() => {
			if (submissionGenerationRef.current === generation) {
				setSubmitting(false);
			}
		});
	};

	/** 入力欄が引き受けた送信（agentComposerIntercept）と、候補で選んだシート・使用量・状態。 */
	handleInterceptRef.current = (intercept: AgentComposerIntercept, text: string) => {
		switch (intercept.kind) {
			case 'model-sheet':
			case 'effort-sheet':
				if (modelPillRef.current?.open(intercept.kind === 'effort-sheet' ? 'effort' : 'model') === true) {
					clearActiveInput();
				} else {
					haptic('warning');
					setSlashError({ message: 'いまはモデルを選べません。Claude Code が入力待ちになってから試してください', terminal: false });
				}
				return;
			case 'model-switch':
				applySetting('model', intercept.alias, text);
				return;
			case 'effort-switch':
				applySetting('effort', intercept.level, text);
				return;
			case 'model-not-alias':
				haptic('warning');
				setSlashError({ message: `「${intercept.value}」はモデルの別名ではないので送りませんでした。default・sonnet・opus・haiku・fable・best・opusplan（[1m] 付きも可）のどれかを指定するか、シートで選んでください`, terminal: false, sheet: true });
				return;
			case 'usage':
				clearActiveInput();
				haptic('move');
				onOpenUsage?.();
				return;
			case 'status':
				clearActiveInput();
				haptic('move');
				setLocalCard('status');
				return;
			case 'codex-model':
				haptic('warning');
				setLocalCard('codex-model');
				return;
			case 'confirm-panel':
				haptic('warning');
				paraAlert.alert(
					'PC で画面が開きます',
					`/${intercept.command} は PC に${intercept.title}の画面を開きます。この端末からは中を操作できず、閉じるまで発言を送れません。`,
					[
						{ text: 'やめる', style: 'cancel' },
						{ text: 'PC で開く', onPress: () => { bypassInterceptRef.current = true; submitRef.current(); } },
					],
				);
				return;
		}
	};

	const closePanel = () => {
		if (onClosePanel === undefined || closingPanel || panel === undefined) {
			return;
		}
		haptic('move');
		setClosingPanel(true);
		// 押したらすぐに帯を隠す（二度押しで Esc を 2 回送らない）。断られたら出し直す
		const since = panel.since;
		setDismissedPanelSince(since);
		onClosePanel().catch((): AgentMessageSendResult => ({ status: 'rejected' })).then(result => {
			if (result.status === 'rejected') {
				haptic('error');
				setDismissedPanelSince(current => current === since ? undefined : current);
				setSlashError({ message: result.message ?? 'PC の画面を閉じられませんでした。端末を開いて Esc を送ってください', terminal: true });
			}
		}).finally(() => setClosingPanel(false));
	};

	useImperativeHandle(ref, () => ({
		insertText: (text: string) => replaceActiveInput(appendQuickReply(inputRef.current, text)),
		focus: () => nativeInputRef.current?.focus(),
	}), [replaceActiveInput]);

	const showSlashMenu = slashQuery !== undefined && answerTarget === undefined;
	// 取り直している間は、前に取った一覧で候補を出す
	const visibleCommands = slashQuery !== undefined && commandCatalog !== undefined && (commandCatalog.status === 'ready' || commandCatalog.commands.length > 0)
		? filterAgentSlashCommands(commandCatalog.commands, slashQuery)
		: [];
	// Codex の skill は送る前に `$name` へ直すので、一覧が 1 度も届いていない取得中だけ送信を待たせる。
	// 求められなかった（PC と繋がっていない等）・失敗・時間切れのときは待たない
	const codexSlashCatalogPending = answerTarget === undefined && agent === 'codex' && /^\/\S/.test(inputRef.current)
		&& commandCatalog?.status === 'loading' && commandCatalog.commands.length === 0;
	const selectSlashCommand = (command: AgentCommandOption) => {
		// シート・使用量・状態のカードで済むコマンドは、文字を入れずにその場で開く
		const builtin = agent === 'claude' && command.source === 'built-in' ? claudeBuiltinCommand(command.name, commandCatalog?.commands ?? []) : undefined;
		if (builtin?.action === 'model-sheet' || builtin?.action === 'effort-sheet' || builtin?.action === 'usage' || builtin?.action === 'status') {
			handleInterceptRef.current({ kind: builtin.action }, `/${command.name}`);
			return;
		}
		pickedCommandRef.current = command.name;
		replaceActiveInput(selectedAgentSlashCommandText(command));
		setSlashQuery(undefined);
		nativeInputRef.current?.focus();
	};
	const commandBadge = (command: AgentCommandOption) => agentBuiltinCommandBadge(agent, command, commandCatalog?.commands ?? []);
	const retryCommandCatalog = useCallback(() => {
		if (terminalKey !== undefined) {
			requestAgentCommandCatalog(terminalKey);
		}
	}, [terminalKey, requestAgentCommandCatalog]);

	// 画像の添付: フォトライブラリから選び（複数可。上限 5 枚）、入力欄の札に並べて選んだ順に 1 枚ずつ PC へ上げる。
	const startUpload = useCallback((key: string, item: ComposerAttachment) => {
		enqueueAttachmentUpload(key, async () => {
			// 待っている間に外されていたら上げない。再試行では一覧の中身（base64）を使う
			const current = composerAttachmentsOf(key).find(candidate => candidate.id === item.id);
			if (current === undefined || current.base64 === undefined) {
				return;
			}
			patchComposerAttachment(key, item.id, { status: 'uploading' });
			try {
				const { path } = await fsUpload(current.fileName, current.base64, ws);
				const name = attachmentNameOf(path);
				const copy = name !== undefined ? await saveAttachmentDeviceCopy(name, current.base64) : undefined;
				patchComposerAttachment(key, item.id, { status: 'ready', path, name, base64: undefined, ...(copy !== undefined ? { previewUri: copy } : {}) });
			} catch (err) {
				console.warn('[session] image upload failed', errorKind(err));
				haptic('error');
				patchComposerAttachment(key, item.id, { status: 'failed' });
			}
		});
	}, [fsUpload, ws]);
	const attachImage = useCallback(async () => {
		const key = attachmentKeyOf(draftKey, answeringRef.current);
		const remaining = remainingAttachmentSlots(composerAttachmentsOf(key));
		if (remaining <= 0) {
			haptic('warning');
			paraAlert.alert('これ以上添付できません', `画像は 1 回に ${ATTACHMENT_LIMIT} 枚まで添付できます。`);
			return;
		}
		const result = await ImagePicker.launchImageLibraryAsync({
			mediaTypes: ['images'],
			base64: true,
			quality: 0.8,
			allowsMultipleSelection: true,
			selectionLimit: remaining,
			orderedSelection: true,
		});
		if (result.canceled) {
			return;
		}
		const picked: ComposerAttachment[] = [];
		for (const asset of result.assets ?? []) {
			if (asset.base64 === undefined || asset.base64 === null) {
				continue;
			}
			picked.push({
				id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				previewUri: asset.uri,
				fileName: asset.fileName ?? 'photo.jpg',
				status: 'uploading',
				base64: asset.base64,
			});
		}
		let accepted: readonly ComposerAttachment[] = [];
		setComposerAttachments(key, list => {
			const appended = appendComposerAttachments(list, picked);
			accepted = appended.accepted;
			return appended.next;
		});
		for (const item of accepted) {
			startUpload(key, item);
		}
	}, [draftKey, startUpload]);
	const removeAttachment = useCallback((id: string) => {
		setComposerAttachments(attachmentKey, list => list.filter(item => item.id !== id));
	}, [attachmentKey]);
	const retryAttachment = useCallback((id: string) => {
		const item = composerAttachmentsOf(attachmentKey).find(candidate => candidate.id === id);
		if (item !== undefined && item.status === 'failed') {
			patchComposerAttachment(attachmentKey, id, { status: 'uploading' });
			startUpload(attachmentKey, item);
		}
	}, [attachmentKey, startUpload]);

	// PC で画面が開いている間は送らない（送ると画面に打ち込まれる）。回答の入力は承認・質問の画面へ向けたものなので止めない
	const panelOpen = panel !== undefined && panel.since !== dismissedPanelSince && !answering;
	const sendDisabled = submitting || !(sendable || hasReadyAttachments) || attachmentState.kind === 'uploading' || codexSlashCatalogPending || (answering && answerRefreshing) || panelOpen;
	// 外付けキーボードの ⌘↩（iPad）。送信ボタンと同じ条件で送る。
	const focused = useIsFocused();
	useShortcutSlot('send', focused ? { send: () => { if (!sendDisabled) { haptic('commit'); submit(); } } } : undefined);
	return (
		<View style={styles.root}>
			{showSlashMenu ? (
				<SlashCommandList catalog={commandCatalog} commands={visibleCommands} onSelect={selectSlashCommand} onRetry={retryCommandCatalog} badgeFor={commandBadge} />
			) : null}
			{localCard === 'status' && answerTarget === undefined ? (
				<SessionStatusCard agent={agent} model={model} effort={effort} spaceName={spaceName} branch={branch} onClose={() => { haptic('move'); setLocalCard(undefined); }} />
			) : null}
			{localCard === 'codex-model' && answerTarget === undefined ? (
				<View style={styles.answerBanner} accessibilityLiveRegion="polite">
					<Icon icon={Info} size={answerIconSize} color={colors.yellow} />
					<View style={textStyles.answerBody}>
						<Text style={textStyles.answerPrompt}>Codex のモデルはこの端末から変えられません</Text>
						<Text style={textStyles.slashErrorText}>PC のターミナルで /model を使ってください。このまま送ると、Codex への発言として届きます。</Text>
					</View>
					<View style={styles.bannerActions}>
						<Button label="文章として送る" variant="ghost" size="sm" onPress={() => { haptic('move'); setLocalCard(undefined); bypassInterceptRef.current = true; submitRef.current(); }} />
						<Button label="消す" variant="ghost" size="sm" onPress={() => { haptic('move'); setLocalCard(undefined); clearActiveInput(); }} />
					</View>
				</View>
			) : null}
			{panelOpen ? (
				<View style={styles.answerBanner} accessibilityLiveRegion="polite">
					<Icon icon={Monitor} size={answerIconSize} color={colors.yellow} />
					<View style={textStyles.answerBody}>
						<Text style={textStyles.answerPrompt}>PC で画面が開いています。閉じるまで送れません</Text>
						<Text style={textStyles.answerLabel} numberOfLines={1}>{agentPanelLabel(panel?.command) ?? '画面'}</Text>
					</View>
					{onClosePanel !== undefined ? <Button label="閉じる" variant="ghost" size="sm" loading={closingPanel} onPress={closePanel} /> : null}
				</View>
			) : null}
			{slashError !== undefined && answerTarget === undefined ? (
				<View style={styles.answerBanner} accessibilityLiveRegion="polite">
					<Icon icon={CircleAlert} size={answerIconSize} color={colors.red} />
					<View style={textStyles.answerBody}>
						<Text style={textStyles.slashErrorText}>{slashError.message}</Text>
					</View>
					{slashError.terminal && onOpenTerminal !== undefined ? (
						<Button label="端末を開く" variant="ghost" size="sm" onPress={() => { haptic('move'); setSlashError(undefined); onOpenTerminal(); }} />
					) : null}
					{slashError.sheet === true ? (
						<Button label="シートで選ぶ" variant="ghost" size="sm" onPress={() => { haptic('move'); setSlashError(undefined); if (modelPillRef.current?.open('model') === true) { clearActiveInput(); } }} />
					) : null}
					<Button label="閉じる" variant="ghost" size="sm" onPress={() => { haptic('move'); setSlashError(undefined); }} />
				</View>
			) : null}
			{answerTarget !== undefined ? (
				<View style={styles.answerBanner} accessibilityLiveRegion="polite">
					<Icon icon={CornerDownRight} size={answerIconSize} color={colors.textDim} />
					<View style={textStyles.answerBody}>
						<Text style={textStyles.answerLabel}>{answerRefreshing ? '最新の内容を取得しています。届くまで回答できません' : answerTarget.mode === 'clarify' ? '質問を取り下げて送ります' : answerTarget.mode === 'deny' ? '拒否して、この指示を送ります' : '質問への回答を入力しています（改行は空白として送られます）'}</Text>
						<Text style={textStyles.answerPrompt} numberOfLines={1}>{answerTarget.prompt}</Text>
					</View>
					<Button label="やめる" variant="ghost" size="sm" onPress={() => { haptic('move'); onCancelAnswer(); }} />
				</View>
			) : null}
			<View style={styles.bar}>
				{attachments.length > 0 ? (
					<View style={styles.attachments}>
						<ComposerAttachmentChips items={attachments} onRemove={removeAttachment} onRetry={retryAttachment} />
						{attachmentState.kind !== 'ok' ? (
							<Text style={[textStyles.attachmentNote, attachmentState.kind === 'failed' ? styles.attachmentNoteFailed : undefined]} accessibilityLiveRegion="polite">
								{attachmentState.kind === 'uploading'
									? `画像をアップロードしています（残り ${attachmentState.uploading} 枚）。終わるまで送信できません`
									: `${attachmentState.failed} 枚をアップロードできませんでした。札を押すと再試行します`}
							</Text>
						) : null}
					</View>
				) : null}
				<ComposerInput
					key={draftKey}
					ref={nativeInputRef}
					defaultValue={defaultValueRef.current}
					onChangeText={updateInput}
					placeholder={panelOpen ? 'PC の画面を閉じると送れます' : answerTarget === undefined ? 'メッセージ、/コマンド' : answerTarget.mode === 'clarify' ? '伝えたいこと' : answerTarget.mode === 'deny' ? '代わりにどうしてほしいか' : '回答を入力（送信で回答します）'}
					maxLength={answerTarget?.maxLength !== undefined && attachmentState.kind !== 'uploading' ? attachmentTextBudget(answerTarget.maxLength, attachmentState.paths) : answerTarget?.maxLength}
				/>
				<View style={styles.actions}>
					<Pressable
						onPress={() => { void attachImage(); }}
						hitSlop={ROUND_SLOP}
						style={({ pressed }) => [styles.round, pressed ? styles.pressed : undefined]}
						accessibilityRole="button"
						accessibilityState={{ busy: attachmentState.kind === 'uploading' }}
						accessibilityLabel="画像を添付"
					>
						<Icon icon={ImagePlus} size={20} color={colors.textDim} />
					</Pressable>
					<ModelPill
						ref={modelPillRef}
						key={`${terminalKey ?? 'none'}:${sessionEpoch ?? 'none'}:${agent ?? 'none'}`}
						agent={agent}
						model={model}
						effort={effort}
						modelControl={modelControl}
						readOnly={modelLocked === true}
						onClaudeSetting={updateClaudeSetting}
						onRequestCodexCatalog={() => { if (terminalKey !== undefined) { requestAgentModelCatalog(terminalKey); } }}
						onUpdateCodexSettings={(nextModel, nextEffort) => { if (terminalKey !== undefined) { updateAgentSettings(terminalKey, nextModel, nextEffort); } }}
					/>
					<BackgroundPill key={`${terminalKey ?? 'none'}:${sessionEpoch ?? 'none'}`} terminalKey={terminalKey} monitors={monitors} shells={shells} shellsAccess={shellsAccess} />
					<View style={styles.spacer} />
					<Pressable
						onPress={() => { haptic('commit'); submit(); }}
						disabled={sendDisabled}
						hitSlop={ROUND_SLOP}
						style={({ pressed }) => [styles.round, styles.send, !sendDisabled ? { backgroundColor: theme.bubble } : undefined, pressed ? styles.pressed : undefined]}
						accessibilityRole="button"
						accessibilityState={{ disabled: sendDisabled }}
						accessibilityLabel={answering ? '回答を送信' : '送信'}
					>
						<Icon icon={ArrowUp} size={20} color={sendDisabled ? colors.textMuted : theme.onBubble} strokeWidth={2.6} />
					</Pressable>
				</View>
			</View>
		</View>
	);
}));

/**
 * 入力欄。モデルの一覧・会話の本文など入力以外の更新から、変換中の日本語入力を切り離す
 * （値は持たず、下書きの対象が替わったときだけ `key` で作り直す）。Enter は改行で、送信はボタンだけ。
 */
const ComposerInput = memo(forwardRef<TextInput, {
	defaultValue: string;
	onChangeText: (text: string) => void;
	placeholder: string;
	/** 入力の上限（回答の入力のうち、上限のあるもの。拒否に添える指示など）。 */
	maxLength?: number | undefined;
}>(function ComposerInput({ defaultValue, onChangeText, placeholder, maxLength }, ref) {
	// 文字サイズの設定が変わったときは、memo を越えて Context から描き直される（値は持たないので入力は消えない）。
	const inputStyle = useChatStyles(styles).input;
	return (
		<TextInput
			ref={ref}
			style={inputStyle}
			defaultValue={defaultValue}
			onChangeText={onChangeText}
			placeholder={placeholder}
			placeholderTextColor={colors.textMuted}
			maxLength={maxLength}
			autoCapitalize="none"
			autoCorrect={false}
			multiline
			blurOnSubmit={false}
			accessibilityLabel="メッセージ"
		/>
	);
}));

const styles = StyleSheet.create({
	root: {
		flexShrink: 1,
		paddingHorizontal: space.md,
		paddingTop: space.sm,
		paddingBottom: space.xs,
	},
	bar: {
		gap: space.xs,
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
		borderRadius: radius.composer,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.panel,
	},
	input: {
		minHeight: 40,
		maxHeight: 140,
		paddingHorizontal: space.md,
		paddingTop: space.sm,
		paddingBottom: space.sm,
		borderRadius: radius.input,
		backgroundColor: colors.raised,
		fontSize: type.input,
		lineHeight: 21,
		color: colors.text,
	},
	actions: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: ROUND,
	},
	spacer: {
		flex: 1,
	},
	round: {
		width: ROUND,
		height: ROUND,
		borderRadius: radius.pill,
		alignItems: 'center',
		justifyContent: 'center',
	},
	send: {
		backgroundColor: colors.raised,
	},
	pressed: {
		opacity: 0.7,
	},
	answerBanner: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		marginBottom: space.sm,
		paddingLeft: space.md,
		borderRadius: radius.card,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.panel,
	},
	answerBody: {
		flex: 1,
		minWidth: 0,
		paddingVertical: space.sm,
	},
	bannerActions: {
		alignItems: 'flex-end',
	},
	answerLabel: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	attachments: {
		gap: space.xs,
	},
	attachmentNote: {
		fontSize: type.caption,
		lineHeight: 15,
		color: colors.textMuted,
	},
	attachmentNoteFailed: {
		color: colors.red,
	},
	slashErrorText: {
		fontSize: type.meta,
		lineHeight: 18,
		color: colors.text,
	},
	answerPrompt: {
		marginTop: 2,
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.text,
	},
});

/** 入力欄の上に理由を出す断り（ダイアログは出さない）。PC の action-result の code。 */
const INLINE_REJECTION_CODES: ReadonlySet<string> = new Set([AGENT_SLASH_COMMAND_REJECTED_CODE, AGENT_PANEL_OPEN_CODE, AGENT_COMPOSER_NOT_EMPTY_CODE]);

/** 添付の一覧の鍵（入力欄ごと。質問への回答の入力は別）。 */
function attachmentKeyOf(draftKey: string | undefined, answering: boolean): string {
	return `${draftKey ?? 'none'}${answering ? '\0answer' : ''}`;
}

/** 入力欄ごとのアップロードの列（選んだ順に 1 枚ずつ上げる）。 */
const uploadQueues = new Map<string, Promise<void>>();

function enqueueAttachmentUpload(key: string, run: () => Promise<void>): void {
	const previous = uploadQueues.get(key) ?? Promise.resolve();
	const next: Promise<void> = previous.then(run, run).finally(() => {
		if (uploadQueues.get(key) === next) {
			uploadQueues.delete(key);
		}
	});
	uploadQueues.set(key, next);
}
