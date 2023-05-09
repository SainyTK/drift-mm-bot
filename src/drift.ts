import {
  initialize,
  Wallet,
  DriftClient,
  getMarketsAndOraclesForSubscription,
  BulkAccountLoader,
  User,
  DriftEnv,
  PerpMarkets,
  convertToNumber,
  SlotSubscriber,
  MarketType,
  DLOB,
  getVammL2Generator,
  calculateBidPrice,
  calculateAskPrice,
  PerpMarketAccount,
  PRICE_PRECISION,
  PositionDirection,
  PerpMarketConfig,
  L2OrderBook,
  calculateEstimatedPerpEntryPrice,
  getLimitOrderParams,
  BASE_PRECISION,
  calculateBidAskPrice,
  QUOTE_PRECISION,
  OrderStatus,
} from "@drift-labs/sdk";
import { AnchorProvider, BN } from "@project-serum/anchor";
import { convertSecretKeyToKeypair } from "@slidelabs/solana-toolkit/build/utils/convertSecretKeyToKeypair";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { connection, env } from "./config/solanaConnection";
import { logger } from "./utils/logger";
import sleep from "./utils/sleep";

export class Drift {
  public env: DriftEnv = env;
  public connection = connection;
  public anchorProvider: AnchorProvider;
  public sdkConfig = initialize({ env: this.env });
  public driftPublicKey = new PublicKey(this.sdkConfig.DRIFT_PROGRAM_ID);
  public perpMarkets = PerpMarkets[this.env];
  public driftClient: DriftClient;
  public user: User;
  public readonly defaultIntervalMs: number = 5000;
  public marketAccount: PerpMarketAccount;
  public currentSlot: number = 0;

