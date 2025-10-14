import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import Decimal from "decimal.js-light";
import { once } from "events";
import path from "path";

import type { AlphaProVault } from "../charm/alpha-pro-vault";
import { CommonVariables } from "../enums";
import { WAD } from "../utils";
import JSBI from "jsbi";

type ObservationKey = "leverage" | "volRatio" | "calmPart";

type Observation = {
  timestampMs: number;
  leverage: number;
  volRatio: number;
  calmPart: number;
};

export type DebtNeuralAgentOptions = {
  topLeverage: number;
  bottomLeverage: number;
  horizonSeconds: number;
  pythonExecutable?: string;
  inferencePath?: string;
};

export type DebtAgentContext = {
  vault: AlphaProVault;
  metadata: Map<string, unknown>;
};

const DEFAULT_OPTIONS: DebtNeuralAgentOptions = {
  topLeverage: 2.2,
  bottomLeverage: 1.8,
  horizonSeconds: 600,
};

const DEFAULT_TARGET_CR = JSBI.multiply(JSBI.BigInt(2), WAD); // 2e18 == 200%

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

export class DebtNeuralAgent {
  private readonly topLeverage: number;
  private readonly bottomLeverage: number;
  private readonly horizonMs: number;
  private readonly midLeverage: number;
  private python?: ChildProcessWithoutNullStreams;
  private readonly pending: Array<{
    resolve: (value: number) => void;
    reject: (error: Error) => void;
  }> = [];
  private stdoutBuffer = "";
  private closed = false;
  private readonly inferenceScript: string;
  private history: Observation[] = [];

  constructor(private readonly options: DebtNeuralAgentOptions = DEFAULT_OPTIONS) {
    this.topLeverage = options.topLeverage ?? DEFAULT_OPTIONS.topLeverage;
    this.bottomLeverage = options.bottomLeverage ?? DEFAULT_OPTIONS.bottomLeverage;
    this.horizonMs = (options.horizonSeconds ?? DEFAULT_OPTIONS.horizonSeconds) * 1000;
    this.midLeverage = (this.topLeverage + this.bottomLeverage) / 2;

    const scriptPath =
      options.inferencePath ??
      path.resolve(process.cwd(), "agents/debt/model/inference.py");
    this.inferenceScript = scriptPath;
  }

  async recommendTargetCR(ctx: DebtAgentContext): Promise<JSBI | null> {
    const observation = await this.buildObservation(ctx);
    if (!observation) return DEFAULT_TARGET_CR;

    this.appendObservation(observation);
    const obsVector = this.buildFeatureVector();
    if (!obsVector) return DEFAULT_TARGET_CR;

    const action = await this.runInference(obsVector);
    const targetLeverage = this.leverageForAction(action);
    if (targetLeverage === null) return null;
    return this.targetCrFromLeverage(targetLeverage);
  }

  async shutdown(): Promise<void> {
    if (!this.python || this.closed) return;
    this.closed = true;
    this.python.kill();
    await once(this.python, "exit").catch(() => undefined);
  }

  private leverageForAction(action: number): number | null {
    switch (action) {
      case 0:
        return null;
      case 1:
        return this.midLeverage;
      case 2:
        return (this.topLeverage + this.midLeverage) / 2;
      case 3:
        return (this.bottomLeverage + this.midLeverage) / 2;
      default:
        return null;
    }
  }

  private targetCrFromLeverage(leverage: number): JSBI {
    if (!Number.isFinite(leverage) || leverage <= 1) {
      return DEFAULT_TARGET_CR;
    }
    const ratio = 1 + 1 / (leverage - 1);
    return this.toWad(ratio);
  }

  private toWad(value: number): JSBI {
    const dec = new Decimal(value);
    const scaled = dec.mul(new Decimal("1e18")).toFixed(0, Decimal.ROUND_HALF_UP);
    return JSBI.BigInt(scaled);
  }

  private appendObservation(observation: Observation): void {
    this.history.push(observation);
    const cutoff = observation.timestampMs - this.horizonMs;
    this.history = this.history.filter((item) => item.timestampMs >= cutoff);
  }

  private async buildObservation(ctx: DebtAgentContext): Promise<Observation | null> {
    const { vault, metadata } = ctx;
    const date = metadata.get(CommonVariables.DATE) as Date | undefined;
    const timestampMs = date ? date.getTime() : Date.now();

    const totalAmounts = await vault.getTotalAmounts();
    const price = vault.poolPrice(vault.pool.sqrtPriceX96);
    const volatileValue = vault.volatileToStableValue(totalAmounts.total0, price);
    const debt = vault.virtualDebt;

    const stableDec = new Decimal(totalAmounts.total1.toString());
    const volatileDec = new Decimal(volatileValue.toString());
    const debtDec = new Decimal(debt.toString());
    const gross = stableDec.plus(volatileDec);

    if (gross.lte(0)) {
      return {
        timestampMs,
        leverage: this.midLeverage,
        volRatio: 0.5,
        calmPart: 0.5,
      };
    }

    const collateralRaw = gross.minus(debtDec);
    const collateral = collateralRaw.lte(0)
      ? new Decimal("1e-9")
      : collateralRaw;

    const calmPart = clamp01(
      gross.isZero() ? 0.5 : stableDec.div(gross).toNumber()
    );
    const positiveVolatile = volatileDec.lt(0) ? new Decimal(0) : volatileDec;
    const volRatio = collateral.lte(0)
      ? 0
      : positiveVolatile
          .div(collateral)
          .toNumber();

    const cumulativeLp = debtDec;
    const y = collateral.lte(0)
      ? 0
      : cumulativeLp.div(collateral).toNumber();

    let leverage = this.midLeverage;
    if (calmPart > 0) {
      leverage = volRatio / calmPart + y + 1;
    }

    if (!Number.isFinite(leverage)) leverage = this.midLeverage;

    return {
      timestampMs,
      leverage,
      volRatio: Number.isFinite(volRatio) ? volRatio : 0,
      calmPart,
    };
  }

