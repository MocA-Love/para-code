// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useState } from 'react';
import { PARADIS_AGENT_APPROVAL_OPTIONS_CAPABILITY } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisAgentApprovalOptions.js';
import { useAppStore } from '../../appState.js';
import { approvalChoicesFromOptions, parseApprovalOptionsReply, shouldRequestApprovalOptions, type ApprovalOptionChoices } from '../../approvalOptions.js';
import { usePcCapability } from '../../hooks/usePcCapability.js';
import type { AgentInteraction, AgentMessageSendResult } from '../../store.js';

/** PC が画面を待ってから答えるので、その上限（3 秒）より長めに待つ。 */
const APPROVAL_OPTIONS_TIMEOUT_MS = 8_000;

/**
 * 承認カードに並べる、PC の画面の番号付きの選択肢（W2-21）。
 *
 * 承認が変わるたびに 1 回だけ PC に求める。届くまでと、読めなかったときは undefined（カードは今までの
 * 「許可 / 拒否」のまま）。`approve` は押した選択肢の文言を添えて送る。
 */
export function useApprovalOptions(
	terminalKey: string,
	epoch: string | undefined,
	interaction: AgentInteraction | undefined,
	approve: (interactionId: string, choice: string, optionLabel?: string) => Promise<AgentMessageSendResult>,
): (ApprovalOptionChoices & { readonly approve: (interactionId: string, choice: string) => Promise<AgentMessageSendResult> }) | undefined {
	const supported = usePcCapability(PARADIS_AGENT_APPROVAL_OPTIONS_CAPABILITY);
	const requestAgentReply = useAppStore(s => s.requestAgentReply);
	const [loaded, setLoaded] = useState<{ readonly key: string; readonly value: ApprovalOptionChoices } | undefined>(undefined);
	const wanted = supported && epoch !== undefined && shouldRequestApprovalOptions(interaction);
	const interactionId = interaction?.id;
	const key = wanted && interactionId !== undefined ? `${epoch}\0${interactionId}` : undefined;

	useEffect(() => {
		if (key === undefined || interactionId === undefined) {
			return undefined;
		}
		let cancelled = false;
		requestAgentReply(terminalKey, { t: 'approval-options', epoch, interactionId }, 'approval-options', APPROVAL_OPTIONS_TIMEOUT_MS)
			.then(reply => {
				const options = parseApprovalOptionsReply(reply);
				if (!cancelled && options !== undefined) {
					setLoaded({ key, value: approvalChoicesFromOptions(options) });
				}
			})
			.catch(() => { /* 読めない・古い・切断: 「許可 / 拒否」のまま */ });
		return () => {
			cancelled = true;
		};
	}, [key, terminalKey, epoch, interactionId, requestAgentReply]);

	const value = loaded !== undefined && loaded.key === key ? loaded.value : undefined;
	const approveOption = useCallback((id: string, choice: string) => approve(id, choice, value?.labels.get(choice)), [approve, value]);
	return value !== undefined ? { ...value, approve: approveOption } : undefined;
}
