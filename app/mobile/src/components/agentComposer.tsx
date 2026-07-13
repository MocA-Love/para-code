// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../appState.js';
import type { AgentMessageSendResult, AgentModelControlState, FsUploadResult } from '../store.js';
import { GlassComposer } from './glassComposer.js';
import { ModelPill } from './modelPill.js';
import { useComposerDraft } from '../hooks/useComposerDraft.js';
import { colors } from '../theme.js';
import { hapticImpact } from '../haptics.js';
import { reconcileSubmittedDraftTarget, shouldShowSubmissionAlert } from './agentComposerDraft.js';

/**
 * エージェント詳細画面の入力欄（コンポーザー）を、チャット本文の再レンダリングから
 * 隔離するための子コンポーネント。下書き（value）はこのコンポーネント内のローカルstate
 * （useComposerDraft）だけで完結させ、エージェント応答のストリーミング（agentChats の
 * delta ごとの更新）が入力欄の再レンダリングに波及しないようにする。
 *
 * これが独立コンポーネントである理由: 制御コンポーネントの TextInput は、日本語IMEの
 * 変換中（マークドテキスト保持中）に親由来で再レンダリングされると value が再適用され、
 * 変換途中の文字列がキャンセルされてしまう。ストリーミング中に頻発する親の再レンダリングを
 * ここで断ち切るため、React.memo で包み、渡す props は「ストリーミングの delta では参照が
 * 変わらないもの」（プリミティブ、またはストアの安定なアクション参照）だけに限定している。
 * tools（添付ボタン＋ModelPill）も親から要素で受け取らず、このコンポーネント内部で組み立てる
 * （毎レンダリングで新しい要素参照になる props を作らないため）。
 */
export const AgentComposer = memo(function AgentComposer({
	draftKey, activeId, sessionEpoch, agent, model, effort, modelControl,
	sendText, updateClaudeSetting, onAfterSubmit, fsUpload, requestAgentModelCatalog, updateAgentSettings,
}: {
	/** 下書きの退避キー（ターミナル単位。切替時のみ変わる）。 */
	draftKey: string | undefined;
	activeId: number | undefined;
	sessionEpoch: string | undefined;
	/** 'claude' | 'codex'（セッション未特定時は undefined）。 */
	agent: string | undefined;
	model: string | undefined;
	effort: string | undefined;
	modelControl: AgentModelControlState | undefined;
	sendText: (text: string) => Promise<AgentMessageSendResult>;
	updateClaudeSetting: (setting: 'model' | 'effort', value: string) => Promise<boolean>;
	/** 送信直後に呼ぶ（最下部への追従スクロール）。 */
	onAfterSubmit: () => void;
	fsUpload: (name: string, dataBase64: string) => Promise<FsUploadResult>;
	requestAgentModelCatalog: (id: number) => void;
	updateAgentSettings: (id: number, model: string, effort: string) => void;
}) {
	const [input, setInput, clearInput] = useComposerDraft(draftKey);
	const inputRef = useRef(input);
	inputRef.current = input;
	const submissionGenerationRef = useRef(0);
	const draftKeyRef = useRef(draftKey);
	const [submitting, setSubmitting] = useState(false);
	if (draftKeyRef.current !== draftKey) {
		draftKeyRef.current = draftKey;
		inputRef.current = input;
		submissionGenerationRef.current++;
	}
	useEffect(() => {
		setSubmitting(false);
	}, [draftKey]);
	const updateInput = useCallback((text: string) => {
		inputRef.current = text;
		setInput(text);
	}, [setInput]);

	const submit = useCallback(() => {
		if (submitting) {
			return;
		}
		const text = input;
		const submittedDraftKey = draftKey;
		const generation = ++submissionGenerationRef.current;
		setSubmitting(true);
		// 送信本文を先に入力欄から退避し、待機中に次のメッセージを入力できるようにする。
		// reject時だけ最新入力の前へ戻すため、最初の本文が再送されることはない。
		inputRef.current = '';
		clearInput();
		sendText(text).catch((): AgentMessageSendResult => ({ status: 'rejected', message: '送信処理中にエラーが発生しました' })).then(result => {
			const reconciliation = reconcileSubmittedDraftTarget(
				draftKeyRef.current, submittedDraftKey, inputRef.current,
				submittedDraftKey !== undefined ? useAppStore.getState().agentDrafts[submittedDraftKey] ?? '' : '',
				text, result.status,
			);
			if (reconciliation.kind === 'active' && reconciliation.value !== inputRef.current) {
				inputRef.current = reconciliation.value;
				setInput(reconciliation.value);
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
	}, [submitting, input, draftKey, clearInput, sendText, onAfterSubmit]);

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
			const prev = uploadDraftKey !== undefined ? useAppStore.getState().agentDrafts[uploadDraftKey] ?? '' : input;
			const next = prev.length > 0 ? prev + ' ' + path + ' ' : path + ' ';
			if (draftKeyRef.current === uploadDraftKey) {
				updateInput(next);
			} else if (uploadDraftKey !== undefined) {
				useAppStore.getState().setAgentDraft(uploadDraftKey, next);
			}
		} catch (err) {
			console.warn('[agent] image upload failed', err);
		} finally {
			setUploading(false);
		}
	}, [uploading, fsUpload, draftKey, input, updateInput]);

	return (
		<GlassComposer
			value={input}
			onChangeText={updateInput}
			onSubmit={submit}
			placeholder="エージェントへメッセージ…"
			sendDisabled={submitting || input.trim().length === 0}
			tools={
				<>
					<Pressable style={styles.attachBtn} onPress={() => { hapticImpact('light'); void attachImage(); }} disabled={uploading} accessibilityLabel="画像を添付">
						<Ionicons name={uploading ? 'hourglass-outline' : 'add'} size={20} color={colors.text} />
					</Pressable>
					<ModelPill
						key={`${activeId ?? 'none'}:${sessionEpoch ?? 'none'}:${agent ?? 'none'}`}
						agent={agent}
						model={model}
						effort={effort}
						modelControl={modelControl}
						onClaudeSetting={updateClaudeSetting}
						onRequestCodexCatalog={() => { if (activeId !== undefined) { requestAgentModelCatalog(activeId); } }}
						onUpdateCodexSettings={(nextModel, nextEffort) => { if (activeId !== undefined) { updateAgentSettings(activeId, nextModel, nextEffort); } }}
					/>
				</>
			}
		/>
	);
});

const styles = StyleSheet.create({
	attachBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
});
