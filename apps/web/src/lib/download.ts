import { api, buildPath, serializeQuery, type QueryValue } from '@/contract';

/**
 * Audit export link: a plain `<a href download>` so the browser streams the file with the
 * session cookie. The URL carries exactly the active filters plus `format`.
 */
export function auditExportUrl(filters: Record<string, QueryValue>, format: 'csv' | 'ndjson'): string {
  return buildPath(api.audit.export.path) + serializeQuery({ ...filters, format });
}

/** Overlay YAML download (`overlays.download`), latest revision unless `rev` is given. */
export function overlayDownloadUrl(serverId: string, rev?: number): string {
  return buildPath(api.overlays.download.path, { id: serverId }) + serializeQuery({ rev });
}

/** Original spec bytes (`specs.download`). */
export function specDownloadUrl(specId: string): string {
  return buildPath(api.specs.download.path, { id: specId });
}

/** Effective neurouter.yaml (`config.export`). */
export function configExportUrl(): string {
  return buildPath(api.config.export.path);
}
