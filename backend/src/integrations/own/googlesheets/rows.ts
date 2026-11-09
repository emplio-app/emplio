// Spreadsheet rows as people think of them: a header row, then values under it. Used by the actions and the polled triggers.
import { AppsError } from "../../types";

export const letter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : letter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
export const quoteSheet = (title: string) => `'${title.replace(/'/g, "''")}'`;

// a column by its heading, or by its letter
export function columnIndex(header: unknown[], column: string): number {
  const named = header.findIndex((h) => String(h).trim().toLowerCase() === column.trim().toLowerCase());
  if (named >= 0) return named;
  if (/^[A-Za-z]{1,3}$/.test(column)) return column.toUpperCase().split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  throw new AppsError(`there's no column called "${column}"; the columns are: ${header.join(", ")}`);
}

export const toObject = (header: unknown[], row: unknown[]) => Object.fromEntries(header.map((h, i) => [String(h), row[i] ?? ""]));

const number = (v: unknown) => Number(String(v).replace(/[,\s]/g, ""));

export function aggregate(values: unknown[], fn: "sum" | "average" | "count" | "min" | "max" | "percentage", total = values.length): number | null {
  const nums = values.map(number).filter((n) => Number.isFinite(n));
  if (fn === "count") return values.length;
  if (fn === "percentage") return total ? (values.length / total) * 100 : null;
  if (!nums.length) return null;
  if (fn === "sum") return nums.reduce((a, b) => a + b, 0);
  if (fn === "average") return nums.reduce((a, b) => a + b, 0) / nums.length;
  return fn === "min" ? Math.min(...nums) : Math.max(...nums);
}

export const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
