import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DocSidebar } from "@/components/doc-sidebar";
import { Mdx } from "@/components/mdx";
import { assertDocNavMatchesContent, findDocNavItem, loadDoc, neighbours } from "@/lib/docs";
import { DOC_NAV, Route } from "@/lib/nav";

interface PageProps {
  params: Promise<{ slug: string[] }>;
}

export function generateStaticParams(): { slug: string[] }[] {
  assertDocNavMatchesContent();
  return DOC_NAV.map((item) => ({ slug: [item.slug] }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const nav = findDocNavItem(slug.join("/"));
  if (!nav) return {};
  return { title: nav.title, description: nav.description };
}

export default async function DocPage({ params }: PageProps) {
  const { slug } = await params;
  const key = slug.join("/");
  if (!findDocNavItem(key)) notFound();

  const doc = await loadDoc(key);
  const { prev, next } = neighbours(key);

  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 md:px-6 md:py-16 lg:grid-cols-[210px_1fr] lg:gap-12">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <DocSidebar activeSlug={key} />
      </aside>

      <article className="min-w-0">
        <p className="os-label">{doc.nav.section}</p>
        <div className="prose-app mt-4">
          <Mdx source={doc.body} />
        </div>

        <nav className="mt-16 flex flex-wrap justify-between gap-4 border-t border-line-soft pt-6 text-[13px]">
          {prev ? (
            <Link href={`${Route.Docs}/${prev.slug}/`} className="text-muted hover:text-accent">
              ← {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={`${Route.Docs}/${next.slug}/`} className="text-muted hover:text-accent">
              {next.title} →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>
    </div>
  );
}
