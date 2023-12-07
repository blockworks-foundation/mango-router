import {
  BookSide,
  BookSideType,
  Group,
  HealthType,
  I80F48,
  MANGO_V4_ID,
  MANGO_V4_MAIN_GROUP,
  MangoAccount,
  MangoClient,
  USDC_MINT,
  ZERO_I80F48,
  getAssociatedTokenAddress,
  toUiDecimals,
} from "@blockworks-foundation/mango-v4";
import { Percentage, U64_MAX, ZERO } from "@orca-so/common-sdk";
import {
  ORCA_WHIRLPOOL_PROGRAM_ID,
  SwapQuote,
  SwapUtils,
  Whirlpool,
  WhirlpoolClient,
  WhirlpoolContext,
  WhirlpoolIx,
  buildWhirlpoolClient,
  swapQuoteByInputToken,
  swapQuoteByOutputToken,
} from "@orca-so/whirlpools-sdk";
import {
  AnchorProvider,
  BorshAccountsCoder,
  Idl,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  Clmm,
  ClmmPoolInfo,
  ApiClmmPoolsItem,
  MAINNET_PROGRAM_ID,
  PoolInfoLayout,
  ReturnTypeComputeAmountOut,
  ReturnTypeComputeAmountOutBaseOut,
  ReturnTypeFetchMultipleMintInfos,
  ReturnTypeFetchMultiplePoolInfos,
  ReturnTypeFetchMultiplePoolTickArrays,
  SqrtPriceMath,
  TOKEN_PROGRAM_ID,
  fetchMultipleMintInfos,
} from "@raydium-io/raydium-sdk";
import {
  AccountMeta,
  Connection,
  EpochInfo,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import BN from "bn.js";
import bs58 from "bs58";
import ravenIdl from "./idl/raven.json";
import {
  RAVEN_MANGO_ACCOUNT_OWNER,
  RAVEN_PROGRAM_ADDRESS,
  RAVEN_MANGO_ACCOUNT,
  RAVEN_BASE_FEE,
  RAVEN_POSITION_INCREASE_FEE,
} from "./constants";
import { assert } from "console";

export interface DepthResult {
  label: string;
  maxAmtIn: BN;
  minAmtOut: BN;
  ok: boolean;
}

export enum SwapMode {
  ExactIn = "ExactIn",
  ExactOut = "ExactOut",
}

export interface SwapResult {
  instructions: (wallet: PublicKey) => Promise<TransactionInstruction[]>;
  label: string;
  marketInfos: {
    label: string;
    fee: { amount: BN; mint: PublicKey; rate: number };
  }[];
  maxAmtIn: BN;
  minAmtOut: BN;
  mints: PublicKey[];
  ok: boolean;

  // The maxAmtIn and minAmtOut that are merged away.
  intermediateAmounts: BN[];
}

function BN2I80(bn: BN) {
  assert(bn.bitLength() < 63);
  return I80F48.fromI64(bn.toTwos(64));
}

function mergeSwapResults(...hops: SwapResult[]) {
  const firstHop = hops[0];
  const lastHop = hops[hops.length - 1];
  return {
    instructions: async (wallet: PublicKey) =>
      await (await Promise.all(hops.map((h) => h.instructions(wallet)))).flat(),
    label: hops.map((h) => h.label).join("_"),
    marketInfos: [...firstHop.marketInfos, ...lastHop.marketInfos],
    maxAmtIn: firstHop.maxAmtIn,
    minAmtOut: lastHop.minAmtOut,
    mints: [...firstHop.mints, ...lastHop.mints],
    ok: hops.reduce((p, c) => p && c.ok, true),
    intermediateAmounts: [...firstHop.intermediateAmounts, firstHop.minAmtOut, lastHop.maxAmtIn, ...lastHop.intermediateAmounts],
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
    const label = "orca:" + pool.getAddress().toString();
    const fwd = new WhirlpoolEdge(
      label,
      pool.getTokenAInfo().mint,
      pool.getTokenBInfo().mint,
      pool.getAddress(),
      client
    );
    const bwd = new WhirlpoolEdge(
      label,
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
          false
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
          false
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
        let swapIx = WhirlpoolIx.swapIx(
          this.client.getContext().program,
          SwapUtils.getSwapParamsFromQuote(
            quote!,
            this.client.getContext(),
            pool,
            tokenIn,
            tokenOut,
            wallet
          )
        );
        return swapIx.instructions;
      };
      return {
        ok,
        instructions,
        label: this.poolPk.toString(),
        marketInfos: [
          {
            label: "Whirlpool",
            fee: {
              amount: quote.estimatedFeeAmount,
              mint: this.inputMint,
              rate: pool.getData().feeRate * 1e-6,
            },
          },
        ],
        maxAmtIn: quote.estimatedAmountIn,
        minAmtOut: quote.estimatedAmountOut,
        mints: [this.inputMint, this.outputMint],
        intermediateAmounts: [],
      };
    } catch (e) {
      // console.error(
      //   "whirpool error swap",
      //   this.poolPk.toString().slice(0, 6),
      //   this.inputMint.toString().slice(0, 6),
      //   this.outputMint.toString().slice(0, 6),
      //   amount.toNumber(),
      //   otherAmountThreshold.toNumber()
      // );
      return {
        ok: false,
        label: "",
        marketInfos: [],
        maxAmtIn: amount,
        minAmtOut: otherAmountThreshold,
        mints: [this.inputMint, this.outputMint],
        instructions: async () => [],
        intermediateAmounts: [],
      };
    }
  }
}

