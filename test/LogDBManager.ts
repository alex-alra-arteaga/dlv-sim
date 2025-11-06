import knexBuilder from "knex";
import type { Knex } from "knex";
import { DateConverter } from "@bella-defintech/uniswap-v3-simulator";
import { BigNumber as BN } from "ethers";
import { RebalanceLog } from "./DLV.test";

const DATE_FORMAT: string = "YYYY-MM-DD HH:mm:ss.SSS";

// type RebalanceLogRecord = {
//   wide0: number;
//   wide1: number;
//   base0: number;
//   base1: number;
//   limit0: number;
//   limit1: number;
//   total0: number;
//   total1: number;
//   nonVolatileAssetPrice: BN;
//   assetsBalanceInUSDC: BN;
//   date: Date;
// };

export class LogDBManager {
  private knex: Knex;

  constructor(dbPath: string) {
    const config: Knex.Config = {
      client: "sqlite3",
      connection: {
        filename: dbPath, //:memory:
      },
      // sqlite does not support inserting default values. Set the `useNullAsDefault` flag to hide the warning.
      useNullAsDefault: true,
    };
    this.knex = knexBuilder(config);
  }

  initTables(): Promise<void> {
    const knex = this.knex;
    return knex.schema.hasTable("rebalanceLog").then(async (exists: boolean) => {
      if (!exists) {
        return knex.schema.createTable(
          "rebalanceLog",
          function (t: Knex.TableBuilder) {
            t.increments("id").primary();
            t.string("wide0", 255);
            t.string("wide1", 255);
            t.string("base0", 255);
            t.string("base1", 255);
            t.string("limit0", 255);
            t.string("limit1", 255);
            t.string("total0", 255);
            t.string("total1", 255);
            t.string("nonVolatileAssetPrice", 255);
            t.string("prevTotalPoolValue", 255);
            t.string("afterTotalPoolValue", 255);
            t.string("lpRatio", 255);
            t.string("swapFeeStable", 255);
            t.string("prevCollateralRatio", 255);
            t.string("afterCollateralRatio", 255);
            t.string("accumulatedSwapFees0", 255);
            t.string("accumulatedSwapFees1", 255);
            t.string("almSwapFeeStable", 255);
            t.string("volatileHoldValueStable", 255);
            t.string("realizedIL", 255);
            t.string("swapFeesGainedThisPeriod", 255);
            t.text("date");
          }
        );
      }

      // If table exists, ensure all expected columns are present (migration for older DB files)
      const expectedColumns: { name: string; type: "string" | "text" }[] = [
        { name: "wide0", type: "string" },
        { name: "wide1", type: "string" },
        { name: "base0", type: "string" },
        { name: "base1", type: "string" },
        { name: "limit0", type: "string" },
        { name: "limit1", type: "string" },
        { name: "total0", type: "string" },
        { name: "total1", type: "string" },
        { name: "nonVolatileAssetPrice", type: "string" },
        { name: "prevTotalPoolValue", type: "string" },
        { name: "afterTotalPoolValue", type: "string" },
        { name: "lpRatio", type: "string" },
        { name: "swapFeeStable", type: "string" },
        { name: "prevCollateralRatio", type: "string" },
        { name: "afterCollateralRatio", type: "string" },
        { name: "accumulatedSwapFees0", type: "string" },
        { name: "accumulatedSwapFees1", type: "string" },
        { name: "almSwapFeeStable", type: "string" },
        { name: "volatileHoldValueStable", type: "string" },
        { name: "realizedIL", type: "string" },
        { name: "swapFeesGainedThisPeriod", type: "string" },
        { name: "date", type: "text" },
      ];

      for (const col of expectedColumns) {
        // eslint-disable-next-line no-await-in-loop
        const has = await knex.schema.hasColumn("rebalanceLog", col.name);
        if (!has) {
          // eslint-disable-next-line no-await-in-loop
          await knex.schema.table("rebalanceLog", (t: Knex.TableBuilder) => {
            if (col.type === "text") t.text(col.name);
            else t.string(col.name, 255);
          });
        }
      }
      return Promise.resolve();
    });
  }

