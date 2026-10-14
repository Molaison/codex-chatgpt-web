/** A versioned, inert rendering contract. No DOM, script, URL or executable Vega expression crosses it. */
export interface ChatGptChartWidget {
  version: 1;
  kind: "cartesian_chart";
  id: string;
  mark: "bar" | "line" | "point";
  title: string;
  xField: string;
  yField: string;
  seriesField?: string;
  points: Array<{ x: string; y: number; series?: string }>;
}

export function parseChatGptChartWidgets(sources: readonly string[]): ChatGptChartWidget[] {
  const widgets: ChatGptChartWidget[] = [];
  for (const source of sources.slice(0, 4)) {
    if (!source || source.length > 64_000) continue;
    let spec: any;
    try { spec = JSON.parse(source); } catch { continue; }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    const mark = typeof spec.mark === "string" ? spec.mark : spec.mark?.type;
    if (mark !== "bar" && mark !== "line" && mark !== "point") continue;
    const xField = spec.encoding?.x?.field;
    const yField = spec.encoding?.y?.field;
    const seriesField = spec.encoding?.color?.field;
    if (typeof xField !== "string" || typeof yField !== "string"
      || !xField || !yField || xField.length > 100 || yField.length > 100
      || (seriesField !== undefined && (typeof seriesField !== "string" || !seriesField || seriesField.length > 100))) continue;
    const rows = spec.data?.values;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 300) continue;
    const points: ChatGptChartWidget["points"] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) break;
      const x = row[xField], y = row[yField];
      if ((typeof x !== "string" && typeof x !== "number") || !Number.isFinite(Number(y))
        || typeof y === "boolean" || String(x).length > 100) break;
      const series = seriesField === undefined ? undefined : row[seriesField];
      if (seriesField !== undefined && (typeof series !== "string" && typeof series !== "number" || String(series).length > 80)) break;
      points.push({ x: String(x), y: Number(y), ...(seriesField !== undefined ? { series: String(series) } : {}) });
    }
    if (points.length !== rows.length) continue;
    widgets.push({ version: 1, kind: "cartesian_chart", id: `chart-${widgets.length + 1}`,
      mark, title: typeof spec.title === "string" ? spec.title.slice(0, 160) : "",
      xField, yField, ...(seriesField ? { seriesField } : {}), points });
  }
  return widgets;
}
