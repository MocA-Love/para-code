// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Alert } from 'react-native';
import { create } from 'zustand';
import { useAppStore } from './appState.js';

/**
 * エージェント起動のバックグラウンド実行と、その進行トースト。
 *
 * 起動フォームは画面（app/agent-launch.tsx）だが、CTAを押した直後にその画面は閉じる。
 * 起動処理と進行表示を画面の中に置くと、閉じた時点で進行が追えなくなるため、
 * ここ（画面のライフサイクルと無関係なモジュール）に置いてホームが購読する。
 */

export interface AgentLaunchToast {
	readonly text: string;
	readonly sub: string;
	readonly phase: 'progress' | 'done';
}

interface AgentLaunchToastStore {
	readonly toast: AgentLaunchToast | undefined;
	/** autoHideMs を渡すとその時間後に自動で消える（渡さなければ出したまま）。 */
	show(next: AgentLaunchToast, autoHideMs?: number): void;
}

/** 自動非表示のタイマー。表示は同時に1件だけなのでモジュールに1本持てば足りる。 */
let hideTimer: ReturnType<typeof setTimeout> | undefined;

export const useAgentLaunchToast = create<AgentLaunchToastStore>()(set => ({
	toast: undefined,
	show(next, autoHideMs) {
		if (hideTimer !== undefined) {
			clearTimeout(hideTimer);
			hideTimer = undefined;
		}
		set({ toast: next });
		if (autoHideMs !== undefined) {
			hideTimer = setTimeout(() => {
				hideTimer = undefined;
				set({ toast: undefined });
			}, autoHideMs);
		}
	},
}));

/** 起動フォームが組み立てた1回ぶんの起動要求。 */
export interface AgentLaunchRequest {
	/** トーストに出すエージェント名（'Claude' 等）。 */
	readonly agentLabel: string;
	/** トーストの2行目（スペース名・ブランチ）。 */
	readonly subtitle: string;
	readonly agent: string;
	readonly prompt?: string;
	readonly model?: string;
	readonly effort?: string;
	readonly permission?: string;
	/** 既存スペースへ起動する場合のワークスペースid。 */
	readonly ws?: string;
	/** その場で新しいスペースを作って起動する場合の作成条件。 */
	readonly newSpace?: {
		readonly repo: string;
		readonly name?: string;
		readonly branch?: string;
		readonly base?: string;
		readonly runSetup?: boolean;
	};
}

/**
 * 起動を投げっぱなしで実行する（呼び出し元は即座に画面を閉じてよい）。
 * 進行と結果はトーストで、失敗と警告は Alert で伝える。
 */
export function launchAgentInBackground(request: AgentLaunchRequest): void {
	const show = useAgentLaunchToast.getState().show;
	const store = useAppStore.getState();
	const options = {
		agent: request.agent,
		...(request.prompt !== undefined && request.prompt.length > 0 ? { prompt: request.prompt } : {}),
		...(request.model !== undefined ? { model: request.model } : {}),
		...(request.effort !== undefined ? { effort: request.effort } : {}),
		...(request.permission !== undefined ? { permission: request.permission } : {}),
	};

	if (request.newSpace !== undefined) {
		const space = request.newSpace;
		show({ text: `新しいスペースを作成して ${request.agentLabel} を起動中…`, sub: request.subtitle, phase: 'progress' });
		store.createWorktree({
			repo: space.repo,
			...(space.name !== undefined && space.name.length > 0 ? { name: space.name } : {}),
			...(space.branch !== undefined && space.branch.length > 0 ? { branch: space.branch } : {}),
			...(space.base !== undefined ? { base: space.base } : {}),
			...(space.runSetup !== undefined ? { runSetup: space.runSetup } : {}),
			...options,
		}).then(result => {
			show({ text: `${request.agentLabel} を起動しました`, sub: `${result.name} · ${result.branch}`, phase: 'done' }, 2_500);
			if (result.warning) {
				Alert.alert('スペースを作成しました', `ただし後続の処理でエラーがありました: ${result.warning}`);
			}
		}).catch((e: unknown) => {
			show({ text: '起動できませんでした', sub: '', phase: 'done' }, 1_200);
			Alert.alert('エージェントを起動できませんでした', String(e instanceof Error ? e.message : e));
		});
		return;
	}

	if (request.ws === undefined) {
		return;
	}
	show({ text: `${request.agentLabel} を起動中…`, sub: request.subtitle, phase: 'progress' });
	store.launchAgent({ ws: request.ws, ...options }).then(() => {
		show({ text: `${request.agentLabel} を起動しました`, sub: request.subtitle, phase: 'done' }, 2_500);
	}).catch((e: unknown) => {
		show({ text: '起動できませんでした', sub: '', phase: 'done' }, 1_200);
		Alert.alert('エージェントを起動できませんでした', String(e instanceof Error ? e.message : e));
	});
}
