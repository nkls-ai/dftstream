import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Expired CLI-link handshake rows are swept in a small batch on every
// /cli/link/start, but that endpoint is unauthenticated: a burst of starts
// can insert faster than its bounded sweep drains, and a deployment that
// never sees another start would keep the leftovers forever. This cron runs
// the same sweep with a larger batch so the table stays bounded either way.
crons.interval(
  "sweep expired CLI link handshakes",
  { minutes: 10 },
  internal.cliLinks.sweep,
  {},
);

export default crons;
