import Link from "next/link";

import { DOC_NAV, DOC_SECTIONS, Route } from "@/lib/nav";

export function DocSidebar({ activeSlug }: { activeSlug?: string }) {
  return (
    <nav className="space-y-6 text-[13px]">
      {DOC_SECTIONS.map((section) => {
        const items = DOC_NAV.filter((item) => item.section === section);
        if (items.length === 0) return null;
        return (
          <div key={section}>
            <p className="os-label">{section}</p>
            <ul className="mt-2.5 space-y-0.5">
              {items.map((item) => {
                const active = item.slug === activeSlug;
                return (
                  <li key={item.slug}>
                    {/* Mirrors the app's sidebar nav item: 8px radius, a wash
                        when active, an accent rule on the leading edge. */}
                    <Link
                      href={`${Route.Docs}/${item.slug}/`}
                      aria-current={active ? "page" : undefined}
                      className={`relative block rounded-lg px-3 py-2 font-medium transition-colors ${
                        active
                          ? "bg-elevated text-text"
                          : "text-muted hover:bg-[color:var(--os-hover-wash)] hover:text-text"
                      }`}
                    >
                      {active ? (
                        <span
                          aria-hidden
                          className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-[3px]"
                          style={{ background: "var(--os-accent)" }}
                        />
                      ) : null}
                      {item.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
