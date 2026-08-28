/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { PolicyCategory } from '../../../../base/common/policy.js';
import { localize } from '../../../../nls.js';
import type { IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, type IConfigurationPropertySchema } from '../../../../platform/configuration/common/configurationRegistry.js';

export const PARADIS_OFFICE_FEATURE_EXCEL_VIEW = 1 << 0;
export const PARADIS_OFFICE_FEATURE_EXCEL_DIFF = 1 << 1;
export const PARADIS_OFFICE_FEATURE_WORD_VIEW = 1 << 2;
export const PARADIS_OFFICE_FEATURE_WORD_DIFF = 1 << 3;
export const PARADIS_OFFICE_ALL_FEATURES = PARADIS_OFFICE_FEATURE_EXCEL_VIEW
	| PARADIS_OFFICE_FEATURE_EXCEL_DIFF
	| PARADIS_OFFICE_FEATURE_WORD_VIEW
	| PARADIS_OFFICE_FEATURE_WORD_DIFF;

export type ParadisOfficeProtocolVersion = 0 | 1;
export type ParadisOfficeClientPlatform = 'desktop' | 'mobile' | 'web';
export type ParadisOfficeBackendKind = 'local' | 'remote' | 'mobileHost' | 'webWorker';

export type ParadisOfficeClientAdvertisement =
	| { readonly version: 0; readonly platform: Exclude<ParadisOfficeClientPlatform, 'web'> }
	| { readonly version: 1; readonly platform: ParadisOfficeClientPlatform; readonly featureBits: number };

export type ParadisOfficeBackendAdvertisement =
	| { readonly version: 0; readonly kind: Exclude<ParadisOfficeBackendKind, 'webWorker'>; readonly available: boolean }
	| { readonly version: 1; readonly kind: ParadisOfficeBackendKind; readonly available: boolean; readonly featureBits: number };

export interface ParadisOfficeCapabilityHandshake {
	readonly client: ParadisOfficeClientAdvertisement;
	readonly backend: ParadisOfficeBackendAdvertisement;
	readonly localSpoolAvailable?: boolean;
}

export type ParadisOfficeFeatureSupport =
	| 'semantic'
	| 'legacy'
	| 'legacyRelay'
	| 'hostSemantic'
	| 'nativeBasic'
	| 'nativeWithHostDiagnostics'
	| 'diagnostic'
	| 'explicitFallback';

export interface ParadisOfficeCapabilitySet {
	readonly version: ParadisOfficeProtocolVersion;
	readonly route: 'legacyChannel' | 'boundedLocalSpool' | 'localV1' | 'remoteV1' | 'mobileRelayV0' | 'mobileRelayV1' | 'webWorkerV1' | 'diagnostic';
	readonly quality: 'legacy' | 'complete' | 'degraded' | 'blocked';
	readonly semanticCompleteness: boolean;
	readonly features: {
		readonly excelView: ParadisOfficeFeatureSupport;
		readonly excelDiff: ParadisOfficeFeatureSupport;
		readonly wordView: ParadisOfficeFeatureSupport;
		readonly wordDiff: ParadisOfficeFeatureSupport;
	};
	readonly warnings: readonly string[];
}

interface DataRecord {
	readonly values: Readonly<Record<string, unknown>>;
	readonly keys: ReadonlySet<string>;
}

function sameKeys(first: readonly string[], second: readonly PropertyKey[]): boolean {
	return first.length === second.length && second.every((key, index) => key === first[index]);
}

function sameDataDescriptor(first: PropertyDescriptor | undefined, second: PropertyDescriptor | undefined): first is PropertyDescriptor & { readonly value: unknown } {
	return !!first && !!second && first.enumerable === true && second.enumerable === true
		&& Object.prototype.hasOwnProperty.call(first, 'value')
		&& Object.prototype.hasOwnProperty.call(second, 'value')
		&& first.configurable === second.configurable
		&& first.writable === second.writable
		&& Object.is(first.value, second.value);
}

function dataRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): DataRecord | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			return undefined;
		}
		const allowed = new Set([...required, ...optional]);
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.length > allowed.size || ownKeys.some(key => typeof key !== 'string' || !allowed.has(key))) {
			return undefined;
		}
		const keys = ownKeys as string[];
		if (required.some(key => !keys.includes(key))) {
			return undefined;
		}
		const result: Record<string, unknown> = Object.create(null);
		for (const key of keys) {
			const firstDescriptor = Object.getOwnPropertyDescriptor(value, key);
			const secondDescriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!sameDataDescriptor(firstDescriptor, secondDescriptor)) {
				return undefined;
			}
			result[key] = firstDescriptor.value;
		}
		if (!sameKeys(keys, Reflect.ownKeys(value))) {
			return undefined;
		}
		return { values: result, keys: new Set(keys) };
	} catch {
		return undefined;
	}
}

function blockedCapabilities(version: ParadisOfficeProtocolVersion, warning: string): ParadisOfficeCapabilitySet {
	return {
		version,
		route: 'diagnostic',
		quality: 'blocked',
		semanticCompleteness: false,
		features: { excelView: 'diagnostic', excelDiff: 'explicitFallback', wordView: 'diagnostic', wordDiff: 'explicitFallback' },
		warnings: [warning],
	};
}

function invalidCapabilities(warning = 'office.capability.invalidHandshake'): ParadisOfficeCapabilitySet {
	return blockedCapabilities(0, warning);
}

function legacyDesktop(quality: 'legacy' | 'degraded', warning?: string, route: 'legacyChannel' | 'boundedLocalSpool' = 'legacyChannel'): ParadisOfficeCapabilitySet {
	return {
		version: 0,
		route,
		quality,
		semanticCompleteness: false,
		features: { excelView: 'legacy', excelDiff: 'legacy', wordView: 'legacy', wordDiff: 'legacy' },
		warnings: warning ? [warning] : [],
	};
}

function legacyMobile(quality: 'legacy' | 'degraded', warning?: string): ParadisOfficeCapabilitySet {
	return {
		version: 0,
		route: 'mobileRelayV0',
		quality,
		semanticCompleteness: false,
		features: { excelView: 'legacyRelay', excelDiff: 'legacyRelay', wordView: 'nativeBasic', wordDiff: 'explicitFallback' },
		warnings: warning ? [warning] : [],
	};
}

function supports(featureBits: number, feature: number): boolean {
	return (featureBits & feature) === feature;
}

function semanticFeatures(featureBits: number, host: boolean): ParadisOfficeCapabilitySet['features'] {
	return {
		excelView: supports(featureBits, PARADIS_OFFICE_FEATURE_EXCEL_VIEW) ? (host ? 'hostSemantic' : 'semantic') : 'diagnostic',
		excelDiff: supports(featureBits, PARADIS_OFFICE_FEATURE_EXCEL_DIFF) ? (host ? 'hostSemantic' : 'semantic') : 'explicitFallback',
		wordView: supports(featureBits, PARADIS_OFFICE_FEATURE_WORD_VIEW) ? (host ? 'nativeWithHostDiagnostics' : 'semantic') : (host ? 'nativeBasic' : 'diagnostic'),
		wordDiff: supports(featureBits, PARADIS_OFFICE_FEATURE_WORD_DIFF) ? (host ? 'hostSemantic' : 'semantic') : 'explicitFallback',
	};
}

function v1Capabilities(route: 'localV1' | 'remoteV1' | 'mobileRelayV1' | 'webWorkerV1', featureBits: number): ParadisOfficeCapabilitySet {
	const complete = featureBits === PARADIS_OFFICE_ALL_FEATURES;
	const summaryOnly = route === 'webWorkerV1';
	return {
		version: 1,
		route,
		quality: complete && !summaryOnly ? 'complete' : 'degraded',
		semanticCompleteness: complete && !summaryOnly,
		features: semanticFeatures(featureBits, route === 'mobileRelayV1'),
		warnings: summaryOnly ? ['office.capability.summaryOnly'] : complete ? [] : ['office.capability.featureUnavailable'],
	};
}

