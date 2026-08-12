/**
 * Shared line icons for Back Office.
 *
 * Hand-rolled rather than pulling in lucide-react: the codebase already inlines
 * its SVGs everywhere (KDS, Order Entry, the modal close buttons), and these are
 * drawn to the same grid Lucide uses — 24×24 viewBox, 2px stroke, round caps and
 * joins, no fills — so they sit consistently beside the existing ones.
 *
 * Every icon takes the same props and inherits `currentColor`, so colour comes
 * from the surrounding text style and nothing needs a hard-coded hex.
 */

function Svg({ size = 18, strokeWidth = 2, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ---- Navigation ---- */
export const IconHome = (p) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
    <path d="M9.5 21v-6h5v6" />
  </Svg>
);

export const IconUsers = (p) => (
  <Svg {...p}>
    <path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20" />
    <circle cx="10" cy="7.5" r="3.5" />
    <path d="M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4" />
    <path d="M15.5 4.2a3.5 3.5 0 0 1 0 6.6" />
  </Svg>
);

/* Fork + knife — the menu section. */
export const IconMenu = (p) => (
  <Svg {...p}>
    <path d="M6 3v7a2 2 0 0 0 4 0V3" />
    <path d="M8 10v11" />
    <path d="M17 3c-1.5 1.5-2 3.5-2 5.5S15.5 12 17 12.5V21" />
  </Svg>
);

export const IconPayroll = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6 10v4M18 10v4" />
  </Svg>
);

export const IconReports = (p) => (
  <Svg {...p}>
    <path d="M3 21h18" />
    <rect x="5" y="12" width="3.5" height="6" rx="1" />
    <rect x="10.25" y="7" width="3.5" height="11" rx="1" />
    <rect x="15.5" y="14" width="3.5" height="4" rx="1" />
  </Svg>
);

export const IconDevices = (p) => (
  <Svg {...p}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M10.5 5.5h3" />
    <path d="M11 18.5h2" />
  </Svg>
);

export const IconLogOut = (p) => (
  <Svg {...p}>
    <path d="M9.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4.5" />
    <path d="M16 16.5 20.5 12 16 7.5" />
    <path d="M20.5 12H9" />
  </Svg>
);

/* ---- Range selector / reports ---- */
export const IconCalendar = (p) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Svg>
);

export const IconClock = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5.2l3.2 2" />
  </Svg>
);

export const IconChart = (p) => (
  <Svg {...p}>
    <path d="M21 7.5 14 14l-4-3.5L3 17" />
    <path d="M15 7.5h6v6" />
  </Svg>
);

export const IconSliders = (p) => (
  <Svg {...p}>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="16" cy="18" r="2" />
  </Svg>
);

/* ---- List-row glyphs ---- */
export const IconPhone = (p) => (
  <Svg {...p}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </Svg>
);

export const IconLaptop = (p) => (
  <Svg {...p}>
    <rect x="4" y="5" width="16" height="11" rx="2" />
    <path d="M2 19.5h20" />
  </Svg>
);

export const IconUser = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.75" />
    <path d="M5 20v-1a4.5 4.5 0 0 1 4.5-4.5h5A4.5 4.5 0 0 1 19 19v1" />
  </Svg>
);

/* ---- Actions ---- */
export const IconPlus = (p) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconSearch = (p) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Svg>
);

export const IconChevronRight = (p) => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);

export const IconTrendUp = (p) => (
  <Svg {...p}>
    <path d="M21 7.5 14 14l-4-3.5L3 17" />
    <path d="M15 7.5h6v6" />
  </Svg>
);

export const IconTrendDown = (p) => (
  <Svg {...p}>
    <path d="M21 16.5 14 10l-4 3.5L3 7" />
    <path d="M15 16.5h6v-6" />
  </Svg>
);
