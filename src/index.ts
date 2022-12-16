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
  WhirlpoolContext,
} from "@orca-so/whirlpools-sdk";
import { AnchorProvider, BN } from "@project-serum/anchor";
import { Cluster, clusterApiUrl, PublicKey } from "@solana/web3.js";

const { CLUSTER, RPC_URL, GROUP_PK } = process.env;

const cluster = (CLUSTER || "mainnet-beta") as Cluster;
const rpcUrl = RPC_URL || clusterApiUrl(cluster);
const groupPk = new PublicKey(
  GROUP_PK || "78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX"
);

async function main() {
  // init anchor
  const provider = AnchorProvider.local(rpcUrl);

  // init mango
  const mangoClient = await MangoClient.connect(
    provider,
    cluster,
    MANGO_V4_ID[cluster],
    {
      idsSource: "get-program-accounts",
    }
  );
  const group = await mangoClient.getGroup(groupPk);

  // init orca
  const ctx = WhirlpoolContext.withProvider(
    provider,
    ORCA_WHIRLPOOL_PROGRAM_ID
  );
  let orcaClient = buildWhirlpoolClient(ctx);
  let _pools = await ctx.program.account.whirlpool.all();
  let pools = await orcaClient.getPools(_pools.map((p) => p.publicKey));

  let allMintPks = Array.from(group.banksMapByMint.keys()).map(
    (p) => new PublicKey(p)
  );
  // for every mint, find all direct routes to each other mint
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
      console.log(
        "SWAP",
        mintA.toString(),
        "TO",
        mintB.toString(),
        relevantPools.length,
        "ROUTES FOUND"
      );

      const bankA = group.getFirstBankByMint(mintA);
      const bankB = group.getFirstBankByMint(mintB);

      // calculate reference amount ($100) & reference price

      for (let referenceUsdAmount of [100, 1000, 10000]) {
        const referenceBaseAmount = referenceUsdAmount / bankA.uiPrice;
        const referenceQuoteAmount = referenceUsdAmount / bankB.uiPrice;
        const slippageLimit = Percentage.fromFraction(250, 10000); // 250bps

        for (let pool of relevantPools) {
          try {
            let quote = await swapQuoteByInputToken(
              pool,
              mintA,
              toNative(referenceBaseAmount, bankA.mintDecimals),
              slippageLimit,
              ORCA_WHIRLPOOL_PROGRAM_ID,
              ctx.fetcher,
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
          } catch (e) {
            // console.log("error", e);
          }
        }
      }
    }
  }
}
main();
