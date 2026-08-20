// The controls a designer sets their trade policy with, and the badges a reader
// sees it through. Both live here because publishing a design, re-policying a
// published one, and reading someone else's listing have to describe the same
// thing in the same words.

import {
  MAX_COVERAGE_CEILING,
  MAX_COVERAGE_FLOOR,
  MIN_COLORS_CEILING,
  MIN_COLORS_FLOOR,
  isOpen,
  type NsfwRule,
  type TradeRequirements,
} from "./requirements.ts";
import type { TradePolicy } from "./api.ts";

// Turning a requirement on needs a value, and these are the ones a designer is
// most likely to have meant: a chip with a handful of colors, and a chip that
// is not most of one color.
const DEFAULT_MIN_COLORS = 4;
const DEFAULT_MAX_COVERAGE = 60;

const NSFW_RULES: { value: NsfwRule; label: string }[] = [
  { value: "any", label: "Tagged or not" },
  { value: "disallowed", label: "Nothing tagged NSFW" },
  { value: "required", label: "NSFW chips only" },
];

/** Clamped rather than refused: a half-typed number is not a decision yet. */
function bounded(value: number, floor: number, ceiling: number): number {
  if (!Number.isFinite(value)) return floor;
  return Math.min(ceiling, Math.max(floor, Math.round(value)));
}

export type TradePolicyFieldsProps = {
  policy: TradePolicy;
  onChange: (policy: TradePolicy) => void;
  disabled?: boolean | undefined;
  /** Names the fieldset for a reader who cannot see the heading above it. */
  label: string;
};

export const TradePolicyFields = ({
  policy,
  onChange,
  disabled,
  label,
}: TradePolicyFieldsProps) => {
  const { requirements } = policy;
  const set = (next: Partial<TradeRequirements>) =>
    onChange({ ...policy, requirements: { ...requirements, ...next } });

  return (
    <fieldset aria-label={label} className="chipswap-policy" disabled={disabled}>
      <label className="nt-field chipswap-policy-check">
        <input
          checked={requirements.approval}
          onChange={(event) => set({ approval: event.currentTarget.checked })}
          type="checkbox"
        />
        <span className="nt-label">Approve each trade myself</span>
      </label>

      <label className="nt-field chipswap-policy-check">
        <input
          checked={requirements.minColors !== null}
          onChange={(event) =>
            set({ minColors: event.currentTarget.checked ? DEFAULT_MIN_COLORS : null })
          }
          type="checkbox"
        />
        <span className="nt-label">Offered chip uses at least</span>
        <input
          aria-label="Minimum colors"
          className="nt-input chipswap-policy-number"
          disabled={requirements.minColors === null}
          max={MIN_COLORS_CEILING}
          min={MIN_COLORS_FLOOR}
          onChange={(event) =>
            set({
              minColors: bounded(
                event.currentTarget.valueAsNumber,
                MIN_COLORS_FLOOR,
                MIN_COLORS_CEILING,
              ),
            })
          }
          type="number"
          value={requirements.minColors ?? DEFAULT_MIN_COLORS}
        />
        <span className="nt-label">colors</span>
      </label>

      <label className="nt-field chipswap-policy-check">
        <input
          checked={requirements.maxCoverage !== null}
          onChange={(event) =>
            set({
              maxCoverage: event.currentTarget.checked ? DEFAULT_MAX_COVERAGE : null,
            })
          }
          type="checkbox"
        />
        <span className="nt-label">No one color covers more than</span>
        <input
          aria-label="Maximum single-color coverage"
          className="nt-input chipswap-policy-number"
          disabled={requirements.maxCoverage === null}
          max={MAX_COVERAGE_CEILING}
          min={MAX_COVERAGE_FLOOR}
          onChange={(event) =>
            set({
              maxCoverage: bounded(
                event.currentTarget.valueAsNumber,
                MAX_COVERAGE_FLOOR,
                MAX_COVERAGE_CEILING,
              ),
            })
          }
          type="number"
          value={requirements.maxCoverage ?? DEFAULT_MAX_COVERAGE}
        />
        <span className="nt-label">percent of it</span>
      </label>

      <label className="nt-field">
        <span className="nt-label">Chips tagged NSFW</span>
        <select
          className="nt-select"
          onChange={(event) =>
            set({ nsfw: event.currentTarget.value as NsfwRule })
          }
          value={requirements.nsfw}
        >
          {NSFW_RULES.map((rule) => (
            <option key={rule.value} value={rule.value}>
              {rule.label}
            </option>
          ))}
        </select>
      </label>

      <label className="nt-field chipswap-policy-check chipswap-policy-tag">
        <input
          checked={policy.nsfw}
          onChange={(event) =>
            onChange({ ...policy, nsfw: event.currentTarget.checked })
          }
          type="checkbox"
        />
        <span className="nt-label">
          This chip is NSFW. The tag travels with every copy that is minted from
          now on.
        </span>
      </label>
    </fieldset>
  );
};

export type PolicyBadgesProps = {
  requirements: TradeRequirements;
  nsfw: boolean;
};

/**
 * The policy at a glance. A design that asks for nothing says so rather than
 * showing an empty row, because "no badges" and "not loaded yet" would look the
 * same.
 */
export const PolicyBadges = ({ requirements, nsfw }: PolicyBadgesProps) => (
  <div className="chipswap-badges">
    {nsfw ? (
      <span className="nt-badge nt-badge--warning" title="Tagged NSFW">
        NSFW
      </span>
    ) : null}
    {isOpen(requirements) ? (
      <span className="nt-badge">Swaps freely</span>
    ) : null}
    {requirements.approval ? (
      <span className="nt-badge">Designer approves</span>
    ) : null}
    {requirements.minColors !== null ? (
      <span className="nt-badge">{requirements.minColors}+ colors</span>
    ) : null}
    {requirements.maxCoverage !== null ? (
      <span className="nt-badge">≤{requirements.maxCoverage}% one color</span>
    ) : null}
    {requirements.nsfw === "disallowed" ? (
      <span className="nt-badge">No NSFW</span>
    ) : null}
    {requirements.nsfw === "required" ? (
      <span className="nt-badge">NSFW only</span>
    ) : null}
  </div>
);
