import Link from "next/link";

import { AppMark } from "@/components/app-mark";
import { PRIMARY_NAV, Route, SITE } from "@/lib/nav";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-line-soft bg-sidebar/90 backdrop-blur-md">
      {/* Below `sm` the nav wraps under the wordmark — five links do not fit
          beside it on a phone, and a header that overflows makes every page
          scroll sideways. */}
      <div className="mx-auto flex max-w-6xl flex-col gap-1.5 px-5 py-2.5 sm:h-14 sm:flex-row sm:items-center sm:gap-8 sm:py-0 md:px-6">
        <Link href={Route.Home} className="flex items-center gap-2.5">
          <AppMark />
          <span className="text-[15px] font-bold tracking-[0.01em] text-text">{SITE.name}</span>
        </Link>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] font-medium text-muted sm:ml-auto sm:gap-6">
          {PRIMARY_NAV.map((link) => (
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
    </header>
  );
}
