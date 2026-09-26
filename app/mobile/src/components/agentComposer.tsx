// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../appState.js';
import type { AgentCommandCatalogState, AgentCommandOption, AgentMessageSendResult, AgentModelControlState, FsUploadResult, WorkspacePrStatus } from '../store.js';
import { GlassComposer } from './glassComposer.js';
import { ModelPill } from './modelPill.js';
import { PrPill } from './prPill.js';
import { HIT_SIZE, colors, radius, space, squircle, type } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';
import { appendQuickReply } from '../agentConversationUx.js';
import { Button } from './button.js';
import type { QuestionFreeTextRequest } from './questionCard.js';
import { appendUploadedPath, flattenAnswerInput, reconcileSubmittedDraftTarget, shouldShowSubmissionAlert } from './agentComposerDraft.js';
import { agentSlashQuery, filterAgentSlashCommands, normalizeAgentSlashSubmission, selectedAgentSlashCommandText } from './agentSlashCommands.js';
import { AgentSlashCommandMenu } from './agentSlashCommandMenu.js';

export interface AgentComposerHandle {
	/** クイック返信などの文字を入力欄へ入れる（書きかけがあれば後ろへ足す。送信はしない）。 */
	insertText(text: string): void;
	focus(): void;
}

interface AgentComposerProps {
	/** 下書きの退避キー（ターミナル単位。切替時のみ変わる）。 */
	draftKey: string | undefined;
	activeTerminalKey: string | undefined;
	sessionEpoch: string | undefined;
	/** 'claude' | 'codex'（セッション未特定時は undefined）。 */
	agent: string | undefined;
	model: string | undefined;
	effort: string | undefined;
	modelControl: AgentModelControlState | undefined;
	commandCatalog: AgentCommandCatalogState | undefined;
	/** 所属ワークスペースの現在ブランチに紐づくPR（無ければピル非表示）。 */
	pr: WorkspacePrStatus | undefined;
	sendText: (text: string) => Promise<AgentMessageSendResult>;
	updateClaudeSetting: (setting: 'model' | 'effort', value: string) => Promise<AgentMessageSendResult>;
	/** 送信直後に呼ぶ（最下部への追従スクロール）。 */
	onAfterSubmit: () => void;
	fsUpload: (name: string, dataBase64: string) => Promise<FsUploadResult>;
	requestAgentModelCatalog: (terminalKey: string) => void;
	requestAgentCommandCatalog: (terminalKey: string) => void;
	updateAgentSettings: (terminalKey: string, model: string, effort: string) => void;
	/** 質問への回答入力に切り替えているときの依頼（無ければ通常のメッセージ入力）。 */
	answerTarget?: QuestionFreeTextRequest;
	/** 回答入力をやめて通常のメッセージ入力へ戻す。 */
	onCancelAnswer?: () => void;
	/** 回答先の質問カードが最新の内容を取り直している最中（届くまで回答を送れない）。 */
	answerRefreshing?: boolean;
}

/**
 * エージェント詳細画面の入力欄（コンポーザー）を、チャット本文の再レンダリングから
 * 隔離するための子コンポーネント。入力中の文字列はuncontrolledのネイティブTextInputに
 * 保持し、下書きストアへはonChangeTextから一方向に退避する。エージェント応答の
 * ストリーミング（agentChats のdeltaごとの更新）も入力欄へ文字列を書き戻さない。
 *
 * これが独立コンポーネントである理由: 制御コンポーネントのTextInputは、日本語IMEの
 * 変換中（マークドテキスト保持中）にvalueが再適用されると、変換途中の文字列を確定・分解
 * してしまう。React.memoで親の更新も隔離しつつ、入力自体をuncontrolledにすることで、
 * コンポーザー内部の送信状態更新でもIMEの保持領域には触れない。
 * tools（添付ボタン＋ModelPill＋PrPill）も親から要素で受け取らず、このコンポーネント内部で組み立てる
 * （毎レンダリングで新しい要素参照になる props を作らないため）。
 *
 * 質問カードで「その他（入力して回答）」を選ぶと `answerTarget` が渡り、入力欄はその質問への
 * 回答入力に切り替わる（送信でメッセージではなく回答として送る）。カード内に別の入力欄を
 * 持たせると、下のコンポーザーと入力欄が二重になって、どちらに打てばよいか迷うため。
 *
 * 回答入力のあいだは、書きかけのメッセージ（ターミナル単位の下書き）を入力欄から外して空にする。
 * 下書きはストアに残したまま触らず、回答の文字もストアへは書かない。回答を送れた・「やめる」で
 * 取り消した・質問が替わったときに、ストアの下書きを入力欄へ戻す。下書きを残したまま回答へ
 * 切り替えると、書きかけの本文が回答に混ざって送られていた。
 */
