/**
 * Points. Every accrual parameter (per-asset rates, cliff, cohort edges and
 * multipliers) comes from the ASP's published epochs (services/points-feed.ts);
 * nothing about the program is configured here.
 */
import { ACTIVE_APP_ENVIRONMENT, type AppEnvironment } from '@/config/app-environment';

/** Environments points may run in, while the program is only live on the staging ASP. */
const POINTS_ENVIRONMENTS: readonly AppEnvironment[] = ['staging'];

// Read through a static `process.env.EXPO_PUBLIC_*` member: Expo only inlines
// static member access at build time.
const POINTS_FLAG: boolean = process.env.EXPO_PUBLIC_POINTS_ENABLED?.toLowerCase() === 'true';

/** Both the build flag and the selected environment; the environment is fixed per page load. */
export const POINTS_ENABLED: boolean = POINTS_FLAG && POINTS_ENVIRONMENTS.includes(ACTIVE_APP_ENVIRONMENT);
