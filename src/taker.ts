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
  Transaction,
} from "@solana/web3.js";

import { DepthResult, Router, SwapMode, SwapResult } from "./router";

const { CLUSTER, GROUP, MAX_ROUTES, MIN_TVL, PORT, RPC_URL, KEYPAIR } =
  process.env;

const cluster = (CLUSTER || "mainnet-beta") as Cluster;
const groupPk = new PublicKey(
  GROUP || "78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX"
);
const maxRoutes = parseInt(MAX_ROUTES || "1");
const minTvl = parseInt(MIN_TVL || "500");
const port = parseInt(PORT || "5000");
const rpcUrl = RPC_URL || clusterApiUrl(cluster);
const keyPair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(KEYPAIR!)));
const wallet = new Wallet(keyPair);

async function main() {
  // init anchor
  const connection = new Connection(rpcUrl, "confirmed");
  const anchorProvider = new AnchorProvider(connection, wallet, {});

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

  const inputMint = "6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU";
  const inputMintPk = new PublicKey(inputMint);
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const outputMintPk = new PublicKey(outputMint);
  const mode = SwapMode.ExactIn;
  const slippage = 0.0001;
  const amount = new BN(10000);
  const otherAmountThreshold = mode == SwapMode.ExactIn ? ZERO : U64_MAX;
  let referencePrice: number | undefined;
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
    return;
  }

  const results = await router.swap(
    inputMintPk,
    outputMintPk,
    amount,
    otherAmountThreshold,
    mode,
    slippage
  );

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
  const [best] = ranked.slice(0, Math.min(ranked.length, maxRoutes));
  const ins = await best.instructions(wallet.publicKey);
  let priceImpact: number | undefined = undefined;
  if (!!referencePrice) {
    const actualPrice =
      Number(best.maxAmtIn.toString()) / Number(best.minAmtOut.toString());
    priceImpact = actualPrice / referencePrice - 1;
  }

  const tx = new Transaction();
  const response = await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = response.blockhash;
  tx.add(...ins);
  tx.sign(keyPair);

  const sig = await connection.sendTransaction(tx, [keyPair], {
    skipPreflight: true,
  });
  console.log("send", sig);
  const confirmationResult = await connection.confirmTransaction(sig);
  console.log("confirmed", confirmationResult);
}

main();
