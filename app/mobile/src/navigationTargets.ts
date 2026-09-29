// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WorkspaceState } from './store.js';
import { isAttentionAgent } from './attentionCount.js';
import type { SessionTab } from './routes.js';

/**
 * ルートの ID（`pcId` / `spaceId` / タブ）を、ストアにある既存のデータへ引き当てる純関数。
 *
 * ID の対応（呼び名は Orca と作り直し計画に合わせている）:
 *  - **PC** = `useAppStore().pcs[].id`（ペアリング台帳の ID）。いま見ている PC は `activePcId`
 *  - **スペース** = `workspace.workspaces[].id`（PC から届くワークスペースの ID。`1:w1` のような形）
 *  - **セッションのタブ** = `workspace.terminals[].terminalKey`（エージェントもターミナルもこれ）。
 *    ターミナルがどのスペースに属するかは `terminal.ws`（＝スペースの ID）
 *
 * **ストアが中身を持っているのは、いま見ている PC（`activePcId`）の分だけ。** 別の PC の
 * ルートを開いたときは、まず `switchPc` でその PC へ切り替える必要がある（`pcRouteStatus` が
 * `inactive` を返す）。フックは `src/hooks/useRouteTargets.ts`。
 */

type Workspace = WorkspaceState['workspaces'][number];
export type SpaceTerminal = WorkspaceState['terminals'][number];

/** ルートの PC がどういう状態か。 */
export type PcRouteStatus =
	/** ペアリング台帳に無い（解除した後のリンクなど）。 */
	| 'unknown'
	/** 台帳にはあるが、いま見ている PC ではない（切り替えが要る）。 */
	| 'inactive'
	/** いま見ている PC。ストアの `workspace` はこの PC のもの。 */
	| 'active';

export function findPc<T extends { readonly id: string }>(pcs: readonly T[], pcId: string | undefined): T | undefined {
	return pcId === undefined ? undefined : pcs.find(pc => pc.id === pcId);
}

export function pcRouteStatus(pcs: readonly { readonly id: string }[], activePcId: string | undefined, pcId: string | undefined): PcRouteStatus {
	if (findPc(pcs, pcId) === undefined) {
		return 'unknown';
	}
	return pcId === activePcId ? 'active' : 'inactive';
}

export function findSpace(workspace: WorkspaceState | undefined, spaceId: string | undefined): Workspace | undefined {
	return spaceId === undefined ? undefined : workspace?.workspaces.find(space => space.id === spaceId);
}

/** ルートのスペースがどういう状態か。 */
export type SpaceRouteStatus =
	/** まだ PC から全体が届いていない（届けば見つかるかもしれない）。 */
	| 'loading'
	/** 全体が届いたうえで見つからない（閉じられた・別の PC のスペース）。 */
	| 'missing'
	| 'ready';

/**
 * スペースが見つかるか。PC から届く状態は窓ごとに分かれて届くことがあり（`complete: false`）、
 * その間に「無い」と決めつけると、正しいリンクまで「見つかりません」になる。
 */
export function spaceRouteStatus(workspace: WorkspaceState | undefined, spaceId: string | undefined): SpaceRouteStatus {
	if (findSpace(workspace, spaceId) !== undefined) {
		return 'ready';
	}
	return workspace === undefined || workspace.complete !== true ? 'loading' : 'missing';
}

/** スペースに属するターミナル（エージェントを含む）を、PC から届いた順のまま返す。 */
export function spaceTerminals(workspace: WorkspaceState | undefined, spaceId: string | undefined): SpaceTerminal[] {
	if (workspace === undefined || spaceId === undefined) {
		return [];
	}
	return workspace.terminals.filter(terminal => terminal.ws === spaceId);
}

/** ターミナルが属するスペースの ID。 */
export function spaceIdOfTerminal(workspace: WorkspaceState | undefined, terminalKey: string | undefined): string | undefined {
	if (terminalKey === undefined) {
		return undefined;
	}
	return workspace?.terminals.find(terminal => terminal.terminalKey === terminalKey)?.ws;
}

/**
 * タブの指定が無いときに開くタブ。要対応のエージェント → エージェント → 先頭のターミナルの順。
 * ターミナルが1つも無ければ undefined（画面は空の状態を出す）。
 */
export function defaultSessionTab(terminals: readonly SpaceTerminal[]): SessionTab | undefined {
	const pick = terminals.find(isAttentionAgent)
		?? terminals.find(terminal => terminal.agent === true)
		?? terminals[0];
	return pick === undefined ? undefined : { kind: 'terminal', terminalKey: pick.terminalKey };
}

/** セッション画面が開くタブの決まり方。 */
export type ResolvedSessionTab =
	| { readonly status: 'terminal'; readonly terminal: SpaceTerminal }
	| { readonly status: 'browser' }
	/** 指定されたターミナルがまだ届いていない。 */
	| { readonly status: 'loading' }
	/** 指定されたターミナルが（全体が届いたうえで）このスペースに無い。別のタブへは勝手に移さない。 */
	| { readonly status: 'missing' }
	/** このスペースにターミナルが1つも無い。 */
	| { readonly status: 'empty' };

/**
 * ルートのタブの指定を、このスペースのターミナルへ引き当てる。
 *
 * 指定があって見つからないときは、既定のタブへ代えない（通知で開いた先が別のエージェントに
 * すり替わると、答えるべき相手を取り違える。`agentNavigation.ts` の
 * `resolveExplicitTerminalSelection` と同じ決まり）。
 */
export function resolveSessionTab(workspace: WorkspaceState | undefined, spaceId: string | undefined, requested: SessionTab | undefined): ResolvedSessionTab {
	if (requested?.kind === 'browser') {
		return { status: 'browser' };
	}
	const terminals = spaceTerminals(workspace, spaceId);
	if (requested !== undefined) {
		const found = terminals.find(terminal => terminal.terminalKey === requested.terminalKey);
		if (found !== undefined) {
			return { status: 'terminal', terminal: found };
		}
		return workspace === undefined || workspace.complete !== true ? { status: 'loading' } : { status: 'missing' };
	}
	const fallback = defaultSessionTab(terminals);
	if (fallback?.kind === 'terminal') {
		const terminal = terminals.find(candidate => candidate.terminalKey === fallback.terminalKey);
		if (terminal !== undefined) {
			return { status: 'terminal', terminal };
		}
	}
	return workspace === undefined || workspace.complete !== true ? { status: 'loading' } : { status: 'empty' };
}

/**
 * 指定なしで開いた画面が、既定で開いたタブを固定するための指定。固定するものが無ければ undefined。
 *
 * 既定のタブは要対応のエージェントを優先するので、指定なしのまま置くと、同じスペースの別の
 * エージェントが許可待ちになった瞬間に画面がそちらへ切り替わる（入力中の相手と取り違える）。
 * 開いた時点のタブをクエリへ書き込み、以後は指定ありと同じ扱いにする。
 */
export function sessionTabToPin(requested: SessionTab | undefined, resolved: ResolvedSessionTab): Extract<SessionTab, { readonly kind: 'terminal' }> | undefined {
	if (requested !== undefined || resolved.status !== 'terminal') {
		return undefined;
	}
	return { kind: 'terminal', terminalKey: resolved.terminal.terminalKey };
}
