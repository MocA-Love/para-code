// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	paradisMobileCommitFailureIsFixable,
	type IParadisMobileBranchSync,
	type IParadisMobileCommitFailure,
	type ParadisMobileSyncOperation,
} from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileScmSync.js';
import { commitAction, type CommitAction, type CommitActionInput, type ScmCounts } from './scmModel.js';

/**
 * ソース管理の同期（push / pull / fetch）とコミットの失敗の見せ方（Orca W2-15）。React に依存しない純関数で、
 * `scmSync.test.ts` で固定している。判定の考え方は Orca の `source-control-primary-action-decision.ts` を
 * スマホで出せる操作（コミット・push・pull・公開）に絞ったもの。**強制 push は出さない**（Q114 A）。
 */

export type ScmPrimaryKind = 'commit' | 'push' | 'pull' | 'publish';

export interface ScmPrimaryAction extends CommitAction {
	readonly kind: ScmPrimaryKind;
}

export interface ScmPrimaryInput extends CommitActionInput {
	/** PC が同期を扱えるときの上流と先行・遅れ（扱えない PC なら undefined。コミットだけの主ボタンになる）。 */
	readonly sync: IParadisMobileBranchSync | undefined;
	/** 実行中の同期（無ければ undefined）。 */
	readonly syncing: ParadisMobileSyncOperation | undefined;
	readonly branch: string | undefined;
}

const SYNCING_LABEL: Record<ParadisMobileSyncOperation, string> = { push: 'プッシュ中…', pull: '取り込み中…', fetch: 'フェッチ中…' };

/**
 * コミットバーの主ボタン。変更があればコミット、無ければ 遅れ → 取り込み（pull）、先行 → プッシュ、上流が無い →
 * ブランチを公開、の順に選ぶ。先行と遅れの両方がある（履歴が分かれている）ときは押せず、PC での解決を案内する。
 */
export function scmPrimaryAction(input: ScmPrimaryInput): ScmPrimaryAction {
	const commit = commitAction(input);
	if (input.sync === undefined) {
		return { ...commit, kind: 'commit' };
	}
	if (input.syncing !== undefined) {
		return { kind: input.syncing === 'push' ? 'push' : 'pull', label: SYNCING_LABEL[input.syncing], disabled: true, reason: undefined, showInput: commit.showInput, busy: true };
	}
	if (input.committing || !input.live || input.total === undefined || input.total > 0) {
		return { ...commit, kind: 'commit' };
	}
	const idle = { showInput: false, busy: false } as const;
	const { upstream, ahead = 0, behind = 0 } = input.sync;
	if (upstream === undefined) {
		return input.branch !== undefined && input.branch.length > 0 && input.branch !== 'HEAD'
			? { kind: 'publish', label: 'ブランチを公開', disabled: false, reason: undefined, ...idle }
			: { ...commit, kind: 'commit' };
	}
	if (ahead > 0 && behind > 0) {
		return { kind: 'pull', label: '同期', disabled: true, reason: '手元とリモートの履歴が分かれています。PC で解決してください', ...idle };
	}
	if (behind > 0) {
		return { kind: 'pull', label: `取り込む（${behind}）`, disabled: false, reason: undefined, ...idle };
	}
	if (ahead > 0) {
		return { kind: 'push', label: `プッシュ（${ahead}）`, disabled: false, reason: undefined, ...idle };
	}
	return { ...commit, kind: 'commit' };
}

/** ブランチのカードに出す同期の状態と、並べる操作。 */
export interface ScmSyncSummary {
	/** 「origin/main ↑2 ↓1」のような一行（上流が無ければ「まだ公開していません」）。 */
	readonly text: string;
	/** 履歴が分かれている（PC で解決してもらう）。 */
	readonly diverged: boolean;
	/** カードに並べる操作（主ボタンと重なるものも出す。変更があって主ボタンがコミットのときに使う）。 */
	readonly actions: readonly ParadisMobileSyncOperation[];
}

export function scmSyncSummary(sync: IParadisMobileBranchSync | undefined): ScmSyncSummary | undefined {
	if (sync === undefined) {
		return undefined;
	}
	if (sync.upstream === undefined) {
		return { text: 'まだ公開していません', diverged: false, actions: ['fetch'] };
	}
	if (sync.ahead === undefined || sync.behind === undefined) {
		return { text: `${sync.upstream}（リモートのブランチがありません）`, diverged: false, actions: ['fetch'] };
	}
	const counts = [sync.ahead > 0 ? `↑${sync.ahead}` : undefined, sync.behind > 0 ? `↓${sync.behind}` : undefined].filter(part => part !== undefined);
	const diverged = sync.ahead > 0 && sync.behind > 0;
	const actions: ParadisMobileSyncOperation[] = ['fetch'];
	if (!diverged && sync.behind > 0) {
		actions.push('pull');
	}
	if (!diverged && sync.ahead > 0) {
		actions.push('push');
	}
	return { text: counts.length > 0 ? `${sync.upstream} ${counts.join(' ')}` : `${sync.upstream} と同じ`, diverged, actions };
}

