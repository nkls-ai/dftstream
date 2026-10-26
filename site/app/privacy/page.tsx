import type { Metadata } from "next";

import { SITE } from "@/lib/nav";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What DFTStream stores and where, exactly what the opt-in telemetry sends, and what this website does not collect.",
};

/** One field the opt-in telemetry report may contain. Closed list — mirrors
 *  wrapper/internal/telemetry/telemetry.go, which validates every field
 *  against an allowlist before it leaves the process. */
interface TelemetryField {
  readonly field: string;
  readonly example: string;
  readonly description: string;
}

const TELEMETRY_FIELDS: readonly TelemetryField[] = [
  {
    field: "runTypes",
    example: "OPT, FREQ",
    description: "The job kinds the input requested, from a fixed vocabulary.",
  },
  {
    field: "orcaVersion",
    example: "6.0.1",
    description: "ORCA's own version string, as ORCA printed it.",
  },
  {
    field: "errorClass",
    example: "scf_not_converged",
    description: "The parser's failure classification. Empty on success.",
  },
  {
    field: "ok",
    example: "true",
    description: "Whether the run finished cleanly.",
  },
  {
    field: "wrapperVersion, apiVersion",
    example: "0.6.0, 1",
    description: "The DFTStream build that produced the report.",
  },
  {
    field: "os, arch",
    example: "linux, amd64",
    description: "Operating system and CPU architecture.",
  },
];

const NEVER_SENT: readonly string[] = [
  "Molecules: no geometries, no charges, no multiplicities, no element lists, no input text.",
  "Filenames or paths: no input path, no working directory, no run or experiment names.",
  "Identity: no hostname, no username, no organization, no run id.",
];

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16 md:px-6 md:py-20">
      <p className="os-label">Privacy</p>
      <h1 className="mt-4 text-[32px] font-semibold leading-[1.12] tracking-[-0.025em] text-text md:text-[40px]">
        What DFTStream stores, and where.
      </h1>

      <div className="mt-10 space-y-12 text-[14.5px] leading-relaxed text-muted">
        <section>
          <h2 className="os-label">Your calculations stay on your infrastructure</h2>
          <p className="mt-3">
            The wrapper reads ORCA&apos;s output as it is written, parses it, and records the run in
            the backend <em>you</em> point it at. By default that backend is a local database on the
            same machine, listening on <code className="font-mono text-[0.9em] text-text">127.0.0.1</code>.
            A group can instead run the backend on its own server, or pay us to host one. In every
            case, the inputs, geometries, energies, and artifacts of your runs live in that backend
            and nowhere else — DFTStream has no central service that sees your chemistry.
          </p>
          <p className="mt-3">
            Your original files are never modified: everything ORCA writes comes out of a tracked
            run byte-for-byte identical to a plain <code className="font-mono text-[0.9em] text-text">orca input.inp</code> run.
          </p>
        </section>

        <section>
          <h2 className="os-label">What a run record contains</h2>
          <p className="mt-3">
            Alongside the parsed chemistry, each tracked run stores machine metadata in your chosen
            backend: the hostname, the working directory, and the username that launched the run,
            plus the wrapper&apos;s log lines. This exists so a group can tell whose run ran where.
            It is visible to everyone with access to that backend — on a shared group backend, that
            means your colleagues. None of it is sent to us or to any third party; it goes only to
            the backend you configured.
          </p>
        </section>

        <section>
          <h2 className="os-label">Telemetry is opt-in, and off by default</h2>
          <p className="mt-3">
            The wrapper can report anonymous run outcomes so we learn which ORCA versions and job
            types fail, and how. It is disabled unless <strong className="font-medium text-text">both</strong>{" "}
            of these are set:
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5">
            <li>
              <code className="font-mono text-[0.9em] text-text">DFTSTREAM_TELEMETRY=1</code> — the
              opt-in switch, and
            </li>
            <li>
              <code className="font-mono text-[0.9em] text-text">DFTSTREAM_TELEMETRY_ENDPOINT</code>{" "}
              — an <code className="font-mono text-[0.9em] text-text">https://</code> URL to send to.
              A plaintext endpoint is rejected, not downgraded.
            </li>
          </ul>
          <p className="mt-3">
            Without both, nothing is collected — not stored for later, not sent. When enabled, one
            small report per run may contain exactly these fields:
          </p>

          <div className="os-card mt-5 overflow-x-auto">
            <table className="os-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Example</th>
                  <th>What it is</th>
                </tr>
              </thead>
              <tbody>
                {TELEMETRY_FIELDS.map((row) => (
                  <tr key={row.field}>
                    <td className="num text-text">{row.field}</td>
                    <td className="num text-faint">{row.example}</td>
                    <td className="text-muted">{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-5">
            The following is never reported — by construction, not by convention. Every field is
            validated against a narrow allowlist before it leaves the process; a filename, a path,
            or a molecule matches none of them and is dropped:
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5">
            {NEVER_SENT.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-3">
            The implementation is open source:{" "}
            <a
              href={`${SITE.repo}/blob/main/wrapper/internal/telemetry/telemetry.go`}
              className="text-accent hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              wrapper/internal/telemetry/telemetry.go
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="os-label">This website</h2>
          <p className="mt-3">
            This site is a set of static files. It sets no cookies, runs no analytics, and loads no
            third-party scripts — fonts are bundled at build time, so viewing a page here sends no
            request to anyone but the host serving the files.
          </p>
        </section>

        <section>
          <h2 className="os-label">Questions</h2>
          <p className="mt-3">
            Open an issue on{" "}
            <a
              href={`${SITE.repo}/issues`}
              className="text-accent hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