function snapshotHandshake(value: unknown): ParadisOfficeCapabilityHandshake | undefined {
	const root = dataRecord(value, ['client', 'backend'], ['localSpoolAvailable']);
	if (!root) {
		return undefined;
	}
	const client = dataRecord(root.values.client, ['version', 'platform'], ['featureBits']);
	const backend = dataRecord(root.values.backend, ['version', 'kind', 'available'], ['featureBits']);
	if (!client || !backend) {
		return undefined;
	}
	const clientVersion = client.values.version;
	const platform = client.values.platform;
	const clientFeatureBits = client.values.featureBits;
	const backendVersion = backend.values.version;
	const kind = backend.values.kind;
	const available = backend.values.available;
	const featureBits = backend.values.featureBits;
	const localSpoolAvailable = root.values.localSpoolAvailable;
	const clientHasFeatureBits = client.keys.has('featureBits');
	const backendHasFeatureBits = backend.keys.has('featureBits');
	if ((clientVersion !== 0 && clientVersion !== 1)
		|| (platform !== 'desktop' && platform !== 'mobile' && platform !== 'web')
		|| (clientVersion === 0 ? clientHasFeatureBits : !clientHasFeatureBits || typeof clientFeatureBits !== 'number' || !Number.isSafeInteger(clientFeatureBits) || clientFeatureBits < 0 || (clientFeatureBits & ~PARADIS_OFFICE_ALL_FEATURES) !== 0)
		|| (backendVersion !== 0 && backendVersion !== 1)
		|| (kind !== 'local' && kind !== 'remote' && kind !== 'mobileHost' && kind !== 'webWorker')
		|| typeof available !== 'boolean'
		|| (backendVersion === 0 ? backendHasFeatureBits : !backendHasFeatureBits || typeof featureBits !== 'number' || !Number.isSafeInteger(featureBits) || featureBits < 0 || (featureBits & ~PARADIS_OFFICE_ALL_FEATURES) !== 0)
		|| (localSpoolAvailable !== undefined && typeof localSpoolAvailable !== 'boolean')
		|| (platform === 'desktop' ? kind !== 'local' && kind !== 'remote' : platform === 'mobile' ? kind !== 'mobileHost' : kind !== 'webWorker')
		|| (clientVersion === 0 && platform === 'web')
		|| (localSpoolAvailable !== undefined && !(clientVersion === 1 && platform === 'desktop' && backendVersion === 0 && kind === 'remote'))) {
		return undefined;
	}
	const snapshotClient: ParadisOfficeClientAdvertisement = clientVersion === 1
		? { version: 1, platform, featureBits: clientFeatureBits as number }
		: { version: 0, platform: platform as 'desktop' | 'mobile' };
	const snapshotBackend: ParadisOfficeBackendAdvertisement = backendVersion === 1
		? { version: 1, kind, available, featureBits: featureBits as number }
		: { version: 0, kind: kind as 'local' | 'remote' | 'mobileHost', available };
	return {
		client: snapshotClient,
		backend: snapshotBackend,
		...(localSpoolAvailable === undefined ? {} : { localSpoolAvailable }),
	};
}

