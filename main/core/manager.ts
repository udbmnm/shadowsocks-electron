import electronIsDev from "electron-is-dev";
import { EventEmitter } from "events";
import os from 'os';

import logger, { info, warning } from "../logs";

import checkPortInUse from "./helpers/port-checker";
import { SocketTransfer } from './socket-transfer';
import { SSClient, SSRClient } from "./client";
import pickPorts from "./helpers/port-picker";
import { Proxy } from "./proxy";
import randomPicker from "./helpers/random-picker";
import { Target } from "./LoadBalancer/types";
import { Config, Settings } from "../types/extention";

const platform = os.platform();

export class Manager {
  static mode: 'single' | 'cluster' = 'single'; // running mode
  static proxy: Proxy | null; // proxy
  static ssLocal: SSRClient | SSClient | null; // single mode client
  static pool: (SSRClient | SSClient)[] = []; // cluster clients pool
  static socketTransfer: SocketTransfer | null; // cluster tcp gateway
  static clusterConfig: Config[]; // cluster server configs
  static event: EventEmitter = new EventEmitter(); // event center
  static deadMap: { [key: string]: number } = {}; // dead client records
  static heartbeat: number = 60e3;
  static trafficTimer: NodeJS.Timer;

  static syncConnected(connected: boolean) {
    if ((global as any)?.win?.webContents) {
      (global as any).win.webContents.send("connected", {
        status: connected,
        mode: Manager.mode
      });
    }
  }

  static syncTraffic() {
    if ((global as any)?.win?.webContents && Manager.socketTransfer) {
      (global as any)?.win.webContents.send("traffic", {
        traffic: Manager.socketTransfer.bytesTransfer
      });
    }
  }

  /**
   * @name healCluster heal unhealthy cluster nodes
   * @param targets ports group that need to be healed
   * @returns Promise<void>
   *
   * total steps:
   *  - get healthy/unhealthy cluster nodes
   *  - set healthy cluster nodes to pool / socket transfer
   *  - disconnect unhealthy cluster nodes
   *  - recreate some nodes from configs
   *  - connect those nodes
   *  - put connected new nodes socket into socket-transfer and pool, failed nodes only put into pool
   */
  static async healCluster(targets: Target[]) {
    const abnormalPorts: (number | string)[] = [];
    const abnormalClients: (SSRClient | SSClient)[] = [];
    const normalOrDeadClients: (SSRClient | SSClient)[] = [];
    const deadTargets: string[] = [];

    targets.forEach(target => {
      if (Manager.deadMap[target.confId as string] !== undefined) {
        // when healed over than 3 times, make it be dead, reduce system resources.
        if (Manager.deadMap[target.confId as string] > 3) {
          deadTargets.push(target.confId);
        } else {
          abnormalPorts.push(target.id);
          Manager.deadMap[target.confId as string] += 1;
        }
      } else {
        Manager.deadMap[target.confId as string] = 1;
        abnormalPorts.push(target.id)
      }
    });

    /* get healthy/unhealthy cluster nodes */
    Manager.pool.forEach(client => {
      if (
        (!deadTargets.includes(client.config.id)) &&
        (abnormalPorts.includes(client.settings.localPort) || !client.connected)
      ) {
        abnormalClients.push(client);
      } else {
        normalOrDeadClients.push(client);
      }
    });

    info.bold(
      '>> abnormal client that need to heal: ',
      abnormalClients.map(client => client.settings.localPort)
    );

    info.underline(
      `>> ${normalOrDeadClients.length} normal or dead client: `,
      normalOrDeadClients.map(client => client.settings.localPort)
    );

    warning('>> dead client map: ', JSON.stringify(Manager.deadMap, null, 2));

    if (!abnormalClients.length) return;

    /* set healthy cluster nodes to pool / socket transfer */
    Manager.pool = normalOrDeadClients;
    Manager.socketTransfer?.setTargetsWithFilter((target) => {
      return !abnormalPorts.includes(target.id);
    });

    /* disconnect unhealthy cluster nodes */
    return Promise
      .all(abnormalClients.map(client => client.disconnect()))
      .then((results) => {
        const pendingClients: (SSRClient | SSClient)[] = [];
        results.forEach((result, i) => {
          if (result.code === 200) {
            pendingClients.push(abnormalClients[i]);
          } else {
            Manager.pool.push(abnormalClients[i]);
            Manager.socketTransfer?.pushTargets([
              {
                id: abnormalClients[i].settings.localPort,
                confId: abnormalClients[i].config.id
              }
            ]);
          }
        });

        if (!pendingClients.length)
          throw new Error('Healer: No pending clients');

        return pendingClients;
      })
      /* recreate some nodes from configs */
      .then((pendingClients: (SSRClient | SSClient)[]) => {
        info.underline(
          '>> pending clients: ',
          pendingClients.map(client => `${client.config.serverHost}:${client.config.serverPort}`)
        );
        const filterIds = [
          ...pendingClients.map(client => client.config.id),
          ...Manager.pool.map(client => client.config.id)
        ];

        return Promise.all(
          randomPicker(
            Manager.clusterConfig.filter(conf => !filterIds.includes(conf.id)),
            pendingClients.length
          )
            .map((config, i) => {
              info.underline('>> healer pick: ', `${config.serverHost}:${config.serverPort}`);
              return Manager.spawnClient(
                config,
                pendingClients[i].settings
              );
            })
        );
      })
      /* connect those nodes */
      .then(async (results) => {
        const failedClients: (SSRClient | SSClient)[] = [];
        const createdClients = results
          .filter(rsp => {
            if (rsp.code === 200) {
              return true;
            } else {
              failedClients.push(rsp.result as (SSRClient | SSClient))
              return false;
            }
          })
          .map(rsp => rsp.result as (SSRClient | SSClient));
        const cons = await Promise.all(createdClients.map(client => client.connect()));
        let hasSuccess = 0;

        info.underline(
          '>> reconnected clients: ',
          createdClients.map(client => `${client.config.serverHost}:${client.config.serverPort}`)
        );

        /* push connected new nodes to pool / socket transfer */
        Manager.pool.push(...failedClients);
        cons.forEach((c, i) => {
          Manager.pool.push(createdClients[i]);
          if (c.code === 200 && c.result?.port) {
            Manager.socketTransfer?.pushTargets([
              {
                id: createdClients[i].settings.localPort,
                confId: createdClients[i].config.id
              }
            ]);
            hasSuccess += 1;
          }
        });

        if (!Manager.pool.length) {
          Manager.syncConnected(false);
          throw new Error('Warning: Pool is empty')
        }

        if (!hasSuccess) {
          throw new Error('Cluster heal failed');
        }

        info.underline(`>> Cluster heal ${hasSuccess} nodes!`);
        info.underline(`>> Pool now have ${Manager.pool.length} nodes.`);
      })
      .catch(err => {
        warning(err?.message);
      });
  }

