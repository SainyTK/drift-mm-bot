import { DriftEnv } from "@drift-labs/sdk";
import { Connection } from "@solana/web3.js";
import HELIUS_API from "../utils/helius";

export const env = "mainnet-beta" as DriftEnv;

export const connection = new Connection(HELIUS_API);
