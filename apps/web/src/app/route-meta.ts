/** Per-route static data used by the shell (breadcrumbs). */
export interface AppStaticData {
  /** Breadcrumb trail, e.g. ['Servers', 'Acme Orders API'] (dynamic crumbs are set by the page). */
  crumbs?: string[];
}

declare module '@tanstack/react-router' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface StaticDataRouteOption extends AppStaticData {}
}
