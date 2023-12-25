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
export const RAVEN_LST_FEE = I80F48.fromNumber(0.001);

// updated on 2023-12-23
export const RAVEN_LST_CONVERSION_RATES: { [_: string]: number } = {
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: 1.0995,
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 1.1564811282,
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 1.078,
  ZScHuTtqZukUrtZS43teTKGs2VqkKL8k4QCouR2n6Uo: 1.1512,
};

export const CU_LIMIT: number = 700_000;