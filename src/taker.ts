import {
  MangoClient,
  MANGO_V4_ID,
  MANGO_V4_MAIN_GROUP,
  getAssociatedTokenAddress,
  USDC_MINT,
  ZERO_I80F48,
} from "@blockworks-foundation/mango-v4";
import { U64_MAX, ZERO } from "@orca-so/common-sdk";
import {
  AnchorProvider,
  Wallet,
  BN,
  BorshAccountsCoder,
  Program,
  Idl,
  web3,
  utils,
} from "@coral-xyz/anchor";
import {
  Connection,
  Cluster,
  clusterApiUrl,
  PublicKey,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  AccountMeta,
  TransactionInstruction,
} from "@solana/web3.js";
import ravenIdl from "./idl/raven.json";

import { DepthResult, Router, SwapMode, SwapResult } from "./router";

const {
  CLUSTER,
  GROUP,
  MAX_ROUTES,
  MIN_TVL,
  PORT,
  RPC_URL,
  RPC_BACKUP_URLS,
  KEYPAIR,
  MINT,
  PRIORITY_FEE,
  SIZE,
  SIZES,
  DISCORD_WEBHOOK_URL,
} = process.env;

import axios from "axios";
import { CU_LIMIT, RAVEN_PROGRAM_ADDRESS } from "./constants";
import { stat } from "fs";

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
const groupPk = new PublicKey(GROUP || MANGO_V4_MAIN_GROUP);
const maxRoutes = parseInt(MAX_ROUTES || "2");
const minTvl = parseInt(MIN_TVL || "500");
const rpcUrl = RPC_URL || clusterApiUrl(cluster);
const rpcBackupUrls = RPC_BACKUP_URLS ? RPC_BACKUP_URLS.split(',') : [];
const sizes = SIZES ? SIZES.split(',') : [SIZE!];
const keyPair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(KEYPAIR!)));
const wallet = new Wallet(keyPair);

async function main() {
  // init anchor
  const connection = new Connection(rpcUrl, "confirmed");
  const anchorProvider = new AnchorProvider(connection, wallet, {});

  // init mango
  const mangoClient = MangoClient.connect(
    anchorProvider as any,
    cluster,
    MANGO_V4_ID[cluster],
    {
      idsSource: "get-program-accounts",
      multipleConnections: rpcBackupUrls.map(u => new Connection(u, "confirmed")),
    }
  );
  const group = await mangoClient.getGroup(groupPk);
  await group.reloadAll(mangoClient);

  // Every 5m update the group in the background
  setInterval(async function () {
    await group.reloadAll(mangoClient);
  }, 300_000);

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
  let latestBlockhash: Readonly<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> = await connection.getLatestBlockhash("finalized");

  // Regularly update the latest blockhash in the background.
  setInterval(async function () {
    latestBlockhash = await connection.getLatestBlockhash("finalized");
  }, 10_000);

  const inputMint = MINT!;
  const inputMintPk = new PublicKey(inputMint);
  const outputMint = MINT!;
  const outputMintPk = new PublicKey(outputMint);
  const mode = SwapMode.ExactIn;
  const prioritizationFee = PRIORITY_FEE || 2;
  const slippage = 0.00001;

  while (true) {
    try {

      let referencePrice: number | undefined;
      let amounts: BN[] | undefined;
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
        amounts = sizes.map(s => new BN(parseFloat(s) * 10 ** inputBank.mintDecimals));
      }
      const results: SwapResult[][] = await Promise.all(amounts!.map(amount => 
        router.swap(inputMintPk, outputMintPk, amount, ZERO, mode, slippage)
      ));

      const profit = (r: SwapResult) => r.minAmtOut.sub(r.maxAmtIn);
      const filtered = results
        .flat()
        .filter((r) => r.ok && r.label.includes("rvn"));

      if (filtered.length == 0) {
        console.log(new Date(), "No raven routes found");
        await sleep(100);
        continue;
      }

      let ranked = filtered.sort((a, b) =>
        Number(profit(b).sub(profit(a)).toString()));

      const [best]: SwapResult[] = ranked.slice(
        0,
        Math.min(ranked.length, maxRoutes)
      );
      const instructions = await best.instructions(wallet.publicKey);
      let priceImpact: number | undefined = undefined;
      if (!!referencePrice) {
        const actualPrice =
          Number(best.maxAmtIn.toString()) / Number(best.minAmtOut.toString());
        priceImpact = actualPrice / referencePrice - 1;
      }

      console.log(
        new Date(),
        MINT,
        best.label,
        best.minAmtOut.toString(),
        profit(best).toString()
      );

      if (profit(best).gte(ZERO)) {
        /*
        // Use the arb protection function on raven.
        const program = new Program(
          ravenIdl as Idl,
          RAVEN_PROGRAM_ADDRESS,
          anchorProvider
        );
        const [checkpoint, _unusedBump] =  web3.PublicKey.findProgramAddressSync(
          [Buffer.from(utils.bytes.utf8.encode('checkpoint'))],
          program.programId,
        );
        const checkpointIx: TransactionInstruction = await program.methods.updateCheckpoint().accounts({
          payer: keyPair.publicKey,
          checkpoint: checkpoint,
        })
        .remainingAccounts([
          {
            pubkey: await getAssociatedTokenAddress(inputMintPk, keyPair.publicKey),
            isWritable: true,
            isSigner: false,
          } as AccountMeta,
          {
            pubkey: await getAssociatedTokenAddress(USDC_MINT, keyPair.publicKey),
            isWritable: true,
            isSigner: false,
          } as AccountMeta,
        ])
        .instruction();
        */

        const postSendTxCallback = ({txid}: any) => { 
          console.log(
            "Sending trade",
            "SwapMode:",
            mode,
            "label:",
            best.label,
            "maxIn:",
            best.maxAmtIn.toString(),
            "minOut:",
            best.minAmtOut.toString(),
            "intermediateAmounts",
            best.intermediateAmounts.map((val: BN) => {
              return val.toString();
            }),
            "txid",
            txid
          );
          alertDiscord(`🤞  arb ${MINT} ${best.label} ${txid}`);
        };

        try {
          const status = await mangoClient.sendAndConfirmTransactionForGroup(
            group,
            [...instructions, ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT })],
            { latestBlockhash, postSendTxCallback, prioritizationFee });
            alertDiscord(
              `💸  confirmed ${MINT} ${best.label} ${status.signature} ${status.confirmationStatus}`
            );
        } catch (e: any) {
          alertDiscord(
            `😭  failed ${MINT} ${best.label} ${e.txid} ${e.message}`
          );
          await sleep(60_000);
        }
      }
      await sleep(100);

    } catch (e: any) {
      console.error(e);
      alertDiscord(
        `☢️  error ${MINT} ${e.message} ${e.stack
        } ${e.toString()} ${JSON.stringify(e)}`
      );
      await sleep(60000);
    }
  }
}


function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