class RaydiumEdge implements Edge {
  constructor(
    public label: string,
    public inputMint: PublicKey,
    public outputMint: PublicKey,
    public poolPk: PublicKey,
    public raydiumCache: RaydiumCache
  ) {}

  static pairFromPool(
    poolInfo: ClmmPoolInfo,
    raydiumCache: RaydiumCache
  ): Edge[] {
    const label = "raydium: " + poolInfo.id.toString();
    const fwd = new RaydiumEdge(
      label,
      new PublicKey(poolInfo.mintA.mint),
      new PublicKey(poolInfo.mintB.mint),
      new PublicKey(poolInfo.id),
      raydiumCache
    );
    const bwd = new RaydiumEdge(
      label,
      new PublicKey(poolInfo.mintB.mint),
      new PublicKey(poolInfo.mintA.mint),
      new PublicKey(poolInfo.id),
      raydiumCache
    );
    return [fwd, bwd];
  }
  
  // The otherAmountThreshold actually used on the ix and included in the
  // SwapResult is from the expected swap factoring in the slippage. The
  // threshold used here in the input is just for checking whether the
  // SwapResult is ok.
  async swap(
    amount: BN,
    otherAmountThreshold: BN,
    mode: SwapMode,
    slippage: number
  ): Promise<SwapResult> {
    try {
      let ok: boolean = false;
      let fee: BN;
      let maxAmtIn: BN;
      let minAmtOut: BN;
      let feeRate: number;
      let remainingAccounts: PublicKey[];

      const poolInfo =
        this.raydiumCache.poolInfos[this.poolPk.toBase58()].state;
      if (mode === SwapMode.ExactIn) {
        let amountOut: ReturnTypeComputeAmountOut = Clmm.computeAmountOut({
          poolInfo,
          tickArrayCache:
            this.raydiumCache.tickArrayByPoolIds[this.poolPk.toBase58()],
          baseMint: this.inputMint,
          token2022Infos: this.raydiumCache.mintInfos,
          epochInfo: this.raydiumCache.epochInfo,
          amountIn: amount,
          slippage: slippage,
        });
        ok = otherAmountThreshold.lte(amountOut.amountOut.amount);
        fee = amountOut.fee;
        maxAmtIn = amountOut.realAmountIn.amount;
        feeRate = fee.toNumber() / maxAmtIn.toNumber();
        minAmtOut = new BN(amountOut.minAmountOut.amount.toNumber() * (1 - slippage));
        remainingAccounts = amountOut.remainingAccounts;
      } else {
        let amountIn: ReturnTypeComputeAmountOutBaseOut = Clmm.computeAmountIn({
          poolInfo,
          tickArrayCache:
            this.raydiumCache.tickArrayByPoolIds[this.poolPk.toBase58()],
          baseMint: this.outputMint,
          token2022Infos: this.raydiumCache.mintInfos,
          epochInfo: this.raydiumCache.epochInfo,
          amountOut: amount,
          slippage: slippage,
        });
        ok = otherAmountThreshold.gte(amountIn.amountIn.amount);
        fee = amountIn.fee;
        maxAmtIn = new BN(amountIn.maxAmountIn.amount.toNumber() * (1 + slippage));
        feeRate = fee.toNumber() / maxAmtIn.toNumber();
        minAmtOut = amountIn.realAmountOut.amount;
        remainingAccounts = amountIn.remainingAccounts;
      }

      let instructions = async (wallet: PublicKey) => {
        const tokenAccountA = await getAssociatedTokenAddress(
          poolInfo.mintA.mint,
          wallet
        );
        const tokenAccountB = await getAssociatedTokenAddress(
          poolInfo.mintB.mint,
          wallet
        );
        const swapIx =
          mode === SwapMode.ExactIn
            ? Clmm.makeSwapBaseInInstructions({
                poolInfo:
                  this.raydiumCache.poolInfos[this.poolPk.toBase58()].state,
                ownerInfo: {
                  wallet,
                  tokenAccountA,
                  tokenAccountB,
                },
                inputMint: this.inputMint,
                amountIn: amount,
                amountOutMin: minAmtOut,
                sqrtPriceLimitX64: new BN(0),
                remainingAccounts,
              })
            : Clmm.makeSwapBaseOutInstructions({
                poolInfo:
                  this.raydiumCache.poolInfos[this.poolPk.toBase58()].state,
                ownerInfo: {
                  wallet,
                  tokenAccountA,
                  tokenAccountB,
                },
                outputMint: this.outputMint,
                amountOut: amount,
                amountInMax: maxAmtIn,
                sqrtPriceLimitX64: new BN(0),
                remainingAccounts,
              });
        return swapIx.innerTransaction.instructions;
      };

      return {
        ok: ok,
        instructions,
        label: 'raydium:' + this.poolPk.toString(),
        marketInfos: [
          {
            label: "Raydium",
            fee: {
              amount: fee,
              mint: this.inputMint,
              rate: feeRate,
            },
          },
        ],
        maxAmtIn: mode == SwapMode.ExactIn ? amount : maxAmtIn,
        minAmtOut: mode == SwapMode.ExactIn ? minAmtOut : amount,
        mints: [this.inputMint, this.outputMint],
        intermediateAmounts: [],
      };
    } catch (err) {
      // console.error(
      //   "raydium error swap",
      //   this.poolPk.toString().slice(0, 6),
      //   this.inputMint.toString().slice(0, 6),
      //   this.outputMint.toString().slice(0, 6),
      //   amount.toNumber(),
      //   otherAmountThreshold.toNumber()
      // );
      return {
        ok: false,
        label: "",
        marketInfos: [],
        maxAmtIn: amount,
        minAmtOut: otherAmountThreshold,
        mints: [this.inputMint, this.outputMint],
        instructions: async () => [],
        intermediateAmounts: [],
      };
    }
  }
}

