// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { agentQuestionKeySequence, type AgentQuestionKeyAnswer, type AgentQuestionShape } from '../agentQuestionKeys.js';
import type { AgentMessageSendResult } from '../store.js';

/**
 * エージェントへの入力・承認応答をまとめたアクション群。
 * すべて既存のtermチャネル（PTY stdin注入）で行う（専用の回答APIは存在しない）:
 *  - テキスト送信: そのままTUIの入力欄に入り、Enterで確定
 *  - 承認（Claude）: 選択肢番号を送って250ms後にCR（TUIが番号を処理してから確定する必要がある）
 *  - 承認（Codex）: y / d / a のショートカット1文字（Enter不要）
 * agent.tsx（TUIチャット画面）とホーム画面のアテンションカードの両方から使う。
 */
/** 1問ぶんの回答（複数質問グループでは質問の並び順に1つずつ持つ）。 */
export type QuestionGroupAnswer = AgentQuestionKeyAnswer;

export interface AgentActions {
	send(data: string): boolean;
	sendText(text: string): Promise<AgentMessageSendResult>;
	// 回答系はテキスト送信と同じく理由付きの結果を返す。失敗の理由をUIまで運べないと
	// 「押したのに何も起きない」としか見えず、接続断・対象変更・PC側の拒否を区別できない。
	// question / questions はTUI上の形（選択肢の数と複数選択か）。キー列の組み立てに要る。
	answerQuestion(interactionId: string, question: AgentQuestionShape, optionIndex: number): Promise<AgentMessageSendResult>;
	answerQuestionMulti(interactionId: string, question: AgentQuestionShape, indices: number[]): Promise<AgentMessageSendResult>;
	answerQuestionFreeText(interactionId: string, question: AgentQuestionShape, text: string): Promise<AgentMessageSendResult>;
	answerQuestionGroup(interactionId: string, questions: readonly AgentQuestionShape[], answers: QuestionGroupAnswer[]): Promise<AgentMessageSendResult>;
	approve(interactionId: string, choice: string): Promise<AgentMessageSendResult>;
	updateClaudeSetting(setting: 'model' | 'effort', value: string): Promise<AgentMessageSendResult>;
}

const STALE_INTERACTION_RESULT: AgentMessageSendResult = { status: 'rejected', message: '回答の対象が変わりました。最新の内容を確認してください。' };
const NO_TARGET_RESULT: AgentMessageSendResult = { status: 'rejected', message: '送信先のエージェントが見つかりません' };

/** PTY注入（agentActions 非対応セッション向けのレガシー経路）の成否を同じ結果型へ揃える。 */
function fromInjection(ok: boolean): AgentMessageSendResult {
	return ok ? { status: 'accepted' } : { status: 'rejected', message: 'ターミナルへ入力を送信できませんでした' };
}

type AppStoreSnapshot = ReturnType<typeof useAppStore.getState>;

function agentRendererTarget(state: AppStoreSnapshot, terminalKey: string | undefined): string | undefined {
	if (state.connection !== 'online' || !state.pcOnline || !state.sessionProtocolReady || state.protocolError !== undefined || terminalKey === undefined) {
		return undefined;
	}
	const terminal = state.workspace?.terminals.find(candidate => candidate.terminalKey === terminalKey);
	const renderer = terminal !== undefined ? state.workspace?.renderers.find(candidate => candidate.windowId === terminal.windowId) : undefined;
	return renderer?.ready === true && renderer.rendererGeneration === terminal?.rendererGeneration && state.workspace !== undefined
		? JSON.stringify([state.workspace.desktopEpoch, terminal.windowId, terminal.rendererGeneration, terminal.id, terminal.agentToken ?? null])
		: undefined;
}

