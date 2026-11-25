/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「新しいスペース」の作成の流れの naming の段（スペース名とブランチ名を決める）。ダイアログ・モバイル・エージェントの
// create_space・定期実行のどれから来ても同じ決め方にするため、決め方だけをここに置く（命名のモデルと gh の呼び出しは
// 呼び出し側が渡す）。指示に貼った Issue・PR の題名から名前を付ける（q.html Q684）。

import { paradisExtractGithubReferences, ParadisGithubReferenceKind, ParadisGithubReferenceLookup } from '../../../common/paradisIssueDetection.js';
import { paradisReferenceNamingPrompt, paradisToBranchName, paradisToReferenceBranchName, paradisToReferenceWorktreeTitle, paradisToWorktreeTitle } from './paradisWorktreeCreate.js';

/** 名前に使う Issue・PR。ダイアログが取得済みなら題名まで持つ。 */
export interface IParadisWorktreeNameReference {
	readonly url: string;
	readonly number: number;
	readonly kind: ParadisGithubReferenceKind;
	/** 取得済みの題名。無ければ作成の流れが取る。 */
	readonly title?: string;
}

export interface IParadisWorktreeNamingInput {
	/** 打ったスペース名（空なら自動）。 */
	readonly name: string;
	/** 打ったブランチ名（整形済み）か、開く既存のブランチ。空なら自動。 */
	readonly branch: string | undefined;
	/** エージェントへ渡す指示。ここでは読むだけで、書き換えない。 */
	readonly prompt: string;
	readonly reference?: IParadisWorktreeNameReference;
	readonly skipReference?: boolean;
}

/** 決め方の外にあるもの（gh・命名のモデル・時計）。 */
export interface IParadisWorktreeNamingHost {
	/** 待ちの出る処理（gh・命名のモデル）を始める前に呼ぶ。 */
	onNaming(): void;
	/** Issue・PR を取る。待つ上限は呼び出し側が持ち、時間切れなら undefined を返す。 */
	lookupReference(url: string): Promise<ParadisGithubReferenceLookup | undefined>;
	/** 命名のモデルに見出しとブランチ名を付けさせる。使えなければ空を返す。 */
	generate(namingPrompt: string): Promise<{ readonly title?: string; readonly branch?: string }>;
	/** モデルが使えないときのブランチ名（打ったスペース名 → 指示 → 日時）。 */
	fallbackBranchName(seeds: readonly (string | undefined)[]): string;
	log(message: string): void;
}

export interface IParadisWorktreeNaming {
	/** ブランチ名（重複の回避の前）。 */
	readonly branch: string;
	/** そのまま表示名にする名前（打った名前か、Issue・PR の番号つきの題名）。空なら `suggestedTitle` → ディレクトリ名の順。 */
	readonly spaceName: string;
	/** 命名のモデルの見出しか、指示の 1 行目。 */
	readonly suggestedTitle?: string;
}

/**
 * スペース名とブランチ名を決める。打った名前が常に勝つ。
 *
 * - スペース名: 打った名前 > Issue・PR の題名（`#2236 題名`）> 命名のモデルの見出し > 指示の 1 行目
 * - ブランチ名: 打った名前（か既存のブランチ）> `2236-<モデルが題名から付けた英語>` > 今までの付け方
 *
 * 題名は命名のモデルへの入力にだけ使う。**エージェントへ渡す指示は返さない・変えない**（題名も本文も足さない）。
 * Issue・PR を取れなくても止めず、今までの付け方に戻る。
 */
export async function paradisDecideWorktreeNaming(input: IParadisWorktreeNamingInput, host: IParadisWorktreeNamingHost): Promise<IParadisWorktreeNaming> {
	const typedName = input.name.trim();
	let branch = input.branch;
	let reference: { readonly number: number; readonly kind: ParadisGithubReferenceKind; readonly title: string } | undefined;
	// スペース名もブランチ名も決まっていれば、取りに行かない
	if (input.skipReference !== true && (typedName.length === 0 || !branch)) {
		const hint: IParadisWorktreeNameReference | undefined = input.reference ?? paradisExtractGithubReferences(input.prompt, 1).at(0);
		if (hint?.title !== undefined) {
			reference = { number: hint.number, kind: hint.kind, title: hint.title };
		} else if (hint !== undefined) {
			host.onNaming();
			const found = await host.lookupReference(hint.url);
			if (found?.kind === 'ok') {
				reference = { number: found.info.number, kind: found.info.kind, title: found.info.title };
			} else {
				host.log(`could not read the pasted issue or pull request (${found?.reason ?? 'timed out'})`);
			}
		}
	}
	let suggestedTitle: string | undefined;
	if (!branch) {
		const namingPrompt = reference !== undefined ? paradisReferenceNamingPrompt(reference.title, input.prompt) : input.prompt;
		if (namingPrompt.length > 0) {
			host.onNaming();
			const generated = await host.generate(namingPrompt);
			branch = generated.branch;
			suggestedTitle = generated.title;
		}
		// 命名モデルが使えない環境（Copilot 未ログイン等）でも英字のブランチ名を見出しにしない。
		// 依頼文の先頭は利用者自身の言葉なので、日付だけの名前やブランチ名よりは手がかりになる。
		// ブランチ名を手入力した場合はここへ来ない（利用者が決めた名前をそのまま見出しに残す）。
		suggestedTitle = suggestedTitle ?? paradisToWorktreeTitle(input.prompt);
		branch = reference !== undefined
			// Issue・PR の番号を前に置く。モデルが使えなければ打ったスペース名・題名から作る（URL の文字からは作らない）
			? paradisToReferenceBranchName(reference.number, reference.kind, branch ?? paradisToBranchName(input.name), reference.title)
			: branch ?? host.fallbackBranchName([input.name, input.prompt]);
	}
	const spaceName = typedName || (reference !== undefined ? paradisToReferenceWorktreeTitle(reference.number, reference.title) : '');
	return { branch, spaceName, ...(suggestedTitle !== undefined ? { suggestedTitle } : {}) };
}
