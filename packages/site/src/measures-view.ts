/**
 * The view of the demo of the measures: the controls, the chart of the bounds, the table of the levels and the summary.
 * The logic is in `measures-demo.ts`.
 */
import { byId } from "@mark1russell7/site-pages/chrome";
import { levelName, rowAt, SAMPLE_SETTINGS, sampleJobs, shortTime, SPAN_NAMES, ticksOf, viewOf, type LevelRow, type MeasureView, type SampleSettings, type SpanName } from "./measures-demo.ts";

const SVG = "http://www.w3.org/2000/svg";

const SPAN_LABELS: Readonly<Record<SpanName, { readonly button: string; readonly noun: string }>> = Object.freeze({
  queue: { button: "Queue time", noun: "queue time" },
  run: { button: "Run time", noun: "run time" },
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Readonly<Record<string, string | number>> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

/** This function gives the path of the steps of the share of the values at or below each time, clipped at `max`. */
function stepsOf(values: readonly number[], x: (ms: number) => number, y: (share: number) => number, max: number): string {
  const n = values.length;
  const parts = [`M${x(0)},${y(0)}`];
  values.forEach((value, index) => {
    const at = x(Math.min(value, max * 1.05));
    parts.push(`L${at},${y(index / n)}`, `L${at},${y((index + 1) / n)}`);
  });
  parts.push(`L${x(max * 1.05)},${y(1)}`);
  return parts.join("");
}

/** This function gives the end of the time axis: past the high bound and the true value of the top level. */
function axisEnd(view: MeasureView): number {
  const ends = view.rows.flatMap((row) => [row.truth, row.high ?? row.low]);
  return Math.max(1000, ...ends) * 1.1;
}

/** This function mounts the demo of the measures on the elements of the page. */
export function mountMeasures(): void {
  let settings: SampleSettings = SAMPLE_SETTINGS;
  let span: SpanName = "queue";
  let jobs = sampleJobs(settings);
  let view = viewOf(jobs, span);

  const spanBox = byId("span-choice");
  const passInput = byId<HTMLInputElement>("pass");
  const passOut = byId("pass-out");
  const countInput = byId<HTMLSelectElement>("job-count");
  const text = byId("measure-text");
  const chart = byId("chart");
  const tip = byId("chart-tip");
  const rows = byId("levels-body");
  const json = byId("summary-json");

  const spanButtons = SPAN_NAMES.map((name) => {
    const button = el("button", "chip", SPAN_LABELS[name].button);
    button.type = "button";
    button.addEventListener("click", () => {
      span = name;
      view = viewOf(jobs, span);
      render();
    });
    return button;
  });
  spanBox.replaceChildren(...spanButtons);
  passInput.value = String(settings.pass);
  countInput.value = String(settings.jobs);

  const resample = (next: Partial<SampleSettings>): void => {
    settings = { ...settings, ...next };
    jobs = sampleJobs(settings);
    view = viewOf(jobs, span);
    render();
  };
  passInput.addEventListener("input", () => resample({ pass: Number(passInput.value) }));
  countInput.addEventListener("change", () => resample({ jobs: Number(countInput.value) }));
  byId("resample").addEventListener("click", () => resample({ seed: settings.seed + 1 }));

  function renderText(): void {
    const noun = SPAN_LABELS[span].noun;
    const median = view.rows.find((row) => row.p === 0.5) ?? view.rows[0];
    const held = view.rows.every((row) => row.holds);
    const parts: (string | Node)[] = [];
    if (median !== undefined) {
      parts.push(
        `Of ${view.spans.length} jobs, the median ${noun} is from ${shortTime(median.low)} to ${median.high === null ? "an unknown time" : shortTime(median.high)}. `,
        `The true median is ${shortTime(median.truth)}. `,
      );
    }
    parts.push(el("strong", "", held ? "Each pair of bounds holds its true value." : "A pair of bounds does not hold its true value."));
    text.className = held ? "measure-text" : "measure-text bad";
    text.replaceChildren(...parts.map((part) => (typeof part === "string" ? document.createTextNode(part) : part)));
  }

  function renderTable(): void {
    rows.replaceChildren(
      ...view.rows.map((row) => {
        const line = el("tr");
        line.append(
          el("th", "", levelName(row.p)),
          el("td", "", shortTime(row.low)),
          el("td", "", row.high === null ? "unknown" : shortTime(row.high)),
          el("td", "", shortTime(row.truth)),
          el("td", row.holds ? "ok" : "bad", row.holds ? "✓ yes" : "✕ no"),
        );
        line.firstElementChild?.setAttribute("scope", "row");
        return line;
      }),
    );
  }

  function renderChart(): void {
    const width = Math.max(280, Math.round(chart.clientWidth || 640));
    const height = Math.round(Math.min(340, Math.max(230, width * 0.5)));
    const margin = { left: 44, right: 12, top: 14, bottom: 34 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const end = axisEnd(view);
    const x = (ms: number): number => Math.round((margin.left + (Math.max(0, ms) / end) * plotWidth) * 10) / 10;
    const y = (share: number): number => Math.round((margin.top + (1 - share) * plotHeight) * 10) / 10;

    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": "chart-title" });
    const title = svg("title", { id: "chart-title" });
    title.textContent = `The share of the jobs at or below each ${SPAN_LABELS[span].noun}: the bounds from the reads, and the true times.`;
    root.append(title);

    const clip = svg("clipPath", { id: "plot-clip" });
    clip.append(svg("rect", { x: margin.left, y: margin.top - 2, width: plotWidth, height: plotHeight + 4 }));
    root.append(clip);

    // The grid and the axes.
    const unit = end < 180_000 ? 1000 : 60_000;
    const grid = svg("g", { class: "grid" });
    for (const tick of ticksOf(end / unit)) {
      const at = x(tick * unit);
      grid.append(svg("line", { x1: at, x2: at, y1: margin.top, y2: margin.top + plotHeight }));
      const label = svg("text", { x: at, y: height - margin.bottom + 18, "text-anchor": "middle", class: "axis" });
      label.textContent = `${tick}${unit === 1000 ? " s" : " min"}`;
      grid.append(label);
    }
    for (const share of [0, 0.5, 1]) {
      const label = svg("text", { x: margin.left - 6, y: y(share) + 4, "text-anchor": "end", class: "axis" });
      label.textContent = `${share * 100}%`;
      grid.append(label);
    }
    grid.append(svg("line", { x1: margin.left, x2: margin.left + plotWidth, y1: y(0), y2: y(0), class: "base" }));
    root.append(grid);

    // The band between the bounds, its two edges, and the true times.
    const marks = svg("g", { "clip-path": "url(#plot-clip)" });
    const lows = stepsOf(view.lows, x, y, end);
    const highs = stepsOf(view.highs, x, y, end);
    const back = highs.replace(/^M/, "L").split("L").filter((part) => part !== "").reverse().map((part) => `L${part}`).join("");
    marks.append(
      svg("path", { d: `${lows}${back}Z`, class: "band" }),
      svg("path", { d: lows, class: "edge" }),
      svg("path", { d: highs, class: "edge" }),
      svg("path", { d: stepsOf(view.truths, x, y, end), class: "truth" }),
    );
    root.append(marks);

    // The levels: a guide, the bounds of the quantile, and the true quantile.
    const levels = svg("g", { class: "levels" });
    for (const row of view.rows) {
      levels.append(
        svg("line", { x1: margin.left, x2: margin.left + plotWidth, y1: y(row.p), y2: y(row.p), class: "guide" }),
        svg("line", { x1: x(row.low), x2: x(row.high ?? end), y1: y(row.p), y2: y(row.p), class: "bound" }),
        svg("circle", { cx: x(row.truth), cy: y(row.p), r: 4.5, class: "dot" }),
      );
      const label = svg("text", { x: margin.left + plotWidth - 2, y: y(row.p) - 5, "text-anchor": "end", class: "level" });
      label.textContent = levelName(row.p);
      levels.append(label);
    }
    root.append(levels);

    // The hover layer: a level at the height of the pointer.
    const cross = svg("g", { class: "cross", visibility: "hidden" });
    const crossLine = svg("line", { x1: margin.left, x2: margin.left + plotWidth, class: "guide" });
    const crossBound = svg("line", { class: "bound" });
    const crossDot = svg("circle", { r: 4.5, class: "dot" });
    cross.append(crossLine, crossBound, crossDot);
    root.append(cross);
    const hit = svg("rect", { x: margin.left, y: margin.top, width: plotWidth, height: plotHeight, class: "hit" });
    root.append(hit);

    const n = Math.max(1, view.spans.length);
    const show = (event: PointerEvent): void => {
      const box = root.getBoundingClientRect();
      const share = 1 - (event.clientY - box.top - margin.top) / plotHeight;
      const p = Math.min(1, Math.max(1 / n, Math.round(share * 1000) / 1000));
      const row: LevelRow = rowAt(view, p);
      const at = y(p);
      for (const line of [crossLine, crossBound]) {
        line.setAttribute("y1", String(at));
        line.setAttribute("y2", String(at));
      }
      crossBound.setAttribute("x1", String(x(row.low)));
      crossBound.setAttribute("x2", String(x(row.high ?? end)));
      crossDot.setAttribute("cx", String(x(row.truth)));
      crossDot.setAttribute("cy", String(at));
      cross.setAttribute("visibility", "visible");
      tip.replaceChildren(
        el("strong", "", levelName(p)),
        document.createTextNode(` From ${shortTime(row.low)} to ${row.high === null ? "unknown" : shortTime(row.high)}. True: ${shortTime(row.truth)}.`),
      );
      tip.hidden = false;
      const left = Math.min(box.width - tip.offsetWidth - 4, Math.max(4, event.clientX - box.left + 12));
      const top = Math.max(4, Math.min(box.height - tip.offsetHeight - 4, event.clientY - box.top - tip.offsetHeight - 10));
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", () => {
      cross.setAttribute("visibility", "hidden");
      tip.hidden = true;
    });

    chart.replaceChildren(root);
  }

  function render(): void {
    spanButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(SPAN_NAMES[index] === span)));
    passOut.textContent = `${settings.pass} s`;
    renderText();
    renderTable();
    renderChart();
    json.textContent = JSON.stringify(view.summary, null, 2);
  }

  let lastWidth = 0;
  new ResizeObserver(() => {
    const width = Math.round(chart.clientWidth);
    if (width === lastWidth) return;
    lastWidth = width;
    renderChart();
  }).observe(chart);
  render();
}
