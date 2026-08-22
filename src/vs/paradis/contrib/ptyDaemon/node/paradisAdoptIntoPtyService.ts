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
import { ISetTerminalLayoutInfoArgs } from '../../../../platform/terminal/common/terminalProcess.js';
import { paradisDecodeLayout } from './paradisTerminalLayout.js';
import { IParadisAdoptTarget } from './paradisTerminalProcessFactory.js';

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
		paradisAdoptTarget?: IParadisAdoptTarget,
	): Promise<number>;
	setTerminalLayoutInfo(args: ISetTerminalLayoutInfoArgs): Promise<void>;
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
	// **名前を必ず付ける。** 器は「一度も触られていない」端末を、窓のリロード時に畳んでよいものと
	// 見なす。引き取った端末は誰も打鍵していないのでそのままだと該当し、**ビルドを眺めていた
	// だけの端末がリロードで死ぬ**。名前が付いていれば器の側で触られた扱いになる。
	const name = adopted.metadata.name || adopted.summary.title || 'terminal';
	return {
		shellLaunchConfig: { ...(launch?.shellLaunchConfig ?? {}), name },
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

/**
 * 起動時の場所を文字列にする。
 *
 * **`toString()` では足りない。** 預かりものは JSON を往復しているので、`URI` だったものは
 * ただのオブジェクトに戻っており、`toString()` は `[object Object]` になる。それがそのまま
 * 「起動時の場所」として画面へ出る。
 */
function paradisCwdOf(cwd: unknown): string {
	if (typeof cwd === 'string') {
		return cwd;
	}
	const revived = cwd as { path?: unknown } | undefined;
	return typeof revived?.path === 'string' ? revived.path : '';
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
	/** 常駐側の handle と、こちら側で振り直した番号の対応。配置を戻すのに要る。 */
	const idByHandle = new Map<number, number>();
	for (const terminal of result.adopted) {
		const remains = remainsOf(terminal);
		try {
			const id = await ptyService.createProcess(
				remains.shellLaunchConfig,
				paradisCwdOf(remains.shellLaunchConfig.cwd),
				terminal.summary.cols,
				terminal.summary.rows,
				'11',
				remains.env,
				remains.executableEnv,
				remains.options,
				terminal.metadata.shouldPersist,
				terminal.metadata.workspaceId,
				terminal.metadata.workspaceName,
				// 復元ではない。**走っているものに繋ぎ直す**ので、画面は繋いだときに常駐から
				// そのまま流れてくる（器の直列化はそれを受けて埋まる）。
				undefined,
				undefined,
				{
					handle: terminal.summary.handle,
					pid: terminal.summary.pid,
					title: terminal.summary.title,
					exited: terminal.summary.alive ? undefined : { code: terminal.summary.exitCode },
				},
			);
			// handle の登録は器の `adopt()` が行う（起こす経路と同じ道を通る）。
			idByHandle.set(terminal.summary.handle, id);
			adopted++;
		} catch (error) {
			// **常駐からは外さない。** こちらが器を作れないというだけで、走っているプロセスを
			// 畳む理由が無い。次の起動でもう一度試せる。
			logService.error(`[ParadisPtyHost] could not take over terminal ${terminal.summary.handle}`, error);
			skipped++;
		}
	}

	// **配置を戻すまでが引き取り。** 戻さないと、器はできているのに窓が繋ぎに来ないので、
	// 走っているプロセスはあるのに画面には何も出ない。
	await paradisRestoreLayouts(ptyService, host, result.adopted, idByHandle, logService);

	logService.info(`[ParadisPtyHost] took over ${adopted} terminal(s) from the daemon${skipped > 0 ? `, left ${skipped} behind` : ''}`);
	return { reachable: true, adopted, skipped };
}

/**
 * 預けておいた配置を、新しい番号で戻す。
 *
 * スペースごとに1回。読めなかったものは黙って飛ばす——配置は作り直せるが、走っている
 * プロセスは作り直せないので、ここで諦めて全体を落とさない。
 */
async function paradisRestoreLayouts(
	ptyService: IParadisAdoptionTarget,
	host: IParadisPtyHost,
	adopted: readonly IParadisAdoptedTerminal[],
	idByHandle: Map<number, number>,
	logService: ILogService,
): Promise<void> {
	const workspaces = new Set(adopted.map(terminal => terminal.metadata.workspaceId).filter(id => id.length > 0));
	for (const workspaceId of workspaces) {
		try {
			const raw = await host.getLayout(workspaceId);
			const layout = raw === undefined ? undefined : paradisDecodeLayout(raw, handle => idByHandle.get(handle));
			if (layout) {
				await ptyService.setTerminalLayoutInfo(layout);
			}
		} catch (error) {
			logService.warn(`[ParadisPtyHost] could not restore the layout for ${workspaceId}`, error);
		}
	}
}