export class RaydiumCache {
  constructor(
    public epochInfo: EpochInfo,
    public mintInfos: ReturnTypeFetchMultipleMintInfos,
    public poolInfos: ReturnTypeFetchMultiplePoolInfos,
    public tickArrayByPoolIds: ReturnTypeFetchMultiplePoolTickArrays
  ) {}
}

export class Router {
  minTvl: number;
  routes: Map<string, Map<string, Edge[]>>;

  whirlpoolClient: WhirlpoolClient;
  whirlpoolSub?: number;

  connection: Connection;

  raydiumCache?: RaydiumCache;
  raydiumPoolInfoSub?: number;
  subscriptions: number[];

  constructor(anchorProvider: AnchorProvider, minTvl: number) {
    this.minTvl = minTvl;
    this.routes = new Map();
    this.whirlpoolClient = buildWhirlpoolClient(
      WhirlpoolContext.withProvider(anchorProvider, ORCA_WHIRLPOOL_PROGRAM_ID)
    );
    this.connection = anchorProvider.connection;
    this.subscriptions = [];
  }

  public async start(): Promise<void> {
    this.routes = new Map();
    this.subscriptions = [];

    await this.indexRaven();

    await this.indexWhirpools();

    // setup a websocket connection to refresh all whirpool program accounts
    const idl = this.whirlpoolClient.getContext().program.idl;
    const whirlpoolCoder = new BorshAccountsCoder(idl as Idl);
    const whirlpoolInfoDiscriminator = Buffer.from(
      sha256("account:Whirlpool")
    ).slice(0, 8);
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
        "processed",
        [
          {
            memcmp: {
              offset: 0,
              bytes: bs58.encode(whirlpoolInfoDiscriminator),
            },
          },
        ]
      );

    await this.indexRaydium();

