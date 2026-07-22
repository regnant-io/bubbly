/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
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
          muted: '#859900', // Solarized green (darker)
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
        cyan: {
          agent: 'rgb(var(--sol-cyan-rgb) / <alpha-value>)',
        },
        magenta: {
          agent: 'rgb(var(--sol-magenta-rgb) / <alpha-value>)',
        },
        violet: {
          agent: 'rgb(var(--sol-violet-rgb) / <alpha-value>)',
        },
        brown: {
          agent: 'rgb(var(--brown-primary-rgb) / <alpha-value>)',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
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
