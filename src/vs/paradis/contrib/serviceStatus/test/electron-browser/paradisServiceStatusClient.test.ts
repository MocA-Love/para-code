/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AuthInfo, Credentials, IRequestService } from '../../../../../platform/request/common/request.js';
import { configureParadisDiagnosticReporter, type ParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { PARADIS_SERVICE_STATUS_SOURCES, ParadisServiceStatusProvider } from '../../common/paradisServiceStatus.js';
import { ParadisServiceStatusClient } from '../../electron-browser/paradisServiceStatusClient.js';

const episodeProviders = ['claude', 'codex'] as const;

const privateResponseNeedles = [
	'private-response-body',
	'file:///Users/alice/service-status.json',
	'https://private.example.test/status',
];

function response(body: string): IRequestContext {
	return {
		res: { headers: {}, statusCode: 200 },
		stream: bufferToStream(VSBuffer.fromString(body)),
	};
}

class SequencedStatusRequestService implements IRequestService {
	declare readonly _serviceBrand: undefined;
	readonly onDidCompleteRequest = Event.None;
	private readonly providerAttempts = new Map<ParadisServiceStatusProvider, number>();

	async request(options: IRequestOptions, _token: CancellationToken): Promise<IRequestContext> {
		const provider = episodeProviders.find(provider => options.url === PARADIS_SERVICE_STATUS_SOURCES[provider].apiUrl);
		if (provider) {
			const attempt = this.providerAttempts.get(provider) ?? 0;
			this.providerAttempts.set(provider, attempt + 1);
			if (attempt === 2) {
				return response(JSON.stringify({ status: { indicator: 'none', description: 'All Systems Operational' } }));
			}
			if (attempt === 1) {
				return response(JSON.stringify({
					status: { indicator: 123 },
					private: privateResponseNeedles.join(' '),
				}));
			}
			return response(
				'{"status":{"indicator":"none"},"private":"private-response-body file:///Users/alice/service-status.json https://private.example.test/status ' + provider + '-attempt-' + attempt + '",',
			);
		}
		return response(JSON.stringify({ status: { indicator: 'none', description: 'All Systems Operational' } }));
	}

	async resolveProxy(_url: string): Promise<string | undefined> { return undefined; }
	async lookupAuthorization(_authInfo: AuthInfo): Promise<Credentials | undefined> { return undefined; }
	async lookupKerberosAuthorization(_url: string): Promise<string | undefined> { return undefined; }
	async loadCertificates(): Promise<string[]> { return []; }
}

suite('ParadisServiceStatusClient diagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports each provider failure episode independently with a fixed error', async () => {
		const reports: Array<{
			readonly scope: string;
			readonly feature: string;
			readonly operation: string;
			readonly error: unknown;
			readonly safeExtra: Parameters<ParadisDiagnosticReporter>[4];
			readonly severity: string | undefined;
		}> = [];
		configureParadisDiagnosticReporter((scope, feature, operation, error, safeExtra, severity) => {
			reports.push({ scope, feature, operation, error, safeExtra, severity });
		});

		try {
			const client = new ParadisServiceStatusClient(new SequencedStatusRequestService());
			const snapshots = [];
			for (let index = 0; index < 4; index++) {
				snapshots.push(await client.getSnapshot());
			}

			assert.deepStrictEqual(
				snapshots.map(snapshot => ({
					claude: snapshot.entries.claude.severity,
					codex: snapshot.entries.codex.severity,
					github: snapshot.entries.github.severity,
				})),
				[
					{ claude: 'unknown', codex: 'unknown', github: 'ok' },
					{ claude: 'unknown', codex: 'unknown', github: 'ok' },
					{ claude: 'ok', codex: 'ok', github: 'ok' },
					{ claude: 'unknown', codex: 'unknown', github: 'ok' },
				],
			);
			for (const provider of episodeProviders) {
				assert.ok(snapshots[0].entries[provider].error?.includes('private-response-body'));
				assert.strictEqual(snapshots[0].entries[provider].error?.length, 161);
				assert.ok(snapshots[0].entries[provider].error?.endsWith('…'));
			}
			assert.strictEqual(reports.length, 4);
			assert.deepStrictEqual(reports.map(report => ({
				scope: report.scope,
				feature: report.feature,
				operation: report.operation,
				message: report.error instanceof Error ? report.error.message : String(report.error),
				provider: report.safeExtra?.['safe_provider'],
				safeExtraKeys: report.safeExtra ? Object.keys(report.safeExtra) : [],
				severity: report.severity,
			})).sort((left, right) => String(left.provider).localeCompare(String(right.provider))), [{
				scope: 'owned',
				feature: 'service-status',
				operation: 'fetch-failed',
				message: 'Service status provider request failed',
				provider: 'claude',
				safeExtraKeys: ['safe_provider'],
				severity: 'warning',
			}, {
				scope: 'owned',
				feature: 'service-status',
				operation: 'fetch-failed',
				message: 'Service status provider request failed',
				provider: 'claude',
				safeExtraKeys: ['safe_provider'],
				severity: 'warning',
			}, {
				scope: 'owned',
				feature: 'service-status',
				operation: 'fetch-failed',
				message: 'Service status provider request failed',
				provider: 'codex',
				safeExtraKeys: ['safe_provider'],
				severity: 'warning',
			}, {
				scope: 'owned',
				feature: 'service-status',
				operation: 'fetch-failed',
				message: 'Service status provider request failed',
				provider: 'codex',
				safeExtraKeys: ['safe_provider'],
				severity: 'warning',
			}]);
			assert.ok(reports.every(report => report.error instanceof Error));
			assert.ok(reports.every(report => {
				const error = report.error as Error;
				return !Object.hasOwn(error, 'cause')
					&& Object.getOwnPropertyNames(error).sort().join(',') === 'message,stack';
			}));
			assert.ok(reports.every(report => privateResponseNeedles.every(needle => {
				const error = report.error as Error;
				return !error.message.includes(needle) && !error.stack?.includes(needle);
			})));
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});
});
