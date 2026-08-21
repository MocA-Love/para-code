/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐が抱えているものを `PtyService` の器に載せる。**画面に出るのはここを通った後。**
//
// `createProcess` をそのまま使うのは、器の組み立て（イベントの繋ぎ、台帳への登録、終了時の
// 片付け）が一式そこにあるため。引き取り専用にもう一度書くと、**繋ぎ忘れが起きても動いては
// いる**という形で表に出ないずれ方をする。渡す引数を変えるだけで済ませる。
//
// 器ができた後は、アプリから見れば普通のターミナルと区別が付かない。復元されたものではなく、
// **止まらなかったもの**である点だけが違う。

import { ILogService } from '../../../../platform/log/common/log.js';
import { IShellLaunchConfig, ITerminalProcessOptions } from '../../../../platform/terminal/common/terminal.js';
import { IProcessEnvironment } from '../../../../base/common/platform.js';
import { IParadisPtyHost } from '../common/paradisPtyProtocol.js';
import { IParadisAdoptedTerminal, paradisAdoptTerminals } from './paradisTerminalAdoption.js';

/** 器を作れる相手。`PtyService` のうち、ここが使う部分だけ。 */
export interface IParadisAdoptionTarget {
	createProcess(
		shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		cols: number,
		rows: number,
		unicodeVersion: '6' | '11',
		env: IProcessEnvironment,
		executableEnv: IProcessEnvironment,
		options: ITerminalProcessOptions,
		shouldPersist: boolean,
		workspaceId: string,
		workspaceName: string,
		isReviving?: boolean,
		rawReviveBuffer?: string,
		paradisAdoptTarget?: { readonly handle: number; readonly pid: number; readonly title: string },
	): Promise<number>;
}

/** 預かりものから取り出せた起動時の材料。読めなければ既定へ倒す。 */
interface IParadisLaunchRemains {
	readonly shellLaunchConfig: IShellLaunchConfig;
	readonly env: IProcessEnvironment;
	readonly executableEnv: IProcessEnvironment;
	readonly options: ITerminalProcessOptions;
}

/**
 * 起動時の材料を取り出す。**取り出せなくても引き取りは続ける。**
 *
 * ここが空だと、後で「保存して復元」する際の材料が足りなくなる。それは表示の問題であって、
 * 走っているプロセスを失うのとは重みが違う。
 */
function remainsOf(adopted: IParadisAdoptedTerminal): IParadisLaunchRemains {
	const launch = adopted.metadata.launch as Partial<IParadisLaunchRemains> | undefined;
	return {
		shellLaunchConfig: launch?.shellLaunchConfig ?? { name: adopted.metadata.name ?? adopted.summary.title },
		env: launch?.env ?? {},
		executableEnv: launch?.executableEnv ?? {},
		options: launch?.options ?? {
			shellIntegration: { enabled: false, suggestEnabled: false, nonce: '' },
			windowsUseConptyDll: false,
			environmentVariableCollections: undefined,
			workspaceFolder: undefined,
			isScreenReaderOptimized: false,
		},
	};
}

export interface IParadisAdoptionOutcome {
	/** 常駐に聞けたか。**空と不明を混ぜない。** */
	readonly reachable: boolean;
	/** 器に載せられた本数。 */
	readonly adopted: number;
	/** 載せられなかった本数。**常駐にはそのまま残っている。** */
	readonly skipped: number;
}

/**
 * 常駐が抱えているものを一通り引き取って器に載せる。
 *
 * 1本ずつ独立に扱う。器を作れなかった1本のために、走っている残り全部を落とさない。
 */
export async function paradisAdoptIntoPtyService(
	ptyService: IParadisAdoptionTarget,
	host: IParadisPtyHost,
	logService: ILogService,
): Promise<IParadisAdoptionOutcome> {
	const result = await paradisAdoptTerminals(host);
	if (!result.reachable) {
		logService.warn('[ParadisPtyHost] could not ask the daemon what it holds; terminals it has are not lost, only unseen');
		return { reachable: false, adopted: 0, skipped: 0 };
	}

	let adopted = 0;
	let skipped = result.skipped;
	for (const terminal of result.adopted) {
		const remains = remainsOf(terminal);
		try {
			await ptyService.createProcess(
				{
					...remains.shellLaunchConfig,
					// 器の中の直列化に流し込まれる（`isReviving` と組で効く）。
					initialText: terminal.replay,
				},
				remains.shellLaunchConfig.cwd?.toString() ?? '',
				terminal.summary.cols,
				terminal.summary.rows,
				'11',
				remains.env,
				remains.executableEnv,
				remains.options,
				terminal.metadata.shouldPersist,
				terminal.metadata.workspaceId,
				terminal.metadata.workspaceName,
				// **この2つを渡さないと、引き取った画面が空になる。**
				//
				// `initialText` だけでは届かない。あれは `IProcessDetails` に含まれないので、
				// ウィンドウへ渡る経路に乗らない。器の中の直列化に入れるには、upstream の復元と
				// 同じ形——「復元である」と「復元の中身」——で渡す必要がある。
				//
				// 渡らないと、走っているプロセスには繋がるのに画面だけ真っ白になる。
				// 「動いてはいる」形の壊れ方で、しかも見た人は出力が無かったと読む。
				true,
				terminal.replay,
				{ handle: terminal.summary.handle, pid: terminal.summary.pid, title: terminal.summary.title },
			);
			adopted++;
		} catch (error) {
			// **常駐からは外さない。** こちらが器を作れないというだけで、走っているプロセスを
			// 畳む理由が無い。次の起動でもう一度試せる。
			logService.error(`[ParadisPtyHost] could not take over terminal ${terminal.summary.handle}`, error);
			skipped++;
		}
	}

	logService.info(`[ParadisPtyHost] took over ${adopted} terminal(s) from the daemon${skipped > 0 ? `, left ${skipped} behind` : ''}`);
	return { reachable: true, adopted, skipped };
}
