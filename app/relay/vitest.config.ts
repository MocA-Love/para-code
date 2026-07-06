// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				// WebSocketを跨ぐDO状態が残るため、テスト毎のストレージ分離は無効化する
				// （各テストは provision で新規deviceIdを払い出すので相互干渉しない）。
				isolatedStorage: false,
				singleWorker: true,
				wrangler: { configPath: './wrangler.jsonc' },
				// APNsプッシュ経路のテスト用シークレット。使い捨てのP-256鍵で、本番とは無関係。
				miniflare: {
					bindings: {
						APNS_KEY_P8: [
							'-----BEGIN PRIVATE KEY-----',
							'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfQayOIMz4OZDurRB',
							'AFp6UF7Sx1vTQBPaHVCJIivp16ShRANCAAT3iqWMLu+1JsNc1xHaf9I70IDIsyjM',
							'2S5kbGXyYXnYAOYX4YXeCGMlR8Bej91DRTSBSu7aCTmhz/9f5QcVLowH',
							'-----END PRIVATE KEY-----',
						].join('\n'),
						APNS_KEY_ID: 'TESTKEYID1',
						APNS_TEAM_ID: 'TESTTEAM01',
						APNS_TOPIC: 'ltd.paradis.paracode.mobile',
					},
				},
			},
		},
	},
});
