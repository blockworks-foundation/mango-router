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
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";

import { DepthResult, Router, SwapMode, SwapResult } from "./router";

const {
  CLUSTER,
  GROUP,
  MAX_ROUTES,
  MIN_TVL,
  PORT,
  RPC_URL,
  KEYPAIR,
  MINT,
  SIZE,
  DISCORD_WEBHOOK_URL,
} = process.env;

import axios from "axios";
import { json } from "stream/consumers";

export function alertDiscord(message: string) {
  if (DISCORD_WEBHOOK_URL) {
    axios
      .post(DISCORD_WEBHOOK_URL, {
        content: message,
      })
      .then((response) => {
        console.log("Message sent to Alerts:", message, response.data);
      })
      .catch((error) => {
        console.error("Error sending message to Discord:", error);
      });
  } else {
    console.log(message);
  }
}

const cluster = (CLUSTER || "mainnet-beta") as Cluster;
const groupPk = new PublicKey(
  GROUP || "78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX"
);
const maxRoutes = parseInt(MAX_ROUTES || "2");
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
    anchorProvider as any,
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
          coder as any,
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

  while (true) {
    try {
      const inputMint = MINT!;
      const inputMintPk = new PublicKey(inputMint);
      const outputMint = MINT!;
      const outputMintPk = new PublicKey(outputMint);
      const mode = SwapMode.ExactIn;
      const slippage = 0.00001;
      // const amount = new BN(10000);
      // const amount = new BN(1000000 * 20);
      let referencePrice: number | undefined;
      let amount: BN | undefined;
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
        amount = new BN(parseFloat(SIZE!) * 10 ** inputBank.mintDecimals);
      }

      const otherAmountThreshold = mode == SwapMode.ExactIn ? ZERO : U64_MAX;

      const results = await router.swap(
        inputMintPk,
        outputMintPk,
        amount!,
        otherAmountThreshold,
        mode,
        slippage
      );

      const filtered = results.filter((r) => r.ok && r.label.includes("rvn"));
      if (filtered.length == 0) continue;

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

      // console.log(
      //   "ranked",
      //   ranked.map((r) => [r.label, r.minAmtOut.toString()])
      // );

      const [best] = ranked.slice(0, Math.min(ranked.length, maxRoutes));
      const instructions = await best.instructions(wallet.publicKey);
      let priceImpact: number | undefined = undefined;
      if (!!referencePrice) {
        const actualPrice =
          Number(best.maxAmtIn.toString()) / Number(best.minAmtOut.toString());
        priceImpact = actualPrice / referencePrice - 1;
      }

      const profitable = best.minAmtOut.gte(best.maxAmtIn);

      console.log(
        new Date(),
        MINT,
        profitable,
        best.label,
        best.minAmtOut.toString()
      );

      if (profitable) {
        const response = await connection.getLatestBlockhash("finalized");

        const messageV0 = new TransactionMessage({
          payerKey: keyPair.publicKey,
          recentBlockhash: response.blockhash,
          instructions: [
            ...instructions,
            ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          ],
        }).compileToV0Message(group.addressLookupTablesList);

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([keyPair]);

        const sig = await connection.sendTransaction(transaction, {
          skipPreflight: true,
        });

        alertDiscord(`🤞  arb ${MINT} ${best.label} ${sig}`);
        const confirmationResult = await connection.confirmTransaction({
          blockhash: response.blockhash,
          lastValidBlockHeight: response.lastValidBlockHeight,
          signature: sig,
        });
        if (confirmationResult.value.err) {
          alertDiscord(
            `😭  failed ${MINT} ${best.label} ${sig} ${JSON.stringify(
              confirmationResult.value.err
            )}`
          );
          await sleep(60000);
        } else {
          alertDiscord(
            `💸  confirmed ${MINT} ${best.label} ${sig} ${confirmationResult}`
          );
        }
      }
    } catch (e: any) {
      console.error(e);
      alertDiscord(
        `☢️  error ${MINT} ${e.message} ${
          e.stack
        } ${e.toString()} ${JSON.stringify(e)}`
      );
      await sleep(60000);
    }

    await sleep(100);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
