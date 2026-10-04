// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PARADIS_AGENT_APPROVAL_OPTIONS_CAPABILITY } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisAgentApprovalOptions.js';
import { useAppStore } from '../../appState.js';
import { approvalChoicesFromOptions, parseApprovalOptionsReply, shouldRequestApprovalOptions, shouldRequestApprovalWarningOnly, type ApprovalOptionChoices } from '../../approvalOptions.js';
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
	approve: (interactionId: string, choice: string, option?: { readonly label: string; readonly promptHash?: string }) => Promise<AgentMessageSendResult>,
): (ApprovalOptionChoices & { readonly approve: (interactionId: string, choice: string) => Promise<AgentMessageSendResult> }) | undefined {
	const supported = usePcCapability(PARADIS_AGENT_APPROVAL_OPTIONS_CAPABILITY);
	const requestAgentReply = useAppStore(s => s.requestAgentReply);
	const [loaded, setLoaded] = useState<{ readonly key: string; readonly value: ApprovalOptionChoices } | undefined>(undefined);
	const warningOnly = supported && shouldRequestApprovalWarningOnly(interaction);
	const wanted = supported && epoch !== undefined && (shouldRequestApprovalOptions(interaction) || warningOnly);
	const ownChoices = interaction?.kind === 'approval' ? interaction.choices : undefined;
	const interactionId = interaction?.id;
	// 番号の選択肢で答えて断られたら（PC の選択肢が変わっていた等）、取り直す（シミュレータ確認の気づき (b)）。
	const [reload, setReload] = useState(0);
	const key = wanted && interactionId !== undefined ? `${epoch}\0${interactionId}\0${reload}` : undefined;

	useEffect(() => {
		if (key === undefined || interactionId === undefined) {
			return undefined;
		}
		let cancelled = false;
		requestAgentReply(terminalKey, { t: 'approval-options', epoch, interactionId }, 'approval-options', APPROVAL_OPTIONS_TIMEOUT_MS)
			.then(reply => {
				const parsed = parseApprovalOptionsReply(reply);
				if (cancelled || parsed === undefined) {
					return;
				}
				setLoaded({ key, value: approvalChoicesFromOptions(parsed.options, parsed.promptHash, parsed.warning) });
			})
			.catch(() => { /* 読めない・古い・切断: 「許可 / 拒否」のまま */ });
		return () => {
			cancelled = true;
		};
	}, [key, terminalKey, epoch, interactionId, requestAgentReply]);

	const read = loaded !== undefined && loaded.key === key ? loaded.value : undefined;
	// mod が値で答える承認（always あり）は、PC が広告した選択肢のまま答える。画面からは警告だけを使う
	const value = useMemo((): ApprovalOptionChoices | undefined => read !== undefined && warningOnly
		? { choices: ownChoices ?? [], labels: new Map(), ...(read.warning !== undefined ? { warning: read.warning } : {}) }
		: read, [read, warningOnly, ownChoices]);
	const approveOption = useCallback(async (id: string, choice: string) => {
		const label = value?.labels.get(choice);
		const result = await approve(id, choice, label !== undefined ? { label, ...(value?.promptHash !== undefined ? { promptHash: value.promptHash } : {}) } : undefined);
		if (result.status === 'rejected' && label !== undefined) {
			// 古い選択肢を出したままにしない。取り直すまでは「許可 / 拒否」に戻る。
			setReload(count => count + 1);
		}
		return result;
	}, [approve, value]);
	return value !== undefined ? { ...value, approve: approveOption } : undefined;
}
