import {
  initialize,
  Wallet,
  DriftClient,
  getMarketsAndOraclesForSubscription,
  BulkAccountLoader,
  DriftEnv,
  PerpMarkets,
  convertToNumber,
  MarketType,
  PositionDirection,
  PerpMarketConfig,
  getLimitOrderParams,
  calculateBidAskPrice,
  QUOTE_PRECISION,
  OrderTriggerCondition,
  User,
  PostOnlyParams,
  calculateAskPrice,
  DLOB,
  calculateBidPrice,
  calculateEstimatedPerpEntryPrice,
  PRICE_PRECISION,
  calculatePositionPNL,
  OrderStatus,
  OrderType,
} from "@drift-labs/sdk";
import { AnchorProvider, BN } from "@project-serum/anchor";
import { convertSecretKeyToKeypair } from "@slidelabs/solana-toolkit/build/utils/convertSecretKeyToKeypair";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { connection, env } from "./config/solanaConnection";
import { postion } from "./utils/alerts";
import { logger } from "./utils/logger";

export class DriftMultiAsset {
  public env: DriftEnv = env;
  public connection = connection;
  public anchorProvider: AnchorProvider;
  public sdkConfig = initialize({ env: this.env });
  public driftPublicKey = new PublicKey(this.sdkConfig.DRIFT_PROGRAM_ID);
  public perpMarkets = PerpMarkets[this.env];
  public driftClient: DriftClient;

  private account: Keypair;
  private wallet: Wallet;
  private bulkAccountLoader: BulkAccountLoader;
  private botAccount: string;
  private user: User;

  constructor(botAccount: string) {
    this.botAccount = botAccount;
  }

