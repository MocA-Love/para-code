// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import type { AgentMessageSendResult } from '../store.js';

/**
 * エージェントへの入力・承認応答をまとめたアクション群。
 * すべて既存のtermチャネル（PTY stdin注入）で行う（専用の回答APIは存在しない）:
 *  - テキスト送信: そのままTUIの入力欄に入り、Enterで確定
 *  - 承認（Claude）: 選択肢番号を送って250ms後にCR（TUIが番号を処理してから確定する必要がある）
 *  - 承認（Codex）: y / d / a のショートカット1文字（Enter不要）
 * agent.tsx（TUIチャット画面）とホーム画面のアテンションカードの両方から使う。
 */
/** 複数質問グループ（AskUserQuestion の questions が2つ以上）の1問ぶんの回答。 */
export type QuestionGroupAnswer =
	| { kind: 'option'; index: number }
	| { kind: 'multi'; indices: number[] }
	| { kind: 'text'; optionCount: number; text: string };

export interface AgentActions {
	send(data: string): void;
	sendText(text: string): Promise<AgentMessageSendResult>;
	answerQuestion(interactionId: string, optionIndex: number): Promise<boolean>;
	answerQuestionMulti(interactionId: string, indices: number[]): Promise<boolean>;
	answerQuestionFreeText(interactionId: string, optionCount: number, text: string): Promise<boolean>;
	answerQuestionGroup(interactionId: string, answers: QuestionGroupAnswer[]): Promise<boolean>;
	approve(interactionId: string, choice: 'yes' | 'no'): Promise<boolean>;
	updateClaudeSetting(setting: 'model' | 'effort', value: string): Promise<boolean>;
}