/** Negotiates a fresh, bounded capability result without retaining the untrusted handshake. */
export function negotiateParadisOfficeCapabilities(value: unknown): ParadisOfficeCapabilitySet {
	const handshake = snapshotHandshake(value);
	if (!handshake) {
		return invalidCapabilities();
	}
	const { client, backend } = handshake;
	if (!backend.available) {
		if (client.platform === 'mobile') {
			return {
				version: client.version,
				route: 'diagnostic',
				quality: 'degraded',
				semanticCompleteness: false,
				features: { excelView: 'diagnostic', excelDiff: 'explicitFallback', wordView: 'nativeBasic', wordDiff: 'explicitFallback' },
				warnings: ['office.capability.mobileHostUnavailable'],
			};
		}
		return blockedCapabilities(client.version, client.platform === 'web' ? 'office.capability.workerUnavailable' : 'office.capability.backendUnavailable');
	}
	if (client.platform === 'desktop') {
		if (client.version === 0) {
			return legacyDesktop('legacy');
		}
		if (backend.version === 0) {
			if (backend.kind === 'remote') {
				return handshake.localSpoolAvailable
					? legacyDesktop('degraded', 'office.capability.remoteBackendV0', 'boundedLocalSpool')
					: invalidCapabilities('office.capability.remoteBackendV0');
			}
			return legacyDesktop('degraded', 'office.capability.backendV0');
		}
		return v1Capabilities(backend.kind === 'local' ? 'localV1' : 'remoteV1', (client.featureBits ?? 0) & (backend.featureBits ?? 0));
	}
	if (client.platform === 'mobile') {
		if (client.version === 0) {
			return legacyMobile('legacy');
		}
		if (backend.version === 0) {
			return legacyMobile('degraded', 'office.capability.mobileHostV0');
		}
		return v1Capabilities('mobileRelayV1', (client.featureBits ?? 0) & (backend.featureBits ?? 0));
	}
	if (backend.version === 1) {
		return v1Capabilities('webWorkerV1', (client.version === 1 ? client.featureBits : 0) & (backend.featureBits ?? 0));
	}
	return invalidCapabilities();
}

export const PARADIS_OFFICE_CONFIGURATION_KEYS = [
	'paradis.officeViewer.engine',
	'paradis.officeViewer.kernelShadow',
	'paradis.officeViewer.semanticSpreadsheet',
	'paradis.officeViewer.virtualizedSpreadsheet',
	'paradis.officeViewer.semanticWord',
	'paradis.officeViewer.platformBackend',
	'paradis.officeViewer.searchPrint',
	'paradis.officeViewer.enabled',
] as const;

/** Master checkbox for the viewer; the advanced keys (engine/kernelShadow/platformBackend) stay settings.json-only. */
export const PARADIS_OFFICE_ENABLED_SETTING = 'paradis.officeViewer.enabled' as const;

export type ParadisOfficeEngine = 'auto' | 'legacy' | 'v1';

export interface ParadisOfficeRuntimeConfiguration {
	readonly engine: ParadisOfficeEngine;
	readonly kernelShadow: boolean;
	readonly semanticSpreadsheet: boolean;
	readonly virtualizedSpreadsheet: boolean;
	readonly semanticWord: boolean;
	readonly platformBackend: boolean;
	readonly searchPrint: boolean;
}

type ParadisOfficeRuntimeConfigurationKey = keyof ParadisOfficeRuntimeConfiguration;
type ParadisOfficeRuntimeConfigurationLayer = Partial<ParadisOfficeRuntimeConfiguration>;

export interface ParadisOfficeConfigurationReader {
	getValue<T>(key: string): T | undefined;
	inspect<T>(key: string): IConfigurationValue<T> | undefined;
}

export interface ParadisOfficeRuntimeOverrides {
	/** Per-profile storage override captured when a document is opened. */
	readonly profile?: unknown;
	/** Command-line override captured when a document is opened. */
	readonly cli?: unknown;
}

const officeConfigurationDefaults: ParadisOfficeRuntimeConfiguration = {
	engine: 'legacy',
	kernelShadow: false,
	semanticSpreadsheet: true,
	virtualizedSpreadsheet: true,
	semanticWord: true,
	platformBackend: true,
	searchPrint: true,
};