  static async spawnClient(config: Config, settings: Settings): Promise<{ code: number, result: unknown }> {
    if (electronIsDev && Manager.mode === 'single') console.log(config);

    return new Promise(resolve => {
      if (config.type === 'ssr') {
        resolve({
          code: 200,
          result: new SSRClient(settings, config)
        });
      } else if (config.type === 'ss') {
        resolve({
          code: 200,
          result: new SSClient(settings, config)
        });
      } else {
        resolve({
          code: 600,
          result: `Unknown shadowsocks client type: ${config.type}`
        });
      }
    });
  }

  static async kill(client: SSRClient | SSClient | null) {
    if (!client) return Promise.resolve();

    Manager.ssLocal = null;
    await client.disconnect()?.then(
      () => {
        logger.info(`>> Killed ${Manager.ssLocal?.type || 'ss'}-local`);
      },
      () => {
        logger.info(`>> Killed ${Manager.ssLocal?.type || 'ss'}-local failed`);
      }
    );
  };

  static isConnected() {
    if (Manager.mode === 'single') {
      return !!Manager.ssLocal?.connected;
    }
    return Manager.pool.find(client => client.connected);
  }

  static async changeMode(mode: 'single' | 'cluster') {
    if (Manager.ssLocal) {
      await Manager.kill(Manager.ssLocal);
      await new Promise<void>(resolve => setTimeout(() => resolve(), 1000));
    }

    if (Manager.pool.length) {
      await Manager.stopCluster();
    }

    if (Manager.socketTransfer) {
      await Manager.socketTransfer.stop();
    }

    if (Manager.proxy) {
      await Manager.disableProxy();
    }

    Manager.mode = mode;
  }

  static async enableProxy(settings: Settings) {
    Manager.proxy = Proxy.createProxy(
      platform,
      platform === 'win32' ? settings.httpProxy.port : settings.localPort,
      settings.pacPort,
      settings.mode
    );
    await Manager.proxy?.start();
  }

  static async disableProxy() {
    await Manager.proxy?.stop();
    Manager.proxy = null;
  }

