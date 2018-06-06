import { Watcher } from "common/util/watcher";

import { actions } from "common/actions";
import { manager } from "main/reactors/setup";
import { IStore } from "common/types";
import { t } from "common/format/t";
import { modalWidgets } from "renderer/components/modal-widgets";
import ospath from "path";
import childProcess from "child_process";
import { relaunchLogPath } from "common/util/paths";
import fs from "fs";

import rootLogger from "common/logger";
import { delay } from "./delay";
import { ISM } from "main/broth/itch-setup";
const logger = rootLogger.child({ name: "self-update" });

// 2 hours, * 60 = minutes, * 60 = seconds, * 1000 = millis
const UPDATE_INTERVAL = 2 * 60 * 60 * 1000;
const UPDATE_INTERVAL_WIGGLE = 0.2 * 60 * 60 * 1000;

export default function(watcher: Watcher) {
  watcher.on(actions.tick, async (store, action) => {
    const rs = store.getState();
    const { nextComponentsUpdateCheck } = rs.systemTasks;

    let componentCheckPastDue = Date.now() > nextComponentsUpdateCheck;
    let setupDone = rs.setup.done;

    let shouldUpdateNow = setupDone && componentCheckPastDue;
    if (!shouldUpdateNow) {
      return;
    }

    rescheduleComponentsUpdate(store);
    store.dispatch(actions.checkForComponentUpdates({}));
  });

  watcher.on(actions.checkForComponentUpdates, async (store, action) => {
    rescheduleComponentsUpdate(store);
    await manager.upgrade();
  });

  watcher.on(actions.relaunchRequest, async (store, action) => {
    const rs = store.getState();
    const pkg = rs.broth.packages[rs.system.appName];
    if (pkg.stage !== "need-restart") {
      return;
    }
    const version = pkg.availableVersion;
    const restart = t(rs.i18n, ["prompt.self_update_ready.action.restart"]);

    store.dispatch(
      actions.openModal(
        modalWidgets.naked.make({
          window: "root",
          title: ["prompt.self_update.title", { version }],
          message: ["prompt.self_update_ready.message", { restart }],
          buttons: [
            {
              label: ["prompt.self_update_ready.action.restart"],
              action: actions.relaunch({}),
            },
            {
              label: ["prompt.self_update_ready.action.snooze"],
              action: actions.closeModal({ window: "root" }),
            },
          ],
          widgetParams: null,
        })
      )
    );
  });

  watcher.on(actions.relaunch, async (store, action) => {
    const rs = store.getState();
    const pkg = rs.broth.packages["itch-setup"];
    if (pkg.stage !== "idle") {
      logger.warn(`itch-setup: wanted pkg stage idle but got '${pkg.stage}'`);
      return;
    }

    const prefix = pkg.versionPrefix;
    if (!prefix) {
      logger.warn(`itch-setup: no prefix (not installed yet?)`);
      return;
    }

    const command = ospath.join(prefix, "itch-setup");
    const args: string[] = [
      "--appname",
      rs.system.appName,
      "--relaunch",
      "--relaunch-pid",
      `${process.pid}`,
    ];

    const stdio: any[] = ["ignore", "ignore", "ignore"];
    try {
      fs.unlinkSync(relaunchLogPath());
    } catch (e) {}

    let out = -1;
    let err = -1;
    const logPath = relaunchLogPath();
    try {
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
      out = fs.openSync(logPath, "a");
      stdio[1] = out;
      err = fs.openSync(logPath, "a");
      stdio[2] = err;
    } catch (e) {
      logger.warn(`Could not set up stdout/stderr for relaunch: ${e.stack}`);
      if (out != -1) {
        fs.closeSync(out);
      }
      if (err != -1) {
        fs.closeSync(err);
      }
    }
    const child = childProcess.spawn(command, args, {
      stdio,
      detached: true,
    });
    child.unref();

    for (let i = 0; i < 30; i++) {
      try {
        const file = fs.readFileSync(logPath, { encoding: "utf8" });
        const tokens = file.split("\n");
        for (const tok of tokens) {
          try {
            const msg = JSON.parse(tok) as ISM;
            if (msg.type === "ready-to-relaunch") {
              logger.info(`itch-setup is ready to relaunch!`);
              store.dispatch(actions.quit({}));
              return;
            }
          } catch (e) {
            // ignore
          }
        }
      } catch (e) {
        logger.warn(`While polling itch-setup log: ${e.stack}`);
      }
      await delay(250);
    }
  });

  watcher.on(actions.viewChangelog, async (store, action) => {
    // TODO: re-implement me
  });
}

function rescheduleComponentsUpdate(store: IStore) {
  const sleepTime = UPDATE_INTERVAL + Math.random() + UPDATE_INTERVAL_WIGGLE;
  store.dispatch(
    actions.scheduleSystemTask({
      nextComponentsUpdateCheck: Date.now() + sleepTime,
    })
  );
}
