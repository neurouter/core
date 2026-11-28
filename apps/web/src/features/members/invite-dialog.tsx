import { useState } from 'react';
import { InviteRole, type InviteCreated } from '@/contract';
import { GatedButton } from '@/components/app/gated';
import { CopyButton } from '@/components/code/copy-button';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/permissions';
import { useCreateInvite } from './queries';

const ROLE_HELP: Record<InviteRole, string> = {
  admin: 'Operates the gateway: servers, environments, keys, evals and settings. Can invite members.',
  viewer: 'Sees everything read-only.',
};

/**
 * "Invite member" (multi-tenancy spec §2.4): email + role. No email is sent; the link is shown
 * once with a copy button, for the admin to pass on.
 */
export function InviteDialog({ orgName, onClose }: { orgName: string; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('viewer');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<InviteCreated | null>(null);
  const create = useCreateInvite();

  if (created) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Invite link for {created.invite.email}</DialogTitle>
            <DialogDescription>
              Copy the link now and send it to {created.invite.email}. It is shown only once, works once, and expires on {formatDate(created.invite.expiresAt)}. They must sign in with this email address to accept.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code aria-label="Invite link" className="min-w-0 flex-1 truncate rounded-lg border bg-muted/40 px-3 py-2 font-mono text-[12.5px]" title={created.url}>
              {created.url}
            </code>
            <CopyButton value={created.url} label="Copy link" variant="outline" size="sm" />
          </div>
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
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>Invite someone to {orgName}. You get a link to send them; no email is sent.</DialogDescription>
        </DialogHeader>
        <form
          id="invite-member"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate(
              { email: email.trim(), role },
              { onSuccess: setCreated, onError: (err) => setError(err instanceof ApiError ? (err.fieldErrors[0]?.message ?? err.detail ?? err.title) : 'Could not create the invite') },
            );
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inv-email">Email</Label>
            <Input id="inv-email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" aria-invalid={error ? true : undefined} aria-describedby={error ? 'inv-error' : undefined} />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Role</legend>
            {InviteRole.options.map((r) => (
              <label key={r} className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-[13.5px] has-checked:border-primary has-checked:bg-primary/5">
                <input type="radio" name="inv-role" value={r} checked={role === r} onChange={() => setRole(r)} className="mt-0.5 accent-primary" />
                <span className="flex flex-col">
                  <span className="font-medium">{ROLE_LABEL[r]}</span>
                  <span className="text-[13px] text-muted-foreground">{ROLE_HELP[r]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error ? (
            <p id="inv-error" role="alert" className="text-[13.5px] text-destructive">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <GatedButton cap="members:invite" type="submit" form="invite-member" disabled={!email.trim() || create.isPending}>
            Create invite link
          </GatedButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
