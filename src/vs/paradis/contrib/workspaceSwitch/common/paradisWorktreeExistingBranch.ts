/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「新しいスペース」の「既存のブランチ」（q.html Q605 案 A）の型と判定。ローカルか origin にある既存のブランチを、新しい
// ブランチを切らずにワークツリーで開く。判定（そのまま開く・追跡して作る・早送り・捨てて合わせる・使用中）はここの
// 純関数 1 つにまとめ、ダイアログの表示と、作る直前の git の側（paradisWorktreeGitChannel.ts）の両方が使う
// （ダイアログで見た状態と、キューで実際に作る時点の状態はずれうるので、git の側で判定し直す）。

import { ParadisHostPath } from '../../../common/paradisHostPath.js';

/** ブランチの一覧の 1 件。 */
export interface IParadisBranchCandidate {
	/** ブランチ名（origin の側は `origin/` を除いた名前）。 */
	readonly name: string;
	/** 先頭のコミットの日時（ミリ秒）。分からなければ 0。 */
	readonly committedAt: number;
}

/** ほかのワークツリー（メインの checkout を含む）で開いているブランチ。 */
export interface IParadisBranchInUse {
	readonly branch: string;
	/** 開いているワークツリーのパス（git を動かすマシンから見たパス）。 */
	readonly path: string;
	/** メインの checkout（リポジトリ本体）か。 */
	readonly main: boolean;
}

/** 「既存のブランチ」の候補。 */
export interface IParadisBranchCandidates {
	/** ローカルのブランチ（コミット日時の新しい順）。 */
	readonly local: readonly IParadisBranchCandidate[];
	/** `refs/remotes/origin/*`（`origin/HEAD` を除く。コミット日時の新しい順）。 */
	readonly remote: readonly IParadisBranchCandidate[];
	/** ワークツリーで開いているブランチ。 */
	readonly inUse: readonly IParadisBranchInUse[];
	/** origin が登録されているか（無ければ取得しない・オフラインとも出さない）。 */
	readonly hasOrigin: boolean;
	/** 最後に fetch した時刻（`FETCH_HEAD` の更新時刻、ミリ秒）。分からなければ undefined。 */
	readonly lastFetchedAt?: number;
}

/** 選んだ 1 本の、ローカルと origin の関係。 */
export interface IParadisExistingBranchState {
	readonly localSha?: string;
	readonly remoteSha?: string;
	/** ローカルだけにあるコミットの数（両方あるときだけ意味がある）。 */
	readonly ahead: number;
	/** origin だけにあるコミットの数（両方あるときだけ意味がある）。 */
	readonly behind: number;
	readonly inUse?: IParadisBranchInUse;
}

/** どこから選んだか。同じ名前でも、ローカルを選んだならローカルをそのまま開く。 */
export type ParadisExistingBranchSource = 'local' | 'origin';

/** 選んだブランチをどう開くか。 */
export type ParadisExistingBranchPlan =
	/** 別のワークツリーで開いている。git は 1 つのブランチを 2 か所で開けないので作らない。 */
	| { readonly kind: 'inUse'; readonly inUse: IParadisBranchInUse }
	/** ローカルのブランチをそのまま開く（origin に無い・同じ・ローカルが先にある・ローカルを選んだ）。 */
	| { readonly kind: 'open'; readonly ahead: number }
	/** origin にだけある。追跡するローカルブランチを作って開く。 */
	| { readonly kind: 'track' }
	/** 同じ名前のローカルが origin より遅れているだけ（早送りできる）。 */
	| { readonly kind: 'behind'; readonly behind: number }
	/** 同じ名前のローカルが origin と分かれている。 */
	| { readonly kind: 'diverged'; readonly ahead: number; readonly behind: number }
	/** 選んだ側にそのブランチが無い（取得し直したら消えていた）。 */
	| { readonly kind: 'missing' };

/** 選んだブランチをどう開くかを決める。 */
export function paradisPlanExistingBranch(source: ParadisExistingBranchSource, state: IParadisExistingBranchState): ParadisExistingBranchPlan {
	if (source === 'local' ? state.localSha === undefined : state.remoteSha === undefined) {
		return { kind: 'missing' };
	}
	if (state.inUse !== undefined) {
		return { kind: 'inUse', inUse: state.inUse };
	}
	if (state.localSha === undefined) {
		return { kind: 'track' };
	}
	if (source === 'local' || state.remoteSha === undefined || state.behind === 0) {
		return { kind: 'open', ahead: state.remoteSha === undefined ? 0 : state.ahead };
	}
	return state.ahead === 0 ? { kind: 'behind', behind: state.behind } : { kind: 'diverged', ahead: state.ahead, behind: state.behind };
}

/**
 * 作るときにローカルを origin に合わせるか。`fastForward` は遅れているだけのとき、`reset` は分かれているとき
 * （ローカルだけのコミットを捨てる）にだけ意味がある。それ以外の判定のときに渡されたら作らずに止める。
 */
export type ParadisExistingBranchSync = 'fastForward' | 'reset';

/** 判定に対して、作るときの合わせ方が受け付けられるか。 */
export function paradisExistingBranchSyncAllowed(plan: ParadisExistingBranchPlan, sync: ParadisExistingBranchSync | undefined): boolean {
	if (sync === undefined) {
		return true;
	}
	return sync === 'fastForward' ? plan.kind === 'behind' : plan.kind === 'diverged';
}