  persistRebalanceLog(rebalanceLog: RebalanceLog): Promise<number> {
    return this.knex
      .transaction((trx) =>
        this.insertRebalanceLog(
          rebalanceLog.wide0,
          rebalanceLog.wide1,
          rebalanceLog.base0,
          rebalanceLog.base1,
          rebalanceLog.limit0,
          rebalanceLog.limit1,
          rebalanceLog.total0,
          rebalanceLog.total1,
          rebalanceLog.nonVolatileAssetPrice,
          rebalanceLog.prevTotalPoolValue,
          rebalanceLog.afterTotalPoolValue,
          rebalanceLog.lpRatio,
          rebalanceLog.swapFeeStable,
          rebalanceLog.almSwapFeeStable ?? BN.from(0),
          rebalanceLog.prevCollateralRatio,
          rebalanceLog.afterCollateralRatio,
          rebalanceLog.accumulatedSwapFees0,
          rebalanceLog.accumulatedSwapFees1,
          rebalanceLog.volatileHoldValueStable,
          rebalanceLog.realizedIL,
          rebalanceLog.swapFeesGainedThisPeriod,
          rebalanceLog.date,
          trx
        )
      )
      .then((ids) => Promise.resolve(ids[0]));
  }

  clearRebalanceLog(): Promise<number> {
    return this.knex("rebalanceLog").del();
  }

  close(): Promise<void> {
    return this.knex.destroy();
  }

  private insertRebalanceLog(
    wide0: number,
    wide1: number,
    base0: number,
    base1: number,
    limit0: number,
    limit1: number,
    total0: BN,
    total1: BN,
    nonVolatileAssetPrice: BN,
    prevTotalPoolValue: BN,
    afterTotalPoolValue: BN,
    lpRatio: BN,
    swapFeeStable: BN,
    almSwapFeeStable: BN,
    prevCollateralRatio: BN,
    afterCollateralRatio: BN,
    accumulatedSwapFees0: BN,
    accumulatedSwapFees1: BN,
    volatileHoldValueStable: BN,
    realizedIL: BN,
    swapFeesGainedThisPeriod: BN,
    date: Date,
    trx?: Knex.Transaction
  ): Promise<Array<number>> {
    return this.getBuilderContext("rebalanceLog", trx).insert([
      {
        wide0: wide0.toString(),
        wide1: wide1.toString(),
        base0: base0.toString(),
        base1: base1.toString(),
        limit0: limit0.toString(),
        limit1: limit1.toString(),
        total0: total0.toString(),
        total1: total1.toString(),
        nonVolatileAssetPrice: nonVolatileAssetPrice.toString(),
        prevTotalPoolValue: prevTotalPoolValue.toString(),
        afterTotalPoolValue: afterTotalPoolValue.toString(),
        lpRatio: lpRatio.toString(),
        swapFeeStable: swapFeeStable.toString(),
        almSwapFeeStable: almSwapFeeStable.toString(),
        prevCollateralRatio: prevCollateralRatio.toString(),
        afterCollateralRatio: afterCollateralRatio.toString(),
        accumulatedSwapFees0: accumulatedSwapFees0.toString(),
        accumulatedSwapFees1: accumulatedSwapFees1.toString(),
        volatileHoldValueStable: volatileHoldValueStable.toString(),
        realizedIL: realizedIL.toString(),
        swapFeesGainedThisPeriod: swapFeesGainedThisPeriod.toString(),
        date: DateConverter.formatDate(date, DATE_FORMAT),
      },
    ]);
  }

  private getBuilderContext(
    tableName: string,
    trx?: Knex.Transaction
  ): Knex.QueryBuilder {
    return trx ? trx(tableName) : this.knex(tableName);
  }
}