/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「新しく開くターミナルへ渡す CODEX_HOME」を renderer の中で同期的に引ける場所。
//
// ターミナルの env は PTY を起動する直前に同期で組み立てられる（paradisPaneTokenService）ので、
// shared process へ聞きに行く暇がない。正は shared process の選択で、electron-browser 側の
// contribution（paradisCodexAccounts.contribution.ts）が変わるたびにここへ反映する。
//
// 前回の値を保存しておいて起動直後から使うことはしない。保存した後にそのホームが消えたり
// ログアウトしたりしていても、ここでは確かめられないため。shared process の返事（選んだホームが
// 今もログイン済みか確かめた結果）が届くまでに開いたターミナルは、既定のホームで開く。
//
// SSH の接続先を開いたウィンドウでは、正は接続先（REH）の選択で、値は接続先のホームのパスになる。
// 渡してよいのは接続先で動くターミナルだけ（{@link paradisTerminalRunsOnWindowHost}）。
//
// あわせて「そのペインをどのホームで開いたか」を覚える。切替後、前のアカウントのまま動いている
// Codex を数えて知らせるのに使う（知らせるのは通常の通知1回だけで、入力は止めない）。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { getRemoteAuthority } from '../../../../platform/remote/common/remoteHosts.js';
import { IShellLaunchConfig, ITerminalEnvironment } from '../../../../platform/terminal/common/terminal.js';

/** Codex がホームを決めるときに読む環境変数。 */
export const PARADIS_CODEX_HOME_ENV_VAR = 'CODEX_HOME';

/**
 * ターミナルの env へ CODEX_HOME を入れる。`launchHome` が undefined（既定のホーム）なら何もしない
 * （ユーザーが自分で設定した CODEX_HOME をそのまま効かせる）。
 */
export function paradisApplyCodexLaunchHome(env: ITerminalEnvironment | undefined, launchHome: string | undefined): ITerminalEnvironment | undefined {
	if (launchHome === undefined || launchHome.length === 0) {
		return env;
	}
	return { ...env, [PARADIS_CODEX_HOME_ENV_VAR]: launchHome };
}

/**
 * そのターミナルが、ウィンドウと同じマシン（手元のウィンドウなら手元、接続先のウィンドウなら接続先）で
 * 動くか。選択はそのマシンのホームを指すので、違うマシンで動くターミナルへは渡さない。
 *
 * どこで動くかは upstream の TerminalProcessManager と同じ規則で決める（cwd が URI ならその authority、
 * 無ければウィンドウの接続先）。
 */
export function paradisTerminalRunsOnWindowHost(cwd: IShellLaunchConfig['cwd'], windowRemoteAuthority: string | undefined): boolean {
	const terminalAuthority = cwd && typeof cwd === 'object' ? getRemoteAuthority(cwd) : windowRemoteAuthority;
	return terminalAuthority === windowRemoteAuthority;
}

/** ペインを開いたときのホーム。`known: false` は再接続などで分からないもの。 */
export interface IParadisCodexPaneHome {
	readonly known: boolean;
	/** 既定のホームで開いたときは undefined。 */
	readonly homePath?: string;
	/** shared process の選択が届く前に開いた（選んだアカウントではなく既定のホームで開いた可能性がある）。 */
	readonly beforeSync?: boolean;
}

/** 選択の反映。 */
export interface IParadisCodexLaunchHomeChange {
	readonly previous: string | undefined;
	readonly next: string | undefined;
	/** このウィンドウで初めて shared process の選択を受け取った。 */
	readonly initial: boolean;
}

export const IParadisCodexLaunchHomeService = createDecorator<IParadisCodexLaunchHomeService>('paradisCodexLaunchHomeService');

export interface IParadisCodexLaunchHomeService {
	readonly _serviceBrand: undefined;

	/** 選択を反映した（初回は値が変わらなくても1回届く）。 */
	readonly onDidChangeLaunchHome: Event<IParadisCodexLaunchHomeChange>;

	/** shared process の選択を一度でも受け取ったか。 */
	readonly synced: boolean;

	/** 新しく開くターミナルへ渡す CODEX_HOME。既定のホームなら undefined。 */
	getLaunchHome(): string | undefined;

	/** shared process の選択を反映する（electron-browser 側の contribution だけが呼ぶ）。 */
	setLaunchHome(homePath: string | undefined): void;

	/** ペイントークンごとに、開いたときのホームを覚える（paradisPaneTokenService が呼ぶ）。 */
	recordPaneHome(token: string, homePath: string | undefined): void;

	/** 覚えているホーム。 */
	getPaneHome(token: string): IParadisCodexPaneHome;

	/** 閉じたペインの記録を捨てる。 */
	forgetPaneHome(token: string): void;
}

export class ParadisCodexLaunchHomeService extends Disposable implements IParadisCodexLaunchHomeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeLaunchHome = this._register(new Emitter<IParadisCodexLaunchHomeChange>());
	readonly onDidChangeLaunchHome = this._onDidChangeLaunchHome.event;

	private launchHome: string | undefined;
	private _synced = false;
	private readonly paneHomes = new Map<string, { readonly homePath: string | undefined; readonly beforeSync: boolean }>();

	get synced(): boolean {
		return this._synced;
	}

	getLaunchHome(): string | undefined {
		return this.launchHome;
	}

	setLaunchHome(homePath: string | undefined): void {
		const next = homePath !== undefined && homePath.length > 0 ? homePath : undefined;
		const initial = !this._synced;
		if (next === this.launchHome && !initial) {
			return;
		}
		const previous = this.launchHome;
		this.launchHome = next;
		this._synced = true;
		this._onDidChangeLaunchHome.fire({ previous, next, initial });
	}

	recordPaneHome(token: string, homePath: string | undefined): void {
		this.paneHomes.set(token, { homePath, beforeSync: !this._synced });
	}

	getPaneHome(token: string): IParadisCodexPaneHome {
		const entry = this.paneHomes.get(token);
		return entry ? { known: true, homePath: entry.homePath, beforeSync: entry.beforeSync } : { known: false };
	}

	forgetPaneHome(token: string): void {
		this.paneHomes.delete(token);
	}
}

registerSingleton(IParadisCodexLaunchHomeService, ParadisCodexLaunchHomeService, InstantiationType.Delayed);
