import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { aggregateUsage, TIME_WINDOWS } from "./aggregate.js";
import { formatCost, formatTokens, formatWindow } from "./format.js";
import type {
  DailyUsage,
  ModelUsage,
  ScanDiagnostics,
  ScanResult,
  TimeWindow,
  UsageAggregate,
  UsageTotals,
} from "./types.js";

const MAX_MODELS = 10;
const MAX_PROVIDERS = 10;

const SUB_BLOCKS_H = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
const VERTICAL_BLOCKS = [" ", " ", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

interface ChartItem {
  name: string;
  totals: UsageTotals;
}

function truncatePlain(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return "…";

  let result = "";
  for (const character of value) {
    if (visibleWidth(result + character) > width - 1) break;
    result += character;
  }
  return result + "…";
}

function truncateLine(value: string, width: number): string {
  if (value.includes("\x1b")) {
    return truncateToWidth(value, width, "…");
  }
  return truncatePlain(value, width);
}

function fit(value: string, width: number, align: "left" | "right" = "left"): string {
  if (width <= 0) return "";
  const truncated = truncatePlain(value, width);
  const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return align === "right" ? padding + truncated : truncated + padding;
}

function hasUsage(totals: UsageTotals): boolean {
  return (
    totals.inputTokens > 0 ||
    totals.outputTokens > 0 ||
    totals.cacheReadTokens > 0 ||
    totals.cacheWriteTokens > 0 ||
    totals.totalTokens > 0 ||
    totals.costUSD > 0
  );
}

function renderHorizontalBar(ratio: number, barWidth: number, theme?: Theme): string {
  if (barWidth <= 0) return "";
  if (ratio <= 0) return " ".repeat(barWidth);

  const clamped = Math.min(1, Math.max(0, ratio));
  const total8ths = Math.max(1, Math.round(clamped * barWidth * 8));
  const fullBlocks = Math.floor(total8ths / 8);
  const frac = total8ths % 8;
  const hasFrac = frac > 0 && fullBlocks < barWidth;

  const filledCount = Math.min(barWidth, fullBlocks);
  const partial = hasFrac ? SUB_BLOCKS_H[frac] : "";
  const filledStr = "█".repeat(filledCount) + partial;
  const trackCount = Math.max(0, barWidth - filledCount - (hasFrac ? 1 : 0));
  const trackStr = " ".repeat(trackCount);

  if (theme) {
    return `${theme.fg("accent", filledStr)}${trackStr}`;
  }
  return `${filledStr}${trackStr}`;
}

function chartRows(
  items: readonly ChartItem[],
  width: number,
  scaleMaximum?: number,
  theme?: Theme,
): string[] {
  if (items.length === 0) return [];
  const maximum = scaleMaximum ?? Math.max(...items.map((item) => item.totals.totalTokens));
  const totalTokens = items.reduce((sum, item) => sum + item.totals.totalTokens, 0);
  const showCost = items.some((item) => item.totals.costUSD > 0);
  const showPercent = width >= 62;

  const valueWidth = 8;
  const percentWidth = showPercent ? 7 : 0;
  const costWidth = showCost ? 9 : 0;

  const maxNameLen = Math.max(...items.map((item) => visibleWidth(item.name)));
  const maxAllowedName = Math.max(8, Math.min(24, Math.floor(width * 0.32)));
  const nameWidth = Math.max(8, Math.min(maxAllowedName, maxNameLen));

  const barWidth = Math.max(6, width - nameWidth - valueWidth - percentWidth - costWidth - 4);

  return items.map((item) => {
    const ratio = maximum > 0 ? item.totals.totalTokens / maximum : 0;
    const bar = renderHorizontalBar(ratio, barWidth, theme);
    const tokensVal = fit(formatTokens(item.totals.totalTokens), valueWidth, "right");
    const pctVal = totalTokens > 0 ? `${((item.totals.totalTokens / totalTokens) * 100).toFixed(1)}%` : "0%";
    const pctPad = showPercent ? ` ${fit(pctVal, percentWidth - 1, "right")}` : "";
    const costPad = showCost
      ? item.totals.costUSD > 0
        ? ` ${fit(formatCost(item.totals.costUSD), costWidth - 1, "right")}`
        : " ".repeat(costWidth)
      : "";

    const truncatedName = fit(item.name, nameWidth);

    if (theme) {
      const styledName = theme.fg("text", truncatedName);
      const styledTokens = theme.bold(tokensVal);
      const styledPct = showPercent ? theme.fg("dim", pctPad) : "";
      const styledCost =
        showCost && item.totals.costUSD > 0 ? theme.fg("success", costPad) : costPad;
      return `${styledName}  ${bar}  ${styledTokens}${styledPct}${styledCost}`;
    }

    return `${truncatedName}  ${bar}  ${tokensVal}${pctPad}${costPad}`;
  });
}

function renderDenseTrendChart(
  days: readonly DailyUsage[],
  width: number,
  theme?: Theme,
): string[] {
  const colW = width >= days.length * 2 ? 2 : 1;
  const chartW = days.length * colW;
  const maximum = Math.max(...days.map((d) => d.totalTokens));
  const peak = days.reduce((p, d) => (d.totalTokens > p.totalTokens ? d : p), days[0]!);
  const barHeight = 4;

  const rows: string[] = [];
  if (maximum > 0) {
    const peakStr = `Peak: ${formatTokens(maximum)} (${peak.label})`;
    rows.push(theme ? theme.fg("dim", peakStr) : peakStr);
  } else {
    rows.push("");
  }

  for (let level = barHeight; level >= 1; level--) {
    let line = "";
    for (const d of days) {
      if (d.totalTokens === 0 || maximum === 0) {
        line += " ".repeat(colW);
        continue;
      }
      const totalSteps = Math.max(1, Math.round((d.totalTokens / maximum) * barHeight * 8));
      const stepInLevel = Math.min(8, Math.max(0, totalSteps - (level - 1) * 8));
      if (stepInLevel === 0) {
        line += " ".repeat(colW);
        continue;
      }
      const ch = VERTICAL_BLOCKS[stepInLevel] ?? " ";
      const bar = ch.repeat(colW);
      line += theme ? theme.fg("accent", bar) : bar;
    }
    rows.push(line);
  }

  const baseline = "─".repeat(chartW);
  rows.push(theme ? theme.fg("dim", baseline) : baseline);

  const numTicks = colW === 2 ? 5 : 3;
  const step = (days.length - 1) / (numTicks - 1);
  let axis = " ".repeat(chartW);
  for (let i = 0; i < numTicks; i++) {
    const idx = Math.min(days.length - 1, Math.round(i * step));
    const lbl = days[idx]!.label;
    let pos = idx * colW;
    if (i === numTicks - 1) {
      pos = Math.max(0, chartW - visibleWidth(lbl));
    }
    axis = axis.substring(0, pos) + lbl + axis.substring(pos + visibleWidth(lbl));
  }
  rows.push(theme ? theme.fg("text", axis) : axis);

  return rows;
}

function dailyChartRows(days: readonly DailyUsage[], width: number, theme?: Theme): string[] {
  if (days.length === 0) return [];

  // Dense chart for 15+ items (e.g. 30 days)
  if (days.length > 14) {
    return renderDenseTrendChart(days, width, theme);
  }

  // Compact discrete column chart for <= 14 items (e.g. 7 days or months)
  const columnWidth = Math.max(5, Math.min(7, Math.floor(width / days.length)));
  const chartWidth = columnWidth * days.length;
  const maximum = Math.max(...days.map((day) => day.totalTokens));
  const barHeight = 4;
  const barColWidth = columnWidth >= 7 ? 3 : 2;

  const center = (value: string, colWidth = columnWidth): string => {
    const text = truncatePlain(value, colWidth);
    const remaining = Math.max(0, colWidth - visibleWidth(text));
    const left = Math.floor(remaining / 2);
    return " ".repeat(left) + text + " ".repeat(remaining - left);
  };

  const numRow = days.map((day) => center(day.totalTokens > 0 ? formatTokens(day.totalTokens) : "")).join("");
  const rows: string[] = [theme ? theme.fg("muted", numRow) : numRow];

  for (let level = barHeight; level >= 1; level--) {
    let line = "";
    for (const day of days) {
      if (day.totalTokens === 0 || maximum === 0) {
        line += " ".repeat(columnWidth);
        continue;
      }
      const totalSteps = Math.max(1, Math.round((day.totalTokens / maximum) * barHeight * 8));
      const stepInLevel = Math.min(8, Math.max(0, totalSteps - (level - 1) * 8));
      if (stepInLevel === 0) {
        line += " ".repeat(columnWidth);
        continue;
      }
      const ch = VERTICAL_BLOCKS[stepInLevel] ?? " ";
      const bar = ch.repeat(barColWidth);
      const remaining = columnWidth - barColWidth;
      const left = Math.floor(remaining / 2);
      const coloredBar = theme ? theme.fg("accent", bar) : bar;
      line += " ".repeat(left) + coloredBar + " ".repeat(remaining - left);
    }
    rows.push(line);
  }

  const baseline = "─".repeat(chartWidth);
  rows.push(theme ? theme.fg("dim", baseline) : baseline);

  const dateRow = days
    .map((day, index) => {
      const isToday = index === days.length - 1;
      const label = center(day.label);
      if (theme && isToday) return theme.fg("accent", theme.bold(label));
      if (theme) return theme.fg("text", label);
      return label;
    })
    .join("");
  rows.push(dateRow);

  return rows;
}

function buildTabBar(activeWindow: TimeWindow, theme?: Theme): string {
  const tabs = TIME_WINDOWS.map((w, index) => {
    const num = index + 1;
    const label = formatWindow(w);
    if (w === activeWindow) {
      return theme ? theme.fg("accent", theme.bold(`[ ${num} ${label} ]`)) : `[ ${label} ]`;
    }
    return theme ? theme.fg("muted", `  ${num} ${label}  `) : `  ${label}  `;
  });
  return tabs.join(" ");
}

function modelLabels(models: readonly ModelUsage[]): Map<ModelUsage, string> {
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.model, (counts.get(model.model) ?? 0) + 1);
  return new Map(
    models.map((model) => [
      model,
      (counts.get(model.model) ?? 0) > 1 ? `${model.provider}/${model.model}` : model.model,
    ]),
  );
}

