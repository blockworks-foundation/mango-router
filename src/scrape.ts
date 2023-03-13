import fetch from "cross-fetch";
import { Configuration, DefaultApi } from "@jup-ag/api";
import { Market, Orderbook } from "@project-serum/serum";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

async function quoteAsk(usdAmount: number, usdMint: string) {
  const response = await fetch(
    `https://api.mngo.cloud/router/v1/swap?wallet=Bz9thGbRRfwq3EFtFtSKZYnnXio5LXDaRgJDh3NrMAGT&inputMint=${usdMint}&outputMint=So11111111111111111111111111111111111111112&mode=ExactIn&amount=${
      usdAmount * 1_000_000
    }&slippage=0.1`
  );
  const json: any = await response.json();
  if (json[0]) {
    return (usdAmount * 1_000_000_000) / json[0]["outAmount"];
  } else {
    return 0;
  }
}

async function quoteBid(usdAmount: number, usdMint: string) {
  const response = await fetch(
    `https://api.mngo.cloud/router/v1/swap?wallet=Bz9thGbRRfwq3EFtFtSKZYnnXio5LXDaRgJDh3NrMAGT&inputMint=So11111111111111111111111111111111111111112&outputMint=${usdMint}&mode=ExactOut&amount=${
      usdAmount * 1_000_000
    }&slippage=0.1`
  );
  const json: any = await response.json();
  if (json[0]) {
    return (usdAmount * 1_000_000_000) / json[0]["inAmount"];
  } else {
    return 0;
  }
}

const config = new Configuration({
  basePath: "https://quote-api.jup.ag",
  fetchApi: fetch,
});
const jupiterQuoteApi = new DefaultApi(config);

async function quoteJupAsk(usdAmount: number, usdMint: string) {
  try {
    const quote: any = await jupiterQuoteApi.v4QuoteGet({
      inputMint: usdMint,
      outputMint: "So11111111111111111111111111111111111111112",
      amount: `${usdAmount * 1_000_000}`,
    });
    return (usdAmount * 1_000_000_000) / quote.data[0]["outAmount"];
  } catch (e) {
    return 0;
  }
}

async function quoteJupBid(usdAmount: number, usdMint: string) {
  try {
    const quote: any = await jupiterQuoteApi.v4QuoteGet({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: usdMint,
      amount: `${usdAmount * 1_000_000}`,
      swapMode: "ExactOut" as any,
    });
    return (usdAmount * 1_000_000_000) / quote.data[0]["inAmount"];
  } catch (e) {
    return 0;
  }
}

let openbookBids: [number, number, BN, BN][] = [];
let openbookAsks: [number, number, BN, BN][] = [];

async function subscribeOB() {
  let connection = new Connection(process.env.RPC_URL!);
  let marketAddress = new PublicKey(
    "8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6"
  );
  let programAddress = new PublicKey(
    "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX"
  );
  let market = await Market.load(connection, marketAddress, {}, programAddress);
  connection.onAccountChange(market.asksAddress, (info) => {
    openbookAsks = Orderbook.decode(market, info.data).getL2(20);
  });
  connection.onAccountChange(market.bidsAddress, (info) => {
    openbookBids = Orderbook.decode(market, info.data).getL2(20);
  });
}

function quoteOBBid(usdAmount: number) {
  let matchedSize = 0;
  let usdRemaining = usdAmount + 0;
  let index = 0;
  while (usdRemaining > 0) {
    let top = openbookBids[index++];
    if (!top) return 0;

    const [price, size] = top;
    matchedSize += Math.min(usdRemaining / price, size);

    usdRemaining -= price * size;
  }

  return usdAmount / matchedSize;
}

function quoteOBAsk(usdAmount: number) {
  let matchedSize = 0;
  let usdRemaining = usdAmount + 0;
  let index = 0;
  while (usdRemaining > 0) {
    let top = openbookAsks[index++];
    if (!top) return 0;

    const [price, size] = top;
    matchedSize += Math.min(usdRemaining / price, size);

    usdRemaining -= price * size;
  }

  return usdAmount / matchedSize;
}


const SIZE = [1000, 4000, 10000];
async function main(subscribe: any) {
  // run every second
  setTimeout(main, 1000);

  if (subscribe) {
    await subscribeOB();
  }

  const usdMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  // const usdMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

  const ts = Date.now();
  const quotes = await Promise.all([
    quoteBid(SIZE[0], usdMint),
    quoteBid(SIZE[1], usdMint),
    quoteBid(SIZE[2], usdMint),
    quoteJupBid(SIZE[0], usdMint),
    quoteJupBid(SIZE[1], usdMint),
    quoteJupBid(SIZE[2], usdMint),
    quoteAsk(SIZE[0], usdMint),
    quoteAsk(SIZE[1], usdMint),
    quoteAsk(SIZE[2], usdMint),
    quoteJupAsk(SIZE[0], usdMint),
    quoteJupAsk(SIZE[1], usdMint),
    quoteJupAsk(SIZE[2], usdMint),
  ]);

  const obQuotes = [
    quoteOBBid(SIZE[0]),
    quoteOBBid(SIZE[1]),
    quoteOBBid(SIZE[2]),
    quoteOBAsk(SIZE[0]),
    quoteOBAsk(SIZE[1]),
    quoteOBAsk(SIZE[2]),
  ];

  console.log([ts, ...quotes, ...obQuotes].join(","));
}

main(true);
