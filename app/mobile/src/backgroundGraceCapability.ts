// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ParadisMobileCapability } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileCompat.js';

/**
 * PC が「裏に回った」の確認を返せることの広告（W2-34）。PC は State の `capabilities` で広告する
 * （`paradisMobileCompat.ts` の `PARADIS_MOBILE_PC_CAPABILITIES`）。
 */
export const BACKGROUND_GRACE_CAPABILITY: string = ParadisMobileCapability.BackgroundGrace;
