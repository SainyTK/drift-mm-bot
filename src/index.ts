import { Drift } from "./drift";

const drift = new Drift(process.env.ACCOUNT);

const setup = async () => {
  await drift.setup();
};

setup();
