"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUB_ACCOUNTS = exports.Drift = void 0;
const sdk_1 = require("@drift-labs/sdk");
const anchor_1 = require("@project-serum/anchor");
const convertSecretKeyToKeypair_1 = require("@slidelabs/solana-toolkit/build/utils/convertSecretKeyToKeypair");
const web3_js_1 = require("@solana/web3.js");
const solanaConnection_1 = require("./config/solanaConnection");
class Drift {
    constructor(botAccount) {
        this.env = solanaConnection_1.env;
        this.connection = solanaConnection_1.connection;
        this.sdkConfig = (0, sdk_1.initialize)({ env: this.env });
        this.driftPublicKey = new web3_js_1.PublicKey(this.sdkConfig.DRIFT_PROGRAM_ID);
        this.perpMarkets = sdk_1.PerpMarkets[this.env];
        this.setup = async () => {
            this.account = (0, convertSecretKeyToKeypair_1.convertSecretKeyToKeypair)(this.botAccount);
            this.wallet = new sdk_1.Wallet(this.account);
            this.anchorProvider = new anchor_1.AnchorProvider(this.connection, this.wallet, anchor_1.AnchorProvider.defaultOptions());
            this.bulkAccountLoader = new sdk_1.BulkAccountLoader(this.connection, "processed", 1000);
            this.driftClient = new sdk_1.DriftClient({
                connection: this.connection,
                wallet: this.anchorProvider.wallet,
                programID: this.driftPublicKey,
                ...(0, sdk_1.getMarketsAndOraclesForSubscription)(this.env),
                accountSubscription: {
                    type: "polling",
                    accountLoader: this.bulkAccountLoader,
                },
            });
            await this.driftClient.subscribe();
            this.user = new sdk_1.User({
                driftClient: this.driftClient,
                userAccountPublicKey: await this.driftClient.getUserAccountPublicKey(),
                accountSubscription: {
                    type: "polling",
                    accountLoader: this.bulkAccountLoader,
                },
            });
            await this.user.subscribe();
            this.slotSubscriber = new sdk_1.SlotSubscriber(solanaConnection_1.connection);
            await this.slotSubscriber.subscribe();
        };
        this.startBot = async (subAccount, symbol) => {
            let orders = {
                bid: [],
                ask: [],
            };
            await this.driftClient.switchActiveUser(subAccount);
            const oraclePriceData = this.fetchOraclePrice(symbol);
            const marketConfig = this.fetchPerpMarket(symbol);
            const marketAccount = this.driftClient.getPerpMarketAccount(marketConfig.marketIndex);
            const perpPositon = this.user.getPerpPosition(marketConfig.marketIndex);
            if (perpPositon.quoteEntryAmount &&
                (0, sdk_1.convertToNumber)(perpPositon.quoteEntryAmount) > 0) {
                await this.driftClient.closePosition(marketConfig.marketIndex);
            }
            const slot = this.slotSubscriber.getSlot();
            const dlob = new sdk_1.DLOB();
            const l2 = dlob.getL2({
                marketIndex: marketConfig.marketIndex,
                marketType: sdk_1.MarketType.PERP,
                depth: 1000000,
                oraclePriceData,
                slot: slot,
                fallbackBid: (0, sdk_1.calculateBidPrice)(marketAccount, oraclePriceData),
                fallbackAsk: (0, sdk_1.calculateAskPrice)(marketAccount, oraclePriceData),
                fallbackL2Generators: [
                    (0, sdk_1.getVammL2Generator)({
                        marketAccount: marketAccount,
                        oraclePriceData,
                        numOrders: 1000000,
                    }),
                ],
            });
            console.log("********************************");
            const oraclePrice = (0, sdk_1.convertToNumber)(oraclePriceData.price);
            console.log(symbol);
            console.log("oraclePrice", oraclePrice);
            l2.bids.forEach((bid) => {
                const bidPrice = (0, sdk_1.convertToNumber)(bid.price);
                const dif = (oraclePrice - bidPrice) / 100;
                if (orders.bid.length > 14) {
                    return;
                }
                if (dif < 0.5) {
                    orders.bid.push(bid.price);
                }
            });
            l2.asks.forEach((ask) => {
                const askPrice = (0, sdk_1.convertToNumber)(ask.price);
                const dif = (askPrice - oraclePrice) / 100;
                if (orders.ask.length > 14) {
                    return;
                }
                if (dif < 0.8) {
                    orders.ask.push(ask.price);
                }
            });
            this.openOrders(orders, subAccount, symbol);
        };
        this.openOrders = async (orders, subAccount, symbol) => {
            const marketConfig = this.fetchPerpMarket(symbol);
            const longInstructions = [];
            const shortInstructions = [];
            console.log("marketConfig", marketConfig.baseAssetSymbol);
            if (this.driftClient
                .getUserAccount()
                .orders.find((item) => item.marketIndex === marketConfig.marketIndex)) {
                const cancelLongInstructions = await this.driftClient.getCancelOrdersIx(sdk_1.MarketType.PERP, marketConfig.marketIndex, sdk_1.PositionDirection.LONG);
                longInstructions.push(cancelLongInstructions);
                const cancelShortInstructions = await this.driftClient.getCancelOrdersIx(sdk_1.MarketType.PERP, marketConfig.marketIndex, sdk_1.PositionDirection.SHORT);
                shortInstructions.push(cancelShortInstructions);
            }
            // LONG
            const instructionPlaceLongOrders = await this.placeOrders(orders.bid, marketConfig, sdk_1.PositionDirection.LONG);
            if (instructionPlaceLongOrders?.length > 0) {
                longInstructions.push(...instructionPlaceLongOrders);
            }
            const longTransaction = new web3_js_1.Transaction();
            longTransaction.instructions = longInstructions;
            await this.driftClient.sendTransaction(longTransaction);
            // SHORT
            const instructionPlaceShortOrders = await this.placeOrders(orders.ask, marketConfig, sdk_1.PositionDirection.SHORT);
            if (instructionPlaceShortOrders?.length > 0) {
                shortInstructions.push(...instructionPlaceShortOrders);
            }
            const shortTransaction = new web3_js_1.Transaction();
            shortTransaction.instructions = shortInstructions;
            await this.driftClient.sendTransaction(shortTransaction);
            console.log(`DONE ${symbol}`);
            console.log("GENERAL DONE");
            console.log("RESTART");
            this.startBot(subAccount, symbol);
        };
        this.placeOrders = async (orders, marketConfig, direction) => {
            const instructions = [];
            for (let i = 0; i < orders.length; i++) {
                const price = orders[i];
                const perpMarketPrice = this.driftClient.getPerpMarketAccount(marketConfig.marketIndex);
                const marketOrderParams = (0, sdk_1.getLimitOrderParams)({
                    baseAssetAmount: ORDER_SIZE[marketConfig.baseAssetSymbol],
                    direction: direction,
                    marketIndex: perpMarketPrice.marketIndex,
                    postOnly: sdk_1.PostOnlyParams.MUST_POST_ONLY,
                    triggerCondition: sdk_1.OrderTriggerCondition.ABOVE,
                    price: price,
                });
                const instructionPlaceOrder = await this.driftClient.getPlacePerpOrderIx(marketOrderParams);
                instructions.push(instructionPlaceOrder);
            }
            return instructions;
        };
        this.fetchPerpMarket = (symbol) => {
            return this.perpMarkets.find((market) => market.baseAssetSymbol === symbol);
        };
        this.fetchPrice = (symbol) => {
            try {
                const marketInfo = this.fetchPerpMarket(symbol);
                if (!marketInfo)
                    return null;
                const perpMarketPrice = this.driftClient.getPerpMarketAccount(marketInfo.marketIndex);
                if (!perpMarketPrice)
                    return null;
                const oraclePriceData = this.fetchOraclePrice(symbol);
                const bidAskPrice = (0, sdk_1.calculateBidAskPrice)(perpMarketPrice.amm, oraclePriceData);
                return [bidAskPrice[0], bidAskPrice[1]];
            }
            catch { }
        };
        this.fetchOraclePrice = (symbol) => {
            try {
                const makertInfo = this.fetchPerpMarket(symbol);
                if (!makertInfo)
                    return null;
                return this.driftClient.getOracleDataForPerpMarket(makertInfo.marketIndex);
            }
            catch {
                return null;
            }
        };
        this.botAccount = botAccount;
    }
}
exports.Drift = Drift;
//
// Utils
//
exports.SUB_ACCOUNTS = {
    SOL: 0,
    BTC: 1,
    ETH: 2,
    MATIC: 3,
    "1MBONK": 4,
    APT: 5,
    ARB: 6,
    BNB: 7,
};
const ORDER_SIZE = {
    SOL: sdk_1.QUOTE_PRECISION.mul(new anchor_1.BN(6000)),
    BTC: new anchor_1.BN(500000),
    ETH: new anchor_1.BN(10000000),
    APT: new anchor_1.BN(8000000000),
    "1MBONK": new anchor_1.BN(1000000000),
    MATIC: new anchor_1.BN(40000000000),
    ARB: new anchor_1.BN(40000000000),
    DOGE: new anchor_1.BN(100000000000),
    BNB: new anchor_1.BN(100000000),
};
