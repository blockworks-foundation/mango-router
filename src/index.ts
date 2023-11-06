import {
  MangoClient,
  MANGO_V4_ID,
  toNative,
  toUiDecimals,
} from "@blockworks-foundation/mango-v4";
import { U64_MAX, ZERO } from "@orca-so/common-sdk";
import {
  AnchorProvider,
  Wallet,
  BN,
  BorshAccountsCoder,
} from "@coral-xyz/anchor";
import {
  Connection,
  Cluster,
  clusterApiUrl,
  PublicKey,
  Keypair,
} from "@solana/web3.js";
import cors from "cors";
import express from "express";

import { DepthResult, Router, SwapMode, SwapResult } from "./router";

const {
  CLUSTER,
  FLY_APP_NAME,
  FLY_ALLOC_ID,
  GROUP,
  MAX_ROUTES,
  MIN_TVL,
  PORT,
  RPC_URL,
} = process.env;

import * as prom from "prom-client";
const collectDefaultMetrics = prom.collectDefaultMetrics;
collectDefaultMetrics({
  labels: {
    app: FLY_APP_NAME,
    instance: FLY_ALLOC_ID,
  },
});

import promBundle from "express-prom-bundle";
const metricsApp = express();
const promMetrics = promBundle({
  includeMethod: true,
  metricsApp,
  autoregister: false,
});

const cluster = (CLUSTER || "mainnet-beta") as Cluster;
const groupPk = new PublicKey(
  GROUP || "78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX"
);
const maxRoutes = parseInt(MAX_ROUTES || "1");
const minTvl = parseInt(MIN_TVL || "500");
const port = parseInt(PORT || "5000");
const rpcUrl = RPC_URL || clusterApiUrl(cluster);

const metricSwapDuration = new prom.Histogram({
  name: "swap_processing_duration_s",
  help: "Swap processing duration in seconds",
  buckets: [0.1, 0.2, 0.5, 1, 5, 10, 20],
});
prom.register.registerMetric(metricSwapDuration);