  private buildFeatureVector(): number[] | null {
    if (this.history.length === 0) return null;
    const latest = this.history[this.history.length - 1];

    const leverageMean = this.mean("leverage");
    const volMean = this.mean("volRatio");
    const calmMean = this.mean("calmPart");

    const leverageNorm = this.normalizeLeverage(latest.leverage);
    const leverageMeanNorm = this.normalizeLeverage(leverageMean);

    const leverageSlope = this.normalizeSlope(this.slope("leverage"));
    const volSlope = this.normalizeSlope(this.slope("volRatio"));
    const calmSlope = this.normalizeSlope(this.slope("calmPart"));

    const crNorm = this.collateralRatioNorm();

    return [
      leverageNorm,
      crNorm,
      leverageMeanNorm,
      leverageSlope,
      latest.volRatio,
      volMean,
      volSlope,
      latest.calmPart,
      calmMean,
      calmSlope,
    ].map((value) => (Number.isFinite(value) ? value : 0));
  }

  private collateralRatioNorm(): number {
    if (this.history.length === 0) return 0.5;
    const latest = this.history[this.history.length - 1];

    const leverage = latest.leverage;
    if (!Number.isFinite(leverage) || leverage <= 1) return 0.5;

    const cr = 1 + 1 / (leverage - 1);
    return cr <= 0 ? 0 : 1 / cr;
  }

  private normalizeLeverage(value: number): number {
    const denom = this.topLeverage - this.bottomLeverage;
    if (denom <= 0) return clamp01(value - this.bottomLeverage);
    return clamp01((value - this.bottomLeverage) / denom);
  }

  private normalizeSlope(rawSlope: number): number {
    if (!Number.isFinite(rawSlope)) return 0.5;
    const alpha = Math.atan(8000 * rawSlope);
    return (2 / Math.PI) * alpha * 0.5 + 0.5;
  }

  private mean(key: ObservationKey): number {
    if (this.history.length === 0) return 0;
    const sum = this.history.reduce((acc, item) => acc + item[key], 0);
    return sum / this.history.length;
  }

  private slope(key: ObservationKey): number {
    if (this.history.length < 2) return 0;
    const n = this.history.length;
    const meanTime = this.history.reduce((acc, item) => acc + item.timestampMs, 0) / n;
    const meanVal = this.mean(key);

    let numerator = 0;
    let denominator = 0;
    for (const item of this.history) {
      const dt = (item.timestampMs - meanTime) / 1000;
      const dv = item[key] - meanVal;
      numerator += dt * dv;
      denominator += dt * dt;
    }

    if (denominator === 0) return 0;
    return numerator / denominator;
  }

  private async runInference(features: number[]): Promise<number> {
    if (!this.python) this.initializeProcess();

    return new Promise<number>((resolve, reject) => {
      if (!this.python || this.closed) {
        reject(new Error("Inference process is not available"));
        return;
      }
      this.pending.push({ resolve, reject });
      const payload = JSON.stringify({ type: "infer", obs: features });
      this.python.stdin.write(`${payload}\n`, (err) => {
        if (!err) return;
        const pendingEntry = this.pending.pop();
        if (pendingEntry) pendingEntry.reject(err);
      });
    });
  }

  private initializeProcess(): void {
    if (this.python) return;
    const pythonExecutable = this.options.pythonExecutable ?? "python3";
    const cwd = path.dirname(this.inferenceScript);

    this.python = spawn(pythonExecutable, [this.inferenceScript], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.python.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      this.drainStdoutBuffer();
    });

    this.python.stderr.on("data", (chunk: Buffer) => {
      // eslint-disable-next-line no-console
      console.warn("[DebtNeuralAgent][stderr]", chunk.toString());
    });

    this.python.once("error", (err) => {
      if (this.closed) return;
      this.closed = true;
      while (this.pending.length > 0) {
        const entry = this.pending.shift();
        entry?.reject(err);
      }
    });

    this.python.once("exit", () => {
      if (this.closed) return;
      this.closed = true;
      while (this.pending.length > 0) {
        const entry = this.pending.shift();
        entry?.reject(new Error("Inference process exited unexpectedly"));
      }
    });
  }

  private drainStdoutBuffer(): void {
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleResponse(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleResponse(line: string): void {
    const pendingEntry = this.pending.shift();
    if (!pendingEntry) return;
    try {
      const parsed = JSON.parse(line) as { action?: number; error?: string };
      if (parsed.error !== undefined) {
        pendingEntry.reject(new Error(parsed.error));
        return;
      }
      if (typeof parsed.action !== "number") {
        pendingEntry.reject(new Error("Malformed response from inference process"));
        return;
      }
      pendingEntry.resolve(parsed.action);
    } catch (error) {
      pendingEntry.reject(
        error instanceof Error ? error : new Error("Invalid JSON response"),
      );
    }
  }
}
