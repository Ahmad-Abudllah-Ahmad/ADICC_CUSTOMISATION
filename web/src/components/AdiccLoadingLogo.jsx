// Loading mark: stroke draws continuously from the start of “A” through the end of the last “C”,
// then fills solid, then resets — loops until unmounted.
import React from "react";

export default function AdiccLoadingLogo() {
  return (
    <>
      <style>{`
        @keyframes adicc-logo-draw {
          0%   { stroke-dashoffset: 520; fill-opacity: 0; stroke-opacity: 1; }
          52%  { stroke-dashoffset: 0;   fill-opacity: 0; stroke-opacity: 1; }
          68%  { stroke-dashoffset: 0;   fill-opacity: 1; stroke-opacity: 0.55; }
          78%  { stroke-dashoffset: 0;   fill-opacity: 1; stroke-opacity: 0; }
          90%  { stroke-dashoffset: 0;   fill-opacity: 1; stroke-opacity: 0; }
          100% { stroke-dashoffset: 520; fill-opacity: 0; stroke-opacity: 0; }
        }
        .adicc-logo-draw-text {
          stroke-dasharray: 520;
          stroke-linecap: round;
          stroke-linejoin: round;
          paint-order: stroke fill;
          animation: adicc-logo-draw 2.5s cubic-bezier(0.4, 0.05, 0.45, 0.95) infinite;
        }
      `}</style>
      <svg width="148" height="36" viewBox="0 0 148 36" role="img" aria-label="ADICC" style={{ display: "block" }}>
        <text
          x="74"
          y="26"
          textAnchor="middle"
          className="adicc-logo-draw-text"
          style={{
            fontFamily: "var(--f-display)",
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            fill: "var(--ink)",
            stroke: "var(--ink)",
            strokeWidth: 1.2,
          }}
        >
          ADI
          <tspan style={{ fontStyle: "italic", fill: "var(--cobalt)", stroke: "var(--cobalt)" }}>CC</tspan>
        </text>
      </svg>
    </>
  );
}
