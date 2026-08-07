// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Alert } from 'react-native';
import { useAppStore } from './appState.js';
import { useParaToast } from './paraToast.js';

/**
 * エージェント起動のバックグラウンド実行と、その進行トースト。
 *
 * 起動フォームは画面（app/agent-launch.tsx）だが、CTAを押した直後にその画面は閉じる。
 * 起動処理と進行表示を画面の中に置くと、閉じた時点で進行が追えなくなるため、
 * ここ（画面のライフサイクルと無関係なモジュール）に置く。
 *
 * 表示は共通の {@link useParaToast}（上端のカプセル）へ流す。以前はこのファイルが
 * 専用のストアとタブバー上の専用トーストを持っていたが、
 * 「一時的なお知らせ」の器はアプリに1つで足りる（src/paraToast.ts 参照）。
 */

/** 進行中の起動トーストを出す。 */
function showProgress(text: string, sub: string): void {
	useParaToast.getState().show({ key: 'agent-launch', text, sub, icon: 'sparkles-outline', tone: 'info', spinner: true });
}

/** 結果を出して、しばらくしてから沈ませる。 */
function showResult(text: string, sub: string, tone: 'done' | 'warn', autoHideMs: number): void {
	useParaToast.getState().show({ key: 'agent-launch', text, sub, icon: tone === 'done' ? 'checkmark-circle' : 'alert-circle', tone }, autoHideMs);
}

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
		showProgress(`新しいスペースを作成して ${request.agentLabel} を起動中…`, request.subtitle);
		store.createWorktree({
			repo: space.repo,
			...(space.name !== undefined && space.name.length > 0 ? { name: space.name } : {}),
			...(space.branch !== undefined && space.branch.length > 0 ? { branch: space.branch } : {}),
			...(space.base !== undefined ? { base: space.base } : {}),
			...(space.runSetup !== undefined ? { runSetup: space.runSetup } : {}),
			...options,
		}).then(result => {
			showResult(`${request.agentLabel} を起動しました`, `${result.name} · ${result.branch}`, 'done', 2_500);
			if (result.warning) {
				Alert.alert('スペースを作成しました', `ただし後続の処理でエラーがありました: ${result.warning}`);
			}
		}).catch((e: unknown) => {
			showResult('起動できませんでした', '', 'warn', 1_200);
			Alert.alert('エージェントを起動できませんでした', String(e instanceof Error ? e.message : e));
		});
		return;
	}

	if (request.ws === undefined) {
		return;
	}
	showProgress(`${request.agentLabel} を起動中…`, request.subtitle);
	store.launchAgent({ ws: request.ws, ...options }).then(() => {
		showResult(`${request.agentLabel} を起動しました`, request.subtitle, 'done', 2_500);
	}).catch((e: unknown) => {
		showResult('起動できませんでした', '', 'warn', 1_200);
		Alert.alert('エージェントを起動できませんでした', String(e instanceof Error ? e.message : e));
	});
}
