/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// システム使用率のエディタのタブ（リソースを持たない、1 ウィンドウに 1 つだけの入力）。
// タイトルバーのパネルの「詳しく見る」とコマンドから開く。

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ParadisSystemUsageMachineId } from './paradisSystemUsageModel.js';

export const PARADIS_SYSTEM_USAGE_EDITOR_ID = 'paradis.editor.systemUsage';
export const PARADIS_SYSTEM_USAGE_INPUT_TYPE_ID = 'paradis.input.systemUsage';
/** エディタのタブを開くコマンド。引数に `'local'` / `'remote'` を渡すとそのマシンを選んで開く。 */
export const PARADIS_SYSTEM_USAGE_OPEN_COMMAND_ID = 'paradis.systemUsage.open';

export class ParadisSystemUsageEditorInput extends EditorInput {

	static readonly ID = PARADIS_SYSTEM_USAGE_INPUT_TYPE_ID;

	private static _instance: ParadisSystemUsageEditorInput | undefined;
	static get instance(): ParadisSystemUsageEditorInput {
		if (!ParadisSystemUsageEditorInput._instance || ParadisSystemUsageEditorInput._instance.isDisposed()) {
			ParadisSystemUsageEditorInput._instance = new ParadisSystemUsageEditorInput();
		}
		return ParadisSystemUsageEditorInput._instance;
	}

	readonly resource = URI.from({ scheme: 'paradis-system-usage', path: 'dashboard' });

	private readonly _onDidRequestMachine = this._register(new Emitter<ParadisSystemUsageMachineId>());
	/** 開き直すときに選ぶマシンを指定された（既に開いているタブへ伝える）。 */
	readonly onDidRequestMachine = this._onDidRequestMachine.event;

	private _requestedMachineId: ParadisSystemUsageMachineId | undefined;
	get requestedMachineId(): ParadisSystemUsageMachineId | undefined {
		return this._requestedMachineId;
	}

	requestMachine(machineId: ParadisSystemUsageMachineId): void {
		this._requestedMachineId = machineId;
		this._onDidRequestMachine.fire(machineId);
	}

	override get typeId(): string {
		return ParadisSystemUsageEditorInput.ID;
	}

	override get editorId(): string {
		return PARADIS_SYSTEM_USAGE_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('paradis.systemUsage.inputName', "システムの使用率");
	}

	override getIcon(): ThemeIcon {
		return Codicon.pulse;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ParadisSystemUsageEditorInput;
	}
}

/** ウィンドウを開き直してもタブを戻せるようにする。 */
export class ParadisSystemUsageEditorInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(): string {
		return '{}';
	}

	deserialize(): EditorInput {
		return ParadisSystemUsageEditorInput.instance;
	}
}
