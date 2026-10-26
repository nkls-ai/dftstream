import Link from "next/link";

import { AppMark } from "@/components/app-mark";
import { FOOTER_NAV, PRIMARY_NAV, SITE } from "@/lib/nav";

export function SiteFooter() {
  return (
    <footer className="border-t border-line-soft">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 md:grid-cols-[2fr_1fr] md:px-6">
        <div className="max-w-lg">
          <p className="flex items-center gap-2.5">
            <AppMark size={24} />
            <span className="text-[15px] font-bold text-text">{SITE.name}</span>
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            DFTStream watches ORCA output. It is not part of ORCA and is not affiliated with FACCTs
            GmbH or the Max-Planck-Institut für Kohlenforschung. ORCA is developed by Frank Neese and
            his team, and is licensed separately.
          </p>
          <p className="os-label mt-5">Your files are never modified</p>
        </div>
        <nav className="flex flex-col gap-2 text-[13px] text-muted md:items-end">
          {[...PRIMARY_NAV, ...FOOTER_NAV].map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="transition-colors hover:text-text"
              {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
