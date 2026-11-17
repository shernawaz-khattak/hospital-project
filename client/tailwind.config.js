/** Design tokens: clinical white, ink, scrub green, and wayfinding colours per department. */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#F3F7F8',
        ink: { DEFAULT: '#142D35', soft: '#304851' },
        muted: '#60757B',
        rule: '#DCE7E8',
        scrub: { DEFAULT: '#087F72', dark: '#066457', light: '#E2F4F0' },
        alert: { DEFAULT: '#B42318', light: '#FDECEA' },
        caution: { DEFAULT: '#9A5B05', light: '#FDF3DF' },
        ok: { DEFAULT: '#127A4B', light: '#E5F4EC' },
        info: { DEFAULT: '#1F5BA8', light: '#E6EEF9' },
        // Wayfinding bands (hospital signage colours) — used only as markers, never as fills for text.
        way: {
          home: '#12282F', patients: '#0E7C86', appointments: '#2F5DB3', wards: '#7A4BB0', clinical: '#0B6B5A',
          lab: '#C7861B', pharmacy: '#3E8E3A', billing: '#A23B72', admin: '#4F5D75', system: '#5F6B7A', portal: '#0E7C86',
        },
      },
      fontFamily: {
        sans: ['"Atkinson Hyperlegible Next Variable"', 'system-ui', 'sans-serif'],
        sign: ['"Barlow Semi Condensed"', '"Atkinson Hyperlegible Next Variable"', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        xs: ['0.78rem', '1.15rem'], sm: ['0.875rem', '1.3rem'], base: ['0.95rem', '1.45rem'], lg: ['1.1rem', '1.55rem'], xl: ['1.35rem', '1.7rem'], '2xl': ['1.75rem', '2.1rem'], '3xl': ['2.4rem', '2.6rem'],
      },
      borderRadius: { DEFAULT: '10px', panel: '16px' },
    },
  },
  plugins: [],
};
