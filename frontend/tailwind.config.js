/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        hebrew: ['Assistant', 'system-ui', 'sans-serif'],
      },
      colors: {
        alert: {
          safe: '#16a34a',
          low: '#65a30d',
          medium: '#ca8a04',
          high: '#ea580c',
          critical: '#dc2626',
        },
      },
    },
  },
  plugins: [],
}