  private slotSubscriber: SlotSubscriber;
  private account: Keypair;
  private wallet: Wallet;
  private bulkAccountLoader: BulkAccountLoader;
  private botAccount: string;
  private botName = process.env.BOT_NAME;
  private runingTransaction = false;
  private marketIndex: number = 0;

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
      "confirmed",
      1000
    );
    const { oracleInfos, perpMarketIndexes, spotMarketIndexes } =
      getMarketsAndOraclesForSubscription(this.env);
    this.driftClient = new DriftClient({
      connection: this.connection,
      wallet: this.anchorProvider.wallet,
      programID: this.driftPublicKey,
      perpMarketIndexes,
      spotMarketIndexes,
      oracleInfos,
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

    this.initBot();
  };

  async initBot() {
    logger.info(`${this.botName} initing`);

    this.slotSubscriber.eventEmitter.on("newSlot", async (slot) => {
      const dlob = new DLOB();

      if (this.marketIndex === 5) {
        this.marketIndex = 0;
      }

      this.marketAccount = this.driftClient.getPerpMarketAccount(
        this.marketIndex
      );

      const oraclePriceData = this.driftClient.getOraclePriceDataAndSlot(
        this.marketAccount.amm.oracle
      );

      const l2 = dlob.getL2({
        marketIndex: this.marketIndex,
        marketType: MarketType.PERP,
        depth: 3,
        oraclePriceData: oraclePriceData.data,
        slot: slot,
        fallbackBid: calculateBidPrice(
          this.marketAccount,
          oraclePriceData.data
        ),
        fallbackAsk: calculateAskPrice(
          this.marketAccount,
          oraclePriceData.data
        ),
        fallbackL2Generators: [
          getVammL2Generator({
            marketAccount: this.marketAccount,
            oraclePriceData: oraclePriceData.data,
            numOrders: 3,
          }),
        ],
      });

      this.updateOpenOrdersForMarket(this.marketAccount, l2);
      this.marketIndex += 1;
    });
  }

  private async updateOpenOrdersForMarket(
    marketAccount: PerpMarketAccount,
    orders: L2OrderBook
  ) {
    const marketIndex = marketAccount.marketIndex;
    const marketConfig = this.fetchPerpMarket(marketIndex);

    // LONG
    const longInstructions = [];
    if (
      this.driftClient
        .getUserAccount()
        .orders.filter((item) => item.marketIndex === marketIndex).length > 0
    ) {
      const instructionCancelLongOrders =
        await this.driftClient.getCancelOrdersIx(
          MarketType.PERP,
          marketIndex,
          PositionDirection.LONG
        );

      longInstructions.push(instructionCancelLongOrders);
    }

    for (let i = 0; i < orders.bids.length; i++) {
      const order = orders.bids[i];

      console.log(convertToNumber(order.price, PRICE_PRECISION));
      const perpMarketPrice =
        this.driftClient.getPerpMarketAccount(marketIndex);

      const marketOrderParams = getLimitOrderParams({
        baseAssetAmount: ORDER_SIZE[marketIndex],
        direction: PositionDirection.LONG,
        marketIndex: perpMarketPrice.marketIndex,
        price: order.price,
      });

      const instructionPlaceOrder = await this.driftClient.getPlacePerpOrderIx(
        marketOrderParams
      );
      longInstructions.push(instructionPlaceOrder);
    }

    const transactionLong = new Transaction();
    transactionLong.instructions = longInstructions;

    const longTx = await this.driftClient.sendTransaction(transactionLong);

    const longBlock = await this.connection.getLatestBlockhash();

    await connection.confirmTransaction(
      {
        signature: longTx.txSig,
        blockhash: longBlock.blockhash,
        lastValidBlockHeight: longBlock.lastValidBlockHeight,
      },
      "processed"
    );

    console.log(`NEW LONG ORDERS SUBMITTED - ${marketConfig.symbol}`);

    // SHORT
    const shortInstructions = [];
    if (
      this.driftClient
        .getUserAccount()
        .orders.filter((item) => item.marketIndex === marketIndex).length > 0
    ) {
      try {
        const instructionCancelOrders =
          await this.driftClient.getCancelOrdersIx(
            MarketType.PERP,
            marketIndex,
            PositionDirection.SHORT
          );

        shortInstructions.push(instructionCancelOrders);
      } catch {}
    }

    for (let i = 0; i < orders.asks.length; i++) {
      const order = orders.asks[i];

      console.log(convertToNumber(order.price, PRICE_PRECISION));

      const perpMarketPrice =
        this.driftClient.getPerpMarketAccount(marketIndex);

      const marketOrderParams = getLimitOrderParams({
        baseAssetAmount: ORDER_SIZE[marketIndex],
        direction: PositionDirection.SHORT,
        marketIndex: perpMarketPrice.marketIndex,
        price: order.price,
      });

      const instructionPlaceOrder = await this.driftClient.getPlacePerpOrderIx(
        marketOrderParams
      );
      shortInstructions.push(instructionPlaceOrder);
    }

    const stTransaction = new Transaction();
    stTransaction.instructions = shortInstructions;

    const tx = await this.driftClient.sendTransaction(stTransaction);

    const stBlock = await this.connection.getLatestBlockhash();

    await connection.confirmTransaction(
      {
        signature: tx.txSig,
        blockhash: stBlock.blockhash,
        lastValidBlockHeight: stBlock.lastValidBlockHeight,
      },
      "processed"
    );
    console.log(`NEW SHORT ORDERS SUBMITTED - ${marketConfig.symbol}`);
  }

  fetchPerpMarket = (marketIndex: number) => {
    return this.perpMarkets.find(
      (market) => market.marketIndex === marketIndex
    );
  };

  fetchPrice = (marketIndex: number) => {
    try {
      const marketInfo = this.fetchPerpMarket(marketIndex);

      if (!marketInfo) return null;

      const perpMarketPrice = this.driftClient.getPerpMarketAccount(
        marketInfo.marketIndex
      );

      if (!perpMarketPrice) return null;

      const oraclePriceData = this.fetchOraclePrice(marketIndex);

      const bidAskPrice = calculateBidAskPrice(
        perpMarketPrice.amm,
        oraclePriceData
      );

      return [convertToNumber(bidAskPrice[0]), convertToNumber(bidAskPrice[1])];
    } catch {}
  };

  fetchOraclePrice = (marketIndex: number) => {
    try {
      const makertInfo = this.fetchPerpMarket(marketIndex);

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

const ORDER_SIZE: { [key: number]: BN } = {
  0: QUOTE_PRECISION.mul(new BN(2500)), // SOL
  1: new BN(2000000), // BTC
  2: new BN(20000000), // ETH
  3: new BN(5500000000), // APT
  4: new BN(30000000000), // 1MBONK
  // 5: new BN(10000000000), // MATIC
  // 6: new BN(10000000000), //  ARB
  // 7: new BN(100000000000), // DOGE
  // 8: new BN(100000000), // BNB
};

export type TOKENS =
  | "BONK"
  | "USDC"
  | "SOL"
  | "ETH"
  | "BTC"
  | "APT"
  | "1MBONK"
  | "ARB"
  | "DOGE"
  | "BNB";
