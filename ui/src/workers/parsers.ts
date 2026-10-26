// Registry of the heavy, full-file ORCA parsers that run in a Web Worker so a
// multi-MB output doesn't freeze the UI thread. Every function here must be
// pure (string in → serializable data out) and live in a module free of
// React/DOM imports, so it loads cleanly into the worker.
import { parseThermo, parseOutProperties } from "../routes/runDetailParsers";
import { parseIRCOutput } from "../routes/irc";
import { parseScanOutput } from "../routes/scan";
import { parseNEBOutput } from "../routes/neb";
import { parseGoatOutput } from "../routes/goat";
import { parseMultiXYZ } from "../components/xyz";

export const PARSERS = {
  thermo: parseThermo,
  outProperties: parseOutProperties,
  irc: parseIRCOutput,
  scan: parseScanOutput,
  neb: parseNEBOutput,
  goat: parseGoatOutput,
  multixyz: parseMultiXYZ,
} as const;

export type ParseKind = keyof typeof PARSERS;
export type ParseResult<K extends ParseKind> = ReturnType<(typeof PARSERS)[K]>;
