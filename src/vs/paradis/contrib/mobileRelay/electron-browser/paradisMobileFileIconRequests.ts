/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホのファイルの一覧のアイコン（fs.icon-theme.v1）。PC で選んでいるファイルアイコンのテーマ
// （`workbench.iconTheme`）の対応表と SVG をそのまま渡す。
//
// - fs の `iconTheme` {ifRevision?}: 対応表（`paradisMobileFileIconTheme.ts`）と版を返す。版が同じなら `notModified`
// - fs の `iconSvgs` {revision, ids}: 頼まれたアイコンの SVG を返す。版が違えば `stale`（アプリは対応表から取り直す）
// - 返したモバイルを 10 分の購読として覚え、テーマが変わったら `{ t: 'iconThemeChanged' }` を送る
//
// テーマの JSON と SVG は、PC がエクスプローラーで使うのと同じく `IExtensionResourceLoaderService` で読む
// （SSH 接続中に接続先へ入った拡張のテーマでも、PC のテーマの読み込みと同じ経路で読める）。

import * as json from '../../../../base/common/json.js';
import { DisposableStore, markAsSingleton } from '../../../../base/common/lifecycle.js';
import * as resources from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IWorkbenchFileIconTheme, IWorkbenchThemeService } from '../../../../workbench/services/themes/common/workbenchThemeService.js';
import {
	IParadisMobileIconThemeManifest,
	PARADIS_MOBILE_ICON_SVG_REQUEST_LIMIT,
	PARADIS_MOBILE_ICON_SVG_RESPONSE_BUDGET,
	paradisBuildMobileIconThemeManifest,
	paradisMobileIconThemeRevision,
	paradisSanitizeMobileIconSvg,
} from '../common/paradisMobileFileIconTheme.js';
import { registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/** 変更を知らせ続ける時間（ms）。アプリはファイルの一覧を開くたびに版を確かめ直す。 */
const SUBSCRIPTION_TTL_MS = 10 * 60_000;

interface ILoadedIconTheme {
	readonly themeId: string;
	readonly revision: string;
	readonly label: string;
	readonly manifest: IParadisMobileIconThemeManifest | undefined;
	/** テーマの JSON のあるフォルダー（SVG の相対パスの基準）。 */
	readonly base: URI | undefined;
	readonly svgPaths: ReadonlyMap<string, string>;
	readonly svgCache: Map<string, Promise<string | undefined>>;
}

/** いま選んでいるテーマの読み込み結果（テーマが変わったら捨てる）。 */
let loaded: { readonly key: string; readonly value: Promise<ILoadedIconTheme> } | undefined;
const subscribers = new Map<string, { expiresAt: number; push: (body: { readonly t: string }) => void }>();
/** テーマの変化の購読。ウィンドウ（Renderer）を閉じるときに、購読者・読み込み結果と一緒に外す。 */
let changeListener: { readonly service: IWorkbenchThemeService; readonly store: DisposableStore } | undefined;

function release(): void {
	changeListener?.store.dispose();
	changeListener = undefined;
	subscribers.clear();
	loaded = undefined;
}

function notifySubscribers(): void {
	loaded = undefined;
	const now = Date.now();
	for (const [mobileId, subscriber] of subscribers) {
		if (subscriber.expiresAt < now) {
			subscribers.delete(mobileId);
		} else {
			subscriber.push({ t: 'iconThemeChanged' });
		}
	}
}

function subscribe(themeService: IWorkbenchThemeService, lifecycleService: ILifecycleService, mobileId: string | undefined, push: (body: { readonly t: string }) => void): void {
	// サービスはウィンドウと同じ寿命のシングルトンなので、最初の要求で 1 回だけ購読し、ウィンドウを閉じるときに外す
	if (changeListener?.service !== themeService) {
		release();
		const store = markAsSingleton(new DisposableStore());
		store.add(themeService.onDidFileIconThemeChange(notifySubscribers));
		store.add(lifecycleService.onWillShutdown(release));
		changeListener = { service: themeService, store };
	}
	if (mobileId !== undefined) {
		subscribers.set(mobileId, { expiresAt: Date.now() + SUBSCRIPTION_TTL_MS, push });
	}
}

function unsupported(themeId: string, label: string): ILoadedIconTheme {
	return { themeId, label, revision: `unsupported:${themeId}`, manifest: undefined, base: undefined, svgPaths: new Map(), svgCache: new Map() };
}

async function loadIconTheme(
	theme: IWorkbenchFileIconTheme,
	extensionService: IExtensionService,
	resourceLoader: IExtensionResourceLoaderService,
	languageService: ILanguageService,
): Promise<ILoadedIconTheme> {
	const themeId = theme.settingsId ?? '';
	if (theme.settingsId === null || theme.extensionData === undefined) {
		return unsupported(themeId, theme.label);
	}
	const extension = await extensionService.getExtension(theme.extensionData.extensionId);
	// 拡張の宣言の型（ITheme）は label しか持たないので、id と path は形を確かめて読む
	const contribution = (extension?.contributes?.iconThemes as unknown as readonly { readonly id?: unknown; readonly path?: unknown }[] | undefined)
		?.find(candidate => candidate.id === theme.settingsId);
	if (extension === undefined || typeof contribution?.path !== 'string') {
		return unsupported(themeId, theme.label);
	}
	const location = resources.joinPath(extension.extensionLocation, contribution.path);
	const errors: json.ParseError[] = [];
	const document = json.parse(await resourceLoader.readExtensionResource(location), errors);
	if (errors.length > 0) {
		return unsupported(themeId, theme.label);
	}
	const build = paradisBuildMobileIconThemeManifest(document, {
		extensions: languageId => languageService.getExtensions(languageId),
		filenames: languageId => languageService.getFilenames(languageId),
	});
	if (!build.supported) {
		return unsupported(themeId, theme.label);
	}
	return {
		themeId,
		label: theme.label,
		revision: paradisMobileIconThemeRevision(themeId, extension.version, build.manifest),
		manifest: build.manifest,
		base: resources.dirname(location),
		svgPaths: build.svgPaths,
		svgCache: new Map(),
	};
}

/** いまのテーマの読み込み結果（同じテーマなら 1 回だけ読む。失敗したら次の要求で読み直す）。 */
function currentIconTheme(themeService: IWorkbenchThemeService, extensionService: IExtensionService, resourceLoader: IExtensionResourceLoaderService, languageService: ILanguageService): Promise<ILoadedIconTheme> {
	const theme = themeService.getFileIconTheme();
	const key = `${theme.id}\u0000${theme.settingsId ?? ''}`;
	if (loaded?.key !== key) {
		const value = loadIconTheme(theme, extensionService, resourceLoader, languageService);
		const entry = { key, value };
		loaded = entry;
		value.catch(() => {
			if (loaded === entry) {
				loaded = undefined;
			}
		});
	}
	return loaded.value;
}

function readSvg(resourceLoader: IExtensionResourceLoaderService, theme: ILoadedIconTheme, id: string): Promise<string | undefined> {
	const path = theme.svgPaths.get(id);
	const base = theme.base;
	if (path === undefined || base === undefined) {
		// 対応表に無い ID は覚えない（アプリが送る任意の文字列でキャッシュを膨らませない）
		return Promise.resolve(undefined);
	}
	let pending = theme.svgCache.get(id);
	if (pending === undefined) {
		const reading = resourceLoader.readExtensionResource(resources.joinPath(base, path)).then(paradisSanitizeMobileIconSvg, () => {
			// 読めなかったものは覚えない（次の要求で読み直す）
			theme.svgCache.delete(id);
			return undefined;
		});
		pending = reading;
		theme.svgCache.set(id, reading);
	}
	return pending;
}

registerParadisMobileRequestHandler('fs', 'iconTheme', {
	async handle(accessor, request, context) {
		const themeService = accessor.get(IWorkbenchThemeService);
		const extensionService = accessor.get(IExtensionService);
		const resourceLoader = accessor.get(IExtensionResourceLoaderService);
		const languageService = accessor.get(ILanguageService);
		subscribe(themeService, accessor.get(ILifecycleService), context.mobileId, body => context.push(body));
		const theme = await currentIconTheme(themeService, extensionService, resourceLoader, languageService);
		if (typeof request.ifRevision === 'string' && request.ifRevision === theme.revision) {
			context.reply({ t: 'iconTheme', themeId: theme.themeId, revision: theme.revision, notModified: true });
			return;
		}
		context.reply({
			t: 'iconTheme',
			themeId: theme.themeId,
			label: theme.label,
			revision: theme.revision,
			supported: theme.manifest !== undefined,
			...(theme.manifest !== undefined ? { manifest: theme.manifest } : {}),
		});
	},
});

registerParadisMobileRequestHandler('fs', 'iconSvgs', {
	async handle(accessor, request, context) {
		const themeService = accessor.get(IWorkbenchThemeService);
		const extensionService = accessor.get(IExtensionService);
		const resourceLoader = accessor.get(IExtensionResourceLoaderService);
		const languageService = accessor.get(ILanguageService);
		const ids = Array.isArray(request.ids) ? request.ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256) : [];
		if (ids.length > PARADIS_MOBILE_ICON_SVG_REQUEST_LIMIT) {
			context.reply({ error: `too many icons (${ids.length} > ${PARADIS_MOBILE_ICON_SVG_REQUEST_LIMIT})` });
			return;
		}
		const theme = await currentIconTheme(themeService, extensionService, resourceLoader, languageService);
		if (request.revision !== theme.revision) {
			context.reply({ t: 'iconSvgs', revision: theme.revision, stale: true, svgs: {}, missing: [] });
			return;
		}
		const svgs: Record<string, string> = {};
		const missing: string[] = [];
		let budget = PARADIS_MOBILE_ICON_SVG_RESPONSE_BUDGET;
		for (const id of new Set(ids)) {
			if (budget <= 0) {
				// 入り切らない分は svgs にも missing にも入れない（アプリが次の要求で頼み直す）
				break;
			}
			const svg = await readSvg(resourceLoader, theme, id);
			if (svg === undefined) {
				missing.push(id);
			} else {
				svgs[id] = svg;
				budget -= svg.length;
			}
		}
		context.reply({ t: 'iconSvgs', revision: theme.revision, svgs, missing });
	},
});
