import fallbacks from './postcss-fallbacks.js'
export default { plugins: [(await import('tailwindcss')).default(), (await import('autoprefixer')).default(), fallbacks()] }
