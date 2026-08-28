/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'assert';
import { ConfigurationScope } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_OFFICE_ALL_FEATURES,
	PARADIS_OFFICE_CONFIGURATION_KEYS,
	PARADIS_OFFICE_CONFIGURATION_PROPERTIES,
	PARADIS_OFFICE_FEATURE_EXCEL_DIFF,
	PARADIS_OFFICE_FEATURE_EXCEL_VIEW,
	PARADIS_OFFICE_FEATURE_WORD_VIEW,
	ParadisOfficeConfigurationReader,
	ParadisOfficeRuntimeOverrides,
	getParadisOfficeRuntimeFeatureBits,
	negotiateParadisOfficeCapabilities,
	snapshotParadisOfficeRuntimeConfiguration,
} from '../../common/paradisOfficeCapabilities.js';

const semanticFeatures = {
	excelView: 'semantic',
	excelDiff: 'semantic',
	wordView: 'semantic',
	wordDiff: 'semantic',
} as const;

const desktopLegacyFeatures = {
	excelView: 'legacy',
	excelDiff: 'legacy',
	wordView: 'legacy',
	wordDiff: 'legacy',
} as const;

const mobileLegacyFeatures = {
	excelView: 'legacyRelay',
	excelDiff: 'legacyRelay',
	wordView: 'nativeBasic',
	wordDiff: 'explicitFallback',
} as const;

interface CompatibilityFixture {
	readonly name: string;
	readonly handshake: unknown;
	readonly expected: unknown;
}

const compatibilityFixtures: readonly CompatibilityFixture[] = [
	...(['local', 'remote'] as const).map(backend => ({
		name: `v0 desktop / v0 ${backend}`,
		handshake: { client: { version: 0, platform: 'desktop' }, backend: { version: 0, kind: backend, available: true } },
		expected: { version: 0, route: 'legacyChannel', quality: 'legacy', semanticCompleteness: false, features: desktopLegacyFeatures, warnings: [] },
	})),
	...(['local', 'remote'] as const).map(backend => ({
		name: `v0 desktop / v1 ${backend}`,
		handshake: { client: { version: 0, platform: 'desktop' }, backend: { version: 1, kind: backend, available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES } },
		expected: { version: 0, route: 'legacyChannel', quality: 'legacy', semanticCompleteness: false, features: desktopLegacyFeatures, warnings: [] },
	})),
	{
		name: 'v1 desktop / v0 local',
		handshake: { client: { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES }, backend: { version: 0, kind: 'local', available: true } },
		expected: { version: 0, route: 'legacyChannel', quality: 'degraded', semanticCompleteness: false, features: desktopLegacyFeatures, warnings: ['office.capability.backendV0'] },
	},
	{
		name: 'v1 desktop / v0 remote',
		handshake: { client: { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES }, backend: { version: 0, kind: 'remote', available: true }, localSpoolAvailable: true },
		expected: { version: 0, route: 'boundedLocalSpool', quality: 'degraded', semanticCompleteness: false, features: desktopLegacyFeatures, warnings: ['office.capability.remoteBackendV0'] },
	},
	...(['local', 'remote'] as const).map(backend => ({
		name: `v1 desktop / v1 ${backend}`,
		handshake: { client: { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES }, backend: { version: 1, kind: backend, available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES } },
		expected: { version: 1, route: backend === 'local' ? 'localV1' as const : 'remoteV1' as const, quality: 'complete' as const, semanticCompleteness: true, features: semanticFeatures, warnings: [] },
	})),
	{
		name: 'old mobile / old PC',
		handshake: { client: { version: 0, platform: 'mobile' }, backend: { version: 0, kind: 'mobileHost', available: true } },
		expected: { version: 0, route: 'mobileRelayV0', quality: 'legacy', semanticCompleteness: false, features: mobileLegacyFeatures, warnings: [] },
	},
	{
		name: 'old mobile / new PC',
		handshake: { client: { version: 0, platform: 'mobile' }, backend: { version: 1, kind: 'mobileHost', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES } },
		expected: { version: 0, route: 'mobileRelayV0', quality: 'legacy', semanticCompleteness: false, features: mobileLegacyFeatures, warnings: [] },
	},
	{
		name: 'new mobile / old PC',
		handshake: { client: { version: 1, platform: 'mobile', featureBits: PARADIS_OFFICE_ALL_FEATURES }, backend: { version: 0, kind: 'mobileHost', available: true } },
		expected: { version: 0, route: 'mobileRelayV0', quality: 'degraded', semanticCompleteness: false, features: mobileLegacyFeatures, warnings: ['office.capability.mobileHostV0'] },
	},
	{
		name: 'new mobile / new PC',
		handshake: { client: { version: 1, platform: 'mobile', featureBits: PARADIS_OFFICE_ALL_FEATURES }, backend: { version: 1, kind: 'mobileHost', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES } },
		expected: {
			version: 1,
			route: 'mobileRelayV1',
			quality: 'complete',
			semanticCompleteness: true,
			features: { excelView: 'hostSemantic', excelDiff: 'hostSemantic', wordView: 'nativeWithHostDiagnostics', wordDiff: 'hostSemantic' },
			warnings: [],
		},
	},
	{
		name: 'Web v1 / Worker v1',
		handshake: { client: { version: 1, platform: 'web', featureBits: PARADIS_OFFICE_ALL_FEATURES }, backend: { version: 1, kind: 'webWorker', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES } },
		expected: { version: 1, route: 'webWorkerV1', quality: 'degraded', semanticCompleteness: false, features: semanticFeatures, warnings: ['office.capability.summaryOnly'] },
	},
	{
		name: 'Web v1 / Worker unavailable',
		handshake: { client: { version: 1, platform: 'web', featureBits: PARADIS_OFFICE_ALL_FEATURES }, backend: { version: 1, kind: 'webWorker', available: false, featureBits: 0 } },
		expected: {
			version: 1,
			route: 'diagnostic',
			quality: 'blocked',
			semanticCompleteness: false,
			features: { excelView: 'diagnostic', excelDiff: 'explicitFallback', wordView: 'diagnostic', wordDiff: 'explicitFallback' },
			warnings: ['office.capability.workerUnavailable'],
		},
	},
];

