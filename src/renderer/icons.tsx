import React from "react";

// One 24px grid, 1.7 stroke, round joins. Authored for Stillwell; no icon font or CDN.
const paths = {
  arrange: (
    <>
      <path d="M5 3l12 7-5 1.6L9.5 17z" />
      <path d="M12.4 12l4.6 6" />
    </>
  ),
  crop: (
    <>
      <path d="M6 2v16h16" />
      <path d="M2 6h16v16" />
    </>
  ),
  cutout: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.2 8.2L20 20M8.2 15.8L20 4" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="1" />
      <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
    </>
  ),
  text: <path d="M5 7V4h14v3M12 4v16M9 20h6" />,
  adjust: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </>
  ),
  shelf: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1" />
      <rect x="3" y="14" width="18" height="6" rx="1" />
      <path d="M7 7h4M7 17h4" />
    </>
  ),
  print: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <rect x="7.5" y="6.5" width="9" height="11" />
    </>
  ),
  filters: (
    <>
      <circle cx="9" cy="10" r="5" />
      <circle cx="15" cy="10" r="5" />
      <circle cx="12" cy="15" r="5" />
    </>
  ),
  retouch: (
    <>
      <rect
        x="3"
        y="9"
        width="18"
        height="6"
        rx="3"
        transform="rotate(-40 12 12)"
      />
      <path d="M10.5 10.5l3 3" />
    </>
  ),
  draw: (
    <>
      <path d="M4 20l1-5L16 4l4 4L9 19z" />
      <path d="M14 6l4 4" />
    </>
  ),
  liquify: <path d="M3 8c3-3 6 3 9 0s6 3 9 0M3 16c3-3 6 3 9 0s6 3 9 0" />,
  layers: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 0 0 0 12h3" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4l16 16" />
      <path d="M9.9 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6M6.4 6.6C3.7 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4-.9" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="1.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="1.5" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </>
  ),
  export: (
    <>
      <path d="M12 15V3M7 8l5-5 5 5" />
      <path d="M4 14v7h16v-7" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <circle cx="9" cy="10" r="2" />
      <path d="M3 18l6-5 4 3 3-2 5 4" />
    </>
  ),
  group: (
    <>
      <path d="M3 6h7l2 2h9v11H3z" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  folder: <path d="M3 6h7l2 2h9v11H3z" />,
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  open: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M12 16V9M9 12l3-3 3 3" />
    </>
  ),
  paste: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="1.5" />
      <path d="M9 4V3h6v1M9 9h6M9 13h6M9 17h3" />
    </>
  ),
};

export type IconName = keyof typeof paths;

// The Stillwell mark (build/icon.svg without its tile): a sun on still water whose
// reflection breaks into tool-colour capsules.
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="logo"
      viewBox="232 270 560 548"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M252 540 A260 260 0 0 1 772 540 Z" fill="var(--go)" />
      <rect
        x="272"
        y="580"
        width="480"
        height="58"
        rx="29"
        fill="var(--t-cutout)"
      />
      <rect
        x="342"
        y="672"
        width="340"
        height="50"
        rx="25"
        fill="var(--t-text)"
      />
      <rect
        x="422"
        y="756"
        width="180"
        height="42"
        rx="21"
        fill="var(--t-arrange)"
      />
    </svg>
  );
}

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
