/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐に預けておく、アプリ側だけが読むもの。
//
// 常駐から見ればただの文字列で、中身は一切見ない。だからここには VS Code の型を入れてよい
// (アイコンや固定サイズなど)。**凍結しているのは常駐が読む面であって、ここではない。**
//
// ただし条件が1つある。**読む側が、自分より古い（あるいは新しい）版が書いたものを読む。**
// これは更新をまたいで繋ぎ直すという目的の裏返しで、避けられない。したがって:
//
//   **読み取りは決して失敗してはいけない。**
//
// 分からない形は既定値へ倒して読み進める。ここで例外を投げたり undefined を返したりすると、
// **走っているターミナルが引き取れなくなる**。失うのはアイコンの色ではなく、動いているプロセス
// そのものになる。落とし所として「表示が少し寂しくなる」を選ぶ。

/** いま書いている版。**読む側はこれと違う値を必ず受け入れること。** */
const PARADIS_TERMINAL_METADATA_VERSION = 1;

/** 引き取りに要るもの。全部 optional なのは、古い版が書いたものにも欠けがあり得るため。 */
export interface IParadisTerminalMetadata {
	readonly workspaceId: string;
	readonly workspaceName: string;
	readonly shouldPersist: boolean;
	/** 表示名。無ければ常駐が知っている題名へ倒す。 */
	readonly name: string | undefined;
	/** アイコンや色のような「見た目」。読めなければ捨てる。**繋げることを優先する。** */
	readonly appearance: unknown;
	/**
	 * 器を作り直すための材料（起動時のシェル設定と環境）。
	 *
	 * **無くても引き取れる**。無いまま引き取ると、後でこのターミナルを「保存して復元」する際の
	 * 材料が空になるが、それは走っているプロセスを失うのに比べれば些細なこと。
	 */
	readonly launch: unknown;
}

const FALLBACK: IParadisTerminalMetadata = {
	workspaceId: '',
	workspaceName: '',
	shouldPersist: true,
	name: undefined,
	appearance: undefined,
	launch: undefined,
};

export function paradisEncodeTerminalMetadata(metadata: IParadisTerminalMetadata): string {
	return JSON.stringify({ version: PARADIS_TERMINAL_METADATA_VERSION, ...metadata });
}

/**
 * 預かりものを読む。**何が入っていても値を返す。**
 *
 * `shouldPersist` の既定を true にしてあるのは、分からないときに残す側へ倒すため。false へ
 * 倒すと、読めなかったというだけの理由で走っているものを畳むことになる。
 */
export function paradisDecodeTerminalMetadata(raw: string): IParadisTerminalMetadata {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return FALLBACK;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return FALLBACK;
	}
	const value = parsed as Partial<IParadisTerminalMetadata>;
	return {
		workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : FALLBACK.workspaceId,
		workspaceName: typeof value.workspaceName === 'string' ? value.workspaceName : FALLBACK.workspaceName,
		shouldPersist: typeof value.shouldPersist === 'boolean' ? value.shouldPersist : FALLBACK.shouldPersist,
		name: typeof value.name === 'string' ? value.name : undefined,
		// 中身は見ない。使う側が読めなければ捨てる。
		appearance: value.appearance,
		launch: value.launch,
	};
}
