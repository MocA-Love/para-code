// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { isWidgetStoreAvailable, readWidgetFile, reloadWidgets, writeWidgetFile } from '../../modules/para-live-activity/index.js';
import { themeColorOf, useThemeColorStore } from '../ui/index.js';
import { DEFAULT_WIDGET_SETTINGS, parseWidgetSettings, serializeWidgetSettings, type WidgetSettings } from './settings.js';

/**
 * 設定 → ウィジェットの値（アプリ内の設定）。保存先は App Group の `widget-settings.json` だけで、
 * ウィジェットは同じファイルを読む（Keychain などに二重に持たない）。変えたらすぐ書いてウィジェットを描き直す。
 * 形の判定は `settings.ts`。
 */
interface WidgetSettingsState {
	readonly settings: WidgetSettings;
	readonly loaded: boolean;
}

export const useWidgetSettings = create<WidgetSettingsState>()(() => ({ settings: DEFAULT_WIDGET_SETTINGS, loaded: false }));

let loading: Promise<void> | undefined;
let writeChain: Promise<void> = Promise.resolve();

/** 保存された設定を読む（何度呼んでもよい。1回だけ読む）。 */
export function loadWidgetSettings(): Promise<void> {
	if (!isWidgetStoreAvailable()) {
		useWidgetSettings.setState({ loaded: true });
		return Promise.resolve();
	}
	loading ??= readWidgetFile('widget-settings.json').then(raw => {
		useWidgetSettings.setState({ settings: parseWidgetSettings(raw), loaded: true });
	}).catch(() => {
		loading = undefined;
		useWidgetSettings.setState({ loaded: true });
	});
	return loading;
}

function themePrimaryHex(): string {
	return themeColorOf(useThemeColorStore.getState().settings, 'primary');
}

/** いまの設定を App Group へ書き、ウィジェットを描き直させる。 */
export function persistWidgetSettings(settings: WidgetSettings = useWidgetSettings.getState().settings): Promise<void> {
	if (!isWidgetStoreAvailable()) {
		return Promise.resolve();
	}
	const json = serializeWidgetSettings(settings, themePrimaryHex());
	const run = writeChain.then(() => writeWidgetFile('widget-settings.json', json)).then(() => reloadWidgets());
	writeChain = run.catch(() => undefined);
	return run;
}

/** 設定を変える。画面にはすぐ当たり、保存に失敗したら reject。 */
export function updateWidgetSettings(next: WidgetSettings): Promise<void> {
	useWidgetSettings.setState({ settings: next });
	return persistWidgetSettings(next);
}

let themeWatchStarted = false;

/**
 * 「主ボタンの色に合わせる」を選んでいるとき、設定 → 色で主ボタンの色を変えたらウィジェットにも書き直す。
 * 起動時に1回呼ぶ（何度呼んでも1回だけ始まる）。
 */
export function startWidgetThemeWatch(): void {
	if (themeWatchStarted) {
		return;
	}
	themeWatchStarted = true;
	let last = themePrimaryHex();
	useThemeColorStore.subscribe(() => {
		const next = themePrimaryHex();
		if (next === last) {
			return;
		}
		last = next;
		if (useWidgetSettings.getState().loaded && useWidgetSettings.getState().settings.accent === 'theme') {
			void persistWidgetSettings().catch(() => undefined);
		}
	});
}
