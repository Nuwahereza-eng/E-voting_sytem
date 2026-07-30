// Full-page ambient field of floating balloon/nodes that sits behind all
// HomePage content, from the hero down to the bottom. Purely decorative
// texture echoing the "distributed voters" story — no connecting lines
// (those read as threads), just softly drifting dots of varied size.
//
// Ornamental only: absolutely positioned, `pointer-events-none`, hidden
// from assistive tech, and disabled under `prefers-reduced-motion`.
import type { CSSProperties } from "react";

type Balloon = {
  left: string;
  top: string;
  size: number;
  delay: number;
  duration: number;
  blur?: boolean;
};

// Scattered across the full page — including behind the cards — at low
// opacity so they read as background bokeh rather than clickable dots.
const BALLOONS: Balloon[] = [
  { left: "4%", top: "5%", size: 14, delay: 0.0, duration: 6.5 },
  { left: "88%", top: "7%", size: 20, delay: 0.8, duration: 7.5, blur: true },
  { left: "22%", top: "12%", size: 8, delay: 1.4, duration: 5.5 },
  { left: "63%", top: "10%", size: 10, delay: 0.5, duration: 6.0 },
  { left: "94%", top: "18%", size: 12, delay: 1.1, duration: 7.0 },
  { left: "9%", top: "22%", size: 22, delay: 0.3, duration: 8.0, blur: true },
  { left: "48%", top: "26%", size: 9, delay: 1.7, duration: 5.8 },
  { left: "78%", top: "30%", size: 14, delay: 0.9, duration: 6.8 },
  { left: "33%", top: "34%", size: 7, delay: 0.2, duration: 5.2 },
  { left: "6%", top: "40%", size: 16, delay: 1.3, duration: 7.2, blur: true },
  { left: "91%", top: "43%", size: 10, delay: 0.6, duration: 6.3 },
  { left: "56%", top: "47%", size: 13, delay: 1.5, duration: 7.6 },
  { left: "18%", top: "52%", size: 9, delay: 0.4, duration: 5.6 },
  { left: "84%", top: "56%", size: 24, delay: 1.0, duration: 8.2, blur: true },
  { left: "42%", top: "60%", size: 8, delay: 1.8, duration: 5.4 },
  { left: "3%", top: "64%", size: 12, delay: 0.7, duration: 6.9 },
  { left: "70%", top: "67%", size: 10, delay: 0.1, duration: 6.1 },
  { left: "27%", top: "71%", size: 15, delay: 1.2, duration: 7.4, blur: true },
  { left: "95%", top: "74%", size: 9, delay: 0.5, duration: 5.9 },
  { left: "52%", top: "78%", size: 11, delay: 1.6, duration: 6.7 },
  { left: "12%", top: "82%", size: 18, delay: 0.9, duration: 7.8, blur: true },
  { left: "80%", top: "85%", size: 8, delay: 0.3, duration: 5.3 },
  { left: "38%", top: "89%", size: 13, delay: 1.4, duration: 7.1 },
  { left: "66%", top: "93%", size: 10, delay: 0.6, duration: 6.4 },
  { left: "7%", top: "95%", size: 16, delay: 1.1, duration: 7.7, blur: true },

  // Denser fill across the body (behind the cards), spread over the
  // mid-column and staggered between the rows above.
  { left: "40%", top: "8%", size: 6, delay: 0.9, duration: 5.7 },
  { left: "72%", top: "15%", size: 9, delay: 0.4, duration: 6.6 },
  { left: "15%", top: "16%", size: 11, delay: 1.6, duration: 7.3, blur: true },
  { left: "58%", top: "18%", size: 7, delay: 0.2, duration: 5.1 },
  { left: "30%", top: "24%", size: 12, delay: 1.0, duration: 6.9 },
  { left: "86%", top: "24%", size: 8, delay: 0.7, duration: 5.9 },
  { left: "63%", top: "32%", size: 10, delay: 1.3, duration: 7.0 },
  { left: "12%", top: "33%", size: 6, delay: 0.5, duration: 5.4 },
  { left: "45%", top: "38%", size: 14, delay: 1.8, duration: 7.7, blur: true },
  { left: "74%", top: "40%", size: 8, delay: 0.1, duration: 6.2 },
  { left: "25%", top: "42%", size: 11, delay: 1.1, duration: 6.8 },
  { left: "97%", top: "33%", size: 7, delay: 0.8, duration: 5.6 },
  { left: "36%", top: "48%", size: 9, delay: 0.3, duration: 6.5 },
  { left: "64%", top: "52%", size: 6, delay: 1.5, duration: 5.3 },
  { left: "8%", top: "55%", size: 12, delay: 0.9, duration: 7.2, blur: true },
  { left: "50%", top: "54%", size: 8, delay: 1.2, duration: 6.0 },
  { left: "30%", top: "58%", size: 10, delay: 0.6, duration: 6.7 },
  { left: "88%", top: "63%", size: 7, delay: 1.7, duration: 5.5 },
  { left: "58%", top: "64%", size: 13, delay: 0.4, duration: 7.5, blur: true },
  { left: "16%", top: "68%", size: 8, delay: 1.0, duration: 6.3 },
  { left: "45%", top: "70%", size: 6, delay: 0.2, duration: 5.2 },
  { left: "78%", top: "72%", size: 11, delay: 1.4, duration: 7.1 },
  { left: "35%", top: "80%", size: 9, delay: 0.7, duration: 6.6 },
  { left: "60%", top: "84%", size: 7, delay: 1.6, duration: 5.8 },
  { left: "22%", top: "88%", size: 12, delay: 0.5, duration: 7.4, blur: true },
  { left: "88%", top: "92%", size: 8, delay: 1.1, duration: 6.1 },
  { left: "50%", top: "96%", size: 10, delay: 0.3, duration: 6.9 },
  { left: "72%", top: "97%", size: 6, delay: 1.3, duration: 5.4 },
];

export function PageNodes() {
  return (
    <div
      className="pointer-events-none absolute inset-0 -z-0 overflow-hidden"
      aria-hidden="true"
    >
      {BALLOONS.map((b, i) => {
        const style: CSSProperties = {
          left: b.left,
          top: b.top,
          width: b.size,
          height: b.size,
          animationDelay: `${b.delay}s`,
          animationDuration: `${b.duration}s`,
        };
        return (
          <span
            key={i}
            className={`bob absolute rounded-full bg-gradient-to-br from-accent/60 to-primary/60 ${
              b.blur ? "opacity-30 blur-[2px]" : "opacity-45"
            }`}
            style={style}
          />
        );
      })}
    </div>
  );
}
