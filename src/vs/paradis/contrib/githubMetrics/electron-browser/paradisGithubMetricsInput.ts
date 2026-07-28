/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// GitHub API 利用状況ダッシュボードのシングルトン EditorInput とシリアライザ。
// ccusage ダッシュボード(paradisCcusageInput.ts)と同じ「リソースを持たないダッシュボード型」。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

export const PARADIS_GITHUB_METRICS_EDITOR_ID = 'paradis.editor.githubMetricsDashboard';
export const PARADIS_GITHUB_METRICS_INPUT_TYPE_ID = 'paradis.input.githubMetricsDashboard';

export class ParadisGithubMetricsInput extends EditorInput {

	static readonly ID = PARADIS_GITHUB_METRICS_INPUT_TYPE_ID;

	private static _instance: ParadisGithubMetricsInput | undefined;
	static get instance(): ParadisGithubMetricsInput {
		if (!ParadisGithubMetricsInput._instance || ParadisGithubMetricsInput._instance.isDisposed()) {
			ParadisGithubMetricsInput._instance = new ParadisGithubMetricsInput();
		}
		return ParadisGithubMetricsInput._instance;
	}

	readonly resource = URI.from({ scheme: 'paradis-github-metrics', path: 'dashboard' });

	override get typeId(): string {
		return ParadisGithubMetricsInput.ID;
	}

	override get editorId(): string {
		return PARADIS_GITHUB_METRICS_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('paradis.githubMetrics.inputName', "GitHub API Usage");
	}

	override getIcon(): ThemeIcon {
		return Codicon.github;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ParadisGithubMetricsInput;
	}
}

/** ウィンドウ再起動後もタブを復元できるようにするシリアライザ。 */
export class ParadisGithubMetricsInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(): string {
		return '{}';
	}

	deserialize(): EditorInput {
		return ParadisGithubMetricsInput.instance;
	}
}
