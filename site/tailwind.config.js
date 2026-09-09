/** Tokens live in src/index.css; this file only binds them to utilities. */
const token = (name) => `hsl(var(--${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: token('background'),
        foreground: token('foreground'),
        card: { DEFAULT: token('card'), foreground: token('card-foreground') },
        popover: { DEFAULT: token('popover'), foreground: token('popover-foreground') },
        primary: { DEFAULT: token('primary'), foreground: token('primary-foreground') },
        /* Solid CTAs are near-black; mint is the accent, not the fill. */
        ink: { DEFAULT: token('ink'), foreground: token('ink-foreground') },
        secondary: { DEFAULT: token('secondary'), foreground: token('secondary-foreground') },
        muted: { DEFAULT: token('muted'), foreground: token('muted-foreground') },
        accent: { DEFAULT: token('accent'), foreground: token('accent-foreground') },
        destructive: { DEFAULT: token('destructive'), foreground: token('destructive-foreground') },
        border: token('border'),
        input: token('input'),
        ring: token('ring'),

        /* `brand` aliases the mint accent so existing brand-* classes resolve. */
        brand: {
          50: 'hsl(163 60% 96%)',
          100: 'hsl(163 62% 92%)',
          200: 'hsl(163 64% 85%)',
          300: 'hsl(163 66% 76%)',
          400: 'hsl(163 68% 70%)',
          500: token('primary'),
          600: token('primary'),
          700: 'hsl(163 55% 38%)',
          800: 'hsl(163 52% 30%)',
          900: 'hsl(163 48% 24%)',
        },
      },
      borderColor: { DEFAULT: 'hsl(var(--border))' },
      borderRadius: {
        /* Modern but serious — never the everything-at-30px startup look. */
        lg: 'var(--radius)',                 /* 12px — cards */
        md: 'calc(var(--radius) - 4px)',     /*  8px — small UI */
        sm: 'calc(var(--radius) - 6px)',     /*  6px — inline */
        xl: 'calc(var(--radius) + 6px)',     /* 18px — large visualisations */
      },
      fontFamily: {
        /* A grotesk. Geist and Inter both sit in the Söhne/Suisse family. */
        sans: ['Inter', 'Geist', 'Helvetica Neue', 'ui-sans-serif', 'system-ui', 'Arial', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        tightest: '-0.038em',
        display: '-0.035em',
        eyebrow: '0.08em',
      },
      fontWeight: {
        /* 450 is the editorial weight: present without shouting. */
        book: '450',
      },
      boxShadow: {
        xs: 'none',
        card: 'none',
        pop: '0 8px 30px rgb(20 30 25 / 0.06), 0 24px 60px -30px rgb(20 30 25 / 0.10)',
      },
      transitionTimingFunction: {
        premium: 'cubic-bezier(.16, 1, .3, 1)',
      },
      transitionDuration: { 600: '600ms', 800: '800ms' },
      keyframes: {
        in: { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
        slideL: { from: { transform: 'translateX(100%)' }, to: { transform: 'none' } },
      },
      animation: {
        in: 'in 500ms cubic-bezier(.16, 1, .3, 1)',
        slideL: 'slideL 600ms cubic-bezier(.16, 1, .3, 1)',
      },
    },
  },
  plugins: [],
}
