import {
  LiquidityPoolKeysV4,
  Liquidity,
  Market,
  SERUM_PROGRAM_ID_V3,
  LIQUIDITY_PROGRAM_ID_V4,
  jsonInfo2PoolKeys
} from "@raydium-io/raydium-sdk"

import {
  Connection,
  PublicKey,
} from "@solana/web3.js";

const importDynamic = new Function('modulePath', 'return import(modulePath)');
const fetch = async (...args:any[]) => {
  const module = await importDynamic('node-fetch');
  return module.default(...args);
};

export interface PairInfo {
  name: string;
  ammId: string;
  lpMint: string;
  market: string;
  liquidity: number;
  volume24h: number;
  volume24hQuote: number;
  fee24h: number;
  fee24hQuote: number;
  volume7d: number;
  volume7dQuote: number;
  fee7d: number;
  fee7dQuote: number;
  volume30d: number;
  volume30dQuote: number;
  fee30d: number;
  fee30dQuote: number;
  price: number;
  lpPrice: number;
  tokenAmountCoin: number;
  tokenAmountPc: number;
  tokenAmountLp: number;
  apr24h: number;
  apr7d: number;
  apr30d: number;
}

export async function fetchPoolKeys(
  connection: Connection,
  poolId: PublicKey,
  version : number = 4
): Promise<LiquidityPoolKeysV4> {

  // const version = 4
  const serumVersion = 3
  const marketVersion = 3

  const programId = LIQUIDITY_PROGRAM_ID_V4
  const serumProgramId = SERUM_PROGRAM_ID_V3

  const account = await connection.getAccountInfo(poolId)
  const { state: LiquidityStateLayout }  = Liquidity.getLayouts(version)

  //@ts-ignore
  const fields = LiquidityStateLayout.decode(account.data);
  const { status, baseMint, baseDecimal, quoteMint, quoteDecimal, lpMint, openOrders, targetOrders, baseVault, quoteVault, marketId } = fields;

  let withdrawQueue, lpVault;
  if (Liquidity.isV4(fields)) {
    withdrawQueue = fields.withdrawQueue;
    lpVault = fields.lpVault;
  } else {
    withdrawQueue = PublicKey.default;
    lpVault = PublicKey.default;
  }

  const associatedPoolKeys = await Liquidity.getAssociatedPoolKeys({
    version,
    marketVersion,
    marketId,
    baseMint,
    quoteMint,
    baseDecimals: Number(baseDecimal),
    quoteDecimals: Number(quoteDecimal),
    programId,
    marketProgramId: serumProgramId
  });

  const marketInfo = await connection.getAccountInfo( marketId);
  const { state: MARKET_STATE_LAYOUT } = Market.getLayouts(marketVersion);
  //@ts-ignore
  const market = MARKET_STATE_LAYOUT.decode(marketInfo.data);

  const {
    baseVault: marketBaseVault,
    quoteVault: marketQuoteVault,
    bids: marketBids,
    asks: marketAsks,
    eventQueue: marketEventQueue,
  } = market;
  const poolKeys: LiquidityPoolKeysV4 = {
    id: poolId,
    baseMint,
    quoteMint,
    lpMint,
    baseDecimals: associatedPoolKeys.baseDecimals,
    quoteDecimals: associatedPoolKeys.quoteDecimals,
    lpDecimals: associatedPoolKeys.lpDecimals,
    version,
    programId,
    authority: associatedPoolKeys.authority,
    baseVault,
    quoteVault,
    lpVault,
    openOrders,
    targetOrders,
    withdrawQueue,
    marketVersion: serumVersion,
    marketProgramId: serumProgramId,
    marketId,
    marketAuthority: associatedPoolKeys.marketAuthority,
    marketBaseVault,
    marketQuoteVault,
    marketBids,
    marketAsks,
    marketEventQueue,
  };
  return poolKeys;
}

export async function fetchAllPoolKeys(): Promise<LiquidityPoolKeysV4[]> {
    const response = await fetch('https://api.raydium.io/v2/sdk/liquidity/mainnet.json');
    if (!(await response).ok) return []
    const json: any = await response.json();
    const poolsKeysJson = [...(json?.official ?? []), ...(json?.unOfficial ?? [])]
    const poolsKeys = poolsKeysJson.map((item) => {
      const {
          id,
          baseMint,
          quoteMint,
          lpMint,
          baseDecimals,
          quoteDecimals,
          lpDecimals,
          version,
          programId,
          authority,
          openOrders,
          targetOrders,
          baseVault,
          quoteVault,
          withdrawQueue,
          lpVault,
          marketVersion,
          marketProgramId,
          marketId,
          marketAuthority,
          marketBaseVault,
          marketQuoteVault,
          marketBids,
          marketAsks,
          marketEventQueue,
      } = jsonInfo2PoolKeys(item)
      return {
          id,
          baseMint,
          quoteMint,
          lpMint,
          baseDecimals,
          quoteDecimals,
          lpDecimals,
          version,
          programId,
          authority,
          openOrders,
          targetOrders,
          baseVault,
          quoteVault,
          withdrawQueue,
          lpVault,
          marketVersion,
          marketProgramId,
          marketId,
          marketAuthority,
          marketBaseVault,
          marketQuoteVault,
          marketBids,
          marketAsks,
          marketEventQueue,
      };
    })
    return poolsKeys
}

export async function fetchAllPairInfos(): Promise<PairInfo[]> {
  const pairsResponse = await fetch('https://api.raydium.io/v2/main/pairs');
  const pairs: PairInfo[] = await pairsResponse.json();
  return pairs;
}