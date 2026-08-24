/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// upstream既定の terminal.integrated.wordSeparators（ダブルクリック単語選択とフォールバックの
// 'word' リンク検出の両方に使われる）は全角の括弧・引用符・句読点を含んでいない。CLIエージェント
// (Claude Code/Codex等)がターミナルに出す `hogehoge.com（PR3939)` のような出力では、URL自体は
// LinkComputer が正しく `hogehoge.com` で切れる（linkComputer.ts の FORCE_TERMINATION_CHARACTERS が
// 全角括弧等を含むため）。しかし TerminalWordLinkDetector 側の単語区切りにはそれらが入っていないため
// `hogehoge.com（PR3939` を1単語として拾ってしまい、URLの範囲外にカーソルがあると
// そちらの(検索用の)フォールバックリンクがハイライトされる非対称な見え方になる。
//
// 追加する文字は linkComputer.ts の FORCE_TERMINATION_CHARACTERS のうち wordSeparators の既定値に
// 無い全角文字だけに絞っている(【】等、LinkComputer側で終端記号として扱われない文字を足しても
// リンク当たり判定の是正には効かないため)。
//
// upstreamのデフォルト設定オブジェクトは改変せず、"default" 設定レイヤーへの注入
// (registerDefaultConfigurations) で追加する。ベースはハードコードせず configurationRegistry に
// 実際に登録されている upstream 既定値を読む — upstream が既定値を変更しても追従できるようにするため
// (読めない場合のみ、現行 upstream 既定値と同じ内容のフォールバック文字列を使う)。

import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TerminalSettingId } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { type ParadisDiagnosticReporter, reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

// Fallback mirroring upstream's current default (terminalConfiguration.ts), used only if the
// property isn't registered yet for some reason.
// allow-any-unicode-next-line
const paradisUpstreamWordSeparatorsFallback = ' ()[]{}\',"`─‘’“”|';
const paradisUpstreamWordSeparators = configurationRegistry.getConfigurationProperties()[TerminalSettingId.WordSeparators]?.default;
const paradisBaseWordSeparators = typeof paradisUpstreamWordSeparators === 'string' ? paradisUpstreamWordSeparators : paradisUpstreamWordSeparatorsFallback;

// Subset of linkComputer.ts's FORCE_TERMINATION_CHARACTERS not already covered above.
// allow-any-unicode-next-line
const paradisFullWidthWordSeparators = '、。｡､，．：；〈「『〔（［｛｢｣｝］）〕』」〉｀～…';

configurationRegistry.registerDefaultConfigurations([{
	overrides: {
		[TerminalSettingId.WordSeparators]: paradisBaseWordSeparators + paradisFullWidthWordSeparators
	}
}]);

export function reportParadisTerminalWordSeparatorsDefault(
	defaultValue: unknown,
	report: ParadisDiagnosticReporter = reportParadisDiagnosticError,
): void {
	if (typeof defaultValue === 'string') {
		return;
	}
	report(
		'owned',
		'terminal-word-separators',
		'default-missing',
		new Error('terminal.integrated.wordSeparators default was not found in the configuration registry'),
	);
}

export class ParadisTerminalWordSeparatorsDiagnosticsContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalWordSeparatorsDiagnostics';

	constructor() {
		reportParadisTerminalWordSeparatorsDefault(paradisUpstreamWordSeparators);
	}
}

type ParadisTerminalWordSeparatorsDiagnosticsRegistrar = (
	id: string,
	ctor: typeof ParadisTerminalWordSeparatorsDiagnosticsContribution,
	phase: WorkbenchPhase,
) => void;

export function registerParadisTerminalWordSeparatorsDiagnosticsContribution(
	register: ParadisTerminalWordSeparatorsDiagnosticsRegistrar = registerWorkbenchContribution2,
): void {
	register(
		ParadisTerminalWordSeparatorsDiagnosticsContribution.ID,
		ParadisTerminalWordSeparatorsDiagnosticsContribution,
		WorkbenchPhase.AfterRestored,
	);
}

let paradisTerminalWordSeparatorsDiagnosticsContributionInitialized = false;

export function initializeParadisTerminalWordSeparatorsDiagnosticsContribution(
	register: ParadisTerminalWordSeparatorsDiagnosticsRegistrar = registerWorkbenchContribution2,
): void {
	if (paradisTerminalWordSeparatorsDiagnosticsContributionInitialized) {
		throw new Error('Paradis terminal word separators diagnostics contribution is already initialized');
	}
	registerParadisTerminalWordSeparatorsDiagnosticsContribution(register);
	paradisTerminalWordSeparatorsDiagnosticsContributionInitialized = true;
}

initializeParadisTerminalWordSeparatorsDiagnosticsContribution();