function diagnosticLine(diagnostics: ScanDiagnostics, theme?: Theme): string | undefined {
  const parts: string[] = [];
  if (diagnostics.fileErrors > 0) parts.push(`${diagnostics.fileErrors} file error(s)`);
  if (diagnostics.malformedLines > 0) parts.push(`${diagnostics.malformedLines} malformed line(s)`);
  if (diagnostics.missingIds > 0) parts.push(`${diagnostics.missingIds} missing ID(s)`);
  if (diagnostics.invalidTimestamps > 0) parts.push(`${diagnostics.invalidTimestamps} invalid timestamp(s)`);
  if (parts.length === 0) return undefined;
  const line = `Skipped: ${parts.join(" · ")}`;
  return theme ? theme.fg("warning", line) : line;
}

function addNonZeroSummary(
  lines: string[],
  aggregate: UsageAggregate,
  width: number,
  theme?: Theme,
): void {
  const stats: Array<[string, string, boolean]> = [];
  if (aggregate.totals.totalTokens > 0) {
    stats.push(["Tokens", formatTokens(aggregate.totals.totalTokens), true]);
  }
  if (aggregate.totals.inputTokens > 0) {
    stats.push(["In", formatTokens(aggregate.totals.inputTokens), false]);
  }
  if (aggregate.totals.outputTokens > 0) {
    stats.push(["Out", formatTokens(aggregate.totals.outputTokens), false]);
  }
  if (aggregate.totals.cacheReadTokens > 0) {
    stats.push(["Cache", formatTokens(aggregate.totals.cacheReadTokens), false]);
  }
  if (aggregate.totals.costUSD > 0) {
    stats.push(["Cost", formatCost(aggregate.totals.costUSD), true]);
  }
  stats.push(["Msgs", aggregate.totals.messages.toString(), false]);

  const formattedItems = stats.map(([label, val, isHighlight]) => {
    if (theme) {
      const styledLabel = theme.fg("dim", label);
      const styledVal = isHighlight ? theme.fg("accent", theme.bold(val)) : theme.fg("text", theme.bold(val));
      return { plain: `${label} ${val}`, styled: `${styledLabel} ${styledVal}` };
    }
    return { plain: `${label} ${val}`, styled: `${label} ${val}` };
  });

  const lineLimit = Math.min(width, 76);
  let currentPlain = "";
  let currentStyled = "";

  for (const item of formattedItems) {
    const nextPlain = currentPlain.length === 0 ? item.plain : `${currentPlain}   ${item.plain}`;
    const nextStyled = currentStyled.length === 0 ? item.styled : `${currentStyled}   ${item.styled}`;

    if (currentPlain.length > 0 && visibleWidth(nextPlain) > lineLimit) {
      lines.push(currentStyled);
      currentPlain = item.plain;
      currentStyled = item.styled;
    } else {
      currentPlain = nextPlain;
      currentStyled = nextStyled;
    }
  }
  if (currentStyled) lines.push(currentStyled);
}

