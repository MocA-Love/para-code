/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** worktree 作成後に行う一連のアクション（順序・失敗時の打ち切りをテストしやすいよう分離）。 */
export interface IParadisCreatedWorktreeActions {
	/** リポジトリ定義の setupScript を実行する。完了を待つのは自動実行プリセットだけ。 */
	runSetup(): Promise<void>;
	/** 自動実行プリセットを起動する。何か起動したら true を返す。 */
	runAutoRun(): Promise<boolean>;
	/** runAutoRun が何も起動しなかった場合のみ呼ばれる。 */
	openDefaultTerminal(): Promise<void>;
	/** エージェント CLI を起動する。setup の完了・成否には左右されない。 */
	launchAgent(): Promise<void>;
}

/**
 * setup を開始 →（待たずに）エージェント起動 → setup 完了を待って自動実行プリセット
 * （無ければ既定ターミナル）、の順で実行する。
 *
 * エージェントの起動を setup に待たせない: setup は shared process で完走まで最長10分かかり、
 * さらに初回はスクリプト内容ごとの承認ダイアログを挟む。ここを直列にすると、依存インストールが
 * 長い・非ゼロ終了する・承認が放置される・対話プロンプトで固まる、のいずれでもエージェントが
 * 一切起動しなくなっていた（setup 中でも作成済みの worktree 行から新しいスペースは開けるので、
 * エージェントの様子はそのスペースのターミナルで見られる）。
 *
 * 自動実行プリセット（`npm run dev` 等）は依存が入っている前提を置けるため、従来どおり setup の
 * 完了を待ち、setup が失敗した場合は起動しない。
 */
export async function paradisCompleteCreatedWorktree(actions: IParadisCreatedWorktreeActions): Promise<void> {
	const setup = actions.runSetup();
	// setup の失敗は下の await で呼び出し元へ投げる。それまでの間 unhandled rejection に
	// させないため、待ち始める前にハンドラを付けておく
	setup.catch(() => { });
	await actions.launchAgent();
	await setup;
	const autoRunExecuted = await actions.runAutoRun();
	if (!autoRunExecuted) {
		await actions.openDefaultTerminal();
	}
}
