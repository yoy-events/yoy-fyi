// Server-rendered SVG charts: no client script, so they work under the admin CSP.

type Point = { t: Date; clicks: number };

// The charts' words: the admin is in English, the signed-in pages pass their language's.
export type ChartText = { chart: (peak: number) => string; peak: (n: number) => string; clicks: (n: number) => string; none: string; noClicks: string };
const ENGLISH: ChartText = {
  chart: (n) => `Bar chart, peak ${n} clicks`,
  peak: (n) => `Peak ${n} clicks`,
  clicks: (n) => `${n} clicks`,
  none: "(none)",
  noClicks: "No clicks.",
};

export function BarChart({ points, label, text = ENGLISH }: { points: Point[]; label: (t: Date) => string; text?: ChartText }) {
  const width = 600;
  const height = 120;
  const gap = 1;
  // The real peak is shown; bars are scaled to at least 1 so an empty chart stays flat.
  const peak = Math.max(0, ...points.map((p) => p.clicks));
  const max = Math.max(1, peak);
  const barWidth = width / points.length;
  return (
    <figure class="chart">
      <svg viewBox={`0 0 ${width} ${height + 28}`} role="img" aria-label={text.chart(peak)}>
        {points.map((p, i) => {
          const h = Math.round((p.clicks / max) * height);
          return (
            <rect class="bar" x={i * barWidth} y={height - h} width={Math.max(barWidth - gap, 1)} height={Math.max(h, 0)}>
              <title>{`${label(p.t)}: ${text.clicks(p.clicks)}`}</title>
            </rect>
          );
        })}
        <line class="axis" x1="0" y1={height} x2={width} y2={height} />
        <text x="0" y={height + 24} class="tick">
          {label(points[0]!.t)}
        </text>
        <text x={width} y={height + 24} class="tick" text-anchor="end">
          {label(points.at(-1)!.t)}
        </text>
      </svg>
      <figcaption class="meta">{text.peak(peak)}</figcaption>
    </figure>
  );
}

// A ranked table whose proportion bars are SVG, since inline styles are blocked by the CSP.
export function Ranking({
  title,
  items,
  total,
  text = ENGLISH,
}: { title: string; items: { value: string | null; clicks: number }[]; total: number; text?: ChartText }) {
  return (
    <section class="ranking">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p class="meta">{text.noClicks}</p>
      ) : (
        <table>
          {items.map((it) => (
            <tr>
              <td class="truncate">{it.value ?? text.none}</td>
              <td class="num">{it.clicks}</td>
              <td class="share">
                <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
                  <rect class="share-bar" x="0" y="0" height="8" width={total ? Math.round((it.clicks / total) * 100) : 0} />
                </svg>
              </td>
            </tr>
          ))}
        </table>
      )}
    </section>
  );
}
