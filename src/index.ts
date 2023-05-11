import { Drift, RUN } from "./drift";
import { crash } from "./utils/alerts";
import sleep from "./utils/sleep";

const drift = new Drift(process.env.ACCOUNT);

const initBots = async () => {
  let i = 0;

  while (true) {
    await drift.startBot(RUN[i]);

    console.log("Sleeping for 2 seconds...");

    await sleep(2000);

    i++;

    if (i === RUN.length) {
      i = 0;

      console.log("STARTED ALL BOTS, RESTARTING...");
      await sleep(8000);
    }
  }
};

const setup = async () => {
  try {
    await drift.setup();

    initBots();
  } catch {
    initBots();
  }
};

setup();
