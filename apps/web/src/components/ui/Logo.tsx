export function Logo({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} role="img" aria-label="Jorcord">
      <rect width="64" height="64" rx="18" fill="#5865f2" />
      <path d="M20 20h24a4 4 0 0 1 4 4v13a4 4 0 0 1-4 4H33l-8 7v-7h-5a4 4 0 0 1-4-4V24a4 4 0 0 1 4-4z" fill="#fff" />
      <path d="M36 26v9a5 5 0 0 1-10 0" fill="none" stroke="#5865f2" strokeWidth="3.6" strokeLinecap="round" />
    </svg>
  );
}

export function LogoGlyph({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <path d="M10 6h44a7 7 0 0 1 7 7v28a7 7 0 0 1-7 7H39L27 60V48H10a7 7 0 0 1-7-7V13a7 7 0 0 1 7-7z" fill="currentColor" />
      <path d="M38 17v17a8 8 0 0 1-16 0" fill="none" stroke="rgb(var(--brand))" strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
}