export function buildReportLines(
  aggregate: UsageAggregate,
  window: TimeWindow,
  diagnostics: ScanDiagnostics,
  width = 100,
  status?: string,
  theme?: Theme,
): string[] {
  const available = Math.max(1, width);
  const contentWidth = Math.min(available, 70);
  const separator = "─".repeat(contentWidth);
  const lines: string[] = [
    buildTabBar(window, theme),
    "",
  ];
  addNonZeroSummary(lines, aggregate, contentWidth, theme);

  if (aggregate.daily.length > 0) {
    const title =
      window === "7"
        ? "Daily Trend"
        : window === "30"
          ? "Daily Trend (30 Days)"
          : "Usage Trend (All Time)";
    lines.push("");
    lines.push(theme ? theme.fg("accent", theme.bold(title)) : title);
    lines.push(...dailyChartRows(aggregate.daily, contentWidth, theme));
  }

  const visibleModels = aggregate.models.filter(hasUsage);
  const labels = modelLabels(visibleModels);
  const modelItems = visibleModels.slice(0, MAX_MODELS).map((model) => ({
    name: labels.get(model) ?? model.model,
    totals: model,
  }));
  lines.push("");
  lines.push(theme ? theme.fg("accent", theme.bold("By Model")) : "By Model");
  lines.push(theme ? theme.fg("dim", separator) : separator);
  lines.push(...chartRows(modelItems, contentWidth, undefined, theme));
  if (visibleModels.length === 0) {
    lines.push(theme ? theme.fg("muted", "No usage records in this window.") : "No usage records in this window.");
  } else if (visibleModels.length > MAX_MODELS) {
    const more = `… ${visibleModels.length - MAX_MODELS} more model(s)`;
    lines.push(theme ? theme.fg("dim", more) : more);
  }

  const visibleProviders = aggregate.providers.filter(hasUsage).slice(0, MAX_PROVIDERS);
  const providerItems: ChartItem[] = visibleProviders.map((provider) => ({
    name: provider.provider,
    totals: provider,
  }));

  lines.push("");
  lines.push(theme ? theme.fg("accent", theme.bold("By Provider")) : "By Provider");
  lines.push(theme ? theme.fg("dim", separator) : separator);
  const providerMaximum = Math.max(0, ...visibleProviders.map((provider) => provider.totalTokens));
  lines.push(...chartRows(providerItems, contentWidth, providerMaximum, theme));
  if (visibleProviders.length === 0) {
    lines.push(theme ? theme.fg("muted", "No providers in this window.") : "No providers in this window.");
  }
  const providerCount = aggregate.providers.filter(hasUsage).length;
  if (providerCount > MAX_PROVIDERS) {
    const more = `… ${providerCount - MAX_PROVIDERS} more provider(s)`;
    lines.push(theme ? theme.fg("dim", more) : more);
  }

  const diagnostic = diagnosticLine(diagnostics, theme);
  if (diagnostic) lines.push("", diagnostic);
  if (status) lines.push("", theme ? theme.fg("muted", status) : status);

  const helpText = theme
    ? theme.fg("dim", "1-4 / ← → window · r refresh · q close")
    : "←/→ window · r refresh · q close";
  lines.push("", helpText);

  return lines.map((line) => truncateLine(line, available));
}

