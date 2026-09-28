// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { agentModelOptions, claudeModelOptionsFromAgents, type AgentModelOption } from '../agentModels.js';
import { useAppStore } from '../appState.js';

/**
 * チャットのモデル選択で使う Claude の候補。PC がインストール済みの Claude Code から取った一覧を
 * `worktreeForm`（agentsOnly）で取り、PC ごとに覚えておく。取れるまでと取れないときは固定表を使う。
 *
 * PC 側も CLI を起こすのは版が変わったときだけだが、ここでも取りに行くのはシートを開いたときだけにし、
 * 同じ PC へは 5 分に1回までにする（旧 PC は agentsOnly を知らずリポジトリごとの git まで動かすため）。
 * 使える一覧が来なかったとき（PC が CLI から取り直している途中など）だけは 30 秒で聞き直す。
 */

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** PC から使える一覧が来なかったとき（PC が CLI から取り直している途中など）は、早めに聞き直す。 */
const RETRY_INTERVAL_MS = 30 * 1000;

interface CatalogEntry {
	readonly fetchedAt: number;
	readonly options: readonly AgentModelOption[] | undefined;
}

const catalogs = new Map<string, CatalogEntry>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

function getVersion(): number {
	return version;
}

function publish(pcId: string, entry: CatalogEntry): void {
	catalogs.set(pcId, entry);
	version++;
	for (const listener of [...listeners]) {
		listener();
	}
}

export function useClaudeModelOptions(agent: string | undefined): { readonly options: readonly AgentModelOption[]; readonly request: () => void } {
	const { pcId, worktreeForm } = useAppStore(useShallow(s => ({ pcId: s.activePcId, worktreeForm: s.worktreeForm })));
	useSyncExternalStore(subscribe, getVersion);
	const entry = pcId !== undefined ? catalogs.get(pcId) : undefined;
	const request = useCallback(() => {
		if (agent !== 'claude' || pcId === undefined || inFlight.has(pcId)) {
			return;
		}
		const current = catalogs.get(pcId);
		if (current !== undefined && Date.now() - current.fetchedAt < (current.options !== undefined ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS)) {
			return;
		}
		inFlight.add(pcId);
		worktreeForm({ agentsOnly: true }).then(result => {
			publish(pcId, { fetchedAt: Date.now(), options: claudeModelOptionsFromAgents(result.agents) });
		}, () => {
			// 取れなければ固定表のまま。次にシートを開いたときに取り直す
		}).finally(() => {
			inFlight.delete(pcId);
		});
	}, [agent, pcId, worktreeForm]);
	return { options: agentModelOptions(agent, agent === 'claude' ? entry?.options : undefined), request };
}
