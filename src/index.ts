import {
  getAssociatedTokenAddress,
  MangoClient,
  MANGO_V4_ID,
} from "@blockworks-foundation/mango-v4";
import { Percentage, U64_MAX, ZERO } from "@orca-so/common-sdk";
import {
  buildWhirlpoolClient,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  SwapQuote,
  swapQuoteByInputToken,
  swapQuoteByOutputToken,
  Whirlpool,
  WhirlpoolClient,
  WhirlpoolContext,
} from "@orca-so/whirlpools-sdk";
import {
  AnchorProvider,
  BN,
  BorshAccountsCoder,
  Idl,
} from "@project-serum/anchor";
import {
  Cluster,
  clusterApiUrl,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import cors from "cors";
import express from "express";

const { CLUSTER, FLY_APP_NAME, FLY_ALLOC_ID, MAX_ROUTES, PORT, RPC_URL } =
  process.env;

import * as prom from "prom-client";
const collectDefaultMetrics = prom.collectDefaultMetrics;
collectDefaultMetrics({
  labels: {
    app: FLY_APP_NAME,
    instance: FLY_ALLOC_ID,
  },
});

import promBundle from "express-prom-bundle";
const promMetrics = promBundle({ includeMethod: true });

const cluster = (CLUSTER || "mainnet-beta") as Cluster;
const maxRoutes = parseInt(MAX_ROUTES || "2");
const port = parseInt(PORT || "5000");
const rpcUrl = RPC_URL || clusterApiUrl(cluster);

enum SwapMode {
  ExactIn = "ExactIn",
  ExactOut = "ExactOut",
}

interface SwapResult {
  instructions: (wallet: PublicKey) => Promise<TransactionInstruction[]>;
  label: string;
  maxAmtIn: BN;
  minAmtOut: BN;
  ok: boolean;
}

function mergeSwapResults(...hops: SwapResult[]) {
  const firstHop = hops[0];
  const lastHop = hops[hops.length - 1];
  return {
    instructions: async (wallet: PublicKey) =>
      await (await Promise.all(hops.map((h) => h.instructions(wallet)))).flat(),
    label: hops.map((h) => h.label).join("_"),
    maxAmtIn: firstHop.maxAmtIn,
    minAmtOut: lastHop.minAmtOut,
    ok: hops.reduce((p, c) => p && c.ok, true),
  };
}

interface Edge {
  label: string;
  inputMint: PublicKey;
  outputMint: PublicKey;
  swap: (
    amount: BN,
    otherAmountThreshold: BN,
    mode: SwapMode,
    slippage: number
  ) => Promise<SwapResult>;
}

class WhirlpoolEdge implements Edge {
  constructor(
    public label: string,
    public inputMint: PublicKey,
    public outputMint: PublicKey,
    public poolPk: PublicKey,
    public client: WhirlpoolClient
  ) {}

  static pairFromPool(pool: Whirlpool, client: WhirlpoolClient): Edge[] {
    const fwd = new WhirlpoolEdge(
      "Whirlpool",
      pool.getTokenAInfo().mint,
      pool.getTokenBInfo().mint,
      pool.getAddress(),
      client
    );
    const bwd = new WhirlpoolEdge(
      "Whirpool",
      pool.getTokenBInfo().mint,
      pool.getTokenAInfo().mint,
      pool.getAddress(),
      client
    );

    return [fwd, bwd];
  }

  async swap(
    amount: BN,
    otherAmountThreshold: BN,
    mode: SwapMode,
    slippage: number
  ): Promise<SwapResult> {
    try {
      const fetcher = this.client.getFetcher();
      const pool = await this.client.getPool(this.poolPk);
      const programId = this.client.getContext().program.programId;
      const slippageLimit = Percentage.fromFraction(slippage * 1e8, 1e8);
      let quote: SwapQuote | undefined;
      let ok: boolean = false;

      if (mode === SwapMode.ExactIn) {
        quote = await swapQuoteByInputToken(
          pool,
          this.inputMint,
          amount,
          slippageLimit,
          programId,
          fetcher,
          true
        );
        ok = otherAmountThreshold.lte(quote.estimatedAmountOut);
      } else {
        quote = await swapQuoteByOutputToken(
          pool,
          this.outputMint,
          amount,
          slippageLimit,
          programId,
          fetcher,
          true
        );
        ok = otherAmountThreshold.gte(quote.estimatedAmountIn);
      }

      let instructions = async (wallet: PublicKey) => {
        if (!ok) {
          return [];
        }
        const tokenIn = await getAssociatedTokenAddress(this.inputMint, wallet);
        const tokenOut = await getAssociatedTokenAddress(
          this.outputMint,
          wallet
        );
        return [await pool.getSwapIx(quote!, tokenIn, tokenOut, wallet)];
      };
      return {
        ok,
        instructions,
        label: this.poolPk.toString().slice(0, 6),
        maxAmtIn: quote.estimatedAmountIn,
        minAmtOut: quote.estimatedAmountOut,
      };
    } catch (e) {
      if (false) {
        console.log(
          "could not swap",
          this.poolPk.toString().slice(0, 6),
          this.inputMint.toString().slice(0, 6),
          this.outputMint.toString().slice(0, 6),
          amount.toNumber(),
          otherAmountThreshold.toNumber()
        );
      }
      return {
        ok: false,
        label: "",
        maxAmtIn: amount,
        minAmtOut: otherAmountThreshold,
        instructions: async () => [],
      };
    }
  }
}

class Router {
  whirlpoolClient: WhirlpoolClient;
  routes: Map<string, Map<string, Edge[]>>;

  whirlpoolSub?: number;

  constructor(mangoClient: MangoClient, whirpoolClient: WhirlpoolClient) {
    this.whirlpoolClient = whirpoolClient;
    this.routes = new Map();
  }

  async start(): Promise<void> {
    await this.indexWhirpools();

    // setup a websocket connection to refresh all whirpool program accounts
    const idl = this.whirlpoolClient.getContext().program.idl;
    const whirlpoolCoder = new BorshAccountsCoder(idl as Idl);
    this.whirlpoolSub = this.whirlpoolClient
      .getContext()
      .connection.onProgramAccountChange(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        (p) => {
          const key = p.accountId.toBase58();
          const accountData = p.accountInfo.data;
          const value = whirlpoolCoder.decodeAny(accountData);
          this.whirlpoolClient.getFetcher()["_cache"][key] = {
            entity: undefined,
            value,
          };
        },
        "processed"
      );
  }

  async stop(): Promise<void> {
    if (this.whirlpoolSub) {
      await this.whirlpoolClient
        .getContext()
        .connection.removeProgramAccountChangeListener(this.whirlpoolSub);
    }
  }

  addEdge(edge: Edge) {
    const mintA = edge.inputMint.toString();
    const mintB = edge.outputMint.toString();
    if (!this.routes.has(mintA)) {
      this.routes.set(mintA, new Map());
    }

    let routesFromA = this.routes.get(mintA)!;
    if (!routesFromA.has(mintB)) {
      routesFromA.set(mintB, []);
    }

    let routesFromAToB = routesFromA.get(mintB)!;
    routesFromAToB.push(edge);
  }

  addEdges(edges: Edge[]) {
    for (const edge of edges) {
      this.addEdge(edge);
    }
  }

  async indexWhirpools(): Promise<void> {
    let poolsPks = (
      await this.whirlpoolClient.getContext().program.account.whirlpool.all()
    ).map((p) => p.publicKey);
    // sucks to double fetch but I couldn't find another way to do this
    let pools = await this.whirlpoolClient.getPools(poolsPks);

    for (const pool of pools) {
      this.addEdges(WhirlpoolEdge.pairFromPool(pool, this.whirlpoolClient));
    }
  }

  async swap(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: BN,
    otherAmountThreshold: BN,
    mode: SwapMode,
    slippage: number
  ): Promise<SwapResult[]> {
    let results: SwapResult[] = [];

    const A = inputMint.toString();
    const fromA = this.routes.get(A);
    if (!fromA) return results;

    const Z = outputMint.toString();
    const AtoZ = fromA?.get(Z);

    // direct swaps A->Z
    if (AtoZ) {
      results = await Promise.all(
        AtoZ.map((eAZ) =>
          eAZ.swap(amount, otherAmountThreshold, mode, slippage)
        )
      );
    }

    for (const [B, AtoB] of fromA.entries()) {
      const fromB = this.routes.get(B);
      const BtoZ = fromB?.get(Z);

      if (!BtoZ) continue;

      if (mode === SwapMode.ExactIn) {
        // swap A->B->Z amt=IN oth=OUT
        for (const eAB of AtoB) {
          // TODO: slippage limit should apply for whole route not single hop
          const firstHop = await eAB.swap(amount, ZERO, mode, slippage);
          for (const eBZ of BtoZ) {
            const secondHop = await eBZ.swap(
              firstHop.minAmtOut,
              otherAmountThreshold,
              mode,
              slippage
            );
            results.push(mergeSwapResults(firstHop, secondHop));
          }
        }
      } else if (mode === SwapMode.ExactOut) {
        // swap A->B->Z amt=OUT oth=IN
        for (const eBZ of BtoZ) {
          const secondHop = await eBZ.swap(amount, U64_MAX, mode, slippage);
          for (const eAB of AtoB) {
            const firstHop = await eAB.swap(
              secondHop.maxAmtIn,
              otherAmountThreshold,
              mode,
              slippage
            );
            const merged = mergeSwapResults(firstHop, secondHop);
            results.push(merged);
          }
        }
      }

      // TODO: A->B->C->Z
    }
    return results;
  }
}

async function main() {
  // init anchor, mango & orca
  const anchorProvider = AnchorProvider.local(rpcUrl);
  const mangoClient = await MangoClient.connect(
    anchorProvider,
    cluster,
    MANGO_V4_ID[cluster],
    {
      idsSource: "get-program-accounts",
    }
  );
  const whirpoolClient = buildWhirlpoolClient(
    WhirlpoolContext.withProvider(anchorProvider, ORCA_WHIRLPOOL_PROGRAM_ID)
  );

  const router = new Router(mangoClient, whirpoolClient);
  await router.start();

  const app = express();
  app.use(promMetrics);
  app.use(cors());
  app.get("/swap", async (req, res) => {
    const wallet = new PublicKey(req.query.wallet as string);
    const inputMint = new PublicKey(req.query.inputMint as string);
    const outputMint = new PublicKey(req.query.outputMint as string);
    const mode = req.query.mode as SwapMode;
    const slippage = Number(req.query.slippage as string);
    const amount = new BN(req.query.amount as string);
    const otherAmountThreshold = req.query.otherAmountThreshold
      ? new BN(req.query.otherAmountThreshold as string)
      : mode == SwapMode.ExactIn
      ? ZERO
      : U64_MAX;

    if (mode !== SwapMode.ExactIn && mode !== SwapMode.ExactOut) {
      const error = { e: "mode needs to be one of ExactIn or ExactOut" };
      res.status(404).send(error);
      return;
    }

    const results = await router.swap(
      inputMint,
      outputMint,
      amount,
      otherAmountThreshold,
      mode,
      slippage
    );

    const filtered = results.filter((r) => r.ok);
    let ranked: SwapResult[] = [];
    if (mode === SwapMode.ExactIn) {
      ranked = filtered.sort((a, b) => b.minAmtOut.sub(a.minAmtOut).toNumber());
    } else if (mode === SwapMode.ExactOut) {
      ranked = filtered.sort((a, b) => a.maxAmtIn.sub(b.maxAmtIn).toNumber());
    }
    const topN = ranked.slice(0, Math.min(ranked.length, maxRoutes));

    const response = await Promise.all(
      topN.map(async (r) => {
        const instructions = await r.instructions(wallet);
        return {
          amount: amount.toString(),
          otherAmountThreshold: otherAmountThreshold.toString(),
          swapMode: mode,
          slippageBps: Math.round(slippage * 10000),
          inAmount: r.maxAmtIn.toString(),
          outAmount: r.minAmtOut.toString(),
          instructions: instructions.map((i) => ({
            keys: i.keys.map((k) => ({ ...k, pubkey: k.pubkey.toString() })),
            programId: i.programId.toString(),
            data: i.data.toString("base64"),
          })),
        };
      })
    );

    res.send(response);
  });
  app.listen(port);
  // TEST1: http://localhost:5000/swap?wallet=Bz9thGbRRfwq3EFtFtSKZYnnXio5LXDaRgJDh3NrMAGT&inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&mode=ExactIn&amount=100000000&otherAmountThreshold=7000000000&slippage=0.001
  // TEST2: http://localhost:5000/swap?wallet=Bz9thGbRRfwq3EFtFtSKZYnnXio5LXDaRgJDh3NrMAGT&inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&mode=ExactOut&amount=7000000000&otherAmountThreshold=100000000&slippage=0.001
}
main();
