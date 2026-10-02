/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisMobileStatusFile, paradisParseMobilePorcelainStatus, paradisWithMobileLineCounts, paradisWithUntrackedFileStats } from './paradisMobileDiffReview.js';
import { PARADIS_MOBILE_STATUS_DEADLINE_MS, PARADIS_MOBILE_STATUS_OPTIONAL_GRACE_MS, paradisSettleWithin, paradisWithHostDeadline } from './paradisMobileHostDeadline.js';
import { IParadisGitResult } from './paradisMobileRelay.js';
import { IParadisMobileBranchSync, paradisParseMobileBranchSync } from './paradisMobileScmSync.js';

/** scm `status` の応答（形は以前と同じ。上流との先行・遅れは読めなければ省く）。 */
/** `pathsUnquoted`: git の引用（`"a b.txt"` など）を外したパスで送っている印（アプリは外し直さない）。 */
export type ParadisMobileScmStatusReply = { readonly t: 'status'; readonly branch: string; readonly files: IParadisMobileStatusFile[]; readonly pathsUnquoted: true } & IParadisMobileBranchSync;

/** status を読む材料（git はそのリポジトリがあるマシンで動かす）。 */
export interface IParadisMobileScmStatusSource {
	runGit(args: readonly string[]): Promise<IParadisGitResult>;
	/** 未追跡のファイルの大きさと時刻（パスの一覧をまとめて調べる）。 */
	statFiles(paths: readonly string[]): Promise<ReadonlyMap<string, { readonly size: number; readonly mtime: number }>>;
}

export interface IParadisMobileScmStatusDeadlines {
	/**
	 * 必須の部分（`status`・`rev-parse`・行数 2 本・未追跡の大きさ）の上限。超えたら `ParadisMobileHostNoResponseError`。
	 * 行数と大きさは差分レビューの識別（`paradisMobileDiffIdentity`）に入るので、省くと確認済みの印が一斉に
	 * 「確認後に変更あり」になり、欠けた識別で印が保存される。だから省かずに待つ。
	 */
	readonly requiredMs: number;
	/** 必須の部分が揃ってから、上流との先行・遅れ（識別に入らない）を待つ上限。超えたら省いて返す。 */
	readonly optionalGraceMs: number;
}

const DEFAULT_DEADLINES: IParadisMobileScmStatusDeadlines = { requiredMs: PARADIS_MOBILE_STATUS_DEADLINE_MS, optionalGraceMs: PARADIS_MOBILE_STATUS_OPTIONAL_GRACE_MS };

/**
 * scm `status` の応答を作る。5 本の git は同時に始める。一覧と識別に要るもの（status・ブランチ名・行数・
 * 未追跡の大きさ）は上限つきで全部待ち、上流との先行・遅れだけは短い上限で打ち切って省く
 * （古いアプリは省いた項目を「無い」として読む）。合計（必須 + 任意）はアプリの timeout（30 秒）より短い。
 */
export async function paradisReadMobileScmStatus(source: IParadisMobileScmStatusSource, deadlines: IParadisMobileScmStatusDeadlines = DEFAULT_DEADLINES): Promise<ParadisMobileScmStatusReply> {
	// 上流と先行・遅れの数（スマホからの push / pull の判断に使う。Orca W2-15）。任意
	const branchSyncResult = source.runGit(['status', '--porcelain=v2', '--branch', '--untracked-files=no']).catch(() => undefined);
	const required = Promise.all([
		source.runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
		readStatusFiles(source),
	]);
	const [branch, { files }] = await paradisWithHostDeadline(required, deadlines.requiredMs);
	const branchSync = await paradisSettleWithin(branchSyncResult, deadlines.optionalGraceMs);
	return { t: 'status', branch: branch.stdout.trim(), files, pathsUnquoted: true, ...(branchSync?.code === 0 ? paradisParseMobileBranchSync(branchSync.stdout) : {}) };
}

/**
 * 変更の一覧を行数と未追跡の大きさまで揃えて読む（差分レビューの識別の材料。scm `status` と同じ）。
 * `timeoutMs` までに揃わなければ `ParadisMobileHostNoResponseError`（識別の欠けた一覧は返さない）。
 * `status` 自体が失敗したら undefined。
 */
export async function paradisReadMobileStatusFiles(source: IParadisMobileScmStatusSource, timeoutMs: number = PARADIS_MOBILE_STATUS_DEADLINE_MS): Promise<IParadisMobileStatusFile[] | undefined> {
	const read = await paradisWithHostDeadline(readStatusFiles(source), timeoutMs);
	return read.ok ? read.files : undefined;
}

/** `ok` は `git status` が成功したか（scm `status` の応答は以前どおり失敗でも出力を読む）。 */
async function readStatusFiles(source: IParadisMobileScmStatusSource): Promise<{ readonly ok: boolean; readonly files: IParadisMobileStatusFile[] }> {
	const [status, unstaged, staged] = await Promise.all([
		source.runGit(['status', '--porcelain=v1']),
		// ファイルごとの行数（差分レビューの「確認後に変更あり」の判定に使う。Orca W2-14）。
		// git が失敗したときは以前どおり省く（時間切れは呼び出し側の全体の上限で扱う）
		source.runGit(['diff', '--numstat', '-z']).catch(() => undefined),
		source.runGit(['diff', '--cached', '--numstat', '-z']).catch(() => undefined),
	]);
	if (status.code !== 0) {
		return { ok: false, files: paradisParseMobilePorcelainStatus(status.stdout) };
	}
	// 未追跡のファイルは行数を数えられないので、大きさと時刻を足す（書き換えを見分けるため）
	const files = await paradisWithUntrackedFileStats(paradisWithMobileLineCounts(
		paradisParseMobilePorcelainStatus(status.stdout),
		unstaged?.code === 0 ? unstaged.stdout : undefined,
		staged?.code === 0 ? staged.stdout : undefined,
	), paths => source.statFiles(paths));
	return { ok: true, files };
}