class MutableConfigurationReader implements ParadisOfficeConfigurationReader {
	readonly values = new Map<string, unknown>();
	readonly policyValues = new Map<string, unknown>();

	getValue<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	inspect<T>(key: string): { readonly defaultValue?: T; readonly userValue?: T; readonly policyValue?: T; readonly value?: T } | undefined {
		return this.policyValues.has(key) ? {
			defaultValue: true as T,
			userValue: this.values.get(key) as T | undefined,
			policyValue: this.policyValues.get(key) as T,
			value: this.policyValues.get(key) as T,
		} : undefined;
	}
}

function invalidCapabilitySet() {
	return {
		version: 0,
		route: 'diagnostic',
		quality: 'blocked',
		semanticCompleteness: false,
		features: { excelView: 'diagnostic', excelDiff: 'explicitFallback', wordView: 'diagnostic', wordDiff: 'explicitFallback' },
		warnings: ['office.capability.invalidHandshake'],
	} as const;
}

suite('ParadisOfficeCapabilities', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const fixture of compatibilityFixtures) {
		test(`negotiates ${fixture.name}`, () => {
			deepStrictEqual(negotiateParadisOfficeCapabilities(fixture.handshake), fixture.expected);
		});
	}

	test('blocks a v0 remote backend when bounded local spool is unavailable', () => {
		deepStrictEqual(negotiateParadisOfficeCapabilities({
			client: { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES },
			backend: { version: 0, kind: 'remote', available: true },
			localSpoolAvailable: false,
		}), {
			version: 0,
			route: 'diagnostic',
			quality: 'blocked',
			semanticCompleteness: false,
			features: { excelView: 'diagnostic', excelDiff: 'explicitFallback', wordView: 'diagnostic', wordDiff: 'explicitFallback' },
			warnings: ['office.capability.remoteBackendV0'],
		});
	});

	test('separates mobile standalone from a connected host', () => {
		deepStrictEqual(negotiateParadisOfficeCapabilities({
			client: { version: 1, platform: 'mobile', featureBits: PARADIS_OFFICE_ALL_FEATURES },
			backend: { version: 1, kind: 'mobileHost', available: false, featureBits: 0 },
		}), {
			version: 1,
			route: 'diagnostic',
			quality: 'degraded',
			semanticCompleteness: false,
			features: { excelView: 'diagnostic', excelDiff: 'explicitFallback', wordView: 'nativeBasic', wordDiff: 'explicitFallback' },
			warnings: ['office.capability.mobileHostUnavailable'],
		});
	});

	test('intersects v1 client and backend feature bitsets at the lower capability', () => {
		deepStrictEqual(negotiateParadisOfficeCapabilities({
			client: { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_FEATURE_EXCEL_VIEW | PARADIS_OFFICE_FEATURE_WORD_VIEW },
			backend: { version: 1, kind: 'local', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES },
		}), {
			version: 1,
			route: 'localV1',
			quality: 'degraded',
			semanticCompleteness: false,
			features: { excelView: 'semantic', excelDiff: 'explicitFallback', wordView: 'semantic', wordDiff: 'explicitFallback' },
			warnings: ['office.capability.featureUnavailable'],
		});
	});

	for (const backendKind of ['local', 'remote'] as const) {
		test(`intersects a ${backendKind} v1 backend subset below an all-feature client`, () => {
			deepStrictEqual(negotiateParadisOfficeCapabilities({
				client: { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES },
				backend: { version: 1, kind: backendKind, available: true, featureBits: PARADIS_OFFICE_FEATURE_EXCEL_VIEW | PARADIS_OFFICE_FEATURE_WORD_VIEW },
			}), {
				version: 1,
				route: backendKind === 'local' ? 'localV1' : 'remoteV1',
				quality: 'degraded',
				semanticCompleteness: false,
				features: { excelView: 'semantic', excelDiff: 'explicitFallback', wordView: 'semantic', wordDiff: 'explicitFallback' },
				warnings: ['office.capability.featureUnavailable'],
			});
		});
	}

	test('enforces version-specific featureBits presence and rejects a sole extra field', () => {
		const invalidInputs = [
			{ client: { version: 0, platform: 'desktop', featureBits: undefined }, backend: { version: 0, kind: 'local', available: true } },
			{ client: { version: 0, platform: 'desktop' }, backend: { version: 0, kind: 'local', available: true, featureBits: undefined } },
			{ client: { version: 1, platform: 'desktop' }, backend: { version: 1, kind: 'local', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES } },
			{ client: { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES }, backend: { version: 1, kind: 'local', available: true } },
			{ client: { version: 0, platform: 'desktop' }, backend: { version: 0, kind: 'local', available: true }, extra: true },
		];

		for (const input of invalidInputs) {
			deepStrictEqual(negotiateParadisOfficeCapabilities(input), invalidCapabilitySet());
		}
	});

	test('rejects large unknown-key records before requesting any property descriptor', () => {
		const largeClient: Record<string, unknown> = { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES };
		for (let index = 0; index < 10_000; index++) {
			largeClient[`extra${index}`] = index;
		}
		let descriptorReads = 0;
		const sentinelClient = new Proxy({ version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES }, {
			ownKeys: target => [...Reflect.ownKeys(target), 'extra'],
			getOwnPropertyDescriptor: () => {
				descriptorReads++;
				throw new Error('descriptor sentinel');
			},
		});
		const backend = { version: 1, kind: 'local', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES };

		deepStrictEqual(negotiateParadisOfficeCapabilities({ client: largeClient, backend }), invalidCapabilitySet());
		deepStrictEqual(negotiateParadisOfficeCapabilities({ client: sentinelClient, backend }), invalidCapabilitySet());
		strictEqual(descriptorReads, 0);
	});

	test('copies handshake inputs and does not share nested results across calls', () => {
		const client = { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES };
		const backend = { version: 1, kind: 'local', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES };
		const first = negotiateParadisOfficeCapabilities({ client, backend });
		client.featureBits = 0;
		backend.featureBits = 0;
		const second = negotiateParadisOfficeCapabilities({
			client: { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES },
			backend: { version: 1, kind: 'local', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES },
		});

		strictEqual(first.quality, 'complete');
		strictEqual(second.quality, 'complete');
		notStrictEqual(first, second);
		notStrictEqual(first.features, second.features);
		notStrictEqual(first.warnings, second.warnings);
	});

	test('rejects extra, invalid, accessor, and stateful proxy handshake inputs without retaining identity', () => {
		const accessed: string[] = [];
		const accessor = Object.create(null, {
			client: { enumerable: true, get: () => { accessed.push('client'); return { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES }; } },
			backend: { enumerable: true, value: { version: 1, kind: 'local', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES } },
		});
		let proxyReads = 0;
		const proxy = new Proxy({
			client: { version: 1, platform: 'desktop', featureBits: PARADIS_OFFICE_ALL_FEATURES },
			backend: { version: 1, kind: 'local', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES },
		}, {
			ownKeys: target => {
				proxyReads++;
				return proxyReads === 1 ? Reflect.ownKeys(target) : ['client'];
			},
		});
		const malformed = [
			{ client: { version: 1, platform: 'desktop', extra: true }, backend: { version: 1, kind: 'local', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES } },
			{ client: { version: 2, platform: 'desktop' }, backend: { version: 1, kind: 'local', available: true, featureBits: PARADIS_OFFICE_ALL_FEATURES } },
			accessor,
			proxy,
		];
		const expected = invalidCapabilitySet();
		const results = malformed.map(value => negotiateParadisOfficeCapabilities(value));

		for (const result of results) {
			deepStrictEqual(result, expected);
			notStrictEqual(result, expected);
		}
		deepStrictEqual(accessed, []);
		strictEqual(proxyReads <= 2, true);
	});
});

