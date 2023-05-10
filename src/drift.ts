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
  OrderStatus,
  User,
  PostOnlyParams,
  UserMap,
  DLOBSubscriber,
  DLOB,
  calculateBidPrice,
  calculateAskPrice,
  getVammL2Generator,
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
      "processed",
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

    const user = new User({
      driftClient: this.driftClient,
      userAccountPublicKey: await this.driftClient.getUserAccountPublicKey(),
      accountSubscription: {
        type: "polling",
        accountLoader: this.bulkAccountLoader,
      },
    });

    await user.subscribe();

    this.slotSubscriber = new SlotSubscriber(connection);
    await this.slotSubscriber.subscribe();
  };

  public startBot = async (subAccount: number, symbol: string) => {
    let orders: Order = {
      bid: [],
      ask: [],
    };

    this.driftClient.switchActiveUser(subAccount);

    const oraclePriceData = this.fetchOraclePrice(symbol);
    const marketConfig = this.fetchPerpMarket(symbol);
    const marketAccount = this.driftClient.getPerpMarketAccount(
      marketConfig.marketIndex
    );

    const slot = this.slotSubscriber.getSlot();

    const dlob = new DLOB();
    const l2 = dlob.getL2({
      marketIndex: marketConfig.marketIndex,
      marketType: MarketType.PERP,
      depth: 10000,
      oraclePriceData,
      slot: slot,
      fallbackBid: calculateBidPrice(marketAccount, oraclePriceData),
      fallbackAsk: calculateAskPrice(marketAccount, oraclePriceData),
      fallbackL2Generators: [
        getVammL2Generator({
          marketAccount: marketAccount,
          oraclePriceData,
          numOrders: 10000,
        }),
      ],
    });

    console.log("********************************");

    const oraclePrice = convertToNumber(oraclePriceData.price);

    console.log(symbol);
    console.log("oraclePrice", oraclePrice);
    l2.bids.forEach((bid) => {
      const bidPrice = convertToNumber(bid.price);
      const dif = (oraclePrice - bidPrice) / 100;

      if (orders.bid.length > 14) {
        return;
      }

      if (dif < 0.5) {
        orders.bid.push(bid.price);
      }
    });

    l2.asks.forEach((ask) => {
      const askPrice = convertToNumber(ask.price);
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

  private openOrders = async (
    orders: Order,
    subAccount: number,
    symbol: string
  ) => {
    const marketConfig = this.fetchPerpMarket(symbol);
    const longInstructions: TransactionInstruction[] = [];
    const shortInstructions: TransactionInstruction[] = [];

    console.log("marketConfig", marketConfig.baseAssetSymbol);

    if (
      this.driftClient
        .getUserAccount()
        .orders.find((item) => item.marketIndex === marketConfig.marketIndex)
    ) {
      const cancelLongInstructions = await this.driftClient.getCancelOrdersIx(
        MarketType.PERP,
        marketConfig.marketIndex,
        PositionDirection.LONG
      );

      longInstructions.push(cancelLongInstructions);

      const cancelShortInstructions = await this.driftClient.getCancelOrdersIx(
        MarketType.PERP,
        marketConfig.marketIndex,
        PositionDirection.SHORT
      );

      shortInstructions.push(cancelShortInstructions);
    }

    // LONG
    const instructionPlaceLongOrders = await this.placeOrders(
      orders.bid,
      marketConfig,
      PositionDirection.LONG
    );
    if (instructionPlaceLongOrders?.length > 0) {
      longInstructions.push(...instructionPlaceLongOrders);
    }

    const longTransaction = new Transaction();
    longTransaction.instructions = longInstructions;

    await this.driftClient.sendTransaction(longTransaction);

    // SHORT
    const instructionPlaceShortOrders = await this.placeOrders(
      orders.ask,
      marketConfig,
      PositionDirection.SHORT
    );
    if (instructionPlaceShortOrders?.length > 0) {
      shortInstructions.push(...instructionPlaceShortOrders);
    }

    const shortTransaction = new Transaction();
    shortTransaction.instructions = shortInstructions;

    await this.driftClient.sendTransaction(shortTransaction);

    console.log(`DONE ${symbol}`);

    console.log("GENERAL DONE");

    await sleep(1000);

    console.log("RESTART");

    this.startBot(subAccount, symbol);
  };

  private placeOrders = async (
    orders: BN[],
    marketConfig: PerpMarketConfig,
    direction: PositionDirection
  ) => {
    const instructions = [];
    for (let i = 0; i < orders.length; i++) {
      const price = orders[i];

      const perpMarketPrice = this.driftClient.getPerpMarketAccount(
        marketConfig.marketIndex
      );

      const marketOrderParams = getLimitOrderParams({
        baseAssetAmount: ORDER_SIZE[marketConfig.baseAssetSymbol],
        direction: direction,
        marketIndex: perpMarketPrice.marketIndex,
        postOnly: PostOnlyParams.MUST_POST_ONLY,
        triggerCondition: OrderTriggerCondition.ABOVE,
        price: price,
      });

      const instructionPlaceOrder = await this.driftClient.getPlacePerpOrderIx(
        marketOrderParams
      );

      instructions.push(instructionPlaceOrder);
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
}

//
// Utils
//

export const SUB_ACCOUNTS: { [key: string]: number } = {
  SOL: 0,
  BTC: 1,
  ETH: 2,
  MATIC: 3,
  "1MBONK": 4,
  APT: 5,
  ARB: 6,
  BNB: 7,
};

const ORDER_SIZE: { [key: string]: BN } = {
  SOL: QUOTE_PRECISION.mul(new BN(3500)),
  BTC: new BN(500000),
  ETH: new BN(50000000),
  APT: new BN(8000000000),
  "1MBONK": new BN(50000000000),
  MATIC: new BN(40000000000),
  ARB: new BN(40000000000),
  DOGE: new BN(100000000000),
  BNB: new BN(100000000),
};

interface Order {
  bid: BN[];
  ask: BN[];
}