export const AgentComposer = memo(forwardRef<AgentComposerHandle, AgentComposerProps>(function AgentComposer({
	draftKey, activeTerminalKey, sessionEpoch, agent, model, effort, modelControl, commandCatalog, pr,
	sendText, updateClaudeSetting, onAfterSubmit, fsUpload, requestAgentModelCatalog, requestAgentCommandCatalog, updateAgentSettings,
	answerTarget, onCancelAnswer, answerRefreshing,
}, ref) {
	const loadDraft = (key: string | undefined): string => key !== undefined ? useAppStore.getState().agentDrafts[key] ?? '' : '';
	const nativeInputRef = useRef<TextInput>(null);
	const inputRef = useRef(loadDraft(draftKey));
	// defaultValueは入力中に変えない。変化させるとuncontrolledでもネイティブIMEへ
	// propsが再適用される可能性があるため、下書き対象の切替時だけ更新する。
	const defaultValueRef = useRef(inputRef.current);
	const submissionGenerationRef = useRef(0);
	const draftKeyRef = useRef(draftKey);
	const [inputMeta, setInputMeta] = useState(() => ({ key: draftKey, sendable: inputRef.current.trim().length > 0 }));
	const [slashQuery, setSlashQuery] = useState<string | undefined>(() => agentSlashQuery(inputRef.current));
	const [submitting, setSubmitting] = useState(false);
	const answering = answerTarget !== undefined;
	// 回答入力中か。入力の書き込み（updateInput 等）は ref で判定する（切替直後の入力でも下書きを汚さない）。
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
		if (slashQuery !== undefined && commandCatalog === undefined && activeTerminalKey !== undefined && agent !== undefined) {
			requestAgentCommandCatalog(activeTerminalKey);
		}
	}, [activeTerminalKey, agent, commandCatalog, requestAgentCommandCatalog, slashQuery]);
	const updateInput = useCallback((input: string) => {
		// 回答はPCで1行に平坦化されて送られる（agentQuestionKeys.ts）。改行を打った時点で空白に
		// 置き換えて、送られる形のまま見せる。改行を含まない入力（IMEの変換中を含む）には触れない。
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
		setInputMeta(current => current.key === draftKey && current.sendable === nextSendable
			? current
			: { key: draftKey, sendable: nextSendable });
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
	// 回答入力への出入りで入力欄を差し替える。入るときは空にし（下書きはストアに残る）、
	// 出るときはストアの下書きを戻す。ストアは書き換えないので、回答の文字は下書きに残らない。
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
		if (text.trim().length === 0) {
			return;
		}
		if (answerTarget !== undefined && answerRefreshing === true) {
			return;
		}
		const submittedDraftKey = draftKey;
		const generation = ++submissionGenerationRef.current;
		setSubmitting(true);
		if (answerTarget !== undefined) {
			// 質問への回答として送る。送り方（キー列の組み立て）と失敗表示は質問カード側が持つ
			// （カード内の自由入力欄から送っていたときと同じく、本文は前後の空白を落として渡す）。
			// 受け付けられたら親が回答入力を閉じ、下書きが入力欄へ戻る。
			// 拒否されたら本文を入力欄へ戻す（エラーの理由はカードに出る）。回答入力を抜けたあとなら戻さない
			// （戻すと回答の文字が下書きへ混ざる）。
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
		// 送信本文を先に入力欄から退避し、待機中に次のメッセージを入力できるようにする。
		// reject時だけ最新入力の前へ戻すため、最初の本文が再送されることはない。
		clearActiveInput();
		const submittedText = normalizeAgentSlashSubmission(text, agent, commandCatalog?.commands ?? []);
		sendText(submittedText).catch((): AgentMessageSendResult => ({ status: 'rejected', message: '送信処理中にエラーが発生しました' })).then(result => {
			const storedDraft = submittedDraftKey !== undefined ? useAppStore.getState().agentDrafts[submittedDraftKey] ?? '' : '';
			// 待っている間に回答入力へ切り替わっていたら、入力欄（回答の文字）ではなくストアの下書きへ戻す。
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
				Alert.alert('メッセージは未送信です', result.message ?? '本文はターミナルの入力欄に残っています。ターミナルを確認して送信してください。');
			}
			if (result.status === 'rejected' && shouldShowSubmissionAlert(result.status, submissionGenerationRef.current, generation)) {
				Alert.alert('メッセージを送信できませんでした', result.message ?? '接続とエージェントセッションを確認して再送してください。');
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

	// 回答入力のあいだはスラッシュコマンドの候補を出さない（回答の本文として送るため）。
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
		if (activeTerminalKey !== undefined) {
			requestAgentCommandCatalog(activeTerminalKey);
		}
	}, [activeTerminalKey, requestAgentCommandCatalog]);

	/**
	 * 画像添付（+ボタン）。フォトライブラリから選び、PCへアップロードして保存先の
	 * フルパスを入力欄へ挿入する（エージェントCLIはプロンプト内のパスから画像を読める）。
	 */
	const [uploading, setUploading] = useState(false);
	const attachImage = useCallback(async () => {
		if (uploading) {
			return;
		}
		const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.8 });
		const asset = result.assets?.[0];
		if (result.canceled || !asset?.base64) {
			return;
		}
		setUploading(true);
		const uploadDraftKey = draftKey;
		const uploadForAnswer = answeringRef.current;
		try {
			const name = asset.fileName ?? 'photo.jpg';
			const { path } = await fsUpload(name, asset.base64);
			const sameInput = draftKeyRef.current === uploadDraftKey && answeringRef.current === uploadForAnswer;
			if (uploadForAnswer) {
				// 回答入力中に添付したものは回答へ足す。回答入力を抜けていたら捨てる（下書きへ混ぜない）。
				if (sameInput) {
					replaceActiveInput(appendUploadedPath(inputRef.current, path));
				}
				return;
			}
			// アップロードのawait中に入力が変わっている可能性があるため、最新の下書きを
			// ストアから読んでパスを追記する（stale closure回避）。
			const prev = uploadDraftKey !== undefined ? useAppStore.getState().agentDrafts[uploadDraftKey] ?? '' : inputRef.current;
			const next = appendUploadedPath(prev, path);
			if (sameInput) {
				replaceActiveInput(next);
			} else if (uploadDraftKey !== undefined) {
				// 別のターミナルへ移った、または回答入力に切り替わった: 入力欄ではなく下書きへ足す。
				useAppStore.getState().setAgentDraft(uploadDraftKey, next);
			}
		} catch (err) {
			console.warn('[agent] image upload failed', err);
		} finally {
			setUploading(false);
		}
	}, [uploading, fsUpload, draftKey, replaceActiveInput]);

	return (
		<View style={styles.root}>
			{showSlashMenu ? (
				<AgentSlashCommandMenu catalog={commandCatalog} commands={visibleCommands} agent={agent} onSelect={selectSlashCommand} onRetry={retryCommandCatalog} />
			) : null}
			{answerTarget !== undefined ? (
				<View style={styles.answerBanner} accessibilityLiveRegion="polite">
					<Ionicons name="return-down-forward-outline" size={14} color={colors.textDim} />
					<View style={styles.answerBannerBody}>
						<Text style={styles.answerBannerLabel}>
							{answerRefreshing === true ? '最新の内容を取得しています。届くまで回答できません' : '質問への回答を入力しています'}
						</Text>
						<Text style={styles.answerBannerPrompt} numberOfLines={1}>{answerTarget.prompt}</Text>
						<Text style={styles.answerBannerLabel}>改行は空白として送られます（1行の回答になります）</Text>
					</View>
					<Button label="やめる" variant="ghost" size="sm" onPress={() => { hapticSelection(); onCancelAnswer?.(); }} />
				</View>
			) : null}
			<GlassComposer
				defaultValue={defaultValueRef.current}
				inputKey={draftKey}
				inputRef={nativeInputRef}
				onChangeText={updateInput}
				onSubmit={submit}
				placeholder={answerTarget !== undefined ? '回答を入力（送信で回答します）' : 'エージェントへメッセージ…'}
				sendDisabled={submitting || !sendable || codexSlashCatalogPending || (answering && answerRefreshing === true)}
				tools={
					<>
						<Pressable style={styles.attachBtn} onPress={() => { hapticImpact('light'); void attachImage(); }} disabled={uploading} accessibilityRole="button" accessibilityState={{ disabled: uploading }} accessibilityLabel="画像を添付">
							<Ionicons name={uploading ? 'hourglass-outline' : 'add'} size={20} color={colors.text} />
						</Pressable>
						<ModelPill
							key={`${activeTerminalKey ?? 'none'}:${sessionEpoch ?? 'none'}:${agent ?? 'none'}`}
							agent={agent}
							model={model}
							effort={effort}
							modelControl={modelControl}
							onClaudeSetting={updateClaudeSetting}
							onRequestCodexCatalog={() => { if (activeTerminalKey !== undefined) { requestAgentModelCatalog(activeTerminalKey); } }}
							onUpdateCodexSettings={(nextModel, nextEffort) => { if (activeTerminalKey !== undefined) { updateAgentSettings(activeTerminalKey, nextModel, nextEffort); } }}
						/>
						{pr !== undefined ? <PrPill pr={pr} /> : null}
					</>
				}
			/>
		</View>
	);
}));

const styles = StyleSheet.create({
	// flexShrink: 画面の空きが足りないとき、GlassComposer本体ではなくスラッシュメニュー側
	// （agentSlashCommandMenu の flexShrink: 1）が縮んで収まるように、rootまで縮小を伝播させる
	root: { width: '100%', flexShrink: 1 },
	attachBtn: { width: HIT_SIZE, height: HIT_SIZE, borderRadius: radius.pill, ...squircle, backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
	answerBanner: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: space.md, marginBottom: space.sm, borderRadius: radius.card, ...squircle, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong },
	answerBannerBody: { flex: 1, minWidth: 0 },
	answerBannerLabel: { color: colors.textDim, fontSize: type.caption },
	answerBannerPrompt: { color: colors.text, fontSize: type.meta, fontWeight: '600' },
});