    // Only the poolInfo is worth updating. tickArray and mintInfos should not change.
    const poolInfoDiscriminator = Buffer.from(
      sha256("account:PoolState")
    ).slice(0, 8);
    this.raydiumPoolInfoSub = this.connection.onProgramAccountChange(
      MAINNET_PROGRAM_ID.CLMM,
      (p) => {
        const key = p.accountId.toBase58();
        const accountData = p.accountInfo.data;
        const layoutAccountInfo = PoolInfoLayout.decode(accountData);

        // Cache only holds those filtered with enough TVL.
        if (!(key in this.raydiumCache!.poolInfos)) {
          return;
        }

        // Most of these fields dont matter, but update anyways.
        this.raydiumCache!.poolInfos[key] = {
          state: {
            ...this.raydiumCache!.poolInfos[key].state,
            observationId: layoutAccountInfo.observationId,
            creator: layoutAccountInfo.creator,
            version: 6,
            tickSpacing: layoutAccountInfo.tickSpacing,
            liquidity: layoutAccountInfo.liquidity,
            sqrtPriceX64: layoutAccountInfo.sqrtPriceX64,
            currentPrice: SqrtPriceMath.sqrtPriceX64ToPrice(
              layoutAccountInfo.sqrtPriceX64,
              layoutAccountInfo.mintDecimalsA,
              layoutAccountInfo.mintDecimalsB
            ),
            tickCurrent: layoutAccountInfo.tickCurrent,
            observationIndex: layoutAccountInfo.observationIndex,
            observationUpdateDuration:
              layoutAccountInfo.observationUpdateDuration,
            feeGrowthGlobalX64A: layoutAccountInfo.feeGrowthGlobalX64A,
            feeGrowthGlobalX64B: layoutAccountInfo.feeGrowthGlobalX64B,
            protocolFeesTokenA: layoutAccountInfo.protocolFeesTokenA,
            protocolFeesTokenB: layoutAccountInfo.protocolFeesTokenB,
            swapInAmountTokenA: layoutAccountInfo.swapInAmountTokenA,
            swapOutAmountTokenB: layoutAccountInfo.swapOutAmountTokenB,
            swapInAmountTokenB: layoutAccountInfo.swapInAmountTokenB,
            swapOutAmountTokenA: layoutAccountInfo.swapOutAmountTokenA,
            tickArrayBitmap: layoutAccountInfo.tickArrayBitmap,
            startTime: layoutAccountInfo.startTime.toNumber(),
          },
        };
      },
      "processed",
      [{ memcmp: { offset: 0, bytes: bs58.encode(poolInfoDiscriminator) } }]
    );
  }

  public async stop(): Promise<void> {
    if (this.whirlpoolSub) {
      await this.whirlpoolClient
        .getContext()
        .connection.removeProgramAccountChangeListener(this.whirlpoolSub);
    }
    if (this.raydiumPoolInfoSub) {
      await this.connection.removeProgramAccountChangeListener(
        this.raydiumPoolInfoSub
      );
    }
    for (const sub of this.subscriptions) {
      await this.connection.removeAccountChangeListener(sub);
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

  async addRavenEdges(
    raven: Program,
    pda: PublicKey,
    client: MangoClient,
    group: Group,
    mangoAccount: MangoAccount,
    perpMarketLabel: string,
    baseMintLabel: string,
    quoteMintLabel: string,
    baseMint: PublicKey,
    quoteMint: PublicKey
  ): Promise<void> {
    const market = group.getPerpMarketByName(perpMarketLabel);
    const booksides = await Promise.all([
      market.loadBids(client, true),
      market.loadAsks(client, true),
    ]);

    const baseBank = group.getFirstBankByMint(baseMint);
    const quoteBank = group.getFirstBankByMint(quoteMint);

    // setup subscription

    this.subscriptions.push(
      this.connection.onAccountChange(
        market.bids,
        (acc) => {
          const side = client.program.account.bookSide.coder.accounts.decode(
            "bookSide",
            acc.data
          );
          booksides[0] = BookSide.from(client, market, BookSideType.bids, side);
        },
        "processed"
      )
    );
    this.subscriptions.push(
      this.connection.onAccountChange(
        market.asks,
        (acc) => {
          const side = client.program.account.bookSide.coder.accounts.decode(
            "bookSide",
            acc.data
          );
          booksides[1] = BookSide.from(client, market, BookSideType.asks, side);
        },
        "processed"
      )
    );

    await mangoAccount.reload(client);
    let ravenPositions = {
      perpBase: mangoAccount.perpPositionExistsForMarket(market)
        ? mangoAccount
            .getPerpPosition(market.perpMarketIndex)!
            .getBasePosition(market)
        : new BN(0),
      tokenBase: mangoAccount.getTokenBalance(baseBank),
      tokenQuote: mangoAccount.getTokenBalance(quoteBank),
      healthRatio: mangoAccount.getHealthRatio(group, HealthType.init),
    };
    this.subscriptions.push(
      this.connection.onAccountChange(
        RAVEN_MANGO_ACCOUNT,
        (acc) => {
          const mangoAccount =
            client.program.account.mangoAccount.coder.accounts.decode(
              "mangoAccount",
              acc.data
            );
          ravenPositions = {
            perpBase: mangoAccount.perpPositionExistsForMarket(market)
              ? mangoAccount
                  .getPerpPosition(market.perpMarketIndex)!
                  .getBasePosition(market)
              : new BN(0),
            tokenBase: mangoAccount.getTokenBalance(baseBank),
            tokenQuote: mangoAccount.getTokenBalance(quoteBank),
            healthRatio: mangoAccount.getHealthRatio(group, HealthType.init),
          };
        },
        "processed"
      )
    );

    // create edges
    const edges = [
      {
        label: `rvn-${baseMintLabel}-${quoteMintLabel}`,
        inputMint: baseMint,
        outputMint: quoteMint,
        swap: async (
          amount: BN,
          otherAmountThreshold: BN,
          mode: SwapMode,
          slippage: number
        ): Promise<SwapResult> => {
          if (mode === SwapMode.ExactIn) {
            let amountInLots = amount
              .divn(Math.pow(10, baseBank.mintDecimals - market.baseDecimals))
              .div(market.baseLotSize);

            const sumBaseLots = new BN(0);
            const sumQuoteLots = new BN(0);
            for (const order of booksides[0].items()) {
              sumBaseLots.iadd(order.sizeLots);
              sumQuoteLots.iadd(order.sizeLots.mul(order.priceLots));

              const diff = sumBaseLots.sub(amountInLots);
              if (!diff.isNeg()) {
                sumQuoteLots.isub(diff.mul(order.priceLots));
                break;
              }
              if (diff.isZero()) break;
            }

            const nativeBase = amountInLots
              .mul(market.baseLotSize)
              .muln(Math.pow(10, baseBank.mintDecimals - market.baseDecimals));
            const nativeQuoteFromPerpTrade = BN2I80(
              sumQuoteLots.mul(market.quoteLotSize)
            );
            const nativeQuoteWithdrawn = nativeQuoteFromPerpTrade.sub(
              ravenPositions.tokenQuote.max(ZERO_I80F48())
            );
            const zero = ZERO_I80F48();
            const feeRate = RAVEN_BASE_FEE.add(market.takerFee)
              .add(
                nativeQuoteWithdrawn.isPos()
                  ? nativeQuoteWithdrawn
                      .div(nativeQuoteFromPerpTrade)
                      .mul(quoteBank.loanOriginationFeeRate)
                  : zero
              )
              .add(
                ravenPositions.perpBase.isNeg()
                  ? RAVEN_POSITION_INCREASE_FEE
                  : zero
              );

            const nativeQuote = new BN(
              nativeQuoteFromPerpTrade
                .mul(I80F48.fromNumber(1).sub(feeRate))
                .toBig()
                .round(undefined, 0)
                .toNumber()
            );
            const feeQuote = sumQuoteLots
              .mul(market.quoteLotSize)
              .sub(nativeQuote);

            // TODO: Add the OI limit check also
            // https://github.com/mschneider/raven/blob/main/programs/raven/src/instructions/trade_exact_in.rs#L415
            const passesHealthRatioCheck =
              ravenPositions.healthRatio.toNumber() > 100 ||
              !ravenPositions.perpBase.isNeg();

            if (nativeQuote.gte(otherAmountThreshold) && passesHealthRatioCheck) {
              return {
                label: `rvn-${baseMintLabel}-${quoteMintLabel}`,
                marketInfos: [
                  {
                    label: "raven",
                    fee: {
                      amount: feeQuote,
                      mint: quoteMint,
                      rate: feeRate.toNumber(),
                    },
                  },
                ],
                maxAmtIn: nativeBase,
                minAmtOut: nativeQuote.muln(1e7 * (1 - slippage)).divn(1e7),
                mints: [],
                ok: true,
                instructions: async (wallet: PublicKey) => {
                  const baseToken = await getAssociatedTokenAddress(
                    baseMint,
                    wallet
                  );
                  const quoteToken = await getAssociatedTokenAddress(
                    quoteMint,
                    wallet
                  );

                  // @ts-ignore
                  const healthRemainingAccounts = client[
                    "buildHealthRemainingAccounts"
                  ](group, [mangoAccount]);

                  const tradeIx = await raven.methods
                    .tradeExactIn(nativeBase, true, nativeQuote)
                    .accounts({
                      trader: wallet,
                      owner: pda,
                      account: mangoAccount.publicKey,
                      perpMarket: market.publicKey,
                      perpOracle: market.oracle,
                      eventQueue: market.eventQueue,
                      bids: market.bids,
                      asks: market.asks,
                      baseBank: baseBank.publicKey,
                      quoteBank: quoteBank.publicKey,
                      baseVault: baseBank.vault,
                      quoteVault: quoteBank.vault,
                      baseOracle: baseBank.oracle,
                      quoteOracle: quoteBank.oracle,
                      group: group.publicKey,
                      baseToken,
                      quoteToken,
                      mangoProgram: MANGO_V4_ID["mainnet-beta"],
                      tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .remainingAccounts(
                      healthRemainingAccounts.map(
                        (pk: any) =>
                          ({
                            pubkey: pk,
                            isWritable: false,
                            isSigner: false,
                          } as AccountMeta)
                      )
                    )
                    .instruction();

                  return [tradeIx];
                },
                intermediateAmounts: [],
              };
            }
          } else {
            // SwapMode.ExactOut
            // Not yet implemented in the program side.
          }

          // error case no swap result has been generated
          // console.error(`error raven swap ${baseMintLabel}-${quoteMintLabel}`);
          return {
            ok: false,
            label: "",
            marketInfos: [],
            maxAmtIn: amount,
            minAmtOut: otherAmountThreshold,
            mints: [],
            instructions: async () => [],
            intermediateAmounts: [],
          };
        },
      },
      {
        label: `rvn-${quoteMintLabel}-${baseMintLabel}`,
        inputMint: quoteMint,
        outputMint: baseMint,
        swap: async (
          amount: BN,
          otherAmountThreshold: BN,
          mode: SwapMode,
          slippage: number
        ): Promise<SwapResult> => {
          if (mode === SwapMode.ExactIn) {
            // Calculate upper bound estimation of the traded size
            const sumMaxBase = new BN(0);
            {
              const amountInLots = amount.div(market.quoteLotSize);
              const sumQuote = new BN(0);
              for (const order of booksides[1].items()) {
                sumMaxBase.iadd(order.sizeLots);
                sumQuote.iadd(order.sizeLots.mul(order.priceLots));

                const diff = sumQuote.sub(amountInLots);
                if (!diff.isNeg()) {
                  sumMaxBase.isub(
                    diff.add(order.priceLots.subn(1)).div(order.priceLots)
                  );
                  break;
                }
                if (diff.isZero()) break;
              }
            }
            const nativeMaxBase = sumMaxBase.mul(market.baseLotSize);
            const maxBaseWithdrawn = BN2I80(nativeMaxBase).sub(
              ravenPositions.tokenBase.max(ZERO_I80F48())
            );

            const zero = ZERO_I80F48();
            const feeRate = RAVEN_BASE_FEE.add(market.takerFee)
              .add(
                maxBaseWithdrawn.isNeg()
                  ? zero
                  : maxBaseWithdrawn.div(BN2I80(nativeMaxBase))
              )
              .add(
                ravenPositions.perpBase.isNeg()
                  ? zero
                  : RAVEN_POSITION_INCREASE_FEE
              );

            const nativeQuote = new BN(
              BN2I80(amount)
                .mul(I80F48.fromNumber(1).sub(feeRate))
                .toBig()
                .round(undefined, 0)
                .toNumber()
            );

            let amountInLots = nativeQuote.div(market.quoteLotSize);

            const feeQuote = amount.sub(amountInLots.mul(market.quoteLotSize));

            const sumBase = new BN(0);
            const sumQuote = new BN(0);
            for (const order of booksides[1].items()) {
              sumBase.iadd(order.sizeLots);
              sumQuote.iadd(order.sizeLots.mul(order.priceLots));

              const diff = sumQuote.sub(amountInLots);
              if (!diff.isNeg()) {
                sumBase.isub(
                  diff.add(order.priceLots.subn(1)).div(order.priceLots)
                );
                break;
              }
              if (diff.isZero()) break;
            }

            const nativeBase = sumBase
              .mul(market.baseLotSize)
              .muln(Math.pow(10, baseBank.mintDecimals - market.baseDecimals));

            const passesHealthRatioCheck =
              ravenPositions.healthRatio.toNumber() > 100 ||
              ravenPositions.perpBase.isNeg();

            if (nativeBase.gte(otherAmountThreshold) && passesHealthRatioCheck) {
              return {
                label: `rvn-${quoteMintLabel}-${baseMintLabel}`,
                marketInfos: [
                  {
                    label: "raven",
                    fee: {
                      amount: feeQuote,
                      mint: quoteMint,
                      rate: feeRate.toNumber(),
                    },
                  },
                ],
                maxAmtIn: amount,
                minAmtOut: nativeBase,
                mints: [],
                ok: true,
                instructions: async (wallet: PublicKey) => {
                  const baseToken = await getAssociatedTokenAddress(
                    baseMint,
                    wallet
                  );
                  const quoteToken = await getAssociatedTokenAddress(
                    quoteMint,
                    wallet
                  );

                  // @ts-ignore
                  const healthRemainingAccounts = client[
                    "buildHealthRemainingAccounts"
                  ](group, [mangoAccount!]);
                  const tradeIx = await raven.methods
                    .tradeExactIn(amount, false, nativeBase)
                    .accounts({
                      trader: wallet,
                      owner: pda,
                      account: mangoAccount.publicKey,
                      perpMarket: market.publicKey,
                      perpOracle: market.oracle,
                      eventQueue: market.eventQueue,
                      bids: market.bids,
                      asks: market.asks,
                      baseBank: baseBank.publicKey,
                      quoteBank: quoteBank.publicKey,
                      baseVault: baseBank.vault,
                      quoteVault: quoteBank.vault,
                      baseOracle: baseBank.oracle,
                      quoteOracle: quoteBank.oracle,
                      group: group.publicKey,
                      baseToken,
                      quoteToken,
                      mangoProgram: MANGO_V4_ID["mainnet-beta"],
                      tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .remainingAccounts(
                      healthRemainingAccounts.map(
                        (pk: any) =>
                          ({
                            pubkey: pk,
                            isWritable: false,
                            isSigner: false,
                          } as AccountMeta)
                      )
                    )
                    .instruction();

                  return [tradeIx];
                },
                intermediateAmounts: [],
              };
            }
          } else {
            // SwapMode.ExactOut
            // ExactOut not yet implemented in program.
          }

          // error case no swap result has been generated
          // console.error(`error raven swap ${quoteMintLabel}-${baseMintLabel}`);
          return {
            ok: false,
            label: "",
            marketInfos: [],
            maxAmtIn: amount,
            minAmtOut: otherAmountThreshold,
            mints: [],
            instructions: async () => [],
            intermediateAmounts: [],
          };
        },
      },
    ];

    this.addEdges(edges);
  }

  async indexRaven(): Promise<void> {
    // load initial cache state
    const user = Keypair.generate();
    const userWallet = new Wallet(user);
    const userProvider = new AnchorProvider(this.connection, userWallet, {});
    const client = MangoClient.connect(
      // @ts-ignore
      userProvider,
      "mainnet-beta",
      MANGO_V4_ID["mainnet-beta"],
      {
        idsSource: "get-program-accounts",
      }
    );
    const group = await client.getGroup(MANGO_V4_MAIN_GROUP);
    const program = new Program(
      ravenIdl as Idl,
      RAVEN_PROGRAM_ADDRESS,
      userProvider
    );
    const mangoAccount = await client.getMangoAccountForOwner(
      group,
      RAVEN_MANGO_ACCOUNT_OWNER,
      0 /* First Mango account created */
    );
    await mangoAccount!.reload(client);

    await this.addRavenEdges(
      program,
      RAVEN_MANGO_ACCOUNT_OWNER,
      client,
      group,
      mangoAccount!,
      "BTC-PERP",
      "tbtc",
      "usdc",
      new PublicKey("6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU"),
      USDC_MINT
    );
    await this.addRavenEdges(
      program,
      RAVEN_MANGO_ACCOUNT_OWNER,
      client,
      group,
      mangoAccount!,
      "SOL-PERP",
      "wsol",
      "usdc",
      new PublicKey("So11111111111111111111111111111111111111112"),
      USDC_MINT
    );
    await this.addRavenEdges(
      program,
      RAVEN_MANGO_ACCOUNT_OWNER,
      client,
      group,
      mangoAccount!,
      "ETH-PERP",
      "eth",
      "usdc",
      new PublicKey("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"),
      USDC_MINT
    );

    await this.addRavenEdges(
      program,
      RAVEN_MANGO_ACCOUNT_OWNER,
      client,
      group,
      mangoAccount!,
      "RENDER-PERP",
      "rndr",
      "usdc",
      new PublicKey("rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof"),
      USDC_MINT
    );
  }

  async indexRaydium(): Promise<void> {
    const response = await fetch("https://api.raydium.io/v2/ammV3/ammPools", {
      method: "GET",
    });
    const poolData = (await response.json()).data as ApiClmmPoolsItem[];

    // TODO: Do not trust the tvl and instead look it up like with jupiter prices
    const poolsFilteredByTvl = poolData.filter((p: ApiClmmPoolsItem) => {
      return p.tvl > this.minTvl;
    });
    console.log(
      "found",
      poolData.length,
      "raydium pools.",
      poolsFilteredByTvl.length,
      "of those with TVL >",
      this.minTvl,
      "USD"
    );

    const poolInfos = await Clmm.fetchMultiplePoolInfos({
      connection: this.connection,
      poolKeys: poolsFilteredByTvl,
      ownerInfo: undefined,
      chainTime: 0,
      batchRequest: false,
      updateOwnerRewardAndFee: true,
    });
    const poolTickArrays = await Clmm.fetchMultiplePoolTickArrays({
      connection: this.connection,
      poolKeys: poolsFilteredByTvl.map((p) => poolInfos[p.id].state),
      batchRequest: false,
    });
    const mints = poolsFilteredByTvl
      .map((p) => [new PublicKey(p.mintA), new PublicKey(p.mintB)])
      .flat();
    const mintInfos = await fetchMultipleMintInfos({
      connection: this.connection,
      mints: mints,
    });

    this.raydiumCache = new RaydiumCache(
      await this.connection.getEpochInfo(),
      mintInfos,
      poolInfos,
      poolTickArrays
    );

    for (const pool of poolsFilteredByTvl) {
      const poolInfo = poolInfos[pool.id].state;
      this.addEdges(RaydiumEdge.pairFromPool(poolInfo, this.raydiumCache));
    }
  }

  async indexWhirpools(): Promise<void> {
    const poolsPks = (
      await this.whirlpoolClient.getContext().program.account.whirlpool.all()
    ).map((p) => p.publicKey);
    // sucks to double fetch but I couldn't find another way to do this
    const pools = await this.whirlpoolClient.getPools(poolsPks, true);
    const mints = Array.from(
      new Set(
        pools.flatMap((p) => [
          p.getTokenAInfo().mint.toString(),
          p.getTokenBInfo().mint.toString(),
        ])
      )
    );
    const prices: Record<string, number> = {};
    const batchSize = 64;
    for (let i = 0; i < mints.length; i += batchSize) {
      const mintBatch = mints.slice(i, i + batchSize);
      const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v4/price?ids=${mintBatch.join(",")}`
      );
      const quotes: any = await quoteResponse.json();

      for (const pk in quotes.data) {
        prices[pk] = quotes.data[pk].price;
      }
    }

    const filtered = pools.filter((p) => {
      const mintA = p.getTokenAInfo().mint.toString();
      const mintB = p.getTokenBInfo().mint.toString();
      const priceA = prices[mintA];
      const priceB = prices[mintB];

      if (!priceA || !priceB) {
        // console.log(
        //   "filter pool",
        //   p.getAddress().toString(),
        //   "unknown price for mint",
        //   priceA ? mintB : mintA
        // );
        return false;
      }

      const vaultBalanceA = toUiDecimals(
        p.getTokenVaultAInfo().amount,
        p.getTokenAInfo().decimals
      );
      const vaultBalanceB = toUiDecimals(
        p.getTokenVaultBInfo().amount,
        p.getTokenBInfo().decimals
      );

      const tvl = vaultBalanceA * priceA + vaultBalanceB * priceB;
      if (tvl <= this.minTvl) {
        // console.log(
        //   "filter pool",
        //   p.getAddress().toString(),
        //   "tvl",
        //   tvl,
        //   mintA,
        //   mintB
        // );
        return false;
      }

      return true;
    });

    console.log(
      "found",
      poolsPks.length,
      "orca pools.",
      filtered.length,
      "of those with TVL >",
      this.minTvl,
      "USD"
    );

    for (const pool of filtered) {
      this.addEdges(WhirlpoolEdge.pairFromPool(pool, this.whirlpoolClient));
    }
  }

  public async queryDepth(
    inputMint: PublicKey,
    outputMint: PublicKey,
    startAmount: BN,
    referencePrice: number,
    priceImpactLimit: number
  ): Promise<DepthResult[]> {
    let results: DepthResult[] = [];

    const A = inputMint.toString();
    const fromA = this.routes.get(A);
    if (!fromA) return results;

    const Z = outputMint.toString();
    const AtoZ = fromA?.get(Z);

    // direct swaps A->Z
    if (AtoZ) {
      results = await Promise.all(
        AtoZ.map(async (eAZ) => {
          let bestResult = {
            label: eAZ.label,
            maxAmtIn: ZERO,
            minAmtOut: ZERO,
            ok: false,
          };
          let inAmount = startAmount;
          while (inAmount.lt(U64_MAX)) {
            let outAmountThreshold = inAmount
              .divn(referencePrice)
              .muln(1 - priceImpactLimit);
            let swapResult = await eAZ.swap(
              inAmount,
              outAmountThreshold,
              SwapMode.ExactIn,
              0
            );
            let actualPrice =
              Number(swapResult.maxAmtIn.toString()) /
              Number(swapResult.minAmtOut.toString());
            let priceImpact = actualPrice / referencePrice - 1;

            if (!swapResult.ok || priceImpact >= priceImpactLimit) break;

            bestResult = { ...swapResult, ok: true };
            inAmount = inAmount.muln(1.1);
          }
          return bestResult;
        })
      );
    }

    // swap A->B->Z
    for (const [B, AtoB] of fromA.entries()) {
      const fromB = this.routes.get(B);
      const BtoZ = fromB?.get(Z);

      if (!BtoZ) continue;

      // swap A->B->Z amt=IN oth=OUT
      for (const eAB of AtoB) {
        for (const eBZ of BtoZ) {
          let bestResult = {
            label: `${eAB.label}_${eBZ.label}`,
            maxAmtIn: ZERO,
            minAmtOut: ZERO,
            ok: false,
          };
          let inAmount = startAmount;

          while (inAmount.lt(U64_MAX)) {
            let outAmountThreshold = inAmount
              .divn(referencePrice)
              .muln(1 - priceImpactLimit);
            const firstHop = await eAB.swap(
              inAmount,
              ZERO,
              SwapMode.ExactIn,
              0
            );
            const secondHop = await eBZ.swap(
              firstHop.minAmtOut,
              outAmountThreshold,
              SwapMode.ExactIn,
              0
            );
            let actualPrice =
              Number(firstHop.maxAmtIn.toString()) /
              Number(secondHop.minAmtOut.toString());
            let priceImpact = actualPrice / referencePrice - 1;

            if (
              !firstHop.ok ||
              !secondHop.ok ||
              priceImpact >= priceImpactLimit
            )
              break;

            bestResult = {
              label: `${firstHop.label}_${secondHop.label}`,
              maxAmtIn: firstHop.maxAmtIn,
              minAmtOut: secondHop.minAmtOut,
              ok: true,
            };
            inAmount = inAmount.muln(2 ** 0.5);
          }

          results.push(bestResult);
        }
      }
    }

    // swap A->B->C->Z
    for (const [B, AtoB] of fromA.entries()) {
      const fromB = this.routes.get(B)!;
      for (const [C, BtoC] of fromB.entries()) {
        const fromC = this.routes.get(C)!;
        const CtoZ = fromC?.get(Z);

        if (!CtoZ) continue;

        // swap A->B->Z amt=IN oth=OUT
        for (const eAB of AtoB) {
          for (const eBC of BtoC) {
            for (const eCZ of CtoZ) {
              let bestResult = {
                label: `${eAB.label}_${eBC.label}_${eCZ.label}`,
                maxAmtIn: ZERO,
                minAmtOut: ZERO,
                ok: false,
              };
              let inAmount = startAmount;

              while (inAmount.lt(U64_MAX)) {
                let outAmountThreshold = inAmount
                  .divn(referencePrice)
                  .muln(1 - priceImpactLimit);
                const firstHop = await eAB.swap(
                  inAmount,
                  ZERO,
                  SwapMode.ExactIn,
                  0
                );
                const secondHop = await eBC.swap(
                  firstHop.minAmtOut,
                  ZERO,
                  SwapMode.ExactIn,
                  0
                );
                const thirdHop = await eCZ.swap(
                  secondHop.minAmtOut,
                  outAmountThreshold,
                  SwapMode.ExactIn,
                  0
                );

                let actualPrice =
                  Number(firstHop.maxAmtIn.toString()) /
                  Number(thirdHop.minAmtOut.toString());
                let priceImpact = actualPrice / referencePrice - 1;

                if (
                  !firstHop.ok ||
                  !secondHop.ok ||
                  !thirdHop.ok ||
                  priceImpact >= priceImpactLimit
                )
                  break;

                bestResult = {
                  label: `${firstHop.label}_${secondHop.label}_${thirdHop.label}`,
                  maxAmtIn: firstHop.maxAmtIn,
                  minAmtOut: thirdHop.minAmtOut,
                  ok: true,
                };
                inAmount = inAmount.muln(2 ** 0.5);
              }

              results.push(bestResult);
            }
          }
        }
      }
    }

    return results;
  }

  public async swap(
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
