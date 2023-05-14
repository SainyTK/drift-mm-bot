"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUN = exports.DriftMultiAsset = void 0;
const sdk_1 = require("@drift-labs/sdk");
const anchor_1 = require("@project-serum/anchor");
const convertSecretKeyToKeypair_1 = require("@slidelabs/solana-toolkit/build/utils/convertSecretKeyToKeypair");
const web3_js_1 = require("@solana/web3.js");
const solanaConnection_1 = require("./config/solanaConnection");
class DriftMultiAsset {
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
            this.bulkAccountLoader = new sdk_1.BulkAccountLoader(this.connection, "confirmed", 500);
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
            this.subscribeOrders();
        };
        this.subscribeOrders = async () => {
            try {
                setInterval(() => {
                    const activeOrders = this.driftClient
                        .getUserAccount()
                        .orders.filter((item) => item.orderId);
                    activeOrders.forEach(async (order) => {
                        const oraclePriceData = this.driftClient.getOracleDataForPerpMarket(order.marketIndex);
                        const direction = order.direction;
                        if (direction.long) {
                            const bidSpread = ((0, sdk_1.convertToNumber)(oraclePriceData.price, sdk_1.PRICE_PRECISION) /
                                (0, sdk_1.convertToNumber)(order.price, sdk_1.PRICE_PRECISION) -
                                1) *
                                100.0;
                            if (bidSpread < 0.008 || bidSpread > 0.1) {
                                console.log("***************************");
                                console.log(`${this.fetchPerpMarket(undefined, order.marketIndex).symbol}`);
                                console.log(`OR${(0, sdk_1.convertToNumber)(oraclePriceData.price)}`);
                                console.log(`BID CLOSED`, (0, sdk_1.convertToNumber)(order.price, sdk_1.PRICE_PRECISION).toFixed(4), `(${bidSpread.toFixed(4)}%)`);
                                this.driftClient.cancelOrder(order.orderId);
                                console.log("***************************\n");
                            }
                        }
                        if (direction.short) {
                            const askSpread = ((0, sdk_1.convertToNumber)(order.price, sdk_1.PRICE_PRECISION) /
                                (0, sdk_1.convertToNumber)(oraclePriceData.price, sdk_1.PRICE_PRECISION) -
                                1) *
                                100.0;
                            if (askSpread < 0.008 || askSpread > 0.1) {
                                console.log("***************************");
                                console.log(`OR${(0, sdk_1.convertToNumber)(oraclePriceData.price)}`);
                                console.log(`${this.fetchPerpMarket(undefined, order.marketIndex).symbol}`);
                                console.log(`ASK CLOSED`, (0, sdk_1.convertToNumber)(order.price, sdk_1.PRICE_PRECISION).toFixed(4), `(${askSpread.toFixed(4)}%)`);
                                this.driftClient.cancelOrder(order.orderId);
                                console.log("***************************\n");
                            }
                        }
                    });
                }, 500);
            }
            catch (e) {
                console.log(e);
            }
        };
        this.calcSpread = (oraclePrice, orderPrice, direction) => {
            let spread = 0;
            if (direction === "SHORT") {
                spread =
                    ((0, sdk_1.convertToNumber)(orderPrice, sdk_1.PRICE_PRECISION) /
                        (0, sdk_1.convertToNumber)(oraclePrice, sdk_1.PRICE_PRECISION) -
                        1) *
                        100.0;
            }
            if (direction === "LONG") {
                spread =
                    ((0, sdk_1.convertToNumber)(oraclePrice, sdk_1.PRICE_PRECISION) /
                        (0, sdk_1.convertToNumber)(orderPrice, sdk_1.PRICE_PRECISION) -
                        1) *
                        100.0;
            }
            return spread;
        };
        this.startBot = async () => {
            try {
                const orders = {};
                let i = 0;
                while (true) {
                    const symbol = exports.RUN[i];
                    const marketConfig = this.fetchPerpMarket(symbol);
                    const perpPosition = this.user.getPerpPosition(marketConfig.marketIndex);
                    const perpMarketPrice = this.driftClient.getPerpMarketAccount(marketConfig.marketIndex);
                    const oraclePriceData = this.fetchOraclePrice(symbol);
                    if (perpPosition) {
                        const unrealizedPnl = (0, sdk_1.calculatePositionPNL)(perpMarketPrice, perpPosition, false, oraclePriceData);
                        if ((0, sdk_1.convertToNumber)(perpPosition.quoteEntryAmount) !== 0 &&
                            ((0, sdk_1.convertToNumber)(unrealizedPnl) < 0 ||
                                (0, sdk_1.convertToNumber)(unrealizedPnl) > 0.5)) {
                            await this.driftClient.closePosition(marketConfig.marketIndex);
                        }
                    }
                    const { bestAsk, bestBid } = await this.printTopOfOrderLists(marketConfig.marketIndex, sdk_1.MarketType.PERP);
                    const firstPercentage = new anchor_1.BN(1000).div(new anchor_1.BN(4));
                    const firstBestBid = bestBid.add(bestBid.mul(firstPercentage).div(new anchor_1.BN(1000000)));
                    const firstBestAsk = bestAsk.sub(bestAsk.mul(firstPercentage).div(new anchor_1.BN(1000000)));
                    orders[symbol] = {
                        bid: [firstBestBid],
                        ask: [firstBestAsk],
                    };
                    i++;
                    if (i === exports.RUN.length) {
                        i = 0;
                        await this.openOrders(orders);
                    }
                }
            }
            catch { }
        };
        this.openOrders = async (orders) => {
            try {
                const instructions = [];
                for (let i = 0; i < Object.keys(orders).length; i++) {
                    const symbol = Object.keys(orders)[i];
                    const order = orders[symbol];
                    const marketConfig = this.fetchPerpMarket(symbol);
                    const ordersAmount = this.driftClient
                        .getUserAccount()
                        .orders.filter((item) => item.marketIndex === marketConfig.marketIndex && item.orderId);
                    if (ordersAmount.length >= 28) {
                        continue;
                    }
                    instructions.push(...(await this.placeOrders(order.bid, marketConfig, sdk_1.PositionDirection.LONG)));
                    instructions.push(...(await this.placeOrders(order.ask, marketConfig, sdk_1.PositionDirection.SHORT)));
                }
                if (instructions.length > 0) {
                    const transaction = new web3_js_1.Transaction();
                    transaction.instructions = instructions;
                    await this.driftClient.sendTransaction(transaction, undefined, {
                        commitment: "processed",
                    });
                }
            }
            catch { }
        };
        this.placeOrders = async (prices, marketConfig, direction) => {
            try {
                const instructions = [];
                for (let i = 0; i < prices.length; i++) {
                    const price = prices[i];
                    const perpMarketPrice = this.driftClient.getPerpMarketAccount(marketConfig.marketIndex);
                    let amount = 10;
                    const slot = await this.connection.getSlot();
                    const dblob = new sdk_1.DLOB();
                    const perpPrice = (0, sdk_1.calculateEstimatedPerpEntryPrice)("quote", new anchor_1.BN(amount * 10).mul(sdk_1.QUOTE_PRECISION), direction, perpMarketPrice, this.driftClient.getOracleDataForPerpMarket(perpMarketPrice.marketIndex), dblob, slot);
                    const marketOrderParams = (0, sdk_1.getLimitOrderParams)({
                        baseAssetAmount: perpPrice.baseFilled,
                        direction: direction,
                        marketIndex: perpMarketPrice.marketIndex,
                        postOnly: sdk_1.PostOnlyParams.MUST_POST_ONLY,
                        triggerCondition: sdk_1.OrderTriggerCondition.ABOVE,
                        price,
                    });
                    this.driftClient.perpMarketLastSlotCache.set(marketConfig.marketIndex, slot);
                    instructions.push(await this.driftClient.getPlacePerpOrderIx(marketOrderParams));
                }
                return instructions;
            }
            catch { }
        };
        this.fetchPerpMarket = (symbol, marketIndex) => {
            return this.perpMarkets.find((market) => market.baseAssetSymbol === symbol || marketIndex === market.marketIndex);
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
    async printTopOfOrderLists(marketIndex, marketType) {
        const dlob = new sdk_1.DLOB();
        const market = this.driftClient.getPerpMarketAccount(marketIndex);
        const slot = await this.driftClient.connection.getSlot();
        const oraclePriceData = this.driftClient.getOracleDataForPerpMarket(marketIndex);
        const fallbackAsk = (0, sdk_1.calculateAskPrice)(market, oraclePriceData);
        const fallbackBid = (0, sdk_1.calculateBidPrice)(market, oraclePriceData);
        const bestAsk = dlob.getBestAsk(marketIndex, fallbackAsk, slot, marketType, oraclePriceData);
        const bestBid = dlob.getBestBid(marketIndex, fallbackBid, slot, marketType, oraclePriceData);
        return {
            bestAsk,
            bestBid,
        };
    }
}
exports.DriftMultiAsset = DriftMultiAsset;
//
// Utils
//
exports.RUN = ["ETH"];
// const bidSpread =
// (convertToNumber(bestBid, PRICE_PRECISION) /
//   convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
//   1) *
// 100.0;
// const askSpread =
// (convertToNumber(bestAsk, PRICE_PRECISION) /
//   convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
//   1) *
// 100.0;
// console.log(`Market ${sdkConfig.PERP_MARKETS[marketIndex].symbol} Orders`);
// console.log(
// `  Ask`,
// convertToNumber(bestAsk, PRICE_PRECISION).toFixed(4),
// `(${askSpread.toFixed(4)}%)`
// );
// console.log(`  Mid`, convertToNumber(mid, PRICE_PRECISION).toFixed(4));
// console.log(
// `  Bid`,
// convertToNumber(bestBid, PRICE_PRECISION).toFixed(4),
// `(${bidSpread.toFixed(4)}%)`
// );
