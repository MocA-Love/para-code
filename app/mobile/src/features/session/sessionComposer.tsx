// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ArrowUp, CornerDownRight, ImagePlus } from 'lucide-react-native';
import { appendQuickReply } from '../../agentConversationUx.js';
import { useAppStore } from '../../appState.js';
import { appendUploadedPath, flattenAnswerInput, reconcileSubmittedDraftTarget, shouldShowSubmissionAlert } from '../../components/agentComposerDraft.js';
import { agentSlashQuery, filterAgentSlashCommands, normalizeAgentSlashSubmission, selectedAgentSlashCommandText } from '../../components/agentSlashCommands.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import type { QuestionFreeTextRequest } from '../../components/questionCard.js';
import { hapticImpact, hapticSelection } from '../../haptics.js';
import type { AgentMonitor } from '../../agentMonitors.js';
import type { AgentCommandCatalogState, AgentCommandOption, AgentMessageSendResult, AgentModelControlState, FsUploadResult } from '../../store.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { Button, Icon, iconSize, useThemeColors } from '../../ui/index.js';
import { errorKind } from './errorKind.js';
import { ModelPill } from './modelDrawer.js';
import { MonitorPill } from './monitorDrawer.js';
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
	commandCatalog: AgentCommandCatalogState | undefined;
	/** Claude Code の Monitor の一覧（古い PC では undefined。そのときピルは出ない）。 */
	monitors: readonly AgentMonitor[] | undefined;
	sendText: (text: string) => Promise<AgentMessageSendResult>;
	updateClaudeSetting: (setting: 'model' | 'effort', value: string) => Promise<AgentMessageSendResult>;
	onAfterSubmit: () => void;
	fsUpload: (name: string, dataBase64: string) => Promise<FsUploadResult>;
	requestAgentModelCatalog: (terminalKey: string) => void;
	requestAgentCommandCatalog: (terminalKey: string) => void;
	updateAgentSettings: (terminalKey: string, model: string, effort: string) => void;
	/** 質問への回答入力に切り替えているときの依頼（無ければ通常のメッセージ入力）。 */
	answerTarget?: QuestionFreeTextRequest;
	onCancelAnswer: () => void;
	answerRefreshing: boolean;
}

/**
 * 会話表示の入力欄（Orca の MobileNativeChatComposer。モックの `.composer`）。
 * 上段に入力、下段に 画像の添付・モデルと effort のピル・Monitor のピル（あるときだけ）・送信の白い円。
 *
 * 入力と送信の決まりは旧部品（`components/agentComposer.tsx`）をそのまま移している:
 *  - 入力中の文字はネイティブの TextInput が持ち（uncontrolled）、下書きはストアへ一方向に退避する。
 *    日本語の変換中に値を書き戻すと、変換途中の文字が確定・分解されるため
 *  - 送った本文は先に入力欄から外し、PC に拒否されたら入力欄へ戻す（`agentComposerDraft.ts`）
 *  - 質問カードの「その他」を押すと回答入力に切り替わる。書きかけの下書きは入力欄から外し、
 *    回答を送れた・やめた・質問が替わったら戻す（回答に下書きが混ざらないように）
 *  - `/` で始めるとスラッシュコマンドの候補を出す
 *  - 画像は PC へ上げて、保存先のパスを入力欄へ入れる
 */
