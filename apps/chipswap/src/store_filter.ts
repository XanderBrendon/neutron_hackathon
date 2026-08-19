// The three store filter axes from the requirements. The backend applies them so
// paging stays correct, which means the tile only has to name them.

import type { StoreFilter } from "./api.ts";

export const OWNERSHIP_OPTIONS = [
  { value: "all", label: "All chips" },
  { value: "owned", label: "Chips I own" },
  { value: "not_owned", label: "Chips I don't own" },
] as const;

export const DESIGNER_OPTIONS = [
  { value: "all", label: "All designers" },
  { value: "owner_of_designer", label: "Designers I own from" },
  { value: "not_owner_of_designer", label: "Designers I don't own from" },
] as const;

export const TRADE_MODE_OPTIONS = [
  { value: "all", label: "Any trade mode" },
  { value: "auto", label: "Accepts any trade" },
  { value: "manual", label: "Designer approves" },
] as const;

export function defaultFilter(): StoreFilter {
  return {
    ownership: "all",
    designerOwnership: "all",
    tradeMode: "all",
  };
}

export function isDefaultFilter(filter: StoreFilter): boolean {
  return (
    filter.ownership === "all" &&
    filter.designerOwnership === "all" &&
    filter.tradeMode === "all"
  );
}

/** Exactly the field names the backend query expects. */
export function serializeFilter(filter: StoreFilter): {
  ownership: string;
  designer_ownership: string;
  trade_mode: string;
} {
  return {
    ownership: filter.ownership,
    designer_ownership: filter.designerOwnership,
    trade_mode: filter.tradeMode,
  };
}

export function filterLabel(filter: StoreFilter): string {
  if (isDefaultFilter(filter)) return "Everything in your directory";
  const parts: string[] = [];
  const ownership = OWNERSHIP_OPTIONS.find(
    (option) => option.value === filter.ownership,
  );
  const designer = DESIGNER_OPTIONS.find(
    (option) => option.value === filter.designerOwnership,
  );
  const mode = TRADE_MODE_OPTIONS.find(
    (option) => option.value === filter.tradeMode,
  );
  if (filter.ownership !== "all" && ownership) parts.push(ownership.label);
  if (filter.designerOwnership !== "all" && designer) parts.push(designer.label);
  if (filter.tradeMode !== "all" && mode) parts.push(mode.label);
  return parts.join(" · ");
}