async function main() {
  // init anchor
  const connection = new Connection(rpcUrl, "confirmed");
  const anchorProvider = new AnchorProvider(
    connection,
    new Wallet(Keypair.generate()),
    {}
  );

  // init mango
  const mangoClient = await MangoClient.connect(
    anchorProvider,
    cluster,
    MANGO_V4_ID[cluster],
    {
      idsSource: "get-program-accounts",
    }
  );
  const group = await mangoClient.getGroup(groupPk);
  await group.reloadAll(mangoClient);

  const banks = Array.from(group.banksMapByMint, ([, value]) => value);
  const coder = new BorshAccountsCoder(mangoClient.program.idl);
  const subs = banks.map(([bank]) =>
    anchorProvider.connection.onAccountChange(
      bank.oracle,
      async (ai, ctx) => {
        if (!ai)
          throw new Error(
            `Undefined accountInfo object in onAccountChange(bank.oracle) for ${bank.oracle.toString()}!`
          );
        const { price, uiPrice } = await group["decodePriceFromOracleAi"](
          coder,
          bank.oracle,
          ai,
          group.getMintDecimals(bank.mint),
          mangoClient
        );
        bank._price = price;
        bank._uiPrice = uiPrice;
      },
      "processed"
    )
  );

  // init router
  const router = new Router(anchorProvider, minTvl);
  await router.start();

  const app = express();
  app.use(promMetrics);
  app.use(cors());
  app.get("/depth", async (req, res) => {
    try {
      const inputMint = new PublicKey(req.query.inputMint as string);
      const outputMint = new PublicKey(req.query.outputMint as string);
      const priceImpactLimit = Number(req.query.priceImpactLimit as string);

      const inputBank = group.getFirstBankByMint(inputMint);
      const outputBank = group.getFirstBankByMint(outputMint);

      // input = referencePrice * output
      const referencePrice =
        (10 ** (inputBank.mintDecimals - outputBank.mintDecimals) *
          outputBank.uiPrice) /
        inputBank.uiPrice;

      // start with $100 and slowly increase until hitting threshold
      const startAmount = toNative(
        100 / inputBank.uiPrice,
        inputBank.mintDecimals
      );

      const results = await router.queryDepth(
        inputMint,
        outputMint,
        startAmount,
        referencePrice,
        priceImpactLimit
      );

      const filtered = results.filter((r) => r.ok);
      filtered.sort((a, b) => b.maxAmtIn.toNumber() - a.maxAmtIn.toNumber());

      // greedy pruning to ensure no edge is touched twice
      let pruned: DepthResult[] = [];
      let usedPools = new Set<string>();
      filtered.forEach((r) => {
        let pools = r.label.split("_");
        let includesUsedPool = pools.find((p) => usedPools.has(p));
        if (!includesUsedPool) {
          pruned.push(r);
          pools.forEach((p) => usedPools.add(p));
        }
      });

      const maxAmtIn = pruned.reduce((p, n) => p.add(n.maxAmtIn), ZERO);
      const minAmtOut = pruned.reduce((p, n) => p.add(n.minAmtOut), ZERO);
      const response = {
        priceImpactLimit,
        labels: pruned.map((r) => r.label),
        maxInput: toUiDecimals(maxAmtIn, inputBank.mintDecimals),
        minOutput: toUiDecimals(minAmtOut, outputBank.mintDecimals),
      };
      res.send(response);
    } catch (err) {
      console.error(err);
      res.status(500).send();
    }
  });

  app.get("/swap", async (req, res) => {
    try {
      const walletPk = new PublicKey(req.query.wallet as string);
      const inputMint = req.query.inputMint as string;
      const inputMintPk = new PublicKey(inputMint);
      const outputMint = req.query.outputMint as string;
      const outputMintPk = new PublicKey(outputMint);
      const mode = req.query.mode as SwapMode;
      const slippage = Number(req.query.slippage as string);
      const amount = new BN(req.query.amount as string);
      const otherAmountThreshold = req.query.otherAmountThreshold
        ? new BN(req.query.otherAmountThreshold as string)
        : mode == SwapMode.ExactIn
        ? ZERO
        : U64_MAX;
      let referencePrice: number;
      if (
        group.banksMapByMint.has(inputMint) &&
        group.banksMapByMint.has(outputMint)
      ) {
        const inputBank = group.banksMapByMint.get(inputMint)![0];
        const outputBank = group.banksMapByMint.get(outputMint)![0];

        referencePrice =
          (10 ** (inputBank.mintDecimals - outputBank.mintDecimals) *
            outputBank.uiPrice) /
          inputBank.uiPrice;
      }

      if (mode !== SwapMode.ExactIn && mode !== SwapMode.ExactOut) {
        const error = { e: "mode needs to be one of ExactIn or ExactOut" };
        res.status(404).send(error);
        return;
      }

      const timerSwapDuration = metricSwapDuration.startTimer();
      const results = await router.swap(
        inputMintPk,
        outputMintPk,
        amount,
        otherAmountThreshold,
        mode,
        slippage
      );
      const swapDuration = timerSwapDuration();
      metricSwapDuration.observe(swapDuration);
      console.log("swap", swapDuration);

      const filtered = results.filter((r) => r.ok);
      let ranked: SwapResult[] = [];
      if (mode === SwapMode.ExactIn) {
        ranked = filtered.sort((a, b) =>
          Number(b.minAmtOut.sub(a.minAmtOut).toString())
        );
      } else if (mode === SwapMode.ExactOut) {
        ranked = filtered.sort((a, b) =>
          Number(a.maxAmtIn.sub(b.maxAmtIn).toString())
        );
      }
      const topN = ranked.slice(0, Math.min(ranked.length, maxRoutes));

      const response = await Promise.all(
        topN.map(async (r) => {
          const instructions = await r.instructions(walletPk);
          let priceImpact: number | undefined = undefined;
          if (referencePrice) {
            const actualPrice =
              Number(r.maxAmtIn.toString()) / Number(r.minAmtOut.toString());
            priceImpact = actualPrice / referencePrice - 1;
          }

          return {
            amount: amount.toString(),
            otherAmountThreshold: otherAmountThreshold.toString(),
            mode,
            slippage,
            inAmount: r.maxAmtIn.toString(),
            outAmount: r.minAmtOut.toString(),
            priceImpact,
            marketInfos: r.marketInfos.map((m) => ({
              label: m.label,
              fee: {
                amount: m.fee.amount.toString(),
                mint: m.fee.mint.toString(),
                rate: m.fee.rate,
              },
            })),
            mints: Array.from(new Set(r.mints.map((m) => m.toString()))),
            instructions: instructions.map((i) => ({
              keys: i.keys.map((k) => ({ ...k, pubkey: k.pubkey.toString() })),
              programId: i.programId.toString(),
              data: i.data.toString("base64"),
            })),
          };
        })
      );

      res.send(response);
    } catch (err) {
      console.error(err);
      res.status(500).send();
    }
  });
  app.listen(port);
  metricsApp.listen(9091);
  // TEST swap: curl 'http://localhost:5000/swap?wallet=Bz9thGbRRfwq3EFtFtSKZYnnXio5LXDaRgJDh3NrMAGT&inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&mode=ExactIn&amount=100000000&slippage=0.001' | jq
  // TEST depth: curl 'http://localhost:5000/depth?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&priceImpactLimit=0.01' | jq
}
main();
