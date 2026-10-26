import { TOUR } from "@/lib/shots";

/**
 * The animated click-through: a real GIF, encoded frame by frame from headless
 * captures of the running app.
 *
 * Motion is opt-out at the network level rather than in CSS. A `<picture>`
 * whose first `<source>` matches `prefers-reduced-motion: reduce` makes the
 * browser fetch the still poster instead of the animation — a reader who has
 * asked for less motion never downloads it at all.
 */
export function AppTour() {
  return (
    <figure className="min-w-0">
      <div
        className="overflow-hidden rounded-[10px] border border-line"
        style={{ boxShadow: "0 18px 44px var(--os-shadow)" }}
      >
        <picture>
          <source media="(prefers-reduced-motion: reduce)" srcSet={TOUR.poster} />
          {/* eslint-disable-next-line @next/next/no-img-element -- next/image cannot express a media-switched <source>. */}
          <img
            src={TOUR.gif}
            alt={TOUR.alt}
            width={TOUR.width}
            height={TOUR.height}
            className="block h-auto w-full"
          />
        </picture>
      </div>
    </figure>
  );
}
