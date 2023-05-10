"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const drift_1 = require("./drift");
const drift = new drift_1.Drift(process.env.ACCOUNT);
const setup = async () => {
    await drift.setup();
    // Object.keys(SUB_ACCOUNTS).forEach((key) => {
    //   drift.startBot(SUB_ACCOUNTS[key], key);
    // });
    drift.startBot(drift_1.SUB_ACCOUNTS["SOL"], "SOL");
    // drift.startBot(SUB_ACCOUNTS["BTC"], "BTC");
    // drift.startBot(SUB_ACCOUNTS["1MBONK"], "1MBONK");
};
setup();
