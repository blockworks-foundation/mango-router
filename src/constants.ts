import {
    PublicKey,
} from "@solana/web3.js";

export const RAVEN_PROGRAM_ADDRESS: string = "AXRsZddcKo8BcHrbbBdXyHozSaRGqHc11ePh9ChKuoa1";
export const RAVEN_MANGO_ACCOUNT: PublicKey = new PublicKey(
    "GRR9y6yBxfxqVS7xQekRk4c6KUB2ukqSM8fY8GJSSCbo"
);
export const RAVEN_MANGO_ACCOUNT_OWNER: PublicKey = PublicKey.findProgramAddressSync(
    [Buffer.from("pda")],
    new PublicKey(
        RAVEN_PROGRAM_ADDRESS
    )
)[0];

export const RAVEN_FEE_BPS = 1;
export const MANGO_TAKER_FEE_BPS = 6;
export const MANGO_BORROW_FEE_BPS = 5;
export const POSITION_INCREASE_RAVEN_FEE_BPS = 1;
