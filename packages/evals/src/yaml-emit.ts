/** Minimal block-style YAML emitter for overlay patch fragments (strings are JSON-quoted when needed). */
export function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value
      .map((v) => {
        if (isPlainObject(v) && Object.keys(v).length) {
          const inner = toYaml(v, indent + 2).trimStart();
          return `${pad}- ${inner}`;
        }
        return `${pad}- ${scalar(v)}`;
      })
      .join('\n');
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return '{}';
    return entries
      .map(([k, v]) => {
        const key = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : JSON.stringify(k);
        if ((isPlainObject(v) && Object.keys(v).length) || (Array.isArray(v) && v.length)) return `${pad}${key}:\n${toYaml(v, indent + 2)}`;
        if (typeof v === 'string' && v.includes('\n')) return `${pad}${key}: |\n${v.split('\n').map((l) => `${pad}  ${l}`).join('\n')}`;
        return `${pad}${key}: ${Array.isArray(v) || isPlainObject(v) ? toYaml(v) : scalar(v)}`;
      })
      .join('\n');
  }
  return scalar(value);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (/^[A-Za-z][A-Za-z0-9 _./-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) && !s.endsWith(' ')) return s;
  return JSON.stringify(s);
}
