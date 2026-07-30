// Decorative visuals for the empty margins beside the hero headline.
//
// The hero text is constrained to ~max-w-2xl while the page is max-w-5xl,
// so on large screens there's ~150px of empty gutter on each side. We
// fill it with floating brand medallions and small node clusters that
// echo the product story (distributed voters linking on-chain) without
// crowding the headline.
//
// Everything here is purely ornamental: hidden from assistive tech,
// `pointer-events-none`, and only shown from `lg` up (below that there's
// no gutter to spare). Motion is disabled under `prefers-reduced-motion`
// via the animation classes in index.css.
import type { CSSProperties, ReactNode } from "react";
import {
  GoogleCloudLogo,
  StellarLogo,
  SunbirdLogo,
} from "@/components/BrandLogos";

// A frosted tile holding a brand logo, gently bobbing.
function Medallion({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`bob absolute flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-card/70 shadow-lg shadow-black/30 backdrop-blur ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}

// A tiny voter-graph: a few nodes wired together, softly floating.
function NodeCluster({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 72 96"
      className={`float-slow absolute ${className}`}
      style={style}
      fill="none"
    >
      <g stroke="hsl(var(--primary))" strokeWidth="1" opacity="0.45">
        <line x1="14" y1="16" x2="52" y2="30" />
        <line x1="52" y1="30" x2="30" y2="62" />
        <line x1="30" y1="62" x2="14" y2="16" />
        <line x1="30" y1="62" x2="58" y2="80" />
      </g>
      <g>
        <circle cx="14" cy="16" r="4" fill="hsl(var(--accent))" />
        <circle cx="52" cy="30" r="5" fill="hsl(var(--primary))" />
        <circle cx="30" cy="62" r="4" fill="hsl(var(--accent))" />
        <circle cx="58" cy="80" r="3" fill="hsl(var(--primary))" />
      </g>
    </svg>
  );
}

// A single twinkling node dot.
function Dot({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`twinkle absolute rounded-full bg-gradient-to-br from-accent to-primary ${className}`}
      style={style}
    />
  );
}

export function HeroDecor() {
  return (
    <div
      className="pointer-events-none absolute inset-0 hidden lg:block"
      aria-hidden="true"
    >
      {/* Left gutter */}
      <Medallion className="left-0 top-2">
        <StellarLogo className="size-7 text-foreground" />
      </Medallion>
      <NodeCluster className="left-3 top-24 h-24 w-16 opacity-80" />
      <Medallion
        className="left-2 top-48"
        style={{ animationDelay: "0.8s", animationDuration: "6s" }}
      >
        <GoogleCloudLogo className="size-7" />
      </Medallion>
      <Dot className="left-20 top-6 size-2" style={{ animationDelay: "0.2s" }} />
      <Dot className="left-10 top-40 size-2.5" style={{ animationDelay: "1.1s" }} />
      <Dot className="left-24 top-56 size-1.5" style={{ animationDelay: "0.6s" }} />

      {/* Right gutter */}
      <Medallion
        className="right-0 top-6"
        style={{ animationDelay: "0.4s", animationDuration: "5.5s" }}
      >
        <SunbirdLogo className="size-8" />
      </Medallion>
      <NodeCluster
        className="right-3 top-28 h-24 w-16 opacity-80"
        style={{ animationDelay: "0.9s" }}
      />
      <Medallion
        className="right-2 top-52"
        style={{ animationDelay: "1.2s", animationDuration: "6.5s" }}
      >
        <StellarLogo className="size-6 text-foreground/80" />
      </Medallion>
      <Dot className="right-20 top-4 size-2" style={{ animationDelay: "0.5s" }} />
      <Dot className="right-10 top-44 size-2.5" style={{ animationDelay: "0.9s" }} />
      <Dot className="right-24 top-60 size-1.5" style={{ animationDelay: "1.4s" }} />
    </div>
  );
}
