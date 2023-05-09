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
  private currentSymbolIndex: number = 0;

  constructor(botAccount: string) {
    this.botAccount = botAccount;
  }

  setup = async () => {
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
      500
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

    // this.initBot();
  };

  async initBot() {
    console.log("NEW ORDERS");
    let orders: Order = {};

    for (
      this.currentSymbolIndex = 0;
      this.currentSymbolIndex < 7;
      this.currentSymbolIndex++
    ) {
      const symbol = TOKENS[this.currentSymbolIndex];
      const marketConfig = this.fetchPerpMarket(
        TOKENS[this.currentSymbolIndex]
      );

      if (!orders[marketConfig.baseAssetSymbol]) {
        orders[marketConfig.baseAssetSymbol] = {
          bid: [],
          ask: [],
        };
      }

      // while (orders[marketConfig.baseAssetSymbol]?.bid.length < 2) {
      const currentPrice = this.fetchPrice(symbol);
      const oraclePrice = this.fetchOraclePrice(symbol);

      console.log("----------------------");
      console.log("Symbol", symbol);
      console.log("BID", convertToNumber(currentPrice[0]));
      console.log("ASK", convertToNumber(currentPrice[1]));
      console.log("OraclePrice", convertToNumber(oraclePrice.price));
      console.log("----------------------");

      orders[marketConfig.baseAssetSymbol].bid.push(currentPrice[0]);
      orders[marketConfig.baseAssetSymbol].ask.push(currentPrice[1]);
      // }
    }

    if (this.currentSymbolIndex === 7) {
      this.openOrders(orders);
      orders = {};
    }
  }

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

  private openOrders = async (orders: Order) => {
    for (let i = 0; i < Object.keys(orders).length; i++) {
      const symbol = Object.keys(orders)[i];
      const marketConfig = this.fetchPerpMarket(symbol);
      const instructions: TransactionInstruction[] = [];

      if (
        this.driftClient
          .getUserAccount()
          .orders.find((item) => item.marketIndex === marketConfig.marketIndex)
      ) {
        const longInstructions = await this.driftClient.getCancelOrdersIx(
          MarketType.PERP,
          marketConfig.marketIndex,
          PositionDirection.LONG
        );

        instructions.push(longInstructions);

        const shortInstructions = await this.driftClient.getCancelOrdersIx(
          MarketType.PERP,
          marketConfig.marketIndex,
          PositionDirection.SHORT
        );

        instructions.push(shortInstructions);
      }

      // LONG
      const instructionPlaceLongOrders = await this.placeOrders(
        orders[symbol].bid,
        marketConfig,
        PositionDirection.LONG
      );
      if (instructionPlaceLongOrders?.length > 0) {
        instructions.push(...instructionPlaceLongOrders);
      }

      // SHORT
      const instructionPlaceShortOrders = await this.placeOrders(
        orders[symbol].ask,
        marketConfig,
        PositionDirection.SHORT
      );
      if (instructionPlaceShortOrders?.length > 0) {
        instructions.push(...instructionPlaceShortOrders);
      }

      const transaction = new Transaction();
      transaction.instructions = instructions;

      await this.driftClient.sendTransaction(transaction, undefined, {
        commitment: "processed",
      });

      console.log(`DONE ${symbol}`);
    }

    console.log("GENERAL DONE");
    this.currentSymbolIndex = 0;
    await sleep(2000);
    this.initBot();
  };

  fetchPerpMarket = (symbol: string) => {
    return this.perpMarkets.find((market) => market.baseAssetSymbol === symbol);
  };

  fetchPrice = (symbol: string) => {
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

  fetchOraclePrice = (symbol: string) => {
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

const TOKENS = ["SOL", "BTC", "ETH", "APT", "1MBONK", "MATIC", "ARB"];

const ORDER_SIZE: { [key: string]: BN } = {
  SOL: QUOTE_PRECISION.mul(new BN(15000)),
  BTC: new BN(600000),
  ETH: new BN(50000000),
  APT: new BN(5000000000),
  "1MBONK": new BN(50000000000),
  MATIC: new BN(40000000000),
  ARB: new BN(40000000000),
  DOGE: new BN(100000000000),
  BNB: new BN(100000000),
};

interface Order {
  [key: string]: { bid: BN[]; ask: BN[] };
}
