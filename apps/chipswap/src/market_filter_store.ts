// Where the market's filter waits while you are looking at something else.
//
// The filter is a choice about this browser rather than something the canister
// owns, so it is kept here and never sent anywhere. Switching tabs unmounts the
// Market, which is what used to lose it.
//
// What is read back is parsed rather than trusted: an older build, a second
// tab, or a hand-edited entry can all leave something unexpected under this
// key, and a filter that will not load should return the market to its default
// rather than break the page.
//
// The tile's partition is ephemeral, so this outlives moving between tabs and a
// reload, not a browser restart. Anything that has to survive the machine's
// session belongs in the background's store instead (`src/resident/store.ts`).

import {
  defaultFilter,
  isDefaultFilter,
  parseFilter,
  type MarketFilter,
} from "./market_filter.ts";

export const MARKET_FILTER_KEY = "chipswap.market.filter";

/**
 * `localStorage`, or null where it cannot be reached. Reaching for it can throw
 * rather than come back empty — a frame denied storage, a browser set to refuse
 * it — so the access itself is guarded and not just its result.
 */
function browserStore(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The filter this browser last had, or the default if it has none to give. */
export function readStoredFilter(
  store: Storage | null = browserStore(),
): MarketFilter {
  if (store === null) return defaultFilter();
  let raw: string | null;
  try {
    raw = store.getItem(MARKET_FILTER_KEY);
  } catch {
    return defaultFilter();
  }
  if (raw === null) return defaultFilter();
  try {
    return parseFilter(JSON.parse(raw) as unknown);
  } catch {
    // Not JSON at all. The default market is a better answer than none.
    return defaultFilter();
  }
}

export function writeStoredFilter(
  filter: MarketFilter,
  store: Storage | null = browserStore(),
): void {
  if (store === null) return;
  try {
    if (isDefaultFilter(filter)) {
      // An absent key already means the default, so storing it would only
      // leave something behind to go stale against a later default.
      store.removeItem(MARKET_FILTER_KEY);
    } else {
      store.setItem(MARKET_FILTER_KEY, JSON.stringify(filter));
    }
  } catch {
    // A filter that could not be saved is not worth interrupting the market
    // over: the view keeps working, it just will not be remembered.
  }
}
