/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          50:  '#f5f5f5',
          100: '#e5e5e5',
          200: '#d4d4d4',
          300: '#a3a3a3',
          500: '#404040',
          600: '#262626',
          700: '#171717',
          800: '#0f0f0f',
          900: '#0a0a0a',
        },
      },
    },
  },
  plugins: [],
}
