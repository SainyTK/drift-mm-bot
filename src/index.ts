import { Drift, SUB_ACCOUNTS } from "./drift";

const drift = new Drift(process.env.ACCOUNT);

const setup = async () => {
  await drift.setup();

  // Object.keys(SUB_ACCOUNTS).forEach((key) => {
  //   drift.startBot(SUB_ACCOUNTS[key], key);
  // });

  drift.startBot(SUB_ACCOUNTS["SOL"], "SOL");
  // drift.startBot(SUB_ACCOUNTS["BTC"], "BTC");
  // drift.startBot(SUB_ACCOUNTS["1MBONK"], "1MBONK");
};

setup();
