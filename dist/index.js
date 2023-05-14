"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const drift_multi_asset_1 = require("./drift-multi-asset");
const drift = new drift_multi_asset_1.DriftMultiAsset(process.env.ACCOUNT);
const setup = async () => {
    try {
        await drift.setup();
        drift.startBot();
    }
    catch {
        drift.startBot();
    }
};
setup();