/**
 * 作るときの選び方。`auto` はローカルにあればローカル、無ければ origin（エージェントの create_space が名前だけで頼むとき。
 * 合わせる操作は受けない）。
 */
export type ParadisExistingBranchRequestSource = ParadisExistingBranchSource | 'auto';

/** 作成の要求（キュー・再表示）に載せる「既存のブランチを開く」の指定。 */
export interface IParadisExistingBranchChoice {
	readonly branch: string;
	readonly source: ParadisExistingBranchRequestSource;
	readonly sync?: ParadisExistingBranchSync;
	/** `reset` のときにダイアログで見たローカルの先頭のコミット。 */
	readonly expectedLocalSha?: string;
}

/** `addWorktreeFromBranch` の要求。パスはすべて「git を動かすマシン」から見たパス。 */
export interface IParadisAddBranchWorktreeRequest<TPath extends string = ParadisHostPath> {
	readonly repoPath: TPath;
	/** 作るワークツリーのディレクトリ（まだ無いこと）。 */
	readonly worktreePath: TPath;
	/** 開くブランチ（`origin/` を付けない名前）。 */
	readonly branch: string;
	readonly source: ParadisExistingBranchRequestSource;
	readonly sync?: ParadisExistingBranchSync;
	/**
	 * `reset` のとき、ダイアログで見たローカルの先頭のコミット。今の値が違えば止める（「2 コミット捨てる」と見せたまま、
	 * その後に足されたコミットまで捨てないため）。
	 */
	readonly expectedLocalSha?: string;
	/** 作った後に Claude Code と Codex のフォルダの信頼を済ませるか（{@link IParadisAddWorktreeRequest} と同じ）。 */
	readonly trustClaudeFolder?: boolean;
}

/** `addWorktreeFromBranch` の結果。 */
export interface IParadisAddBranchWorktreeResult {
	/** 実際に行ったこと。 */
	readonly plan: ParadisExistingBranchPlan['kind'];
	/** ローカルを origin に合わせたか。 */
	readonly synced: boolean;
}

/** ブランチの作り方。`existing` は既にあるローカル、`track` は origin の同名を追う新しいブランチ、`new` は base から作る。 */
export type ParadisWorktreeBranchMode = 'existing' | 'track' | 'new';

/**
 * `git worktree add`（`dir` あり）と `git switch`（`dir` なし）の、ブランチの作り方ごとの引数。タスクボードの
 * 中継（paradisTaskBoardRemote.ts）と「新しいスペース」の既存のブランチで同じ形を使う。値の検査は呼ぶ側で済ませる。
 */
export function paradisWorktreeBranchArgs<TPath = string>(mode: ParadisWorktreeBranchMode, branch: string, dir: TPath | undefined, base: string | undefined): (string | TPath)[] {
	const at: TPath[] = dir !== undefined ? [dir] : [];
	const create = dir !== undefined ? '-b' : '-c';
	switch (mode) {
		case 'existing': return [...at, branch];
		case 'track': return ['--track', create, branch, ...at, `refs/remotes/origin/${branch}`];
		case 'new': return ['--no-track', create, branch, ...at, base ?? ''];
	}
}

/** `git worktree list --porcelain -z` の出力から、ブランチを開いているワークツリーを取り出す（`prunable` は数えない）。 */
export function paradisParseWorktreeBranchUse(porcelain: string): IParadisBranchInUse[] {
	const result: IParadisBranchInUse[] = [];
	const records = porcelain.split('\0\0').map(record => record.split('\0').filter(field => field.length > 0)).filter(fields => fields.length > 0);
	records.forEach((fields, index) => {
		const path = fields.find(field => field.startsWith('worktree '))?.slice('worktree '.length);
		const branch = fields.find(field => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length);
		// 消えたフォルダの記録（prunable）を数えると、切り替え先の無い「使用中」になる
		if (path === undefined || branch === undefined || fields.some(field => field === 'prunable' || field.startsWith('prunable '))) {
			return;
		}
		result.push({ branch, path, main: index === 0 });
	});
	return result;
}

/**
 * `git for-each-ref --format=%(refname)%00%(committerdate:unix) refs/heads/ refs/remotes/origin/` の出力を、ローカルと
 * origin に分ける。名前は完全な ref から取る（`refname:short` はタグと名前が重なると `heads/x` に化ける）。
 */
export function paradisParseBranchRefs(raw: string): { readonly local: IParadisBranchCandidate[]; readonly remote: IParadisBranchCandidate[] } {
	const local: IParadisBranchCandidate[] = [];
	const remote: IParadisBranchCandidate[] = [];
	for (const line of raw.split('\n')) {
		const [ref, date] = line.split('\0');
		if (!ref) {
			continue;
		}
		const committedAt = (Number.parseInt(date ?? '', 10) || 0) * 1000;
		if (ref.startsWith('refs/heads/')) {
			local.push({ name: ref.slice('refs/heads/'.length), committedAt });
		} else if (ref.startsWith('refs/remotes/origin/')) {
			const name = ref.slice('refs/remotes/origin/'.length);
			if (name !== 'HEAD') {
				remote.push({ name, committedAt });
			}
		}
	}
	const newestFirst = (a: IParadisBranchCandidate, b: IParadisBranchCandidate) => b.committedAt - a.committedAt;
	return { local: local.sort(newestFirst), remote: remote.sort(newestFirst) };
}
