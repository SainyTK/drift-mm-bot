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
} from "@drift-labs/sdk";
import { AnchorProvider, BN } from "@project-serum/anchor";
import { convertSecretKeyToKeypair } from "@slidelabs/solana-toolkit/build/utils/convertSecretKeyToKeypair";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { connection, env } from "./config/solanaConnection";
import { logger } from "./utils/logger";

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
      10000
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

    const dlob = new DLOB();

    setInterval(async () => {
      // if (this.marketIndex > 8) {
      //   this.marketIndex = 0;
      // }

      this.marketAccount = this.driftClient.getPerpMarketAccount(
        this.marketIndex
      );

      if (this.runingTransaction) return;

      const oraclePriceData = this.driftClient.getOraclePriceDataAndSlot(
        this.marketAccount.amm.oracle
      );
      const slot = this.slotSubscriber.getSlot();

      const l2 = dlob.getL2({
        marketIndex: this.marketIndex,
        marketType: MarketType.PERP,
        depth: 12,
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
            numOrders: 12,
          }),
        ],
      });

      console.log(l2.bids.length);
      this.updateOpenOrdersForMarket(this.marketAccount, l2);

      // this.marketIndex += 1;
    }, 5000);
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

    for (let i = 2; i < orders.bids.length; i++) {
      const oder = orders.bids[i];

      console.log(convertToNumber(oder.price, PRICE_PRECISION));
      const perpMarketPrice =
        this.driftClient.getPerpMarketAccount(marketIndex);

      const marketOrderParams = getLimitOrderParams({
        baseAssetAmount: BASE_PRECISION.mul(new BN(1)),
        direction: PositionDirection.LONG,
        marketIndex: perpMarketPrice.marketIndex,
        price: oder.price,
      });

      const instructionPlaceOrder = await this.driftClient.getPlacePerpOrderIx(
        marketOrderParams
      );
      longInstructions.push(instructionPlaceOrder);
    }

    this.runingTransaction = true;
    const transactionLong = new Transaction();
    transactionLong.instructions = longInstructions;

    const txLong = await this.driftClient.sendTransaction(transactionLong);

    const lbLong = await connection.getLatestBlockhash();

    await connection.confirmTransaction(
      {
        signature: txLong.txSig,
        blockhash: lbLong.blockhash,
        lastValidBlockHeight: lbLong.lastValidBlockHeight,
      },
      "finalized"
    );

    this.runingTransaction = false;
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

    for (let i = 2; i < orders.asks.length; i++) {
      const oder = orders.asks[i];

      console.log(convertToNumber(oder.price, PRICE_PRECISION));

      const perpMarketPrice =
        this.driftClient.getPerpMarketAccount(marketIndex);

      const marketOrderParams = getLimitOrderParams({
        baseAssetAmount: BASE_PRECISION.mul(new BN(1)),
        direction: PositionDirection.SHORT,
        marketIndex: perpMarketPrice.marketIndex,
        price: oder.price,
      });

      const instructionPlaceOrder = await this.driftClient.getPlacePerpOrderIx(
        marketOrderParams
      );
      shortInstructions.push(instructionPlaceOrder);
    }

    this.runingTransaction = true;
    const stTransaction = new Transaction();
    stTransaction.instructions = shortInstructions;

    const stTx = await this.driftClient.sendTransaction(stTransaction);

    const stLb = await connection.getLatestBlockhash();

    await connection.confirmTransaction(
      {
        signature: stTx.txSig,
        blockhash: stLb.blockhash,
        lastValidBlockHeight: stLb.lastValidBlockHeight,
      },
      "finalized"
    );

    this.runingTransaction = false;
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
