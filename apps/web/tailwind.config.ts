import type { Config } from 'tailwindcss';
const c = (n: string) => `rgb(var(--${n}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        rail: c('rail'), side: c('side'), chat: c('chat'), float: c('float'), 'chat-hover': c('chat-hover'),
        input: c('input'), modal: c('modal'), 'modal-alt': c('modal-alt'), hover: c('hover'), active: c('active'),
        brand: c('brand'), 'brand-hover': c('brand-hover'), 'brand-active': c('brand-active'),
        normal: c('text'), muted: c('muted'), header: c('header'), interactive: c('interactive'), 'interactive-hover': c('interactive-hover'),
        link: c('link'), danger: c('danger'), 'danger-hover': c('danger-hover'), success: c('success'), warn: c('warn'),
        divider: c('divider'), mention: c('mention'), 'mention-bg': c('mention-bg'),
      },
      fontFamily: { sans: ['var(--font)'], mono: ['var(--mono)'] },
      boxShadow: { elev: '0 8px 16px rgb(0 0 0 / 0.24)', high: '0 2px 10px rgb(0 0 0 / 0.2)' },
      keyframes: {
        pop: { from: { opacity: '0', transform: 'scale(.95)' }, to: { opacity: '1', transform: 'scale(1)' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { pop: 'pop .12s ease-out', slideUp: 'slideUp .18s ease-out' },
    },
  },
  plugins: [],
} satisfies Config;
