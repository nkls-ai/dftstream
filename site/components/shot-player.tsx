"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import { SHOTS } from "@/lib/shots";

/** How long each frame is held before the player advances. */
const HOLD_MS = 4000;

/**
 * The application shown the way a GIF would show it — frames auto-advance and
 * crossfade — but scrubbable: every step is a button, and hovering pauses.
 * Auto-advance is disabled entirely under prefers-reduced-motion.
 */
export function ShotPlayer() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduceMotion(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const playing = !paused && !reduceMotion;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      setIndex((current) => (current + 1) % SHOTS.length);
    }, HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [playing, index]);

  const active = SHOTS[index];

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Application views">
        {SHOTS.map((shot, shotIndex) => {
          const selected = shotIndex === index;
          return (
            <button
              key={shot.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setIndex(shotIndex)}
              className={`relative overflow-hidden rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.06em] transition-colors ${
                selected
                  ? "bg-elevated text-text"
                  : "text-faint hover:text-muted"
              }`}
            >
              {selected && playing && (
                <span
                  key={index}
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-[2px] origin-left"
                  style={{
                    background: "var(--os-accent)",
                    animation: `os-fill ${HOLD_MS}ms linear both`,
                  }}
                />
              )}
              {selected && !playing && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-[2px]"
                  style={{ background: "var(--os-accent)" }}
                />
              )}
              {shot.label}
            </button>
          );
        })}
      </div>

      <div
        className="relative mt-4 overflow-hidden rounded-[10px] border border-line"
        style={{
          aspectRatio: `${active.width} / ${active.height}`,
          boxShadow: "0 18px 44px var(--os-shadow)",
        }}
      >
        {SHOTS.map((shot, shotIndex) => (
          <Image
            key={shot.id}
            src={shot.src}
            alt={shot.alt}
            fill
            sizes="(max-width: 1024px) 100vw, 1104px"
            priority={shotIndex === 0}
            className="object-cover transition-opacity duration-500"
            style={{ opacity: shotIndex === index ? 1 : 0 }}
          />
        ))}
      </div>

      <p className="mt-3 text-[14px] leading-snug text-muted">{active.caption}</p>
    </div>
  );
}
