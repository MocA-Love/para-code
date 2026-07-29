/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「短い文章を1つ作らせるだけ」の用途（ブランチ名など）で Copilot の小型モデルを呼ぶための
// IPC 契約。実体は shared process 側（node/paradisCopilotUtilityChannel.ts）にあり、upstream の
// CopilotApiService をそのまま使う。
//
// renderer の ILanguageModelsService 経由（vendor: 'copilot'）を使わない理由: あちらは Copilot Chat
// 拡張が起動してモデルを登録し終えていて初めて動くため、GitHub にログイン済みでも「まだ登録されて
// いない」状態では黙って0件を返す。こちらは GitHub のトークンさえあれば拡張の状態に依存しない。

export const PARADIS_COPILOT_UTILITY_CHANNEL = 'paradisCopilotUtility';

export interface IParadisCopilotUtilityMessage {
	readonly role: 'system' | 'user';
	readonly content: string;
}

export interface IParadisCopilotUtilityRequest {
	/** GitHub の OAuth アクセストークン。これを元に Copilot のセッショントークンを取る。 */
	readonly githubToken: string;
	readonly messages: readonly IParadisCopilotUtilityMessage[];
	readonly temperature?: number;
}

export interface IParadisCopilotUtilityResult {
	/** 生成された本文。呼び出しに失敗した場合は undefined（理由は error に入る）。 */
	readonly text?: string;
	/** 失敗理由（ログ用。UI には出さない）。 */
	readonly error?: string;
}