const settingByRuntimeKey: Readonly<Record<ParadisOfficeRuntimeConfigurationKey, typeof PARADIS_OFFICE_CONFIGURATION_KEYS[number]>> = {
	engine: 'paradis.officeViewer.engine',
	kernelShadow: 'paradis.officeViewer.kernelShadow',
	semanticSpreadsheet: 'paradis.officeViewer.semanticSpreadsheet',
	virtualizedSpreadsheet: 'paradis.officeViewer.virtualizedSpreadsheet',
	semanticWord: 'paradis.officeViewer.semanticWord',
	platformBackend: 'paradis.officeViewer.platformBackend',
	searchPrint: 'paradis.officeViewer.searchPrint',
};

const runtimeKeys = Object.keys(settingByRuntimeKey) as ParadisOfficeRuntimeConfigurationKey[];

function isRuntimeValue(key: ParadisOfficeRuntimeConfigurationKey, value: unknown): boolean {
	return key === 'engine'
		? value === 'auto' || value === 'legacy' || value === 'v1'
		: typeof value === 'boolean';
}

function snapshotConfigurationLayer(value: unknown): ParadisOfficeRuntimeConfigurationLayer | undefined {
	if (value === undefined) {
		return {};
	}
	const record = dataRecord(value, [], runtimeKeys);
	if (!record) {
		return undefined;
	}
	try {
		const result: ParadisOfficeRuntimeConfigurationLayer = {};
		for (const propertyKey of record.keys) {
			const key = propertyKey as ParadisOfficeRuntimeConfigurationKey;
			const field = record.values[key];
			if (!isRuntimeValue(key, field)) {
				return undefined;
			}
			(result as Record<ParadisOfficeRuntimeConfigurationKey, unknown>)[key] = field;
		}
		return result;
	} catch {
		return undefined;
	}
}

function snapshotRuntimeOverrides(value: ParadisOfficeRuntimeOverrides): { readonly profile: unknown; readonly cli: unknown } | undefined {
	const record = dataRecord(value, [], ['profile', 'cli']);
	if (!record) {
		return undefined;
	}
	return { profile: record.values.profile, cli: record.values.cli };
}

function configurationLayer(reader: ParadisOfficeConfigurationReader): ParadisOfficeRuntimeConfigurationLayer | undefined {
	const result: ParadisOfficeRuntimeConfigurationLayer = {};
	try {
		for (const key of runtimeKeys) {
			const value = reader.getValue<unknown>(settingByRuntimeKey[key]);
			if (value !== undefined) {
				if (!isRuntimeValue(key, value)) {
					return undefined;
				}
				(result as Record<ParadisOfficeRuntimeConfigurationKey, unknown>)[key] = value;
			}
		}
		// The master checkbox is what users flip; turning it on promotes the (hidden) engine key to 'v1'.
		if (reader.getValue<unknown>(PARADIS_OFFICE_ENABLED_SETTING) === true) {
			(result as Record<ParadisOfficeRuntimeConfigurationKey, unknown>).engine = 'v1';
		}
		return result;
	} catch {
		return undefined;
	}
}

function policyLayer(reader: ParadisOfficeConfigurationReader): ParadisOfficeRuntimeConfigurationLayer | undefined {
	const result: ParadisOfficeRuntimeConfigurationLayer = {};
	try {
		for (const key of runtimeKeys) {
			const inspected = reader.inspect<unknown>(settingByRuntimeKey[key]);
			if (inspected === undefined) {
				continue;
			}
			if (!inspected || typeof inspected !== 'object' || Array.isArray(inspected)) {
				return undefined;
			}
			const policyValue = inspected.policyValue;
			if (policyValue === undefined) {
				continue;
			}
			if (!isRuntimeValue(key, policyValue)) {
				return undefined;
			}
			(result as Record<ParadisOfficeRuntimeConfigurationKey, unknown>)[key] = policyValue;
		}
		return result;
	} catch {
		return undefined;
	}
}

function safeLegacyConfiguration(): ParadisOfficeRuntimeConfiguration {
	return Object.freeze({
		engine: 'legacy',
		kernelShadow: false,
		semanticSpreadsheet: false,
		virtualizedSpreadsheet: false,
		semanticWord: false,
		platformBackend: false,
		searchPrint: false,
	});
}