export function useAgentActions(terminalKey: string | undefined, agent: string | undefined): AgentActions {
	const sendLiveInput = useAppStore(s => s.sendLiveInput);
	const sendAgentMessage = useAppStore(s => s.sendAgentMessage);
	const answerAgentQuestion = useAppStore(s => s.answerAgentQuestion);
	const answerAgentApproval = useAppStore(s => s.answerAgentApproval);
	const updateClaudeSettingAction = useAppStore(s => s.updateClaudeSetting);
	const interaction = useAppStore(s => terminalKey !== undefined ? s.agentChats.get(terminalKey)?.interaction : undefined);
	const supportsAgentActions = useAppStore(s => terminalKey !== undefined && s.agentChats.get(terminalKey)?.capabilities?.agentActions === true);
	const supportsClaudeSettings = useAppStore(s => terminalKey !== undefined && s.agentChats.get(terminalKey)?.capabilities?.claudeSettings === true);
	const rendererTarget = useAppStore(s => agentRendererTarget(s, terminalKey));
	const sequenceWaitsRef = useRef(new Map<ReturnType<typeof setTimeout>, () => void>());
	const cancelSequences = useCallback(() => {
		for (const [timer, cancel] of sequenceWaitsRef.current) {
			clearTimeout(timer);
			cancel();
		}
		sequenceWaitsRef.current.clear();
	}, []);
	useEffect(() => {
		cancelSequences();
		return cancelSequences;
	}, [rendererTarget, terminalKey, agent, interaction?.kind, interaction?.id, cancelSequences]);

	const send = useCallback((data: string) => {
		return terminalKey !== undefined && rendererTarget !== undefined
			&& agentRendererTarget(useAppStore.getState(), terminalKey) === rendererTarget
			&& sendLiveInput(terminalKey, data);
	}, [terminalKey, rendererTarget, sendLiveInput]);

	/** キー列を一定間隔（300ms）でPTYへ注入する（TUIが1入力ずつ処理する時間を確保する）。 */
	const sendSequence = useCallback(async (parts: string[]) => {
		const sequenceTarget = rendererTarget;
		if (terminalKey === undefined || sequenceTarget === undefined || parts.length === 0) {
			return false;
		}
		cancelSequences();
		for (let index = 0; index < parts.length; index++) {
			if (agentRendererTarget(useAppStore.getState(), terminalKey) !== sequenceTarget) {
				return false;
			}
			if (index > 0) {
				const continued = await new Promise<boolean>(resolve => {
					const timer = setTimeout(() => {
						sequenceWaitsRef.current.delete(timer);
						resolve(true);
					}, 300);
					sequenceWaitsRef.current.set(timer, () => resolve(false));
				});
				if (!continued) {
					return false;
				}
			}
			if (!send(parts[index]!)) {
				return false;
			}
		}
		return true;
	}, [terminalKey, rendererTarget, send, cancelSequences]);

	// TUIの入力欄へテキストを入れ、少し置いてからCRで確定する（貼り付け直後の
	// 確定はTUI側の取りこぼしがあるため。承認番号注入と同じ250ms方式）。
	const sendText = useCallback((text: string) => {
		if (terminalKey === undefined) {
			return Promise.resolve({ status: 'rejected' as const, message: '送信先のエージェントが見つかりません' });
		}
		return sendAgentMessage(terminalKey, text);
	}, [terminalKey, sendAgentMessage]);

	/**
	 * 質問(AskUserQuestion)への回答。新しいPCではPC側が同じ規則でキー列を組み立てて注入する。
	 * 回答APIを持たない古いPCへは、ここから直接PTYへ注入する（キー列の規則は
	 * agentQuestionKeys.ts に集約。TUIの実挙動と、素朴な「番号 → Enter」が壊れる理由もそこ）。
	 */
	const answerQuestions = useCallback(
		(interactionId: string, questions: readonly AgentQuestionShape[], answers: QuestionGroupAnswer[]): Promise<AgentMessageSendResult> => {
			if (interaction?.kind !== 'question' || interaction.id !== interactionId) {
				return Promise.resolve(STALE_INTERACTION_RESULT);
			}
			if (terminalKey === undefined) {
				return Promise.resolve(NO_TARGET_RESULT);
			}
			if (supportsAgentActions) {
				return answerAgentQuestion(terminalKey, interactionId, answers);
			}
			return sendSequence(agentQuestionKeySequence(questions, answers)).then(fromInjection);
		},
		[terminalKey, interaction, supportsAgentActions, answerAgentQuestion, sendSequence],
	);

	const answerQuestion = useCallback((interactionId: string, question: AgentQuestionShape, optionIndex: number): Promise<AgentMessageSendResult> => {
		return answerQuestions(interactionId, [question], [{ kind: 'option', index: optionIndex }]);
	}, [answerQuestions]);

	const answerQuestionMulti = useCallback((interactionId: string, question: AgentQuestionShape, indices: number[]): Promise<AgentMessageSendResult> => {
		return answerQuestions(interactionId, [question], [{ kind: 'multi', indices }]);
	}, [answerQuestions]);

	/** 自由入力での回答。TUIは選択肢の末尾に常に「Other」（自由入力）を持つ。 */
	const answerQuestionFreeText = useCallback((interactionId: string, question: AgentQuestionShape, text: string): Promise<AgentMessageSendResult> => {
		return answerQuestions(interactionId, [question], [{ kind: 'text', optionCount: question.optionCount, text }]);
	}, [answerQuestions]);

	/**
	 * 複数質問グループの一括回答。1問ずつ送るとTUI側のEnterがフォーム全体をSubmitしてしまうため、
	 * 全問揃えてから1本のキー列にする。
	 */
	const answerQuestionGroup = useCallback((interactionId: string, questions: readonly AgentQuestionShape[], answers: QuestionGroupAnswer[]): Promise<AgentMessageSendResult> => {
		return answerQuestions(interactionId, questions, answers);
	}, [answerQuestions]);

	/**
	 * 承認クイックアクション。
	 *  - Claude 許可: '1'（Yes、選択肢構成に依らず先頭がYes）+250ms+CR。
	 *    拒否は番号ではなく Esc を注入する（「Always Allow」が無いプロンプトでは選択肢が
	 *    2つになり、'3' 固定注入だと範囲外で拒否が黙って失敗するため。Esc は選択肢数に
	 *    依存せずキャンセル=拒否として機能する）。
	 *  - Codex: y / d のショートカット1文字（Enter不要）。
	 */
	const approve = useCallback((interactionId: string, choice: string): Promise<AgentMessageSendResult> => {
		if (interaction?.kind !== 'approval' || interaction.id !== interactionId) {
			return Promise.resolve(STALE_INTERACTION_RESULT);
		}
		if (terminalKey === undefined) {
			return Promise.resolve(NO_TARGET_RESULT);
		}
		if (supportsAgentActions) {
			return answerAgentApproval(terminalKey, interactionId, choice);
		}
		if (choice !== 'yes' && choice !== 'no') {
			return Promise.resolve({ status: 'rejected', message: 'この選択肢は送信できません' });
		}
		if (agent === 'codex') {
			return Promise.resolve(fromInjection(send(choice === 'yes' ? 'y' : 'd')));
		} else if (choice === 'yes') {
			return sendSequence(['1', '\r']).then(fromInjection);
		} else {
			return Promise.resolve(fromInjection(send('\u001b')));
		}
	}, [terminalKey, agent, interaction, supportsAgentActions, answerAgentApproval, send, sendSequence]);

	const updateClaudeSetting = useCallback((setting: 'model' | 'effort', value: string): Promise<AgentMessageSendResult> => {
		if (terminalKey === undefined) {
			return Promise.resolve(NO_TARGET_RESULT);
		}
		if (agent !== 'claude') {
			return Promise.resolve({ status: 'rejected', message: 'このエージェントでは変更できません' });
		}
		if (interaction !== undefined) {
			return Promise.resolve({ status: 'rejected', message: '質問や許可への回答が先に必要です' });
		}
		if (supportsClaudeSettings) {
			return updateClaudeSettingAction(terminalKey, setting, value);
		}
		return sendSequence([`/${setting} ${value}`, '\r']).then(fromInjection);
	}, [terminalKey, agent, interaction, supportsClaudeSettings, updateClaudeSettingAction, sendSequence]);

	return { send, sendText, answerQuestion, answerQuestionMulti, answerQuestionFreeText, answerQuestionGroup, approve, updateClaudeSetting };
}

/** 指定ターミナルのエージェントチャットを購読する（アタッチ/デタッチのライフサイクル込み）。 */
export function useAgentChatSubscription(terminalKey: string | undefined) {
	// agentChats（Map本体）ではなく対象1件だけを購読する。emit は更新のたびに新しい Map を
	// 作るため、Mapを購読すると「開いている行が無くても、どこかのエージェントが出力している間ずっと
	// 呼び出し側が再描画される」（ホーム一覧が他エージェントのストリームで再構築される原因）。
	const { chat, attachAgent, detachAgent } = useAppStore(useShallow(s => ({
		chat: terminalKey !== undefined ? s.agentChats.get(terminalKey) : undefined,
		attachAgent: s.attachAgent,
		detachAgent: s.detachAgent,
	})));

	useEffect(() => {
		if (terminalKey === undefined) {
			return;
		}
		attachAgent(terminalKey);
		return () => detachAgent(terminalKey);
	}, [terminalKey, attachAgent, detachAgent]);

	return chat;
}
