import { I80F48 } from "@blockworks-foundation/mango-v4";
import { PublicKey } from "@solana/web3.js";

export const RAVEN_PROGRAM_ADDRESS: string =
  "AXRsZddcKo8BcHrbbBdXyHozSaRGqHc11ePh9ChKuoa1";
export const RAVEN_MANGO_ACCOUNT: PublicKey = new PublicKey(
  "GRR9y6yBxfxqVS7xQekRk4c6KUB2ukqSM8fY8GJSSCbo"
);
export const RAVEN_MANGO_ACCOUNT_OWNER: PublicKey = PublicKey.findProgramAddressSync(
  [Buffer.from("pda")],
  new PublicKey(RAVEN_PROGRAM_ADDRESS)
)[0];

export const RAVEN_BASE_FEE = I80F48.fromNumber(0.0001);
export const RAVEN_POSITION_INCREASE_FEE = I80F48.fromNumber(0.0001);
