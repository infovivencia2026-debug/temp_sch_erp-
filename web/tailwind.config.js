/** Tokens live in src/index.css; this file only binds them to utilities. */
const token = (name) => `hsl(var(--${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  /* BREAKPOINTS ARE STOCK, AND THAT IS A DECISION.

     `theme.screens` is deliberately not overridden. Every responsive class in
     web/src, both stylesheets' width media queries, and lib/viewport.ts are
     all keyed to Tailwind's own sm/md/lg — and the one thing that must never
     happen is a JS answer and a CSS answer about the same device that differ
     by a few pixels, which is invisible until it is a bug nobody can
     reproduce.

     The three device shapes the product actually has, in those terms:

       phone     below md (768)      one column; the sidebar is an off-canvas
                                     drawer; the Focus board is a paged home
                                     screen with the dock on the bottom edge.
       tablet    md to lg (768-1023) the sidebar is a permanent 58px icon rail
                                     with no hamburger and no scrim.
       desktop   lg (1024) and up    both sidebar panes; the Focus board is the
                                     fixed five-by-three grid.

     `sm` (640) is still used, and means something narrower: it is the width at
     which a card grid stops being one column. It is not a device line, which
     is why the phone/tablet line above is md and not sm — a large phone in
     landscape crosses 640 and is still a phone.

     `xl` appears in a handful of places and means "very wide"; there is no
     fourth device shape behind it. */
  theme: {
    extend: {
      colors: {
        background: token('background'),
        foreground: token('foreground'),
        ground: token('ground'),
        sidebar: token('sidebar'),
        'surface-subtle': token('surface-subtle'),
        'surface-hover': token('surface-hover'),
        'nav-active': token('nav-active'),
        card: { DEFAULT: token('card'), foreground: token('card-foreground') },
        popover: { DEFAULT: token('popover'), foreground: token('popover-foreground') },
        primary: { DEFAULT: token('primary'), foreground: token('primary-foreground') },
        /* Kept as an alias of primary so the handful of call sites that named
           the old near-black CTA keep working while they are converted. */
        ink: { DEFAULT: token('primary'), foreground: token('primary-foreground') },
        info: token('info'),
        elevated: token('elevated'),
        secondary: { DEFAULT: token('secondary'), foreground: token('secondary-foreground') },
        muted: { DEFAULT: token('muted'), foreground: token('muted-foreground') },
        accent: { DEFAULT: token('accent'), foreground: token('accent-foreground') },
        destructive: { DEFAULT: token('destructive'), foreground: token('destructive-foreground') },
        success: token('success'),
        warning: token('warning'),
        rail: { DEFAULT: token('rail'), foreground: token('rail-foreground') },
        border: token('border'),
        'border-strong': token('border-strong'),
        input: token('input'),
        ring: token('ring'),
      },
      borderColor: { DEFAULT: 'hsl(var(--border))' },
      borderRadius: {
        /* By component weight: controls tightest, dialogs loosest. Pills are
           reserved for status and tags, never for buttons. */
        sm: 'var(--radius-control)',   /* 6px  buttons, chips */
        md: 'var(--radius-input)',     /* 8px  inputs, selects */
        lg: 'var(--radius-card)',      /* 10px cards */
        xl: 'var(--radius-dialog)',    /* 12px dialogs */
      },
      fontFamily: {
        /* 'Inter Variable' first: that is the family name @fontsource-variable
           registers, and the bundled file is the only Inter guaranteed to be
           present. Plain 'Inter' follows for anyone who has it installed
           locally, then the system stack for the moment before the woff2
           arrives. Naming only 'Inter' — as this did — matched nothing at all
           and fell silently through to Helvetica Neue. */
        sans: ['Inter Variable', 'Inter', 'Geist', 'Helvetica Neue', 'ui-sans-serif', 'system-ui', 'Arial', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        tightest: '-0.02em',
        display: '-0.02em',
        eyebrow: '0',
      },
      fontWeight: {
        /* 450 is the editorial weight: present without shouting. */
        book: '450',
      },
      boxShadow: {
        /* Only overlays lift off the page; everything in flow is separated by
           a border and a tonal step. */
        xs: 'none',
        card: 'none',
        pop: '0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px -8px rgb(0 0 0 / 0.12)',
      },
      transitionTimingFunction: {
        premium: 'cubic-bezier(.16, 1, .3, 1)',
      },
      transitionDuration: { 600: '600ms', 800: '800ms' },
      fontSize: {
        /* The scale, named by role rather than by size, so a component says
           what a value is for instead of how big it happens to be. */
        caption: ['12px', { lineHeight: '1.4' }],
        secondary: ['13px', { lineHeight: '1.45' }],
        body: ['14px', { lineHeight: '1.5' }],
        card: ['15px', { lineHeight: '1.4', fontWeight: '600' }],
        section: ['18px', { lineHeight: '1.35', fontWeight: '600' }],
        page: ['24px', { lineHeight: '1.25', fontWeight: '600' }],
        metric: ['28px', { lineHeight: '1.15', fontWeight: '600' }],
      },
    },
  },
  plugins: [],
}
