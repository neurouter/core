/**
 * The invite token travels in the link's fragment (`/invite#t=<token>`), so it never reaches
 * server logs. The accept page moves it into `sessionStorage` and strips the fragment, so the
 * token survives a detour through the login page (`returnTo=/invite`) in the same tab.
 */
export const INVITE_TOKEN_KEY = 'neurouter-invite-token';

export function readInviteToken(hash: string = window.location.hash): string | null {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('t');
  if (fromHash) {
    try {
      window.sessionStorage.setItem(INVITE_TOKEN_KEY, fromHash);
    } catch {
      // storage blocked: the token still works for this page view
    }
    return fromHash;
  }
  try {
    return window.sessionStorage.getItem(INVITE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearInviteToken(): void {
  try {
    window.sessionStorage.removeItem(INVITE_TOKEN_KEY);
  } catch {
    // ignore
  }
}
