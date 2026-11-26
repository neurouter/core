import { useState } from 'react';
import type { ConnectConfig } from '@/contract';
import { CopyButton } from '@/components/code/copy-button';
import { Segmented } from '@/components/filters/segmented';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

type ClientId = ConnectConfig['clients'][number]['id'];

/**
 * Client picker + the ready snippet from `servers.connect` (spec §17.2: the backend builds the
 * snippets; the UI never builds URLs). "Code mode only" swaps in `codeModeOnlySnippet`.
 */
export function ClientSnippet({ config, initialClient = 'claude-code', onClientChange }: { config: ConnectConfig; initialClient?: ClientId; onClientChange?: (c: ClientId) => void }) {
  const [client, setClient] = useState<ClientId>(config.clients.some((c) => c.id === initialClient) ? initialClient : (config.clients[0]?.id ?? 'claude-code'));
  const [codeOnly, setCodeOnly] = useState(false);
  const c = config.clients.find((x) => x.id === client) ?? config.clients[0];
  if (!c) return null;
  const snippet = codeOnly ? c.codeModeOnlySnippet : c.snippet;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Client"
          size="sm"
          value={client}
          onChange={(v) => {
            setClient(v);
            onClientChange?.(v);
          }}
          options={config.clients.map((x) => ({ value: x.id, label: x.name }))}
        />
        <span className="flex items-center gap-2">
          <Switch id="code-only" checked={codeOnly} onCheckedChange={setCodeOnly} />
          <Label htmlFor="code-only" className="text-[13px] font-normal">
            Code mode only
          </Label>
        </span>
      </div>
      <div className="relative">
        <pre aria-label={`${c.name} configuration`} className="overflow-x-auto rounded-lg border bg-muted/40 p-3 pr-12 font-mono text-[12.5px] leading-relaxed whitespace-pre">
          {snippet}
        </pre>
        <CopyButton value={snippet} ariaLabel={`Copy the ${c.name} snippet`} className="absolute top-2 right-2" variant="outline" size="icon-sm" />
      </div>
    </div>
  );
}
