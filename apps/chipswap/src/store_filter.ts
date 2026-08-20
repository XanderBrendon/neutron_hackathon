// The store filter axes. The backend applies them so `total` stays correct for
// the filtered set, which means the tile only has to name them.

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

// "Swaps freely" and "Has requirements" are not opposites: a design may ask for
// the designer's approval and nothing else, which is neither of them.
export const POLICY_OPTIONS = [
  { value: "all", label: "Any trade policy" },
  { value: "open", label: "Swaps freely" },
  { value: "approval", label: "Designer approves" },
  { value: "requirements", label: "Has requirements" },
] as const;

export const NSFW_OPTIONS = [
  { value: "hide", label: "Hide NSFW" },
  { value: "show", label: "Show NSFW" },
] as const;

export function defaultFilter(): StoreFilter {
  return {
    ownership: "all",
    designerOwnership: "all",
    policy: "all",
    // Tagged chips stay out until they are asked for. The store says how many
    // it left out, so this is never a silent omission.
    nsfw: "hide",
  };
}

export function isDefaultFilter(filter: StoreFilter): boolean {
  return (
    filter.ownership === "all" &&
    filter.designerOwnership === "all" &&
    filter.policy === "all" &&
    filter.nsfw === "hide"
  );
}

/** Exactly the field names the backend query expects. */
export function serializeFilter(filter: StoreFilter): {
  ownership: string;
  designer_ownership: string;
  policy: string;
  nsfw: string;
} {
  return {
    ownership: filter.ownership,
    designer_ownership: filter.designerOwnership,
    policy: filter.policy,
    nsfw: filter.nsfw,
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
  const policy = POLICY_OPTIONS.find((option) => option.value === filter.policy);
  if (filter.ownership !== "all" && ownership) parts.push(ownership.label);
  if (filter.designerOwnership !== "all" && designer) parts.push(designer.label);
  if (filter.policy !== "all" && policy) parts.push(policy.label);
  // Only the unusual choice is worth naming: hiding tagged chips is the default.
  if (filter.nsfw === "show") parts.push("NSFW shown");
  return parts.join(" · ");
}
