// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../appState.js';
import type { AgentCommandCatalogState, AgentCommandOption, AgentMessageSendResult, AgentModelControlState, FsUploadResult, WorkspacePrStatus } from '../store.js';
import { GlassComposer } from './glassComposer.js';
import { ModelPill } from './modelPill.js';
import { PrPill } from './prPill.js';
import { colors } from '../theme.js';
import { hapticImpact } from '../haptics.js';
import { reconcileSubmittedDraftTarget, shouldShowSubmissionAlert } from './agentComposerDraft.js';
import { agentSlashQuery, filterAgentSlashCommands, normalizeAgentSlashSubmission, selectedAgentSlashCommandText } from './agentSlashCommands.js';
import { AgentSlashCommandMenu } from './agentSlashCommandMenu.js';

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
 */
export const AgentComposer = memo(function AgentComposer({
	draftKey, activeTerminalKey, sessionEpoch, agent, model, effort, modelControl, commandCatalog, pr,
	sendText, updateClaudeSetting, onAfterSubmit, fsUpload, requestAgentModelCatalog, requestAgentCommandCatalog, updateAgentSettings,
}: {
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
	updateClaudeSetting: (setting: 'model' | 'effort', value: string) => Promise<boolean>;
	/** 送信直後に呼ぶ（最下部への追従スクロール）。 */
	onAfterSubmit: () => void;
	fsUpload: (name: string, dataBase64: string) => Promise<FsUploadResult>;
	requestAgentModelCatalog: (terminalKey: string) => void;
	requestAgentCommandCatalog: (terminalKey: string) => void;
	updateAgentSettings: (terminalKey: string, model: string, effort: string) => void;
}) {
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
	if (draftKeyRef.current !== draftKey) {
		draftKeyRef.current = draftKey;
		inputRef.current = loadDraft(draftKey);
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
	const updateInput = useCallback((text: string) => {
		inputRef.current = text;
		if (draftKey !== undefined) {
			useAppStore.getState().setAgentDraft(draftKey, text);
		}
		const nextSendable = text.trim().length > 0;
		setSlashQuery(agentSlashQuery(text));
		setInputMeta(current => current.key === draftKey && current.sendable === nextSendable
			? current
			: { key: draftKey, sendable: nextSendable });
	}, [draftKey]);
	const replaceActiveInput = useCallback((text: string) => {
		inputRef.current = text;
		if (draftKeyRef.current !== undefined) {
			useAppStore.getState().setAgentDraft(draftKeyRef.current, text);
		}
		nativeInputRef.current?.setNativeProps({ text });
		setSlashQuery(agentSlashQuery(text));
		setInputMeta({ key: draftKeyRef.current, sendable: text.trim().length > 0 });
	}, []);
	const clearActiveInput = useCallback(() => {
		inputRef.current = '';
		if (draftKeyRef.current !== undefined) {
			useAppStore.getState().clearAgentDraft(draftKeyRef.current);
		}
		nativeInputRef.current?.clear();
		setSlashQuery(undefined);
		setInputMeta({ key: draftKeyRef.current, sendable: false });
	}, []);

	const submit = useCallback(() => {
		if (submitting) {
			return;
		}
		const text = inputRef.current;
		if (text.trim().length === 0) {
			return;
		}
		const submittedDraftKey = draftKey;
		const generation = ++submissionGenerationRef.current;
		setSubmitting(true);
		// 送信本文を先に入力欄から退避し、待機中に次のメッセージを入力できるようにする。
		// reject時だけ最新入力の前へ戻すため、最初の本文が再送されることはない。
		clearActiveInput();
		const submittedText = normalizeAgentSlashSubmission(text, agent, commandCatalog?.commands ?? []);
		sendText(submittedText).catch((): AgentMessageSendResult => ({ status: 'rejected', message: '送信処理中にエラーが発生しました' })).then(result => {
			const reconciliation = reconcileSubmittedDraftTarget(
				draftKeyRef.current, submittedDraftKey, inputRef.current,
				submittedDraftKey !== undefined ? useAppStore.getState().agentDrafts[submittedDraftKey] ?? '' : '',
				text, result.status,
			);
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
	}, [submitting, draftKey, clearActiveInput, replaceActiveInput, sendText, onAfterSubmit, agent, commandCatalog?.commands]);

	const visibleCommands = slashQuery !== undefined && commandCatalog?.status === 'ready'
		? filterAgentSlashCommands(commandCatalog.commands, slashQuery)
		: [];
	const codexSlashCatalogPending = agent === 'codex' && /^\/\S/.test(inputRef.current)
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
		try {
			const name = asset.fileName ?? 'photo.jpg';
			const { path } = await fsUpload(name, asset.base64);
			// アップロードのawait中に入力が変わっている可能性があるため、最新の下書きを
			// ストアから読んでパスを追記する（stale closure回避）。
			const prev = uploadDraftKey !== undefined ? useAppStore.getState().agentDrafts[uploadDraftKey] ?? '' : inputRef.current;
			const next = prev.length > 0 ? prev + ' ' + path + ' ' : path + ' ';
			if (draftKeyRef.current === uploadDraftKey) {
				replaceActiveInput(next);
			} else if (uploadDraftKey !== undefined) {
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
			{slashQuery !== undefined ? (
				<AgentSlashCommandMenu catalog={commandCatalog} commands={visibleCommands} agent={agent} onSelect={selectSlashCommand} onRetry={retryCommandCatalog} />
			) : null}
			<GlassComposer
				defaultValue={defaultValueRef.current}
				inputKey={draftKey}
				inputRef={nativeInputRef}
				onChangeText={updateInput}
				onSubmit={submit}
				placeholder="エージェントへメッセージ…"
				sendDisabled={submitting || !sendable || codexSlashCatalogPending}
				tools={
					<>
						<Pressable style={styles.attachBtn} onPress={() => { hapticImpact('light'); void attachImage(); }} disabled={uploading} accessibilityLabel="画像を添付">
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
});

const styles = StyleSheet.create({
	root: { width: '100%' },
	attachBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
});