/** Captures the effective runtime switches once per open; active handles retain their prior snapshot. */
export function snapshotParadisOfficeRuntimeConfiguration(reader: ParadisOfficeConfigurationReader, overrides: ParadisOfficeRuntimeOverrides = {}): ParadisOfficeRuntimeConfiguration {
	const overrideSnapshot = snapshotRuntimeOverrides(overrides);
	if (!overrideSnapshot) {
		return safeLegacyConfiguration();
	}
	const configuration = configurationLayer(reader);
	const profile = snapshotConfigurationLayer(overrideSnapshot.profile);
	const cli = snapshotConfigurationLayer(overrideSnapshot.cli);
	const policy = policyLayer(reader);
	if (!configuration || !profile || !cli || !policy) {
		return safeLegacyConfiguration();
	}
	const resolved: ParadisOfficeRuntimeConfiguration = {
		...officeConfigurationDefaults,
		...configuration,
		...profile,
		...cli,
		...policy,
	};
	if (resolved.engine === 'legacy') {
		return Object.freeze({
			engine: 'legacy',
			kernelShadow: resolved.kernelShadow,
			semanticSpreadsheet: false,
			virtualizedSpreadsheet: false,
			semanticWord: false,
			platformBackend: false,
			searchPrint: false,
		});
	}
	return Object.freeze({ ...resolved });
}

/** Constructs search/print callbacks only when the per-open snapshot permits those operations. */
export function createParadisOfficeSearchPrintCallbacks<TSearch, TPrint>(
	configuration: ParadisOfficeRuntimeConfiguration,
	semanticEnabled: boolean,
	factories: { readonly search: () => TSearch; readonly print: () => TPrint },
): { readonly search: TSearch | undefined; readonly print: TPrint | undefined } {
	if (configuration.engine === 'legacy' || !semanticEnabled || !configuration.searchPrint) {
		return { search: undefined, print: undefined };
	}
	return { search: factories.search(), print: factories.print() };
}

/** Converts one open snapshot into the v1 client advertisement used for safe capability intersection. */
export function getParadisOfficeRuntimeFeatureBits(configuration: ParadisOfficeRuntimeConfiguration): number {
	if (configuration.engine === 'legacy' || !configuration.platformBackend) {
		return 0;
	}
	let featureBits = 0;
	if (configuration.semanticSpreadsheet) {
		featureBits |= PARADIS_OFFICE_FEATURE_EXCEL_VIEW | PARADIS_OFFICE_FEATURE_EXCEL_DIFF;
	}
	if (configuration.semanticWord) {
		featureBits |= PARADIS_OFFICE_FEATURE_WORD_VIEW | PARADIS_OFFICE_FEATURE_WORD_DIFF;
	}
	return featureBits;
}

function officeBooleanSetting(defaultValue: boolean, description: string, policyName: string, policyDescription: { readonly key: string; readonly value: string }, included: boolean = false): IConfigurationPropertySchema {
	return {
		type: 'boolean', default: defaultValue, scope: ConfigurationScope.WINDOW, restricted: true, included,
		description,
		policy: {
			name: policyName,
			category: PolicyCategory.Extensions,
			minimumVersion: '1.135',
			localization: { description: policyDescription },
		},
	};
}

