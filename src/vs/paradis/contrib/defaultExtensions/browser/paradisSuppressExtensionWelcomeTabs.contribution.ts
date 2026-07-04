/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 既定拡張の初回アクティベーション時に自動で開く「Welcome」webview タブを、一度だけ自動で閉じる。
//
// 対象は「無効化する設定が拡張側に存在しない」もののみ（設定があるものは
// paradisDefaultSettings.contribution.ts の既定値で抑止している）:
// - fill-labs.dependi: 初回インストール時に 'welcomeDependi'（Welcome to Dependi）を無条件で開く
// - denoland.vscode-deno: 初回アクティベーション時に 'welcomeDeno'（Deno for VSCode）を開く
//
// 「一度だけ」: 各 viewType につき初回に見えた1回だけ閉じ、以後は一切触らない。拡張は自前の
// globalState（初回表示済みフラグ）を初回オープン時に立てるため、以降は自動では開かなくなり、
// ユーザーがコマンド（例: Deno: Welcome）で明示的に開いた場合はそのまま表示される。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { WebviewInput } from '../../../../workbench/contrib/webviewPanel/browser/webviewEditorInput.js';

/** 自動クローズ対象の拡張webviewのviewType（拡張が createWebviewPanel に渡す生のID）。 */
const SUPPRESSED_VIEW_TYPES: readonly string[] = [
	'welcomeDependi',
	'welcomeDeno',
];

/** WebviewInput.viewType は 'mainThreadWebview-' が前置された形で保持される（mainThreadWebviewPanels.ts）。 */
const WEBVIEW_VIEW_TYPE_PREFIX = 'mainThreadWebview-';

const SUPPRESSED_STORAGE_KEY = 'paradis.defaultExtensions.suppressedWelcomeTabs';

class ParadisSuppressExtensionWelcomeTabsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisSuppressExtensionWelcomeTabs';

	private readonly suppressed: Set<string>;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.suppressed = this.readSuppressed();
		if (SUPPRESSED_VIEW_TYPES.every(viewType => this.suppressed.has(viewType))) {
			return; // 全対象を処理済み。以後このcontributionは何もしない
		}

		this.closeSuppressedEditors();
		this._register(this.editorService.onDidEditorsChange(() => this.closeSuppressedEditors()));
	}

	private readSuppressed(): Set<string> {
		try {
			return new Set<string>(JSON.parse(this.storageService.get(SUPPRESSED_STORAGE_KEY, StorageScope.APPLICATION, '[]')));
		} catch {
			return new Set<string>();
		}
	}

	private closeSuppressedEditors(): void {
		let changed = false;
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				if (!(editor instanceof WebviewInput)) {
					continue;
				}
				const rawViewType = editor.viewType.startsWith(WEBVIEW_VIEW_TYPE_PREFIX) ? editor.viewType.slice(WEBVIEW_VIEW_TYPE_PREFIX.length) : editor.viewType;
				if (!SUPPRESSED_VIEW_TYPES.includes(rawViewType) || this.suppressed.has(rawViewType)) {
					continue;
				}
				this.suppressed.add(rawViewType);
				changed = true;
				group.closeEditor(editor, { preserveFocus: true });
			}
		}
		if (changed) {
			this.storageService.store(SUPPRESSED_STORAGE_KEY, JSON.stringify([...this.suppressed]), StorageScope.APPLICATION, StorageTarget.MACHINE);
			if (SUPPRESSED_VIEW_TYPES.every(viewType => this.suppressed.has(viewType))) {
				this.dispose(); // 全対象を処理済み。以後のエディタ変更の走査を止める
			}
		}
	}
}

registerWorkbenchContribution2(ParadisSuppressExtensionWelcomeTabsContribution.ID, ParadisSuppressExtensionWelcomeTabsContribution, WorkbenchPhase.AfterRestored);
