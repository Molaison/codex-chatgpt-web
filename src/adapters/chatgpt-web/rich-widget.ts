/** Versioned, inert data contract. Never forward Vega expressions, HTML, script or URLs. */
export type ChatGptChartWidget =
  | {
    version: 1; kind: "cartesian_chart"; id: string;
    mark: "bar" | "line" | "point" | "area";
    title: string; xField: string; yField: string; seriesField?: string;
    points: Array<{ x: string; y: number; series?: string }>;
  }
  | {
    version: 1; kind: "pie_chart"; id: string; title: string;
    labelField: string; valueField: string;
    slices: Array<{ label: string; value: number }>;
  }
  | {
    version: 1; kind: "heatmap_chart"; id: string; title: string;
    xField: string; yField: string; valueField: string;
    cells: Array<{ x: string; y: string; value: number }>;
  };

const field = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 100;
const label = (value: unknown): value is string | number =>
  (typeof value === "string" || typeof value === "number") && String(value).length <= 100;
const number = (value: unknown): value is number | string =>
  (typeof value === "number" || typeof value === "string") && String(value).trim().length > 0
  && Number.isFinite(Number(value));

export function parseChatGptChartWidgets(sources: readonly string[]): ChatGptChartWidget[] {
  const widgets: ChatGptChartWidget[] = [];
  for (const source of sources.slice(0, 4)) {
    if (!source || source.length > 64_000) continue;
    let spec: any;
    try { spec = JSON.parse(source); } catch { continue; }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    const mark = typeof spec.mark === "string" ? spec.mark : spec.mark?.type;
    const rows: unknown = spec.data?.values;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 300) continue;
    const id = `chart-${widgets.length + 1}`;
    const title = typeof spec.title === "string" ? spec.title.slice(0, 160) : "";

    if (mark === "arc") {
      const labelField = spec.encoding?.color?.field;
      const valueField = spec.encoding?.theta?.field;
      if (!field(labelField) || !field(valueField)) continue;
      const slices: Array<{ label: string; value: number }> = [];
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)
          || !label(row[labelField]) || !number(row[valueField]) || Number(row[valueField]) <= 0) break;
        slices.push({ label: String(row[labelField]), value: Number(row[valueField]) });
      }
      if (slices.length === rows.length) widgets.push({
        version: 1, kind: "pie_chart", id, title, labelField, valueField, slices,
      });
      continue;
    }

    if (mark === "rect") {
      const xField = spec.encoding?.x?.field;
      const yField = spec.encoding?.y?.field;
      const valueField = spec.encoding?.color?.field;
      if (!field(xField) || !field(yField) || !field(valueField)) continue;
      const cells: Array<{ x: string; y: string; value: number }> = [];
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)
          || !label(row[xField]) || !label(row[yField]) || !number(row[valueField])) break;
        cells.push({ x: String(row[xField]), y: String(row[yField]), value: Number(row[valueField]) });
      }
      if (cells.length === rows.length) widgets.push({
        version: 1, kind: "heatmap_chart", id, title, xField, yField, valueField, cells,
      });
      continue;
    }

    if (mark !== "bar" && mark !== "line" && mark !== "point" && mark !== "area") continue;
    const xField = spec.encoding?.x?.field;
    const yField = spec.encoding?.y?.field;
    const seriesField = spec.encoding?.color?.field;
    if (!field(xField) || !field(yField) || (seriesField !== undefined && !field(seriesField))) continue;
    const points: Array<{ x: string; y: number; series?: string }> = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)
        || !label(row[xField]) || !number(row[yField])) break;
      const series = seriesField === undefined ? undefined : row[seriesField];
      if (seriesField !== undefined && !label(series)) break;
      points.push({ x: String(row[xField]), y: Number(row[yField]),
        ...(seriesField !== undefined ? { series: String(series) } : {}) });
    }
    if (points.length === rows.length) widgets.push({
      version: 1, kind: "cartesian_chart", id, mark, title, xField, yField,
      ...(seriesField ? { seriesField } : {}), points,
    });
  }
  return widgets;
}
