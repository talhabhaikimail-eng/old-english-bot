// Theme colours are CSS variables; wrapping them in color-mix lets opacity modifiers such as
// `bg-primary/10` work (Tailwind 3 can't apply alpha to a bare var()).
const themed = name => ({ opacityValue }) =>
  opacityValue === undefined
    ? `var(--${name})`
    : `color-mix(in srgb, var(--${name}) calc(${opacityValue} * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      borderRadius: {
        none: '0px',
        sm: 'calc(var(--radius) - 2px)',
        DEFAULT: 'var(--radius)',
        md: 'var(--radius)',
        lg: 'calc(var(--radius) + 2px)',
        xl: 'calc(var(--radius) + 4px)',
        '2xl': 'calc(var(--radius) + 8px)',
        '3xl': 'calc(var(--radius) + 12px)',
        '4xl': 'calc(var(--radius) + 16px)',
        full: '9999px',
      },
      colors: {
        brand: {
          DEFAULT: '#ffffff',
          dark: '#000000',
        },
        // Pure monochrome scale
        mono: {
          50: '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          400: '#a1a1aa',
          500: '#71717a',
          600: '#52525b',
          700: '#3f3f46',
          800: '#27272a',
          900: '#18181b',
          950: '#09090b',
        },
        background: themed('background'),
        foreground: themed('foreground'),
        card: {
          DEFAULT: themed('card'),
          foreground: themed('card-foreground'),
        },
        popover: {
          DEFAULT: themed('popover'),
          foreground: themed('popover-foreground'),
        },
        primary: {
          DEFAULT: themed('primary'),
          foreground: themed('primary-foreground'),
        },
        secondary: {
          DEFAULT: themed('secondary'),
          foreground: themed('secondary-foreground'),
        },
        muted: {
          DEFAULT: themed('muted'),
          foreground: themed('muted-foreground'),
        },
        accent: {
          DEFAULT: themed('accent'),
          foreground: themed('accent-foreground'),
        },
        destructive: {
          DEFAULT: themed('destructive'),
          foreground: themed('destructive-foreground'),
        },
        border: themed('border'),
        input: themed('input'),
        ring: themed('ring'),
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
