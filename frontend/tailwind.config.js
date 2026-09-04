/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      /*
       * Preflight paints `border-color` on EVERY element from these defaults,
       * and Tailwind's own default is gray-200 — a bright white line that shows
       * up the moment any border utility resolves to nothing. Pointing the
       * defaults at the theme's border means the worst case is an invisible
       * hairline in the right colour rather than a white one in the wrong one.
       */
      borderColor: { DEFAULT: 'var(--border)' },
      divideColor: { DEFAULT: 'var(--border)' },
      colors: {
        /**
         * Colors resolve to CSS variables defined in theme.css.
         *
         * IMPORTANT: anything that may be used with a Tailwind opacity modifier
         * (`bg-accent/30`, `bg-surface-1/60`, `text-text-dim/50`, …) MUST go
         * through the `rgb(var(--x-rgb) / <alpha-value>)` form. Pointing a color
         * straight at `var(--hex-color)` makes the modifier compile to
         * `rgb(#bd7d1c / 0.3)`, which is invalid CSS — the browser drops the
         * declaration and the element renders transparent (or, for borders,
         * falls back to Tailwind's default gray). That silently broke every
         * tinted surface, accent rail and heatmap cell in the app.
         *
         * Colors that already bake an alpha into their value (--border,
         * --primary-light, the *-bg tints) keep the plain `var()` form: they are
         * used as-is and have no meaningful channel mirror.
         */
        /** Channel-backed border colour — see `border.hairline` below. */
        hairline: 'rgb(var(--border-rgb) / <alpha-value>)',
        surface: {
          0: 'rgb(var(--surface-0-rgb) / <alpha-value>)',
          1: 'rgb(var(--surface-1-rgb) / <alpha-value>)',
          2: 'rgb(var(--surface-2-rgb) / <alpha-value>)',
          3: 'rgb(var(--surface-3-rgb) / <alpha-value>)',
          4: 'rgb(var(--surface-4-rgb) / <alpha-value>)',
        },
        border: {
          // Alpha already baked in — no modifier support by design.
          DEFAULT: 'var(--border)',
          bright: 'var(--border-bright)',
          /*
           * The opacity-capable border.
           *
           * `border-border/40` is invalid CSS — the alpha is already inside
           * `var(--border)`, so the modifier compiles to `rgb(rgba(...) / .4)`,
           * the browser drops the declaration, and the element falls back to
           * Tailwind's DEFAULT border colour. That default is gray-200: a
           * BRIGHT WHITE line, which is how a file-tree indent guide and the run
           * timer ended up outlined in white on a dark theme.
           *
           * Use `border-hairline/40` when a border genuinely needs its own
           * alpha. It goes through the channel mirror, so the modifier works.
           */
          hairline: 'rgb(var(--border-rgb) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--primary-rgb) / <alpha-value>)',
          bright: 'rgb(var(--primary-hover-rgb) / <alpha-value>)',
          muted: 'var(--primary-light)',
          glow: 'var(--primary-light)',
        },
        text: {
          DEFAULT: 'rgb(var(--text-rgb) / <alpha-value>)',
          muted: 'rgb(var(--text-muted-rgb) / <alpha-value>)',
          dim: 'rgb(var(--text-dim-rgb) / <alpha-value>)',
          bright: 'rgb(var(--text-bright-rgb) / <alpha-value>)',
        },
        // Status colors using Solarized palette
        green: {
          agent: 'rgb(var(--success-rgb) / <alpha-value>)',
          muted: 'rgb(var(--success-rgb) / <alpha-value>)',
        },
        amber: {
          agent: 'rgb(var(--warning-rgb) / <alpha-value>)',
        },
        red: {
          agent: 'rgb(var(--error-rgb) / <alpha-value>)',
        },
        blue: {
          agent: 'rgb(var(--info-rgb) / <alpha-value>)',
        },
        // Additional Solarized accent colors
        orange: {
          agent: 'rgb(var(--secondary-rgb) / <alpha-value>)',
        },
        // These used to point at fixed Solarized channels, which meant eight of
        // the nine palettes had a handful of components rendering in a colour
        // from a theme the user had not chosen. They now resolve through the
        // per-palette variables emitted by scripts/gen-themes.js.
        cyan: {
          agent: 'rgb(var(--cyan-agent-rgb) / <alpha-value>)',
        },
        magenta: {
          agent: 'rgb(var(--violet-agent-rgb) / <alpha-value>)',
        },
        violet: {
          agent: 'rgb(var(--violet-agent-rgb) / <alpha-value>)',
        },
        brown: {
          agent: 'rgb(var(--brown-agent-rgb) / <alpha-value>)',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
      },
      /**
       * The whole type scale, stepped down one notch from Tailwind's defaults.
       *
       * Overriding the named sizes rather than zooming the root is deliberate:
       * every `text-sm` / `text-xs` in the app moves together, the values are
       * readable here instead of being an emergent property of a root rem, and
       * the arbitrary `text-[11px]` labels — which are already at the floor of
       * legibility — are left exactly where they are rather than being dragged
       * down to 9px along with everything else.
       *
       * Line heights come down with the sizes, but proportionally less: dense
       * text needs its leading more than large text does, and simply scaling
       * both by the same factor is what makes a shrunk UI feel cramped.
       */
      fontSize: {
        xs: ['0.6875rem', { lineHeight: '1rem' }],        // 12 → 11px
        sm: ['0.8125rem', { lineHeight: '1.125rem' }],    // 14 → 13px
        base: ['0.875rem', { lineHeight: '1.375rem' }],   // 16 → 14px
        lg: ['1rem', { lineHeight: '1.5rem' }],           // 18 → 16px
        xl: ['1.125rem', { lineHeight: '1.625rem' }],     // 20 → 18px
        '2xl': ['1.375rem', { lineHeight: '1.8125rem' }], // 24 → 22px
        '3xl': ['1.625rem', { lineHeight: '2rem' }],      // 30 → 26px
        '4xl': ['2rem', { lineHeight: '2.375rem' }],      // 36 → 32px
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        blink: 'blink 1s step-end infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        blink: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0' } },
      },
    },
  },
  plugins: [],
};