suite('ParadisOfficeConfiguration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers the exact hidden runtime setting schema and safe pre-gate defaults', () => {
		const actual = Object.fromEntries(PARADIS_OFFICE_CONFIGURATION_KEYS.map(key => {
			const property = PARADIS_OFFICE_CONFIGURATION_PROPERTIES[key];
			ok(property);
			return [key, {
				type: property.type,
				default: property.default,
				scope: property.scope,
				restricted: property.restricted,
				included: property.included,
				enum: property.enum,
				policy: property.policy?.name,
			}];
		}));

		deepStrictEqual(actual, {
			'paradis.officeViewer.engine': { type: 'string', default: 'legacy', scope: ConfigurationScope.WINDOW, restricted: true, included: false, enum: ['auto', 'legacy', 'v1'], policy: 'ParadisOfficeViewerEngine' },
			'paradis.officeViewer.kernelShadow': { type: 'boolean', default: false, scope: ConfigurationScope.WINDOW, restricted: true, included: false, enum: undefined, policy: 'ParadisOfficeViewerKernelShadow' },
			'paradis.officeViewer.semanticSpreadsheet': { type: 'boolean', default: true, scope: ConfigurationScope.WINDOW, restricted: true, included: true, enum: undefined, policy: 'ParadisOfficeViewerSemanticSpreadsheet' },
			'paradis.officeViewer.virtualizedSpreadsheet': { type: 'boolean', default: true, scope: ConfigurationScope.WINDOW, restricted: true, included: true, enum: undefined, policy: 'ParadisOfficeViewerVirtualizedSpreadsheet' },
			'paradis.officeViewer.semanticWord': { type: 'boolean', default: true, scope: ConfigurationScope.WINDOW, restricted: true, included: true, enum: undefined, policy: 'ParadisOfficeViewerSemanticWord' },
			'paradis.officeViewer.platformBackend': { type: 'boolean', default: true, scope: ConfigurationScope.WINDOW, restricted: true, included: false, enum: undefined, policy: 'ParadisOfficeViewerPlatformBackend' },
			'paradis.officeViewer.searchPrint': { type: 'boolean', default: true, scope: ConfigurationScope.WINDOW, restricted: true, included: true, enum: undefined, policy: 'ParadisOfficeViewerSearchPrint' },
			'paradis.officeViewer.enabled': { type: 'boolean', default: false, scope: ConfigurationScope.WINDOW, restricted: true, included: true, enum: undefined, policy: 'ParadisOfficeViewerEnabled' },
		});
	});

	test('the Settings UI checkbox promotes engine to v1 for the next open snapshot', () => {
		const configuration = new MutableConfigurationReader();
		configuration.values.set('paradis.officeViewer.enabled', true);

		deepStrictEqual(snapshotParadisOfficeRuntimeConfiguration(configuration, { profile: {}, cli: {} }), {
			engine: 'v1',
			kernelShadow: false,
			semanticSpreadsheet: true,
			virtualizedSpreadsheet: true,
			semanticWord: true,
			platformBackend: true,
			searchPrint: true,
		});
	});

	test('an explicit engine setting still wins over the Settings UI checkbox left off', () => {
		const configuration = new MutableConfigurationReader();
		configuration.values.set('paradis.officeViewer.engine', 'legacy');
		configuration.values.set('paradis.officeViewer.enabled', false);

		strictEqual(snapshotParadisOfficeRuntimeConfiguration(configuration, { profile: {}, cli: {} }).engine, 'legacy');
	});

	test('resolves policy over CLI over profile over configuration per setting', () => {
		const configuration = new MutableConfigurationReader();
		configuration.values.set('paradis.officeViewer.engine', 'auto');
		configuration.values.set('paradis.officeViewer.semanticSpreadsheet', false);
		configuration.policyValues.set('paradis.officeViewer.searchPrint', false);

		deepStrictEqual(snapshotParadisOfficeRuntimeConfiguration(configuration, {
			profile: { engine: 'legacy', semanticSpreadsheet: true, virtualizedSpreadsheet: false },
			cli: { engine: 'v1', virtualizedSpreadsheet: true, semanticWord: false, searchPrint: true },
		}), {
			engine: 'v1',
			kernelShadow: false,
			semanticSpreadsheet: true,
			virtualizedSpreadsheet: true,
			semanticWord: false,
			platformBackend: true,
			searchPrint: false,
		});
	});

	test('reads a prototype policy getter once and lets managed legacy override CLI v1', () => {
		let policyReads = 0;
		const inspection = Object.create(Object.create(null, {
			policyValue: {
				get: () => {
					policyReads++;
					return policyReads === 1 ? 'legacy' : 'v1';
				},
			},
		}));
		const configuration: ParadisOfficeConfigurationReader = {
			getValue: <T>(key: string) => key === 'paradis.officeViewer.engine' ? 'v1' as T : undefined,
			inspect: <T>(key: string) => key === 'paradis.officeViewer.engine' ? inspection as { readonly policyValue?: T } : undefined,
		};

		const snapshot = snapshotParadisOfficeRuntimeConfiguration(configuration, { cli: { engine: 'v1' } });

		strictEqual(snapshot.engine, 'legacy');
		strictEqual(policyReads, 1);
		strictEqual(snapshot.semanticSpreadsheet, false);
	});

	test('fails closed when a policy getter throws or returns a non-primitive without leaking raw data', () => {
		const secret = 'do-not-leak-policy-value';
		const throwingInspection = Object.create(Object.create(null, {
			policyValue: { get: () => { throw new Error(secret); } },
		}));
		const rawInspection = Object.create(Object.create(null, {
			policyValue: { get: () => ({ secret }) },
		}));
		const reader = (inspection: object): ParadisOfficeConfigurationReader => ({
			getValue: <T>(key: string) => key === 'paradis.officeViewer.engine' ? 'v1' as T : undefined,
			inspect: <T>(key: string) => key === 'paradis.officeViewer.engine' ? inspection as { readonly policyValue?: T } : undefined,
		});

		const throwingResult = snapshotParadisOfficeRuntimeConfiguration(reader(throwingInspection), { cli: { engine: 'v1' } });
		const rawResult = snapshotParadisOfficeRuntimeConfiguration(reader(rawInspection), { cli: { engine: 'v1' } });

		strictEqual(throwingResult.engine, 'legacy');
		strictEqual(rawResult.engine, 'legacy');
		strictEqual(JSON.stringify([throwingResult, rawResult]).includes(secret), false);
	});

	test('legacy forces every open/render/diff/search/print subfeature off but preserves kernel shadow', () => {
		const configuration = new MutableConfigurationReader();
		const snapshot = snapshotParadisOfficeRuntimeConfiguration(configuration, {
			cli: {
				engine: 'legacy',
				kernelShadow: true,
				semanticSpreadsheet: true,
				virtualizedSpreadsheet: true,
				semanticWord: true,
				platformBackend: true,
				searchPrint: true,
			},
		});
		deepStrictEqual(snapshot, {
			engine: 'legacy',
			kernelShadow: true,
			semanticSpreadsheet: false,
			virtualizedSpreadsheet: false,
			semanticWord: false,
			platformBackend: false,
			searchPrint: false,
		});
		strictEqual(getParadisOfficeRuntimeFeatureBits(snapshot), 0);
	});

	test('advertises only core features enabled for the next open snapshot', () => {
		const configuration = new MutableConfigurationReader();
		const snapshot = snapshotParadisOfficeRuntimeConfiguration(configuration, {
			cli: { engine: 'v1', semanticSpreadsheet: true, semanticWord: false, platformBackend: true },
		});

		strictEqual(getParadisOfficeRuntimeFeatureBits(snapshot), PARADIS_OFFICE_FEATURE_EXCEL_VIEW | PARADIS_OFFICE_FEATURE_EXCEL_DIFF);
	});

	test('configuration changes affect only the next open snapshot', () => {
		const configuration = new MutableConfigurationReader();
		configuration.values.set('paradis.officeViewer.engine', 'v1');
		const firstOpen = snapshotParadisOfficeRuntimeConfiguration(configuration);
		configuration.values.set('paradis.officeViewer.engine', 'legacy');
		configuration.values.set('paradis.officeViewer.kernelShadow', true);
		const nextOpen = snapshotParadisOfficeRuntimeConfiguration(configuration);

		deepStrictEqual(firstOpen, {
			engine: 'v1', kernelShadow: false, semanticSpreadsheet: true, virtualizedSpreadsheet: true,
			semanticWord: true, platformBackend: true, searchPrint: true,
		});
		deepStrictEqual(nextOpen, {
			engine: 'legacy', kernelShadow: true, semanticSpreadsheet: false, virtualizedSpreadsheet: false,
			semanticWord: false, platformBackend: false, searchPrint: false,
		});
	});

	test('invalid or extra override records fail closed without evaluating accessors', () => {
		const configuration = new MutableConfigurationReader();
		const accessed: string[] = [];
		const accessor = Object.create(null, {
			engine: { enumerable: true, get: () => { accessed.push('engine'); return 'v1'; } },
		});
		const outerAccessor = Object.create(null, {
			cli: { enumerable: true, get: () => { accessed.push('cli'); return { engine: 'v1' }; } },
		}) as ParadisOfficeRuntimeOverrides;
		const first = snapshotParadisOfficeRuntimeConfiguration(configuration, { cli: { engine: 'v1', extra: true } });
		const second = snapshotParadisOfficeRuntimeConfiguration(configuration, { cli: accessor });
		const third = snapshotParadisOfficeRuntimeConfiguration(configuration, outerAccessor);

		deepStrictEqual(first, {
			engine: 'legacy', kernelShadow: false, semanticSpreadsheet: false, virtualizedSpreadsheet: false,
			semanticWord: false, platformBackend: false, searchPrint: false,
		});
		deepStrictEqual(second, first);
		notStrictEqual(second, first);
		deepStrictEqual(third, first);
		deepStrictEqual(accessed, []);
	});
});
