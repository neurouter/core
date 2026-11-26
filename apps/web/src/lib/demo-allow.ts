import { DEMO_ANONYMOUS_ALLOW } from '@/contract';

/**
 * Operations that stay enabled in the read-only demo UI (they are answered by the demo's MSW
 * allow-list, `mocks/handlers.ts`). Kept here so the shell does not import the mocks.
 */
export const DEMO_READ_ONLY_ALLOW_UI = new Set<string>([...DEMO_ANONYMOUS_ALLOW, 'servers.create', 'evals.createRun', 'overlays.updateDraft', 'suggestions.verify', 'audit.verify']);
