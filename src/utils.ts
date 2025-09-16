import { BigNumber as BN } from "ethers";
import { JSBI, PoolEvent } from "./charm/types";
import { formatInTimeZone } from "date-fns-tz";

// Helper that logs failure context and throws to stop test runners (like mocha)
export function ensure(condition: boolean, message: string, context?: Record<string, any>, allowedDeviationUnits?: number) {
  if (!condition) {
    // If allowedDeviationUnits provided, and a simple expected/actual pair is supplied in context,
    // try to tolerate small differences between expected/actual.
    if (typeof allowedDeviationUnits === 'number' && context) {
      const keys = Object.keys(context || {});

      // If context explicitly contains prevLpRatio/newLpRatio or expected/actual, prefer those.
      let expectedKeyIndex = keys.findIndex(k => /expected/i.test(k));
      let actualKeyIndex = keys.findIndex(k => /actual/i.test(k));

      // fallback: look for prevLpRatio/newLpRatio (case-insensitive)
      if (expectedKeyIndex === -1 || actualKeyIndex === -1) {
        const prevIdx = keys.findIndex(k => /prevLpRatio/i.test(k));
        const newIdx = keys.findIndex(k => /newLpRatio/i.test(k));
        if (prevIdx !== -1 && newIdx !== -1) {
          expectedKeyIndex = prevIdx;
          actualKeyIndex = newIdx;
        }
      }

      // If still not found, allow the 2-key heuristic as before
      if ((expectedKeyIndex === -1 || actualKeyIndex === -1) && keys.length === 2) {
        expectedKeyIndex = 0;
        actualKeyIndex = 1;
      }

      if (expectedKeyIndex !== -1 && actualKeyIndex !== -1) {
        const expV = context[keys[expectedKeyIndex]];
        const actV = context[keys[actualKeyIndex]];
        try {
          // Try integer BN path first to avoid precision loss for large integer-like values
          // Condition: both values convertible to BN and expected != 0
          try {
            const expBN = safeToBN(expV);
            const actBN = safeToBN(actV);
            const zeroBN = BN.from(0);
            if (!expBN.eq(zeroBN)) {
              const diffBN = actBN.sub(expBN);
              const absDiffBN = diffBN.lt(zeroBN) ? diffBN.mul(BN.from(-1)) : diffBN;
              // Check: absDiff * 1e10 <= expected * allowedDeviationUnits
              const scaleBN = BN.from("10000000000");
              const left = absDiffBN.mul(scaleBN);
              const allowedBN = BN.from(String(Math.floor(allowedDeviationUnits)));
              const right = expBN.mul(allowedBN);
              if (left.lte(right)) return; // treat as pass
            }
          } catch (e) {
            // BN path failed, fall back to numeric fractional check below
          }

          // Fallback: numeric fractional check (for non-integer or decimal values)
          const expNum = Number(typeof expV === 'string' ? expV : (expV as any).toString());
          const actNum = Number(typeof actV === 'string' ? actV : (actV as any).toString());
          if (Number.isFinite(expNum) && Number.isFinite(actNum) && expNum !== 0) {
            // allowedDeviationUnits is a fraction scaled to 1e10 (100% == 1e10)
            const allowedFraction = allowedDeviationUnits / 1e10;
            const deviationFraction = Math.abs((actNum - expNum) / expNum);
            if (deviationFraction <= allowedFraction) return; // treat as pass
          }
        } catch (e) {
          // fallthrough to normal failure path
        }
      }
    }
    try {
      // Build a simple safe context object and print it. If context has many keys, stringify as-is.
      const safeCtx: Record<string, any> = {};
      if (context) {
        for (const k of Object.keys(context)) {
          const v = context[k];
          try {
            if (v === null || v === undefined) safeCtx[k] = v;
            else if (typeof v === 'object' && typeof (v as any).toString === 'function') safeCtx[k] = (v as any).toString();
            else safeCtx[k] = v;
          } catch (e) {
            safeCtx[k] = String(v);
          }
        }
      }
      // Print to stderr so mocha captures it prominently.
      // eslint-disable-next-line no-console
      console.error("ENSURE FAILED:", message);
      // eslint-disable-next-line no-console
      console.error("Context:", JSON.stringify(safeCtx, null, 2));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("ENSURE FAILED:", message, "(failed to stringify context)");
    }
    throw new Error(message);
  }
}

