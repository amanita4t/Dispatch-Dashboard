export const BOARD_FILTER_DEFAULTS = {
  driver_id: "",
  load_type: "",
  status: "",
  q: "",
  archived: "active",
  date_field: "delivery_date",
  date_from: "",
  date_to: "",
  sort: "created_at",
  order: "desc",
};

export type BoardFilters = typeof BOARD_FILTER_DEFAULTS;
export type BoardFilterKey = keyof BoardFilters;

const filterKeys = Object.keys(BOARD_FILTER_DEFAULTS) as BoardFilterKey[];

export function readBoardFilters(params: Pick<URLSearchParams, "get">): BoardFilters {
  const filters = { ...BOARD_FILTER_DEFAULTS };
  for (const key of filterKeys) {
    filters[key] = params.get(key) || BOARD_FILTER_DEFAULTS[key];
  }
  return filters;
}

export function boardUrl(filters: BoardFilters): string {
  const params = new URLSearchParams();
  for (const key of filterKeys) {
    if (filters[key] && filters[key] !== BOARD_FILTER_DEFAULTS[key]) {
      params.set(key, filters[key]);
    }
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function sanitizeBoardReturnUrl(value: string | null): string {
  if (!value || (value !== "/" && !value.startsWith("/?"))) return "/";
  try {
    const url = new URL(value, "https://dispatch.invalid");
    if (url.origin !== "https://dispatch.invalid" || url.pathname !== "/") return "/";
    return boardUrl(readBoardFilters(url.searchParams));
  } catch {
    return "/";
  }
}

export function withBoardReturn(href: string, returnTo: string): string {
  const safeReturn = sanitizeBoardReturnUrl(returnTo);
  if (safeReturn === "/") return href;
  return `${href}?${new URLSearchParams({ returnTo: safeReturn })}`;
}
