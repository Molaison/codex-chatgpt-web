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

/** Validate the inert projection at IPC boundaries, independently of its source chart format. */
export function isChatGptChartWidget(value: unknown): value is ChatGptChartWidget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const widget = value as Record<string, unknown>;
  if (widget.version !== 1 || !field(widget.id) || typeof widget.title !== "string" || widget.title.length > 160) return false;
  const keys = (record: Record<string, unknown>, allowed: readonly string[]) => Object.keys(record).every(key => allowed.includes(key));
  const text = (value: unknown) => typeof value === "string" && value.length <= 100;
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const rows = (value: unknown): value is Array<Record<string, unknown>> => Array.isArray(value)
    && value.length > 0 && value.length <= 300
    && value.every(row => row !== null && typeof row === "object" && !Array.isArray(row));
  const base = ["version", "kind", "id", "title"];
  if (widget.kind === "cartesian_chart") return keys(widget, [...base, "mark", "xField", "yField", "seriesField", "points"])
    && ["bar", "line", "point", "area"].includes(widget.mark as string) && field(widget.xField) && field(widget.yField)
    && (widget.seriesField === undefined || field(widget.seriesField)) && rows(widget.points)
    && widget.points.every(point => keys(point, ["x", "y", "series"]) && text(point.x) && finite(point.y)
      && (widget.seriesField === undefined ? point.series === undefined : text(point.series)));
  if (widget.kind === "pie_chart") return keys(widget, [...base, "labelField", "valueField", "slices"])
    && field(widget.labelField) && field(widget.valueField) && rows(widget.slices)
    && widget.slices.every(slice => keys(slice, ["label", "value"]) && text(slice.label) && finite(slice.value) && (slice.value as number) > 0);
  if (widget.kind === "heatmap_chart") return keys(widget, [...base, "xField", "yField", "valueField", "cells"])
    && field(widget.xField) && field(widget.yField) && field(widget.valueField) && rows(widget.cells)
    && widget.cells.every(cell => keys(cell, ["x", "y", "value"]) && text(cell.x) && text(cell.y) && finite(cell.value));
  return false;
}

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
