import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** Renders `text` as a crisp SVG QR code on a white tile (the quiet zone keeps it scannable in dark themes). */
export function QrCode({ text, size = 176, label = 'QR code' }: { text: string; size?: number; label?: string }) {
  const { path, n } = useMemo(() => {
    const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    const n = qr.getModuleCount(); let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4},${r + 4}h1v1h-1z`;
    return { path: d, n };
  }, [text]);
  const dim = n + 8; // 4 modules of quiet zone on every side
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} shapeRendering="crispEdges" className="rounded-md bg-white">
      <path d={path} fill="#000" />
    </svg>
  );
}