export function useAgentActions(terminalId: number | undefined, agent: string | undefined): AgentActions {
	const sendInput = useAppStore(s => s.sendInput);
	const sendAgentMessage = useAppStore(s => s.sendAgentMessage);
	const answerAgentQuestion = useAppStore(s => s.answerAgentQuestion);
	const answerAgentApproval = useAppStore(s => s.answerAgentApproval);
	const updateClaudeSettingAction = useAppStore(s => s.updateClaudeSetting);
	const interaction = useAppStore(s => terminalId !== undefined ? s.agentChats.get(terminalId)?.interaction : undefined);
	const supportsAgentActions = useAppStore(s => terminalId !== undefined && s.agentChats.get(terminalId)?.capabilities?.agentActions === true);
	const supportsClaudeSettings = useAppStore(s => terminalId !== undefined && s.agentChats.get(terminalId)?.capabilities?.claudeSettings === true);

	const send = useCallback((data: string) => {
		if (terminalId !== undefined) {
			sendInput(terminalId, data);
		}
	}, [terminalId, sendInput]);

	/** キー列を一定間隔（300ms）でPTYへ注入する（TUIが1入力ずつ処理する時間を確保する）。 */
	const sendSequence = useCallback((parts: string[]) => {
		if (terminalId === undefined) {
			return;
		}
		parts.forEach((part, i) => setTimeout(() => send(part), i * 300));
	}, [terminalId, send]);

	// TUIの入力欄へテキストを入れ、少し置いてからCRで確定する（貼り付け直後の
	// 確定はTUI側の取りこぼしがあるため。承認番号注入と同じ250ms方式）。
	const sendText = useCallback((text: string) => {
		if (terminalId === undefined) {
			return Promise.resolve({ status: 'rejected' as const, message: '送信先のエージェントが見つかりません' });
		}
		return sendAgentMessage(terminalId, text);
	}, [terminalId, sendAgentMessage]);

	/**
	 * 質問(AskUserQuestion)への回答。TUIの選択プロンプトは番号キーで選択肢へジャンプするため、
	 * 承認注入と同じ「番号 → CR」方式で選んで確定する（複数質問タブは回答すると
	 * 自動で次のタブへ進むので、順に回答すれば最後に Submit される）。
	 */
	const answerQuestion = useCallback((interactionId: string, optionIndex: number) => {
		if (supportsAgentActions) {
			return terminalId !== undefined && interaction?.kind === 'question' && interaction.id === interactionId
				? answerAgentQuestion(terminalId, interactionId, [{ kind: 'option', index: optionIndex }])
				: Promise.resolve(false);
		}
		sendSequence([String(optionIndex + 1), '\r']);
		return Promise.resolve(true);
	}, [terminalId, interaction, supportsAgentActions, answerAgentQuestion, sendSequence]);

	const answerQuestionMulti = useCallback((interactionId: string, indices: number[]) => {
		if (supportsAgentActions) {
			return terminalId !== undefined && interaction?.kind === 'question' && interaction.id === interactionId
				? answerAgentQuestion(terminalId, interactionId, [{ kind: 'multi', indices }])
				: Promise.resolve(false);
		}
		const parts = indices.flatMap(index => [String(index + 1), ' ']);
		sendSequence([...parts, '\r']);
		return Promise.resolve(true);
	}, [terminalId, interaction, supportsAgentActions, answerAgentQuestion, sendSequence]);

	/**
	 * 自由入力での回答。AskUserQuestion のTUIは選択肢の末尾に常に「Other」（自由入力）を
	 * 持つため、「Otherの番号 → CR（入力欄が開く） → テキスト → CR（確定）」を注入する。
	 */
	const answerQuestionFreeText = useCallback(
		(interactionId: string, optionCount: number, text: string) => {
			if (supportsAgentActions) {
				return terminalId !== undefined && interaction?.kind === 'question' && interaction.id === interactionId
					? answerAgentQuestion(terminalId, interactionId, [{ kind: 'text', optionCount, text }])
					: Promise.resolve(false);
			}
			sendSequence([String(optionCount + 1), '\r', text, '\r']);
			return Promise.resolve(true);
		},
		[terminalId, interaction, supportsAgentActions, answerAgentQuestion, sendSequence],
	);

	/**
	 * 複数質問グループの一括回答。TUIの選択プロンプトは「番号キー = 選択肢へジャンプ
	 * （ハイライト移動のみ）」「Enter = 現在の質問を確定して次の質問へ前進（最終問なら
	 * Submit）」なので、単一質問（answerQuestion）と同じく1問ごとに「番号 → Enter」で
	 * 確定しながら前進する。番号だけを連打すると全てが1問目のハイライト移動に消費され、
	 * 1問目しか選択されず送信もされない（既知バグの原因）。
	 * multiSelect は「番号 → スペース」でトグルし、Enterでその質問を確定。
	 * 自由入力は「Other番号 → CR（入力欄）→ テキスト → CR」。
	 * 末尾の予備Enterは、最終問の確定で自動Submitされた場合は空の入力欄に落ちるだけで無害。
	 */
	const answerQuestionGroup = useCallback((interactionId: string, answers: QuestionGroupAnswer[]) => {
		if (supportsAgentActions) {
			return terminalId !== undefined && interaction?.kind === 'question' && interaction.id === interactionId
				? answerAgentQuestion(terminalId, interactionId, answers)
				: Promise.resolve(false);
		}
		const parts: string[] = [];
		for (const answer of answers) {
			if (answer.kind === 'option') {
				parts.push(String(answer.index + 1), '\r');
			} else if (answer.kind === 'multi') {
				for (const i of answer.indices) {
					parts.push(String(i + 1), ' ');
				}
				parts.push('\r');
			} else {
				parts.push(String(answer.optionCount + 1), '\r', answer.text, '\r');
			}
		}
		parts.push('\r'); // 全問確定後にSubmit確認ステップが残っている場合の予備
		sendSequence(parts);
		return Promise.resolve(true);
	}, [terminalId, interaction, supportsAgentActions, answerAgentQuestion, sendSequence]);

	/**
	 * 承認クイックアクション。
	 *  - Claude 許可: '1'（Yes、選択肢構成に依らず先頭がYes）+250ms+CR。
	 *    拒否は番号ではなく Esc を注入する（「Always Allow」が無いプロンプトでは選択肢が
	 *    2つになり、'3' 固定注入だと範囲外で拒否が黙って失敗するため。Esc は選択肢数に
	 *    依存せずキャンセル=拒否として機能する）。
	 *  - Codex: y / d のショートカット1文字（Enter不要）。
	 */
	const approve = useCallback((interactionId: string, choice: 'yes' | 'no') => {
		if (terminalId === undefined) {
			return Promise.resolve(false);
		}
		if (supportsAgentActions) {
			return interaction?.kind === 'approval' && interaction.id === interactionId
				? answerAgentApproval(terminalId, interactionId, choice)
				: Promise.resolve(false);
		}
		if (agent === 'codex') {
			send(choice === 'yes' ? 'y' : 'd');
		} else if (choice === 'yes') {
			send('1');
			setTimeout(() => send('\r'), 250);
		} else {
			send('\u001b');
		}
		return Promise.resolve(true);
	}, [terminalId, agent, interaction, supportsAgentActions, answerAgentApproval, send]);

	const updateClaudeSetting = useCallback((setting: 'model' | 'effort', value: string) => {
		if (terminalId === undefined || agent !== 'claude' || interaction !== undefined) {
			return Promise.resolve(false);
		}
		if (supportsClaudeSettings) {
			return updateClaudeSettingAction(terminalId, setting, value);
		}
		send(`/${setting} ${value}`);
		setTimeout(() => send('\r'), 250);
		return Promise.resolve(true);
	}, [terminalId, agent, interaction, supportsClaudeSettings, updateClaudeSettingAction, send]);

	return { send, sendText, answerQuestion, answerQuestionMulti, answerQuestionFreeText, answerQuestionGroup, approve, updateClaudeSetting };
}

/** 指定ターミナルのエージェントチャットを購読する（アタッチ/デタッチのライフサイクル込み）。 */
export function useAgentChatSubscription(terminalId: number | undefined) {
	const { agentChats, attachAgent, detachAgent } = useAppStore(useShallow(s => ({
		agentChats: s.agentChats, attachAgent: s.attachAgent, detachAgent: s.detachAgent,
	})));

	useEffect(() => {
		if (terminalId === undefined) {
			return;
		}
		attachAgent(terminalId);
		return () => detachAgent(terminalId);
	}, [terminalId, attachAgent, detachAgent]);

	return terminalId !== undefined ? agentChats.get(terminalId) : undefined;
}
