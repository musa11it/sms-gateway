/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      // Three-colour system: white surfaces, near-black for authority/actions, light green for health and success.
      // Remapping the existing scales (slate/brand/emerald) restyles every screen without editing each one.
      colors: {
        // Warm neutrals: page #F7F7F5 (50), border #E7E7E3 (200), muted text #737373 (500), text #111111 (900).
        slate: {
          50: '#f7f7f5',
          100: '#f0f0ed',
          200: '#e7e7e3',
          300: '#d6d6d1',
          400: '#8c8c87',
          500: '#737373',
          600: '#585858',
          700: '#3d3d3d',
          800: '#242424',
          900: '#111111',
          950: '#0a0a0a',
        },
        // "brand" is the neutral action colour (near-black), kept under its old name so existing classes follow.
        brand: {
          50: '#f7f7f5',
          100: '#efefeb',
          200: '#e0e0db',
          300: '#c9c9c3',
          400: '#8c8c87',
          500: '#3d3d3d',
          600: '#111111',
          700: '#000000',
          800: '#111111',
          900: '#111111',
          950: '#0a0a0a',
        },
        // Light green accent (#B7F7C5) with a dark green for readable text (#166534).
        accent: {
          50: '#f1fdf4',
          100: '#dcfbe3',
          200: '#b7f7c5',
          300: '#8ee9a4',
          400: '#4fcf72',
          500: '#22a64c',
          600: '#15803d',
          700: '#166534',
          800: '#14532d',
          900: '#0f3d1f',
        },
        emerald: {
          50: '#f1fdf4',
          100: '#dcfbe3',
          200: '#b7f7c5',
          300: '#8ee9a4',
          400: '#4fcf72',
          500: '#22a64c',
          600: '#15803d',
          700: '#166534',
          800: '#14532d',
          900: '#0f3d1f',
        },
        ink: {
          950: '#0b0b0b',
          900: '#111111',
          800: '#1a1a1a',
          700: '#262626',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(17,17,17,.03)',
        pop: '0 12px 28px -8px rgba(17,17,17,.16), 0 2px 6px -2px rgba(17,17,17,.06)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0 }, to: { opacity: 1 } },
        'slide-up': { from: { opacity: 0, transform: 'translateY(8px) scale(.98)' }, to: { opacity: 1, transform: 'none' } },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'none' } },
      },
      animation: {
        'fade-in': 'fade-in .15s ease-out',
        'slide-up': 'slide-up .18s ease-out',
        'slide-in-right': 'slide-in-right .22s ease-out',
      },
    },
  },
  plugins: [],
};