/** Shared schema consumed verbatim by the common workbench configuration contribution. */
export const PARADIS_OFFICE_CONFIGURATION_PROPERTIES: Readonly<Record<typeof PARADIS_OFFICE_CONFIGURATION_KEYS[number], IConfigurationPropertySchema>> = {
	'paradis.officeViewer.engine': {
		type: 'string',
		enum: ['auto', 'legacy', 'v1'],
		default: 'legacy',
		scope: ConfigurationScope.WINDOW,
		restricted: true,
		included: false,
		description: localize('paradis.officeViewer.engine', "Office ビューアの処理エンジンを選びます（次に開く文書から反映されます）。"),
		policy: {
			name: 'ParadisOfficeViewerEngine',
			category: PolicyCategory.Extensions,
			minimumVersion: '1.135',
			localization: { description: { key: 'paradis.officeViewer.engine.policy', value: localize('paradis.officeViewer.engine.policy', "Controls the Office viewer processing engine.") } },
		},
	},
	'paradis.officeViewer.kernelShadow': officeBooleanSetting(false, localize('paradis.officeViewer.kernelShadow', "表示を変えずに、Office ファイルの構成を調べる診断だけを実行します。"), 'ParadisOfficeViewerKernelShadow', { key: 'paradis.officeViewer.kernelShadow.policy', value: localize('paradis.officeViewer.kernelShadow.policy', "Controls Office inventory shadow diagnostics.") }),
	'paradis.officeViewer.semanticSpreadsheet': officeBooleanSetting(true, localize('paradis.officeViewer.semanticSpreadsheet', "Excel ブックの変更点を一覧するパネルを表示します（次に開く文書から反映されます）。"), 'ParadisOfficeViewerSemanticSpreadsheet', { key: 'paradis.officeViewer.semanticSpreadsheet.policy', value: localize('paradis.officeViewer.semanticSpreadsheet.policy', "Controls semantic spreadsheet processing.") }, true),
	'paradis.officeViewer.virtualizedSpreadsheet': officeBooleanSetting(true, localize('paradis.officeViewer.virtualizedSpreadsheet', "画面に見えている範囲だけを描画して、行数の多いシートを軽くします（次に開く文書から反映されます）。"), 'ParadisOfficeViewerVirtualizedSpreadsheet', { key: 'paradis.officeViewer.virtualizedSpreadsheet.policy', value: localize('paradis.officeViewer.virtualizedSpreadsheet.policy', "Controls virtualized spreadsheet rendering.") }, true),
	'paradis.officeViewer.semanticWord': officeBooleanSetting(true, localize('paradis.officeViewer.semanticWord', "Word 文書の変更点を一覧するパネルを表示します（次に開く文書から反映されます）。"), 'ParadisOfficeViewerSemanticWord', { key: 'paradis.officeViewer.semanticWord.policy', value: localize('paradis.officeViewer.semanticWord.policy', "Controls semantic Word processing.") }, true),
	'paradis.officeViewer.platformBackend': officeBooleanSetting(true, localize('paradis.officeViewer.platformBackend', "Office ファイルの解析をプラットフォーム側のバックエンドで行います（次に開く文書から反映されます）。"), 'ParadisOfficeViewerPlatformBackend', { key: 'paradis.officeViewer.platformBackend.policy', value: localize('paradis.officeViewer.platformBackend.policy', "Controls platform Office backends.") }),
	'paradis.officeViewer.searchPrint': officeBooleanSetting(true, localize('paradis.officeViewer.searchPrint', "変更点パネルから文書の検索と印刷ができるようにします（次に開く文書から反映されます）。"), 'ParadisOfficeViewerSearchPrint', { key: 'paradis.officeViewer.searchPrint.policy', value: localize('paradis.officeViewer.searchPrint.policy', "Controls semantic Office search and print.") }, true),
	[PARADIS_OFFICE_ENABLED_SETTING]: {
		type: 'boolean',
		default: false,
		scope: ConfigurationScope.WINDOW,
		restricted: true,
		included: true,
		description: localize('paradis.officeViewer.enabled', "Word・Excel の変更点パネル・検索・印刷が使えるようになります。オフのときは従来の表示のみになります。"),
		policy: {
			name: 'ParadisOfficeViewerEnabled',
			category: PolicyCategory.Extensions,
			minimumVersion: '1.135',
			localization: { description: { key: 'paradis.officeViewer.enabled.policy', value: localize('paradis.officeViewer.enabled.policy', "Controls whether Para Code's semantic Office viewer is enabled.") } },
		},
	},
};
