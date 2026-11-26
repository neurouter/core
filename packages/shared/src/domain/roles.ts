import * as z from 'zod';

/** Console roles (A28): Admin and Viewer only. */
export const Role = z.enum(['admin', 'viewer']);
export type Role = z.infer<typeof Role>;
