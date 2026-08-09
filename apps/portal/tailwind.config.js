/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Deliberately restrained. The staging grid uses colour to mean
        // "this cell is wrong" — a decorative palette competing with that
        // would make errors harder to spot, which is the whole product.
        brand: {
          50: '#eef4fb',
          100: '#d6e4f5',
          500: '#2c5f9e',
          600: '#245084',
          700: '#1e3a5f',
          800: '#16293f',
          900: '#0f1c2b',
        },
        danger: { 50: '#fee2e2', 200: '#fecaca', 500: '#dc2626', 700: '#b91c1c' },
        warn: { 50: '#fef3c7', 200: '#fde68a', 500: '#d97706', 700: '#b45309' },
        ok: { 50: '#dcfce7', 200: '#bbf7d0', 500: '#16a34a', 700: '#15803d' },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      keyframes: {
        flashOk: {
          '0%': { backgroundColor: '#dcfce7' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
      animation: { flashOk: 'flashOk 1.2s ease-out' },
    },
  },
  plugins: [],
};
