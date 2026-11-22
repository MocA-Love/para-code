/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// このファイルは何も import しない（`import type` も置かない）。node・browser・electron-browser・shared process・REH に加えて、
// モバイルアプリ（Metro）とタスクボードからも直接読めるようにするため。表示名は nls を通さない素の文字列（製品名）。

/** エージェント CLI の種類。 */
export type ParadisAgentKind = 'claude' | 'codex' | 'opencode' | 'antigravity';

/** 種類の一覧。 */
export const PARADIS_AGENT_KINDS: readonly ParadisAgentKind[] = ['claude', 'codex', 'opencode', 'antigravity'];

/**
 * エージェントへ操作を渡す経路。
 * - `mod`: Claude Mods が値で受ける
 * - `keys`: TUI へのキー（貼り付けと打鍵）
 * - `api`: 連携の API（OpenCode の橋渡し）
 * - `hook`: 許可の hook が答えを待っている間だけ、その答えとして値で返す
 */
type ParadisAgentRoute = 'mod' | 'keys' | 'api' | 'hook';

/** 種類ごとの記述。その種類が「いつでも同じ」こと（静的な性質）だけを書く。mod が生きているか・hook が待っているかは書かない。 */
export interface IParadisAgentDescriptor {
	/** 画面に出す名前。 */
	readonly displayName: string;
	/** 通知の副題などの短い名前。 */
	readonly shortName: string;
	/** ロゴ（`ParadisAgentLogo` と同じ値）。ロゴの無い種類は undefined。 */
	readonly logo: 'claude' | 'codex' | 'antigravity' | undefined;
	readonly resume: {
		/** CLI に分岐（会話ごと複製して始める）の指定があるか。 */
		readonly fork: boolean;
		/** 権限の確認を省いて再開するときの引数。省けない種類は undefined。 */
		readonly bypassFlag: string | undefined;
		/** モバイルから再開した直後に、依頼の文を自動で渡すか。 */
		readonly deliverPromptAfterResume: boolean;
		/**
		 * モバイルが預かった送信を、宛先のペインの会話が預けたときと同じなら確認なしで送ってよいか。`false` は、TUI の中で
		 * 会話が替わっても PC が受け身に気付けない種類で、会話が同じに見えても必ず利用者に確かめる。
		 */
		readonly sendQueuedWithoutConfirm: boolean;
	};
	/** モデル・effort をチャット欄から変える口。`none` は変えられない（PC のターミナルで変える）。 */
	readonly modelControl: 'mod-or-keys' | 'none';
	/** 発言を送る経路（候補の順）。空は送れない。 */
	readonly send: readonly ParadisAgentRoute[];
	/** 質問のカードに答える経路（候補の順）。空は答えられない。 */
	readonly answerQuestion: readonly ParadisAgentRoute[];
	/** 許可の確認に答える経路（候補の順）。空は答えられない。 */
	readonly answerApproval: readonly ParadisAgentRoute[];
	/** 中断の渡し方。`ctrl-c` は端末への Ctrl+C、`api` は連携の API。 */
	readonly interrupt: 'ctrl-c' | 'api';
	/** スラッシュコマンドの一覧の出どころ。 */
	readonly commandCatalog: 'mod-or-files' | 'files' | 'api' | 'none';
	/** モバイルへ配る会話の付帯情報のうち、その種類が持つもの。 */
	readonly features: {
		readonly subagents: boolean;
		readonly teams: boolean;
		readonly workflows: boolean;
		readonly shells: boolean;
		readonly panel: boolean;
		readonly pcDraft: boolean;
		/**
		 * モバイルへ `sessionStatus` を配るか。PC の一覧（`paradisMobileAgentChat.ts` の `desktopPaneInsight`）は別の集合で、
		 * この値では決めない。
		 */
		readonly sessionStatus: boolean;
		readonly asyncQuestions: boolean;
	};
}

/** 種類ごとの記述の表。種類への問いはここを引く。 */
export const PARADIS_AGENT_DESCRIPTORS: Readonly<Record<ParadisAgentKind, IParadisAgentDescriptor>> = {
	claude: {
		displayName: 'Claude Code',
		shortName: 'Claude',
		logo: 'claude',
		resume: { fork: true, bypassFlag: '--dangerously-skip-permissions', deliverPromptAfterResume: true, sendQueuedWithoutConfirm: true },
		modelControl: 'mod-or-keys',
		send: ['mod', 'keys'],
		answerQuestion: ['mod', 'keys'],
		answerApproval: ['mod', 'keys'],
		interrupt: 'ctrl-c',
		commandCatalog: 'mod-or-files',
		features: { subagents: true, teams: true, workflows: true, shells: true, panel: true, pcDraft: true, sessionStatus: true, asyncQuestions: false },
	},
	codex: {
		displayName: 'Codex',
		shortName: 'Codex',
		logo: 'codex',
		resume: { fork: true, bypassFlag: '--dangerously-bypass-approvals-and-sandbox', deliverPromptAfterResume: true, sendQueuedWithoutConfirm: true },
		modelControl: 'none',
		send: ['keys'],
		answerQuestion: ['keys'],
		answerApproval: ['keys'],
		interrupt: 'ctrl-c',
		commandCatalog: 'files',
		features: { subagents: true, teams: false, workflows: false, shells: false, panel: false, pcDraft: false, sessionStatus: true, asyncQuestions: true },
	},
	opencode: {
		displayName: 'OpenCode',
		shortName: 'OpenCode',
		logo: undefined,
		resume: { fork: true, bypassFlag: undefined, deliverPromptAfterResume: true, sendQueuedWithoutConfirm: true },
		modelControl: 'none',
		send: ['api'],
		answerQuestion: ['api'],
		answerApproval: ['api'],
		interrupt: 'api',
		commandCatalog: 'api',
		features: { subagents: false, teams: false, workflows: false, shells: false, panel: false, pcDraft: false, sessionStatus: true, asyncQuestions: false },
	},
	antigravity: {
		displayName: 'Antigravity CLI',
		shortName: 'Antigravity',
		logo: 'antigravity',
		resume: { fork: false, bypassFlag: undefined, deliverPromptAfterResume: false, sendQueuedWithoutConfirm: false },
		modelControl: 'none',
		send: ['keys'],
		answerQuestion: [],
		answerApproval: ['hook'],
		interrupt: 'ctrl-c',
		commandCatalog: 'none',
		features: { subagents: false, teams: false, workflows: false, shells: false, panel: false, pcDraft: false, sessionStatus: false, asyncQuestions: false },
	},
};

/** 記述を引く。種類の型に無い値（古い保存データ・電文の値）と undefined には undefined を返す。 */
export function paradisAgentDescriptor(agent: string | undefined): IParadisAgentDescriptor | undefined {
	return agent !== undefined && Object.prototype.hasOwnProperty.call(PARADIS_AGENT_DESCRIPTORS, agent) ? PARADIS_AGENT_DESCRIPTORS[agent as ParadisAgentKind] : undefined;
}
