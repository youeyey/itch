import { Cave, CaveSummary } from "../buse/messages";
import { Instance, RequestError, IRequestCreator, Client } from "node-buse";
import rootLogger, { Logger } from "../logger/index";
const lazyDefaultLogger = rootLogger.child({ name: "buse" });
import { MinimalContext } from "../context/index";
import * as ospath from "path";

import * as messages from "./messages";
import { butlerDbPath } from "../os/paths";
import urls from "../constants/urls";
import { getRootState } from "../store/get-root-state";

// TODO: pass server URL to butler

export async function makeButlerInstance(): Promise<Instance> {
  const butlerPkg = getRootState().broth.packages["butler"];
  if (!butlerPkg) {
    throw new Error(
      `Cannot make butler instance: package 'butler' not registered`
    );
  }

  const versionPrefix = butlerPkg.versionPrefix;
  if (!versionPrefix) {
    throw new Error(`Cannot make butler instance: no version prefix`);
  }

  return makeButlerInstanceWithPrefix(versionPrefix);
}

export async function makeButlerInstanceWithPrefix(
  versionPrefix: string
): Promise<Instance> {
  return new Instance({
    butlerExecutable: ospath.join(versionPrefix, "butler"),
    args: ["--dbpath", butlerDbPath(), "--address", urls.itchio],
  });
}

type WithCB<T> = (client: Client) => Promise<T>;

export async function withButlerClient<T>(
  parentLogger: Logger,
  cb: WithCB<T>
): Promise<T> {
  let res: T;
  const instance = await makeButlerInstance();
  const client = await instance.getClient();
  setupLogging(client, parentLogger);

  let err: Error;
  try {
    res = await cb(client);
  } catch (e) {
    console.error(`Caught butler error: ${e.stack}`);
    const re = asRequestError(e);
    if (re && re.rpcError && re.rpcError.data) {
      console.error(`Golang stack:\n${re.rpcError.data.stack}`);
    }
    err = e;
  } finally {
    instance.cancel();
  }

  if (err) {
    throw err;
  }
  return res;
}

type Call = <Params, Res>(
  rc: IRequestCreator<Params, Res>,
  params: Params,
  setup?: (client: Client) => void
) => Promise<Res>;

export let call: Call;

call = async function<Params, Res>(
  rc: IRequestCreator<Params, Res>,
  params: Params,
  setup?: (client: Client) => void
): Promise<Res> {
  return await callInternal(lazyDefaultLogger, rc, params, setup);
};

export const withLogger = (logger: Logger) => async <Params, Res>(
  rc: IRequestCreator<Params, Res>,
  params: Params,
  setup?: (client: Client) => void
): Promise<Res> => {
  return await callInternal(logger, rc, params, setup);
};

async function callInternal<Params, Res>(
  logger: Logger,
  rc: IRequestCreator<Params, Res>,
  params: Params,
  setup?: (client: Client) => void
): Promise<Res> {
  return await withButlerClient(logger, async client => {
    if (setup) {
      setup(client);
    }
    return await client.call(rc, params);
  });
}

export function setupClient(
  client: Client,
  parentLogger: Logger,
  ctx: MinimalContext
) {
  client.onNotification(messages.Progress, ({ params }) => {
    ctx.emitProgress(params);
  });

  setupLogging(client, parentLogger);
}

export function setupLogging(client: Client, logger: Logger) {
  client.onWarning(msg => {
    logger.warn(`(buse) ${msg}`);
  });

  client.onNotification(messages.Log, ({ params }) => {
    switch (params.level) {
      case "debug":
        logger.debug(params.message);
        break;
      case "info":
        logger.info(params.message);
        break;
      case "warning":
        logger.warn(params.message);
        break;
      case "error":
        logger.error(params.message);
        break;
      default:
        logger.info(`[${params.level}] ${params.message}`);
        break;
    }
  });
}

export function getCaveSummary(cave: Cave): CaveSummary {
  return {
    id: cave.id,
    gameId: cave.game.id,
    lastTouchedAt: cave.stats.lastTouchedAt,
    secondsRun: cave.stats.secondsRun,
    installedSize: cave.installInfo.installedSize,
  };
}

export function getErrorMessage(e: any): string {
  if (!e) {
    return "Unknown error";
  }

  // TODO: this is a good place to do i18n on buse error codes!

  let errorMessage = e.message;
  const re = e.rpcError;
  if (re) {
    if (re.message) {
      // use just the json-rpc message if possible
      errorMessage = re.message;
    }
  }
  return errorMessage;
}

export function isInternalError(e: any): boolean {
  const re = asRequestError(e);

  if (!re) {
    return true;
  }

  if (re.rpcError.code < 0) {
    return true;
  }
  return false;
}

export function getErrorStack(e: any): string {
  if (!e) {
    return "Unknown error";
  }

  let errorStack = e.stack;

  const re = asRequestError(e);
  if (re) {
    if (re.rpcError.data && re.rpcError.data.stack) {
      // use golang stack if available
      errorStack = re.rpcError.data.stack;
    } else if (re.message) {
      // or just message
      errorStack = re.message;
    }
  }
  return errorStack;
}

export function asRequestError(e: any): RequestError {
  const re = e as RequestError;
  if (re.rpcError) {
    return e as RequestError;
  }
  return null;
}