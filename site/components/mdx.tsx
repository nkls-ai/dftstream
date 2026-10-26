import { MDXRemote, type MDXRemoteProps } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";

/**
 * Every MDX surface on the site renders through this one component, so docs and
 * the changelog can never drift onto different plugin sets.
 *
 * MDX ships CommonMark only, without GFM. `remark-gfm` is what turns the pipe
 * tables in docs/ into tables instead of literal rows of `|` characters.
 */
const MDX_OPTIONS: MDXRemoteProps["options"] = {
  // `parseFrontmatter` stays off: neither docs/ nor the changelog has any.
  mdxOptions: { remarkPlugins: [remarkGfm] },
};

/**
 * A markdown table gets its own scroll container. Without the wrapper the
 * table itself has to carry `overflow-x`, which forces `display: block` — and
 * a block table stops distributing width, so the header band ends halfway
 * across the row on wide screens.
 */
const COMPONENTS: MDXRemoteProps["components"] = {
  table: (props: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="prose-app-table">
      <table {...props} />
    </div>
  ),
};

/**
 * Renders a Markdown/MDX string. A malformed source throws during the static
 * build — which is what we want: a broken doc must fail the build loudly rather
 * than ship a page with content silently missing.
 */
export function Mdx({ source }: { source: string }) {
  return <MDXRemote source={source} options={MDX_OPTIONS} components={COMPONENTS} />;
}
