// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WorktreeAgentDef, WorktreeFormResult } from '../../store.js';

/**
 * 「エージェントを起動」シートの選択肢と、押せるかどうかの判定（純関数）。
 * 起動そのものは既存の `src/agentLaunch.ts`（`launchAgentInBackground`）と
 * ストアの `createTerminal` / `createWorktree` が行い、ここでは書き直さない。
 *
 * モック（concept-orca.html の「エージェントを起動」）の欄: スペース・名前（新しいスペースのとき）・
 * エージェント・最初の指示・詳細（権限）。
 */

/** 起動するものの種類。エージェントは PC 側の定義の id（`claude` / `codex` / 独自定義）。 */
export const TERMINAL_KIND = 'terminal';

/** どこで起動するか。 */
export type LaunchTarget =
	| { readonly kind: 'space'; readonly spaceId: string }
	| { readonly kind: 'new'; readonly repoId: string };

const SPACE_PREFIX = 'space:';
const NEW_PREFIX = 'new:';

/** 選択肢の値（シートの行の key）にする。 */
export function encodeLaunchTarget(target: LaunchTarget): string {
	return target.kind === 'space' ? `${SPACE_PREFIX}${target.spaceId}` : `${NEW_PREFIX}${target.repoId}`;
}

export function parseLaunchTarget(value: string | undefined): LaunchTarget | undefined {
	if (value?.startsWith(SPACE_PREFIX) === true && value.length > SPACE_PREFIX.length) {
		return { kind: 'space', spaceId: value.slice(SPACE_PREFIX.length) };
	}
	if (value?.startsWith(NEW_PREFIX) === true && value.length > NEW_PREFIX.length) {
		return { kind: 'new', repoId: value.slice(NEW_PREFIX.length) };
	}
	return undefined;
}

/** モバイルの起動シートでは出さないエージェント（旧起動画面と同じ）。 */
const HIDDEN_AGENTS = new Set(['gemini']);

/** 起動シートに出すエージェント定義。 */
export function launchableAgents(form: Pick<WorktreeFormResult, 'agents'> | undefined): WorktreeAgentDef[] {
	return (form?.agents ?? []).filter(agent => !HIDDEN_AGENTS.has(agent.id));
}

/**
 * 既存のスペースへエージェントを起動できる PC か。旧 PC はエージェント定義を id/label だけで送り、
 * 既存スペースへの起動（scm launchAgent）にも応えない（旧起動画面と同じ判定）。
 */
export function pcSupportsLaunchIntoSpace(form: Pick<WorktreeFormResult, 'agents'> | undefined): boolean {
	return form?.agents.some(agent => agent.command !== undefined) === true;
}

/** スペースの選択肢（既存のスペース → リポジトリごとの「新しいスペース」）。 */
export interface LaunchSpaceOption {
	readonly value: string;
	readonly label: string;
	readonly hint?: string;
	/** 既存のスペースならその id（色を引くため）。 */
	readonly spaceId?: string;
	readonly isNew: boolean;
}

export function launchSpaceOptions(
	spaces: readonly { readonly id: string; readonly name: string; readonly branch?: string }[],
	repos: readonly { readonly id: string; readonly name: string }[],
): LaunchSpaceOption[] {
	return [
		...spaces.map(space => ({
			value: encodeLaunchTarget({ kind: 'space', spaceId: space.id }),
			label: space.name,
			...(space.branch !== undefined ? { hint: space.branch } : {}),
			spaceId: space.id,
			isNew: false,
		})),
		...repos.map(repo => ({
			value: encodeLaunchTarget({ kind: 'new', repoId: repo.id }),
			label: `新しいスペース（${repo.name}）`,
			hint: 'ワークツリーを作ってから起動します',
			isNew: true,
		})),
	];
}

/**
 * 既定の起動先。指定があればそれ（存在する場合）、無ければいま PC で開いているスペース、
 * それも無ければ先頭のスペース、スペースが1つも無ければ最初のリポジトリの新しいスペース。
 */
export function defaultLaunchTarget(
	preferred: LaunchTarget | undefined,
	spaces: readonly { readonly id: string }[],
	repos: readonly { readonly id: string }[],
	activeWs: string | undefined,
): LaunchTarget | undefined {
	if (preferred?.kind === 'space' && spaces.some(space => space.id === preferred.spaceId)) {
		return preferred;
	}
	if (preferred?.kind === 'new' && repos.some(repo => repo.id === preferred.repoId)) {
		return preferred;
	}
	const space = spaces.find(candidate => candidate.id === activeWs) ?? spaces[0];
	if (space !== undefined) {
		return { kind: 'space', spaceId: space.id };
	}
	const repo = repos[0];
	return repo !== undefined ? { kind: 'new', repoId: repo.id } : undefined;
}

/**
 * 「新しいスペース」の既定のリポジトリ。指定されたスペースの親リポジトリ（ワークツリーなら parent、
 * リポジトリそのものなら自分）があればそれ、無ければ先頭。
 */
export function defaultNewSpaceRepo(
	repos: readonly { readonly id: string }[],
	space: { readonly id: string; readonly parent?: string } | undefined,
): string | undefined {
	const preferred = space !== undefined ? (space.parent ?? space.id) : undefined;
	return (repos.find(repo => repo.id === preferred) ?? repos[0])?.id;
}

export interface LaunchReadinessInput {
	/** PC と話せる状態か（接続中・セッションの準備ができている・ウィンドウが開いている）。 */
	readonly live: boolean;
	/** 選んだ種類（エージェントの id か `terminal`）。 */
	readonly kind: string | undefined;
	readonly target: LaunchTarget | undefined;
	readonly agents: readonly Pick<WorktreeAgentDef, 'id'>[];
	readonly supportsLaunchIntoSpace: boolean;
}

/**
 * 「起動する」を押せない理由。押せるなら undefined。理由はボタンの下に出す一文。
 * 最初の指示は任意（空で起動すればエージェントが入力を待つ）。
 */
export function launchBlockedReason(input: LaunchReadinessInput): string | undefined {
	if (!input.live) {
		return 'PC に接続すると起動できます。';
	}
	if (input.target === undefined) {
		return 'スペースを選んでください。';
	}
	if (input.kind === undefined) {
		return '起動するものを選んでください。';
	}
	if (input.kind !== TERMINAL_KIND && !input.agents.some(agent => agent.id === input.kind)) {
		return 'このエージェントは PC に登録されていません。';
	}
	if (input.kind !== TERMINAL_KIND && input.target.kind === 'space' && !input.supportsLaunchIntoSpace) {
		return 'この PC の Para Code は既存のスペースへの起動に対応していません。新しいスペースを選ぶか、PC を更新してください。';
	}
	return undefined;
}
