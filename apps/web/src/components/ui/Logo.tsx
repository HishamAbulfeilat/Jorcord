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
      <path d="M12 12h40a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H36l-12 10V48h-12a6 6 0 0 1-6-6V18a6 6 0 0 1 6-6z" fill="currentColor" />
      <path d="M37 22v14a6 6 0 0 1-12 0" fill="none" stroke="rgb(var(--brand))" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  );
}
