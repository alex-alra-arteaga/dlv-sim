import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { once } from "events";
import path from "path";

import { AlphaProVault } from "../charm/alpha-pro-vault";
import { CommonVariables } from "../enums";

export type ALMAgentOptions = {
  horizonSteps: number;
  stepSeconds: number;
  pythonExecutable?: string;
  inferencePath?: string;
};

export type ALMAgentContext = {
  vault: AlphaProVault;
  metadata: Map<string, unknown>;
};

type PendingRequest = {
  resolve: (action: number) => void;
  reject: (error: Error) => void;
};

type PriceObservation = {
  timestampMs: number;
  price: number;
};

const DEFAULT_OPTIONS: ALMAgentOptions = {
  horizonSteps: 1000,
  stepSeconds: 4 * 60 * 60,
};

export class ALMNeuralAgent {
  private readonly horizonSteps: number;
  private readonly stepMs: number;
  private readonly inferenceScript: string;
  private readonly pythonExecutable: string;

  private python?: ChildProcessWithoutNullStreams;
  private closed = false;
  private stdoutBuffer = "";
  private readonly pending: PendingRequest[] = [];
  private history: PriceObservation[] = [];

  constructor(options: ALMAgentOptions = DEFAULT_OPTIONS) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.horizonSteps = opts.horizonSteps ?? DEFAULT_OPTIONS.horizonSteps;
    const stepSeconds = opts.stepSeconds ?? DEFAULT_OPTIONS.stepSeconds;
    this.stepMs = Math.max(stepSeconds * 1000, 1);
    const scriptPath =
      options.inferencePath ?? path.resolve(process.cwd(), "agents/alm/inference.py");
    this.inferenceScript = scriptPath;
    this.pythonExecutable = options.pythonExecutable ?? "python3";
  }

  async shouldRebalance(ctx: ALMAgentContext): Promise<boolean> {
    const observation = await this.buildObservation(ctx);
    if (!observation) return false;

    this.appendObservation(observation);
    const features = await this.buildFeatureVector(ctx.vault);
    if (!features) return false;

    const action = await this.runInference(features);
    return action === 1;
  }

  async shutdown(): Promise<void> {
    if (!this.python || this.closed) return;
    this.closed = true;
    this.python.kill();
    await once(this.python, "exit").catch(() => undefined);
    this.python = undefined;
  }

  private async buildObservation(ctx: ALMAgentContext): Promise<PriceObservation | null> {
    const { vault, metadata } = ctx;
    const date = metadata.get(CommonVariables.DATE) as Date | undefined;

    const priceWad = vault.poolPrice(vault.pool.sqrtPriceX96);
    console.log(`[ALMNeuralAgent] Current price WAD: ${priceWad.toString()}`);
    const price = Number(priceWad.toString()) / 1e18;
    if (!Number.isFinite(price)) return null;

    const timestampMs = date instanceof Date ? date.getTime() : Date.now();
    return { timestampMs, price };
  }

  private appendObservation(observation: PriceObservation): void {
    this.history.push(observation);
    if (this.history.length > this.horizonSteps) {
      this.history = this.history.slice(this.history.length - this.horizonSteps);
    }
  }

  private async buildFeatureVector(vault: AlphaProVault): Promise<number[] | null> {
    if (this.history.length === 0) return null;

    const ranges = await vault.getPositionPriceRanges();
    const lower = ranges.wide.lower;
    const upper = ranges.wide.upper;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) {
      return null;
    }

    const latestPrice = this.history[this.history.length - 1]?.price ?? 0;
    const meanPrice = this.mean(this.history.map((entry) => entry.price));
    const volatility = this.volatility(this.history.map((entry) => entry.price));
    const slope = this.slope();

    const priceNormed = this.normalizePrice(latestPrice, lower, upper);
    const priceMeanNormed = this.normalizePrice(meanPrice, lower, upper);
    const priceVolNormed = volatility * 0.00025;
    const priceSlopeNormed = this.normalizeSlope(slope);

    const features = [
      priceNormed,
      priceMeanNormed,
      priceVolNormed,
      priceSlopeNormed,
    ].map((value) => (Number.isFinite(value) ? value : 0));

    return features;
  }

  private normalizePrice(price: number, lower: number, upper: number): number {
    if (!Number.isFinite(price) || !Number.isFinite(lower) || !Number.isFinite(upper)) return 0.5;
    const range = upper - lower;
    if (!Number.isFinite(range) || range <= 0) return 0.5;
    const raw = (price - lower) / range;
    if (!Number.isFinite(raw)) return 0.5;
    return Math.max(0, Math.min(1, raw));
  }

  private normalizeSlope(rawSlope: number): number {
    if (!Number.isFinite(rawSlope)) return 0.5;
    const value = 0.5 * ((2 / Math.PI) * Math.atan(0.5 * rawSlope) + 1);
    return Math.max(0, Math.min(1, value));
  }

  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    const sum = values.reduce((acc, value) => acc + value, 0);
    return sum / values.length;
  }

  private volatility(values: number[]): number {
    if (values.length < 2) return 0;
    const meanValue = this.mean(values);
    const variance =
      values.reduce((acc, value) => {
        const diff = value - meanValue;
        return acc + diff * diff;
      }, 0) / (values.length - 1);
    return Math.sqrt(Math.max(variance, 0));
  }

  private slope(): number {
    if (this.history.length < 2) return 0;
    const firstTimestamp = this.history[0].timestampMs;
    const xs = this.history.map(
      (entry) => (entry.timestampMs - firstTimestamp) / this.stepMs,
    );
    const ys = this.history.map((entry) => entry.price);

    const meanX = this.mean(xs);
    const meanY = this.mean(ys);

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < xs.length; i += 1) {
      const dx = xs[i] - meanX;
      numerator += dx * (ys[i] - meanY);
      denominator += dx * dx;
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
        const entry = this.pending.pop();
        if (entry) entry.reject(err);
      });
    });
  }

  private initializeProcess(): void {
    if (this.python) return;

    const cwd = path.dirname(this.inferenceScript);
    this.python = spawn(this.pythonExecutable, [this.inferenceScript], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.python.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      this.drainStdoutBuffer();
    });

    this.python.stderr.on("data", (chunk: Buffer) => {
      // eslint-disable-next-line no-console
      console.warn("[ALMNeuralAgent][stderr]", chunk.toString());
    });

    this.python.once("error", (err) => {
      if (this.closed) return;
      this.closed = true;
      while (this.pending.length > 0) {
        const entry = this.pending.shift();
        entry?.reject(err instanceof Error ? err : new Error(String(err)));
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
    const entry = this.pending.shift();
    if (!entry) return;
    try {
      const parsed = JSON.parse(line) as { action?: number; error?: string };
      if (parsed.error) {
        entry.reject(new Error(parsed.error));
        return;
      }
      if (typeof parsed.action !== "number") {
        entry.reject(new Error("Malformed response from inference process"));
        return;
      }
      entry.resolve(parsed.action);
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error("Invalid JSON response"));
    }
  }
}
