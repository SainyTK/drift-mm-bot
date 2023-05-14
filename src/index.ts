import { DriftMultiAsset } from "./drift-multi-asset";

const drift = new DriftMultiAsset(process.env.ACCOUNT);

const setup = async () => {
  try {
    await drift.setup();

    drift.startBot();
  } catch {
    drift.startBot();
  }
};

setup();
