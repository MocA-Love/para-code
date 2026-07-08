// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';

/**
 * エージェントへの入力・承認応答をまとめたアクション群。
 * すべて既存のtermチャネル（PTY stdin注入）で行う（専用の回答APIは存在しない）:
 *  - テキスト送信: そのままTUIの入力欄に入り、Enterで確定
 *  - 承認（Claude）: 選択肢番号を送って250ms後にCR（TUIが番号を処理してから確定する必要がある）
 *  - 承認（Codex）: y / d / a のショートカット1文字（Enter不要）
 * agent.tsx（TUIチャット画面）とホーム画面のアテンションカードの両方から使う。
 */
export interface AgentActions {
	send(data: string): void;
	sendText(text: string): void;
	answerQuestion(optionIndex: number): void;
	toggleQuestionOption(optionIndex: number): void;
	confirmQuestion(): void;
	answerQuestionFreeText(optionCount: number, text: string): void;
	approve(choice: 'yes' | 'no'): void;
}

export function useAgentActions(terminalId: number | undefined, agent: string | undefined): AgentActions {
	const sendInput = useAppStore(s => s.sendInput);

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
		send(text);
		setTimeout(() => send('\r'), 250);
	}, [send]);

	/**
	 * 質問(AskUserQuestion)への回答。TUIの選択プロンプトは番号キーで選択肢へジャンプするため、
	 * 承認注入と同じ「番号 → CR」方式で選んで確定する（複数質問タブは回答すると
	 * 自動で次のタブへ進むので、順に回答すれば最後に Submit される）。
	 */
	const answerQuestion = useCallback((optionIndex: number) => sendSequence([String(optionIndex + 1), '\r']), [sendSequence]);

	/** 複数選択(multiSelect)の質問: 番号でジャンプしてスペースでトグルする（確定はしない）。 */
	const toggleQuestionOption = useCallback((optionIndex: number) => sendSequence([String(optionIndex + 1), ' ']), [sendSequence]);

	/** 複数選択(multiSelect)の質問の確定（Enter）。 */
	const confirmQuestion = useCallback(() => sendSequence(['\r']), [sendSequence]);

	/**
	 * 自由入力での回答。AskUserQuestion のTUIは選択肢の末尾に常に「Other」（自由入力）を
	 * 持つため、「Otherの番号 → CR（入力欄が開く） → テキスト → CR（確定）」を注入する。
	 */
	const answerQuestionFreeText = useCallback(
		(optionCount: number, text: string) => sendSequence([String(optionCount + 1), '\r', text, '\r']),
		[sendSequence],
	);

	/**
	 * 承認クイックアクション。
	 *  - Claude 許可: '1'（Yes、選択肢構成に依らず先頭がYes）+250ms+CR。
	 *    拒否は番号ではなく Esc を注入する（「Always Allow」が無いプロンプトでは選択肢が
	 *    2つになり、'3' 固定注入だと範囲外で拒否が黙って失敗するため。Esc は選択肢数に
	 *    依存せずキャンセル=拒否として機能する）。
	 *  - Codex: y / d のショートカット1文字（Enter不要）。
	 */
	const approve = useCallback((choice: 'yes' | 'no') => {
		if (terminalId === undefined) {
			return;
		}
		if (agent === 'codex') {
			send(choice === 'yes' ? 'y' : 'd');
		} else if (choice === 'yes') {
			send('1');
			setTimeout(() => send('\r'), 250);
		} else {
			send('\u001b');
		}
	}, [terminalId, agent, send]);

	return { send, sendText, answerQuestion, toggleQuestionOption, confirmQuestion, answerQuestionFreeText, approve };
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
