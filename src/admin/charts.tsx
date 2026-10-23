// Server-rendered SVG charts: no client script, so they work under the admin CSP.

type Point = { t: Date; clicks: number };

export function BarChart({ points, label }: { points: Point[]; label: (t: Date) => string }) {
  const width = 600;
  const height = 120;
  const gap = 1;
  const max = Math.max(1, ...points.map((p) => p.clicks));
  const barWidth = width / points.length;
  return (
    <figure class="chart">
      <svg viewBox={`0 0 ${width} ${height + 16}`} role="img" aria-label={`Bar chart, peak ${max} clicks`}>
        {points.map((p, i) => {
          const h = Math.round((p.clicks / max) * height);
          return (
            <rect class="bar" x={i * barWidth} y={height - h} width={Math.max(barWidth - gap, 1)} height={Math.max(h, 0)}>
              <title>{`${label(p.t)}: ${p.clicks} clicks`}</title>
            </rect>
          );
        })}
        <line class="axis" x1="0" y1={height} x2={width} y2={height} />
        <text x="0" y={height + 13} class="tick">
          {label(points[0]!.t)}
        </text>
        <text x={width} y={height + 13} class="tick" text-anchor="end">
          {label(points.at(-1)!.t)}
        </text>
      </svg>
      <figcaption class="meta">Peak {max} clicks</figcaption>
    </figure>
  );
}

// A ranked table whose proportion bars are SVG, since inline styles are blocked by the CSP.
export function Ranking({ title, items, total }: { title: string; items: { value: string | null; clicks: number }[]; total: number }) {
  return (
    <section class="ranking">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p class="meta">No clicks.</p>
      ) : (
        <table>
          {items.map((it) => (
            <tr>
              <td class="truncate">{it.value ?? "(none)"}</td>
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
