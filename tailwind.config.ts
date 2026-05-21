import type { Config } from 'tailwindcss'

export default {
  content: [
    './app/**/*.{vue,ts,js}',
    './server/**/*.{ts,js}',
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#f7f7f8',
          100: '#ebebed',
          200: '#d3d3d8',
          300: '#a8a9b2',
          400: '#76777e',
          500: '#52525b',
          600: '#3f3f46',
          700: '#27272a',
          800: '#19191c',
          900: '#0e0e10',
        },
        accent: {
          50:  '#eef6ff',
          100: '#d8eaff',
          200: '#b4d4ff',
          300: '#83b7ff',
          400: '#5293ff',
          500: '#306fff',
          600: '#1d51e6',
          700: '#173fb4',
          800: '#163489',
          900: '#152d6f',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Inter', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config
