import { expect, test } from "bun:test";
import { parseChatGptChartWidgets } from "../src/adapters/chatgpt-web/rich-widget";

test("Vega-Lite inline values convert area, pie and heatmap without executing specifications", () => {
  const values = [{ category: "WT", dose: "low", count: 4 }, { category: "mut", dose: "high", count: 6 }];
  const source = (mark: string, encoding: Record<string, unknown>) => JSON.stringify({
    mark, title: "Test", data: { values }, encoding,
    transform: [{ calculate: "alert('cannot run')", as: "evil" }],
  });
  const sources = [
    source("area", { x: { field: "category" }, y: { field: "count" } }),
    source("arc", { color: { field: "category" }, theta: { field: "count" } }),
    source("rect", { x: { field: "category" }, y: { field: "dose" }, color: { field: "count" } }),
  ];
  const result = parseChatGptChartWidgets(sources);
  expect(result).toEqual([
    {
      version: 1, kind: "cartesian_chart", id: "chart-1", mark: "area", title: "Test",
      xField: "category", yField: "count",
      points: [{ x: "WT", y: 4 }, { x: "mut", y: 6 }],
    },
    {
      version: 1, kind: "pie_chart", id: "chart-2", title: "Test",
      labelField: "category", valueField: "count",
      slices: [{ label: "WT", value: 4 }, { label: "mut", value: 6 }],
    },
    {
      version: 1, kind: "heatmap_chart", id: "chart-3", title: "Test",
      xField: "category", yField: "dose", valueField: "count",
      cells: [{ x: "WT", y: "low", value: 4 }, { x: "mut", y: "high", value: 6 }],
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("alert");
});

test("invalid or unbounded pie and heatmap data never crosses the rich widget boundary", () => {
  const arc = (values: unknown) => JSON.stringify({
    mark: "arc", data: { values },
    encoding: { color: { field: "group" }, theta: { field: "value" } },
  });
  const rect = (values: unknown) => JSON.stringify({
    mark: "rect", data: { values },
    encoding: {
      x: { field: "x" }, y: { field: "y" }, color: { field: "value" },
    },
  });
  expect(parseChatGptChartWidgets([
    arc([{ group: "A", value: -1 }]),
    rect([{ x: "A", y: "B", value: "Infinity" }]),
    arc(Array.from({ length: 301 }, (_, i) => ({ group: String(i), value: 1 }))),
    JSON.stringify({ mark: "image", data: { values: [{ src: "https://example.org" }] } }),
  ])).toEqual([]);
});
