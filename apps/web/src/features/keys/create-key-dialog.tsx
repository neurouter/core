import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DownloadIcon, TriangleAlertIcon } from 'lucide-react';
import type { ApiKeyCreated } from '@/contract';
import { GatedButton } from '@/components/app/gated';
import { CopyButton } from '@/components/code/copy-button';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ClientSnippet } from '@/features/connect/client-snippet';
import { environmentsQuery } from '@/features/environments/queries';
import { serversQuery } from '@/features/servers/queries';
import { ApiError } from '@/lib/api-client';
import { useCreateKey } from './queries';

/** Create key (adapted from Hub): name, server, environment, scopes, expiry; then the secret once. */
export function CreateKeyDialog({ defaults, onClose }: { defaults: { server?: string | undefined; env?: string | undefined }; onClose: () => void }) {
  const servers = useQuery(serversQuery());
  const [serverId, setServerId] = useState(defaults.server ?? '');
  const sid = serverId || servers.data?.items[0]?.id || '';
  const envs = useQuery({ ...environmentsQuery(sid), enabled: !!sid });
  const [envId, setEnvId] = useState(defaults.env ?? '');
  const eid = envId || envs.data?.items.find((e) => e.kind === 'dev' && !e.isMock)?.id || envs.data?.items[0]?.id || '';
  const env = envs.data?.items.find((e) => e.id === eid);
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [code, setCode] = useState(true);
  const [expires, setExpires] = useState<'30' | '90' | '365' | 'never'>('90');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const create = useCreateKey();
  if (created) {
    const envLine = `NEUROUTER_API_KEY=${created.token}`;
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Key created: {created.key.name}</DialogTitle>
            <DialogDescription>Copy the secret now. It is shown only once and cannot be recovered.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code aria-label="API key secret" className="min-w-0 flex-1 truncate rounded-lg border bg-muted/40 px-3 py-2 font-mono text-[12.5px]">
              {created.token}
            </code>
            <CopyButton value={created.token} label="Copy" variant="outline" size="sm" />
            <Button variant="outline" size="sm" render={<a href={`data:text/plain;charset=utf-8,${encodeURIComponent(envLine + '\n')}`} download=".env.neurouter" />} nativeButton={false}>
              <DownloadIcon /> .env line
            </Button>
          </div>
          {created.warnings.map((w) => (
            <p key={w} className="flex items-center gap-2 text-[13px] text-warning">
              <TriangleAlertIcon aria-hidden="true" className="size-4" /> {w}
            </p>
          ))}
          <h3 className="text-sm font-semibold">Connect a client</h3>
          <ClientSnippet config={created.connect} />
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an API key</DialogTitle>
          <DialogDescription>An agent token is bound to one environment.</DialogDescription>
        </DialogHeader>
        <form
          id="create-key"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate(
              { name, serverId: sid, environmentId: eid, scopes: ['tools:read', ...(write ? (['tools:write'] as const) : []), ...(code ? (['code:run'] as const) : [])], expiresInDays: expires === 'never' ? null : Number(expires) },
              { onSuccess: setCreated, onError: (err) => setError(err instanceof ApiError ? (err.fieldErrors[0]?.message ?? err.detail ?? err.title) : 'Could not create the key') },
            );
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="k-name">Name</Label>
            <Input id="k-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="support-copilot" className="font-mono" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="k-server">Server</Label>
              <select id="k-server" className="h-9 rounded-lg border bg-background px-2 text-sm" value={sid} onChange={(e) => (setServerId(e.target.value), setEnvId(''))}>
                {servers.data?.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="k-env">Environment</Label>
              <select id="k-env" required className="h-9 rounded-lg border bg-background px-2 text-sm" value={eid} onChange={(e) => setEnvId(e.target.value)}>
                {envs.data?.items.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.slug}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">Access</legend>
            <label className="inline-flex items-center gap-2 text-[13.5px]">
              <Checkbox checked disabled /> Read tools
            </label>
            <label className="inline-flex items-center gap-2 text-[13.5px]">
              <Checkbox checked={write} onCheckedChange={(v) => setWrite(!!v)} /> Write tools (only those enabled in {env?.slug ?? 'the environment'})
            </label>
            <label className="inline-flex items-center gap-2 text-[13.5px]">
              <Checkbox checked={code} onCheckedChange={(v) => setCode(!!v)} /> Code mode (run_script)
            </label>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="k-exp">Expires</Label>
            <select id="k-exp" className="h-9 rounded-lg border bg-background px-2 text-sm" value={expires} onChange={(e) => setExpires(e.target.value as typeof expires)}>
              <option value="30">in 30 days</option>
              <option value="90">in 90 days</option>
              <option value="365">in a year</option>
              <option value="never">never</option>
            </select>
            {expires === 'never' ? <span className="text-xs text-warning">Keys that never expire are a risk if they leak.</span> : null}
          </div>
          {error ? (
            <p role="alert" className="text-[13.5px] text-destructive">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <GatedButton cap="keys:manage" type="submit" form="create-key" disabled={!name || !eid || create.isPending}>
            Create key
          </GatedButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
