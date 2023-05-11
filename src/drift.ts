import {
  initialize,
  Wallet,
  DriftClient,
  getMarketsAndOraclesForSubscription,
  BulkAccountLoader,
  DriftEnv,
  PerpMarkets,
  convertToNumber,
  SlotSubscriber,
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
import sleep from "./utils/sleep";
import { postion } from "./utils/alerts";

export class Drift {
  public env: DriftEnv = env;
  public connection = connection;
  public anchorProvider: AnchorProvider;
  public sdkConfig = initialize({ env: this.env });
  public driftPublicKey = new PublicKey(this.sdkConfig.DRIFT_PROGRAM_ID);
  public perpMarkets = PerpMarkets[this.env];
  public driftClient: DriftClient;

  private slotSubscriber: SlotSubscriber;
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

    this.slotSubscriber = new SlotSubscriber(connection);
    await this.slotSubscriber.subscribe();
  };

  public startBot = async (symbol: string) => {
    try {
      const orders: Order = {};

      const marketConfig = this.fetchPerpMarket(symbol);
      const perpPosition = this.user.getPerpPosition(marketConfig.marketIndex);

      const unrealizedPnl = this.user.getUnrealizedPNL(
        false,
        marketConfig.marketIndex
      );

      let pnl = convertToNumber(unrealizedPnl);
      if (convertToNumber(perpPosition.settledPnl) !== 0) {
        pnl = convertToNumber(perpPosition.settledPnl.add(unrealizedPnl));
      }

      if (perpPosition && pnl > 2) {
        postion(symbol, convertToNumber(pnl));
      }

      if (
        perpPosition &&
        convertToNumber(perpPosition?.quoteEntryAmount) !== 0 &&
        pnl < 0
      ) {
        await this.driftClient.closePosition(marketConfig.marketIndex);
      }

      const oraclePriceData = this.fetchOraclePrice(symbol);

      const { bestAsk, bestBid } = this.printTopOfOrderLists(
        marketConfig.marketIndex,
        MarketType.PERP
      );

      const firstPercentage = new BN(PERCENT[symbol][0]);
      const firstBestBid = bestBid.add(
        bestBid.mul(firstPercentage).div(new BN("1000000"))
      );
      const firstBestAsk = bestAsk.sub(
        bestAsk.mul(firstPercentage).div(new BN("1000000"))
      );

      const secondPercentage = new BN(PERCENT[symbol][1]);
      const secondBestBid = bestBid.add(
        bestBid.mul(secondPercentage).div(new BN("1000000"))
      );
      const secondBestAsk = bestAsk.sub(
        bestAsk.mul(secondPercentage).div(new BN("1000000"))
      );

      console.log("********************************");
      console.log(symbol);
      console.log("ORC", convertToNumber(oraclePriceData.price));
      console.log("BID", convertToNumber(bestBid));
      console.log("1BID", convertToNumber(firstBestBid));
      console.log("2BID", convertToNumber(secondBestBid));
      console.log("ASK", convertToNumber(bestAsk));
      console.log("1ASK", convertToNumber(firstBestAsk));
      console.log("2ASK", convertToNumber(secondBestAsk));
      console.log("********************************");

      orders[symbol] = {
        bid: [firstBestBid, secondBestBid],
        ask: [firstBestAsk, secondBestAsk],
      };

      await this.openOrders(orders);
    } catch (err) {
      console.error(err);
    }
  };

  private openOrders = async (orders: Order) => {
    const instructions: TransactionInstruction[] = [];

    for (let i = 0; i < Object.keys(orders).length; i++) {
      const symbol = Object.keys(orders)[i];
      const order = orders[symbol];
      const marketConfig = this.fetchPerpMarket(symbol);

      if (
        this.driftClient
          .getUserAccount()
          .orders.find((item) => item.marketIndex === marketConfig.marketIndex)
      ) {
        instructions.push(
          await this.driftClient.getCancelOrdersIx(
            MarketType.PERP,
            marketConfig.marketIndex,
            PositionDirection.LONG
          )
        );

        instructions.push(
          await this.driftClient.getCancelOrdersIx(
            MarketType.PERP,
            marketConfig.marketIndex,
            PositionDirection.SHORT
          )
        );
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

    const transaction = new Transaction();
    transaction.instructions = instructions;

    await this.driftClient.sendTransaction(transaction);
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

      const marketOrderParams = getLimitOrderParams({
        baseAssetAmount: ORDER_SIZE[marketConfig.baseAssetSymbol],
        direction: direction,
        marketIndex: perpMarketPrice.marketIndex,
        postOnly: PostOnlyParams.MUST_POST_ONLY,
        triggerCondition: OrderTriggerCondition.ABOVE,
        price,
      });

      instructions.push(
        await this.driftClient.getPlacePerpOrderIx(marketOrderParams)
      );
    }

    return instructions;
  };

  public fetchPerpMarket = (symbol: string) => {
    return this.perpMarkets.find((market) => market.baseAssetSymbol === symbol);
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

  public printTopOfOrderLists(marketIndex: number, marketType: MarketType) {
    const dlob = new DLOB();
    const market = this.driftClient.getPerpMarketAccount(marketIndex);

    const slot = this.slotSubscriber.getSlot();
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

const PERCENT: { [key: string]: BN[] } = {
  BTC: [new BN(2), new BN(4)],
  ETH: [new BN(2), new BN(4)],
  SOL: [new BN(50), new BN(100)],
  "1MBONK": [new BN(50), new BN(100)],
};

export const RUN = [
  "SOL",
  "BTC",
  "ETH",
  // "APT",
  "1MBONK",
  // "MATIC",
  // "ARB",
  // "DOGE",
  // "BNB",
];

const ORDER_SIZE: { [key: string]: BN } = {
  SOL: QUOTE_PRECISION.mul(new BN(14000)),
  BTC: new BN(10000000),
  ETH: new BN(100000000),
  "1MBONK": new BN(200000000000),
  // MATIC: new BN(40000000000),
  // ARB: new BN(40000000000),
  // DOGE: new BN(100000000000),
  // BNB: new BN(100000000),
  // APT: new BN(8000000000),
};

interface Order {
  [key: string]: {
    bid: BN[];
    ask: BN[];
  };
}

// 40% -> A - BIDE or ASK
// 30% -> B - BIDE or ASK
// 20% -> C - BIDE or ASK
// 10% -> D<>F - BIDE or ASK

// ORACLE = 20.60

// let i = 1

// bid = (oracle - (oracle - i/10))
// ask = (oracle - (oracle - i/10))

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
