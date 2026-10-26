import type { Metadata } from "next";
import Link from "next/link";

import { DocSidebar } from "@/components/doc-sidebar";
import { DOC_NAV, DOC_SECTIONS, Route } from "@/lib/nav";

export const metadata: Metadata = {
  title: "Documentation",
  description: "How to use DFTStream, run a backend for a group, and work on the code.",
};

export default function DocsIndexPage() {
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 md:px-6 md:py-16 lg:grid-cols-[210px_1fr] lg:gap-12">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <DocSidebar />
      </aside>
      <div className="min-w-0">
        <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.025em] text-text md:text-[40px]">
          Documentation
        </h1>
        <p className="mt-4 max-w-xl text-[14.5px] leading-relaxed text-muted">
          Start with the quickstart if you already have ORCA on the machine. Everything here applies
          to the open-source build; organization features are documented separately.
        </p>

        <div className="mt-10 space-y-8">
          {DOC_SECTIONS.map((section) => (
            <section key={section}>
              <h2 className="os-label">{section}</h2>
              <ul className="os-card mt-3 divide-y divide-[color:var(--os-border-light)] overflow-hidden">
                {DOC_NAV.filter((item) => item.section === section).map((item) => (
                  <li key={item.slug}>
                    <Link
                      href={`${Route.Docs}/${item.slug}/`}
                      className="block px-4 py-3 text-[14px] text-text transition-colors hover:bg-[color:var(--os-hover-wash)] hover:text-accent"
                    >
                      {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
