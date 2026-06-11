import type { Config } from 'tailwindcss'

export default {
  content: [
    './app/**/*.{vue,ts,js}',
    './server/**/*.{ts,js}',
  ],
  theme: {
    extend: {
      colors: {
        // Cool, restrained palette tuned for long sessions on a finance tool.
        // Slight blue-shift vs the prior slate-derived scale; matches the
        // Rounds page tokens.
        ink: {
          50:  '#f8fafc',
          100: '#eef0f3',
          200: '#e4e7ec',
          300: '#d0d5dd',
          400: '#98a2b3',
          500: '#667085',
          600: '#475467',
          700: '#344054',
          800: '#1d2939',
          900: '#101828',
          950: '#0b1220',
        },
        // brand is the primary accent (blue). DEFAULT enables bare `bg-brand`,
        // `text-brand`, etc. `soft` / `edge` / `deep` are named tints used by
        // the Rounds table and status pills.
        brand: {
          DEFAULT: '#1d4ed8',
          soft: '#eef2ff',
          edge: '#1e40af',
          deep: '#312e81',
          50:  '#eef2ff',
          100: '#dde6ff',
          200: '#bccdff',
          300: '#8ea9ff',
          400: '#5a82ff',
          500: '#2563eb',
          600: '#1d4ed8',
          700: '#1e40af',
          800: '#1e3a8a',
          900: '#172554',
        },
        // `edit` is the "operator-typed" cue color — amber. Used as a corner
        // dot on editable cells (the only color cue) and as a column-group
        // accent for the Money group.
        edit: {
          DEFAULT: '#a16207',
          soft: '#fefbe8',
          edge: '#854d0e',
          ring: '#fde68a',
        },
        ok:   { DEFAULT: '#047857', soft: '#ecfdf5' },
        warn: { DEFAULT: '#b45309', soft: '#fffbeb' },
      },
      fontFamily: {
        sans: ['Manrope', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Inter', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        'card': '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        'card-hover': '0 4px 12px -2px rgb(15 23 42 / 0.08), 0 2px 4px -2px rgb(15 23 42 / 0.06)',
        'cell-focus': '0 0 0 3px rgba(29, 78, 216, 0.12)',
      },
      keyframes: {
        openDot: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(29, 78, 216, 0.55)' },
          '50%':      { boxShadow: '0 0 0 4px rgba(29, 78, 216, 0)' },
        },
      },
      animation: {
        'open-dot': 'openDot 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
