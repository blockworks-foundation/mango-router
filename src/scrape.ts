import fetch from "cross-fetch";
import { Configuration, DefaultApi } from "@jup-ag/api";
import { Market, Orderbook } from "@project-serum/serum";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

async function quoteBid(usdAmount: number, usdMint: string) {
  const response = await fetch(
    `https://api.mngo.cloud/router/v1/swap?wallet=Bz9thGbRRfwq3EFtFtSKZYnnXio5LXDaRgJDh3NrMAGT&inputMint=${usdMint}&outputMint=So11111111111111111111111111111111111111112&mode=ExactIn&amount=${
      usdAmount * 1000000
    }&slippage=0.1`
  );
  const json: any = await response.json();
  if (json[0]) {
    return 1000000000000 / json[0]["outAmount"];
  } else {
    return 0;
  }
}

async function quoteAsk(usdAmount: number, usdMint: string) {
  const response = await fetch(
    `https://api.mngo.cloud/router/v1/swap?wallet=Bz9thGbRRfwq3EFtFtSKZYnnXio5LXDaRgJDh3NrMAGT&inputMint=So11111111111111111111111111111111111111112&outputMint=${usdMint}&mode=ExactOut&amount=${
      usdAmount * 1000000
    }&slippage=0.1`
  );
  const json: any = await response.json();
  if (json[0]) {
    return 1000000000000 / json[0]["inAmount"];
  } else {
    return 0;
  }
}

const config = new Configuration({
  basePath: "https://quote-api.jup.ag",
  fetchApi: fetch,
});
const jupiterQuoteApi = new DefaultApi(config);

async function quoteJupBid(usdAmount: number, usdMint: string) {
  try {
    const quote: any = await jupiterQuoteApi.v4QuoteGet({
      inputMint: usdMint,
      outputMint: "So11111111111111111111111111111111111111112",
      amount: `${usdAmount * 1000000}`,
    });
    return 1000000000000 / quote.data[0]["outAmount"];
  } catch (e) {
    return 0;
  }
}

async function quoteJupAsk(usdAmount: number, usdMint: string) {
  try {
    const quote: any = await jupiterQuoteApi.v4QuoteGet({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: usdMint,
      amount: `${usdAmount * 1000000}`,
      swapMode: "ExactOut" as any,
    });
    return 1000000000000 / quote.data[0]["inAmount"];
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
    quoteBid(100, usdMint),
    quoteBid(400, usdMint),
    quoteBid(2000, usdMint),
    quoteJupBid(100, usdMint),
    quoteJupBid(400, usdMint),
    quoteJupBid(2000, usdMint),
    quoteAsk(100, usdMint),
    quoteAsk(400, usdMint),
    quoteAsk(2000, usdMint),
    quoteJupAsk(100, usdMint),
    quoteJupAsk(400, usdMint),
    quoteJupAsk(2000, usdMint),
  ]);

  const obQuotes = [
    quoteOBBid(100),
    quoteOBBid(400),
    quoteOBBid(2000),
    quoteOBAsk(100),
    quoteOBAsk(400),
    quoteOBAsk(2000),
  ];

  console.log([ts, ...quotes, ...obQuotes].join(","));
}

main(true);
