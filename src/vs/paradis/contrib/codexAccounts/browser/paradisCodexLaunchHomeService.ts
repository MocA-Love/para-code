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
// contribution（paradisCodexAccounts.contribution.ts）が変わるたびにここへ反映する。起動直後に
// 反映が間に合わないターミナルのため、最後の値をアプリ全体の保存領域にも控えておく。
//
// あわせて「そのペインをどのホームで開いたか」を覚える。切替後、前のアカウントのまま動いている
// Codex を数えて知らせるのに使う（q.html Q06）。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITerminalEnvironment } from '../../../../platform/terminal/common/terminal.js';

/** Codex がホームを決めるときに読む環境変数。 */
export const PARADIS_CODEX_HOME_ENV_VAR = 'CODEX_HOME';

const LAUNCH_HOME_STORAGE_KEY = 'paradis.codexAccounts.launchHome';

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

/** ペインを開いたときのホーム。`known: false` は再接続などで分からないもの。 */
export interface IParadisCodexPaneHome {
	readonly known: boolean;
	/** 既定のホームで開いたときは undefined。 */
	readonly homePath?: string;
}

export const IParadisCodexLaunchHomeService = createDecorator<IParadisCodexLaunchHomeService>('paradisCodexLaunchHomeService');

export interface IParadisCodexLaunchHomeService {
	readonly _serviceBrand: undefined;

	/** 選択が変わった。 */
	readonly onDidChangeLaunchHome: Event<void>;

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

	private readonly _onDidChangeLaunchHome = this._register(new Emitter<void>());
	readonly onDidChangeLaunchHome = this._onDidChangeLaunchHome.event;

	private launchHome: string | undefined;
	private readonly paneHomes = new Map<string, string | undefined>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		const stored = this.storageService.get(LAUNCH_HOME_STORAGE_KEY, StorageScope.APPLICATION);
		this.launchHome = stored !== undefined && stored.length > 0 ? stored : undefined;
	}

	getLaunchHome(): string | undefined {
		return this.launchHome;
	}

	setLaunchHome(homePath: string | undefined): void {
		const next = homePath !== undefined && homePath.length > 0 ? homePath : undefined;
		if (next === this.launchHome) {
			return;
		}
		this.launchHome = next;
		if (next === undefined) {
			this.storageService.remove(LAUNCH_HOME_STORAGE_KEY, StorageScope.APPLICATION);
		} else {
			this.storageService.store(LAUNCH_HOME_STORAGE_KEY, next, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		this._onDidChangeLaunchHome.fire();
	}

	recordPaneHome(token: string, homePath: string | undefined): void {
		this.paneHomes.set(token, homePath);
	}

	getPaneHome(token: string): IParadisCodexPaneHome {
		return this.paneHomes.has(token) ? { known: true, homePath: this.paneHomes.get(token) } : { known: false };
	}

	forgetPaneHome(token: string): void {
		this.paneHomes.delete(token);
	}
}

registerSingleton(IParadisCodexLaunchHomeService, ParadisCodexLaunchHomeService, InstantiationType.Delayed);
