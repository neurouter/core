import type { ComponentProps, ReactElement } from 'react';
import type { Capability } from '@/contract';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMe } from '@/hooks/use-me';
import { can, readOnlyReason } from '@/lib/permissions';
import { DEMO_READ_ONLY_ALLOW_UI } from '@/lib/demo-allow';

/**
 * Mutation-control state (frontend spec §9 "Read-only"): `disabled` plus the tooltip reason. In the
 * read-only demo only the simulated operations (`demoOp`) stay enabled.
 */
export function useGate(cap: Capability, demoOp?: string): { disabled: boolean; reason: string | null } {
  const me = useMe();
  if (!can(me, cap)) return { disabled: true, reason: readOnlyReason(me) };
  if (me.instance.demoReadOnly && !(demoOp && DEMO_READ_ONLY_ALLOW_UI.has(demoOp))) return { disabled: true, reason: 'Read-only demo' };
  return { disabled: false, reason: null };
}

/** Wraps a control with a tooltip that says why it is disabled. */
export function WithReason({ reason, children }: { reason: string | null; children: ReactElement }) {
  if (!reason) return children;
  return (
    <Tooltip>
      {/* a disabled button swallows pointer events; the span carries the tooltip and stays focusable */}
      <TooltipTrigger render={<span tabIndex={0} className="inline-flex rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={reason} />}>{children}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/** A Button gated by a capability: disabled with a tooltip reason for Viewers and the demo. */
export function GatedButton({ cap, demoOp, disabled, disabledReason, render, nativeButton, ...props }: ComponentProps<typeof Button> & { cap: Capability; demoOp?: string; disabledReason?: string | null }) {
  const gate = useGate(cap, demoOp);
  const off = gate.disabled || !!disabled;
  const reason = gate.reason ?? (disabled ? (disabledReason ?? null) : null);
  return (
    <WithReason reason={reason}>
      {/* a disabled link would still navigate: render a real disabled button instead */}
      {off ? <Button {...props} disabled /> : <Button {...props} {...(render ? { render, nativeButton: nativeButton ?? false } : {})} />}
    </WithReason>
  );
}