  public setup = async () => {
    this.account = convertSecretKeyToKeypair(this.botAccount);
    this.wallet = new Wallet(this.account);

    this.anchorProvider = new AnchorProvider(
      this.connection,
      this.wallet,
      AnchorProvider.defaultOptions()
    );

    this.bulkAccountLoader = new BulkAccountLoader(
      this.connection,
      "confirmed",
      1000
    );

    this.driftClient = new DriftClient({
      connection: this.connection,
      wallet: this.anchorProvider.wallet,
      programID: this.driftPublicKey,
      ...getMarketsAndOraclesForSubscription(this.env),
      accountSubscription: {
        type: "polling",
        accountLoader: this.bulkAccountLoader,
      },
    });

    await this.driftClient.subscribe();

    this.user = new User({
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

  subscribeOrders = async () => {
    try {
      setInterval(() => {
        const activeOrders = this.driftClient
          .getUserAccount()
          .orders.filter((item) => item.orderId);

        activeOrders.forEach((order) => {
          const oraclePriceData = this.driftClient.getOracleDataForPerpMarket(
            order.marketIndex
          );

          const direction = order.direction as {
            long: {};
            short: {};
          };

          if (direction.long) {
            const bidSpread =
              (convertToNumber(oraclePriceData.price, PRICE_PRECISION) /
                convertToNumber(order.price, PRICE_PRECISION) -
                1) *
              100.0;

            if (bidSpread < 0.008 || bidSpread > 0.1) {
              console.log("***************************");
              console.log(
                `${this.fetchPerpMarket(undefined, order.marketIndex).symbol}`
              );
              console.log(`OR${convertToNumber(oraclePriceData.price)}`);
              console.log(
                `BID CLOSED`,
                convertToNumber(order.price, PRICE_PRECISION).toFixed(4),
                `(${bidSpread.toFixed(4)}%)`
              );

              this.driftClient.cancelOrder(order.orderId);
              console.log("***************************\n");
            }
          }

          if (direction.short) {
            const askSpread =
              (convertToNumber(order.price, PRICE_PRECISION) /
                convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
                1) *
              100.0;

            if (askSpread < 0.008 || askSpread > 0.1) {
              console.log("***************************");
              console.log(`OR${convertToNumber(oraclePriceData.price)}`);
              console.log(
                `${this.fetchPerpMarket(undefined, order.marketIndex).symbol}`
              );
              console.log(
                `ASK CLOSED`,
                convertToNumber(order.price, PRICE_PRECISION).toFixed(4),
                `(${askSpread.toFixed(4)}%)`
              );
              this.driftClient.cancelOrder(order.orderId);
              console.log("***************************\n");
            }
          }
        });
      }, 1000);
    } catch (e) {
      console.log("errororor");
    }
  };

  public calcSpread = async (oraclePrice: BN, orderPrice: BN) => {}

  public startBot = async () => {
    const orders: Order = {};

    let i = 0;

    while (true) {
      const symbol = RUN[i];
      const marketConfig = this.fetchPerpMarket(symbol);
      const perpPosition = this.user.getPerpPosition(marketConfig.marketIndex);
      const perpMarketPrice = this.driftClient.getPerpMarketAccount(
        marketConfig.marketIndex
      );

      const oraclePriceData = this.fetchOraclePrice(symbol);

      if (perpPosition) {
        const unrealizedPnl = calculatePositionPNL(
          perpMarketPrice,
          perpPosition,
          false,
          oraclePriceData
        );

        if (
          convertToNumber(perpPosition.quoteEntryAmount) !== 0 &&
          (convertToNumber(unrealizedPnl) < 0 ||
            convertToNumber(unrealizedPnl) > 1)
        ) {
          await this.driftClient.closePosition(marketConfig.marketIndex);
        }
      }

      const { bestAsk, bestBid } = await this.printTopOfOrderLists(
        marketConfig.marketIndex,
        MarketType.PERP
      );

      const firstPercentage = new BN(1000).div(new BN(2));

      const firstBestBid = bestBid.add(
        bestBid.mul(firstPercentage).div(new BN(1000000))
      );
      const firstBestAsk = bestAsk.sub(
        bestAsk.mul(firstPercentage).div(new BN(1000000))
      );

      orders[symbol] = {
        bid: [firstBestBid],
        ask: [firstBestAsk],
      };

      i++;

      if (i === RUN.length) {
        i = 0;

        await this.openOrders(orders);
      }
    }
  };

  private openOrders = async (orders: Order) => {
    try {
      const instructions: TransactionInstruction[] = [];

      for (let i = 0; i < Object.keys(orders).length; i++) {
        const symbol = Object.keys(orders)[i];
        const order = orders[symbol];
        const marketConfig = this.fetchPerpMarket(symbol);

        const ordersAmount = this.driftClient
          .getUserAccount()
          .orders.filter(
            (item) =>
              item.marketIndex === marketConfig.marketIndex && item.orderId
          );

        if (ordersAmount.length >= 28) {
          continue;
        }

        instructions.push(
          ...(await this.placeOrders(
            order.bid,
            marketConfig,
            PositionDirection.LONG
          ))
        );

        instructions.push(
          ...(await this.placeOrders(
            order.ask,
            marketConfig,
            PositionDirection.SHORT
          ))
        );
      }

      if (instructions.length > 0) {
        const transaction = new Transaction();
        transaction.instructions = instructions;

        await this.driftClient.sendTransaction(transaction, undefined, {
          commitment: "processed",
        });
      }
    } catch {
      console.log("errororor");
    }
  };

  private placeOrders = async (
    prices: BN[],
    marketConfig: PerpMarketConfig,
    direction: PositionDirection
  ) => {
    const instructions: TransactionInstruction[] = [];

    for (let i = 0; i < prices.length; i++) {
      const price = prices[i];
      const perpMarketPrice = this.driftClient.getPerpMarketAccount(
        marketConfig.marketIndex
      );

      let amount = MONEY;

      if (i === 0) {
        amount = MONEY * 2;
      }

      if (i === 1) {
        amount = MONEY * 4;
      }

      const slot = await this.connection.getSlot();
      const dblob = new DLOB();
      const perpPrice = calculateEstimatedPerpEntryPrice(
        "quote",
        new BN(amount * 10).mul(QUOTE_PRECISION),
        direction,
        perpMarketPrice,
        this.driftClient.getOracleDataForPerpMarket(
          perpMarketPrice.marketIndex
        ),
        dblob,
        slot
      );

      const marketOrderParams = getLimitOrderParams({
        baseAssetAmount: perpPrice.baseFilled,
        direction: direction,
        marketIndex: perpMarketPrice.marketIndex,
        postOnly: PostOnlyParams.MUST_POST_ONLY,
        triggerCondition: OrderTriggerCondition.ABOVE,
        price,
      });

      this.driftClient.perpMarketLastSlotCache.set(
        marketConfig.marketIndex,
        slot
      );

      instructions.push(
        await this.driftClient.getPlacePerpOrderIx(marketOrderParams)
      );
    }

    return instructions;
  };

  public fetchPerpMarket = (symbol: string, marketIndex?: number) => {
    return this.perpMarkets.find(
      (market) =>
        market.baseAssetSymbol === symbol || marketIndex === market.marketIndex
    );
  };

  public fetchPrice = (symbol: string) => {
    try {
      const marketInfo = this.fetchPerpMarket(symbol);

      if (!marketInfo) return null;

      const perpMarketPrice = this.driftClient.getPerpMarketAccount(
        marketInfo.marketIndex
      );

      if (!perpMarketPrice) return null;

      const oraclePriceData = this.fetchOraclePrice(symbol);

      const bidAskPrice = calculateBidAskPrice(
        perpMarketPrice.amm,
        oraclePriceData
      );

      return [bidAskPrice[0], bidAskPrice[1]];
    } catch {}
  };

  public fetchOraclePrice = (symbol: string) => {
    try {
      const makertInfo = this.fetchPerpMarket(symbol);

      if (!makertInfo) return null;

      return this.driftClient.getOracleDataForPerpMarket(
        makertInfo.marketIndex
      );
    } catch {
      return null;
    }
  };

  public async printTopOfOrderLists(
    marketIndex: number,
    marketType: MarketType
  ) {
    const dlob = new DLOB();
    const market = this.driftClient.getPerpMarketAccount(marketIndex);

    const slot = await this.driftClient.connection.getSlot();
    const oraclePriceData =
      this.driftClient.getOracleDataForPerpMarket(marketIndex);
    const fallbackAsk = calculateAskPrice(market, oraclePriceData);
    const fallbackBid = calculateBidPrice(market, oraclePriceData);

    const bestAsk = dlob.getBestAsk(
      marketIndex,
      fallbackAsk,
      slot,
      marketType,
      oraclePriceData
    );
    const bestBid = dlob.getBestBid(
      marketIndex,
      fallbackBid,
      slot,
      marketType,
      oraclePriceData
    );

    return {
      bestAsk,
      bestBid,
    };
  }
}

//
// Utils
//

const MONEY = 4;

export const RUN = ["SOL"];

interface Order {
  [key: string]: {
    bid: BN[];
    ask: BN[];
  };
}

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
