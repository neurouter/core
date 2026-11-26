/**
 * OpenTelemetry bootstrap for `node --import` (backend §10.5). Load BEFORE the app:
 *
 *   node --import ./dist/instrumentation.js dist/main.js
 *
 * It is a no-op unless `OTEL_SDK_DISABLED=false` (see kernel/observability/otel.ts). `npx neurouter
 * serve` starts the same SDK itself.
 */
import { startOtel } from './kernel/observability/otel.js';

export { otelEnabled, resourceAttributes, startOtel, type OtelOptions } from './kernel/observability/otel.js';

// Side effect when loaded with --import (not when imported by tests).
if (process.argv[1] && !process.env.VITEST) {
  await startOtel().catch((err: unknown) => console.error('OpenTelemetry failed to start:', err));
}
