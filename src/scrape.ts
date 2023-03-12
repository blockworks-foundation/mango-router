import fetch from "cross-fetch";
import { Configuration, DefaultApi } from "@jup-ag/api";

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

async function main() {
  // run every second
  setTimeout(main, 1000);

  // const usdMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const usdMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

  const ts = Date.now();
  const quotes = await Promise.all([
    quoteBid(1000, usdMint),
    quoteBid(4000, usdMint),
    quoteBid(10000, usdMint),
    quoteJupBid(1000, usdMint),
    quoteJupBid(4000, usdMint),
    quoteJupBid(10000, usdMint),
    quoteAsk(1000, usdMint),
    quoteAsk(4000, usdMint),
    quoteAsk(10000, usdMint),
    quoteJupAsk(1000, usdMint),
    quoteJupAsk(4000, usdMint),
    quoteJupAsk(10000, usdMint),
  ]);

  console.log([ts, ...quotes].join(","));
}

main();