function styleLines(lines: string[], theme: Theme): string[] {
  return lines.map((line, index) => {
    if (line.includes("\x1b[")) return line;
    if (index === 0) {
      return line.replace(/\[([^\]]+)\]/g, (_, inner) =>
        theme.fg("accent", theme.bold(`[ ${inner.trim()} ]`)),
      );
    }
    if (
      line.startsWith("Daily Trend") ||
      line.startsWith("Usage Trend") ||
      line === "By Model" ||
      line === "By Provider"
    ) {
      return theme.fg("accent", theme.bold(line));
    }
    if (/^─+$/.test(line) || line.startsWith("←/→") || line.startsWith("1-4")) return theme.fg("dim", line);
    if (line.startsWith("Skipped:")) return theme.fg("warning", line);
    if (line === "Refreshing…") return theme.fg("muted", line);
    return line;
  });
}

export function renderPlainReport(
  aggregate: UsageAggregate,
  window: TimeWindow,
  diagnostics: ScanDiagnostics,
): string {
  return buildReportLines(aggregate, window, diagnostics, 120).slice(0, -2).join("\n");
}

export async function showTokensUi(
  ctx: ExtensionCommandContext,
  initial: ScanResult | Promise<ScanResult>,
  initialWindow: TimeWindow,
  rescan: () => Promise<ScanResult>,
  refreshOnOpen = false,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let result: ScanResult | undefined = initial instanceof Promise ? undefined : initial;
    let window = initialWindow;
    let now = Date.now();
    let refreshing = false;
    let disposed = false;
    let refreshError: string | undefined;
    let cachedWidth: number | undefined;
    let cachedLines: string[] | undefined;

    const invalidate = () => {
      cachedWidth = undefined;
      cachedLines = undefined;
    };
    const changeWindow = (next: TimeWindow) => {
      window = next;
      refreshError = undefined;
      invalidate();
      tui.requestRender();
    };
    const update = (next: ScanResult | undefined) => {
      if (disposed || !next) return;
      result = next;
      now = Date.now();
      invalidate();
      tui.requestRender();
    };
    const refresh = (load: () => Promise<ScanResult | undefined> = rescan) => {
      if (refreshing || disposed) return;
      refreshing = true;
      refreshError = undefined;
      invalidate();
      tui.requestRender();
      void Promise.resolve().then(load)
        .then(update)
        .catch(() => {
          // Never expose raw errors or session content in the report.
          if (!disposed) refreshError = "Refresh failed. Press r to retry.";
        })
        .finally(() => {
          if (disposed) return;
          refreshing = false;
          invalidate();
          tui.requestRender();
        });
    };

    if (initial instanceof Promise || refreshOnOpen) {
      refresh(async () => {
        update(await initial);
        if (!disposed && refreshOnOpen) return rescan();
        return undefined;
      });
    }

    return {
      render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;
        if (!result) {
          cachedLines = [theme.fg("muted", refreshError ?? "Loading usage…"), theme.fg("dim", "r retry · q close")]
            .map((line) => truncateLine(line, width));
        } else {
          const aggregate = aggregateUsage(result.records, window, now);
          const status = refreshing ? "Refreshing…" : refreshError;
          cachedLines = styleLines(buildReportLines(aggregate, window, result.diagnostics, width, status, theme), theme);
        }
        cachedWidth = width;
        return cachedLines;
      },
      invalidate,
      dispose(): void { disposed = true; },
      handleInput(data: string): void {
        if (matchesKey(data, "escape") || data.toLowerCase() === "q") {
          disposed = true;
          done(undefined);
          return;
        }
        const index = TIME_WINDOWS.indexOf(window);
        if (matchesKey(data, "left")) changeWindow(TIME_WINDOWS[(index + TIME_WINDOWS.length - 1) % TIME_WINDOWS.length]!);
        else if (matchesKey(data, "right")) changeWindow(TIME_WINDOWS[(index + 1) % TIME_WINDOWS.length]!);
        else if (data === "1") changeWindow("today");
        else if (data === "2") changeWindow("7");
        else if (data === "3") changeWindow("30");
        else if (data === "4") changeWindow("all");
        else if (data.toLowerCase() === "r") refresh();
      },
    };
  });
}