export const toBig = (x: string | number | bigint | JSBI) =>
  JSBI.BigInt(typeof x === "object" ? (x as JSBI).toString() : String(x));

/** ---------- Helpers ---------- */
export const ZERO = JSBI.BigInt(0);
export const ONE = JSBI.BigInt(1);
export const MINIMUM_LIQUIDITY = JSBI.BigInt(1_000);
export const HUNDRED_PERCENT = JSBI.BigInt(1_000_000);
export const MAX_UINT128 = JSBI.BigInt("340282366920938463463374607431768211455");
export const LOCKED_HOLDER = "__LOCKED__"; // sink for MINIMUM_LIQUIDITY shares

export const add = (a: JSBI, b: JSBI) => JSBI.add(a, b);
export const sub = (a: JSBI, b: JSBI) => {
  if (JSBI.lessThan(a, b)) throw new Error("UNDERFLOW");
  return JSBI.subtract(a, b);
};
export const mul = (a: JSBI, b: JSBI) => JSBI.multiply(a, b);
export const div = (a: JSBI, b: JSBI) => {
  if (JSBI.equal(b, ZERO)) throw new Error("DIV0");
  return JSBI.divide(a, b);
};
export const lt = (a: JSBI, b: JSBI) => JSBI.lessThan(a, b);
export const gt = (a: JSBI, b: JSBI) => JSBI.greaterThan(a, b);
export const eq = (a: JSBI, b: JSBI) => JSBI.equal(a, b);
export const mulDiv = (a: JSBI, b: JSBI, d: JSBI) => div(mul(a, b), d);
export const ceilDiv = (a: JSBI, b: JSBI) => {
  const q = div(a, b);
  return eq(mul(q, b), a) ? q : add(q, ONE);
};
export const toU128 = (x: JSBI) => {
  if (gt(x, MAX_UINT128)) throw new Error("uint128 overflow");
  return x;
};
export const nowSeconds = () => Math.floor(Date.now() / 1000);

export const WAD = JSBI.BigInt("1000000000000000000"); // 1e18 fixed-point
export const FEE_DEN = JSBI.BigInt(1_000_000);

export const cmp = (a: PoolEvent, b: PoolEvent) =>
a.blockNumber === b.blockNumber
  ? a.logIndex - b.logIndex
  : a.blockNumber - b.blockNumber;

/**
 * Convert a value to an ethers BigNumber safely.
 * - Accepts ethers BigNumber, JSBI, numbers and objects with toString().
 * - For floats, it will round to nearest integer and warn.
 * - For Infinity/NaN/undefined/null it returns 0.
 */
export function safeToBN(value: any): BN {
	try {
		if (value === null || value === undefined) return BN.from(0);

		// Already a BigNumber
		// @ts-ignore: BN has isBigNumber at runtime in ethers
		if (BN.isBigNumber && BN.isBigNumber(value)) return value;

		// JSBI
		if (typeof value === "object" && value !== null && typeof (value as any).toString === "function") {
			const s = (value as any).toString();
			// integer-like string
			if (/^[+-]?\d+$/.test(s)) return BN.from(s);
			// float-like string -> round
			if (/^[+-]?\d+\.\d+$/.test(s)) {
				const n = Number(s);
				if (!Number.isFinite(n)) return BN.from(0);
				const rounded = Math.round(n);
				// eslint-disable-next-line no-console
				console.warn(`safeToBN: rounding float ${s} -> ${rounded}`);
				return BN.from(rounded.toString());
			}
		}

		if (typeof value === "number") {
			if (!Number.isFinite(value)) return BN.from(0);
			if (Number.isInteger(value)) return BN.from(value.toString());
			const rounded = Math.round(value);
			return BN.from(rounded.toString());
		}

		// Fallback: try to stringify
		const s = String(value);
		if (/^[+-]?\d+$/.test(s)) return BN.from(s);
		// last resort: return 0
		return BN.from(0);
	} catch (e) {
		return BN.from(0);
	}
}

export const toIsoZ = (d: Date) => new Date(d.getTime()).toISOString().slice(0, 19) + "Z";
export const dateUtc = (y: number, m1: number, d: number) => new Date(Date.UTC(y, m1 - 1, d, 0, 0, 0, 0));
export const fmtUTC = toIsoZ;