/** status の応答から同期の状態を取り出す（PC が送っていなければ空）。 */
export function branchSyncOf(status: object | undefined): IParadisMobileBranchSync {
	const value = status as { upstream?: unknown; ahead?: unknown; behind?: unknown } | undefined;
	return {
		...(typeof value?.upstream === 'string' ? { upstream: value.upstream } : {}),
		...(typeof value?.ahead === 'number' ? { ahead: value.ahead } : {}),
		...(typeof value?.behind === 'number' ? { behind: value.behind } : {}),
	};
}

/** 何をコミットするか。ファイルごとにステージできる PC で、ステージ済みがあればそれだけをコミットする。 */
export type CommitScope = 'staged' | 'all';

export function commitScope(counts: ScmCounts | undefined, canStageFiles: boolean): CommitScope {
	return canStageFiles && counts !== undefined && counts.staged > 0 ? 'staged' : 'all';
}

/** コミットバーの下の注記。 */
export function commitHint(scope: CommitScope, counts: ScmCounts | undefined, canStageFiles: boolean): string {
	if (scope === 'staged' && counts !== undefined) {
		return `ステージ済みの ${counts.staged} 件の、ステージした分だけをコミットします（一部だけステージしたファイルの残りは入れません）。`;
	}
	return canStageFiles
		? 'ステージしたものが無いので、未追跡を含むすべての変更をまとめてコミットします。'
		: 'ステージの操作は PC で行います。ここからは未追跡を含むすべての変更をまとめてコミットします。';
}

/** コミットの失敗のカードに出すもの。 */
export interface CommitFailureView {
	readonly title: string;
	readonly output: string;
	/** 「AI に直してもらう」を出すか。 */
	readonly fixable: boolean;
	/** ステージを戻したことの一言（戻していなければ undefined）。 */
	readonly note: string | undefined;
}

export function commitFailureView(failure: IParadisMobileCommitFailure): CommitFailureView {
	return {
		title: failure.summary,
		output: failure.output,
		fixable: paradisMobileCommitFailureIsFixable(failure.kind),
		note: failure.restoreFailed === true ? 'ステージを戻せませんでした。PC で確かめてください。' : failure.restored ? 'ステージの状態はコミットの前に戻しました。' : undefined,
	};
}

/** PC から届いた `commitSafe` の失敗を読む（形の違うものは undefined）。 */
export function parseCommitFailure(value: unknown): IParadisMobileCommitFailure | undefined {
	const failure = value as Partial<Record<keyof IParadisMobileCommitFailure, unknown>> | null | undefined;
	if (failure === null || typeof failure !== 'object' || typeof failure.id !== 'string' || typeof failure.kind !== 'string' || typeof failure.summary !== 'string' || typeof failure.output !== 'string') {
		return undefined;
	}
	const kinds = ['hook', 'lint', 'nothing', 'identity', 'conflict', 'timeout', 'other'] as const;
	const kind = kinds.find(candidate => candidate === failure.kind) ?? 'other';
	return { id: failure.id, kind, summary: failure.summary, output: failure.output, restored: failure.restored === true, ...(failure.restoreFailed === true ? { restoreFailed: true } : {}) };
}

/** エージェントへ送った結果（`commitFix` / `prFixChecks` の応答）。 */
export type AgentHandoffResult =
	| { readonly delivered: true; readonly text: string }
	| { readonly delivered: false; readonly text: string; readonly busy: boolean };

export function agentHandoffResult(reply: { readonly delivered?: unknown; readonly via?: unknown; readonly title?: unknown; readonly code?: unknown; readonly message?: unknown }): AgentHandoffResult {
	if (reply.delivered === true) {
		return {
			delivered: true,
			text: reply.via === 'launch' ? '新しいエージェントを起動して頼みました' : typeof reply.title === 'string' && reply.title.length > 0 ? `「${reply.title}」に頼みました` : 'エージェントに頼みました',
		};
	}
	return { delivered: false, text: typeof reply.message === 'string' && reply.message.length > 0 ? reply.message : '頼めませんでした', busy: reply.code === 'busy' };
}