   /**
   * @name startClient start single client mode
   * @param config ss/ssr config
   * @param settings global settings
   * @returns Promise<{ code: number, result: any }>
   *
   * total steps:
   *  - change mode to single
   *  - enable proxy
   *  - create client
   *  - connect client
   *  - sync status
   */
  static async startClient(config: Config, settings: Settings): Promise<{ code: number, result: any }> {
    /* change mode to single */
    return this.changeMode('single')
      .then(() => checkPortInUse([settings.localPort], '127.0.0.1'))
      .then(results => {
        if (results[0]?.isInUse) {
          warning(`Port ${settings.localPort} is in use`);
          throw new Error(`Port already in use: ${settings.localPort}`);
        }
      })
      /* enable proxy */
      .then(async () => {
        await Manager.enableProxy(settings);
      })
      /* create client */
      .then(() => Manager.spawnClient(config, settings))
      /* connect client */
      .then(async rsp => {
        if (rsp.code === 200) {
          Manager.ssLocal = rsp.result as (SSRClient | SSClient);
          return (rsp.result as (SSRClient | SSClient)).connect();
        } else {
          return rsp;
        }
      })
      /* sync status */
      .then(rsp => {
        Manager.syncConnected(!!Manager.ssLocal?.connected);
        return rsp;
      })
      .catch(err => {
        Manager.disableProxy();
        return {
          code: 600,
          result: err?.toString()
        };
      });
  }

  static async stopClient() {
    await Manager.disableProxy();
    await Manager.kill(Manager.ssLocal);
    Manager.syncConnected(!!Manager.ssLocal?.connected);
  }

  /**
   * @name startCluster start cluster mode
   * @param configs subscription group
   * @param settings global settings
   * @returns Promise<{ code: number, result: any }>
   *
   * total steps:
   *  - change mode to cluster
   *  - enable proxy
   *  - select clients
   *  - connect clients and init socket transfer
   *  - sync status
   */
  static startCluster(configs: Config[], settings: Settings): Promise<{ code: number, result: any }> {
    return new Promise(resolve => {
      Manager.changeMode('cluster')
        .then(() => checkPortInUse([settings.localPort], '127.0.0.1'))
        .then(results => {
          if (results[0]?.isInUse) {
            warning(`Port ${settings.localPort} is in use`);
            throw new Error(`Port already in use: ${settings.localPort}`);
          }
        })
        /* enable proxy */
        .then(async () => {
          await Manager.enableProxy(settings);
        })
        /* select clients */
        .then(async () => {
          if (!configs.length) {
            throw new Error('No server configs found');
          }

          Manager.clusterConfig = configs;
          const ports = await pickPorts(
            settings.localPort + 1, settings.loadBalance.count,
            [settings.pacPort, settings.httpProxy.port]
          );

          return Promise.all(
            randomPicker(configs, ports.length)
              .map((config, i) => {
                info.underline('>> pick: ', config.remark);
                return Manager.spawnClient(
                  config,
                  { ...settings, localPort: ports[i] }
                );
              })
            );
        })
        /* connect clients and init socket transfer */
        .then(async (results) => {
          Manager.pool =
            results
              .filter(results => results.code === 200)
              .map(rsp => rsp.result as (SSRClient | SSClient));

          if (!Manager.pool.length) {
            throw new Error('Warning: Pool is empty')
          }

          const cons = await Promise.all(Manager.pool.map(client => client.connect()));
          const targets: {id: number, confId: string}[] = [];

          cons.forEach((con, i) => {
            if (con.code === 200 && con.result?.port) {
              targets.push({
                id: con.result?.port,
                confId: Manager.pool[i].config.id
              });
            }
          });

          if (!targets.length) {
            throw new Error('Cluster connect failed');
          }

          Manager.socketTransfer = new SocketTransfer({
            port: settings.localPort,
            strategy: settings.loadBalance.strategy,
            targets,
            heartbeat: 15e3,
          });

          Manager.socketTransfer.on('health:check:failed', Manager.healCluster);

          await Manager.socketTransfer.listen();
        })
        /* sync status */
        .then(() => {
          Manager.syncConnected(true);
          clearInterval(Manager.trafficTimer);
          Manager.trafficTimer = setInterval(Manager.syncTraffic, Manager.heartbeat)
        })
        .then(() => {
          resolve({
            code: 200,
            result: Manager.pool.map(client => client.port)
          });
        })
        .catch(err => {
          warning(err);
          Manager.disableProxy();
          resolve({
            code: 500,
            result: err?.toString()
          });
        });
    });
  }

  static stopCluster(): Promise<{ code: number, result: any }> {
    return new Promise(resolve => {
      if (Manager?.socketTransfer) {
        Manager.socketTransfer.off('health:check:failed', Manager.healCluster)
      }

      Promise
        .all(Manager.pool.map(client => Manager.kill(client)))
        .then(async () => {
          Manager.pool = [];
          await Manager.socketTransfer?.stop();
          Manager.socketTransfer = null;
          Manager.clusterConfig = [];
          Manager.deadMap = {};
          clearInterval(Manager.trafficTimer);
        })
        .then(async () => {
          await Manager.disableProxy();
        })
        .then(() => {
          Manager.syncConnected(false);
          resolve({
            code: 200,
            result: ''
          });
        })
        .catch(error => {
          resolve({
            code: 500,
            result: error?.toString()
          })
        });
    })
  }

}
