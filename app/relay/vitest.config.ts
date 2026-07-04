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
			},
		},
	},
});
