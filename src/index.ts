import {
  MangoClient,
  MANGO_V4_ID,
  toNative,
  toUiDecimals,
} from "@blockworks-foundation/mango-v4";
import { Percentage } from "@orca-so/common-sdk";
import {
  buildWhirlpoolClient,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  swapQuoteByInputToken,
  Whirlpool,
  WhirlpoolClient,
  WhirlpoolContext,
} from "@orca-so/whirlpools-sdk";
import { AnchorProvider, BN } from "@project-serum/anchor";
import {
  Cluster,
  clusterApiUrl,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

const { CLUSTER, RPC_URL, GROUP_PK, MAX_SLIPPAGE_BPS } = process.env;

const cluster = (CLUSTER || "mainnet-beta") as Cluster;
const rpcUrl = RPC_URL || clusterApiUrl(cluster);
const groupPk = new PublicKey(
  GROUP_PK || "78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX"
);
const slippageLimit = Percentage.fromFraction(
  Number(MAX_SLIPPAGE_BPS || 250),
  10000
);

const MINUTES = 60 * 1000;

enum RouteProvider {
  Whirpool = "whirpool",
}

interface WhirpoolDetails {
  whirpool: PublicKey;
}

interface Route {
  referenceUsdAmount: number;
  slippage: number;
  inputMint: PublicKey;
  outputMint: PublicKey;
  provider: RouteProvider;
  details: WhirpoolDetails;
}

class Router {
  mangoClient: MangoClient;
  whirpoolClient: WhirlpoolClient;
  whirpoolRefresh?: ReturnType<typeof setInterval>;
  routes: Map<string, Route[]>;

  constructor(mangoClient: MangoClient, whirpoolClient: WhirlpoolClient) {
    this.mangoClient = mangoClient;
    this.whirpoolClient = whirpoolClient;
    this.routes = new Map();
  }

  async start(): Promise<void> {
    await this.refreshWhirpools();
    this.whirpoolRefresh = setInterval(this.refreshWhirpools, 2 * MINUTES);
  }

  pickRoute(
    mintA: string,
    mintB: string,
    usdAmount: number
  ): Route | undefined {
    const key = `FROM:${mintA} TO:${mintB}`;
    const routes = this.routes.get(key)!;

    return routes
      .filter((r) => r.referenceUsdAmount >= usdAmount)
      .sort((a, b) => a.slippage - b.slippage)
      .find((_) => true);
  }

  async refreshWhirpools(): Promise<void> {
    const group = await this.mangoClient.getGroup(groupPk);

    let allMintPks = Array.from(group.banksMapByMint.keys()).map(
      (p) => new PublicKey(p)
    );

    let poolsPks = (
      await this.whirpoolClient.getContext().program.account.whirlpool.all()
    ).map((p) => p.publicKey);
    // sucks to double fetch but I couldn't find another way to do this
    let pools = await this.whirpoolClient.getPools(poolsPks);

    for (const mintA of allMintPks) {
      for (const mintB of allMintPks) {
        // skip loops
        if (mintA.equals(mintB)) continue;

        // consider backwards & forward routing
        const relevantPools = pools.filter(
          (p) =>
            (p.getTokenAInfo().mint.equals(mintA) &&
              p.getTokenBInfo().mint.equals(mintB)) ||
            (p.getTokenAInfo().mint.equals(mintB) &&
              p.getTokenBInfo().mint.equals(mintA))
        );

        const key = `FROM:${mintA.toString()} TO:${mintB.toString()}`;
        console.log("SWAP", key, relevantPools.length, "ROUTES FOUND");

        const bankA = group.getFirstBankByMint(mintA);
        const bankB = group.getFirstBankByMint(mintB);

        let routesForKey: Route[] = [];
        for (let referenceUsdAmount of [100, 300, 1000, 3000, 10000, 30000]) {
          const referenceBaseAmount = referenceUsdAmount / bankA.uiPrice;
          const referenceQuoteAmount = referenceUsdAmount / bankB.uiPrice;

          for (let pool of relevantPools) {
            try {
              let quote = await swapQuoteByInputToken(
                pool,
                mintA,
                toNative(referenceBaseAmount, bankA.mintDecimals),
                slippageLimit,
                ORCA_WHIRLPOOL_PROGRAM_ID,
                this.whirpoolClient.getFetcher(),
                false
              );

              const inAmount = toUiDecimals(
                quote.estimatedAmountIn,
                bankA.mintDecimals
              );
              const outAmount = toUiDecimals(
                quote.estimatedAmountOut,
                bankB.mintDecimals
              );
              const slippage = 1 - outAmount / referenceQuoteAmount;

              console.log(
                "IN:",
                inAmount,
                "OUT:",
                outAmount,
                "PRICE:",
                inAmount / outAmount,
                "SLIPPAGE:",
                slippage,
                "POOL",
                pool.getAddress().toString()
              );

              routesForKey.push({
                referenceUsdAmount,
                slippage,
                inputMint: mintA,
                outputMint: mintB,
                provider: RouteProvider.Whirpool,
                details: { whirpool: pool.getAddress() },
              });
            } catch (e) {
              // console.log("error", e);
            }
          }
        }

        this.routes.set(key, routesForKey);
      }
    }
  }
}

async function main() {
  // init anchor, mango & orca
  const provider = AnchorProvider.local(rpcUrl);
  const mangoClient = await MangoClient.connect(
    provider,
    cluster,
    MANGO_V4_ID[cluster],
    {
      idsSource: "get-program-accounts",
    }
  );
  const ctx = WhirlpoolContext.withProvider(
    provider,
    ORCA_WHIRLPOOL_PROGRAM_ID
  );
  const whirpoolClient = buildWhirlpoolClient(ctx);

  const router = new Router(mangoClient, whirpoolClient);
  await router.refreshWhirpools();

  console.log(
    "pick",
    router.pickRoute(
      "So11111111111111111111111111111111111111112",
      "MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac",
      100
    )
  );
}
main();
