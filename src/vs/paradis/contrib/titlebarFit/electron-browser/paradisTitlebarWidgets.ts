/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タイトルバーの左側に fork が置く部品をまとめて作る。本家の titlebarPart.ts（electron-browser）からは
// この 1 関数だけを呼ぶ（差し込みを import・フィールド・生成の 1 点ずつに抑えるため）。

import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
// import の順は titlebarPart.ts に並んでいたときのまま（部品ごとの CSS が読み込まれる順を変えないため）
import { createParadisResourceMonitorWidget } from '../../resourceMonitor/electron-browser/paradisResourceMonitorWidget.js';
import { createParadisLimitsMonitorWidget } from '../../limitsMonitor/electron-browser/paradisLimitsMonitorWidget.js';
import { createParadisServiceStatusWidget } from '../../serviceStatus/electron-browser/paradisServiceStatusWidget.js';
import { createParadisPortListWidget } from '../../portList/electron-browser/paradisPortListWidget.js';
import { createParadisTitlebarFit } from '../browser/paradisTitlebarFit.js';

/**
 * メインウィンドウのタイトルバーの左側（`leftContent`）へ、fork の状態表示を並び順どおりに足す。
 * 返り値を dispose すると、作った順に片付ける。
 */
export function createParadisTitlebarWidgets(instantiationService: IInstantiationService, rootContainer: HTMLElement, leftContent: HTMLElement): IDisposable {
	const store = new DisposableStore();
	// CPU/RAM usage indicator (Superset resource monitor port)
	store.add(createParadisResourceMonitorWidget(instantiationService, leftContent));
	// AI limits monitor (Claude/Codex rate-limit ring gauges next to the resource monitor)
	store.add(createParadisLimitsMonitorWidget(instantiationService, leftContent));
	// Claude/Codex/GitHub service status chips next to the limits monitor
	store.add(createParadisServiceStatusWidget(instantiationService, leftContent));
	// local/remote listening-port list, grouped with the other left-side status widgets instead of
	// the right side (right side ended up isolated next to the window controls depending on
	// whether actionToolBarElement existed yet).
	store.add(createParadisPortListWidget(instantiationService, leftContent));
	// fold the widgets above by the title bar's own width so they never overlap the command center
	store.add(createParadisTitlebarFit(rootContainer, leftContent));
	return store;
}
