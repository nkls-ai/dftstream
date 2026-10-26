import Link from "next/link";

import { Route } from "@/lib/nav";

/**
 * Without this, a wrong URL lands on Next's built-in page, which renders
 * outside the site's theme — a white flash that reads as a broken deploy.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col items-start px-5 py-24 md:px-6 md:py-32">
      <p className="os-label">404</p>
      <h1 className="mt-4 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-text md:text-[36px]">
        No such page.
      </h1>
      <p className="mt-4 max-w-md text-[14.5px] leading-relaxed text-muted">
        The link is wrong or the page moved. The documentation index is the best place to pick the
        thread back up.
      </p>
      <div className="mt-8 flex flex-wrap gap-3 text-[13px] font-medium">
        <Link
          href={Route.Docs}
          className="rounded-lg px-5 py-2.5 text-white transition-opacity hover:opacity-90"
          style={{ background: "var(--os-accent)" }}
        >
          Documentation
        </Link>
        <Link
          href={Route.Home}
          className="rounded-lg border border-line px-5 py-2.5 text-text transition-colors hover:border-accent hover:text-accent"
        >
          Home
        </Link>
      </div>
    </div>
  );
}