export const SessionComposer = memo(forwardRef<SessionComposerHandle, SessionComposerProps>(function SessionComposer({
	draftKey, terminalKey, sessionEpoch, agent, model, effort, modelControl, commandCatalog, monitors,
	sendText, updateClaudeSetting, onAfterSubmit, fsUpload, requestAgentModelCatalog, requestAgentCommandCatalog, updateAgentSettings,
	answerTarget, onCancelAnswer, answerRefreshing,
}, ref) {
	const loadDraft = (key: string | undefined): string => key !== undefined ? useAppStore.getState().agentDrafts[key] ?? '' : '';
	const nativeInputRef = useRef<TextInput>(null);
	const theme = useThemeColors();
	const inputRef = useRef(loadDraft(draftKey));
	const defaultValueRef = useRef(inputRef.current);
	const submissionGenerationRef = useRef(0);
	const draftKeyRef = useRef(draftKey);
	const [inputMeta, setInputMeta] = useState(() => ({ key: draftKey, sendable: inputRef.current.trim().length > 0 }));
	const [slashQuery, setSlashQuery] = useState<string | undefined>(() => agentSlashQuery(inputRef.current));
	const [submitting, setSubmitting] = useState(false);
	const answering = answerTarget !== undefined;
	const answeringRef = useRef(answering);
	answeringRef.current = answering;
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
	}, [draftKey]);
	useEffect(() => {
		if (slashQuery !== undefined && commandCatalog === undefined && terminalKey !== undefined && agent !== undefined) {
			requestAgentCommandCatalog(terminalKey);
		}
	}, [terminalKey, agent, commandCatalog, requestAgentCommandCatalog, slashQuery]);

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
		setInputMeta({ key: draftKeyRef.current, sendable: text.trim().length > 0 });
	}, []);
	const clearActiveInput = useCallback(() => {
		inputRef.current = '';
		if (draftKeyRef.current !== undefined && !answeringRef.current) {
			useAppStore.getState().clearAgentDraft(draftKeyRef.current);
		}
		nativeInputRef.current?.clear();
		setSlashQuery(undefined);
		setInputMeta({ key: draftKeyRef.current, sendable: false });
	}, []);
	// 回答入力への出入りで入力欄を差し替える（入るときは空に、出るときはストアの下書きを戻す）。
	const previousAnsweringRef = useRef(answering);
	useEffect(() => {
		if (previousAnsweringRef.current === answering) {
			return;
		}
		previousAnsweringRef.current = answering;
		const text = answering ? '' : loadDraft(draftKeyRef.current);
		inputRef.current = text;
		nativeInputRef.current?.setNativeProps({ text });
		setSlashQuery(answering ? undefined : agentSlashQuery(text));
		setInputMeta({ key: draftKeyRef.current, sendable: text.trim().length > 0 });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- loadDraft はストアを読むだけの関数
	}, [answering]);

	const submit = useCallback(() => {
		if (submitting) {
			return;
		}
		const text = inputRef.current;
		if (text.trim().length === 0 || (answerTarget !== undefined && answerRefreshing)) {
			return;
		}
		const submittedDraftKey = draftKey;
		const generation = ++submissionGenerationRef.current;
		setSubmitting(true);
		if (answerTarget !== undefined) {
			// 質問への回答として送る（送り方と失敗の表示は質問カードが持つ）。拒否されたら本文を戻す。
			clearActiveInput();
			answerTarget.submit(text.trim())
				.catch((): AgentMessageSendResult => ({ status: 'rejected', message: '回答を送信できませんでした' }))
				.then(result => {
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
		const submittedText = normalizeAgentSlashSubmission(text, agent, commandCatalog?.commands ?? []);
		sendText(submittedText).catch((): AgentMessageSendResult => ({ status: 'rejected', message: '送信処理中にエラーが発生しました' })).then(result => {
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
				Alert.alert('メッセージは未送信です', result.message ?? '本文はターミナルの入力欄に残っています。ターミナル表示で確認して送信してください。');
			}
			if (result.status === 'rejected' && shouldShowSubmissionAlert(result.status, submissionGenerationRef.current, generation)) {
				Alert.alert('メッセージを送信できませんでした', result.message ?? '接続とエージェントのセッションを確認して再送してください。');
			}
		}).finally(() => {
			if (submissionGenerationRef.current === generation) {
				setSubmitting(false);
			}
		});
	}, [submitting, draftKey, clearActiveInput, replaceActiveInput, sendText, onAfterSubmit, agent, commandCatalog?.commands, answerTarget, answerRefreshing]);

	useImperativeHandle(ref, () => ({
		insertText: (text: string) => replaceActiveInput(appendQuickReply(inputRef.current, text)),
		focus: () => nativeInputRef.current?.focus(),
	}), [replaceActiveInput]);

	const showSlashMenu = slashQuery !== undefined && answerTarget === undefined;
	const visibleCommands = slashQuery !== undefined && commandCatalog?.status === 'ready'
		? filterAgentSlashCommands(commandCatalog.commands, slashQuery)
		: [];
	const codexSlashCatalogPending = answerTarget === undefined && agent === 'codex' && /^\/\S/.test(inputRef.current)
		&& (commandCatalog === undefined || commandCatalog.status === 'loading');
	const selectSlashCommand = useCallback((command: AgentCommandOption) => {
		replaceActiveInput(selectedAgentSlashCommandText(command));
		setSlashQuery(undefined);
		nativeInputRef.current?.focus();
	}, [replaceActiveInput]);
	const retryCommandCatalog = useCallback(() => {
		if (terminalKey !== undefined) {
			requestAgentCommandCatalog(terminalKey);
		}
	}, [terminalKey, requestAgentCommandCatalog]);

	// 画像の添付: フォトライブラリから選び、PC へ上げて保存先のパスを入力欄へ入れる。
	const [uploading, setUploading] = useState(false);
	const attachImage = useCallback(async () => {
		if (uploading) {
			return;
		}
		const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.8 });
		const asset = result.assets?.[0];
		if (result.canceled || asset?.base64 === undefined || asset.base64 === null) {
			return;
		}
		setUploading(true);
		const uploadDraftKey = draftKey;
		const uploadForAnswer = answeringRef.current;
		try {
			const { path } = await fsUpload(asset.fileName ?? 'photo.jpg', asset.base64);
			const sameInput = draftKeyRef.current === uploadDraftKey && answeringRef.current === uploadForAnswer;
			if (uploadForAnswer) {
				if (sameInput) {
					replaceActiveInput(appendUploadedPath(inputRef.current, path));
				}
				return;
			}
			const previous = uploadDraftKey !== undefined ? useAppStore.getState().agentDrafts[uploadDraftKey] ?? '' : inputRef.current;
			const next = appendUploadedPath(previous, path);
			if (sameInput) {
				replaceActiveInput(next);
			} else if (uploadDraftKey !== undefined) {
				useAppStore.getState().setAgentDraft(uploadDraftKey, next);
			}
		} catch (err) {
			console.warn('[session] image upload failed', errorKind(err));
			Alert.alert('画像を送れませんでした', 'PC との接続を確認して、もう一度お試しください。');
		} finally {
			setUploading(false);
		}
	}, [uploading, fsUpload, draftKey, replaceActiveInput]);

	const sendDisabled = submitting || !sendable || codexSlashCatalogPending || (answering && answerRefreshing);
	// 外付けキーボードの ⌘↩（iPad）。送信ボタンと同じ条件で送る。
	const focused = useIsFocused();
	useShortcutSlot('send', focused ? { send: () => { if (!sendDisabled) { hapticImpact('medium'); submit(); } } } : undefined);
	return (
		<View style={styles.root}>
			{showSlashMenu ? (
				<SlashCommandList catalog={commandCatalog} commands={visibleCommands} onSelect={selectSlashCommand} onRetry={retryCommandCatalog} />
			) : null}
			{answerTarget !== undefined ? (
				<View style={styles.answerBanner} accessibilityLiveRegion="polite">
					<Icon icon={CornerDownRight} size={iconSize.sm} color={colors.textDim} />
					<View style={styles.answerBody}>
						<Text style={styles.answerLabel}>{answerRefreshing ? '最新の内容を取得しています。届くまで回答できません' : '質問への回答を入力しています（改行は空白として送られます）'}</Text>
						<Text style={styles.answerPrompt} numberOfLines={1}>{answerTarget.prompt}</Text>
					</View>
					<Button label="やめる" variant="ghost" size="sm" onPress={() => { hapticSelection(); onCancelAnswer(); }} />
				</View>
			) : null}
			<View style={styles.bar}>
				<ComposerInput
					key={draftKey}
					ref={nativeInputRef}
					defaultValue={defaultValueRef.current}
					onChangeText={updateInput}
					placeholder={answerTarget !== undefined ? '回答を入力（送信で回答します）' : 'メッセージ、/コマンド'}
				/>
				<View style={styles.actions}>
					<Pressable
						onPress={() => { hapticImpact('light'); void attachImage(); }}
						disabled={uploading}
						hitSlop={ROUND_SLOP}
						style={({ pressed }) => [styles.round, pressed ? styles.pressed : undefined]}
						accessibilityRole="button"
						accessibilityState={{ disabled: uploading, busy: uploading }}
						accessibilityLabel="画像を添付"
					>
						{uploading ? <ActivityIndicator size="small" color={colors.textDim} /> : <Icon icon={ImagePlus} size={20} color={colors.textDim} />}
					</Pressable>
					<ModelPill
						key={`${terminalKey ?? 'none'}:${sessionEpoch ?? 'none'}:${agent ?? 'none'}`}
						agent={agent}
						model={model}
						effort={effort}
						modelControl={modelControl}
						onClaudeSetting={updateClaudeSetting}
						onRequestCodexCatalog={() => { if (terminalKey !== undefined) { requestAgentModelCatalog(terminalKey); } }}
						onUpdateCodexSettings={(nextModel, nextEffort) => { if (terminalKey !== undefined) { updateAgentSettings(terminalKey, nextModel, nextEffort); } }}
					/>
					<MonitorPill key={`${terminalKey ?? 'none'}:${sessionEpoch ?? 'none'}`} monitors={monitors} />
					<View style={styles.spacer} />
					<Pressable
						onPress={() => { hapticImpact('medium'); submit(); }}
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
}>(function ComposerInput({ defaultValue, onChangeText, placeholder }, ref) {
	return (
		<TextInput
			ref={ref}
			style={styles.input}
			defaultValue={defaultValue}
			onChangeText={onChangeText}
			placeholder={placeholder}
			placeholderTextColor={colors.textMuted}
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
	answerLabel: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	answerPrompt: {
		marginTop: 2,
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.text,
	},
});
