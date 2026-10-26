/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as artifacts from "../artifacts.js";
import type * as auth from "../auth.js";
import type * as authz from "../authz.js";
import type * as cliLinks from "../cliLinks.js";
import type * as crons from "../crons.js";
import type * as events from "../events.js";
import type * as excitedStates from "../excitedStates.js";
import type * as experiments from "../experiments.js";
import type * as frequencies from "../frequencies.js";
import type * as geometries from "../geometries.js";
import type * as http from "../http.js";
import type * as lib_artifactQuota from "../lib/artifactQuota.js";
import type * as lib_authIssuers from "../lib/authIssuers.js";
import type * as lib_batchProgressWriter from "../lib/batchProgressWriter.js";
import type * as lib_batchSummary from "../lib/batchSummary.js";
import type * as lib_cascade from "../lib/cascade.js";
import type * as lib_credentialRevocation from "../lib/credentialRevocation.js";
import type * as lib_deltaRollup from "../lib/deltaRollup.js";
import type * as lib_experimentProgressWriter from "../lib/experimentProgressWriter.js";
import type * as lib_experimentSummary from "../lib/experimentSummary.js";
import type * as lib_identityProviders from "../lib/identityProviders.js";
import type * as lib_migrationState from "../lib/migrationState.js";
import type * as lib_runChildren from "../lib/runChildren.js";
import type * as lib_sha256 from "../lib/sha256.js";
import type * as lib_stepBudget from "../lib/stepBudget.js";
import type * as lib_util from "../lib/util.js";
import type * as logs from "../logs.js";
import type * as machineTokens from "../machineTokens.js";
import type * as meta from "../meta.js";
import type * as metrics from "../metrics.js";
import type * as migrations from "../migrations.js";
import type * as nmrShields from "../nmrShields.js";
import type * as organizations from "../organizations.js";
import type * as pathways from "../pathways.js";
import type * as queue from "../queue.js";
import type * as reimport from "../reimport.js";
import type * as runs from "../runs.js";
import type * as spool from "../spool.js";
import type * as sysSamples from "../sysSamples.js";
import type * as templates from "../templates.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  artifacts: typeof artifacts;
  auth: typeof auth;
  authz: typeof authz;
  cliLinks: typeof cliLinks;
  crons: typeof crons;
  events: typeof events;
  excitedStates: typeof excitedStates;
  experiments: typeof experiments;
  frequencies: typeof frequencies;
  geometries: typeof geometries;
  http: typeof http;
  "lib/artifactQuota": typeof lib_artifactQuota;
  "lib/authIssuers": typeof lib_authIssuers;
  "lib/batchProgressWriter": typeof lib_batchProgressWriter;
  "lib/batchSummary": typeof lib_batchSummary;
  "lib/cascade": typeof lib_cascade;
  "lib/credentialRevocation": typeof lib_credentialRevocation;
  "lib/deltaRollup": typeof lib_deltaRollup;
  "lib/experimentProgressWriter": typeof lib_experimentProgressWriter;
  "lib/experimentSummary": typeof lib_experimentSummary;
  "lib/identityProviders": typeof lib_identityProviders;
  "lib/migrationState": typeof lib_migrationState;
  "lib/runChildren": typeof lib_runChildren;
  "lib/sha256": typeof lib_sha256;
  "lib/stepBudget": typeof lib_stepBudget;
  "lib/util": typeof lib_util;
  logs: typeof logs;
  machineTokens: typeof machineTokens;
  meta: typeof meta;
  metrics: typeof metrics;
  migrations: typeof migrations;
  nmrShields: typeof nmrShields;
  organizations: typeof organizations;
  pathways: typeof pathways;
  queue: typeof queue;
  reimport: typeof reimport;
  runs: typeof runs;
  spool: typeof spool;
  sysSamples: typeof sysSamples;
  templates: typeof templates;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
