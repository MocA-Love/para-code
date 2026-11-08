/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータのタブの名前に、その端末を割り当てたターミナルの名前を添える（q.html Q582 の画面案 2）。
//
// タブは「どの端末を映すか」だけを持ち、「どのペインが操作してよいか」は持たない。名前に出すのは、台帳
// （shared process の Mobile Canvas の台帳、renderer では IParadisMobileCanvasModel）を端末の id で引いて得た
// ペインのトークンから、そのターミナルの名前を出しているだけ。台帳は、シミュレータのタブが見えている間だけ
// 定期的に読み直す（端末の一覧を取るので、見えているタブが無ければ読まない。隠れたタブの名前は、ほかのきっかけ
// （共有ダイアログ・ターミナルの名前の変化）で読み直した値と、次に見えたときの読み直しで直る）。

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisMobileCanvasModel } from '../../mobileCanvas/electron-browser/paradisMobileCanvasModel.js';
import { ParadisSimulatorEditorInput, paradisSimulatorAssignedTerminals } from './paradisSimulatorEditorInput.js';

class ParadisSimulatorTabLabelsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisSimulatorTabLabels';

	private readonly _polling = this._register(new MutableDisposable());

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IParadisMobileCanvasModel private readonly _model: IParadisMobileCanvasModel,
		@IParadisPaneTokenService private readonly _paneTokens: IParadisPaneTokenService,
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
		super();
		this._register(this._editorService.onDidEditorsChange(() => this._update()));
		this._register(this._editorService.onDidVisibleEditorsChange(() => this._update()));
		this._register(this._model.onDidChange(() => this._update()));
		this._register(this._terminalService.onAnyInstanceTitleChange(() => this._update()));
		this._register(this._terminalService.onDidChangeInstances(() => this._update()));
		this._update();
	}

	private _simulatorInputs(): ParadisSimulatorEditorInput[] {
		return this._editorService.editors.filter((editor): editor is ParadisSimulatorEditorInput => editor instanceof ParadisSimulatorEditorInput);
	}

	private _update(): void {
		const inputs = this._simulatorInputs();
		const visible = this._editorService.visibleEditors.some(editor => editor instanceof ParadisSimulatorEditorInput);
		if (!visible) {
			this._polling.clear();
		} else if (!this._polling.value) {
			this._polling.value = this._model.beginPolling();
		}
		if (inputs.length === 0) {
			return;
		}
		const terminalName = (paneToken: string) => {
			const instanceId = this._paneTokens.getInstanceForToken(paneToken);
			return instanceId === undefined ? undefined : this._terminalService.getInstanceFromId(instanceId)?.title;
		};
		for (const input of inputs) {
			input.setAssignedTerminals(paradisSimulatorAssignedTerminals(input.udid, this._model.snapshot.attachments, terminalName));
		}
	}
}

registerWorkbenchContribution2(ParadisSimulatorTabLabelsContribution.ID, ParadisSimulatorTabLabelsContribution, WorkbenchPhase.AfterRestored);
